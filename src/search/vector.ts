import { openVectorReader } from "../embedding/vectors.ts";

export interface VectorResult {
	chunkId: string;
	score: number;
}

export interface VectorFileSearchResult {
	results: VectorResult[];
	vectorsByChunkId: Map<string, Float32Array>;
}

type ChunkIdSource = Iterable<string | { id: string }>;

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

function keepTopK(
	top: Array<VectorResult & { vector: Float32Array }>,
	item: VectorResult,
	vector: Float32Array,
	limit: number,
): void {
	if (limit <= 0) return;
	if (top.length < limit) {
		const stored = { ...item, vector: new Float32Array(vector) };
		top.push(stored);
		top.sort((a, b) => a.score - b.score);
		return;
	}
	if (item.score <= top[0].score) return;
	const stored = { ...item, vector: new Float32Array(vector) };
	top[0] = stored;
	top.sort((a, b) => a.score - b.score);
}

export function searchVector(
	queryVec: Float32Array,
	vectors: Float32Array[],
	chunkIds: string[],
	limit = 50,
): VectorResult[] {
	const scores = vectors.map((v, i) => ({ chunkId: chunkIds[i], score: cosine(queryVec, v) }));
	scores.sort((a, b) => b.score - a.score);
	return scores.slice(0, limit);
}

export function searchVectorFile(
	queryVec: Float32Array,
	vectorPath: string,
	chunkIds: ChunkIdSource,
	limit = 50,
): VectorFileSearchResult {
	const reader = openVectorReader(vectorPath);
	if (!reader) return { results: [], vectorsByChunkId: new Map() };
	try {
		if (reader.dim !== queryVec.length) return { results: [], vectorsByChunkId: new Map() };
		const scratch = new Float32Array(reader.dim);
		const top: Array<VectorResult & { vector: Float32Array }> = [];
		let i = 0;
		for (const chunkIdRef of chunkIds) {
			if (i >= reader.count) break;
			const vectorIndex = i;
			i++;
			if (!reader.readInto(vectorIndex, scratch)) continue;
			const chunkId = typeof chunkIdRef === "string" ? chunkIdRef : chunkIdRef.id;
			keepTopK(top, { chunkId, score: cosine(queryVec, scratch) }, scratch, limit);
		}
		const sorted = top.sort((a, b) => b.score - a.score);
		const vectorsByChunkId = new Map(sorted.map((item) => [item.chunkId, item.vector]));
		return {
			results: sorted.map(({ chunkId, score }) => ({ chunkId, score })),
			vectorsByChunkId,
		};
	} finally {
		reader.close();
	}
}
