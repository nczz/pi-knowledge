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

**行為**: 首次 add/search 時，由 selected profile daemon 啟動隔離 Node model worker，worker 內載入 transformers.js / `onnxruntime-node`。Pi/OMP extension 與 MCP adapter都不載入 native backend；session shutdown只釋放 client state，不停止 daemon或 worker。Daemon explicit shutdown／authenticated build replacement才等待 active runs、停止 worker並關閉 engine resources。Worker transport優先使用 Node `fork()` IPC；若 Windows OMP 或相容層沒有 `child.send()`，改用 `spawn(node, ... --stdio)` JSONL。Daemon executable只接受目前可信 Node 22+或明確持久化路徑；model worker仍可使用完整 discovery。`PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE=true` 是明確 opt-in，不是預設。

**理由**: 大多數 session 不用 knowledge → extension保持 startup-light；多個 Pi/OMP/MCP client共用 daemon時，不能由任一 session回收共享 worker。隔離 native backend仍避免 macOS arm64 `/quit` 的 onnxruntime `mutex lock failed`；Windows fallback和持久化 `knowledge_configure`則處理 host IPC/runtime差異。

---

## ADR-006: Default-first profile storage

**狀態**: 已由 ADR-024取代原本「global + project-local DB」設計

**決策**: 一般使用者使用 registry穩定映射的 `default` profile；可原地採用一份 legacy `~/.pi/knowledge`或 `~/.omp/knowledge`。Named profiles提供進階隔離。不存在 project-local `.pi/knowledge` active storage mode。

---

## ADR-007: Dependency install-script approval

**狀態**: 原始「沒有 `--ignore-scripts` 就會執行」結論已被 npm 12行為取代

**決策**: Repository以 exact-version `allowScripts`核准已審查的 dependency scripts，release執行 `npm install-scripts ls`。Global install使用 install-time `--allow-scripts`；host-managed install必須檢查實際 package manager與 skipped-script output。

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

## ADR-012: Dependency-free structural HTML normalization for URL indexing

**狀態**: 已決定

**決策**: URL fetch 後先移除 comment、script、style、noscript、template 與 SVG 內容，再把 heading 轉成 Markdown heading、paragraph/block tag 轉成空行、`br` 轉成換行、list item 轉成 `- `、table row/cell 轉成可讀分隔文字。常見 named entity 與合法 numeric entity 會解碼；未知 entity 保留原文。結果走 heading-aware chunker，並保留 `file_type=html`。

**理由**:
- 保住文件標題、section breadcrumb 與段落邊界，避免所有 HTML 被壓成單行後失去 chunk 語意。
- 只在 URL ingestion 執行；無新 dependency、parser process、模型或常駐記憶體。
- 對 API docs、blog、wiki 與一般 server-rendered 文件提供明確改善，且沿用現有 Markdown chunk metadata 與 embedding-safe finalizer。

**已知限制**: 這不是完整 DOM、Readability、OCR 或 browser rendering。Malformed nested tags、`>` 出現在 attribute、SPA 動態內容、CSS layout、複雜表格關係與 `<pre>` 原始排版不保證還原。

**未來升級條件**: 只有在真實 URL fixture 證明 lightweight normalization 無法滿足召回，且使用者接受額外 dependency/runtime 成本時，才評估 htmlparser2、Readability 或可選外部文件處理器；不把 Docling 類重型管線放進預設路徑。

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
- 零結果分類由 engine 根據 KB selection、indexed chunk presence、retrieval、score threshold、lexical eligibility、metadata filter、rerank 與 pagination 的實際階段資料產生；tool layer 只負責兩行文字格式化。
- 搜尋 miss 必須提供 structured reason/action、分階段 candidate counts 與 bounded auto-attempt summaries。Symbol lookup 使用對應的 symbol miss contract。
- Miss path 不執行 diagnostics/source scan，不從 query、KB root 或相對 `path_pattern` 推論 source coverage，也不預設列出本機絕對路徑。

**理由**:
- 索引增強解決「chunk 自身缺少檔案/章節/符號語意」。
- 查詢時擴窗保留上下文，但不污染原始 chunk 內容。
- 意圖排序讓 `stt/stt.go`、`bot/errors.go`、`INSTALL.md` 這類目標依查詢語意勝出，而不是被長文件或測試檔覆蓋。
- Confidence gate 讓無意義或低證據查詢可以回傳 0 結果，避免 agent 建立錯誤信心。
- Mode contract 讓 agent 依任務型態選擇 `fast`、`semantic`、`semantic_hybrid`、`hybrid`、`adaptive` 或 `deep`，並在空/弱結果時重試一次，降低 false negative。
- Tool-owned `auto` mode 降低 agent 忘記切換模式的機率；exact lookup fallback 必須防 semantic false positive。`semantic_hybrid` 保持 explicit opt-in，不作為預設 hybrid 的 lexical evidence gate 替代品。
- Engine-owned miss contract 讓 Pi/OMP agent、RPC consumer 與未來 renderer 使用相同事實，不必解析英文或在 tool adapter 重建搜尋狀態。
- 將 retrieved、threshold-passed、eligibility-passed、metadata-passed counts 分開，避免把 lexical evidence 或 metadata filter 誤報成 threshold rejection。

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
- 每個 batch 成功後立即寫入 update staging tables並更新 persisted indexing job；`knowledge_bases.updated_at`與 published counts只代表最近一次完整成功 publication，不作為 liveness heartbeat。
- vector file 用 header placeholder + append vectors + fsync + close 時回寫 header 的方式串流寫入。
- update 以 hash manifest判斷新增/刪除/未變更；新 chunks/symbols與刪除集合先寫 staging tables，新向量與最終向量寫入不可變 generation file。最後一個 SQLite transaction切換 active vector filename、合併 rows、更新 metadata/counts/成功時間與 job狀態；commit後舊 vector generation才可清理。
- publication前失敗或 process crash不影響既有 live rows/vector pointer；下一次 daemon initialize清理無引用 staging/temp/generation artifacts。已有 published generation的 KB在 update期間維持可搜尋，failed update由 persisted job與 status/doctor揭露。
- directory add/update 開始前先做 metadata-only planning scan，回報可索引檔案數、scannable bytes 與 skipped summary；這個 planning pass 不讀完整檔案內容。
- add/update/import 都必須提供 progress；能估算時包含 elapsed、chunks/sec 與 file ETA。大型檔案可能讓 file ETA 偏樂觀，因此進度文字必須同時顯示 chunk throughput。
- add/update/import 的 job state 必須持久化到 SQLite，包含 operation、status、phase、last message、started_at、last_progress_at、processed files/chunks、skipped、added、removed、unchanged 與 error_message。
- JSONL import 必須逐行讀取、bounded batch parse/embed/store；JSONL export 必須用 chunk iterator + write stream。Import/export 是大型 KB 的搬運路徑，不能把全檔、全部 chunks 或全部 JSON strings 一次放進 heap。
- `knowledge_status` 需要同時偵測 legacy/stale `indexing` status與長時間沒有進展的 running job；failed update使用上一個 generation時必須明確顯示，不能假裝完全健康。
- `knowledge_status` diagnostics 需用 chunk iterator與 streaming source scan，不載入全部 chunk content或全部來源內容，並以 persisted job state區分「仍在進展」、「更新失敗但舊版可搜尋」和「卡住」。
- `knowledge_doctor` 以 health score + blocking/warning/info issues + concrete action收斂使用者下一步；failed update保留舊 generation時是 warning，不是讓 KB離線的 error。
- `knowledge_search`只搜尋有一致 published generation的 `ready`或`stale` KB；跳過沒有安全 generation的 `indexing`和`error` KB。
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
- 支援的文件格式（PDF/DOC/DOCX）是可索引來源，不因二進位副檔名樣貌而被 directory scan 當成 binary skip；單檔與 directory add/update 都必須走同一套 extractor。
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

---

## ADR-017: Pi/OMP 相容性與環境變數覆蓋合約

**狀態**: 已決定

**背景**: `pi-knowledge` 需要同時支援 Pi extension 直載、npm package install、以及 OMP 這類 Pi fork/runtime。OMP install validation 可能在 Bun binary 內靜態解析 literal imports；若 extension entry 在啟動時直接碰 native dependency，就會在工具尚未使用前失敗。不同 runtime 也需要不同預設資料根目錄，但既有 Pi 使用者的 `~/.pi/knowledge` 不應在 OMP migration 時突然不可見。

**決策**:
- `extension.js` 是 package entry shim；build 後優先載入 `dist/index.js`，本地開發未 build 時 fallback 到 source `index.ts`。
- root `index.ts` 保持 startup-light；Pi virtual modules 只允許 type-only 或本地 shim，不在 import 時解析 native runtime。
- production extension 只 lazy import profile resolver 與 daemon client；engine、storage、watcher、model/document worker由 selected profile daemon載入並持有，session shutdown只釋放 client state。
- production extension的預設 `session_start`與 `before_agent_start`不得解析 profile、執行 Windows ACL subprocess或 ensure daemon；tools與 opt-in auto-inject lazy ensure，只有 `PI_KNOWLEDGE_WATCH=true`在 session start eager ensure並 monotonic enable watcher。
- 本地 embedding/reranker 透過 daemon內的 model worker子程序載入 `@huggingface/transformers` / `onnxruntime-node`，不讓 Pi/OMP TUI 主程序直接載入 ONNX native backend。
- `better-sqlite3` 只在 daemon runtime path載入；resolution仍支援 Bun/hoisted dependency情境的非 literal package name與 parent walk fallback。
- `default` profile storage選擇順序是 `PI_KNOWLEDGE_DIR`、`OMP_KNOWLEDGE_DIR`、已原子保存的 profile registry、最後才是唯一一個既有 host-derived legacy database；同時找到多個 legacy database時 fail closed並要求明確選擇。
- 首次 legacy discovery可使用 `PI_CODING_AGENT_DIR` / `OMP_CODING_AGENT_DIR`候選，以及 `~/.pi/knowledge`、`~/.omp/knowledge`；一旦 registry claim成功，Pi、OMP、CLI與 MCP都使用同一 canonical storage，不再按目前 host切換。
- Named profile完全隔離在 `PI_KNOWLEDGE_PROFILE_ROOT`，且拒絕 `PI_KNOWLEDGE_DIR` / `OMP_KNOWLEDGE_DIR`，避免名稱與 storage override產生模糊 mapping。
- 所有 runtime override 必須集中記錄在 `docs/configuration.md`，README 保留使用者入口摘要。

**理由**:
- Install-time validation 應能檢查 extension metadata 和 tool schema，不應因 native module resolution 或 model runtime 提前失敗。
- Lazy runtime + worker isolation 讓 Pi/OMP 在不使用 knowledge tools 的 session 保持低風險、低成本。
- 明確 env overrides 讓 release dogfood、Docker smoke、Pi/OMP isolated install、使用者 migration 都能用可重現方式指定資料與模型位置。
- OMP 支援應記錄最低可驗證 contract，不 overclaim fork host internals。

**驗證要求**:
- entry/package 變更需跑 `npm run build`、`node -e "import('./extension.js')"`、`node --experimental-strip-types -e "import('./index.ts')"`、`npm pack --dry-run`。
- OMP-sensitive 變更需至少跑 OMP install 或 `omp -e ./extension.js` dogfood；若本機無法取得 OMP runtime，release handoff 必須明確標示未驗證。
- native dependency、model worker、storage path 或 shutdown 變更需補 async lifecycle review 與 targeted regression tests。

---

## ADR-018: Recursive AST chunking and AST-backed symbol metadata

**狀態**: 已決定

**背景**: Flat function-level chunking made large classes either too coarse or too fragmented, and `knowledge_symbol_search` relied on declaration regexes that missed common method syntax. Search also needed deterministic structural context richer than one `function_name` field without mutating returned chunk content.

**決策**:
- Supported code files use a normalized tree-sitter structure for TypeScript/JavaScript, Python, Go, Rust, Java, Bash, `.c` GNU C source, C++ source/typed headers, and QML UI files during indexing.
- Small declarations remain whole chunks; oversized declarations recursively descend to child declarations; same-parent small declarations can be packed; nodes with no child declarations use bounded line/character fallback chunks.
- Chunk metadata records deterministic structure: `language`, `symbol`, `symbol_kind`, `scope`, `parent_symbol`, `signature`, export/decorator flags, AST path, and source line range.
- Embedding/FTS searchable text prepends structural metadata, but stored `content` remains the original source slice.
- `knowledge_symbol_search` uses symbols emitted from the same AST analysis so methods can be exact-looked-up even when the parent class is one retrieval chunk.
- Add/update parse each code file once for chunks and symbols; fallback keeps existing text/regex behavior when AST parsing is unsupported or fails.
- Tree-sitter imports stay lazy in indexing/chunking paths; root `index.ts` remains startup-light.
- Parser baseline is `tree-sitter@0.25.1` with a root `overrides.tree-sitter` pin because several maintained grammars still publish older peer ranges while runtime parsing works against the 0.25 ABI; JavaScript uses `tree-sitter-javascript` directly instead of the legacy TypeScript package export.
- Ambiguous `.h` headers remain conservatively classified as text; C++ AST support covers `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, and `.hxx` where the extension itself identifies the language.

**理由**:
- Recursive splitting preserves semantic units while bounding worst-case chunk size for large classes, generated declarations, or huge methods.
- Structural metadata improves exact and contextual retrieval for class/method queries without LLM-generated context or private-source egress.
- Shared AST analysis avoids duplicate parser work and keeps chunk/symbol metadata aligned.
- Fallback preserves existing KB behavior for unsupported languages and short code files where AST emits only symbols.

**重建索引邊界**:
- This changes chunk boundaries, chunk identity metadata, searchable text, and symbol metadata. Existing KBs must run `knowledge_update` or be rebuilt to get full benefit.
- Query-time ranking changes still apply immediately, but AST-backed symbol lookup and structural embedding context require re-indexing.

---

## ADR-019: Metadata-driven AST-aware adaptive expansion

**狀態**: 已決定

**背景**: Recursive AST chunking gives code chunks deterministic `scope`, `parent_symbol`, `symbol_kind`, and signature metadata. Adaptive search already expands hybrid seed chunks with bounded same-file context, but line proximity alone can choose nearby unrelated code over a structurally related sibling method.

**決策**:
- Adaptive mode remains a hybrid-seed retrieval path with same-file bounded candidate fetching.
- Query-time expansion parses only chunk `metadata_json`; it never reparses source files and never imports tree-sitter.
- Candidate scoring combines the existing seed boost, line proximity, and lexical coverage with AST relation boosts for same parent symbol, compatible scope prefix, and parent/child structural relation.
- Returned content remains original chunk source joined as adaptive context; structural metadata is not prepended to returned content.
- `source_chunk_ids` remains the provenance mechanism for expanded context.
- Missing or invalid metadata falls back to the previous proximity/coverage behavior.

**理由**:
- This improves coding-agent context for class/method edits without turning `knowledge_search` into LSP, reference search, or caller/callee graph analysis.
- The bounded same-file candidate window preserves adaptive latency and avoids loading whole KB chunk sets.
- Existing KBs keep working; AST-aware expansion becomes available after update/rebuild populates structural metadata.

---

## ADR-020: 使用既有 model worker 做 embedding-safe finalization，不導入 Docling runtime

**狀態**: 已決定

**背景**: Issue #20 希望大型文件有更具語意的 chunk。專案已有 AST、Markdown heading 與 paragraph-aware 第一階段 chunking，但字元/token heuristic 無法保證完整 contextual input 符合 embedding 模型上限。繁體中文長段落可超過本地模型 512-token 上限而仍只產生一個候選 chunk；Transformers pipeline 會成功回傳截尾向量，使資料遺失不易察覺。Docling 能提供版面、表格與 OCR 管線，但會增加本專案目前不需要的 runtime、模型與維運面。

**決策**:
- 保留現有 AST/Markdown/Text chunker 作為語意邊界第一層。
- 所有 ingestion path 在 hash comparison、embedding 與 persistence 前執行通用 embedding-safe finalizer。
- 本地模型使用同一個 model worker、同一個 embedding pipeline tokenizer 批次計算完整 `passage` input；不在 Pi/OMP 主程序載入 Transformers/ONNX，也不啟動第二個 worker。
- OpenAI-compatible provider 以 `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` 驗證完整 prefixed input；provider 不再靜默 `slice()`。
- 只有超限 chunk 依段落、行、句子、空白與 Unicode code point 細分；安全 chunk identity 保持不變，不預設增加 overlap。
- `source_options` 保存輕量 `embedding_input_policy`。`knowledge_doctor` 對舊 KB 回報機器可讀升級動作，不在啟動或搜尋時自動重建。

**理由**:
- 修正已證實的尾端向量遺失，直接改善 multilingual 與大型文件召回。
- 重用既有 worker、provider、streamed batch 與 SQLite JSON 欄位，不新增 dependency、daemon、DB migration 或常駐模型。
- 第一階段保留 code-first 結構品質；第二階段只負責不可違反的 provider budget。
- Docling 的 OCR/layout/table 能力留待有實際 fixture、召回缺陷與可接受部署成本時再評估，不把可選重型能力放入預設索引路徑。

**效能與升級邊界**:
- tokenizer 計數與 embedding 都是 bounded batch；記憶體仍為當前檔案與 batch 級。
- 完整 ASCII input 在 448-token preferred target 內時使用保守字元上界直接接受；multilingual/較長 input 才進 tokenizer，避免一般 code/docs 增加不必要的 worker round-trip。
- 正常安全 chunk 不重建 identity；只有實際超限內容增加向量數。
- file/directory/URL KB 可用 `knowledge_update` 升級；inline/import KB 由原始來源重新建立。

---

## ADR-021: 全域限制搜尋候選、O(n²) diversity 與 API vector normalization

**狀態**: 已決定

**背景**: 多 KB 搜尋原本只在每個 KB 套用 retrieval limit，合併後的候選會隨 KB 數量成長；adaptive expansion 和 diversity 因而處理未受全域限制的集合。原 MMR-style implementation 又在每輪對每個未選候選重掃全部已選結果，最差為 O(n³)，且 CPU loop 沒有 cooperative yield。OpenAI-compatible embedding API 同時可能回傳未 L2-normalized vectors，但搜尋以 dot product 作為 cosine-style similarity，造成 provider magnitude 影響排名。

**決策**:
- Public search window 驗證 `limit` 為 1-50 的整數、`offset` 為非負整數，且 `offset + limit <= 800`。
- Profile-derived candidate limit 對每個 KB 保留 bounded retrieval breadth；合併後先做 ranking、confidence/filter，再以同一上限建立全域 candidate pool。
- Deep reranking、adaptive context expansion 和 diversity 只能接收全域 bounded pool。Diagnostics 回報 per-KB retrieval limit、retrieved、filtered、diversity candidate counts 和 truncation。
- Diversity 保留既有 relevance、lexical/vector/line redundancy 與 stable tie semantics，但以 running maximum redundancy 讓每個 pair 只需計算一次，時間複雜度降為 O(n²)。
- Large diversity passes 在 bounded CPU slice 後 yield event loop，並在 pair batches 前後檢查 `AbortSignal`。
- OpenAI-compatible vectors 在 query 使用或 persistence 前驗證數量、finite values、non-zero magnitude 並做 client-side L2 normalization。
- API normalization policy `client-l2-v1` 納入 embedding signature。既有 API KB 不自動重建；`knowledge_doctor` 以 `rebuild_vectors` 指示 update/rebuild。

**理由**:
- Per-KB breadth 保留跨 KB recall；全域 cap 把昂貴 query-time work 與 KB 數量解耦。
- Running maximum 與原本每輪取 `max(redundancy)` 數學等價，可改善複雜度而不重寫排序策略。
- Cooperative yield 讓取消能在大型候選池內生效，不需要 worker thread 或新 dependency。
- Client-side normalization 讓所有 OpenAI-compatible providers 符合相同 cosine contract；signature cutover 防止新舊 vector semantics 混用。

**升級邊界**:
- Candidate budget、pagination validation、diversity 與 diagnostics 是 query-time 行為，既有 KB 立即受益。
- Local embedding signature 不變。
- 舊 OpenAI-compatible KB signature 不含 `client-l2-v1`，必須執行 `knowledge_update`；inline/import KB 應從原始來源重新建立。

---

## ADR-022: Embedding input instruction registry 與嚴格向量相容性

**狀態**: 已決定

**背景**: E5 需要 `query: ` / `passage: `，Jina Code 與其他 instructed embedding models 則需要不同的 query/document instructions。把所有模型只歸類為 prefix on/off 會造成兩種風險：送出模型未訓練過的輸入格式，或在 query/index 兩側使用不同 instruction 但仍誤判 vectors 相容。外部 server 的 pooling/normalization 也不是文字 preset 能代替的行為。

**決策**:
- 建立單一 instruction registry，strategy 為 `e5`、`none`、`jina-code`、`custom`；`on`/`off` 與 `jina` 保留為輸入 alias。
- Jina Code task prompts 固定取自 model revision `39aeb4fb9b60f930934c78ae5d749a46287c248a`，task 為 `nl2code`、`code2code`、`code2nl`、`code2completion`、`qa`。
- Custom query/document instructions 必須成對設定，保留原始 whitespace，只接受 printable Unicode 與 newline，單一 instruction 最長 512 characters。Raw instructions 不寫入 signature 或 status。
- OpenAI-compatible path 先產生一次完整 input batch；同一批字串同時用於 safety-cap validation 與 HTTP body，避免 measurement/send 兩次 decoration 漂移。
- Signature 納入 strategy、task 與 instruction hash。既有 E5 `on` 與 `off` signature bytes 不變；新策略沒有 compatibility shim。
- Search、update、doctor、status 共用結構化 compatibility result，區分 missing metadata、dimension、decoration、provider/config 與無法解析的 signature。Mismatch 不能顯示 healthy，也不能重用 unchanged vectors。
- Local E5 worker 只支援 `e5`/`none`。`jina-code`/`custom` 搭配 `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local` 在 config resolution 階段直接拒絕。

**理由**:
- Instruction 是 embedding 模型合約的一部分，不是顯示層 prefix；索引與查詢必須逐 byte 一致。
- Registry 讓 built-in prompts 可稽核，custom 保留其他 provider 彈性，同時避免把可能敏感的 instruction 原文寫入 metadata。
- 單次 prepared batch 保證 budget 計算、送出內容與 signature 所代表的策略一致。
- 明確 compatibility cause 讓使用者知道是 task/instruction、dimension 或 provider 變更，而不是只看到籠統的「metadata changed」。

**限制與升級邊界**:
- Jina preset 只裝飾文字；server 仍必須依模型要求實作 last-token pooling 與 normalization。
- `jinaai/jina-code-embeddings-1.5b` 的 CC-BY-NC-4.0 授權、約 3.09 GB BF16 權重與缺少適用 ONNX artifact，使它只作為 opt-in API preset，不取代本地 E5 預設。
- Strategy、task 或 instruction 改變後，file/directory/URL KB 執行 `knowledge_update`；inline/import KB 從原始來源重建。

---

## ADR-023: PDF/DOCX extraction 使用隔離 Node worker

**狀態**: 已決定

**背景**: `unpdf` / PDF.js 與 `mammoth` 原本在 extension host 內執行。PDF.js 的非致命 font、xref、
color-space 等 diagnostics 會透過 `console.warn` 寫到 inherited stderr；Pi/OMP full-screen TUI 因此可能
被 parser output 覆蓋。OMP 的 Bun host 也不保證能解析 parser package 的 bare import 與 transitive
CommonJS dependencies。

**決策**:
- PDF/DOC/DOCX extraction 透過既有 model worker request/response transport 執行，不在 TUI host 載入 parser。
- Worker stdout/stderr 維持 pipe；stdio transport 的 stdout 只承載 JSONL protocol，其他 console output
  重新導向 worker stderr。
- PDF.js 額外使用 error-only verbosity；顯式建立的 document proxy 在 `finally` destroy。
- Extraction failure 透過 worker response 回傳；不得比對或過濾特定 warning 文字。
- Worker lifecycle、Node 22+ discovery、Windows IPC fallback、cancellation request cleanup 與 shutdown
  繼續共用既有 model worker client。

**理由**:
- Stdio 隔離封閉的是所有第三方 parser output，不只單一 TrueType warning。
- 共用既有 worker 避免第二套 child-process protocol、Node discovery、shutdown 與 Windows fallback。
- Parser 仍為 lazy load；不使用 document source 的 session 不會載入 `unpdf` / `mammoth`。

**限制與升級邊界**:
- OMP packaged host 需要可用的 Node 22+ executable；可用 `knowledge_configure` 持久化路徑。
- Extracted text 會經 worker transport 回傳，受既有 10 MiB directory source limit 與 process memory 約束。
- 不改變 KB schema、chunk identity、embedding signature 或既有 KB；升級後不需 reindex。

---

## ADR-024: Default-first profile singleton daemon 與 capability-gated MCP transports

**狀態**: 已決定

**背景**: Extension、CLI 與其他 agent 若各自建立 `KnowledgeEngine`，會同時持有 SQLite、vector、watcher 與 model-worker lifecycle。Issue #25 的交接狀態檔也會因此出現多個 writer，無法定義唯一輸出。

**決策**:
- 一個 profile 是 storage/runtime domain，可包含多個 KB；未指定時固定使用 `default`。
- 每個 canonical profile storage 只允許一個 authenticated long-lived daemon。Pi/OMP extension、CLI 與 MCP 都是 client，不做 local-engine fallback。
- Named profile 只供進階隔離情境；DB、vectors、config、watchers、daemon 與 `coverage.json` 全部分離。
- Extension session shutdown 只釋放 client reference，不停止 daemon。Watcher enable 是 monotonic profile state。
- MCP stdio 與 Streamable HTTP 共用 transport-independent protocol/capability core，預設唯讀；local root、network、write、admin 必須由啟動參數分別授權，host approval 與 `confirm` 不視為 authorization。Adapter 的 early canonicalization 只改善錯誤回報；daemon 必須在實際 filesystem operation 綁定 root identity 並再次驗證 containment，避免跨 process check/use race。
- stdio 是單一 local client 預設；HTTP 供多個本機 agent 共用一個 adapter，只允許 loopback bind，強制 bearer token 與 supplied-Origin 驗證。使用 Node HTTP primitives，不新增 production dependency；不內建 remote bind、TLS 或 OAuth。
- `coverage.json` 只由 daemon service 在 startup reconcile 與成功 mutation 後，以 `0600` temp + fsync + rename 產生。寫入失敗不回滾 mutation，錯誤透過 status/manifest 呈現；watcher背景 mutation也使用同一診斷更新路徑。

**理由**:
- 單一 owner 移除多 writer、重複 watcher、DB close race 與狀態檔競爭。
- Default-first 保持一般使用者零設定；profile 複雜度留在 process/CLI boundary。
- MCP 與 extension 共用工具定義，避免 schema/描述漂移，同時在 adapter boundary 保留最小權限。
- Request-scoped HTTP SSE 保留長工具的 progress/cancellation；legacy session 與 modern stateless request 可共用同一工具 contract，而不讓 transport 成為第二個 lifecycle owner。

**限制**:
- Daemon 只支援同一使用者、本機 endpoint，不是跨機器服務。
- MCP HTTP 也是同機 transport；不是跨機器、多使用者或未受信網路服務。需要不同 capability 的 client 必須使用不同 endpoint/token/process。
- `coverage.json` 是敏感且 advisory 的 profile scope/status，不是 per-file freshness authority，也不能反向控制 daemon。
- 不相容 build 由 authenticated retirement 後重啟；client 不得直接以 PID 猜測 kill。

---

## ADR-025: Provider failure contract 跨 daemon、MCP 與 persisted job

**狀態**: 已決定

**背景**: OpenAI-compatible embedding 與 API reranker 原本只保留格式化訊息。HTTP status 在 provider call site 已知，卻在 daemon RPC、MCP tool error 與 indexing job persistence 邊界被壓成普通 `Error`；上層因此只能解析文字，無法可靠區分 rate limit、服務中斷、credential/config rejection、timeout 與使用者取消。

**決策**:
- Embedding 與 reranker 共用最小 failure facts：`provider`、`operation`、`kind`，以及可選的 HTTP `status` 或經白名單字元/長度驗證的 network `code`；exported `ProviderError` 也以 direct read-only properties 提供相同 facts，caller 不需解析 message 或內部 metadata。
- `kind` 固定區分 `http`、`network`、`timeout`、`cancelled`。保留既有 human-readable message 與 process 內原始 `cause`，但跨 process 只傳安全 facts，不序列化 headers、credentials、stack 或任意 provider payload。
- Daemon protocol 使用 optional details，client 收到後重建 typed provider error；MCP tool error 在既有文字之外提供相同 facts 與 retryability。
- HTTP 408/425/429/5xx、network 與 timeout 為 retryable guidance；其他 4xx 為 non-retryable guidance。這個分類不自動 retry，避免 mutation 重送與 rate-limit amplification。
- Indexing job 只持久化最小 facts。既有 published generation 的 update 失敗時仍維持 ready/stale 與可搜尋，`knowledge_status` 顯示 provider facts，`knowledge_doctor` 提供 retry 或修正設定的 machine-readable action。

**理由**:
- Structured facts 讓 Pi/OMP、MCP client、status 與 doctor 共用同一判斷，不依賴英文訊息 parsing。
- Optional protocol field 與 nullable schema migration 保持舊 job、非 provider error 及同版本 daemon lifecycle 的相容性。
- 不持久化 response body 或 endpoint，降低 secret/敏感 provider output 長期留存風險。

**限制**:
- Retryability 是一般 HTTP/network operational guidance，不保證特定 provider 的 request 可安全重送。
- Local model worker failure 仍使用既有 worker error contract；未經 HTTP API 的錯誤不冒充 provider HTTP status。
- 本次 schema 變更不要求重建 KB 或 vectors。
