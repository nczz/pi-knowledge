import { existsSync, statSync } from "node:fs";
import { stat as statFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type Database from "better-sqlite3";
import {
	createSkippedScanStats,
	iterateScannableFiles,
	iterateScannableFilesAsync,
	type ScanOptions,
	type ScanResult,
} from "../indexer/chunker.ts";
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
	stale_file_count?: number;
	orphan_file_count?: number;
	stale_files_truncated?: boolean;
	orphan_files_truncated?: boolean;
	coverage_percent: number; // indexed files / total scannable files
	total_source_files: number;
	indexed_files: number;
	skipped_files: ScanResult["skipped"];
	scan_error?: string;
	job?: IndexingJob;
}

const DEFAULT_STALE_INDEXING_MS = 10 * 60 * 1000;
const MAX_DIAGNOSTIC_PATHS = 1_000;
const DIAGNOSTIC_YIELD_ITEMS = 1_000;
const MAX_DIAGNOSTIC_WORKING_PATHS = 100_000;
const MAX_DIAGNOSTIC_WORKING_PATH_BYTES = 64 * 1024 * 1024;

function staleIndexingMs(): number {
	const configured = Number(process.env.PI_KNOWLEDGE_STALE_INDEXING_MS);
	return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_INDEXING_MS;
}

function scanOptionsFromSourceOptions(raw: string | null): ScanOptions {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as {
			include_suggested_text?: unknown;
			include_paths?: unknown;
			exclude_paths?: unknown;
		};
		return {
			includeSuggestedText: parsed.include_suggested_text === true,
			includePaths: Array.isArray(parsed.include_paths)
				? parsed.include_paths.filter((item) => typeof item === "string")
				: undefined,
			excludePaths: Array.isArray(parsed.exclude_paths)
				? parsed.exclude_paths.filter((item) => typeof item === "string")
				: undefined,
		};
	} catch {
		return {};
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}
function diagnosticScanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}

export function diagnoseKB(db: Database.Database, kb: KnowledgeBase, signal?: AbortSignal): DiagnosticResult {
	const statusAgeMs = Date.now() - kb.updated_at;
	const job = getIndexingJob(db, kb.id);
	const lastProgressAgeMs = job?.status === "running" ? Date.now() - job.last_progress_at : statusAgeMs;
	const result: DiagnosticResult = {
		kb_id: kb.id,
		kb_name: kb.name,
		status: kb.status,
		status_age_ms: statusAgeMs,
		last_progress_age_ms: lastProgressAgeMs,
		stuck_indexing: (kb.status === "indexing" || job?.status === "running") && lastProgressAgeMs > staleIndexingMs(),
		stale_files: [],
		orphan_files: [],
		stale_file_count: 0,
		orphan_file_count: 0,
		stale_files_truncated: false,
		orphan_files_truncated: false,
		coverage_percent: 100,
		total_source_files: 0,
		indexed_files: kb.file_count,
		skipped_files: createSkippedScanStats(),
		job,
	};

	throwIfAborted(signal);

	if (!kb.source_path || kb.source_type === "url" || !existsSync(kb.source_path)) {
		return result; // text KBs or missing source — no diagnostics possible
	}

	// Scan current source files
	const currentFiles = new Set<string>();
	const isDirectory = statSync(kb.source_path).isDirectory();
	try {
		if (isDirectory) {
			const skipped = createSkippedScanStats();
			for (const file of iterateScannableFiles(
				kb.source_path,
				skipped,
				scanOptionsFromSourceOptions(kb.source_options),
			)) {
				throwIfAborted(signal);
				currentFiles.add(file.relPath);
			}
			result.skipped_files = skipped;
		} else {
			currentFiles.add(kb.source_path);
		}
	} catch (error) {
		if (signal?.aborted) throw new Error("Cancelled");
		result.coverage_percent = 0;
		result.scan_error = diagnosticScanError(error);
		return result;
	}

	result.total_source_files = currentFiles.size;
	result.coverage_percent = currentFiles.size > 0 ? Math.round((result.indexed_files / currentFiles.size) * 100) : 100;

	const indexedFilePaths = new Set<string>();
	const latestIndexedByFile = new Map<string, number>();
	for (const chunk of iterateChunksByKB(db, kb.id)) {
		throwIfAborted(signal);
		indexedFilePaths.add(chunk.file_path);
		const currentLatest = latestIndexedByFile.get(chunk.file_path) ?? 0;
		if (chunk.indexed_at > currentLatest) latestIndexedByFile.set(chunk.file_path, chunk.indexed_at);
	}

	// Orphan detection: chunks referencing files no longer in source
	for (const filePath of indexedFilePaths) {
		throwIfAborted(signal);
		if (!currentFiles.has(filePath)) {
			result.orphan_files.push(filePath);
			result.orphan_file_count = (result.orphan_file_count ?? 0) + 1;
		}
	}

	// Staleness detection: source files modified after last indexing
	for (const relPath of currentFiles) {
		throwIfAborted(signal);
		const absPath = isDirectory ? join(kb.source_path, relPath) : relPath;
		try {
			const mtime = statSync(absPath).mtimeMs;
			const latestIndexed = latestIndexedByFile.get(relPath);
			if (latestIndexed !== undefined && mtime > latestIndexed) {
				result.stale_files.push(relPath);
				result.stale_file_count = (result.stale_file_count ?? 0) + 1;
			}
		} catch {
			/* file unreadable — skip */
		}
	}

	return result;
}

export async function diagnoseKBAsync(
	db: Database.Database,
	kb: KnowledgeBase,
	signal?: AbortSignal,
	maxDiagnosticPaths = MAX_DIAGNOSTIC_PATHS,
): Promise<DiagnosticResult> {
	const statusAgeMs = Date.now() - kb.updated_at;
	const job = getIndexingJob(db, kb.id);
	const lastProgressAgeMs = job?.status === "running" ? Date.now() - job.last_progress_at : statusAgeMs;
	const result: DiagnosticResult = {
		kb_id: kb.id,
		kb_name: kb.name,
		status: kb.status,
		status_age_ms: statusAgeMs,
		last_progress_age_ms: lastProgressAgeMs,
		stuck_indexing: (kb.status === "indexing" || job?.status === "running") && lastProgressAgeMs > staleIndexingMs(),
		stale_files: [],
		orphan_files: [],
		stale_file_count: 0,
		orphan_file_count: 0,
		stale_files_truncated: false,
		orphan_files_truncated: false,
		coverage_percent: 100,
		total_source_files: 0,
		indexed_files: kb.file_count,
		skipped_files: createSkippedScanStats(),
		job,
	};
	throwIfAborted(signal);
	if (!kb.source_path || kb.source_type === "url" || !existsSync(kb.source_path)) return result;

	const currentFiles = new Set<string>();
	let currentPathBytes = 0;
	let isDirectory: boolean;
	try {
		isDirectory = (await statFile(kb.source_path)).isDirectory();
		if (isDirectory) {
			const skipped = createSkippedScanStats();
			for await (const file of iterateScannableFilesAsync(
				kb.source_path,
				skipped,
				scanOptionsFromSourceOptions(kb.source_options),
				signal,
			)) {
				currentPathBytes += Buffer.byteLength(file.relPath);
				if (currentFiles.size >= MAX_DIAGNOSTIC_WORKING_PATHS || currentPathBytes > MAX_DIAGNOSTIC_WORKING_PATH_BYTES) {
					throw new Error("Diagnostic source path working-set limit exceeded");
				}
				currentFiles.add(file.relPath);
			}
			result.skipped_files = skipped;
		} else {
			currentFiles.add(kb.source_path);
		}
	} catch (error) {
		throwIfAborted(signal);
		result.coverage_percent = 0;
		result.scan_error = diagnosticScanError(error);
		return result;
	}

	result.total_source_files = currentFiles.size;
	result.coverage_percent = currentFiles.size > 0 ? Math.round((result.indexed_files / currentFiles.size) * 100) : 100;
	const latestIndexedByFile = new Map<string, number>();
	let indexedPathBytes = 0;
	let processed = 0;
	for (const chunk of iterateChunksByKB(db, kb.id)) {
		throwIfAborted(signal);
		if (!latestIndexedByFile.has(chunk.file_path)) {
			indexedPathBytes += Buffer.byteLength(chunk.file_path);
			if (
				latestIndexedByFile.size >= MAX_DIAGNOSTIC_WORKING_PATHS ||
				indexedPathBytes > MAX_DIAGNOSTIC_WORKING_PATH_BYTES
			) {
				result.scan_error = "Diagnostic indexed path working-set limit exceeded";
				result.orphan_files_truncated = true;
				result.stale_files_truncated = true;
				return result;
			}
		}
		const currentLatest = latestIndexedByFile.get(chunk.file_path) ?? 0;
		if (chunk.indexed_at > currentLatest) latestIndexedByFile.set(chunk.file_path, chunk.indexed_at);
		processed++;
		if (processed % DIAGNOSTIC_YIELD_ITEMS === 0) await yieldToEventLoop();
	}
	let remainingDiagnosticPaths = maxDiagnosticPaths;
	for (const filePath of latestIndexedByFile.keys()) {
		throwIfAborted(signal);
		if (!currentFiles.has(filePath)) {
			result.orphan_file_count = (result.orphan_file_count ?? 0) + 1;
			if (remainingDiagnosticPaths > 0) {
				result.orphan_files.push(filePath);
				remainingDiagnosticPaths--;
			} else result.orphan_files_truncated = true;
		}
	}
	processed = 0;
	for (const relPath of currentFiles) {
		throwIfAborted(signal);
		const absPath = isDirectory ? join(kb.source_path, relPath) : relPath;
		try {
			const mtime = (await statFile(absPath)).mtimeMs;
			const latestIndexed = latestIndexedByFile.get(relPath);
			if (latestIndexed !== undefined && mtime > latestIndexed) {
				result.stale_file_count = (result.stale_file_count ?? 0) + 1;
				if (remainingDiagnosticPaths > 0) {
					result.stale_files.push(relPath);
					remainingDiagnosticPaths--;
				} else result.stale_files_truncated = true;
			}
		} catch {
			/* file unreadable — skip */
		}
		processed++;
		if (processed % DIAGNOSTIC_YIELD_ITEMS === 0) await yieldToEventLoop();
	}
	return result;
}
