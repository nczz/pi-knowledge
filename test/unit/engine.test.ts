import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, createKB, insertChunks, getChunkIdsByKB } from "../../src/storage/sqlite.ts";
import { preTokenizeForFTS, contentHash } from "../../src/indexer/chunker.ts";
import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { KnowledgeEngine } from "../../src/engine.ts";

const TEST_DIR = "/tmp/pk-test-engine";

function makeChunks(texts: string[]) {
	return texts.map((t) => ({
		content_hash: contentHash(t), content: t, content_tokenized: preTokenizeForFTS(t),
		file_path: "test.md", file_type: "markdown", start_line: 1, end_line: 1, metadata_json: "{}",
	}));
}

describe("KnowledgeEngine", () => {
	let engine: KnowledgeEngine;

	beforeEach(async () => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
	});

	afterEach(async () => {
		await engine.dispose();
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	describe("vector cache", () => {
		it("search uses cached vectors (no repeated disk reads)", async () => {
			// Add inline text KB
			await engine.add("This is a test document about authentication and OAuth tokens for testing.", "CacheTest");
			// First search loads from disk into cache
			const r1 = await engine.search("test", { mode: "fast" });
			// Second search should use cache (same result, no error)
			const r2 = await engine.search("test", { mode: "fast" });
			expect(r1.total_count).toBe(r2.total_count);
		});

		it("remove invalidates cache", async () => {
			await engine.add("Content about vector caching and memory management for knowledge bases.", "ToRemove");
			const before = await engine.search("vector", { mode: "fast" });
			expect(before.total_count).toBeGreaterThan(0);
			engine.remove("ToRemove");
			const after = await engine.search("vector", { mode: "fast" });
			expect(after.total_count).toBe(0);
		});

		it("clear invalidates all caches", async () => {
			await engine.add("First knowledge base content about databases and SQL queries.", "KB1");
			await engine.add("Second knowledge base content about APIs and REST endpoints.", "KB2");
			engine.clear();
			expect(engine.list().length).toBe(0);
		});
	});

	describe("schema migration", () => {
		it("opens existing DB without error", async () => {
			// Dispose and re-initialize (simulates restart)
			await engine.dispose();
			engine = new KnowledgeEngine();
			await engine.initialize(TEST_DIR);
			// Should not throw
			expect(engine.list()).toEqual([]);
		});
	});

	describe("model mismatch warning", () => {
		it("no warning when model matches", async () => {
			await engine.add("Test content for model mismatch checking with enough text to be indexed.", "ModelTest");
			const result = await engine.search("model", { mode: "fast" });
			expect(result.warnings).toBeUndefined();
		});
	});

	describe("short file fallback", () => {
		it("indexes short content as single chunk", async () => {
			const { chunkCount } = await engine.add("Short but valid content.", "Short");
			expect(chunkCount).toBe(1);
		});
	});
});
