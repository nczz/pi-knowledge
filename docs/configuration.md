# Configuration

`pi-knowledge` is local-first by default, but several environment variables are available for runtime selection, compatibility, and release validation.

## Storage and Host Runtime

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_DIR` | host-derived knowledge dir | Override the directory that stores `knowledge.db`, vectors, and model cache parent data for Pi and OMP. Takes precedence over `OMP_KNOWLEDGE_DIR`. |
| `OMP_KNOWLEDGE_DIR` | host-derived knowledge dir | Override the knowledge directory when running under OMP. Used when `PI_KNOWLEDGE_DIR` is not set. |
| `PI_CODING_AGENT_DIR` | unset | Derive the Pi host root from a configured agent directory. Useful for isolated installs and validation. |
| `OMP_CODING_AGENT_DIR` | unset | Derive the OMP host root from a configured agent directory. Used when `PI_CODING_AGENT_DIR` is not set. |
| `OMP_PROFILE` | unset | Treat the current process as OMP-hosted for default path selection. |
| `PI_KNOWLEDGE_MODEL_CACHE_DIR` | `<knowledge-dir>/models` | Override the local Transformers.js model cache directory. |
| `PI_KNOWLEDGE_NODE_PATH` | current Node when possible, then `NODE`, then `node` on `PATH` | Override the Node 22+ executable used to run the isolated model worker. Useful for Windows OMP packaged runtimes where the host process is not Node. |

Default data storage is `~/.pi/knowledge` under Pi and `~/.omp/knowledge` under OMP. For the default home OMP root, `pi-knowledge` preserves an existing legacy `~/.pi/knowledge` directory when `~/.omp/knowledge` does not exist, so existing Pi knowledge bases remain visible during migration.

## Embeddings

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_EMBEDDING` | `local:multilingual-e5-small` | Select the embedding provider and model. Supported values are local embeddings and `openai:<model>`. |
| `OPENAI_API_KEY` | unset | API key used when `PI_KNOWLEDGE_EMBEDDING=openai:<model>`. Some local OpenAI-compatible servers accept a placeholder value. |
| `PI_KNOWLEDGE_EMBEDDING_BASE_URL` | unset | OpenAI-compatible embedding API root, such as `http://127.0.0.1:8080/v1`. Takes precedence over `OPENAI_BASE_URL`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Common OpenAI-compatible API root fallback. |
| `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` | `20000` | Final per-input API embedding safety cap for OpenAI-compatible servers with smaller context windows. This does not replace chunker bounds. |
| `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK` | unset | Set to `local` to explicitly fall back to local embeddings for query embeddings after API failures. Indexing/import/update document batches do not fall back because mixed-provider vector files are unsafe. |
| `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE` | unset | Enables idle timers for embedding/reranker run coordination. It does not guarantee immediate worker memory release; model-worker shutdown remains tied to engine/session shutdown. Disabled by default for stable shutdown. |
| `PI_KNOWLEDGE_EMBEDDING_IDLE_MS` | `30000` | Idle timer used only when native idle disposal coordination is enabled. Mainly for lifecycle stress tests. |
| `PI_KNOWLEDGE_OFFLINE` | unset | Use with a pre-populated model cache for offline local model operation. See `docs/offline-mode.md`. |

Each KB stores the embedding model label, vector dimension, and a non-secret embedding signature that includes provider/model semantics, query/document prefixes, pooling, normalization, API input cap, and a hash of the API base URL when applicable. `knowledge_search` skips vector retrieval for KBs whose stored signature or dimension is missing or incompatible with the current query embedding and uses BM25-only fallback for hybrid searches. Run `knowledge_update` to rebuild vectors after changing embedding provider/model/max-character settings or after upgrading older KBs with no signature metadata.

## Reranker

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_RERANKER` | `Xenova/ms-marco-MiniLM-L-4-v2` | Reranker used by `deep` mode. Accepts local/HF forms (`<model>`, `hf:<model>`, Hugging Face model URLs) or `api:<model>` for an external HTTP rerank service. |
| `PI_KNOWLEDGE_RERANKER_REVISION` | `main` | Hugging Face revision passed to Transformers.js for local/HF rerankers. Explicit env value overrides a revision parsed from a model URL. |
| `PI_KNOWLEDGE_RERANKER_DTYPE` | unset | Optional Transformers.js dtype, such as `fp32`, for local/HF rerankers. |
| `PI_KNOWLEDGE_RERANKER_REMOTE_HOST` | Hugging Face host or URL-derived host | Remote artifact host for HF-compatible model repositories. Use with trusted mirrors only. |
| `PI_KNOWLEDGE_RERANKER_REMOTE_PATH_TEMPLATE` | `{model}/resolve/{revision}/` | Transformers.js remote path template for HF-compatible mirrors. |
| `PI_KNOWLEDGE_RERANKER_RAW_LOGITS` | unset | Set to `true` for single-logit cross-encoder rerankers whose raw scores are flattened by sigmoid scoring. Multi-logit classifiers are rejected unless this option is disabled. |
| `PI_KNOWLEDGE_RERANKER_API_ENDPOINT` | derived from base URL | Full HTTP rerank endpoint. Takes precedence over `PI_KNOWLEDGE_RERANKER_API_BASE_URL` and `OPENAI_BASE_URL`. |
| `PI_KNOWLEDGE_RERANKER_API_BASE_URL` | `https://api.cohere.com/v2` | Base URL for Cohere/Jina-compatible `/rerank` APIs. `OPENAI_BASE_URL` is accepted only as a convenience fallback for gateways exposing the same schema. |
| `PI_KNOWLEDGE_RERANKER_API_KEY` | `OPENAI_API_KEY` fallback | Bearer token for API rerankers. Omit only for trusted local services that do not require auth. |
| `PI_KNOWLEDGE_RERANKER_API_FORMAT` | `cohere` | Request/response preset: `cohere`, `jina`, or `custom-json`. All presets send `model`, `query`, `documents`, `top_n`, and `return_documents:false`. |
| `PI_KNOWLEDGE_RERANKER_API_TIMEOUT_MS` | `30000` | Per-request timeout for API reranking. |
| `PI_KNOWLEDGE_RERANKER_MAX_DOC_CHARS` | `12000` | Per-candidate document safety cap before sending content to the API. |
| `PI_KNOWLEDGE_RERANKER_API_RESULTS_PATH` | `results` | Dot path to the result array for `custom-json` or compatible responses. |
| `PI_KNOWLEDGE_RERANKER_API_INDEX_FIELD` | `index` | Field name or dot path holding the original candidate index. |
| `PI_KNOWLEDGE_RERANKER_API_SCORE_FIELD` | `relevance_score` | Field name or dot path holding the rerank score. |
| `PI_KNOWLEDGE_RERANKER_API_SCORE_DIRECTION` | `desc` | Sort direction for returned scores: `desc` when higher is better, `asc` when lower is better. |

Reranker settings affect query-time `deep` search only; they do not change indexed KB vectors. Local/HF rerankers run in the isolated model worker. Offline mode sets the model worker to local-only loading, so a local/HF reranker must already exist in the model cache. `PI_KNOWLEDGE_RERANKER_RAW_LOGITS=true` switches local/HF rerankers from the Transformers.js text-classification pipeline to direct sequence-classification logits and is intended only for trusted single-logit reranker models; use trusted model repositories or pinned revisions for non-default artifacts. API rerankers send the query and selected candidate chunk content to the configured external service; failures surface by default and do not silently fall back to the local worker.

Local embeddings require a real Node 22+ executable for the isolated model worker. `pi-knowledge` first tries Node IPC and automatically falls back to a stdin/stdout JSONL worker transport when the host runtime does not expose `child_process.fork().send()`, which can happen in Windows OMP compatibility layers. On Windows it searches `PI_KNOWLEDGE_NODE_PATH`, persisted `knowledge_configure` settings, common Node, Volta, NVM, Codex `cua_node`, and `PATH` locations before failing. If worker startup still fails, call `knowledge_configure` with the full `node.exe` path such as `C:\Program Files\nodejs\node.exe`; accidental surrounding quotes are ignored. OpenAI-compatible embeddings avoid the local worker entirely.

API embedding failures intentionally surface by default. Silent fallback can hide bad API keys, wrong base URLs, unsupported model names, or context-window errors and can produce a KB with a different embedding model than intended. Query-time fallback is opt-in; indexing fallback is disabled to prevent mixed vector spaces in one KB.

## Runtime Features and Diagnostics

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_WATCH` | unset | Set to `true` to start file watchers for directory KBs. The polling fallback remains available when native `fs.watch` fails. |
| `PI_KNOWLEDGE_AUTO_INJECT` | unset | Set to `true` to auto-search KB context before model calls. This is opt-in. |
| `PI_KNOWLEDGE_STALE_INDEXING_MS` | built-in stale threshold | Override the stale indexing threshold used by diagnostics and `knowledge_doctor`. |
| `PI_KNOWLEDGE_SEARCH_PROFILE` | `auto` | Select the default search tuning profile. Values: `auto`, `balanced`, `low_token`, `precision`, `recall`, `long_context`, `code`, `docs`. Tool `profile` parameters override this. |
| `PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT` | profile default | Override the result limit used only when `knowledge_search` does not pass `limit`. Clamped to 1-50. |
| `PI_KNOWLEDGE_SNIPPET_MAX_LENGTH` | profile default | Override returned snippet length. Clamped to 80-4000 characters. |
| `PI_KNOWLEDGE_MIN_HYBRID_SCORE` | profile default | Override the hybrid confidence gate. Higher values reduce noisy results; lower values increase recall. Clamped to 0-1. |
| `PI_KNOWLEDGE_SEARCH_CANDIDATE_MIN` | profile default | Override the minimum internal retrieval candidate pool. Clamped to 10-500. |
| `PI_KNOWLEDGE_SEARCH_CANDIDATE_MULTIPLIER` | profile default | Override the internal candidate multiplier applied to the effective result limit. Clamped to 2-30. |
| `PI_KNOWLEDGE_ADAPTIVE_CONTEXT_LINES` | profile default | Override surrounding lines fetched for `adaptive` context expansion. Clamped to 10-500. |
| `PI_KNOWLEDGE_ADAPTIVE_MAX_CHARS` | profile default | Override maximum adaptive context characters per result. Clamped to 1000-50000. |
| `PI_KNOWLEDGE_ADAPTIVE_NEIGHBOR_TARGET` | profile default | Override the number of nearby/query-relevant chunks considered for adaptive windows. Clamped to 1-20. |
| `PI_KNOWLEDGE_DEEP_RERANK_CANDIDATES` | profile default | Override how many filtered candidates `deep` mode sends to the reranker. Clamped to 5-100. |
| `PI_KNOWLEDGE_DEEP_RERANK_TOPK_MULTIPLIER` | profile default | Override deep rerank top-k multiplier relative to the effective result limit. Clamped to 1-10. |

Search diagnostics include result provenance and applied search tuning in both text output and structured `details`: selected profile, effective limit, snippet length, hybrid threshold, candidate pool size, chunk id, chunk hash, match reason, indexed timestamp, stale flag, and source mtime when the original source file is available. This provenance is stored in SQLite and derived from indexed source metadata; it does not create or modify files in the indexed project.

`knowledge_search` supports `file_type`, `path_pattern`, `profile`, and explicit `limit` filters. Search profiles tune result count, snippets, hybrid strictness, candidate breadth, adaptive context, and deep rerank breadth at runtime. `auto` chooses from query shape, mode, and KB source type; explicit tool parameters win over env overrides, env overrides win over profile defaults, and profile defaults win over built-in compatibility values. `hybrid` mode remains lexical-anchored to prevent low-evidence semantic false positives; use `semantic` when the query is conceptual and exact terms may differ from indexed wording.

`knowledge_doctor` emits both human-readable issues and machine-readable actions in structured `details`. Action codes include `run_update`, `rebuild_kb`, `wait_for_indexing`, `review_skipped_scope`, `rebuild_vectors`, `check_source`, and `none`. Agents should prefer these action codes over parsing the English action text.

`knowledge_configure` writes runtime configuration to the knowledge directory's `config.json`. It validates Node 22+ before persisting `node_path`, so agents can configure a Codex- or user-installed `node.exe` once without relying on environment variables being injected into an already-running OMP process.

`knowledge_symbol_search` uses a lightweight declaration-pattern index stored in `knowledge.db`. It is rebuilt during `knowledge_add`, `knowledge_update`, and `knowledge_import`, and can find common code symbols, route-like handlers, Markdown headings, config keys, and environment variables. It is not a full LSP or code graph; for methods, uncommon syntax, or empty important lookups, use `knowledge_search` mode `fast`/`adaptive` and check `knowledge_doctor` for stale or missing symbol metadata. Older file/directory/URL KBs without symbol metadata should be updated before relying on symbol lookup. Imported portable KBs and inline text KBs do not retain an active source path; rebuild their symbols by re-importing or re-adding the content.

## Test and Release Fixtures

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_E2E_PDF` | unset | Path to an external PDF fixture for release-grade e2e extraction coverage. |
| `PI_KNOWLEDGE_E2E_DOCX` | unset | Path to an external DOCX fixture for release-grade e2e extraction coverage. |

When `PI_KNOWLEDGE_E2E_PDF` or `PI_KNOWLEDGE_E2E_DOCX` is unset, `npm run test:e2e` is only a smoke gate for those document formats. Do not commit fixture files, fixture paths, extracted text, or snapshots.

## Pi and OMP Support

`pi-knowledge` supports direct Pi extension loading through `pi -e ./extension.js` and OMP-compatible loading through the same packaged entry shim. The root `extension.js` and `index.ts` stay startup-light so install-time validation can inspect the extension without resolving native runtime dependencies such as `better-sqlite3` or `onnxruntime-node`.

Compatibility guarantees:

- The packaged `extension.js` loads built `dist/index.js` when present and falls back to source `index.ts` for local development.
- Runtime modules are imported lazily, after the extension is actually used.
- Local embedding and reranking models run in an isolated Node model worker, not in the Pi or OMP TUI process. Node IPC is preferred; stdin/stdout JSONL transport is used automatically when host IPC is unavailable.
- Native SQLite loading includes a fallback for hoisted plugin dependency layouts.
- OMP path resolution can use `OMP_KNOWLEDGE_DIR`, `OMP_CODING_AGENT_DIR`, and `OMP_PROFILE`.
- Existing default Pi knowledge data can remain visible under the default OMP home root through the legacy `~/.pi/knowledge` fallback described above.

Release validation should include both Pi and OMP when compatibility-sensitive code changes touch entry shims, native dependency loading, storage path resolution, model-worker startup, or lifecycle shutdown.
