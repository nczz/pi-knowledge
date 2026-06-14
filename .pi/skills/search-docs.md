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
