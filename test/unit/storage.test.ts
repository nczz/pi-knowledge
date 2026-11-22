import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createKB,
	finishIndexingJob,
	getChunksByKB,
	getDefaultKnowledgeDir,
	getIndexingJob,
	getKB,
	insertChunks,
	insertStagedChunks,
	markKBIndexed,
	openDatabase,
	publishStagedUpdate,
	resolveHostKnowledgeDir,
	stageRemovedChunkIds,
	startIndexingJob,
	updateKBEmbeddingMetadata,
	updateKBStatus,
} from "../../src/storage/sqlite.ts";

describe("knowledge storage path", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("uses an explicit PI_KNOWLEDGE_DIR override", () => {
		vi.stubEnv("PI_KNOWLEDGE_DIR", "/tmp/custom-knowledge");
		vi.stubEnv("OMP_KNOWLEDGE_DIR", "/tmp/omp-knowledge");

		expect(getDefaultKnowledgeDir()).toBe("/tmp/custom-knowledge");
	});

	it("derives host storage from PI_CODING_AGENT_DIR", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/Users/example/.omp/agent");

		expect(getDefaultKnowledgeDir()).toBe(join(dirname("/Users/example/.omp/agent"), "knowledge"));
	});

	it("derives host storage from OMP_CODING_AGENT_DIR", () => {
		vi.stubEnv("OMP_CODING_AGENT_DIR", "/Users/example/.omp/work-agent");

		expect(getDefaultKnowledgeDir()).toBe(join(dirname("/Users/example/.omp/work-agent"), "knowledge"));
	});

	it("preserves an existing Pi knowledge dir only for the default home OMP root", () => {
		const hostRoot = join(homedir(), ".omp");
		const legacyPiDir = join(homedir(), ".pi", "knowledge");
		const exists = (path: string): boolean => path === legacyPiDir;

		expect(
			resolveHostKnowledgeDir(hostRoot, {
				legacyPiDir,
				exists,
			}),
		).toBe(legacyPiDir);
		expect(
			resolveHostKnowledgeDir("/tmp/project/.omp", {
				legacyPiDir: "/home/me/.pi/knowledge",
				exists,
			}),
		).toBe(join("/tmp/project/.omp", "knowledge"));
	});

	it("preserves legacy Pi storage for Windows-style home OMP paths", () => {
		const homeDir = "C:\\Users\\Example";
		const hostRoot = "c:\\users\\example\\.omp";
		const legacyPiDir = "C:\\Users\\Example\\.pi\\knowledge";
		const exists = (path: string): boolean => path === legacyPiDir;

		expect(resolveHostKnowledgeDir(hostRoot, { homeDir, legacyPiDir, exists })).toBe(legacyPiDir);
	});

	it("keeps the existing Pi storage root by default", () => {
		vi.stubEnv("OMP_PROFILE", "");
		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		vi.stubEnv("PI_KNOWLEDGE_DIR", "");
		vi.stubEnv("OMP_KNOWLEDGE_DIR", "");

		expect(getDefaultKnowledgeDir()).toMatch(/[/\\]\.pi[/\\]knowledge$/);
	});
});

describe("knowledge base embedding metadata", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("stores embedding signatures and dimensions on knowledge bases", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-"));
		tempDirs.push(dir);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, {
				name: "repo",
				source_type: "text",
				embedding_model: "openai:text-embedding-3-small",
				embedding_signature: "openai:text-embedding-3-small:dim=1536",
				embedding_dimension: 1536,
			});

			expect(kb.embedding_model).toBe("openai:text-embedding-3-small");
			expect(kb.embedding_signature).toBe("openai:text-embedding-3-small:dim=1536");
			expect(kb.embedding_dimension).toBe(1536);

			updateKBEmbeddingMetadata(db, kb.id, "multilingual-e5-small", "local:dim=384", 384);
			const updated = getKB(db, kb.id);
			expect(updated?.embedding_model).toBe("multilingual-e5-small");
			expect(updated?.embedding_signature).toBe("local:dim=384");
			expect(updated?.embedding_dimension).toBe(384);

			const defaulted = createKB(db, { name: "other", source_type: "text" });
			expect(defaulted.embedding_model).toBe("multilingual-e5-small");
			expect(defaulted.embedding_signature).toBeNull();
			expect(defaulted.embedding_dimension).toBeNull();
		} finally {
			db.close();
		}
	});

	it("keeps the published index timestamp stable across status bookkeeping", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-indexed-at-"));
		tempDirs.push(dir);
		const now = vi.spyOn(Date, "now");
		let currentTime = 100;
		now.mockImplementation(() => currentTime);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, { name: "timestamped", source_type: "text" });
			expect(kb.indexed_at).toBe(0);

			currentTime = 200;
			markKBIndexed(db, kb.id);
			currentTime = 300;
			updateKBStatus(db, kb.id, "ready");

			const updated = getKB(db, kb.id);
			expect(updated?.indexed_at).toBe(200);
			expect(updated?.updated_at).toBe(200);
		} finally {
			db.close();
			now.mockRestore();
		}
	});

	it("rolls back staged publication without advancing the successful index timestamp", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-publish-"));
		tempDirs.push(dir);
		const now = vi.spyOn(Date, "now");
		let currentTime = 100;
		now.mockImplementation(() => currentTime);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, { name: "atomic", source_type: "file" });
			const [oldChunkId] = insertChunks(db, kb.id, [
				{
					content_hash: "old",
					content: "Published content",
					content_tokenized: "published content",
					file_path: "source.txt",
					file_type: "text",
					start_line: 1,
					end_line: 1,
					metadata_json: "{}",
				},
			]);
			if (!oldChunkId) throw new Error("Missing old chunk");
			currentTime = 200;
			markKBIndexed(db, kb.id);
			const published = getKB(db, kb.id);
			if (!published) throw new Error("Missing published knowledge base");
			startIndexingJob(db, kb.id, "update", "Starting update");
			insertStagedChunks(db, kb.id, [
				{
					content_hash: "new",
					content: "Staged content",
					content_tokenized: "staged content",
					file_path: "source.txt",
					file_type: "text",
					start_line: 1,
					end_line: 1,
					metadata_json: "{}",
				},
			]);
			stageRemovedChunkIds(db, kb.id, [oldChunkId]);
			currentTime = 300;

			expect(() =>
				publishStagedUpdate(db, kb.id, {
					vectorFile: `${kb.id}.generation.bin`,
					expectedChunkCount: 2,
					embeddingModel: "test",
					embeddingSignature: "test:dim=1",
					embeddingDimension: 1,
					sourceOptions: "{}",
					jobMessage: "Ready",
				}),
			).toThrow("Staged update chunk count mismatch");

			expect(getChunksByKB(db, kb.id).map((chunk) => chunk.content)).toEqual(["Published content"]);
			expect(getKB(db, kb.id)).toMatchObject({
				updated_at: published.updated_at,
				indexed_at: published.indexed_at,
				vector_file: published.vector_file,
			});
			const staged = db.prepare("SELECT COUNT(*) AS count FROM update_staged_chunks WHERE kb_id = ?").get(kb.id) as {
				count: number;
			};
			expect(staged.count).toBe(1);
		} finally {
			db.close();
			now.mockRestore();
		}
	});

	it("persists provider failure facts and clears them when a new job starts", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-provider-failure-"));
		tempDirs.push(dir);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, { name: "provider-failure", source_type: "text" });
			startIndexingJob(db, kb.id, "update", "Updating");
			finishIndexingJob(db, kb.id, "failed", "Update failed.", "provider unavailable", {
				provider: "embedding",
				operation: "embed_documents",
				kind: "http",
				status: 503,
			});

			expect(getIndexingJob(db, kb.id)).toMatchObject({
				status: "failed",
				error_message: "provider unavailable",
				error_provider: "embedding",
				provider_operation: "embed_documents",
				error_kind: "http",
				error_status: 503,
				error_code: null,
			});

			startIndexingJob(db, kb.id, "update", "Retrying");
			expect(getIndexingJob(db, kb.id)).toMatchObject({
				status: "running",
				error_message: null,
				error_provider: null,
				provider_operation: null,
				error_kind: null,
				error_status: null,
				error_code: null,
			});
		} finally {
			db.close();
		}
	});

	it("migrates schema-v7 indexing jobs to structured provider failure columns", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-provider-migration-"));
		tempDirs.push(dir);
		const original = openDatabase(dir);
		try {
			for (const column of ["error_provider", "provider_operation", "error_kind", "error_status", "error_code"]) {
				original.exec(`ALTER TABLE indexing_jobs DROP COLUMN ${column}`);
			}
			original.prepare("UPDATE schema_version SET version = 7").run();
		} finally {
			original.close();
		}

		const migrated = openDatabase(dir);
		try {
			const columns = migrated.prepare("PRAGMA table_info(indexing_jobs)").all() as Array<{ name: string }>;
			expect(columns.map((column) => column.name)).toEqual(
				expect.arrayContaining(["error_provider", "provider_operation", "error_kind", "error_status", "error_code"]),
			);
			expect(migrated.prepare("SELECT version FROM schema_version").get()).toEqual({ version: 8 });
		} finally {
			migrated.close();
		}
	});

	it("migrates only trustworthy successful index timestamps", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-migration-"));
		tempDirs.push(dir);
		const now = vi.spyOn(Date, "now");
		let currentTime = 100;
		now.mockImplementation(() => currentTime);
		const original = openDatabase(dir);
		const cancelled = createKB(original, { name: "cancelled", source_type: "text" });
		const succeeded = createKB(original, { name: "succeeded", source_type: "text" });
		try {
			currentTime = 200;
			insertChunks(original, cancelled.id, [
				{
					content_hash: "legacy-content",
					content: "Legacy content",
					content_tokenized: "legacy content",
					file_path: "legacy.md",
					file_type: "markdown",
					start_line: 1,
					end_line: 1,
					metadata_json: "{}",
				},
			]);
			currentTime = 250;
			startIndexingJob(original, cancelled.id, "update", "Updating");
			currentTime = 300;
			finishIndexingJob(original, cancelled.id, "cancelled", "Cancelled");
			currentTime = 400;
			updateKBStatus(original, cancelled.id, "ready");

			currentTime = 220;
			startIndexingJob(original, succeeded.id, "add", "Adding");
			currentTime = 230;
			finishIndexingJob(original, succeeded.id, "succeeded", "Ready");
			currentTime = 400;
			updateKBStatus(original, succeeded.id, "ready");

			original.exec("ALTER TABLE knowledge_bases DROP COLUMN indexed_at");
			original.prepare("UPDATE schema_version SET version = 5").run();
		} finally {
			original.close();
			now.mockRestore();
		}

		const migrated = openDatabase(dir);
		try {
			expect(getKB(migrated, cancelled.id)?.indexed_at).toBe(200);
			expect(getKB(migrated, succeeded.id)?.indexed_at).toBe(230);
		} finally {
			migrated.close();
		}
	});
});
