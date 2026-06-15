# Development Rules

## Code Style

- TypeScript strict mode, no `any` unless absolutely necessary
- ESM only (`"type": "module"`)
- Biome for formatting (tab indent, 120 line width) and linting
- No inline imports by default. Dynamic imports are allowed only for optional/heavy runtime paths that should not load at extension startup (for example model, parser, PDF/DOCX, or filesystem helpers inside rarely used tools).
- Use erasable TypeScript syntax (Node strip-only compatible)
- Avoid non-null assertions. Prefer explicit checks with actionable errors.
- Keep root `index.ts` startup-light: importing it with Node strip-only must not require Pi virtual modules beyond type-only imports.

## Commands

- `npm run check` — biome lint + format (run after every code change)
- `npm test` — unit tests
- `npm run test:e2e` — integration tests (requires Pi + model API key)
- Never run tests unless asked or after creating/modifying test files
- Before release or commit readiness, also run:
  - `node --experimental-strip-types -e "import('./index.ts')"`
  - `npm pack --dry-run`
  - `pi -e ./index.ts` or a one-shot `pi -e ./index.ts -p ...` dogfood
- PDF/DOCX e2e fixtures must be supplied via `PI_KNOWLEDGE_E2E_PDF` and `PI_KNOWLEDGE_E2E_DOCX`. Do not commit private fixture files or extracted fixture content.

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
- Current approved production deps are exactly the pinned entries in `package.json`. Do not add new production deps without approval.
- Pi virtual modules (`@earendil-works/pi-*`, `typebox`) are provided by Pi at runtime, but this package should not require them as runtime imports from `index.ts` unless they are also declared or guarded. Type-only imports are acceptable.
- Add deps only when the user approves

## Extension Development

- Entry point: `index.ts` (default export ExtensionFactory)
- Test with: `pi -e ./index.ts` (direct load, no install needed)
- Install locally: `pi install ./` (from project root)
- All tools must handle `signal?.aborted` for cancellation
- All tools must use `onUpdate` for progress reporting during long operations
- Source types are a behavior contract: directories/files/text/URLs must remain updateable or intentionally documented as one-shot. If adding a source type, cover add + update + status/diagnostics.
- Import/export must remain portable across machines. Do not export local absolute source paths as active update sources.
- `knowledge_search` score semantics are "higher is better" after leaving search modules, including BM25 fast mode.
- `knowledge_status` diagnostics must handle directory, single-file, text, and URL KBs without false stale/orphan reports.
- File watching must keep the polling fallback; native `fs.watch` can fail or stop under local resource limits.

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
