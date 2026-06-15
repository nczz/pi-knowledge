import { join } from "node:path";
import { getDefaultKnowledgeDir } from "../storage/sqlite.ts";

type RerankerPipeline = {
	(input: { text: string; text_pair: string }): Promise<{ score?: number } | Array<{ score?: number }>>;
	dispose(): Promise<void> | void;
};

let rerankerPipeline: RerankerPipeline | null = null;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];
const IDLE_MS = 30_000;

async function load(): Promise<RerankerPipeline> {
	if (rerankerPipeline) return rerankerPipeline;
	if (disposePromise) await disposePromise;
	const { pipeline, env } = await import("@huggingface/transformers");
	env.cacheDir = join(getDefaultKnowledgeDir(), "models");
	rerankerPipeline = await pipeline("text-classification", "Xenova/ms-marco-MiniLM-L-4-v2");
	return rerankerPipeline;
}

function clearTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = null;
}

function scheduleDispose(): void {
	if (activeRuns > 0 || disposeRequested) return;
	clearTimer();
	disposeTimer = setTimeout(() => disposeReranker(), IDLE_MS);
}

function beginRun(): void {
	activeRuns++;
	clearTimer();
}

function endRun(): void {
	activeRuns--;
	if (activeRuns > 0) return;
	for (const resolve of idleWaiters.splice(0)) resolve();
	if (!disposeRequested) scheduleDispose();
}

function waitForNoActiveRuns(): Promise<void> {
	if (activeRuns === 0) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

export async function disposeReranker(): Promise<void> {
	clearTimer();
	if (disposePromise) return disposePromise;
	disposeRequested = true;
	await waitForNoActiveRuns();
	const instance = rerankerPipeline;
	rerankerPipeline = null;
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

export async function prepareRerankerForShutdown(): Promise<void> {
	clearTimer();
	await waitForNoActiveRuns();
}

export interface RerankCandidate {
	chunkId: string;
	content: string;
}

export async function rerank(
	query: string,
	candidates: RerankCandidate[],
	topK: number,
): Promise<Array<{ chunkId: string; score: number }>> {
	if (candidates.length === 0) return [];
	const pipe = await load();
	beginRun();

	const results: Array<{ chunkId: string; score: number }> = [];
	try {
		for (const c of candidates) {
			const output = await pipe({ text: query, text_pair: c.content });
			const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
			results.push({ chunkId: c.chunkId, score });
		}
	} finally {
		endRun();
	}

	results.sort((a, b) => b.score - a.score);
	return results.slice(0, topK);
}
