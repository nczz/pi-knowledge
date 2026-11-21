import {
	closeSync,
	constants,
	createReadStream,
	createWriteStream,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	type WriteStream,
} from "node:fs";
import {
	lstat as lstatFile,
	mkdtemp,
	open as openFile,
	realpath as realpathFile,
	rm as rmAsync,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type Database from "better-sqlite3";
import { type DiagnosticResult, diagnoseKB, diagnoseKBAsync } from "./diagnostics/health.ts";
import type { EmbeddingCompatibility, EmbeddingConfig } from "./embedding/provider.ts";
import {
	describeEmbeddingCompatibility,
	describeEmbeddingDecoration,
	dispose as disposeEmbedding,
	embedDocuments,
	embeddingConfigLabel,
	embeddingSignature,
	embedQueryWithConfig,
	embedValidatedDocuments,
	inspectEmbeddingCompatibility,
	prepareForShutdown as prepareEmbeddingForShutdown,
	resolveEmbeddingConfig,
} from "./embedding/provider.ts";
import { openVectorReader, openVectorWriter } from "./embedding/vectors.ts";
import {
	assertNetworkAccess,
	assertOpenedPathAuthorized,
	assertOutputPathAuthorized,
	authorizeExistingPath,
	authorizeOutputPath,
	type FilesystemAccessPolicy,
} from "./filesystem-access.ts";
import {
	addSkippedScanEntry,
	analyzeIndexableContent,
	buildChunkEmbeddingText,
	chunkFile,
	chunkIdentityHash,
	chunkMarkdown,
	createSkippedScanStats,
	isReadableTextFile,
	isSupportedDocumentFile,
	iterateScannableFiles,
	iterateScannableFilesAsync,
	preTokenizeForFTS,
	type ScannableFile,
	type ScanOptions,
	summarizeSkippedScan,
} from "./indexer/chunker.ts";
import { finalizeChunksForEmbedding } from "./indexer/embedding-safe-chunks.ts";
import { htmlToStructuredMarkdown } from "./indexer/html.ts";
import { extractSymbols } from "./indexer/symbols.ts";
import { extractDocumentInModelWorker, shutdownModelWorker } from "./model-worker-client.ts";
import { fetchPublicText } from "./network/safe-fetch.ts";
import { searchBM25 } from "./search/bm25.ts";
import { MAX_SEARCH_WINDOW } from "./search/contracts.ts";
import { diversifyRankedChunks, interleaveByFile, type RankedChunk } from "./search/diversity.ts";
import { weightedScoreFusion } from "./search/fusion.ts";
import { normalizedQueryText, tokenizeForSearch } from "./search/query.ts";
import {
	hasAnyLexicalEvidence,
	hasEnoughLexicalEvidence,
	normalizeFileTypeFilter,
	queryCoverage,
	type RankingDiagnostics,
	scoreChunkForQuery,
} from "./search/ranking.ts";
import { disposeReranker, prepareRerankerForShutdown, rerank } from "./search/reranker.ts";
import {
	resolveSearchTuning,
	resolveSearchWindow,
	type SearchProfile,
	type SearchTuningSummary,
	summarizeSearchTuning,
} from "./search/tuning.ts";
import { searchVectorFile } from "./search/vector.ts";
import { ensureOwnerOnlyDirectory, prepareSafeNewFile, publishNewFile } from "./secure-files.ts";
import {
	type Chunk,
	type ChunkInsert,
	countSymbols,
	createKB,
	deleteChunksByIds,
	deleteKB,
	deleteSymbolsByKB,
	finishIndexingJob,
	getChunkById,
	getChunkCount,
	getChunksByFile,
	getFileCount,
	getKB,
	getKBByName,
	getSymbolCount,
	getSymbolsByFile,
	insertChunks,
	insertSymbols,
	iterateChunkIdsByKB,
	iterateChunksByKB,
	type KnowledgeBase,
	type KnowledgeSymbol,
	listKBs,
	markKBIndexed,
	openDatabase,
	searchSymbols,
	startIndexingJob,
	updateIndexingJob,
	updateKBCounts,
	updateKBCountsOnly,
	updateKBEmbeddingMetadata,
	updateKBSourceOptions,
	updateKBStatus,
	updateKBStatusOnly,
} from "./storage/sqlite.ts";

export type SearchMode =
	| "auto"
	| "fast"
	| "semantic"
	| "hybrid"
	| "semantic_hybrid"
	| "deep"
	| "adaptive"
	| "code"
	| "config"
	| "docs"
	| "errors"
	| "decision";

export interface SearchOptions {
	mode?: SearchMode;
	profile?: SearchProfile;
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
	provenance?: {
		chunk_id: string;
		chunk_hash: string;
		indexed_at: number;
		source_mtime?: number;
		stale: boolean;
		match_reason: "bm25" | "vector" | "hybrid" | "rerank" | "symbol" | "adaptive";
		source_chunk_ids?: string[];
	};
}

export { CURRENT_EMBEDDING_MODEL } from "./embedding/provider.ts";
export type SearchMissReason =
	| "no_knowledge_bases"
	| "knowledge_base_not_found"
	| "no_searchable_knowledge_bases"
	| "no_indexed_chunks"
	| "embedding_incompatible"
	| "no_retrieval_candidates"
	| "threshold_filtered"
	| "evidence_filtered"
	| "metadata_filtered"
	| "reranker_empty"
	| "page_out_of_range"
	| "no_match";

export type SearchMissAction =
	| "add_knowledge_base"
	| "fix_kb_id"
	| "wait_for_indexing"
	| "fix_knowledge_base"
	| "fix_embedding"
	| "try_semantic"
	| "try_semantic_hybrid"
	| "relax_filter"
	| "reset_offset"
	| "rephrase";

export interface SearchKnowledgeBaseSummary {
	id: string;
	name: string;
	status: KnowledgeBase["status"];
	chunk_count: number;
}

export interface SearchAttemptSummary {
	mode: SearchMode;
	reason?: SearchMissReason;
	retrieved_candidates: number;
	threshold_candidates: number;
	eligible_candidates: number;
	filtered_candidates: number;
	result_count: number;
}

export interface SearchMiss {
	reason: SearchMissReason;
	action: SearchMissAction;
	requested_kb_id?: string;
	file_type?: string;
	path_pattern?: string;
	min_hybrid_score?: number;
	searched_kbs: SearchKnowledgeBaseSummary[];
	skipped_kbs: SearchKnowledgeBaseSummary[];
	retrieved_candidates: number;
	threshold_candidates: number;
	eligible_candidates: number;
	filtered_candidates: number;
	ranked_candidates: number;
	total_results: number;
	attempts?: SearchAttemptSummary[];
}

export interface SearchResponse {
	results: SearchResult[];
	total_count: number;
	has_more: boolean;
	warnings?: string[];
	mode_used?: SearchMode;
	retry_modes?: SearchMode[];
	tuning?: SearchTuningSummary;
	miss?: SearchMiss;
}

export type ProgressCallback = (msg: string) => void;

export interface AddOptions {
	include_suggested_text?: boolean;
	include_paths?: string[];
	exclude_paths?: string[];
}

interface StoredSourceOptions extends AddOptions {
	embedding_input_policy?: number;
	url_structure_policy?: number;
}

type UpdateableKnowledgeBase = KnowledgeBase & { source_path: string };

interface ImportedChunk {
	content: string;
	file_path: string;
	file_type: string;
	start_line: number;
	end_line: number;
	metadata_json?: string;
}

type KnowledgeSymbolInsert = Parameters<typeof insertSymbols>[2][number];

interface ImportHeader {
	name: string;
	description?: string;
	chunk_count?: number;
}

export interface DoctorIssue {
	severity: "blocking" | "warning" | "info";
	kb_name?: string;
	message: string;
	action: string;
	action_code?:
		| "run_update"
		| "rebuild_kb"
		| "wait_for_indexing"
		| "review_skipped_scope"
		| "fix_embedding_config"
		| "rebuild_vectors"
		| "reindex_for_embedding_budget"
		| "check_source"
		| "none";
}

export interface DoctorReport {
	health_score: number;
	summary: string;
	issues: DoctorIssue[];
	diagnostics: DiagnosticResult[];
	actions: Array<{
		code: NonNullable<DoctorIssue["action_code"]>;
		kb_name?: string;
		target?: string;
		description: string;
	}>;
}

export interface KnowledgeBaseEmbeddingStatus {
	kb_id: string;
	kb_name: string;
	indexed_model: string | null;
	active_model: string;
	active_decoration: string;
	compatibility: EmbeddingCompatibility;
	detail: string;
}

export interface KnowledgeStatusSnapshot {
	knowledge_bases: KnowledgeBase[];
	diagnostics: DiagnosticResult[];
	embeddings: KnowledgeBaseEmbeddingStatus[];
	embedding_error?: string;
}

export interface SymbolSearchOptions {
	kb_id?: string;
	kind?: KnowledgeSymbol["kind"];
	file_pattern?: string;
	limit?: number;
	offset?: number;
	exact?: boolean;
}
export type SymbolSearchMissReason =
	| "no_knowledge_bases"
	| "knowledge_base_not_found"
	| "no_searchable_knowledge_bases"
	| "symbol_index_empty"
	| "exact_name_not_found"
	| "metadata_filtered"
	| "page_out_of_range"
	| "no_match";

export type SymbolSearchMissAction =
	| "add_knowledge_base"
	| "fix_kb_id"
	| "wait_for_indexing"
	| "fix_knowledge_base"
	| "rebuild_symbol_index"
	| "broaden_symbol_search"
	| "relax_filter"
	| "reset_offset"
	| "use_text_search";

export interface SymbolSearchMiss {
	reason: SymbolSearchMissReason;
	action: SymbolSearchMissAction;
	requested_kb_id?: string;
	kind?: KnowledgeSymbol["kind"];
	file_pattern?: string;
	exact: boolean;
	searched_kbs: SearchKnowledgeBaseSummary[];
	skipped_kbs: SearchKnowledgeBaseSummary[];
	indexed_symbols: number;
	unfiltered_matches: number;
}

export interface SymbolSearchResponse {
	results: Array<{
		name: string;
		kind: KnowledgeSymbol["kind"];
		file_path: string;
		file_type: string;
		kb_name: string;
		start_line: number;
		end_line: number;
		signature?: string;
		container_name?: string;
		text: string;
		indexed_at: number;
	}>;
	total_count: number;
	has_more: boolean;
	miss?: SymbolSearchMiss;
}

export const CURRENT_URL_STRUCTURE_POLICY = 1;
export const CURRENT_EMBEDDING_INPUT_POLICY = 2;
const DEFAULT_INDEX_EMBED_BATCH_SIZE = 64;

function resolveIndexEmbedBatchSize(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_KNOWLEDGE_EMBEDDING_BATCH_SIZE?.trim();
	if (!raw) return DEFAULT_INDEX_EMBED_BATCH_SIZE;
	const value = Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_INDEX_EMBED_BATCH_SIZE;
	const batchSize = Math.trunc(value);
	return batchSize > 0 ? batchSize : DEFAULT_INDEX_EMBED_BATCH_SIZE;
}

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

function assertEmbeddingBatchSize(vectors: Float32Array[], expected: number, operation: string): void {
	if (vectors.length !== expected) {
		throw new Error(`Embedding provider returned ${vectors.length} vectors for ${expected} ${operation} chunks`);
	}
}

function retrievalModeFor(
	mode: SearchMode,
): Exclude<SearchMode, "auto" | "code" | "config" | "docs" | "errors" | "decision"> {
	if (mode === "auto") return "hybrid";
	if (mode === "code" || mode === "config" || mode === "errors") return "fast";
	if (mode === "docs" || mode === "decision") return "hybrid";
	return mode;
}

function matchReasonFor(mode: SearchMode): NonNullable<SearchResult["provenance"]>["match_reason"] {
	if (mode === "deep") return "rerank";
	if (mode === "adaptive") return "adaptive";
	if (mode === "semantic") return "vector";
	if (mode === "fast" || mode === "code" || mode === "config" || mode === "errors") return "bm25";
	return "hybrid";
}

function toScanOptions(options: AddOptions = {}, accessPolicy?: FilesystemAccessPolicy): ScanOptions {
	return {
		includeSuggestedText: options.include_suggested_text === true,
		includePaths: options.include_paths,
		excludePaths: options.exclude_paths,
		accessPolicy,
	};
}
function serializeAddOptions(options: AddOptions = {}): string {
	const normalized: StoredSourceOptions = {
		embedding_input_policy: CURRENT_EMBEDDING_INPUT_POLICY,
		url_structure_policy: CURRENT_URL_STRUCTURE_POLICY,
	};
	if (options.include_suggested_text === true) normalized.include_suggested_text = true;
	if (options.include_paths && options.include_paths.length > 0) normalized.include_paths = options.include_paths;
	if (options.exclude_paths && options.exclude_paths.length > 0) normalized.exclude_paths = options.exclude_paths;
	return JSON.stringify(normalized);
}

function parseAddOptions(raw: string | null): AddOptions {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as StoredSourceOptions;
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

function storedSourcePolicyVersion(
	raw: string | null,
	key: "embedding_input_policy" | "url_structure_policy",
): number | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as StoredSourceOptions;
		const version = parsed[key];
		return typeof version === "number" && Number.isInteger(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

function planDirectoryScan(dirPath: string, options: ScanOptions = {}, signal?: AbortSignal): DirectoryScanPlan {
	const skipped = createSkippedScanStats();
	let files = 0;
	let bytes = 0;
	for (const file of iterateScannableFiles(dirPath, skipped, options)) {
		throwIfAborted(signal);
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

async function planDirectoryScanAsync(
	dirPath: string,
	options: ScanOptions = {},
	signal?: AbortSignal,
): Promise<DirectoryScanPlan> {
	const skipped = createSkippedScanStats();
	let files = 0;
	let bytes = 0;
	for await (const file of iterateScannableFilesAsync(dirPath, skipped, options, signal)) {
		throwIfAborted(signal);
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

function kbTrustMultiplier(kb: KnowledgeBase): number {
	let multiplier = kb.status === "stale" ? 0.92 : 1;
	if (kb.source_type === "directory" || kb.source_type === "file") multiplier *= 1.04;
	if (kb.source_type === "text" || kb.source_type === "url") multiplier *= 0.98;
	return multiplier;
}

function summarizeKnowledgeBases(kbs: KnowledgeBase[]): SearchKnowledgeBaseSummary[] {
	return kbs.map((kb) => ({
		id: kb.id,
		name: kb.name,
		status: kb.status,
		chunk_count: kb.chunk_count,
	}));
}

interface SearchMissFacts {
	allKnowledgeBases: KnowledgeBase[];
	availableKnowledgeBases: KnowledgeBase[];
	searchedKnowledgeBases: KnowledgeBase[];
	requestedKbId?: string;
	mode: SearchMode;
	fileType?: string;
	pathPattern?: string;
	minimumScore?: number;
	offset: number;
	retrievedCandidates: number;
	thresholdCandidates: number;
	eligibleCandidates: number;
	filteredCandidates: number;
	rankedCandidates: number;
	totalResults: number;
	embeddingIncompatibleCount: number;
}

function searchMissAction(
	reason: SearchMissReason,
	mode: SearchMode,
	availableKnowledgeBases: KnowledgeBase[],
): SearchMissAction {
	switch (reason) {
		case "no_knowledge_bases":
			return "add_knowledge_base";
		case "knowledge_base_not_found":
			return "fix_kb_id";
		case "no_searchable_knowledge_bases":
			return availableKnowledgeBases.length > 0 && availableKnowledgeBases.every((kb) => kb.status === "indexing")
				? "wait_for_indexing"
				: "fix_knowledge_base";
		case "no_indexed_chunks":
			return availableKnowledgeBases.some((kb) => kb.status === "indexing")
				? "wait_for_indexing"
				: "fix_knowledge_base";
		case "embedding_incompatible":
			return "fix_embedding";
		case "no_retrieval_candidates":
			return mode === "fast" || mode === "code" || mode === "config" || mode === "errors"
				? "try_semantic"
				: mode === "semantic" || mode === "semantic_hybrid"
					? "rephrase"
					: "try_semantic_hybrid";
		case "threshold_filtered":
			return mode === "semantic_hybrid" ? "rephrase" : "try_semantic_hybrid";
		case "evidence_filtered":
			return "try_semantic_hybrid";
		case "metadata_filtered":
			return "relax_filter";
		case "page_out_of_range":
			return "reset_offset";
		case "reranker_empty":
		case "no_match":
			return "rephrase";
	}
}

function classifySearchMiss(facts: SearchMissFacts): SearchMiss {
	const skippedKnowledgeBases = facts.availableKnowledgeBases.filter(
		(kb) => kb.status !== "ready" && kb.status !== "stale",
	);
	let reason: SearchMissReason;
	if (facts.allKnowledgeBases.length === 0) {
		reason = "no_knowledge_bases";
	} else if (
		facts.requestedKbId &&
		!facts.availableKnowledgeBases.some((kb) => kb.id === facts.requestedKbId || kb.name === facts.requestedKbId)
	) {
		reason = "knowledge_base_not_found";
	} else if (facts.searchedKnowledgeBases.length === 0) {
		reason = "no_searchable_knowledge_bases";
	} else if (facts.searchedKnowledgeBases.every((kb) => kb.chunk_count === 0)) {
		reason = "no_indexed_chunks";
	} else if (
		facts.retrievedCandidates === 0 &&
		facts.embeddingIncompatibleCount === facts.searchedKnowledgeBases.filter((kb) => kb.chunk_count > 0).length
	) {
		reason = "embedding_incompatible";
	} else if (facts.retrievedCandidates === 0) {
		reason = "no_retrieval_candidates";
	} else if (facts.thresholdCandidates === 0) {
		reason = "threshold_filtered";
	} else if (facts.eligibleCandidates === 0) {
		reason = "evidence_filtered";
	} else if (facts.filteredCandidates === 0 && (facts.fileType || facts.pathPattern)) {
		reason = "metadata_filtered";
	} else if (facts.mode === "deep" && facts.rankedCandidates === 0) {
		reason = "reranker_empty";
	} else if (facts.totalResults > 0 && facts.offset >= facts.totalResults) {
		reason = "page_out_of_range";
	} else {
		reason = "no_match";
	}
	return {
		reason,
		action: searchMissAction(reason, facts.mode, facts.availableKnowledgeBases),
		requested_kb_id: facts.requestedKbId,
		min_hybrid_score: facts.minimumScore,
		file_type: facts.fileType,
		path_pattern: facts.pathPattern,
		searched_kbs: summarizeKnowledgeBases(facts.searchedKnowledgeBases),
		skipped_kbs: summarizeKnowledgeBases(skippedKnowledgeBases),
		retrieved_candidates: facts.retrievedCandidates,
		threshold_candidates: facts.thresholdCandidates,
		eligible_candidates: facts.eligibleCandidates,
		filtered_candidates: facts.filteredCandidates,
		ranked_candidates: facts.rankedCandidates,
		total_results: facts.totalResults,
	};
}

function searchAttemptSummary(mode: SearchMode, response: SearchResponse): SearchAttemptSummary {
	return {
		mode,
		reason: response.miss?.reason,
		retrieved_candidates: response.tuning?.retrieved_candidates ?? 0,
		threshold_candidates: response.tuning?.threshold_candidates ?? 0,
		eligible_candidates: response.tuning?.eligible_candidates ?? 0,
		filtered_candidates: response.tuning?.filtered_candidates ?? 0,
		result_count: response.results.length,
	};
}
interface SymbolSearchMissFacts {
	allKnowledgeBases: KnowledgeBase[];
	availableKnowledgeBases: KnowledgeBase[];
	searchedKnowledgeBases: KnowledgeBase[];
	requestedKbId?: string;
	kind?: KnowledgeSymbol["kind"];
	filePattern?: string;
	exact: boolean;
	offset: number;
	totalResults: number;
	indexedSymbols: number;
	unfilteredMatches: number;
}

function symbolMissAction(
	reason: SymbolSearchMissReason,
	availableKnowledgeBases: KnowledgeBase[],
): SymbolSearchMissAction {
	switch (reason) {
		case "no_knowledge_bases":
			return "add_knowledge_base";
		case "knowledge_base_not_found":
			return "fix_kb_id";
		case "no_searchable_knowledge_bases":
			return availableKnowledgeBases.length > 0 && availableKnowledgeBases.every((kb) => kb.status === "indexing")
				? "wait_for_indexing"
				: "fix_knowledge_base";
		case "symbol_index_empty":
			return "rebuild_symbol_index";
		case "exact_name_not_found":
			return "broaden_symbol_search";
		case "metadata_filtered":
			return "relax_filter";
		case "page_out_of_range":
			return "reset_offset";
		case "no_match":
			return "use_text_search";
	}
}

function classifySymbolSearchMiss(facts: SymbolSearchMissFacts): SymbolSearchMiss {
	const skippedKnowledgeBases = facts.availableKnowledgeBases.filter(
		(kb) => kb.status !== "ready" && kb.status !== "stale",
	);
	let reason: SymbolSearchMissReason;
	if (facts.allKnowledgeBases.length === 0) {
		reason = "no_knowledge_bases";
	} else if (
		facts.requestedKbId &&
		!facts.availableKnowledgeBases.some((kb) => kb.id === facts.requestedKbId || kb.name === facts.requestedKbId)
	) {
		reason = "knowledge_base_not_found";
	} else if (facts.searchedKnowledgeBases.length === 0) {
		reason = "no_searchable_knowledge_bases";
	} else if (facts.indexedSymbols === 0) {
		reason = "symbol_index_empty";
	} else if (facts.totalResults > 0 && facts.offset >= facts.totalResults) {
		reason = "page_out_of_range";
	} else if ((facts.kind || facts.filePattern) && facts.unfilteredMatches > 0) {
		reason = "metadata_filtered";
	} else if (facts.exact) {
		reason = "exact_name_not_found";
	} else {
		reason = "no_match";
	}
	return {
		reason,
		action: symbolMissAction(reason, facts.availableKnowledgeBases),
		requested_kb_id: facts.requestedKbId,
		kind: facts.kind,
		file_pattern: facts.filePattern,
		exact: facts.exact,
		searched_kbs: summarizeKnowledgeBases(facts.searchedKnowledgeBases),
		skipped_kbs: summarizeKnowledgeBases(skippedKnowledgeBases),
		indexed_symbols: facts.indexedSymbols,
		unfiltered_matches: facts.unfilteredMatches,
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

function tokenizeForSimilarity(text: string): Set<string> {
	return tokenizeForSearch(text);
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

interface AdaptiveChunkMetadata {
	symbol?: string;
	symbolKind?: string;
	parentSymbol?: string;
	scope: string[];
	startLine?: number;
	endLine?: number;
}

function metadataString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataStringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
		: [];
}

function parseAdaptiveMetadata(chunk: Chunk): AdaptiveChunkMetadata {
	try {
		const parsed = JSON.parse(chunk.metadata_json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { scope: [] };
		const record = parsed as Record<string, unknown>;
		return {
			symbol: metadataString(record, "symbol") ?? metadataString(record, "function_name"),
			symbolKind: metadataString(record, "symbol_kind"),
			parentSymbol: metadataString(record, "parent_symbol"),
			scope: metadataStringArray(record, "scope"),
			startLine: metadataNumber(record, "start_line"),
			endLine: metadataNumber(record, "end_line"),
		};
	} catch {
		return { scope: [] };
	}
}

function hasAdaptiveStructure(metadata: AdaptiveChunkMetadata): boolean {
	return Boolean(metadata.symbol || metadata.symbolKind || metadata.parentSymbol || metadata.scope.length > 0);
}

function parentScope(scope: string[]): string[] {
	return scope.length > 1 ? scope.slice(0, -1) : [];
}

function sameScope(left: string[], right: string[]): boolean {
	return left.length > 0 && left.length === right.length && left.every((item, index) => item === right[index]);
}

function isScopePrefix(parent: string[], child: string[]): boolean {
	return parent.length > 0 && parent.length < child.length && parent.every((item, index) => item === child[index]);
}

function adaptiveRelationBoost(seed: AdaptiveChunkMetadata, candidate: AdaptiveChunkMetadata): number {
	if (!hasAdaptiveStructure(seed) || !hasAdaptiveStructure(candidate)) return 0;
	const seedParentScope = parentScope(seed.scope);
	const candidateParentScope = parentScope(candidate.scope);
	if (sameScope(seedParentScope, candidateParentScope)) return seed.symbol === candidate.symbol ? 0.35 : 1.35;
	if (seed.parentSymbol && seed.parentSymbol === candidate.parentSymbol) {
		return seed.symbol === candidate.symbol ? 0.35 : 1.2;
	}
	if (isScopePrefix(seed.scope, candidate.scope) || isScopePrefix(candidate.scope, seed.scope)) return 0.9;
	return 0;
}

function buildAdaptiveContext(
	seed: Chunk,
	chunks: Chunk[],
	queryTokens: Set<string>,
	options: { maxContextChars: number; neighborTarget: number },
): {
	content: string;
	startLine: number;
	endLine: number;
	sourceChunkIds: string[];
} {
	const seedMetadata = parseAdaptiveMetadata(seed);
	const scored = chunks
		.map((chunk) => {
			const distance =
				chunk.id === seed.id
					? 0
					: Math.min(Math.abs(chunk.start_line - seed.start_line), Math.abs(chunk.end_line - seed.end_line));
			const proximity = 1 / (1 + distance / 20);
			const coverage = queryCoverage(chunk.content, queryTokens);
			const seedBoost = chunk.id === seed.id ? 2 : 0;
			const relationBoost =
				chunk.id === seed.id ? 0 : adaptiveRelationBoost(seedMetadata, parseAdaptiveMetadata(chunk));
			return { chunk, score: seedBoost + relationBoost + proximity + coverage };
		})
		.sort((a, b) => b.score - a.score || a.chunk.start_line - b.chunk.start_line || a.chunk.end_line - b.chunk.end_line)
		.slice(0, options.neighborTarget);
	if (!scored.some((item) => item.chunk.id === seed.id)) scored.push({ chunk: seed, score: Number.MAX_SAFE_INTEGER });

	const selectedIds = new Set(scored.map((item) => item.chunk.id));
	const ordered = chunks
		.filter((chunk) => selectedIds.has(chunk.id))
		.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
	const parts: string[] = [];
	const sourceChunkIds: string[] = [];
	const includedChunks: Chunk[] = [];
	let totalLength = 0;
	for (const chunk of ordered) {
		if (totalLength >= options.maxContextChars) break;
		const remaining = options.maxContextChars - totalLength;
		const text = chunk.content.slice(0, remaining);
		parts.push(text);
		sourceChunkIds.push(chunk.id);
		includedChunks.push(chunk);
		totalLength += text.length + 2;
	}
	return {
		content: parts.join("\n\n"),
		startLine: Math.min(...includedChunks.map((chunk) => chunk.start_line)),
		endLine: Math.max(...includedChunks.map((chunk) => chunk.end_line)),
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

function chooseAutoMode(query: string): SearchMode {
	const normalized = query.trim();
	if (isExactLookupQuery(normalized)) return "fast";
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;
	if (wordCount >= 10 || /how|why|explain|concept|architecture|design|流程|架構|概念|為什麼|如何/i.test(normalized)) {
		return "semantic";
	}
	return "hybrid";
}

function fallbackModesFor(mode: SearchMode): SearchMode[] {
	if (mode === "fast") return ["hybrid", "semantic"];
	if (mode === "semantic") return ["hybrid", "adaptive"];
	if (mode === "adaptive") return ["hybrid", "deep"];
	if (mode === "deep") return ["hybrid", "adaptive"];
	return ["fast", "semantic", "adaptive"];
}

function isWeakAutoResponse(
	query: string,
	response: SearchResponse,
	primaryMode: SearchMode,
	attemptMode: SearchMode,
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

const MAX_DIRECT_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_DIRECT_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const MAX_IMPORT_LINE_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_LINES = 1_000_001;
const MAX_IMPORT_CHUNKS = 1_000_000;
const MAX_EXPORT_BYTES = MAX_IMPORT_BYTES;
const MAX_EXPORT_CHUNKS = MAX_IMPORT_CHUNKS;
const MAX_EXPORT_DURATION_MS = 60 * 60_000;
const MAX_KB_NAME_BYTES = 512;
const MAX_KB_DESCRIPTION_BYTES = 4 * 1024;
const MAX_IMPORT_CONTENT_BYTES = 12 * 1024 * 1024;
const MAX_IMPORT_FILE_PATH_BYTES = 4_096;
const MAX_IMPORT_FILE_TYPE_BYTES = 256;
const MAX_IMPORT_METADATA_BYTES = 64 * 1024;
const MAX_IMPORT_METADATA_CONTEXT_BYTES = 8 * 1024;
const MAX_IMPORT_METADATA_SCOPE_ITEMS = 128;
const MAX_IMPORT_LINE_NUMBER = 2_147_483_647;
const MAX_IMPORT_FIXED_CONTEXT_BYTES = 64 * 1024;
const IMPORTED_CHUNK_KEYS = new Set(["content", "file_path", "file_type", "start_line", "end_line", "metadata_json"]);
const IMPORTED_CONTEXT_STRING_KEYS = [
	"heading",
	"breadcrumb",
	"language",
	"symbol",
	"function_name",
	"symbol_kind",
	"parent_symbol",
	"signature",
] as const;

async function chunkUrl(source: string, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof chunkFile>>> {
	const html = await fetchPublicText(source, signal);
	throwIfAborted(signal);
	const text = htmlToStructuredMarkdown(html);
	const structuredChunks = chunkMarkdown(text, source, "html");
	return structuredChunks.length > 0 ? structuredChunks : chunkFile(text, source);
}
function validateKnowledgeBaseMetadata(name: unknown, description: unknown): ImportHeader {
	if (typeof name !== "string" || !name.trim()) throw new Error("Knowledge base name must be a non-empty string");
	if (Buffer.byteLength(name) > MAX_KB_NAME_BYTES) {
		throw new Error(`Knowledge base name exceeds the ${MAX_KB_NAME_BYTES}-byte limit`);
	}
	const normalizedDescription = description === null ? undefined : description;
	if (normalizedDescription !== undefined && typeof normalizedDescription !== "string") {
		throw new Error("Knowledge base description must be a string");
	}
	if (
		typeof normalizedDescription === "string" &&
		Buffer.byteLength(normalizedDescription) > MAX_KB_DESCRIPTION_BYTES
	) {
		throw new Error(`Knowledge base description exceeds the ${MAX_KB_DESCRIPTION_BYTES}-byte limit`);
	}
	return { name, description: normalizedDescription };
}

interface ExtractedSourceFile {
	content: string;
	fileType: string;
}

async function readBoundedRegularFile(
	filePath: string,
	maxBytes: number,
	signal?: AbortSignal,
	expected?: ScannableFile,
	access?: FilesystemAccessPolicy,
): Promise<Buffer> {
	if (expected?.rootPath) {
		const canonical = await realpathFile(filePath);
		const rel = relative(expected.rootPath, canonical);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			throw new Error(`Source file escaped its scanned root: ${filePath}`);
		}
	}
	const direct = lstatSync(filePath);
	if (direct.isSymbolicLink() || !direct.isFile())
		throw new Error(`Source is not a regular non-symlink file: ${filePath}`);
	if (
		expected?.device !== undefined &&
		expected.inode !== undefined &&
		(direct.dev !== expected.device || direct.ino !== expected.inode)
	) {
		throw new Error(`Source file changed after scanning: ${filePath}`);
	}
	const handle = await openFile(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat();
		if (!opened.isFile()) throw new Error(`Source is not a regular file: ${filePath}`);
		assertOpenedPathAuthorized(filePath, opened.dev, opened.ino, access);
		if (expected?.rootPath) {
			const canonical = await realpathFile(filePath);
			const current = await lstatFile(filePath);
			const rel = relative(expected.rootPath, canonical);
			if (
				rel === ".." ||
				rel.startsWith(`..${sep}`) ||
				isAbsolute(rel) ||
				current.isSymbolicLink() ||
				current.dev !== opened.dev ||
				current.ino !== opened.ino
			) {
				throw new Error(`Source file changed outside its scanned root: ${filePath}`);
			}
		}
		if (
			expected?.device !== undefined &&
			expected.inode !== undefined &&
			(opened.dev !== expected.device || opened.ino !== expected.inode)
		) {
			throw new Error(`Source file changed while opening: ${filePath}`);
		}
		if (opened.size > maxBytes) {
			throw new Error(`Source file exceeds the ${maxBytes}-byte direct indexing limit: ${filePath}`);
		}
		const chunks: Buffer[] = [];
		let bytes = 0;
		while (bytes <= maxBytes) {
			throwIfAborted(signal);
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytes + 1));
			const result = await handle.read(buffer, 0, buffer.length, null);
			if (result.bytesRead === 0) break;
			bytes += result.bytesRead;
			if (bytes > maxBytes) {
				throw new Error(`Source file exceeds the ${maxBytes}-byte direct indexing limit: ${filePath}`);
			}
			chunks.push(buffer.subarray(0, result.bytesRead));
		}
		return Buffer.concat(chunks, bytes);
	} finally {
		await handle.close();
	}
}

async function extractSourceFileContent(
	filePath: string,
	signal?: AbortSignal,
	expected?: ScannableFile,
	access?: FilesystemAccessPolicy,
): Promise<ExtractedSourceFile> {
	filePath = authorizeExistingPath(filePath, access);
	const lowerPath = filePath.toLowerCase();
	const isDocument = lowerPath.endsWith(".pdf") || lowerPath.endsWith(".docx") || lowerPath.endsWith(".doc");
	const maxBytes = isDocument ? MAX_DIRECT_DOCUMENT_BYTES : MAX_DIRECT_TEXT_BYTES;
	const content = await readBoundedRegularFile(filePath, maxBytes, signal, expected, access);
	if (!isDocument) {
		if (content.subarray(0, 8_000).includes(0x00)) {
			throw new Error(`File is not readable text and has no supported extractor: ${filePath}`);
		}
		return { content: content.toString("utf8"), fileType: "text" };
	}

	const tempDirectory = ensureOwnerOnlyDirectory(await mkdtemp(join(tmpdir(), "pi-knowledge-document-")));
	const tempPath = join(tempDirectory, "source");
	try {
		await writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
		const fileType = lowerPath.endsWith(".pdf") ? "pdf" : "docx";
		const extracted = await extractDocumentInModelWorker(tempPath, fileType, signal);
		throwIfAborted(signal);
		return extracted;
	} finally {
		await rmAsync(tempDirectory, { recursive: true, force: true });
	}
}

interface ClassifiedSource {
	resolvedSource: string;
	isUrl: boolean;
	isDir: boolean;
	isFile: boolean;
	sourceType: "url" | "directory" | "file" | "text";
}

function looksLikeLocalPath(source: string): boolean {
	const trimmed = source.trim();
	if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return false;
	if (/^(?:https?:)?\/\//.test(trimmed)) return false;
	if (trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
	if (trimmed.includes("/") || trimmed.includes("\\")) return true;
	return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(trimmed);
}

function classifySource(source: string, access?: FilesystemAccessPolicy): ClassifiedSource {
	const isUrl = source.startsWith("http://") || source.startsWith("https://");
	if (isUrl) assertNetworkAccess(access);
	const requestedSource = resolve(source);
	const exists = !isUrl && existsSync(requestedSource);
	const resolvedSource = exists ? authorizeExistingPath(requestedSource, access) : requestedSource;
	const isDir = exists && statSync(resolvedSource).isDirectory();
	const isFile = exists && statSync(resolvedSource).isFile();
	if (!isUrl && !isDir && !isFile && looksLikeLocalPath(source)) {
		throw new Error(`Local path does not exist: ${source}. Pass inline text only when the source itself is text.`);
	}
	return {
		resolvedSource,
		isUrl,
		isDir,
		isFile,
		sourceType: isUrl ? "url" : isDir ? "directory" : isFile ? "file" : "text",
	};
}

async function extractScannableFileContent(file: ScannableFile, signal?: AbortSignal): Promise<ExtractedSourceFile> {
	return extractSourceFileContent(file.path, signal, file);
}

async function extractScannableFileContentOrSkip(
	file: ScannableFile,
	skipped: ReturnType<typeof createSkippedScanStats>,
	signal?: AbortSignal,
): Promise<ExtractedSourceFile | undefined> {
	try {
		return await extractScannableFileContent(file, signal);
	} catch (error) {
		if (signal?.aborted || isCancellationError(error)) throw error;
		addSkippedScanEntry(skipped, { path: file.relPath, reason: "extraction_failed", size: file.size });
		return undefined;
	}
}

function persistEmbeddingMetadata(
	db: Database.Database,
	kbId: string,
	config: EmbeddingConfig,
	vectors: Float32Array[],
): number | undefined {
	const firstVector = vectors[0];
	if (!firstVector) return undefined;
	const dimension = firstVector.length;
	updateKBEmbeddingMetadata(db, kbId, embeddingConfigLabel(config), embeddingSignature(config, dimension), dimension);
	return dimension;
}

function embeddingMismatchWarning(kb: KnowledgeBase, compatibility: EmbeddingCompatibility): string {
	return `"${kb.name}" has incompatible embedding vectors (${describeEmbeddingCompatibility(compatibility)}); vector retrieval was skipped and knowledge_update should rebuild them`;
}
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Cancelled");
}

function boundedImportString(value: unknown, field: string, maxBytes: number): string {
	if (typeof value !== "string") throw new Error(`Imported chunk ${field} must be a string`);
	if (Buffer.byteLength(value) > maxBytes) {
		throw new Error(`Imported chunk ${field} exceeds the ${maxBytes}-byte limit`);
	}
	return value;
}

function validateImportedMetadata(metadataJson: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadataJson);
	} catch {
		throw new Error("Imported chunk metadata_json must contain valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Imported chunk metadata_json must contain an object");
	}
	const metadata = parsed as Record<string, unknown>;
	let contextBytes = 0;
	for (const key of IMPORTED_CONTEXT_STRING_KEYS) {
		const value = metadata[key];
		if (value === undefined) continue;
		if (typeof value !== "string") throw new Error(`Imported chunk metadata ${key} must be a string`);
		contextBytes += Buffer.byteLength(value);
	}
	const scope = metadata.scope;
	if (scope !== undefined) {
		if (!Array.isArray(scope) || scope.length > MAX_IMPORT_METADATA_SCOPE_ITEMS) {
			throw new Error("Imported chunk metadata scope is invalid");
		}
		for (const item of scope) {
			if (typeof item !== "string") throw new Error("Imported chunk metadata scope must contain strings");
			contextBytes += Buffer.byteLength(item);
		}
	}
	if (contextBytes > MAX_IMPORT_METADATA_CONTEXT_BYTES) {
		throw new Error(`Imported chunk embedding metadata exceeds the ${MAX_IMPORT_METADATA_CONTEXT_BYTES}-byte limit`);
	}
}

function parseImportedChunk(value: unknown): ImportedChunk {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Imported chunk must be an object");
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!IMPORTED_CHUNK_KEYS.has(key)) throw new Error(`Imported chunk contains unknown field: ${key}`);
	}
	const content = boundedImportString(record.content, "content", MAX_IMPORT_CONTENT_BYTES);
	const filePath = boundedImportString(record.file_path, "file_path", MAX_IMPORT_FILE_PATH_BYTES);
	const fileType = boundedImportString(record.file_type, "file_type", MAX_IMPORT_FILE_TYPE_BYTES);
	if (!content) throw new Error("Imported chunk content must not be empty");
	if (!filePath) throw new Error("Imported chunk file_path must not be empty");
	if (!fileType) throw new Error("Imported chunk file_type must not be empty");
	const startLine = record.start_line;
	const endLine = record.end_line;
	if (
		!Number.isSafeInteger(startLine) ||
		typeof startLine !== "number" ||
		startLine < 0 ||
		startLine > MAX_IMPORT_LINE_NUMBER
	) {
		throw new Error("Imported chunk start_line is invalid");
	}
	if (
		!Number.isSafeInteger(endLine) ||
		typeof endLine !== "number" ||
		endLine < startLine ||
		endLine > MAX_IMPORT_LINE_NUMBER
	) {
		throw new Error("Imported chunk end_line is invalid");
	}
	const metadataJson =
		record.metadata_json === undefined
			? "{}"
			: boundedImportString(record.metadata_json, "metadata_json", MAX_IMPORT_METADATA_BYTES);
	validateImportedMetadata(metadataJson);
	const imported = {
		content,
		file_path: filePath,
		file_type: fileType,
		start_line: startLine,
		end_line: endLine,
		metadata_json: metadataJson,
	};
	const fixedContext = buildChunkEmbeddingText({ ...imported, content: "" });
	if (Buffer.byteLength(fixedContext) > MAX_IMPORT_FIXED_CONTEXT_BYTES) {
		throw new Error(`Imported chunk fixed embedding context exceeds the ${MAX_IMPORT_FIXED_CONTEXT_BYTES}-byte limit`);
	}
	return imported;
}

function importedChunkToInsert(chunk: ImportedChunk): ChunkInsert {
	const metadataJson = chunk.metadata_json || "{}";
	return {
		content_hash: chunkIdentityHash({
			content: chunk.content,
			filePath: chunk.file_path,
			fileType: chunk.file_type,
			startLine: chunk.start_line,
			endLine: chunk.end_line,
			metadataJson,
		}),
		content: chunk.content,
		content_tokenized: "",
		file_path: chunk.file_path,
		file_type: chunk.file_type,
		start_line: chunk.start_line,
		end_line: chunk.end_line,
		metadata_json: metadataJson,
	};
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
	if (stream.write(`${line}\n`)) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
		};
		const onDrain = (): void => {
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		stream.once("drain", onDrain);
		stream.once("error", onError);
	});
}

async function finishWriteStream(stream: WriteStream): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			stream.off("finish", onFinish);
			stream.off("error", onError);
		};
		const onFinish = (): void => {
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		stream.once("finish", onFinish);
		stream.once("error", onError);
		stream.end();
	});
}

export class KnowledgeEngine {
	private db: Database.Database | null = null;
	private knowledgeDir: string = "";
	private activeUpdates = new Map<string, Promise<{ added: number; removed: number; unchanged: number }>>();
	private activeMutations = new Map<string, Promise<unknown>>();
	private disposing = false;

	private runExclusive<T>(keys: string | string[], description: string, operation: () => Promise<T> | T): Promise<T> {
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		const mutationKeys = Array.isArray(keys) ? keys : [keys];
		for (const key of mutationKeys) {
			if (this.activeMutations.has(key)) throw new Error(`${description} is already running`);
		}
		const run = Promise.resolve()
			.then(operation)
			.finally(() => {
				for (const key of mutationKeys) {
					if (this.activeMutations.get(key) === run) this.activeMutations.delete(key);
				}
			});
		for (const key of mutationKeys) this.activeMutations.set(key, run);
		return run;
	}

	async initialize(knowledgeDir: string): Promise<void> {
		this.knowledgeDir = knowledgeDir;
		this.db = openDatabase(knowledgeDir);
		this.disposing = false;
	}

	private vectorPathFor(kbId: string): string {
		return join(this.knowledgeDir, "vectors", `${kbId}.bin`);
	}

	private deleteVectorFile(kbId: string): void {
		rmSync(this.vectorPathFor(kbId), { force: true });
	}

	plan(source: string, options: AddOptions = {}, signal?: AbortSignal, access?: FilesystemAccessPolicy): IndexPlan {
		throwIfAborted(signal);
		const { resolvedSource, isDir, isFile, sourceType } = classifySource(source, access);
		if ((isDir || isFile) && lstatSync(resolvedSource).isSymbolicLink()) {
			throw new Error(`Source is not a regular non-symlink path: ${resolvedSource}`);
		}
		if (isDir) {
			const plan = planDirectoryScan(resolvedSource, toScanOptions(options), signal);
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
			const supportedDocument = isSupportedDocumentFile(resolvedSource);
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

	async planAsync(
		source: string,
		options: AddOptions = {},
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<IndexPlan> {
		throwIfAborted(signal);
		const { resolvedSource, isDir, isFile, sourceType } = classifySource(source, access);
		if (isDir) {
			const plan = await planDirectoryScanAsync(resolvedSource, toScanOptions(options, access), signal);
			return {
				source_type: "directory",
				scannable_files: plan.files,
				scannable_bytes: plan.bytes,
				skipped: plan.skipped,
				summary: `Directory plan: ${plan.files} scannable files, ${formatBytes(plan.bytes)} scannable text, skipped ${plan.skippedTotal} (${plan.skippedSummary})`,
			};
		}
		if (isFile && lstatSync(resolvedSource).isSymbolicLink()) {
			throw new Error(`Source is not a regular non-symlink file: ${resolvedSource}`);
		}
		const skipped = createSkippedScanStats();
		const sourceBytes = isFile ? statSync(resolvedSource).size : Buffer.byteLength(source);
		const maxBytes =
			isFile && isSupportedDocumentFile(resolvedSource) ? MAX_DIRECT_DOCUMENT_BYTES : MAX_DIRECT_TEXT_BYTES;
		if (sourceType !== "url" && sourceBytes > maxBytes) {
			addSkippedScanEntry(skipped, {
				path: isFile ? resolvedSource : "<inline>",
				reason: "oversized",
				size: sourceBytes,
			});
			return {
				source_type: sourceType,
				scannable_files: 0,
				scannable_bytes: 0,
				skipped,
				summary: `${isFile ? "File" : "Inline text"} plan: 0 scannable sources; source exceeds ${formatBytes(maxBytes)}`,
			};
		}
		return this.plan(source, options, signal, access);
	}

	async add(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		options: AddOptions = {},
		access?: FilesystemAccessPolicy,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		throwIfAborted(signal);
		validateKnowledgeBaseMetadata(name, undefined);
		return this.runExclusive(["global:mutation", `kb-name:${name}`], `Mutation for "${name}"`, () =>
			this.addUnlocked(source, name, onProgress, signal, options, access),
		);
	}

	private async addUnlocked(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		options: AddOptions = {},
		access?: FilesystemAccessPolicy,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const db = this.db;
		const { resolvedSource, isUrl, isDir, isFile, sourceType } = classifySource(source, access);
		const scanOptions = toScanOptions(options, access);

		const existingKB = getKBByName(db, name);
		if (existingKB) {
			throw new Error(
				`Knowledge base "${name}" already exists. Use knowledge_update to refresh it, or knowledge_remove before adding a replacement.`,
			);
		}

		const embeddingConfig = resolveEmbeddingConfig();
		const embeddingBatchSize = resolveIndexEmbedBatchSize();
		const kb = createKB(db, {
			name,
			source_path: isDir || isFile ? resolvedSource : isUrl ? source : undefined,
			source_type: sourceType,
			source_options: serializeAddOptions(options),
			embedding_model: embeddingConfigLabel(embeddingConfig),
		});
		updateKBStatus(db, kb.id, "indexing");
		startIndexingJob(db, kb.id, "add", `Starting indexing for "${name}"`);

		let vectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		let tempVectorFile: string | undefined;
		try {
			const vectorPath = this.vectorPathFor(kb.id);
			tempVectorFile = tempVectorPath(vectorPath);
			const writer = openVectorWriter(tempVectorFile);
			vectorWriter = writer;
			let chunkCount = 0;
			let fileCount = 0;
			const pendingChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			const startedAt = Date.now();
			let latestSkippedTotal = 0;
			let latestSkippedSummary = "none";

			const reportProgress = (
				phase: string,
				processedFiles?: number,
				totalFiles?: number,
				skippedTotal = latestSkippedTotal,
			): void => {
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
				const batch = pendingChunks.splice(0, embeddingBatchSize);
				reportProgress(`Embedding batch of ${batch.length}`, processedFiles, totalFiles);
				const vectors = await embedValidatedDocuments(
					batch.map((chunk) => buildChunkEmbeddingText(chunk)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				assertEmbeddingBatchSize(vectors, batch.length, "add");
				persistEmbeddingMetadata(db, kb.id, embeddingConfig, vectors);
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
				const finalizedChunks = await finalizeChunksForEmbedding(chunks, embeddingConfig, signal);
				pendingChunks.push(...finalizedChunks);
				while (pendingChunks.length >= embeddingBatchSize) {
					await flushPending(processedFiles, totalFiles);
				}
			};
			const addSymbols = (content: string, filePath: string, fileType: string): void => {
				insertSymbols(db, kb.id, extractSymbols(content, filePath, fileType));
			};
			const analyzeAndAddSymbols = async (
				content: string,
				filePath: string,
				fileType: string,
			): Promise<Omit<ChunkInsert, "kb_id">[]> => {
				const analysis = await analyzeIndexableContent(content, filePath, fileType);
				insertSymbols(db, kb.id, analysis.symbols);
				return analysis.chunks;
			};

			if (isUrl) {
				const message = `Fetching ${source}...`;
				updateIndexingJob(this.db, kb.id, { phase: "fetching", message });
				onProgress?.(message);
				const chunks = await chunkUrl(source, signal);
				fileCount = 1;
				addSymbols(chunks.map((chunk) => chunk.content).join("\n\n"), source, "html");
				await addChunks(chunks);
			} else if (isFile) {
				const extracted = await extractSourceFileContent(resolvedSource, signal, undefined, access);
				fileCount = 1;
				const chunks = await analyzeAndAddSymbols(extracted.content, resolvedSource, extracted.fileType);
				await addChunks(chunks);
			} else if (isDir) {
				const plan = await planDirectoryScanAsync(resolvedSource, scanOptions, signal);
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
				for await (const file of iterateScannableFilesAsync(resolvedSource, skipped, scanOptions, signal)) {
					if (signal?.aborted) throw new Error("Cancelled");
					const extracted = await extractScannableFileContentOrSkip(file, skipped, signal);
					if (!extracted) {
						latestSkippedTotal = skipped.total;
						continue;
					}
					const chunks = await analyzeAndAddSymbols(extracted.content, file.relPath, extracted.fileType);
					processedFiles++;
					latestSkippedTotal = skipped.total;
					if (chunks.length > 0) fileCount++;
					await addChunks(chunks, processedFiles, plan.files);
					if (processedFiles % 25 === 0) reportProgress("Chunking", processedFiles, plan.files, skipped.total);
				}
				latestSkippedTotal = skipped.total;
				latestSkippedSummary = summarizeSkippedScan(skipped);
				const finalizingMessage = `Scanned ${processedFiles} files, skipped ${skipped.total} (${latestSkippedSummary}), finalizing...`;
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
			} else {
				fileCount = 1;
				if (Buffer.byteLength(source) > MAX_DIRECT_TEXT_BYTES) {
					throw new Error(`Inline text exceeds the ${MAX_DIRECT_TEXT_BYTES}-byte indexing limit`);
				}
				const chunks = await analyzeAndAddSymbols(source, "inline-text", "text");
				await addChunks(chunks);
			}

			await flushPending();
			vectorWriter.close();
			vectorWriter = undefined;
			renameSync(tempVectorFile, vectorPath);
			tempVectorFile = undefined;

			const savedFileCount = isDir ? getFileCount(this.db, kb.id) : fileCount;
			updateKBCounts(this.db, kb.id, chunkCount, savedFileCount);
			markKBIndexed(this.db, kb.id);
			updateKBStatus(this.db, kb.id, "ready");

			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after add: ${kb.id}`);
			const skippedReadySuffix =
				latestSkippedTotal > 0 ? `, skipped ${latestSkippedTotal} (${latestSkippedSummary})` : "";
			const readyMessage = `Ready: ${chunkCount} chunks from ${savedFileCount} files in ${formatDuration(
				Date.now() - startedAt,
			)}${skippedReadySuffix}`;
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
				deleteKB(this.db, kb.id);
				this.deleteVectorFile(kb.id);
			}
			throw e;
		}
	}

	async update(
		nameOrId: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<{ added: number; removed: number; unchanged: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		throwIfAborted(signal);
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		if (!kb.source_path || (kb.source_type !== "url" && !existsSync(kb.source_path))) {
			throw new Error(`Source path not available or missing: ${kb.source_path}`);
		}
		let sourcePath: string;
		if (kb.source_type === "url") {
			assertNetworkAccess(access);
			sourcePath = kb.source_path;
		} else {
			sourcePath = authorizeExistingPath(kb.source_path, access);
		}
		const updateableKB: UpdateableKnowledgeBase = { ...kb, source_path: sourcePath };

		const activeUpdate = this.activeUpdates.get(updateableKB.id);
		if (activeUpdate) {
			onProgress?.(`Update already running for "${updateableKB.name}"; waiting for the active update.`);
			return activeUpdate;
		}

		const updateRun = this.runExclusive(
			["global:mutation", `kb:${updateableKB.id}`],
			`Mutation for "${updateableKB.name}"`,
			() => this.runUpdate(updateableKB, onProgress, signal, access),
		).finally(() => {
			if (this.activeUpdates.get(updateableKB.id) === updateRun) this.activeUpdates.delete(updateableKB.id);
		});
		this.activeUpdates.set(updateableKB.id, updateRun);
		return updateRun;
	}

	private async runUpdate(
		kb: UpdateableKnowledgeBase,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<{ added: number; removed: number; unchanged: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const scanOptions = toScanOptions(parseAddOptions(kb.source_options), access);
		const embeddingConfig = resolveEmbeddingConfig();
		const embeddingBatchSize = resolveIndexEmbedBatchSize();
		// status bookkeeping only: updated_at must keep pointing at the last fully successful pass, so that an update
		// which then fails cannot have advanced the freshness timestamp merely by starting
		updateKBStatusOnly(this.db, kb.id, "indexing");
		startIndexingJob(this.db, kb.id, "update", `Starting update for "${kb.name}"`);
		const embeddingModel = embeddingConfigLabel(embeddingConfig);
		const compatibility = inspectEmbeddingCompatibility(
			kb.embedding_signature,
			kb.embedding_dimension,
			embeddingConfig,
			kb.embedding_dimension ?? 0,
		);
		let canReuseExistingVectors = compatibility.compatible;
		let rebuildMessage = compatibility.compatible
			? undefined
			: `Embedding vectors for "${kb.name}" are incompatible (${describeEmbeddingCompatibility(compatibility)}); rebuilding all vectors`;
		let replacementVectorPath: string | undefined;
		let addedVectorPath: string | undefined;
		let addedVectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		const insertedChunkIds: string[] = [];
		const stagedSymbols: KnowledgeSymbolInsert[] = [];

		try {
			const vectorPath = this.vectorPathFor(kb.id);
			addedVectorPath = tempVectorPath(`${vectorPath}.added`);
			addedVectorWriter = openVectorWriter(addedVectorPath);
			let latestSkippedTotal = 0;
			let latestSkippedSummary = "none";
			const existingHashes = new Map<string, Array<{ id: string; vectorIndex: number }>>();
			let existingIndex = 0;
			for (const chunk of iterateChunksByKB(this.db, kb.id)) {
				const entries = existingHashes.get(chunk.content_hash) ?? [];
				entries.push({ id: chunk.id, vectorIndex: existingIndex });
				existingHashes.set(chunk.content_hash, entries);
				existingIndex++;
			}
			if (canReuseExistingVectors) {
				const oldVectorReader = openVectorReader(vectorPath);
				try {
					if (
						!oldVectorReader ||
						oldVectorReader.count !== existingIndex ||
						oldVectorReader.dim !== kb.embedding_dimension
					) {
						canReuseExistingVectors = false;
						const vectorCount = oldVectorReader?.count ?? 0;
						const vectorDimension = oldVectorReader?.dim ?? 0;
						rebuildMessage = `Stored vector file for "${kb.name}" is incomplete or incompatible (${vectorCount} vectors/${vectorDimension}d for ${existingIndex} chunks/${kb.embedding_dimension}d); rebuilding all vectors`;
					}
				} finally {
					oldVectorReader?.close();
				}
			}
			const reusableHashes = canReuseExistingVectors
				? existingHashes
				: new Map<string, Array<{ id: string; vectorIndex: number }>>();
			if (!canReuseExistingVectors && rebuildMessage) {
				updateIndexingJob(this.db, kb.id, { phase: "embedding", message: rebuildMessage });
				onProgress?.(rebuildMessage);
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
			let finalEmbeddingDimension: number | undefined;
			const startedAt = Date.now();

			const flushPending = async (): Promise<void> => {
				if (!this.db || !addedVectorWriter || pendingChunks.length === 0) return;
				if (signal?.aborted) throw new Error("Cancelled");
				const batch = pendingChunks.splice(0, embeddingBatchSize);
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
				const newVectors = await embedValidatedDocuments(
					batch.map((c) => buildChunkEmbeddingText(c)),
					signal,
				);
				if (signal?.aborted) throw new Error("Cancelled");
				assertEmbeddingBatchSize(newVectors, batch.length, "update");
				addedVectorWriter.append(newVectors);
				for (let i = 0; i < batch.length; i++) {
					const indexes = newVectorIndexByHash.get(batch[i].content_hash) ?? [];
					indexes.push(addedVectorCount + i);
					newVectorIndexByHash.set(batch[i].content_hash, indexes);
				}
				addedVectorCount += newVectors.length;
				insertedChunkIds.push(...insertChunks(this.db, kb.id, batch));
				addedCount += batch.length;
				// progress bookkeeping: an unfinished pass must not refresh updated_at, which means "last fully successful"
				updateKBCountsOnly(this.db, kb.id, getChunkCount(this.db, kb.id), getFileCount(this.db, kb.id));
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
				const finalizedChunks = await finalizeChunksForEmbedding(chunks, embeddingConfig, signal);
				for (const chunk of finalizedChunks) {
					scannedChunks++;
					const existing = reusableHashes.get(chunk.content_hash);
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
					if (pendingChunks.length >= embeddingBatchSize) await flushPending();
				}
			};

			updateIndexingJob(this.db, kb.id, { phase: "scanning", message: "Scanning source..." });
			onProgress?.("Scanning source...");
			if (kb.source_type === "url") {
				const message = `Fetching ${kb.source_path}...`;
				updateIndexingJob(this.db, kb.id, { phase: "fetching", message });
				onProgress?.(message);
				scannedFiles = 1;
				const chunks = await chunkUrl(kb.source_path, signal);
				stagedSymbols.push(
					...extractSymbols(chunks.map((chunk) => chunk.content).join("\n\n"), kb.source_path, "html"),
				);
				await processChunks(chunks);
			} else if (kb.source_type === "directory") {
				const plan = await planDirectoryScanAsync(kb.source_path, scanOptions, signal);
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
				for await (const file of iterateScannableFilesAsync(kb.source_path, skipped, scanOptions, signal)) {
					if (signal?.aborted) throw new Error("Cancelled");
					const extracted = await extractScannableFileContentOrSkip(file, skipped, signal);
					if (!extracted) {
						for (const chunk of getChunksByFile(this.db, kb.id, file.relPath, 0, Number.MAX_SAFE_INTEGER)) {
							const entries = existingHashes.get(chunk.content_hash);
							const retainedIndex = entries?.findIndex((entry) => entry.id === chunk.id) ?? -1;
							if (!entries || retainedIndex < 0) continue;
							const [retained] = entries.splice(retainedIndex, 1);
							if (canReuseExistingVectors && retained) {
								const indexes = oldVectorIndexByHash.get(chunk.content_hash) ?? [];
								indexes.push(retained.vectorIndex);
								oldVectorIndexByHash.set(chunk.content_hash, indexes);
							}
							unchanged++;
						}
						stagedSymbols.push(...getSymbolsByFile(this.db, kb.id, file.relPath));
						continue;
					}
					const analysis = await analyzeIndexableContent(extracted.content, file.relPath, extracted.fileType);
					scannedFiles++;
					stagedSymbols.push(...analysis.symbols);
					await processChunks(analysis.chunks);
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
				latestSkippedTotal = skipped.total;
				latestSkippedSummary = summarizeSkippedScan(skipped);
				const message = `Scanned ${scannedFiles} files, skipped ${skipped.total} (${latestSkippedSummary}), reconciling deletes...`;
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
				const extracted = await extractSourceFileContent(kb.source_path, signal, undefined, access);
				scannedFiles = 1;
				const analysis = await analyzeIndexableContent(extracted.content, kb.source_path, extracted.fileType);
				stagedSymbols.push(...analysis.symbols);
				await processChunks(analysis.chunks);
			}
			await flushPending();
			addedVectorWriter.close();
			addedVectorWriter = undefined;

			const idsToRemove: string[] = [];
			for (const entries of existingHashes.values()) {
				idsToRemove.push(...entries.map((entry) => entry.id));
			}
			const idsToRemoveSet = new Set(idsToRemove);
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
			const repairMissingVector = async (chunk: Chunk): Promise<Float32Array> => {
				const message = `Re-embedding chunk with missing stored vector: ${chunk.id}`;
				if (!this.db) throw new Error("Engine not initialized");
				updateIndexingJob(this.db, kb.id, {
					phase: "embedding",
					message,
					processed_files: scannedFiles,
					processed_chunks: finalChunkCount,
					added_chunks: addedCount,
					removed_chunks: idsToRemove.length,
					unchanged_chunks: unchanged,
				});
				onProgress?.(message);
				const repairedVectors = await embedDocuments([buildChunkEmbeddingText(chunk)], signal);
				if (signal?.aborted) throw new Error("Cancelled");
				assertEmbeddingBatchSize(repairedVectors, 1, "repair");
				const [repairedVector] = repairedVectors;
				if (!repairedVector) throw new Error(`Embedding provider returned no repaired vector for chunk: ${chunk.id}`);
				return repairedVector;
			};
			try {
				for (const chunk of iterateChunksByKB(this.db, kb.id)) {
					if (signal?.aborted) throw new Error("Cancelled");
					if (idsToRemoveSet.has(chunk.id)) continue;
					const oldVectorIndex = takeVectorIndex(oldVectorIndexByHash, chunk.content_hash);
					const newVectorIndex = takeVectorIndex(newVectorIndexByHash, chunk.content_hash);
					let vector =
						oldVectorReader && oldVectorIndex !== undefined
							? oldVectorReader.read(oldVectorIndex)
							: newVectorReader && newVectorIndex !== undefined
								? newVectorReader.read(newVectorIndex)
								: undefined;
					if (!vector) vector = await repairMissingVector(chunk);
					finalEmbeddingDimension ??= vector.length;
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
			if (idsToRemove.length > 0) deleteChunksByIds(this.db, idsToRemove);
			deleteSymbolsByKB(this.db, kb.id);
			insertSymbols(this.db, kb.id, stagedSymbols);

			updateKBEmbeddingMetadata(
				this.db,
				kb.id,
				embeddingModel,
				finalEmbeddingDimension === undefined ? null : embeddingSignature(embeddingConfig, finalEmbeddingDimension),
				finalEmbeddingDimension ?? null,
			);
			updateKBCounts(this.db, kb.id, finalChunkCount, getFileCount(this.db, kb.id));
			updateKBSourceOptions(this.db, kb.id, serializeAddOptions(parseAddOptions(kb.source_options)));
			markKBIndexed(this.db, kb.id);
			updateKBStatus(this.db, kb.id, "ready");
			const skippedReadySuffix =
				latestSkippedTotal > 0 ? `, skipped ${latestSkippedTotal} (${latestSkippedSummary})` : "";
			const readyMessage = `Ready: +${addedCount} -${idsToRemove.length} =${unchanged}${skippedReadySuffix}`;
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
			if (insertedChunkIds.length > 0) {
				deleteChunksByIds(this.db, insertedChunkIds);
				updateKBCountsOnly(this.db, kb.id, getChunkCount(this.db, kb.id), getFileCount(this.db, kb.id));
			}
			updateKBStatusOnly(this.db, kb.id, isCancellationError(e) ? kb.status : "error");
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

	async search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<SearchResponse> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const requestedMode: SearchMode = options.mode ?? "hybrid";
		if (requestedMode === "auto") {
			const primaryMode = chooseAutoMode(query);
			const modes = [primaryMode, ...fallbackModesFor(primaryMode)];
			const tried: SearchMode[] = [];
			const attemptSummaries: SearchAttemptSummary[] = [];
			const warnings: string[] = [];
			let lastMissResponse: { mode: SearchMode; response: SearchResponse } | undefined;
			let bestWeakResponse: { mode: SearchMode; response: SearchResponse } | undefined;
			for (const mode of modes) {
				if (tried.includes(mode)) continue;
				tried.push(mode);
				throwIfAborted(signal);
				const response = await this.search(query, { ...options, mode }, signal);
				attemptSummaries.push(searchAttemptSummary(mode, response));
				if (response.warnings) warnings.push(...response.warnings);
				if (
					response.miss?.reason === "no_knowledge_bases" ||
					response.miss?.reason === "knowledge_base_not_found" ||
					response.miss?.reason === "no_searchable_knowledge_bases" ||
					response.miss?.reason === "no_indexed_chunks"
				) {
					return {
						...response,
						warnings: warnings.length > 0 ? [...new Set(warnings)] : response.warnings,
						mode_used: mode,
						retry_modes: tried.slice(0, -1),
						miss: { ...response.miss, attempts: attemptSummaries },
					};
				}
				if (!isWeakAutoResponse(query, response, primaryMode, mode)) {
					return {
						...response,
						warnings: warnings.length > 0 ? [...new Set(warnings)] : response.warnings,
						mode_used: mode,
						retry_modes: tried.slice(0, -1),
					};
				}
				if (response.results.length > 0) {
					if (!bestWeakResponse || response.results.length > bestWeakResponse.response.results.length) {
						bestWeakResponse = { mode, response };
					}
				} else {
					lastMissResponse = { mode, response };
				}
				if (tried.length >= 3) break;
			}
			if (lastMissResponse?.response.miss) {
				const attemptedModes = new Set(attemptSummaries.map((attempt) => attempt.mode));
				let action = lastMissResponse.response.miss.action;
				if (action === "try_semantic" && attemptedModes.has("semantic")) {
					action = attemptedModes.has("semantic_hybrid") ? "rephrase" : "try_semantic_hybrid";
				} else if (action === "try_semantic_hybrid" && attemptedModes.has("semantic_hybrid")) {
					action = "rephrase";
				}
				return {
					...lastMissResponse.response,
					warnings: warnings.length > 0 ? [...new Set(warnings)] : lastMissResponse.response.warnings,
					mode_used: lastMissResponse.mode,
					retry_modes: tried.filter((mode) => mode !== lastMissResponse.mode),
					miss: {
						...lastMissResponse.response.miss,
						action,
						attempts: attemptSummaries,
					},
				};
			}
			if (bestWeakResponse) {
				return {
					...bestWeakResponse.response,
					warnings: warnings.length > 0 ? [...new Set(warnings)] : bestWeakResponse.response.warnings,
					mode_used: bestWeakResponse.mode,
					retry_modes: tried.filter((mode) => mode !== bestWeakResponse.mode),
				};
			}
			throw new Error("Auto search exhausted without a result or miss classification");
		}
		const db = this.db;
		const { mode = "hybrid", offset: requestedOffset, kb_id, filters, diversity = "balanced" } = options;
		const resolvedMode = retrievalModeFor(mode);
		const retrievalMode = resolvedMode === "adaptive" ? "hybrid" : resolvedMode;
		const normalizedQuery = normalizedQueryText(query);
		const queryTokens = tokenizeForSimilarity(query);
		const normalizedFileType = normalizeFileTypeFilter(filters?.file_type);

		const warnings: string[] = [];
		const allKBs = listKBs(db);
		const selectedKB = kb_id ? (getKB(db, kb_id) ?? getKBByName(db, kb_id)) : undefined;
		const availableKBs = kb_id ? ([selectedKB].filter(Boolean) as KnowledgeBase[]) : allKBs;
		const kbs = availableKBs.filter((kb) => kb.status === "ready" || kb.status === "stale");
		const kbById = new Map(kbs.map((kb) => [kb.id, kb]));
		for (const kb of availableKBs) {
			if (kb.status !== "ready" && kb.status !== "stale") {
				warnings.push(`"${kb.name}" is ${kb.status}; search skipped until indexing is ready`);
			}
		}
		const tuning = resolveSearchTuning({
			query,
			mode,
			profile: options.profile,
			kbSourceTypes: kbs.map((kb) => kb.source_type),
		});
		const { limit, offset } = resolveSearchWindow(options.limit, requestedOffset, tuning.defaultLimit);
		const candidateLimit = Math.min(
			MAX_SEARCH_WINDOW,
			Math.max(tuning.candidateMin, offset + limit * tuning.candidateMultiplier),
		);
		const retrievalLimitPerKb = candidateLimit;
		const tuningSummary = summarizeSearchTuning(tuning, limit, candidateLimit);
		if (kbs.length === 0) {
			return {
				results: [],
				total_count: 0,
				has_more: false,
				warnings: warnings.length > 0 ? warnings : undefined,
				mode_used: mode,
				tuning: tuningSummary,
				miss: classifySearchMiss({
					allKnowledgeBases: allKBs,
					availableKnowledgeBases: availableKBs,
					searchedKnowledgeBases: kbs,
					requestedKbId: kb_id,
					mode,
					fileType: filters?.file_type,
					pathPattern: filters?.path_pattern,
					minimumScore: tuning.minHybridScore,
					offset,
					retrievedCandidates: 0,
					thresholdCandidates: 0,
					eligibleCandidates: 0,
					filteredCandidates: 0,
					rankedCandidates: 0,
					totalResults: 0,
					embeddingIncompatibleCount: 0,
				}),
			};
		}

		const allResults: { chunkId: string; score: number }[] = [];
		const vectorsByChunkId = new Map<string, Float32Array>();
		let queryEmbedding: { vector: Float32Array; config: EmbeddingConfig } | undefined;
		const embeddingIncompatibleKbIds = new Set<string>();

		for (const kb of kbs) {
			throwIfAborted(signal);
			if (kb.chunk_count === 0) continue;
			const vectorPath = this.vectorPathFor(kb.id);

			if (retrievalMode === "fast") {
				allResults.push(
					...searchBM25(db, normalizedQuery || query, retrievalLimitPerKb, kb.id, { allowOrFallback: false }).map(
						(result) => ({
							...result,
							score: result.score * kbTrustMultiplier(kb),
						}),
					),
				);
			} else if (retrievalMode === "semantic") {
				queryEmbedding ??= await embedQueryWithConfig(query, signal);
				const { vector: queryVec, config: queryEmbeddingConfig } = queryEmbedding;
				throwIfAborted(signal);
				const compatibility = inspectEmbeddingCompatibility(
					kb.embedding_signature,
					kb.embedding_dimension,
					queryEmbeddingConfig,
					queryVec.length,
				);
				if (!compatibility.compatible) {
					embeddingIncompatibleKbIds.add(kb.id);
					warnings.push(embeddingMismatchWarning(kb, compatibility));
					continue;
				}
				const vectorResults = searchVectorFile(
					queryVec,
					vectorPath,
					iterateChunkIdsByKB(db, kb.id),
					retrievalLimitPerKb,
					signal,
				);
				allResults.push(
					...vectorResults.results.map((result) => ({ ...result, score: result.score * kbTrustMultiplier(kb) })),
				);
				for (const [chunkId, vector] of vectorResults.vectorsByChunkId) vectorsByChunkId.set(chunkId, vector);
			} else {
				const semanticHybrid = retrievalMode === "semantic_hybrid";
				const bm25Results = searchBM25(db, normalizedQuery || query, retrievalLimitPerKb, kb.id);
				if (bm25Results.length === 0 && !semanticHybrid) continue;

				let vecResults: { chunkId: string; score: number }[] = [];
				queryEmbedding ??= await embedQueryWithConfig(query, signal);
				const { vector: queryVec, config: queryEmbeddingConfig } = queryEmbedding;
				throwIfAborted(signal);
				const compatibility = inspectEmbeddingCompatibility(
					kb.embedding_signature,
					kb.embedding_dimension,
					queryEmbeddingConfig,
					queryVec.length,
				);
				if (compatibility.compatible) {
					const vectorResults = searchVectorFile(
						queryVec,
						vectorPath,
						iterateChunkIdsByKB(db, kb.id),
						retrievalLimitPerKb,
						signal,
					);
					vecResults = vectorResults.results;
					for (const [chunkId, vector] of vectorResults.vectorsByChunkId) vectorsByChunkId.set(chunkId, vector);
				} else {
					embeddingIncompatibleKbIds.add(kb.id);
					warnings.push(embeddingMismatchWarning(kb, compatibility));
				}
				const fused = weightedScoreFusion(bm25Results, vecResults);
				allResults.push(...fused.map((result) => ({ ...result, score: result.score * kbTrustMultiplier(kb) })));
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
			throwIfAborted(signal);
			const chunk = getChunkById(db, result.chunkId);
			if (chunk) {
				const ranking = scoreChunkForQuery(result.score, chunk, queryTokens);
				rankingByChunkId.set(result.chunkId, ranking);
				result.score = ranking.adjusted_score;
			}
		}
		let thresholded = unique.filter((result) => rankingByChunkId.has(result.chunkId));
		if (retrievalMode !== "fast" && retrievalMode !== "semantic") {
			thresholded = thresholded.filter((result) => result.score >= tuning.minHybridScore);
		}
		const thresholdCandidates = thresholded.length;
		let eligible = thresholded;
		if (retrievalMode === "fast") {
			eligible = thresholded.filter((result) => {
				const chunk = getChunkById(db, result.chunkId);
				return chunk ? hasAnyLexicalEvidence(buildChunkEmbeddingText(chunk), queryTokens) : false;
			});
		} else if (retrievalMode !== "semantic" && retrievalMode !== "semantic_hybrid") {
			eligible = thresholded.filter((result) => {
				const chunk = getChunkById(db, result.chunkId);
				return chunk ? hasEnoughLexicalEvidence(chunk, queryTokens) : false;
			});
		}
		eligible.sort((a, b) => b.score - a.score);
		const eligibleCandidates = eligible.length;

		// Apply metadata filters post-retrieval
		let filtered = eligible;
		if (normalizedFileType || filters?.path_pattern) {
			filtered = eligible.filter((r) => {
				const chunk = getChunkById(db, r.chunkId);
				if (!chunk) return false;
				if (normalizedFileType && chunk.file_type !== normalizedFileType) return false;
				if (filters?.path_pattern && !chunk.file_path.includes(filters.path_pattern)) return false;
				return true;
			});
		}
		const candidatePool = filtered.slice(0, candidateLimit);
		const candidatePoolTruncated = candidatePool.length < filtered.length;
		const candidateIds = new Set(candidatePool.map((candidate) => candidate.chunkId));
		for (const chunkId of vectorsByChunkId.keys()) {
			if (!candidateIds.has(chunkId)) vectorsByChunkId.delete(chunkId);
		}

		if (mode === "deep" && candidatePool.length > 0) {
			const candidates = candidatePool
				.slice(0, tuning.deepRerankCandidates)
				.map((r) => {
					const chunk = getChunkById(db, r.chunkId);
					return chunk ? { chunkId: r.chunkId, content: chunk.content } : null;
				})
				.filter(Boolean) as Array<{ chunkId: string; content: string }>;
			const reranked = await rerank(
				query,
				candidates,
				Math.max(limit * tuning.deepRerankTopKMultiplier, limit),
				signal,
			);
			const ranked: RankedChunk[] = [];
			for (const r of reranked) {
				throwIfAborted(signal);
				const chunk = getChunkById(db, r.chunkId);
				if (!chunk) continue;
				const kbObj = getKB(db, chunk.kb_id);
				ranked.push({
					chunk,
					kbName: kbObj?.name ?? "unknown",
					ranking: scoreChunkForQuery(r.score, chunk, queryTokens),
					score: r.score,
					content: chunk.content,
					snippet: buildQuerySnippet(chunk.content, query, tuning.snippetMaxLength),
					startLine: chunk.start_line,
					endLine: chunk.end_line,
					sourceChunkIds: [chunk.id],
				});
			}
			const diversified = interleaveByFile(
				await diversifyRankedChunks(ranked, diversity, vectorsByChunkId, signal),
				diversity,
				signal,
			);
			const page = diversified.slice(offset, offset + limit);
			const results = page.map((r) => {
				const kb = kbById.get(r.chunk.kb_id);
				const stale = kb?.status === "stale";
				return {
					content: r.content,
					file_path: r.chunk.file_path,
					file_type: r.chunk.file_type,
					kb_name: r.kbName,
					score: r.score,
					ranking: r.ranking,
					snippet: r.snippet,
					start_line: r.startLine,
					end_line: r.endLine,
					provenance: {
						chunk_id: r.chunk.id,
						chunk_hash: r.chunk.content_hash,
						indexed_at: r.chunk.indexed_at,
						stale,
						match_reason: matchReasonFor(mode),
						source_chunk_ids: r.sourceChunkIds,
					},
				};
			});
			const deepTuning: SearchTuningSummary = {
				...tuningSummary,
				retrieved_candidates: unique.length,
				threshold_candidates: thresholdCandidates,
				eligible_candidates: eligibleCandidates,
				filtered_candidates: filtered.length,
				diversity_candidates: ranked.length,
				candidate_pool_truncated: candidatePoolTruncated,
			};
			return {
				results,
				total_count: diversified.length,
				has_more: offset + limit < diversified.length,
				warnings: warnings.length > 0 ? warnings : undefined,
				mode_used: mode,
				tuning: deepTuning,
				miss:
					results.length === 0
						? classifySearchMiss({
								allKnowledgeBases: allKBs,
								availableKnowledgeBases: availableKBs,
								searchedKnowledgeBases: kbs,
								requestedKbId: kb_id,
								mode,
								fileType: filters?.file_type,
								pathPattern: filters?.path_pattern,
								minimumScore: tuning.minHybridScore,
								offset,
								retrievedCandidates: unique.length,
								thresholdCandidates,
								eligibleCandidates,
								filteredCandidates: filtered.length,
								rankedCandidates: ranked.length,
								totalResults: diversified.length,
								embeddingIncompatibleCount: embeddingIncompatibleKbIds.size,
							})
						: undefined,
			};
		}

		const ranked: RankedChunk[] = [];
		for (const r of candidatePool) {
			throwIfAborted(signal);
			const chunk = getChunkById(db, r.chunkId);
			if (!chunk) continue;
			const kb = getKB(db, chunk.kb_id);

			if (mode === "adaptive") {
				const contextChunks = getChunksByFile(
					db,
					chunk.kb_id,
					chunk.file_path,
					Math.max(1, chunk.start_line - tuning.adaptiveContextLines),
					chunk.end_line + tuning.adaptiveContextLines,
				);
				const context = buildAdaptiveContext(chunk, contextChunks.length > 0 ? contextChunks : [chunk], queryTokens, {
					maxContextChars: tuning.adaptiveMaxContextChars,
					neighborTarget: tuning.adaptiveNeighborTarget,
				});
				pushAdaptiveCandidate(ranked, {
					chunk,
					kbName: kb?.name ?? "unknown",
					ranking: rankingByChunkId.get(r.chunkId),
					score: r.score,
					content: context.content,
					snippet: buildQuerySnippet(context.content, query, tuning.snippetMaxLength),
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
					snippet: buildQuerySnippet(chunk.content, query, tuning.snippetMaxLength),
					startLine: chunk.start_line,
					endLine: chunk.end_line,
					sourceChunkIds: [chunk.id],
				});
			}
		}

		const diversified = interleaveByFile(
			await diversifyRankedChunks(ranked, diversity, vectorsByChunkId, signal),
			diversity,
			signal,
		);
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
			provenance: (() => {
				const kb = kbById.get(r.chunk.kb_id);
				const stale = kb?.status === "stale";
				return {
					chunk_id: r.chunk.id,
					chunk_hash: r.chunk.content_hash,
					indexed_at: r.chunk.indexed_at,
					stale,
					match_reason: matchReasonFor(mode),
					source_chunk_ids: r.sourceChunkIds,
				};
			})(),
		}));
		const responseTuning: SearchTuningSummary = {
			...tuningSummary,
			retrieved_candidates: unique.length,
			threshold_candidates: thresholdCandidates,
			eligible_candidates: eligibleCandidates,
			filtered_candidates: filtered.length,
			diversity_candidates: ranked.length,
			candidate_pool_truncated: candidatePoolTruncated,
		};

		return {
			results,
			total_count: total,
			has_more: offset + limit < total,
			warnings: warnings.length > 0 ? warnings : undefined,
			mode_used: mode,
			tuning: responseTuning,
			miss:
				results.length === 0
					? classifySearchMiss({
							allKnowledgeBases: allKBs,
							availableKnowledgeBases: availableKBs,
							searchedKnowledgeBases: kbs,
							requestedKbId: kb_id,
							mode,
							fileType: filters?.file_type,
							pathPattern: filters?.path_pattern,
							minimumScore: tuning.minHybridScore,
							offset,
							retrievedCandidates: unique.length,
							thresholdCandidates,
							eligibleCandidates,
							filteredCandidates: filtered.length,
							rankedCandidates: ranked.length,
							totalResults: total,
							embeddingIncompatibleCount: embeddingIncompatibleKbIds.size,
						})
					: undefined,
		};
	}

	remove(nameOrId: string): boolean {
		if (!this.db) return false;
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		if (this.activeMutations.size > 0) throw new Error("A knowledge-base mutation is already running");
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) return false;
		deleteKB(this.db, kb.id);
		this.deleteVectorFile(kb.id);
		return true;
	}

	list(signal?: AbortSignal, limit?: number): KnowledgeBase[] {
		if (!this.db) return [];
		throwIfAborted(signal);
		return listKBs(this.db, limit);
	}

	clear(): void {
		if (!this.db) return;
		if (this.disposing) throw new Error("Knowledge engine is shutting down");
		if (this.activeMutations.size > 0) throw new Error("A knowledge-base mutation is already running");
		for (const kb of listKBs(this.db)) {
			deleteKB(this.db, kb.id);
			this.deleteVectorFile(kb.id);
		}
	}

	diagnose(signal?: AbortSignal): DiagnosticResult[] {
		if (!this.db) return [];
		throwIfAborted(signal);
		const db = this.db;
		return listKBs(db).map((kb) => {
			throwIfAborted(signal);
			return diagnoseKB(db, kb, signal);
		});
	}

	async diagnoseAsync(
		signal?: AbortSignal,
		knowledgeBasesOverride?: KnowledgeBase[],
		maxDiagnosticPaths = Number.POSITIVE_INFINITY,
	): Promise<DiagnosticResult[]> {
		if (!this.db) return [];
		throwIfAborted(signal);
		const db = this.db;
		const diagnostics: DiagnosticResult[] = [];
		let remainingPaths = maxDiagnosticPaths;
		for (const kb of knowledgeBasesOverride ?? listKBs(db)) {
			throwIfAborted(signal);
			const diagnostic = await diagnoseKBAsync(db, kb, signal, Math.max(0, remainingPaths));
			diagnostics.push(diagnostic);
			remainingPaths = Math.max(0, remainingPaths - diagnostic.stale_files.length - diagnostic.orphan_files.length);
		}
		return diagnostics;
	}

	statusSnapshot(
		signal?: AbortSignal,
		diagnosticsOverride?: DiagnosticResult[],
		knowledgeBasesOverride?: KnowledgeBase[],
	): KnowledgeStatusSnapshot {
		if (!this.db) return { knowledge_bases: [], diagnostics: [], embeddings: [] };
		throwIfAborted(signal);
		const db = this.db;
		const knowledgeBases = knowledgeBasesOverride ?? listKBs(db);
		const diagnostics =
			diagnosticsOverride ??
			knowledgeBases.map((kb) => {
				throwIfAborted(signal);
				return diagnoseKB(db, kb, signal);
			});
		try {
			const config = resolveEmbeddingConfig();
			const activeModel = embeddingConfigLabel(config);
			const activeDecoration = describeEmbeddingDecoration(config);
			return {
				knowledge_bases: knowledgeBases,
				diagnostics,
				embeddings: knowledgeBases.map((kb) => {
					const compatibility = inspectEmbeddingCompatibility(
						kb.embedding_signature,
						kb.embedding_dimension,
						config,
						kb.embedding_dimension ?? 0,
					);
					return {
						kb_id: kb.id,
						kb_name: kb.name,
						indexed_model: kb.embedding_model,
						active_model: activeModel,
						active_decoration: activeDecoration,
						compatibility,
						detail: describeEmbeddingCompatibility(compatibility),
					};
				}),
			};
		} catch (error) {
			return {
				knowledge_bases: knowledgeBases,
				diagnostics,
				embeddings: [],
				embedding_error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async statusSnapshotAsync(
		signal?: AbortSignal,
		maxKnowledgeBases = Number.POSITIVE_INFINITY,
		maxDiagnosticPaths = Number.POSITIVE_INFINITY,
	): Promise<KnowledgeStatusSnapshot> {
		if (!this.db) return { knowledge_bases: [], diagnostics: [], embeddings: [] };
		const knowledgeBases = listKBs(this.db, Number.isFinite(maxKnowledgeBases) ? maxKnowledgeBases + 1 : undefined);
		if (knowledgeBases.length > maxKnowledgeBases) {
			throw new Error(`Knowledge status exceeds the ${maxKnowledgeBases}-knowledge-base RPC limit`);
		}
		return this.statusSnapshot(
			signal,
			await this.diagnoseAsync(signal, knowledgeBases, maxDiagnosticPaths),
			knowledgeBases,
		);
	}

	symbolSearch(query: string, options: SymbolSearchOptions = {}, signal?: AbortSignal): SymbolSearchResponse {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const db = this.db;
		const allKBs = listKBs(db);
		const selectedKB = options.kb_id ? (getKB(db, options.kb_id) ?? getKBByName(db, options.kb_id)) : undefined;
		const availableKBs = options.kb_id ? ([selectedKB].filter(Boolean) as KnowledgeBase[]) : allKBs;
		const searchedKBs = availableKBs.filter((kb) => kb.status === "ready" || kb.status === "stale");
		const limit = Math.max(1, Math.min(200, options.limit ?? 20));
		const offset = Math.max(0, options.offset ?? 0);
		if (searchedKBs.length === 0) {
			return {
				results: [],
				total_count: 0,
				has_more: false,
				miss: classifySymbolSearchMiss({
					allKnowledgeBases: allKBs,
					availableKnowledgeBases: availableKBs,
					searchedKnowledgeBases: searchedKBs,
					requestedKbId: options.kb_id,
					kind: options.kind,
					filePattern: options.file_pattern,
					exact: options.exact === true,
					offset,
					totalResults: 0,
					indexedSymbols: 0,
					unfilteredMatches: 0,
				}),
			};
		}
		const symbolOptions = {
			kbId: selectedKB?.id,
			kind: options.kind,
			filePattern: options.file_pattern,
			exact: options.exact,
		};
		const symbols = searchSymbols(db, query, {
			...symbolOptions,
			limit: limit + 1,
			offset,
		});
		throwIfAborted(signal);
		const page = symbols.slice(0, limit);
		const total = countSymbols(db, query, symbolOptions);
		throwIfAborted(signal);
		const results = page.map((symbol) => {
			const kb = getKB(db, symbol.kb_id);
			return {
				name: symbol.name,
				kind: symbol.kind,
				file_path: symbol.file_path,
				file_type: symbol.file_type,
				kb_name: kb?.name ?? "unknown",
				start_line: symbol.start_line,
				end_line: symbol.end_line,
				signature: symbol.signature ?? undefined,
				container_name: symbol.container_name ?? undefined,
				text: symbol.text,
				indexed_at: symbol.indexed_at,
			};
		});
		let miss: SymbolSearchMiss | undefined;
		if (results.length === 0) {
			const indexedSymbols = countSymbols(db, "", { kbId: selectedKB?.id });
			const unfilteredMatches =
				total === 0 && (options.kind || options.file_pattern)
					? countSymbols(db, query, { kbId: selectedKB?.id, exact: options.exact })
					: total;
			throwIfAborted(signal);
			miss = classifySymbolSearchMiss({
				allKnowledgeBases: allKBs,
				availableKnowledgeBases: availableKBs,
				searchedKnowledgeBases: searchedKBs,
				requestedKbId: options.kb_id,
				kind: options.kind,
				filePattern: options.file_pattern,
				exact: options.exact === true,
				offset,
				totalResults: total,
				indexedSymbols,
				unfilteredMatches,
			});
		}
		return {
			results,
			total_count: total,
			has_more: symbols.length > limit,
			miss,
		};
	}

	doctor(
		signal?: AbortSignal,
		diagnosticsOverride?: DiagnosticResult[],
		knowledgeBasesOverride?: KnowledgeBase[],
	): DoctorReport {
		throwIfAborted(signal);
		const diagnostics = diagnosticsOverride ?? this.diagnose(signal);
		const issues: DoctorIssue[] = [];
		const kbs = knowledgeBasesOverride ?? this.list();
		if (kbs.length === 0) {
			issues.push({
				severity: "blocking",
				message: "No knowledge bases are indexed.",
				action: "Run knowledge_add for the project root or relevant source/docs directory.",
				action_code: "rebuild_kb",
			});
		}

		for (const diagnostic of diagnostics) {
			throwIfAborted(signal);
			if (diagnostic.stuck_indexing) {
				const phase = diagnostic.job ? ` during ${diagnostic.job.phase}` : "";
				issues.push({
					severity: "blocking",
					kb_name: diagnostic.kb_name,
					message: `Indexing appears stuck${phase} for ${formatDuration(diagnostic.last_progress_age_ms)}.`,
					action:
						"Check knowledge_status for the last progress message. If no Pi process is actively indexing it, remove and rebuild this KB.",
					action_code: "wait_for_indexing",
				});
			}
			if (diagnostic.status === "error") {
				issues.push({
					severity: "blocking",
					kb_name: diagnostic.kb_name,
					message: "Knowledge base is in error state and is skipped by search.",
					action: "Run knowledge_remove and knowledge_add to rebuild it from the source.",
					action_code: "rebuild_kb",
				});
			}
			if (diagnostic.scan_error) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `Source diagnostics scan failed: ${diagnostic.scan_error}`,
					action: "Check source accessibility and scanner limits, then run knowledge_doctor again.",
					action_code: "check_source",
				});
			} else if (diagnostic.coverage_percent < 80) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `Coverage is ${diagnostic.coverage_percent}% (${diagnostic.indexed_files}/${diagnostic.total_source_files} files).`,
					action: "Review skipped files and source path. Rebuild if index-time rules changed.",
					action_code: "review_skipped_scope",
				});
			}
			const staleFileCount = diagnostic.stale_file_count ?? diagnostic.stale_files.length;
			if (staleFileCount > 0) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `${staleFileCount} files changed after indexing.`,
					action: "Run knowledge_update for this KB.",
					action_code: "run_update",
				});
			}
			const orphanFileCount = diagnostic.orphan_file_count ?? diagnostic.orphan_files.length;
			if (orphanFileCount > 0) {
				issues.push({
					severity: "warning",
					kb_name: diagnostic.kb_name,
					message: `${orphanFileCount} indexed files no longer exist in the source.`,
					action: "Run knowledge_update or rebuild the KB.",
					action_code: "run_update",
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
					action_code: "review_skipped_scope",
				});
			}
		}

		if (this.db) {
			let activeEmbeddingConfig: EmbeddingConfig | undefined;
			try {
				activeEmbeddingConfig = resolveEmbeddingConfig();
			} catch (error) {
				issues.push({
					severity: "blocking",
					message: `Active embedding configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
					action: "Correct the embedding environment variables, then run knowledge_doctor again.",
					action_code: "fix_embedding_config",
				});
			}
			for (const kb of kbs) {
				throwIfAborted(signal);
				if (activeEmbeddingConfig && (kb.status === "ready" || kb.status === "stale") && kb.chunk_count > 0) {
					const compatibility = inspectEmbeddingCompatibility(
						kb.embedding_signature,
						kb.embedding_dimension,
						activeEmbeddingConfig,
						kb.embedding_dimension ?? 0,
					);
					if (!compatibility.compatible) {
						const canUpdate = kb.source_path !== null && kb.source_type !== "text";
						issues.push({
							severity: "warning",
							kb_name: kb.name,
							message: `This KB's vectors are incompatible with the active embedding configuration: ${describeEmbeddingCompatibility(compatibility)}.`,
							action: canUpdate
								? "Run knowledge_update to rebuild vectors with the active embedding configuration."
								: "Re-add inline text or re-import the original source with the active embedding configuration.",
							action_code: "rebuild_vectors",
						});
					}
				}
				if (
					(kb.status === "ready" || kb.status === "stale") &&
					(storedSourcePolicyVersion(kb.source_options, "embedding_input_policy") ?? 0) < CURRENT_EMBEDDING_INPUT_POLICY
				) {
					const canUpdate = kb.source_path !== null && kb.source_type !== "text";
					issues.push({
						severity: "warning",
						kb_name: kb.name,
						message:
							"This KB predates embedding-safe chunk limits, so oversized chunk tails may be missing from vector retrieval.",
						action: canUpdate
							? "Run knowledge_update to re-chunk oversized inputs with the current embedding budget."
							: "Re-add inline text or re-import the original source to rebuild chunks with the current embedding budget.",
						action_code: "reindex_for_embedding_budget",
					});
				}
				if (
					kb.source_type === "url" &&
					(kb.status === "ready" || kb.status === "stale") &&
					(storedSourcePolicyVersion(kb.source_options, "url_structure_policy") ?? 0) < CURRENT_URL_STRUCTURE_POLICY
				) {
					issues.push({
						severity: "warning",
						kb_name: kb.name,
						message: "This URL KB predates structure-preserving HTML normalization.",
						action: "Run knowledge_update to rebuild URL headings, sections, lists, tables, and entities.",
						action_code: "run_update",
					});
				}
				if (kb.status === "ready" && kb.chunk_count > 0 && getSymbolCount(this.db, kb.id) === 0) {
					issues.push({
						severity: "info",
						kb_name: kb.name,
						message: "No lightweight symbols are indexed for this KB.",
						action: "Run knowledge_update to rebuild symbol/config/heading lookup metadata.",
						action_code: "run_update",
					});
				}
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
			actions: issues.map((issue) => ({
				code: issue.action_code ?? "none",
				kb_name: issue.kb_name,
				target: issue.kb_name,
				description: issue.action,
			})),
		};
	}

	async doctorAsync(
		signal?: AbortSignal,
		maxKnowledgeBases = Number.POSITIVE_INFINITY,
		maxDiagnosticPaths = Number.POSITIVE_INFINITY,
	): Promise<DoctorReport> {
		if (!this.db) return this.doctor(signal, [], []);
		const knowledgeBases = listKBs(this.db, Number.isFinite(maxKnowledgeBases) ? maxKnowledgeBases + 1 : undefined);
		if (knowledgeBases.length > maxKnowledgeBases) {
			throw new Error(`Knowledge doctor exceeds the ${maxKnowledgeBases}-knowledge-base RPC limit`);
		}
		return this.doctor(signal, await this.diagnoseAsync(signal, knowledgeBases, maxDiagnosticPaths), knowledgeBases);
	}

	async exportKB(
		nameOrId: string,
		outputPath: string,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
		access?: FilesystemAccessPolicy,
	): Promise<number> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		return this.runExclusive(["global:mutation", `kb:${kb.id}`], `Operation for "${kb.name}"`, () =>
			this.exportKBUnlocked(kb, outputPath, signal, onProgress, access),
		);
	}

	private async exportKBUnlocked(
		kb: KnowledgeBase,
		outputPath: string,
		signal?: AbortSignal,
		onProgress?: ProgressCallback,
		access?: FilesystemAccessPolicy,
	): Promise<number> {
		if (!this.db) throw new Error("Engine not initialized");
		if (kb.chunk_count > MAX_EXPORT_CHUNKS) {
			throw new Error(`Export exceeds the ${MAX_EXPORT_CHUNKS}-chunk limit`);
		}
		const target = prepareSafeNewFile(authorizeOutputPath(outputPath, access));
		let tempFd: number | undefined;
		let tempDevice: number;
		let tempInode: number;
		try {
			tempFd = openSync(
				target.tempPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			const opened = fstatSync(tempFd);
			if (!opened.isFile()) throw new Error(`Export target is not a regular file: ${target.tempPath}`);
			tempDevice = opened.dev;
			tempInode = opened.ino;
			assertOpenedPathAuthorized(target.tempPath, tempDevice, tempInode, access);
			assertOutputPathAuthorized(target.outputPath, target.parentDevice, target.parentInode, access);
		} catch (error) {
			if (tempFd !== undefined) closeSync(tempFd);
			throw error;
		}
		const stream = createWriteStream("", {
			autoClose: false,
			encoding: "utf-8",
			fd: tempFd,
		}) as WriteStream & { fd: number | null };
		const progressBatchSize = resolveIndexEmbedBatchSize();
		let count = 0;
		let bytes = 0;
		const deadline = Date.now() + MAX_EXPORT_DURATION_MS;
		const writeBoundedLine = async (line: string): Promise<void> => {
			if (Date.now() > deadline) throw new Error(`Export exceeded ${MAX_EXPORT_DURATION_MS}ms`);
			const lineBytes = Buffer.byteLength(line) + 1;
			if (bytes + lineBytes > MAX_EXPORT_BYTES) {
				throw new Error(`Export exceeds the ${MAX_EXPORT_BYTES}-byte limit`);
			}
			bytes += lineBytes;
			await writeLine(stream, line);
		};
		const header = JSON.stringify({
			name: kb.name,
			description: kb.description,
			source_type: "text",
			chunk_count: kb.chunk_count,
		});
		try {
			await writeBoundedLine(header);
			for (const chunk of iterateChunksByKB(this.db, kb.id)) {
				throwIfAborted(signal);
				const line = JSON.stringify({
					content: chunk.content,
					file_path: chunk.file_path,
					file_type: chunk.file_type,
					start_line: chunk.start_line,
					end_line: chunk.end_line,
					metadata_json: chunk.metadata_json,
				});
				await writeBoundedLine(line);
				count++;
				if (count % progressBatchSize === 0) onProgress?.(`Exported ${count}/${kb.chunk_count} chunks...`);
			}
			await finishWriteStream(stream);
			throwIfAborted(signal);
			fsyncSync(tempFd);
			if (stream.fd === tempFd) stream.fd = null;
			closeSync(tempFd);
			tempFd = undefined;
			stream.destroy();
			assertOpenedPathAuthorized(target.tempPath, tempDevice, tempInode, access);
			assertOutputPathAuthorized(target.outputPath, target.parentDevice, target.parentInode, access);
			publishNewFile(target.tempPath, target);
			onProgress?.(`Exported ${count}/${kb.chunk_count} chunks.`);
			return count;
		} catch (error) {
			if (tempFd !== undefined) {
				const descriptor = tempFd;
				tempFd = undefined;
				if (stream.fd === descriptor) stream.fd = null;
				try {
					closeSync(descriptor);
				} catch (closeError) {
					if ((closeError as NodeJS.ErrnoException).code !== "EBADF") {
						console.error(`Failed to close export descriptor: ${String(closeError)}`);
					}
				}
			}
			stream.destroy();
			try {
				const current = lstatSync(target.tempPath);
				if (!current.isSymbolicLink() && current.dev === tempDevice && current.ino === tempInode) {
					assertOpenedPathAuthorized(target.tempPath, tempDevice, tempInode, access);
					rmSync(target.tempPath, { force: true });
				}
			} catch {
				// Leave an unverified path untouched rather than deleting outside the authorized root.
			}
			throw error;
		}
	}

	async importKB(
		inputPath: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		return this.runExclusive("global:mutation", "Knowledge-base import", () =>
			this.importKBUnlocked(inputPath, onProgress, signal, access),
		);
	}

	private async importKBUnlocked(
		inputPath: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
		access?: FilesystemAccessPolicy,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		throwIfAborted(signal);
		const embeddingConfig = resolveEmbeddingConfig();
		const embeddingBatchSize = resolveIndexEmbedBatchSize();
		inputPath = authorizeExistingPath(inputPath, access);
		const directInput = lstatSync(inputPath);
		if (directInput.isSymbolicLink() || !directInput.isFile()) {
			throw new Error(`Import source is not a regular non-symlink file: ${inputPath}`);
		}
		const inputFd = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const inputInfo = fstatSync(inputFd);
		if (inputInfo.dev !== directInput.dev || inputInfo.ino !== directInput.ino) {
			closeSync(inputFd);
			throw new Error(`Import source changed while opening: ${inputPath}`);
		}
		if (!inputInfo.isFile()) {
			closeSync(inputFd);
			throw new Error(`Import source is not a regular file: ${inputPath}`);
		}
		try {
			assertOpenedPathAuthorized(inputPath, inputInfo.dev, inputInfo.ino, access);
		} catch (error) {
			closeSync(inputFd);
			throw error;
		}
		if (inputInfo.size > MAX_IMPORT_BYTES) {
			closeSync(inputFd);
			throw new Error(`Import file exceeds the ${MAX_IMPORT_BYTES}-byte limit: ${inputPath}`);
		}
		const stream = createReadStream("", { autoClose: true, encoding: "utf-8", fd: inputFd });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		let observedBytes = 0;
		let observedLineBytes = 0;
		stream.on("data", (chunk: string | Buffer) => {
			observedBytes += Buffer.byteLength(String(chunk));
			if (observedBytes > MAX_IMPORT_BYTES) {
				stream.destroy(new Error(`Import exceeds the ${MAX_IMPORT_BYTES}-byte limit`));
				return;
			}
			const parts = String(chunk).split("\n");
			if (parts.length === 1) {
				observedLineBytes += Buffer.byteLength(parts[0] ?? "");
			} else {
				observedLineBytes += Buffer.byteLength(parts[0] ?? "");
				for (let index = 1; index < parts.length - 1; index++) {
					if (Buffer.byteLength(parts[index] ?? "") > MAX_IMPORT_LINE_BYTES) {
						stream.destroy(new Error(`Import line exceeds the ${MAX_IMPORT_LINE_BYTES}-byte limit`));
						return;
					}
				}
				observedLineBytes = Buffer.byteLength(parts.at(-1) ?? "");
			}
			if (observedLineBytes > MAX_IMPORT_LINE_BYTES) {
				stream.destroy(new Error(`Import line exceeds the ${MAX_IMPORT_LINE_BYTES}-byte limit`));
			}
		});
		let header: ImportHeader | undefined;
		let kb: KnowledgeBase | undefined;
		let vectorWriter: ReturnType<typeof openVectorWriter> | undefined;
		let tempVectorFile: string | undefined;
		let inserted = 0;
		let lineNumber = 0;
		const pendingChunks: ChunkInsert[] = [];
		const pendingSymbols: ReturnType<typeof extractSymbols> = [];

		const flushPending = async (): Promise<void> => {
			if (!this.db || !kb || !vectorWriter || pendingChunks.length === 0) return;
			throwIfAborted(signal);
			const batch = pendingChunks.splice(0, embeddingBatchSize);
			const symbols = pendingSymbols.splice(0);
			const total = header?.chunk_count;
			const message = `Embedding import batch: ${inserted}/${total ?? "unknown"} chunks stored`;
			updateIndexingJob(this.db, kb.id, {
				phase: "embedding",
				message,
				processed_chunks: inserted,
				total_files: total,
				added_chunks: inserted,
			});
			onProgress?.(message);
			const vectors = await embedValidatedDocuments(
				batch.map((chunk) => buildChunkEmbeddingText(chunk)),
				signal,
			);
			throwIfAborted(signal);
			assertEmbeddingBatchSize(vectors, batch.length, "import");
			persistEmbeddingMetadata(this.db, kb.id, embeddingConfig, vectors);
			insertChunks(this.db, kb.id, batch);
			insertSymbols(this.db, kb.id, symbols);
			vectorWriter.append(vectors);
			inserted += batch.length;
			updateKBCounts(this.db, kb.id, inserted, getFileCount(this.db, kb.id));
			updateIndexingJob(this.db, kb.id, {
				phase: "storing",
				message: `Stored import batch: ${inserted}/${total ?? "unknown"} chunks`,
				processed_chunks: inserted,
				total_files: total,
				added_chunks: inserted,
			});
		};

		try {
			for await (const rawLine of lines) {
				throwIfAborted(signal);
				lineNumber++;
				if (lineNumber > MAX_IMPORT_LINES) throw new Error(`Import exceeds the ${MAX_IMPORT_LINES}-line limit`);
				const line = rawLine.trim();
				if (Buffer.byteLength(rawLine) > MAX_IMPORT_LINE_BYTES) {
					throw new Error(`Import line ${lineNumber} exceeds the ${MAX_IMPORT_LINE_BYTES}-byte limit`);
				}
				if (!line) continue;
				if (!header) {
					const parsedHeader = JSON.parse(line) as unknown;
					if (typeof parsedHeader !== "object" || parsedHeader === null || Array.isArray(parsedHeader)) {
						throw new Error("Import header must be an object");
					}
					const headerRecord = parsedHeader as Record<string, unknown>;
					header = {
						...validateKnowledgeBaseMetadata(headerRecord.name, headerRecord.description),
						chunk_count: headerRecord.chunk_count === undefined ? undefined : (headerRecord.chunk_count as number),
					};
					if (
						header.chunk_count !== undefined &&
						(!Number.isInteger(header.chunk_count) || header.chunk_count < 0 || header.chunk_count > MAX_IMPORT_CHUNKS)
					) {
						throw new Error(`Import header chunk_count must be between 0 and ${MAX_IMPORT_CHUNKS}`);
					}
					const existingKB = getKBByName(this.db, header.name);
					if (existingKB) {
						throw new Error(
							`Knowledge base "${header.name}" already exists. Use knowledge_update to refresh it, or knowledge_remove before importing a replacement.`,
						);
					}
					kb = createKB(this.db, {
						name: header.name,
						description: header.description,
						source_type: "text",
						source_options: serializeAddOptions(),
						embedding_model: embeddingConfigLabel(embeddingConfig),
					});
					updateKBStatus(this.db, kb.id, "indexing");
					startIndexingJob(this.db, kb.id, "import", `Starting import for "${header.name}"`);
					const importMessage = `Importing ${header.chunk_count ?? "unknown"} chunks...`;
					updateIndexingJob(this.db, kb.id, {
						phase: "importing",
						message: importMessage,
						total_files: header.chunk_count,
					});
					onProgress?.(importMessage);
					const vectorPath = this.vectorPathFor(kb.id);
					tempVectorFile = tempVectorPath(vectorPath);
					vectorWriter = openVectorWriter(tempVectorFile);
					continue;
				}
				const imported = parseImportedChunk(JSON.parse(line) as unknown);
				const chunk = importedChunkToInsert(imported);
				chunk.content_tokenized = preTokenizeForFTS(buildChunkEmbeddingText(chunk));
				const finalizedChunks = await finalizeChunksForEmbedding([chunk], embeddingConfig, signal);
				pendingChunks.push(...finalizedChunks);
				if (inserted + pendingChunks.length > MAX_IMPORT_CHUNKS) {
					throw new Error(`Import exceeds the ${MAX_IMPORT_CHUNKS}-chunk limit`);
				}
				pendingSymbols.push(...extractSymbols(imported.content, imported.file_path, imported.file_type));
				while (pendingChunks.length >= embeddingBatchSize) await flushPending();
			}
			if (!header) throw new Error("Empty import file");
			if (!kb || !vectorWriter || !tempVectorFile) throw new Error("Import did not create a knowledge base");
			await flushPending();
			vectorWriter.close();
			vectorWriter = undefined;
			renameSync(tempVectorFile, this.vectorPathFor(kb.id));
			tempVectorFile = undefined;
			updateKBCounts(this.db, kb.id, inserted, getFileCount(this.db, kb.id));
			markKBIndexed(this.db, kb.id);
			updateKBStatus(this.db, kb.id, "ready");
			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after import: ${kb.id}`);
			finishIndexingJob(this.db, kb.id, "succeeded", `Ready: imported ${inserted} chunks`);
			return { kb: savedKB, chunkCount: inserted };
		} catch (error) {
			lines.close();
			stream.destroy();
			vectorWriter?.close();
			if (tempVectorFile) rmSync(tempVectorFile, { force: true });
			if (this.db && kb) {
				finishIndexingJob(
					this.db,
					kb.id,
					isCancellationError(error) ? "cancelled" : "failed",
					isCancellationError(error) ? "Import cancelled." : `Import failed near line ${lineNumber}.`,
					error instanceof Error ? error.message : String(error),
				);
				deleteKB(this.db, kb.id);
				this.deleteVectorFile(kb.id);
			}
			throw error;
		}
	}

	async dispose(options: { disposeModels?: boolean } = {}): Promise<void> {
		this.disposing = true;
		const activeUpdates = [...this.activeUpdates.values()];
		if (activeUpdates.length > 0) await Promise.allSettled(activeUpdates);
		const activeMutations = [...this.activeMutations.values()];
		if (activeMutations.length > 0) await Promise.allSettled(activeMutations);
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
