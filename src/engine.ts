import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { embedDocuments, embedQuery, dispose as disposeEmbedding } from "./embedding/provider.ts";
import { loadVectors, saveVectors } from "./embedding/vectors.ts";
import { chunkFile, walkDir } from "./indexer/chunker.ts";
import { searchBM25 } from "./search/bm25.ts";
import { reciprocalRankFusion } from "./search/fusion.ts";
import { rerank, disposeReranker } from "./search/reranker.ts";
import { searchVector } from "./search/vector.ts";
import { diagnoseKB, type DiagnosticResult } from "./diagnostics/health.ts";
import {
	createKB, deleteKB, getChunkById, getChunkIdsByKB, getChunksByKB, getFileCount, getKB, getKBByName,
	insertChunks, listKBs, openDatabase, updateKBCounts, updateKBStatus, deleteChunksByIds, getChunkHashesByKB,
	type KnowledgeBase,
} from "./storage/sqlite.ts";

export interface SearchOptions {
	mode?: "fast" | "semantic" | "hybrid" | "deep";
	limit?: number;
	offset?: number;
	kb_id?: string;
	filters?: { file_type?: string; path_pattern?: string };
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
}

export interface SearchResponse {
	results: SearchResult[];
	total_count: number;
	has_more: boolean;
}

export type ProgressCallback = (msg: string) => void;

export class KnowledgeEngine {
	private db: Database.Database | null = null;
	private knowledgeDir: string = "";

	async initialize(knowledgeDir: string): Promise<void> {
		this.knowledgeDir = knowledgeDir;
		this.db = openDatabase(knowledgeDir);
	}

	async add(source: string, name: string, onProgress?: ProgressCallback): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const resolvedSource = resolve(source);
		const isDir = existsSync(resolvedSource) && statSync(resolvedSource).isDirectory();
		const isFile = existsSync(resolvedSource) && statSync(resolvedSource).isFile();
		const sourceType = isDir ? "directory" : isFile ? "file" : "text";

		const kb = createKB(this.db, { name, source_path: isDir || isFile ? resolvedSource : undefined, source_type: sourceType });
		updateKBStatus(this.db, kb.id, "indexing");

		try {
			let allChunks: Awaited<ReturnType<typeof chunkFile>> = [];

			if (isDir) {
				onProgress?.(`Scanning ${resolvedSource}...`);
				const files = walkDir(resolvedSource);
				onProgress?.(`Found ${files.length} files, chunking...`);
				for (const file of files) {
					allChunks.push(...await chunkFile(file.content, file.relPath));
				}
			} else if (isFile) {
				const { readFileSync } = await import("node:fs");
				const content = readFileSync(resolvedSource, "utf-8");
				allChunks = await chunkFile(content, resolvedSource);
			} else {
				allChunks = await chunkFile(source, "inline-text");
			}

			onProgress?.(`${allChunks.length} chunks, embedding...`);
			const texts = allChunks.map((c) => c.content);
			const vectors = await embedDocuments(texts);

			onProgress?.(`Storing...`);
			insertChunks(this.db, kb.id, allChunks);

			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			saveVectors(vectorPath, vectors);

			const fileCount = isDir ? getFileCount(this.db, kb.id) : 1;
			updateKBCounts(this.db, kb.id, allChunks.length, fileCount);
			updateKBStatus(this.db, kb.id, "ready");

			return { kb: getKB(this.db, kb.id)!, chunkCount: allChunks.length };
		} catch (e) {
			// Clean up partial state on failure
			deleteKB(this.db, kb.id);
			throw e;
		}
	}

	async update(nameOrId: string, onProgress?: ProgressCallback): Promise<{ added: number; removed: number; unchanged: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		if (!kb.source_path || !existsSync(kb.source_path)) {
			throw new Error(`Source path not available or missing: ${kb.source_path}`);
		}

		updateKBStatus(this.db, kb.id, "indexing");

		try {
			// 1. Scan and chunk current source
			onProgress?.("Scanning source...");
			const isDir = statSync(kb.source_path).isDirectory();
			let newChunks: Awaited<ReturnType<typeof chunkFile>> = [];
			if (isDir) {
				const files = walkDir(kb.source_path);
				for (const file of files) newChunks.push(...await chunkFile(file.content, file.relPath));
			} else {
				const { readFileSync } = await import("node:fs");
				newChunks = await chunkFile(readFileSync(kb.source_path, "utf-8"), kb.source_path);
			}

			// 2. Load existing state: chunks (hash→id) + vectors (ordered)
			const existingHashes = getChunkHashesByKB(this.db, kb.id);
			const existingChunkIds = getChunkIdsByKB(this.db, kb.id);
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
				newVectors = await embedDocuments(chunksToAdd.map((c) => c.content));
				insertChunks(this.db, kb.id, chunksToAdd);
			}

			// Add new vectors to cache
			for (let i = 0; i < chunksToAdd.length; i++) {
				vectorCache.set(chunksToAdd[i].content_hash, newVectors[i]);
			}

			// 6. Rebuild vector file in DB chunk order (reusing cached vectors)
			const finalChunks = getChunksByKB(this.db, kb.id);
			const finalVectors = finalChunks.map((c) => vectorCache.get(c.content_hash)!).filter(Boolean);
			saveVectors(vectorPath, finalVectors);

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
		const { mode = "hybrid", limit = 10, offset = 0, kb_id, filters } = options;

		const kbs = kb_id ? [getKB(this.db, kb_id)].filter(Boolean) as KnowledgeBase[] : listKBs(this.db);
		if (kbs.length === 0) return { results: [], total_count: 0, has_more: false };

		let allResults: { chunkId: string; score: number }[] = [];

		for (const kb of kbs) {
			const chunkIds = getChunkIdsByKB(this.db, kb.id);
			if (chunkIds.length === 0) continue;

			if (mode === "fast") {
				allResults.push(...searchBM25(this.db, query, 50, kb.id));
			} else if (mode === "semantic") {
				const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
				const vectors = loadVectors(vectorPath);
				if (vectors.length > 0) {
					const queryVec = await embedQuery(query);
					allResults.push(...searchVector(queryVec, vectors, chunkIds));
				}
			} else {
				// hybrid: BM25 + vector + RRF (both scoped to this KB)
				const bm25Results = searchBM25(this.db, query, 50, kb.id);
				const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
				const vectors = loadVectors(vectorPath);
				let vecResults: { chunkId: string; score: number }[] = [];
				if (vectors.length > 0) {
					const queryVec = await embedQuery(query);
					vecResults = searchVector(queryVec, vectors, chunkIds);
				}
				const fused = reciprocalRankFusion([bm25Results, vecResults]);
				allResults.push(...fused);
			}
		}

		// Deduplicate and sort
		const seen = new Set<string>();
		const unique = allResults.filter((r) => { if (seen.has(r.chunkId)) return false; seen.add(r.chunkId); return true; });
		unique.sort((a, b) => b.score - a.score);

		// Apply metadata filters post-retrieval
		let filtered = unique;
		if (filters?.file_type || filters?.path_pattern) {
			filtered = unique.filter((r) => {
				const chunk = getChunkById(this.db!, r.chunkId);
				if (!chunk) return false;
				if (filters.file_type && chunk.file_type !== filters.file_type) return false;
				if (filters.path_pattern && !chunk.file_path.includes(filters.path_pattern)) return false;
				return true;
			});
		}

		// Deep mode: rerank top-20 with cross-encoder
		if (mode === "deep" && filtered.length > 0) {
			const candidates = filtered.slice(0, 20).map((r) => {
				const chunk = getChunkById(this.db!, r.chunkId);
				return chunk ? { chunkId: r.chunkId, content: chunk.content } : null;
			}).filter(Boolean) as Array<{ chunkId: string; content: string }>;
			const reranked = await rerank(query, candidates, limit);
			const results: SearchResult[] = reranked.map((r) => {
				const chunk = getChunkById(this.db!, r.chunkId)!;
				const kbObj = getKB(this.db!, chunk.kb_id);
				return { content: chunk.content, file_path: chunk.file_path, file_type: chunk.file_type, kb_name: kbObj?.name ?? "unknown", score: r.score, snippet: chunk.content.slice(0, 200), start_line: chunk.start_line, end_line: chunk.end_line };
			});
			return { results, total_count: results.length, has_more: false };
		}

		const total = filtered.length;
		const page = filtered.slice(offset, offset + limit);

		const results: SearchResult[] = page.map((r) => {
			const chunk = getChunkById(this.db!, r.chunkId);
			if (!chunk) return null;
			const kb = getKB(this.db!, chunk.kb_id);
			return {
				content: chunk.content,
				file_path: chunk.file_path,
				file_type: chunk.file_type,
				kb_name: kb?.name ?? "unknown",
				score: r.score,
				snippet: chunk.content.slice(0, 200),
				start_line: chunk.start_line,
				end_line: chunk.end_line,
			};
		}).filter(Boolean) as SearchResult[];

		return { results, total_count: total, has_more: offset + limit < total };
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
		return listKBs(this.db).map((kb) => diagnoseKB(this.db!, kb));
	}

	async dispose(): Promise<void> {
		await disposeEmbedding();
		await disposeReranker();
		this.db?.close();
		this.db = null;
	}
}
