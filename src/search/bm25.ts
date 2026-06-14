import type Database from "better-sqlite3";
import { preTokenizeForFTS } from "../indexer/chunker.ts";

export interface BM25Result { chunkId: string; score: number; }

function prepareFtsQuery(query: string): string {
	let q = preTokenizeForFTS(query);
	q = q.replace(/[*"(){}[\]^~:+.#@!\\/<>|&$%]/g, " ");
	const terms = q.split(/\s+/).filter((t) => t.length > 0);
	if (terms.length === 0) return "";
	return terms.join(" AND ");
}

export function searchBM25(db: Database.Database, query: string, limit = 50, kbId?: string): BM25Result[] {
	const ftsQuery = prepareFtsQuery(query);
	if (!ftsQuery) return [];
	try {
		if (kbId) {
			return db.prepare(
				`SELECT c.id as chunkId, bm25(chunks_fts) as score
         FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid
         WHERE chunks_fts MATCH ? AND c.kb_id = ? ORDER BY score LIMIT ?`,
			).all(ftsQuery, kbId, limit) as BM25Result[];
		}
		return db.prepare(
			`SELECT c.id as chunkId, bm25(chunks_fts) as score
       FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid
       WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`,
		).all(ftsQuery, limit) as BM25Result[];
	} catch { return []; }
}
