# Changelog

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
