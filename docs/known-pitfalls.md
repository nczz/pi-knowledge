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

Pi binary 會以 virtual modules 提供 `@earendil-works/pi-*` 和 `typebox`，但裸 Node / CI 不會。根 `index.ts` 應避免 runtime import 這些 module，或把它們列入 dependency。至少要通過：

```bash
node --experimental-strip-types -e "import('./index.ts')"
```

這能提早發現 extension startup 依賴問題。

## Biome 2 config schema

Biome 2 使用 `assist.actions.source.organizeImports` 和 `files.includes`；舊的 top-level `organizeImports` 與 `files.ignore` 會讓 `npm run check` 直接失敗。每次升級 Biome 後先跑 `npm run check` 確認 gate 本身可用。

## 開發品質方法論

1. 實作後切換嚴格 review 角色（找 overclaim、走捷徑、未驗證）
2. Dogfood（真實 Pi session，不只 unit test）
3. 修正到文件完全對齊事實才 commit
4. CHANGELOG + README + DESIGN.md 每次 commit 前檢查
5. 回報每個 gate 的驗證層級；skipped tests 不能宣稱完整通過
6. Code comments 只能描述已驗證行為，compatibility shim 要記錄 minimum contract，不要 overclaim host internals


## onnxruntime exit crash (macOS arm64)

**症狀**: Pi 結束時 `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`

**原因**: [microsoft/onnxruntime#25038](https://github.com/microsoft/onnxruntime/issues/25038) — OrtEnv destructor 在 exit() 時 lock 已失效的 thread pool mutex。macOS arm64 + onnxruntime 1.22.0。

**影響**: Session 和 KB 資料通常已在 crash 前存檔完成，但 abort 會讓使用者誤判 session 不乾淨，必須當成品質問題處理。

**緩解**:

- idle timer 30s + session_shutdown 後 500ms delay，讓 native thread pool 有時間在 exit 前清理。
- Embedding/reranker dispose 必須是 idempotent。Idle timer 和 `session_shutdown` 可能同時觸發 dispose；必須先清空 pipeline reference 再 await native `dispose()`，避免同一個 ONNX session 被 double-dispose。
- Idle timer 不能在 active model run 中 dispose。大型 `knowledge_add` 可能 embedding 上千 chunks，超過 30 秒；必須在 batch 開始時清掉 timer，等 batch 結束後才重新啟動 idle countdown，否則會在下一個 chunk 推論時出現 `Session already disposed`。
- Pi `session_shutdown` 不應主動 dispose ONNX pipelines。關閉 session 時只清 idle timers、等待 active runs 完成、關閉 DB/watcher；讓 process exit 接管 native runtime teardown，避免在 Pi shutdown path 觸發 onnxruntime native mutex crash。

**根本修復**: 等 Microsoft 修正 → 升級 onnxruntime。無法從 JS 端解決。
