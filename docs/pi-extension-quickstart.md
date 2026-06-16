# Pi Extension 開發 Quickstart

從零到 npm publish 的完整參考。基於 pi-knowledge 的實戰經驗。

---

## 1. 最小可用 Extension

### package.json

```json
{
  "name": "pi-my-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": { "extensions": ["./index.ts"] },
  "files": ["index.ts", "src/", ".pi/", "README.md", "LICENSE"],
  "keywords": ["pi", "pi-extension"],
  "dependencies": {},
  "devDependencies": { "@types/node": "22.19.19" },
  "engines": { "node": ">=22.0.0" },
  "license": "MIT"
}
```

### index.ts

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Lifecycle
  pi.on("session_start", async (_event, ctx) => {
    // 初始化 (ctx.cwd = 當前工作目錄)
  });

  pi.on("session_shutdown", async () => {
    // 清理資源
  });

  // Tool
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does (LLM reads this)",
    promptSnippet: "One-line for 'Available tools' section",
    promptGuidelines: ["When to use my_tool: ..."],
    parameters: Type.Object({
      input: Type.String({ description: "What to process" }),
    }),
    async execute(_id, params, signal, onUpdate) {
      if (signal?.aborted) throw new Error("Cancelled");
      onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
      return { content: [{ type: "text", text: `Result: ${params.input}` }] };
    },
  });
}
```

> pi-knowledge 的根 `index.ts` 目前避免 runtime import `typebox` / `@earendil-works/pi-tui`，以便裸 Node strip-only import 也能驗證 startup。新 extension 若依賴 Pi virtual modules，請至少同時用 `pi -e ./index.ts` 和裸 Node import 檢查載入行為。

### 測試

```bash
npm install
node --experimental-strip-types -e "import('./index.ts')"  # startup dependency smoke test
pi -e ./index.ts            # 直接載入測試
pi -e ./index.ts -p "use my_tool with input hello"  # one-shot 測試
```

---

## 2. Pattern Cheatsheet

### Lifecycle Hooks

```typescript
// 可用 hooks (按執行順序):
pi.on("session_start", async (event, ctx) => {});      // 初始化
pi.on("before_agent_start", (event) => {});            // 修改 system prompt
pi.on("context", async (event) => {});                 // 修改 LLM messages
pi.on("session_shutdown", async () => {});             // 清理
```

### System Prompt 注入

```typescript
pi.on("before_agent_start", (event) => {
  event.systemPromptOptions.promptGuidelines?.push("Your custom instruction here");
});
```

### Tool 完整模板

```typescript
pi.registerTool({
  name: "tool_name",          // LLM 呼叫的 tool name
  label: "Display Name",      // UI 顯示名稱
  description: "...",         // LLM 讀的描述（決定何時呼叫）
  promptSnippet: "...",       // system prompt "Available tools" 一行描述
  promptGuidelines: ["..."],  // system prompt "Guidelines" 條目
  parameters: Type.Object({
    required_param: Type.String({ description: "..." }),
    optional_param: Type.Optional(Type.Number({ description: "..." })),
    enum_param: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")])),
  }),

  // TUI 顯示 (可選)
  renderCall(args, theme) {
    return new Text(theme.fg("accent", `Tool: ${args.required_param}`), 0, 0);
  },
  renderResult(result, options, theme) {
    const text = result.content?.[0]?.text ?? "";
    return new Text(options.expanded ? text : text.slice(0, 200), 0, 0);
  },

  // 執行
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 1. 檢查取消
    if (signal?.aborted) throw new Error("Cancelled");

    // 2. 回報進度
    onUpdate?.({ content: [{ type: "text", text: "Step 1..." }] });

    // 3. 做事
    const result = await doWork(params, signal);

    // 4. 回傳
    return {
      content: [{ type: "text", text: `Done: ${result}` }],
      // details: { ... },  // 給 renderResult 用的額外資料
    };
  },
});
```

### AbortSignal 傳遞

```typescript
// Tool execute 的 signal 必須傳遞到所有 async 操作:
async execute(_id, params, signal) {
  const data = await fetch(url, { signal });           // fetch 支援
  for (const item of items) {
    if (signal?.aborted) throw new Error("Cancelled"); // loop 中檢查
    await process(item);
  }
}
```

### Auto-Injection (context hook)

```typescript
pi.on("context", async (event) => {
  // 在 LLM 呼叫前注入額外 context
  const lastUser = [...event.messages].reverse().find(m => m.role === "user");
  if (!lastUser) return;
  // 搜尋相關資訊...
  const messages = event.messages as Array<{ role: string; content: string }>;
  messages.unshift({ role: "user", content: "[Context]\n..." });
});
```

### Pi Skill (.pi/skills/my-skill.md)

```markdown
---
name: my-skill
description: What this skill does
---

# Skill Title

Do this for: $ARGUMENTS

## Steps
1. Use my_tool with ...
2. Present results...
```

### Native Dependencies

```
✅ 可用: better-sqlite3, tree-sitter, onnxruntime-node
✅ Pi 的 `pi install` 會跑 postinstall (native prebuilt 正常下載)
✅ jiti 載入 extension 後，native require() 正常解析 node_modules/

注意: tree-sitter 版本必須配對:
  core 0.22.x + grammars 0.23.x ✅
  core 0.25.x gyp build failure ❌
```

### Runtime imports and virtual modules

Pi binary 會提供 virtual modules：

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox`

但這些不會自動出現在一般 Node / CI module resolution 中。商用品質要求：

- 根 `index.ts` 應能被 `node --experimental-strip-types -e "import('./index.ts')"` 載入，除非文件明確說明只能在 Pi runtime 載入。
- Runtime import Pi virtual modules 時，要用 `pi -e ./index.ts` dogfood 驗證。
- Type-only imports from Pi packages are acceptable when they are erased by Node strip-only TypeScript.
- Heavy/optional dependencies 可用 dynamic import 延遲載入，但要在 AGENTS.md 記錄為例外。

### Memory 管理 (Lazy Load + Safe Shutdown)

一般 JS/檔案/DB 資源可以 idle dispose；native ML runtime 不能直接套用這個範例。`@huggingface/transformers` / `onnxruntime-node` 在 macOS arm64 已驗證 `/quit` 可能造成 `mutex lock failed` abort。local model 應在隔離 worker process 中執行，Pi TUI 主程序不要直接 import native ONNX backend。

```typescript
let resource: any = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function getResource() {
  if (resource) return resource;
  resource = await loadExpensiveThing();
  return resource;
}

function resetTimer() {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => dispose(), 30_000); // 30s idle
}

async function dispose() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (resource) { await resource.close(); resource = null; }
}

// 在 tool execute 中:
async execute() {
  const r = await getResource();
  resetTimer();
  return r.doWork();
}

// 在 session_shutdown 中:
pi.on("session_shutdown", async () => {
  await dispose();
});
```

對 ONNX/native model：

```typescript
// Prefer a model worker. Do not import onnxruntime-node in Pi's TUI process.
const model = await requestModelWorker({ task, modelId, input });

pi.on("session_shutdown", async () => {
  clearIdleTimer();
  await waitForNoActiveRuns();
  shutdownModelWorkerWithSigkill();
  closeDatabaseAndWatchers();
});
```

---

## 3. 發佈流程

### 開發測試

```bash
pi -e ./index.ts              # 載入測試
pi install ./                  # 模擬 npm install (全域安裝)
pi remove ./my-extension       # 移除本地安裝
```

### npm 發佈

```bash
# 1. 確認 package.json
#    - "pi": { "extensions": ["./index.ts"] }
#    - "files": [...] 排除 test/docs/spike
#    - version 正確

# 2. Dry run
npm pack --dry-run             # 確認只包含 production 檔案

# 3. Login + Publish
npm login
npm publish                    # 需要 OTP

# 4. 驗證
npm view my-extension version
pi install npm:my-extension    # 使用者安裝方式
```

### 版本管理

```bash
npm version patch              # bug fix: 0.1.0 → 0.1.1
npm version minor              # new feature: 0.1.x → 0.2.0
git tag v0.2.0
git push && git push origin v0.2.0
gh release create v0.2.0 --title "v0.2.0 — Title" --notes "..."
npm publish
```

---

## 4. 品質 Checklist

每次 commit 前確認:

- [ ] `npm test` 通過
- [ ] `npm run check` 通過（包含 Biome config 本身）
- [ ] `node --experimental-strip-types -e "import('./index.ts')"` 通過
- [ ] `npm pack --dry-run` package contents 正確
- [ ] `pi -e ./index.ts -p "use my_tool"` dogfood 通過
- [ ] `npm run test:e2e` smoke 通過，且明確記錄 skipped cases
- [ ] 帶外部 `PI_KNOWLEDGE_E2E_PDF` / `PI_KNOWLEDGE_E2E_DOCX` 的 release-grade e2e 通過（若 extension 支援 PDF/DOCX）
- [ ] README 描述和實作對齊（不 overclaim）
- [ ] CHANGELOG 更新
- [ ] 新 tool 有 promptSnippet + promptGuidelines
- [ ] 長操作支援 AbortSignal
- [ ] onUpdate 回報進度
- [ ] 資源有 dispose (session_shutdown)
- [ ] 新 source type 覆蓋 add + update + status/diagnostics
- [ ] import/export 保持跨機器 portable，不依賴本機 absolute source path

### Release flow

1. Bump `package.json` and `package-lock.json`.
2. Update `CHANGELOG.md` with the release date and user-visible changes.
3. Run the full quality checklist above.
4. Commit with the project convention.
5. Push `main`.
6. Create the GitHub release tag with release notes, preferably via `gh release create vX.Y.Z --notes-file ...`.
7. Run `npm publish`.
8. Report commit SHA, tag, npm version, and every gate result. If PDF/DOCX fixture env vars were missing, call the e2e result smoke-only.

---

## 5. 常見陷阱

| 陷阱 | 解法 |
|------|------|
| tool 沒有被 LLM 呼叫 | 確認 description 清楚描述「何時用」+ promptGuidelines 指引 |
| native dep 載入失敗 | 確認 tree-sitter 版本配對；確認 `pi install` 有跑 postinstall |
| TUI render crash | 不要提供未完整驗證的 custom renderer；先用 Pi 預設 renderer |
| Session state 遺失 | 用 filesystem 持久化，不要存在記憶體 |
| 多個 Pi session 衝突 | SQLite WAL mode + busy_timeout |
| Exit 時 native crash | onnxruntime macOS bug；不要在 idle timer 或 session_shutdown 主動 dispose ONNX pipeline |
| `process.env` 讀不到 | env var 在 extension load 時讀取（module scope），不是 tool execute 時 |

---

## 6. 專案結構參考

```
my-extension/
├── index.ts              ← Extension entry (ExtensionFactory default export)
├── package.json          ← "pi" field + "files" field
├── src/                  ← 實作模組
├── test/unit/            ← vitest 測試
├── .pi/skills/           ← Pi Skills (隨 extension 一起分發)
├── docs/                 ← 設計文件 (不包含在 npm package)
├── README.md
├── CHANGELOG.md
├── LICENSE
└── AGENTS.md             ← 開發規則 (給 AI agent 看)
```

---

## 7. 可用的 Pi API

### ExtensionAPI (pi)

| Method | 用途 |
|--------|------|
| `pi.on(event, handler)` | 訂閱 lifecycle events |
| `pi.registerTool(def)` | 註冊 LLM tool |
| `pi.registerCommand(name, opts)` | 註冊 /command |
| `pi.registerShortcut(key, opts)` | 註冊快捷鍵 |
| `pi.sendMessage(msg, opts)` | 注入 custom message |
| `pi.sendUserMessage(text, opts)` | 注入 user message |
| `pi.exec(cmd, args, opts)` | 執行外部命令 |
| `pi.getActiveTools()` | 取得當前啟用的 tools |
| `pi.events` | Extension 間 event bus |

### ExtensionContext (ctx)

| Field | 用途 |
|-------|------|
| `ctx.ui` | 使用者互動 (notify, select, confirm) |
| `ctx.cwd` | 當前工作目錄 |
| `ctx.mode` | "tui" / "rpc" / "print" |
| `ctx.model` | 當前 LLM model |
| `ctx.signal` | AbortSignal (agent running 時) |
| `ctx.sessionManager` | 唯讀 session state |
| `ctx.modelRegistry` | Model + API key 管理 |
| `ctx.isIdle()` | Agent 是否 idle |
| `ctx.shutdown()` | 關閉 Pi |

### 可 import 的 packages

| Package | 用途 |
|---------|------|
| `@earendil-works/pi-coding-agent` | Extension types |
| `@earendil-works/pi-tui` | TUI components (Text, etc.) |
| `@earendil-works/pi-ai` | AI utilities |
| `typebox` | Tool parameter schemas |
