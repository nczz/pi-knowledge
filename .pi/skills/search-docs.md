---
name: search-docs
description: Search indexed knowledge bases for relevant documentation or code
---

# Search Knowledge Base

Search the indexed knowledge bases for: $ARGUMENTS

## Steps

1. Use `knowledge_show` to see available knowledge bases
2. Use `knowledge_search` with the user's query (hybrid mode by default)
3. If results are insufficient, try mode "deep" for cross-encoder reranking
4. For exact symbol lookups, use mode "fast" (BM25 only)
5. Present results with file paths and relevant snippets

## Tips

- Code queries: use function names, class names, or API signatures
- Concept queries: use natural language descriptions
- Filter: `file_type: "typescript"` or `file_type: "python"`
- No results? Check `knowledge_show` to confirm content is indexed

## Indexing Safety

- When creating a KB, prefer one `knowledge_add` call for the project root or relevant source/docs directory.
- Do not create one KB per small file unless the user explicitly asks for separate KBs.
- Avoid indexing generated or runtime artifacts such as `bin/`, `obj/`, `dist/`, `build/`, `node_modules/`, Playwright browser caches, `.app` bundles, `.pak`, and `.asar` files.
- Do not exclude browser-domain source directories merely because they are named `chromium`, `chrome`, `firefox`, `webkit`, or `browsers`; those names may be first-party source in Playwright or browser-tooling projects.
- If a project contains large embedded browsers or vendor bundles, index the source/docs/config directories directly or rely on the extension's default ignore rules.
