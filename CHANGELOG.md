# Changelog

## [0.3.6] - 2026-06-16

### Added
- Added persisted indexing job state for long-running `knowledge_add`, `knowledge_update`, and `knowledge_import` operations. `knowledge_status` now reports operation, phase, last progress message, last progress age, processed files/chunks, skipped count, and add/remove/unchanged counts so large indexing runs do not look frozen after transient tool updates disappear.
- Added contextual indexing for rebuilds: embeddings and FTS now include file path, file type, heading breadcrumbs, and code symbols while keeping returned chunk content readable.
- Added more focused rebuild-time chunking for Markdown and plain text, with reduced overlap to avoid near-duplicate retrieval units.
- Added adaptive search mode with query-time contextual window expansion around relevant seed chunks.
- Added balanced/strong/off diversity controls for search result reranking to reduce near-duplicate chunk clusters.
- Added query-aware snippets so search results show the matched context instead of always showing the chunk prefix.
- Added vector-aware redundancy scoring and overlapping adaptive window collapse for higher-diversity top results.
- Replaced hybrid RRF scoring with normalized weighted score fusion to preserve meaningful score spread.
- Added file-level result interleaving so README-style overview files cannot dominate top results with repeated chunks.
- Added confidence gating for hybrid search so low-evidence garbage queries return no results instead of unrelated matches.
- Strengthened source-file intent scoring so named modules and core implementation files outrank overview and test files when appropriate.
- Demoted localization catalogs for implementation-oriented queries while preserving them for explicit translation or locale intent.
- Excluded generated knowledge-base evaluation reports from default directory indexing to prevent self-referential retrieval pollution.

## [0.3.5] - 2026-06-15

### Fixed
- Prevented idle model disposal from running during active embedding or reranking batches, fixing `Session already disposed` during large `knowledge_add` operations.
- Avoided ONNX native disposal during Pi `session_shutdown`, preventing macOS onnxruntime mutex crashes on session exit.
- Allowed `knowledge_search` `kb_id` to accept either a KB UUID or exact KB name.
- Truncated custom TUI render lines to prevent Pi crashes when search result snippets exceed terminal width.

### Changed
- Added `PI_KNOWLEDGE_EMBEDDING_IDLE_MS` for lifecycle stress testing of embedding idle disposal.

## [0.3.4] - 2026-06-15

### Fixed
- Reject duplicate `knowledge_add` names with an actionable message instead of silently creating multiple same-name knowledge bases.
- Strengthened default directory indexing ignores for build outputs and common secret/config files.

### Changed
- Updated `knowledge_add` tool guidance to prefer one directory-level indexing call and avoid per-file indexing loops.

## [0.3.3] - 2026-06-15

### Changed
- Added a mandatory async lifecycle review contract for timers, event handlers, dispose, and shutdown paths.
- Clarified review requirements for overlap analysis, guard-state updates before await points, idempotent cleanup, and recreate-after-dispose behavior.

## [0.3.2] - 2026-06-15

### Fixed
- Made local embedding and deep reranker model disposal idempotent to avoid concurrent native ONNX session teardown from idle timers and Pi `session_shutdown`.

### Changed
- Updated the onnxruntime exit-crash pitfall notes with the double-dispose race mitigation.

## [0.3.1] - 2026-06-15

### Fixed
- Made watcher shutdown cover both native watchers and polling fallbacks without mutating the collection being iterated.
- Clarified the startup-safe render component shim contract without overclaiming Pi internals.

### Changed
- Documented the difference between e2e smoke runs and release-grade PDF/DOCX fixture coverage.
- Added agent/contributor contracts for verification-level reporting, private fixture handling, documentation alignment, and the release/publish flow.

## [0.3.0] - 2026-06-15

### Fixed
- Corrected BM25 fast-mode score semantics so higher scores are consistently better after search fusion/sorting.
- Made URL knowledge bases a first-class source type and allowed `knowledge_update` to re-fetch URL sources.
- Threaded `AbortSignal` into incremental update embedding.
- Fixed stale diagnostics for single-file knowledge bases.
- Normalized `unpdf` page-array output before chunking PDF text.
- Made JSONL import cleanup partial KBs on failure and import exported KBs as portable text sources.
- Removed root extension runtime dependency on Pi virtual modules so Node strip-only startup smoke tests can run outside Pi.
- Restored `knowledge_search` custom rendering with a startup-safe local TUI component shim.
- Added polling fallback for file watching when native `fs.watch` is unavailable or fails with resource limits.
- Updated Biome 2 configuration so `npm run check` is a working quality gate.

### Added
- Regression coverage for BM25 score direction, URL update, update cancellation, single-file diagnostics, import failure cleanup, and portable import/export behavior.
- E2E coverage for deep rerank, external PDF/DOCX fixtures, and watcher updates without committing private fixture data.
- Development contract notes for Pi runtime imports, source-type update behavior, portable exports, and release gates.

## [0.2.2] - 2026-06-15

### Fixed
- AbortSignal now threads end-to-end (tool → engine → embedding loop)
- Cancellation actually works during long embedding operations

### Added
- TUI custom rendering for knowledge_search (renderCall + renderResult)
- All DESIGN.md phases complete (30/30 checkboxes)

## [0.2.1] - 2026-06-15

### Fixed
- README lists all 9 tools (was missing export/import)
- npm package includes .pi/skills/ for skill distribution

## [0.2.0] - 2026-06-15

### Added
- URL indexing (fetch → HTML strip → chunk)
- PDF text extraction (via unpdf, pure JS)
- DOCX text extraction (via mammoth, pure JS)
- Import/export knowledge bases (JSONL format, git-friendly)
- Performance benchmarks (BM25: 0.05ms, hybrid: 2.1ms)
- Pi Skill: /skill:search-docs
- 9 tools total

## [0.1.4] - 2026-06-15

### Added
- Vector memory cache (search no longer re-reads disk per query)
- AbortSignal support in embedding (cancellable long operations)
- Schema migration infrastructure (future-proof DB upgrades)
- Model mismatch warning on search (suggests re-index)
- Engine regression tests (+6, total 34)
- README Data Storage section
- URL indexing (knowledge_add with http/https URLs, auto HTML strip)
- Performance benchmarks (BM25: 0.05ms, hybrid: 2.1ms, semantic: 2.0ms)
- Pi Skill: `/skill:search-docs` for guided knowledge search

### Fixed
- walkDir skips permission-denied directories
- DESIGN.md phases corrected

## [0.1.3] - 2026-06-14

### Fixed
- Short files index correctly (single chunk fallback)

## [0.1.2] - 2026-06-14

### Fixed
- Short files (<50 chars) now index correctly as a single chunk

## [0.1.1] - 2026-06-14

### Added
- Java AST chunking (6 languages total: TS, JS, Python, Go, Rust, Java)

## [0.1.0] - 2026-06-14

### Added
- Project scaffold and design document
- Extension entry point with 7 tools: knowledge_add, knowledge_search, knowledge_update, knowledge_status, knowledge_show, knowledge_remove, knowledge_clear
- SQLite storage with FTS5 full-text search (WAL mode, content-sync triggers)
- Markdown-aware and paragraph-based chunking with camelCase/CJK pre-tokenization
- Local embedding via @huggingface/transformers (multilingual-e5-small, 384d, lazy load + idle dispose)
- Hybrid search: BM25 + vector cosine + Reciprocal Rank Fusion (RRF)
- Cross-encoder reranking (mode: "deep") via ms-marco-MiniLM-L-4-v2
- Incremental re-indexing (content-hash diff, only embeds changed chunks)
- File watcher (fs.watch recursive + debounce, opt-in PI_KNOWLEDGE_WATCH=true)
- Auto-injection per turn (opt-in PI_KNOWLEDGE_AUTO_INJECT=true, BM25 fast search)
- Metadata filters in search (file_type, path_pattern)
- Pagination (offset/limit)
- Vector binary storage (save/load Float32Array[])
- 25 unit tests (chunker + search pipeline)
- Comprehensive docs: competitive analysis, kiro parity mapping, embedding models, search pipeline, chunking strategies, FTS5 tokenization, offline mode, technical decisions (ADRs), Pi extension architecture
