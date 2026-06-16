import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createSkippedScanStats, iterateScannableFiles, type ScanResult } from "../indexer/chunker.ts";
import { getIndexingJob, type IndexingJob, iterateChunksByKB, type KnowledgeBase } from "../storage/sqlite.ts";

export interface DiagnosticResult {
	kb_id: string;
	kb_name: string;
	status: KnowledgeBase["status"];
	status_age_ms: number;
	last_progress_age_ms: number;
	stuck_indexing: boolean;
	stale_files: string[]; // files modified after indexing
	orphan_files: string[]; // chunks referencing deleted files
	coverage_percent: number; // indexed files / total scannable files
	total_source_files: number;
	indexed_files: number;
	skipped_files: ScanResult["skipped"];
	job?: IndexingJob;
}

const DEFAULT_STALE_INDEXING_MS = 10 * 60 * 1000;

function staleIndexingMs(): number {
	const configured = Number(process.env.PI_KNOWLEDGE_STALE_INDEXING_MS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_INDEXING_MS;
}

export function diagnoseKB(db: Database.Database, kb: KnowledgeBase): DiagnosticResult {
	const statusAgeMs = Date.now() - kb.updated_at;
	const job = getIndexingJob(db, kb.id);
	const lastProgressAgeMs = job?.status === "running" ? Date.now() - job.last_progress_at : statusAgeMs;
	const result: DiagnosticResult = {
		kb_id: kb.id,
		kb_name: kb.name,
		status: kb.status,
		status_age_ms: statusAgeMs,
		last_progress_age_ms: lastProgressAgeMs,
		stuck_indexing: kb.status === "indexing" && lastProgressAgeMs > staleIndexingMs(),
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
		job,
	};

	if (!kb.source_path || kb.source_type === "url" || !existsSync(kb.source_path)) {
		return result; // text KBs or missing source — no diagnostics possible
	}

	// Scan current source files
	const currentFiles = new Set<string>();
	const isDirectory = statSync(kb.source_path).isDirectory();
	try {
		if (isDirectory) {
			const skipped = createSkippedScanStats();
			for (const file of iterateScannableFiles(kb.source_path, skipped)) currentFiles.add(file.relPath);
			result.skipped_files = skipped;
		} else {
			currentFiles.add(kb.source_path);
		}
	} catch {
		return result;
	}

	result.total_source_files = currentFiles.size;
	result.coverage_percent = currentFiles.size > 0 ? Math.round((result.indexed_files / currentFiles.size) * 100) : 100;

	const indexedFilePaths = new Set<string>();
	const latestIndexedByFile = new Map<string, number>();
	for (const chunk of iterateChunksByKB(db, kb.id)) {
		indexedFilePaths.add(chunk.file_path);
		const currentLatest = latestIndexedByFile.get(chunk.file_path) ?? 0;
		if (chunk.indexed_at > currentLatest) latestIndexedByFile.set(chunk.file_path, chunk.indexed_at);
	}

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
			const latestIndexed = latestIndexedByFile.get(relPath);
			if (latestIndexed !== undefined && mtime > latestIndexed) {
				result.stale_files.push(relPath);
			}
		} catch {
			/* file unreadable — skip */
		}
	}

	return result;
}
