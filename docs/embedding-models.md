# Embedding 模型選型完整資料

日期: 2026-06-14

---

## 1. 候選模型比較

| 模型 | 維度 | 大小 (ONNX) | 語言 | 授權 | zh-TW 品質 |
|------|------|-------------|------|------|-----------|
| all-MiniLM-L6-v2 | 384 | 22 MB | 英文為主 | MIT | 差 |
| **multilingual-e5-small** | 384 | 32 MB (quant) / 118 MB (full) | 100+ 語言 | MIT | 良好 |
| multilingual-e5-base | 768 | 278 MB | 100+ 語言 | MIT | 很好 |
| multilingual-e5-large | 1024 | 1.1 GB | 100+ 語言 | MIT | 最佳 |

### 決策: multilingual-e5-small (quantized)

理由:
1. 384d — 和 MiniLM 相同維度，index 大小不變
2. 100+ 語言含中文 — 使用者 zh-TW + 英文環境
3. 32 MB quantized — 可接受下載量
4. MIT — 商用無限制
5. ONNX 版: [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small)

---

## 2. 技術特性

**論文**: [Multilingual E5 Text Embeddings (arXiv 2402.05672)](https://arxiv.org/abs/2402.05672)

- Architecture: XLM-RoBERTa base
- Tokenizer: SentencePiece BPE
- 需要固定 prefix:
  - Query: `"query: {text}"`
  - Document: `"passage: {text}"`

---

## 3. Quantized 品質數據

來源: [elastic/multilingual-e5-small-optimized](https://huggingface.co/elastic/multilingual-e5-small-optimized)

### MIRACL (多語言 retrieval) NDCG@10

| 語言 | Full | Quantized | 差距 |
|------|------|-----------|------|
| DE | 0.7586 | 0.7599 | +0.2% |
| YO (低資源) | 0.5619 | 0.4893 | **-12.9%** |
| RU | 0.8031 | 0.7967 | -0.8% |
| AR | 0.8278 | 0.8202 | -0.9% |
| ES | 0.8167 | 0.8135 | -0.4% |
| TH | 0.8507 | 0.8432 | -0.9% |

**zh-TW 推斷**: 中文是高資源語言，預期損失 <2%。需 spike 確認。

---

## 4. @huggingface/transformers 整合

一站式解決 tokenizer + inference + model download:

```typescript
import { pipeline, env } from '@huggingface/transformers';

env.cacheDir = '~/.pi/knowledge/models/';

const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
  progress_callback: (progress) => { /* download progress */ }
});

const output = await extractor('query: 認證流程', { pooling: 'mean', normalize: true });
// → Float32Array[384]
```

### env 配置

| 設定 | 用途 |
|------|------|
| `env.cacheDir` | Model 快取目錄 |
| `env.allowRemoteModels` | 允許下載 (false=離線) |
| `env.localModelPath` | 離線 model 路徑 |
| `env.logLevel` | 日誌等級 |

### Backend

- Node/Bun → 自動用 onnxruntime-node (native, 快)
- 可強制 WASM → `env.backends.onnx.wasm.enabled = true` (慢 5x 但零 native dep)

---

## 5. 效能預估 (M1)

| 操作 | 預估 |
|------|------|
| 單次 embedding | ~10-15ms |
| Batch 32 chunks | ~200-400ms |
| 1000 chunks 全量 | ~15-30s |
| 記憶體 (model loaded) | ~200-300 MB |
| 記憶體 (unused) | ~5 MB |
| 記憶體 (after local model use) | Model remains resident until process exit by default |

---

## 6. Cross-Encoder Reranking (Phase 3)

| 模型 | 大小 | 來源 |
|------|------|------|
| ms-marco-MiniLM-L-4-v2 (推薦) | ~20 MB | Xenova/ms-marco-MiniLM-L-4-v2 |
| ms-marco-MiniLM-L-2-v2 (快) | ~10 MB | Xenova/ms-marco-MiniLM-L-2-v2 |
| ms-marco-MiniLM-L-12-v2 (品質) | ~60 MB | Xenova/ms-marco-MiniLM-L-12-v2 |

---

## 7. 備選方案

| 情境 | 方案 |
|------|------|
| Quantized 品質不足 | `PI_KNOWLEDGE_MODEL_QUALITY=full` (118 MB) |
| 零 native dep 需求 | Not currently supported by the Node bundle; local models run in an isolated worker |
| 明確啟用 native idle dispose | `PI_KNOWLEDGE_ENABLE_NATIVE_IDLE_DISPOSE=true` |

> Stability note: local models run in a worker process and are not idle-disposed by default. On macOS arm64, loading the native ONNX backend in the Pi TUI process can make Pi abort on `/quit` with `mutex lock failed`.
| 有 API key | `PI_KNOWLEDGE_EMBEDDING=openai:text-embedding-3-small` |

---

## 8. ONNX Runtime 平台支援

All Pi target platforms confirmed:
Windows x64/arm64, Linux x64/arm64, macOS x64/arm64 — 全部有 prebuilt binary。

來源: [onnxruntime.ai](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
