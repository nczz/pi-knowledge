import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, preTokenizeForFTS } from "../../src/indexer/chunker.ts";
import { searchBM25 } from "../../src/search/bm25.ts";
import { reciprocalRankFusion, weightedScoreFusion } from "../../src/search/fusion.ts";
import { searchVector } from "../../src/search/vector.ts";
import { createKB, getChunkIdsByKB, insertChunks, openDatabase } from "../../src/storage/sqlite.ts";

const TEST_DIR = "/tmp/pk-test-search";

describe("search pipeline", () => {
	let db: Database.Database;
	let chunkIds: string[];

	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		db = openDatabase(TEST_DIR);
		const kb = createKB(db, { name: "test", source_type: "text" });
		const texts = [
			"SQLite FTS5 full-text search",
			"Vector embeddings semantic",
			"認證流程 OAuth token",
			"React useState state",
		];
		insertChunks(
			db,
			kb.id,
			texts.map((t) => ({
				content_hash: contentHash(t),
				content: t,
				content_tokenized: preTokenizeForFTS(t),
				file_path: "t.md",
				file_type: "markdown",
				start_line: 1,
				end_line: 1,
				metadata_json: "{}",
			})),
		);
		chunkIds = getChunkIdsByKB(db, kb.id);
	});

	afterEach(() => {
		db.close();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	describe("BM25", () => {
		it("finds exact terms", () => expect(searchBM25(db, "OAuth token").length).toBe(1));
		it("finds CJK", () => expect(searchBM25(db, "認證").length).toBe(1));
		it("no match → empty", () => expect(searchBM25(db, "zzzzz")).toEqual([]));
		it("empty query → empty", () => expect(searchBM25(db, "")).toEqual([]));
		it("returns relevance scores where higher is better", () => {
			const results = searchBM25(db, "OAuth token");
			expect(results[0].score).toBeGreaterThan(0);
		});
	});

	describe("Vector search", () => {
		it("top-K sorted", () => {
			const q = new Float32Array([1, 0, 0, 0]);
			const vecs = [
				new Float32Array([0.9, 0.1, 0, 0]),
				new Float32Array([0, 1, 0, 0]),
				new Float32Array([0.5, 0.5, 0, 0]),
				new Float32Array([0.8, 0.2, 0, 0]),
			];
			const r = searchVector(q, vecs, chunkIds, 2);
			expect(r.length).toBe(2);
			expect(r[0].score).toBeGreaterThan(r[1].score);
		});
		it("empty → empty", () => expect(searchVector(new Float32Array([1]), [], [], 10)).toEqual([]));
	});

	describe("RRF", () => {
		it("merges with overlap boosted", () => {
			const l1 = [
				{ chunkId: "a", score: 1 },
				{ chunkId: "b", score: 0.5 },
			];
			const l2 = [
				{ chunkId: "b", score: 1 },
				{ chunkId: "c", score: 0.5 },
			];
			const f = reciprocalRankFusion([l1, l2]);
			expect(f.length).toBe(3);
			expect(f[0].chunkId).toBe("b"); // in both → highest
		});
		it("empty → empty", () => expect(reciprocalRankFusion([[], []])).toEqual([]));
	});

	describe("weighted fusion", () => {
		it("preserves score spread from lexical and vector channels", () => {
			const fused = weightedScoreFusion(
				[
					{ chunkId: "a", score: 100 },
					{ chunkId: "b", score: 20 },
					{ chunkId: "c", score: 1 },
				],
				[
					{ chunkId: "a", score: 0.95 },
					{ chunkId: "b", score: 0.7 },
					{ chunkId: "c", score: 0.2 },
				],
			);

			expect(fused[0].chunkId).toBe("a");
			expect(fused[0].score - fused[2].score).toBeGreaterThan(0.5);
		});
	});
});
