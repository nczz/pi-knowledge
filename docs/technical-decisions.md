# 技術決策紀錄 (ADR)

日期: 2026-06-14

---

## ADR-001: 使用 @huggingface/transformers 作為唯一 embedding 引擎

**狀態**: 已決定

**背景**: 需要在 Pi extension 中做本地向量嵌入。原始方案用 onnxruntime-node + tokenizers-node (2 native deps)。

**決策**: 改用 @huggingface/transformers (1 顯式 dep，內建 WASM tokenizer + onnxruntime-node transitive dep)。

**理由**:
- 解決 tokenizer（XLM-RoBERTa SentencePiece）
- 自帶 model download + cache + progress callback
- 自動偵測 Node/Bun 選對 backend
- 一行 `pipeline()` 完成一切
- 減少顯式 native dep 從 3 → 1

---

## ADR-002: Phase 1 用 pure-JS flat cosine search

**狀態**: 已決定

**背景**: 向量相似度搜尋選型。

**決策**: Phase 1 brute-force cosine。Phase 3 若 >10K vectors 再加 HNSW。

**理由**:
- 少一個 native dep
- 10K × 384d brute-force ~5-10ms on M1
- 大多數 KB 在 1K-5K chunks

**升級觸發**: 延遲 >50ms 或 vectors >30K

---

## ADR-003: Embedding cache key = SHA-256(content)

**狀態**: 已決定

**背景**: 增量索引需要 content-addressed cache。

**決策**:
- Embedding cache key: `SHA-256(content)` — 只看內容
- Chunk identity: `SHA-256(content + filePath + startLine)` — KB 內唯一

**理由**: 檔案開頭新增 code 時，後面 chunk position 變但 content 不變 → 不需 re-embed。

---

## ADR-004: 預設 multilingual-e5-small

**狀態**: 已決定

**背景**: zh-TW + 英文混合環境。

**決策**: 預設 multilingual-e5-small quantized (32 MB)。

**理由**: 同 384d、中文品質好、quantized 損失 <2% for 高資源語言。

---

## ADR-005: Lazy-load + idle-dispose 記憶體策略

**狀態**: 已決定

**行為**: 首次 add/search 載入 → 60s idle dispose → shutdown 強制 dispose。

**理由**: 大多數 session 不用 knowledge → 0 memory cost。

---

## ADR-006: 儲存 ~/.pi/knowledge/ (global) + .pi/knowledge/ (project)

**狀態**: 已決定

**理由**: 知識庫是獨立功能，不嵌套 agent/ 下。

---

## ADR-007: pi install 會跑 postinstall (confirmed from source)

**狀態**: 已確認

**證據**: `package-manager.ts` getNpmInstallArgs() 無 --ignore-scripts。

---

## ADR-008: FTS5 + camelCase pre-tokenize

**狀態**: 需 spike 驗證品質

**方案**: index 前 `replace(/([a-z])([A-Z])/g, '$1 $2')`。

**備案**: trigram tokenizer。
