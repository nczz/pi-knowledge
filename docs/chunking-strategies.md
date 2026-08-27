# Chunking 策略規格

---

## 1. 策略優先級

| 優先 | 策略 | 適用 | Chunk 大小 |
|------|------|------|-----------|
| 1 | Recursive AST-based | TS/JS/Python/Go/Rust/Java/Bash/C | declaration-first; bounded fallback at ~6,000 chars |
| 2 | Markdown-aware | .md files | heading 為單位 |
| 3 | Semantic boundary | 其他文字檔 | 300-1000 tokens |
| 4 | Fixed-size | 未知格式 fallback | 512 tokens, 64 overlap |

---

## 2. Token 估算

不載入 model 就估算，用 chars/token ratio:

```typescript
// XLM-RoBERTa tokenizer 平均:
// 英文: ~4 chars/token, 中文: ~1.5 chars/token, 程式碼: ~3.5 chars/token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3); // 混合內容取 ~3
}
```

精確 tokenization 在 embedding 時由 @huggingface/transformers 處理。

---

## 3. 檔案掃描

### .gitignore + 內建排除

```typescript
// 使用 'ignore' package (Pi 生態已用)
const ig = ignore();
ig.add(readFileSync('.gitignore', 'utf-8'));
ig.add([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '*.min.js',
  'docs/*knowledge-base*report*.md',
  'docs/*evaluation-report*.md',
  'docs/*eval-report*.md',
]);
```

### Binary 偵測

```typescript
function isBinary(path: string): boolean {
  const binaryExts = new Set(['.png','.jpg','.gif','.zip','.gz','.pdf','.exe','.db','.bin']);
  if (binaryExts.has(extname(path).toLowerCase())) return true;
  const buf = readFileSync(path, { length: 512 });
  return buf.includes(0x00); // null byte = binary
}
```

### 大小限制: 預設 10 MB/file (可配)

---

## 4. Markdown-Aware

- 按 heading (##/###) 切分
- 保留 heading + content 為一個 chunk
- 跳過 <50 chars 的 section
- >2000 tokens 的 section 再按段落切分
- Frontmatter → 提取為 metadata，不索引 raw YAML

---

## 5. Semantic Boundary (通用文字)

- 按 `\n\n+` 分段落
- 累積到 ~1000 tokens 時 flush
- Overlap: 保留前一 chunk 最後一段 (2 sentences)
- 確保不在句子中間切斷

---

## 6. Fixed-Size (Fallback)

- 512 token chunks, 64 token overlap
- 用行為單位避免 mid-line cut

---

## 7. AST-Based

| 語言 | 切分單位 | Metadata |
|------|---------|----------|
| TS/JS | class, interface, type, function, exported arrow/function-valued variables, class field methods | `language`, `symbol`, `symbol_kind`, `scope`, `parent_symbol`, `signature`, `exported`, `ast_path`, `start_line`, `end_line` |
| Python | class, function, method | 同上，並保留 decorators |
| Go/Rust/Java | function/method/type/class/interface declarations supported by tree-sitter grammar | 同上 |
| Bash | function declarations in `name() {}` and `function name {}` forms | 同上；parse errors fall back to text chunking |
| GNU C | `.c` function definitions/prototypes, structs, unions, enums, typedefs, reliable preprocessor definitions | 同上，並保留 `static` storage metadata when present; `.h` remains text until the C/C++ header decision |

原則:

- 小型 class/type/function 以完整 declaration 為 chunk，保留可讀原始內容。
- 超過 token 上限的 parent declaration 會遞迴下降到 child declarations；例如大型 class 會拆成 method-level chunks。
- 相鄰且同 parent 的小 child declarations 可 pack 成 sibling group chunk，以減少碎片化。
- 沒有可用 child declaration 的巨大節點用行與固定字元上限切分，避免產生 MB 級 chunk。
- Chunk identity 包含 file path、file type、line range、metadata 和 content；不能只看 content。
- Symbol index 來自同一次 AST analysis；method symbols 可以獨立於 retrieval chunk 存在。

---

## 8. Code Pre-Tokenize (for FTS5)

```typescript
function preTokenizeCode(content: string): string {
  return content
    .replace(/([a-z])([A-Z])/g, '$1 $2')        // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // ACRONYM
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')         // item1
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');        // 3px
}
```

Edge cases (`XMLHTTPRequest`→不完美) 可接受，Phase 3 改善。
