export interface VectorResult { chunkId: string; score: number; }

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

export function searchVector(queryVec: Float32Array, vectors: Float32Array[], chunkIds: string[], limit = 50): VectorResult[] {
	const scores = vectors.map((v, i) => ({ chunkId: chunkIds[i], score: cosine(queryVec, v) }));
	scores.sort((a, b) => b.score - a.score);
	return scores.slice(0, limit);
}
