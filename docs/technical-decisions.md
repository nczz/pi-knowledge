# 技術決策紀錄 (ADR)

日期: 2026-06-14

---

## ADR-001: 使用 @huggingface/transformers 作為唯一 embedding 引擎

**狀態**: 已決定

**背景**: 需要在 Pi extension 中做本地向量嵌入。原始方案用 onnxruntime-node + tokenizers-node (2 native deps)。

**決策**: 改用 @huggingface/transformers (1 顯式 dep，內建 WASM tokenizer + onnxruntime-node transitive dep)。

**理由**:
- 解決 tokenizer（XLM-RoBERTa SentencePiece）
- 自帶 model download + cache + progress callback
- 自動偵測 Node/Bun 選對 backend
- 一行 `pipeline()` 完成一切
- 減少顯式 native dep 從 3 → 1

---

## ADR-002: Phase 1 用 pure-JS flat cosine search

**狀態**: 已決定

**背景**: 向量相似度搜尋選型。

**決策**: Phase 1 brute-force cosine。Phase 3 若 >10K vectors 再加 HNSW。

**理由**:
- 少一個 native dep
- 10K × 384d brute-force ~5-10ms on M1
- 大多數 KB 在 1K-5K chunks

**升級觸發**: 延遲 >50ms 或 vectors >30K

---

## ADR-003: Embedding cache key = SHA-256(content)

**狀態**: 已決定

**背景**: 增量索引需要 content-addressed cache。

**決策**:
- Embedding cache key: `SHA-256(content)` — 只看內容
- Chunk identity: `SHA-256(content + filePath + startLine)` — KB 內唯一

**理由**: 檔案開頭新增 code 時，後面 chunk position 變但 content 不變 → 不需 re-embed。

---

## ADR-004: 預設 multilingual-e5-small

**狀態**: 已決定

**背景**: zh-TW + 英文混合環境。

**決策**: 預設 multilingual-e5-small quantized (32 MB)。

**理由**: 同 384d、中文品質好、quantized 損失 <2% for 高資源語言。

---

## ADR-005: Lazy-load + idle-dispose 記憶體策略

**狀態**: 已決定

**行為**: 首次 add/search 載入 → 60s idle dispose → shutdown 強制 dispose。

**理由**: 大多數 session 不用 knowledge → 0 memory cost。

---

## ADR-006: 儲存 ~/.pi/knowledge/ (global) + .pi/knowledge/ (project)

**狀態**: 已決定

**理由**: 知識庫是獨立功能，不嵌套 agent/ 下。

---

## ADR-007: pi install 會跑 postinstall (confirmed from source)

**狀態**: 已確認

**證據**: `package-manager.ts` getNpmInstallArgs() 無 --ignore-scripts。

---

## ADR-008: FTS5 + camelCase pre-tokenize

**狀態**: 需 spike 驗證品質

**方案**: index 前 `replace(/([a-z])([A-Z])/g, '$1 $2')`。

**備案**: trigram tokenizer。


---

## ADR-009: tree-sitter for multi-language AST

**狀態**: 已決定

**選 tree-sitter 而非**:
- TypeScript Compiler API → 只支援 TS/JS
- Babel → 只支援 JS/TS
- ast-grep → 較新、社群小
- 各語言 native parser → 需要 N 個不同 API

**理由**: 唯一能用一套 API 支援 6+ 語言的 AST parser。C binding 但有 Node prebuilt。

---

## ADR-010: unpdf for PDF text extraction

**狀態**: 已決定

**選 unpdf 而非**:
- pdf-parse v2 → API 完全重寫(class-based)、bundle 巨大、測試失敗
- pdfjs-dist → unpdf 內部就是 wrap 它，但 API 更簡潔
- pdf2json → 輸出 JSON 不是 plain text

**理由**: Pure JS、API 簡單 (`extractText(Uint8Array) → {text}`)、中文實測通過。

---

## ADR-011: mammoth for DOCX

**狀態**: 已決定

**選 mammoth 而非**:
- docx-parser → 維護較少
- officeparser → 較新、未經大規模驗證
- textract → 需要系統工具(antiword)

**理由**: Pure JS、15K+ stars、活躍維護、`extractRawText({path}) → {value}` 一行完成。

---

## ADR-012: Regex HTML stripping for URL indexing

**狀態**: 已決定（可改進）

**當前**: `html.replace(/<script>...</script>/).replace(/<[^>]+>/g, " ")`

**替代**: cheerio (~200KB), @mozilla/readability, htmlparser2

**理由**: 零額外依賴。對文檔類頁面（API docs、blog、wiki）夠用。

**已知限制**: 不處理 nested `>`、HTML entities、SPA 動態內容。

**未來升級條件**: 如果使用者回報 URL indexing 品質差，加 cheerio。

---

## ADR-013: JSONL for import/export

**狀態**: 已決定

**選 JSONL 而非**:
- Single JSON → 大檔案不 git-friendly（一行改動 = 整檔 diff）
- SQLite dump → 需要 SQLite 工具解讀
- Custom binary → 不可讀

**理由**: Line-diffable（git-friendly）、streaming 讀寫、人類可讀、可用 jq 查詢。

---

## ADR-014: Contextual Retrieval 使用「索引增強 + 查詢時擴窗 + 意圖排序」

**狀態**: 已決定

**背景**: 單純 chunk-level embedding 會讓 README 或大型概覽文件反覆出現在 top results，也會讓小模組、實作檔與測試檔混排。RRF 雖然穩定，但會壓縮 hybrid score，導致結果差異變成「量的變化」而不是「質的排序」。

**決策**:
- 索引時把 file path、file type、Markdown heading breadcrumbs、code symbols 納入 embedding/FTS searchable text。
- 查詢時保留原始 chunk 作為回傳內容，但 adaptive mode 會從 seed chunk 擴張同檔案上下文 window。
- Hybrid 用 normalized weighted score fusion，後接 query-aware ranking，不再用 RRF 作為預設 fusion。
- Ranking 必須同時考慮 lexical coverage、path token、source file intent、documentation/setup intent、test intent 與 low-evidence confidence gate。
- Ranking diagnostics 必須可回傳，方便用真實專案報告檢視分數與排序原因。

**理由**:
- 索引增強解決「chunk 自身缺少檔案/章節/符號語意」。
- 查詢時擴窗保留上下文，但不污染原始 chunk 內容。
- 意圖排序讓 `stt/stt.go`、`bot/errors.go`、`INSTALL.md` 這類目標依查詢語意勝出，而不是被長文件或測試檔覆蓋。
- Confidence gate 讓無意義或低證據查詢可以回傳 0 結果，避免 agent 建立錯誤信心。

**重建索引邊界**:
- Query normalization、ranking、confidence gate、diversity 屬於 query-time 變更，既有 KB 可直接受益。
- embedding/FTS searchable text、file type 標記、chunk metadata 屬於 index-time 變更，既有 KB 必須 update/rebuild 才會完整受益。
