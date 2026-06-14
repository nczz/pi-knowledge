import { join } from "node:path";
import { getDefaultKnowledgeDir } from "../storage/sqlite.ts";

let pipelineInstance: any = null;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_TIMEOUT_MS = 60_000;

function getModelCacheDir(): string {
	return join(getDefaultKnowledgeDir(), "models");
}

async function loadPipeline(): Promise<any> {
	if (pipelineInstance) return pipelineInstance;
	const { pipeline, env } = await import("@huggingface/transformers");
	env.cacheDir = getModelCacheDir();
	pipelineInstance = await pipeline("feature-extraction", "Xenova/multilingual-e5-small", { quantized: true });
	return pipelineInstance;
}

function resetIdleTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = setTimeout(() => dispose(), IDLE_TIMEOUT_MS);
}

export async function dispose(): Promise<void> {
	if (disposeTimer) { clearTimeout(disposeTimer); disposeTimer = null; }
	if (pipelineInstance) { await pipelineInstance.dispose(); pipelineInstance = null; }
}

export async function embedTexts(texts: string[], prefix: "query" | "passage"): Promise<Float32Array[]> {
	const pipe = await loadPipeline();
	resetIdleTimer();
	const results: Float32Array[] = [];
	for (const text of texts) {
		const output = await pipe(`${prefix}: ${text}`, { pooling: "mean", normalize: true });
		results.push(new Float32Array(output.data));
	}
	return results;
}

export async function embedQuery(text: string): Promise<Float32Array> {
	const [vec] = await embedTexts([text], "query");
	return vec;
}

export async function embedDocuments(texts: string[]): Promise<Float32Array[]> {
	return embedTexts(texts, "passage");
}
