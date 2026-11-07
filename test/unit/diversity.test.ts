import { setImmediate as scheduleImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import { diversifyRankedChunks, interleaveByFile, type RankedChunk } from "../../src/search/diversity.ts";
import { tokenizeForSearch } from "../../src/search/query.ts";

function candidate(index: number, score: number, filePath = `file-${index % 4}.ts`): RankedChunk {
	const id = `chunk-${index}`;
	return {
		chunk: {
			id,
			kb_id: "kb-1",
			content_hash: `hash-${index}`,
			content: `shared token group-${index % 5} detail-${index}`,
			content_tokenized: `shared token group-${index % 5} detail-${index}`,
			file_path: filePath,
			file_type: "typescript",
			start_line: index * 10 + 1,
			end_line: index * 10 + 6,
			metadata_json: "{}",
			indexed_at: 1_767_225_600_000,
		},
		kbName: "Test KB",
		score,
		content: `shared token group-${index % 5} detail-${index}`,
		snippet: `detail-${index}`,
		startLine: index * 10 + 1,
		endLine: index * 10 + 6,
		sourceChunkIds: [id],
	};
}

function cosineSimilarity(a: Float32Array | undefined, b: Float32Array | undefined): number {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

function lineProximity(a: RankedChunk, b: RankedChunk): number {
	if (a.chunk.file_path !== b.chunk.file_path || a.chunk.kb_id !== b.chunk.kb_id) return 0;
	if (a.sourceChunkIds.some((id) => b.sourceChunkIds.includes(id))) return 1;
	const overlap = Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
	if (overlap > 0) return 1;
	const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
	if (gap <= 20) return 0.8;
	if (gap <= 80) return 0.45;
	return 0.2;
}

function referenceDiversity(
	candidates: RankedChunk[],
	mode: "balanced" | "strong",
	vectorsByChunkId: Map<string, Float32Array>,
): RankedChunk[] {
	const lambda = mode === "strong" ? 0.62 : 0.76;
	const minScore = Math.min(...candidates.map((item) => item.score));
	const maxScore = Math.max(...candidates.map((item) => item.score));
	const relevance = new Map(
		candidates.map((item) => [
			item.chunk.id,
			maxScore === minScore ? 1 : (item.score - minScore) / (maxScore - minScore),
		]),
	);
	const tokenSets = new Map(candidates.map((item) => [item.chunk.id, tokenizeForSearch(item.content)]));
	const remaining = [...candidates];
	const selected: RankedChunk[] = [];
	while (remaining.length > 0) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < remaining.length; i++) {
			const current = remaining[i];
			let redundancy = 0;
			for (const prior of selected) {
				const lexical = jaccardSimilarity(
					tokenSets.get(current.chunk.id) ?? new Set(),
					tokenSets.get(prior.chunk.id) ?? new Set(),
				);
				const vector =
					Math.max(0, cosineSimilarity(vectorsByChunkId.get(current.chunk.id), vectorsByChunkId.get(prior.chunk.id))) *
					0.35;
				redundancy = Math.max(redundancy, lexical, vector, lineProximity(current, prior));
			}
			const score = lambda * (relevance.get(current.chunk.id) ?? 0) - (1 - lambda) * redundancy;
			if (score > bestScore) {
				bestIndex = i;
				bestScore = score;
			}
		}
		const [next] = remaining.splice(bestIndex, 1);
		if (!next) throw new Error("Reference selection exhausted candidates unexpectedly");
		selected.push(next);
	}
	return selected;
}

function deterministicScore(index: number): number {
	return ((index * 73 + 19) % 101) / 100;
}

describe("search diversity", () => {
	it.each(["balanced", "strong"] as const)("preserves the established %s ranking order", async (mode) => {
		const candidates = Array.from({ length: 31 }, (_, index) => candidate(index, deterministicScore(index)));
		const vectors = new Map<string, Float32Array>();
		for (let i = 0; i < candidates.length; i++) {
			if (i % 6 === 0) continue;
			const vector = new Float32Array([((i * 3) % 11) / 11, ((i * 7) % 13) / 13, 0.5]);
			vectors.set(candidates[i].chunk.id, vector);
		}

		const actual = await diversifyRankedChunks(candidates, mode, vectors);
		const expected = referenceDiversity(candidates, mode, vectors);

		expect(actual.map((item) => item.chunk.id)).toEqual(expected.map((item) => item.chunk.id));
	});

	it("keeps the original array when diversity is disabled or the candidate pool is tiny", async () => {
		const candidates = [candidate(0, 1), candidate(1, 0.5)];

		expect(await diversifyRankedChunks(candidates, "off")).toBe(candidates);
		expect(await diversifyRankedChunks(candidates, "strong")).toBe(candidates);
	});

	it("interleaves files without changing the order within each file", () => {
		const candidates = [
			candidate(0, 1, "a.ts"),
			candidate(1, 0.9, "a.ts"),
			candidate(2, 0.8, "b.ts"),
			candidate(3, 0.7, "a.ts"),
			candidate(4, 0.6, "b.ts"),
		];

		const result = interleaveByFile(candidates, "balanced");

		expect(result.map((item) => item.chunk.id)).toEqual(["chunk-0", "chunk-2", "chunk-1", "chunk-4", "chunk-3"]);
	});

	it("yields to cancellation during a large CPU-bound ranking pass", async () => {
		const candidates = Array.from({ length: 500 }, (_, index) => candidate(index, deterministicScore(index)));
		const vector = new Float32Array(512);
		vector[0] = 1;
		const vectors = new Map(candidates.map((item) => [item.chunk.id, vector]));
		const controller = new AbortController();
		const abortHandle = scheduleImmediate(() => controller.abort());

		try {
			await expect(diversifyRankedChunks(candidates, "strong", vectors, controller.signal)).rejects.toThrow(
				"Cancelled",
			);
		} finally {
			clearImmediate(abortHandle);
		}
	});
});
