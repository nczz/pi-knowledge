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
| `PI_KNOWLEDGE_NODE_PATH` | current Node when possible, otherwise `node` | Override the Node executable used to fork the isolated model worker. |

Default data storage is `~/.pi/knowledge` under Pi and `~/.omp/knowledge` under OMP. For the default home OMP root, `pi-knowledge` preserves an existing legacy `~/.pi/knowledge` directory when `~/.omp/knowledge` does not exist, so existing Pi knowledge bases remain visible during migration.

## Embeddings

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_EMBEDDING` | `local:multilingual-e5-small` | Select the embedding provider and model. Supported values are local embeddings and `openai:<model>`. |
| `OPENAI_API_KEY` | unset | API key used when `PI_KNOWLEDGE_EMBEDDING=openai:<model>`. Some local OpenAI-compatible servers accept a placeholder value. |
| `PI_KNOWLEDGE_EMBEDDING_BASE_URL` | unset | OpenAI-compatible embedding API root, such as `http://127.0.0.1:8080/v1`. Takes precedence over `OPENAI_BASE_URL`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Common OpenAI-compatible API root fallback. |
| `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` | `20000` | Final per-input API embedding safety cap for OpenAI-compatible servers with smaller context windows. This does not replace chunker bounds. |
| `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK` | unset | Set to `local` to explicitly fall back to local embeddings after API failures. Without this, API failures are surfaced. |
| `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE` | unset | Set to `true` to opt into native ONNX idle disposal. Disabled by default for stable shutdown. |
| `PI_KNOWLEDGE_EMBEDDING_IDLE_MS` | `30000` | Idle-dispose timer used only when native idle disposal is enabled. Mainly for lifecycle stress tests. |
| `PI_KNOWLEDGE_OFFLINE` | unset | Use with a pre-populated model cache for offline local model operation. See `docs/offline-mode.md`. |

API embedding failures intentionally surface by default. Silent fallback can hide bad API keys, wrong base URLs, unsupported model names, or context-window errors and can produce a KB with a different embedding model than intended.

## Runtime Features and Diagnostics

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_KNOWLEDGE_WATCH` | unset | Set to `true` to start file watchers for directory KBs. The polling fallback remains available when native `fs.watch` fails. |
| `PI_KNOWLEDGE_AUTO_INJECT` | unset | Set to `true` to auto-search KB context before model calls. This is opt-in. |
| `PI_KNOWLEDGE_STALE_INDEXING_MS` | built-in stale threshold | Override the stale indexing threshold used by diagnostics and `knowledge_doctor`. |

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
- Local embedding and reranking models run in an isolated model worker, not in the Pi or OMP TUI process.
- Native SQLite loading includes a fallback for hoisted plugin dependency layouts.
- OMP path resolution can use `OMP_KNOWLEDGE_DIR`, `OMP_CODING_AGENT_DIR`, and `OMP_PROFILE`.
- Existing default Pi knowledge data can remain visible under the default OMP home root through the legacy `~/.pi/knowledge` fallback described above.

Release validation should include both Pi and OMP when compatibility-sensitive code changes touch entry shims, native dependency loading, storage path resolution, model-worker startup, or lifecycle shutdown.
