# Spike: Native Dep 驗證

驗證 better-sqlite3 + @huggingface/transformers 在 Pi extension 中能正常載入。

## 執行

```bash
cd spike/
npm install
pi -e ./index.ts
# 對 Pi 說: "Run the spike test"
```

## 成功標準

- `spike_sqlite`: Database open + CREATE TABLE + INSERT + SELECT 正常
- `spike_embedding`: pipeline load + embed 回傳 Float32Array[384]
- `spike_fts5`: FTS5 virtual table + MATCH query 回傳結果

## 失敗 Plan B

- SQLite 失敗 → sql.js (WASM) 或 bun:sqlite
- ONNX 失敗 → env.backends.onnx.wasm = true (WASM backend)
