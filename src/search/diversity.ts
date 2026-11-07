import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Chunk } from "../storage/sqlite.ts";
import { tokenizeForSearch } from "./query.ts";
import type { RankingDiagnostics } from "./ranking.ts";

export type DiversityMode = "off" | "balanced" | "strong" | undefined;

export interface RankedChunk {
	chunk: Chunk;
	kbName: string;
	ranking?: RankingDiagnostics;
	score: number;
	content: string;
	snippet: string;
	startLine: number;
	endLine: number;
	sourceChunkIds: string[];
}

interface ProximityMeta {
	filePath: string;
	kbId: string;
	startLine: number;
	endLine: number;
	sourceIds: Set<string>;
}

const VECTOR_REDUNDANCY_WEIGHT = 0.35;
const PAIR_CHECK_INTERVAL = 1_024;
const CPU_SLICE_MS = 8;

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}

function cosineSimilarity(a: Float32Array | undefined, b: Float32Array | undefined): number {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const token of small) {
		if (large.has(token)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

function proximityMeta(candidate: RankedChunk): ProximityMeta {
	return {
		filePath: candidate.chunk.file_path,
		kbId: candidate.chunk.kb_id,
		startLine: candidate.startLine,
		endLine: candidate.endLine,
		sourceIds: new Set(candidate.sourceChunkIds),
	};
}

function lineProximity(a: ProximityMeta, b: ProximityMeta): number {
	if (a.filePath !== b.filePath || a.kbId !== b.kbId) return 0;
	const [small, large] = a.sourceIds.size <= b.sourceIds.size ? [a.sourceIds, b.sourceIds] : [b.sourceIds, a.sourceIds];
	for (const id of small) {
		if (large.has(id)) return 1;
	}
	const overlap = Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
	if (overlap > 0) return 1;
	const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
	if (gap <= 20) return 0.8;
	if (gap <= 80) return 0.45;
	return 0.2;
}

function normalizeScores(candidates: RankedChunk[]): Float64Array {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		if (candidate.score < min) min = candidate.score;
		if (candidate.score > max) max = candidate.score;
	}
	const normalized = new Float64Array(candidates.length);
	for (let i = 0; i < candidates.length; i++) {
		normalized[i] = max === min ? 1 : (candidates[i].score - min) / (max - min);
	}
	return normalized;
}

function firstUnusedIndex(used: Uint8Array): number {
	for (let i = 0; i < used.length; i++) {
		if (used[i] === 0) return i;
	}
	throw new Error("Diversity selection exhausted its candidate pool unexpectedly");
}

export async function diversifyRankedChunks(
	candidates: RankedChunk[],
	diversity: DiversityMode,
	vectorsByChunkId: Map<string, Float32Array> = new Map(),
	signal?: AbortSignal,
): Promise<RankedChunk[]> {
	throwIfAborted(signal);
	if (diversity === "off" || candidates.length <= 2) return candidates;

	const lambda = diversity === "strong" ? 0.62 : 0.76;
	const n = candidates.length;
	const tokenSets = new Array<Set<string>>(n);
	const vectors = new Array<Float32Array | undefined>(n);
	const metas = new Array<ProximityMeta>(n);
	const relevance = normalizeScores(candidates);
	for (let i = 0; i < n; i++) {
		const candidate = candidates[i];
		tokenSets[i] = tokenizeForSearch(candidate.content);
		vectors[i] = vectorsByChunkId.get(candidate.chunk.id);
		metas[i] = proximityMeta(candidate);
	}

	const pairRedundancy = (a: number, b: number): number => {
		let best = lineProximity(metas[a], metas[b]);
		const lexical = jaccardSimilarity(tokenSets[a], tokenSets[b]);
		if (lexical > best) best = lexical;
		const va = vectors[a];
		const vb = vectors[b];
		if (va !== undefined && vb !== undefined) {
			const vector = Math.max(0, cosineSimilarity(va, vb)) * VECTOR_REDUNDANCY_WEIGHT;
			if (vector > best) best = vector;
		}
		return best;
	};

	const redundancy = new Float64Array(n);
	const used = new Uint8Array(n);
	const selected = new Array<RankedChunk>(n);
	let pairsSinceCheck = 0;
	let sliceStartedAt = performance.now();

	for (let round = 0; round < n; round++) {
		throwIfAborted(signal);
		let bestIndex = firstUnusedIndex(used);
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < n; i++) {
			if (used[i] === 1) continue;
			const mmrScore = lambda * relevance[i] - (1 - lambda) * redundancy[i];
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIndex = i;
			}
		}

		used[bestIndex] = 1;
		selected[round] = candidates[bestIndex];
		for (let i = 0; i < n; i++) {
			if (used[i] === 1) continue;
			const pair = pairRedundancy(bestIndex, i);
			if (pair > redundancy[i]) redundancy[i] = pair;
			pairsSinceCheck++;
			if (pairsSinceCheck < PAIR_CHECK_INTERVAL) continue;
			pairsSinceCheck = 0;
			throwIfAborted(signal);
			if (performance.now() - sliceStartedAt < CPU_SLICE_MS) continue;
			await yieldToEventLoop();
			throwIfAborted(signal);
			sliceStartedAt = performance.now();
		}
	}

	return selected;
}

export function interleaveByFile(
	candidates: RankedChunk[],
	diversity: DiversityMode,
	signal?: AbortSignal,
): RankedChunk[] {
	throwIfAborted(signal);
	if (diversity === "off" || candidates.length <= 2) return candidates;
	const buckets = new Map<string, RankedChunk[]>();
	const fileOrder: string[] = [];
	for (const candidate of candidates) {
		throwIfAborted(signal);
		const key = `${candidate.chunk.kb_id}:${candidate.chunk.file_path}`;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = [];
			buckets.set(key, bucket);
			fileOrder.push(key);
		}
		bucket.push(candidate);
	}
	if (fileOrder.length <= 1) return candidates;

	const result: RankedChunk[] = [];
	let round = 0;
	while (result.length < candidates.length) {
		let added = false;
		for (const key of fileOrder) {
			const item = buckets.get(key)?.[round];
			if (!item) continue;
			result.push(item);
			added = true;
		}
		if (!added) break;
		round++;
	}
	return result;
}
