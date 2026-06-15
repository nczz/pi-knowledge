import { join } from "node:path";
import { getDefaultKnowledgeDir } from "../storage/sqlite.ts";

type FeatureExtractionPipeline = {
	(input: string, options: { pooling: "mean"; normalize: true }): Promise<{ data: ArrayLike<number> }>;
	dispose(): Promise<void> | void;
};

let pipelineInstance: FeatureExtractionPipeline | null = null;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];

const IDLE_TIMEOUT_MS = Number(process.env.PI_KNOWLEDGE_EMBEDDING_IDLE_MS ?? 30_000);
const EMBEDDING_CONFIG = process.env.PI_KNOWLEDGE_EMBEDDING ?? "local:multilingual-e5-small";

function getModelCacheDir(): string {
	return join(getDefaultKnowledgeDir(), "models");
}

async function loadPipeline(): Promise<FeatureExtractionPipeline> {
	if (pipelineInstance) return pipelineInstance;
	if (disposePromise) await disposePromise;
	const { pipeline, env } = await import("@huggingface/transformers");
	env.cacheDir = getModelCacheDir();
	pipelineInstance = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", {
		quantized: true,
		dtype: "fp32",
	});
	return pipelineInstance;
}

function clearIdleTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = null;
}

function scheduleIdleDispose(): void {
	if (activeRuns > 0 || disposeRequested) return;
	clearIdleTimer();
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
	const instance = pipelineInstance;
	pipelineInstance = null;
	if (!instance) {
		disposeRequested = false;
		return;
	}
	disposePromise = Promise.resolve(instance.dispose()).finally(() => {
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
	const pipe = await loadPipeline();
	beginRun();
	const results: Float32Array[] = [];
	try {
		for (const text of texts) {
			if (signal?.aborted) throw new Error("Cancelled");
			const output = await pipe(`${prefix}: ${text}`, { pooling: "mean", normalize: true });
			results.push(new Float32Array(output.data));
		}
	} finally {
		endRun();
	}
	return results;
}

export async function embedQuery(text: string): Promise<Float32Array> {
	const [vec] = await embedTexts([text], "query");
	return vec;
}

export async function embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
	return embedTexts(texts, "passage", signal);
}
