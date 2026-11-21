import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createKB,
	finishIndexingJob,
	getDefaultKnowledgeDir,
	getKB,
	insertChunks,
	markKBIndexed,
	openDatabase,
	resolveHostKnowledgeDir,
	startIndexingJob,
	updateKBCounts,
	updateKBCountsOnly,
	updateKBEmbeddingMetadata,
	updateKBStatus,
	updateKBStatusOnly,
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
		).toBe("/tmp/project/.omp/knowledge");
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
			expect(updated?.updated_at).toBe(300);
		} finally {
			db.close();
			now.mockRestore();
		}
	});

	it("writes only the status column from updateKBStatusOnly", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-status-only-"));
		tempDirs.push(dir);
		const now = vi.spyOn(Date, "now");
		let currentTime = 100;
		now.mockImplementation(() => currentTime);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, { name: "status-only", source_type: "text" });
			currentTime = 200;
			markKBIndexed(db, kb.id);
			currentTime = 300;
			const before = getKB(db, kb.id);

			// the freshness epoch must survive a bookkeeping status write, while the status itself still changes
			currentTime = 400;
			updateKBStatusOnly(db, kb.id, "indexing");

			const after = getKB(db, kb.id);
			expect(after?.status).toBe("indexing");
			expect(after?.updated_at).toBe(before?.updated_at);
			expect(after?.indexed_at).toBe(before?.indexed_at);
			expect(after?.chunk_count).toBe(before?.chunk_count);
			expect(after?.file_count).toBe(before?.file_count);
		} finally {
			db.close();
			now.mockRestore();
		}
	});

	it("writes only the count columns from updateKBCountsOnly", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-counts-only-"));
		tempDirs.push(dir);
		const now = vi.spyOn(Date, "now");
		let currentTime = 100;
		now.mockImplementation(() => currentTime);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, { name: "counts-only", source_type: "text" });
			currentTime = 200;
			markKBIndexed(db, kb.id);
			currentTime = 300;
			const before = getKB(db, kb.id);

			currentTime = 400;
			updateKBCountsOnly(db, kb.id, 7, 3);

			const after = getKB(db, kb.id);
			expect(after?.chunk_count).toBe(7);
			expect(after?.file_count).toBe(3);
			expect(after?.updated_at).toBe(before?.updated_at);
			expect(after?.indexed_at).toBe(before?.indexed_at);
			expect(after?.status).toBe(before?.status);
		} finally {
			db.close();
			now.mockRestore();
		}
	});

	it("still refreshes updated_at from updateKBStatus and updateKBCounts", () => {
		const dir = mkdtempSync(join(tmpdir(), "pk-storage-refreshing-"));
		tempDirs.push(dir);
		const now = vi.spyOn(Date, "now");
		let currentTime = 100;
		now.mockImplementation(() => currentTime);
		const db = openDatabase(dir);
		try {
			const kb = createKB(db, { name: "refreshing", source_type: "text" });
			const before = getKB(db, kb.id);

			currentTime = 500;
			updateKBStatus(db, kb.id, "ready");
			expect(getKB(db, kb.id)?.updated_at).toBe(500);

			currentTime = 700;
			updateKBCounts(db, kb.id, 2, 1);
			expect(getKB(db, kb.id)?.updated_at).toBe(700);
			expect(getKB(db, kb.id)?.indexed_at).toBe(before?.indexed_at);
		} finally {
			db.close();
			now.mockRestore();
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
