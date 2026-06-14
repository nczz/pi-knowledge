# 已知的技術陷阱與經驗

開發中遇到的問題，避免未來重複踩坑。

## tree-sitter 版本相容性

```
✅ 可用: tree-sitter@0.22.4 + grammars@0.23.x
❌ 失敗: tree-sitter@0.25.0 (gyp build error on macOS)
❌ 失敗: tree-sitter@0.21.1 + grammar@0.25.0 (nodeTypeNamesById undefined)
```

Grammar 版本必須和 core 配對。鎖定 0.22.x core + 0.23.x grammars。

## pdf-parse v2.x (deferred)

v2.4.5 完全重寫：`new PDFParse()` class-based API，內建完整 pdf.js bundle。不要直接裝就嘗試整合 — 需獨立研究。

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
