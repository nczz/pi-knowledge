import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { type DiagnosticResult, diagnoseKB } from "./diagnostics/health.ts";
import {
	dispose as disposeEmbedding,
	embedDocuments,
	embedQuery,
	prepareForShutdown as prepareEmbeddingForShutdown,
} from "./embedding/provider.ts";
import { openVectorReader, openVectorWriter } from "./embedding/vectors.ts";
import {
	buildChunkEmbeddingText,
	chunkFile,
	chunkIdentityHash,
	createSkippedScanStats,
	isReadableTextFile,
	iterateScannableFiles,
	iterateScannedFiles,
	preTokenizeForFTS,
	type ScanOptions,
	summarizeSkippedScan,
} from "./indexer/chunker.ts";
import { shutdownModelWorker } from "./model-worker-client.ts";
import { searchBM25 } from "./search/bm25.ts";
import { weightedScoreFusion } from "./search/fusion.ts";
import { normalizedQueryText, tokenizeForSearch } from "./search/query.ts";
import {
	hasAnyLexicalEvidence,
	hasEnoughLexicalEvidence,
	MIN_HYBRID_SCORE,
	normalizeFileTypeFilter,
	queryCoverage,
	type RankingDiagnostics,
	scoreChunkForQuery,
} from "./search/ranking.ts";
import { disposeReranker, prepareRerankerForShutdown, rerank } from "./search/reranker.ts";
import { searchVectorFile } from "./search/vector.ts";
import {
	type Chunk,
	createKB,
	deleteChunksByIds,
	deleteKB,
	finishIndexingJob,
	getChunkById,
	getChunkCount,
	getChunksByFile,
	getChunksByKB,
	getFileCount,
	getKB,
	getKBByName,
	insertChunks,
	iterateChunkIdsByKB,
	iterateChunksByKB,
	type KnowledgeBase,
	listKBs,
	openDatabase,
	startIndexingJob,
	updateIndexingJob,
	updateKBCounts,
	updateKBStatus,
} from "./storage/sqlite.ts";

export interface SearchOptions {
	mode?: "auto" | "fast" | "semantic" | "hybrid" | "deep" | "adaptive";
	limit?: number;
	offset?: number;
	kb_id?: string;
	filters?: { file_type?: string; path_pattern?: string };
	diversity?: "off" | "balanced" | "strong";
}

export interface SearchResult {
	content: string;
	file_path: string;
	file_type: string;
	kb_name: string;
	score: number;
	snippet: string;
	start_line: number;
	end_line: number;
	ranking?: RankingDiagnostics;
}

export const CURRENT_EMBEDDING_MODEL = "multilingual-e5-small";

export interface SearchResponse {
	results: SearchResult[];
	total_count: number;
	has_more: boolean;
	warnings?: string[];
	mode_used?: NonNullable<SearchOptions["mode"]>;
	retry_modes?: NonNullable<SearchOptions["mode"]>[];
	suggestions?: string[];
}

export type ProgressCallback = (msg: string) => void;

export interface AddOptions {
	include_suggested_text?: boolean;
	include_paths?: string[];
	exclude_paths?: string[];
}

interface ImportedChunk {
	content: string;
	file_path: string;
	file_type: string;
	start_line: number;
	end_line: number;
	metadata_json?: string;
}

interface RankedChunk {
	chunk: Chunk;
	kbName: string;
	ranking?: RankingDiagnostics;
	score: number;
	content: string;
	snippet: string;
	startLine: number;
	endLine: number;
	sourceChunkIds: string[];
}

export interface DoctorIssue {
	severity: "blocking" | "warning" | "info";
	kb_name?: string;
	message: string;
	action: string;
}

export interface DoctorReport {
	health_score: number;
	summary: string;
	issues: DoctorIssue[];
	diagnostics: DiagnosticResult[];
}

const ADAPTIVE_CONTEXT_LINES = 80;
const ADAPTIVE_MAX_CONTEXT_CHARS = 6_000;
const ADAPTIVE_NEIGHBOR_TARGET = 5;
const INDEX_EMBED_BATCH_SIZE = 64;
const VECTOR_REDUNDANCY_WEIGHT = 0.35;

interface DirectoryScanPlan {
	files: number;
	bytes: number;
	skippedTotal: number;
	skippedSummary: string;
	skipped: ReturnType<typeof createSkippedScanStats>;
}

export interface IndexPlan {
	source_type: "file" | "directory" | "text" | "url";
	scannable_files: number;
	scannable_bytes: number;
	skipped: ReturnType<typeof createSkippedScanStats>;
	summary: string;
}

function isCancellationError(error: unknown): boolean {
	return error instanceof Error && error.message === "Cancelled";
}

function tempVectorPath(vectorPath: string): string {
	return `${vectorPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function toScanOptions(options: AddOptions = {}): ScanOptions {
	return {
		includeSuggestedText: options.include_suggested_text === true,
		includePaths: options.include_paths,
		excludePaths: options.exclude_paths,
	};
}

function serializeAddOptions(options: AddOptions = {}): string | undefined {
	const normalized: AddOptions = {};
	if (options.include_suggested_text === true) normalized.include_suggested_text = true;
	if (options.include_paths && options.include_paths.length > 0) normalized.include_paths = options.include_paths;
	if (options.exclude_paths && options.exclude_paths.length > 0) normalized.exclude_paths = options.exclude_paths;
	return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : undefined;
}

function parseAddOptions(raw: string | null): AddOptions {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as AddOptions;
		return {
			include_suggested_text: parsed.include_suggested_text === true,
			include_paths: Array.isArray(parsed.include_paths)
				? parsed.include_paths.filter((item) => typeof item === "string")
				: undefined,
			exclude_paths: Array.isArray(parsed.exclude_paths)
				? parsed.exclude_paths.filter((item) => typeof item === "string")
				: undefined,
		};
	} catch {
		return {};
	}
}

function planDirectoryScan(dirPath: string, options: ScanOptions = {}): DirectoryScanPlan {
	const skipped = createSkippedScanStats();
	let files = 0;
	let bytes = 0;
	for (const file of iterateScannableFiles(dirPath, skipped, options)) {
		files++;
		bytes += file.size;
	}
	return {
		files,
		bytes,
		skippedTotal: skipped.total,
		skippedSummary: summarizeSkippedScan(skipped),
		skipped,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1)} MB`;
	return `${(mb / 1024).toFixed(2)} GB`;
}

function cosineSimilarity(a: Float32Array | undefined, b: Float32Array | undefined): number {
	if (!a || !b || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

function tokenizeForSimilarity(text: string): Set<string> {
	return tokenizeForSearch(text);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}

function lineProximity(a: RankedChunk, b: RankedChunk): number {
	if (a.chunk.file_path !== b.chunk.file_path || a.chunk.kb_id !== b.chunk.kb_id) return 0;
	if (a.sourceChunkIds.some((id) => b.sourceChunkIds.includes(id))) return 1;
	const overlap = Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
	if (overlap > 0) return 1;
	const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
	if (gap <= 20) return 0.8;
	if (gap <= 80) return 0.45;
	return 0.2;
}

function normalizeScores(candidates: RankedChunk[]): Map<string, number> {
	const scores = candidates.map((candidate) => candidate.score);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	const normalized = new Map<string, number>();
	for (const candidate of candidates) {
		const value = max === min ? 1 : (candidate.score - min) / (max - min);
		normalized.set(candidate.chunk.id, value);
	}
	return normalized;
}

function diversifyRankedChunks(
	candidates: RankedChunk[],
	diversity: SearchOptions["diversity"],
	vectorsByChunkId: Map<string, Float32Array> = new Map(),
): RankedChunk[] {
	if (diversity === "off" || candidates.length <= 2) return candidates;
	const lambda = diversity === "strong" ? 0.62 : 0.76;
	const normalized = normalizeScores(candidates);
	const tokenSets = new Map(
		candidates.map((candidate) => [candidate.chunk.id, tokenizeForSimilarity(candidate.content)]),
	);
	const selected: RankedChunk[] = [];
	const remaining = [...candidates];

	while (remaining.length > 0) {
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			let redundancy = 0;
			for (const chosen of selected) {
				const lexical = jaccardSimilarity(
					tokenSets.get(candidate.chunk.id) ?? new Set<string>(),
					tokenSets.get(chosen.chunk.id) ?? new Set<string>(),
				);
				const vector = Math.max(
					0,
					cosineSimilarity(vectorsByChunkId.get(candidate.chunk.id), vectorsByChunkId.get(chosen.chunk.id)),
				);
				redundancy = Math.max(
					redundancy,
					Math.max(lexical, lineProximity(candidate, chosen), vector * VECTOR_REDUNDANCY_WEIGHT),
				);
			}
			const relevance = normalized.get(candidate.chunk.id) ?? 0;
			const mmrScore = lambda * relevance - (1 - lambda) * redundancy;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIndex = i;
			}
		}
		selected.push(remaining.splice(bestIndex, 1)[0]);
	}

	return selected;
}

function interleaveByFile(candidates: RankedChunk[], diversity: SearchOptions["diversity"]): RankedChunk[] {
	if (diversity === "off" || candidates.length <= 2) return candidates;
	const buckets = new Map<string, RankedChunk[]>();
	const fileOrder: string[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.chunk.kb_id}:${candidate.chunk.file_path}`;
		if (!buckets.has(key)) {
			buckets.set(key, []);
			fileOrder.push(key);
		}
		buckets.get(key)?.push(candidate);
	}
	if (fileOrder.length <= 1) return candidates;

	const result: RankedChunk[] = [];
	let round = 0;
	while (result.length < candidates.length) {
		let added = false;
		for (const key of fileOrder) {
			const bucket = buckets.get(key);
			const item = bucket?.[round];
			if (!item) continue;
			result.push(item);
			added = true;
		}
		if (!added) break;
		round++;
	}
	return result;
}

function buildQuerySnippet(content: string, query: string, maxLength = 240): string {
	const terms = [...tokenizeForSimilarity(query)].sort((a, b) => b.length - a.length);
	const lower = content.toLowerCase();
	let matchIndex = -1;
	for (const term of terms) {
		matchIndex = lower.indexOf(term.toLowerCase());
		if (matchIndex >= 0) break;
	}
	if (matchIndex < 0) return content.slice(0, maxLength);
	const half = Math.floor(maxLength / 2);
	const start = Math.max(0, matchIndex - half);
	const end = Math.min(content.length, start + maxLength);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < content.length ? "..." : "";
	return `${prefix}${content.slice(start, end)}${suffix}`;
}

function buildAdaptiveContext(
	seed: Chunk,
	chunks: Chunk[],
	queryTokens: Set<string>,
): {
	content: string;
	startLine: number;
	endLine: number;
	sourceChunkIds: string[];
} {
	const scored = chunks
		.map((chunk) => {
			const distance =
				chunk.id === seed.id
					? 0
					: Math.min(Math.abs(chunk.start_line - seed.start_line), Math.abs(chunk.end_line - seed.end_line));
			const proximity = 1 / (1 + distance / 20);
			const coverage = queryCoverage(chunk.content, queryTokens);
			const seedBoost = chunk.id === seed.id ? 2 : 0;
			return { chunk, score: seedBoost + proximity + coverage };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, ADAPTIVE_NEIGHBOR_TARGET);
	if (!scored.some((item) => item.chunk.id === seed.id)) scored.push({ chunk: seed, score: Number.MAX_SAFE_INTEGER });

	const selectedIds = new Set(scored.map((item) => item.chunk.id));
	const ordered = chunks
		.filter((chunk) => selectedIds.has(chunk.id))
		.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
	const parts: string[] = [];
	const sourceChunkIds: string[] = [];
	let totalLength = 0;
	for (const chunk of ordered) {
		if (totalLength >= ADAPTIVE_MAX_CONTEXT_CHARS) break;
		const remaining = ADAPTIVE_MAX_CONTEXT_CHARS - totalLength;
		const text = chunk.content.slice(0, remaining);
		parts.push(text);
		sourceChunkIds.push(chunk.id);
		totalLength += text.length + 2;
	}
	return {
		content: parts.join("\n\n"),
		startLine: Math.min(...ordered.map((chunk) => chunk.start_line)),
		endLine: Math.max(...ordered.map((chunk) => chunk.end_line)),
		sourceChunkIds,
	};
}

function pushAdaptiveCandidate(candidates: RankedChunk[], candidate: RankedChunk): void {
	const overlappingIndex = candidates.findIndex(
		(existing) =>
			existing.chunk.kb_id === candidate.chunk.kb_id &&
			existing.chunk.file_path === candidate.chunk.file_path &&
			existing.sourceChunkIds.some((id) => candidate.sourceChunkIds.includes(id)),
	);
	if (overlappingIndex < 0) {
		candidates.push(candidate);
		return;
	}
	const existing = candidates[overlappingIndex];
	if (candidate.score > existing.score || candidate.sourceChunkIds.length > existing.sourceChunkIds.length) {
		candidates[overlappingIndex] = candidate;
	}
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function isExactLookupQuery(query: string): boolean {
	const trimmed = query.trim();
	if (/["'`]/.test(trimmed)) return true;
	if (/[./\\][\w.-]+/.test(trimmed)) return true;
	if (/\b[A-Z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/.test(trimmed)) return true;
	if (/\b[A-Z]{2,}[_-]?[A-Z0-9]*\b/.test(trimmed)) return true;
	if (/\b[a-zA-Z_][\w-]*\.(ts|tsx|js|jsx|go|rs|py|java|md|json|ya?ml|toml)\b/.test(trimmed)) return true;
	if (/\b[A-Z]+-\d+\b/.test(trimmed)) return true;
	return false;
}

function chooseAutoMode(query: string): NonNullable<SearchOptions["mode"]> {
	const normalized = query.trim();
	if (isExactLookupQuery(normalized)) return "fast";
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;
	if (wordCount >= 10 || /how|why|explain|concept|architecture|design|流程|架構|概念|為什麼|如何/i.test(normalized)) {
		return "semantic";
	}
	return "hybrid";
}

function fallbackModesFor(mode: NonNullable<SearchOptions["mode"]>): NonNullable<SearchOptions["mode"]>[] {
	if (mode === "fast") return ["hybrid", "semantic"];
	if (mode === "semantic") return ["hybrid", "adaptive"];
	if (mode === "adaptive") return ["hybrid", "deep"];
	if (mode === "deep") return ["hybrid", "adaptive"];
	return ["fast", "semantic", "adaptive"];
}

function isWeakAutoResponse(
	query: string,
	response: SearchResponse,
	primaryMode: NonNullable<SearchOptions["mode"]>,
	attemptMode: NonNullable<SearchOptions["mode"]>,
): boolean {
	if (response.results.length === 0) return true;
	if (primaryMode === "fast") {
		const exactNeedle = query
			.trim()
			.replace(/^["'`]|["'`]$/g, "")
			.toLowerCase();
		const hasExactHit = response.results.some(
			(result) =>
				result.file_path.toLowerCase().includes(exactNeedle) || result.content.toLowerCase().includes(exactNeedle),
		);
		if (!hasExactHit && response.results.every((result) => (result.ranking?.coverage ?? 0) < 0.67)) return true;
	}
	if (primaryMode !== "semantic" && attemptMode === "semantic") {
		return response.results.every((result) => (result.ranking?.coverage ?? 0) === 0);
	}
	return false;
}

async function chunkUrl(source: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof chunkFile>>> {
	const res = await fetch(source, { signal });
	if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
	const html = await res.text();
	const text = html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&[a-z]+;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return chunkFile(text, source);
}

function normalizeExtractedText(text: string | string[]): string {
	return Array.isArray(text) ? text.join("\n\n") : text;
}

export class KnowledgeEngine {
	private db: Database.Database | null = null;
	private knowledgeDir: string = "";

	async initialize(knowledgeDir: string): Promise<void> {
		this.knowledgeDir = knowledgeDir;
		this.db = openDatabase(knowledgeDir);
	}

	plan(source: string, options: AddOptions = {}): IndexPlan {
		const resolvedSource = resolve(source);
		const isUrl = source.startsWith("http://") || source.startsWith("https://");
		const isDir = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isDirectory();
		const isFile = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isFile();
		const sourceType = isUrl ? "url" : isDir ? "directory" : isFile ? "file" : "text";
		if (isDir) {
			const plan = planDirectoryScan(resolvedSource, toScanOptions(options));
			return {
				source_type: "directory",
				scannable_files: plan.files,
				scannable_bytes: plan.bytes,
				skipped: plan.skipped,
				summary: `Directory plan: ${plan.files} scannable files, ${formatBytes(plan.bytes)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`,
			};
		}
		if (isFile) {
			const skipped = createSkippedScanStats();
			const supportedDocument =
				resolvedSource.endsWith(".pdf") || resolvedSource.endsWith(".docx") || resolvedSource.endsWith(".doc");
			if (!supportedDocument && !isReadableTextFile(resolvedSource)) {
				skipped.total = 1;
				skipped.by_reason.binary = 1;
				skipped.samples.push({ path: resolvedSource, reason: "binary" });
				return {
					source_type: "file",
					scannable_files: 0,
					scannable_bytes: 0,
					skipped,
					summary: "File plan: 0 scannable files; file is unsupported binary/non-text",
				};
			}
			const size = statSync(resolvedSource).size;
			return {
				source_type: "file",
				scannable_files: 1,
				scannable_bytes: size,
				skipped,
				summary: `File plan: 1 scannable file, ${formatBytes(size)} source size`,
			};
		}
		const skipped = createSkippedScanStats();
		return {
			source_type: sourceType,
			scannable_files: 1,
			scannable_bytes: Buffer.byteLength(source),
			skipped,
			summary: `${sourceType === "url" ? "URL" : "Inline text"} plan: 1 source`,
		};
	}

	async add(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		options: AddOptions = {},
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const db = this.db;
		const resolvedSource = resolve(source);
		const isUrl = source.startsWith("http://") || source.startsWith("https://");
		const isDir = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isDirectory();
		const isFile = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isFile();
		const sourceType = isUrl ? "url" : isDir ? "directory" : isFile ? "file" : "text";
		const scanOptions = toScanOptions(options);

		const existingKB = getKBByName(db, name);
		if (existingKB) {
			throw new Error(
				`Knowledge base "${name}" already exists. Use knowledge_update to refresh it, or knowledge_remove before adding a replacement.`,
			);
		}

		const kb = createKB(db, {
			name,
			source_path: isDir || isFile ? resolvedSource : isUrl ? source : undefined,
			source_type: sourceType,
			source_options: serializeAddOptions(options),
		});
		updateKBStatus(db, kb.id, "indexing");
		startIndexingJob(db, kb.id, "add", `Starting indexing for "${name}"`);

		let vectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		let tempVectorFile: string | undefined;
		try {
			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			tempVectorFile = tempVectorPath(vectorPath);
			const writer = openVectorWriter(tempVectorFile);
			vectorWriter = writer;
			let chunkCount = 0;
			let fileCount = 0;
			const pendingChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			const startedAt = Date.now();
			let latestSkippedTotal = 0;

			const reportProgress = (phase: string, processedFiles?: number, totalFiles?: number, skippedTotal = 0): void => {
				latestSkippedTotal = skippedTotal;
				const elapsed = Date.now() - startedAt;
				const chunkRate = chunkCount / Math.max(1, elapsed / 1000);
				let suffix = `${chunkCount} chunks, ${chunkRate.toFixed(1)} chunks/s, elapsed ${formatDuration(elapsed)}`;
				if (processedFiles !== undefined && totalFiles !== undefined && totalFiles > 0) {
					const rate = processedFiles / Math.max(1, elapsed / 1000);
					const remainingFiles = Math.max(0, totalFiles - processedFiles);
					const etaMs = rate > 0 ? (remainingFiles / rate) * 1000 : 0;
					suffix = `${processedFiles}/${totalFiles} files, ${suffix}, file ETA ${formatDuration(etaMs)}`;
				} else if (processedFiles !== undefined) {
					suffix = `${processedFiles} files scanned, ${suffix}`;
				}
				if (skippedTotal > 0) suffix = `${suffix}, skipped ${skippedTotal}`;
				const message = `${phase}: ${suffix}`;
				updateIndexingJob(db, kb.id, {
					phase,
					message,
					processed_files: processedFiles,
					processed_chunks: chunkCount,
					total_files: totalFiles,
					skipped_total: skippedTotal,
					added_chunks: chunkCount,
				});
				onProgress?.(message);
			};

			const flushPending = async (processedFiles?: number, totalFiles?: number): Promise<void> => {
				if (pendingChunks.length === 0) return;
				if (signal?.aborted) throw new Error("Cancelled");
				const batch = pendingChunks.splice(0, INDEX_EMBED_BATCH_SIZE);
				reportProgress(`Embedding batch of ${batch.length}`, processedFiles, totalFiles);
				const vectors = await embedDocuments(
					batch.map((chunk) => buildChunkEmbeddingText(chunk)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				insertChunks(db, kb.id, batch);
				writer.append(vectors);
				chunkCount += batch.length;
				updateKBCounts(db, kb.id, chunkCount, fileCount);
				reportProgress("Stored batch", processedFiles, totalFiles);
			};

			const addChunks = async (
				chunks: Awaited<ReturnType<typeof chunkFile>>,
				processedFiles?: number,
				totalFiles?: number,
			): Promise<void> => {
				pendingChunks.push(...chunks);
				while (pendingChunks.length >= INDEX_EMBED_BATCH_SIZE) {
					await flushPending(processedFiles, totalFiles);
				}
			};

			if (isUrl) {
				const message = `Fetching ${source}...`;
				updateIndexingJob(this.db, kb.id, { phase: "fetching", message });
				onProgress?.(message);
				const chunks = await chunkUrl(source, signal);
				fileCount = 1;
				await addChunks(chunks);
			} else if (isFile && resolvedSource.endsWith(".pdf")) {
				updateIndexingJob(this.db, kb.id, { phase: "extracting", message: "Extracting text from PDF..." });
				onProgress?.("Extracting text from PDF...");
				const { extractText } = await import("unpdf");
				const buf = (await import("node:fs")).readFileSync(resolvedSource);
				const { text } = await extractText(new Uint8Array(buf));
				fileCount = 1;
				await addChunks(await chunkFile(normalizeExtractedText(text), resolvedSource));
			} else if (isFile && (resolvedSource.endsWith(".docx") || resolvedSource.endsWith(".doc"))) {
				updateIndexingJob(this.db, kb.id, { phase: "extracting", message: "Extracting text from DOCX..." });
				onProgress?.("Extracting text from DOCX...");
				const mammoth = await import("mammoth");
				const result = await mammoth.extractRawText({ path: resolvedSource });
				fileCount = 1;
				await addChunks(await chunkFile(result.value, resolvedSource));
			} else if (isDir) {
				const plan = planDirectoryScan(resolvedSource, scanOptions);
				const planningMessage = `Planned directory scan: ${plan.files} files, ${formatBytes(
					plan.bytes,
				)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`;
				updateIndexingJob(this.db, kb.id, {
					phase: "planning",
					message: planningMessage,
					total_files: plan.files,
					skipped_total: plan.skippedTotal,
				});
				onProgress?.(planningMessage);
				const scanningMessage = `Scanning ${resolvedSource}...`;
				updateIndexingJob(this.db, kb.id, {
					phase: "scanning",
					message: scanningMessage,
					total_files: plan.files,
					skipped_total: plan.skippedTotal,
				});
				onProgress?.(scanningMessage);
				const skipped = createSkippedScanStats();
				let processedFiles = 0;
				for (const file of iterateScannedFiles(resolvedSource, skipped, scanOptions)) {
					if (signal?.aborted) throw new Error("Cancelled");
					const chunks = await chunkFile(file.content, file.relPath);
					processedFiles++;
					latestSkippedTotal = skipped.total;
					if (chunks.length > 0) fileCount++;
					await addChunks(chunks, processedFiles, plan.files);
					if (processedFiles % 25 === 0) reportProgress("Chunking", processedFiles, plan.files, skipped.total);
				}
				const finalizingMessage = `Scanned ${processedFiles} files, skipped ${skipped.total} (${summarizeSkippedScan(
					skipped,
				)}), finalizing...`;
				updateIndexingJob(this.db, kb.id, {
					phase: "finalizing",
					message: finalizingMessage,
					processed_files: processedFiles,
					processed_chunks: chunkCount,
					total_files: plan.files,
					skipped_total: skipped.total,
					added_chunks: chunkCount,
				});
				onProgress?.(finalizingMessage);
			} else if (isFile) {
				if (!isReadableTextFile(resolvedSource)) {
					throw new Error(`File is not readable text and has no supported extractor: ${resolvedSource}`);
				}
				const { readFileSync } = await import("node:fs");
				const content = readFileSync(resolvedSource, "utf-8");
				fileCount = 1;
				await addChunks(await chunkFile(content, resolvedSource));
			} else {
				fileCount = 1;
				await addChunks(await chunkFile(source, "inline-text"));
			}

			await flushPending();
			vectorWriter.close();
			vectorWriter = undefined;
			renameSync(tempVectorFile, vectorPath);
			tempVectorFile = undefined;

			const savedFileCount = isDir ? getFileCount(this.db, kb.id) : fileCount;
			updateKBCounts(this.db, kb.id, chunkCount, savedFileCount);
			updateKBStatus(this.db, kb.id, "ready");

			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after add: ${kb.id}`);
			const readyMessage = `Ready: ${chunkCount} chunks from ${savedFileCount} files in ${formatDuration(
				Date.now() - startedAt,
			)}`;
			updateIndexingJob(this.db, kb.id, {
				phase: "ready",
				message: readyMessage,
				processed_files: savedFileCount,
				processed_chunks: chunkCount,
				skipped_total: latestSkippedTotal,
				added_chunks: chunkCount,
			});
			finishIndexingJob(this.db, kb.id, "succeeded", readyMessage);
			onProgress?.(readyMessage);
			return { kb: savedKB, chunkCount };
		} catch (e) {
			vectorWriter?.close();
			if (tempVectorFile) rmSync(tempVectorFile, { force: true });
			if (this.db) {
				finishIndexingJob(
					this.db,
					kb.id,
					isCancellationError(e) ? "cancelled" : "failed",
					isCancellationError(e) ? "Indexing cancelled." : "Indexing failed.",
					e instanceof Error ? e.message : String(e),
				);
			}
			// Clean up partial state on failure
			deleteKB(this.db, kb.id);
			throw e;
		}
	}

	async update(
		nameOrId: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ added: number; removed: number; unchanged: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		if (!kb.source_path || (kb.source_type !== "url" && !existsSync(kb.source_path))) {
			throw new Error(`Source path not available or missing: ${kb.source_path}`);
		}

		updateKBStatus(this.db, kb.id, "indexing");
		startIndexingJob(this.db, kb.id, "update", `Starting update for "${kb.name}"`);
		const scanOptions = toScanOptions(parseAddOptions(kb.source_options));
		let replacementVectorPath: string | undefined;
		let addedVectorPath: string | undefined;
		let addedVectorWriter: ReturnType<typeof openVectorWriter> | undefined;

		try {
			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			addedVectorPath = tempVectorPath(`${vectorPath}.added`);
			addedVectorWriter = openVectorWriter(addedVectorPath);
			const existingHashes = new Map<string, Array<{ id: string; vectorIndex: number }>>();
			let existingIndex = 0;
			for (const chunk of iterateChunksByKB(this.db, kb.id)) {
				const entries = existingHashes.get(chunk.content_hash) ?? [];
				entries.push({ id: chunk.id, vectorIndex: existingIndex });
				existingHashes.set(chunk.content_hash, entries);
				existingIndex++;
			}

			const oldVectorIndexByHash = new Map<string, number[]>();
			const newVectorIndexByHash = new Map<string, number[]>();
			const pendingChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			let addedVectorCount = 0;
			let addedCount = 0;
			let unchanged = 0;
			let scannedFiles = 0;
			let scannedChunks = 0;
			let plannedTotalFiles: number | undefined;
			const startedAt = Date.now();

			const flushPending = async (): Promise<void> => {
				if (!this.db || !addedVectorWriter || pendingChunks.length === 0) return;
				if (signal?.aborted) throw new Error("Cancelled");
				const batch = pendingChunks.splice(0, INDEX_EMBED_BATCH_SIZE);
				const elapsed = Date.now() - startedAt;
				const message = `Embedding update batch: ${addedCount} new chunks stored, ${scannedFiles} files scanned, elapsed ${formatDuration(
					elapsed,
				)}`;
				updateIndexingJob(this.db, kb.id, {
					phase: "embedding",
					message,
					processed_files: scannedFiles,
					processed_chunks: scannedChunks,
					total_files: plannedTotalFiles,
					added_chunks: addedCount,
					unchanged_chunks: unchanged,
				});
				onProgress?.(message);
				const newVectors = await embedDocuments(
					batch.map((c) => buildChunkEmbeddingText(c)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				addedVectorWriter.append(newVectors);
				for (let i = 0; i < batch.length; i++) {
					const indexes = newVectorIndexByHash.get(batch[i].content_hash) ?? [];
					indexes.push(addedVectorCount + i);
					newVectorIndexByHash.set(batch[i].content_hash, indexes);
				}
				addedVectorCount += newVectors.length;
				insertChunks(this.db, kb.id, batch);
				addedCount += batch.length;
				updateKBCounts(this.db, kb.id, getChunkCount(this.db, kb.id), getFileCount(this.db, kb.id));
				const storedMessage = `Stored update batch: +${addedCount} chunks, =${unchanged} unchanged`;
				updateIndexingJob(this.db, kb.id, {
					phase: "storing",
					message: storedMessage,
					processed_files: scannedFiles,
					processed_chunks: scannedChunks,
					total_files: plannedTotalFiles,
					added_chunks: addedCount,
					unchanged_chunks: unchanged,
				});
				onProgress?.(storedMessage);
			};

			const processChunks = async (chunks: Awaited<ReturnType<typeof chunkFile>>): Promise<void> => {
				for (const chunk of chunks) {
					scannedChunks++;
					const existing = existingHashes.get(chunk.content_hash);
					if (existing && existing.length > 0) {
						const retained = existing.shift();
						if (retained) {
							const indexes = oldVectorIndexByHash.get(chunk.content_hash) ?? [];
							indexes.push(retained.vectorIndex);
							oldVectorIndexByHash.set(chunk.content_hash, indexes);
						}
						unchanged++;
						continue;
					}
					pendingChunks.push(chunk);
					if (pendingChunks.length >= INDEX_EMBED_BATCH_SIZE) await flushPending();
				}
			};

			updateIndexingJob(this.db, kb.id, { phase: "scanning", message: "Scanning source..." });
			onProgress?.("Scanning source...");
			if (kb.source_type === "url") {
				const message = `Fetching ${kb.source_path}...`;
				updateIndexingJob(this.db, kb.id, { phase: "fetching", message });
				onProgress?.(message);
				scannedFiles = 1;
				await processChunks(await chunkUrl(kb.source_path, signal));
			} else if (statSync(kb.source_path).isDirectory()) {
				const plan = planDirectoryScan(kb.source_path, scanOptions);
				plannedTotalFiles = plan.files;
				const planningMessage = `Planned directory scan: ${plan.files} files, ${formatBytes(
					plan.bytes,
				)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`;
				updateIndexingJob(this.db, kb.id, {
					phase: "planning",
					message: planningMessage,
					total_files: plan.files,
					skipped_total: plan.skippedTotal,
				});
				onProgress?.(planningMessage);
				const skipped = createSkippedScanStats();
				for (const file of iterateScannedFiles(kb.source_path, skipped, scanOptions)) {
					if (signal?.aborted) throw new Error("Cancelled");
					scannedFiles++;
					await processChunks(await chunkFile(file.content, file.relPath));
					if (scannedFiles % 25 === 0) {
						const message = `Scanned ${scannedFiles} files, ${scannedChunks} chunks, skipped ${skipped.total}, +${addedCount} =${unchanged}`;
						updateIndexingJob(this.db, kb.id, {
							phase: "scanning",
							message,
							processed_files: scannedFiles,
							processed_chunks: scannedChunks,
							total_files: plan.files,
							skipped_total: skipped.total,
							added_chunks: addedCount,
							unchanged_chunks: unchanged,
						});
						onProgress?.(message);
					}
				}
				const message = `Scanned ${scannedFiles} files, skipped ${skipped.total} (${summarizeSkippedScan(
					skipped,
				)}), reconciling deletes...`;
				updateIndexingJob(this.db, kb.id, {
					phase: "reconciling",
					message,
					processed_files: scannedFiles,
					processed_chunks: scannedChunks,
					total_files: plan.files,
					skipped_total: skipped.total,
					added_chunks: addedCount,
					unchanged_chunks: unchanged,
				});
				onProgress?.(message);
			} else {
				const { readFileSync } = await import("node:fs");
				scannedFiles = 1;
				await processChunks(await chunkFile(readFileSync(kb.source_path, "utf-8"), kb.source_path));
			}
			await flushPending();
			addedVectorWriter.close();
			addedVectorWriter = undefined;

			const idsToRemove: string[] = [];
			for (const entries of existingHashes.values()) {
				idsToRemove.push(...entries.map((entry) => entry.id));
			}
			if (idsToRemove.length > 0) deleteChunksByIds(this.db, idsToRemove);
			const changesMessage = `Changes: +${addedCount} -${idsToRemove.length} =${unchanged}`;
			updateIndexingJob(this.db, kb.id, {
				phase: "reconciling",
				message: changesMessage,
				processed_files: scannedFiles,
				processed_chunks: scannedChunks,
				added_chunks: addedCount,
				removed_chunks: idsToRemove.length,
				unchanged_chunks: unchanged,
			});
			onProgress?.(changesMessage);

			replacementVectorPath = tempVectorPath(vectorPath);
			const vectorWriter = openVectorWriter(replacementVectorPath);
			const oldVectorReader = openVectorReader(vectorPath);
			const newVectorReader = openVectorReader(addedVectorPath);
			let finalChunkCount = 0;
			const takeVectorIndex = (indexesByHash: Map<string, number[]>, hash: string): number | undefined => {
				const indexes = indexesByHash.get(hash);
				return indexes?.shift();
			};
			try {
				for (const chunk of iterateChunksByKB(this.db, kb.id)) {
					const oldVectorIndex = takeVectorIndex(oldVectorIndexByHash, chunk.content_hash);
					const newVectorIndex = takeVectorIndex(newVectorIndexByHash, chunk.content_hash);
					const vector =
						oldVectorReader && oldVectorIndex !== undefined
							? oldVectorReader.read(oldVectorIndex)
							: newVectorReader && newVectorIndex !== undefined
								? newVectorReader.read(newVectorIndex)
								: undefined;
					if (!vector) throw new Error(`Missing vector while rebuilding knowledge base: ${chunk.id}`);
					vectorWriter.append([vector]);
					finalChunkCount++;
					if (finalChunkCount % 1_000 === 0) {
						const message = `Rebuilding vector file: ${finalChunkCount} chunks written`;
						updateIndexingJob(this.db, kb.id, {
							phase: "rebuilding_vectors",
							message,
							processed_files: scannedFiles,
							processed_chunks: finalChunkCount,
							added_chunks: addedCount,
							removed_chunks: idsToRemove.length,
							unchanged_chunks: unchanged,
						});
						onProgress?.(message);
					}
				}
			} finally {
				oldVectorReader?.close();
				newVectorReader?.close();
				vectorWriter.close();
			}
			renameSync(replacementVectorPath, vectorPath);
			replacementVectorPath = undefined;
			if (addedVectorPath) rmSync(addedVectorPath, { force: true });
			addedVectorPath = undefined;

			updateKBCounts(this.db, kb.id, finalChunkCount, getFileCount(this.db, kb.id));
			updateKBStatus(this.db, kb.id, "ready");
			const readyMessage = `Ready: +${addedCount} -${idsToRemove.length} =${unchanged}`;
			updateIndexingJob(this.db, kb.id, {
				phase: "ready",
				message: readyMessage,
				processed_files: scannedFiles,
				processed_chunks: finalChunkCount,
				added_chunks: addedCount,
				removed_chunks: idsToRemove.length,
				unchanged_chunks: unchanged,
			});
			finishIndexingJob(this.db, kb.id, "succeeded", readyMessage);
			onProgress?.(readyMessage);

			return { added: addedCount, removed: idsToRemove.length, unchanged };
		} catch (e) {
			addedVectorWriter?.close();
			if (replacementVectorPath) rmSync(replacementVectorPath, { force: true });
			if (addedVectorPath) rmSync(addedVectorPath, { force: true });
			updateKBStatus(this.db, kb.id, "error");
			finishIndexingJob(
				this.db,
				kb.id,
				isCancellationError(e) ? "cancelled" : "failed",
				isCancellationError(e) ? "Update cancelled." : "Update failed.",
				e instanceof Error ? e.message : String(e),
			);
			throw e;
		}
	}

	async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
		if (!this.db) throw new Error("Engine not initialized");
		const requestedMode = options.mode ?? "hybrid";
		if (requestedMode === "auto") {
			const primaryMode = chooseAutoMode(query);
			const attempts = [primaryMode, ...fallbackModesFor(primaryMode)];
			const tried: NonNullable<SearchOptions["mode"]>[] = [];
			const warnings: string[] = [];
			for (const mode of attempts) {
				if (tried.includes(mode)) continue;
				tried.push(mode);
				const response = await this.search(query, { ...options, mode });
				if (response.warnings) warnings.push(...response.warnings);
				if (!isWeakAutoResponse(query, response, primaryMode, mode)) {
					return {
						...response,
						warnings: warnings.length > 0 ? [...new Set(warnings)] : response.warnings,
						mode_used: mode,
						retry_modes: tried.slice(0, -1),
						suggestions: response.suggestions,
					};
				}
				if (tried.length >= 3) break;
			}
			return {
				results: [],
				total_count: 0,
				has_more: false,
				warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
				mode_used: tried.at(-1),
				retry_modes: tried.slice(0, -1),
				suggestions: [
					"No results after auto mode fallback. Check knowledge_status, try a more exact term, or rebuild the KB if indexing rules changed.",
				],
			};
		}
		const db = this.db;
		const { mode = "hybrid", limit = 10, offset = 0, kb_id, filters, diversity = "balanced" } = options;
		const retrievalMode = mode === "adaptive" ? "hybrid" : mode;
		const candidateLimit = Math.max(50, offset + limit * 12);
		const normalizedQuery = normalizedQueryText(query);
		const queryTokens = tokenizeForSimilarity(query);
		const normalizedFileType = normalizeFileTypeFilter(filters?.file_type);

		const warnings: string[] = [];
		const selectedKB = kb_id ? (getKB(db, kb_id) ?? getKBByName(db, kb_id)) : undefined;
		const availableKBs = kb_id ? ([selectedKB].filter(Boolean) as KnowledgeBase[]) : listKBs(db);
		const kbs = availableKBs.filter((kb) => kb.status === "ready" || kb.status === "stale");
		for (const kb of availableKBs) {
			if (kb.status !== "ready" && kb.status !== "stale") {
				warnings.push(`"${kb.name}" is ${kb.status}; search skipped until indexing is ready`);
			}
		}
		if (kbs.length === 0) {
			return {
				results: [],
				total_count: 0,
				has_more: false,
				warnings: warnings.length > 0 ? warnings : undefined,
				mode_used: mode,
			};
		}

		const allResults: { chunkId: string; score: number }[] = [];
		const vectorsByChunkId = new Map<string, Float32Array>();

		for (const kb of kbs) {
			if (kb.embedding_model !== CURRENT_EMBEDDING_MODEL) {
				warnings.push(
					`"${kb.name}" was indexed with ${kb.embedding_model} (current: ${CURRENT_EMBEDDING_MODEL}) — run knowledge_update for best results`,
				);
			}
			if (kb.chunk_count === 0) continue;
			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);

			if (retrievalMode === "fast") {
				allResults.push(...searchBM25(db, normalizedQuery || query, candidateLimit, kb.id, { allowOrFallback: false }));
			} else if (retrievalMode === "semantic") {
				const queryVec = await embedQuery(query);
				const vectorResults = searchVectorFile(queryVec, vectorPath, iterateChunkIdsByKB(db, kb.id), candidateLimit);
				allResults.push(...vectorResults.results);
				for (const [chunkId, vector] of vectorResults.vectorsByChunkId) vectorsByChunkId.set(chunkId, vector);
			} else {
				// hybrid: BM25 + vector weighted fusion (both scoped to this KB)
				const bm25Results = searchBM25(db, normalizedQuery || query, candidateLimit, kb.id);
				if (bm25Results.length === 0) continue;

				let vecResults: { chunkId: string; score: number }[] = [];
				const queryVec = await embedQuery(query);
				const vectorResults = searchVectorFile(queryVec, vectorPath, iterateChunkIdsByKB(db, kb.id), candidateLimit);
				vecResults = vectorResults.results;
				for (const [chunkId, vector] of vectorResults.vectorsByChunkId) vectorsByChunkId.set(chunkId, vector);
				const fused = weightedScoreFusion(bm25Results, vecResults);
				allResults.push(...fused);
			}
		}

		// Deduplicate and sort
		const seen = new Set<string>();
		const unique = allResults.filter((r) => {
			if (seen.has(r.chunkId)) return false;
			seen.add(r.chunkId);
			return true;
		});
		const rankingByChunkId = new Map<string, RankingDiagnostics>();
		for (const result of unique) {
			const chunk = getChunkById(db, result.chunkId);
			if (chunk) {
				const ranking = scoreChunkForQuery(result.score, chunk, queryTokens);
				rankingByChunkId.set(result.chunkId, ranking);
				result.score = ranking.adjusted_score;
			}
		}
		let scored = unique;
		if (retrievalMode === "fast") {
			scored = unique.filter((result) => {
				const chunk = getChunkById(db, result.chunkId);
				if (!chunk) return false;
				return hasAnyLexicalEvidence(buildChunkEmbeddingText(chunk), queryTokens);
			});
		} else if (retrievalMode !== "semantic") {
			scored = unique.filter((result) => {
				const chunk = getChunkById(db, result.chunkId);
				if (!chunk) return false;
				return result.score >= MIN_HYBRID_SCORE && hasEnoughLexicalEvidence(chunk, queryTokens);
			});
		}
		scored.sort((a, b) => b.score - a.score);

		// Apply metadata filters post-retrieval
		let filtered = scored;
		if (normalizedFileType || filters?.path_pattern) {
			filtered = scored.filter((r) => {
				const chunk = getChunkById(db, r.chunkId);
				if (!chunk) return false;
				if (normalizedFileType && chunk.file_type !== normalizedFileType) return false;
				if (filters?.path_pattern && !chunk.file_path.includes(filters.path_pattern)) return false;
				return true;
			});
		}

		if (mode === "deep" && filtered.length > 0) {
			const candidates = filtered
				.slice(0, 30)
				.map((r) => {
					const chunk = getChunkById(db, r.chunkId);
					return chunk ? { chunkId: r.chunkId, content: chunk.content } : null;
				})
				.filter(Boolean) as Array<{ chunkId: string; content: string }>;
			const reranked = await rerank(query, candidates, Math.max(limit * 3, limit));
			const ranked: RankedChunk[] = [];
			for (const r of reranked) {
				const chunk = getChunkById(db, r.chunkId);
				if (!chunk) continue;
				const kbObj = getKB(db, chunk.kb_id);
				ranked.push({
					chunk,
					kbName: kbObj?.name ?? "unknown",
					ranking: scoreChunkForQuery(r.score, chunk, queryTokens),
					score: r.score,
					content: chunk.content,
					snippet: buildQuerySnippet(chunk.content, query),
					startLine: chunk.start_line,
					endLine: chunk.end_line,
					sourceChunkIds: [chunk.id],
				});
			}
			const diversified = interleaveByFile(diversifyRankedChunks(ranked, diversity, vectorsByChunkId), diversity);
			const page = diversified.slice(offset, offset + limit);
			const results = page.map((r) => ({
				content: r.content,
				file_path: r.chunk.file_path,
				file_type: r.chunk.file_type,
				kb_name: r.kbName,
				score: r.score,
				ranking: r.ranking,
				snippet: r.snippet,
				start_line: r.startLine,
				end_line: r.endLine,
			}));
			return {
				results,
				total_count: diversified.length,
				has_more: offset + limit < diversified.length,
				warnings: warnings.length > 0 ? warnings : undefined,
				mode_used: mode,
			};
		}

		const ranked: RankedChunk[] = [];
		for (const r of filtered) {
			const chunk = getChunkById(db, r.chunkId);
			if (!chunk) continue;
			const kb = getKB(db, chunk.kb_id);

			if (mode === "adaptive") {
				const contextChunks = getChunksByFile(
					db,
					chunk.kb_id,
					chunk.file_path,
					Math.max(1, chunk.start_line - ADAPTIVE_CONTEXT_LINES),
					chunk.end_line + ADAPTIVE_CONTEXT_LINES,
				);
				const context = buildAdaptiveContext(chunk, contextChunks.length > 0 ? contextChunks : [chunk], queryTokens);
				pushAdaptiveCandidate(ranked, {
					chunk,
					kbName: kb?.name ?? "unknown",
					ranking: rankingByChunkId.get(r.chunkId),
					score: r.score,
					content: context.content,
					snippet: buildQuerySnippet(context.content, query),
					startLine: context.startLine,
					endLine: context.endLine,
					sourceChunkIds: context.sourceChunkIds,
				});
			} else {
				ranked.push({
					chunk,
					kbName: kb?.name ?? "unknown",
					ranking: rankingByChunkId.get(r.chunkId),
					score: r.score,
					content: chunk.content,
					snippet: buildQuerySnippet(chunk.content, query),
					startLine: chunk.start_line,
					endLine: chunk.end_line,
					sourceChunkIds: [chunk.id],
				});
			}
		}

		const diversified = interleaveByFile(diversifyRankedChunks(ranked, diversity, vectorsByChunkId), diversity);
		const total = diversified.length;
		const page = diversified.slice(offset, offset + limit);
		const results: SearchResult[] = page.map((r) => ({
			content: r.content,
			file_path: r.chunk.file_path,
			file_type: r.chunk.file_type,
			kb_name: r.kbName,
			score: r.score,
			ranking: r.ranking,
			snippet: r.snippet,
			start_line: r.startLine,
			end_line: r.endLine,
		}));

		return {
			results,
			total_count: total,
			has_more: offset + limit < total,
			warnings: warnings.length > 0 ? warnings : undefined,
			mode_used: mode,
			suggestions:
				results.length === 0
					? [
							"Try mode 'fast' for exact symbols or mode 'semantic' for conceptual wording.",
							"Run knowledge_status if the KB should contain this answer.",
						]
					: undefined,
		};
	}

	remove(nameOrId: string): boolean {
		if (!this.db) return false;
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) return false;
		deleteKB(this.db, kb.id);
		return true;
	}

	list(): KnowledgeBase[] {
		if (!this.db) return [];
		return listKBs(this.db);
	}

	clear(): void {
		if (!this.db) return;
		for (const kb of listKBs(this.db)) deleteKB(this.db, kb.id);
	}

	diagnose(): DiagnosticResult[] {
		if (!this.db) return [];
		const db = this.db;
		return listKBs(db).map((kb) => diagnoseKB(db, kb));
	}

	doctor(): DoctorReport {
		const diagnostics = this.diagnose();
		const issues: DoctorIssue[] = [];
		const kbs = this.list();
		if (kbs.length === 0) {
			issues.push({
				severity: "blocking",
				message: "No knowledge bases are indexed.",
				action: "Run knowledge_add for the project root or relevant source/docs directory.",
			});
		}

		for (const diagnostic of diagnostics) {
			if (diagnostic.stuck_indexing) {
				const phase = diagnostic.job ? ` during ${diagnostic.job.phase}` : "";
				issues.push({
					severity: "blocking",
					kb_name: diagnostic.kb_name,
					message: `Indexing appears stuck${phase} for ${formatDuration(diagnostic.last_progress_age_ms)}.`,
					action:
						"Check knowledge_status for the last progress message. If no Pi process is actively indexing it, remove and rebuild this KB.",
				});
			}
			if (diagnostic.status === "error") {
				issues.push({
					severity: "blocking",
					kb_name: diagnostic.kb_name,
					message: "Knowledge base is in error state and is skipped by search.",
					action: "Run knowledge_remove and knowledge_add to rebuild it from the source.",
				});
			}
			if (diagnostic.coverage_percent < 80) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `Coverage is ${diagnostic.coverage_percent}% (${diagnostic.indexed_files}/${diagnostic.total_source_files} files).`,
					action: "Review skipped files and source path. Rebuild if index-time rules changed.",
				});
			}
			if (diagnostic.stale_files.length > 0) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `${diagnostic.stale_files.length} files changed after indexing.`,
					action: "Run knowledge_update for this KB.",
				});
			}
			if (diagnostic.orphan_files.length > 0) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `${diagnostic.orphan_files.length} indexed files no longer exist in the source.`,
					action: "Run knowledge_update or rebuild the KB.",
				});
			}
			if (diagnostic.skipped_files.total > 0) {
				issues.push({
					severity: "info",
					kb_name: diagnostic.kb_name,
					message: `${diagnostic.skipped_files.total} files were skipped while scanning (${Object.entries(
						diagnostic.skipped_files.by_reason,
					)
						.filter(([, count]) => count > 0)
						.map(([reason, count]) => `${reason}: ${count}`)
						.join(", ")}).`,
					action:
						"Use skipped samples to confirm exclusions are expected. Adjust source path or ignore rules if needed.",
				});
			}
		}

		const penalty = issues.reduce((score, issue) => {
			if (issue.severity === "blocking") return score + 35;
			if (issue.severity === "warning") return score + 12;
			return score + 2;
		}, 0);
		const healthScore = Math.max(0, Math.min(100, 100 - penalty));
		const blocking = issues.filter((issue) => issue.severity === "blocking").length;
		const warnings = issues.filter((issue) => issue.severity === "warning").length;
		const summary =
			issues.length === 0
				? "Knowledge system is healthy."
				: `${blocking} blocking, ${warnings} warning, ${issues.length - blocking - warnings} info issues.`;

		return {
			health_score: healthScore,
			summary,
			issues,
			diagnostics,
		};
	}

	async exportKB(nameOrId: string, outputPath: string): Promise<number> {
		if (!this.db) throw new Error("Engine not initialized");
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		const chunks = getChunksByKB(this.db, kb.id);
		const { writeFileSync } = await import("node:fs");
		const header = JSON.stringify({
			name: kb.name,
			description: kb.description,
			source_type: "text",
			chunk_count: chunks.length,
		});
		const lines = [
			header,
			...chunks.map((c) =>
				JSON.stringify({
					content: c.content,
					file_path: c.file_path,
					file_type: c.file_type,
					start_line: c.start_line,
					end_line: c.end_line,
					metadata_json: c.metadata_json,
				}),
			),
		];
		writeFileSync(outputPath, `${lines.join("\n")}\n`);
		return chunks.length;
	}

	async importKB(
		inputPath: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const { readFileSync } = await import("node:fs");
		const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
		if (lines.length < 1) throw new Error("Empty import file");
		const header = JSON.parse(lines[0]) as { name: string; description?: string };
		const kb = createKB(this.db, { name: header.name, description: header.description, source_type: "text" });
		updateKBStatus(this.db, kb.id, "indexing");
		startIndexingJob(this.db, kb.id, "import", `Starting import for "${header.name}"`);
		let vectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		let tempVectorFile: string | undefined;
		try {
			const chunkData = lines.slice(1).map((l) => JSON.parse(l) as ImportedChunk);
			const importMessage = `Importing ${chunkData.length} chunks...`;
			updateIndexingJob(this.db, kb.id, {
				phase: "importing",
				message: importMessage,
				total_files: chunkData.length,
			});
			onProgress?.(importMessage);
			const chunks = chunkData.map((c) => ({
				content_hash: chunkIdentityHash({
					content: c.content,
					filePath: c.file_path,
					fileType: c.file_type,
					startLine: c.start_line,
					endLine: c.end_line,
					metadataJson: c.metadata_json || "{}",
				}),
				content: c.content,
				content_tokenized: "",
				file_path: c.file_path,
				file_type: c.file_type,
				start_line: c.start_line,
				end_line: c.end_line,
				metadata_json: c.metadata_json || "{}",
			}));
			const indexedChunks = chunks.map((chunk) => ({
				...chunk,
				content_tokenized: preTokenizeForFTS(buildChunkEmbeddingText(chunk)),
			}));
			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			tempVectorFile = tempVectorPath(vectorPath);
			vectorWriter = openVectorWriter(tempVectorFile);
			let inserted = 0;
			for (let offset = 0; offset < indexedChunks.length; offset += INDEX_EMBED_BATCH_SIZE) {
				if (signal?.aborted) throw new Error("Cancelled");
				const batch = indexedChunks.slice(offset, offset + INDEX_EMBED_BATCH_SIZE);
				const message = `Embedding import batch ${Math.floor(offset / INDEX_EMBED_BATCH_SIZE) + 1}/${Math.ceil(
					indexedChunks.length / INDEX_EMBED_BATCH_SIZE,
				)}: ${offset}/${indexedChunks.length} chunks`;
				updateIndexingJob(this.db, kb.id, {
					phase: "embedding",
					message,
					processed_chunks: offset,
					total_files: indexedChunks.length,
					added_chunks: inserted,
				});
				onProgress?.(message);
				const vectors = await embedDocuments(
					batch.map((c) => buildChunkEmbeddingText(c)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				insertChunks(this.db, kb.id, batch);
				vectorWriter.append(vectors);
				inserted += batch.length;
				updateKBCounts(
					this.db,
					kb.id,
					inserted,
					new Set(indexedChunks.slice(0, inserted).map((c) => c.file_path)).size,
				);
				updateIndexingJob(this.db, kb.id, {
					phase: "storing",
					message: `Stored import batch: ${inserted}/${indexedChunks.length} chunks`,
					processed_chunks: inserted,
					total_files: indexedChunks.length,
					added_chunks: inserted,
				});
			}
			vectorWriter.close();
			vectorWriter = undefined;
			renameSync(tempVectorFile, vectorPath);
			tempVectorFile = undefined;
			updateKBCounts(this.db, kb.id, indexedChunks.length, new Set(indexedChunks.map((c) => c.file_path)).size);
			updateKBStatus(this.db, kb.id, "ready");
			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after import: ${kb.id}`);
			finishIndexingJob(this.db, kb.id, "succeeded", `Ready: imported ${indexedChunks.length} chunks`);
			return { kb: savedKB, chunkCount: chunks.length };
		} catch (e) {
			vectorWriter?.close();
			if (tempVectorFile) rmSync(tempVectorFile, { force: true });
			if (this.db) {
				finishIndexingJob(
					this.db,
					kb.id,
					isCancellationError(e) ? "cancelled" : "failed",
					isCancellationError(e) ? "Import cancelled." : "Import failed.",
					e instanceof Error ? e.message : String(e),
				);
			}
			deleteKB(this.db, kb.id);
			throw e;
		}
	}

	async dispose(options: { disposeModels?: boolean } = {}): Promise<void> {
		const disposeModels = options.disposeModels ?? true;
		if (disposeModels) {
			await disposeEmbedding();
			await disposeReranker();
		} else {
			await prepareEmbeddingForShutdown();
			await prepareRerankerForShutdown();
		}
		shutdownModelWorker();
		this.db?.close();
		this.db = null;
	}
}
