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


## onnxruntime exit crash (macOS arm64)

**症狀**: Pi 結束時 `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`

**原因**: [microsoft/onnxruntime#25038](https://github.com/microsoft/onnxruntime/issues/25038) — OrtEnv destructor 在 exit() 時 lock 已失效的 thread pool mutex。macOS arm64 + onnxruntime 1.22.0。

**影響**: 純 cosmetic。Session 和 KB 資料已在 crash 前存檔完成。

**緩解**: idle timer 30s + session_shutdown 後 500ms delay。讓 native thread pool 有時間在 exit 前清理。

**根本修復**: 等 Microsoft 修正 → 升級 onnxruntime。無法從 JS 端解決。
