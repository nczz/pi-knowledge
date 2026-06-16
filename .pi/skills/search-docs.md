---
name: search-docs
description: Search indexed knowledge bases for relevant documentation or code
---

# Search Knowledge Base

Search the indexed knowledge bases for: $ARGUMENTS

## Steps

1. Use `knowledge_show` to see available knowledge bases
2. Choose the search mode from the decision rules below instead of always using the default
3. Present results with file paths and relevant snippets
4. If results are insufficient, retry once with a different mode before concluding the KB lacks the answer

## Tips

- Code queries: use function names, class names, or API signatures
- Concept queries: use natural language descriptions
- Filter: `file_type: "typescript"` or `file_type: "python"`
- No results? Check `knowledge_show` to confirm content is indexed

## Mode Selection

- Use `hybrid` by default for most project questions.
- Use `fast` for exact symbols, filenames, commands, error codes, API names, config keys, or quoted strings.
- Use `semantic` for broad conceptual questions when exact terms may differ from the indexed wording.
- Use `adaptive` when the user needs nearby implementation context, related sections, or enough context to safely edit code.
- Use `deep` for high-stakes answers, ambiguous top results, or final verification when slower reranking is acceptable.
- If results are repetitive, retry with `diversity: "strong"` or `adaptive` before raising `limit`.
- If results are empty but the KB should contain the answer, retry once with `fast` for exact terms or `semantic` for conceptual wording.

## Indexing Safety

- When creating a KB, prefer one `knowledge_add` call for the project root or relevant source/docs directory.
- Do not create one KB per small file unless the user explicitly asks for separate KBs.
- Avoid indexing generated or runtime artifacts such as `bin/`, `obj/`, `dist/`, `build/`, `node_modules/`, Playwright browser caches, `.app` bundles, `.pak`, and `.asar` files.
- Do not exclude browser-domain source directories merely because they are named `chromium`, `chrome`, `firefox`, `webkit`, or `browsers`; those names may be first-party source in Playwright or browser-tooling projects.
- If a project contains large embedded browsers or vendor bundles, index the source/docs/config directories directly or rely on the extension's default ignore rules.
