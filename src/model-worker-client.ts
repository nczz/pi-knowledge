import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

type WorkerResponse = {
	id: number;
	result?: unknown;
	error?: string;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
};

let worker: ChildProcess | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function rejectPending(error: Error): void {
	for (const request of pending.values()) {
		request.reject(error);
	}
	pending.clear();
}

function getWorker(): ChildProcess {
	if (worker?.connected) return worker;
	const workerPath = fileURLToPath(new URL("./model-worker.ts", import.meta.url));
	worker = fork(workerPath, {
		execArgv: ["--experimental-strip-types"],
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: process.env,
	});
	const child = worker;
	worker.on("message", (message: WorkerResponse) => {
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) {
			request.reject(new Error(message.error));
		} else {
			request.resolve(message.result);
		}
	});
	worker.on("exit", (code, signal) => {
		if (worker !== child) return;
		worker = null;
		if (pending.size > 0) {
			rejectPending(
				new Error(`Model worker exited before responding (code ${code ?? "null"}, signal ${signal ?? "null"})`),
			);
		}
	});
	worker.on("error", (error) => {
		if (worker !== child) return;
		worker = null;
		rejectPending(error);
	});
	return worker;
}

async function requestModelWorker(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) throw new Error("Cancelled");
	const child = getWorker();
	const id = nextRequestId++;
	return new Promise((resolve, reject) => {
		let abortHandler: (() => void) | undefined;
		pending.set(id, { resolve, reject });
		if (signal) {
			abortHandler = () => {
				pending.delete(id);
				reject(new Error("Cancelled"));
				shutdownModelWorker();
			};
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		const cleanup = (): void => {
			if (abortHandler) signal?.removeEventListener("abort", abortHandler);
		};
		const originalResolve = resolve;
		const originalReject = reject;
		pending.set(id, {
			resolve(value) {
				cleanup();
				originalResolve(value);
			},
			reject(error) {
				cleanup();
				originalReject(error);
			},
		});
		child.send({ id, ...message }, (error) => {
			if (!error) return;
			pending.delete(id);
			cleanup();
			reject(error);
		});
	});
}

export async function embedInModelWorker(
	texts: string[],
	prefix: "query" | "passage",
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	const result = await requestModelWorker({ type: "embed", texts, prefix }, signal);
	if (!Array.isArray(result)) throw new Error("Invalid embedding worker response");
	return result.map((vector) => {
		if (!Array.isArray(vector)) throw new Error("Invalid embedding vector from worker");
		return new Float32Array(vector);
	});
}

export interface RerankWorkerCandidate {
	chunkId: string;
	content: string;
}

export async function rerankInModelWorker(
	query: string,
	candidates: RerankWorkerCandidate[],
	topK: number,
): Promise<Array<{ chunkId: string; score: number }>> {
	const result = await requestModelWorker({ type: "rerank", query, candidates, topK });
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
	rejectPending(new Error("Model worker shut down"));
	if (child && !child.killed) {
		child.kill("SIGKILL");
	}
}
