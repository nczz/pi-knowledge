export interface FusionResult { chunkId: string; score: number; }

export function reciprocalRankFusion(lists: Array<{ chunkId: string; score: number }[]>, k = 60): FusionResult[] {
	const scores = new Map<string, number>();
	for (const list of lists) {
		for (let rank = 0; rank < list.length; rank++) {
			const { chunkId } = list[rank];
			scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank + 1));
		}
	}
	return [...scores.entries()]
		.map(([chunkId, score]) => ({ chunkId, score }))
		.sort((a, b) => b.score - a.score);
}
