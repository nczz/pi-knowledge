# 競品與生態系統分析

日期: 2026-06-14

---

## 1. 直接競品（Pi extension 生態）

### jayzeng/pi-memory ⭐ 68

**定位**: Pi 的持久記憶 extension — agent 自己的筆記、偏好、每日日誌

**核心能力**:
- `memory_write`: 寫入 MEMORY.md (長期) 或 daily log
- `memory_read`: 讀取任何記憶檔案
- `scratchpad`: checklist 待辦項目
- `memory_search`: 透過 qmd 搜尋所有記憶（keyword/semantic/deep 三模式）
- `memory_status`: 健康檢查

**技術架構**:
- 儲存: plain markdown files at `~/.pi/agent/memory/`
- 搜尋引擎: 外部 CLI [qmd](https://github.com/tobi/qmd) (BM25 + vector + hybrid + reranking)
- 嵌入: qmd 內建（首次使用自動下載嵌入模型）
- Context injection: session_start 時注入 MEMORY.md + daily log + scratchpad
- KV cache 穩定: snapshot 機制避免每 turn 重建導致 local LLM prefix cache 失效

**安裝**: `pi install npm:pi-memory`

**關鍵設計決策**:
- 不帶 native dep — 用外部 qmd CLI 做搜尋（迴避了 native binding 問題）
- 記憶只是 markdown files（可 git commit、手動編輯）
- Context injection 有 16K char cap（優先級: scratchpad > today's log > MEMORY.md > yesterday's log）
- 寫入 daily/scratchpad 不觸發 snapshot refresh（高頻操作，避免 cache bust）

**與 pi-knowledge 的定位差異**:
| 面向 | pi-memory | pi-knowledge |
|------|-----------|-------------|
| 索引來源 | Agent 自己寫的筆記 | 使用者指定的任意文件/目錄 |
| 內容管理 | Agent 寫入/修改 | 使用者指定路徑，自動索引 |
| 搜尋目標 | 「我之前記住了什麼」 | 「這份文檔裡說了什麼」 |
| 更新頻率 | 每次 session | 使用者修改原始文件時 |
| 體量 | 幾百 KB markdown | 幾百 MB codebase/docs |

**可學習的 pattern**:
- KV cache-stable snapshot for auto-injection
- Background qmd update/embed (non-blocking, fire-and-forget)
- Graceful degradation when search engine unavailable
- `PI_MEMORY_SNAPSHOT=per-turn` vs `stable` config switch

---

### ArtemisAI/pi-mem ⭐ 12

**定位**: Fork 自 thedotmack/claude-mem，跨 coding agent 的持久記憶 + hybrid RAG search

**特點**:
- 1679 commits（非常活躍）
- 有 `ragtime/` 子目錄做 RAG
- 支援 multiple agents: Claude (.claude-plugin), Codex (.codex-plugin), Pi (pi-agent/), Windsurf (.windsurf/rules)
- 有 openclaw 目錄（與 Pi 的 contribution workflow 整合）

**與 pi-knowledge 的關係**: 偏向 agent memory 而非文件索引，但 ragtime/ 子系統可能有參考價值

---

## 2. 相鄰工具（MCP server / 通用 RAG）

### lyonzin/knowledge-rag

**定位**: Claude Code 的 MCP server — 本地 RAG 系統，12 MCP tools

**技術架構**:
- Hybrid search: semantic + BM25 + cross-encoder reranking
- 20 種文件格式 parser
- Markdown-aware chunking
- File watcher
- 100% 本地，零 API key

**與 pi-knowledge 的關係**:
- 功能最接近我們想做的（hybrid search + reranking + local）
- 但它是 MCP server（需要 Claude Code），不是 Pi native extension
- 我們可以參考其 chunking strategy 和 search pipeline

### tomohiro-owada/devrag

**定位**: MCP server，multilingual-e5-small embeddings，Markdown 向量搜尋

**技術架構**:
- multilingual-e5-small（和我們一樣的模型選擇）
- 針對 markdown 文件優化

---

## 3. 參考架構（kiro-cli 內建 knowledge）

kiro-cli 是 closed-source，但我透過日常使用已知其完整行為。見 `docs/kiro-knowledge-behavior.md`。

---

## 4. 其他 Pi extension 生態

| 專案 | 說明 |
|------|------|
| code-yeongyu/pi-websearch | Web search tool for Pi |
| nicobailon/pi-subagents | Async subagent delegation |
| tmustier/pi-extensions | Delightful extensions collection |
| ben-vargas/pi-packages | Extensions, skills, themes bundle |
| yevhen/bo-pi | Custom extensions |
| emanuelcasco/pi-mono-extensions | Collection of extensions |
| sysid/pi-extensions | Improved extensions |

---

## 5. 差異化定位

pi-knowledge 的 unique value proposition:

1. **不是 memory** — 索引使用者的既有文件，不是 agent 自己的筆記
2. **不是 MCP server** — 深度整合 Pi lifecycle、TUI、RPC，而非外掛協議
3. **Hybrid search 是預設** — BM25 + vector + weighted score fusion，不需要使用者選模式
4. **Incremental** — content-addressed，只 re-embed 變更的 chunk
5. **本地 + 多語言** — multilingual-e5-small，支持 zh-TW，零 API key
6. **Code-aware** — AST chunking 保留函數/class 邊界（Phase 3）
