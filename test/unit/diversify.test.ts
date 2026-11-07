import { describe, expect, it } from "vitest";
import { diversifyRankedChunks, type RankedChunk } from "../../src/engine.ts";
import type { Chunk } from "../../src/storage/sqlite.ts";

/**
 * Reference implementation kept verbatim from the pre-optimization greedy MMR:
 * every selection round re-scores every remaining candidate against every
 * already-selected one. O(n^3/6) pair evaluations. The optimized version folds
 * each unordered pair in exactly once; these must agree on output order.
 */
function referenceDiversify(
	candidates: RankedChunk[],
	diversity: "balanced" | "strong",
	vectorsByChunkId: Map<string, Float32Array>,
): RankedChunk[] {
	if (candidates.length <= 2) return candidates;
	const lambda = diversity === "strong" ? 0.62 : 0.76;

	const scores = candidates.map((c) => c.score);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const normalized = new Map<string, number>();
	for (const c of candidates) normalized.set(c.chunk.id, max === min ? 1 : (c.score - min) / (max - min));

	const tokens = (text: string) => new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
	const jaccard = (a: Set<string>, b: Set<string>) => {
		if (a.size === 0 || b.size === 0) return 0;
		let inter = 0;
		for (const t of a) if (b.has(t)) inter++;
		return inter / (a.size + b.size - inter);
	};
	const cosine = (a?: Float32Array, b?: Float32Array) => {
		if (!a || !b || a.length !== b.length) return 0;
		let dot = 0;
		for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
		return dot;
	};
	const proximity = (a: RankedChunk, b: RankedChunk) => {
		if (a.chunk.file_path !== b.chunk.file_path || a.chunk.kb_id !== b.chunk.kb_id) return 0;
		if (a.sourceChunkIds.some((id) => b.sourceChunkIds.includes(id))) return 1;
		const overlap = Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
		if (overlap > 0) return 1;
		const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
		if (gap <= 20) return 0.8;
		if (gap <= 80) return 0.45;
		return 0.2;
	};

	const selected: RankedChunk[] = [];
	const remaining = [...candidates];
	while (remaining.length > 0) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			let redundancy = 0;
			for (const chosen of selected) {
				const lexical = jaccard(tokens(candidate.content), tokens(chosen.content));
				const vector = Math.max(
					0,
					cosine(vectorsByChunkId.get(candidate.chunk.id), vectorsByChunkId.get(chosen.chunk.id)),
				);
				redundancy = Math.max(redundancy, Math.max(lexical, proximity(candidate, chosen), vector * 0.35));
			}
			const relevance = normalized.get(candidate.chunk.id) ?? 0;
			const mmrScore = lambda * relevance - (1 - lambda) * redundancy;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIndex = i;
			}
		}
		selected.push(remaining.splice(bestIndex, 1)[0]);
	}
	return selected;
}

const VOCAB = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "iota"];

/** Deterministic PRNG so the differential cases are reproducible in CI. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeCase(
	seed: number,
	n: number,
	dim: number,
): { candidates: RankedChunk[]; vectors: Map<string, Float32Array> } {
	const rnd = mulberry32(seed);
	const candidates: RankedChunk[] = [];
	const vectors = new Map<string, Float32Array>();
	const files = ["src/a.ts", "src/b.ts", "docs/c.md"];
	for (let i = 0; i < n; i++) {
		const id = `c${i}`;
		const content = Array.from(
			{ length: 4 + Math.floor(rnd() * 12) },
			() => VOCAB[Math.floor(rnd() * VOCAB.length)],
		).join(" ");
		const startLine = Math.floor(rnd() * 200);
		const chunk = { id, kb_id: "kb1", file_path: files[Math.floor(rnd() * files.length)] } as unknown as Chunk;
		candidates.push({
			chunk,
			kbName: "kb1",
			score: Math.round(rnd() * 1000) / 1000,
			content,
			snippet: content,
			startLine,
			endLine: startLine + 1 + Math.floor(rnd() * 40),
			// Overlapping source ids exercise the set-intersection branch of lineProximity.
			sourceChunkIds: [`${Math.floor(rnd() * 4)}`, `s${i}`],
		});
		const v = new Float32Array(dim);
		for (let d = 0; d < dim; d++) v[d] = rnd() - 0.5;
		vectors.set(id, v);
	}
	// Some candidates intentionally share a chunk id and have no vector, matching
	// real duplicate-folded results where vectorsByChunkId misses an entry.
	if (n > 4) candidates[n - 1] = { ...candidates[n - 1], chunk: { ...candidates[0].chunk } as Chunk };
	return { candidates, vectors };
}

describe("diversifyRankedChunks", () => {
	it("matches the pre-optimization reference on randomized cases", () => {
		for (const seed of [1, 2, 7, 11, 23, 42, 99, 1234]) {
			for (const n of [3, 5, 9, 17, 33]) {
				for (const diversity of ["balanced", "strong"] as const) {
					const { candidates, vectors } = makeCase(seed + n, n, 16);
					const ids = (list: RankedChunk[]) => list.map((c) => `${c.chunk.id}:${c.startLine}`);
					expect(ids(diversifyRankedChunks(candidates, diversity, vectors))).toEqual(
						ids(referenceDiversify(candidates, diversity, vectors)),
					);
				}
			}
		}
	});

	it("returns the input unchanged for diversity=off and tiny pools", () => {
		const { candidates, vectors } = makeCase(5, 2, 8);
		expect(diversifyRankedChunks(candidates, "off", vectors)).toBe(candidates);
		const three = makeCase(6, 3, 8);
		expect(diversifyRankedChunks(three.candidates, "off", three.vectors)).toBe(three.candidates);
		expect(diversifyRankedChunks([], "balanced")).toEqual([]);
	});

	it("selects each candidate exactly once and scales linearly in pairs", () => {
		const { candidates, vectors } = makeCase(77, 120, 32);
		const out = diversifyRankedChunks(candidates, "strong", vectors);
		expect(out).toHaveLength(candidates.length);
		expect(new Set(out.map((c) => c.startLine)).size).toBeGreaterThan(1);
	});
});
