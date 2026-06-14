# pi-knowledge — Technical Design

## 1. Problem Statement

Coding agents operate within limited context windows. When working on complex projects with extensive documentation, API specs, architecture docs, and accumulated team knowledge, the agent cannot access information outside its immediate context.

**kiro-cli** solves this with a built-in `knowledge` tool, but it has limitations:
- Full re-index on every update (no incremental)
- No hybrid search (semantic OR keyword, not fused)
- No reranking pass
- No file watching for auto-update
- No code-structure-aware chunking
- Opaque background operations (no granular progress)
- Server-dependent embedding (no offline capability)

**pi-knowledge** aims to provide the same core capability (index → search → retrieve) while advancing the state of the art on each weakness.

---

## 2. Design Goals

1. **Feature parity with kiro-cli knowledge** — same UX primitives: add, search, remove, update, show, status, clear
2. **Hybrid search by default** — BM25 + semantic + Reciprocal Rank Fusion, with optional cross-encoder rerank
3. **Incremental indexing** — content-addressed chunks; only re-embed changed/new content
4. **Code-aware chunking** — AST-based splitting for supported languages; fallback to semantic boundaries
5. **100% local** — local ONNX embedding model, zero API keys required for core functionality
6. **Deep Pi integration** — lifecycle hooks, auto-injection, TUI render, RPC support
7. **Observable** — real-time progress, index health diagnostics, chunk coverage stats

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Pi Agent Process                    │
├─────────────────────────────────────────────────────┤
│  pi-knowledge extension (index.ts)                   │
│  ├── Tool Registry (knowledge_*)                     │
│  ├── Lifecycle Hooks (session_start, context, etc.)  │
│  ├── TUI Renderers (search results, progress)        │
│  └── System Prompt Injection (promptGuidelines)       │
├─────────────────────────────────────────────────────┤
│  Core Engine                                         │
│  ├── Indexer          → chunking + embedding + store │
│  ├── Searcher         → hybrid retrieval + rerank    │
│  ├── Watcher          → fs.watch + debounced update  │
│  └── Diagnostics      → coverage, staleness, health  │
├─────────────────────────────────────────────────────┤
│  Storage Layer                                       │
│  ├── SQLite (metadata, BM25 FTS5, chunk registry)    │
│  ├── Vector Store (HNSW index, float32 embeddings)   │
│  └── Content Store (content-addressed chunk cache)   │
├─────────────────────────────────────────────────────┤
│  Embedding Layer                                     │
│  ├── Local ONNX (multilingual-e5-small, 384d) [default]  │
│  ├── Pi AI provider (OpenAI/Google/etc.) [optional]  │
│  └── Custom endpoint [configurable]                  │
└─────────────────────────────────────────────────────┘

Persistence: ~/.pi/knowledge/
├── knowledge.db          (SQLite: metadata + FTS5 + chunk registry)
├── vectors/
│   └── <kb-id>.hnsw      (HNSW index per knowledge base)
├── cache/
│   └── <content-hash>    (content-addressed embedding cache)
└── config.json           (user preferences)
```

---

## 4. Data Model

### Knowledge Base (KB)

```typescript
interface KnowledgeBase {
  id: string;           // UUID
  name: string;         // user-facing display name
  description?: string;
  source_path?: string; // original indexed path (dir or file)
  source_type: "file" | "directory" | "text";
  created_at: number;   // epoch ms
  updated_at: number;
  chunk_count: number;
  file_count: number;
  embedding_model: string;
  status: "ready" | "indexing" | "error" | "stale";
}
```

### Chunk

```typescript
interface Chunk {
  id: string;                // UUID
  kb_id: string;             // parent KB
  content_hash: string;      // SHA-256 of content (for dedup + incremental)
  content: string;           // actual text
  file_path: string;         // relative to KB source
  file_type: string;         // "typescript" | "markdown" | "python" | ...
  start_line: number;
  end_line: number;
  metadata: Record<string, string>;  // language, function_name, class_name, heading, etc.
  embedding?: Float32Array;  // cached embedding vector
  indexed_at: number;
}
```

### Search Result

```typescript
interface SearchResult {
  chunk: Chunk;
  kb_name: string;
  score: number;           // final fused score
  bm25_score?: number;     // keyword component
  semantic_score?: number;  // vector component
  rerank_score?: number;    // cross-encoder score (if enabled)
  snippet: string;          // truncated display text
  highlight_ranges?: Array<{ start: number; end: number }>;
}
```

---

## 5. Chunking Strategy

### Hierarchy (highest priority first):

1. **AST-based** (supported languages: TypeScript, JavaScript, Python, Go, Rust, Java)
   - Split at function/method/class boundaries
   - Preserve full signature + body as one chunk
   - Chunk size target: 500-2000 tokens
   - Metadata: function_name, class_name, module, exports

2. **Markdown-aware**
   - Split at heading boundaries (##, ###)
   - Keep heading + content together
   - Metadata: heading hierarchy, frontmatter fields

3. **Semantic boundary** (fallback for other text)
   - Paragraph-based splitting
   - Overlap window: 2 sentences
   - Chunk size target: 300-1000 tokens

4. **Fixed-size** (binary/unknown format fallback)
   - 512 token chunks with 64 token overlap
   - Only used when no structure is detected

### Content-Addressed Dedup

Each chunk is identified by `SHA-256(content + file_path + chunk_position)`. On re-index:
- Unchanged chunks → skip embedding (reuse cached vector)
- Modified chunks → re-embed only those
- Deleted chunks → remove from index
- New chunks → embed and insert

This makes incremental updates O(changed) instead of O(total).

---

## 6. Embedding Layer

### Default: Local ONNX

```
Model: multilingual-e5-small (quantized ONNX, ~32 MB)
Dimensions: 384
Speed: ~80-120 chunks/sec on M1 (batch=32)
Quality: excellent multilingual (100+ languages including zh-TW)
Query prefix: "query: {text}"
Document prefix: "passage: {text}"
```

Downloaded on first use, cached at `~/.pi/knowledge/models/`.

Note: multilingual-e5-small chosen over all-MiniLM-L6-v2 because:
- Same 384 dimensions (identical index size)
- Significantly better zh-TW/multilingual retrieval
- Only ~10 MB larger (quantized ONNX)
- See RESEARCH.md §4 for full comparison

### Optional: Pi AI Provider

When user has API keys configured in Pi's model registry, offer higher-quality embeddings:
- OpenAI `text-embedding-3-small` (1536d)
- Google `text-embedding-004` (768d)
- Configurable via `PI_KNOWLEDGE_EMBEDDING=openai:text-embedding-3-small`

### Embedding Cache

Content-addressed: `cache/<sha256(content)>` → `Float32Array`. Shared across KBs — identical content chunks are embedded once regardless of which KB they belong to.

---

## 7. Search Pipeline

```
Query
  │
  ├─→ BM25 (SQLite FTS5)       → top-50 candidates
  │
  ├─→ Vector search (HNSW)     → top-50 candidates
  │
  └─→ Reciprocal Rank Fusion   → merged top-K
       │
       └─→ [Optional] Cross-encoder rerank → final top-K
            │
            └─→ Metadata filter → results
```

### RRF (Reciprocal Rank Fusion)

```
score(doc) = Σ 1 / (k + rank_i(doc))
```
Where `k = 60` (standard constant), across BM25 and vector result lists.

### Metadata Filters (post-retrieval)

```typescript
knowledge_search({
  query: "authentication",
  filters: {
    file_type: "typescript",
    kb_name: "backend-docs",
  }
})
```

### Search Modes

| Mode | Pipeline | Latency | Use case |
|------|----------|---------|----------|
| `fast` | BM25 only | ~10ms | Exact terms, filenames, symbols |
| `semantic` | Vector only | ~50ms | Conceptual, paraphrased queries |
| `hybrid` (default) | BM25 + Vector + RRF | ~80ms | General purpose |
| `deep` | Hybrid + cross-encoder rerank | ~500ms | Maximum relevance |

---

## 8. Pi Extension Integration

### Tool Registration

```typescript
api.registerTool(knowledgeAddTool);
api.registerTool(knowledgeSearchTool);
api.registerTool(knowledgeRemoveTool);
api.registerTool(knowledgeUpdateTool);
api.registerTool(knowledgeShowTool);
api.registerTool(knowledgeStatusTool);
api.registerTool(knowledgeClearTool);
```

### System Prompt Injection

```typescript
promptSnippet: "Search indexed knowledge bases (docs, code, specs) for relevant context"

promptGuidelines: [
  "Before answering questions about project architecture, APIs, or domain concepts, search the knowledge base first",
  "When the user references documentation or specs, check if they are indexed and search them",
  "Use knowledge_search with mode 'hybrid' by default; switch to 'fast' for exact symbol lookups",
]
```

### Lifecycle Hooks

```typescript
// session_start: warm up index, check staleness
api.on("session_start", async (event, ctx) => {
  await engine.initialize(ctx.cwd);
  await engine.checkStaleness();
});

// session_shutdown: flush pending writes, stop watcher
api.on("session_shutdown", async () => {
  await engine.flush();
  engine.stopWatcher();
});

// context: auto-inject relevant snippets (opt-in)
api.on("context", async (event, ctx) => {
  if (config.autoInject) {
    const lastUserMsg = getLastUserMessage(event.messages);
    if (lastUserMsg) {
      const results = await engine.search(lastUserMsg, { limit: 3, mode: "fast" });
      // Inject as context prefix
    }
  }
});

// before_agent_start: inject KB metadata into system prompt
api.on("before_agent_start", (event) => {
  const kbs = engine.listKnowledgeBases();
  if (kbs.length > 0) {
    event.systemPromptOptions.promptGuidelines.push(
      `Available knowledge bases: ${kbs.map(kb => `"${kb.name}" (${kb.chunk_count} chunks)`).join(", ")}`
    );
  }
});
```

### TUI Rendering

Custom search result rendering with relevance bars, file paths, and highlighted snippets.

### RPC Mode

All tools work identically in RPC mode — no TUI-specific code in tool execute().

---

## 9. File Watcher

Optional (enabled via `PI_KNOWLEDGE_WATCH=true`):

```typescript
engine.startWatcher(kb.source_path, {
  debounceMs: 2000,
  ignorePatterns: ["node_modules", ".git", "dist", "build"],
  onChanges: async (changes) => {
    await engine.incrementalUpdate(kb.id, changes);
  }
});
```

Non-blocking, fire-and-forget. Errors reported via `knowledge_status`.

---

## 10. Diagnostics

```
Knowledge Engine Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Embedding model: multilingual-e5-small (local ONNX, 384d)
Storage: ~/.pi/knowledge/ (12.4 MB)
Knowledge bases: 3

  "API Docs"          ready     142 chunks   8 files   updated 2m ago
  "Architecture"      ready      67 chunks   3 files   updated 1h ago
  "Team Conventions"  indexing   23/45 chunks            ETA: 8s

Active watchers: 2
Index health: ✓ no stale chunks
```

Health checks: staleness detection, orphan cleanup, coverage %, embedding drift warning.

---

## 11. Configuration

Environment overrides:

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_KNOWLEDGE_DIR` | Storage directory | `~/.pi/knowledge` |
| `PI_KNOWLEDGE_EMBEDDING` | provider:model | `local:multilingual-e5-small` |
| `PI_KNOWLEDGE_WATCH` | Enable file watchers | `false` |
| `PI_KNOWLEDGE_AUTO_INJECT` | Auto-inject per turn | `false` |
| `PI_KNOWLEDGE_RERANK` | Enable cross-encoder | `false` |

---

## 12. kiro-cli Parity Mapping

| kiro command | pi-knowledge tool | Enhancement |
|--------------|-------------------|-------------|
| `knowledge add` (path) | `knowledge_add { path, name }` | + incremental, + file type detection |
| `knowledge add` (text) | `knowledge_add { text, name }` | identical |
| `knowledge search` | `knowledge_search { query, kb, limit, offset }` | + hybrid, + filters, + rerank |
| `knowledge remove` (by name/id/path) | `knowledge_remove { name/kb_id/path }` | identical |
| `knowledge update` | `knowledge_update { kb_id, path }` | + incremental (only changed) |
| `knowledge show` | `knowledge_show {}` | + health indicators |
| `knowledge status` | `knowledge_status {}` | + granular progress % |
| `knowledge clear` | `knowledge_clear {}` | identical |
| `knowledge cancel` | `knowledge_status { cancel: true }` | identical |

---

## 13. Improvements Over kiro-cli

| kiro weakness | pi-knowledge solution |
|---------------|----------------------|
| Full re-index on update | Content-addressed SHA-256 diffing. O(changed) not O(total). |
| Semantic OR keyword only | Hybrid by default: BM25 + vector + RRF fusion. |
| No reranking | Optional cross-encoder (ms-marco-MiniLM). |
| No file watching | fs.watch + debounce + .gitignore. KBs stay fresh. |
| No code-aware chunking | AST splitting (TS/JS/Python/Go/Rust). |
| Server-dependent embedding | Local ONNX. Works offline, no API costs. |
| Opaque progress | Real-time: files/chunks/embeddings + ETA. |
| No quality metrics | Staleness, orphans, coverage %, drift. |
| No metadata filters | Filter by file_type, kb_name, path, language. |
| No dedup | Content-addressed embedding cache. |

---

## 14. Implementation Phases

### Phase 1: Core Parity (MVP)

- [ ] Project scaffold (package.json, tsconfig, biome)
- [ ] SQLite storage (metadata + FTS5)
- [ ] Basic chunking (paragraph + markdown-aware)
- [ ] Local ONNX embedding (multilingual-e5-small)
- [ ] HNSW vector index
- [ ] BM25 search via FTS5
- [ ] Semantic search via HNSW
- [ ] Tools: add, search, remove, show, clear
- [ ] Persistence at `~/.pi/knowledge/`
- [ ] Pi extension lifecycle hooks
- [ ] Unit tests

### Phase 2: Hybrid + Incremental

- [ ] RRF fusion
- [ ] Content-addressed dedup
- [ ] Incremental re-indexing
- [ ] `knowledge_update` + `knowledge_status`
- [ ] Pagination
- [ ] Metadata filters
- [ ] TUI renderers

### Phase 3: Intelligence

- [ ] AST chunking (TypeScript, Python, Go)
- [ ] Cross-encoder reranking
- [ ] File watcher
- [ ] Index diagnostics
- [ ] Auto-injection per turn
- [ ] Pi AI provider embeddings
- [ ] Benchmarks

### Phase 4: Ecosystem

- [ ] More language AST support
- [ ] PDF/DOCX parsing
- [ ] URL indexing
- [ ] Import/export KBs
- [ ] KB sharing
- [ ] Pi skills integration

---

## 15. Dependencies

### Required

| Package | Purpose | Size |
|---------|---------|------|
| `better-sqlite3` | Metadata + FTS5 | 2.3 MB |
| `onnxruntime-node` | Local embedding | ~15 MB |

Note: Phase 1 uses pure-JS flat cosine search (no hnswlib-node needed).
See RESEARCH.md §7 for rationale: <10K vectors → brute-force is <10ms.

### Optional (Phase 3+)

| Package | Purpose |
|---------|---------|
| `hnswlib-node` or `usearch` | HNSW vector index (if >10K vectors) |
| `tree-sitter` + grammars | AST chunking |
| Cross-encoder ONNX | Reranking |
| `chokidar` | File watching |

---

## 16. File Structure

```
pi-knowledge/
├── index.ts              ← Extension entry (ExtensionFactory)
├── package.json
├── tsconfig.json
├── biome.json
├── README.md
├── DESIGN.md
├── CHANGELOG.md
├── src/
│   ├── engine.ts         ← KnowledgeEngine facade
│   ├── tools/            ← Tool definitions (add, search, remove, etc.)
│   ├── indexer/          ← Chunking + embedding orchestration
│   │   ├── chunkers/    ← markdown, code-ast, semantic, fixed
│   │   └── ...
│   ├── embedding/        ← Provider interface + local ONNX + pi-ai
│   ├── search/           ← BM25, vector, fusion, reranker
│   ├── storage/          ← SQLite + HNSW persistence
│   ├── watcher/          ← File watching
│   ├── diagnostics/      ← Health checks
│   └── config.ts
└── test/
    ├── unit/
    ├── e2e/
    └── bench/
```

---

## 17. Security

- **No network by default**: Local ONNX — data never leaves machine
- **Explicit paths only**: Only indexes what user provides
- **Secret skip**: Ignores `.env`, `*.key`, `*.pem`, credentials
- **ONNX model verification**: SHA-256 check on download

---

## 18. Performance Targets

| Operation | Target |
|-----------|--------|
| Index 1000 files | < 60s |
| Incremental update (10 files) | < 3s |
| Hybrid search | < 100ms |
| Deep search (rerank) | < 500ms |
| Startup | < 200ms |
| Storage per 1K chunks | ~5 MB |

---

## 19. Open Questions

1. **Native dep portability**: onnxruntime-node + hnswlib-node Bun binary compatibility. Fallback: pure-JS approximate NN.
2. **Multilingual**: all-MiniLM-L6-v2 vs multilingual-e5-small for zh-TW support.
3. **tree-sitter loading**: Lazy-load grammars per language to avoid bundle bloat.
4. **KV cache stability**: Adopt pi-memory's snapshot pattern for auto-injection.
5. **Scope**: Global `~/.pi/knowledge/` + project-local `.pi/knowledge/` both supported.
