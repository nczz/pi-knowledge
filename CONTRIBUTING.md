# Contributing

## Development

```bash
git clone https://github.com/nczz/pi-knowledge.git
cd pi-knowledge
npm install
npm test                # Unit tests
npm run build           # Build dist entry
pi -e ./extension.js    # Load extension through the packaged entry shim
```

## Architecture

- `extension.js` — Package entry shim; loads `dist/index.js` when built and falls back to source `index.ts`
- `index.ts` — Extension factory source
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

Format: `feat|fix|docs|refactor|test: <description>`

- Keep one logical change per commit.
- Stage only files changed for the current task.
- Include the verification gates in the handoff or release notes.

## Testing

- Unit tests: `npm test` (all must pass before PR)
- Typecheck: `npm run typecheck`
- Static startup smoke: `node -e "import('./extension.js')"`
- Integration smoke: `npm run test:e2e`
- Release-grade integration: `PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e`
- Pi dogfood: `pi -e ./extension.js` or a one-shot `pi -e ./extension.js -p "..."`
- OMP dogfood: `omp -e ./extension.js` or a one-shot `omp -e ./extension.js -p "..."`
- Package contents: `npm pack --dry-run`
- New features require tests in `test/unit/`

PDF/DOCX fixtures must stay outside the repository. Do not commit private documents, extracted fixture text, snapshots of private fixture content, or machine-specific fixture paths. If e2e passes with skipped PDF/DOCX cases, report it as a smoke pass, not complete release-grade coverage.

## Documentation Alignment

- Update `AGENTS.md` for agent-facing behavior contracts.
- Update `README.md` for user-visible behavior, installation, or development commands.
- Update `docs/known-pitfalls.md` when a bug or runtime trap is likely to recur.
- Update `docs/technical-decisions.md` or the relevant spec when an architecture or dependency decision changes.
- Update `CHANGELOG.md` before version bumps and releases.

## Release Process

1. Choose the next semver version and update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run `npm run check`.
3. Run `npm run typecheck`.
4. Run `npm test`.
5. Run `npm run build`.
6. Run `npm run test:e2e`; if PDF/DOCX fixture env vars are unset, treat this only as a smoke pass.
7. Run release-grade e2e with `PI_KNOWLEDGE_E2E_PDF` and `PI_KNOWLEDGE_E2E_DOCX` pointing to local external fixtures.
8. Run `node -e "import('./extension.js')"`.
9. Run `npm pack --dry-run` and inspect the package contents, including `extension.js`, `dist/index.js`, and `dist/src/model-worker.js`.
10. Dogfood with `pi -e ./extension.js` or a one-shot prompt.
11. Dogfood with `omp -e ./extension.js` or a one-shot prompt when the change touches entry shims, native dependencies, storage path resolution, model-worker startup, lifecycle shutdown, or packaging.
12. Commit with the project commit convention, push `main`, create a GitHub release tag, then run `npm publish`.
13. Report the final git commit, tag, npm version, and every verification gate, including skipped or unverified gates.
