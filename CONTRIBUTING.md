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

Format: `feat|fix|docs|refactor|test: <description>`

- Keep one logical change per commit.
- Stage only files changed for the current task.
- Include the verification gates in the handoff or release notes.

## Testing

- Unit tests: `npm test` (all must pass before PR)
- Static startup smoke: `node --experimental-strip-types -e "import('./index.ts')"`
- Integration smoke: `npm run test:e2e`
- Release-grade integration: `PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e`
- Pi dogfood: `pi -e ./index.ts` or a one-shot `pi -e ./index.ts -p "..."`
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
3. Run `npm test`.
4. Run `npm run test:e2e`; if PDF/DOCX fixture env vars are unset, treat this only as a smoke pass.
5. Run release-grade e2e with `PI_KNOWLEDGE_E2E_PDF` and `PI_KNOWLEDGE_E2E_DOCX` pointing to local external fixtures.
6. Run `node --experimental-strip-types -e "import('./index.ts')"`.
7. Run `npm pack --dry-run` and inspect the package contents.
8. Dogfood with `pi -e ./index.ts` or a one-shot prompt.
9. Commit with the project commit convention, push `main`, create a GitHub release tag, then run `npm publish`.
10. Report the final git commit, tag, npm version, and every verification gate, including skipped or unverified gates.
