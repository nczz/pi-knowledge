# pi-knowledge

**Vector knowledge base extension for Pi** — index any file, directory, or text into persistent, searchable knowledge bases with hybrid semantic + keyword search.

Built as a native [Pi extension](https://pi.dev/docs/latest/extensions), deeply integrated with the agent lifecycle. Designed to match and exceed what kiro-cli's built-in knowledge tool offers, while being 100% local and provider-agnostic.

## Why

Coding agents forget everything outside their context window. `pi-knowledge` gives Pi persistent, searchable long-term memory over your documentation, codebases, specs, and notes — across sessions, across projects.

Unlike `pi-memory` (which manages the agent's own notes), `pi-knowledge` indexes **your existing files** and makes them semantically searchable by the agent.

## Features

| Feature | pi-knowledge | kiro-cli knowledge | pi-memory |
|---------|:---:|:---:|:---:|
| Index arbitrary files/dirs | ✅ | ✅ | ❌ |
| Multiple named knowledge bases | ✅ | ✅ | ❌ |
| Semantic (vector) search | ✅ | ✅ | ✅ (via qmd) |
| BM25 keyword search | ✅ | ✅ | ✅ (via qmd) |
| **Hybrid search + RRF fusion** | ✅ | ❌ | partial |
| **Cross-encoder reranking** | ✅ | ❌ | ❌ |
| **Incremental re-indexing** | ✅ | ❌ | ❌ |
| **File watcher (auto-update)** | ✅ | ❌ | ❌ |
| **Code-aware chunking** | ✅ | ❌ | ❌ |
| **Local embeddings (zero API)** | ✅ | ❌ | ✅ (qmd) |
| **Index quality diagnostics** | ✅ | ❌ | ❌ |
| **Metadata filters in search** | ✅ | ❌ | ❌ |
| **Progress reporting** | ✅ | partial | ❌ |
| Cross-session persistence | ✅ | ✅ | ✅ |
| Pi extension native | ✅ | N/A | ✅ |
| Context injection per turn | ✅ | ❌ | ✅ |
| TUI custom rendering | ✅ | N/A | ❌ |
| RPC mode support | ✅ | N/A | N/A |

## Quick Start

```bash
# Install
pi install npm:pi-knowledge

# Or from source
pi install ./pi-knowledge

# Index a directory
# (agent will call knowledge_add automatically, or you can ask it)
> Index my project docs at ./docs as "Project Docs"

# Search
> Search my knowledge base for "authentication flow"

# The agent also auto-searches relevant knowledge before answering domain questions
```

## Tools

| Tool | Description |
|------|-------------|
| `knowledge_add` | Index files, directories, or inline text into a named knowledge base |
| `knowledge_search` | Hybrid search across one or all knowledge bases |
| `knowledge_remove` | Remove a knowledge base by name or ID |
| `knowledge_update` | Incrementally re-index changed files in a knowledge base |
| `knowledge_show` | List all knowledge bases with stats |
| `knowledge_status` | Show indexing progress, health, and diagnostics |
| `knowledge_clear` | Remove all knowledge bases |

## Architecture

See [DESIGN.md](DESIGN.md) for the full technical design document.

## Development

```bash
npm install
npm test          # Unit tests
npm run test:e2e  # Integration tests (requires pi + API key)
npm run bench     # Indexing/search benchmarks
```

## License

MIT
