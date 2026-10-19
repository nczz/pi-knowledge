import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string | null;
	source_path: string | null;
	source_type: "file" | "directory" | "text" | "url";
	source_options: string | null;
	created_at: number;
	updated_at: number;
	chunk_count: number;
	file_count: number;
	embedding_model: string;
	embedding_signature: string | null;
	embedding_dimension: number | null;
	status: "ready" | "indexing" | "error" | "stale";
}

export interface IndexingJob {
	kb_id: string;
	operation: "add" | "update" | "import";
	status: "running" | "succeeded" | "failed" | "cancelled";
	phase: string;
	message: string;
	started_at: number;
	updated_at: number;
	last_progress_at: number;
	processed_files: number;
	processed_chunks: number;
	total_files: number | null;
	skipped_total: number;
	added_chunks: number;
	removed_chunks: number;
	unchanged_chunks: number;
	error_message: string | null;
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

export interface KnowledgeSymbol {
	id: string;
	kb_id: string;
	name: string;
	normalized_name: string;
	kind: "function" | "class" | "interface" | "type" | "variable" | "heading" | "config_key" | "env_var" | "route";
	file_path: string;
	file_type: string;
	start_line: number;
	end_line: number;
	container_name: string | null;
	signature: string | null;
	text: string;
	metadata_json: string;
	indexed_at: number;
}

export type KnowledgeSymbolInsert = Omit<KnowledgeSymbol, "id" | "kb_id" | "indexed_at" | "normalized_name">;

const SCHEMA_VERSION = 5;
const ITERATION_BATCH_SIZE = 500;

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
  source_options TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  embedding_model TEXT NOT NULL DEFAULT 'multilingual-e5-small',
  embedding_signature TEXT,
  embedding_dimension INTEGER,
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

CREATE TABLE IF NOT EXISTS indexing_jobs (
  kb_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_progress_at INTEGER NOT NULL,
  processed_files INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER,
  skipped_total INTEGER NOT NULL DEFAULT 0,
  added_chunks INTEGER NOT NULL DEFAULT 0,
  removed_chunks INTEGER NOT NULL DEFAULT 0,
  unchanged_chunks INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_kb_id ON chunks(kb_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'text',
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER NOT NULL DEFAULT 0,
  container_name TEXT,
  signature TEXT,
  text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbols_kb_name ON symbols(kb_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kb_kind ON symbols(kb_id, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(kb_id, file_path);

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

type DatabaseConstructor = typeof Database;

const localRequire = createRequire(import.meta.url);
let databaseConstructor: DatabaseConstructor | undefined;
let betterSqlite3PackageRoot: string | undefined;

function findBetterSqlite3PackageRoot(): string | undefined {
	if (betterSqlite3PackageRoot) return betterSqlite3PackageRoot;
	let current = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidate = join(current, "node_modules", "better-sqlite3");
		if (existsSync(join(candidate, "package.json"))) {
			betterSqlite3PackageRoot = candidate;
			return betterSqlite3PackageRoot;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findBetterSqlite3Entry(): string | undefined {
	const packageRoot = findBetterSqlite3PackageRoot();
	return packageRoot ? join(packageRoot, "lib", "index.js") : undefined;
}

function findBetterSqlite3NativeBinding(): string | undefined {
	const packageRoot = findBetterSqlite3PackageRoot();
	if (!packageRoot) return undefined;
	const candidate = join(packageRoot, "build", "Release", "better_sqlite3.node");
	return existsSync(candidate) ? candidate : undefined;
}

function betterSqlite3PackageName(): string {
	return ["better", "sqlite3"].join("-");
}

function bunSqliteModuleName(): string {
	return ["bun", "sqlite"].join(":");
}

function isBunRuntime(): boolean {
	return typeof (process.versions as { bun?: unknown }).bun === "string";
}

function loadDatabaseConstructor(): DatabaseConstructor {
	if (databaseConstructor) return databaseConstructor;
	if (isBunRuntime()) {
		const bunSqlite = localRequire(bunSqliteModuleName()) as { Database: unknown };
		databaseConstructor = bunSqlite.Database as DatabaseConstructor;
		return databaseConstructor;
	}
	try {
		databaseConstructor = localRequire(betterSqlite3PackageName()) as DatabaseConstructor;
		return databaseConstructor;
	} catch (error) {
		const entry = findBetterSqlite3Entry();
		if (entry) {
			databaseConstructor = localRequire(entry) as DatabaseConstructor;
			return databaseConstructor;
		}
		throw error;
	}
}

function applyPragma(db: Database.Database, pragma: string): void {
	const sqlite = db as Database.Database & { pragma?: (source: string) => unknown };
	if (typeof sqlite.pragma === "function") {
		sqlite.pragma(pragma);
		return;
	}
	db.exec(`PRAGMA ${pragma}`);
}

function basenameForHostPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function normalizeForHostComparison(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isWithinOrEqualPath(path: string, parent: string): boolean {
	const normalizedPath = normalizeForHostComparison(path);
	const normalizedParent = normalizeForHostComparison(parent);
	return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export function getDefaultKnowledgeDir(): string {
	const explicit = process.env.PI_KNOWLEDGE_DIR?.trim() || process.env.OMP_KNOWLEDGE_DIR?.trim();
	if (explicit) return explicit;

	const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim() || process.env.OMP_CODING_AGENT_DIR?.trim();
	if (configuredAgentDir) return resolveHostKnowledgeDir(dirname(configuredAgentDir));

	const hostRoot = join(homedir(), isOmpHost() ? ".omp" : ".pi");
	return resolveHostKnowledgeDir(hostRoot);
}

export function resolveHostKnowledgeDir(
	hostRoot: string,
	options: { legacyPiDir?: string; exists?: (path: string) => boolean; homeDir?: string } = {},
): string {
	const pathExists = options.exists ?? existsSync;
	const target = join(hostRoot, "knowledge");
	const homeDir = options.homeDir ?? homedir();
	const legacyPiDir = options.legacyPiDir ?? join(homeDir, ".pi", "knowledge");
	if (
		basenameForHostPath(hostRoot) === ".omp" &&
		isWithinOrEqualPath(hostRoot, homeDir) &&
		!pathExists(target) &&
		pathExists(legacyPiDir)
	) {
		return legacyPiDir;
	}
	return target;
}

function isOmpHost(): boolean {
	if (process.env.OMP_PROFILE?.trim()) return true;
	const candidates = [process.argv[1], process.execPath].filter((value): value is string => typeof value === "string");
	return candidates.some((value) => {
		const executableName = basenameForHostPath(value).toLowerCase();
		return executableName === "omp" || executableName === "omp.exe";
	});
}

export function openDatabase(knowledgeDir?: string): Database.Database {
	const dir = knowledgeDir ?? getDefaultKnowledgeDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const dbPath = join(dir, "knowledge.db");
	const Database = loadDatabaseConstructor();
	const nativeBinding = isBunRuntime() ? undefined : findBetterSqlite3NativeBinding();
	const db = nativeBinding ? new Database(dbPath, { nativeBinding }) : new Database(dbPath);
	applyPragma(db, "journal_mode = WAL");
	applyPragma(db, "busy_timeout = 60000");
	applyPragma(db, "foreign_keys = ON");

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
		2: `
CREATE TABLE IF NOT EXISTS indexing_jobs (
  kb_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_progress_at INTEGER NOT NULL,
  processed_files INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER,
  skipped_total INTEGER NOT NULL DEFAULT 0,
  added_chunks INTEGER NOT NULL DEFAULT 0,
  removed_chunks INTEGER NOT NULL DEFAULT 0,
  unchanged_chunks INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
`,
	};
	for (let v = from + 1; v <= to; v++) {
		if (v === 3) {
			const columns = db.prepare("PRAGMA table_info(knowledge_bases)").all() as Array<{ name: string }>;
			if (!columns.some((column) => column.name === "source_options")) {
				db.exec("ALTER TABLE knowledge_bases ADD COLUMN source_options TEXT");
			}
			continue;
		}
		if (v === 4) {
			db.exec(`
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'text',
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER NOT NULL DEFAULT 0,
  container_name TEXT,
  signature TEXT,
  text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_kb_name ON symbols(kb_id, normalized_name);
CREATE INDEX IF NOT EXISTS idx_symbols_kb_kind ON symbols(kb_id, kind);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(kb_id, file_path);
`);
			continue;
		}
		if (v === 5) {
			const columns = db.prepare("PRAGMA table_info(knowledge_bases)").all() as Array<{ name: string }>;
			if (!columns.some((column) => column.name === "embedding_signature")) {
				db.exec("ALTER TABLE knowledge_bases ADD COLUMN embedding_signature TEXT");
			}
			if (!columns.some((column) => column.name === "embedding_dimension")) {
				db.exec("ALTER TABLE knowledge_bases ADD COLUMN embedding_dimension INTEGER");
			}
			continue;
		}
		if (migrations[v]) db.exec(migrations[v]);
	}
}

// --- CRUD: Knowledge Bases ---

export function createKB(
	db: Database.Database,
	opts: {
		name: string;
		description?: string;
		source_path?: string;
		source_type: KnowledgeBase["source_type"];
		source_options?: string;
		embedding_model?: string;
		embedding_signature?: string;
		embedding_dimension?: number;
	},
): KnowledgeBase {
	const id = randomUUID();
	const now = Date.now();
	db.prepare(
		`INSERT INTO knowledge_bases (
       id, name, description, source_path, source_type, source_options, created_at, updated_at,
       embedding_model, embedding_signature, embedding_dimension
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		opts.name,
		opts.description ?? null,
		opts.source_path ?? null,
		opts.source_type,
		opts.source_options ?? null,
		now,
		now,
		opts.embedding_model ?? "multilingual-e5-small",
		opts.embedding_signature ?? null,
		opts.embedding_dimension ?? null,
	);
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
	db.prepare("DELETE FROM indexing_jobs WHERE kb_id = ?").run(id);
	db.prepare("DELETE FROM symbols WHERE kb_id = ?").run(id);
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

export function updateKBSourceOptions(db: Database.Database, id: string, sourceOptions: string): void {
	db.prepare("UPDATE knowledge_bases SET source_options = ?, updated_at = ? WHERE id = ?").run(
		sourceOptions,
		Date.now(),
		id,
	);
}

export function updateKBEmbeddingMetadata(
	db: Database.Database,
	id: string,
	embeddingModel: string,
	embeddingSignature: string | null,
	embeddingDimension: number | null,
): void {
	db.prepare(
		`UPDATE knowledge_bases
     SET embedding_model = ?, embedding_signature = ?, embedding_dimension = ?, updated_at = ?
     WHERE id = ?`,
	).run(embeddingModel, embeddingSignature, embeddingDimension, Date.now(), id);
}

// --- Indexing Jobs ---

export function startIndexingJob(
	db: Database.Database,
	kbId: string,
	operation: IndexingJob["operation"],
	message: string,
): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO indexing_jobs (
			kb_id, operation, status, phase, message, started_at, updated_at, last_progress_at
		) VALUES (?, ?, 'running', 'starting', ?, ?, ?, ?)
		ON CONFLICT(kb_id) DO UPDATE SET
			operation = excluded.operation,
			status = 'running',
			phase = 'starting',
			message = excluded.message,
			started_at = excluded.started_at,
			updated_at = excluded.updated_at,
			last_progress_at = excluded.last_progress_at,
			processed_files = 0,
			processed_chunks = 0,
			total_files = NULL,
			skipped_total = 0,
			added_chunks = 0,
			removed_chunks = 0,
			unchanged_chunks = 0,
			error_message = NULL`,
	).run(kbId, operation, message, now, now, now);
}

export function updateIndexingJob(
	db: Database.Database,
	kbId: string,
	progress: {
		phase?: string;
		message?: string;
		processed_files?: number;
		processed_chunks?: number;
		total_files?: number | null;
		skipped_total?: number;
		added_chunks?: number;
		removed_chunks?: number;
		unchanged_chunks?: number;
	},
): void {
	const current = getIndexingJob(db, kbId);
	if (!current) return;
	const now = Date.now();
	db.prepare(
		`UPDATE indexing_jobs SET
			phase = ?,
			message = ?,
			updated_at = ?,
			last_progress_at = ?,
			processed_files = ?,
			processed_chunks = ?,
			total_files = ?,
			skipped_total = ?,
			added_chunks = ?,
			removed_chunks = ?,
			unchanged_chunks = ?
		WHERE kb_id = ?`,
	).run(
		progress.phase ?? current.phase,
		progress.message ?? current.message,
		now,
		now,
		progress.processed_files ?? current.processed_files,
		progress.processed_chunks ?? current.processed_chunks,
		progress.total_files === undefined ? current.total_files : progress.total_files,
		progress.skipped_total ?? current.skipped_total,
		progress.added_chunks ?? current.added_chunks,
		progress.removed_chunks ?? current.removed_chunks,
		progress.unchanged_chunks ?? current.unchanged_chunks,
		kbId,
	);
}

export function finishIndexingJob(
	db: Database.Database,
	kbId: string,
	status: Extract<IndexingJob["status"], "succeeded" | "failed" | "cancelled">,
	message: string,
	errorMessage?: string,
): void {
	const now = Date.now();
	db.prepare(
		`UPDATE indexing_jobs SET
			status = ?,
			phase = ?,
			message = ?,
			updated_at = ?,
			last_progress_at = ?,
			error_message = ?
		WHERE kb_id = ?`,
	).run(status, status, message, now, now, errorMessage ?? null, kbId);
}

export function getIndexingJob(db: Database.Database, kbId: string): IndexingJob | undefined {
	return db.prepare("SELECT * FROM indexing_jobs WHERE kb_id = ?").get(kbId) as IndexingJob | undefined;
}

// --- CRUD: Chunks ---

export function insertChunks(db: Database.Database, kbId: string, chunks: ChunkInsert[]): string[] {
	const ids: string[] = [];
	const stmt = db.prepare(
		`INSERT INTO chunks (id, kb_id, content_hash, content, content_tokenized, file_path, file_type, start_line, end_line, metadata_json, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const now = Date.now();
	const insertMany = db.transaction((items: ChunkInsert[]) => {
		for (const c of items) {
			const id = randomUUID();
			ids.push(id);
			stmt.run(
				id,
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
	return ids;
}

export function getChunksByKB(db: Database.Database, kbId: string): Chunk[] {
	return db.prepare("SELECT * FROM chunks WHERE kb_id = ? ORDER BY rowid").all(kbId) as Chunk[];
}

export function iterateChunksByKB(db: Database.Database, kbId: string): IterableIterator<Chunk> {
	return iterateChunkRowsByKB(db, kbId);
}

export function getChunkIdsByKB(db: Database.Database, kbId: string): string[] {
	const rows = db.prepare("SELECT id FROM chunks WHERE kb_id = ? ORDER BY rowid").all(kbId) as { id: string }[];
	return rows.map((r) => r.id);
}

export function iterateChunkIdsByKB(db: Database.Database, kbId: string): IterableIterator<{ id: string }> {
	return iterateChunkIdRowsByKB(db, kbId);
}

export function getChunkById(db: Database.Database, id: string): Chunk | undefined {
	return db.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Chunk | undefined;
}

export function getChunksByFile(
	db: Database.Database,
	kbId: string,
	filePath: string,
	startLine: number,
	endLine: number,
): Chunk[] {
	return db
		.prepare(
			`SELECT * FROM chunks
       WHERE kb_id = ? AND file_path = ? AND end_line >= ? AND start_line <= ?
       ORDER BY start_line, end_line`,
		)
		.all(kbId, filePath, startLine, endLine) as Chunk[];
}

export function getChunkByRowid(db: Database.Database, rowid: number): Chunk | undefined {
	return db.prepare("SELECT * FROM chunks WHERE rowid = ?").get(rowid) as Chunk | undefined;
}

export function deleteChunksByKB(db: Database.Database, kbId: string): void {
	db.prepare("DELETE FROM chunks WHERE kb_id = ?").run(kbId);
}

export function deleteChunksByIds(db: Database.Database, ids: string[]): void {
	if (ids.length === 0) return;
	const batchSize = 500;
	const deleteBatch = db.transaction((batch: string[]) => {
		const placeholders = batch.map(() => "?").join(",");
		db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...batch);
	});
	for (let offset = 0; offset < ids.length; offset += batchSize) {
		deleteBatch(ids.slice(offset, offset + batchSize));
	}
}

export function getChunkHashesByKB(db: Database.Database, kbId: string): Map<string, string> {
	const rows = db.prepare("SELECT id, content_hash FROM chunks WHERE kb_id = ? ORDER BY rowid").all(kbId) as {
		id: string;
		content_hash: string;
	}[];
	return new Map(rows.map((r) => [r.content_hash, r.id]));
}

export function iterateChunkHashesByKB(
	db: Database.Database,
	kbId: string,
): IterableIterator<{ id: string; content_hash: string }> {
	return iterateChunkHashRowsByKB(db, kbId);
}

function* iterateChunkRowsByKB(db: Database.Database, kbId: string): IterableIterator<Chunk> {
	let lastRowid = 0;
	const statement = db.prepare(
		`SELECT rowid as rowid, * FROM chunks
		 WHERE kb_id = ? AND rowid > ?
		 ORDER BY rowid
		 LIMIT ?`,
	);
	while (true) {
		const rows = statement.all(kbId, lastRowid, ITERATION_BATCH_SIZE) as Array<Chunk & { rowid: number }>;
		if (rows.length === 0) return;
		for (const row of rows) {
			lastRowid = row.rowid;
			const { rowid: _rowid, ...chunk } = row;
			yield chunk;
		}
	}
}

function* iterateChunkIdRowsByKB(db: Database.Database, kbId: string): IterableIterator<{ id: string }> {
	let lastRowid = 0;
	const statement = db.prepare(
		`SELECT rowid, id FROM chunks
		 WHERE kb_id = ? AND rowid > ?
		 ORDER BY rowid
		 LIMIT ?`,
	);
	while (true) {
		const rows = statement.all(kbId, lastRowid, ITERATION_BATCH_SIZE) as Array<{ rowid: number; id: string }>;
		if (rows.length === 0) return;
		for (const row of rows) {
			lastRowid = row.rowid;
			yield { id: row.id };
		}
	}
}

function* iterateChunkHashRowsByKB(
	db: Database.Database,
	kbId: string,
): IterableIterator<{ id: string; content_hash: string }> {
	let lastRowid = 0;
	const statement = db.prepare(
		`SELECT rowid, id, content_hash FROM chunks
		 WHERE kb_id = ? AND rowid > ?
		 ORDER BY rowid
		 LIMIT ?`,
	);
	while (true) {
		const rows = statement.all(kbId, lastRowid, ITERATION_BATCH_SIZE) as Array<{
			rowid: number;
			id: string;
			content_hash: string;
		}>;
		if (rows.length === 0) return;
		for (const row of rows) {
			lastRowid = row.rowid;
			yield { id: row.id, content_hash: row.content_hash };
		}
	}
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

// --- CRUD: Symbols ---

function normalizeSymbolName(name: string): string {
	return name.trim().toLowerCase();
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function insertSymbols(db: Database.Database, kbId: string, symbols: KnowledgeSymbolInsert[]): void {
	if (symbols.length === 0) return;
	const stmt = db.prepare(
		`INSERT INTO symbols (
			id, kb_id, name, normalized_name, kind, file_path, file_type, start_line, end_line,
			container_name, signature, text, metadata_json, indexed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const now = Date.now();
	const insertMany = db.transaction((items: KnowledgeSymbolInsert[]) => {
		for (const symbol of items) {
			stmt.run(
				randomUUID(),
				kbId,
				symbol.name,
				normalizeSymbolName(symbol.name),
				symbol.kind,
				symbol.file_path,
				symbol.file_type,
				symbol.start_line,
				symbol.end_line,
				symbol.container_name ?? null,
				symbol.signature ?? null,
				symbol.text,
				symbol.metadata_json,
				now,
			);
		}
	});
	insertMany(symbols);
}

export function deleteSymbolsByKB(db: Database.Database, kbId: string): void {
	db.prepare("DELETE FROM symbols WHERE kb_id = ?").run(kbId);
}

export function deleteSymbolsByFile(db: Database.Database, kbId: string, filePath: string): void {
	db.prepare("DELETE FROM symbols WHERE kb_id = ? AND file_path = ?").run(kbId, filePath);
}

export function searchSymbols(
	db: Database.Database,
	query: string,
	options: {
		kbId?: string;
		kind?: KnowledgeSymbol["kind"];
		filePattern?: string;
		limit?: number;
		offset?: number;
		exact?: boolean;
	} = {},
): KnowledgeSymbol[] {
	const clauses: string[] = ["kb.status IN ('ready', 'stale')"];
	const params: Array<string | number> = [];
	const normalizedQuery = normalizeSymbolName(query);
	if (options.kbId) {
		clauses.push("s.kb_id = ?");
		params.push(options.kbId);
	}
	if (options.kind) {
		clauses.push("s.kind = ?");
		params.push(options.kind);
	}
	if (options.filePattern) {
		clauses.push("s.file_path LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLike(options.filePattern)}%`);
	}
	if (normalizedQuery) {
		if (options.exact) {
			clauses.push("s.normalized_name = ?");
			params.push(normalizedQuery);
		} else {
			clauses.push(
				"(s.normalized_name LIKE ? ESCAPE '\\' OR s.file_path LIKE ? ESCAPE '\\' OR s.text LIKE ? ESCAPE '\\')",
			);
			const pattern = `%${escapeLike(normalizedQuery)}%`;
			params.push(pattern, pattern, pattern);
		}
	}
	const where = `WHERE ${clauses.join(" AND ")}`;
	const limit = Math.max(1, Math.min(200, options.limit ?? 20));
	const offset = Math.max(0, options.offset ?? 0);
	return db
		.prepare(
			`SELECT s.* FROM symbols s
			 JOIN knowledge_bases kb ON kb.id = s.kb_id
			 ${where}
			 ORDER BY
			   CASE WHEN s.normalized_name = ? THEN 0 WHEN s.normalized_name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
			   s.file_path, s.start_line
			 LIMIT ? OFFSET ?`,
		)
		.all(...params, normalizedQuery, `${escapeLike(normalizedQuery)}%`, limit, offset) as KnowledgeSymbol[];
}

export function countSymbols(
	db: Database.Database,
	query: string,
	options: {
		kbId?: string;
		kind?: KnowledgeSymbol["kind"];
		filePattern?: string;
		exact?: boolean;
	} = {},
): number {
	const clauses: string[] = ["kb.status IN ('ready', 'stale')"];
	const params: string[] = [];
	const normalizedQuery = normalizeSymbolName(query);
	if (options.kbId) {
		clauses.push("s.kb_id = ?");
		params.push(options.kbId);
	}
	if (options.kind) {
		clauses.push("s.kind = ?");
		params.push(options.kind);
	}
	if (options.filePattern) {
		clauses.push("s.file_path LIKE ? ESCAPE '\\'");
		params.push(`%${escapeLike(options.filePattern)}%`);
	}
	if (normalizedQuery) {
		if (options.exact) {
			clauses.push("s.normalized_name = ?");
			params.push(normalizedQuery);
		} else {
			clauses.push(
				"(s.normalized_name LIKE ? ESCAPE '\\' OR s.file_path LIKE ? ESCAPE '\\' OR s.text LIKE ? ESCAPE '\\')",
			);
			const pattern = `%${escapeLike(normalizedQuery)}%`;
			params.push(pattern, pattern, pattern);
		}
	}
	const where = `WHERE ${clauses.join(" AND ")}`;
	const row = db
		.prepare(`SELECT COUNT(*) as count FROM symbols s JOIN knowledge_bases kb ON kb.id = s.kb_id ${where}`)
		.get(...params) as { count: number };
	return row.count;
}

export function getSymbolCount(db: Database.Database, kbId: string): number {
	const row = db.prepare("SELECT COUNT(*) as count FROM symbols WHERE kb_id = ?").get(kbId) as { count: number };
	return row.count;
}
