import { bench, describe } from "vitest";
import { diversifyRankedChunks, type RankedChunk } from "../../src/search/diversity.ts";
import { tokenizeForSearch } from "../../src/search/query.ts";

function candidate(index: number): RankedChunk {
	const id = `chunk-${index}`;
	const content = `shared architecture search group-${index % 12} detail-${index}`;
	return {
		chunk: {
			id,
			kb_id: "benchmark-kb",
			content_hash: `hash-${index}`,
			content,
			content_tokenized: content,
			file_path: `src/file-${index % 20}.ts`,
			file_type: "typescript",
			start_line: index * 12 + 1,
			end_line: index * 12 + 8,
			metadata_json: "{}",
			indexed_at: 1_767_225_600_000,
		},
		kbName: "Benchmark",
		score: ((index * 73 + 19) % 101) / 100,
		content,
		snippet: content,
		startLine: index * 12 + 1,
		endLine: index * 12 + 8,
		sourceChunkIds: [id],
	};
}

function vectorsFor(candidates: RankedChunk[]): Map<string, Float32Array> {
	return new Map(
		candidates.map((item, index) => {
			const vector = new Float32Array(64);
			for (let dimension = 0; dimension < vector.length; dimension++) {
				vector[dimension] = ((index + 1) * (dimension + 3)) % 17;
			}
			let magnitude = 0;
			for (const value of vector) magnitude += value * value;
			magnitude = Math.sqrt(magnitude);
			for (let dimension = 0; dimension < vector.length; dimension++) vector[dimension] /= magnitude;
			return [item.chunk.id, vector];
		}),
	);
}

function cosineSimilarity(a: Float32Array | undefined, b: Float32Array | undefined): number {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

function lexicalSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

function lineProximity(a: RankedChunk, b: RankedChunk): number {
	if (a.chunk.file_path !== b.chunk.file_path) return 0;
	const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
	if (gap <= 0) return 1;
	if (gap <= 20) return 0.8;
	if (gap <= 80) return 0.45;
	return 0.2;
}

function legacyDiversity(candidates: RankedChunk[], vectorsByChunkId: Map<string, Float32Array>): RankedChunk[] {
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
				const lexical = lexicalSimilarity(
					tokenSets.get(current.chunk.id) ?? new Set(),
					tokenSets.get(prior.chunk.id) ?? new Set(),
				);
				const vector =
					Math.max(0, cosineSimilarity(vectorsByChunkId.get(current.chunk.id), vectorsByChunkId.get(prior.chunk.id))) *
					0.35;
				redundancy = Math.max(redundancy, lexical, vector, lineProximity(current, prior));
			}
			const mmrScore = 0.76 * (relevance.get(current.chunk.id) ?? 0) - 0.24 * redundancy;
			if (mmrScore > bestScore) {
				bestIndex = i;
				bestScore = mmrScore;
			}
		}
		const [next] = remaining.splice(bestIndex, 1);
		if (!next) throw new Error("Legacy benchmark exhausted candidates unexpectedly");
		selected.push(next);
	}
	return selected;
}

const small = Array.from({ length: 50 }, (_, index) => candidate(index));
const medium = Array.from({ length: 150 }, (_, index) => candidate(index));
const boundedMaximum = Array.from({ length: 800 }, (_, index) => candidate(index));
const smallVectors = vectorsFor(small);
const mediumVectors = vectorsFor(medium);
const boundedMaximumVectors = vectorsFor(boundedMaximum);

describe("diversity ranking complexity", () => {
	bench("legacy O(n³), 50 candidates", () => {
		legacyDiversity(small, smallVectors);
	});
	bench("running redundancy O(n²), 50 candidates", async () => {
		await diversifyRankedChunks(small, "balanced", smallVectors);
	});
	bench("legacy O(n³), 150 candidates", () => {
		legacyDiversity(medium, mediumVectors);
	});
	bench("running redundancy O(n²), 150 candidates", async () => {
		await diversifyRankedChunks(medium, "balanced", mediumVectors);
	});
	bench(
		"running redundancy O(n²), bounded 800-candidate maximum",
		async () => {
			await diversifyRankedChunks(boundedMaximum, "balanced", boundedMaximumVectors);
		},
		{ iterations: 3, time: 0 },
	);
});
