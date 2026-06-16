import { embedInModelWorker } from "../model-worker-client.ts";

let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];

const IDLE_TIMEOUT_MS = Number(process.env.PI_KNOWLEDGE_EMBEDDING_IDLE_MS ?? 30_000);
const EMBEDDING_CONFIG = process.env.PI_KNOWLEDGE_EMBEDDING ?? "local:multilingual-e5-small";
const ENABLE_NATIVE_IDLE_DISPOSE = process.env.PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE === "true";

function clearIdleTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = null;
}

function scheduleIdleDispose(): void {
	if (activeRuns > 0 || disposeRequested) return;
	clearIdleTimer();
	if (!ENABLE_NATIVE_IDLE_DISPOSE) return;
	disposeTimer = setTimeout(() => dispose(), IDLE_TIMEOUT_MS);
}

function beginRun(): void {
	activeRuns++;
	clearIdleTimer();
}

function endRun(): void {
	activeRuns--;
	if (activeRuns > 0) return;
	for (const resolve of idleWaiters.splice(0)) resolve();
	if (!disposeRequested) scheduleIdleDispose();
}

function waitForNoActiveRuns(): Promise<void> {
	if (activeRuns === 0) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

export async function dispose(): Promise<void> {
	clearIdleTimer();
	if (disposePromise) return disposePromise;
	disposeRequested = true;
	await waitForNoActiveRuns();
	disposePromise = Promise.resolve().finally(() => {
		disposePromise = null;
		disposeRequested = false;
	});
	return disposePromise;
}

export async function prepareForShutdown(): Promise<void> {
	clearIdleTimer();
	await waitForNoActiveRuns();
}

async function embedViaAPI(texts: string[], prefix: "query" | "passage"): Promise<Float32Array[]> {
	const [provider, model] = EMBEDDING_CONFIG.split(":");
	const prefixedTexts = texts.map((t) => `${prefix}: ${t}`);

	if (provider === "openai") {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("OPENAI_API_KEY required for openai embedding");
		const res = await fetch("https://api.openai.com/v1/embeddings", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ input: prefixedTexts, model: model || "text-embedding-3-small" }),
		});
		if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
		const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
		return data.data.map((d) => new Float32Array(d.embedding));
	}

	throw new Error(`Unsupported embedding provider: ${provider}`);
}

export async function embedTexts(
	texts: string[],
	prefix: "query" | "passage",
	signal?: AbortSignal,
): Promise<Float32Array[]> {
	if (!EMBEDDING_CONFIG.startsWith("local")) {
		try {
			return await embedViaAPI(texts, prefix);
		} catch {
			/* fallback to local */
		}
	}
	beginRun();
	try {
		return await embedInModelWorker(texts, prefix, signal);
	} finally {
		endRun();
	}
}

export async function embedQuery(text: string): Promise<Float32Array> {
	const [vec] = await embedTexts([text], "query");
	return vec;
}

export async function embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	return embedTexts(texts, "passage", signal);
}
