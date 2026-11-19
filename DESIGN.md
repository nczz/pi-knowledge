# pi-knowledge — Technical Design

> Status: historical design reference. The current source of truth is the implementation plus README, AGENTS.md, docs/configuration.md, docs/technical-decisions.md, and docs/known-pitfalls.md. Some sections below describe earlier shapes of the storage schema, source types, filters, and lifecycle behavior.

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
2. **Hybrid search by default** — BM25 + semantic + normalized weighted score fusion, with optional cross-encoder rerank
3. **Incremental indexing** — content-addressed chunks; only re-embed changed/new content
4. **Code-aware chunking** — AST-based splitting for supported languages; fallback to semantic boundaries
5. **100% local** — local ONNX embedding model, zero API keys required for core functionality
6. **Native + standard agent integration** — keep Pi/OMP lifecycle hooks while exposing the same tools to external MCP clients
7. **Observable** — real-time progress, index health diagnostics, chunk coverage stats
8. **Self-correcting agent UX** — auto mode selection, fallback metadata, and doctor actions make retrieval failures actionable

---

## 3. Architecture Overview

```
Pi / OMP process               External MCP agents              Operator CLI
┌──────────────────┐           ┌──────────────────────┐          ┌──────────────────┐
│ extension.js     │           │ pi-knowledge-mcp     │          │ daemon start/... │
│ hooks + tools    │           │ stdio or loopback    │          └────────┬─────────┘
│ prompt guidance  │           │ Streamable HTTP      │                   │
└────────┬─────────┘           └──────────┬───────────┘                   │
         └──────────────────────┬─────────┴───────────────────────────────┘
                                │ authenticated local RPC
                     ┌──────────▼───────────┐
                     │ profile daemon       │  one owner per canonical storage
                     │ engine + watchers    │
                     │ mutation lifecycle   │
                     │ coverage.json writer │
                     └──────────┬───────────┘
              ┌─────────────────┼──────────────────┐
              │                 │                  │
        SQLite + FTS5     vector files      isolated model/
        symbols/jobs      streamed reads    document worker
```

Pi/OMP and MCP share public tool definitions and the selected daemon; no production client opens SQLite or constructs a fallback `KnowledgeEngine`. Pi/OMP session shutdown and MCP adapter shutdown release only client/transport state. The daemon remains until an explicit daemon stop or authenticated package/build replacement.

Persistence for the default profile is recorded in `~/.pi-knowledge/profiles.json` and normally uses `~/.pi-knowledge/profiles/default`. A single existing legacy Pi/OMP directory may be adopted in place. Named profiles use isolated storage:

```
<profile-storage>/
├── knowledge.db
├── vectors/
├── models/
├── config.json
└── coverage.json
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

Downloaded on first use and cached under the selected profile's `models/` directory.

Note: multilingual-e5-small chosen over all-MiniLM-L6-v2 because:
- Same 384 dimensions (identical index size)
- Significantly better zh-TW/multilingual retrieval
- Only ~10 MB larger (quantized ONNX)
- See RESEARCH.md §4 for full comparison

### Optional: Environment-configured provider

The default path is local ONNX. If `PI_KNOWLEDGE_EMBEDDING` is set to an external provider and the matching environment API key is available, embeddings can use that provider with local fallback:
- OpenAI `text-embedding-3-small` via `PI_KNOWLEDGE_EMBEDDING=openai:text-embedding-3-small`
- `OPENAI_API_KEY` is required for OpenAI embedding

### Vector Storage

Vectors are stored per KB in a compact binary file: 8-byte header (`count`, `dim`) followed by contiguous float32 vectors in SQLite chunk row order. Indexing writes vectors through a temp file and atomic rename; search uses ranged reads and retains only top candidate vectors needed for ranking/diversity.

---

## 7. Search Pipeline

```
Query
  │
  ├─→ BM25 (SQLite FTS5)       → top-50 candidates
  │
  ├─→ Vector search (streamed exact scan) → top-50 candidates
  │
  └─→ Weighted score fusion    → merged top-K
       │
       └─→ [Optional] Cross-encoder rerank → final top-K
            │
            └─→ Metadata filter → results
```

### Weighted Score Fusion

```
score(doc) = bm25_weight * normalized_bm25 + vector_weight * normalized_vector + overlap_bonus
```

RRF remains a tested baseline, but the default pipeline uses normalized weighted scores because project-level dogfood showed RRF compressed hybrid scores too aggressively for diagnostics and ranking tuning.

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
| `hybrid` (default) | BM25 + vector + weighted score fusion + confidence gate | variable | General purpose |
| `adaptive` | Hybrid + query-time neighboring context expansion | variable | Implementation context and related sections |
| `deep` | Hybrid + cross-encoder rerank | slower | Maximum relevance |
| `auto` | Tool-selected primary mode + bounded fallback | variable | Agent default when query shape is unclear |

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
api.registerTool(knowledgeDoctorTool);
api.registerTool(knowledgeClearTool);
```

### System Prompt Injection

```typescript
promptSnippet: "Search indexed knowledge bases (docs, code, specs) for relevant context"

promptGuidelines: [
  "Before answering questions about project architecture, APIs, or domain concepts, search the knowledge base first",
  "When the user references documentation or specs, check if they are indexed and search them",
  "Use hybrid by default, fast for exact symbols, semantic for conceptual wording, adaptive for surrounding context, deep for high-stakes verification, or auto when the tool should choose and retry",
]
```

### Lifecycle Hooks

```typescript
// session_start: connect to or ensure the selected profile daemon
api.on("session_start", async () => {
  await ensureDaemonClient(profile);
});

// session_shutdown: release this extension client's state only
api.on("session_shutdown", async () => {
  releaseClientState();
});

// context: ask the daemon for relevant snippets (opt-in)
api.on("context", async (event) => {
  if (config.autoInject) {
    const lastUserMsg = getLastUserMessage(event.messages);
    if (lastUserMsg) {
      const results = await daemon.search(lastUserMsg, { limit: 3, mode: "fast" });
      // Inject a bounded context prefix.
    }
  }
});
```

The profile daemon owns initialization, SQLite, model/document workers, persisted jobs, watchers, and shutdown ordering. A host session never flushes/closes those shared resources.

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
Storage: <default-profile-storage> (12.4 MB)
Knowledge bases: 3

  "API Docs"          ready     142 chunks   8 files   updated 2m ago
  "Architecture"      ready      67 chunks   3 files   updated 1h ago
  "Team Conventions"  indexing   23/45 chunks            ETA: 8s

Active watchers: 2
Index health: ✓ no stale chunks
```

Health checks: staleness detection, orphan cleanup, coverage %, skipped file counts/reasons, embedding drift warning, and stuck indexing detection. `knowledge_doctor` converts these signals into a health score and concrete actions.

---

## 11. Configuration

Environment overrides:

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_KNOWLEDGE_PROFILE` | Process-wide storage/runtime profile | `default` |
| `PI_KNOWLEDGE_DIR` | Explicit default-profile storage override | persisted mapping or adopted legacy directory |
| `PI_KNOWLEDGE_EMBEDDING` | provider:model | `local:multilingual-e5-small` |
| `PI_KNOWLEDGE_WATCH` | Enable daemon-owned file watchers | `false` |
| `PI_KNOWLEDGE_AUTO_INJECT` | Auto-inject per turn | `false` |

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
| `knowledge doctor` | `knowledge_doctor {}` | + health score and recommended actions |
| `knowledge clear` | `knowledge_clear {}` | identical |

---

## 13. Improvements Over kiro-cli

| kiro weakness | pi-knowledge solution |
|---------------|----------------------|
| Full re-index on update | Content-addressed SHA-256 diffing. O(changed) not O(total). |
| Semantic OR keyword only | Hybrid by default: BM25 + vector + weighted score fusion. |
| No reranking | Optional cross-encoder (ms-marco-MiniLM). |
| No file watching | fs.watch + debounce + .gitignore. KBs stay fresh. |
| No code-aware chunking | AST splitting (TS/JS/Python/Go/Rust). |
| Server-dependent embedding | Local ONNX. Works offline, no API costs. |
| Opaque progress | Real-time: files/chunks/embeddings + ETA. |
| No quality metrics | Staleness, orphans, coverage %, skipped files, stuck jobs, health score. |
| No metadata filters | Filter by file_type, kb_name, path, language. |
| No dedup | Content-addressed update diff avoids re-embedding unchanged chunks. |

---

## 14. Implementation Phases

### Phase 1: Core Parity (MVP)

- [x] Project scaffold (package.json, tsconfig, biome)
- [x] SQLite storage (metadata + FTS5)
- [x] Basic chunking (paragraph + markdown-aware)
- [x] Local ONNX embedding (multilingual-e5-small)
- [x] Flat cosine vector search (pure JS, no HNSW needed)
- [x] BM25 search via FTS5
- [x] Semantic search via flat cosine similarity
- [x] Tools: add, search, remove, show, clear
- [x] Default-first profile storage with stable legacy adoption
- [x] Pi/OMP extension lifecycle hooks through the profile daemon
- [x] Unit tests

### Phase 2: Hybrid + Incremental

- [x] Weighted score fusion
- [x] Content-addressed dedup
- [x] Incremental re-indexing
- [x] `knowledge_update` + `knowledge_status`
- [x] Pagination
- [x] Metadata filters
- [x] TUI custom renderers (renderCall + renderResult on search)

### Phase 3: Intelligence

- [x] AST chunking (TypeScript, JavaScript, Python, Go, Rust, Java)
- [x] Cross-encoder reranking
- [x] File watcher
- [x] Index diagnostics
- [x] Auto-injection per turn
- [x] Optional OpenAI env provider embeddings with local fallback
- [x] Benchmarks (vitest bench: BM25 0.05ms, hybrid 2.1ms)

### Phase 4: Ecosystem

- [x] Additional language AST (Rust, Java added — 6 total)
- [x] PDF/DOCX parsing (unpdf + mammoth, pure JS)
- [x] URL indexing (fetch + HTML strip)
- [x] Import/export KBs (JSONL format)
- [x] KB sharing (via JSONL export/import — git-friendly)
- [x] Pi skills integration (.pi/skills/search-docs.md)

---

## 15. Dependencies

### Required

| Package | Purpose | Size |
|---------|---------|------|
| `better-sqlite3` | Metadata + FTS5 | 2.3 MB |
| `@huggingface/transformers` | Local ONNX embedding and reranking runtime | ~32 MB model cache |
| `ignore` | Gitignore-compatible directory filtering | small |
| `unpdf` | PDF text extraction | small |
| `mammoth` | DOCX text extraction | small |
| `tree-sitter*` | AST code chunking | varies |

Current vector search uses exact streamed scan from the per-KB binary vector file. This is O(N) time but O(topK) vector memory, which prioritizes stable operation on large codebases. ANN/HNSW remains a future option for million-chunk low-latency search.

### Optional (Phase 3+)

| Package | Purpose |
|---------|---------|
| `hnswlib-node` or `usearch` | ANN vector index if exact scan becomes too slow |
| `chokidar` | File watching alternative if native watch/polling is insufficient |

---

## 16. File Structure

```
pi-knowledge/
├── extension.js          ← Package entry shim (loads dist first, source fallback)
├── index.ts              ← Startup-light Pi/OMP extension client + shared tool definitions
├── dist/                 ← Build output included in npm package
├── src/
│   ├── daemon/           ← Profile singleton, authenticated RPC, lifecycle, CLI
│   ├── mcp/              ← Shared protocol core, stdio, Streamable HTTP
│   ├── profiles.ts       ← Default-first profile registry and storage resolution
│   ├── engine.ts         ← Daemon-owned KnowledgeEngine facade
│   ├── indexer/          ← Scanning, chunking, embedding orchestration
│   ├── embedding/        ← Provider interface, worker client, vector I/O
│   ├── search/           ← BM25, vector, fusion, reranker, context
│   ├── storage/          ← SQLite persistence
│   ├── watcher/          ← Daemon-owned file watching
│   └── diagnostics/      ← Health checks
├── docs/
└── test/
    ├── unit/
    ├── e2e/
    └── bench/
```

---

## 17. Security

- **Local-first by default**: local embeddings do not send indexed content to an API.
- **Single owner**: only the selected profile daemon opens SQLite/vectors and owns watchers.
- **Explicit source scope**: risky or low-signal text is suggested for exclusion and requires confirmed inclusion; technical skips are reserved for unsupported/unreadable/oversized content.
- **Capability-gated MCP**: read-only default; local roots, network, writes, and admin are independent launch capabilities.
- **HTTP boundary**: loopback-only, mandatory bearer token, exact supplied-Origin validation, bounded requests/sessions/output, and no built-in remote bind/TLS/OAuth.
- **Private runtime state**: daemon token/manifest/socket and `coverage.json` use owner-only storage and never carry MCP credentials.

---

## 18. Performance Targets

Historical numeric targets below are directional only; current release decisions use benchmark and smoke evidence rather than treating these values as verified guarantees.

| Operation | Target |
|-----------|--------|
| Index 1000 files | < 60s |
| Incremental update (10 files) | < 3s |
| Hybrid search | < 100ms |
| Deep search (rerank) | < 500ms |
| Startup | < 200ms |
| Storage per 1K chunks | ~5 MB |

---

## 19. Current Boundaries

1. Native/runtime portability for SQLite, tree-sitter, and ONNX remains release-gated on supported Node/macOS/Linux/Windows paths.
2. Vector search is exact and streamed; an ANN dependency requires measured evidence and explicit approval.
3. Auto-injection remains opt-in and bounded.
4. Profiles are global storage/runtime domains, not project-local databases. Most users use `default`; named profiles are advanced isolation.
5. HTTP MCP is a same-machine transport. Remote/multi-user serving requires a separate TLS/OAuth design.
