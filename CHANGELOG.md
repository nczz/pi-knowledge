# Changelog

## [Unreleased]

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
