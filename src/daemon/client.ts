import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
	AddOptions,
	DoctorReport,
	IndexPlan,
	KnowledgeStatusSnapshot,
	SearchOptions,
	SearchResponse,
	SymbolSearchOptions,
	SymbolSearchResponse,
} from "../engine.ts";
import type { FilesystemAccessPolicy } from "../filesystem-access.ts";
import { configureDaemonNodePath, resolveDaemonNodePath } from "../node-runtime.ts";
import type { KnowledgeProfile } from "../profiles.ts";
import { resolveKnowledgeProfile } from "../profiles.ts";
import type { KnowledgeBase } from "../storage/sqlite.ts";
import {
	DAEMON_PROTOCOL_VERSION,
	DAEMON_REQUEST_TIMEOUT_MS,
	DAEMON_SHUTDOWN_GRACE_MS,
	DAEMON_SHUTDOWN_SETTLE_MS,
	DAEMON_START_TIMEOUT_MS,
	type DaemonManifest,
	type DaemonMethod,
	MAX_RPC_FRAME_BYTES,
	packageBuildIdentity,
	packageVersion,
	parseDaemonServerFrame,
	runtimeConfigurationSignature,
} from "./protocol.ts";
import { processIsAlive, readDaemonManifest, readDaemonOwner } from "./runtime.ts";
import type { DaemonServiceStatus } from "./service.ts";

export interface DaemonPing {
	ready: boolean;
	protocol_version: number;
	profile: { name: string; id: string };
	storage_dir: string;
	instance_id: string;
	pid: number;
	package_version: string;
	build_identity: string;
	runtime_configuration_signature: string;
}

export type ProgressCallback = (message: string) => void;

function serializeFilesystemAccess(
	access: FilesystemAccessPolicy | undefined,
): { allowed_roots: string[]; allow_network: boolean } | undefined {
	if (!access) return undefined;
	return { allowed_roots: access.allowedRoots, allow_network: access.allowNetwork };
}

function requestDaemon<T>(
	profile: KnowledgeProfile,
	method: DaemonMethod,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onProgress?: ProgressCallback,
	manifestOverride?: DaemonManifest,
): Promise<T> {
	if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
	const manifest = manifestOverride ?? readDaemonManifest(profile);
	if (!manifest) return Promise.reject(new Error(`Knowledge profile daemon is not running: ${profile.name}`));
	if (manifest.protocol_version !== DAEMON_PROTOCOL_VERSION) {
		return Promise.reject(new Error(`Unsupported daemon protocol version: ${manifest.protocol_version}`));
	}
	const requestId = randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const socket = createConnection(manifest.endpoint);
	let buffer = "";
	const decoder = new StringDecoder("utf8");
	let settled = false;
	const finish = (error?: Error, result?: T): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		socket.destroy();
		if (error) reject(error);
		else resolve(result as T);
	};
	const abort = (): void => {
		if (settled) return;
		if (socket.writable) {
			socket.write(
				`${JSON.stringify({ type: "cancel", version: DAEMON_PROTOCOL_VERSION, id: requestId, token: manifest.auth_token })}\n`,
			);
		}
		finish(new Error("Cancelled"));
	};
	const timeout = setTimeout(
		() => finish(new Error(`Daemon request timed out: ${method}`)),
		method === "ping"
			? DAEMON_START_TIMEOUT_MS
			: method === "shutdown"
				? DAEMON_SHUTDOWN_GRACE_MS + DAEMON_SHUTDOWN_SETTLE_MS + 5_000
				: DAEMON_REQUEST_TIMEOUT_MS,
	);
	signal?.addEventListener("abort", abort, { once: true });
	socket.once("connect", () => {
		socket.write(
			`${JSON.stringify({
				type: "request",
				version: DAEMON_PROTOCOL_VERSION,
				id: requestId,
				token: manifest.auth_token,
				package_version: packageVersion(),
				build_identity: packageBuildIdentity(),
				method,
				params,
			})}\n`,
		);
	});
	socket.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		if (Buffer.byteLength(buffer) > MAX_RPC_FRAME_BYTES) {
			finish(new Error("Daemon response exceeds the configured frame limit"));
			return;
		}
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) {
				try {
					const frame = parseDaemonServerFrame(JSON.parse(line));
					if (frame.id !== requestId) throw new Error("Daemon response request id mismatch");
					if (frame.type === "progress") onProgress?.(frame.message);
					else if (frame.type === "error") finish(new Error(frame.message));
					else finish(undefined, frame.result as T);
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}
			newline = buffer.indexOf("\n");
		}
	});
	socket.once("error", (error) => finish(error));
	socket.once("close", () => {
		if (!settled) finish(new Error("Daemon connection closed before a response"));
	});
	return promise;
}

function daemonEntryPath(): string {
	const current = fileURLToPath(import.meta.url);
	const extension = current.endsWith(".js") ? ".js" : ".ts";
	const path = fileURLToPath(new URL(`./main${extension}`, import.meta.url));
	if (!existsSync(path)) throw new Error(`Profile daemon entry not found: ${path}`);
	return path;
}

function daemonEnvironment(profile: KnowledgeProfile): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	const exactKeys = [
		"HOME",
		"USERPROFILE",
		"TMPDIR",
		"TEMP",
		"TMP",
		"SYSTEMROOT",
		"WINDIR",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	] as const;
	for (const key of exactKeys) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PI_KNOWLEDGE_") || key.startsWith("OPENAI_")) env[key] = value;
	}
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	delete env.PI_KNOWLEDGE_MCP_HTTP_TOKEN;
	env.PI_KNOWLEDGE_PROFILE = profile.name;
	env.PI_KNOWLEDGE_PROFILE_ROOT = profile.profileRoot;
	if (profile.name === "default") env.PI_KNOWLEDGE_DIR = profile.storageDir;
	else {
		delete env.PI_KNOWLEDGE_DIR;
		delete env.OMP_KNOWLEDGE_DIR;
	}
	return env;
}

function spawnDaemon(profile: KnowledgeProfile): Promise<number> {
	const nodePath = resolveDaemonNodePath(profile);
	const entry = daemonEntryPath();
	const args = entry.endsWith(".ts") ? ["--experimental-strip-types", entry, "run"] : [entry, "run"];
	args.push("--profile", profile.name, "--expect-profile-id", profile.id);
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const child = spawn(nodePath, args, {
		cwd: profile.storageDir,
		detached: true,
		env: daemonEnvironment(profile),
		shell: false,
		stdio: "ignore",
		windowsHide: true,
	});
	child.once("error", reject);
	child.once("spawn", () => {
		if (child.pid === undefined) {
			reject(new Error("Profile daemon process started without a process id"));
			return;
		}
		resolve(child.pid);
	});
	child.unref();
	return promise;
}

function assertRuntimeConfiguration(ping: DaemonPing): void {
	const expected = runtimeConfigurationSignature();
	if (ping.runtime_configuration_signature !== expected) {
		throw new Error(
			"Knowledge profile daemon is running with different runtime configuration; stop and restart it before using this client",
		);
	}
}

async function waitForDaemonReady(
	profile: KnowledgeProfile,
	expectedPid: number,
	deadline = Date.now() + DAEMON_START_TIMEOUT_MS,
): Promise<KnowledgeDaemonClient | undefined> {
	let lastError: Error | undefined;
	while (Date.now() < deadline) {
		const candidate = readDaemonManifest(profile);
		if (candidate) {
			let ping: DaemonPing | undefined;
			try {
				ping = await requestDaemon<DaemonPing>(profile, "ping", {}, undefined, undefined, candidate);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
			if (ping) {
				assertRuntimeConfiguration(ping);
				if (ping.ready) return new KnowledgeDaemonClient(profile);
			}
		}
		if (!processIsAlive(expectedPid)) {
			const owner = readDaemonOwner(profile);
			if (!owner || !processIsAlive(owner.pid)) return undefined;
		}
		await delay(50);
	}
	throw new Error(`Knowledge profile daemon did not become ready: ${lastError?.message ?? profile.name}`);
}

const ensureRuns = new Map<string, Promise<KnowledgeDaemonClient>>();

export async function ensureDaemonClient(profile = resolveKnowledgeProfile()): Promise<KnowledgeDaemonClient> {
	const existing = ensureRuns.get(profile.id);
	if (existing) return existing;
	const run = (async () => {
		const manifest = readDaemonManifest(profile);
		if (manifest) {
			if (manifest.package_version !== packageVersion() || manifest.build_identity !== packageBuildIdentity()) {
				try {
					await requestDaemon(profile, "shutdown", {}, undefined, undefined, manifest);
					await waitForDaemonShutdown(profile, manifest.instance_id);
				} catch (error) {
					const owner = readDaemonOwner(profile);
					if (owner?.instance_id === manifest.instance_id && processIsAlive(owner.pid)) {
						await waitForDaemonShutdown(profile, manifest.instance_id);
					} else {
						const replacement = readDaemonManifest(profile);
						if (
							replacement &&
							replacement.instance_id !== manifest.instance_id &&
							replacement.package_version === packageVersion() &&
							replacement.build_identity === packageBuildIdentity()
						) {
							const ready = await waitForDaemonReady(profile, replacement.pid);
							if (ready) return ready;
						}
						if (owner?.instance_id === manifest.instance_id) {
							// A dead stale owner is recovered by the normal ownership election below.
						} else if (owner && processIsAlive(owner.pid)) {
							throw error;
						}
					}
				}
			} else {
				const ready = await waitForDaemonReady(profile, manifest.pid);
				if (ready) return ready;
			}
		}
		const startupDeadline = Date.now() + DAEMON_START_TIMEOUT_MS;
		let spawnedPid: number | undefined;
		do {
			spawnedPid = await spawnDaemon(profile);
			const ready = await waitForDaemonReady(profile, spawnedPid, startupDeadline);
			if (ready) return ready;
			const owner = readDaemonOwner(profile);
			if (owner && processIsAlive(owner.pid)) {
				throw new Error(
					`Knowledge profile daemon process ${spawnedPid} exited while owner PID ${owner.pid} remained live`,
				);
			}
		} while (Date.now() < startupDeadline);
		throw new Error(`Knowledge profile daemon process ${String(spawnedPid)} exited before becoming ready`);
	})().finally(() => {
		if (ensureRuns.get(profile.id) === run) ensureRuns.delete(profile.id);
	});
	ensureRuns.set(profile.id, run);
	return run;
}

export async function configureAndEnsureDaemonClient(
	profile: KnowledgeProfile,
	nodePath: string,
	signal?: AbortSignal,
): Promise<KnowledgeDaemonClient> {
	if (signal?.aborted) throw new Error("Cancelled");
	configureDaemonNodePath(profile, nodePath);
	if (signal?.aborted) throw new Error("Cancelled");
	return ensureDaemonClient(profile);
}

export async function waitForDaemonShutdown(
	profile: KnowledgeProfile,
	instanceId: string,
	timeoutMs = DAEMON_SHUTDOWN_GRACE_MS + DAEMON_SHUTDOWN_SETTLE_MS + 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const manifest = readDaemonManifest(profile);
		const owner = readDaemonOwner(profile);
		const manifestReleased = !manifest || manifest.instance_id !== instanceId;
		const ownerReleased = !owner || owner.instance_id !== instanceId;
		if (manifestReleased && ownerReleased) return;
		await delay(50);
	}
	throw new Error(`Knowledge profile daemon did not stop within ${timeoutMs}ms`);
}

export class KnowledgeDaemonClient {
	readonly profile: KnowledgeProfile;

	constructor(profile: KnowledgeProfile) {
		this.profile = profile;
	}

	ping(signal?: AbortSignal): Promise<DaemonPing> {
		return requestDaemon(this.profile, "ping", {}, signal);
	}

	plan(
		source: string,
		options: AddOptions = {},
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<IndexPlan> {
		return requestDaemon(this.profile, "plan", { source, options, access: serializeFilesystemAccess(access) }, signal);
	}

	configure(nodePath?: string, signal?: AbortSignal): Promise<{ node_path: string }> {
		return requestDaemon(this.profile, "configure", { node_path: nodePath }, signal);
	}

	add(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		options: AddOptions = {},
		access?: FilesystemAccessPolicy,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		return requestDaemon(
			this.profile,
			"add",
			{ source, name, options, access: serializeFilesystemAccess(access) },
			signal,
			onProgress,
		);
	}

	search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResponse> {
		return requestDaemon(this.profile, "search", { query, options }, signal);
	}

	symbolSearch(query: string, options: SymbolSearchOptions = {}, signal?: AbortSignal): Promise<SymbolSearchResponse> {
		return requestDaemon(this.profile, "symbol_search", { query, options }, signal);
	}

	update(
		target: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<{ added: number; removed: number; unchanged: number }> {
		return requestDaemon(
			this.profile,
			"update",
			{ target, access: serializeFilesystemAccess(access) },
			signal,
			onProgress,
		);
	}

	list(signal?: AbortSignal): Promise<KnowledgeBase[]> {
		return requestDaemon(this.profile, "list", {}, signal);
	}

	status(signal?: AbortSignal): Promise<DaemonServiceStatus> {
		return requestDaemon(this.profile, "status", {}, signal);
	}

	doctor(signal?: AbortSignal): Promise<DoctorReport> {
		return requestDaemon(this.profile, "doctor", {}, signal);
	}

	remove(target: string, signal?: AbortSignal): Promise<boolean> {
		return requestDaemon(this.profile, "remove", { target }, signal);
	}

	exportKB(
		target: string,
		output: string,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
		access?: FilesystemAccessPolicy,
	): Promise<number> {
		return requestDaemon(
			this.profile,
			"export",
			{ target, output, access: serializeFilesystemAccess(access) },
			signal,
			onProgress,
		);
	}

	importKB(
		input: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		return requestDaemon(
			this.profile,
			"import",
			{ input, access: serializeFilesystemAccess(access) },
			signal,
			onProgress,
		);
	}

	clear(signal?: AbortSignal): Promise<void> {
		return requestDaemon(this.profile, "clear", {}, signal);
	}

	enableWatchers(signal?: AbortSignal): Promise<{ watch_count: number }> {
		return requestDaemon(this.profile, "enable_watchers", {}, signal);
	}

	async shutdown(signal?: AbortSignal): Promise<{ accepted: boolean }> {
		const manifest = readDaemonManifest(this.profile);
		try {
			return await requestDaemon(this.profile, "shutdown", {}, signal, undefined, manifest);
		} catch (error) {
			const current = readDaemonManifest(this.profile);
			if (!manifest || !current || current.instance_id !== manifest.instance_id || !processIsAlive(manifest.pid)) {
				return { accepted: true };
			}
			if (!current.ready) {
				await waitForDaemonShutdown(this.profile, manifest.instance_id);
				return { accepted: true };
			}
			throw error;
		}
	}
}

export type { KnowledgeStatusSnapshot };
