import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";

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

	describe("vector storage", () => {
		it("search reads persisted vectors consistently", async () => {
			// Add inline text KB
			await engine.add("This is a test document about authentication and OAuth tokens for testing.", "CacheTest");
			// Repeated searches should read persisted vectors consistently.
			const r1 = await engine.search("test", { mode: "fast" });
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

	describe("add", () => {
		it("rejects duplicate knowledge base names", async () => {
			await engine.add("Original content about authentication tokens and sessions.", "Duplicate");

			await expect(engine.add("Replacement content about billing invoices and payments.", "Duplicate")).rejects.toThrow(
				'Knowledge base "Duplicate" already exists',
			);
		});

		it("does not idle-dispose the embedding model during large add batches", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-large-add-"));
			try {
				for (let i = 0; i < 150; i++) {
					writeFileSync(
						join(projectDir, `doc-${i}.txt`),
						`Large batch document ${i} about AlphaBatchToken authentication and indexing reliability. `.repeat(3),
					);
				}

				const { chunkCount } = await engine.add(projectDir, "Large Batch");
				expect(chunkCount).toBe(150);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("reports indexing progress with file counts and ETA", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-progress-"));
			try {
				for (let i = 0; i < 70; i++) {
					writeFileSync(
						join(projectDir, `doc-${i}.txt`),
						`Progress document ${i} about ProgressToken stable indexing and observable batches. `.repeat(3),
					);
				}
				const updates: string[] = [];

				const { chunkCount } = await engine.add(projectDir, "Progress", (message) => updates.push(message));

				expect(chunkCount).toBe(70);
				expect(updates.some((message) => message.includes("Scanning"))).toBe(true);
				expect(updates.some((message) => message.includes("Found 70 files"))).toBe(true);
				expect(updates.some((message) => message.includes("Embedding batch"))).toBe(true);
				expect(updates.some((message) => message.includes("ETA"))).toBe(true);
				expect(updates.at(-1)).toContain("Ready: 70 chunks from 70 files");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("directory indexing skips common build output and secret config files", async () => {
			const projectDir = join(TEST_DIR, "project");
			mkdirSync(join(projectDir, "src"), { recursive: true });
			mkdirSync(join(projectDir, "bin"), { recursive: true });
			mkdirSync(join(projectDir, "obj"), { recursive: true });
			writeFileSync(join(projectDir, "src", "Program.cs"), 'public class Program { string topic = "AlphaSafeToken"; }');
			writeFileSync(join(projectDir, "setting.json"), '{"ConnectionString":"SecretShouldNotIndex"}');
			writeFileSync(join(projectDir, "bin", "runtime.json"), '{"runtime":"BuildOutputShouldNotIndex"}');
			writeFileSync(join(projectDir, "obj", "assets.json"), '{"asset":"ObjShouldNotIndex"}');

			const { kb } = await engine.add(projectDir, "Filtered Project");

			expect(kb.file_count).toBe(1);
			const safe = await engine.search("AlphaSafeToken", { mode: "fast" });
			expect(safe.total_count).toBeGreaterThan(0);
			const secret = await engine.search("SecretShouldNotIndex", { mode: "fast" });
			expect(secret.total_count).toBe(0);
			const build = await engine.search("BuildOutputShouldNotIndex", { mode: "fast" });
			expect(build.total_count).toBe(0);
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

		it("reports batched progress while embedding many changed chunks", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-large-update-"));
			try {
				for (let i = 0; i < 70; i++) {
					writeFileSync(
						join(projectDir, `doc-${i}.txt`),
						`Initial update document ${i} about BatchUpdateToken stable indexing and observable changes. `.repeat(3),
					);
				}
				await engine.add(projectDir, "Large Update");
				for (let i = 0; i < 70; i++) {
					writeFileSync(
						join(projectDir, `doc-${i}.txt`),
						`Changed update document ${i} about BatchUpdateToken stable indexing and observable changes. `.repeat(3),
					);
				}
				const updates: string[] = [];

				const result = await engine.update("Large Update", (message) => updates.push(message));

				expect(result.added).toBe(70);
				expect(result.removed).toBe(70);
				expect(updates.some((message) => message.includes("Embedding update batch"))).toBe(true);
				expect(updates.some((message) => message.includes("Stored update batch"))).toBe(true);
				expect(updates.some((message) => message.includes("ETA"))).toBe(true);
				expect(updates.at(-1)).toBe("Ready: +70 -70 =0");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	describe("search", () => {
		it("accepts a knowledge base name in kb_id", async () => {
			const { kb } = await engine.add(
				"Scoped search content about SearchByNameToken and exact knowledge base names.",
				"Search Scope",
			);

			const byName = await engine.search("SearchByNameToken", { mode: "fast", kb_id: "Search Scope" });
			expect(byName.total_count).toBeGreaterThan(0);

			const byId = await engine.search("SearchByNameToken", { mode: "fast", kb_id: kb.id });
			expect(byId.total_count).toBe(byName.total_count);
		});

		it("diversifies repeated hits from the same file", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-diversity-"));
			try {
				writeFileSync(
					join(projectDir, "dominant.md"),
					[
						"# Dominant One",
						"AlphaDiversityToken repeated material about billing workflows and permission policy.",
						"# Dominant Two",
						"AlphaDiversityToken repeated material about billing workflows and permission policy.",
						"# Dominant Three",
						"AlphaDiversityToken repeated material about billing workflows and permission policy.",
					].join("\n\n"),
				);
				writeFileSync(
					join(projectDir, "secondary.md"),
					"# Secondary\n\nAlphaDiversityToken independent material about audit workflows and command visibility.",
				);

				await engine.add(projectDir, "Diversity");
				const result = await engine.search("AlphaDiversityToken workflows", {
					mode: "fast",
					limit: 3,
					diversity: "strong",
				});

				expect(result.results.map((r) => r.file_path)).toContain("secondary.md");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("adaptive mode expands a relevant seed with neighboring context", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-adaptive-"));
			try {
				writeFileSync(
					join(projectDir, "guide.md"),
					[
						"# Search Setup",
						"AdaptiveSeedToken explains the searchable setup flow and retrieval trigger.",
						"# Operational Context",
						"NeighborContextToken explains the operational caveat that should travel with nearby search setup.",
					].join("\n\n"),
				);

				await engine.add(projectDir, "Adaptive");
				const result = await engine.search("AdaptiveSeedToken", { mode: "adaptive", limit: 1 });

				expect(result.results[0].content).toContain("AdaptiveSeedToken");
				expect(result.results[0].content).toContain("NeighborContextToken");
				expect(result.results[0].snippet).toContain("AdaptiveSeedToken");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("adaptive mode collapses overlapping seed windows", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-adaptive-overlap-"));
			try {
				writeFileSync(
					join(projectDir, "cluster.md"),
					[
						"# Cluster One",
						"OverlapSeedToken explains permissions and visibility in the first nearby section.",
						"# Cluster Two",
						"OverlapSeedToken explains permissions and visibility in the second nearby section.",
						"# Cluster Three",
						"OverlapSeedToken explains permissions and visibility in the third nearby section.",
						"# Cluster Four",
						"OverlapSeedToken explains permissions and visibility in the fourth nearby section.",
					].join("\n\n"),
				);

				await engine.add(projectDir, "Adaptive Overlap");
				const result = await engine.search("OverlapSeedToken permissions visibility", {
					mode: "adaptive",
					limit: 5,
					diversity: "off",
				});

				expect(result.total_count).toBe(1);
				expect(result.results[0].content).toContain("Cluster One");
				expect(result.results[0].content).toContain("Cluster Four");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("search can use indexed file context after rebuild", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-contextual-index-"));
			try {
				mkdirSync(join(projectDir, "docs"), { recursive: true });
				writeFileSync(
					join(projectDir, "docs", "billing-refunds.md"),
					"## Policy\n\nContextualIndexToken explains the approval workflow and operational guardrails.",
				);

				await engine.add(projectDir, "Contextual Index");
				const result = await engine.search("billing refunds approval workflow", {
					mode: "fast",
					limit: 1,
					diversity: "off",
				});

				expect(result.results[0].content).toContain("ContextualIndexToken");
				expect(result.results[0].file_path).toBe("docs/billing-refunds.md");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("accepts common file type aliases in filters", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-file-type-alias-"));
			try {
				writeFileSync(
					join(projectDir, "README.md"),
					"## Alias\n\nFileTypeAliasToken explains markdown filter aliases and retrieval behavior.",
				);

				await engine.add(projectDir, "File Type Alias");
				const result = await engine.search("FileTypeAliasToken", {
					mode: "fast",
					filters: { file_type: "md" },
				});

				expect(result.total_count).toBeGreaterThan(0);
				expect(result.results.every((r) => r.file_type === "markdown")).toBe(true);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("keeps broad recall for filtered source file searches", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-go-filter-recall-"));
			try {
				mkdirSync(join(projectDir, "bot"), { recursive: true });
				for (let i = 0; i < 45; i++) {
					writeFileSync(
						join(projectDir, "bot", `handler_${i}.go`),
						[
							"package bot",
							`func DiscordBotHandler${i}() string {`,
							'  return "GoFilterRecallToken discord bot command handler manager workflow"',
							"}",
						].join("\n"),
					);
				}

				await engine.add(projectDir, "Go Filter Recall");
				const result = await engine.search("discord bot", {
					mode: "hybrid",
					limit: 50,
					filters: { file_type: "go" },
					diversity: "strong",
				});

				expect(result.total_count).toBeGreaterThanOrEqual(40);
				expect(result.results.every((r) => r.file_type === "go")).toBe(true);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("hybrid mode returns no results when there is no lexical anchor", async () => {
			await engine.add("Relevant content about authentication tokens and command permissions.", "No Garbage");

			const result = await engine.search("zzzxqv blorfwump qqqqnonexistent", {
				mode: "hybrid",
				limit: 5,
			});

			expect(result.total_count).toBe(0);
			expect(result.results).toEqual([]);
		});

		it("hybrid mode suppresses low-confidence garbage queries with one accidental token match", async () => {
			await engine.add(
				"Review examples mention unknown edge cases, reproducible failures, and unrelated diagnostics.",
				"Accidental Match",
			);

			const result = await engine.search("blablabla xyz unknown nonsense", {
				mode: "hybrid",
				limit: 3,
			});

			expect(result.total_count).toBe(0);
			expect(result.results).toEqual([]);
		});

		it("boosts small modules when the query names their path", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-small-module-"));
			try {
				mkdirSync(join(projectDir, "stt"), { recursive: true });
				writeFileSync(
					join(projectDir, "stt", "stt.go"),
					[
						"package stt",
						"func TranscribeAudio() string {",
						'  return "SmallModuleToken speech transcription command pipeline"',
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "README.md"),
					"## Speech\n\nSmallModuleToken speech transcription command pipeline overview.",
				);

				await engine.add(projectDir, "Small Module");
				const result = await engine.search("stt speech transcription command", {
					mode: "hybrid",
					limit: 2,
					diversity: "strong",
				});

				expect(result.results[0].file_path).toBe("stt/stt.go");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("ranks a named small source module above overview documentation", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-stt-module-"));
			try {
				mkdirSync(join(projectDir, "stt"), { recursive: true });
				writeFileSync(
					join(projectDir, "stt", "stt.go"),
					[
						"package stt",
						"type Provider interface {",
						"  SpeechToTextProvider() string",
						"}",
						"func NewProvider() Provider {",
						'  _ = "STT speech to text provider"',
						"  return nil",
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "README.md"),
					"## STT Providers\n\nSTT speech to text provider setup table and feature overview.",
				);

				await engine.add(projectDir, "STT Module");
				const result = await engine.search("STT speech to text provider", {
					mode: "hybrid",
					limit: 2,
					diversity: "strong",
				});

				expect(result.results[0].file_path).toBe("stt/stt.go");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("prefers implementation files over tests unless the query asks for tests", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-impl-before-test-"));
			try {
				writeFileSync(
					join(projectDir, "error.go"),
					[
						"package app",
						"func HandleError() error {",
						'  _ = "ErrorHandlingToken error handling retry classification"',
						"  return nil",
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "error_test.go"),
					[
						"package app",
						"func TestHandleError() {",
						'  _ = "ErrorHandlingToken error handling retry classification"',
						"}",
					].join("\n"),
				);

				await engine.add(projectDir, "Implementation Priority");
				const implementation = await engine.search("ErrorHandlingToken error handling", {
					mode: "hybrid",
					limit: 2,
					diversity: "strong",
				});
				expect(implementation.results[0].file_path).toBe("error.go");

				const tests = await engine.search("ErrorHandlingToken error handling test", {
					mode: "hybrid",
					limit: 2,
					diversity: "strong",
				});
				expect(tests.results[0].file_path).toBe("error_test.go");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("keeps a core errors implementation ahead of broad error-heavy files", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-error-core-"));
			try {
				mkdirSync(join(projectDir, "bot"), { recursive: true });
				mkdirSync(join(projectDir, "acp"), { recursive: true });
				writeFileSync(
					join(projectDir, "bot", "errors.go"),
					[
						"package bot",
						"func FormatError() string {",
						'  return "error handling logging commandError user-facing error formatting"',
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "bot", "errors_test.go"),
					[
						"package bot",
						"func TestFormatError() {",
						'  _ = "error handling logging commandError errors.New expected output"',
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "acp", "agent.go"),
					[
						"package acp",
						"func wrapHandshakeError() string {",
						'  return "handshake error wrapping error handling logging transport error"',
						"}",
					].join("\n"),
				);

				await engine.add(projectDir, "Error Core");
				const result = await engine.search("error handling logging", {
					mode: "hybrid",
					limit: 3,
					diversity: "strong",
				});

				expect(result.results[0].file_path).toBe("bot/errors.go");
				expect(result.results.findIndex((r) => r.file_path === "bot/errors_test.go")).toBeGreaterThan(0);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("demotes localization catalogs for implementation-oriented queries", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-locale-demotion-"));
			try {
				mkdirSync(join(projectDir, "channel"), { recursive: true });
				mkdirSync(join(projectDir, "locale", "lang"), { recursive: true });
				writeFileSync(
					join(projectDir, "channel", "memory.go"),
					[
						"package channel",
						"func ManageMemoryContext() string {",
						'  return "LocaleDemotionToken memory context management implementation"',
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "locale", "lang", "en.json"),
					JSON.stringify({
						memory_context_management: "LocaleDemotionToken memory context management translation message labels",
					}),
				);

				await engine.add(projectDir, "Locale Demotion");
				const implementation = await engine.search("LocaleDemotionToken memory context management", {
					mode: "hybrid",
					limit: 2,
					diversity: "strong",
				});
				expect(implementation.results[0].file_path).toBe("channel/memory.go");

				const localization = await engine.search("LocaleDemotionToken memory context translation message", {
					mode: "hybrid",
					limit: 2,
					diversity: "strong",
				});
				expect(localization.results[0].file_path).toBe("locale/lang/en.json");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("interleaves files so README-like documents do not dominate hybrid results", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-file-interleave-"));
			try {
				writeFileSync(
					join(projectDir, "README.md"),
					[
						"# Commands",
						"InterleaveToken default member permissions command visibility manage channels.",
						"## Usage",
						"InterleaveToken default member permissions command visibility manage channels.",
						"## Notes",
						"InterleaveToken default member permissions command visibility manage channels.",
					].join("\n\n"),
				);
				mkdirSync(join(projectDir, "bot"), { recursive: true });
				writeFileSync(
					join(projectDir, "bot", "interaction_policy.go"),
					[
						"package bot",
						"func commandDefaultMemberPermissions() {",
						'  _ = "InterleaveToken default member permissions command visibility manage channels"',
						"}",
					].join("\n"),
				);
				writeFileSync(
					join(projectDir, "bot", "handler_test.go"),
					[
						"package bot",
						"func TestSlashCommandsApplyVisibilityAndPermissionPolicy() {",
						'  _ = "InterleaveToken default member permissions command visibility manage channels"',
						"}",
					].join("\n"),
				);

				await engine.add(projectDir, "File Interleave");
				const result = await engine.search("InterleaveToken default member permissions command visibility", {
					mode: "hybrid",
					limit: 3,
					diversity: "strong",
				});

				expect(new Set(result.results.map((r) => r.file_path)).size).toBeGreaterThan(1);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("skips knowledge bases that are still indexing", async () => {
			await engine.add("Indexing status content about SkipIndexingToken and partial rebuilds.", "Partial");
			const [{ id }] = engine.list();
			const db = openDatabase(TEST_DIR);
			try {
				db.prepare("UPDATE knowledge_bases SET status = 'indexing', updated_at = ? WHERE id = ?").run(Date.now(), id);
			} finally {
				db.close();
			}

			const result = await engine.search("SkipIndexingToken", { mode: "hybrid" });
			expect(result.total_count).toBe(0);
			expect(result.warnings?.[0]).toContain('"Partial" is indexing');
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

		it("detects stale indexing state left behind by interrupted runs", async () => {
			await engine.add("Interrupted indexing content about status diagnostics and recovery.", "Interrupted");
			const [{ id }] = engine.list();
			const db = openDatabase(TEST_DIR);
			try {
				db.prepare("UPDATE knowledge_bases SET status = 'indexing', updated_at = ? WHERE id = ?").run(
					Date.now() - 15 * 60 * 1000,
					id,
				);
			} finally {
				db.close();
			}

			const [diagnostic] = engine.diagnose();
			expect(diagnostic.status).toBe("indexing");
			expect(diagnostic.stuck_indexing).toBe(true);
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
