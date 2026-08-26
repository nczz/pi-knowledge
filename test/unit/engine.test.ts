import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeEngine } from "../../src/engine.ts";
import { buildChunkEmbeddingText } from "../../src/indexer/chunker.ts";
import { getChunksByKB, getIndexingJob, openDatabase, updateKBEmbeddingMetadata } from "../../src/storage/sqlite.ts";

const mammothMock = vi.hoisted(() => ({
	extractRawText: vi.fn(),
}));

vi.mock("mammoth", () => ({
	extractRawText: mammothMock.extractRawText,
}));

const TEST_DIR = "/tmp/pk-test-engine";

describe("KnowledgeEngine", () => {
	let engine: KnowledgeEngine;

	beforeEach(async () => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		engine = new KnowledgeEngine();
		await engine.initialize(TEST_DIR);
		mammothMock.extractRawText.mockReset();
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

		it("persists embedding signature metadata for indexed KB vectors", async () => {
			await engine.add("Embedding metadata protects vector compatibility during search.", "EmbeddingMetadata");
			const [kb] = engine.list();

			expect(kb.embedding_model).toBe("multilingual-e5-small");
			expect(kb.embedding_dimension).toBe(384);
			expect(kb.embedding_signature).toContain("local:multilingual-e5-small");
			expect(kb.embedding_signature).toContain("dim=384");
		});

		it("skips vector retrieval for incompatible embedding signatures", async () => {
			await engine.add("OAuth token compatibility search should still have lexical evidence.", "IncompatibleVectors");
			const [kb] = engine.list();
			const db = openDatabase(TEST_DIR);
			try {
				updateKBEmbeddingMetadata(
					db,
					kb.id,
					"openai:text-embedding-3-small",
					"openai:text-embedding-3-small:dim=1536",
					1536,
				);
			} finally {
				db.close();
			}

			const hybrid = await engine.search("OAuth token", { mode: "hybrid" });
			expect(hybrid.total_count).toBeGreaterThan(0);
			expect(hybrid.warnings?.join("\n")).toContain("vector retrieval was skipped");
			const semantic = await engine.search("OAuth token", { mode: "semantic" });
			expect(semantic.total_count).toBe(0);
			expect(semantic.warnings?.join("\n")).toContain("vector retrieval was skipped");
		});

		it("remove invalidates cache", async () => {
			await engine.add("Content about vector caching and memory management for knowledge bases.", "ToRemove");
			const [{ id }] = engine.list();
			expect(existsSync(join(TEST_DIR, "vectors", `${id}.bin`))).toBe(true);
			const before = await engine.search("vector", { mode: "fast" });
			expect(before.total_count).toBeGreaterThan(0);
			engine.remove("ToRemove");
			expect(existsSync(join(TEST_DIR, "vectors", `${id}.bin`))).toBe(false);
			const after = await engine.search("vector", { mode: "fast" });
			expect(after.total_count).toBe(0);
		});

		it("clear invalidates all caches", async () => {
			await engine.add("First knowledge base content about databases and SQL queries.", "KB1");
			await engine.add("Second knowledge base content about APIs and REST endpoints.", "KB2");
			const vectorPaths = engine.list().map((kb) => join(TEST_DIR, "vectors", `${kb.id}.bin`));
			expect(vectorPaths.every((path) => existsSync(path))).toBe(true);
			engine.clear();
			expect(engine.list().length).toBe(0);
			expect(vectorPaths.every((path) => !existsSync(path))).toBe(true);
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

		it("migrates existing databases to include indexing job state", async () => {
			await engine.dispose();
			const db = openDatabase(TEST_DIR);
			db.prepare("UPDATE schema_version SET version = 1").run();
			db.prepare("DROP TABLE indexing_jobs").run();
			db.close();

			engine = new KnowledgeEngine();
			await engine.initialize(TEST_DIR);
			const migrated = openDatabase(TEST_DIR);
			const table = migrated
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'indexing_jobs'")
				.get();
			const version = migrated.prepare("SELECT version FROM schema_version").get() as { version: number };
			migrated.close();

			expect(table).toBeTruthy();
			expect(version.version).toBeGreaterThanOrEqual(2);
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
		it("plans suggested exclusions without writing a knowledge base", () => {
			const projectDir = join(TEST_DIR, "plan-project");
			mkdirSync(join(projectDir, "node_modules"), { recursive: true });
			writeFileSync(join(projectDir, "src.ts"), "export const PlanSourceToken = true;");
			writeFileSync(join(projectDir, ".env"), "PLAN_SECRET_TOKEN=1");
			writeFileSync(join(projectDir, "node_modules", "pkg.js"), "export const PlanVendorToken = true;");
			writeFileSync(join(projectDir, "image.png"), Buffer.from([0x89, 0x50, 0x00]));

			const plan = engine.plan(projectDir);

			expect(engine.list()).toHaveLength(0);
			expect(plan.source_type).toBe("directory");
			expect(plan.scannable_files).toBe(1);
			expect(plan.skipped.by_reason.suggested_excluded).toBeGreaterThan(0);
			expect(plan.skipped.by_reason.binary).toBe(1);
		});

		it("rejects duplicate knowledge base names", async () => {
			await engine.add("Original content about authentication tokens and sessions.", "Duplicate");

			await expect(engine.add("Replacement content about billing invoices and payments.", "Duplicate")).rejects.toThrow(
				'Knowledge base "Duplicate" already exists',
			);
		});

		it("rejects missing local path-like sources instead of treating them as inline text", async () => {
			const missingPath = join(TEST_DIR, "missing-source.md");

			await expect(engine.add(missingPath, "Missing Source")).rejects.toThrow(/missing|does not exist/i);

			expect(engine.list()).toHaveLength(0);
		});

		it("rejects overlapping adds for the same knowledge base name", async () => {
			const first = engine.add("Original overlap content about authentication tokens and sessions.", "Overlap Add");
			const second = engine.add("Replacement overlap content about billing invoices and payments.", "Overlap Add");

			await expect(second).rejects.toThrow('Mutation for "Overlap Add" is already running');
			await first;
			expect(engine.list()).toHaveLength(1);
		});

		it("blocks clear while add is in flight", async () => {
			const addRun = engine.add("Clear guard content about authentication tokens and sessions.", "Clear Guard Add");

			expect(() => engine.clear()).toThrow("A knowledge-base mutation is already running");
			await addRun;
			expect(engine.list()).toHaveLength(1);
		});

		it("blocks remove while add is in flight", async () => {
			const addRun = engine.add("Remove guard content about authentication tokens and sessions.", "Remove Guard Add");

			expect(() => engine.remove("Remove Guard Add")).toThrow("A knowledge-base mutation is already running");
			await addRun;
			expect(engine.list()).toHaveLength(1);
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
				const db = openDatabase(TEST_DIR);
				const job = getIndexingJob(db, engine.list().find((kb) => kb.name === "Progress")?.id ?? "");
				db.close();

				expect(chunkCount).toBe(70);
				expect(job?.status).toBe("succeeded");
				expect(job?.phase).toBe("succeeded");
				expect(job?.processed_files).toBe(70);
				expect(job?.processed_chunks).toBe(70);
				expect(job?.message).toContain("Ready: 70 chunks");
				expect(updates.some((message) => message.includes("Planned directory scan: 70 files"))).toBe(true);
				expect(updates.some((message) => message.includes("Scanning"))).toBe(true);
				expect(updates.some((message) => message.includes("Scanned 70 files"))).toBe(true);
				expect(updates.some((message) => message.includes("skipped 0"))).toBe(true);
				expect(updates.some((message) => message.includes("chunks/s"))).toBe(true);
				expect(updates.some((message) => message.includes("Embedding batch"))).toBe(true);
				expect(updates.at(-1)).toContain("Ready: 70 chunks from 70 files");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("hard-caps embedding batches even when one file creates many chunks", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-batch-cap-"));
			try {
				const paragraphs = Array.from({ length: 90 }, (_, i) =>
					`BatchCapToken${i} contains enough content to become a meaningful retrieval paragraph for bounded embedding batch validation. `.repeat(
						8,
					),
				);
				writeFileSync(join(projectDir, "large.md"), paragraphs.join("\n\n"));
				const updates: string[] = [];

				await engine.add(projectDir, "Batch Cap", (message) => updates.push(message));

				const batchSizes = updates
					.map((message) => message.match(/Embedding batch of (\d+)/)?.[1])
					.filter((value): value is string => Boolean(value))
					.map(Number);
				expect(batchSizes.length).toBeGreaterThan(1);
				expect(Math.max(...batchSizes)).toBeLessThanOrEqual(64);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("directory indexing keeps ordinary config while skipping build output and obvious secrets", async () => {
			const projectDir = join(TEST_DIR, "project");
			mkdirSync(join(projectDir, "src"), { recursive: true });
			mkdirSync(join(projectDir, "bin"), { recursive: true });
			mkdirSync(join(projectDir, "obj"), { recursive: true });
			writeFileSync(join(projectDir, "src", "Program.cs"), 'public class Program { string topic = "AlphaSafeToken"; }');
			writeFileSync(join(projectDir, "settings.json"), '{"FeatureFlag":"ConfigShouldIndexToken"}');
			writeFileSync(join(projectDir, ".env"), "API_KEY=SecretShouldNotIndex");
			writeFileSync(join(projectDir, "service.key"), "PrivateKeyShouldNotIndex");
			writeFileSync(join(projectDir, "bin", "runtime.json"), '{"runtime":"BuildOutputShouldNotIndex"}');
			writeFileSync(join(projectDir, "obj", "assets.json"), '{"asset":"ObjShouldNotIndex"}');

			const { kb } = await engine.add(projectDir, "Filtered Project");

			expect(kb.file_count).toBe(2);
			const safe = await engine.search("AlphaSafeToken", { mode: "fast" });
			expect(safe.total_count).toBeGreaterThan(0);
			const config = await engine.search("ConfigShouldIndexToken", { mode: "fast" });
			expect(config.total_count).toBeGreaterThan(0);
			const secret = await engine.search("SecretShouldNotIndex", { mode: "fast" });
			expect(secret.total_count).toBe(0);
			const privateKey = await engine.search("PrivateKeyShouldNotIndex", { mode: "fast" });
			expect(privateKey.total_count).toBe(0);
			const build = await engine.search("BuildOutputShouldNotIndex", { mode: "fast" });
			expect(build.total_count).toBe(0);
		});

		it("can index suggested-excluded text after user-confirmed scope override", async () => {
			const projectDir = join(TEST_DIR, "confirmed-project");
			mkdirSync(join(projectDir, "src"), { recursive: true });
			mkdirSync(join(projectDir, "node_modules", "chosen"), { recursive: true });
			writeFileSync(join(projectDir, "src", "main.ts"), "export const MainToken = true;");
			writeFileSync(join(projectDir, ".env"), "CONFIRMED_SECRET_TOKEN=1");
			writeFileSync(
				join(projectDir, "node_modules", "chosen", "index.js"),
				"export const ConfirmedVendorToken = true;",
			);

			const { kb } = await engine.add(projectDir, "Confirmed Scope", undefined, undefined, {
				include_paths: [".env", "node_modules/chosen/index.js"],
			});

			expect(kb.file_count).toBe(3);
			const secret = await engine.search("CONFIRMED_SECRET_TOKEN", { mode: "fast" });
			expect(secret.total_count).toBeGreaterThan(0);
			const vendor = await engine.search("ConfirmedVendorToken", { mode: "fast" });
			expect(vendor.total_count).toBeGreaterThan(0);

			writeFileSync(join(projectDir, ".env"), "CONFIRMED_SECRET_TOKEN=1\nUPDATED_CONFIRMED_SECRET=1");
			await engine.update("Confirmed Scope");
			const updated = await engine.search("UPDATED_CONFIRMED_SECRET", { mode: "fast" });
			expect(updated.total_count).toBeGreaterThan(0);
		});

		it("indexes AST-backed method symbols and structural chunk context", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-ast-symbols-"));
			try {
				writeFileSync(
					join(projectDir, "auth.ts"),
					[
						"export class AuthenticationService {",
						"  authenticate(): boolean { return true; }",
						"  refreshToken(): string { return 'token'; }",
						"}",
					].join("\n"),
				);

				await engine.add(projectDir, "AST Symbols");
				const method = engine.symbolSearch("refreshToken", { exact: true, kb_id: "AST Symbols" });
				const db = openDatabase(TEST_DIR);
				const kbId = engine.list().find((kb) => kb.name === "AST Symbols")?.id ?? "";
				const [chunk] = getChunksByKB(db, kbId);
				db.close();

				expect(method.total_count).toBe(1);
				expect(method.results[0]).toMatchObject({
					kind: "function",
					container_name: "AuthenticationService",
					file_path: "auth.ts",
				});
				expect(buildChunkEmbeddingText(chunk)).toContain("Scope: AuthenticationService");
				expect(chunk.content).toContain("export class AuthenticationService");
				expect(chunk.content).not.toContain("Scope:");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	describe("update", () => {
		it("updates after search and diagnostics without leaving the database busy", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-update-after-read-"));
			try {
				writeFileSync(
					join(projectDir, "a.txt"),
					"Initial ReadThenUpdateToken content about indexing reliability and vector search. ".repeat(3),
				);
				writeFileSync(
					join(projectDir, "b.txt"),
					"Supporting ReadThenUpdateToken material about diagnostics and status checks. ".repeat(3),
				);
				await engine.add(projectDir, "Read Then Update");

				const search = await engine.search("ReadThenUpdateToken reliability", { mode: "hybrid", limit: 1 });
				const diagnostics = engine.diagnose();
				const report = engine.doctor();
				writeFileSync(
					join(projectDir, "a.txt"),
					"Changed BusyRegressionToken content about indexing reliability and vector search. ".repeat(3),
				);

				const result = await engine.update("Read Then Update");
				const updated = await engine.search("BusyRegressionToken", { mode: "fast", limit: 1 });

				expect(search.total_count).toBeGreaterThan(0);
				expect(diagnostics).toHaveLength(1);
				expect(report.health_score).toBeGreaterThan(0);
				expect(result.added).toBe(1);
				expect(result.removed).toBe(1);
				expect(updated.total_count).toBeGreaterThan(0);
				expect(engine.list()[0].status).toBe("ready");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("rebuilds unchanged vectors when legacy embedding signature metadata is missing", async () => {
			const filePath = join(TEST_DIR, "legacy-signature.txt");
			writeFileSync(filePath, "LegacySignatureToken content about vector metadata compatibility.");
			await engine.add(filePath, "Legacy Signature");
			const [{ id }] = engine.list();
			const db = openDatabase(TEST_DIR);
			try {
				updateKBEmbeddingMetadata(db, id, "multilingual-e5-small", null, null);
			} finally {
				db.close();
			}

			const updates: string[] = [];
			const result = await engine.update("Legacy Signature", (message) => updates.push(message));
			const [kb] = engine.list();

			expect(result.added).toBe(1);
			expect(result.removed).toBe(1);
			expect(updates).toContain('Embedding metadata changed or missing for "Legacy Signature"; rebuilding all vectors');
			expect(kb.embedding_signature).toContain("local:multilingual-e5-small");
			expect(kb.embedding_dimension).toBe(384);
		});

		it("coalesces overlapping updates for the same knowledge base", async () => {
			const filePath = join(TEST_DIR, "coalesce.txt");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(filePath, "Original coalesced update content about stable indexing.");
			await engine.add(filePath, "Coalesced Update");
			writeFileSync(filePath, "Changed CoalescedUpdateToken content about stable indexing.");
			const secondUpdates: string[] = [];

			const first = engine.update("Coalesced Update");
			const second = engine.update("Coalesced Update", (message) => secondUpdates.push(message));
			const [firstResult, secondResult] = await Promise.all([first, second]);

			expect(secondUpdates).toContain('Update already running for "Coalesced Update"; waiting for the active update.');
			expect(secondResult).toEqual(firstResult);
			expect(firstResult.added).toBe(1);
			expect(firstResult.removed).toBe(1);
			expect(engine.list()[0].status).toBe("ready");
		});

		it("blocks remove and clear while update is in flight", async () => {
			const sourcePath = join(TEST_DIR, "update-guard.txt");
			writeFileSync(sourcePath, "Initial update guard content about authentication tokens.");
			await engine.add(sourcePath, "Update Guard");
			const [{ id }] = engine.list();
			const updateRun = engine.update(id);

			expect(() => engine.remove(id)).toThrow("A knowledge-base mutation is already running");
			expect(() => engine.clear()).toThrow("A knowledge-base mutation is already running");
			await updateRun;
		});

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
			const filePath = join(TEST_DIR, "source.ts");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(
				filePath,
				"export function preservedSymbol() {}\nInitial content about authentication tokens and sessions.",
			);
			await engine.add(filePath, "Cancellable");
			writeFileSync(filePath, "Changed content about billing invoices and payments.");

			const controller = new AbortController();
			controller.abort();

			await expect(engine.update("Cancellable", undefined, controller.signal)).rejects.toThrow("Cancelled");
			const db = openDatabase(TEST_DIR);
			const kbId = engine.list().find((kb) => kb.name === "Cancellable")?.id ?? "";
			const job = getIndexingJob(db, kbId);
			const [chunk] = getChunksByKB(db, kbId);
			db.close();
			expect(job?.status).toBe("succeeded");
			expect(job?.message).not.toBe("Update cancelled.");
			expect(engine.list().find((kb) => kb.name === "Cancellable")?.status).toBe("ready");
			expect(engine.list().find((kb) => kb.name === "Cancellable")?.chunk_count).toBe(1);
			expect((await engine.search("billing", { mode: "fast", kb_id: "Cancellable" })).total_count).toBe(0);
			expect(chunk?.content).toContain("export function preservedSymbol() {}");
			expect(engine.symbolSearch("preservedSymbol", { exact: true, kb_id: "Cancellable" }).total_count).toBe(1);
		});

		it("updates document files from extractors instead of raw UTF-8 bytes", async () => {
			const filePath = join(TEST_DIR, "source.docx");
			writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]));
			mammothMock.extractRawText
				.mockResolvedValueOnce({
					value: "Initial extracted DOCX text about InitialDocxToken authentication sessions.",
				})
				.mockResolvedValueOnce({
					value: "Changed extracted DOCX text about ChangedDocxToken billing invoices.",
				});

			await engine.add(filePath, "Docx Update");
			writeFileSync(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfe, 0x00]));

			const result = await engine.update("Docx Update");

			expect(result.added).toBe(1);
			expect(result.removed).toBe(1);
			expect(mammothMock.extractRawText).toHaveBeenCalledTimes(2);
			expect((await engine.search("ChangedDocxToken", { mode: "fast", kb_id: "Docx Update" })).total_count).toBe(1);
			expect((await engine.search("InitialDocxToken", { mode: "fast", kb_id: "Docx Update" })).total_count).toBe(0);
		});

		it("extracts DOCX files found during directory add and update", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-directory-docx-"));
			try {
				const docxPath = join(projectDir, "handbook.docx");
				writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]));
				mammothMock.extractRawText
					.mockResolvedValueOnce({
						value: "Initial directory DOCX text about DirectoryDocxInitialToken authentication sessions.",
					})
					.mockResolvedValueOnce({
						value: "Changed directory DOCX text about DirectoryDocxChangedToken billing invoices.",
					});

				const added = await engine.add(projectDir, "Directory Docx");
				expect(added.kb.file_count).toBe(1);
				expect(mammothMock.extractRawText).toHaveBeenCalledWith({ path: docxPath });
				expect(
					(await engine.search("DirectoryDocxInitialToken", { mode: "fast", kb_id: "Directory Docx" })).total_count,
				).toBe(1);

				writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfe, 0x00]));
				const updated = await engine.update("Directory Docx");

				expect(updated.added).toBe(1);
				expect(updated.removed).toBe(1);
				expect(mammothMock.extractRawText).toHaveBeenCalledTimes(2);
				expect(
					(await engine.search("DirectoryDocxChangedToken", { mode: "fast", kb_id: "Directory Docx" })).total_count,
				).toBe(1);
				expect(
					(await engine.search("DirectoryDocxInitialToken", { mode: "fast", kb_id: "Directory Docx" })).total_count,
				).toBe(0);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("skips failed document extraction during directory add without failing the KB", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-directory-docx-add-skip-"));
			try {
				const docxPath = join(projectDir, "broken.docx");
				writeFileSync(join(projectDir, "valid.ts"), "export const ValidAddToken = 'indexed';");
				writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]));
				mammothMock.extractRawText.mockRejectedValueOnce(new Error("corrupt document"));

				const added = await engine.add(projectDir, "Directory Docx Add Skip");

				const db = openDatabase(TEST_DIR);
				const job = getIndexingJob(db, added.kb.id);
				db.close();
				expect(added.kb.status).toBe("ready");
				expect(added.kb.file_count).toBe(1);
				expect(job?.status).toBe("succeeded");
				expect(job?.skipped_total).toBe(1);
				expect(job?.message).toContain("extraction_failed: 1");
				expect(mammothMock.extractRawText).toHaveBeenCalledWith({ path: docxPath });
				expect(
					(await engine.search("ValidAddToken", { mode: "fast", kb_id: "Directory Docx Add Skip" })).total_count,
				).toBe(1);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("skips failed document extraction during directory update without marking the KB error", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-directory-docx-update-skip-"));
			try {
				const docxPath = join(projectDir, "handbook.docx");
				const validPath = join(projectDir, "valid.ts");
				writeFileSync(validPath, "export const InitialValidUpdateToken = 'indexed';");
				writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]));
				mammothMock.extractRawText.mockResolvedValueOnce({
					value: "Initial update DOCX text about InitialSkippedDocToken.",
				});

				const added = await engine.add(projectDir, "Directory Docx Update Skip");
				writeFileSync(validPath, "export const ChangedValidUpdateToken = 'indexed';");
				writeFileSync(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xfe, 0x00]));
				mammothMock.extractRawText.mockRejectedValueOnce(new Error("corrupt updated document"));

				const updated = await engine.update("Directory Docx Update Skip");

				const db = openDatabase(TEST_DIR);
				const job = getIndexingJob(db, added.kb.id);
				db.close();
				expect(updated.added).toBe(1);
				expect(updated.removed).toBe(2);
				expect(engine.list().find((kb) => kb.id === added.kb.id)?.status).toBe("ready");
				expect(job?.status).toBe("succeeded");
				expect(job?.skipped_total).toBe(1);
				expect(job?.message).toContain("extraction_failed: 1");
				expect(mammothMock.extractRawText).toHaveBeenCalledTimes(2);
				expect(
					(await engine.search("ChangedValidUpdateToken", { mode: "fast", kb_id: "Directory Docx Update Skip" }))
						.total_count,
				).toBe(1);
				expect(
					(await engine.search("InitialSkippedDocToken", { mode: "fast", kb_id: "Directory Docx Update Skip" }))
						.total_count,
				).toBe(0);
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
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
				expect(updates.some((message) => message.includes("Changes: +70 -70 =0"))).toBe(true);
				expect(updates.at(-1)).toBe("Ready: +70 -70 =0");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("removes one duplicate-content file without orphaning stale chunks", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-duplicate-update-"));
			try {
				const duplicateContent = "DuplicateIdentityToken shared content that appears in multiple source files.";
				writeFileSync(join(projectDir, "a.txt"), duplicateContent);
				writeFileSync(join(projectDir, "b.txt"), duplicateContent);
				await engine.add(projectDir, "Duplicate Identity");

				unlinkSync(join(projectDir, "b.txt"));
				const result = await engine.update("Duplicate Identity");
				const diagnostics = engine.diagnose().find((item) => item.kb_name === "Duplicate Identity");

				expect(result.added).toBe(0);
				expect(result.removed).toBe(1);
				expect(result.unchanged).toBe(1);
				expect(diagnostics?.orphan_files).toEqual([]);
				expect(diagnostics?.indexed_files).toBe(1);
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

		it("auto mode selects exact lookup and reports mode used", async () => {
			await engine.add("Exact lookup content about AutoModeToken and command configuration.", "Auto");

			const result = await engine.search("AutoModeToken", { mode: "auto", limit: 1 });

			expect(result.total_count).toBeGreaterThan(0);
			expect(result.mode_used).toBe("fast");
			expect(result.retry_modes).toEqual([]);
		});

		it("auto mode retries alternate modes before returning no results", async () => {
			await engine.add("Retry mode content about billing configuration and project setup.", "Auto Retry");

			const result = await engine.search("zzzzzzzz nonexistent unmatched query", { mode: "auto", limit: 1 });

			expect(result.total_count).toBe(0);
			expect(result.retry_modes?.length).toBeGreaterThan(0);
			expect(result.suggestions?.[0]).toContain("No results after auto mode fallback");
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

		it("doctor reports actionable health issues", async () => {
			await engine.add("Doctor content about health diagnostics and recovery.", "Doctor");
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

			const report = engine.doctor();

			expect(report.health_score).toBeLessThan(100);
			expect(report.issues.some((issue) => issue.severity === "blocking")).toBe(true);
			expect(report.issues.some((issue) => issue.action.includes("remove and rebuild"))).toBe(true);
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

		it("blocks clear while import is in flight", async () => {
			const inputPath = join(TEST_DIR, "guarded-import.jsonl");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(
				inputPath,
				[
					JSON.stringify({ name: "Guarded Import" }),
					JSON.stringify({
						content: "Imported content about guarded lifecycle mutations.",
						file_path: "import.md",
						file_type: "markdown",
						start_line: 1,
						end_line: 1,
					}),
				].join("\n"),
			);

			const importRun = engine.importKB(inputPath);

			expect(() => engine.clear()).toThrow("A knowledge-base mutation is already running");
			await importRun;
			expect(engine.list()).toHaveLength(1);
		});

		it("blocks remove while import is in flight", async () => {
			const inputPath = join(TEST_DIR, "guarded-remove-import.jsonl");
			mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(
				inputPath,
				[
					JSON.stringify({ name: "Guarded Remove Import" }),
					JSON.stringify({
						content: "Imported content about guarded remove lifecycle mutations.",
						file_path: "import.md",
						file_type: "markdown",
						start_line: 1,
						end_line: 1,
					}),
				].join("\n"),
			);

			const importRun = engine.importKB(inputPath);

			expect(() => engine.remove("Guarded Remove Import")).toThrow("A knowledge-base mutation is already running");
			await importRun;
			expect(engine.list()).toHaveLength(1);
		});

		it("rejects imports that would duplicate an existing knowledge base name", async () => {
			await engine.add("Existing import name content about authentication tokens.", "Import Duplicate");
			const inputPath = join(TEST_DIR, "duplicate-import.jsonl");
			writeFileSync(inputPath, `${JSON.stringify({ name: "Import Duplicate" })}\n`);

			await expect(engine.importKB(inputPath)).rejects.toThrow('Knowledge base "Import Duplicate" already exists');
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

		it("blocks remove while export is in flight", async () => {
			await engine.add("Export guard content about authentication tokens and sessions.", "Export Guard");
			const outputPath = join(TEST_DIR, "export-guard.jsonl");
			const exportRun = engine.exportKB("Export Guard", outputPath);

			expect(() => engine.remove("Export Guard")).toThrow("A knowledge-base mutation is already running");
			await exportRun;
			expect(existsSync(outputPath)).toBe(true);
		});

		it("keeps an existing export file when export is cancelled", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-export-cancel-"));
			try {
				for (let i = 0; i < 70; i++) {
					writeFileSync(
						join(projectDir, `doc-${i}.txt`),
						`Export cancel document ${i} about ExportCancelToken stable indexing. `.repeat(3),
					);
				}
				await engine.add(projectDir, "Export Cancel");
				const outputPath = join(TEST_DIR, "existing-export.jsonl");
				writeFileSync(outputPath, "existing user export\n");
				const controller = new AbortController();

				await expect(
					engine.exportKB("Export Cancel", outputPath, controller.signal, () => controller.abort()),
				).rejects.toThrow("Cancelled");

				expect(readFileSync(outputPath, "utf-8")).toBe("existing user export\n");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});

		it("keeps an existing export file when cancellation arrives after the final chunk progress", async () => {
			const projectDir = mkdtempSync(join(tmpdir(), "pk-export-final-cancel-"));
			try {
				for (let i = 0; i < 64; i++) {
					writeFileSync(
						join(projectDir, `doc-${i}.txt`),
						`Final export cancel document ${i} about ExportFinalCancelToken stable indexing. `.repeat(3),
					);
				}
				await engine.add(projectDir, "Export Final Cancel");
				const outputPath = join(TEST_DIR, "existing-final-export.jsonl");
				writeFileSync(outputPath, "existing final export\n");
				const controller = new AbortController();
				const updates: string[] = [];

				await expect(
					engine.exportKB("Export Final Cancel", outputPath, controller.signal, (message) => {
						updates.push(message);
						if (message === "Exported 64/64 chunks...") controller.abort();
					}),
				).rejects.toThrow("Cancelled");

				expect(updates).toEqual(["Exported 64/64 chunks..."]);
				expect(readFileSync(outputPath, "utf-8")).toBe("existing final export\n");
			} finally {
				rmSync(projectDir, { recursive: true, force: true });
			}
		});
	});

	describe("dispose lifecycle", () => {
		it("waits for active mutations but rejects new mutations after shutdown starts", async () => {
			const addRun = engine.add("Active dispose guard content about authentication tokens.", "Dispose Active");
			const disposeRun = engine.dispose({ disposeModels: false });

			await expect(engine.add("Late add content.", "Late Add")).rejects.toThrow("Knowledge engine is shutting down");
			await expect(engine.update("Dispose Active")).rejects.toThrow("Knowledge engine is shutting down");
			await expect(engine.importKB(join(TEST_DIR, "missing.jsonl"))).rejects.toThrow(
				"Knowledge engine is shutting down",
			);
			expect(() => engine.remove("Dispose Active")).toThrow("Knowledge engine is shutting down");
			expect(() => engine.clear()).toThrow("Knowledge engine is shutting down");

			await addRun;
			await disposeRun;
			engine = new KnowledgeEngine();
			await engine.initialize(TEST_DIR);
		});
	});
});
