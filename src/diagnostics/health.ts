import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type ScanResult, walkDirDetailed } from "../indexer/chunker.ts";
import { getChunksByKB, type KnowledgeBase } from "../storage/sqlite.ts";

export interface DiagnosticResult {
	kb_id: string;
	kb_name: string;
	status: KnowledgeBase["status"];
	status_age_ms: number;
	stuck_indexing: boolean;
	stale_files: string[]; // files modified after indexing
	orphan_files: string[]; // chunks referencing deleted files
	coverage_percent: number; // indexed files / total scannable files
	total_source_files: number;
	indexed_files: number;
	skipped_files: ScanResult["skipped"];
}

const DEFAULT_STALE_INDEXING_MS = 10 * 60 * 1000;

function staleIndexingMs(): number {
	const configured = Number(process.env.PI_KNOWLEDGE_STALE_INDEXING_MS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_INDEXING_MS;
}

export function diagnoseKB(db: Database.Database, kb: KnowledgeBase): DiagnosticResult {
	const statusAgeMs = Date.now() - kb.updated_at;
	const result: DiagnosticResult = {
		kb_id: kb.id,
		kb_name: kb.name,
		status: kb.status,
		status_age_ms: statusAgeMs,
		stuck_indexing: kb.status === "indexing" && statusAgeMs > staleIndexingMs(),
		stale_files: [],
		orphan_files: [],
		coverage_percent: 100,
		total_source_files: 0,
		indexed_files: kb.file_count,
		skipped_files: {
			total: 0,
			by_reason: {
				ignored: 0,
				oversized: 0,
				binary: 0,
				unreadable: 0,
				inaccessible: 0,
			},
			samples: [],
		},
	};

	if (!kb.source_path || kb.source_type === "url" || !existsSync(kb.source_path)) {
		return result; // text KBs or missing source — no diagnostics possible
	}

	// Scan current source files
	const currentFiles = new Set<string>();
	const isDirectory = statSync(kb.source_path).isDirectory();
	try {
		const scanResult = isDirectory
			? walkDirDetailed(kb.source_path)
			: { files: [{ relPath: kb.source_path }], skipped: result.skipped_files };
		result.skipped_files = scanResult.skipped;
		const scanned = scanResult.files.map((f) => f.relPath);
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
		const absPath = isDirectory ? join(kb.source_path, relPath) : relPath;
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
		} catch {
			/* file unreadable — skip */
		}
	}

	return result;
}
