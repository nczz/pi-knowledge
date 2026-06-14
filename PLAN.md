# pi-knowledge — 開發計劃

## 當前狀態

**v0.1.4 已發佈** (npm + GitHub) — 2026-06-15

| 指標 | 值 |
|------|-----|
| npm | https://www.npmjs.com/package/pi-knowledge |
| GitHub | https://github.com/nczz/pi-knowledge |
| Tests | 34 passing |
| Tools | 7 (add, search, update, status, show, remove, clear) |
| AST languages | 6 (TypeScript, JavaScript, Python, Go, Rust, Java) |
| Search modes | 4 (fast, semantic, hybrid, deep) |
| Embedding | multilingual-e5-small (384d, local ONNX, zero API keys) |
| Storage | ~/.pi/knowledge/ (SQLite + FTS5 + binary vectors) |

## 已完成 Phases

### Phase 1 ✅ — Core (knowledge_add + knowledge_search)
Storage, chunking, embedding, BM25, vector cosine, RRF fusion, 5 tools, lifecycle hooks

### Phase 2 ✅ — Incremental + Status
knowledge_update (content-hash diff), knowledge_status, pagination, metadata filters

### Phase 3 ✅ — Intelligence
Cross-encoder reranking (mode: deep), file watcher (opt-in), auto-injection (opt-in)

### Phase 4 ✅ — Ecosystem
AST chunking (6 languages via tree-sitter), OpenAI API embedding (optional), npm publish, pi install verified

### Quality Pass ✅
- Vector memory cache (no disk re-read per search)
- AbortSignal in embedding loop
- walkDir permission error handling
- Schema migration infrastructure
- Model mismatch warning
- Diagnostics: staleness, orphans, coverage %
- 34 regression tests
- All docs aligned with implementation
- No overclaims in README

## 未完成 — 下一步建議

| 優先 | 功能 | 說明 |
|------|------|------|
| 1 | **PDF/DOCX parsing** | 需要研究 pdf-parse v2.x API（v2 是 pure TS，API 和 v1 完全不同） |
| 2 | **Performance benchmarks** | index 1000 files 端到端時間、search 延遲 p50/p99 |
| 3 | **Pi Skill 整合** | `/skill:search-docs` 讓使用者直接用 skill 觸發搜尋 |
| 4 | **TUI custom rendering** | renderResult 顯示 search results with highlights |
| 5 | **URL/web indexing** | fetch URL → extract text → index |
| 6 | **Import/export KBs** | git-friendly serialization format |

## 技術文件交叉參考

| 需要什麼 | 去看哪裡 |
|---------|---------|
| 架構和設計 | DESIGN.md |
| 技術研究和驗證 | RESEARCH.md |
| 版本歷史 | CHANGELOG.md |
| 競品分析 | docs/competitive-analysis.md |
| kiro-cli 行為對照 | docs/kiro-knowledge-behavior.md |
| Pi extension API | docs/pi-extension-architecture.md |
| Embedding 選型 | docs/embedding-models.md |
| Search pipeline | docs/search-pipeline.md |
| Chunking 策略 | docs/chunking-strategies.md |
| FTS5 tokenization | docs/fts5-code-tokenization.md |
| 離線模式 | docs/offline-mode.md |
| 技術決策 | docs/technical-decisions.md |
| 已知陷阱 | docs/known-pitfalls.md |
| 開發規則 | AGENTS.md |
| 貢獻指南 | CONTRIBUTING.md |

## 如何接續開發

```bash
cd /path/to/pi-knowledge
npm install
npm test              # 34 tests should pass
pi -e ./index.ts      # Load extension for manual testing
```

新功能的標準流程：
1. 讀相關 docs/ 確認設計決策
2. 實作 → 跑 tests → dogfood 驗證
3. 嚴格 review（站在產品角度檢視）
4. 修正到 100% 滿意
5. 更新 CHANGELOG + docs
6. commit → tag → push → npm publish
