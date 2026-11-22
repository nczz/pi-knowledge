# Profile-scoped Daemon Architecture

## 狀態

實作規格。此文件定義 pi-knowledge 從 extension 內嵌 `KnowledgeEngine` 遷移到 profile-scoped singleton daemon 的完整切換契約。

## 目標

- 一般使用者零設定使用 `default` profile；工具參數不暴露 profile 複雜度。
- 一個 profile 可包含多個 knowledge bases，但只擁有一個 storage domain 與一個常駐 daemon。
- Pi、OMP、CLI、MCP 與其他 agent 都連到同一個 profile daemon；client 不直接開啟 `knowledge.db` 或 vector files。
- 進階使用者可明確選擇 named profile，取得完全隔離的 DB、vectors、config、watchers、daemon 與 coverage snapshot。
- daemon 可由使用者獨立啟動，也可由 extension/MCP client 以 `ensure` 語意自動啟動；啟動它的 client 離開不會停止 daemon。
- issue #25 的 `coverage.json` 由 profile daemon 在 mutation 完成點唯一產生。

## 核心模型

### Profile

Profile 是 storage/runtime domain，不是單一 KB。每個 profile 包含：

- canonical storage directory
- `knowledge.db`
- `vectors/` 與 model/runtime config
- watcher state
- daemon runtime manifest、endpoint 與 singleton ownership
- `coverage.json`

Profile 名稱只供選擇與顯示；singleton identity 由 canonical storage directory 的 SHA-256 digest 決定。名稱必須是已 canonicalize 的 ASCII lowercase key，符合 `[a-z0-9][a-z0-9_-]{0,62}`；拒絕 trailing dot/space、Windows reserved device basename、case-fold collision 與不能 round-trip 的名稱。工具中的既有 search tuning `profile` 不改名；knowledge profile 在程序層以 `PI_KNOWLEDGE_PROFILE` 或 CLI `--profile` 選擇，避免同名參數衝突。Named profile directory 建立時不得跟隨 symlink，建立後必須 realpath 並驗證仍位於 owner-verified profile root 內。

### Default-first 行為

- 未指定 profile 時永遠選擇 `default`。
- extension 與 MCP tool schema 不新增必填 profile 欄位。
- named profile 只由進階使用者透過程序設定選擇；找不到 named profile 時建立其隔離 storage directory，不 fallback 到 default。
- 一個 daemon process 只管理一個 profile；不同 profile 可同時執行。

### Default storage migration

Default 必須跨 Pi、OMP 與 MCP 穩定解析到同一 storage directory，同時保留現有資料：

1. `PI_KNOWLEDGE_DIR`、其次 `OMP_KNOWLEDGE_DIR` 明確覆蓋 default storage；explicit override 可位於 profile root 外，但仍須 canonicalize 與驗證 owner。
2. 沒有覆蓋時，讀取 `~/.pi-knowledge/profiles.json` 的 persisted default mapping。
3. 首次建立 mapping 時，先依現行 precedence 解析 `PI_CODING_AGENT_DIR`、`OMP_CODING_AGENT_DIR` 所代表的 host-derived knowledge directory，再連同 legacy `~/.pi/knowledge`、`~/.omp/knowledge` 一起 canonicalize、去重並檢查：
   - 只有一個 candidate 含 `knowledge.db`：採用該目錄，不搬移資料。
   - 多個 candidate 解析為同一 canonical path：採用該目錄。
   - 多個不同 candidate 各有 `knowledge.db`：拒絕猜測，回報需用 `PI_KNOWLEDGE_DIR` 明確選擇。
   - 都沒有 DB：新 default 使用 `~/.pi-knowledge/profiles/default`。
4. Named profiles 使用 `~/.pi-knowledge/profiles/<canonical-name>`，可由 `PI_KNOWLEDGE_PROFILE_ROOT` 覆蓋 profile root。
5. Registry 以 owner-only tmp + rename 原子寫入；不得匯出、移動或合併現有 KB。新 profile directory mode 為 `0700`；重用 legacy directory 前驗證 owner，對 group/other writable 目錄拒絕啟動並提供明確修復訊息。

## Daemon ownership

Profile daemon 是以下資源的唯一 runtime owner：

- `KnowledgeEngine`
- SQLite connection
- vector mutation
- model worker lifecycle
- file watchers 與 polling fallback
- mutation queue/guards
- profile coverage snapshot

Client 不得在 daemon 無法連線時 fallback 建立本地 `KnowledgeEngine`。失敗必須回報 actionable error，否則會重新引入第二個 writer。

Direct `KnowledgeEngine` construction 保留給 unit/e2e/bench 與內部 daemon service，不是 extension/MCP production path。

## Singleton 與 runtime discovery

每個 profile storage directory 下建立 owner-verified、不可跟隨 symlink 的 `.runtime/`（mode `0700`）：

- `daemon.json`: runtime manifest，以 exclusive `0600` temp file + fsync + rename 發布
- `daemon.lock`: 完整 daemon owner JSON，以 exclusive `0600` temp file + fsync + hard-link no-replace claim 發布

Unix endpoint 放在 owner-verified、mode `0700` 的 per-user runtime directory，名稱包含 profile id 與每次啟動的 256-bit random component，避免 socket path 長度與 predictable-name race；Windows named pipe 同樣使用 random component、token authentication與僅本機模式。Endpoint 只能從受保護 manifest 發現。Manifest 至少包含：

- protocol version
- profile name/id
- canonical storage directory
- daemon instance id、PID、started timestamp
- random endpoint
- package/build identity
- 256-bit auth token
- watcher enabled state

Daemon startup：

1. 先產生 instance id/random endpoint與完整 owner JSON（PID、instance id、endpoint、started timestamp），再以 `0600` exclusive temp file寫入並 fsync，最後用 hard link把完整檔案 no-replace claim為 `daemon.lock`。Target 已存在時 claim必須失敗，不得覆蓋。
2. 取得完整 lock後立即建立/bind random endpoint；完成 bind後才初始化 engine。Application handshake尚未 ready時，raw socket listener仍代表 owner存活，其他 launcher必須等待或回報 busy。
3. lock已存在時，即使 manifest尚未發布，也能直接從完整 `daemon.lock`讀取 instance/PID/endpoint；先嘗試 authenticated handshake或 raw connect。
4. heartbeat只供診斷，永遠不能授權 takeover。Owner PID仍存在、PID identity無法可靠確認、raw endpoint可連線或 lock identity在檢查期間改變時，一律拒絕接管並回報 busy/unresponsive。
5. 只有 endpoint明確沒有 listener、owner PID已不存在、`daemon.lock`/manifest（若存在）的 instance id在二次讀取後仍完全一致，才能 atomic rename舊 lock後清理該 instance記錄。Crash發生在 manifest發布前仍可由 owner record安全恢復；stale random socket保守保留，避免 unlink/bind race移除外來 live endpoint。
6. `EADDRINUSE`或未通過認證的 foreign endpoint一律 fail closed；daemon不得因 handshake失敗就 unlink不屬於自己的 socket。
7. graceful shutdown關閉 admission、watchers與 server，取消並等待 bounded in-flight work。只有 coordinator確認所有使用 DB/vector handles的 operation已 settle，才能 dispose engine並移除 instance-matched artifacts。

PID、heartbeat 或檔案存在本身都不構成 liveness 證明。Client 只有在完成 authenticated protocol handshake 後才把 daemon 視為 ready。

## Local RPC contract

- JSON Lines request/response protocol over local socket/pipe。
- protocol version 從 1 開始；client/server protocol 或 package/build identity 不相容時直接拒絕。
- 每個 client request 使用唯一 id；連線以受保護 manifest 中的 token 認證，token 不進 argv/log/error。
- server 可傳送零到多個 bounded progress frames，最後恰好一個 result 或 error frame。
- client `AbortSignal` 觸發 cancel frame；server 的 `AbortController` 傳入所有長操作，取消必須繼續傳到 model worker。
- 連線中止也必須取消該 subscriber；coalesced update 由 daemon mutation coordinator 管理 subscriber/progress，只有沒有 subscriber或 daemon shutdown 時才取消底層 operation。
- model worker protocol 必須支援 cancel frame與 request registry；長迴圈在批次間檢查。無法中斷的單次 native/model call 可延遲到該 call 返回，但不得繼續後續 batch，且語意必須明確。
- request/frame、connection、in-flight request、queued mutation、progress bytes與 outbound buffer 都設定硬上限；超載直接拒絕，不建立無界 queue。
- daemon shutdown 在任何 `await` 前停止 admission並 abort controllers，重複 shutdown 共用同一 promise。Grace deadline 到期後先 terminate model worker，使 pending model promises reject，再給 coordinator一個短的 settle deadline；若仍有 operation存活，daemon採 fail-stop：不 close DB、不 dispose live resources、不移除 lock/manifest/socket，直接以非零狀態結束整個 process，讓 OS 回收 handles，下次啟動只在確認舊 PID dead後做 instance-checked recovery。
- server error 只回傳安全的 message/code，不回傳 stack 或 token。

第一版 RPC operations：

- `ping`, `shutdown`, `enable_watchers`
- `plan`, `configure`
- `add`, `update`, `remove`, `clear`, `import`, `export`
- `search`, `symbol_search`, `list`, `status`, `doctor`

`configure` 正常由 daemon 執行；但 launcher另提供 startup-light bootstrap config path，不開 DB/engine、不需要 daemon。當 ensure 回報「沒有可信 Node runtime」時，`knowledge_configure` 可用使用者明確提供的 absolute `node_path` 在 client process驗證 Node 22+、owner與路徑，原子寫入該 profile runtime config，再重試 ensure。Bootstrap 禁止 PATH/NODE auto-discovery；未提供明確 path 時回傳 actionable error。其他 tools 不得繞過 daemon。

所有 engine 呼叫都由 daemon service 執行。Watcher callback 也回到同一個 mutation coordinator/service update path，確保 subscriber cancellation、progress、coverage snapshot 與 mutation guard 一致。

## Daemon lifecycle

- `ensure`: 先 connect；不可達時使用目前 package `import.meta.url` 解析出的絕對 daemon entry，透過共用、profile-aware Node 22+ resolver 以 argument array、`shell:false`、detached stdio啟動，再等待 authenticated readiness。
- Source checkout 的 `.ts` entry 使用 `--experimental-strip-types`；published `.js` 不使用。不得從 cwd、shell或 PATH 搜尋 `pi-knowledge-daemon`。
- Daemon runtime只接受兩類 Node executable：已驗證確為 Node 22+ 的 `process.execPath`，或由 admin 明確設定／profile config持久化的 absolute、owner-verified Node path。Daemon launcher不得採信 `NODE`、`PATH`或自動 discovery candidate；非 Node Pi/OMP host沒有可信 persisted runtime時 fail closed並要求先明確 configure。Model worker可維持既有 discovery，但不能決定 daemon executable。
- Spawn environment 採 allowlist：profile/storage/runtime/provider必要設定與 credentials；拒絕繼承 `NODE_OPTIONS`、`NODE_PATH` 等 loader injection。Token 不放 argv/environment。
- `start`: ensure 的 CLI 顯式形式，已啟動時成功回報既有 instance。
- `run`: foreground daemon，供 service manager 與診斷使用。
- `status`: 只做 handshake，不啟動 daemon。
- `stop`: authenticated admin shutdown，等待 server 確認；不得以 PID 猜測直接 kill 正常 daemon。
- extension session shutdown 只釋放 client state，不停止 daemon。
- daemon shutdown guard 必須在任何 `await` 前設定，重複 shutdown必須 idempotent。Service先 bounded drain；deadline後 terminate model worker並短暫等待 coordinator。若仍未 settle，整個 daemon fail-stop且不執行競態 cleanup；只有全數 settle才呼叫 `KnowledgeEngine.dispose()`。Engine dispose不得重新無界等待已由 service管理的 operation。

## Watcher contract

Watcher 從 extension 移入 daemon：

- daemon 啟動時依 profile runtime 設定啟用。
- client 帶 `PI_KNOWLEDGE_WATCH=true` 連入既有 daemon 時，可呼叫 `enable_watchers`；這是 monotonic enable，不因另一個 client 離開而關閉。
- add directory KB 後由 daemon 自動建立 watcher。
- remove/clear 後 daemon 停止對應 watcher。
- watcher update 使用 service mutation coordinator，不直接呼叫第二個 engine。
- watcher polling 改為 async、bounded batch、不可重入；不得以同步全目錄 scan 長時間阻塞 daemon endpoint。
- shutdown 先停止 watcher/timer與新 admission，再 abort/drain requests，最後 engine dispose。

## Extension cutover

Root `index.ts` 保持 startup-light：

- 不再 runtime import `engine.ts`、SQLite 或 watcher。
- lazy import daemon client/profile resolver。
- 預設 session start與 before-agent-start不解析 profile、不執行 ACL檢查、不啟動 daemon；before-agent-start只注入靜態工具指引。
- `PI_KNOWLEDGE_WATCH=true`在 session start eager ensure並 monotonic enable watcher；所有 engine-backed tool與 opt-in auto-inject在第一次使用時 lazy ensure。唯一例外是上述 `knowledge_configure` no-runtime bootstrap，它只驗證/持久化明確 Node path並立即重試 ensure，不開 DB或 engine。
- session shutdown 等待可能的 in-flight ensure 完成後清理 client reference，但不停止 daemon。

Public tool descriptions、approval、confirmation、search miss formatting與結構化 `details` 必須保持相容。

## MCP adapter

MCP 是 daemon 的 adapter，不是第二個 engine owner：

- `pi-knowledge-mcp [--profile <name>]` 預設提供 stdio JSON-RPC；`--transport http` 提供多個本機 agent 可共用的 Streamable HTTP endpoint。
- adapter 啟動時 ensure profile daemon。MCP process 不開 DB、不啟動 watcher、不載入模型；stdio/HTTP 都轉送到同一 profile daemon。
- transport-independent protocol core 實作 legacy `2025-11-25`/`2025-06-18`/`2025-03-26` 的 `initialize` 與 modern `2026-07-28` 的 `server/discover`、required per-request `_meta`、typed result，以及 cacheable complete result 必備的 private `ttlMs`/`cacheScope`；兩者都支援 `ping`、`tools/list`、`tools/call`、progress 與 cancellation。
- tool metadata/schema 與 Pi/OMP extension 共用同一份定義，輸出順序 deterministic。MCP 是新增的外部 client surface，不取代或改變 Pi/OMP hooks。
- stdio 使用 bounded JSONL；stdin EOF 取消 adapter in-flight requests 並退出，但不停止 profile daemon。
- HTTP 只允許 `127.0.0.1`、`::1` 或 `localhost`，且強制從 `PI_KNOWLEDGE_MCP_HTTP_TOKEN` 取得 32–512 visible ASCII bearer token。 supplied `Origin` 必須等於 endpoint own origin 或 explicit `--allow-origin`；token 不進 argv/log。
- HTTP modern request 驗證 required metadata 與 `MCP-Protocol-Version`、`Mcp-Method`、tool call `Mcp-Name` mirrored headers；tool call 使用 request-scoped SSE 回報 progress/result，client disconnect 取消 modern work。
- HTTP 保留 negotiated legacy session ID、idle/session bounds、DELETE session termination；GET 回 `405`，不建立 server-initiated event stream。Request/body/output queue/concurrency 全部 bounded。
- HTTP shutdown 先停止 admission，再 abort sessions/requests、bounded drain/close connections；重複或 concurrent close 必須 idempotent，且不停止 profile daemon。
- MCP adapter預設只暴露不讀取 retained source的已索引 `search`、`symbol_search`、`show`；`knowledge_plan`不屬於預設 read-only，因為它會掃描任意來源。Search provenance只使用已索引時間與持久化 KB status，不在 query path讀取 source mtime。
- `--allow-root <canonical-dir>`（可重複）提供 owner-verified local source/import/export scope並開啟 `plan`；所有 local path在每次操作時 realpath並驗證仍位於 allowed root。`--allow-network`另行開啟 URL source/update，套用 private-network policy。`--allow-write`開啟 mutation，但 local/network mutation仍必須同時具備對應 root/network capability。`--allow-admin`另行開啟會掃描 retained source的 status/doctor，以及 configure/remove/clear。
- Pi/OMP host 的 approval metadata不能被視為 MCP authorization；`confirm` 也只防誤操作。

不新增 production dependency；stdio 與 HTTP 使用 Node runtime primitives。遠端 bind、TLS、OAuth、MCP resources/prompts 不在本階段範圍，不能把 loopback HTTP 文件化成跨機器服務。

## Coverage snapshot（issue #25）

Daemon 在 startup reconcile，以及 add/update/remove/clear/import 成功後，原子重寫 `<profile-storage>/coverage.json`：

```json
{
  "schema_version": 1,
  "generated_at": 1763050000000,
  "profile": "default",
  "kbs": [
    {
      "name": "repo",
      "source_type": "directory",
      "source_path": "/work/repo",
      "exclude_paths": ["dist"],
      "file_count": 42,
      "chunk_count": 812,
      "updated_at": 1763049871000,
      "status": "ready"
    }
  ]
}
```

- `kbs` 以 `name`、再以內部 KB ID 的 Unicode code-unit順序排序；順序不受 OS locale影響。`name` 在同一 profile內唯一，也是 `knowledge_update`等工具可使用的 selector。
- `source_type` 的封閉集合為 `directory | file | url | text`。`source_path` 對 directory/file 是建立或更新時解析的本機絕對路徑，對 URL 是 URL；inline text/import 為 `null`。Consumer 必須把 `null` 視為 scope-agnostic（永遠涵蓋），不能解讀為不涵蓋任何 path。
- `exclude_paths` 只對 directory source有意義；值使用 `/`、移除前後 `/`，並相對於 source root。值 `archive` 只匹配 `archive` 本身與其子樹，不匹配 `archived_reports`；空值不輸出。
- `file_count`、`chunk_count`是最近一次成功持久化的 KB計數。`updated_at`是最近一次完整成功 add/update/import 的 Unix epoch毫秒；indexing、error、cancel或其他 row bookkeeping 不得推進此時間。它仍不是 per-file freshness watermark。
- 既有 v5 database 升級時，daemon 依序以最近保留的成功 indexing job、現存 chunk 的最晚 `indexed_at`、最後 `0` 做保守回填；不得用會被 status bookkeeping 推進的舊 row `updated_at`。`0` 表示沒有可證明的成功時間，consumer 應保持 silent/fail-open。
- `status` 的封閉集合為 `ready | indexing | error | stale`。`generated_at`是 daemon產生本次 point-in-time snapshot的 Unix epoch毫秒。
- source-backed update已有 published generation時，KB維持原本 `ready`/`stale`可搜尋狀態；running/failed/cancelled由 `indexing_jobs`表達。更新使用 staging tables與不可變 vector generation，最後以單一 SQLite transaction切換 chunks/symbols/vector pointer/metadata/timestamps。失敗保留舊 generation與 `updated_at`/`indexed_at`，status/doctor另揭露 failed update。只有沒有可用 published generation或其一致性無法保證時才使用 `indexing`/`error`。
- clear 保留檔案並寫入空 `kbs`。
- snapshot 與 temp file 都使用 `0600`；tmp + fsync + rename，consumer 永遠只看到完整舊版或完整新版。
- snapshot error 不回滾也不改變已成功的 mutation；daemon 保存最近 snapshot error供 status/manifest診斷並寫不含敏感 path的 stderr。Watcher背景更新也必須同步更新或清除 manifest診斷。
- snapshot可能包含本機絕對 path或 URL，屬敏感的 advisory point-in-time scope/status；它不是 per-file coverage/freshness authority。
- consumer必須處理 absent/stale/version mismatch，且不得修改此檔控制 daemon。

## Runtime configuration ownership

Daemon process 以 profile storage directory 設定自己的 `PI_KNOWLEDGE_DIR`，讓既有 model cache、runtime config 與 worker discovery 都落在正確 profile。

Engine-affecting環境設定由啟動中的 daemon 擁有。Handshake 回報 runtime configuration signature；client 與現有 daemon 設定不一致時不得假裝新設定已套用，應回報需要 restart/reconfigure。`PI_KNOWLEDGE_WATCH=true` 例外，可透過 monotonic enable 即時開啟。

## 安全邊界

- endpoint 僅限本機；Unix runtime parent/profile runtime mode `0700`，socket、manifest、token與 coverage 使用 user-only 權限；所有 runtime artifact 在使用/刪除前做 `lstat`、owner、symlink 與 instance-id 驗證。
- auth token 每次 daemon instance 以 crypto 產生至少 256 bits，輪替後舊 token 失效，不寫 log、argv、錯誤或 coverage snapshot。同 UID process 視為本機 trust boundary，但 MCP adapter仍以 read/write/admin launch capability限制 agent surface。
- RPC 不接受任意方法名稱映射或動態 import；方法 allowlist與輸入 schema在 daemon boundary 再驗證。
- destructive tool confirmation 只防誤操作，不代表授權；MCP mutation/admin 必須另由 launch capability開啟。
- direct file、URL、import、inline text與 export path 都有 byte/count/time/redirect bounds。URL 一律拒絕 loopback/private/link-local與 redirect 逃逸；`--allow-network` 只授權 public URL operation，不會放寬此限制。Export 預設拒絕 symlink escape與非預期覆寫。

## Clean cutover

- production extension 一次切換到 daemon client；不保留 local-engine compatibility mode。
- 舊 storage 透過 default registry 指向原目錄，不複製資料。
- watcher ownership 一次移入 daemon；extension 移除 watcher lifecycle。
- package 提供 `pi-knowledge-daemon` 與 `pi-knowledge-mcp` bin entry。
- `knowledge_status` 顯示 active profile、daemon instance/protocol、storage path、watcher count與 snapshot warning。

## 實作階段與 gates

### Phase A：Profile 與 daemon core

交付：profile resolver/registry、manifest、singleton、RPC framing、daemon service/client/CLI。

Gate：

- default legacy/host-derived resolution、named isolation、invalid/ambiguous/case-fold/reserved profile 測試。
- concurrent ensure 只產生一個 daemon。
- live-but-unresponsive owner不接管；pre-manifest crash可由完整 atomic owner record恢復；dead owner stale lock/socket做 instance-checked recovery。
- auth、protocol/build mismatch、foreign endpoint、oversized frame、overload與disconnect cancellation。
- model-worker cancellation與 coalesced update 多 subscriber progress/cancel。
- trusted/persisted Node、非 Node host fail-closed、Windows 空白 path、spawn failure與 readiness timeout。
- fresh non-Node host無 persisted config時，client-side explicit configure-node → ensure成功，且 bootstrap全程不開 DB/engine。
- repeated/concurrent shutdown idempotence、cooperative bounded drain，以及永不回應 native call觸發不清理 live resources的 fail-stop gate。
- 獨立 reviewer 完成 correctness/security/lifecycle review，blocking finding 歸零。

### Phase B：Extension 與 MCP cutover

交付：shared tool definitions、extension daemon client、watcher daemon ownership、MCP shared protocol core、stdio 與 loopback Streamable HTTP。

Gate：

- 所有 public tools contract 保持。
- startup/shutdown race、agent-start、auto-inject、progress/cancellation。
- MCP modern discover/meta/result 與三個 legacy initialize 版本；stdio list/call/progress/cancel；HTTP bearer/origin/mirrored headers、JSON/SSE、legacy session/DELETE、disconnect cancellation。
- read/write/admin capability filtering 在兩個 transports 一致。
- HTTP non-loopback/weak token fail closed；request/body/session/concurrency/output bounded；repeated/concurrent shutdown idempotent。
- extension 不再 import/construct production `KnowledgeEngine`，Pi/OMP hooks 行為不因 MCP transport 改變。
- 獨立 reviewer 完成 compatibility/security/lifecycle review，blocking finding 歸零。

### Phase C：Coverage snapshot

交付：versioned atomic snapshot、mutation/startup hooks、status warning、文件。

Gate：

- shape、exclude paths、source type、clear empty list。
- write/rename failure不影響 mutation。
- startup reconcile。
- 只有 daemon service production path 寫入。
- 獨立 reviewer 完成 data contract/failure semantics review，blocking finding 歸零。

### Final gate

- `npm run check`
- `npm run typecheck`
- `npm test`
- `npm run test:e2e`，明列未設定 PDF/DOCX fixture時的 skipped coverage
- 設定 `PI_KNOWLEDGE_E2E_PDF` 與 `PI_KNOWLEDGE_E2E_DOCX` 的 release-grade e2e（fixture 可用時）
- actual detached daemon CLI smoke with concurrent clients
- actual packed MCP stdio 與 authenticated loopback HTTP smoke；兩者都實際 list/call 並 clean shutdown
- `node --experimental-strip-types -e "import('./index.ts')"`
- `npm run build`
- `npm pack --dry-run`
- 將 packed tarball 安裝到 temp project，實際啟動兩個 bin並驗證 native dependency resolution
- Pi/OMP dogfood when runtimes are available
- independent final quality/security/async-lifecycle review

## 非目標

- 跨機器 daemon、遠端 network listener或多使用者服務。
- default 跨 profile 搜尋。
- 自動合併兩個 legacy DB。
- sidecar 作為 mutation input或 per-file manifest。
- MCP resources/prompts、遠端 HTTP bind、TLS termination、OAuth或多使用者服務。
