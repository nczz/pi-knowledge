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

`pi-knowledge` applies and dogfoods retrieval techniques from RAG and information retrieval research:

- **Contextual Retrieval**: searchable embeddings and FTS text include deterministic local context such as file path, file type, Markdown heading breadcrumbs, and code symbols, following the core idea from Anthropic's Contextual Retrieval work without sending chunks to an LLM to generate context.
- **Hybrid retrieval**: BM25 and dense embeddings are fused with normalized weighted scores, preserving useful score spread for diagnostics instead of hiding relevance differences behind compressed rank-only scores.
- **Diversity reranking**: MMR-style reranking, file interleaving, vector redundancy checks, and adaptive-window overlap collapse reduce repeated README or same-file chunks in top results.
- **Intent-aware ranking**: source, documentation/setup, test, and localization intent are handled differently so implementation queries return implementation files, setup queries return guides, test queries can surface tests, and translation catalogs do not dominate general code searches.
- **Confidence gating**: low-evidence hybrid matches can return zero results instead of unrelated chunks.

In project-level dogfood, these changes improved a real codebase evaluation from early 3.x/5 quality to above 4.5/5 after rebuilds, with fixes for score compression, README repetition, garbage-query false positives, small-module discoverability, and source-vs-test ranking. Existing KBs should be rebuilt or updated after upgrades that change indexing text.

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
| `knowledge_clear` | Remove all knowledge bases |
| `knowledge_export` | Export a KB to shareable JSONL file |
| `knowledge_import` | Import a KB from JSONL (re-embeds content) |

### Search Modes

- `fast`: BM25 keyword search for exact symbols, commands, and identifiers.
- `semantic`: vector search for conceptual matches.
- `hybrid`: BM25 + vector search with normalized weighted score fusion.
- `deep`: hybrid retrieval followed by cross-encoder reranking.
- `adaptive`: hybrid retrieval followed by query-time contextual window expansion around seed chunks. It keeps the matched seed, prefers nearby/query-relevant neighboring chunks, and collapses overlapping windows from the same file.

Search results use balanced diversity reranking by default so near-duplicate chunks from the same file do not dominate the top results. Diversity scoring considers lexical overlap, same-file line proximity, overlapping adaptive windows, available embedding-vector similarity, and file-level interleaving. Use `diversity: "off"` only when raw ranking order is needed for diagnostics.

For best search quality, rebuild or update existing knowledge bases after upgrading. New indexes use contextual retrieval units: embeddings and FTS include file path, file type, Markdown heading breadcrumbs, and code symbol names while returned results keep the original chunk text readable. This improves queries that mention project structure, filenames, sections, or functions, and reduces duplicate-looking chunk hits.

## Large Project Indexing

Indexing prioritizes stability over raw speed. `knowledge_add`, `knowledge_update`, and `knowledge_import` embed and store chunks in bounded batches, stream vector files to disk, and report progress with file/chunk counts, elapsed time, and ETA where available. This keeps long-running project indexing observable and avoids one huge all-at-once embedding or vector-write step.

Search also avoids loading a full KB vector file into memory. Semantic and hybrid modes scan vectors from disk and retain only the top candidate vectors needed for ranking/diversity. `knowledge_status` reports stale files, orphaned chunks, coverage, and indexing jobs that appear stuck after an interrupted or crashed Pi process. KBs still marked `indexing` or `error` are visible in status but skipped by search until rebuilt. A stuck `indexing` KB should be removed and rebuilt after confirming no active Pi process is still building it.

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
