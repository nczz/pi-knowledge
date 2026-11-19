# 離線模式部署

---

## 1. 預下載 Model

```bash
# 有網路時在 selected profile觸發一次 knowledge_add，模型會下載到 <profile-storage>/models/
# 或設定 PI_KNOWLEDGE_MODEL_CACHE_DIR後，從可信來源預先填入該目錄
```

---

## 2. 配置

```bash
export PI_KNOWLEDGE_OFFLINE=true
# Optional: point at a pre-populated model cache
export PI_KNOWLEDGE_MODEL_CACHE_DIR=/path/to/models
```

Model worker行為:
```typescript
import { env } from '@huggingface/transformers';
env.cacheDir = process.env.PI_KNOWLEDGE_MODEL_CACHE_DIR ?? '<profile-storage>/models';
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
# Build machine (有網路): 觸發下載，打包 selected profile的 models/或自訂 cache
# Target machine: 解壓到 owner-only目錄並設定 PI_KNOWLEDGE_MODEL_CACHE_DIR
export PI_KNOWLEDGE_OFFLINE=true
```

---

## 5. 行為差異

| 功能 | Online | Offline (model cached) | Offline (no cache) |
|------|--------|----------------------|-------------------|
| knowledge_add | ✅ | ✅ | ❌ error |
| knowledge_search | ✅ | ✅ | ❌ error |
| Model update | auto-check | skip | skip |
