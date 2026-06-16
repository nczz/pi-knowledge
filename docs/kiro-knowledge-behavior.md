# kiro-cli Knowledge Tool — 完整行為記錄

日期: 2026-06-14
來源: 直接使用經驗（本 agent 日常使用 kiro-cli knowledge tool）

---

## 1. 命令與參數

### knowledge add

```
knowledge add {
  command: "add",
  name: string,             // 知識庫顯示名稱（必填）
  value: string,            // 文字內容 或 檔案/目錄路徑
  context_id?: string,      // 指定已存在 KB 的 ID 做更新
}
```

行為:
- 如果 value 是有效的檔案/目錄路徑 → 索引該路徑
- 否則視為 inline text → 索引文字內容
- 索引完成回傳 context_id
- 支援 Code, Markdown, Text, PDF, CSV 等格式
- 目錄索引會遞迴掃描

### knowledge search

```
knowledge search {
  command: "search",
  query: string,            // 搜尋查詢（必填）
  context_id?: string,      // 限定在特定 KB 搜尋
  limit?: number,           // 結果數量（default 5）
  offset?: number,          // 分頁 offset
  snippet_length?: number,  // 每筆結果文字截斷長度
  sort_by?: "relevance" | "path" | "name",
  file_type?: string,       // 篩選 "Code" | "Markdown" | "Text"
}
```

回傳格式:
```json
{
  "results": [
    {
      "content": "chunk 完整文字",
      "file_path": "相對路徑",
      "file_type": "Code",
      "score": 0.87,
      "snippet": "截斷顯示文字..."
    }
  ],
  "page_info": {
    "total_count": 142,
    "has_next_page": true,
    "after_cursor": "opaque_cursor_string"
  }
}
```

### knowledge remove

```
knowledge remove {
  command: "remove",
  name?: string,        // 用名稱刪除
  context_id?: string,  // 用 ID 刪除
  path?: string,        // 用來源路徑刪除
}
```

### knowledge update

```
knowledge update {
  command: "update",
  path: string,             // 要重新索引的路徑
  name?: string,            // 目標 KB 名稱
  context_id?: string,      // 目標 KB ID
}
```

行為: **全量重新索引**（non-incremental）— 這是我們要改善的主要弱點

### knowledge show

```
knowledge show {
  command: "show"
}
```

回傳所有 KB 列表: name, context_id, file_count, 建立時間

### knowledge status

```
knowledge status {
  command: "status"
}
```

回傳背景操作狀態（indexing 中的 job）

### knowledge clear

```
knowledge clear {
  command: "clear"
}
```

刪除所有知識庫

### knowledge cancel

```
knowledge cancel {
  command: "cancel",
  operation_id?: string,  // 指定取消哪個操作（不填=全部取消）
}
```

---

## 2. 已知行為特性

### 搜尋
- 預設是 semantic search（MiniLLM 嵌入）
- 也支援 BM25 keyword search
- **但不做 hybrid fusion** — 是 semantic OR keyword，取決於查詢特性
- 沒有 reranking 層
- 結果按 score 降序排列

### 索引
- 全量索引 — update 時重新處理所有檔案
- 無 file watcher
- 無 incremental（改一個檔案也 re-index 全部）
- 背景執行（不阻塞 agent）
- 有 status/cancel 機制

### 嵌入
- Server-side MiniLLM（不在本地跑，需要 Kiro 雲端服務）
- 離線時無法使用
- 嵌入品質 OK 但對中文可能不是最佳

### 儲存
- 持久化跨 session
- 每個 KB 有唯一 context_id
- 支援按 context_id 分別搜尋或全局搜尋

### Progress
- `status` 命令可看到是否在 indexing
- 但無精細進度（%、files processed、ETA）

---

## 3. pi-knowledge 超越 kiro-cli 的方向

| kiro 行為 | pi-knowledge 改進 |
|-----------|------------------|
| 全量 re-index | Content-addressed incremental（SHA-256 diff，只 re-embed 變更） |
| Semantic OR keyword | Hybrid 預設（BM25 + vector + weighted score fusion） |
| 無 reranking | Optional cross-encoder rerank (mode: "deep") |
| 無 file watching | Optional fs.watch + debounce |
| Server-side embedding | Local ONNX（multilingual-e5-small，零 API key） |
| 單語言 MiniLLM | 多語言 multilingual-e5（100+ 語言含 zh-TW） |
| 粗略 progress | Real-time: files/chunks/embeddings + ETA |
| 無 code-aware chunking | AST-based（TS/JS/Python/Go）保留函數邊界 |
| 無 metadata filter | Filter by file_type, language, kb_name, path |
| 無 dedup | Content-addressed embedding cache |
| 無 diagnostics | Staleness, orphans, coverage %, drift warning |

---

## 4. 完全對齊的功能（必須做到）

以下是 UX 必須 1:1 對齊的核心操作:

- [x] `add` with path (file/directory)
- [x] `add` with inline text
- [x] `search` with query + limit + offset + pagination
- [x] `search` with context_id filter
- [x] `search` with snippet_length control
- [x] `remove` by name/id/path
- [x] `update` (re-index)
- [x] `show` (list all KBs)
- [x] `status` (background operation state)
- [x] `clear` (remove all)
- [x] `cancel` (abort background operation)
- [x] Cross-session persistence
- [x] Background indexing (non-blocking)
- [x] Multiple named KBs with unique IDs
