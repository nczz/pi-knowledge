import type Database from "better-sqlite3";
import { normalizedQueryText } from "./query.ts";

export interface BM25Result {
	chunkId: string;
	score: number;
}

function prepareFtsTerms(query: string): string[] {
	return normalizedQueryText(query)
		.split(/\s+/)
		.filter((t) => t.length > 0);
}

function runSearch(db: Database.Database, ftsQuery: string, limit: number, kbId?: string): BM25Result[] {
	if (kbId) {
		return db
			.prepare(
				`SELECT c.id as chunkId, -bm25(chunks_fts) as score
       FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid
       WHERE chunks_fts MATCH ? AND c.kb_id = ? ORDER BY bm25(chunks_fts) LIMIT ?`,
			)
			.all(ftsQuery, kbId, limit) as BM25Result[];
	}
	return db
		.prepare(
			`SELECT c.id as chunkId, -bm25(chunks_fts) as score
     FROM chunks_fts JOIN chunks c ON chunks_fts.rowid = c.rowid
     WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`,
		)
		.all(ftsQuery, limit) as BM25Result[];
}

export function searchBM25(db: Database.Database, query: string, limit = 50, kbId?: string): BM25Result[] {
	const terms = prepareFtsTerms(query);
	if (terms.length === 0) return [];
	try {
		const strict = runSearch(db, terms.join(" AND "), limit, kbId);
		if (strict.length > 0 || terms.length === 1) return strict;
		return runSearch(db, terms.join(" OR "), limit, kbId);
	} catch {
		return [];
	}
}
