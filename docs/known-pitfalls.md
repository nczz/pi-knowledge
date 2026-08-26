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

## OpenAI-compatible embedding 設定錯誤不能靜默降級

自架 embedding server（例如 llama-server 的 OpenAI-compatible `/v1/embeddings`）需要可設定 base URL。產品支援 `PI_KNOWLEDGE_EMBEDDING_BASE_URL`，也相容常見的 `OPENAI_BASE_URL`。兩者都應指向包含 `/embeddings` 的 API root，例如 `http://127.0.0.1:8080/v1`。

API embedding 失敗時，預設必須把 HTTP status 與短錯誤內容回報給使用者。不要靜默 fallback 到 local ONNX，否則 API key、base URL、model name、context window 等設定錯誤會被藏起來，使用者只會得到較慢或不同模型產生的 KB。只有使用者明確設定 `PI_KNOWLEDGE_EMBEDDING_API_FALLBACK=local` 時才允許 fallback，且必須輸出 warning。

即使 chunker 已避免產生巨大 Markdown/text chunk，API provider 仍應保留最後一道 input 長度保護，避免外部 OpenAI-compatible server 因 model context window 較小而回 400。預設 `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS=20000`，使用不同 context window 的 self-hosted model 時可調整。這是 safety cap，不應取代 chunker 的 bounded chunk 修復。

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

Import/export 也必須維持 streaming 語意。不要用 `readFileSync(...).split("\n")` 或 `getChunksByKB().map(...).join("\n")` 重新引入全量 heap 放大；大型 KB 匯入匯出應逐行處理、以 bounded batch embedding/store，並支援 cancellation。

Export 必須寫到同目錄 temporary file，成功完成後才 rename 到使用者指定的 `outputPath`。取消或失敗只能刪 temporary file，不能刪除或截斷使用者既有 export 檔。Export 雖然是讀取操作，也要納入 engine lifecycle guard，避免和 remove/update/shutdown 交錯。

## Remove/clear data deletion contract

`knowledge_remove` 與 `knowledge_clear` 的使用者語意是刪除 KB 衍生資料，不只是刪 SQLite rows。Engine layer 必須在刪 DB row 的同時刪除 `vectors/<kb.id>.bin`，因為 storage layer 不知道 knowledge directory。失敗 cleanup 也要刪除 temp vector 和可能已 rename 的 vector file，避免 private embedding data 殘留在 `~/.pi/knowledge` 或 `~/.omp/knowledge`。

## File watcher fallback

`fs.watch(dir, { recursive: true })` 在 macOS/Node 環境中仍可能因 `EMFILE: too many open files` 或平台限制失效。`startWatcher` 必須保留 polling fallback；狀態顯示的 active watcher count 應計入 native watcher 或 poller。測試 watcher 時至少等待 `POLL_MS + DEBOUNCE_MS`。

Watcher snapshot 必須套用與 indexing scanner 一致的 suggested exclusions / include / exclude options。否則大型 repo 即使 indexing 排除了 `node_modules`、`.git`、`dist`、runtime cache，watcher 仍會每輪掃完整 tree 或因 ignored file 改動觸發 update。

## SQLite iterator/update lifecycle

`better-sqlite3` 的 `.iterate()` 會讓 statement lifecycle 跟 JS iterator 消費方式綁在一起。Search、status、doctor 或 vector rebuild 如果中途 break、return、throw，後續同一 connection 的 write 可能遇到 `This database connection is busy executing a query`。Production paths 不應把 live SQLite iterator 傳入可能提前返回的 helper，也不應在 live `chunks` iterator 迴圈內寫 DB。改用 bounded `.all()` 分頁 generator，讓每批 query statement 在 yield 前已完成。

`knowledge_update` 還必須以 KB id 做 in-flight coalescing。Watcher 自動更新、手動 `knowledge_update`、重試與 shutdown 都可能重疊；guard state 必須在任何可 yield 的 work 前建立，dispose 必須等待 active update settle 後再關 DB。

所有 destructive/mutation paths 都要尊重同一個 lifecycle gate。`add`、`import`、`update`、`remove`、`clear` 不可在任一 KB mutation active 時交錯；`dispose()` 開始後必須在任何 await 前設 shutdown state，late tool wrapper 呼叫只能拒絕，不能再拿舊 engine reference 寫 DB 或 vector files。

`knowledge_update` cancellation 不能把原本 ready/stale KB 變成 error，也不能提前刪除可見 symbols。新增 chunks、臨時 vector files、replacement vector files 都必須可回滾；舊 chunks/symbols 只可在 replacement vector 成功建立後的 commit path 替換。

## Pi virtual modules vs Node import

Pi binary 會以 virtual modules 提供 `@earendil-works/pi-*` 和 `typebox`，但裸 Node / CI 不會。Package entry 應避免 runtime import 這些 module，或把它們列入 dependency。pi-knowledge 透過 `extension.js` shim 載入已 build 的 `dist/index.js`，並在本地未 build 時 fallback 到 source `index.ts`。至少要通過：

```bash
npm run build
node -e "import('./extension.js')"
```

這能提早發現 package entry、dist 或 startup 依賴問題。

## OMP Bun binary native dependency resolution

OMP plugin install validation runs in a Bun binary path that can statically resolve literal `import()` / `require()` targets before runtime guards run. Keep `extension.js` and root `index.ts` startup-light: do not statically import modules that pull native dependencies such as `better-sqlite3`.

Bun binary resolution may also fail to resolve hoisted native-package dependencies from bare package specifiers. Native loaders should first try normal resolution, then walk parent directories for the installed package entry and require that absolute path with non-literal package names so validation does not pre-resolve it.

## Windows OMP model-worker IPC

**症狀**: Windows 上用 OMP 執行 `knowledge_add`，第一次本地 embedding batch 可能回報 `child.send is not a function`、`Model worker is not connected`，或在 host 層噴出 `ENOENT: no such file or directory, uv_spawn 'node'`。

**原因**: OMP packaged host 或 Bun 相容層可能回傳沒有 Node IPC `.send()` 的 `child_process.fork()` child object；Windows 使用者也可能沒有把 Node 加到 `PATH`，或把含空白的 `node.exe` 路徑連同引號寫入環境變數。這不是索引來源內容、SQLite 或 KB 名稱問題，而是本地 model worker transport 啟動層的相容性問題。

**緩解/修復**:
- model worker client 必須先檢查 worker 檔案存在與 Node 22+ 可用，不可讓 missing Node 變成未捕捉的 `uv_spawn 'node'`。
- Windows Node discovery 應檢查 `PI_KNOWLEDGE_NODE_PATH`、持久化 `knowledge_configure` 設定、`NODE`、NVM symlink、Volta、常見 `Program Files\nodejs\node.exe`、`LOCALAPPDATA\Programs\nodejs\node.exe`、Codex `LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\*\bin\node.exe` 與 `PATH`；路徑外層引號要先剝掉。
- 優先使用 Node `fork()` IPC；若 `child.send` 不存在，關掉該 child 並自動 fallback 到 `spawn(node, ... --stdio)` 的 stdin/stdout JSONL protocol。
- stdio fallback 的 stdout 只能承載 framed JSON response；worker/stdout logging 必須 redirect 到 stderr，避免 transformers/ONNX log 污染 protocol。
- Windows/OMP 使用者若 worker startup 仍失敗，可設定 `PI_KNOWLEDGE_NODE_PATH` 指向完整 `node.exe`，或改用 OpenAI-compatible embedding provider。

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

1. index-time searchable text 是否包含 file path、file type、heading breadcrumbs、code symbols、scope、parent symbol 與 signature。
2. query normalization 是否處理 camelCase、punctuation、常見 typo、plural/stem 與 CJK token。
3. query-time ranking 是否區分 source/doc/test/setup intent，並提供 diagnostics。
4. confidence gate 是否能讓低證據查詢回傳 0 結果。

如果變更 index-time searchable text、metadata、file type detection 或 chunking，必須重建或 update 既有 KB 才能驗證真實效果。單純 ranking/query-time 變更可直接用現有 KB dogfood。

搜尋模式不能完全交給 agent 猜。工具提示、skill、README 與 AGENTS 必須一致說明:

- `hybrid`: 預設模式，適合有明確 lexical anchor 的多數專案問題；它不是 vector-only semantic recall，低 keyword evidence 會被 gate 掉。
- `fast`: 精確 symbol、檔名、指令、錯誤碼、API、config key、quoted string。
- `semantic`: 概念問題，使用者用語可能和文件/程式碼字面不同，或 `hybrid` 沒有 lexical match 但 KB 理論上應該有答案。
- `adaptive`: 需要鄰近脈絡、相關 section、或準備改 code。
- `deep`: 高風險答案、top results 模糊、或最後驗證。

如果結果空或明顯弱，但 KB 理論上應該有答案，agent 應該換 mode 重試一次；如果結果重複，先用 `diversity: "strong"` 或 `adaptive`，不要只提高 limit。

`auto` mode 是工具層 fallback，不是單純 prompt 建議。它必須回傳實際 `mode_used` 與 `retry_modes`，並避免 exact lookup 查不到後接受零 lexical evidence 的 semantic 假陽性。

`knowledge_symbol_search` 是 exact lookup 的第一層，不是完整 code graph。它應索引 lightweight、可重建的 metadata: AST-backed function/method/class/interface/type/variable、Markdown heading、config key、env var。不要為了 symbol lookup 在 root entry 或一般啟動路徑引入 LSP、tree-sitter 或大型 parser；tree-sitter 只能在 indexing/chunking 路徑 lazy-load。如果需要 caller/callee graph 或 rename 語意，應作為後續明確設計，而不是塞進 Pi/OMP 外掛的 startup path。

`knowledge_search` 的 `path_pattern` 是 substring filter，不是 glob/LSP path query。Agent 若需要鎖定檔案或目錄，可以搭配 `file_type` 使用；若需要 code symbol 的 caller/callee 或 rename 語意，這不是此工具的責任。

搜尋 provenance 不能 overclaim。`stale=false` 只代表能取得來源 mtime 時來源沒有比 chunk `indexed_at` 更新，或 KB 本身不是 stale；它不是外部依賴、遠端 URL 或使用者語意正確性的保證。Agent 回答仍應用 file path、line range、match reason 和 diagnostics 判斷證據強度。

生成的 `docs/*knowledge-base*report*.md`、`docs/*evaluation-report*.md`、`docs/*eval-report*.md` 類文件預設不索引。這些文件是評估產物，不是來源真相；若被索引，會讓後續評估查到自己的結論。

locale/i18n/translation catalog 只應在查詢明確包含 translation、locale、language、i18n 等意圖時正常競爭排名。一般開發查詢應優先回傳 source、docs 或架構文件，避免 UI 文案檔用高詞頻污染 top results。

## Browser/vendor bundle indexing trap

專案內若含 Playwright、Chromium、Electron、BrowseForge、瀏覽器 profile/cache 或 `.app` bundle，目錄檔案數可能暴增，而且許多 `.pak`、`.asar`、locale bundle、snapshot 檔小於單檔大小上限，會讓索引器在 binary detection / scanning 階段大量耗 CPU 與 GC，甚至在 KB 建立後、chunk 寫入前長時間卡住。

另一個同類陷阱是 `knowledge-backup.jsonl`、export JSONL、壓縮過的單行資料檔，或 Markdown 內的巨大 code block / 單一長段落。若文字或 Markdown chunker 只按空行切分，單行 1MB JSONL 或大型 `.md` 段落會變成單一巨大 chunk，embedding 前的 text assembly 會造成 V8 large object allocation、GC 壓力，或超出外部 embedding server 的 context window。

預設 ignore 必須排除明確的 browser/runtime artifacts，例如 `.browser(s)/`、`ms-playwright`、`playwright-report`、`test-results`、`.app`、`.pak`、`.asar`、knowledge export JSONL 等產物。不要用 `chromium`、`chrome`、`firefox`、`webkit`、`browsers` 這類領域名稱做全域排除，否則會誤傷 Playwright、Chromium、Electron 或瀏覽器工具本身的 source tree。文字與 Markdown chunker 也必須對超大段落做硬切分，不能產生 MB 級 chunk。驗證大型專案索引卡住時，先比較:

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
- AST chunk identity 必須用 normalized metadata；如果直接 hash 原始 AST node text 或只 hash symbol 名稱，重複方法、同名 class 或 update 後移動的 code 會造成 stale chunk 或錯誤 vector reuse。
- progress 必須包含目前 phase、已處理量、elapsed 與 chunks/sec，能估算檔案總量時要回報 file ETA。大型檔案會讓 file ETA 偏樂觀，所以不能只顯示 files processed；同一檔案內 chunks 持續增加時，使用者也必須看得出仍有進展。
- progress 不能只靠 `onUpdate`。大型索引常跨越多個 prompt 或 TUI render；phase、last message、last progress time、processed counts、skipped、added/removed/unchanged 與 error/cancelled state 必須持久化，讓 `knowledge_status` 可以判斷正在進展還是真的卡死。
- progress 與 diagnostics 必須揭露 skipped file count/reasons/samples，否則使用者無法判斷是索引器漏掉還是安全排除。
- `knowledge_status` 必須標示超過 stale threshold 的 `indexing` KB，並提示先確認沒有 active Pi process，再 remove/rebuild。
- `knowledge_search` 必須跳過 `indexing` 和 `error` KB，避免中斷後的半成品被 agent 當成可靠檢索結果。
- query-time semantic/hybrid search 不應把整個 KB vector file 或全部 chunk IDs 載入長駐 cache。大型 KB 搜尋要用 streaming/ranged read 掃描 top-K，只保留候選向量給 MMR/diversity。
- diagnostics 不能把所有 chunk content 或所有來源內容載入記憶體，也不應讀取完整來源檔案；只保留 stale/orphan/coverage 判斷需要的 file path、file type、size 和 indexed_at metadata。
- `knowledge_doctor` 必須把 status/diagnostics 收斂成 health score 與 concrete actions，避免使用者看見一堆統計但不知道下一步。


## Embedding provider changes must not mix vector spaces

`PI_KNOWLEDGE_EMBEDDING` 影響 index-time document vectors 和 query-time vectors。若 add/update/import 的某些 batch 用 OpenAI-compatible API 成功、後續 batch 又因 fallback 改用 local model，同一個 KB vector file 會混入不同向量空間；搜尋時分數看似正常但語意完全不可靠。

穩定性要求:

- 每個 KB 必須持久化 embedding model label、vector dimension、以及不含 secret 的 embedding signature。signature 至少要反映 provider/model、API base URL hash、query/document prefix、pooling、normalize、API input cap 與 dimension。
- add/update/import 的 document embedding API failure 不得 silent fallback 到 local。使用者明確設定 fallback 也只能用於 query-time degradation，不能用於產生 KB vectors。
- `knowledge_update` 發現目前 embedding signature 與 KB metadata 不相容時，不能重用 unchanged chunk 的舊 vectors，必須完整重建 vectors。
- `knowledge_search` 在 semantic/hybrid vector retrieval 前要檢查 KB signature/dimension。相容才可讀 vector file；不相容時 hybrid 可退回 BM25-only 並明確 warning，semantic 不可拿錯向量空間硬搜。


## Cancellation boundaries must preserve unrelated work

Pi/OMP 使用者取消 tool call 時，取消只應影響該次請求，不能把共享資源或既有 KB 推進失敗狀態。

- OpenAI-compatible embedding 的 `AbortError` 必須 normalize 成產品層 `Cancelled`，否則 update/import 會把使用者取消誤判成 API failure，進而把原本 ready/stale KB 標成 `error`。
- model worker 是 embedding 與 reranking 的共享子程序。單一 rerank/search request 被取消時，不應直接 kill worker 並用普通 failure reject 其他 pending embedding requests；否則取消查詢會讓同時進行的 add/update/import 失敗。
- export 必須先寫 unique temp file，並在最後 rename/publish 前再次檢查 cancellation。最後一次 progress callback 也可能觸發 abort；不能因 loop 已結束就覆蓋使用者既有 output。
- PDF/DOCX 這類 heavy extraction path 在 add/update 都要共用同一套 extractor，並在讀檔、載入 parser、extract 前後檢查 cancellation。單檔與 directory scan 都必須走 extractor；update 不能把已支援的 document source 當 UTF-8 raw text 重新索引，也不能把 directory 裡的 PDF/DOCX 誤列為 binary technical skip。
- public tool wrapper 即使只是 show/list/symbol lookup，也要在 runtime initialization 前後觀察 AbortSignal。今天查詢很快不代表未來 symbol table 或 DB startup 一定便宜。


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
- `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE` 目前只啟用 idle coordination timers，不保證立刻釋放 model-worker 內的 native ONNX memory。真正的 worker process shutdown 仍由 engine/session shutdown 控制；若未來要 idle kill worker，必須先有 embedding/reranker 共用的 active-run accounting。
- 不要在 extension 內提供未完整驗證的 custom TUI renderer。已驗證 tool result/warning 行寬超過 Pi TUI 寬度時會先觸發 `Rendered line ... exceeds terminal width`，接著因 native runtime teardown 出現同一個 `mutex lock failed` 二次崩潰。

**根本修復**: 等 Microsoft 修正 → 升級 onnxruntime。無法從 JS 端解決。
