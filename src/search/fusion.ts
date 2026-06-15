export interface FusionResult {
	chunkId: string;
	score: number;
}

function normalizeScores(list: Array<{ chunkId: string; score: number }>): Map<string, number> {
	if (list.length === 0) return new Map();
	const scores = list.map((item) => item.score);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	return new Map(
		list.map((item) => {
			const normalized = max === min ? 1 : (item.score - min) / (max - min);
			return [item.chunkId, normalized];
		}),
	);
}

export function reciprocalRankFusion(lists: Array<{ chunkId: string; score: number }[]>, k = 60): FusionResult[] {
	const scores = new Map<string, number>();
	for (const list of lists) {
		for (let rank = 0; rank < list.length; rank++) {
			const { chunkId } = list[rank];
			scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank + 1));
		}
	}
	return [...scores.entries()].map(([chunkId, score]) => ({ chunkId, score })).sort((a, b) => b.score - a.score);
}

export function weightedScoreFusion(
	bm25Results: Array<{ chunkId: string; score: number }>,
	vectorResults: Array<{ chunkId: string; score: number }>,
	weights = { bm25: 0.45, vector: 0.55, overlap: 0.15 },
): FusionResult[] {
	const bm25Scores = normalizeScores(bm25Results);
	const vectorScores = normalizeScores(vectorResults);
	const ids = new Set([...bm25Scores.keys(), ...vectorScores.keys()]);
	const fused: FusionResult[] = [];

	for (const chunkId of ids) {
		const bm25 = bm25Scores.get(chunkId) ?? 0;
		const vector = vectorScores.get(chunkId) ?? 0;
		const overlap = bm25 > 0 && vector > 0 ? weights.overlap : 0;
		fused.push({ chunkId, score: weights.bm25 * bm25 + weights.vector * vector + overlap });
	}

	return fused.sort((a, b) => b.score - a.score);
}
