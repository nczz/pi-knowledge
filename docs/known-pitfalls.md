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

## 開發品質方法論

1. 實作後切換嚴格 review 角色（找 overclaim、走捷徑、未驗證）
2. Dogfood（真實 Pi session，不只 unit test）
3. 修正到文件完全對齊事實才 commit
4. CHANGELOG + README + DESIGN.md 每次 commit 前檢查


## onnxruntime exit crash (macOS arm64)

**症狀**: Pi 結束時 `libc++abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed: Invalid argument`

**原因**: [microsoft/onnxruntime#25038](https://github.com/microsoft/onnxruntime/issues/25038) — OrtEnv destructor 在 exit() 時 lock 已失效的 thread pool mutex。macOS arm64 + onnxruntime 1.22.0。

**影響**: 純 cosmetic。Session 和 KB 資料已在 crash 前存檔完成。

**緩解**: idle timer 從 60s 降到 10s。如果 exit 時 model 已被 idle dispose，crash 不發生。

**根本修復**: 等 Microsoft 修正 → 升級 onnxruntime。無法從 JS 端解決。
