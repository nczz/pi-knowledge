# Phase 1 實作計劃

狀態: **Phase 2 完成**
Spike: ✅ 全部通過 (2026-06-14)
Phase 1: ✅ 完成 — 5 tools, 25 tests, dogfood passed
Phase 2: ✅ 完成 — +2 tools (update, status), incremental indexing, metadata filters, pagination
下一步: Phase 3 — cross-encoder reranking, file watcher, auto-injection, AST chunking

---

## 當前狀態快照

- Spike: ✅ 全部通過（better-sqlite3, embedding, FTS5）
- Dependencies: `@huggingface/transformers` + `better-sqlite3` + `tree-sitter`
- Embedding model: `Xenova/multilingual-e5-small` quantized, 384d

---

## 實作順序（最小閉環優先）

### Step 1: Storage Layer
`src/storage/sqlite.ts`

- SQLite schema: knowledge_bases 表 + chunks 表 + chunks_fts 虛擬表
- CRUD: createKB, getKB, listKBs, deleteKB, insertChunks, getChunksByKB, deleteChunksByKB
- WAL mode + busy_timeout(5000) 處理並發
- Migration 機制（schema version）

### Step 2: Chunking
`src/indexer/chunker.ts`

- 檔案掃描: walkDir + .gitignore + binary detection + size limit
- Markdown chunker: heading-based split
- Generic chunker: paragraph-based with overlap
- Pre-tokenize for FTS5: camelCase + CJK 分隔
- Content hash: SHA-256(content) for embedding cache

### Step 3: Embedding
`src/embedding/provider.ts`

- @huggingface/transformers pipeline wrapper
- Lazy load (首次 embed 時載入)
- Idle dispose (60s timeout)
- Batch embedding (32 chunks per batch)
- "query:" / "passage:" prefix handling
- Cache dir: ~/.pi/knowledge/models/
- Progress callback 透傳

### Step 4: Search
`src/search/bm25.ts` + `src/search/vector.ts` + `src/search/fusion.ts`

- BM25: FTS5 MATCH query + bm25() scoring
- Vector: flat cosine similarity on loaded vectors
- RRF: reciprocal rank fusion (k=60)
- Mode dispatch: fast/semantic/hybrid

### Step 5: Engine Facade
`src/engine.ts`

- KnowledgeEngine class: 整合 storage + chunker + embedding + search
- add(path/text, name): scan → chunk → embed → store
- search(query, options): mode dispatch → retrieve → format
- remove/show/clear
- initialize()/flush()/dispose()

### Step 6: Tool Registration
`src/tools/add.ts` + `src/tools/search.ts`

- knowledge_add: TypeBox schema, execute 呼叫 engine.add()
- knowledge_search: TypeBox schema, execute 呼叫 engine.search()
- onUpdate progress for add (file count, embedding progress)

### Step 7: Extension Entry
`index.ts`

- Import engine + tools
- session_start: engine.initialize()
- session_shutdown: engine.dispose()
- before_agent_start: inject KB metadata into promptGuidelines
- Register tools

### Step 8: Dogfood Test
手動測試: index pi-knowledge/docs/ → 搜尋 "embedding model" / "FTS5" / "認證"

### Step 9: 補全 Tools
`src/tools/remove.ts`, `show.ts`, `clear.ts`, `update.ts`, `status.ts`

### Step 10: Unit Tests
`test/unit/chunker.test.ts`, `search.test.ts`, `storage.test.ts`

---

## 驗證 Checkpoint

每完成一個 Step 都可以獨立驗證:

| Step | 驗證方式 |
|------|---------|
| 1 | Node script: open DB, create table, insert, query |
| 2 | Node script: chunk a markdown file, print chunks |
| 3 | Node script: embed "test query", print vector dims |
| 4 | After 1+2+3: insert test chunks, search, print results |
| 5 | Engine facade: add a file, search it |
| 6 | `pi -e ./index.ts -p "add docs/ as test"` |
| 7 | Full extension lifecycle test |
| 8 | Real usage: index own docs, search |

---

## 如果中斷，如何回復

1. 看這份文件確認當前在哪個 Step
2. 看 `src/` 目錄哪些檔案已建立
3. 看 TODO list 哪些 task 已完成
4. 從下一個未完成的 task 繼續

---

## 關鍵文件交叉參考

| 需要什麼 | 去看哪裡 |
|---------|---------|
| 整體架構 | DESIGN.md §3 |
| Data model (KB/Chunk/SearchResult) | DESIGN.md §4 |
| Chunking 細節 | docs/chunking-strategies.md |
| Search pipeline 演算法 | docs/search-pipeline.md |
| FTS5 tokenization | docs/fts5-code-tokenization.md |
| Embedding API | docs/embedding-models.md §4 |
| Pi extension API | docs/pi-extension-architecture.md |
| Tool 行為對齊 kiro | docs/kiro-knowledge-behavior.md |
| 技術決策紀錄 | docs/technical-decisions.md |
| Spike 驗證結果 | RESEARCH.md §B.9 |
