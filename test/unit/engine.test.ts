import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";

const TEST_DIR = "/tmp/pk-test-engine";

describe("KnowledgeEngine", () => {
	let engine: KnowledgeEngine;

	beforeEach(async () => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
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

	describe("update", () => {
		it("updates URL knowledge bases by re-fetching the source", async () => {
			let body = "<html><body>Original URL content about authentication tokens and sessions.</body></html>";
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(body, { status: 200 })),
			);

			await engine.add("https://example.test/docs", "URL");
			body = "<html><body>Changed URL content about billing invoices and payments.</body></html>";

			const result = await engine.update("URL");
			expect(result.added).toBeGreaterThan(0);
			expect(engine.list()[0].source_type).toBe("url");
		});

		it("honors cancellation before embedding changed chunks", async () => {
			const filePath = join(TEST_DIR, "source.txt");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(filePath, "Initial content about authentication tokens and sessions.");
			await engine.add(filePath, "Cancellable");
			writeFileSync(filePath, "Changed content about billing invoices and payments.");

			const controller = new AbortController();
			controller.abort();

			await expect(engine.update("Cancellable", undefined, controller.signal)).rejects.toThrow("Cancelled");
		});
	});

	describe("diagnostics", () => {
		it("detects stale single-file knowledge bases", async () => {
			const filePath = join(TEST_DIR, "single.txt");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(filePath, "Single file content about authentication tokens and sessions.");
			await engine.add(filePath, "SingleFile");

			writeFileSync(filePath, "Updated single file content about authentication tokens and sessions.");
			const future = new Date(Date.now() + 5_000);
			utimesSync(filePath, future, future);

			const [diagnostic] = engine.diagnose();
			expect(diagnostic.stale_files).toContain(filePath);
			expect(diagnostic.orphan_files).toEqual([]);
		});
	});

	describe("import/export", () => {
		it("removes partially created KBs when import fails", async () => {
			const inputPath = join(TEST_DIR, "bad.jsonl");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(inputPath, `${JSON.stringify({ name: "Bad Import" })}\n{not json}\n`);

			await expect(engine.importKB(inputPath)).rejects.toThrow();
			expect(engine.list()).toEqual([]);
		});

		it("imports exported KBs as portable text sources", async () => {
			await engine.add("Portable import export content about authentication tokens and sessions.", "Portable");
			const outputPath = join(TEST_DIR, "portable.jsonl");
			await engine.exportKB("Portable", outputPath);
			engine.clear();

			const { kb } = await engine.importKB(outputPath);
			expect(kb.source_type).toBe("text");
			expect(kb.source_path).toBeNull();
		});
	});
});
