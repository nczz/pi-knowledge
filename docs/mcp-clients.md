# MCP Client Setup

`pi-knowledge-mcp` lets any MCP client use the same profile daemon and knowledge data as the Pi and OMP extensions. Pi and OMP integration is unchanged: their extension hooks, tool registration, prompt guidance, and optional auto-injection still run through `extension.js`. MCP is an additional client surface, not a replacement for those hooks.

## Choose a transport

| Transport | Use it when | Process model |
|-----------|-------------|---------------|
| stdio | One local agent should launch and own its MCP adapter | The MCP client starts `pi-knowledge-mcp`; the adapter exits with that client, while the profile daemon remains running |
| Streamable HTTP | Several local agents need one stable MCP endpoint | Start one `pi-knowledge-mcp --transport http` process; clients connect to its loopback URL |

Both transports connect to the selected profile daemon. The zero-configuration profile is `default`; most users should keep it. `--profile research` selects an advanced, isolated storage/runtime domain with its own database, vectors, watchers, daemon, and `coverage.json`. This process-level knowledge profile is separate from the `knowledge_search` tuning parameter also named `profile`.

## Install the command

Pi and OMP users can keep their existing package installation. For an external agent that needs `pi-knowledge-mcp` on `PATH`, install the npm package globally with Node 22 or newer:

```bash
npm install -g pi-knowledge
```

npm 12 blocks dependency install scripts unless they are explicitly approved. `pi-knowledge` uses native/runtime packages for SQLite, local embeddings, documents, and code parsers. Review the package and the skipped-script list, then install with the required package names allowed:

```bash
npm install -g \
  --allow-scripts=better-sqlite3,onnxruntime-node,protobufjs,sharp,tree-sitter,tree-sitter-bash,tree-sitter-c,tree-sitter-cpp,tree-sitter-go,tree-sitter-java,tree-sitter-javascript,tree-sitter-python,tree-sitter-qmljs,tree-sitter-rust,tree-sitter-typescript \
  pi-knowledge
```

For a repository checkout, `package.json` contains version-pinned `allowScripts` entries for the reviewed dependency versions, so `npm ci` can build them under npm 12. Re-review changed pins during dependency upgrades; do not replace the list with an unbounded approval.

Confirm the binaries and default profile daemon:

```bash
pi-knowledge-daemon status
pi-knowledge-mcp </dev/null
```

The second command should exit cleanly. It does not stop the daemon.

## Default read-only capabilities

The adapter exposes only `knowledge_search`, `knowledge_symbol_search`, and `knowledge_show` unless launch flags grant more authority.

| Flag | Additional authority |
|------|----------------------|
| `--allow-root <dir>` | Repeatable, current-user-owned local roots for plan/add/import/export paths |
| `--allow-network` | Public URL planning, add, and update; private-network and redirect protections still apply |
| `--allow-write` | Add, update, import, and export, subject to root/network authority |
| `--allow-admin` | Configure, live status/doctor, remove, and clear; destructive tools still require their explicit confirmation input |

Grant only what that MCP client needs. Host tool approval is not a substitute for these server-side capabilities. A typical project writer is:

```bash
pi-knowledge-mcp --allow-root "$PWD" --allow-write
```

## stdio configuration

Generic `mcpServers` configuration:

```json
{
  "mcpServers": {
    "piKnowledge": {
      "type": "stdio",
      "command": "pi-knowledge-mcp",
      "args": []
    }
  }
}
```

Add capability arguments explicitly, for example `"args": ["--allow-root", "/absolute/project", "--allow-write"]`. Use an absolute, trusted path. For a named knowledge profile, add `"--profile", "research"`.

### Claude Code

```bash
claude mcp add --transport stdio pi-knowledge -- pi-knowledge-mcp
claude mcp get pi-knowledge
```

Add server arguments after `pi-knowledge-mcp`. Use `--scope user` or `--scope project` according to Claude Code's configuration policy.

### Codex CLI, desktop, and IDE

Codex clients share `~/.codex/config.toml`:

```toml
[mcp_servers.pi_knowledge]
command = "pi-knowledge-mcp"
args = []
```

Equivalent CLI setup:

```bash
codex mcp add pi_knowledge -- pi-knowledge-mcp
codex mcp list
```

### Cursor

Put this in `~/.cursor/mcp.json` for global use or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "piKnowledge": {
      "type": "stdio",
      "command": "pi-knowledge-mcp",
      "args": []
    }
  }
}
```

### VS Code Copilot

Use **Chat: Open Customizations → MCP Servers → Add Server → Command (stdio)**, or add the generic stdio entry above to `~/.copilot/mcp-config.json` under `mcpServers`. Workspace-shared native configuration uses `.mcp.json` at the workspace root when that feature is enabled. New Copilot configurations should not use the deprecated `.vscode/mcp.json` Local-harness format.

### Kiro CLI and ACP

Add a user-level entry to `~/.kiro/settings/mcp.json`, or the same entry to `.kiro/settings/mcp.json` for one workspace:

```json
{
  "mcpServers": {
    "piKnowledge": {
      "command": "pi-knowledge-mcp",
      "args": []
    }
  }
}
```

Run `kiro-cli mcp list global` or start a chat with `--require-mcp-startup` to fail closed when the server cannot initialize. Kiro CLI V3 validates the modern MCP cache hints, so use a current `pi-knowledge` package rather than copying an older built adapter.

Kiro's ACP support is an upstream client-to-agent transport: an ACP editor launches `kiro-cli acp`, and Kiro remains the MCP client of `pi-knowledge-mcp`. `pi-knowledge` does not need a second ACP server. A Kiro custom agent can place the same entry in its `mcpServers` field; set `includeMcpJson: true` instead when that agent should inherit Kiro's user/workspace MCP files.

Kiro CLI 3.5 may terminate descendants of a stdio MCP process when a one-shot chat exits. If Kiro starts the profile daemon for the first time, that host cleanup can stop the otherwise detached daemon; indexed data remains safe and the next session starts it again. For a daemon that must remain warm across Kiro sessions, run `pi-knowledge-daemon start [--profile <name>]` before the chat, or use the persistent HTTP adapter. A daemon started independently was verified to survive Kiro's stdio teardown.

## Streamable HTTP configuration

HTTP mode is intentionally same-machine only. It accepts `127.0.0.1`, `::1`, or `localhost`; it does not provide TLS, OAuth, or a remote bind. A 32–512-character bearer token is mandatory.

Start one endpoint:

```bash
export PI_KNOWLEDGE_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
pi-knowledge-mcp --transport http --host 127.0.0.1 --port 3210 --endpoint /mcp
```

The endpoint is `http://127.0.0.1:3210/mcp`. Keep the token out of shell history, source control, chat, process arguments, and shared configuration. Supply it through the client's environment. The server rejects non-loopback binds, unauthenticated requests, mismatched protocol headers, and unapproved supplied origins. If a local MCP host sends `Origin`, add only its exact trusted origin, for example `--allow-origin http://127.0.0.1:3000`. This validates the header but does not enable browser CORS/preflight; use a native MCP client rather than direct browser JavaScript.

HTTP is useful when multiple local clients share one adapter and one capability set. If clients need different authority, start separate endpoints with different ports, tokens, and launch flags. They may still target the same profile daemon.

### Claude Code

```bash
claude mcp add --transport http pi-knowledge http://127.0.0.1:3210/mcp \
  --header "Authorization: Bearer $PI_KNOWLEDGE_MCP_HTTP_TOKEN"
claude mcp get pi-knowledge
```

Claude stores the expanded header in its MCP configuration. Protect that configuration as a credential, or use its dynamic-header facilities when token-at-rest policy requires them.

### Codex CLI, desktop, and IDE

Keep the token in the environment and reference its variable name:

```toml
[mcp_servers.pi_knowledge]
url = "http://127.0.0.1:3210/mcp"
bearer_token_env_var = "PI_KNOWLEDGE_MCP_HTTP_TOKEN"
```

Restart the Codex client after changing MCP configuration.

### Cursor

```json
{
  "mcpServers": {
    "piKnowledge": {
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer ${env:PI_KNOWLEDGE_MCP_HTTP_TOKEN}"
      }
    }
  }
}
```

Restart or reconnect the server from Cursor after changing the token or endpoint.

### VS Code Copilot

Use **Chat: Open Customizations → MCP Servers → Add Server → HTTP**, or use native portable configuration:

```json
{
  "mcpServers": {
    "piKnowledge": {
      "type": "http",
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer ${PI_KNOWLEDGE_MCP_HTTP_TOKEN}"
      },
      "tools": ["*"]
    }
  }
}
```

Place it in `~/.copilot/mcp-config.json`, or in workspace-root `.mcp.json` only if sharing the non-secret endpoint definition is intentional. Do not commit a literal token.

### Kiro CLI

Kiro accepts localhost HTTP MCP entries in `~/.kiro/settings/mcp.json` or a workspace MCP file:

```json
{
  "mcpServers": {
    "piKnowledge": {
      "url": "http://127.0.0.1:3210/mcp",
      "headers": {
        "Authorization": "Bearer ${PI_KNOWLEDGE_MCP_HTTP_TOKEN}"
      }
    }
  }
}
```

Kiro expands `${VARIABLE_NAME}` values at runtime. Keep the token in the environment, not as a literal in the JSON file.

## Lifecycle and upgrades

- An MCP adapter automatically ensures the selected profile daemon. Closing a stdio client or HTTP adapter does not stop that daemon.
- One authenticated daemon owns each canonical profile storage directory. Concurrent Pi, OMP, stdio, and HTTP clients share it safely.
- `pi-knowledge-daemon stop [--profile <name>]` is the explicit administrative stop. A later client starts it again.
- Package/build incompatibility uses authenticated daemon retirement and replacement; clients do not kill a PID based only on a stale file.
- After upgrading `pi-knowledge`, restart Pi/OMP sessions, stdio MCP clients, and persistent HTTP adapter processes so all clients run the new package. The first compatible client replaces an older daemon when required.
- Re-run `npm install-scripts ls` under npm 12 and review any newly pending or stale install-script approval before rebuilding or publishing.

## Protocol and verification

The server supports legacy MCP initialization for `2025-11-25`, `2025-06-18`, and `2025-03-26`, plus the stateless `2026-07-28` discovery/request contract. Modern cacheable discovery/list results include private `ttlMs` and `cacheScope` hints. HTTP uses Streamable HTTP POST responses, request-scoped SSE for tool progress/results, legacy session IDs where negotiated, and DELETE for legacy session termination. It intentionally returns `405` for GET because it does not expose a server-initiated event stream.

Verify a real tool call, not only a connected status:

```text
Use piKnowledge to list my knowledge bases. Do not change anything.
```

Then inspect the client tool trace and confirm it called `knowledge_show`. For troubleshooting, check `pi-knowledge-daemon status`, the MCP client's server log, the selected `--profile`, the HTTP token environment, and the adapter capability flags.

Client references:

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
- [VS Code Copilot MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [Kiro MCP configuration](https://kiro.dev/docs/mcp/configuration/)
- [Kiro ACP](https://kiro.dev/docs/cli/acp/)
- [npm 12 install-script approvals](https://docs.npmjs.com/cli/v12/commands/npm-install-scripts)
