# Search Pipeline 實作規格

---

## 1. 搜尋模式

| Mode | 管線 | 預期延遲 |
|------|------|---------|
| `fast` | BM25 only | <10ms |
| `semantic` | Vector only | <50ms |
| `hybrid` (default) | BM25 + Vector + RRF | <100ms |
| `deep` | Hybrid + Cross-encoder rerank | <500ms |

---

## 2. BM25 (via SQLite FTS5)

### FTS5 Table

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

### Scoring

FTS5 內建 `bm25()`: k1=1.2, b=0.75。分數是負值（越負越相關）:

```typescript
const normalizedScore = 1 / (1 + Math.abs(rawBm25Score));
```

### Query 預處理

```typescript
function prepareFtsQuery(query: string): string {
  let processed = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase split
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYM split
    .replace(/[*"(){}[\]^~:]/g, ' ');           // remove FTS5 special chars
  const terms = processed.split(/\s+/).filter(t => t.length > 0);
  return terms.join(' AND ');
}
```

---

## 3. Vector Search (Flat Cosine)

### Cosine on normalized vectors = dot product

```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function vectorSearch(queryVec: Float32Array, vectors: Float32Array[], topK: number) {
  const scores = vectors.map((v, i) => ({ index: i, score: cosineSimilarity(queryVec, v) }));
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK);
}
```

### 效能: 10K × 384d → ~5-10ms on M1。不需 HNSW。

### 向量儲存: binary file per KB

```
Format: [count: uint32] [dim: uint32] [vec0: float32[384]] [vec1: float32[384]] ...
Path: ~/.pi/knowledge/vectors/<kb-id>.bin
```

---

## 4. Reciprocal Rank Fusion (RRF)

### 公式 (Cormack et al. 2009)

```
RRF_score(doc) = Σ 1 / (k + rank_i(doc))    where k = 60
```

### 實作

```typescript
function reciprocalRankFusion(resultLists: Array<{ chunkId: string }[]>, k = 60) {
  const scores = new Map<string, number>();
  for (const list of resultLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank].chunkId;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .map(([chunkId, rrfScore]) => ({ chunkId, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}
```

### 為何 RRF: 不需 normalize 異質分數、零參數 tune、robust default。

---

## 5. Cross-Encoder Reranking (Phase 3)

只在 `mode: "deep"` 觸發。對 RRF top-20 做 pair-wise scoring:

```typescript
async function rerank(query: string, candidates: Chunk[], topK: number, pipeline: Pipeline) {
  const pairs = candidates.map(c => ({ text: query, text_pair: c.content }));
  const scores = await pipeline(pairs);
  return candidates
    .map((c, i) => ({ chunk: c, score: scores[i][0].score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
```

---

## 6. Metadata Filtering (Post-retrieval)

Filtering 在 retrieval 之後（不影響 RRF rank）:

```typescript
function applyFilters(results: SearchResult[], filters: SearchFilters): SearchResult[] {
  return results.filter(r => {
    if (filters.file_type && r.chunk.file_type !== filters.file_type) return false;
    if (filters.kb_name && r.kb_name !== filters.kb_name) return false;
    if (filters.path_pattern && !matchGlob(filters.path_pattern, r.chunk.file_path)) return false;
    return true;
  });
}
```

---

## 7. 完整流程

```
query → mode dispatch:
  fast:     BM25(top-50) → filter → paginate
  semantic: embed → vectorSearch(top-50) → filter → paginate
  hybrid:   BM25(top-50) + vectorSearch(top-50) → RRF → filter → paginate
  deep:     hybrid → top-20 → crossEncoderRerank → filter → return
```


---

## 附錄: 實作修正

### BM25 kbId scope

```typescript
export function searchBM25(db, query, limit = 50, kbId?: string): BM25Result[]
// kbId 傳入時: WHERE chunks_fts MATCH ? AND c.kb_id = ?
```

### FTS5 完整 escape

```typescript
q.replace(/[*"(){}[\]^~:+.#@!\\/<>|&$%]/g, " ");
```

已驗證: `c++`, `node.js`, `C#` 正常搜尋不報 syntax error。
