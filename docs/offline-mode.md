# 離線模式部署

---

## 1. 預下載 Model

```bash
# 有網路時觸發一次 knowledge_add → model 自動下載到 ~/.pi/knowledge/models/
# 或手動從 https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx 下載
```

---

## 2. 配置

```bash
export PI_KNOWLEDGE_OFFLINE=true
# Optional: point at a pre-populated model cache
export PI_KNOWLEDGE_MODEL_CACHE_DIR=/path/to/models
```

Extension 行為:
```typescript
import { env } from '@huggingface/transformers';
env.cacheDir = process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR ?? '<knowledge-dir>/models';
env.allowRemoteModels = false;
env.localModelPath = env.cacheDir;
```

---

## 3. Proxy 支援

@huggingface/transformers 用 Node `fetch()`，支持:
```bash
export HTTPS_PROXY=http://proxy.corp.com:8080
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
```

---

## 4. Air-Gapped 部署

```bash
# Build machine (有網路): 觸發下載，打包 ~/.pi/knowledge/models/
# Target machine: 解壓到同路徑，或設定 PI_KNOWLEDGE_MODEL_CACHE_DIR 指向解壓後路徑
export PI_KNOWLEDGE_OFFLINE=true
```

---

## 5. 行為差異

| 功能 | Online | Offline (model cached) | Offline (no cache) |
|------|--------|----------------------|-------------------|
| knowledge_add | ✅ | ✅ | ❌ error |
| knowledge_search | ✅ | ✅ | ❌ error |
| Model update | auto-check | skip | skip |
