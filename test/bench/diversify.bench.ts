// Timing harness: original O(n^3) greedy MMR vs the running-redundancy port.
// Run: npx vitest --run test/bench/diversify.bench.ts
import { bench, describe } from "vitest";
import { diversifyRankedChunks, type RankedChunk } from "../../src/engine.ts";
import type { Chunk } from "../../src/storage/sqlite.ts";

function referenceDiversify(
	candidates: RankedChunk[],
	diversity: "balanced" | "strong",
	vectorsByChunkId: Map<string, Float32Array>,
): RankedChunk[] {
	const lambda = diversity === "strong" ? 0.62 : 0.76;
	const scores = candidates.map((c) => c.score);
	let min = Infinity;
	let max = -Infinity;
	for (const s of scores) {
		if (s < min) min = s;
		if (s > max) max = s;
	}
	const normalized = new Map<string, number>();
	for (const c of candidates) normalized.set(c.chunk.id, max === min ? 1 : (c.score - min) / (max - min));
	const tokens = new Map(candidates.map((c) => [c.chunk.id, new Set(c.content.toLowerCase().split(/\s+/))]));
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
		let bestScore = -Infinity;
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			let redundancy = 0;
			for (const chosen of selected) {
				const a = tokens.get(candidate.chunk.id) ?? new Set<string>();
				const b = tokens.get(chosen.chunk.id) ?? new Set<string>();
				const lexical = jaccard(a, b);
				const vector = Math.max(
					0,
					cosine(vectorsByChunkId.get(candidate.chunk.id), vectorsByChunkId.get(chosen.chunk.id)),
				);
				redundancy = Math.max(redundancy, Math.max(lexical, proximity(candidate, chosen), vector * 0.35));
			}
			const mmr = lambda * (normalized.get(candidate.chunk.id) ?? 0) - (1 - lambda) * redundancy;
			if (mmr > bestScore) {
				bestScore = mmr;
				bestIndex = i;
			}
		}
		selected.push(remaining.splice(bestIndex, 1)[0]);
	}
	return selected;
}

const VOCAB = Array.from({ length: 40 }, (_, i) => `token${i}`);
function makeCase(n: number, dim: number) {
	let a = 123456789;
	const rnd = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const candidates: RankedChunk[] = [];
	const vectors = new Map<string, Float32Array>();
	for (let i = 0; i < n; i++) {
		const id = `c${i}`;
		// ~250 tokens per chunk, matching real chunk content size.
		const content = Array.from({ length: 250 }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(" ");
		const start = Math.floor(rnd() * 2000);
		candidates.push({
			chunk: { id, kb_id: "kb", file_path: `f${i % 7}.ts` } as unknown as Chunk,
			kbName: "kb",
			score: rnd() * 10,
			content,
			snippet: content,
			startLine: start,
			endLine: start + 30,
			sourceChunkIds: [`s${i % 5}`],
		});
		const v = new Float32Array(dim);
		for (let d = 0; d < dim; d++) v[d] = rnd() - 0.5;
		vectors.set(id, v);
	}
	return { candidates, vectors };
}

// Default sizes keep the bench under a minute; PK_DIVERSIFY_BENCH_N=50,100,200,400 extends it
// (n=400 with 1024-dim vectors is the ~5 minute case).
const SIZES = (process.env.PK_DIVERSIFY_BENCH_N ?? "50,100,200")
	.split(",")
	.map((v) => Number(v.trim()))
	.filter(Number.isFinite);

for (const n of SIZES) {
	const { candidates, vectors } = makeCase(n, 1024);
	describe(`diversifyRankedChunks n=${n} (dim=1024)`, () => {
		bench("optimized (running redundancy)", () => {
			diversifyRankedChunks(candidates, "balanced", vectors);
		});
		bench("original (recompute per round)", () => {
			referenceDiversify(candidates, "balanced", vectors);
		});
	});
}
