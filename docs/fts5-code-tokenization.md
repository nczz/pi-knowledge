# FTS5 Code Tokenization 深入分析

---

## 1. unicode61 Tokenizer 對 CJK 的行為

連續 CJK 字元 (Unicode `Lo`) 被視為**一個 token**。`認證流程` → 一個 token。

**解法**: Pre-tokenize CJK 逐字空格分隔:
```typescript
content.replace(/([\u4e00-\u9fff\u3400-\u4dbf])/g, ' $1 ');
// "認證流程" → " 認 證 流 程 "
```

搜尋 `認證` → `認 AND 證` → 命中含這兩字的 chunk。不保語序但足夠。Vector search 補語意。

---

## 2. 程式碼 Pre-tokenize

```typescript
function preTokenizeForFTS(content: string): string {
  return content
    .replace(/([a-z])([A-Z])/g, '$1 $2')        // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // ACRONYM
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')         // letter+digit
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')         // digit+letter
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf])/g, ' $1 ') // CJK
    .replace(/\s+/g, ' ');
}
```

### Edge Cases

| Input | Output | OK? |
|-------|--------|-----|
| `getElementById` | `get Element By Id` | ✅ |
| `HTMLElement` | `HTML Element` | ✅ |
| `XMLHTTPRequest` | `XMLHTTP Request` | ⚠️ 可接受 |
| `iOS` | `i OS` | ⚠️ 低影響 |
| `snake_case` | 不處理 (unicode61 切 _) | ✅ |
| `認證流程` | `認 證 流 程` | ✅ |

---

## 3. 備案: Trigram

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, tokenize='trigram');
```

任何 3 字元子序列都是 token。不需分詞，CJK 自然支持。代價: index 大 3-5x。

Phase 1 先用 unicode61。Spike #3 若 precision <60% 則考慮切換。


---

## 附錄: 實作驗證發現

1. **CJK 單字元 term 必須保留** — filter 不能用 `length > 1`，必須 `> 0`。
2. **完整 escape 字元**: `[*"(){}[\]^~:+.#@!\\/<>|&$%]` — 含 `c++` 的 `+` 和 `node.js` 的 `.`。
3. **TEXT PK + content_rowid=rowid** — SQLite implicit rowid 正常工作。
4. **Multi-KB search** — BM25 必須傳 kbId 做 scope filter，否則和 per-KB vector search 混合 scope。
