import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { walkDir } from "../indexer/chunker.ts";
import { type KnowledgeBase, getChunksByKB } from "../storage/sqlite.ts";

export interface DiagnosticResult {
	kb_id: string;
	kb_name: string;
	stale_files: string[];      // files modified after indexing
	orphan_files: string[];     // chunks referencing deleted files
	coverage_percent: number;   // indexed files / total scannable files
	total_source_files: number;
	indexed_files: number;
}

export function diagnoseKB(db: Database.Database, kb: KnowledgeBase): DiagnosticResult {
	const result: DiagnosticResult = {
		kb_id: kb.id,
		kb_name: kb.name,
		stale_files: [],
		orphan_files: [],
		coverage_percent: 100,
		total_source_files: 0,
		indexed_files: kb.file_count,
	};

	if (!kb.source_path || !existsSync(kb.source_path)) {
		return result; // text KBs or missing source — no diagnostics possible
	}

	// Scan current source files
	const currentFiles = new Set<string>();
	try {
		const scanned = statSync(kb.source_path).isDirectory()
			? walkDir(kb.source_path).map((f) => f.relPath)
			: [kb.source_path];
		for (const f of scanned) currentFiles.add(f);
	} catch {
		return result;
	}

	result.total_source_files = currentFiles.size;
	result.coverage_percent = currentFiles.size > 0 ? Math.round((result.indexed_files / currentFiles.size) * 100) : 100;

	// Get indexed chunks
	const chunks = getChunksByKB(db, kb.id);
	const indexedFilePaths = new Set(chunks.map((c) => c.file_path));

	// Orphan detection: chunks referencing files no longer in source
	for (const filePath of indexedFilePaths) {
		if (!currentFiles.has(filePath)) {
			result.orphan_files.push(filePath);
		}
	}

	// Staleness detection: source files modified after last indexing
	for (const relPath of currentFiles) {
		const absPath = join(kb.source_path, relPath);
		try {
			const mtime = statSync(absPath).mtimeMs;
			// Find latest indexed_at for this file's chunks
			const fileChunks = chunks.filter((c) => c.file_path === relPath);
			if (fileChunks.length > 0) {
				const latestIndexed = Math.max(...fileChunks.map((c) => c.indexed_at));
				if (mtime > latestIndexed) {
					result.stale_files.push(relPath);
				}
			}
		} catch { /* file unreadable — skip */ }
	}

	return result;
}
