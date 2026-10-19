import { type ChildProcess, execFileSync, fork, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getConfiguredNodePath, writeRuntimeConfig } from "./runtime-config.ts";
import type { HfRerankerConfig } from "./search/reranker-config.ts";

type WorkerResponse = {
	id: number;
	result?: unknown;
	error?: string;
};

type WorkerRequest = Record<string, unknown> & { id: number };

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
};

type SendCapableChild = ChildProcess & {
	send: NonNullable<ChildProcess["send"]>;
};

let worker: ModelWorkerTransport | null = null;
let nextRequestId = 1;
let resolvedNodeExecPath: string | null = null;
const WORKER_STDERR_TAIL_CHARS = 4_000;
const MIN_NODE_MAJOR = 22;

function getWorkerPath(): string {
	const workerFile = fileURLToPath(import.meta.url).endsWith(".js") ? "model-worker.js" : "model-worker.ts";
	const workerPath = fileURLToPath(new URL(`./${workerFile}`, import.meta.url));
	if (!existsSync(workerPath)) {
		throw new Error(
			`Model worker file not found at ${workerPath}. Rebuild or reinstall pi-knowledge so the worker is packaged beside model-worker-client.`,
		);
	}
	return workerPath;
}

function getWorkerExecArgv(): string[] {
	return fileURLToPath(import.meta.url).endsWith(".js") ? [] : ["--experimental-strip-types"];
}

function parseNodeMajor(version: string): number | null {
	const match = /^v?(?<major>\d+)\./.exec(version.trim());
	if (!match?.groups?.major) return null;
	const major = Number(match.groups.major);
	return Number.isInteger(major) ? major : null;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function validateNodeExecPath(candidate: string): string {
	const version = execFileSync(candidate, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5_000,
		windowsHide: true,
	}).trim();
	const major = parseNodeMajor(version);
	if (major === null || major < MIN_NODE_MAJOR) {
		throw new Error(`Node ${MIN_NODE_MAJOR}+ is required for the model worker; ${candidate} reported ${version}`);
	}
	return candidate;
}

function normalizeExecutableCandidate(value: string): string {
	const trimmed = value.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function pathEnvValue(): string {
	return process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
}

function appendIfPresent(candidates: string[], value: string | undefined, suffix?: string): void {
	const normalized = value ? normalizeExecutableCandidate(value) : "";
	if (!normalized) return;
	candidates.push(suffix ? join(normalized, suffix) : normalized);
}

function appendCodexNodeCandidates(candidates: string[]): void {
	const localAppData = process.env.LOCALAPPDATA ? normalizeExecutableCandidate(process.env.LOCALAPPDATA) : "";
	if (!localAppData) return;
	const runtimeRoot = join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
	if (!existsSync(runtimeRoot)) return;
	const discovered = readdirSync(runtimeRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const nodePath = join(runtimeRoot, entry.name, "bin", "node.exe");
			const mtimeMs = existsSync(nodePath) ? statSync(nodePath).mtimeMs : 0;
			return { nodePath, mtimeMs };
		})
		.filter((candidate) => candidate.mtimeMs > 0)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const candidate of discovered) candidates.push(candidate.nodePath);
}

function getWindowsNodeCandidates(): string[] {
	const candidates: string[] = [];
	appendIfPresent(candidates, process.env.NVM_SYMLINK, "node.exe");
	appendIfPresent(candidates, process.env.VOLTA_HOME, join("bin", "node.exe"));
	appendIfPresent(candidates, process.env.ProgramFiles, join("nodejs", "node.exe"));
	appendIfPresent(candidates, process.env["ProgramFiles(x86)"], join("nodejs", "node.exe"));
	appendIfPresent(candidates, process.env.LOCALAPPDATA, join("Programs", "nodejs", "node.exe"));
	appendCodexNodeCandidates(candidates);
	for (const directory of pathEnvValue().split(delimiter)) {
		appendIfPresent(candidates, directory, "node.exe");
	}
	return candidates;
}

function getNodeCandidates(): string[] {
	const candidates: string[] = [];
	appendIfPresent(candidates, process.env.NODE);
	if (process.platform === "win32") {
		candidates.push(...getWindowsNodeCandidates());
	} else {
		for (const directory of pathEnvValue().split(delimiter)) {
			appendIfPresent(candidates, directory, "node");
		}
	}
	candidates.push("node");
	return [...new Set(candidates)];
}

function getNodeExecPath(): string {
	if (resolvedNodeExecPath) return resolvedNodeExecPath;
	const configured = process.env.PI_KNOWLEDGE_NODE_PATH
		? normalizeExecutableCandidate(process.env.PI_KNOWLEDGE_NODE_PATH)
		: "";
	if (configured) {
		try {
			resolvedNodeExecPath = validateNodeExecPath(configured);
			return resolvedNodeExecPath;
		} catch (error) {
			throw new Error(
				`PI_KNOWLEDGE_NODE_PATH does not point to a usable Node ${MIN_NODE_MAJOR}+ executable: ${toError(error).message}`,
			);
		}
	}
	const persisted = getConfiguredNodePath();
	if (persisted) {
		try {
			resolvedNodeExecPath = validateNodeExecPath(normalizeExecutableCandidate(persisted));
			return resolvedNodeExecPath;
		} catch {
			// Persisted paths can point at removable Codex runtimes; continue with auto-discovery.
		}
	}
	const execName = basename(process.execPath).toLowerCase();
	const currentProcessLooksLikeNode = execName === "node" || execName === "node.exe";
	if (currentProcessLooksLikeNode) {
		const major = parseNodeMajor(process.version);
		if (major !== null && major >= MIN_NODE_MAJOR) {
			resolvedNodeExecPath = process.execPath;
			return resolvedNodeExecPath;
		}
	}
	for (const candidate of getNodeCandidates()) {
		try {
			resolvedNodeExecPath = validateNodeExecPath(candidate);
			return resolvedNodeExecPath;
		} catch {
			// Try the next candidate before surfacing a deterministic error below.
		}
	}
	throw new Error(
		`Node ${MIN_NODE_MAJOR}+ is required for local pi-knowledge embeddings, but no usable node executable was found. Install Node ${MIN_NODE_MAJOR}+ or set PI_KNOWLEDGE_NODE_PATH to the full node.exe path.`,
	);
}

export function validateModelWorkerNodePath(nodePath: string): string {
	return validateNodeExecPath(normalizeExecutableCandidate(nodePath));
}

export function resolveModelWorkerNodePath(): string {
	return getNodeExecPath();
}

export function configureModelWorkerNodePath(nodePath?: string): string {
	const resolved = nodePath ? validateModelWorkerNodePath(nodePath) : getNodeExecPath();
	writeRuntimeConfig({ node_path: resolved });
	resolvedNodeExecPath = resolved;
	return resolved;
}

function appendWorkerStderr(current: string, chunk: Buffer): string {
	const next = `${current}${chunk.toString("utf-8")}`;
	return next.length > WORKER_STDERR_TAIL_CHARS ? next.slice(-WORKER_STDERR_TAIL_CHARS) : next;
}

function formatWorkerExitError(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): Error {
	const reason = `Model worker exited before responding (code ${code ?? "null"}, signal ${signal ?? "null"})`;
	const stderr = stderrTail.trim();
	if (!stderr)
		return new Error(`${reason}. Set PI_KNOWLEDGE_NODE_PATH to a working Node binary if Pi is not running under Node.`);
	return new Error(`${reason}. Worker stderr:\n${stderr}`);
}

function formatWorkerSpawnError(error: Error, stderrTail: string): Error {
	const stderr = stderrTail.trim();
	const hint = "Set PI_KNOWLEDGE_NODE_PATH to a working Node 22+ binary if Pi or OMP is not running under Node.";
	return new Error(
		`Model worker failed to start: ${error.message}. ${hint}${stderr ? ` Worker stderr:\n${stderr}` : ""}`,
	);
}

function isWorkerResponse(message: unknown): message is WorkerResponse {
	if (typeof message !== "object" || message === null) return false;
	if (!("id" in message) || typeof message.id !== "number") return false;
	return !("error" in message) || message.error === undefined || typeof message.error === "string";
}

abstract class ModelWorkerTransport {
	protected readonly pending = new Map<number, PendingRequest>();
	protected readonly child: ChildProcess;
	private stderrTail = "";
	private exited = false;
	private terminalError: Error | null = null;

	protected constructor(child: ChildProcess) {
		this.child = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = appendWorkerStderr(this.stderrTail, chunk);
		});
		child.on("exit", (code, signal) => {
			this.exited = true;
			if (worker === this) worker = null;
			if (this.pending.size > 0) this.rejectPending(formatWorkerExitError(code, signal, this.stderrTail));
		});
		child.on("error", (error) => {
			this.terminalError = formatWorkerSpawnError(error, this.stderrTail);
			this.exited = true;
			if (worker === this) worker = null;
			this.rejectPending(this.terminalError);
		});
	}

	isConnected(): boolean {
		return !this.exited && !this.child.killed && !this.terminalError && this.isTransportConnected();
	}

	request(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) throw new Error("Cancelled");
		if (!this.isConnected()) throw this.terminalError ?? new Error("Model worker is not connected");
		const id = nextRequestId++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		let abortHandler: (() => void) | undefined;
		const cleanup = (): void => {
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		};
		if (signal) {
			abortHandler = () => {
				this.pending.delete(id);
				cleanup();
				reject(new Error("Cancelled"));
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		this.pending.set(id, {
			resolve(value) {
				cleanup();
				resolve(value);
			},
			reject(error) {
				cleanup();
				reject(error);
			},
		});
		this.writeRequest({ id, ...message }, (error) => {
			if (!error) return;
			this.pending.delete(id);
			cleanup();
			reject(error);
		});
		return promise;
	}

	shutdown(): void {
		this.rejectPending(new Error("Model worker shut down"));
		if (!this.child.killed) this.child.kill("SIGKILL");
	}

	protected handleWorkerResponse(message: unknown): void {
		if (!isWorkerResponse(message)) {
			this.rejectPending(new Error("Invalid model worker response"));
			if (!this.child.killed) this.child.kill("SIGKILL");
			return;
		}
		const request = this.pending.get(message.id);
		if (!request) return;
		this.pending.delete(message.id);
		if (message.error) {
			request.reject(new Error(message.error));
		} else {
			request.resolve(message.result);
		}
	}

	protected rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			request.reject(error);
		}
		this.pending.clear();
	}

	protected abstract isTransportConnected(): boolean;
	protected abstract writeRequest(message: WorkerRequest, callback: (error: Error | null) => void): void;
}

class IpcModelWorkerTransport extends ModelWorkerTransport {
	private readonly ipcChild: SendCapableChild;
	private constructor(ipcChild: SendCapableChild) {
		super(ipcChild);
		this.ipcChild = ipcChild;
		ipcChild.on("message", (message: unknown) => this.handleWorkerResponse(message));
	}

	static create(workerPath: string, nodeExecPath: string): IpcModelWorkerTransport | null {
		let child: ChildProcess;
		try {
			child = fork(workerPath, {
				execPath: nodeExecPath,
				execArgv: getWorkerExecArgv(),
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: process.env,
			});
		} catch {
			return null;
		}
		if (typeof child.send !== "function") {
			if (!child.killed) child.kill("SIGKILL");
			return null;
		}
		return new IpcModelWorkerTransport(child as SendCapableChild);
	}

	protected isTransportConnected(): boolean {
		return this.ipcChild.connected;
	}

	protected writeRequest(message: WorkerRequest, callback: (error: Error | null) => void): void {
		this.ipcChild.send(message, callback);
	}
}

class StdioModelWorkerTransport extends ModelWorkerTransport {
	private readonly decoder = new StringDecoder("utf8");
	private stdoutBuffer = "";

	constructor(workerPath: string, nodeExecPath: string) {
		let child: ChildProcess;
		try {
			child = spawn(nodeExecPath, [...getWorkerExecArgv(), workerPath, "--stdio"], {
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
				windowsHide: true,
			});
		} catch (error) {
			throw formatWorkerSpawnError(toError(error), "");
		}
		super(child);
		if (!child.stdin || !child.stdout) {
			if (!child.killed) child.kill("SIGKILL");
			throw new Error("Model worker stdio pipes are unavailable");
		}
		child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
	}

	protected isTransportConnected(): boolean {
		return this.child.stdin?.writable === true && this.child.stdin.destroyed !== true;
	}

	protected writeRequest(message: WorkerRequest, callback: (error: Error | null) => void): void {
		const stdin = this.child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			callback(new Error("Model worker stdin is not writable"));
			return;
		}
		stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error?: Error | null) => {
			callback(error ?? null);
		});
	}

	private handleStdoutChunk(chunk: Buffer): void {
		this.stdoutBuffer += this.decoder.write(chunk);
		let newlineIndex = this.stdoutBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line) this.handleStdoutLine(line);
			newlineIndex = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleStdoutLine(line: string): void {
		try {
			this.handleWorkerResponse(JSON.parse(line));
		} catch (error) {
			this.rejectPending(
				new Error(`Invalid model worker stdio response: ${error instanceof Error ? error.message : String(error)}`),
			);
			if (!this.child.killed) this.child.kill("SIGKILL");
		}
	}
}

function getWorker(): ModelWorkerTransport {
	if (worker?.isConnected()) return worker;
	const workerPath = getWorkerPath();
	const nodeExecPath = getNodeExecPath();
	worker =
		IpcModelWorkerTransport.create(workerPath, nodeExecPath) ?? new StdioModelWorkerTransport(workerPath, nodeExecPath);
	return worker;
}

export async function embedInModelWorker(
	texts: string[],
	prefix: "query" | "passage",
	prefixesOrSignal?: "on" | "off" | AbortSignal,
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	const prefixes = prefixesOrSignal === "off" ? "off" : "on";
	const requestSignal = typeof prefixesOrSignal === "object" ? prefixesOrSignal : signal;
	const result = await getWorker().request({ type: "embed", texts, prefix, prefixes }, requestSignal);
	if (!Array.isArray(result)) throw new Error("Invalid embedding worker response");
	return result.map((vector) => {
		if (!Array.isArray(vector)) throw new Error("Invalid embedding vector from worker");
		return new Float32Array(vector);
	});
}

export async function measureEmbeddingInputInModelWorker(
	texts: string[],
	prefix: "query" | "passage",
	prefixes: "on" | "off",
	signal?: AbortSignal,
): Promise<{ counts: number[]; maximum: number }> {
	const result = await getWorker().request({ type: "measure_embedding_input", texts, prefix, prefixes }, signal);
	if (
		typeof result !== "object" ||
		result === null ||
		!("counts" in result) ||
		!Array.isArray(result.counts) ||
		result.counts.length !== texts.length ||
		!result.counts.every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0) ||
		!("maximum" in result) ||
		typeof result.maximum !== "number" ||
		!Number.isInteger(result.maximum) ||
		result.maximum <= 0
	) {
		throw new Error("Invalid embedding input measurement from worker");
	}
	return { counts: result.counts, maximum: result.maximum };
}

export interface RerankWorkerCandidate {
	chunkId: string;
	content: string;
}

export async function rerankInModelWorker(
	query: string,
	candidates: RerankWorkerCandidate[],
	topK: number,
	reranker: HfRerankerConfig,
	signal?: AbortSignal,
): Promise<Array<{ chunkId: string; score: number }>> {
	const result = await getWorker().request({ type: "rerank", query, candidates, topK, reranker }, signal);
	if (!Array.isArray(result)) throw new Error("Invalid reranker worker response");
	return result.map((item) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof (item as { chunkId?: unknown }).chunkId !== "string" ||
			typeof (item as { score?: unknown }).score !== "number"
		) {
			throw new Error("Invalid reranker result from worker");
		}
		return item as { chunkId: string; score: number };
	});
}

export function shutdownModelWorker(): void {
	const child = worker;
	worker = null;
	child?.shutdown();
}
