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

### Install Args 與 dependency scripts

Pi 的歷史 install args沒有 `--ignore-scripts`：

```typescript
// npm:
[\"install\", ...specs, \"--prefix\", installRoot, \"--legacy-peer-deps\"]
// bun/pnpm use their corresponding install forms
```

這不再等於「所有 native postinstall 一定執行」。npm 12 預設阻擋未由 root project `allowScripts` 或 install-time `--allow-scripts`核准的 dependency scripts。`pi-knowledge` repository 的 version-pinned `allowScripts`保護本地 checkout；global/host-managed install仍須依實際 package manager檢查 skipped-script output。外部 MCP global install的 reviewed allow-list在 `docs/mcp-clients.md`。
### 完整安裝流程

```
pi install npm:pi-knowledge
  → npm install pi-knowledge --prefix ~/.pi/agent/npm/ --legacy-peer-deps
  → flat hoisted node_modules:
    ~/.pi/agent/npm/node_modules/
      pi-knowledge/extension.js  (loads dist/index.js; source fallback for local development)
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
| `session_start` | 初始化 | ✅ ensure selected profile daemon；必要時 monotonic enable watcher |
| `session_shutdown` | Cleanup | ✅ 釋放 extension client/session state；不停止 daemon、不關 DB/watcher/model worker |
| `before_agent_start` | 修改 system prompt | ✅ 從 daemon 注入 KB metadata |
| `context` | 修改 messages | ✅ 透過 daemon auto-inject search results (opt-in) |
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

1. **入口**: default export ExtensionFactory；root `index.ts`保持 startup-light
2. **Tool 註冊**: registerTool + TypeBox schema；同一份 public tool definitions也供 MCP使用
3. **State ownership**: production extension只持有 daemon client；SQLite、vectors、watchers、model/document worker與 `coverage.json`都由 selected profile daemon擁有
4. **Lifecycle**: session_start ensure daemon → before_agent_start/context讀取狀態 → session_shutdown只釋放 client state
5. **進度/取消**: onUpdate與 AbortSignal跨 authenticated daemon RPC轉送
6. **Background work**: watcher與 indexing job state在 daemon，不掛在單一 Pi session
7. **Model lifecycle**: local models只在 daemon擁有的隔離 worker載入；Pi TUI與 MCP adapter都不 import `onnxruntime-node`
8. **RPC/MCP 相容**: Pi/OMP execute contract、stdio MCP與 loopback Streamable HTTP共用 tool schema和 daemon operation
