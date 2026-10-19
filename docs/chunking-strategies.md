# Chunking 策略規格

---

## 1. 分層策略

| 階段 | 策略 | 適用 | 目的 |
|------|------|------|------|
| 1 | Recursive AST-based | TS/JS/Python/Go/Rust/Java/Bash/C/C++/QML | 優先保留 declaration、parent/child 與 sibling 結構 |
| 1 | Markdown-aware | `.md` | 優先保留 heading、breadcrumb 與段落 |
| 1 | Paragraph-aware text | 其他文字 | 以段落組合候選 chunk |
| 2 | Embedding-safe finalizer | 所有來源與 import | 依實際 provider budget 細分超限候選 |

第一階段只決定較好的語意邊界。第二階段才是 embedding 安全保證；它會計算加入 file path、file type、heading、symbol、signature 與 `passage: ` prefix 後的完整輸入。

---

## 2. Token 預估與硬上限

初步 chunker 使用 `Math.ceil(text.length / 3)` 控制一般候選大小。這只是減少 tokenizer 工作量的 heuristic，不能當成 multilingual token 上限。

本地 `multilingual-e5-small` 的 finalizer 透過既有 model worker 內、embedding pipeline 自己的 tokenizer 批次計數：

- tokenizer hard limit：512 tokens。
- preferred split target：hard limit 的 87.5%，目前為 448 tokens。
- 完整輸入為 ASCII 且字元數加特殊 tokens 仍低於 448 時，可用保守上界直接接受；其他內容才進 tokenizer，降低一般 code/docs 的 IPC 與重複 tokenization 成本。
- 計數包含 contextual prefix 與 E5 `passage: ` prefix。
- 超限內容依空行、換行、句子標點、空白、Unicode code point 的順序細分。
- provider 在 embedding 前再次驗證；不得靜默 truncation。

OpenAI-compatible provider 無法假設遠端 tokenizer，因此沿用 `PI_KNOWLEDGE_EMBEDDING_MAX_CHARS` 的完整輸入字元上限。超限 chunk 在送出 HTTP 前細分；直接呼叫 provider 的超限 query/document 會明確失敗。

finalizer 只處理超限候選。安全 chunk 保留原 content、metadata 與 identity，避免不必要的向量重建。

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

- 按 heading 與 section 切分。
- 保留 heading breadcrumb metadata。
- 跳過 `<50` chars 的 section。
- 一般段落先以約 450 個估算 tokens 組合。
- 巨大單段先做 bounded fallback，再由 embedding-safe finalizer 依實際 provider budget 驗證。

---

## 5. Paragraph-Aware Text

- 按 `\n\n+` 分段落。
- 一般內容累積到約 550 個估算 tokens 時 flush。
- 相鄰 chunks 不重疊，避免向量與儲存量無條件膨脹。
- 巨大單段允許先按字元 fallback；finalizer 仍會以實際完整 embedding input 驗證。

---

## 6. Embedding-Safe Fallback

- 只在 AST/Markdown/Text 候選超過 provider hard limit 時啟用。
- 優先沿既有結構邊界切分，不以固定 overlap 複製內容。
- 程式碼子 chunk 保留 symbol/scope/signature metadata 與可追溯 line range。
- 分割後重算 chunk identity、FTS text、`chunk_part` 與 `chunk_part_count`。
- add、update、URL、inline text 與 JSONL import 使用同一條 finalization 路徑。
- 單一固定 context 已超過 provider limit 且無法再安全切分時，索引明確失敗，不產生截尾向量。

---

## 7. AST-Based

| 語言 | 切分單位 | Metadata |
|------|---------|----------|
| TS/JS | class, interface, type, function, exported arrow/function-valued variables, class field methods | `language`, `symbol`, `symbol_kind`, `scope`, `parent_symbol`, `signature`, `exported`, `ast_path`, `start_line`, `end_line` |
| Python | class, function, method | 同上，並保留 decorators |
| Go/Rust/Java | function/method/type/class/interface declarations supported by tree-sitter grammar | 同上 |
| Bash | function declarations in `name() {}` and `function name {}` forms | 同上；parse errors fall back to text chunking |
| GNU C | `.c` function definitions/prototypes, structs, unions, enums, typedefs, reliable preprocessor definitions | 同上，並保留 `static` storage metadata when present; `.h` remains text by default |
| C++ | `.cpp`/`.cc`/`.cxx` source and `.hpp`/`.hh`/`.hxx` headers: namespaces, classes, methods, constructors/destructors, enums, templates where tree-sitter parses cleanly | 同上，並保留 explicit access visibility; Qt macro parse errors fall back to text chunking |
| QML | `.qml` imports, component/object definitions, properties, signals, handlers, ids, bindings, and embedded JavaScript functions | 同上；object hierarchy is preserved in `scope` / `parent_symbol`, parse errors fall back to text chunking |

原則:

- 小型 class/type/function 以完整 declaration 為 chunk，保留可讀原始內容。
- 超過 token 上限的 parent declaration 會遞迴下降到 child declarations；例如大型 class 會拆成 method-level chunks。
- 相鄰且同 parent 的小 child declarations 可 pack 成 sibling group chunk，以減少碎片化。
- 沒有可用 child declaration 的巨大節點用行與固定字元上限切分，避免產生 MB 級 chunk。
- Chunk identity 包含 file path、file type、line range、metadata 和 content；不能只看 content。
- Symbol index 來自同一次 AST analysis；method symbols 可以獨立於 retrieval chunk 存在。

---

## 8. 索引版本與既有 KB

新索引會在既有 `source_options` JSON 寫入 `embedding_input_policy: 2`，不增加資料庫欄位。`knowledge_doctor` 發現舊 KB 沒有目前版本時會回報 `reindex_for_embedding_budget`：

- file/directory/URL：執行 `knowledge_update`。
- inline text/import：由原始來源重新 add 或 import。

診斷只讀取版本標記，不啟動模型，也不掃描所有 chunk。舊 KB 不會在啟動或搜尋時被強制重建。

---

## 9. Code Pre-Tokenize (for FTS5)

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
