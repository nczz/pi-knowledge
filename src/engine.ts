import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { embedDocuments, embedQuery, dispose as disposeEmbedding } from "./embedding/provider.ts";
import { loadVectors, saveVectors } from "./embedding/vectors.ts";
import { chunkFile, walkDir, contentHash, preTokenizeForFTS } from "./indexer/chunker.ts";
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

export const CURRENT_EMBEDDING_MODEL = "multilingual-e5-small";

export interface SearchResponse {
	results: SearchResult[];
	total_count: number;
	has_more: boolean;
	warnings?: string[];
}

export type ProgressCallback = (msg: string) => void;

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
		if (this.vectorCache.has(kbId)) return this.vectorCache.get(kbId)!;
		const vectorPath = join(this.knowledgeDir, "vectors", `${kbId}.bin`);
		const vectors = loadVectors(vectorPath);
		this.vectorCache.set(kbId, vectors);
		return vectors;
	}

	private invalidateVectorCache(kbId: string): void {
		this.vectorCache.delete(kbId);
	}

	async add(source: string, name: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const resolvedSource = resolve(source);
		const isUrl = source.startsWith("http://") || source.startsWith("https://");
		const isDir = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isDirectory();
		const isFile = !isUrl && existsSync(resolvedSource) && statSync(resolvedSource).isFile();
		const sourceType = isDir ? "directory" : isFile ? "file" : "text";

		const kb = createKB(this.db, { name, source_path: isDir || isFile ? resolvedSource : isUrl ? source : undefined, source_type: sourceType });
		updateKBStatus(this.db, kb.id, "indexing");

		try {
			let allChunks: Awaited<ReturnType<typeof chunkFile>> = [];

			if (isUrl) {
				onProgress?.(`Fetching ${source}...`);
				const res = await fetch(source);
				if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
				const html = await res.text();
				const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ")
					.replace(/\s+/g, " ").trim();
				allChunks = await chunkFile(text, source);
			} else if (isFile && resolvedSource.endsWith(".pdf")) {
				onProgress?.("Extracting text from PDF...");
				const { extractText } = await import("unpdf");
				const buf = (await import("node:fs")).readFileSync(resolvedSource);
				const { text } = await extractText(new Uint8Array(buf));
				allChunks = await chunkFile(text, resolvedSource);
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
			const vectors = await embedDocuments(texts, signal);

			onProgress?.(`Storing...`);
			insertChunks(this.db, kb.id, allChunks);

			const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
			saveVectors(vectorPath, vectors);
			this.vectorCache.set(kb.id, vectors);

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

	async update(nameOrId: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<{ added: number; removed: number; unchanged: number }> {
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
		const { mode = "hybrid", limit = 10, offset = 0, kb_id, filters } = options;

		const kbs = kb_id ? [getKB(this.db, kb_id)].filter(Boolean) as KnowledgeBase[] : listKBs(this.db);
		if (kbs.length === 0) return { results: [], total_count: 0, has_more: false };

		const warnings: string[] = [];
		let allResults: { chunkId: string; score: number }[] = [];

		for (const kb of kbs) {
			if (kb.embedding_model !== CURRENT_EMBEDDING_MODEL) {
				warnings.push(`"${kb.name}" was indexed with ${kb.embedding_model} (current: ${CURRENT_EMBEDDING_MODEL}) — run knowledge_update for best results`);
			}
			const chunkIds = getChunkIdsByKB(this.db, kb.id);
			if (chunkIds.length === 0) continue;

			if (mode === "fast") {
				allResults.push(...searchBM25(this.db, query, 50, kb.id));
			} else if (mode === "semantic") {
				
				const vectors = this.getVectors(kb.id);
				if (vectors.length > 0) {
					const queryVec = await embedQuery(query);
					allResults.push(...searchVector(queryVec, vectors, chunkIds));
				}
			} else {
				// hybrid: BM25 + vector + RRF (both scoped to this KB)
				const bm25Results = searchBM25(this.db, query, 50, kb.id);
				
				const vectors = this.getVectors(kb.id);
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
			return { results, total_count: results.length, has_more: false, warnings: warnings.length > 0 ? warnings : undefined };
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

		return { results, total_count: total, has_more: offset + limit < total, warnings: warnings.length > 0 ? warnings : undefined };
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
		return listKBs(this.db).map((kb) => diagnoseKB(this.db!, kb));
	}

	async exportKB(nameOrId: string, outputPath: string): Promise<number> {
		if (!this.db) throw new Error("Engine not initialized");
		const kb = getKB(this.db, nameOrId) ?? getKBByName(this.db, nameOrId);
		if (!kb) throw new Error(`Knowledge base not found: ${nameOrId}`);
		const chunks = getChunksByKB(this.db, kb.id);
		const { writeFileSync } = await import("node:fs");
		const header = JSON.stringify({ name: kb.name, description: kb.description, source_path: kb.source_path, source_type: kb.source_type, chunk_count: chunks.length });
		const lines = [header, ...chunks.map((c) => JSON.stringify({ content: c.content, file_path: c.file_path, file_type: c.file_type, start_line: c.start_line, end_line: c.end_line, metadata_json: c.metadata_json }))];
		writeFileSync(outputPath, lines.join("\n") + "\n");
		return chunks.length;
	}

	async importKB(inputPath: string, onProgress?: ProgressCallback, signal?: AbortSignal): Promise<{ kb: KnowledgeBase; chunkCount: number }> {
		if (!this.db) throw new Error("Engine not initialized");
		const { readFileSync } = await import("node:fs");
		const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
		if (lines.length < 1) throw new Error("Empty import file");
		const header = JSON.parse(lines[0]);
		const kb = createKB(this.db, { name: header.name, description: header.description, source_path: header.source_path, source_type: header.source_type || "text" });
		updateKBStatus(this.db, kb.id, "indexing");
		const chunkData = lines.slice(1).map((l) => JSON.parse(l));
		onProgress?.(`Importing ${chunkData.length} chunks, embedding...`);
		const texts = chunkData.map((c: any) => c.content);
		const vectors = await embedDocuments(texts, signal);
		const chunks = chunkData.map((c: any) => ({ content_hash: contentHash(c.content), content: c.content, content_tokenized: preTokenizeForFTS(c.content), file_path: c.file_path, file_type: c.file_type, start_line: c.start_line, end_line: c.end_line, metadata_json: c.metadata_json || "{}" }));
		insertChunks(this.db, kb.id, chunks);
		const vectorPath = join(this.knowledgeDir, "vectors", `${kb.id}.bin`);
		saveVectors(vectorPath, vectors);
		this.vectorCache.set(kb.id, vectors);
		updateKBCounts(this.db, kb.id, chunks.length, new Set(chunks.map((c: any) => c.file_path)).size);
		updateKBStatus(this.db, kb.id, "ready");
		return { kb: getKB(this.db, kb.id)!, chunkCount: chunks.length };
	}

	async dispose(): Promise<void> {
		await disposeEmbedding();
		await disposeReranker();
		this.db?.close();
		this.db = null;
	}
}
