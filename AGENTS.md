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
- Treat plain `npm run test:e2e` as a smoke gate only when PDF/DOCX fixture env vars are unset. Release-grade e2e must run with both fixture env vars and report whether tests were skipped.
- External fixtures may live outside the repo, such as `~/Downloads`, but never persist fixture paths, extracted text, or private document content in tests, snapshots, docs, or commits. Report only non-sensitive summaries such as pass/fail and chunk counts.

## Commit Convention

- Format: `feat|fix|docs|refactor|test: <description>`
- One logical change per commit
- Stage only files changed in this session
- Commit readiness requires a clean explanation of which gates were run, which were skipped, and why.

## Review Contract

- Findings must distinguish blocking bugs, non-blocking risks, and documentation-only issues.
- Each conclusion must identify its verification level: static read, unit test, e2e smoke, release-grade e2e with external fixtures, Pi dogfood, or external dependency not verified.
- Do not call skipped tests a full pass. If a gate succeeds with skipped cases, say exactly which coverage did not run.
- Comments and docs must describe verified behavior. Compatibility shims should document the minimum contract they implement, not unverified host internals.
- Async lifecycle review (mandatory for any code with timers, event handlers, or dispose/shutdown):
  1. List every independent caller of the async function.
  2. Determine whether callers can overlap (timer + shutdown event, repeated tool calls, failed retries, same tick, etc.).
  3. Identify the guard state that prevents re-entry, double-dispose, duplicate timers, or stale callback work.
  4. Verify guard state is updated before any `await` that could yield to another lifecycle caller.
  5. Verify dispose/cleanup is idempotent: concurrent or repeated calls must not double-free resources or close already-closed handles.
  6. Verify reload/recreate paths wait for in-flight cleanup before constructing replacement resources.
  7. Treat lifecycle-only format diffs as behavior-sensitive; they still require this analysis before approval.

## Documentation Alignment

- Behavior contract changes belong in `AGENTS.md`.
- Contributor workflow changes belong in `CONTRIBUTING.md`.
- User-visible capability or install/development changes belong in `README.md`.
- Repeated bugs, runtime traps, or review learnings belong in `docs/known-pitfalls.md`.
- Architecture or dependency decisions belong in `docs/technical-decisions.md` or the relevant spec under `docs/`.
- Release or publish process changes must be reflected in the release checklist before the release commit.

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
- Long-running indexing paths (`knowledge_add`, `knowledge_update`, `knowledge_import`) must prefer streaming directory scans, bounded embedding batches, incremental DB writes, streamed vector writes, cancellation checks before and after model calls, and useful progress updates over one-shot memory-heavy work.
- Long-running indexing paths must persist job state, not only emit transient `onUpdate` messages. `knowledge_status` must be able to report operation, phase, last progress time, last message, processed files/chunks, skipped count, and add/remove/unchanged counts after the current TUI update has disappeared.
- Directory scanners must not read all file contents into an array for production add/update/diagnostics paths. Binary detection must read only a fixed-size sample before deciding whether to skip or index a file.
- Update paths must not hold all new chunks, all final chunks, or all new vectors in memory. Use hash manifests, batch deletes, chunk iterators, and temporary vector files when rebuilding large KBs.
- Query-time vector search must not load an entire KB vector file or all chunk IDs into a long-lived cache. Prefer streaming/ranged vector reads and keep only top candidate vectors needed by ranking/diversity.
- `knowledge_search` mode guidance is a behavior contract: `hybrid` default, `fast` exact symbols/files/errors/config, `semantic` conceptual wording, `adaptive` surrounding context for implementation, `deep` high-stakes or ambiguous verification, `auto` tool-owned selection/fallback. Empty/weak results should trigger one mode retry before declaring no answer.
- `knowledge_doctor` is the product-level health check. Keep its health score, skipped-file transparency, stuck indexing detection, stale/orphan findings, and concrete actions aligned with `knowledge_status` and docs.
- Directory indexing must remain guarded against generated/vendor/runtime artifacts by default. Binary bundles, `.app` bundles, and unsupported non-text artifacts are technical skips; generated/vendor/runtime text is a suggested exclusion that can be included after user confirmation. Do not globally exclude browser-domain source names such as `chromium`, `chrome`, `firefox`, `webkit`, or `browsers`.
- Text files must not be permanently blocked only because they look risky or low-signal. `.env`, private-key-looking text, credential/secret-named text, generated reports, lockfiles, vendor text, build output text, and runtime/cache text are suggested exclusions by default, but `knowledge_add` must allow confirmed inclusion through `include_suggested_text` or focused `include_paths`.
- Hard skips are reserved for technical limits: unsupported binary/non-text files, oversized files, unreadable files, inaccessible paths, and supported document types that fail extraction. Agent guidance for `knowledge_add` must tell agents to index project source/docs/config at a directory level, avoid per-file indexing loops, explain precision/privacy tradeoffs for suggested exclusions, and ask the user before including risky or low-signal text.
- `knowledge_plan` must remain a no-write scope inspection tool. Agents should use it before broad directory indexing or risky/private scope decisions, then call `knowledge_add` with the confirmed include/exclude options.
- Directory KB update behavior must preserve confirmed scope options. If `knowledge_add` included suggested-excluded text via `include_suggested_text`, `include_paths`, or `exclude_paths`, `knowledge_update` must reuse those persisted source options instead of silently dropping or adding files.
- Import/export must remain portable across machines. Do not export local absolute source paths as active update sources.
- `knowledge_search` score semantics are "higher is better" after leaving search modules, including BM25 fast mode.
- `knowledge_status` diagnostics must handle directory, single-file, text, and URL KBs without false stale/orphan reports, and must surface stale `indexing` state left by interrupted runs. `knowledge_search` must skip non-ready/non-stale KBs rather than searching partial `indexing` or `error` data.
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
