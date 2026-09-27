# WhatsApp Calendar Agent - BINDING ARCHITECTURE (v1)

Status: **binding** for workflows 2 (build) and 3 (test/review). Date: 2026-09-21.
Inputs: `docs/research/*.md` (10 reports), `docs/proposals/{simplicity,safety,ux}.md`, `ops/CONTEXT.md`, `ops/agent-notes/workflow-1-summary.md`.
Author: synthesis/judge agent. Reasoning trail: `ops/agent-notes/architecture-judge.md`.

Reading rules for build agents:

- **MUST / NEVER** in this document are release blockers. Anything not described here is out of scope for v1 ("no speculative features").
- Where research was UNVERIFIED or reports conflicted, the **lower-risk option was chosen and is marked `[LR]`** with the reason. Section 19 lists every remaining UNVERIFIED fact and the manual check that closes it.
- Versions and model names were re-verified on 2026-09-21 (`npm view`, Hugging Face API, vendor docs). npm `latest` is a trap for several packages - use the exact pins in section 16.
- Locked user decisions (`ops/CONTEXT.md`) are not relitigated: Electron+TS; approval-first; personal assistant, DMs only, he/en; llama.cpp embedded with tiered first-run download, no Ollama; exactly three providers Local/Claude/Gemini; Google Calendar only through an MCP server with tools exposed to the active LLM; the exact prebuilt `whatsapp-bridge.exe` as a managed child with its own store; minimal three-list dashboard, he (RTL) + en, X hides to tray, quit only from the tray.
- **Revision 2 (2026-09-22).** Paragraphs marked `[R2]` were changed after the adversarial design review (38 findings; disposition in `ops/DECISIONS.md`). Where this document and `docs/specs/contracts.md` differ in a `ts`/SQL block, **contracts.md wins** - it is the single source of truth for shapes, DDL and constants.

---

## 0. Judgement of the three proposals

Scores 1-5 (5 = best; for "packaging risk" 5 = lowest risk).

| Criterion | simplicity | safety | ux | Notes |
|---|---|---|---|---|
| Requirements fit | 4 | 4 | 4 | All satisfy the locks. simplicity: single tool loop ending in a forced virtual tool leans on forced `tool_choice` (rejected on `claude-fable-5-1`, UNVERIFIED on llama-server+Gemma 4). ux: Local "tool calling" is an `anyOf` grammar union (UNVERIFIED in b10964) and a keyword pre-filter silently drops messages. safety: narrowest, but every mechanism it uses is documented. |
| Buildability by parallel agents | 5 | 3 | 3 | simplicity has the smallest module graph and a concrete wave/ownership plan. safety has 5 spikes before build lock. ux adds CalendarSync, hash worker, window destroy/recreate, demo pipeline. |
| Packaging risk | 5 | 3 | 4 | simplicity: zero native addons, no asarUnpack, ASAR-integrity fuse off, verified `ELECTRON_RUN_AS_NODE` path. safety: primary MCP launch is an unverified `process.stdin` hack inside `utilityProcess`, ASAR integrity on (UNVERIFIED on Windows). ux: worker_threads entry inside asar, ASAR integrity on. |
| Safety | 3 | 5 | 4 | safety: write-ahead action log, shownHash binding, DB trigger, spawn invariants, unknown-sender gate, capability separation with tests. simplicity: only a `revision` check. |
| UX | 3 | 3 | 5 | ux: single health pill, ErrorCode -> one action, onboarding with background download, skip-Google, copy escape hatch, edit-lock, first-close coach mark. |
| **Total** | **20** | **18** | **20** | |

**Verdict.** Base = **simplicity** (process model, zero-native-addon rule, one supervisor, single ingestion path, packaging, wave plan). Grafted from **safety**: the seven invariants, ToolGate + read/write client split, the action table with `shownHash` + expiry + write-ahead states + DB trigger, `unknown_outcome` reconciliation, bridge spawn invariants, the extract-then-draft pipeline with TypeScript date resolution, the security test gate. Grafted from **ux**: `AppHealth` + `ErrorCode` (one bilingual message + one action per failure), onboarding order with background model download and skippable Google, "Copy" escape hatch and `@lid` copy-only, edit-lock, raw cards when the LLM is unavailable, first-close coach mark, below-normal priority for llama-server.

Rejected ideas are listed in section 20.

---

## 1. Binding decisions

| # | Decision | Rationale | Source |
|---|---|---|---|
| A1 | **Zero native Node addons.** No `node-llama-cpp`, no `better-sqlite3`, `npmRebuild:false`, no `asarUnpack`. | Every packaging failure mode in the research comes from native addons. | simplicity D1 |
| A2 | **Local LLM = official `llama-server.exe`, llama.cpp build `b10964`, Windows Vulkan x64 zip, shipped in the installer, lazy child process, OpenAI-compatible HTTP on `127.0.0.1:<random>` + per-launch API key.** Still "llama.cpp embedded, no Ollama". | Crash isolation, no ABI coupling, one zip covers CPU+iGPU+dGPU, new chat templates without a binding release. All three proposals and the runtime report agree. | all |
| A3 | **Exactly three managed children under one Electron-free `Supervisor`**: bridge (always), calendar MCP server (once Google credentials exist), llama-server (lazy, provider=Local only). No `utilityProcess`, no `worker_threads`, no agent worker process. | One restart/kill/reap implementation. Heavy work is already out of process. | simplicity D3/D4 |
| A4 | **Calendar MCP server = `@cocal/google-calendar-mcp@2.6.3` over stdio, spawned with `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; the `runAsNode` fuse stays ENABLED.** `[LR]` | The only launch path verified by research on a PC without Node. The `utilityProcess`+stdin-shim alternative is an unverified hack; the HTTP transport is an unauthenticated loopback endpoint with calendar write access. Guarded by a packaged smoke test (section 15.4). | simplicity D9, ux D10, orchestrator C1 |
| A5 | **App state DB = built-in `node:sqlite` (`DatabaseSync`), WAL, behind a small `Db` interface.** | PROBED in Electron 44.4.3; nothing to rebuild or unpack. | research electron-stack |
| A6 | **One ingestion path: read-only `rowid`-watermark scan of the app-owned bridge `messages.db`.** The webhook is a body-discarding doorbell that triggers the same `scan()`; a 30 s timer, app start, bridge (re)connect and the "History sync complete" stdout marker trigger it too. | Text webhooks carry no message id and no timestamp and are never retried, so a DB scan is mandatory anyway. Verified in vendored `main.go`: `INSERT ... ON CONFLICT(id, chat_jid) DO UPDATE`, ordinary rowid table. | simplicity D5 |
| A7 | **Unit of work = a chat. At most one OPEN item per chat** (partial unique index). | Bursts become one card; re-triage is idempotent. | all |
| A8 | **Two-stage LLM pipeline with no feature combination** `[LR]`: S1 EXTRACT = schema-constrained JSON, **no tools**; S2 RESOLVE = TypeScript date math; S3 DRAFT = bounded **tool loop with READ calendar tools, `tool_choice:auto`, terminal output = plain text draft**. Never tools+structured-output in one request, never forced `tool_choice`, never `anyOf` unions, never nullable types. | Each stage uses the single best-supported feature of all three backends. Combining tools with `response_format` is UNVERIFIED on llama-server; forced tool choice is rejected on `claude-fable-5-1`; `anyOf` grammar is UNVERIFIED on b10964; type arrays crash `gemma4.jinja`. Both local-model reports recommend grammar JSON for extraction and no date arithmetic by the model. | safety S1-S3 (modified), research |
| A9 | **The LLM only ever sees app-authored tool definitions** for READ calendar tools (`get_current_time`, `get_freebusy`; `[R2]` `list_events` cut - free/busy is enough for drafting and it was the only tool that could ship event titles to a cloud provider); execution is a real MCP `tools/call` through `ToolGate` (default-deny allowlist, app-pinned args, projected results, per-run budgets). `[R2]` Reading of the locked "LLM via MCP" decision, to be confirmed by the user (ops/DECISIONS.md): the active LLM reaches the calendar **read-only** through MCP tool calling; `create-event` is executed by the app through the **same MCP client** after the user's approval click, never by the LLM. | Satisfies "MCP tools exposed to the active LLM via tool calling" while defeating tool-description poisoning and schema incompatibilities. | all, orchestrator C3 |
| A10 | **WRITE = `create-event` only, reachable only from `ActionExecutor`, which runs only from the `action:approve` IPC handler.** `update-event`, `delete-event`, `create-events`, `respond-to-event`, `search-events`, `get-event`, `list-colors` are not even enabled at the MCP server. | "Delete my calendar" is impossible regardless of bugs above it. Reschedule/cancel produce a reply draft + a link to the event. | all |
| A11 | **Approval binding**: opaque `actionId` + `sha256(canonical_json)` shown-hash + 24 h expiry + focused window + rate limits + write-ahead states `pending -> approved -> executing -> done/failed`, enforced by a SQLite trigger. `[R2]` Every state change is a compare-and-set on the previous state (`changes === 1`), `failed` is terminal, nothing returns to `pending`, and the trigger refuses `executing` without `approved_final_json` (contracts.md 15.2 is the binding trigger text). A concurrent second `action:approve` for the same id is answered `ACTION_STALE` before any await (in-memory `inFlight` set) or at the write-ahead - never `failed`, never a clone. Crash mid-execution => `unknown_outcome`, never auto-retried, reconciled read-only. | Approval-first enforced in code and in the database, not in prompts. | safety 6.3 |
| A12 | **Recipient of a send is always the chat of the trigger message**, re-read from the app DB by the executor; regex `^[0-9]{5,20}@s\.whatsapp\.net$`. `@lid` chats are analysed but **copy-only** `[LR]`. `[R2]` The vendored bridge already rewrites LID chats to the phone JID when it knows the mapping (`resolveLIDChat`, SenderAlt/RecipientAlt, LID store) and resolves phone->LID itself on `/api/send`; the residue of unmapped `@lid` chats is re-resolved by ingest on every bridge ONLINE transition through a read-only lookup of the bridge's own mapping table and merged into the phone-JID chat (`repos.chats.mergeLidInto`). V3 (`/api/send` to an `@lid` recipient) is a **release-gate manual item**; if it passes, `DM_LID_JID_RE` becomes sendable and copy-only is dropped. | Whether `/api/send` handles `@lid` is UNVERIFIED. | safety I3, ux D9 |
| A13 | **Unknown-sender gate (default ON)**: a chat in which the user has never sent a **real message** (per bridge DB: `is_from_me=1`, not a reaction, non-empty, not deleted `[R2]`, over both JID forms of the contact) is not LLM-processed; it appears as a raw card with an "Analyse this chat" button. | Removes the zero-cost stranger attack and cost DoS; the raw card keeps first-contact messages visible. `[R2]` An own thumbs-up to a stranger must not flip the chat to "known". | security S1, ux 2.2 |
| A14 | **Backlog gate**: rows with `ts < live_from_ts` (`= pairedAt - settings.whatsapp.backlogHours`, default **0**) are context-only. `[R2]` The **24 h age cap applies only while the bridge is (re)syncing history** (spawn until the first "History sync complete" hint, max 120 s) or before the bridge has ever been ONLINE; once the bridge has been online (`meta.last_online_ts`, persisted on every ONLINE -> not-ONLINE transition and on quit), rows up to **7 days** old are live triggers (a laptop closed over a weekend), and older-but-live rows still become a raw card with an `older_message` badge instead of vanishing. `paired_at`/`live_from_ts` are reset on **every** pairing that followed a QR scan; `unlinkAndWipe` resets the watermark. `[LR]` | History sync dumps months of messages without webhooks. Default 0 deviates from the orchestrator's "24 h" lean because backlog triage would send old third-party messages to a cloud provider on first run; the user can raise it (0-72 h). | safety 4.7, simplicity 2.1 |
| A15 | **Bridge spawn invariants** (`assertBridgeSpawnInvariants`): refuse to spawn unless cwd is inside `userData`, all five env vars are set, port != 8080, webhook host is `127.0.0.1` on our live doorbell port, exe SHA-256 matches the pin, outbox dir exists and is empty, ToS disclosure accepted. | The user runs another live copy of the same bridge; defaults would leak messages to their other webhook receiver. | safety 4.3 |
| A16 | **Only four bridge endpoints are implemented**: `GET /api/health`, `GET /api/pairing/status`, `GET /api/pairing/qr.png`, `POST /api/send {recipient, message}`. Never `media_path`, `/api/typing`, `/api/react`, `/api/download`, `/api/media`, `/api/group/*`. | No visible side effect on the contact's side other than an approved send. | safety 4.4 |
| A17 | **One `AppHealth` object + `ErrorCode` enum**; every failure maps to one bilingual title/body and exactly one action. | Clear states for a non-technical user; testable (enum parity test). | ux D8 |
| A18 | **Renderer**: React 19 + Zustand + Tailwind 4 (logical utilities only) + i18next/react-i18next, sandboxed, served from `app://bundle/`, CSP `connect-src 'none'`. All renderer libs are devDependencies bundled by Vite. | The version set was dependency-resolved by research; utility classes avoid shared-CSS merge conflicts between parallel agents; zero packaging impact. | research electron-stack, ux |
| A19 | **Fuses**: `runAsNode:true` (A4), `enableNodeOptionsEnvironmentVariable:false`, `enableNodeCliInspectArguments:false`, `onlyLoadAppFromAsar:true`, `enableCookieEncryption:true`, `grantFileProtocolExtraPrivileges:false`, `enableEmbeddedAsarIntegrityValidation:false` `[LR]`. | ASAR integrity with electron-builder 26.15.3 on Windows is UNVERIFIED; a packaged app that cannot start is the larger risk for an unsigned per-user v1. Ticket to re-test after v1. | simplicity 11 |
| A20 | **Default provider = Local. Cloud providers need a versioned blocking consent record** (factory throws without it). Payloads carry role labels only - no names, numbers or JIDs. Gemini always `store:false`. Never silent fallback from one provider to another. | Privacy; third-party messages. | security C-40 |
| A21 | **Local models**: Gemma 4 family only (one prompt style): E2B-it Q4_K_M / E4B-it Q4_K_M / 12B-it QAT UD-Q4_K_XL, pinned by HF commit + size + sha256 (section 17). No executable is ever downloaded at runtime. | Best Hebrew evidence, Apache-2.0, not gated. | research local-model-* |
| A22 | **Capability separation by construction**: `compose.ts` is the only place that constructs `BridgeSendClient` and `McpWriteClient` and passes them to `ActionExecutor`. ESLint `no-restricted-imports` + a vitest import-graph test make violations a build failure. `[R2]` The raw MCP caller never leaves `mcp/host.ts`: `McpHost.callerFor('read' | 'write' | 'admin')` returns a wrapper that asserts the tool's class at run time (throws + audits `tool_blocked`) and is typed `McpToolCaller<'read'>` etc., so a read facade calling `create-event` is both a compile error and a runtime block (`tool-gate.test.ts`). | Catches mistakes (not malice) with zero new dependencies. | safety 6.4 (dependency-cruiser dropped) |
| A23 | **No telemetry, no crash reporter, no auto-updater, no code signing in v1.** NSIS one-click per-user x64 installer. | Out of scope; disclosed in section 19. | all |

---

## 2. The seven invariants (each has a named test in `tests/security/`)

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I1 | No WhatsApp send and no calendar write without a per-action user click | only `ActionExecutor` holds send/write clients; `trg_actions_state` | import-graph test; obedient-attacker LLM over the injection corpus -> fake bridge and fake MCP record zero writes |
| I2 | The LLM can reach only READ calendar tools with app-pinned arguments | `ToolGate` default-deny + `McpReadClient` facade with no write method | fake provider emits every write/unknown/case-variant tool name -> all blocked + audited |
| I3 | Send recipient = chat of the trigger message, never model- or renderer-supplied | `actions.chat_id` set at proposal time; executor re-derives JID; strict DM regex; `.strict()` zod on IPC | forged IPC with extra `chatJid` field rejected |
| I4 | Untrusted text never enters the system prompt or tool definitions | `buildSystemPrompt({nowIso,tz,replyLang,userGender})` typed + regex-validated; tool defs are compile-time constants | property test: byte-identical output for random untrusted inputs |
| I5 | One chat per LLM context; cloud payloads carry no names/numbers/JIDs | `ContextBuilder(chatId)`; `minimize()` before every provider | payload snapshot test per provider |
| I6 | The bridge can never touch the user's live store, port 8080 or the default webhook/outbox | `assertBridgeSpawnInvariants()` | one unit test per violated precondition |
| I7 | A crash of any child never takes down the tray app and never duplicates a side effect | separate OS processes + supervisor; write-ahead action log; deterministic `eventId` derived from the **retry-chain root AND the approved content** (`[R3]` `eventIdFor(itemId:create_event:version, {title,start,end,tz,location})`: identical for every UNEDITED retry clone, so Google answers 409 for an event that was already created; a retry the user EDITED gets a fresh id, so the corrected slot is really written - see T-401 for the residual) | kill tests against fake children; "crash between executing and done" test; `[R2]` "unknown_outcome -> reconcile fails -> Add again -> same eventId -> exactly one event" |

Trust/taint rule: `TRUSTED` = app constants, system prompt, app-authored tool definitions, user settings, user clicks/edits. `UNTRUSTED` = message text, quoted text, push/contact names, filenames, calendar event text, MCP tool descriptions and results, all child stdout, **and every LLM output** (forever; persistence does not promote it). UNTRUSTED data may appear only (a) inside the nonce-delimited JSON data block of a user-role message, (b) inside projected tool results, (c) in the renderer as inert text inside a visually distinct quoted bubble. Never in app chrome, banners, toasts, tray tooltip, window title, system prompt, tool definitions, log lines or `shell.openExternal`.

---

## 3. Process model

```
                                Windows 11 user session
+------------------------------------------------------------------------------------------+
| Electron MAIN  (ESM, Electron 44.4.3 / Node 24.21)  - the only process with secrets/power |
|                                                                                          |
|  lifecycle | tray | window | app:// protocol+CSP | i18n(main) | IPC router (sender+zod)  |
|  Db (node:sqlite app.db, WAL)      secrets (safeStorage/DPAPI)      HealthHub (AppHealth) |
|  Supervisor x3 + Reaper (PID files)                                                       |
|  Bridge: launcher/invariants | BridgeReadClient | Doorbell 127.0.0.1:<rand>/hook/<secret> |
|          BridgeDb (messages.db READ-ONLY) -> Ingest (rowid watermark)                     |
|  Agent:  TriageQueue(1) -> S0 filter -> S1 extract -> S2 resolve -> S3 draft -> S4 validate|
|          ToolGate -> McpReadClient                                                        |
|  Exec:   ActionExecutor  -> BridgeSendClient (/api/send) | McpWriteClient (create-event)  |
|  LLM:    LlmProvider { local | claude | gemini }  + ModelManager (hw probe, downloader)   |
+------+-----------------+----------------------+---------------------+---------------------+
       | IPC             | spawn, REST+Bearer,  | spawn, stdio        | spawn, HTTP+API key | HTTPS (consent)
       | allow-listed    | doorbell, ro SQLite  | MCP JSON-RPC        | OpenAI-compatible   |
       v                 v                      v                     v                     v
+--------------+ +---------------------+ +-----------------------+ +--------------------+  api.anthropic.com
| RENDERER     | | whatsapp-bridge.exe | | calendar MCP server   | | llama-server.exe   |  generativelanguage
| sandbox,     | | pinned SHA-256      | | @cocal/google-        | | llama.cpp b10964   |  .googleapis.com
| ctxIsolation | | cwd=<userData>\     | | calendar-mcp@2.6.3    | | Vulkan x64         |
| React 19     | |   bridge            | | process.execPath +    | | LAZY: provider =   |
| app://bundle | | 127.0.0.1:<rand>    | | ELECTRON_RUN_AS_NODE=1| | Local AND work     |
| CSP connect- | | per-launch token    | | started when Google   | | queued; idle sleep |
| src 'none'   | | ALWAYS running      | | credentials exist     | | 600 s              |
+--------------+ +---------------------+ +----------+------------+ +--------------------+
                                                    | googleapis (the ONLY path to Google Calendar;
                                                    v  app code contains no Google REST call)
                                             Google Calendar API
```

| Process | Started | Holds | Crash effect | Restart policy |
|---|---|---|---|---|
| Main | app start / autostart `--hidden` | decrypted API keys (memory only), bridge token, doorbell secret, llama API key, `app.db` | children become orphans, reaped at next start | - |
| Renderer | window create | display data only; opaque `itemId`/`actionId`/`chatRef`; never secrets, ports, paths, JIDs-as-identifiers | window reload; main state intact | `render-process-gone` -> recreate window |
| Bridge | after ToS disclosure accepted | WhatsApp session in its own `store\` | `whatsapp` health = offline; sends disabled; ingest catches up by watermark | backoff 2/5/15/60 s; breaker 5 exits / 10 min |
| Calendar MCP | when `<userData>\google\gcp-oauth.keys.json` exists | Google OAuth tokens (plain file, required by the server) | event proposals/approvals disabled with reason; drafts continue | backoff 2/10/60 s; breaker 3 / 10 min |
| llama-server | first queued Local run with a verified GGUF | model in RAM/VRAM | item stays `analysis='queued'`, retried once; then CPU fallback; then breaker | max 3 / 10 min |

Rules:

- Main is ESM (`"type":"module"`); `protocol.registerSchemesAsPrivileged` and `requestSingleInstanceLock` run at module top level before any `await`. Preload is CJS (`out/preload/index.cjs`), sandboxed, dependency-free, with a literal channel allow-list.
- Only `src/main/index.ts`, `compose.ts`, `app/**`, `ipc/register.ts`, `secrets.ts` import `electron`. Everything else takes dependencies by injection and runs in plain Node 24 under vitest.
- `node:sqlite` is synchronous on the main thread: every query is an indexed point/range read; dev-mode warning when a statement exceeds 20 ms. GGUF and exe hashing are **streamed** (`createReadStream` 1 MiB chunks -> `crypto.createHash`), never `readFileSync`.
- Children are killed **by PID only** (never by image name - the user's other bridge uses the same image). Shutdown path for all children is a hard kill (`child.kill()`, then `taskkill /PID <pid> /T /F` after the grace period).

---

## 4. WhatsApp bridge integration

### 4.1 Files
- Exe: `<resources>\bridge\whatsapp-bridge.exe` (43,540,541 bytes, SHA-256 `AC23221E8BCF3937A4CA346B3BD80A8DA09DF94CBECD949AF2916C4BC8D22FF5`), MIT `LICENSE` next to it (`[R2]` copied from the **repository root** `C:\Users\ilay1\Documents\minime\whatsapp-mcp\LICENSE` - the `whatsapp-bridge\` folder itself holds no LICENSE/README, and it holds other `*.exe` files that must never be globbed). Go source vendored in `vendor/whatsapp-bridge-src/` for reference only (never built, never packaged).
- Intake: `scripts/import-bridge.mjs` copies **exactly one file by exact path** into `resources/bridge/`, verifies the SHA-256 and refuses otherwise. It never enumerates the source folder, never touches `store\`, never executes the exe. Run by the user or an explicitly user-approved step. Build and test agents NEVER execute the exe; all tests use `tests/fakes/fake-bridge.ts`.
- Runtime cwd: `<userData>\bridge\` (the bridge creates `store\{whatsapp.db,messages.db,<jid>\}` itself). Outbox: `<userData>\bridge\outbox-empty\`, created by the app, never written to.

### 4.2 Spawn contract
```
exe   : <resources>\bridge\whatsapp-bridge.exe      args: []   (NEVER --full-history-pair)
cwd   : <userData>\bridge                            shell:false  windowsHide:true  stdio:['ignore','pipe','pipe']
env   : WHATSAPP_BRIDGE_PORT  = free ephemeral port (listen :0 on 127.0.0.1, close, reuse); never 8080
        WHATSAPP_BRIDGE_TOKEN = crypto.randomBytes(32).toString('hex')   new on EVERY launch, memory only
        WEBHOOK_URL           = http://127.0.0.1:<doorbellPort>/hook/<32-byte base64url secret, per launch>
        FORWARD_SELF          = true
        WHATSAPP_MEDIA_ROOTS  = <userData>\bridge\outbox-empty
        + minimal OS env only: SystemRoot, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA   (never process.env wholesale)
```
`assertBridgeSpawnInvariants()` (A15) runs before every spawn; any failure => no spawn, `ErrorCode` `BRIDGE_SPAWN_REFUSED` / `BRIDGE_BINARY_BLOCKED`, audit row.

Readiness `[R2]`: the stdout hint `Starting REST API server on 127.0.0.1:<port>` only starts the readiness poll early; the authoritative readiness signal is `GET /api/pairing/status` answering `200` to our bearer at `http://127.0.0.1:<port>` (`redirect:'error'`, 15 s; polled every 500 ms from spawn, 10 s budget). No answer within the budget, or the child exiting => kill + fresh port (max 3) **without having sent the token** to anything that answered `401/403` (a foreign listener => kill, new port).

### 4.3 Host state machine
```
STOPPED -> spawn -> STARTING (pairing/status answers 200 to OUR token within 10 s)
STARTING -> qr_pending  => NEEDS_PAIRING (main fetches qr.png -> data: URL; refetch when expires_at changes; poll 1.5 s)
STARTING -> connected   => ONLINE
NEEDS_PAIRING -> connected => ONLINE   ([R2] EVERY time it follows a QR scan: meta.paired_at = now; live_from_ts recomputed; scan; then ingest.resolveLidChats())
NEEDS_PAIRING -> timeout|error => UI "Show new code" => kill + respawn
ONLINE: GET /api/health every 20 s; 503 => RECONNECTING (bridge self-heals); 10 min of 503 => kill + respawn
ONLINE -> anything else, and app quit: meta.last_online_ts = now   ([R2] backlog gate, A14)
any 'exit' while not stopping (exit code is always 0) => crash => backoff respawn with fresh port+token
pairing/status = {status:'error', message ~ /logged out/i}  => LOGGED_OUT: stop; user clicks "Re-link" => delete ONLY <userData>\bridge\store\whatsapp.db => respawn
breaker open (5 exits / 10 min, or 3 readiness failures) => terminal; ErrorCode = BRIDGE_OUTDATED when the last annotation hint within 60 s was
   `client_outdated`, else BRIDGE_CRASH_LOOP; no respawn loop (no runtime exe download, ever); "Try again" resets the breaker
```
`[R2]` **No stdout line ever causes a stop, kill, respawn, re-link or terminal state on its own.** The old rows `stdout "Device logged out" => stop` and `stdout "Client outdated" => terminal` are withdrawn: the bridge echoes every incoming message verbatim to stdout, so a contact could type those strings.

### 4.4 Stdout `[R2]`
Decode UTF-8, strip ANSI, split into lines (keep the partial tail), and match the marker table of `bridge-contract.md` section 9 **only at the start of a line that does not begin with the message-echo prefix** `[YYYY-MM-DD HH:MM:SS] ` (`MESSAGE_ECHO_RE`; whatsmeow's own `HH:MM:SS.fff [Client INFO] ` prefix is skipped before matching). Markers are **hints** only: `rest_starting` (start the readiness poll), `qr_phase` (poll pairing/status now), `history_sync_done` (`ingest.poke()`, ends the "syncing" window of A14), `token_banner`/`invalid_port`/`token_too_short` (accepted only while STARTING with no REST answer yet => audit `spawn_refused` + stop). `client_outdated`, `rest_error`, `unstable`, `stream_replaced` are **annotations** that only select the `ErrorCode` when the health probe/breaker later decides. **Raw bridge stdout is never persisted or displayed** (it contains message bodies and numbers); only marker names reach the log. Security test: a message whose text equals each marker string produces no state change (`bridge-lifecycle.test.ts`, injection corpus vector `stdout_marker`).

### 4.5 Doorbell
`http.createServer` on `127.0.0.1:0`, `exclusive:true`; `[R2]` `server.requestTimeout = 5_000`, `headersTimeout = 2_000`, `maxHeadersCount = 32`. Accept only `POST`, remote `127.0.0.1`, `Host: 127.0.0.1:<port>`, path `=== /hook/<secret>` and `X-Bridge-Token === token` (both constant-time), no `Origin` header. Everything else: `res.writeHead(404); res.end(); req.socket.destroy()` **without reading the body**. Accept path: **answer `200` immediately**, call `ingest.poke()` synchronously (250 ms trailing debounce), then `req.resume()` to discard the body (20 MB cap and a 10 s drain timeout, both destroy the socket; the drain is never awaited) - the body is **never parsed**, so image base64 never enters the app. Intake limiter 30 req/s. Test: a 25 MB body on a wrong path is cut off after the headers (`bytesDrained < 64 KB`).

### 4.6 Ingest (the only reader of `messages.db`)
1. Open `<userData>\bridge\store\messages.db` with `new DatabaseSync(p,{readOnly:true})`, `PRAGMA query_only=1`, `busy_timeout=2000`; short reads; retry on `SQLITE_BUSY` at the next trigger; never change the journal mode; never add indexes. File missing => return.
2. `SELECT rowid,id,chat_jid,sender,content,timestamp,is_from_me,media_type,deleted_at FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 500`, loop; `?` = `meta.bridge_rowid_watermark`. If `max(rowid) < watermark` (store was wiped) reset the watermark to 0 (the backlog gate prevents re-triage).
3. Per row, in TypeScript (no SQL date math): keep only DM JIDs (`^[0-9]{5,20}@s\.whatsapp\.net$` or `^[0-9]+@lid$`); drop `media_type='reaction'`, empty content, `deleted_at` rows. `parseBridgeTs()` accepts the go-sqlite3 text form `YYYY-MM-DD HH:MM:SS[.f{1,9}][+HH:MM|-HH:MM|Z]` (`[R2]` 1-9 fractional digits truncated to ms - `time.Now()` rows look like `2026-09-21 20:15:03.123456789+03:00`), RFC 3339 and integer epoch s/ms; unparseable => treated as backlog and counted; **>= 20 consecutive unparseable rows => health error `BRIDGE_TS_FORMAT`** (so a wrong format assumption can never fail silently). Live/context classification per A14 `[R2]`: `ts < live_from_ts` => context-only; while the bridge is (re)syncing history (spawn until the first `history_sync_done` hint, max 120 s) or before it has ever been ONLINE, `now - ts > 24 h` => context-only; otherwise `now - ts <= 7 d` => live trigger, older => raw card with badge `older_message`, no LLM run.
4. Group by chat; `[R2]` resolve `@lid` JIDs to the phone JID through `BridgeDb.phoneJidForLid()` (read-only lookup of the bridge's own LID mapping) and key the chat on the phone JID when a mapping exists (`repos.chats.mergeLidInto` merges an older `@lid` row and its items); upsert `chats` (name from the bridge `chats.name`, UNTRUSTED; `sendable` = phone JID; `is_known` = `BridgeDb.userHasSentIn(jid)` OR'ed over both JID forms, where `userHasSentIn` = `EXISTS(SELECT 1 FROM messages WHERE chat_jid=? AND is_from_me=1 AND (media_type IS NULL OR media_type <> 'reaction') AND content <> '' AND deleted_at IS NULL)` via `idx_messages_chat_jid` - an own reaction, empty or deleted row never makes a chat known). `ingest.resolveLidChats()` re-runs the resolution for every stored `@lid` chat on each bridge ONLINE transition (the bridge rewrites LID chats to phone JIDs at startup, so chat JIDs may change between runs).
5. Newest live row of the chat is **outbound** (`is_from_me=1`): if it matches an `executing`/`done` send of that chat (same text, <= 120 s) record `wa_msg_id` on the action; otherwise the user answered from the phone: open item `reply_state='answered_elsewhere'`, pending `send_reply` superseded; the item closes unless an event approval is still pending. Own messages never trigger a run.
6. Newest live row is **inbound** and passes S0 (section 6.1): create/touch the open item and enqueue the chat in `triage_queue` with `due_at = now + 20 s` (trailing debounce, 60 s hard cap). `[R2]` When a **new** open item is created for a chat, the same transaction supersedes every pending `send_reply` of that chat's non-open items (`repos.actions.supersedePendingRepliesOfChat`) so at most one approvable draft exists per chat; the `in_calendar` card drops its "Reply not sent yet" affordance.
7. Persist the new watermark in the same app-DB transaction as steps 4-6.

Media janitor (hourly): delete files older than 7 days under `<userData>\bridge\store\<jid-dir>\` only; never `*.db`, never dot-files, never files in the `store\` root; path-prefix assertion before every delete. The app does not use media.

---

## 5. Calendar through MCP

### 5.1 Host
```ts
new StdioClientTransport({
  command: process.execPath,
  args: [<mcpRoot>/node_modules/@cocal/google-calendar-mcp/build/index.js, 'start', '--transport', 'stdio'],
  cwd: <mcpRoot>, stderr: 'pipe',
  env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production',
         GOOGLE_OAUTH_CREDENTIALS: <userData>\google\gcp-oauth.keys.json,
         GOOGLE_CALENDAR_MCP_TOKEN_PATH: <userData>\google\tokens.json,
         GOOGLE_ACCOUNT_MODE: 'personal',
         ENABLED_TOOLS: 'get-current-time,get-freebusy,list-events,list-calendars,create-event,manage-accounts' } })
```
`<mcpRoot>` = `<resources>\calendar-mcp` (packaged) or `build-resources/calendar-mcp` (dev). Never API keys or the bridge token in this env. stderr goes through the redactor (`code=`, `access_token`, `refresh_token`, `client_secret`).

Startup contract (fail closed, `ErrorCode CAL_TOOLSET_MISMATCH`): `tools/list` names must equal the six names above exactly; the three READ tools must carry `readOnlyHint:true` (an extra closed gate, never the classifier); required fields of our app-authored schemas must exist in the server's `inputSchema`.

### 5.2 Three client facades (the raw MCP `Client` is module-private to `mcp/host.ts`)
```ts
McpReadClient  { getCurrentTime(), getFreeBusy(PinnedWindow), findAppEvent(chainRootId, PinnedWindow) }   // ToolGate + executor conflict check + reconcile
McpWriteClient { createEvent(CreateEventArgs) }                                               // constructed in compose.ts, handed ONLY to ActionExecutor
McpAdminClient { manageAccounts(...), listCalendars() }                                       // GoogleAuthService (wizard/settings) ONLY
// [R2] compose.ts: createMcpReadClient(host.callerFor('read')), createMcpWriteClient(host.callerFor('write')), createMcpAdminClient(host.callerFor('admin'))
//      callerFor(cls) is the ONLY exit from host.ts; the wrapper asserts MCP_TOOLS[tool] === cls at run time and is typed McpToolCaller<cls>.
```

### 5.3 READ: what the active LLM sees (identical for Local / Claude / Gemini)

Compile-time constants in `src/main/agent/toolDefs.ts`; app-authored names, descriptions and schemas in the lowest-common-denominator subset (`type`, `properties`, `required`, `enum`, `additionalProperties:false`; no `$ref`, no `anyOf`, no type arrays, no `minLength/maximum`). LLM-facing names use underscores `[LR]` (dash acceptance differs per backend); one static map, no per-provider shim.

| LLM-facing tool | MCP tool | LLM args | Max calls/run | Exposed when | Result projection |
|---|---|---|---|---|---|
| `get_current_time` | `get-current-time` | `{}` | 1 | calendar connected | `{nowIso, timeZone}` |
| `get_freebusy` | `get-freebusy` | `{timeMin, timeMax}` (local ISO) | 3 | calendar connected | `[{start,end}]` busy blocks, no titles |
| ~~`list_events`~~ | - | - | - | `[R2]` **cut from v1** together with `settings.calendar.shareTitlesWithAi`: the only tool that could ship calendar titles to a cloud provider, serving a default-off setting. `list-events` stays enabled at the MCP server for the app-side reconcile only (`findAppEvent`, unreachable from ToolGate). | - |

```
provider.chat() -> toolCalls -> ToolGate.invoke(name, rawArgs, runCtx)
   1 name in READ table and exposed?     no -> audit 'tool_blocked' + synthetic {"error":"tool not available"}; 2 strikes -> abort run, badge 'manipulation'
   2 per-run budget left?
   3 constrainReadArgs: zod .strict(); app pins calendars/calendarId (settings), timeZone (settings), account='personal';
                        clamps timeMin >= now, window <= 14 days, horizon <= 60 days. No free-text query exists.
   4 McpReadClient call
   5 project(result); unparseable -> {"error":"unavailable"}   (raw server text never reaches a model)
   6 wrap in nonce data block -> tool result message
```
Tool calls from a `max_tokens` or `refusal` turn are never executed. If the calendar is not connected the tools are simply not offered and triage still works (drafts only).

### 5.4 WRITE: propose -> user approves -> app executes
`McpWriteClient.createEvent(toCreateEventArgs(validatedEvent, settings))` with an explicit field whitelist - nothing is spread from model output:

`calendarId` (settings, default `primary`), `account:'personal'`, `summary` (<= 80 chars, single line, URLs stripped), `start`, `end` (`YYYY-MM-DDTHH:mm:ss`), `timeZone` (IANA, settings), `location?` (<= 120), `description` = fixed app template (never model text, no contact name), `sendUpdates:'none'`, `allowDuplicates:false`, `eventId` = first 32 chars of lowercase base32hex(`sha256(chainKey)`) where `[R2]` `chainKey = itemId:create_event:version` = the idempotency key **without** the retry suffix, identical for the first action and every retry clone (so "Add again" after an unconfirmed outcome re-sends the same id and Google answers 409 `id_exists`, which the executor records as `done` and reconciles - a retry can never create a second event), `extendedProperties.private = {waAgent:'1', waItem:<itemId>, waAction:<chain-root actionId>}`. **Never**: attendees, recurrence, conferenceData, attachments, reminders, colorId, source, visibility, `calendarsToCheck` `[LR]` (server-side conflict behaviour is UNVERIFIED; the executor does its own check).

Before the call the executor re-runs event sanity checks and a fresh app-side `getFreeBusy`; busy => result `needs_confirm_conflict` => one more explicit click (`confirmConflict:true`). Any MCP error => `failed(error_code)`; a duplicate-detection response => `CAL_DUPLICATE` with "Create anyway" as a **new** click (`allowDuplicates:true`). `[R2]` The `conflict` badge itself is computed by the app-side free/busy prefetch in **S2** whenever a complete slot exists and the calendar is connected - independent of `needsReply` - so a "confirmation" item (contact agrees to the user's slot) shows the clash on the card, not only at click time.

---

## 6. End-to-end data flow

```
bridge writes row -> POST doorbell --+
30 s timer / app start / reconnect --+-> Ingest.scan() -> [S0 filter] -> item touched -> triage_queue (debounce 20 s, concurrency 1)
"History sync complete" marker ------+
   -> [S1 EXTRACT  provider.structured(), NO tools]            -> Extraction (zod .strict())
   -> [S2 RESOLVE  TypeScript: dates, sanity, sub-states]      -> ignored | info_missing | needs_reply
   -> [S3 DRAFT    provider.chat() loop, READ tools via ToolGate, terminal plain text]  (skipped when no reply is needed)
   -> [S4 VALIDATE deterministic checks, badges]               -> proposals row + actions rows (state=pending), one transaction
   -> dashboard:changed -> card -> user click -> action:approve -> [S5 ActionExecutor, no LLM] -> bridge /api/send | MCP create-event
```

### 6.1 S0 deterministic filter (no LLM), in order
1. Non-DM JID, reaction, empty, deleted, `from_me` => never a trigger (4.6).
2. Backlog (A14) => context only.
3. Chat policy `never` => no item. (`[R2]` the `local_only` policy and `hold_reason='local_only'` are cut from v1.)
4. Unknown sender (A13) and not `force_known` => item `analysis='held'`, `hold_reason='unknown_sender'` (raw card + "Analyse this chat").
5. Agent paused => `held/paused`. No usable provider (model downloading, key missing, consent missing) => `held/waiting_llm`. LLM budgets exhausted (6 runs/h per chat, 60 runs/h global, cloud daily token budget) => `held/budget`. `[R2]` Release of `held/waiting_llm` items when a **cloud** provider becomes usable is limited to items whose `trigger_ts` is within the last 24 h (`LIMITS.heldReleaseWindowMs`); older ones stay raw cards with "Analyse this chat" (the consent text describes the chat being analysed, not a week of backlog). Release to the Local provider is unrestricted.
6. Open item has `editing_until > now` (edit-lock) => the queue row is deferred until the lock ends.
7. Otherwise `analysis='queued'`.

Visibility rule (avoids flicker and an empty dashboard): items with `analysis IN ('queued','running')` are **not** listed; the "Needs reply" header shows "Analysing N chats..." from `AppHealth.queue`. Items with `analysis IN ('held','failed')` are listed as **raw cards** (quoted message, empty editable reply box, Send/Copy, reason chip) so the app stays useful when the LLM is unavailable.

### 6.2 S1 EXTRACT
Context = last 12 messages / 6,000 chars of this one chat read live from the bridge DB, each `sanitizeForModel()` (NFKC; strip Unicode TAG block, bidi controls, zero-width, C0) and cut to 2,000 chars, role labels `contact` / `me`, JSON-encoded inside `<<DATA-nonce>>` markers in a user-role message. The same rows are snapshotted into `item_messages`. The user message also carries a TypeScript-computed 14-day table (`2026-09-24 | Thursday | yom chamishi in Hebrew script`) for `settings.general.timeZone` (default `Asia/Jerusalem`, week starts Sunday).

System prompt = constant English string (static prefix first, for prompt caching) + trusted interpolations only. It includes 3-4 Hebrew-slang few-shot examples (constants).

Output schema - flat, no nulls, no unions (identical JSON Schema for all providers; ranges enforced by zod afterwards because Claude structured outputs reject `minimum/maxLength`):
```ts
// src/shared/schemas.ts
Extraction = {
  intent: 'schedule_request'|'reschedule'|'cancel'|'confirmation'|'question'|'smalltalk'|'other',
  needsReply: boolean,
  title: string,                 // '' = none; <= 80
  dateKind: 'none'|'absolute'|'weekday'|'relative_days',
  isoDate: string,               // '' or YYYY-MM-DD (must be explicit in the text)
  weekday: number,               // 0..6, 0 = Sunday; meaningful only for dateKind='weekday'
  weekOffset: number,            // 0..2
  daysFromToday: number,         // 0..60
  time24h: string,               // '' or HH:MM
  timeAmbiguous: boolean,        // hour given without am/pm cue
  durationMin: number,           // 0 = unspecified
  location: string,              // '' = none; <= 120
  missing: ('date'|'time'|'duration'|'location'|'who'|'confirmation')[],
  suspicious: boolean }
```
Deliberately absent: recipient, JID, attendees, calendarId, eventId, sendUpdates, URLs, any approve/auto flag, any draft. No schema-valid output after one repair retry => `analysis='failed'`, `ErrorCode LLM_BAD_OUTPUT`, raw card.

### 6.3 S2 RESOLVE (pure TypeScript, `src/shared/when.ts` + `agent/resolve.ts`)
- The model never does date arithmetic: `resolveWhen()` turns `dateKind/...` into local start/end. Default duration `settings.calendar.defaultDurationMin` (60).
- Ambiguous hour (`timeAmbiguous` and hour 1-7 => PM, 8-11 => AM): assumed + amber badge `time_assumed`, editable on the card (`settings.agent.ambiguousHour='assume'`; the alternative `'ask'` sends the item to "Information missing"). Matches the orchestrator default Q2.
- Sanity: start not in the past, <= 12 months ahead, duration 5 min..12 h. Weekday word in the text contradicting the resolved date => `missing += 'date'`.
- Sub-states: scheduling intent with `missing` non-empty => `event_state='incomplete'`; complete slot => `event_state='proposed'`; `reschedule`/`cancel` => no event action, badge `change_in_google` (+ link if the app created the event); `needsReply=false` and no event => item closed `not_needed`.
- `[R2]` **Free/busy prefetch lives here, not in S3**: whenever the resolved slot is complete and the calendar is connected, `ToolGate.prefetchFreeBusy(slot)` runs (window slot +-2 h, app-pinned, no model budget) and its busy blocks are stored in `proposals.freebusy_json`; S4 derives the `conflict` badge from them and S3 (when it runs) reuses them in its data block.

### 6.4 S3 DRAFT (only when `needsReply`)
Input: the same data block + the extraction/resolved slot (app-generated, still inside the data block) + the S2 **prefetched `get-freebusy` projection** for that slot (same `ToolGate` path), so weak local models need zero tool calls in the common case. Tools remain offered so the model can explore alternatives ("when are you free next week?").

Loop: max 3 model turns with tools + 1 final turn without tools if the 3rd still asks for tools; max 4 tool calls; wall clock 60 s cloud / 240 s local; provider fixed for the whole run. **The terminal text is the draft.** `cleanDraft()`: trim, strip wrapping quotes and a leading "Draft:"-style label, cap 600 chars. Reply language = deterministic Hebrew-vs-Latin script count over the last 5 inbound messages (`detectLanguage`), passed as a directive; optional user gender from settings. `info_missing` items get a draft that asks for exactly the missing pieces.

### 6.5 S4 VALIDATE (deterministic)
URL/domain in the draft not present in the user's own earlier messages => stripped + red badge `link_removed`; phone/e-mail/6+ digit runs/echoed calendar titles => amber `personal_details`; invisible/bidi chars stripped from all outputs; `suspicious`, a blocked tool call, or an injection-heuristic hit => red `manipulation`, draft collapsed behind "show anyway" (advisory only); draft language != chat language => amber `lang_mismatch`; prefetched busy overlaps the slot => amber `conflict`. Then, in one transaction: insert `proposals` (version+1), supersede the item's older pending actions, insert up to two `actions` rows (`send_reply` only if the chat is sendable; `create_event` only if `event_state='proposed'` and the calendar is connected) with `canonical_json`, `content_sha256`, `idempotency_key = itemId:kind:version`, `expires_at = now + 24 h`; set `analysis='done'`.

### 6.6 Approval and execution (S5, no LLM anywhere)
Card: recipient name **and** formatted phone from the app DB (`<bdi dir="ltr">`); quoted trigger message (`dir="auto"`, inert text); draft in a plain `<textarea dir="auto">` - what is in the box at click time is what is sent; event rendered by the app from structured fields (`Intl.DateTimeFormat`, weekday, explicit time zone when not the default, `<bdi>` ranges), inline-editable; badges. **Two buttons = two approvals.** Plus "Copy" and "Dismiss" on every card. No bulk approve, no per-contact auto-approve, no approval from toasts or the tray.

`action:approve {actionId, kind, shownHash, edit?, confirmConflict?, confirmDuplicate?}` in main:
1. trusted sender frame (`app://bundle`, our window's main frame); window visible and focused; zod `.strict()`. `[R2]` Focus-steal guard: an approve arriving < 300 ms after main showed the window from a notification click => `WINDOW_NOT_FOCUSED` (the renderer mirrors it: approval buttons ignore activation for 500 ms after `focus`/`visibilitychange`, and initial focus in the sheet is the close button, never an approval button).
2. `[R2]` synchronously, before the first `await`: `inFlight.has(actionId)` => `ACTION_STALE`; `inFlight.add(actionId)` (removed in `finally`). Then load action; `kind` matches; `state='pending'`; not expired; `sha256(canonical_json) === shownHash`.
3. apply the user edit (TRUSTED, still schema-validated, length-capped, invisible chars stripped) -> `approved_final_json`.
4. rate limits - sends: 1 per 5 s and 6/h per chat, 20/h and 60/day global; creates: 10/h, 30/day.
5. **write-ahead**: `pending -> approved -> executing` committed before the side effect as one transaction of two compare-and-set `UPDATE ... WHERE id=? AND state=?` statements; `[R2]` `changes !== 1` or a trigger abort => `Result.ok=false ACTION_STALE`, nothing else (no `failed`, no clone, no audit `action_failed`) - the concurrent winner's execution is untouched.
6. execute. `send_reply`: the 3-8 s jitter sleep happens **here, after the write-ahead** (never before it); JID re-read via `actions.chat_id`; DM regex; bridge must be ONLINE (approvals never queue for later delivery); `POST /api/send {recipient, message}` and nothing else. `create_event`: section 5.4; MCP `id_exists` (409 on our deterministic id) => `done`.
7. `-> done | failed(error_code) | unknown_outcome`, each a compare-and-set `WHERE state='executing'` (`changes !== 1` is a programming error, audited); audit row; `dashboard:changed`. Failure keeps the card intact with the error line and a Retry (= a new click on a fresh action).

Startup recovery: `analysis='running'` -> `queued`; `actions.state='executing'` -> **`unknown_outcome`, never auto-retried**. Reconcile read-only: sends - look for a matching `is_from_me` row in the bridge DB after `approved_at`; events - `findAppEvent` = `list-events` with `privateExtendedProperty waAction=<chain-root id>` (app-side read). Found => `done`; not found => card says "We could not confirm this - check WhatsApp / your calendar" with an explicit "Send again" / "Add again" (new action, new click; for events the clone re-sends the same `eventId`, so a second event is impossible).

Edit-lock: the renderer sends `item:setEditing {itemId, editing}` on focus/blur of a card's inputs; main sets `items.editing_until = now + 10 min` (cleared on blur/approve). A locked item is not re-triaged, so its `shownHash` stays valid while the user is typing.

---

## 7. Item state machine

`state` is one of the three dashboard lists plus the hidden bucket. It is **derived** by one pure shared function and stored only for indexing.

```ts
// src/shared/state.ts
export function deriveState(i: { analysis: Analysis; replyState: ReplyState; eventState: EventState; closedReason: string|null }): ItemState {
  if (i.closedReason)                 return 'ignored';
  if (i.eventState === 'created')     return 'in_calendar';
  if (i.analysis !== 'done')          return 'needs_reply';      // raw card (listed only when held/failed, see 6.1)
  if (i.eventState === 'incomplete')  return 'info_missing';
  if (i.replyState === 'draft' || i.eventState === 'proposed') return 'needs_reply';
  return 'ignored';
}
```
`analysis`: `queued | running | done | failed | held`. `reply_state`: `none | draft | sent | answered_elsewhere | skipped`. `event_state`: `none | incomplete | proposed | created | declined`. `closed_reason`: `not_needed | replied | answered_elsewhere | dismissed | superseded | expired | past`.

```
inbound live DM --S0--> item(open) --S1..S4--> needs_reply      (draft and/or complete event proposal)
                                          \--> info_missing     (scheduling intent, missing[] not empty; draft = clarifying question;
                                          \                      user may fill the mini-form and press "Add to calendar" without another LLM turn)
                                           \-> ignored          (not_needed)
needs_reply | info_missing --new inbound message--> re-triage SAME item: proposal version+1, older pending actions -> superseded
needs_reply --approve "Add to calendar", create-event OK--> in_calendar      (an unsent draft stays actionable on the card UNTIL a newer open item
                                                                              exists for the same chat: then it is superseded [R2], 4.6 step 6)
any open --reply sent by approval, no event pending--> closed 'replied'
any open --answered from the phone, no event pending--> closed 'answered_elsewhere'
any open --user Dismiss--> closed 'dismissed'      (undo: 6 s toast or the "Undo dismiss" drawer = last 20 dismissed, item:restore [R2])
open > 7 days --janitor--> closed 'expired'          in_calendar --event start + 1 day--> closed 'past'
held/failed --"Analyse this chat" / item:retriage--> queued
```
"Open" = `state IN ('needs_reply','info_missing')` - the partial unique index guarantees one per chat. An `in_calendar` item does not block a new open item for the same chat. Dashboard queries: `WHERE state=? [AND analysis IN ('done','held','failed')] ORDER BY updated_at DESC LIMIT 20`, three times.

---

## 8. LLM provider abstraction

```ts
// src/main/llm/types.ts
export interface LlmTool     { name: string; description: string; inputSchema: JsonSchemaLcd }      // app-authored READ tools only
export interface LlmToolCall { id: string; name: string; input: Record<string, unknown> }
export type LlmMessage =
  | { role: 'system';    content: string }                                                        // only from buildSystemPrompt()
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[]; providerData?: unknown }     // opaque verbatim replay
  | { role: 'tool';      results: { toolCallId: string; name: string; content: string; isError?: boolean }[] };
export interface LlmResponse { text: string; toolCalls: LlmToolCall[];
  stopReason: 'end'|'tool_use'|'max_tokens'|'refusal'|'other'; usage?: { inputTokens: number; outputTokens: number };
  assistantMessage: Extract<LlmMessage, { role: 'assistant' }> }
export interface LlmProvider {
  readonly id: 'local'|'claude'|'gemini';
  structured<T>(messages: LlmMessage[], schema: JsonSchemaLcd, opts: CallOpts): Promise<T>;        // S1: schema-constrained, NO tools
  chat(messages: LlmMessage[], tools: LlmTool[], opts: CallOpts): Promise<LlmResponse>;            // S3: ONE model turn, never executes tools
  validate(signal: AbortSignal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>;
  dispose(): Promise<void>;
}
type CallOpts = { signal: AbortSignal; maxOutputTokens: number; purpose: 'extract'|'draft' };
type ProviderErrorCode = 'auth'|'billing'|'quota_daily'|'rate_limited'|'model_not_found'|'overloaded'|'network'|'aborted'|'bad_output'|'not_ready';
```
Common rules: providers receive no MCP client, no bridge client, no DB; the orchestrator owns the loop; a run finishes on the provider that started it (thought-signature replay); every output is re-validated with zod `.strict()`; no retry for `auth/billing/quota_daily`; keys are decrypted with the async `safeStorage` API when a client is constructed, passed explicitly (stray env vars ignored), never logged, never in URLs, never sent to the renderer. `factory.ts` throws for a cloud provider without a current consent record (`[R2]` "current" = a `consents` row with **exactly** `CONSENT_VERSIONS[kind]`, never `max(version) >=`; the `consent:accept` handler rejects any other version with `BAD_REQUEST`, so a renderer cannot pre-accept future bumps).

`[R2]` **SDK clients are constructed with explicit base URLs** - both SDKs otherwise read `process.env` (`ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`), and on a developer machine such variables commonly point at a proxy: `new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com', maxRetries: 2, timeout: 60_000 })` and `new GoogleGenAI({ apiKey, httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com' } })`; `undefined` is never passed for these. `consent-payload.test.ts` sets `ANTHROPIC_BASE_URL=https://evil.example` / `GOOGLE_GEMINI_BASE_URL=https://evil.example` and asserts the recording SDK doubles see the constants. `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` in the **main** process are an accepted R4 residual (same-user attacker); they are never propagated to any child (bridge/llama/MCP use minimal env blocks).

| | Local | Claude | Gemini |
|---|---|---|---|
| Transport | `fetch` to `http://127.0.0.1:<port>/v1/chat/completions`, `Authorization: Bearer <LLAMA_API_KEY>` (no `openai` SDK) | `@anthropic-ai/sdk@0.127.0`, `client.messages.create`, `maxRetries:2`, `timeout:60_000` | `@google/genai@2.23.0`, `ai.interactions.create`; **`store:false` set in exactly one function + unit test** |
| `structured` | `[R2]` `response_format:{type:'json_schema', json_schema:{name:'extraction', strict:true, schema}}` (OpenAI form - llama-server b10964 reads `response_format.json_schema.schema` and treats an absent schema as "any object", so the old top-level `schema` key gave NO grammar), `temperature:0.1`, no `tools` in the request | `output_config:{format:{type:'json_schema', schema}}` (every object `additionalProperties:false`) | `response_format:{type:'text', mime_type:'application/json', schema}` |
| `chat` | `tools`, `tool_choice:'auto'`, `parallel_tool_calls:false`, sampling from the manifest | `tools:[{name,description,input_schema}]`, `tool_choice:{type:'auto'}`; replay `response.content` verbatim via `providerData`; all tool results in ONE user message | `tools:[{type:'function',...}]`; replay `interaction.steps` verbatim (thought signatures); `function_result` steps |
| Thinking / params | `chat_template_kwargs:{enable_thinking:false}`, server flag `--reasoning-budget 0`, `cache_prompt:true` | never `temperature/top_p/top_k/budget_tokens/prefill`; never `thinking:{type:'disabled'}`; `output_config.effort:'low'` on every model except `claude-haiku-4-5` (errors there); `max_tokens >= 2048` (thinking counts as output) | `generation_config.thinking_level:'low'`; no temperature |
| NEVER | - | SDK tool runner, `mcpTools()`, server-side MCP connector, forced `tool_choice` | `mcpToTool()`, `mcp_server` tool, `store:true`, `previous_interaction_id` |
| Default model | tier manifest (section 17) | **`claude-opus-5`** (Anthropic's "start here" model; user decision U1), dropdown from `client.models.list()` - never a hard-coded list (`claude-haiku-4-5` may retire after 2026-10-15); `[R2]` presets `claude-opus-5`, `claude-sonnet-5` are **ordering hints only**, intersected with the live list before rendering (`claude-haiku-4-5` dropped from the constant) | **`gemini-3.8-flash`**, preset `gemini-3.5-flash-lite` (same intersection rule), id editable, never `-latest` aliases |
| Key check | `GET /health` + self-test | `client.models.retrieve(model)` (free) | `ai.models.get({model})` (free); no key-format regex |
| Activation | default, no consent | consent `cloud_claude` | consent `cloud_gemini` + free-tier training/human-review warning |

Not in v1 `[LR]`: Claude server-side refusal `fallbacks` (forces the beta namespace; TS typing of the scalar form is UNVERIFIED) - `stop_reason:'refusal'` is handled as "could not analyse" (raw card).

---

## 9. Local runtime

- Binary: `https://github.com/ggml-org/llama.cpp/releases/download/b10964/llama-b10964-bin-win-vulkan-x64.zip` (31,674,542 bytes, sha256 `1ee3ad952f4ba71f438bd6d7bebef19e1c7af04adcaa35d08b4ddabb27d4c642`), fetched and verified at **build time** by `scripts/fetch-llama.mjs`. `[R2]` The zip is flat and holds no llama.cpp `LICENSE` (only `LICENSE-LLVM-OpenMP` for `libomp.dll`); `llama-server.exe` is a 9 KB stub that loads `llama-server-impl.dll`. Packaged by **explicit allow-list**, never `*.dll`: `llama-server.exe`, `llama-server-impl.dll`, `llama-common.dll`, `llama.dll`, `mtmd.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-vulkan.dll`, `ggml-cpu-*.dll` (never prune these), `libomp.dll`, `LICENSE-LLVM-OpenMP`; the llama.cpp MIT text is written into `resources/licenses/THIRD_PARTY_NOTICES.txt` from the pinned repo tag.
- `[R2]` **VC++ runtime.** The build is MSVC: `llama-server.exe` imports `VCRUNTIME140.dll`; the impl/ggml DLLs import `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` - not part of Windows 11, not shipped by Electron or the Go bridge. On a PC without the VC++ 2015-2022 x64 Redistributable the process dies at load with exit `0xC0000135` (`-1073741515`) and every retry (`--list-devices`, self-test, `--device none`) fails identically. **Chosen: both layers.** (a) `scripts/fetch-llama.mjs` copies `msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll` app-locally next to `llama-server.exe` when the env var `VC_REDIST_CRT_DIR` points at a `Microsoft.VC143.CRT` folder (Microsoft permits redistributing these files; sha256 pins in `vendor/llama.pin.json`, entry in THIRD_PARTY_NOTICES) and prints a loud warning when it is unset - the build still succeeds. (b) Deterministic pre-flight in `llm/local/hardware.ts`: before the first spawn, the three DLLs must exist app-locally or in `%SystemRoot%\System32`; if not, or when a child exits with `-1073741515`, the health surfaces `ErrorCode LLM_VCREDIST_MISSING`, whose single action opens `https://aka.ms/vs/17/release/vc_redist.x64.exe` (a Microsoft page in the browser; the app never downloads an executable). Release gate V5 runs in Windows Sandbox without the redistributable and must show either a working Local provider (a) or exactly this error (b), never a generic `LLM_LOCAL_FAILED`. `ggml-vulkan.dll` imports `vulkan-1.dll` but is loaded dynamically by ggml, so a missing Vulkan loader degrades to CPU (V5 "start without vulkan-1.dll" is resolved).
- Spawn: `llama-server.exe -m <gguf> --host 127.0.0.1 --port <rand> --jinja --no-webui --offline -c 8192 -np 1 --sleep-idle-seconds 600 --reasoning-budget 0` (+ `--cache-ram 0` when RAM < 16 GiB; + `--device none` after a failed GPU self-test or when acceleration = Off; + `--device VulkanN` when both an iGPU and a dGPU are listed). Key via env `LLAMA_API_KEY` (never argv). Minimal env, `cwd` = bin dir, `shell:false`, args as an array (paths contain spaces/Hebrew). **No `--log-file`** (server logs can contain prompt text); stdout/stderr go through a marker-only filter. `os.setPriority(pid, PRIORITY_BELOW_NORMAL)`.
- Ready = `GET /health` 200 (<= 180 s) then a self-test (fixed prompt through `structured()`, expect known JSON). Garbage/timeout/exit with acceleration Auto => retry once with `--device none` and persist `settings.llm.local.forceCpu=true`. `[R2]` On machines with **no dedicated GPU** the first-run self-test times the fixed prompt twice - once with the default (iGPU via Vulkan) and once with `--device none` (~10 s each) - persists the faster mode in `settings.llm.local.forceCpu` and stores both numbers in `model_files.bench_json` (`{gpuTokPerSec, cpuTokPerSec, chosen}`); Intel/AMD Vulkan drivers can be slow-but-not-failing, and a slow iGPU path must not push the user to a smaller model. Only when the **better** of the two is below 5 tok/s does the UI *suggest* (never auto-switch) a smaller tier.
- Stopped immediately when the user switches to a cloud provider, and on quit.
- Hardware probe: `os.totalmem()`, `fs.statfs` free disk, tolerant parser of `llama-server.exe --list-devices`; a device counts as dedicated only when its name matches a discrete-GPU pattern (NVIDIA GeForce/RTX/GTX/Quadro, AMD Radeon RX/Pro, Intel Arc A/B-series); integrated-GPU shared memory is never counted; parse failure => "no GPU" `[LR]`.
- Downloader (own, ~150 lines): HTTPS only; always request `https://huggingface.co/<repo>/resolve/<commit>/<file>` on every (re)try (signed CDN redirects expire); `redirect:'manual'`, **one hop max**, `[R2]` accepting only `https://` redirect targets whose hostname is `huggingface.co` or ends with `.hf.co` / `.huggingface.co` (a suffix rule, not exact hosts: Hugging Face picks the CDN host by region and backend - `us.aws.cdn.hf.co`, `cas-bridge.xethub.hf.co`, `cdn-lfs-us-1.hf.co`, `cdn-lfs.hf.co` have all been observed; the sha256 pin is the real integrity check), and using the 302's `X-Linked-Size` / `X-Linked-ETag` headers as an early size/sha sanity check before streaming; `Range` resume into `<userData>\models\<file>.part` + sidecar; free-disk check (`size + 5 %`); GGUF magic check; full streamed sha256 against the compile-time pin; atomic rename; mismatch => delete + one automatic re-download. Progress (bytes, speed, ETA) pushed over `model:progress` at 4 Hz. Re-hash only when size/mtime changed.

---

## 10. App database (`<userData>\app.db`, `node:sqlite`, WAL)

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;       -- migrations: PRAGMA user_version + ordered SQL strings

CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- paired_at, live_from_ts, bridge_rowid_watermark, onboarding_step, tray_hint_seen, last_backup_at, last_online_ts [R2]
CREATE TABLE settings  (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);   -- one row 'settings', zod-validated on read
CREATE TABLE secrets   (name TEXT PRIMARY KEY CHECK(name IN ('anthropic_api_key','gemini_api_key')),
                        ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);                          -- safeStorage (DPAPI) ciphertext only
CREATE TABLE consents  (kind TEXT NOT NULL CHECK(kind IN ('whatsapp_tos','cloud_claude','cloud_gemini')),
                        version INTEGER NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY(kind, version));

CREATE TABLE chats     (id INTEGER PRIMARY KEY, jid TEXT NOT NULL UNIQUE, display_name TEXT,            -- display_name is UNTRUSTED
                        is_known INTEGER NOT NULL DEFAULT 0, force_known INTEGER NOT NULL DEFAULT 0,
                        sendable INTEGER NOT NULL DEFAULT 0,
                        policy TEXT NOT NULL DEFAULT 'default' CHECK(policy IN ('default','never')),                  -- [R2] local_only cut
                        lang TEXT CHECK(lang IN ('he','en')), last_inbound_ts INTEGER, last_outbound_ts INTEGER,
                        last_triaged_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE items     (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id),
                        state TEXT NOT NULL CHECK(state IN ('needs_reply','info_missing','in_calendar','ignored')),   -- = deriveState()
                        analysis TEXT NOT NULL DEFAULT 'queued' CHECK(analysis IN ('queued','running','done','failed','held')),
                        hold_reason TEXT,            -- unknown_sender | paused | waiting_llm | budget      ([R2] local_only cut)
                        error_code TEXT,             -- ErrorCode when analysis='failed'
                        reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state IN ('none','draft','sent','answered_elsewhere','skipped')),
                        event_state TEXT NOT NULL DEFAULT 'none' CHECK(event_state IN ('none','incomplete','proposed','created','declined')),
                        trigger_msg_id TEXT NOT NULL, trigger_ts INTEGER NOT NULL,
                        missing_json TEXT NOT NULL DEFAULT '[]', badges_json TEXT NOT NULL DEFAULT '[]',
                        current_proposal_id INTEGER, editing_until INTEGER NOT NULL DEFAULT 0,
                        calendar_event_id TEXT, calendar_html_link TEXT, event_start_ts INTEGER,
                        closed_reason TEXT, closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX ux_items_open ON items(chat_id) WHERE state IN ('needs_reply','info_missing');
CREATE INDEX ix_items_list ON items(state, updated_at DESC);

CREATE TABLE item_messages (item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,            -- snapshot of the context window (<= 12 rows)
                        wa_msg_id TEXT NOT NULL, from_me INTEGER NOT NULL, ts INTEGER NOT NULL,
                        text TEXT, text_sha256 TEXT NOT NULL,                                            -- text nulled by retention, hash kept
                        PRIMARY KEY(item_id, wa_msg_id));

CREATE TABLE triage_queue (chat_id INTEGER PRIMARY KEY REFERENCES chats(id), due_at INTEGER NOT NULL,
                        first_enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);

CREATE TABLE runs      (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), stage TEXT NOT NULL CHECK(stage IN ('extract','draft')),
                        provider TEXT NOT NULL, model TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
                        outcome TEXT, input_tokens INTEGER, output_tokens INTEGER,
                        tool_calls INTEGER NOT NULL DEFAULT 0, blocked_tool_calls INTEGER NOT NULL DEFAULT 0, error_code TEXT);
                        -- metadata only: no prompts, no completions

CREATE TABLE proposals (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), version INTEGER NOT NULL,
                        provider TEXT NOT NULL, model TEXT NOT NULL, extraction_json TEXT NOT NULL,
                        draft_text TEXT, reply_lang TEXT, event_json TEXT,    -- {title,startLocal,endLocal,timeZone,location,assumptions[]}
                        freebusy_json TEXT, suspicious INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL, superseded_at INTEGER, UNIQUE(item_id, version));

CREATE TABLE actions   (id TEXT PRIMARY KEY,                                  -- uuid v4: the only handle the renderer gets
                        item_id INTEGER NOT NULL REFERENCES items(id), proposal_id INTEGER NOT NULL REFERENCES proposals(id),
                        chat_id INTEGER NOT NULL REFERENCES chats(id),        -- recipient pinned here
                        kind TEXT NOT NULL CHECK(kind IN ('send_reply','create_event')),
                        canonical_json TEXT, content_sha256 TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,   -- [R2] canonical_json nullable ONLY for retention on terminal rows
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
                          ('pending','approved','executing','done','failed','unknown_outcome','rejected','expired','superseded')),
                        approved_at INTEGER, approved_final_json TEXT, executed_at INTEGER, result_json TEXT, error_code TEXT,
                        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- [R2] Hardened trigger set (binding text = contracts.md 15.2): 'failed' is terminal; nothing returns to 'pending'; approved/executing need
-- approved_final_json; failed/unknown_outcome only from executing; rejected only from pending; expired/superseded only from pending/unknown_outcome.
CREATE TRIGGER trg_actions_state BEFORE UPDATE OF state ON actions WHEN NEW.state <> OLD.state BEGIN
  SELECT CASE
    WHEN OLD.state IN ('done','failed','rejected','expired','superseded') THEN RAISE(ABORT,'terminal state')
    WHEN NEW.state='pending'   THEN RAISE(ABORT,'cannot return to pending')
    WHEN NEW.state='approved'  AND (OLD.state<>'pending' OR NEW.approved_at IS NULL OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'bad approve')
    WHEN NEW.state='executing' AND (OLD.state<>'approved' OR NEW.approved_final_json IS NULL) THEN RAISE(ABORT,'execute without approval')
    WHEN NEW.state='done'      AND OLD.state NOT IN ('executing','unknown_outcome') THEN RAISE(ABORT,'bad done')
    WHEN NEW.state IN ('failed','unknown_outcome') AND OLD.state<>'executing' THEN RAISE(ABORT,'bad outcome')
    WHEN NEW.state='rejected'  AND OLD.state<>'pending' THEN RAISE(ABORT,'bad reject')
    WHEN NEW.state IN ('expired','superseded') AND OLD.state NOT IN ('pending','unknown_outcome') THEN RAISE(ABORT,'bad close')
  END; END;
-- plus trg_actions_insert (born pending, with content), trg_actions_frozen (content columns immutable except retention NULLing on terminal rows)
-- and trg_actions_final_frozen (approved_final_json immutable once past 'approved', same retention exception) - see contracts.md 15.2.

CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT, detail_json TEXT NOT NULL);
  -- kinds: tool_blocked, action_approved, action_done, action_failed, consent, spawn_refused, toolset_mismatch ... metadata only
  -- [R2] tool_blocked detail = {nameSha8, nameLen, verdict, runId} - a blocked tool NAME is model output and is never stored, logged or exported;
  --      triage_queue.last_error and runs.error_code hold an ErrorCode only, never err.message (zod/provider messages echo received values)
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TABLE rate_events (bucket TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX ix_rate ON rate_events(bucket, key, ts);
CREATE TABLE model_files (id TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, mtime INTEGER NOT NULL,
                        status TEXT NOT NULL CHECK(status IN ('none','downloading','paused','verifying','ready','failed')),
                        bytes_done INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, bench_json TEXT);
```
- Child PIDs are NOT in SQLite: `<userData>\run\<name>.pid.json` `{pid, exePath, startedAt}`, written atomically, so the reaper works when the DB is locked or corrupt. `[R2]` The file is untrusted input: `parsePidFile()` accepts only a safe integer `0 < pid < 2^31`, an absolute `exePath` under our resources dir (or `=== process.execPath`), a finite `startedAt`; anything else is a stale file. No field is ever interpolated into a shell string or WQL filter.
- Retention job (daily + at start): `item_messages.text`, `proposals.draft_text/extraction_json/event_json/freebusy_json` and `[R2]` `actions.canonical_json/approved_final_json` (terminal states only; `content_sha256` kept) nulled after `settings.privacy.retentionDays` (30); closed items after 90 days; `runs`, `audit_log`, `rate_events` after 180 days. `data:purgeNow` runs the same job with `retentionDays=0`, then `[R2]` deletes `backups\*` and takes one fresh backup, so purged text does not survive in the daily copies.
- Recoverability: `PRAGMA quick_check` at start; backup (`VACUUM INTO <userData>\backups\app-YYYYMMDD.db`, keep 3) daily and before every migration. Corrupt => restore newest backup; none => start empty (pairing and model survive - separate files). Pending approvals are intentionally not reconstructed.
- Not encrypted in v1 (`node:sqlite` has no SQLCipher; the bridge DBs are plaintext beside it). Never put `app.db`, `whatsapp.db`, `tokens.json` in logs or diagnostics exports.

---

## 11. IPC surface

Contract in `src/shared/ipc.ts` (channel -> zod request/response); the preload duplicates the channel literals on purpose. Every handler: trusted-sender check + zod `.strict()` + typed `Result<T, ErrorCode>`. **No channel accepts a JID, URL, file path, tool name or MCP arguments.** The renderer identifies things only by `itemId`, `actionId`, `chatRef` (= `chats.id`).

| Invoke channel | Request | Notes |
|---|---|---|
| `app:getBootstrap` | - | `{lang, dir, onboardingStep, health, settingsPublic, version}` - one call paints the first frame |
| `health:get` | - | `AppHealth` |
| `dashboard:get` | - | three lists (latest 20 each) + counts + ignored count |
| `item:get` | `{itemId}` | snapshot messages, draft, event, badges, `actions[{actionId,kind,shownHash,state}]` |
| `item:dismiss` / `item:restore` / `item:retriage` | `{itemId}` | retriage is user-initiated, budget-limited; also "Analyse this chat" |
| `item:setEditing` | `{itemId, editing}` | edit-lock |
| `action:approve` | `{actionId, kind, shownHash, edit?, confirmConflict?, confirmDuplicate?}` | section 6.6 - the ONLY path to a side effect. `edit` = `{text}` or `{title,startLocal,endLocal,location}` |
| `action:reject` | `{actionId}` | |
| `agent:setPaused` | `{paused}` | pauses LLM processing, not the bridge |
| `chat:setPolicy` | `{chatRef, policy}` or `{chatRef, forceKnown:true}` | |
| `onboarding:getState` / `onboarding:setStep` | `{step}` | resumable |
| `consent:get` / `consent:accept` | `{kind, version}` | versioned bilingual text shipped in the app; `[R2]` `accept` rejects `version !== CONSENT_VERSIONS[kind]` (`BAD_REQUEST` + audit `ipc_rejected`) |
| `pairing:get` / `pairing:newCode` | - | `{status, qrDataUrl?, expiresAt?}`; `newCode` = kill + respawn |
| `pairing:relink` / `pairing:unlinkAndWipe` | `{confirm:true}` | relink deletes only `store\whatsapp.db`; wipe deletes `<userData>\bridge\store`, `[R2]` resets `meta.bridge_rowid_watermark` to 0 and clears `paired_at`/`live_from_ts`/`last_online_ts`, and reminds to remove the linked device on the phone |
| `llm:getHardware` | - | `{ramGiB, gpus[], freeDiskGiB, recommendedTier}` |
| `llm:getConfig` / `llm:setProvider` | `{provider}` | `setProvider` fails without consent / key / verified model |
| `secrets:set` / `secrets:has` / `secrets:clear` | `{name, value?}` | no `get`; UI shows last 4 chars computed in main |
| `llm:validateKey` / `llm:listModels` | `{provider}` | free metadata calls only |
| `model:getPlan` / `model:startDownload` / `model:pause` / `model:resume` / `model:cancel` / `model:delete` / `model:selfTest` | `{tier?}` | tier from an enum, never a URL |
| `google:getWizardState` / `google:pickCredentialsFile` / `google:importCredentials` | - / - / `{jsonText}` (<= 16 KB) | native dialog opened **in main**, or dropped file *content*; validated (`installed` key, client id suffix, secret present, localhost redirect; `[R2]` when present `auth_uri === 'https://accounts.google.com/o/oauth2/auth'`, `token_uri === 'https://oauth2.googleapis.com/token'`, `auth_provider_x509_cert_url === 'https://www.googleapis.com/oauth2/v1/certs'`, every `redirect_uris` entry `http://localhost...` or `urn:ietf:wg:oauth:2.0:oob` - else `GOOGLE_CREDENTIALS_INVALID` with `credentialsProblem:'bad_endpoint'`, because google-auth-library would POST the client secret and auth code to a foreign `token_uri`) |
| `google:startSignIn` / `google:status` / `google:disconnect` / `google:listCalendars` | - | `auth_url` opened by main only if host is `accounts.google.com` |
| `settings:get` / `settings:set` | partial of the allow-listed schema | language change also rebuilds the tray |
| `external:open` | `{target: enum}` or `{itemId, target:'calendarEvent'}` | hard-coded URL table (`resources/links.json`, incl. `vcredist_download`); `[R2]` **`calendarEvent` never opens a server-supplied link**: main builds `https://calendar.google.com/calendar/r/day/YYYY/MM/DD` from `items.event_start_ts` in the app time zone; `htmlLink` from the MCP result is kept for diagnostics only and never displayed or opened (`electron-hardening.test.ts` feeds `https://www-google.com/`, `https://wwwXgoogle.com/`, `https://www.google.com/url?q=` links and asserts none is opened) |
| `clipboard:writeText` | `{text}` (<= 4000) | `[R2]` the "Copy" button on every card (the sandboxed renderer has no `navigator.clipboard`) |
| `data:purgeNow` / `diagnostics:export` | - | export = redacted metadata logs only |

Push events: `dashboard:changed` (debounced 150 ms), `health:changed`, `pairing:changed`, `model:progress` (4 Hz), `google:changed`, `ui:languageChanged`, `ui:navigate {view,itemId?}`. The renderer keeps a Zustand store hydrated by `dashboard:get` and refreshed on `dashboard:changed`. Optimistic UI is forbidden for send/create: show a spinner until main confirms.

---

## 12. Onboarding, settings, i18n

### 12.1 Onboarding (single wizard view, resumable per step, language toggle always visible)
| Step | Screen | Main-process work |
|---|---|---|
| 0 Welcome | Language (default from `app.getPreferredSystemLanguages()`, `iw` = he). Three plain bullets + the promise "nothing is sent or scheduled without your approval". Explicit accept: unofficial linked device, possible ban, needs one free linked-device slot. | `consents(whatsapp_tos)`; silent hardware probe. No accept => the bridge is never spawned. |
| 1 Choose the AI | Three cards. **Local (default, private)**: probe result in plain words, size, free disk -> download **starts at once and continues in the background** (progress pill in the header for the rest of onboarding and on the dashboard). Claude / Gemini: blocking versioned consent (what leaves the PC; Gemini free-tier warning) -> paste key -> live validation with specific errors. | `model:startDownload` or `secrets:set` + `validate` |
| 2 Link WhatsApp | Large QR (data URL from main), three numbered **text** phone steps (`[R2]` no illustrations in v1), countdown synced to `expires_at`, "New code" on timeout. Success: "Connected - older messages are ignored". | spawn bridge; poll 1.5 s; on `connected` set `paired_at`, `live_from_ts` (every pairing, not only the first) |
| 3 Google Calendar | "About 5 minutes, one time" with **Start** and **Later** (skip => reply-only mode). The 5-step wizard of `calendar-mcp.md` 6.3: one deep-link button + numbered text instructions per step (`[R2]` no screenshots in v1 - no lane can capture the Google console; post-v1 ticket if the user wants them); steer to External + **Publish app** (no 7-day token expiry); JSON drop zone/browse with specific validation errors; explainer of the "Google hasn't verified this app" screen shown **before** the browser opens; `[R2]` one sentence "Windows may ask whether this app can use the network - Cancel or Allow both work" (the MCP server's OAuth callback listens on all interfaces, so the Defender Firewall dialog appears on first `manage-accounts add` for this unsigned exe). | write `gcp-oauth.keys.json` -> spawn MCP -> `manage-accounts add` -> `shell.openExternal(auth_url)` -> poll `list` every 2 s up to 5 min -> smoke `get-freebusy` today -> pick calendar from `list-calendars` |
| 4 Ready | Live checklist (AI downloading 43 % / ready; WhatsApp; Calendar). Two sentences with the tray icon glyph inline (`[R2]` no flyout picture in v1): "X hides the app next to the clock, under hidden icons; Quit is in the tray menu". Autostart toggle (**default off**). BitLocker tip; warning if `userData` is under a cloud-synced folder. | show dashboard |

Anything unfinished afterwards is a **setup strip** at the top of the dashboard, never a modal. While the model is downloading, qualifying items are `held/waiting_llm` raw cards and are analysed oldest-first when the model is ready (`[R2]` release to a **cloud** provider is limited to items triggered within the last 24 h, 6.1 step 5).

### 12.2 Settings (one page; one zod schema stored as one JSON value)
```ts
export const Settings = z.object({
  general:  z.object({ language: z.enum(['system','en','he']), autostart: z.boolean(), timeZone: z.string(),   // [R2] timeZone READ-ONLY: main sets it from the OS
                       notifications: z.enum(['off','generic']) }),                         // never message text; default 'generic' ; [R2] 'with_name' cut (push names are attacker-chosen)
  llm:      z.object({ provider: z.enum(['local','claude','gemini']), claudeModel: z.string(), geminiModel: z.string(),
                       local: z.object({ tier: z.enum(['auto','tiny','small','mid']), acceleration: z.enum(['auto','off']), forceCpu: z.boolean() }),
                       cloudDailyTokenBudget: z.number().int() }),                          // default 200_000 (kept: it feeds held/budget; the footer usage counter is cut [R2])
  whatsapp: z.object({ processUnknownSenders: z.boolean(), backlogHours: z.number().int().min(0).max(72) }),   // false, 0
  calendar: z.object({ targetCalendarId: z.string(), conflictCalendarIds: z.array(z.string()),
                       defaultDurationMin: z.number().int() }),                             // 'primary', ['primary'], 60 ; [R2] shareTitlesWithAi cut with list_events
  agent:    z.object({ paused: z.boolean(), ambiguousHour: z.enum(['assume','ask']), userGender: z.enum(['m','f','unspecified']) }),
  privacy:  z.object({ retentionDays: z.number().int().min(7).max(90) }),                                        // 30
}).strict();
```
Page groups: General (language, autostart, notifications off/generic, time zone shown read-only) - AI engine (three radio cards; Local: tier, speed, acceleration Auto/Off, delete/re-download; cloud: key status, model, consent) - WhatsApp (status, re-link, unlink and wipe, unknown senders, per-chat "never analyse" list) - Google Calendar (account, reconnect/disconnect/replace credentials, target calendar, conflict calendars) - Replies (gender) - Privacy and data (what leaves the PC, retention, purge now, export diagnostics, licences). `[R2]` Cut from v1 (ops/DECISIONS.md): per-chat `local_only` policy, `notifications:'with_name'`, `shareTitlesWithAi`, the IANA time-zone picker, the footer cloud-usage counter, the Alt+P / Ctrl+L / Ctrl+, shortcuts (F6 and Escape stay), the full "Ignored" drawer (kept only as "Undo dismiss", last 20).

### 12.3 i18n / RTL (binding rules from `i18n-rtl.md`)
`i18next@26.4.2` + `react-i18next@17.0.14`; two static JSON files `src/shared/locales/{en,he}.json`, one namespace, bundled into main AND renderer; main uses its own `i18next.createInstance()` for tray, notifications and native dialogs. Language source of truth = `settings.general.language` in main; main resolves it before creating the window and passes it via `additionalArguments`; `<html lang dir>` from `i18next.dir()`. Logical CSS/Tailwind utilities only (lint-banned physical classes); `dir="auto"` on message text and textareas; `<bdi>` for names and ranges; `<bdi dir="ltr">` for phones; FSI/PDI isolates in plain strings. Font = system `"Segoe UI"` (no bundled font). All dates via `Intl` with explicit `he-IL`/`en-IL`, `hourCycle:'h23'`, explicit `timeZone`. The LLM returns enum codes; the UI localises them; only drafts, titles and locations are free text. Hebrew buttons use action nouns, instructions use the plural imperative. Unit test: key parity between `en.json` and `he.json`, and every `ErrorCode` has `title/body/action` in both.

---

## 13. Tray lifecycle (Windows 11)

- `app.requestSingleInstanceLock()` at module top; `second-instance` => show + focus. `app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath)`; `APP_ID = com.ilay.whatsapp-calendar-agent` (== electron-builder `appId`; never change after the first release).
- Window `close` => `preventDefault(); hide()` unless `isQuitting` - **every time, immediately** (`[R2]` this is the rule; ux.md and contracts.md follow it; e2e asserts "first close hides within 200 ms"). On the **first** hide: Windows toast "Still running next to the clock, under hidden icons; to quit: right-click the icon -> Quit" and `meta.tray_hint_seen = 1`; the in-window coach mark (view `tray_hint`) is shown the **next time the window is opened** and dismissed with `app:ackTrayHint`. No picture. `window-all-closed` is a no-op. The renderer never registers `onbeforeunload`. Windows 11 places new tray icons in the overflow flyout automatically - that *is* the requested behaviour; do not touch the `NotifyIconSettings` registry.
- Tray (no GUID while unsigned; instance kept in module scope): left/double click = open. Menu: Open / status line (disabled; e.g. "Active - Local model", "Paused", "WhatsApp offline") / Pause-Resume processing / Settings / **Quit**. Rebuilt on language, pause and health changes. Icons: `tray.ico`, `tray-attention.ico` (open items), `tray-paused.ico`, `tray-error.ico`. **Tooltip and toasts never contain message text, drafts or contact names** (`[R2]` `with_name` cut: push names are attacker-chosen and a toast is app chrome on the lock screen); a toast click only opens the window (`ui:navigate`), records `shownByNotificationAt` for the 300 ms focus-steal guard, and the sheet's initial focus is its close button.
- Quit (tray only): `isQuitting=true` -> `before-quit` (prevent once) -> stop intake -> abort the in-flight LLM call -> wait up to 5 s for actions in `executing` -> `supervisor.stopAll({graceMs:3000})` -> `taskkill /PID <pid> /T /F` stragglers -> clear PID files -> destroy tray -> `app.quit()`.
- Windows shutdown/logoff: `before-quit` is not emitted; `session-end` on the window and `process.on('exit')` => `supervisor.killAllSync()`. Whether a hidden window receives `session-end` is UNVERIFIED => the reaper is mandatory.
- Reaper (before any spawn): for each `<userData>\run\*.pid.json`, `parsePidFile()` first (`[R2]` safe integer pid, exePath under our resources dir or `=== process.execPath`, finite `startedAt`; otherwise the file is discarded and **nothing is spawned or killed**), then query the process with `spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command', 'Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$args[0]) | Select-Object ProcessId,ExecutablePath,CreationDate | ConvertTo-Json', '--', String(pid)], { shell:false })` - the pid travels as a separate argv element, never inside a shell string or a WQL literal; kill (`taskkill /PID <n> /T /F`, `shell:false`) **only if** the executable path equals our own resources path and the creation time matches (+-2 s). Test: a hostile pid file (`"1 OR 1=1"`, foreign exePath) causes no spawn and no kill.
- Autostart: `setLoginItemSettings({openAtLogin, args:['--hidden']})` only when packaged; `--hidden` starts without showing the window.

---

## 14. Failure handling

`Supervisor` (Electron-free): states `stopped|starting|running|backoff|failed|stopping`; backoff `min(60 s, base*2^n)` + jitter, reset after 60 s stable; circuit breaker -> `failed` (only a user click closes it); liveness probe (bridge 20 s, 3 misses => kill + restart); any exit while not `stopping` is a crash.

`HealthHub` merges everything into `AppHealth = { overall:'ok'|'working'|'attention', whatsapp, llm, calendar, queue:{pending,running}, paused }`, each part `{state, code?: ErrorCode, since}`. The header shows one pill; clicking expands three rows with one sentence and one action each.

| Failure | Detection | Automatic response | ErrorCode -> single user action | Safety note |
|---|---|---|---|---|
| Bridge exits / hangs / port bind failed | `exit`, health misses, readiness poll timeout (`[R2]` never a stdout marker alone) | respawn, new port + token; catch-up scan | `BRIDGE_CRASH_LOOP` after 5 / 10 min -> "Try again" | sends disabled, main also rejects; approvals never queue |
| Exe missing / hash mismatch | pre-spawn check | refuse spawn | `BRIDGE_BINARY_BLOCKED` -> "Open instructions" (antivirus) | |
| Spawn invariant violated | `assertBridgeSpawnInvariants` | refuse spawn, audit | `BRIDGE_SPAWN_REFUSED` -> "Export diagnostics" | I6 |
| WhatsApp disconnected | `/api/health` 503 | bridge self-heals; 10 min => respawn | amber "Reconnecting..."; `WA_OFFLINE` after 30 min -> "Check your internet" | |
| Logged out from the phone | `GET /api/pairing/status` `{status:'error', message ~ /logged out/i}` **only** (`[R2]` never the stdout echo) | stop bridge | `WA_LOGGED_OUT` -> "Re-link" (deletes only our `whatsapp.db` after confirm) | destructive step needs a click; a contact typing "Device logged out" changes nothing |
| `Client outdated` | breaker opens (repeated exits / readiness failures) with a `client_outdated` stdout **annotation** within 60 s (`[R2]` the annotation only picks the code) | stop respawning | `BRIDGE_OUTDATED` -> "How to update"; drafting continues, sending disabled, Copy works | never download an exe at runtime |
| llama-server dies at load (`0xC0000135`) | pre-flight DLL check / exit code (`[R2]`) | none | `LLM_VCREDIST_MISSING` -> "Install Microsoft runtime" (opens `aka.ms/vs/17/release/vc_redist.x64.exe` in the browser) | the app never downloads an exe |
| Timestamp format unknown | 20 unparseable rows | - | `BRIDGE_TS_FORMAT` -> "Export diagnostics" | never silent |
| Doorbell missed | - | 30 s scan + reconnect scans | invisible | doorbell is an optimisation only |
| llama-server crash / garbage / sleep-resume device lost | exit, `/health`, self-test | retry once; then `--device none` persisted; then breaker | `LLM_LOCAL_FAILED` -> "Test again" (also offers a smaller model) | items wait as raw cards; nothing is lost |
| Model missing / corrupt / disk full / hash mismatch | size check, hash flag, downloader | pause; delete `.part`; one auto re-download | `MODEL_MISSING` / `DISK_FULL` / `DOWNLOAD_FAILED` -> "Download again" / "Free up X GB" | |
| Cloud `auth` | typed error | no retry; provider blocked | `KEY_INVALID` -> "Update key" | never silently fall back to another provider |
| Cloud `billing` / `quota_daily` | typed error (no retry-after) | no retry; queue held | `CLOUD_QUOTA` -> "Open AI settings" | |
| Cloud `rate_limited` / `overloaded` / `network` | typed error | SDK retries, then queue backoff 1/5/30 min | amber only | |
| Model id retired (404) | typed error | none | `MODEL_NOT_FOUND` -> "Choose a model" | |
| LLM output invalid twice / refusal / truncated | validator | one repair retry | `LLM_BAD_OUTPUT` on the raw card -> "Analyse again" | |
| MCP server crash | transport close | restart x3 with backoff, re-verify toolset | `CAL_UNAVAILABLE` -> "Try again"; "Add to calendar" disabled with reason | reads fail closed `{"error":"unavailable"}` |
| Google token invalid (`invalid_grant`, 7-day Testing expiry) | error text mapping | none (not a restart) | `CAL_RECONNECT` -> "Reconnect" (+ Publish hint) | |
| OAuth callback ports 3500-3505 busy | `EADDRINUSE` text | retry once | `CAL_PORT_BUSY` -> plain instruction | |
| `tools/list` drift | startup contract | calendar disabled, audit | `CAL_TOOLSET_MISMATCH` -> "Export diagnostics" | fail closed |
| Send failed / bridge offline | non-200 / timeout | none - never auto-resend | inline "Sending failed" -> "Try again" / "Copy" | |
| Rate limit hit | RateLimiter | - | inline "Hourly send limit reached - this protects your account" | |
| Crash mid-execution | `executing` rows at start | `unknown_outcome`, reconcile read-only | "Could not confirm - check WhatsApp / calendar" -> "Send again" | never auto-retry a side effect |
| Stale / expired / superseded approval | hash / expiry / state | reject, refresh card | inline "This card changed - review again" | |
| `app.db` corrupt / migration failed | `quick_check`, migrate error | restore backup | `DB_RECOVERY` -> "Restore" / "Start fresh" | pairing unaffected |
| safeStorage unavailable / decrypt failure | exception | treat as key missing; refuse to persist | `KEY_MISSING` -> "Enter key" | |
| Renderer gone | `render-process-gone` | recreate window | - | main state intact |

Kill switch: "Pause processing" aborts all LLM runs at once (AbortController) and leaves pending approvals usable.

Logging: `electron-log@5.4.4` behind a single `redact()` hook; metadata only (event type, `sha256(jid).slice(0,8)`, lengths, durations, token counts, **allow-listed** tool names - `[R2]` a name that is not in `READ_TOOL_NAMES` is model output and is logged only as `sha256(name).slice(0,8)` + length - outcomes, `ErrorCode`s never `err.message`); patterns of `security-threat-model.md` C-41; 5 files x 1 MB in `<userData>\logs`. ESLint bans `console.*` in `src/main`. `crashReporter` stays off. The redaction sentinel test feeds a blocked tool name containing `SENTINEL_MSG_TEXT` and asserts zero hits in `audit_log`, the log files and the diagnostics export.

---

## 15. Electron hardening and packaging

### 15.1 Window and session
`BrowserWindow` 980x680, min 420x560, `show:false`, `autoHideMenuBar:true`; `webPreferences: { preload: out/preload/index.cjs, contextIsolation:true, sandbox:true, nodeIntegration:false, nodeIntegrationInWorker:false, nodeIntegrationInSubFrames:false, webSecurity:true, allowRunningInsecureContent:false, webviewTag:false, experimentalFeatures:false, spellcheck:false, devTools:!app.isPackaged }`; `Menu.setApplicationMenu(null)`. Renderer served from `app://bundle/` (`protocol.handle` with a traversal guard). Production CSP (response header): `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`. `will-navigate`, `window.open`, `will-attach-webview` denied on every webContents; all permission requests and checks denied; no custom OS URL scheme. ESLint bans `dangerouslySetInnerHTML`/`innerHTML`; no markdown renderer; links inside messages are not clickable. E2E seams (`WCA_E2E`, fake bridge URL, stub LLM, `--user-data-dir`) are honoured only when `!app.isPackaged`.

### 15.2 electron-builder (`electron-builder.yml`, 26.15.3)
```yaml
appId: com.ilay.whatsapp-calendar-agent
productName: WhatsApp Calendar Agent
directories: { output: dist, buildResources: build }
files: [ "out/**", "package.json", "!**/*.map", "!out/.e2e-build" ]   # [R3] never ship the e2e marker of scripts/mark-e2e-build.mjs
asar: true
npmRebuild: false                      # no native modules anywhere; NO asarUnpack
electronLanguages: [en-US, he]
extraResources:
  - { from: resources/bridge,             to: bridge,       filter: ["whatsapp-bridge.exe", "LICENSE", "SHA256SUMS"] }
  - { from: vendor/llama/win-x64-vulkan,  to: llama,        filter: ["llama-server.exe", "llama-server-impl.dll", "llama-common.dll", "llama.dll", "mtmd.dll",
                                                                     "ggml.dll", "ggml-base.dll", "ggml-vulkan.dll", "ggml-cpu-*.dll", "libomp.dll",
                                                                     "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE-LLVM-OpenMP"] }   # [R2] explicit allow-list (fetch-llama.mjs already keeps only these)
  - { from: build-resources/calendar-mcp, to: calendar-mcp }
  # [R3] The entry above copies ONLY package.json + package-lock.json. electron-builder rejects a matcher ROOT
  # node_modules in app-builder-lib/out/util/filter.js (if relative === "node_modules" return false) BEFORE any
  # filter pattern is consulted - for extraResources too - so an explicit filter ["**/*", "node_modules/**"] copies
  # 0 files as well (both measured with 26.15.3). The matcher below is rooted AT that folder, so its children
  # (@cocal, googleapis, ...) are the relative paths and the rule never fires. Without it the installed app has NO
  # calendar server and every calendar feature is dead at run time; packaged smoke check 4a fails the build.
  - { from: build-resources/calendar-mcp/node_modules, to: calendar-mcp/node_modules }
  - { from: resources/icons,              to: icons }
  - { from: resources/links.json,         to: links.json }      # [R2] resources/onboarding/** removed: no raster onboarding assets in v1
  - { from: resources/licenses,           to: licenses }
electronFuses:
  runAsNode: true                      # REQUIRED by the MCP stdio child (A4) - do NOT "harden" this off; guarded by 15.4
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false # => Playwright runs against the UNPACKAGED build
  onlyLoadAppFromAsar: true
  enableEmbeddedAsarIntegrityValidation: false   # [LR] UNVERIFIED on Windows with 26.15.3
  enableCookieEncryption: true
  grantFileProtocolExtraPrivileges: false
win:  { target: [{ target: nsis, arch: [x64] }], icon: build/icon.ico, requestedExecutionLevel: asInvoker }
nsis: { oneClick: true, perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true,   # Start-menu shortcut REQUIRED for toasts
        shortcutName: WhatsApp Calendar Agent, runAfterFinish: true, deleteAppDataOnUninstall: false,
        artifactName: "WhatsAppCalendarAgent-Setup-${version}.${ext}" }
```
`build/installer.nsh` `customInit`: `taskkill /F /T /IM "WhatsApp Calendar Agent.exe"` - **only our own main image with `/T`**; never `taskkill /IM whatsapp-bridge.exe`.

### 15.3 Installed layout
```
%LOCALAPPDATA%\Programs\WhatsApp Calendar Agent\
  WhatsApp Calendar Agent.exe
  resources\
    app.asar                                   main (ESM) + preload (CJS) + renderer + locales + 6 DIRECT pure-JS deps (~143 packages in the production tree, [R2]); nothing unpacked
    bridge\whatsapp-bridge.exe  LICENSE  SHA256SUMS
    llama\llama-server.exe  llama-server-impl.dll  llama-common.dll  llama.dll  mtmd.dll  ggml*.dll  libomp.dll  msvcp140.dll  vcruntime140*.dll  LICENSE-LLVM-OpenMP   ([R2])
    calendar-mcp\package.json  package-lock.json  node_modules\@cocal\google-calendar-mcp\...   (npm ci --omit=dev --ignore-scripts)
    icons\tray.ico tray-attention.ico tray-paused.ico tray-error.ico notification.png
    links.json    licenses\THIRD_PARTY_NOTICES.txt   (includes the llama.cpp MIT text and the VC++ CRT notice [R2])

%APPDATA%\WhatsApp Calendar Agent\             (userData; survives uninstall; warn if under a cloud-synced folder)
  app.db (+ -wal, -shm)   backups\   logs\   run\*.pid.json
  bridge\                  <- bridge cwd
     store\whatsapp.db  messages.db  <jid>\media...      created by the bridge; the app opens messages.db READ-ONLY only
     outbox-empty\
  google\gcp-oauth.keys.json  tokens.json                (plain files required by the MCP server)
  models\*.gguf  *.gguf.part  *.part.json
```

### 15.4 Build scripts and gates
- `scripts/import-bridge.mjs` (4.1) - `scripts/hash-bridge.mjs` (fails the build on SHA-256 mismatch) - `scripts/fetch-llama.mjs` (download pinned zip, verify sha256, unzip, keep the allow-list, write the file list to `vendor/llama/MANIFEST.txt`) - `scripts/stage-calendar-mcp.mjs` (`npm ci --omit=dev --ignore-scripts` from the committed `build-resources/calendar-mcp/package-lock.json`) - `scripts/pin-models.mjs` (re-checks the manifest against the HF API `lfs.oid` + size; fails on drift) - `scripts/make-icons.mjs` - `scripts/smoke-packaged.mjs` (`[R3]` seven gates: the six of TESTS section 11 plus **4a**, which compares `<resources>\calendar-mcp\node_modules` against `build-resources\calendar-mcp\node_modules` and fails the build when the staged server did not reach the package - the regression D-035 guards against).
- **Packaged smoke test (release gate)**: after `electron-builder --dir`, (1) spawn `<unpacked>\WhatsApp Calendar Agent.exe` with `ELECTRON_RUN_AS_NODE=1` + the MCP entry + the fixture credentials file `[R2]` **exactly** `{"installed":{"client_id":"TESTONLY.apps.googleusercontent.com","client_secret":"TESTONLY","redirect_uris":["http://localhost"]}}` (the server reads `redirect_uris[0]` before the MCP handshake; a fixture without it throws a TypeError that would be misread as a flipped fuse) and assert MCP `initialize` + `tools/list` == the six names; the smoke distinguishes the two failure modes: child exits non-zero with stderr `Failed to start server` => fixture/runtime problem; child alive with no stdout JSON-RPC and a second GUI process/window => fuse flipped; (2) read the fuse wire back with `@electron/fuses`; (3) assert the three resource folders exist. NSIS install/upgrade-while-running test on a path with a space is a manual checklist item.
- Root `package-lock.json` committed; exact versions; `npm ci`; `npm audit --omit=dev` in the test stage. First install: `npm approve-scripts esbuild` (npm 11.17 advisory); CI: `npx install-electron --no`.
- Expected installer ~200-240 MB (Electron ~110, bridge 43, llama ~90 unpacked, calendar-mcp/googleapis ~200 unpacked; all compress well). googleapis is shipped as-is `[LR]` (the esbuild re-bundle is UNVERIFIED).

---

## 16. Exact dependency list (verified with `npm view` on 2026-09-21)

npm `latest` traps - **do NOT use**: `vite@8.3.0`, `@vitejs/plugin-react@6.1.1`, `vitest@5.0.1`, `typescript@7.0.2` (incompatible with `electron-vite@5.0.0` / `typescript-eslint@8.70.0`). Pin exactly (no `^`).

```json
{
  "name": "whatsapp-calendar-agent", "productName": "WhatsApp Calendar Agent", "version": "0.1.0", "private": true,
  "type": "module", "main": "./out/main/index.js", "engines": { "node": ">=24.0.0" },
  "dependencies": {
    "@anthropic-ai/sdk": "0.127.0",
    "@google/genai": "2.23.0",
    "@modelcontextprotocol/sdk": "1.30.0",
    "electron-log": "5.4.4",
    "i18next": "26.4.2",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@electron/fuses": "2.1.3",
    "@eslint/js": "10.0.1",
    "@playwright/test": "1.63.0",
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/dom": "10.4.2",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/node": "24.13.6",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "5.2.0",
    "@vitest/coverage-v8": "4.1.11",
    "electron": "44.4.3",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "eslint": "10.11.0",
    "eslint-plugin-react-hooks": "7.1.1",
    "globals": "17.12.0",
    "jsdom": "30.1.0",
    "png-to-ico": "3.0.2",
    "prettier": "3.9.8",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-i18next": "17.0.14",
    "tailwindcss": "4.3.3",
    "typescript": "6.0.3",
    "typescript-eslint": "8.70.0",
    "vite": "7.3.6",
    "vitest": "4.1.11",
    "zustand": "5.0.15"
  }
}
```
Notes: all six **direct** runtime dependencies are pure JS (externalised by electron-vite and shipped inside `app.asar`; `[R2]` the production tree they pull in is ~143 packages - `@modelcontextprotocol/sdk@1.30.0` alone brings `express`, `hono`, `jose`, `ajv`, `ajv-formats`, `ws`... - all pure JS). Renderer libraries are devDependencies (bundled by Vite). The scaffold agent re-runs `npm install --package-lock-only` (research resolved this set, with `node-llama-cpp` still included, with exit 0). **Forbidden packages** `[R2]` - forbidden as **direct** dependencies of the root `package.json` (`dependencies` or `devDependencies`) and as root-declared lockfile entries; additionally **no `gypfile`/`binding.gyp` anywhere in the production tree** (the real rule behind the list = no native addons): `node-llama-cpp`, `better-sqlite3`, `electron-rebuild`, `electron-store`, `electron-updater`, `openai`, `ajv`, `ipull`, `tree-kill`, `dependency-cruiser`, `@electron-toolkit/*`, `i18next-*` plugins, any font package. Explicit allow-list of transitive occurrences: `ajv` / `ajv-formats` as dependencies of `@modelcontextprotocol/sdk` (production) and of `eslint` (dev). The check (W0 lockfile test, TESTS 12a, W2-04 release acceptance) is: for each forbidden name assert absence from root `dependencies`/`devDependencies` and that no lockfile package of that name is root-declared; then scan every production package for `binding.gyp`/`gypfile`.

Separate isolated package (`build-resources/calendar-mcp/package.json` + committed lockfile): `"@cocal/google-calendar-mcp": "2.6.3"` (MIT; brings `googleapis ^171.4.0`, `google-auth-library ^10.5.0`, `@modelcontextprotocol/sdk ^1.27.0`, `open`, `zod`). It is never imported by app code.

Vendored binaries: llama.cpp `b10964` Vulkan x64 zip (section 9, MIT); `whatsapp-bridge.exe` (section 4.1, MIT).

Tooling: electron-vite config, tsconfig split, vitest two-project config and Playwright config exactly as in `electron-stack.md` sections 9-10 (E2E against the built **unpackaged** app with fakes).

---

## 17. Local model picks per hardware tier (pinned 2026-09-21 via the Hugging Face API)

All Apache-2.0, not gated, text-only (never download `mmproj-*` or `mtp-*`). Compile-time manifest `src/main/llm/local/manifest.ts`:

| Tier | Model | Pinned URL | Size (bytes) | sha256 |
|---|---|---|---|---|
| `tiny` | Gemma 4 E2B-it Q4_K_M | `https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf` | 3,106,738,272 | `740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8` |
| `small` | Gemma 4 E4B-it Q4_K_M | `https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf` | 4,977,171,584 | `85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87` |
| `mid` | Gemma 4 12B-it QAT UD-Q4_K_XL | `https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/980b060c40a8539ac159e0501a3e0f66a6365af3/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` | 6,716,356,800 | `90fd44e29e0d7cffeb0fd00dc73cfdab9ed0b0e95306ecf7821ea634c940c370` |

Tier rule (first match wins; GiB = `bytes / 2^30`; integrated-GPU memory never counts):

| # | Condition | Tier | Mode |
|---|---|---|---|
| 1 | free disk on the `userData` drive < 12 GiB | `small` if RAM >= 12 GiB else `tiny` | - |
| 2 | dedicated VRAM >= 7.5 GiB and RAM >= 15 GiB | `mid` | full GPU offload (~20 tok/s reported on RTX 4060 8 GB) |
| 3 | dedicated VRAM 5.5-7.5 GiB and RAM >= 15 GiB | `mid` | partial offload (`--fit on` default) |
| 4 | no dedicated GPU and RAM >= 30 GiB | `mid` | CPU only, expectation note shown |
| 5 | RAM >= 12 GiB | `small` | CPU / iGPU |
| 6 | otherwise | `tiny` | CPU |

Sampling: extract `temperature 0.1`; draft = Gemma defaults `temperature 1.0, top_p 0.95, top_k 64`. Thinking off. The user may override the tier in Settings (download size shown first).

**Release gate**: a 40-60 item synthetic Hebrew/English/mixed golden set (`tests/golden/`) must pass per provider before the pins are considered locked. Contingency (NOT in the v1 manifest): Qwen3.5-4B / Qwen3.5-9B Q4_K_M from `unsloth/*-GGUF` if Gemma fails the gate.

---

## 18. Directory layout and build ownership

```
C:\dev\whatsapp agent\
  package.json  package-lock.json  electron.vite.config.ts  electron-builder.yml
  tsconfig.json  tsconfig.node.json  tsconfig.web.json  vitest.config.ts  playwright.config.ts  eslint.config.js  .prettierrc.json
  CLAUDE.md  .gitignore
  build\              icon.ico  installer.nsh
  resources\          bridge\{whatsapp-bridge.exe,LICENSE,SHA256SUMS}   icons\   links.json   licenses\THIRD_PARTY_NOTICES.txt     ([R2] no onboarding\ pictures)
  build-resources\    calendar-mcp\{package.json,package-lock.json}      (node_modules git-ignored)
  vendor\             whatsapp-bridge-src\ (Go source, reference only)   llama\ (git-ignored)   llama.pin.json
  scripts\            import-bridge.mjs  hash-bridge.mjs  fetch-llama.mjs  stage-calendar-mcp.mjs  pin-models.mjs  make-icons.mjs  smoke-packaged.mjs
  src\
    shared\           ipc.ts  schemas.ts  state.ts  when.ts  errors.ts  health.ts  settings.ts  types.ts
                      locales\{en,he}.json   i18n\{languages,bidi,format}.ts
    preload\          index.ts                                   (CJS output, dependency-free, literal allow-list)
    main\
      index.ts  compose.ts  paths.ts  logger.ts  secrets.ts      (compose.ts = the ONLY place capabilities are wired)
      app\            window.ts  tray.ts  autostart.ts  notifications.ts  protocol.ts  i18n.ts
      ipc\            register.ts  sender.ts  handlers\{app,items,actions,settings,secrets,llm,model,pairing,google,data}.ts
      db\             index.ts  migrations.ts  backup.ts  retention.ts  repos\{meta,settings,chats,items,proposals,actions,queue,audit,rate,models}.ts
      proc\           supervisor.ts  reaper.ts  freePort.ts
      health\         healthHub.ts
      bridge\         launcher.ts  invariants.ts  readClient.ts  sendClient.ts  doorbell.ts  pairing.ts  bridgeDb.ts  ingest.ts  timestamps.ts  stdoutMarkers.ts  janitor.ts
      mcp\            host.ts  readClient.ts  writeClient.ts  adminClient.ts  googleAuth.ts  projection.ts
      llm\            types.ts  factory.ts  consent.ts  claude.ts  gemini.ts  local.ts
                      local\{llamaServer.ts,hardware.ts,manifest.ts,download.ts,selfTest.ts}
      agent\          queue.ts  stage0.ts  contextBuilder.ts  sanitize.ts  minimize.ts  prompt.ts  dateTable.ts  replyLang.ts
                      extract.ts  resolve.ts  toolDefs.ts  toolGate.ts  draft.ts  validate.ts  orchestrator.ts  items.ts
      exec\           actionExecutor.ts  actionHash.ts  buildSendArgs.ts  buildCreateEventArgs.ts  rateLimiter.ts  reconcile.ts
    renderer\         index.html
                      src\{main.tsx, App.tsx, styles.css, i18n.ts, api.ts, env.d.ts, store\{dashboard,health,settings}.ts,
                           views\{Dashboard.tsx, Settings.tsx, Onboarding\{Welcome,ChooseAi,LinkWhatsApp,GoogleWizard,Ready}.tsx},
                           components\{ItemList,ItemCard,RawCard,DraftBox,EventEditor,Badges,QuotedBubble,HealthPill,DownloadPill,
                                       SetupStrip,UndoDismissDrawer,QrPairing,ConsentDialog,LanguageToggle}.tsx}     ([R2] IgnoredDrawer -> UndoDismissDrawer)
  tests\              mocks\electron.ts  setup-renderer.ts
                      fakes\{fake-bridge.ts, fake-bridge-db.ts, fake-mcp-calendar.ts, fake-llama-server.ts, stub-llm.ts, obedient-attacker-llm.ts, fake-child.mjs}
                      security\{injection-corpus.he.json, injection-corpus.en.json, *.test.ts}     golden\{he,en,mixed}.jsonl
                      e2e\{app,tray-lifecycle,approval-first,i18n-rtl,onboarding}.spec.ts
  docs\               ARCHITECTURE.md  research\  proposals\  specs\
  ops\                CONTEXT.md DECISIONS.md PROGRESS.md BOARD.md NOTES.md  tickets\  agent-notes\
  out\  dist\         (git-ignored)
```

Import boundaries (ESLint `no-restricted-imports` + `tests/security/import-graph.test.ts`):
- `src/main/agent/**` and `src/main/llm/**` MUST NOT import `src/main/exec/**`, `bridge/sendClient.ts`, `mcp/writeClient.ts`, `mcp/adminClient.ts` or `mcp/host.ts`.
- `src/main/exec/**` MUST NOT import `src/main/llm/**` or `src/main/agent/**` (no LLM in the execution stage; shared pure helpers live in `src/shared`).
- `bridge/sendClient.ts` and `mcp/writeClient.ts` are imported only by `compose.ts` (construction) and `exec/**` (types).
- `node:sqlite` and `electron` are never imported from `src/renderer/**` or `src/shared/**`.

Parallel build plan: **Wave 0** (one agent, blocks everyone): scaffold `package.json` with the exact pins, configs, `src/shared/*`, `llm/types.ts`, `db/migrations.ts`, exported signatures of `proc/supervisor.ts`, `bridge/*Client.ts`, `mcp/*Client.ts`, `agent/toolGate.ts`, `exec/actionExecutor.ts`, and the fakes' interfaces - everything typechecks from minute one. Then disjoint ownership:

| # | Owns | Tested against |
|---|---|---|
| 1 | `proc/*`, `health/*` | `fake-child.mjs` |
| 2 | `bridge/{launcher,invariants,readClient,sendClient,pairing,doorbell,stdoutMarkers,janitor}` | `fake-bridge` (never the real exe) |
| 3 | `bridge/{bridgeDb,ingest,timestamps}` | `fake-bridge-db` built from the schema in `bridge-contract.md` section 6 |
| 4 | `db/*` | in-memory sqlite |
| 5 | `mcp/*` | `fake-mcp-calendar` over `InMemoryTransport`; real server with dummy creds for `tools/list` only |
| 6 | `llm/claude.ts` | recorded fixtures, no key |
| 7 | `llm/gemini.ts` | recorded fixtures, no key |
| 8 | `llm/local.ts`, `llm/local/*`, `scripts/{fetch-llama,pin-models}.mjs` | `fake-llama-server`; the real llama-server smoke is a manual step |
| 9 | `agent/*` + `tests/golden` | `stub-llm` |
| 10 | `exec/*`, `ipc/handlers/actions.ts`, `tests/security/*` | fakes + `obedient-attacker-llm` |
| 11 | `main/index.ts`, `compose.ts`, `app/*`, `secrets.ts`, `logger.ts`, `llm/{factory,consent}.ts` | electron mock |
| 12 | `ipc/register.ts`, `ipc/sender.ts`, remaining handlers, `preload/` | contract tests generated from `shared/ipc.ts` |
| 13 | renderer Dashboard + cards + both locale files | jsdom + RTL snapshot tests |
| 14 | renderer Onboarding + Settings + dialogs | jsdom |
| 15 | packaging, remaining scripts, Playwright e2e, packaged smoke | - |

Security test gate (release blocker, all against fakes): (1) tool gate (`[R2]` incl. a monkey-patched read client calling `create-event` through its injected caller -> rejected before the fake MCP); (2) import graph; (3) he+en injection corpus >= 40 cases with an LLM stub that **obeys the attacker** (`[R2]` + `stdout_marker` vectors); (4) system-prompt/tool-definition purity property test; (5) approval binding (forged id, wrong hash, extra fields, expired, superseded, double click **with a slow fake free/busy so the interleaving happens** and on a `create_event`, hidden window, focus-steal guard, DB trigger table incl. `UPDATE actions SET state='pending'` on an executing row); (6) crash recovery and `unknown_outcome` (`[R2]` + reconcile fails -> "Add again" -> same `eventId` -> exactly one event); (7) doorbell rejections, "payload provably unused", 25 MB body on a wrong path cut off after headers; (8) bridge launch invariants and env contents; reaper hostile pid file; (9) redaction goldens + sentinel grep over the log dir, `audit_log` and the export, incl. a blocked tool name carrying the sentinel; (10) consent factory + payload snapshots + Gemini `store:false` + `ANTHROPIC_BASE_URL`/`GOOGLE_GEMINI_BASE_URL` poisoning + consent version 999 rejected; (11) backlog gate (`[R2]` + re-pair resets `live_from_ts`; cloud release limited to 24 h; 3-day-old live message after the bridge was online yesterday => item); (12) Electron webPreferences/CSP/navigation, `external:open` bypass strings, fuse wire, GGUF corrupt byte / foreign redirect, rate-limiter virtual clock.

---

## 19. UNVERIFIED register and the manual first-run checklist

Nothing below was checked by running the real exe, real Google or a real model (hard rules). Each item lists the design's lower-risk posture and the supervised check that closes it.

| # | Unverified fact | Posture in this design | Closed by (user-supervised) |
|---|---|---|---|
| V1 | Prebuilt exe == vendored source; answers `/api/pairing/status`; needs no extra DLLs | pin by SHA-256; readiness requires our token to get 200 | first supervised launch on the dev PC |
| V2 | `messages.db` timestamp text format; rowid behaviour on upsert; write-before-webhook order | defensive TS parser + `BRIDGE_TS_FORMAT` health error; timer scan backs up the doorbell | first pairing: inspect the app-owned DB |
| V3 | `/api/send` with `@lid`; frequency of `@lid` chats | `@lid` = copy-only; ingest resolves `@lid` -> phone JID from the bridge's mapping on every ONLINE (`[R2]`) | `[R2]` **release-gate manual item** (not "later"): send to an `@lid` test contact from the app; if it works, `DM_LID_JID_RE` becomes sendable. Record the observed `@lid` share after the first supervised launch in ops/PROGRESS.md |
| V4 | `manage-accounts` stays registered under `ENABLED_TOOLS`; `sendUpdates`/`eventId`/duplicate responses of `create-event` | listed explicitly; any error => `failed` + reconcile by tag; fake MCP contract tests | integration test with dummy creds (`tools/list`), then first real event |
| V5 | llama-server b10964: `--list-devices` format, Unicode/space model paths, tool parsing with Gemma 4 (`peg-gemma4`). `[R2]` **Resolved by inspection**: zip file list (flat, no LICENSE, stub exe + impl DLL), VC++ CRT static imports (MSVC build), `vulkan-1.dll` loaded dynamically (degrades to CPU), all flags present | explicit file allow-list; CRT DLLs shipped app-locally when available + `LLM_VCREDIST_MISSING` pre-flight; tolerant parser -> "no GPU"; `--device none` fallback; S1 does not depend on tool parsing at all; S3 degrades to a no-tool draft | manual llama smoke + golden set on the dev PC; clean Windows Sandbox run **without** the VC++ redistributable must show Local working or exactly `LLM_VCREDIST_MISSING`; manual check that the real server returns 400/garbage when `response_format.json_schema.schema` is absent |
| V6 | ASAR integrity fuse on Windows with electron-builder 26.15.3 | fuse off in v1 | post-v1 ticket |
| V7 | `session-end` on a hidden window | reaper is mandatory | manual logoff test |
| V8 | Gemini Interactions wire details (usage field names, error body), free-tier limits | duck-typed errors; contract fixtures captured once with the user's key | user smoke test |
| V9 | Claude zero-credit error shape (402 vs 400) | both mapped to `billing` | user smoke test |
| V10 | NSIS build/upgrade from a project path with a space; upgrade while children run | `installer.nsh` kills only our tree | manual install/upgrade test |
| V11 | Hebrew quality of Gemma 4 at E2B/E4B/12B; agent-written Hebrew UI copy | golden-set gate; Edit-first card; user skims `he.json` | golden set + user review |
| V12 | HF CDN redirect hosts | `[R2]` suffix rule (`huggingface.co`, `*.hf.co`, `*.huggingface.co`), one hop, sha256 pin is the integrity check (all three pinned URLs verified 302 -> 200 with matching LFS oids/sizes; today's target `us.aws.cdn.hf.co`) | first real download |
| V13 | `[R2]` Windows Defender Firewall prompt on the MCP server's OAuth callback listener (all interfaces, ports 3500-3505, unsigned exe) | wizard copy explains "Cancel or Allow both work"; manual checklist M5 | first Google sign-in |

Known, accepted weaknesses (disclosed in the README): same-user malware can read `whatsapp.db`, `messages.db`, `tokens.json` and call DPAPI; `runAsNode` is enabled; nothing is code-signed (SmartScreen/Defender friction for three unsigned executables); no auto-update; the bridge is an opaque binary nobody here can rebuild and will eventually hit "Client outdated"; whatsmeow use violates WhatsApp's terms regardless of volume; Google setup needs the user's own Cloud project; the MCP server requests the full `auth/calendar` scope; create-only calendar; one open item per chat collapses parallel topics; 1-2 local LLM calls per actionable burst (roughly 20-60 s on a CPU-only laptop); capability separation is module-level, not process-level; the human approving without reading defeats everything.

User decisions still open (defaults are in force; none blocks the build):

| # | Question | Default used |
|---|---|---|
| U1 | Default Claude model | `claude-opus-5` (Anthropic's recommended default; the user pays - `claude-sonnet-5` is about 2.5x cheaper and is one click away) |
| U2 | Ambiguous hour ("at 5") | assume PM + visible badge |
| U3 | Messages from senders you never wrote to | raw card, no AI until "Analyse this chat" |
| U4 | Show names of conflicting events to the AI | off (busy/free only) |
| U5 | Backlog window after pairing | 0 h (from now) - the orchestrator note Q5 proposed 24 h |
| U6 | Retention of message snapshots and drafts | 30 days |
| U7 | Start with Windows | off, toggle in onboarding and settings |
| U8 | `[R2]` Reading of "calendar via the LLM's MCP": LLM = read-only tool calling (`get_current_time`, `get_freebusy`); `create-event` executed by the app through the same MCP client after the approval click | as stated (A9); one sentence in the README privacy table |
| U9 | `[R2]` v1 cuts: `list_events`/share-titles, per-chat `local_only`, named toasts, time-zone picker, usage counter, extra shortcuts, onboarding pictures, full Ignored drawer | cut (ops/DECISIONS.md); each is a post-v1 ticket if wanted |
| U10 | `[R2]` Ship the VC++ CRT DLLs app-locally (needs `VC_REDIST_CRT_DIR` on the build PC) vs rely on the `LLM_VCREDIST_MISSING` pre-flight only | both; the build warns when the DLLs are absent |

---

## 20. Rejected ideas (do not reintroduce without a new decision)

| Idea | From | Why rejected |
|---|---|---|
| `node-llama-cpp` in-process / in a utilityProcess | research electron-stack | native addon, ABI coupling, template lag, 150-695 MB, crash isolation opt-in |
| MCP server in `utilityProcess` with a `process.stdin` shim, `runAsNode` off | safety | unverified hack that a server update can break silently; hardening gain on an unsigned per-user app is modest |
| MCP HTTP transport | - | unauthenticated loopback endpoint with calendar write access |
| Single tool loop ending in a forced virtual `submit_triage` tool | simplicity | forced `tool_choice` is rejected on `claude-fable-5-1` and UNVERIFIED with adaptive thinking and on llama-server+Gemma 4; 4B tool calling is the shakiest local feature |
| JSON-schema `anyOf` union (`call_tool` or `final`) to emulate local tool calling | ux | `anyOf` grammar conversion UNVERIFIED on b10964; not native tool calling |
| Tools + structured output in the same request | safety S3, ux | not reliably combinable on llama-server; needs a per-provider capability branch |
| Keyword/cue lexicon pre-filter that drops messages before the LLM | ux | silent recall loss with no telemetry to tune it; S1 is one short constrained call |
| Model computes dates / emits ISO start-end | simplicity schema | small models are unreliable at calendar arithmetic |
| Parsing the webhook body | safety, ux | unnecessary (global rowid scan); keeps base64 media out of the app |
| SQL timestamp comparisons on the bridge DB | safety safety-net scan | on-disk timestamp format is UNVERIFIED |
| Full message mirror table in `app.db` | safety | second plaintext copy of the whole DM corpus; a per-item snapshot of <= 12 rows is enough |
| No snapshot at all (read the bridge DB live for cards) | simplicity | cards lose their transcript after a store reset or JID migration; no record of what the model saw |
| Periodic `CalendarSync` every 15 min | ux | speculative; reconcile-by-tag covers crash recovery |
| Destroy/recreate the BrowserWindow on low-RAM machines; onboarding demo conversation; backlog choice screen | ux | speculative |
| `worker_threads` hash worker | ux | worker entry inside asar is one more packaging unknown; streamed hashing suffices |
| Audit hash chain; global "Safe mode" screen; `netstat` port-squat check | safety | little value against a same-user attacker; per-component fail-closed states + marker-before-token readiness cover the cases |
| `dependency-cruiser`, `ajv`, `openai`, `ipull`, `tree-kill`, bundled Heebo font | various | each removable with existing tools (ESLint + vitest, zod, fetch, own downloader, `taskkill`, Segoe UI) |
| `calendarsToCheck` on `create-event` | safety, research | server-side conflict behaviour UNVERIFIED; the executor does its own free/busy check |
| `update-event` / `delete-event` / attendees / recurrence / media / typing / reactions / groups | - | out of scope for v1; each needs its own approval UX |
| Plain CSS modules with no state library | simplicity | the researched Tailwind+Zustand set is already dependency-resolved and reduces cross-agent CSS conflicts at zero packaging cost |
| ASAR integrity fuse on; autostart pre-checked; Claude server-side `fallbacks` beta | safety/ux, ux, claude-api guidance | UNVERIFIED packaging behaviour; surprise for the user; beta namespace + UNVERIFIED TS typing |
| Silent provider fallback (cloud -> local or local -> cloud) | - | privacy: the user chose where messages go |
