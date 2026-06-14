# Pi Extension 架構深入分析

日期: 2026-06-14
來源: 直接閱讀 earendil-works/pi 原始碼 (commit as of 2026-06-14)

---

## 1. Pi Monorepo 結構

```
earendil-works/pi/
├── packages/
│   ├── ai/              → @earendil-works/pi-ai (統一多 provider LLM API)
│   ├── agent/           → @earendil-works/pi-agent-core (agent loop + tool calling)
│   ├── coding-agent/    → @earendil-works/pi-coding-agent (互動 CLI + extension system)
│   └── tui/             → @earendil-works/pi-tui (terminal UI library)
├── scripts/             → release, publish, stats 工具
└── .pi/                 → 自用 extensions, prompts, skills
```

### 支援的 LLM Providers (pi-ai)

| Provider | API | 原始碼 |
|----------|-----|--------|
| OpenAI (Completions) | openai-completions | providers/openai-completions.ts (41KB) |
| OpenAI (Responses) | openai-responses | providers/openai-responses.ts |
| OpenAI Codex Responses | openai-codex-responses | providers/openai-codex-responses.ts (47KB) |
| Anthropic | anthropic | providers/anthropic.ts (38KB) |
| Google Gemini | google | providers/google.ts |
| Google Vertex AI | google-vertex | providers/google-vertex.ts |
| Amazon Bedrock | amazon-bedrock | providers/amazon-bedrock.ts (36KB) |
| Azure OpenAI | azure-openai-responses | providers/azure-openai-responses.ts |
| Mistral | mistral | providers/mistral.ts (20KB) |
| Cloudflare | cloudflare | providers/cloudflare.ts |
| Faux (test mock) | faux | providers/faux.ts |

---

## 2. Extension 載入機制 (loader.ts)

原始碼: `packages/coding-agent/src/core/extensions/loader.ts`

### jiti 設定

```typescript
async function loadExtensionModule(extensionPath: string) {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    ...(isBunBinary 
      ? { virtualModules: VIRTUAL_MODULES, tryNative: false } 
      : { alias: getAliases() }),
  });
  const module = await jiti.import(extensionPath, { default: true });
}
```

### Bun binary vs Node 開發模式

| 模式 | 設定 | 行為 |
|------|------|------|
| Bun binary | `virtualModules + tryNative:false` | Pi packages 從記憶體提供；jiti 自行 transform .ts |
| Node/dev | `alias` | Pi packages 對應到 workspace dist/ 路徑 |

### virtualModules 預打包

Bun binary 中已 bundle 的 packages（extension import 時從記憶體提供）：
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`  
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai` + `/oauth`
- `typebox` + `/compile` + `/value`

### tryNative:false 真實含義

**不**阻止 native addon loading。只是讓 jiti 不嘗試 Node native ESM import 來載入 .ts 檔案。

對於非 virtualModules 的 npm packages，jiti fall through 到標準 module resolution → 找到 extension 的 node_modules/ → require .js → dlopen .node。

### isBunBinary 偵測

```typescript
export const isBunBinary = import.meta.url.includes("$bunfs") 
  || import.meta.url.includes("~BUN") 
  || import.meta.url.includes("%7EBUN");
```

---

## 3. Package Manager (pi install)

原始碼: `packages/coding-agent/src/core/package-manager.ts`

### 安裝路徑

```typescript
private getNpmInstallRoot(scope, temporary) {
  if (temporary) return this.getTemporaryDir("npm");
  if (scope === "project") return join(this.cwd, ".pi", "npm");
  return join(this.agentDir, "npm");  // ~/.pi/agent/npm/
}
```

### Install Args — 不含 --ignore-scripts

```typescript
// npm:
["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"]
// bun:
["install", ...specs, "--cwd", installRoot, "--omit=peer"]
// pnpm:
["install", ...specs, "--prefix", installRoot, "--config.auto-install-peers=false", ...]
```

**關鍵: 沒有 `--ignore-scripts`。** Native deps 的 postinstall 會正常執行。

### 完整安裝流程

```
pi install npm:pi-knowledge
  → npm install pi-knowledge --prefix ~/.pi/agent/npm/ --legacy-peer-deps
  → flat hoisted node_modules:
    ~/.pi/agent/npm/node_modules/
      pi-knowledge/index.ts
      better-sqlite3/          (hoisted)
      @huggingface/transformers/ (hoisted)
      onnxruntime-node/        (transitive, hoisted)
```

---

## 4. Extension API

原始碼: `packages/coding-agent/src/core/extensions/types.ts` (55KB)

### ExtensionFactory

```typescript
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

### ToolDefinition

```typescript
interface ToolDefinition<TParams extends TSchema> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;      // "Available tools" 一行簡述
  promptGuidelines?: string[]; // "Guidelines" 額外條目
  parameters: TParams;         // TypeBox schema
  executionMode?: "sequential" | "parallel";
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>;
  renderCall?(args, theme, context): Component;
  renderResult?(result, options, theme, context): Component;
  prepareArguments?(args): Static<TParams>;
}
```

### Lifecycle Events

| Event | 用途 | pi-knowledge 使用 |
|-------|------|------------------|
| `session_start` | 初始化 | ✅ warm up index, check staleness |
| `session_shutdown` | Cleanup | ✅ flush writes, dispose model, stop watcher |
| `before_agent_start` | 修改 system prompt | ✅ inject KB metadata |
| `context` | 修改 messages | ✅ auto-inject search results (opt-in) |
| `tool_call` | 攔截 | ❌ 不需要 |
| `input` | 攔截輸入 | ❌ 不需要 |

### ExtensionContext

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  cwd: string;
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model | undefined;
  isIdle(): boolean;
  signal: AbortSignal | undefined;
  abort(): void;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?): void;
  getSystemPrompt(): string;
}
```

---

## 5. Native Addon 先例

Pi 自身載入 native addon:

```typescript
// clipboard-native.ts
const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")));

export function loadClipboardNative() {
  for (const requireClipboard of [moduleRequire, executableDirRequire]) {
    try { return requireClipboard("@mariozechner/clipboard"); } catch {}
  }
  return null;
}
```

---

## 6. 對 pi-knowledge 的設計啟示

1. **入口**: default export ExtensionFactory，async 可做初始化
2. **Tool 註冊**: registerTool + TypeBox schema，自帶 promptSnippet/Guidelines
3. **State**: 用 filesystem (SQLite + vectors)，不用 appendEntry（太大）
4. **Lifecycle**: session_start 初始化 → before_agent_start 注入 metadata → session_shutdown cleanup
5. **進度**: onUpdate callback in execute() + ctx.ui.notify
6. **Background work**: session_start 中 fire-and-forget 的 staleness check
7. **Model dispose**: session_shutdown 確保釋放
8. **RPC 相容**: 標準 execute() 在所有 mode 都能工作
