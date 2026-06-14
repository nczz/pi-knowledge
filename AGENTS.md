# Development Rules

## Code Style

- TypeScript strict mode, no `any` unless absolutely necessary
- ESM only (`"type": "module"`)
- Biome for formatting (tab indent, 120 line width) and linting
- No inline imports — top-level only
- Use erasable TypeScript syntax (Node strip-only compatible)

## Commands

- `npm run check` — biome lint + format (run after every code change)
- `npm test` — unit tests
- `npm run test:e2e` — integration tests (requires Pi + model API key)
- Never run tests unless asked or after creating/modifying test files

## Commit Convention

- Format: `feat|fix|docs|refactor|test: <description>`
- One logical change per commit
- Stage only files changed in this session

## Testing

- Unit tests in `test/unit/` — no external deps, no network, fast
- E2E tests in `test/e2e/` — requires Pi runtime, may need API keys
- Benchmarks in `test/bench/` — performance regression tests
- Test file naming: `<module>.test.ts`

## Dependencies

- Pin exact versions in package.json
- Only 2 production deps: `@huggingface/transformers`, `better-sqlite3`
- Add deps only when the user approves

## Extension Development

- Entry point: `index.ts` (default export ExtensionFactory)
- Test with: `pi -e ./index.ts` (direct load, no install needed)
- Install locally: `pi install ./` (from project root)
- All tools must handle `signal?.aborted` for cancellation
- All tools must use `onUpdate` for progress reporting during long operations

## File Organization

- `src/` — implementation modules (never import from test/)
- `test/` — test files only
- `docs/` — research, decisions, specifications
- `spike/` — throwaway validation code (not production)
- Root `index.ts` — extension entry point

## Language

- Code: English
- Comments: English
- Commit messages: English
- Documentation: 繁體中文 or English (match existing file)
- User-facing tool descriptions: English (Pi convention)
