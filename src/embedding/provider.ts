import { embedInModelWorker } from "../model-worker-client.ts";

let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];

const IDLE_TIMEOUT_MS = Number(process.env.PI_KNOWLEDGE_EMBEDDING_IDLE_MS ?? 30_000);
const EMBEDDING_CONFIG = process.env.PI_KNOWLEDGE_EMBEDDING ?? "local:multilingual-e5-small";
const ENABLE_NATIVE_IDLE_DISPOSE = process.env.PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE === "true";
const API_FALLBACK_TO_LOCAL = process.env.PI_KNOWLEDGE_EMBEDDING_API_FALLBACK === "local";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_API_MAX_EMBED_CHARS = 20_000;

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
	const configuredMaxChars = Number(process.env.PI_KNOWLEDGE_EMBEDDING_MAX_CHARS ?? DEFAULT_API_MAX_EMBED_CHARS);
	const maxChars =
		Number.isFinite(configuredMaxChars) && configuredMaxChars > 0 ? configuredMaxChars : DEFAULT_API_MAX_EMBED_CHARS;
	const prefixedTexts = texts.map((t) => `${prefix}: ${t}`);
	const safeTexts = prefixedTexts.map((text) => (text.length > maxChars ? text.slice(0, maxChars) : text));

	if (provider === "openai") {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) throw new Error("OPENAI_API_KEY required for openai embedding");
		const baseUrl =
			process.env.PI_KNOWLEDGE_EMBEDDING_BASE_URL?.trim() ||
			process.env.OPENAI_BASE_URL?.trim() ||
			DEFAULT_OPENAI_BASE_URL;
		const endpoint = new URL("embeddings", `${baseUrl.replace(/\/+$/, "")}/`);
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ input: safeTexts, model: model || "text-embedding-3-small" }),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`OpenAI embedding API error: ${res.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
		}
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
		} catch (error) {
			if (!API_FALLBACK_TO_LOCAL) throw error;
			console.warn(
				`pi-knowledge: embedding API failed; falling back to local model because PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local (${error instanceof Error ? error.message : String(error)})`,
			);
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
