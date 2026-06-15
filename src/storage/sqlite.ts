import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string | null;
	source_path: string | null;
	source_type: "file" | "directory" | "text" | "url";
	created_at: number;
	updated_at: number;
	chunk_count: number;
	file_count: number;
	embedding_model: string;
	status: "ready" | "indexing" | "error" | "stale";
}

export interface Chunk {
	id: string;
	kb_id: string;
	content_hash: string;
	content: string;
	content_tokenized: string;
	file_path: string;
	file_type: string;
	start_line: number;
	end_line: number;
	metadata_json: string;
	indexed_at: number;
}

export type ChunkInsert = Omit<Chunk, "id" | "kb_id" | "indexed_at">;

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_path TEXT,
  source_type TEXT NOT NULL DEFAULT 'directory',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  embedding_model TEXT NOT NULL DEFAULT 'multilingual-e5-small',
  status TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  content_tokenized TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'text',
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_kb_id ON chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content_tokenized,
  content=chunks,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content_tokenized) VALUES (new.rowid, new.content_tokenized);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content_tokenized) VALUES('delete', old.rowid, old.content_tokenized);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content_tokenized) VALUES('delete', old.rowid, old.content_tokenized);
  INSERT INTO chunks_fts(rowid, content_tokenized) VALUES (new.rowid, new.content_tokenized);
END;
`;

export function getDefaultKnowledgeDir(): string {
	return join(homedir(), ".pi", "knowledge");
}

export function openDatabase(knowledgeDir?: string): Database.Database {
	const dir = knowledgeDir ?? getDefaultKnowledgeDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const dbPath = join(dir, "knowledge.db");
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 5000");
	db.pragma("foreign_keys = ON");

	const hasVersion = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
	if (!hasVersion) {
		db.exec(SCHEMA_SQL);
		db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
	} else {
		const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
		const currentVersion = row?.version ?? 0;
		if (currentVersion < SCHEMA_VERSION) {
			runMigrations(db, currentVersion, SCHEMA_VERSION);
			db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
		}
	}

	return db;
}

function runMigrations(db: Database.Database, from: number, to: number): void {
	const migrations: Record<number, string> = {
		// Future migrations go here, keyed by target version number:
		// 2: "ALTER TABLE ...",
	};
	for (let v = from + 1; v <= to; v++) {
		if (migrations[v]) db.exec(migrations[v]);
	}
}

// --- CRUD: Knowledge Bases ---

export function createKB(
	db: Database.Database,
	opts: { name: string; description?: string; source_path?: string; source_type: KnowledgeBase["source_type"] },
): KnowledgeBase {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO knowledge_bases (id, name, description, source_path, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(id, opts.name, opts.description ?? null, opts.source_path ?? null, opts.source_type, now, now);
	const kb = getKB(db, id);
	if (!kb) throw new Error(`Failed to create knowledge base: ${id}`);
	return kb;
}

export function getKB(db: Database.Database, id: string): KnowledgeBase | undefined {
	return db.prepare("SELECT * FROM knowledge_bases WHERE id = ?").get(id) as KnowledgeBase | undefined;
}

export function getKBByName(db: Database.Database, name: string): KnowledgeBase | undefined {
	return db.prepare("SELECT * FROM knowledge_bases WHERE name = ?").get(name) as KnowledgeBase | undefined;
}

export function listKBs(db: Database.Database): KnowledgeBase[] {
	return db.prepare("SELECT * FROM knowledge_bases ORDER BY updated_at DESC").all() as KnowledgeBase[];
}

export function deleteKB(db: Database.Database, id: string): void {
	db.prepare("DELETE FROM chunks WHERE kb_id = ?").run(id);
	db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(id);
}

export function updateKBStatus(db: Database.Database, id: string, status: KnowledgeBase["status"]): void {
	db.prepare("UPDATE knowledge_bases SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
}

export function updateKBCounts(db: Database.Database, id: string, chunkCount: number, fileCount: number): void {
	db.prepare("UPDATE knowledge_bases SET chunk_count = ?, file_count = ?, updated_at = ? WHERE id = ?").run(
		chunkCount,
		fileCount,
		Date.now(),
		id,
	);
}

// --- CRUD: Chunks ---

export function insertChunks(db: Database.Database, kbId: string, chunks: ChunkInsert[]): void {
	const stmt = db.prepare(
		`INSERT INTO chunks (id, kb_id, content_hash, content, content_tokenized, file_path, file_type, start_line, end_line, metadata_json, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const now = Date.now();
	const insertMany = db.transaction((items: ChunkInsert[]) => {
		for (const c of items) {
			stmt.run(
				randomUUID(),
				kbId,
				c.content_hash,
				c.content,
				c.content_tokenized,
				c.file_path,
				c.file_type,
				c.start_line,
				c.end_line,
				c.metadata_json,
				now,
			);
		}
	});
	insertMany(chunks);
}

export function getChunksByKB(db: Database.Database, kbId: string): Chunk[] {
	return db.prepare("SELECT * FROM chunks WHERE kb_id = ? ORDER BY rowid").all(kbId) as Chunk[];
}

export function getChunkIdsByKB(db: Database.Database, kbId: string): string[] {
	const rows = db.prepare("SELECT id FROM chunks WHERE kb_id = ? ORDER BY rowid").all(kbId) as { id: string }[];
	return rows.map((r) => r.id);
}

export function getChunkById(db: Database.Database, id: string): Chunk | undefined {
	return db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Chunk | undefined;
}

export function getChunkByRowid(db: Database.Database, rowid: number): Chunk | undefined {
	return db.prepare("SELECT * FROM chunks WHERE rowid = ?").get(rowid) as Chunk | undefined;
}

export function deleteChunksByKB(db: Database.Database, kbId: string): void {
	db.prepare("DELETE FROM chunks WHERE kb_id = ?").run(kbId);
}

export function deleteChunksByIds(db: Database.Database, ids: string[]): void {
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(",");
	db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids);
}

export function getChunkHashesByKB(db: Database.Database, kbId: string): Map<string, string> {
	const rows = db.prepare("SELECT id, content_hash FROM chunks WHERE kb_id = ? ORDER BY rowid").all(kbId) as {
		id: string;
		content_hash: string;
	}[];
	return new Map(rows.map((r) => [r.content_hash, r.id]));
}

export function getChunkCount(db: Database.Database, kbId: string): number {
	const row = db.prepare("SELECT COUNT(*) as count FROM chunks WHERE kb_id = ?").get(kbId) as { count: number };
	return row.count;
}

export function getFileCount(db: Database.Database, kbId: string): number {
	const row = db.prepare("SELECT COUNT(DISTINCT file_path) as count FROM chunks WHERE kb_id = ?").get(kbId) as {
		count: number;
	};
	return row.count;
}
