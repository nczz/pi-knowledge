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
- Chunk identity: `SHA-256(filePath + fileType + startLine + endLine + metadataJson + content)` — KB 內唯一

**理由**:
- Embedding cache 可以只看 content，因為同一段文字的語意向量可重用。
- Chunk identity 不能只看 content，否則不同檔案或同檔不同位置的相同內容會在 update 時互相覆蓋，造成刪除檔案後 stale chunks/orphans 留在 KB。
- 目前 SQLite `content_hash` 欄位承擔的是 chunk identity，不是 embedding cache key；因此必須包含 path、line 與 metadata。若未來新增真正 embedding cache，應使用獨立欄位或獨立 cache key。

---

## ADR-004: 預設 multilingual-e5-small

**狀態**: 已決定

**背景**: zh-TW + 英文混合環境。

**決策**: 預設 multilingual-e5-small quantized (32 MB)。

**理由**: 同 384d、中文品質好、quantized 損失 <2% for 高資源語言。

---

## ADR-005: Lazy-load + stable native model lifecycle

**狀態**: 已決定

**行為**: 首次 add/search 載入本地 embedding/reranker → Pi 主程序 fork model worker → worker 內載入 transformers.js / `onnxruntime-node` → session 內保留 worker 到 shutdown → `session_shutdown` 等 active runs 完成後用 `SIGKILL` 收掉 worker。`PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE=true` 是明確 opt-in，不是預設。

**理由**: 大多數 session 不用 knowledge → 0 memory cost；一旦使用本地模型，穩定退出優先於把 native backend 留在 Pi TUI 主程序。已驗證 macOS arm64 上主程序載入 native backend 後 `/quit` 會觸發 onnxruntime `mutex lock failed` abort。

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

**背景**: 真實專案可能包含數百到數十萬個可索引 chunk。大型 indexing 是產品支援的長任務，不是必須瞬間完成的背景小工作；產品責任是限制資源、持續顯示進度、避免假死與壞狀態。若 `knowledge_add`、`knowledge_update` 或 `knowledge_import` 一次持有全部 embedding input、全部 Float32 vectors，再用單一 `Buffer.alloc` 寫 vector file，會讓大型 codebase 建 KB 時不穩定，也讓使用者無法判斷目前是否仍在進展。

**決策**:
- directory scan 用 iterator/callback 型 API 串流產生檔案，production add/update path 不先收集所有 `ScannedFile.content`；diagnostics 使用 metadata-only scanner，不讀取完整檔案內容。
- binary detection 只讀固定 sample，不用 `readFileSync` 讀完整檔案後再取前段。
- embedding batch 是硬上限，目前為 64 chunks；單一大檔產生大量 chunks 時也不能超過此上限。
- 每個 batch 成功後立即寫入 SQLite 並更新 KB counts，讓 `updated_at` 代表索引仍有進展。
- vector file 用 header placeholder + append vectors + close 時回寫 header 的方式串流寫入。
- update 以 hash manifest 判斷新增/刪除/未變更，新增向量先寫入 temporary vector file，最後依 SQLite chunk iterator 重建正式 vector file。
- 刪除 chunks 必須分批執行，避免大型 KB 超過 SQLite parameter limit。
- directory add/update 開始前先做 metadata-only planning scan，回報可索引檔案數、scannable bytes 與 skipped summary；這個 planning pass 不讀完整檔案內容。
- add/update/import 都必須提供 progress；能估算時包含 elapsed、chunks/sec 與 file ETA。大型檔案可能讓 file ETA 偏樂觀，因此進度文字必須同時顯示 chunk throughput。
- add/update/import 的 job state 必須持久化到 SQLite，包含 operation、status、phase、last message、started_at、last_progress_at、processed files/chunks、skipped、added、removed、unchanged 與 error_message。
- `knowledge_status` 需要偵測 stale `indexing` 狀態，避免中斷後的半成品被誤認為健康 KB。
- `knowledge_status` diagnostics 需用 chunk iterator 與 streaming source scan，不載入全部 chunk content 或全部來源內容，並以 persisted job state 區分「仍在進展」和「卡住」。
- `knowledge_doctor` 以 health score + blocking/warning/info issues + concrete action 收斂使用者下一步。
- `knowledge_search` 跳過 `indexing` 和 `error` KB，只搜尋 `ready` 或 `stale` KB。
- semantic/hybrid search 以 vector file ranged reads 掃描 top-K，不把整個 KB 的 Float32 vectors 或全部 chunk IDs 放進長駐 cache。

**理由**:
- 商用品質的索引行為應先求穩定完成，再求速度。
- 大型 indexing 可以花很久，但不能因專案規模大而讓 process 無界成長、靜默卡死、或留下看似健康的 partial KB。
- 批次寫入讓大型專案在模型推論、SQLite 寫入、向量檔輸出三個階段都有可觀測進度。
- persisted job state 讓使用者可以在下一個 prompt、另一個狀態查詢或 TUI 更新消失後仍知道索引目前在哪個階段，而不是只能看到 `Working...`。
- 串流掃描讓 400 萬行等級 codebase 的主要記憶體消耗由「全部檔案內容 + 全部 chunks + 全部 vectors」降為「當前檔案 + embedding batch + hash/id metadata + top-K candidates」。
- 串流向量檔避免最後一次把所有向量複製到同一個巨大 buffer。
- query-time streaming scan 的時間複雜度仍是 O(N)，但記憶體用量由 O(N vectors) 降到 O(topK vectors)，更符合本階段「再大的 codebase 先穩定可跑」的目標。

**限制**:
- 搜尋仍是 exact scan，不是 ANN。若未來需要百萬級 chunk 的低延遲搜尋，需改成 mmap/分片向量索引或外部 ANN index。

---

## ADR-016: 文字檔風險由 agent 與使用者確認，不做永久硬排除

**狀態**: 已決定

**背景**: 大型專案常把重要架構、feature flags、module wiring、cloud/runtime 行為放在 `settings.json`、`appsettings.json`、`.env`、editor config、generated report、lockfile、vendor text 或其他設定/文字檔中。這些檔案可能是專案知識，也可能包含私人資訊或降低搜尋精準度。若產品層用 broad hard ignore 直接排除文字檔，會讓合法索引需求建立不完整 KB；若完全不提示 agent，又可能把敏感或低價值內容納入索引。

**決策**:
- hard skip 只用於技術不可索引或會破壞穩定性的內容: unsupported binary/non-text、oversized、unreadable、inaccessible、無法抽取文字的文件。
- `.env`、private-key-looking text、credential/secret-named text、generated report、lockfile、vendor text、build output text、runtime/cache text 是 suggested exclusion，不是永久 hard block。
- `knowledge_plan` 是 no-write inspection tool，讓 agent 在建立 KB 前先回報 scannable files、suggested exclusions、technical skips，再請使用者確認。
- `knowledge_add` 預設可以略過 suggested exclusions，但必須提供 `include_suggested_text` 與 focused `include_paths` 讓 agent 在使用者確認後納入。
- `exclude_paths` 讓 agent 能在單一專案 KB 中精準排除使用者不想索引的文字檔，不需要拆成大量 per-file KB。
- confirmed scope options 必須持久化，`knowledge_update` 需重用同一套 include/exclude 規則，避免更新後悄悄丟失使用者確認過的文字檔。
- `knowledge_add` prompt guidance 必須要求 agent 把 source/docs/config 當成專案知識候選，同時對 ambiguous/risky/low-signal text 做風險與精準度判斷；若看起來可能是 environment-specific、private data 或搜尋污染來源，先向使用者確認。

**理由**:
- 工具層 hard block 應用在技術不可索引與穩定性底線；文字內容是否值得索引是產品/agent/user 的範圍決策。
- 將模糊決策移到 prompt、scan suggestions 與 user confirmation，可以保留完整性，同時讓使用者對隱私與精準度風險有最後決定權。
- 這比針對單一測試專案調整 ignore 更通用，適用於 .NET、Node、Java、cloud-native、browser tooling 等不同專案型態。
