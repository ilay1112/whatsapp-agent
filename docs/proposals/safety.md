# Architecture Proposal - SAFETY-FIRST

Project: WhatsApp Calendar Agent. Date: 2026-09-21. Author: architecture agent, angle "safety-first".
Inputs: all ten reports in `docs/research/`. Locked decisions are taken as given and not relitigated.
Anything I introduce that no research report verified is tagged **UNVERIFIED** and has a spike in section 17.

Design test used for every decision in this document:

> Assume the LLM is the attacker (it has just read a hostile WhatsApp message or calendar title) and assume any
> single child process can crash or hang at any moment. What is the worst thing that can happen?
> Required answer: a bad *draft* or a bad *event proposal* appears on screen for a human to read; nothing is
> sent, nothing is written to Google, no other chat's data is exposed, and the app recovers without user data loss.

---

## 1. The seven invariants (enforced in code, each with a test)

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I1 | No WhatsApp send and no calendar write without a per-action user click | Only `ActionExecutor` holds the send/write capabilities (section 6); DB trigger forbids `executing` unless `approved` | dependency-cruiser rule + fake-bridge/fake-MCP record zero writes across the whole injection corpus |
| I2 | The LLM can reach only READ calendar tools, with app-pinned arguments | `ToolGate` default-deny allowlist + `McpReadClient` facade that has no write method | scripted "obedient-to-attacker" fake provider emits every write/unknown tool name -> all blocked |
| I3 | The recipient of a send is the chat the trigger message came from - never model- or renderer-supplied | `actions.chat_id` set at ingest; executor re-derives JID from DB; strict DM regex | forged IPC with extra `chatJid` field is rejected by `.strict()` zod |
| I4 | Untrusted text never enters the system prompt or tool definitions | `buildSystemPrompt({nowIso,tz,lang})` typed + regex-validated inputs; tool defs are compile-time constants | property test: outputs byte-identical for random untrusted inputs |
| I5 | One chat per LLM context; cloud payloads carry no names, numbers or JIDs | `ContextBuilder` takes exactly one `chat_id`; `Minimizer` runs before every provider | payload snapshot test per provider |
| I6 | The bridge can never touch the user's live store, port 8080, or the default webhook/outbox | `assertBridgeSpawnInvariants()` refuses to spawn otherwise (section 4.3) | unit test per violated precondition |
| I7 | A crash of bridge / llama-server / MCP server never takes down the tray app and never causes a duplicate side effect | every heavy component is a separate OS process under one supervisor; write-ahead action log + idempotency keys | kill -9 style tests against fake children; "crash between execute and commit" test |

---

## 2. Process model

```
                         +---------------------------------------------------------------+
                         | Electron MAIN (trusted broker, ESM, only process with secrets) |
                         |  lifecycle/tray | IPC router (zod+sender check) | app.db       |
                         |  Supervisor+Reaper | WebhookDoorbell (127.0.0.1:rand)          |
                         |  Ingest (reads bridge messages.db READ-ONLY)                   |
                         |  Agent pipeline: Stage0 filter -> LLM runs -> Validator        |
                         |  ToolGate -> McpReadClient        ActionExecutor -> send/write |
                         +--+----------------+------------------+-------------------+-----+
        IPC (allow-listed)  |   REST+Bearer  |  OpenAI-style    |  MCP JSON-RPC     | HTTPS
                            v                v  HTTP+API key    v  (no network port)v
  +----------------+  +--------------------+ +------------------+ +----------------+  Claude / Gemini
  | RENDERER       |  | whatsapp-bridge.exe| | llama-server.exe | | calendar MCP    |  (only after consent)
  | sandboxed,     |  | child, cwd =       | | child, lazy,     | | server, child,  |
  | contextIsolated|  | <userData>\bridge  | | 127.0.0.1:rand   | | googleapis ->   |
  | app:// + CSP   |  | 127.0.0.1:rand     | | --offline        | | Google Calendar |
  | connect-src    |  +--------------------+ +------------------+ +----------------+
  | 'none'         |
  +----------------+
```

| Process | Tech | Started | Holds | Crash effect | Restart |
|---|---|---|---|---|---|
| Main | Electron 44.4.3 main, ESM | app start | API keys (decrypted in memory only while a run needs them), bridge token, webhook secret, llama API key, app.db | app restarts from tray/autostart; children reaped at next start (section 12) | - |
| Renderer | React 19 in sandbox, no Node, no network | window create | display data only; no secrets, no JIDs as identifiers (opaque `chatRef`/`itemId`/`actionId`) | window reload; main state unaffected | `render-process-gone` -> recreate window |
| Bridge | the exact prebuilt `whatsapp-bridge.exe` (SHA-256 `AC23221E...2FF5`) | after ToS disclosure accepted | WhatsApp session in its own `store\` | dashboard shows "WhatsApp offline"; sends disabled; ingest resumes by DB catch-up | backoff 2/5/15/60 s, circuit breaker 5 crashes / 10 min |
| llama-server | official llama.cpp `b10964` Vulkan x64 zip, `llama-server.exe` | lazily, first Local run; idle-unloads after 600 s | model in RAM/VRAM | run fails -> item stays `untriaged`, retried once; persistent -> CPU fallback -> "Local model failed" banner | max 3 / 10 min |
| Calendar MCP | `@cocal/google-calendar-mcp@2.6.3`, Node code run by Electron | after Google credentials exist | Google OAuth tokens (file) | event proposals/approvals disabled, drafts still work | backoff, circuit breaker |

Decisions and why (safety angle):

1. **Local LLM = `llama-server.exe` child, not `node-llama-cpp` in-process.** A Vulkan driver fault or OOM abort in a native addon would kill the tray app, the supervisor and the approval state machine with it. Out-of-process gives crash isolation for free, removes the native-addon/asarUnpack/ABI surface, and keeps one supervisor pattern for all three children. It is still "llama.cpp embedded in the app": shipped inside the installer, started/stopped by the app, loopback only.
2. **No separate "agent worker" process.** The pipeline runs in main. I considered a quarantined utility process holding the LLM SDKs with only `readTool`/`submitProposal` RPCs. Honest assessment: any same-user Node process can read `whatsapp.db` from disk anyway, so the gain against a compromised npm dependency is small, while the IPC complexity is large. Capability separation is therefore enforced at module level (section 6.4) and listed as a weakness (W3).
3. **Calendar MCP server runs with the `runAsNode` fuse OFF** - primary plan: `utilityProcess.fork()` plus a 60-line stdin shim (section 5.1). Fallback if the spike fails: `ELECTRON_RUN_AS_NODE=1` spawn with the fuse ON (the path verified by the calendar-mcp research). Never the HTTP transport: an unauthenticated loopback port with calendar write access is strictly worse than either stdio option.
4. **The webhook is a doorbell only.** Its payload content is discarded; the only source of message truth is the app-owned `messages.db` opened read-only. A forged webhook can therefore do nothing except trigger a harmless scan.

---

## 3. Trust boundaries and taint rule

- `TRUSTED`: app constants, system prompt, app-authored tool definitions, user settings, user clicks and user edits.
- `UNTRUSTED`: message text, quoted text, push/contact names, filenames, calendar event text, MCP server tool descriptions and results, bridge/llama/MCP stdout, **and every LLM output produced after untrusted text was in context**. Stored LLM output stays untrusted forever (no promotion by persistence).
- UNTRUSTED data may appear only: (a) inside the nonce-delimited JSON data block of a user-role message, (b) inside projected tool-result blocks, (c) in the renderer as inert text inside a visually distinct quoted bubble. Never in app chrome, banners, toasts, tray tooltip, window title, system prompt, tool definitions, log lines, URLs passed to `shell.openExternal`.

---

## 4. WhatsApp bridge integration

### 4.1 Files
- Exe: `<resources>\bridge\whatsapp-bridge.exe` (extraResources), MIT `LICENSE` next to it, Go source vendored under `vendor/whatsapp-bridge-src/` for reference only (never built, never packaged).
- Runtime cwd: `<userData>\bridge\` -> the bridge creates `<userData>\bridge\store\{whatsapp.db,messages.db,<jid>\media}` itself.
- Outbox: `<userData>\bridge\outbox-empty\` - created by the app, never written to. The app never sets `media_path`.

### 4.2 Spawn contract
```
WHATSAPP_BRIDGE_PORT   = free ephemeral port (listen :0 on 127.0.0.1, close, reuse); never 8080
WHATSAPP_BRIDGE_TOKEN  = crypto.randomBytes(32).toString('hex'), new on EVERY launch, memory only
WEBHOOK_URL            = http://127.0.0.1:<doorbellPort>/hook/<32-byte base64url secret, per launch>
FORWARD_SELF           = true
WHATSAPP_MEDIA_ROOTS   = <userData>\bridge\outbox-empty
+ minimal OS env only: SystemRoot, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA  (never process.env wholesale)
args: []   (never --full-history-pair)      stdio: ['ignore','pipe','pipe']   windowsHide: true   shell: false
```

### 4.3 `assertBridgeSpawnInvariants()` - refuse to spawn unless ALL hold
1. `realpath(cwd)` is inside `realpath(app.getPath('userData'))` (`path.relative` does not start with `..`), and the string does not contain the user's live bridge folder path (belt).
2. All five env vars present and non-empty; port is not 8080; `WEBHOOK_URL` host is literally `127.0.0.1` and its port equals our live doorbell listener's port.
3. Streamed SHA-256 of the exe equals the compile-time constant `BRIDGE_SHA256` (`timingSafeEqual`). Mismatch -> "Component modified or quarantined" error state, no spawn.
4. `outbox-empty` exists and is empty.
5. No live process from `bridge.pid` (reaper ran first).
6. WhatsApp ToS/ban-risk disclosure accepted (consent row exists).

After spawn: poll `GET /api/pairing/status` with our bearer at `http://127.0.0.1:<port>` (`redirect:'error'`, 15 s timeout). `401` means the port belongs to something else -> kill, new port, retry (max 3). Stdout marker `REST API server error` -> same. SHOULD: confirm via `netstat -ano` that the listening PID is `child.pid` before the first authenticated request (port-squat check).

### 4.4 Endpoints the app is allowed to call (hard-coded in `BridgeClient`)
`GET /api/health`, `GET /api/pairing/status`, `GET /api/pairing/qr.png` via `BridgeReadClient`; `POST /api/send` via `BridgeSendClient` (constructed once, handed only to `ActionExecutor`). Not implemented at all: `/api/typing`, `/api/react`, `/api/download`, `/api/media`, `/api/group/*`. There is no code path that can produce a visible side effect on the contact's side other than an approved send.

### 4.5 Stdout handling
Decode UTF-8, strip ANSI, match the marker table from the bridge-contract report, emit state events. **Raw bridge stdout is never persisted** (it contains message bodies and numbers). Only marker names reach the log.

### 4.6 Doorbell listener
`http.createServer` on `127.0.0.1:0`, `exclusive:true`. Accept only: `POST`, remote address `127.0.0.1`, `Host: 127.0.0.1:<port>`, path equals `/hook/<secret>` (constant-time), `X-Bridge-Token` equals the bearer (constant-time), `Content-Type: application/json`, no `Origin` header, body <= 20 MB. Everything else -> uniform `404`. Behaviour: answer `200` immediately; if body <= 256 KB parse it and read only `chatJID`, `isFromMe`, `eventType`; larger bodies (inline images) are not parsed at all -> enqueue a global scan. **All content fields including `mediaBase64` are dropped on the floor.** Intake limiter: 30 req/s, queue max 500.

### 4.7 Ingest (the only reader of `messages.db`)
- Open `<userData>\bridge\store\messages.db` with `new DatabaseSync(p,{readOnly:true})` per scan, short transactions, `busy_timeout`, retry on `SQLITE_BUSY`, never change journal mode, never add indexes.
- Cursor: `meta.bridge_cursor_rowid`; query `rowid > cursor` filtered to DM JIDs (`%@s.whatsapp.net`; `@lid` rows are ingested but marked `unsendable` until the bridge migrates them to a phone JID). De-dupe on `(chat_id, wa_msg_id)`. **UNVERIFIED** that upserts advance rowid - hence a second safety net: every 60 s and on startup / reconnect / `History sync complete`, a per-chat `timestamp > last_scanned_ts - 5 min` scan.
- Timestamps parsed defensively to epoch ms (format UNVERIFIED; parser accepts go-sqlite3 text forms and integers; unparseable -> row treated as backlog).
- **Backlog gate:** `meta.live_from_ts = max(pairedAt, firstConnectedAt)`. Rows older than `live_from_ts` or older than 24 h at ingest time get `origin='backlog'`: usable as context for that same chat, never trigger a run, and never sent to a cloud provider unless they fall inside the 12-message window of a live trigger.
- Media janitor: deletes files (never `*.db`, never dotfiles) under `<userData>\bridge\store\<jid>\` older than 24 h; path-prefix assertion before every delete. The app does not use media.

---

## 5. Calendar through MCP

### 5.1 Launching the server with `runAsNode` OFF (primary) - **UNVERIFIED, spike S1**
`utilityProcess.fork(<resources>/calendar-mcp/shim.mjs, [], { serviceName:'mcp-calendar', stdio:['ignore','pipe','pipe'], env })`. The shim (ours, ~60 lines):
1. creates a `PassThrough`, `Object.defineProperty(process,'stdin',{value:pt})` **before** importing the server, so the SDK's `StdioServerTransport` (which defaults to `process.stdin`) reads from it;
2. `process.parentPort.on('message', e => pt.write(e.data))`;
3. sets `process.argv = [execPath, entry, 'start', '--transport', 'stdio']` and `await import(<server>/build/index.js)`.
Server stdout stays a real pipe. Main implements a 40-line MCP `Transport`: `send()` = `child.postMessage(JSON line)`, receive = line-split `child.stdout`. No TCP port exists at any point.
Env passed: `GOOGLE_OAUTH_CREDENTIALS`, `GOOGLE_CALENDAR_MCP_TOKEN_PATH` (both under `<userData>\google\`), `GOOGLE_ACCOUNT_MODE=personal`, `ENABLED_TOOLS`, `NODE_ENV=production`, minimal OS env. Never API keys, never the bridge token.

Fallback (if S1 fails within its time box): `StdioClientTransport` with `command: process.execPath`, `ELECTRON_RUN_AS_NODE=1`, fuse `runAsNode: true`, plus the packaging test that performs an MCP `initialize` against the packaged exe. This is recorded as a conscious downgrade, not drift.

### 5.2 Server-side tool set (defence in depth, not the gate)
`ENABLED_TOOLS=get-current-time,get-freebusy,list-events,list-calendars,create-event,manage-accounts`.
Not enabled in v1: `update-event`, `delete-event`, `create-events`, `respond-to-event`, `search-events`, `get-event`, `list-colors`. With delete/update absent at the server, "delete all my events" is impossible through this app regardless of bugs above it. Startup check: `tools/list` must equal exactly this set, and every tool we classify as read must carry `readOnlyHint:true`; otherwise calendar features stay disabled (fail closed) and a security event is logged. SHOULD: compare `sha256(JSON(tools/list))` with the build-time pin for 2.6.3.

### 5.3 How calendar tools reach the LLM (exactly)
```
 LLM provider --toolCalls--> Orchestrator --> ToolGate.invoke(name, rawArgs, runCtx)
                                                 1 name in READ_TOOLS ?            no -> blocked + audit + synthetic {"error":"tool not available"}
                                                 2 per-run budget left ?           (2 blocked calls -> abort run, badge "suspicious")
                                                 3 args = constrainReadArgs(...)   zod .strict(); app pins calendar ids, tz, account; clamps window
                                                 4 McpReadClient.call(name,args)   facade: the ONLY methods are getCurrentTime/getFreeBusy/listEvents
                                                 5 project(result)                 -> BusyBlock[] {start,end,title?}; unparseable -> {"error":"unavailable"}
                                                 6 wrap in nonce data block  --> tool result message back to the LLM
```
- LLM-facing tools (compile-time constants, **app-authored** names/descriptions/schemas in the lowest-common-denominator JSON-Schema subset: plain `type`, `properties`, `required`, `additionalProperties:false`, no `$ref`, no type arrays):
  - `get-current-time` `{}` (max 1 call/run)
  - `get-freebusy` `{timeMin, timeMax}` (max 3 calls/run) - default and preferred: returns no titles
  - `list-events` `{timeMin, timeMax}` (max 2 calls/run) - exposed only when the user enables "show names of conflicting events"; result projected to `start`, `end`, `title` (sanitised, <= 60 chars); description/location/attendees/links are dropped before the model sees anything.
- Because tool definitions are ours, MCP tool-description poisoning, the Gemini schema sanitiser problem and the gemma4 template crash on type arrays all disappear. A startup contract test checks our schemas are a subset of the server's real `inputSchema` (required fields exist), else fail closed.
- Arg pinning: `calendars`/`calendarId` = user-selected ids from settings; `timeZone` = settings; `account='personal'`; `timeMin >= now`, window <= 14 days, horizon <= 60 days. Free-text `query` does not exist in our surface.
- Provider adapters map `-` <-> `_` in tool names if a provider rejects dashes.
- Loop limits: 4 turns, 6 tool calls, 1024 output tokens, 60 s cloud / 180 s local wall clock. Tool calls from a `max_tokens` or `refusal` turn are never executed.
- In addition the app itself prefetches `get-freebusy` for the resolved slot through the same ToolGate path and places the projection in the planning prompt, so weak local models need zero tool calls for the common case; the tools remain available for exploring alternatives.

### 5.4 WRITE path
`McpWriteClient` has exactly one method, `createEvent(args: CreateEventArgs)`, and one owner, `ActionExecutor`. Args are built by `toCreateEventArgs()` from a validated event with an explicit field whitelist:
`calendarId` (settings), `summary` (<= 80 chars, single line, URLs stripped), `start`, `end`, `timeZone`, `location?` (<= 120), `description` = app template (never model text), `sendUpdates:'none'`, `allowDuplicates:false`, `calendarsToCheck` (settings), `extendedProperties.private = {waAgent:'1', waItem:<itemId>, waAction:<actionId>}`, and a **deterministic `eventId`** = base32hex(sha256(actionId)) so a retry after an unknown outcome cannot create a second event (**UNVERIFIED** how the MCP server surfaces Google's 409; treated as success after a `list-events` tag lookup). Never: attendees, recurrence, conferenceData, attachments, reminders, colorId, source, visibility.
`manage-accounts` is reachable only from `GoogleAuthService` (wizard/settings).

---

## 6. Data flow: webhook -> triage -> state -> approval -> execution

### 6.1 Pipeline
```
doorbell/scan -> Ingest -> [S0 deterministic filter] -> item(untriaged) -> per-chat debounce 20 s
   -> [S1 EXTRACT  LLM, no tools, schema-constrained]      -> Extraction
   -> [S2 RESOLVE  TypeScript: dates, sanity, state]        -> needs_reply | info_missing | ignored
   -> [S3 PLAN+DRAFT LLM, READ tools via ToolGate, final schema-constrained output] -> Draft
   -> [S4 VALIDATE deterministic post-checks, badges]       -> proposals row + actions rows (state=pending)
   -> dashboard card -> user click -> [S5 ActionExecutor, no LLM] -> bridge /api/send | MCP create-event
```

**S0 filter (no LLM).** Drop non-DM JIDs (`@g.us`, `status@broadcast`, `@newsletter`, `@broadcast`), reactions, empty text, `deleted_at` rows. `from_me` rows never trigger a run; they mark the chat's open item `reply_state='answered_elsewhere'`. Gates, in order: agent paused -> stays `untriaged`; chat policy `never` -> `ignored`; **unknown-sender gate** (the user has never sent a message in this chat according to the bridge DB) -> not LLM-processed, not listed, counted in a footer "N messages from unknown senders" with a per-chat "start processing" action; backlog -> context only; budgets exhausted -> stays `untriaged` with a visible counter; cloud provider + chat policy `local_only` -> skipped with reason.

**S1 extract.** Context = last 12 messages / 6,000 chars of this one chat, each `sanitizeForModel()` (NFKC, strip TAG block, bidi controls, zero-width, C0) and cut to 2,000 chars, role labels `user`/`contact`, JSON-encoded inside `<<DATA-nonce>>` markers in a user-role message. Output schema (strict; identical for all providers):
```ts
Extraction = { intent: 'schedule_request'|'reschedule'|'cancel'|'confirmation'|'smalltalk'|'other',
  needsReply: boolean, language: 'he'|'en', title: string|null (<=80),
  dateExpr: { kind:'absolute'|'weekday'|'relative_days'|'none', isoDate?, weekday?:0..6, weekOffset?:0|1|2, daysFromToday?:0..60 },
  time24h: string|null, durationMin: number|null, location: string|null (<=120),
  missing: ('date'|'time'|'duration'|'location'|'who'|'confirmation')[], suspicious: boolean }
```
Deliberately absent: recipient, JID, attendees, calendarId, eventId, sendUpdates, URLs, flags of any kind. The model never does date arithmetic: the prompt carries a precomputed 14-day weekday table (he+en) and S2 resolves `dateExpr` in TypeScript (`Asia/Jerusalem` default, Sunday-first). No schema-valid output after one retry -> `info_missing` with reason `unparsed`, no draft.

**S2 resolve.** Pure function. `smalltalk/other && !needsReply` -> `ignored`. Event sanity: start not in the past, <= 12 months ahead, duration 5 min..12 h (default 60). Missing date/time -> `event_state='incomplete'` -> list "Information missing". Ambiguous hour without am/pm cue (1-7): assumed PM + amber badge "time assumed" (user-dialog decision D4).

**S3 plan+draft.** Input: extraction + resolved slot + prefetched busy projection. Tools: section 5.3. Final structured output `Draft = { draftReply: string|null (<=600), replyLang:'he'|'en', alternatives: {startLocal,endLocal}[] (<=3), suspicious: boolean }`. Reply language = sender language by deterministic script counting; the model only receives it as a directive.

**S4 validate.** URL/domain in draft not present in the user's own earlier messages -> stripped + red badge; phone/e-mail/6+ digit runs/calendar titles echoed in draft -> amber "contains personal details"; invisible/bidi chars stripped from outputs; `suspicious`, a blocked tool call or an injection-heuristic hit -> red badge and the draft is collapsed behind "show anyway" (advisory only); draft language != chat language -> amber. Then, in one transaction: insert `proposals` row, supersede older pending actions of the item, insert up to two `actions` rows (`send_reply`, `create_event`) with `canonical_json`, `content_sha256`, `idempotency_key = itemId:kind:proposalVersion`, `expires_at = now + 24 h`.

### 6.2 Item state
One open item per chat (partial unique index). Two sub-states drive the list the item appears in:

| reply_state | event_state | -> `state` (dashboard list) |
|---|---|---|
| any | `created` | `in_calendar` ("In calendar") |
| any except closed | `incomplete` | `info_missing` ("Information missing") |
| `draft` | `none` / `proposed` | `needs_reply` ("Needs reply") |
| `sent` / `answered_elsewhere` | `proposed` | `needs_reply` (only the event approval remains) |
| `sent` / `answered_elsewhere` / `skipped` | `none` / `declined` | `ignored` (closed) |
| - | - | `untriaged` (waiting for LLM / paused / budget), `error` |

`deriveState(reply_state, event_state)` is a pure shared function; the stored `state` column exists only for indexing. A new live message in a chat with an open item re-runs S1-S4 and supersedes the pending actions (old `actionId`s become `expired`, so a stale card cannot be approved: the hash check fails).

### 6.3 Approval and execution (S5)
Card contents (renderer): recipient name **and** formatted phone number from the app DB; the quoted trigger message; the draft in a plain `<textarea>` (what is in the box at click time is what is sent; no markdown, no link previews); the event rendered by the app from structured fields with `Intl.DateTimeFormat`, weekday, explicit time zone, `<bdi>` isolation; badges. Two separate buttons = two separate approvals. No "approve all", no per-contact auto-approve, no approval from toasts or the tray.

`action:approve {actionId, kind, shownHash, edit?}` in main:
1. trusted sender frame (`app://bundle`, our window's main frame); window must be visible and focused; zod `.strict()`.
2. load action; `kind` matches; `state='pending'`; not expired; `sha256(canonical_json) === shownHash` (what the user saw is what we hold).
3. apply user edit (TRUSTED but still schema-validated and length-capped; invisible chars stripped); store `approved_final_json`.
4. rate limiters (sends: 1/5 s and 6/h per chat, 20/h and 60/day global; creates: 10/h, 30/day); sends are serialised with 3-8 s jitter.
5. **write-ahead:** `state pending -> approved -> executing` committed *before* the side effect.
6. execute:
   - `send_reply`: JID re-read from `chats` via `actions.chat_id`; must match `^[0-9]{5,20}@s\.whatsapp\.net$`; trigger message must belong to that chat; bridge must be `connected`; `POST /api/send {recipient, message}` - nothing else in the body, ever. Afterwards look up the newest `is_from_me` row with the same text in the bridge DB to record the WhatsApp message id.
   - `create_event`: re-run sanity checks (time has passed), fresh app-side `get-freebusy` -> if busy, return `needs_confirm_conflict` (one more explicit click), then `McpWriteClient.createEvent(toCreateEventArgs(...))`.
7. `state -> done | failed(error_code)`; audit row; dashboard push.

Crash between 5 and 7 leaves `executing`. On next start these become **`unknown_outcome` and are never auto-retried**. Reconciliation: for sends, search the bridge DB for a matching `is_from_me` row after `approved_at`; for events, `list-events` with `privateExtendedProperty waAction=<id>`. Found -> `done`; not found -> card shows "We could not confirm this was sent - check WhatsApp" with an explicit "Send again" (a new action, a new click).

### 6.4 Capability separation by construction
- Composition root `src/main/compose.ts` is the only place that constructs `BridgeSendClient` and `McpWriteClient`, and passes them only to `new ActionExecutor(...)`.
- `src/main/agent/**` and `src/main/llm/**` may not import `src/main/exec/**`, `bridge/send-client.ts`, `mcp/write-client.ts` or the raw MCP `Client`. Enforced by dependency-cruiser in `npm run lint` and by a vitest that walks the import graph.
- `src/main/exec/**` may not import `src/main/llm/**` (no LLM in the execution stage).
- No IPC channel accepts a JID, tool name, MCP arguments, URL or file path.
- DB trigger on `actions`: `executing` only from `approved`; `approved` requires `approved_at`; terminal states are immutable.

---

## 7. LLM provider abstraction (Local / Claude / Gemini)

```ts
// src/main/llm/types.ts
export interface LlmTool { name: string; description: string; inputSchema: JsonSchemaLcd }   // app-authored only
export interface LlmToolCall { id: string; name: string; input: Record<string, unknown> }
export type LlmMessage =
  | { role:'system'; content:string }                       // built only by buildSystemPrompt()
  | { role:'user'; content:string }
  | { role:'assistant'; content:string; toolCalls?:LlmToolCall[]; providerData?:unknown }  // opaque verbatim replay
  | { role:'tool'; results:{ toolCallId:string; content:string; isError?:boolean }[] }
export interface LlmResponse { text:string; toolCalls:LlmToolCall[];
  stopReason:'end'|'tool_use'|'max_tokens'|'refusal'|'other'; usage?:Usage;
  assistantMessage: Extract<LlmMessage,{role:'assistant'}> }
export interface LlmProvider {
  readonly id:'local'|'claude'|'gemini'
  readonly caps:{ structuredWithTools:boolean }
  chat(messages:LlmMessage[], tools:LlmTool[], signal:AbortSignal): Promise<LlmResponse>          // ONE model turn, never executes tools
  structured<T>(messages:LlmMessage[], schema:JsonSchemaLcd, signal:AbortSignal): Promise<T>      // schema-constrained, no tools
  validate(signal:AbortSignal): Promise<{ok:true;model:string}|{ok:false;reason:ProviderErrorCode}>
}
```
Rules common to all three: providers receive no MCP client, no bridge client, no DB; the orchestrator owns the loop; a run finishes on the provider that started it (thought-signature replay); every provider output is re-validated with zod `.strict()` regardless of provider-side constraints; typed error codes (`auth`, `billing`, `quota_daily`, `rate_limited`, `model_not_found`, `overloaded`, `network`, `aborted`, `bad_output`) with "no retry" for `auth/billing/quota_daily`.

| | Local | Claude | Gemini |
|---|---|---|---|
| Transport | `fetch` to `llama-server` `/v1/chat/completions`, Bearer = per-launch `LLAMA_API_KEY` | `@anthropic-ai/sdk@0.127.0`, explicit `apiKey`, manual loop | `@google/genai@~2.23.0` Interactions API |
| `chat` | `tools`, `tool_choice:'auto'`; thinking disabled | `tools`, `tool_choice:{type:'auto'}`; replay `response.content` verbatim; never the SDK tool runner / `mcpTools()` / server-side MCP connector | `{type:'function'}` tools; **`store:false` set in exactly one function + unit test**; replay `steps` verbatim; never `mcpToTool()` / `mcp_server` tool |
| `structured` | `response_format:{type:'json_schema'}` (GBNF), temperature 0-0.2, separate call from tools | `output_config.format` json schema | `response_format` with schema |
| Params | per-model flags from the manifest | `output_config.effort:'low'` only on Opus 5 / Sonnet 5; never temperature/top_p/budget_tokens/prefill | `generation_config.thinking_level:'low'`; no temperature |
| Default model | tier manifest (section 8) | `claude-sonnet-5` (user decision D2), list from `models.list()` | `gemini-3.8-flash`, id editable |
| Activation | default, no consent needed | blocked by factory unless `consents(cloud_claude, currentVersion)` exists | same, plus free-tier training/human-review warning |

Cloud minimisation (also applied to Local for one code path): role labels only, no names/JIDs/numbers, no media, no quoted-sender ids, optional masking of 8-19 digit runs. Keys are decrypted with `safeStorage.decryptStringAsync` when a client is constructed, held in memory, never logged, never in URLs, never sent to the renderer.

---

## 8. Local runtime and models

- Binary: llama.cpp `b10964` `llama-b10964-bin-win-vulkan-x64.zip`, sha256 `1ee3ad95...c642`, fetched and verified by `scripts/fetch-llama.mjs` at build time; only `llama-server.exe`, all DLLs and LICENSE are packaged. **No executable is ever downloaded at runtime.**
- Spawn: `-m <gguf> --host 127.0.0.1 --port <rand> --jinja --no-webui --offline -c 8192 -np 1 --sleep-idle-seconds 600 --reasoning-budget 0` (+ `--cache-ram 0` below 16 GB RAM, + `--device none` after a failed GPU self-test), key via env `LLAMA_API_KEY`, **minimal env (not `process.env`)**, `cwd` = bin dir, `shell:false`. **No `--log-file`**: llama-server logs may contain prompt text; stdout/stderr go through the marker-only filter. Disable `/slots`-style introspection endpoints if the pinned build exposes them (**UNVERIFIED** flag name).
- Post-load self-test (fixed prompt, expect known JSON) -> on garbage/timeout persist `localLlm.device='cpu'`. Micro-benchmark; below 5 tok/s *suggest* (never auto) a smaller tier.
- Tier manifest = compile-time constant `{tier, repo, commit(40 hex), file, sizeBytes, sha256, flags}`:
  - small (default for >= 12 GB RAM, CPU/iGPU): Gemma 4 E4B-it Q4_K_M (4,977,171,584 bytes, sha256 `85a896a0...fab87`); < 12 GB RAM: Gemma 4 E2B-it Q4_K_M
  - mid (dedicated VRAM >= 7.5 GB and RAM >= 15 GB, or no dGPU and RAM >= 30 GB; partial offload 5.5-7.5 GB): Gemma 4 12B-it QAT UD-Q4_K_XL
  - integrated-GPU "VRAM" is never counted; free disk < 12 GB forces small.
  - Hardware probe: `os.totalmem()` + tolerant parser of `llama-server.exe --list-devices`.
- Downloader: HTTPS only, `redirect:'manual'` with a host allowlist for the CDN hop (exact hosts captured during implementation), always re-request the `huggingface.co/<repo>/resolve/<commit>/<file>` URL on retry, Range resume into `.part` + sidecar, free-disk check, GGUF magic check, full sha256 verify against the compile-time pin, atomic rename; mismatch -> delete. Progress (bytes, speed, ETA) pushed over `model:progress`. Re-hash only when size/mtime changed.
- Release gate: the 40-60 item Hebrew/English golden set must pass before the model pins are locked.

---

## 9. App SQLite schema (`<userData>\app.db`, `node:sqlite`, WAL)

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;   -- migrations via PRAGMA user_version

CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- paired_at, live_from_ts, bridge_cursor_rowid, last_backup_at, tray_hint_seen
CREATE TABLE settings  (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE secrets   (name TEXT PRIMARY KEY CHECK(name IN('anthropic_api_key','gemini_api_key')),
                        ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);           -- safeStorage (DPAPI)
CREATE TABLE consents  (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('whatsapp_tos','cloud_claude','cloud_gemini')),
                        version INTEGER NOT NULL, accepted_at INTEGER NOT NULL, UNIQUE(kind,version));

CREATE TABLE chats     (id INTEGER PRIMARY KEY, jid TEXT NOT NULL UNIQUE, display_name TEXT,       -- display_name is UNTRUSTED
                        is_known INTEGER NOT NULL DEFAULT 0, sendable INTEGER NOT NULL DEFAULT 0,
                        policy TEXT NOT NULL DEFAULT 'default' CHECK(policy IN('default','never','local_only')),
                        lang TEXT, last_scanned_ts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE messages  (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id),
                        wa_msg_id TEXT NOT NULL, ts INTEGER NOT NULL, from_me INTEGER NOT NULL,
                        text TEXT,                                   -- snapshot; purged after retention, hash kept
                        text_sha256 TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN('live','backlog')),
                        ingested_at INTEGER NOT NULL, UNIQUE(chat_id, wa_msg_id));
CREATE INDEX ix_messages_chat_ts ON messages(chat_id, ts);

CREATE TABLE items     (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id),
                        trigger_message_id INTEGER NOT NULL REFERENCES messages(id),
                        state TEXT NOT NULL CHECK(state IN('untriaged','needs_reply','info_missing','in_calendar','ignored','error')),
                        reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state IN('none','draft','sent','answered_elsewhere','skipped')),
                        event_state TEXT NOT NULL DEFAULT 'none' CHECK(event_state IN('none','incomplete','proposed','created','declined')),
                        missing_json TEXT NOT NULL DEFAULT '[]', badges_json TEXT NOT NULL DEFAULT '[]',
                        hold_reason TEXT, calendar_event_id TEXT, calendar_html_link TEXT,
                        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX ux_items_open ON items(chat_id) WHERE state IN('untriaged','needs_reply','info_missing');
CREATE INDEX ix_items_state_updated ON items(state, updated_at DESC);

CREATE TABLE runs      (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), stage TEXT NOT NULL,
                        provider TEXT NOT NULL, model TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
                        outcome TEXT, input_tokens INTEGER, output_tokens INTEGER,
                        tool_calls INTEGER NOT NULL DEFAULT 0, blocked_tool_calls INTEGER NOT NULL DEFAULT 0,
                        error_code TEXT);                           -- metadata only: no prompts, no completions
CREATE TABLE proposals (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), run_id INTEGER REFERENCES runs(id),
                        version INTEGER NOT NULL, extraction_json TEXT NOT NULL, draft_text TEXT, reply_lang TEXT,
                        event_json TEXT, suspicious INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL, superseded_at INTEGER, UNIQUE(item_id, version));

CREATE TABLE actions   (id TEXT PRIMARY KEY,                           -- uuid v4, the only handle the renderer gets
                        item_id INTEGER NOT NULL REFERENCES items(id), proposal_id INTEGER NOT NULL REFERENCES proposals(id),
                        chat_id INTEGER NOT NULL REFERENCES chats(id),  -- recipient pinned here at creation
                        kind TEXT NOT NULL CHECK(kind IN('send_reply','create_event')),
                        canonical_json TEXT NOT NULL, content_sha256 TEXT NOT NULL,
                        idempotency_key TEXT NOT NULL UNIQUE,
                        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
                          ('pending','approved','executing','done','failed','unknown_outcome','rejected','expired')),
                        approved_at INTEGER, approved_final_json TEXT, executed_at INTEGER,
                        result_json TEXT, error_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TRIGGER trg_actions_state BEFORE UPDATE OF state ON actions BEGIN
  SELECT CASE
    WHEN OLD.state IN('done','rejected','expired') THEN RAISE(ABORT,'terminal state')
    WHEN NEW.state='approved'  AND (OLD.state<>'pending' OR NEW.approved_at IS NULL) THEN RAISE(ABORT,'bad approve')
    WHEN NEW.state='executing' AND OLD.state<>'approved' THEN RAISE(ABORT,'execute without approval')
    WHEN NEW.state='done'      AND OLD.state NOT IN('executing','unknown_outcome') THEN RAISE(ABORT,'bad done')
  END; END;

CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,  -- tool_blocked, action_approved,
                        ref TEXT, detail_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL); -- action_done, consent, spawn_refused...
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TABLE rate_events (id INTEGER PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX ix_rate ON rate_events(bucket, key, ts);
CREATE TABLE model_files (id TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                          mtime INTEGER NOT NULL, verified_at INTEGER NOT NULL, bench_json TEXT);
```
- `audit_log.detail_json` holds metadata only (ids, hashes, lengths, tool names) - never text, args or results.
- Retention job (daily): `messages.text`, `proposals.draft_text/extraction_json/event_json` nulled after 30 days (configurable); closed items after 90 days; `runs` and `audit_log` after 180 days.
- Recoverability: `PRAGMA quick_check` at start; daily `VACUUM INTO <userData>\backups\app-YYYYMMDD.db` (keep 3). Corrupt DB -> restore newest backup -> if none, start empty: WhatsApp pairing and model survive (separate files), "In calendar" is rebuilt from Google via `list-events privateExtendedProperty waAgent=1`, open items are rebuilt by a 24 h rescan. Pending approvals are intentionally **not** reconstructed.
- Not encrypted in v1 (`node:sqlite` has no SQLCipher; the bridge DBs are plaintext regardless). See W6.

---

## 10. IPC surface (complete; preload allow-list duplicates these literals)

Every handler: trusted-sender check, zod `.strict()` request schema, typed `Result`. The renderer identifies things only by opaque `itemId` / `actionId` / `chatRef`. No channel accepts a JID, URL, path, tool name or MCP args.

| invoke channel | request | notes |
|---|---|---|
| `app:getBootState` | - | onboarding step, language, dir, component status |
| `ui:setLanguage` | `{lang:'system'|'en'|'he'}` | main persists, rebuilds tray, broadcasts |
| `dashboard:get` | - | three lists (latest 20 each) + counts + footer counters |
| `item:get` | `{itemId}` | quoted messages, draft, event, badges, actions `{actionId, kind, shownHash, state}` |
| `item:dismiss` / `item:retriage` | `{itemId}` | retriage is user-initiated and budget-limited |
| `action:approve` | `{actionId, kind, shownHash, edit?:{text}|{title,startLocal,endLocal,location}}` | section 6.3; also `{confirmConflict:true}` for the second click |
| `action:reject` | `{actionId}` | |
| `agent:setPaused` | `{paused}` | pauses LLM processing, not the bridge |
| `status:get` | - | bridge/LLM/MCP health, budgets used |
| `onboarding:acceptDisclosure` | `{kind:'whatsapp_tos', version}` | |
| `pairing:get` / `pairing:newCode` | - | QR as `data:` URL fetched by main; `newCode` = kill + respawn |
| `pairing:unlinkAndWipe` | `{confirm:true}` | stops bridge, deletes only `<userData>\bridge\store`, reminds to remove the linked device on the phone |
| `llm:getConfig` / `llm:setProvider` | `{provider}` | `setProvider` fails without consent / key / model |
| `consent:get` / `consent:accept` | `{kind, version}` | versioned, bilingual text shipped in the app |
| `secrets:set` / `secrets:has` / `secrets:clear` | `{name, value?}` | no `get`; UI shows last 4 chars computed in main |
| `llm:validateKey` | `{provider}` | free metadata call only |
| `model:getPlan` / `model:startDownload` / `model:pause` / `model:cancel` / `model:selfTest` | `{tier?}` | tier from enum, never a URL |
| `google:getWizardState` / `google:importCredentials` | `{jsonText}` (<= 16 KB) | file *content*, never a path; validated (`installed` key, client id suffix, secret present) |
| `google:startSignIn` / `google:status` / `google:disconnect` / `google:listCalendars` | - | `auth_url` is opened by main only if host is `accounts.google.com` |
| `settings:get` / `settings:set` | partial of an allow-listed settings schema | |
| `chat:setPolicy` | `{chatRef, policy}` / `{chatRef, startProcessing:true}` | |
| `external:open` | `{target: enum}` | hard-coded URL table (consoles, help, Windows settings); plus `{itemId, target:'calendarEvent'}` validated against `https://(www|calendar).google.com/` |
| `data:purgeNow` / `diagnostics:export` | - | export = redacted metadata logs only |

Push events: `dashboard:changed` (debounced 150 ms), `status:changed`, `pairing:changed`, `model:progress`, `google:authChanged`, `ui:languageChanged`.

---

## 11. Onboarding, settings, tray

### 11.1 Onboarding (resumable; each step persisted)
0. Language (he/en; default from `app.getPreferredSystemLanguages()`, `iw` = he).
1. Plain-words disclosure + explicit accept: unofficial linked device, possible ban, needs one free linked-device slot, what the app reads, that nothing is sent or added without a click. No accept -> the bridge is never spawned.
2. AI engine: **Local (default, private)** -> hardware probe -> recommended tier + size -> download starts and continues in the background; or Claude / Gemini -> blocking consent dialog (what leaves the PC, retention summary, Gemini free-tier warning) -> key entry -> `validate`.
3. WhatsApp pairing: QR (data URL from main), status text, "new code" on timeout. On `connected`: record `paired_at`, explain "older messages are ignored".
4. Google Calendar: the 5-step wizard from the calendar-mcp report (own Cloud project, Desktop client, publish to production, paste/browse JSON, sign-in via `manage-accounts add` + poll). Skippable: without it the app runs "drafts only" and event proposals show "connect calendar".
5. Finish: tray hint ("lives in hidden icons; X hides, Quit is in the tray menu"), autostart toggle (default off), BitLocker/Device Encryption tip, userData-in-OneDrive warning if applicable.

### 11.2 Settings (minimal)
General: language, start with Windows, time zone. AI: provider, model/tier, hardware acceleration Auto/Off, daily cloud token budget + usage counter, consent status. WhatsApp: connection status, re-pair, unlink and wipe, process unknown senders (off), per-chat policies. Calendar: account, target calendar, calendars checked for conflicts, show conflicting event names (off), default duration. Privacy: retention days, private notifications (on), purge now, export diagnostics. Replies: optional first-person gender for Hebrew.

### 11.3 Tray lifecycle
- `requestSingleInstanceLock()` at module top; `second-instance` -> show window.
- Window `close` -> `preventDefault(); hide()` unless `isQuitting`; first time one toast hint. `window-all-closed` is a no-op.
- Tray (no GUID while unsigned; instance kept in module scope): left/double click = open; menu = Open / Pause processing (checkbox) / status line (e.g. "Active - Local model", "Paused", "WhatsApp offline") / Quit. Rebuilt on language, pause and status changes. Icons: normal, paused, attention. **Tooltip and toasts never contain message text, names or drafts**; a toast click only opens the window.
- Quit: tray Quit -> `isQuitting=true` -> `before-quit` (prevent once) -> `supervisor.stopAll({graceMs:3000})` -> `taskkill /PID /T /F` stragglers -> destroy tray -> `app.quit()`. `session-end` and `process.on('exit')` -> `killAllSync()`.
- Autostart: `setLoginItemSettings({openAtLogin, args:['--hidden']})` only when packaged.

---

## 12. Error, restart and degraded-mode strategy

Supervisor (Electron-free, unit-testable): states `stopped|starting|running|backoff|failed|stopping`; backoff `min(60 s, base*2^n)` + jitter, reset after 60 s stable; circuit breaker (5 crashes / 10 min -> `failed`, only a user click closes it); liveness probe every 30 s (3 misses -> kill + restart); any exit code while not `stopping` is a crash (the bridge always exits 0).

Orphan reaper (runs before any spawn): for each `<userData>\proc\<name>.pid` JSON `{pid, exePath, startedAt}` -> query the process (PowerShell `Get-CimInstance Win32_Process -Filter ProcessId=<pid>`), kill **only if** the executable path equals our own resources path and the creation time matches. Never kill by image name: the user runs another copy of the same bridge.

| Failure | Detection | Automatic response | User-visible | Safety note |
|---|---|---|---|---|
| Bridge exits / hangs | `exit`, health misses | respawn with new port+token; DB catch-up scan on recovery | "WhatsApp offline", send buttons disabled (main also rejects) | approvals never queue for later delivery |
| Bridge `timeout` in pairing | status poll | none | "Show new code" | |
| Bridge `error` logged out | status message | stop bridge | "Re-pair" click -> delete only our `store\whatsapp.db`, respawn | destructive step needs a click |
| `Client outdated` marker | stdout | stop respawning | "WhatsApp component needs an update" | no runtime exe download, ever |
| Exe hash mismatch / missing | pre-spawn check | refuse spawn | "Component modified or removed by antivirus" | |
| llama-server crash / garbage | exit, self-test | retry once; then `--device none` persisted; then breaker | "Local model failed" + switch CPU / re-download | items wait as `untriaged`; nothing is lost |
| Cloud `auth/billing/quota_daily` | typed error | no retry, provider marked blocked | specific bilingual message | never silently falls back to another provider (privacy) |
| Cloud `rate_limited/overloaded/network` | typed error | backoff, max 3, then hold item | counter in status bar | |
| MCP server crash / token invalid | transport close, `McpError` | restart with backoff; reads fail closed (`{"error":"unavailable"}`) | "Reconnect Google"; create buttons disabled | drafts continue without availability |
| `tools/list` drift | startup check | calendar disabled | "Calendar component mismatch" | fail closed |
| Crash mid-execution | `executing` rows at start | mark `unknown_outcome`, reconcile read-only | "Could not confirm - check WhatsApp" | never auto-retry a side effect |
| app.db corrupt | `quick_check` | restore backup / rebuild (section 9) | one-time notice | |
| Renderer gone | `render-process-gone` | recreate window | - | main state intact |
| Disk full / download hash mismatch | downloader | pause / delete `.part` | specific message | |
| Webhook missed | - | 60 s safety scan + reconnect scans | - | doorbell is an optimisation only |

Global kill switch: "Pause processing" stops all LLM runs immediately (AbortController) and leaves pending approvals usable. A second, stronger "Safe mode" is entered automatically on any invariant violation (I6 refusal, tool-list drift, audit-chain break): no spawns, no LLM, read-only dashboard, explanation screen.

Logging: `electron-log` behind one `redact()` choke point; metadata only (event type, `sha256(jid)[0:8]`, lengths, durations, token counts, tool names, outcomes). ESLint bans `console.*` in `src/main`. `crashReporter` off. No telemetry, no updater pings in v1.

---

## 13. Electron hardening and packaging

- `BrowserWindow`: `contextIsolation:true, sandbox:true, nodeIntegration:false, webSecurity:true, webviewTag:false, devTools:!app.isPackaged, spellcheck:false`; `Menu.setApplicationMenu(null)`.
- Renderer served from `app://bundle/` with a traversal guard; CSP header in production: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`. `will-navigate` and `window.open` denied everywhere; all permission requests denied; no custom URL scheme registered with the OS.
- Untrusted text: framework interpolation only; ESLint bans `dangerouslySetInnerHTML`/`innerHTML`; no markdown renderer; links in messages are not clickable.
- Fuses: `runAsNode:false` (primary plan; `true` only under the documented S1 fallback), `enableNodeOptionsEnvironmentVariable:false`, `enableNodeCliInspectArguments:false`, `onlyLoadAppFromAsar:true`, `enableEmbeddedAsarIntegrityValidation:true` (**UNVERIFIED** on electron-builder 26.15.3 - spike S4; revert to false only if the packaged app cannot start), `enableCookieEncryption:true`, `grantFileProtocolExtraPrivileges:false`.
- E2E seams (`WCA_E2E`, fake bridge URL, stub LLM, `--user-data-dir`) are honoured only when `!app.isPackaged`.

Installed layout (NSIS one-click, per-user, x64, `deleteAppDataOnUninstall:false`, `npmRebuild:false`, `electronLanguages:[en-US, he]`):
```
%LOCALAPPDATA%\Programs\WhatsApp Calendar Agent\
  WhatsApp Calendar Agent.exe
  resources\
    app.asar                                   main + preload + renderer (no native modules, nothing unpacked)
    bridge\whatsapp-bridge.exe  LICENSE        pinned SHA-256, verified before every spawn
    llama\llama-server.exe  *.dll  LICENSE     from the sha256-verified b10964 Vulkan zip
    calendar-mcp\shim.mjs  package-lock.json  node_modules\@cocal\google-calendar-mcp\...   (npm ci --ignore-scripts, pinned 2.6.3)
    icons\tray.ico tray-paused.ico tray-attention.ico
    licenses\THIRD_PARTY.md ...
%APPDATA%\WhatsApp Calendar Agent\            (userData; warn if under a cloud-synced folder)
  app.db  backups\  logs\  proc\*.pid
  bridge\store\{whatsapp.db,messages.db,<jid>\}   bridge\outbox-empty\
  google\gcp-oauth.keys.json  tokens.json          (plaintext files required by the MCP server)
  models\*.gguf  *.part
```
Build scripts: `scripts/fetch-llama.mjs` (download + sha256 + prune CLI exes), `scripts/stage-calendar-mcp.mjs` (`npm ci --ignore-scripts` from a committed lockfile into `build-resources/calendar-mcp`), `scripts/hash-bridge.mjs` (computes the SHA-256 of `resources/bridge/whatsapp-bridge.exe`, compares with the constant, fails the build on mismatch), `scripts/check-boundaries.mjs` (dependency-cruiser). The bridge exe is placed into `resources/bridge/` by the user or one dedicated build task copying that single file by exact path; nothing else from the user's bridge folder is ever touched. Root `package-lock.json` committed, exact versions, `npm ci`, `npm audit --omit=dev` gate. Dependencies drop `node-llama-cpp`; everything else follows the electron-stack report's pinned list.

---

## 14. Directory structure

```
C:\dev\whatsapp agent\
  package.json  electron.vite.config.ts  electron-builder.yml  tsconfig*.json  eslint.config.js
  vitest.config.ts  playwright.config.ts  .dependency-cruiser.cjs
  build\            icon.ico  installer.nsh
  resources\        bridge\{whatsapp-bridge.exe,LICENSE,SHA256SUMS}  icons\  licenses\
  build-resources\  calendar-mcp\{package.json,package-lock.json,shim.mjs}      (node_modules git-ignored)
  vendor\           whatsapp-bridge-src\ (reference only)   llama\ (git-ignored)   llama.pin.json
  scripts\          fetch-llama.mjs  stage-calendar-mcp.mjs  hash-bridge.mjs  check-boundaries.mjs  make-icons.mjs
  src\
    shared\         ipc.ts  schemas.ts (zod: Extraction, Draft, ValidatedEvent, IPC reqs)  state.ts (deriveState)
                    types.ts  locales\{en,he}.json  i18n\{languages,format}.ts
    preload\        index.ts                       (CJS, dependency-free, literal channel allow-list)
    main\
      index.ts  compose.ts                         (composition root: the only place capabilities are wired)
      app\          window.ts tray.ts autostart.ts notifications.ts protocol.ts paths.ts i18n.ts
      ipc\          register.ts sender.ts handlers\*.ts
      security\     toolGate.ts sanitize.ts promptAssembly.ts minimizer.ts redact.ts rateLimiter.ts
                    consent.ts invariants.ts audit.ts safeMode.ts
      db\           index.ts migrations.ts backup.ts retention.ts repos\*.ts
      proc\         supervisor.ts reaper.ts freePort.ts
      bridge\       launcher.ts read-client.ts send-client.ts doorbell.ts pairing.ts ingest.ts stdoutMarkers.ts janitor.ts
      mcp\          launcher.ts utilityTransport.ts read-client.ts write-client.ts googleAuth.ts toolDefs.ts projection.ts
      llm\          types.ts factory.ts local.ts claude.ts gemini.ts
                    local\{llamaServer.ts,hardware.ts,manifest.ts,download.ts,selfTest.ts}
      agent\        queue.ts stage0.ts contextBuilder.ts extract.ts resolveDate.ts plan.ts orchestrator.ts validate.ts items.ts
      exec\         actionExecutor.ts buildSendArgs.ts buildCreateEventArgs.ts reconcile.ts
      secrets.ts  logger.ts
    renderer\       index.html  src\{main.tsx,App.tsx,styles.css,i18n.ts,store\,views\{Dashboard,Settings,Onboarding}.tsx,
                    components\{ListCard,ItemCard,DraftEditor,EventCard,Badges,QuotedBubble,QrPairing,ModelDownload,
                                GoogleWizard,ConsentDialog,StatusBar,LanguageToggle}.tsx}
  tests\            fakes\{fake-bridge.ts,fake-mcp-calendar.ts,stub-llm.ts,obedient-attacker-llm.ts}
                    security\{injection-corpus.he.json,injection-corpus.en.json,*.test.ts}  golden\{he,en}.jsonl
                    mocks\electron.ts  e2e\*.spec.ts
  docs\             research\  proposals\
```
Only `src/main/index.ts`, `compose.ts`, `app/**`, `ipc/register.ts`, `secrets.ts`, `mcp/launcher.ts` import `electron`; everything else is plain Node and unit-testable.

---

## 15. Security test suite (release gate, all against fakes - never the real exe, never real Google)
1. Tool gate: every write/unknown/case-variant/unicode tool name blocked; fake MCP records zero write calls.
2. Import-graph boundaries (section 6.4).
3. Injection corpus (he+en, >= 40 cases) with an LLM stub that **obeys the attacker**: zero side effects without approval; proposals never contain forbidden fields; recipient always the source chat; badges raised.
4. System-prompt/tool-definition purity property test.
5. Approval binding: forged id, wrong hash, extra fields, expired, superseded, double click, hidden window -> rejected / executed exactly once; DB trigger test for `executing` without `approved`.
6. Crash recovery: kill between write-ahead and completion -> `unknown_outcome`, no auto-retry, reconciliation works; deterministic `eventId` prevents duplicates.
7. Doorbell: wrong path/token/Host, `Origin` present, `text/plain`, 25 MB, GET -> uniform 404; bound to 127.0.0.1; payload content provably unused.
8. Bridge launch invariants: each violated precondition blocks the spawn; env contains no API keys; token never reaches logs.
9. Redaction golden tests + sentinel grep over the log dir after an end-to-end run.
10. Consent: factory throws for cloud without consent; payload snapshots contain no names/JIDs/numbers; Gemini `store:false` asserted.
11. Backlog gate: history rows never trigger runs and never reach a cloud provider outside a live window.
12. Electron: webPreferences, CSP header, navigation denial, fuse wire read back from the packaged exe; GGUF corrupt byte / foreign redirect host rejected; rate-limiter virtual-clock tests.

---

## 16. Decisions to put to the user (option dialog) - with my recommended default
| # | Question | Options | Recommended |
|---|---|---|---|
| D1 | MCP server launch | (a) utilityProcess + stdin shim, fuse off; (b) `ELECTRON_RUN_AS_NODE`, fuse on | (a) with (b) as time-boxed fallback |
| D2 | Default Claude model | `claude-sonnet-5` / `claude-opus-5` / `claude-haiku-4-5` | `claude-sonnet-5` (bounded cost under message floods) |
| D3 | Messages from senders you never wrote to | ignore for AI (counter only) / process everyone | ignore for AI |
| D4 | Ambiguous hour ("at 5") | assume PM with a visible badge / send to "Information missing" | assume PM with badge |
| D5 | Calendar detail visible to the AI | busy/free only / include event names | busy/free only |
| D6 | Reschedule/cancel support | v1 create-only (manual edits in Google) / enable `update-event` with before-after approval | create-only in v1 |
| D7 | Retention of message snapshots and drafts | 7 / 30 / 90 days | 30 days |
| D8 | Second linked device and ToS risk | proceed / stop | explicit accept screen (already in onboarding) |

---

## 17. Spikes required before build lock (time-boxed)
- S1 MCP server inside `utilityProcess` with the stdin shim (`process.stdin` redefinition, ESM import from `resources\calendar-mcp`, `tools/list` round-trip, packaged build). Fail -> D1(b).
- S2 `llama-server` b10964: separate `tools` and `response_format` calls with Gemma 4 E4B; Hebrew string args; `--reasoning-budget 0`; flags that suppress prompt logging; Unicode model path.
- S3 Bridge DB assumptions against a fixture built from the vendored schema, then confirmed by the user on the first supervised run: timestamp text format, rowid behaviour on upsert, `@lid` chat frequency, `/api/pairing/status` answering.
- S4 ASAR integrity fuse with electron-builder 26.15.3 on Windows; NSIS upgrade while the app and children are running (installer hook kills only our own process tree).
- S5 Deterministic `eventId` behaviour through the MCP server (409 mapping) and `sendUpdates:'none'` acceptance on `create-event`.

---

## 18. Honest weaknesses of this proposal
- **W1 Same-user malware is out of reach.** `whatsapp.db` (full account access), `messages.db`, `tokens.json` and `gcp-oauth.keys.json` are plaintext files; DPAPI does not stop same-user processes; child env vars are readable. Hash pinning, per-launch tokens and fuses raise the bar only against remote content and casual tampering. Disk encryption is advice, not a control.
- **W2 The bridge is an opaque, unsigned, locally modified binary that nobody on this project can rebuild.** The SHA-256 pin proves "same file as the user's", not "benign" or "matches the vendored source". A WhatsApp protocol change ends the product until someone produces a new exe. SmartScreen/Defender friction is likely.
- **W3 Capability separation is module-level, not process-level.** The pipeline, the SDKs and `ActionExecutor` share the main process; a compromised npm dependency in main defeats I1-I3. dependency-cruiser and the DB trigger catch mistakes, not malice.
- **W4 The human is the last line.** A user who clicks Approve without reading defeats everything; badges and URL stripping are probabilistic. Requiring a focused window is weak protection against a renderer XSS that can synthesise clicks - CSP + sandbox + no-HTML rendering carry that risk.
- **W5 My primary MCP launch plan is an unverified hack** (redefining `process.stdin` inside a utility process, depending on the server's internal use of SDK defaults). A server update can break it silently; the fallback re-enables `runAsNode`, whose marginal risk on an unsigned per-user app is honestly modest - so the hardening gain of the primary plan is real but small relative to its fragility.
- **W6 No at-rest encryption of `app.db`**, and even if added it would protect little because the bridge stores the full corpus in plaintext next to it.
- **W7 More friction and less capability than a convenience-first design.** Two LLM calls per trigger (slow on CPU: plausibly 30-90 s per message on a 4B model), no processing of unknown senders by default, no event names for the AI by default, create-only calendar (no reschedule/cancel automation), no send-later queue when WhatsApp is offline, 24 h approval expiry, conflict confirmation as a second click, no toast actions. Some users will find it fussy.
- **W8 App-authored tool definitions dilute "expose the MCP server's tools to the LLM".** The LLM sees three narrowed read tools with our descriptions, not the server's thirteen. This is deliberate (poisoning, schema portability, small-model context) but it means new server features need app releases, and a schema drift in a server upgrade disables calendar features until we re-pin.
- **W9 Ingest depends on reading another process's SQLite file** with unverified timestamp format and rowid semantics, rollback-journal locking (`SQLITE_BUSY`), and JIDs that can be rewritten by bridge migrations. `@lid` chats are shown but cannot be replied to from the app in v1.
- **W10 The unknown-sender gate uses history that may be incomplete** right after pairing (history sync is partial), so legitimate contacts may be silently unprocessed until the user replies once or opts the chat in.
- **W11 Reconciliation of `unknown_outcome` sends is heuristic** (`/api/send` returns no message id; matching by text and time can be wrong for identical short replies). The design chooses "ask the human" over "retry", which can leave a confusing card.
- **W12 Local model quality is unproven for informal Hebrew**; schema-constrained extraction may produce valid-but-wrong JSON. Safety does not depend on it, usefulness does. The golden-set gate may force a model change late.
- **W13 Installer weight and AV surface**: about 200 MB of `googleapis` files, three unsigned executables' worth of heuristics (Electron app, Go bridge, llama-server), no code signing, no auto-update channel - security fixes reach the user only by manual reinstall.
- **W14 Legal/ToS exposure is disclosed, not solved**: whatsmeow use violates WhatsApp's terms regardless of volume; third-party message content goes to cloud providers when the user opts in; Gemini free-tier data use cannot be verified by the app.
