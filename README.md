# pi-knowledge

**Vector knowledge base extension for Pi** — index any file, directory, or text into persistent, searchable knowledge bases with hybrid semantic + keyword search.

Built as a native [Pi extension](https://pi.dev/docs/latest/extensions), deeply integrated with the agent lifecycle. Designed to match and exceed what kiro-cli's built-in knowledge tool offers, while being 100% local and provider-agnostic.

## Why

Coding agents forget everything outside their context window. `pi-knowledge` gives Pi persistent, searchable long-term memory over your documentation, codebases, specs, and notes — across sessions, across projects.

Unlike `pi-memory` (which manages the agent's own notes), `pi-knowledge` indexes **your existing files** and makes them semantically searchable by the agent.

## Features

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
| **Local embeddings (zero API)** | ✅ | ❌ | ✅ (qmd) |
| **Index quality diagnostics** | ✅ | ❌ | ❌ |
| **Metadata filters in search** | ✅ | ❌ | ❌ |
| **Progress reporting + stuck indexing diagnostics** | ✅ | partial | ❌ |
| Cross-session persistence | ✅ | ✅ | ✅ |
| Pi extension native | ✅ | N/A | ✅ |
| Context injection per turn | ✅ | ❌ | ✅ |
| TUI custom rendering | planned | N/A | ❌ |
| RPC mode support | ✅ | N/A | N/A |

## Research-Backed Retrieval

`pi-knowledge` turns retrieval research into product behavior that agents can actually use:

- **RAG-native project memory**: follows the Retrieval-Augmented Generation pattern from Lewis et al. 2020: keep source truth outside the model, retrieve it at answer time, and inject only relevant context.
- **Dense semantic recall**: uses multilingual dense embeddings in the spirit of Dense Passage Retrieval (Karpukhin et al. 2020), so conceptual queries can find code/docs even when wording differs.
- **Contextual Retrieval without remote chunk rewriting**: applies Anthropic's Contextual Retrieval insight locally by embedding file path, file type, Markdown breadcrumbs, and code symbols with each chunk. This improves standalone chunk meaning without sending private source chunks to an LLM for context generation.
- **Hybrid retrieval with diagnosable scores**: combines BM25 and vectors with normalized weighted score fusion. RRF (Cormack et al. 2009) remains the baseline reference, but weighted fusion is used by default because project dogfood showed RRF compressed scores too much for ranking diagnostics.
- **MMR-style diversity**: uses Maximal Marginal Relevance ideas (Goldstein and Carbonell 1998), file interleaving, vector redundancy checks, and adaptive-window overlap collapse so repeated README or same-file chunks do not dominate top results.
- **Intent-aware and self-correcting agent UX**: mode selection (`auto`, `fast`, `semantic`, `hybrid`, `adaptive`, `deep`), ranking diagnostics, and `knowledge_doctor` turn retrieval failures into concrete next actions instead of silent bad answers.
- **Confidence gating**: low-evidence hybrid matches can return zero results instead of unrelated chunks, reducing false confidence when the KB does not contain the answer.

This is intentionally not a heavy ColBERT-style late-interaction index yet (Khattab and Zaharia 2020). The current product chooses lightweight local embeddings, BM25, query-aware ranking, optional cross-encoder reranking, streamed vector scans, and health diagnostics for commercial usefulness with low setup cost.

In project-level dogfood, these changes improved a real codebase evaluation from early 3.x/5 quality to above 4.5/5 after rebuilds, with fixes for score compression, README repetition, garbage-query false positives, small-module discoverability, source-vs-test ranking, indexing stability, and auto-mode false positives. Existing KBs should be rebuilt or updated after upgrades that change indexing text.

## Quick Start

```bash
# Install
pi install npm:pi-knowledge

# Or from source
pi install ./pi-knowledge

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
| `knowledge_add` | Index files, directories, URLs, PDFs, DOCX, or inline text |
| `knowledge_search` | Hybrid, deep, or adaptive search across one or all knowledge bases |
| `knowledge_remove` | Remove a knowledge base by name or ID |
| `knowledge_update` | Incrementally re-index changed files in a knowledge base |
| `knowledge_show` | List all knowledge bases with stats |
| `knowledge_status` | Show engine status with health diagnostics (stale, orphans, coverage) |
| `knowledge_doctor` | Diagnose health score, skipped files, stuck jobs, stale data, and recommended fixes |
| `knowledge_clear` | Remove all knowledge bases |
| `knowledge_export` | Export a KB to shareable JSONL file |
| `knowledge_import` | Import a KB from JSONL (re-embeds content) |

### Search Modes

- `fast`: BM25 keyword search for exact symbols, commands, and identifiers.
- `semantic`: vector search for conceptual matches.
- `hybrid`: BM25 + vector search with normalized weighted score fusion.
- `deep`: hybrid retrieval followed by cross-encoder reranking.
- `adaptive`: hybrid retrieval followed by query-time contextual window expansion around seed chunks. It keeps the matched seed, prefers nearby/query-relevant neighboring chunks, and collapses overlapping windows from the same file.
- `auto`: selects a primary mode from the query shape and retries alternate modes when results are empty or weak.

Mode selection contract:

- Start with `hybrid` for most project questions.
- Use `fast` for exact symbols, filenames, commands, error codes, API names, config keys, or quoted strings.
- Use `semantic` when the query is conceptual and exact terms may differ from the indexed wording.
- Use `adaptive` when the answer needs nearby code, neighboring documentation sections, or enough context to make a safe edit.
- Use `deep` for high-stakes answers, ambiguous top results, or final verification when slower reranking is acceptable.
- If results are empty or weak but the KB should contain the answer, retry once with a different mode before concluding no answer exists.

Search results use balanced diversity reranking by default so near-duplicate chunks from the same file do not dominate the top results. Diversity scoring considers lexical overlap, same-file line proximity, overlapping adaptive windows, available embedding-vector similarity, and file-level interleaving. Use `diversity: "off"` only when raw ranking order is needed for diagnostics. Agents can request search diagnostics to inspect mode fallback, ranking coverage, path/source/test boosts, and adjusted scores.

For best search quality, rebuild or update existing knowledge bases after upgrading. New indexes use contextual retrieval units: embeddings and FTS include file path, file type, Markdown heading breadcrumbs, and code symbol names while returned results keep the original chunk text readable. This improves queries that mention project structure, filenames, sections, or functions, and reduces duplicate-looking chunk hits.

## Large Project Indexing

Indexing prioritizes stability over raw speed. `knowledge_add`, `knowledge_update`, and `knowledge_import` scan directories incrementally, embed and store chunks in bounded batches, stream vector files to disk, and report progress with file/chunk counts, chunks/sec, skipped file counts, elapsed time, and file ETA where available. Directory indexing starts with a metadata-only planning scan so large repositories can show total scannable files and skipped counts without loading all file content.

Indexing progress is persisted in SQLite, not only printed as transient tool updates. `knowledge_status` shows the current or last indexing operation, phase, last progress message, last progress age, processed file/chunk counts, skipped count, and add/remove/unchanged counts. This makes long indexing runs distinguishable from stuck jobs even if the user checks status from a later prompt.

Update and diagnostics paths are also streaming-oriented: changed chunks are embedded in batches, newly produced vectors are written to temporary vector files, deleted rows are removed in batches, and final vector rebuilds iterate SQLite rows instead of loading the whole KB. Search also avoids loading a full KB vector file or all chunk IDs into memory. Semantic and hybrid modes scan vectors from disk and retain only the top candidate vectors needed for ranking/diversity. `knowledge_status` reports stale files, orphaned chunks, coverage, skipped files, and indexing jobs that appear stuck after an interrupted or crashed Pi process. `knowledge_doctor` summarizes the same signals as a health score with concrete actions. KBs still marked `indexing` or `error` are visible in status but skipped by search until rebuilt. A stuck `indexing` KB should be removed and rebuilt after confirming no active Pi process is still building it.

## Architecture

See [DESIGN.md](DESIGN.md) for the full technical design document.

## Data Storage

All data is stored globally at `~/.pi/knowledge/` (never in your project directory):

```
~/.pi/knowledge/
├── knowledge.db      ← SQLite (metadata + chunks + FTS5 index)
├── vectors/          ← Embedding vectors per KB (binary)
└── models/           ← Downloaded ONNX models (~32MB, cached)
```

- **Backup**: copy `~/.pi/knowledge/` directory
- **Reset**: delete `~/.pi/knowledge/` to start fresh
- **Project safety**: pi-knowledge is read-only on indexed directories — no files are created or modified in your project
- **Updates**: extension updates do not affect existing indexed data. Schema migrations run automatically if needed.

## Development

```bash
npm install
npm test          # Unit tests
npm run test:e2e # Smoke integration tests; PDF/DOCX cases skip unless fixture env vars are set
PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e
npm run bench     # Indexing/search benchmarks
```

PDF/DOCX fixtures should be real local files outside the repository. Do not commit private fixture files, extracted fixture text, snapshots, or machine-specific fixture paths. A release-grade e2e pass requires both fixture env vars; a run with skipped PDF/DOCX cases is only a smoke pass.

## Release

Before publishing, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then run:

```bash
npm run check
npm test
npm run test:e2e
PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e
node --experimental-strip-types -e "import('./index.ts')"
npm pack --dry-run
pi -e ./index.ts
git push origin main
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /path/to/release-notes.md
npm publish
```

Report any skipped or unverified gate explicitly. Do not describe smoke e2e as complete release-grade coverage.

## License

MIT
