# Configuration

`pi-knowledge` is local-first by default, but several environment variables are available for runtime selection, compatibility, and release validation.

## Storage and Host Runtime

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_PROFILE` | `default` | Select the process-wide knowledge profile. Profile names are lowercase ASCII keys; named profiles are an advanced isolation feature. |
| `PI_KNOWLEDGE_PROFILE_ROOT` | `~/.pi-knowledge/profiles` | Override the root used for named profiles. It does not move or merge an existing default profile. |
| `PI_KNOWLEDGE_DIR` | persisted default mapping or legacy directory | Override storage for the `default` profile only. The directory contains `knowledge.db`, vectors, model/runtime config, and `coverage.json`. Takes precedence over `OMP_KNOWLEDGE_DIR`. |
| `OMP_KNOWLEDGE_DIR` | unset | Override default-profile storage when `PI_KNOWLEDGE_DIR` is not set. Named profiles reject both storage overrides. |
| `PI_CODING_AGENT_DIR` | unset | Candidate used only when first claiming the default profile from an existing host-derived knowledge directory. |
| `OMP_CODING_AGENT_DIR` | unset | OMP candidate used only when first claiming the default profile. |
| `OMP_PROFILE` | unset | Retained for host compatibility; profile selection uses `PI_KNOWLEDGE_PROFILE`. |
| `PI_KNOWLEDGE_RUNTIME_DIR` | per-user private runtime directory | Advanced override for Unix daemon socket placement. The directory must be owner-only. |
| `PI_KNOWLEDGE_MODEL_CACHE_DIR` | `<profile-storage>/models` | Override the local Transformers.js model cache directory. |
| `PI_KNOWLEDGE_NODE_PATH` | persisted profile runtime, then worker discovery | Override the Node 22+ executable used by the isolated model/document worker. Daemon startup itself accepts only the current trusted Node runtime or an explicit path persisted by `knowledge_configure`. |

The zero-configuration path is the `default` profile. On first use, `~/.pi-knowledge/profiles.json` atomically records one canonical default storage directory. A single existing Pi/OMP legacy database is adopted in place; multiple distinct legacy databases fail closed until `PI_KNOWLEDGE_DIR` selects one. Named profiles use `~/.pi-knowledge/profiles/<name>` and never fall back to default.

Each profile has one long-lived daemon that owns its SQLite handle, vectors, model worker, mutations, watchers, and `coverage.json`. Pi/OMP sessions connect to that daemon and do not stop it on session shutdown. Use `pi-knowledge-daemon start|status|stop [--profile <name>]` for explicit lifecycle control.

## Embeddings

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_EMBEDDING` | `local:multilingual-e5-small` | Select the embedding provider and model. Supported values are local embeddings and `openai:<model>`. |
| `PI_KNOWLEDGE_EMBEDDING_API_KEY` | unset | API key for OpenAI-compatible embedding APIs. Takes precedence over `OPENAI_API_KEY`; omit for trusted local endpoints that do not require auth. |
| `OPENAI_API_KEY` | unset | Fallback API key used when `PI_KNOWLEDGE_EMBEDDING=openai:<model>`. Required by OpenAI's hosted API; many local OpenAI-compatible servers do not need it. |
| `PI_KNOWLEDGE_EMBEDDING_BASE_URL` | unset | OpenAI-compatible embedding API root, such as `http://127.0.0.1:8080/v1`. Takes precedence over `OPENAI_BASE_URL`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Common OpenAI-compatible API root fallback. |
| `PI_KNOWLEDGE_EMBEDDING_PREFIXES` | `on` | Embedding input decoration strategy. `on`/`e5` use `query: ` and `passage: `; `off`/`none` use raw text; `jina`/`jina-code` use published Jina Code prompts; `custom` uses the two instruction variables below. |
| `PI_KNOWLEDGE_EMBEDDING_TASK` | `nl2code` for `jina-code` | Jina Code prompt task: `nl2code`, `code2code`, `code2nl`, `code2completion`, or `qa`. Rejected for other strategies. |
| `PI_KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION` | unset | Exact query instruction for `custom`. Required and non-empty; maximum 512 characters. Whitespace is preserved. |
| `PI_KNOWLEDGE_EMBEDDING_DOCUMENT_INSTRUCTION` | unset | Exact document instruction for `custom`. Required; may be an explicit empty string; maximum 512 characters. Whitespace is preserved. |
| `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` | `20000` | Final complete-input API embedding safety cap after instructions are added. Configuration fails if an instruction alone leaves no room for text. This does not replace chunker bounds. |
| `PI_KNOWLEDGE_EMBEDDING_BATCH_SIZE` | `64` | Maximum number of document chunks sent in one embedding request during add, update, and import. Lower this for self-hosted embedding servers with smaller request batch limits. |
| `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK` | unset | Set to `local` to explicitly fall back to local embeddings for query embeddings after API failures. Indexing/import/update document batches do not fall back. `jina-code` and `custom` reject local fallback during configuration because the local E5 model cannot reproduce those inputs. |
| `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE` | unset | Enables idle timers for embedding/reranker run coordination. It does not guarantee immediate worker memory release; model-worker shutdown remains tied to engine/session shutdown. Disabled by default for stable shutdown. |
| `PI_KNOWLEDGE_EMBEDDING_IDLE_MS` | `30000` | Idle timer used only when native idle disposal coordination is enabled. Mainly for lifecycle stress tests. |
| `PI_KNOWLEDGE_OFFLINE` | unset | Use with a pre-populated model cache for offline local model operation. See `docs/offline-mode.md`. |

Each KB stores the embedding model label, vector dimension, and a non-secret embedding signature that includes provider/model semantics, the input decoration descriptor, pooling, normalization policy, API input cap, and a hash of the API base URL when applicable. E5 `on` and raw-text `off` descriptors remain byte-compatible with existing signatures; Jina signatures include the task and instruction hash, while custom signatures contain only an instruction hash rather than the raw instruction text. OpenAI-compatible response vectors are validated and L2-normalized by the client before use or persistence; the `client-l2-v1` policy is part of API signatures. `knowledge_search` skips vector retrieval for missing or incompatible signatures/dimensions and uses BM25-only fallback for hybrid searches. `knowledge_status` reports indexed and active embedding settings and counts incompatibility in aggregate health. `knowledge_doctor` reports configuration failures and rebuild actions. Run `knowledge_update` after changing provider, model, endpoint, input cap, task, or instructions; re-add inline text or re-import portable sources that cannot be updated.

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
| `PI_KNOWLEDGE_RERANKER_API_FORMAT` | `cohere` | Request/response preset: `cohere`, `jina`, `custom-json`, or `tei`. Cohere/Jina-compatible presets send `model`, `query`, `documents`, `top_n`, and `return_documents:false`; `tei` sends `query` plus `texts` and parses a root response array with `index`/`score`. |
| `PI_KNOWLEDGE_RERANKER_API_TIMEOUT_MS` | `30000` | Per-request timeout for API reranking. |
| `PI_KNOWLEDGE_RERANKER_MAX_DOC_CHARS` | `12000` | Per-candidate document safety cap before sending content to the API. |
| `PI_KNOWLEDGE_RERANKER_API_RESULTS_PATH` | `results` (`tei`: root response array) | Dot path to the result array for `custom-json` or compatible responses. |
| `PI_KNOWLEDGE_RERANKER_API_INDEX_FIELD` | `index` | Field name or dot path holding the original candidate index. |
| `PI_KNOWLEDGE_RERANKER_API_SCORE_FIELD` | `relevance_score` (`tei`: `score`) | Field name or dot path holding the rerank score. |
| `PI_KNOWLEDGE_RERANKER_API_SCORE_DIRECTION` | `desc` | Sort direction for returned scores: `desc` when higher is better, `asc` when lower is better. |

Reranker settings affect query-time `deep` search only; they do not change indexed KB vectors. Local/HF rerankers run in the isolated model worker. Offline mode sets the model worker to local-only loading, so a local/HF reranker must already exist in the model cache. `PI_KNOWLEDGE_RERANKER_RAW_LOGITS=true` switches local/HF rerankers from the Transformers.js text-classification pipeline to direct sequence-classification logits and is intended only for trusted single-logit reranker models; use trusted model repositories or pinned revisions for non-default artifacts. API rerankers send the query and selected candidate chunk content to the configured external service; failures surface by default and do not silently fall back to the local worker.

For Hugging Face Text Embeddings Inference rerankers, set `PI_KNOWLEDGE_RERANKER_API_FORMAT=tei` and point `PI_KNOWLEDGE_RERANKER_API_ENDPOINT` at the TEI `/rerank` endpoint, for example `http://127.0.0.1:8080/rerank`. Do not reuse an embeddings `OPENAI_BASE_URL` ending in `/v1` unless the reranker endpoint actually exists there; TEI's OpenAI-compatible route covers embeddings, while reranking uses `/rerank`.

Local embeddings, local/HF reranking, and PDF/DOCX extraction require a real Node 22+ executable for the isolated worker. `pi-knowledge` first tries Node IPC and automatically falls back to a stdin/stdout JSONL worker transport when the host runtime does not expose `child_process.fork().send()`, which can happen in Windows OMP compatibility layers. On Windows it searches `PI_KNOWLEDGE_NODE_PATH`, persisted `knowledge_configure` settings, common Node, Volta, NVM, Codex `cua_node`, and `PATH` locations before failing. If worker startup still fails, call `knowledge_configure` with the full `node.exe` path such as `C:\Program Files\nodejs\node.exe`; accidental surrounding quotes are ignored. OpenAI-compatible embeddings avoid local model loading, but document extraction still uses the worker to isolate parser stdio from the host.

API embedding failures intentionally surface by default. Silent fallback can hide bad API keys, wrong base URLs, unsupported model names, context-window errors, server batch limits, or instruction mismatches and can produce a KB with a different embedding model than intended. Query-time fallback is opt-in and supports only E5 `on`/`off` semantics; indexing fallback is disabled to prevent mixed vector spaces in one KB. OpenAI-compatible embedding requests send `Authorization: Bearer <key>` only when `PI_KNOWLEDGE_EMBEDDING_API_KEY` or `OPENAI_API_KEY` is configured. Instruction decoration is applied once before both safety-cap validation and the HTTP request.

Embedding and reranker API failures use the exported `ProviderError` class and expose provider, operation, HTTP/network/timeout/cancellation kind, optional numeric HTTP `status`, and an optional validated network `code` as direct read-only properties. The same safe facts survive the profile daemon and MCP response. Credentials, headers, and arbitrary provider response fields are not copied into this metadata. HTTP 408/425/429 and 5xx, network failures, and timeouts are reported as retryable; other 4xx failures direct the operator to endpoint, credential, model, or request-limit configuration. This classification does not trigger automatic retries. If `knowledge_update` fails after a KB already has a published generation, that generation remains searchable while the failed job and provider facts remain visible in `knowledge_status` and `knowledge_doctor`.

## Runtime Features and Diagnostics

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_WATCH` | unset | Set to `true` to connect to the selected daemon at session start and enable directory KB watchers. Without this flag, default Pi/OMP session startup remains cold until a tool or auto-injection needs the daemon. The polling fallback remains available when native `fs.watch` fails. |
| `PI_KNOWLEDGE_AUTO_INJECT` | unset | Set to `true` to auto-search KB context before model calls. This is opt-in and lazily connects to the daemon on the first eligible context event. |
| `PI_KNOWLEDGE_STALE_INDEXING_MS` | built-in stale threshold | Override the stale indexing threshold used by diagnostics and `knowledge_doctor`. |
| `PI_KNOWLEDGE_SCAN_TIMEOUT_MS` | `0` (disabled) | Optional wall-clock limit in milliseconds for each asynchronous directory traversal pass used by plan/add/update, live diagnostics, and watcher snapshots. Caller work between yielded files also counts, so update extraction/chunking/embedding/storage can consume the budget. Timeout errors report visited entries and yielded files. Invalid values fail daemon startup. `0` keeps progressing large scans unbounded while entry-count, byte, depth, file-size, access, and cancellation bounds remain active. Restart the selected profile daemon after changing this setting. |
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

Search diagnostics include result provenance and applied search tuning in both text output and structured `details`: selected profile, effective limit, snippet length, hybrid threshold, global candidate limit, per-KB retrieval limit, retrieved/threshold-passed/eligibility-passed/metadata-passed/diversity candidate counts, global-pool truncation, chunk id, chunk hash, match reason, persisted indexed timestamp, and stale flag derived from persisted KB status. Query-time search reads indexed data only and does not stat retained source paths.

`knowledge_search` supports `file_type`, substring `path_pattern`, `profile`, integer `limit` from 1 to 50, and non-negative integer `offset`. `offset + limit` cannot exceed the 800-candidate global search window. Each KB retrieves up to the profile-derived candidate limit, then merged results are ranked, filtered, and globally capped before deep reranking, adaptive expansion, or diversity. Search profiles tune result count, snippets, hybrid strictness, candidate breadth, adaptive context, and deep rerank breadth at runtime. `auto` chooses from query shape, mode, and KB source type; explicit tool parameters win over env overrides, env overrides win over profile defaults, and profile defaults win over built-in compatibility values. `hybrid` mode remains lexical-anchored to prevent low-evidence semantic false positives; use `semantic` for pure vector search, or `semantic_hybrid` when weak lexical overlap should not block vector-backed weighted fusion. `adaptive` uses bounded same-file context expansion; when AST metadata is present it can prefer same-parent/sibling chunks without claiming caller/callee graph semantics.

Empty `knowledge_search` responses always include structured `details.miss` with a deterministic reason, action, searched/skipped KB summaries, stage counts, requested filters, and bounded `auto` attempt summaries. Empty `knowledge_symbol_search` responses expose the corresponding symbol miss contract. The default text is a two-line rendering of these facts. Miss classification does not run source diagnostics, enumerate absolute source paths, change ranking, or mutate a KB.

`knowledge_doctor` emits both human-readable issues and machine-readable actions in structured `details`. Action codes include `run_update`, `rebuild_kb`, `wait_for_indexing`, `review_skipped_scope`, `rebuild_vectors`, `reindex_for_embedding_budget`, `fix_embedding_config`, `check_source`, and `none`. Agents should prefer these action codes over parsing the English action text.

`knowledge_configure` writes runtime configuration to the knowledge directory's `config.json`. It validates Node 22+ before persisting `node_path`, so agents can configure a Codex- or user-installed `node.exe` once without relying on environment variables being injected into an already-running OMP process.

`knowledge_symbol_search` uses a lightweight symbol index stored in `knowledge.db`. It is rebuilt during `knowledge_add`, `knowledge_update`, and `knowledge_import`, and can find AST-backed methods/functions/classes/interfaces/types/variables for supported code files, route-like handlers, Markdown headings, config keys, and environment variables. It is not a full LSP or code graph; it does not answer caller/callee or rename-safety questions. Empty lookups distinguish missing KBs, unavailable KBs, empty symbol metadata, exact-name misses, metadata filters, pagination, and ordinary no-match results. If the symbol index itself is empty, use `knowledge_update` for source-backed KBs; imported portable KBs and inline text KBs do not retain an active source path and must be re-imported or re-added from the original content.

### Standalone MCP server

`pi-knowledge-mcp [--profile <name>]` connects to the selected daemon. It uses stdio by default; `--transport http` starts an authenticated Streamable HTTP endpoint for multiple local clients. Both transports are read-only by default and list only indexed search, symbol search, and show. These paths do not rescan retained source directories.

| Option or variable | Default | Purpose |
|--------------------|---------|---------|
| `--transport stdio\|http` | `stdio` | Select a per-client stdio adapter or a shared local HTTP process. |
| `PI_KNOWLEDGE_MCP_HTTP_TOKEN` | unset | Required only for HTTP. Must contain 32–512 visible ASCII characters and is accepted as a bearer token. Keep it out of arguments, source control, logs, and shared config. |
| `--host` | `127.0.0.1` | HTTP bind host. Only `127.0.0.1`, `::1`, and `localhost` are accepted. |
| `--port` | `3210` | HTTP TCP port; `0` requests an ephemeral port. |
| `--endpoint` | `/mcp` | One absolute HTTP endpoint path without query or fragment. |
| `--allow-origin <origin>` | none | Repeatable exact HTTP(S) supplied origin. Requests without `Origin` are allowed; an unlisted supplied origin is rejected. This validation does not enable browser CORS/preflight. |

HTTP mode does not provide TLS, OAuth, or remote binding. It is a same-machine transport; use stdio when one client owns the adapter. For several local clients, start one persistent HTTP adapter and give each client the same loopback URL and token. Separate endpoints are required when clients need different capability sets.

- `--allow-root <canonical-dir>` may be repeated; it enables `knowledge_plan` and authorizes local source/import/export paths inside those roots. Roots must be current-user-owned and not group/world-writable on Unix, or private by Windows ACL. The adapter canonicalizes arguments for early rejection; the daemon independently rebinds the root inode and revalidates containment at operation time.
- `--allow-network` authorizes public URL sources; the normal private-network and redirect policy still applies.
- `--allow-write` exposes add/update/import/export, subject to the root/network capabilities above.
- `--allow-admin` exposes live status/doctor diagnostics plus configure/remove/clear. Status and doctor can rescan every retained source, so they are not exposed to the capability-free MCP surface. Tool confirmation remains required for destructive calls, but confirmation is not authorization.

The server supports legacy `initialize` protocols `2025-11-25`, `2025-06-18`, and `2025-03-26`, plus modern `2026-07-28` `server/discover`, tool progress, and cancellation. Stdio uses newline-delimited JSON-RPC. HTTP uses POST with JSON or request-scoped SSE, mandatory modern mirrored headers, negotiated legacy session IDs, and DELETE session termination; GET intentionally returns `405`. Valid tool execution/cancellation failures use an MCP tool result with `isError: true`; malformed JSON-RPC requests remain protocol errors.

Client shutdown cancels adapter requests without stopping the profile daemon. HTTP shutdown stops admission, aborts active session work, drains bounded operations, and is idempotent. See [MCP Client Setup](mcp-clients.md) for npm installation, Claude Code, Codex, Cursor, VS Code Copilot, capability, profile, upgrade, and token examples.


## Test and Release Fixtures

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_E2E_PDF` | unset | Path to an external PDF fixture for release-grade e2e extraction coverage. |
| `PI_KNOWLEDGE_E2E_DOCX` | unset | Path to an external DOCX fixture for release-grade e2e extraction coverage. |

When `PI_KNOWLEDGE_E2E_PDF` or `PI_KNOWLEDGE_E2E_DOCX` is unset, `npm run test:e2e` is only a smoke gate for those document formats. Do not commit fixture files, fixture paths, extracted text, or snapshots.

## Pi and OMP Support

`pi-knowledge` supports direct Pi extension loading through `pi -e ./extension.js` and OMP-compatible loading through the same packaged entry shim. The root `extension.js` and `index.ts` stay startup-light so install-time validation can inspect the extension without resolving native runtime dependencies such as `better-sqlite3` or `onnxruntime-node`.

Minimal Ubuntu/Debian servers need native build tools before `omp install npm:pi-knowledge`,
because OMP's Bun-based npm install compiles `better-sqlite3` from source when Bun cannot use
the package prebuild:

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
omp install npm:pi-knowledge
```

Compatibility guarantees:

- The packaged `extension.js` loads built `dist/index.js` when present and falls back to source `index.ts` for local development.
- Default session startup and `before_agent_start` remain daemon-free; tools and opt-in auto-injection connect lazily, while `PI_KNOWLEDGE_WATCH=true` is the explicit eager path.
- Windows profile/runtime hardening uses Windows PowerShell 5.1 only as a process host for typed .NET owner+DACL operations. It preserves group/SACL data, does not request `SeSecurityPrivilege`, verifies path and ancestor trust fail-closed, and never interpolates paths into PowerShell source.
- Local embedding/reranking models and PDF/DOCX parsers run in an isolated Node worker, not in the Pi or OMP TUI process. Node IPC is preferred; stdin/stdout JSONL transport is used automatically when host IPC is unavailable.
- Native SQLite loading includes a fallback for hoisted plugin dependency layouts.
- OMP path resolution can use `OMP_KNOWLEDGE_DIR`, `OMP_CODING_AGENT_DIR`, and `OMP_PROFILE`.
- Existing default Pi knowledge data can remain visible under the default OMP home root through the legacy `~/.pi/knowledge` fallback described above.

Release validation should include both Pi and OMP when compatibility-sensitive code changes touch entry shims, native dependency loading, storage path resolution, model-worker startup, or lifecycle shutdown.
