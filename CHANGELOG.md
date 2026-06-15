# Changelog

## [0.3.0] - 2026-06-15

### Fixed
- Corrected BM25 fast-mode score semantics so higher scores are consistently better after search fusion/sorting.
- Made URL knowledge bases a first-class source type and allowed `knowledge_update` to re-fetch URL sources.
- Threaded `AbortSignal` into incremental update embedding.
- Fixed stale diagnostics for single-file knowledge bases.
- Made JSONL import cleanup partial KBs on failure and import exported KBs as portable text sources.
- Removed root extension runtime dependency on Pi virtual modules so Node strip-only startup smoke tests can run outside Pi.
- Updated Biome 2 configuration so `npm run check` is a working quality gate.

### Added
- Regression coverage for BM25 score direction, URL update, update cancellation, single-file diagnostics, import failure cleanup, and portable import/export behavior.
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
