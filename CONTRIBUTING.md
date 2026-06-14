# Contributing

## Development

```bash
git clone https://github.com/nczz/pi-knowledge.git
cd pi-knowledge
npm install
npm test          # Unit tests
pi -e ./index.ts  # Load extension directly for testing
```

## Architecture

- `index.ts` — Extension entry point (Pi ExtensionFactory)
- `src/storage/` — SQLite + FTS5
- `src/indexer/` — File scanning, chunking (markdown, text, AST)
- `src/embedding/` — @huggingface/transformers pipeline + vector I/O
- `src/search/` — BM25, vector, RRF fusion, cross-encoder reranker
- `src/watcher/` — File watcher
- `src/engine.ts` — KnowledgeEngine facade

## Code Style

- TypeScript strict, no `any`
- Biome for formatting (tab indent, 120 line width)
- Run `npm run check` before committing

## Commits

Format: `feat|fix|docs|refactor: <description>`

## Testing

- Unit tests: `npm test` (all must pass before PR)
- Integration: `pi -e ./index.ts` → test tools manually
- New features require tests in `test/unit/`
