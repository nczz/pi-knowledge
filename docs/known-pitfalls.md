# 已知的技術陷阱與經驗

開發中遇到的問題，避免未來重複踩坑。

## tree-sitter 版本相容性

```
✅ 可用: tree-sitter@0.22.4 + grammars@0.23.x
❌ 失敗: tree-sitter@0.25.0 (gyp build error on macOS)
❌ 失敗: tree-sitter@0.21.1 + grammar@0.25.0 (nodeTypeNamesById undefined)
```

Grammar 版本必須和 core 配對。鎖定 0.22.x core + 0.23.x grammars。

## PDF/DOCX — 已解決 (v0.2.0)

最終方案不用 pdf-parse。改用：
- **PDF**: `unpdf` (pure JS, `extractText(Uint8Array)`) ✅ 中文 PDF 實測通過
- **DOCX**: `mammoth` (pure JS, `extractRawText({path})`) ✅ 中文 DOCX 實測通過

pdf-parse v2.x 的 class-based API 過於複雜且 bundle 巨大，已棄用。

## PDF/DOCX e2e fixture gate

`npm run test:e2e` 在沒有 `PI_KNOWLEDGE_E2E_PDF` / `PI_KNOWLEDGE_E2E_DOCX` 時會 skip 真實文件抽取測試。這是為了避免把私有 PDF/DOCX fixtures 寫進 repo，但也代表 plain e2e 只能算 smoke pass。

商用品質或 release-grade 驗收必須帶外部 fixture env vars 跑過：

```bash
PI_KNOWLEDGE_E2E_PDF=/path/to/file.pdf PI_KNOWLEDGE_E2E_DOCX=/path/to/file.docx npm run test:e2e
```

不要把 fixture 檔案、抽取文字、snapshot 或本機絕對路徑 commit 進 repo。回報只寫 pass/fail、是否 skipped、chunk count 等非敏感摘要。

## Pi modelRegistry 不提供 API key

`ctx.modelRegistry` 只管 chat model auth。沒有 `getApiKey(provider)`。Extension 用 `process.env.OPENAI_API_KEY`。這是 Pi 的設計，不是 bug。

## @huggingface/transformers 一站式

不要分開裝 onnxruntime-node + tokenizer。`@huggingface/transformers` 包含：WASM tokenizer + ONNX inference + model download + progress callback。

## BM25 CJK 注意事項

FTS5 query builder 的 term filter 不能用 `length > 1`（CJK 逐字分隔後每個字 1 char）。必須 `> 0`。

## BM25 score 方向

SQLite FTS5 的 `bm25()` 分數是「越小越相關」。`KnowledgeEngine.search()` 對所有 search modes 的最終排序語意是「score 越大越相關」，所以 BM25 module 必須在 SQL 層 `ORDER BY bm25(chunks_fts)`，但回傳 `-bm25(chunks_fts) as score`。否則 `mode: "fast"` 會被 engine 的全域排序反轉。

## URL source type 不能偷用 text

URL indexing 如果把 `source_type` 存成 `text`，`knowledge_update` 會走本機檔案存在性檢查，對 `https://...` 永遠失敗。URL 必須是正式 source type，並在 update 時重新 fetch。

## 單檔 diagnostics 路徑

Directory KB 的 chunk `file_path` 是相對路徑；single-file KB 的 chunk `file_path` 是絕對路徑。`knowledge_status` 做 stale 檢測時，只有 directory KB 可以 `join(source_path, relPath)`；single-file KB 必須直接 stat 該絕對路徑。

## Import/export portable contract

JSONL export 是分享格式，不是原機器 source manifest。不要把本機 absolute `source_path` 匯出後再匯入成 active source，否則另一台機器會出現不可更新或錯誤 diagnostics。Imported KB 應當視為 portable text source，必要時重新 add 原始資料來源。

## File watcher fallback

`fs.watch(dir, { recursive: true })` 在 macOS/Node 環境中仍可能因 `EMFILE: too many open files` 或平台限制失效。`startWatcher` 必須保留 polling fallback；狀態顯示的 active watcher count 應計入 native watcher 或 poller。測試 watcher 時至少等待 `POLL_MS + DEBOUNCE_MS`。

## Pi virtual modules vs Node import

Pi binary 會以 virtual modules 提供 `@earendil-works/pi-*` 和 `typebox`，但裸 Node / CI 不會。Package entry 應避免 runtime import 這些 module，或把它們列入 dependency。pi-knowledge 透過 `extension.js` shim 載入已 build 的 `dist/index.js`，並在本地未 build 時 fallback 到 source `index.ts`。至少要通過：

```bash
npm run build
node -e "import('./extension.js')"
```

這能提早發現 package entry、dist 或 startup 依賴問題。

## Biome 2 config schema

Biome 2 使用 `assist.actions.source.organizeImports` 和 `files.includes`；舊的 top-level `organizeImports` 與 `files.ignore` 會讓 `npm run check` 直接失敗。每次升級 Biome 後先跑 `npm run check` 確認 gate 本身可用。

## 開發品質方法論

1. 實作後切換嚴格 review 角色（找 overclaim、走捷徑、未驗證）
2. Dogfood（真實 Pi session，不只 unit test）
3. 修正到文件完全對齊事實才 commit
4. CHANGELOG + README + DESIGN.md 每次 commit 前檢查
5. 回報每個 gate 的驗證層級；skipped tests 不能宣稱完整通過
6. Code comments 只能描述已驗證行為，compatibility shim 要記錄 minimum contract，不要 overclaim host internals

## Contextual Retrieval 品質陷阱

Contextual Retrieval 不能只靠「把鄰近 chunk 多塞一點」解決。常見失敗模式:

- 只增加搜尋量，沒有改善 top results 的排序品質。
- README、評估報告、總覽文件因為包含大量關鍵詞而重複佔據 top results。
- 小模組或單檔 source（例如 `stt/stt.go`）被大型文件或測試檔壓過。
- 查詢沒有足夠證據時仍硬回傳 go.sum、README 或其他無關 chunk。
- `file_type` alias 或 metadata 標記錯誤，導致 `md`/`go` filter 測試失真。
- 生成的知識庫評估報告被再次索引，造成自引用污染。
- locale/i18n translation catalog 因為含有大量 UI 文案，在實作導向查詢中壓過真正的 source file。

修正時必須同時檢查四層:

1. index-time searchable text 是否包含 file path、file type、heading breadcrumbs、code symbols。
2. query normalization 是否處理 camelCase、punctuation、常見 typo、plural/stem 與 CJK token。
3. query-time ranking 是否區分 source/doc/test/setup intent，並提供 diagnostics。
4. confidence gate 是否能讓低證據查詢回傳 0 結果。

如果變更 index-time searchable text、metadata、file type detection 或 chunking，必須重建或 update 既有 KB 才能驗證真實效果。單純 ranking/query-time 變更可直接用現有 KB dogfood。

搜尋模式不能完全交給 agent 猜。工具提示、skill、README 與 AGENTS 必須一致說明:

- `hybrid`: 預設模式，適合大多數專案問題。
- `fast`: 精確 symbol、檔名、指令、錯誤碼、API、config key、quoted string。
- `semantic`: 概念問題，使用者用語可能和文件/程式碼字面不同。
- `adaptive`: 需要鄰近脈絡、相關 section、或準備改 code。
- `deep`: 高風險答案、top results 模糊、或最後驗證。

如果結果空或明顯弱，但 KB 理論上應該有答案，agent 應該換 mode 重試一次；如果結果重複，先用 `diversity: "strong"` 或 `adaptive`，不要只提高 limit。

`auto` mode 是工具層 fallback，不是單純 prompt 建議。它必須回傳實際 `mode_used` 與 `retry_modes`，並避免 exact lookup 查不到後接受零 lexical evidence 的 semantic 假陽性。

生成的 `docs/*knowledge-base*report*.md`、`docs/*evaluation-report*.md`、`docs/*eval-report*.md` 類文件預設不索引。這些文件是評估產物，不是來源真相；若被索引，會讓後續評估查到自己的結論。

locale/i18n/translation catalog 只應在查詢明確包含 translation、locale、language、i18n 等意圖時正常競爭排名。一般開發查詢應優先回傳 source、docs 或架構文件，避免 UI 文案檔用高詞頻污染 top results。

## Browser/vendor bundle indexing trap

專案內若含 Playwright、Chromium、Electron、BrowseForge、瀏覽器 profile/cache 或 `.app` bundle，目錄檔案數可能暴增，而且許多 `.pak`、`.asar`、locale bundle、snapshot 檔小於單檔大小上限，會讓索引器在 binary detection / scanning 階段大量耗 CPU 與 GC，甚至在 KB 建立後、chunk 寫入前長時間卡住。

另一個同類陷阱是 `knowledge-backup.jsonl`、export JSONL、壓縮過的單行資料檔。若文字 chunker 只按空行切分，單行 1MB JSONL 會變成單一巨大 chunk，embedding 前的 text assembly 會造成 V8 large object allocation 與 GC 壓力。

預設 ignore 必須排除明確的 browser/runtime artifacts，例如 `.browser(s)/`、`ms-playwright`、`playwright-report`、`test-results`、`.app`、`.pak`、`.asar`、knowledge export JSONL 等產物。不要用 `chromium`、`chrome`、`firefox`、`webkit`、`browsers` 這類領域名稱做全域排除，否則會誤傷 Playwright、Chromium、Electron 或瀏覽器工具本身的 source tree。文字 chunker 也必須對超大段落做硬切分，不能產生 MB 級 chunk。驗證大型專案索引卡住時，先比較:

```bash
find <project> -type f | wc -l
find <project> -maxdepth 4 \( -path '*/bin/*' -o -path '*/obj/*' -o -path '*/.playwright/*' -o -path '*/ms-playwright/*' -o -path '*/node_modules/*' \) -prune -o -type f -print | wc -l
```

如果差距很大，優先補 ignore 規則，而不是調整 embedding/ranking。

## Ambiguous config should not be hard-excluded

`settings.json`、`appsettings.json`、`.env`、credential/secret-named text、cloud/editor/runtime config 這類檔案可能是專案行為的關鍵知識，也可能含有環境或私人資訊。不要為了「避免敏感資料」而把文字檔做成無法覆蓋的產品層 hard block，否則會讓使用者明確想索引設定、或大型專案需要設定脈絡時建立不完整的 KB。

產品層 hard skip 只適合技術不可索引或會破壞穩定性的內容: unsupported binary/non-text、oversized、unreadable、inaccessible、無法抽取文字的文件。其他文字檔應是 suggested exclusion: 預設提醒並略過，但 agent 可在向使用者確認後用 `include_suggested_text` 或 focused `include_paths` 納入。這包含 `.env`、secret/credential-named text、private-key-looking text、generated report、lockfile、vendor text、build output text、runtime/cache text。普通 config 的取捨應放在 `knowledge_add` prompt guidance: agent 需要判斷它是專案知識還是 environment/private data；風險不明時先問使用者，而不是工具單方面永久阻擋。

## Large indexing must be bounded and observable

大型 codebase 建立 KB 是受支援的長任務；產品可以花時間完成，但不能因規模大而崩潰、靜默假死或留下看似健康的 partial KB。不能把「掃描完成、全部 chunk 放進陣列、全部 embedding、全部向量一次寫檔」當作可接受流程。這會在最糟情境產生三種問題:

- 使用者看不到目前卡在掃描、chunking、embedding、DB write 還是 vector write。
- V8 heap 同時持有大量 chunk text、embedding input、Float32 vectors 和最後 binary buffer。
- Pi 或 Node 中途被殺掉時，可能留下 `status = indexing` 的半成品，下一輪使用者只看到卡住或無結果。

穩定性要求:

- embedding 以固定 hard cap batch 執行，batch 前後都要檢查 cancellation signal。單一大檔產生大量 chunks 時也不能讓 batch 超過上限。
- directory add/update 開始前要做 metadata-only planning scan，先回報可索引檔案數、scannable bytes 與 skipped summary，讓使用者在 expensive embedding 前知道任務規模。
- directory scan 要串流處理檔案，不能先把全部檔案內容收進 `ScannedFile[]` 再開始 chunking。保留相容 helper 可以，但 production add/update/diagnostics path 必須吃 iterator。
- binary detection 只能讀固定大小 sample。不要用 `readFileSync` 讀完整檔案後再檢查前 512 bytes。
- chunks 要分批寫入 SQLite，`updated_at` 和 counts 要隨 batch 更新，讓 `knowledge_status` 能判斷是否仍活著。
- vector file 要 streaming append，最後回寫 header；不要在索引路徑用單一巨大 `Buffer.alloc`。
- update 不能建立 `newChunks`、`chunksToAdd`、`finalChunks` 這類大型全量陣列後才開始處理。新增向量應寫入 temporary vector file，刪除應分批，正式 vector file 應依 DB iterator 重建。
- chunk identity 不能只看 content。大型 codebase 常有重複模板、空函式、產生器輸出或同名設定片段；若 hash 不含 path/line/metadata，update 會把不同檔案的相同內容當同一個 chunk，刪除其中一個檔案時會留下 stale/orphan chunk。
- progress 必須包含目前 phase、已處理量、elapsed 與 chunks/sec，能估算檔案總量時要回報 file ETA。大型檔案會讓 file ETA 偏樂觀，所以不能只顯示 files processed；同一檔案內 chunks 持續增加時，使用者也必須看得出仍有進展。
- progress 不能只靠 `onUpdate`。大型索引常跨越多個 prompt 或 TUI render；phase、last message、last progress time、processed counts、skipped、added/removed/unchanged 與 error/cancelled state 必須持久化，讓 `knowledge_status` 可以判斷正在進展還是真的卡死。
- progress 與 diagnostics 必須揭露 skipped file count/reasons/samples，否則使用者無法判斷是索引器漏掉還是安全排除。
- `knowledge_status` 必須標示超過 stale threshold 的 `indexing` KB，並提示先確認沒有 active Pi process，再 remove/rebuild。
- `knowledge_search` 必須跳過 `indexing` 和 `error` KB，避免中斷後的半成品被 agent 當成可靠檢索結果。
- query-time semantic/hybrid search 不應把整個 KB vector file 或全部 chunk IDs 載入長駐 cache。大型 KB 搜尋要用 streaming/ranged read 掃描 top-K，只保留候選向量給 MMR/diversity。
- diagnostics 不能把所有 chunk content 或所有來源內容載入記憶體，也不應讀取完整來源檔案；只保留 stale/orphan/coverage 判斷需要的 file path、file type、size 和 indexed_at metadata。
- `knowledge_doctor` 必須把 status/diagnostics 收斂成 health score 與 concrete actions，避免使用者看見一堆統計但不知道下一步。


## onnxruntime exit crash (macOS arm64)

**症狀**: Pi 結束時 `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`

**原因**: [microsoft/onnxruntime#25038](https://github.com/microsoft/onnxruntime/issues/25038) — OrtEnv destructor 在 exit() 時 lock 已失效的 thread pool mutex。已在 macOS arm64 + `@huggingface/transformers@3.8.1` transitive `onnxruntime-node@1.21.0` 重現。

**影響**: Session 和 KB 資料通常已在 crash 前存檔完成，但 abort 會讓使用者誤判 session 不乾淨，必須當成品質問題處理。

**緩解**:

- 預設本地模型在隔離子程序中載入 transformers.js / `onnxruntime-node`，Pi TUI 主程序不得直接 import native ONNX backend。
- 預設不要在 Pi 互動 session 內 idle-dispose native ONNX pipelines。已驗證「Pi 主程序載入 native backend 後，`knowledge_search` 後 idle 超過 30 秒再 `/quit`」會噴 `mutex lock failed`。
- `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE=true` 只作為明確 opt-in 記憶體回收選項；商用品質預設必須偏向穩定退出。
- `session_shutdown` 等待 active runs 後以 `SIGKILL` 收掉 model worker，避免 native destructor 在 Pi TUI 主程序 teardown 路徑執行。
- Embedding/reranker dispose 仍必須是 idempotent。測試或明確 dispose path 可能重複呼叫；必須先清空 pipeline reference 再 await native `dispose()`，避免同一個 ONNX session 被 double-dispose。
- Pi `session_shutdown` 不應主動 dispose ONNX pipelines。關閉 session 時只清 timers、等待 active runs 完成、關閉 DB/watcher；讓 process exit 接管 native runtime teardown，避免在 Pi shutdown path 觸發 onnxruntime native mutex crash。
- 不要在 extension 內提供未完整驗證的 custom TUI renderer。已驗證 tool result/warning 行寬超過 Pi TUI 寬度時會先觸發 `Rendered line ... exceeds terminal width`，接著因 native runtime teardown 出現同一個 `mutex lock failed` 二次崩潰。

**根本修復**: 等 Microsoft 修正 → 升級 onnxruntime。無法從 JS 端解決。
