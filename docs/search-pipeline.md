# Search Pipeline 實作規格

---

## 1. 搜尋模式

| Mode | 管線 | 預期延遲 |
|------|------|---------|
| `fast` | BM25 only | <10ms |
| `semantic` | Vector only | <50ms |
| `hybrid` (default) | BM25 + Vector + weighted score fusion + confidence gate + diversity | <100ms |
| `deep` | Hybrid + Cross-encoder rerank | <500ms |
| `adaptive` | Hybrid + query-time contextual window expansion | <150ms |

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

Semantic and hybrid search read this file with ranged vector reads and stream chunk IDs from SQLite in row order. The search path must keep only top-K candidate vectors for ranking/diversity, not the full vector file or a full chunk-id array.

---

## 4. Hybrid Weighted Score Fusion

Hybrid mode does not use Reciprocal Rank Fusion anymore. RRF was robust, but it compressed scores too aggressively for project-level knowledge bases: many chunks had near-identical final scores, making natural-language ranking difficult to diagnose and tune.

Current hybrid retrieval:

1. Run BM25 with strict AND terms and fallback OR terms.
2. Run vector search for semantic recall.
3. Normalize BM25 and vector scores independently.
4. Fuse with weighted score fusion.
5. Apply query-aware ranking boosts and penalties.
6. Drop low-confidence candidates that lack enough lexical evidence.

```
hybrid_score = normalized_bm25 * bm25_weight + normalized_vector * vector_weight
```

This keeps score spread meaningful while still combining exact lexical and semantic matches.

### Query-aware ranking

```typescript
function scoreChunkForQuery(baseScore: number, chunk: Chunk, queryTokens: Set<string>) {
  let score = baseScore;
  score += pathTokenBoost(chunk.file_path, queryTokens);
  score += sourceFileBoost(chunk, queryTokens);
  score += documentationBoost(chunk, queryTokens);
  if (isTestPath(chunk.file_path) && !queryAsksForTests(queryTokens)) score *= 0.48;
  if (!isTestPath(chunk.file_path) && queryAsksForTests(queryTokens)) score *= 0.88;
  return score;
}
```

Ranking diagnostics are returned with each search result so score behavior can be inspected without guessing.

Implementation-oriented queries also demote localization catalogs such as `locale/`, `lang/`, `i18n/`, and `translations/` unless the query explicitly asks for translation, language, locale, or i18n behavior. This prevents UI text catalogs from outranking source files that implement the behavior being searched.

### Confidence gate

Hybrid/adaptive search must not always return something. Candidates must pass a minimum adjusted score and enough lexical evidence, except when the query strongly names a source module path. This prevents garbage queries or one accidental token match from returning unrelated code.

---

## 5. Cross-Encoder Reranking

只在 `mode: "deep"` 觸發。對 hybrid top candidates 做 pair-wise scoring:

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

## 6. Adaptive Contextual Retrieval

Adaptive mode starts from hybrid seed chunks and expands context at query time. It does not blindly return every neighboring chunk:

- Keep the matched seed chunk.
- Prefer nearby chunks with stronger query coverage.
- Collapse overlapping context windows from the same file.
- Use lexical, line-proximity, vector-redundancy, and file-level diversity so repeated README or overview chunks do not dominate top results.

Index-time contextual retrieval is also used for embeddings and FTS: file path, file type, Markdown heading breadcrumbs, and code symbols are included in the searchable representation, while returned content stays as the original chunk text.

Existing KBs should be rebuilt or updated after search-quality changes that affect indexing text. Query-time ranking changes apply immediately to existing KBs.

## 7. Metadata Filtering (Post-retrieval)

Filtering 在 retrieval 之後:

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

## 8. 完整流程

```
query → mode dispatch:
  fast:     BM25(top-50) → filter → paginate
  semantic: embed → vectorSearch(top-50) → filter → paginate
  hybrid:   BM25(top-N) + vectorSearch(top-N) → weighted fusion → query-aware ranking → confidence gate → filter → diversify → paginate
  deep:     hybrid candidates → crossEncoderRerank → diversify → return
  adaptive: hybrid seeds → contextual window expansion → diversify → paginate
```

---

## 9. Research References and Implementation Mapping

This search pipeline is based on retrieval research and production RAG guidance, but it deliberately implements the parts that fit a local Pi extension without adding paid API dependencies or large serving infrastructure.

| Source | Relevant finding | pi-knowledge implementation |
|--------|------------------|-----------------------------|
| [Lewis et al. 2020, Retrieval-Augmented Generation](https://arxiv.org/abs/2005.11401) | Keep knowledge outside model weights and retrieve relevant passages at query time. | Persistent local KBs, chunk retrieval, source-bearing results, and no model retraining requirement. |
| [Karpukhin et al. 2020, Dense Passage Retrieval](https://arxiv.org/abs/2004.04906) | Dense vectors improve semantic passage retrieval beyond sparse lexical matching alone. | `semantic` mode and vector side of `hybrid` mode use local embeddings. |
| [Anthropic 2024, Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | Prepending chunk-specific context to embeddings and BM25 improves retrieval; combining contextual embeddings, contextual BM25, and reranking gives the largest gains. | Index-time searchable text prepends file path, file type, Markdown breadcrumbs, and code symbols to embeddings/FTS while returned content remains the original chunk. |
| [Cormack et al. 2009, Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) | RRF is a strong zero-training rank-fusion baseline. | Retained as a tested utility, but not the default hybrid scoring because project dogfood showed excessive score compression for this product's diagnostics. |
| [Goldstein and Carbonell 1998, MMR diversity reranking](https://aclanthology.org/X98-1025/) | Reranking can trade off relevance and novelty to reduce redundant top results. | Diversity reranking uses relevance plus lexical, same-file line proximity, adaptive-window overlap, and vector-redundancy signals. |
| [Khattab and Zaharia 2020, ColBERT](https://arxiv.org/abs/2004.12832) | Late interaction can improve retrieval quality while precomputing document representations. | Not implemented in this release: it would add larger model/index complexity. Current approach uses lighter local embeddings plus optional cross-encoder reranking. |

The current implementation intentionally does not generate LLM-written per-chunk context like Anthropic's full Contextual Retrieval recipe. Instead, it uses deterministic context available locally from the indexed artifact: path, type, heading, and symbol metadata. This keeps indexing private, repeatable, offline-capable, and suitable for commercial local development workflows.


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
