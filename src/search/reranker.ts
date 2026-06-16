import { rerankInModelWorker } from "../model-worker-client.ts";

let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let disposePromise: Promise<void> | null = null;
let activeRuns = 0;
let disposeRequested = false;
const idleWaiters: Array<() => void> = [];
const IDLE_MS = 30_000;
const ENABLE_NATIVE_IDLE_DISPOSE = process.env.PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE === "true";

function clearTimer(): void {
	if (disposeTimer) clearTimeout(disposeTimer);
	disposeTimer = null;
}

function scheduleDispose(): void {
	if (activeRuns > 0 || disposeRequested) return;
	clearTimer();
	if (!ENABLE_NATIVE_IDLE_DISPOSE) return;
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
	disposePromise = Promise.resolve().finally(() => {
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
	beginRun();
	try {
		return await rerankInModelWorker(query, candidates, topK);
	} finally {
		endRun();
	}
}
