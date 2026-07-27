# pi-knowledge

Local-first RAG knowledge base for Pi and OMP coding agents.

Index your codebase, docs, PDFs, URLs, and notes into persistent knowledge bases that Pi and [OMP](https://omp.sh/) can search across sessions. `pi-knowledge` combines semantic embeddings, BM25 keyword search, code-aware chunking, reranking, diagnostics, and stable large-project indexing so agents can answer from your actual project knowledge instead of guessing.

Built as a native [Pi extension](https://pi.dev/docs/latest/extensions) with verified [OMP](https://omp.sh/) compatibility through the packaged extension entry. Designed for local-first project memory, agentic code search, and retrieval-augmented development workflows.

## Why It Matters

Agents lose project context between sessions and cannot fit large repositories into one prompt. `pi-knowledge` gives Pi and OMP durable, searchable project memory:

- Search code and documentation by meaning, exact symbols, or both.
- Look up lightweight code symbols, Markdown headings, config keys, and environment variables before broader search.
- Keep private source data local by default.
- Re-index changed files incrementally.
- Diagnose stale, stuck, or low-quality indexes.
- Handle large repositories with persisted progress instead of silent hangs.

Unlike `pi-memory` (which manages the agent's own notes), `pi-knowledge` indexes **your existing files** and makes them semantically searchable by the agent.

## Highlights

- **Local-first project memory**: stores indexes under `~/.pi/knowledge/`; no project files are modified.
- **Hybrid retrieval**: lexical-anchored BM25 + semantic vectors + normalized weighted score fusion, with semantic mode for vector-only conceptual recall.
- **Code-aware indexing**: AST-aware chunking for TypeScript/JavaScript, Python, Go, Rust, and Java.
- **Lightweight symbol lookup**: indexes functions, classes, interfaces, types, variables, route-like handlers, Markdown headings, config keys, and env vars for exact agent lookup.
- **Better agent answers**: adaptive context windows, diversity reranking, optional cross-encoder reranking, and diagnostics.
- **Large-project stability**: persisted indexing progress, capped batches, streaming vector scans, and stuck-job detection.
- **Private by default**: local embeddings run without an API key.

## Feature Comparison

| Feature | pi-knowledge | kiro-cli knowledge | pi-memory |
|---------|:---:|:---:|:---:|
| Index arbitrary files/dirs | ✅ | ✅ | ❌ |
| Multiple named knowledge bases | ✅ | ✅ | ❌ |
| Semantic (vector) search | ✅ | ✅ | ✅ (via qmd) |
| BM25 keyword search | ✅ | ✅ | ✅ (via qmd) |
| **Hybrid search + weighted score fusion** | ✅ | ❌ | partial |
| **Cross-encoder reranking** | ✅ | ❌ | ❌ |
| **Adaptive contextual search** | ✅ | ❌ | ❌ |
| **Diversity reranking** | ✅ | ❌ | ❌ |
| **Incremental re-indexing** | ✅ | ❌ | ❌ |
| **File watcher (auto-update)** | ✅ | ❌ | ❌ |
| **Code-aware chunking** | ✅ (TS/JS/Py/Go/Rust/Java) | ❌ | ❌ |
| **Symbol/config/heading lookup** | ✅ | ❌ | ❌ |
| **Local embeddings (zero API)** | ✅ | ❌ | ✅ (qmd) |
| **Index quality diagnostics** | ✅ | ❌ | ❌ |
| **Metadata filters in search** | ✅ | ❌ | ❌ |
| **Progress reporting + stuck indexing diagnostics** | ✅ | partial | ❌ |
| Cross-session persistence | ✅ | ✅ | ✅ |
| Pi extension native | ✅ | N/A | ✅ |
| Context injection per turn | ✅ | ❌ | ✅ |
| Search result TUI rendering | ✅ | N/A | ❌ |
| Full tool TUI rendering | partial | N/A | ❌ |
| RPC mode support | ✅ | N/A | N/A |

TUI rendering currently uses Pi's stable default tool rendering plus targeted result formatting. A fuller custom renderer is intentionally not enabled yet because custom renderers must be width-safe across terminal sizes and Pi TUI modes.

## Research-Backed Retrieval

`pi-knowledge` turns retrieval research into product behavior that agents can actually use:

- **RAG-native project memory**: follows the Retrieval-Augmented Generation pattern from Lewis et al. 2020: keep source truth outside the model, retrieve it at answer time, and inject only relevant context.
- **Dense semantic recall**: uses multilingual dense embeddings in the spirit of Dense Passage Retrieval (Karpukhin et al. 2020), so conceptual queries can find code/docs even when wording differs.
- **Contextual Retrieval without remote chunk rewriting**: applies Anthropic's Contextual Retrieval insight locally by embedding file path, file type, Markdown breadcrumbs, and code symbols with each chunk. This improves standalone chunk meaning without sending private source chunks to an LLM for context generation.
- **Hybrid retrieval with diagnosable scores**: combines lexical BM25 anchors and vectors with normalized weighted score fusion. RRF (Cormack et al. 2009) remains the baseline reference, but weighted fusion is used by default because project dogfood showed RRF compressed scores too much for ranking diagnostics.
- **MMR-style diversity**: uses Maximal Marginal Relevance ideas (Goldstein and Carbonell 1998), file interleaving, vector redundancy checks, and adaptive-window overlap collapse so repeated README or same-file chunks do not dominate top results.
- **Intent-aware and self-correcting agent UX**: mode selection (`auto`, `fast`, `semantic`, `hybrid`, `adaptive`, `deep`), ranking diagnostics, and `knowledge_doctor` turn retrieval failures into concrete next actions instead of silent bad answers.
- **Confidence gating**: low-evidence hybrid matches can return zero results instead of unrelated chunks, reducing false confidence when the KB does not contain the answer.

This is intentionally not a heavy ColBERT-style late-interaction index yet (Khattab and Zaharia 2020). The current product chooses lightweight local embeddings, BM25, query-aware ranking, optional cross-encoder reranking, streamed vector scans, and health diagnostics for commercial usefulness with low setup cost.

In project-level dogfood, these changes improved a real codebase evaluation from early 3.x/5 quality to above 4.5/5 after rebuilds, with fixes for score compression, README repetition, garbage-query false positives, small-module discoverability, source-vs-test ranking, indexing stability, and auto-mode false positives. Existing KBs should be rebuilt or updated after upgrades that change indexing text.

## Quick Start

```bash
# Install for Pi
pi install npm:pi-knowledge

# Install for OMP
omp install npm:pi-knowledge

# Or from source
pi install ./pi-knowledge
omp install ./pi-knowledge

# Index a directory
# (agent will call knowledge_add automatically, or you can ask it)
> Index my project docs at ./docs as "Project Docs"

# Search
> Search my knowledge base for "authentication flow"

# The agent also auto-searches relevant knowledge before answering domain questions
```

## Tools

| Tool | Description |
|------|-------------|
| `knowledge_plan` | Inspect an indexing source before writing a KB; reports scannable counts, suggested exclusions, and technical skips |
| `knowledge_add` | Index files, directories, URLs, PDFs, DOCX, or inline text |
| `knowledge_search` | Fast, semantic, lexical-anchored hybrid, deep, or adaptive search across one or all knowledge bases; supports file-type and path filters |
| `knowledge_symbol_search` | Lightweight exact or substring lookup for code symbols, route-like handlers, Markdown headings, config keys, and env vars; fall back to `knowledge_search` for methods or uncommon syntax |
| `knowledge_remove` | Remove a knowledge base by name or ID after `confirm: true` |
| `knowledge_update` | Incrementally re-index changed files in a source-backed file, directory, or URL knowledge base |
| `knowledge_show` | List all knowledge bases with stats |
| `knowledge_status` | Show engine status with health diagnostics (stale, orphans, coverage) |
| `knowledge_doctor` | Diagnose health score, skipped files, stuck jobs, stale data, and recommended fixes |
| `knowledge_configure` | Persist runtime prerequisites such as a Windows `node.exe` path for the isolated local model worker |
| `knowledge_clear` | Remove all knowledge bases after `confirm: true` |
| `knowledge_export` | Export a KB to shareable JSONL file |
| `knowledge_import` | Import a KB from JSONL (re-embeds content) |

### Search Modes

- `fast`: BM25 keyword search for exact symbols, commands, and identifiers.
- `semantic`: vector search for conceptual matches.
- `hybrid`: lexical-anchored BM25 + vector search with normalized weighted score fusion. It requires keyword evidence to avoid low-confidence semantic false positives.
- `deep`: hybrid retrieval followed by cross-encoder reranking.
- `adaptive`: hybrid retrieval followed by query-time contextual window expansion around seed chunks. It keeps the matched seed, prefers nearby/query-relevant neighboring chunks, and collapses overlapping windows from the same file.
- `auto`: selects a primary mode from the query shape and retries alternate modes when results are empty or weak.
- `code`, `config`, `errors`, `docs`, `decision`: intent aliases for agents. `code`, `config`, and `errors` bias toward exact lexical/symbol evidence; `docs` and `decision` keep the intended source type explicit.

Search profiles tune result count, snippet length, hybrid strictness, candidate breadth, adaptive context, and deep rerank breadth. `profile: "auto"` selects a runtime profile from query shape, mode, and KB source type; explicit tool parameters still win over profile defaults. Use `profile: "low_token"` for slow local models that need fewer, stricter, longer results in one call; use `precision` for identifiers/errors, `recall` for broad discovery, `long_context` for prose/specs, and `balanced` for compatibility.

Mode selection contract:

- Start with `hybrid` for most project questions that contain useful lexical anchors.
- Use `fast` for exact symbols, filenames, commands, error codes, API names, config keys, or quoted strings.
- Use `semantic` when the query is conceptual, exact terms may differ from indexed wording, or hybrid returns no lexical matches.
- Use `adaptive` when the answer needs nearby code, neighboring documentation sections, or enough context to make a safe edit.
- Use `deep` for high-stakes answers, ambiguous top results, or final verification when slower reranking is acceptable.
- If results are empty or weak but the KB should contain the answer, retry once with a different mode before concluding no answer exists.

Search results use balanced diversity reranking by default so near-duplicate chunks from the same file do not dominate the top results. Diversity scoring considers lexical overlap, same-file line proximity, overlapping adaptive windows, available embedding-vector similarity, file-level interleaving, and a small KB trust multiplier that favors ready file/directory sources over stale, URL, or imported text sources. Use `diversity: "off"` only when raw ranking order is needed for diagnostics. Agents can request search diagnostics to inspect mode fallback, selected profile, applied search tuning, ranking coverage, path/source/test boosts, adjusted scores, and provenance such as chunk id, chunk hash, match reason, stale flag, and source freshness where available.

For best search quality, rebuild or update existing knowledge bases after upgrading. New indexes use contextual retrieval units: embeddings and FTS include file path, file type, Markdown heading breadcrumbs, and code symbol names while returned results keep the original chunk text readable. This improves queries that mention project structure, filenames, sections, or functions, and reduces duplicate-looking chunk hits.
Symbol/config/heading metadata is also rebuilt during `knowledge_update`; older KBs created before this feature may show a doctor action recommending update.

## Embedding Configuration

Local embeddings are the default and require no API key:

```bash
PI_KNOWLEDGE_EMBEDDING=local:multilingual-e5-small
```

OpenAI or OpenAI-compatible embedding APIs can be selected with `PI_KNOWLEDGE_EMBEDDING`:

```bash
export PI_KNOWLEDGE_EMBEDDING=openai:text-embedding-3-small
export OPENAI_API_KEY=...
```

For self-hosted OpenAI-compatible servers, set either `PI_KNOWLEDGE_EMBEDDING_BASE_URL` or `OPENAI_BASE_URL` to the API root that contains `/embeddings`:

```bash
export PI_KNOWLEDGE_EMBEDDING=openai:Qwen3-Embedding-8B
export PI_KNOWLEDGE_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=local-placeholder
```

API embedding failures are surfaced by default so configuration and context-window problems are visible. To explicitly allow query-time local fallback after API failures, set `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local`; indexing/import/update document batches still fail instead of creating mixed-provider vector files.

API embedding requests are capped at 20000 characters per input by default as a final context-window safety guard for OpenAI-compatible servers. Adjust this with `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` when your embedding model has a different context window; changing the cap changes embedding compatibility and requires `knowledge_update`.

Stored KB metadata includes the embedding model, vector dimension, and a non-secret embedding signature. If the current query embedding is incompatible with a KB's stored vectors, or if an older KB has no signature metadata, `knowledge_search` skips vector retrieval for that KB and reports a warning; run `knowledge_update` after changing embedding providers or upgrading older KBs.

## Configuration

Full configuration details are in [docs/configuration.md](docs/configuration.md).

| Area | Environment variables |
|------|-----------------------|
| Storage path | `PI_KNOWLEDGE_DIR`, `OMP_KNOWLEDGE_DIR`, `PI_CODING_AGENT_DIR`, `OMP_CODING_AGENT_DIR`, `OMP_PROFILE` |
| Model worker and cache | `PI_KNOWLEDGE_MODEL_CACHE_DIR`, `PI_KNOWLEDGE_NODE_PATH` |
| Embedding provider | `PI_KNOWLEDGE_EMBEDDING`, `OPENAI_API_KEY`, `PI_KNOWLEDGE_EMBEDDING_BASE_URL`, `OPENAI_BASE_URL`, `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS`, `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK` |
| Reranker provider | `PI_KNOWLEDGE_RERANKER`, `PI_KNOWLEDGE_RERANKER_REVISION`, `PI_KNOWLEDGE_RERANKER_DTYPE`, `PI_KNOWLEDGE_RERANKER_REMOTE_HOST`, `PI_KNOWLEDGE_RERANKER_REMOTE_PATH_TEMPLATE`, `PI_KNOWLEDGE_RERANKER_RAW_LOGITS`, `PI_KNOWLEDGE_RERANKER_API_ENDPOINT`, `PI_KNOWLEDGE_RERANKER_API_BASE_URL`, `PI_KNOWLEDGE_RERANKER_API_KEY`, `PI_KNOWLEDGE_RERANKER_API_FORMAT`, `PI_KNOWLEDGE_RERANKER_API_TIMEOUT_MS`, `PI_KNOWLEDGE_RERANKER_MAX_DOC_CHARS`, `PI_KNOWLEDGE_RERANKER_API_RESULTS_PATH`, `PI_KNOWLEDGE_RERANKER_API_INDEX_FIELD`, `PI_KNOWLEDGE_RERANKER_API_SCORE_FIELD`, `PI_KNOWLEDGE_RERANKER_API_SCORE_DIRECTION` |
| Native lifecycle | `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE`, `PI_KNOWLEDGE_EMBEDDING_IDLE_MS` |
| Runtime features | `PI_KNOWLEDGE_WATCH`, `PI_KNOWLEDGE_AUTO_INJECT`, `PI_KNOWLEDGE_STALE_INDEXING_MS`, `PI_KNOWLEDGE_OFFLINE`, `PI_KNOWLEDGE_SEARCH_PROFILE`, `PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT`, `PI_KNOWLEDGE_SNIPPET_MAX_LENGTH`, `PI_KNOWLEDGE_MIN_HYBRID_SCORE`, `PI_KNOWLEDGE_SEARCH_CANDIDATE_MIN`, `PI_KNOWLEDGE_SEARCH_CANDIDATE_MULTIPLIER`, `PI_KNOWLEDGE_ADAPTIVE_CONTEXT_LINES`, `PI_KNOWLEDGE_ADAPTIVE_MAX_CHARS`, `PI_KNOWLEDGE_ADAPTIVE_NEIGHBOR_TARGET`, `PI_KNOWLEDGE_DEEP_RERANK_CANDIDATES`, `PI_KNOWLEDGE_DEEP_RERANK_TOPK_MULTIPLIER` |
| Release fixtures | `PI_KNOWLEDGE_E2E_PDF`, `PI_KNOWLEDGE_E2E_DOCX` |

## Pi and OMP Support

`pi-knowledge` supports Pi and [OMP](https://omp.sh/) extension loading through the packaged `extension.js` entry shim. The entry stays startup-light: install-time validation can inspect the extension without resolving native runtime dependencies, and runtime modules load lazily only when tools or lifecycle hooks need them.

Default storage is `~/.pi/knowledge` for Pi and `~/.omp/knowledge` for OMP. Explicit overrides are available with `PI_KNOWLEDGE_DIR` and `OMP_KNOWLEDGE_DIR`. Under the default home OMP root, existing legacy `~/.pi/knowledge` data remains visible when `~/.omp/knowledge` has not been created yet.

OMP compatibility covers path resolution, packaged entry loading, native SQLite dependency resolution, isolated model-worker startup, Windows-safe worker transport fallback, and idempotent shutdown. Local embeddings require Node 22+ for the isolated worker; set `PI_KNOWLEDGE_NODE_PATH` to `node.exe` if OMP runs from a non-Node packaged host. Compatibility-sensitive releases should validate both Pi and OMP install/runtime flows.

## Large Project Indexing

Indexing is designed as a stable long-running operation, not a quick background trick. `knowledge_add`, `knowledge_update`, and `knowledge_import` scan directories incrementally, embed and store chunks in hard-capped batches, stream vector files to disk, and report progress with file/chunk counts, chunks/sec, skipped file counts, elapsed time, and file ETA where available. Directory indexing starts with a metadata-only planning scan so large repositories can show total scannable files and skipped counts before expensive embedding starts.

Directory indexing separates technical skips from user-confirmable suggestions. `knowledge_plan` inspects a source without writing a KB, so agents can show scannable files, suggested exclusions, and technical skips before asking the user to confirm scope. Unsupported binary/non-text files, oversized files, unreadable files, inaccessible paths, and documents that cannot be extracted are skipped for stability. Text files that may be private or low-signal, such as `.env`, credential-named files, generated reports, lockfiles, vendor text, build output text, and runtime/cache text, are suggested exclusions by default rather than permanent blocks. Agents should explain the privacy and search-precision tradeoff, ask the user when the choice is ambiguous, and then use `include_suggested_text` or focused `include_paths` when the user confirms those text files belong in the KB. Ordinary project configuration files such as `settings.json` or `appsettings.json` remain indexable because they often describe real system behavior.

Indexing progress is persisted in SQLite, not only printed as transient tool updates. `knowledge_status` shows the current or last indexing operation, phase, last progress message, last progress age, processed file/chunk counts, skipped count, and add/remove/unchanged counts. This makes long indexing runs distinguishable from stuck jobs even if the user checks status from a later prompt.

Update and diagnostics paths are also streaming-oriented: changed chunks are embedded in batches, newly produced vectors are written to temporary vector files, deleted rows are removed in batches, and final vector rebuilds iterate SQLite rows instead of loading the whole KB. Search also avoids loading a full KB vector file or all chunk IDs into memory. Semantic and hybrid modes scan vectors from disk and retain only the top candidate vectors needed for ranking/diversity. `knowledge_status` reports stale files, orphaned chunks, coverage, skipped files, and indexing jobs that appear stuck after an interrupted or crashed Pi process. `knowledge_doctor` summarizes the same signals as a health score with concrete actions. KBs still marked `indexing` or `error` are visible in status but skipped by search, so interrupted work is not treated as a healthy searchable KB. A stuck `indexing` KB should be removed and rebuilt after confirming no active Pi process is still building it.

## Architecture

[DESIGN.md](DESIGN.md) is the historical technical design. For current behavior contracts, prefer this README, [AGENTS.md](AGENTS.md), [docs/configuration.md](docs/configuration.md), and the ADR/pitfall notes under `docs/`.

## Data Storage

All data is stored globally at `~/.pi/knowledge/` under Pi or `~/.omp/knowledge/` under OMP unless overridden (never in your project directory):

```
~/.pi/knowledge/
├── knowledge.db      ← SQLite (metadata + chunks + FTS5 index)
├── vectors/          ← Embedding vectors per KB (binary)
└── models/           ← Downloaded ONNX models (~32MB, cached)
```

- **Backup**: copy the active knowledge directory, usually `~/.pi/knowledge/` or `~/.omp/knowledge/`
- **Reset**: delete the active knowledge directory to start fresh
- **Override**: set `PI_KNOWLEDGE_DIR` or `OMP_KNOWLEDGE_DIR`
- **Project safety**: pi-knowledge is read-only on indexed directories — no files are created or modified in your project
- **Updates**: extension updates do not affect existing indexed data. Schema migrations run automatically if needed.
- **Symbol index**: `knowledge.db` also stores lightweight symbol/config/heading metadata used by `knowledge_symbol_search`; it is derived from indexed source. File, directory, and URL KBs with retained source paths can rebuild it with `knowledge_update`; imported portable KBs and inline text KBs should be re-imported or re-added because they intentionally do not store an active local source manifest.

## Development

```bash
npm install
npm test          # Unit tests
npm run test:e2e # Smoke integration tests; PDF/DOCX cases skip unless fixture env vars are set
PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e
npm run bench     # Indexing/search benchmarks
node --experimental-strip-types -e "import('./index.ts')" # Startup-light source import smoke
```

PDF/DOCX fixtures should be real local files outside the repository. Do not commit private fixture files, extracted fixture text, snapshots, or machine-specific fixture paths. A release-grade e2e pass requires both fixture env vars; a run with skipped PDF/DOCX cases is only a smoke pass.

## Release

Before publishing, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then run:

```bash
npm run check
npm run typecheck
npm test
npm run build
npm run test:e2e
PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e
node -e "import('./extension.js')"
node --experimental-strip-types -e "import('./index.ts')"
npm pack --dry-run
pi -e ./extension.js
omp -e ./extension.js
git push origin main
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /path/to/release-notes.md
npm publish
```

Report any skipped or unverified gate explicitly. Do not describe smoke e2e as complete release-grade coverage.

## License

MIT
