import { join } from "node:path";
import { getDefaultKnowledgeDir } from "../storage/sqlite.ts";

let rerankerPipeline: any = null;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_MS = 60_000;

async function load(): Promise<any> {
	if (rerankerPipeline) return rerankerPipeline;
	const { pipeline, env } = await import("@huggingface/transformers");
	env.cacheDir = join(getDefaultKnowledgeDir(), "models");
	rerankerPipeline = await pipeline("text-classification", "Xenova/ms-marco-MiniLM-L-4-v2");
	return rerankerPipeline;
}

function resetTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = setTimeout(() => disposeReranker(), IDLE_MS);
}

export async function disposeReranker(): Promise<void> {
	if (disposeTimer) { clearTimeout(disposeTimer); disposeTimer = null; }
	if (rerankerPipeline) { await rerankerPipeline.dispose(); rerankerPipeline = null; }
}

export interface RerankCandidate { chunkId: string; content: string; }

export async function rerank(query: string, candidates: RerankCandidate[], topK: number): Promise<Array<{ chunkId: string; score: number }>> {
	if (candidates.length === 0) return [];
	const pipe = await load();
	resetTimer();

	const results: Array<{ chunkId: string; score: number }> = [];
	for (const c of candidates) {
		const output = await pipe({ text: query, text_pair: c.content });
		const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
		results.push({ chunkId: c.chunkId, score });
	}

	results.sort((a, b) => b.score - a.score);
	return results.slice(0, topK);
}
