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
- Agent-facing mode selection 必須文件化，不能只提供 modes 讓模型自行猜測。
- `auto` mode 在工具層執行 primary mode selection 與 fallback，並回傳 mode/retry metadata。

**理由**:
- 索引增強解決「chunk 自身缺少檔案/章節/符號語意」。
- 查詢時擴窗保留上下文，但不污染原始 chunk 內容。
- 意圖排序讓 `stt/stt.go`、`bot/errors.go`、`INSTALL.md` 這類目標依查詢語意勝出，而不是被長文件或測試檔覆蓋。
- Confidence gate 讓無意義或低證據查詢可以回傳 0 結果，避免 agent 建立錯誤信心。
- Mode contract 讓 agent 依任務型態選擇 `fast`、`semantic`、`hybrid`、`adaptive` 或 `deep`，並在空/弱結果時重試一次，降低 false negative。
- Tool-owned `auto` mode 降低 agent 忘記切換模式的機率；exact lookup fallback 必須防 semantic false positive。

**重建索引邊界**:
- Query normalization、ranking、confidence gate、diversity 屬於 query-time 變更，既有 KB 可直接受益。
- embedding/FTS searchable text、file type 標記、chunk metadata 屬於 index-time 變更，既有 KB 必須 update/rebuild 才會完整受益。

**研究依據與取捨**:
- 採用 RAG 的基本分工: 外部知識以檢索方式進入上下文，而不是要求模型記住所有內容。參考 Lewis et al. 2020, "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks".
- 採用 dense retrieval 作為 semantic recall 層。參考 Karpukhin et al. 2020, "Dense Passage Retrieval for Open-Domain Question Answering".
- 採用 Contextual Retrieval 的核心洞察: chunk 本身常缺上下文，因此 searchable text 需要補上 chunk 所屬的文件/章節/符號背景。參考 Anthropic 2024, "Introducing Contextual Retrieval".
- 保留 RRF 作為測試過的 fusion baseline，但預設改用 normalized weighted score fusion。原因是本產品需要可診斷的分數區間；RRF 在專案級 dogfood 中讓 hybrid score 過度壓縮。參考 Cormack et al. 2009, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods".
- 採用 MMR 類似的 diversity 思路降低同檔案、同 window、同語意 chunk 的重複佔位。參考 Goldstein and Carbonell 1998, "Using MMR for Diversity-Based Reranking".
- 未採用 ColBERT late interaction 作為本 release 預設。ColBERT 對精細 token interaction 有價值，但需要更重的模型與索引設計；目前用 lightweight local embeddings、BM25、query-aware ranking、diversity 和 optional cross-encoder reranking 先取得較低成本的商用品質。參考 Khattab and Zaharia 2020, "ColBERT".

---

## ADR-015: 大型索引採用 bounded batches + streamed vectors

**狀態**: 已決定

**背景**: 真實專案可能包含數百到數十萬個可索引 chunk。若 `knowledge_add`、`knowledge_update` 或 `knowledge_import` 一次持有全部 embedding input、全部 Float32 vectors，再用單一 `Buffer.alloc` 寫 vector file，會讓大型 codebase 建 KB 時不穩定，也讓使用者無法判斷還要等多久。

**決策**:
- embedding batch 固定上限，目前為 64 chunks。
- 每個 batch 成功後立即寫入 SQLite 並更新 KB counts，讓 `updated_at` 代表索引仍有進展。
- vector file 用 header placeholder + append vectors + close 時回寫 header 的方式串流寫入。
- add/update/import 都必須提供 progress；能估算時包含 elapsed 與 ETA。
- `knowledge_status` 需要偵測 stale `indexing` 狀態，避免中斷後的半成品被誤認為健康 KB。
- `knowledge_doctor` 以 health score + blocking/warning/info issues + concrete action 收斂使用者下一步。
- `knowledge_search` 跳過 `indexing` 和 `error` KB，只搜尋 `ready` 或 `stale` KB。
- semantic/hybrid search 以 vector file ranged reads 掃描 top-K，不把整個 KB 的 Float32 vectors 放進長駐 cache。

**理由**:
- 商用品質的索引行為應先求穩定完成，再求速度。
- 批次寫入讓大型專案在模型推論、SQLite 寫入、向量檔輸出三個階段都有可觀測進度。
- 串流向量檔避免最後一次把所有向量複製到同一個巨大 buffer。
- query-time streaming scan 的時間複雜度仍是 O(N)，但記憶體用量由 O(N vectors) 降到 O(topK vectors)，更符合本階段「再大的 codebase 先穩定可跑」的目標。

**限制**:
- 搜尋仍是 exact scan，不是 ANN。若未來需要百萬級 chunk 的低延遲搜尋，需改成 mmap/分片向量索引或外部 ANN index。
