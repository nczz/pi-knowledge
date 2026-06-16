import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { type DiagnosticResult, diagnoseKB } from "./diagnostics/health.ts";
import {
	dispose as disposeEmbedding,
	embedDocuments,
	embedQuery,
	prepareForShutdown as prepareEmbeddingForShutdown,
} from "./embedding/provider.ts";
import { loadVectors, saveVectors } from "./embedding/vectors.ts";
import { buildChunkEmbeddingText, chunkFile, contentHash, preTokenizeForFTS, walkDir } from "./indexer/chunker.ts";
import { searchBM25 } from "./search/bm25.ts";
import { weightedScoreFusion } from "./search/fusion.ts";
import { normalizedQueryText, tokenizeForSearch } from "./search/query.ts";
import {
	hasEnoughLexicalEvidence,
	MIN_HYBRID_SCORE,
	normalizeFileTypeFilter,
	queryCoverage,
	type RankingDiagnostics,
	scoreChunkForQuery,
} from "./search/ranking.ts";
import { disposeReranker, prepareRerankerForShutdown, rerank } from "./search/reranker.ts";
import { searchVector } from "./search/vector.ts";
import {
	type Chunk,
	createKB,
	deleteChunksByIds,
	deleteKB,
	getChunkById,
	getChunkHashesByKB,
	getChunkIdsByKB,
	getChunksByFile,
	getChunksByKB,
	getFileCount,
	getKB,
	getKBByName,
	insertChunks,
	type KnowledgeBase,
	listKBs,
	openDatabase,
	updateKBCounts,
	updateKBStatus,
} from "./storage/sqlite.ts";

export interface SearchOptions {
	mode?: "fast" | "semantic" | "hybrid" | "deep" | "adaptive";
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
}

export type ProgressCallback = (msg: string) => void;

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

const ADAPTIVE_CONTEXT_LINES = 80;
const ADAPTIVE_MAX_CONTEXT_CHARS = 6_000;
const ADAPTIVE_NEIGHBOR_TARGET = 5;
const VECTOR_REDUNDANCY_WEIGHT = 0.35;

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
	private vectorCache: Map<string, Float32Array[]> = new Map();

	async initialize(knowledgeDir: string): Promise<void> {
		this.knowledgeDir = knowledgeDir;
		this.db = openDatabase(knowledgeDir);
		this.vectorCache.clear();
	}

	private getVectors(kbId: string): Float32Array[] {
		const cached = this.vectorCache.get(kbId);
		if (cached) return cached;
		const vectorPath = join(this.knowledgeDir, "vectors", `${kbId}.bin`);
		const vectors = loadVectors(vectorPath);
		this.vectorCache.set(kbId, vectors);
		return vectors;
	}

	private invalidateVectorCache(kbId: string): void {
		this.vectorCache.delete(kbId);
	}

	private getVectorsByChunkId(kbId: string, chunkIds: string[]): Map<string, Float32Array> {
		const vectors = this.getVectors(kbId);
		const mapped = new Map<string, Float32Array>();
		for (let i = 0; i < chunkIds.length; i++) {
			if (vectors[i]) mapped.set(chunkIds[i], vectors[i]);
		}
		return mapped;
	}

	async add(
		source: string,
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal,
	): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const resolvedSource = resolve(source);
		const isUrl = source.startsWith("http://") || source.startsWith("https://");
		const isDir = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isDirectory();
		const isFile = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isFile();
		const sourceType = isUrl ? "url" : isDir ? "directory" : isFile ? "file" : "text";

		const existingKB = getKBByName(this.db, name);
		if (existingKB) {
			throw new Error(
				`Knowledge base "${name}" already exists. Use knowledge_update to refresh it, or knowledge_remove before adding a replacement.`,
			);
		}

		const kb = createKB(this.db, {
			name,
			source_path: isDir || isFile ? resolvedSource : isUrl ? source : undefined,
			source_type: sourceType,
		});
		updateKBStatus(this.db, kb.id, "indexing");

		try {
			let allChunks: Awaited<ReturnType<typeof chunkFile>> = [];

			if (isUrl) {
				onProgress?.(`Fetching ${source}...`);
				allChunks = await chunkUrl(source, signal);
			} else if (isFile && resolvedSource.endsWith(".pdf")) {
				onProgress?.("Extracting text from PDF...");
				const { extractText } = await import("unpdf");
				const buf = (await import("node:fs")).readFileSync(resolvedSource);
				const { text } = await extractText(new Uint8Array(buf));
				allChunks = await chunkFile(normalizeExtractedText(text), resolvedSource);
			} else if (isFile && (resolvedSource.endsWith(".docx") || resolvedSource.endsWith(".doc"))) {
				onProgress?.("Extracting text from DOCX...");
				const mammoth = await import("mammoth");
				const result = await mammoth.extractRawText({ path: resolvedSource });
				allChunks = await chunkFile(result.value, resolvedSource);
			} else if (isDir) {
				onProgress?.(`Scanning ${resolvedSource}...`);
				const files = walkDir(resolvedSource);
				onProgress?.(`Found ${files.length} files, chunking...`);
				for (const file of files) {
					allChunks.push(...(await chunkFile(file.content, file.relPath)));
				}
			} else if (isFile) {
				const { readFileSync } = await import("node:fs");
				const content = readFileSync(resolvedSource, "utf-8");
				allChunks = await chunkFile(content, resolvedSource);
			} else {
				allChunks = await chunkFile(source, "inline-text");
			}

			onProgress?.(`${allChunks.length} chunks, embedding...`);
			const texts = allChunks.map((c) => buildChunkEmbeddingText(c));
			const vectors = await embedDocuments(texts, signal);

			onProgress?.(`Storing...`);
			insertChunks(this.db, kb.id, allChunks);

			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			saveVectors(vectorPath, vectors);
			this.vectorCache.set(kb.id, vectors);

			const fileCount = isDir ? getFileCount(this.db, kb.id) : 1;
			updateKBCounts(this.db, kb.id, allChunks.length, fileCount);
			updateKBStatus(this.db, kb.id, "ready");

			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after add: ${kb.id}`);
			return { kb: savedKB, chunkCount: allChunks.length };
		} catch (e) {
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

		try {
			// 1. Scan and chunk current source
			onProgress?.("Scanning source...");
			let newChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			if (kb.source_type === "url") {
				onProgress?.(`Fetching ${kb.source_path}...`);
				newChunks = await chunkUrl(kb.source_path, signal);
			} else if (statSync(kb.source_path).isDirectory()) {
				const files = walkDir(kb.source_path);
				for (const file of files) newChunks.push(...(await chunkFile(file.content, file.relPath)));
			} else {
				const { readFileSync } = await import("node:fs");
				newChunks = await chunkFile(readFileSync(kb.source_path, "utf-8"), kb.source_path);
			}

			// 2. Load existing state: chunks (hash→id) + vectors (ordered)
			const existingHashes = getChunkHashesByKB(this.db, kb.id);
			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			const existingVectors = loadVectors(vectorPath);

			// Build hash→vector cache from existing data
			const vectorCache = new Map<string, Float32Array>();
			const existingChunks = getChunksByKB(this.db, kb.id);
			for (let i = 0; i < existingChunks.length; i++) {
				if (existingVectors[i]) vectorCache.set(existingChunks[i].content_hash, existingVectors[i]);
			}

			// 3. Identify changes
			const newHashSet = new Set(newChunks.map((c) => c.content_hash));
			const chunksToAdd = newChunks.filter((c) => !existingHashes.has(c.content_hash));
			const idsToRemove = [...existingHashes.entries()].filter(([hash]) => !newHashSet.has(hash)).map(([, id]) => id);
			const unchanged = newChunks.length - chunksToAdd.length;

			onProgress?.(`Changes: +${chunksToAdd.length} -${idsToRemove.length} =${unchanged}`);

			// 4. Remove deleted chunks from DB
			if (idsToRemove.length > 0) deleteChunksByIds(this.db, idsToRemove);

			// 5. Embed ONLY new chunks
			let newVectors: Float32Array[] = [];
			if (chunksToAdd.length > 0) {
				onProgress?.(`Embedding ${chunksToAdd.length} new chunks...`);
				newVectors = await embedDocuments(
					chunksToAdd.map((c) => buildChunkEmbeddingText(c)),
					signal,
				);
				insertChunks(this.db, kb.id, chunksToAdd);
			}

			// Add new vectors to cache
			for (let i = 0; i < chunksToAdd.length; i++) {
				vectorCache.set(chunksToAdd[i].content_hash, newVectors[i]);
			}

			// 6. Rebuild vector file in DB chunk order (reusing cached vectors)
			const finalChunks = getChunksByKB(this.db, kb.id);
			const finalVectors: Float32Array[] = [];
			for (const chunk of finalChunks) {
				const vector = vectorCache.get(chunk.content_hash);
				if (vector) finalVectors.push(vector);
			}
			saveVectors(vectorPath, finalVectors);
			this.vectorCache.set(kb.id, finalVectors);

			// 7. Update counts
			updateKBCounts(this.db, kb.id, finalChunks.length, getFileCount(this.db, kb.id));
			updateKBStatus(this.db, kb.id, "ready");

			return { added: chunksToAdd.length, removed: idsToRemove.length, unchanged };
		} catch (e) {
			updateKBStatus(this.db, kb.id, "error");
			throw e;
		}
	}

	async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
		if (!this.db) throw new Error("Engine not initialized");
		const db = this.db;
		const { mode = "hybrid", limit = 10, offset = 0, kb_id, filters, diversity = "balanced" } = options;
		const retrievalMode = mode === "adaptive" ? "hybrid" : mode;
		const candidateLimit = Math.max(50, offset + limit * 12);
		const normalizedQuery = normalizedQueryText(query);
		const queryTokens = tokenizeForSimilarity(query);
		const normalizedFileType = normalizeFileTypeFilter(filters?.file_type);

		const selectedKB = kb_id ? (getKB(db, kb_id) ?? getKBByName(db, kb_id)) : undefined;
		const kbs = kb_id ? ([selectedKB].filter(Boolean) as KnowledgeBase[]) : listKBs(db);
		if (kbs.length === 0) return { results: [], total_count: 0, has_more: false };

		const warnings: string[] = [];
		const allResults: { chunkId: string; score: number }[] = [];
		const vectorsByChunkId = new Map<string, Float32Array>();

		for (const kb of kbs) {
			if (kb.embedding_model !== CURRENT_EMBEDDING_MODEL) {
				warnings.push(
					`"${kb.name}" was indexed with ${kb.embedding_model} (current: ${CURRENT_EMBEDDING_MODEL}) — run knowledge_update for best results`,
				);
			}
			const chunkIds = getChunkIdsByKB(db, kb.id);
			if (chunkIds.length === 0) continue;
			for (const [chunkId, vector] of this.getVectorsByChunkId(kb.id, chunkIds)) {
				vectorsByChunkId.set(chunkId, vector);
			}

			if (retrievalMode === "fast") {
				allResults.push(...searchBM25(db, normalizedQuery || query, candidateLimit, kb.id));
			} else if (retrievalMode === "semantic") {
				const vectors = [...this.getVectorsByChunkId(kb.id, chunkIds).values()];
				if (vectors.length > 0) {
					const queryVec = await embedQuery(query);
					allResults.push(...searchVector(queryVec, vectors, chunkIds, candidateLimit));
				}
			} else {
				// hybrid: BM25 + vector weighted fusion (both scoped to this KB)
				const bm25Results = searchBM25(db, normalizedQuery || query, candidateLimit, kb.id);

				const vectors = [...this.getVectorsByChunkId(kb.id, chunkIds).values()];
				let vecResults: { chunkId: string; score: number }[] = [];
				if (vectors.length > 0) {
					const queryVec = await embedQuery(query);
					vecResults = searchVector(queryVec, vectors, chunkIds, candidateLimit);
				}
				if (bm25Results.length === 0) continue;
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
		if (retrievalMode !== "fast" && retrievalMode !== "semantic") {
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
		};
	}

	remove(nameOrId: string): boolean {
		if (!this.db) return false;
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) return false;
		this.invalidateVectorCache(kb.id);
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
		this.vectorCache.clear();
	}

	diagnose(): DiagnosticResult[] {
		if (!this.db) return [];
		const db = this.db;
		return listKBs(db).map((kb) => diagnoseKB(db, kb));
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
		try {
			const chunkData = lines.slice(1).map((l) => JSON.parse(l) as ImportedChunk);
			onProgress?.(`Importing ${chunkData.length} chunks, embedding...`);
			const chunks = chunkData.map((c) => ({
				content_hash: contentHash(c.content),
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
			const vectors = await embedDocuments(
				indexedChunks.map((c) => buildChunkEmbeddingText(c)),
				signal,
			);
			insertChunks(this.db, kb.id, indexedChunks);
			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			saveVectors(vectorPath, vectors);
			this.vectorCache.set(kb.id, vectors);
			updateKBCounts(this.db, kb.id, indexedChunks.length, new Set(indexedChunks.map((c) => c.file_path)).size);
			updateKBStatus(this.db, kb.id, "ready");
			const savedKB = getKB(this.db, kb.id);
			if (!savedKB) throw new Error(`Knowledge base disappeared after import: ${kb.id}`);
			return { kb: savedKB, chunkCount: chunks.length };
		} catch (e) {
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
		this.db?.close();
		this.db = null;
	}
}
