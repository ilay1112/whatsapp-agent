# Architecture Proposal - UX-FIRST angle

Project: WhatsApp Calendar Agent (Windows 11, Electron + TypeScript)
Date: 2026-09-21
Author angle: optimise for a non-technical, Hebrew-speaking user on a weak laptop. Painless onboarding, a dashboard the user can trust at a glance, fast *perceived* response, and every state/error explained in plain words with exactly one next action.

Inputs: all ten reports in `docs/research/`. Where reports disagree (llama runtime, runAsNode fuse, which MCP tools are enabled, debounce values) this document picks one side and says why. Locked user decisions are not relitigated.

---

## 0. The ten decisions that define this proposal

| # | Decision | UX reason |
|---|----------|-----------|
| D1 | **A card appears within ~1 s of a WhatsApp message, before any LLM work.** The card shows the raw message, an editable (empty) reply box and "Analysing..." progress. The LLM result fills the card in later. | On a CPU-only laptop a 4B model needs 30-60 s per triage. The user must never stare at an empty dashboard wondering whether the app works. The card is useful even if the LLM fails (user can type and send with approval, or copy). |
| D2 | **One open item per chat**, not per message. New messages in the same chat re-triage and update the same card. | A burst of 6 messages must not create 6 cards. The dashboard stays "minimal". |
| D3 | **Deterministic pre-filter before the LLM** (Hebrew/English scheduling-cue lexicon + question detection + known-sender gate). No cue = `ignored` with no LLM call; visible and recoverable in an "Ignored" drawer. | Keeps the laptop cool, the queue short, cloud cost low, and fewer private messages leave the machine. |
| D4 | **Onboarding runs the slow thing first and in the background**: pick the AI -> model download starts -> user continues to QR pairing and Google while 5 GB downloads. Google Calendar can be **skipped** and connected later (reply-only mode). | The hardest step (Google Cloud project) must not block the first "wow". The longest step (download) must not be dead time. |
| D5 | **llama.cpp runs as the official `llama-server.exe` child** (Vulkan x64 zip, pinned b10964), not node-llama-cpp. | Crash isolation (a native crash cannot take the UI down), one small zip covers CPU + iGPU + dGPU, new model templates arrive without waiting for a binding release, installer stays ~500 MB smaller than the binding with all backends. |
| D6 | **One provider interface, one loop, one terminal schema.** `chat()` returns either `tool_calls` or a schema-valid `final` Proposal. Claude and Gemini use native tool calling + native structured output; Local implements the same contract with a JSON-schema grammar union (`call_tool` or `final`), as both local-model reports recommend. | The user can switch provider in Settings and the dashboard behaves identically. |
| D7 | **WRITE capability is unreachable from the LLM loop by construction.** The LLM sees only `get-freebusy`, `list-events` (projected) and `get-current-time`. `create-event` is called only by `ActionExecutor` behind an approve IPC bound to an action id + content hash. v1 is **create-only** (no update/delete enabled at the MCP server). | "Trustworthy" means the user can explain to a friend why the app cannot do anything on its own. |
| D8 | **Every failure maps to one `ErrorCode` -> one bilingual title + body + one action button**, surfaced through a single `AppHealth` object and one health pill in the header. No stack traces, no English-only errors, no dead ends. | Clear states and errors for a non-technical user. |
| D9 | **Reply and calendar event are two separate approvals** on the same card ("אישור ושליחה" and "הוספה ליומן"), plus a "העתקה" (copy draft) escape hatch on every card. No bulk approve, no approve-from-toast. | Minimal clicks without weakening approval-first; copy is the trust-building fallback when sending is impossible (`@lid` chat, bridge offline). |
| D10 | **runAsNode fuse stays ENABLED in v1** so the bundled Calendar MCP server can run on a machine without Node (`ELECTRON_RUN_AS_NODE=1`, stdio). All other hardening fuses are on. | A Google connection that "just works" after install beats a hardening flag whose alternative is shipping another unsigned `node.exe`. Listed as a weakness in section 17. |

---

## 1. Process model

```
+---------------------------------------------------------------------------------+
| Electron MAIN process (ESM, Node 24.21)  - the only place with secrets & power   |
|                                                                                 |
|  AppLifecycle  TrayController  WindowController  I18nMain  Settings  Secrets     |
|  Db (node:sqlite, app.db, WAL)      HealthHub (AppHealth aggregator)            |
|  ProcessSupervisor x3  (Electron-free class, PID registry, orphan reaper)        |
|  BridgeClient (REST 127.0.0.1)   WebhookListener (127.0.0.1:0, secret path)      |
|  BridgeDbReader (messages.db READ-ONLY)   Ingestor   PreFilter   TriageQueue     |
|  TriageOrchestrator -> LlmProvider {Local | Claude | Gemini}                     |
|  McpHost (StdioClientTransport)  ToolBroker (READ allowlist, arg pinning)        |
|  ProposalValidator (zod + deterministic checks + date resolver)                  |
|  ActionExecutor  (the ONLY module that can send / create)   RateLimiter          |
|  ModelManager (HW detect, manifest, downloader)  hash Worker (worker_threads)    |
+-------+-----------------+--------------------+-------------------+--------------+
        | IPC (typed,     | spawn, REST,       | spawn, stdio      | spawn, HTTP
        | zod-validated)  | webhook, ro SQLite | MCP JSON-RPC      | OpenAI-compatible
        v                 v                    v                   v
+---------------+  +--------------------+  +------------------------+  +---------------------+
| RENDERER      |  | whatsapp-bridge.exe|  | Calendar MCP server    |  | llama-server.exe     |
| sandboxed,    |  | cwd=<userData>\    |  | @cocal/google-calendar |  | Vulkan x64 b10964    |
| React 19,     |  |   bridge           |  | -mcp@2.6.3 run with    |  | only when provider = |
| app:// + CSP  |  | own store\, random |  | process.execPath +     |  | Local; lazy start,   |
| connect-src   |  | port + token       |  | ELECTRON_RUN_AS_NODE=1 |  | idle sleep 600 s,    |
| 'none'        |  | always-on          |  | started when Google    |  | below-normal priority|
|               |  |                    |  | credentials exist      |  |                      |
+---------------+  +--------------------+  +------------------------+  +---------------------+
```

Rules:

- **Main process owns everything privileged.** The renderer is a view: it never sees API keys, JIDs it did not get from main, MCP tool names, or bridge tokens. There is no generic `mcp:callTool` or `bridge:send` channel.
- **No Electron `utilityProcess` in v1.** The heavy work is already out-of-process (three children). The only in-process CPU hog is SHA-256 of multi-GB GGUF files, which runs in a `worker_threads` worker so the UI never janks. `node:sqlite` is synchronous but all queries are indexed and tiny.
- **Children are started by need, not by default**:
  - bridge: always (after onboarding step 2 begins);
  - MCP server: only when `<userData>\google\gcp-oauth.keys.json` exists;
  - llama-server: only when provider = Local **and** a verified model exists; started on first queued job (or app start if a queue exists), `--sleep-idle-seconds 600`, stopped immediately when the user switches to a cloud provider (frees 3-6 GB RAM).
- **Low-RAM courtesy** (total RAM < 12 GB and provider = Local): when the window has been hidden in the tray for 10 min, the BrowserWindow is destroyed (not just hidden) and recreated on demand (~1 s). Otherwise hide = keep alive for instant reopen.

### 1.1 Child launch contracts (non-negotiable pre-spawn assertions)

| Child | Spawn | Assertions before spawn (refuse otherwise) |
|---|---|---|
| Bridge | `spawn(<resources>\bridge\whatsapp-bridge.exe, [], {cwd:<userData>\bridge, windowsHide:true, shell:false, env: MINIMAL})` with `WHATSAPP_BRIDGE_PORT` (free ephemeral, never 8080), `WHATSAPP_BRIDGE_TOKEN` (64 hex, per launch), `WEBHOOK_URL=http://127.0.0.1:<p>/hook/<secret>`, `FORWARD_SELF=true`, `WHATSAPP_MEDIA_ROOTS=<userData>\bridge\outbox-empty` | sha256(exe) == pinned `AC23221E...2FF5`; resolved cwd is inside `app.getPath('userData')`; all five env vars set; cwd does not contain `minime`; after start `/api/pairing/status` answers 200 to OUR token within 10 s (401 = foreign process on that port -> new port) |
| MCP | `StdioClientTransport{command: process.execPath, args:[<resources>\calendar-mcp\node_modules\@cocal\google-calendar-mcp\build\index.js,'start','--transport','stdio'], env:{...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE:'1', GOOGLE_OAUTH_CREDENTIALS, GOOGLE_CALENDAR_MCP_TOKEN_PATH, GOOGLE_ACCOUNT_MODE:'personal', ENABLED_TOOLS:'list-calendars,list-events,get-freebusy,get-current-time,create-event,manage-accounts'}}` | after `initialize`, `tools/list` must equal the expected set exactly; every READ tool must report `readOnlyHint:true`; anything unknown => not exposed (fail closed) |
| llama | `spawn(<resources>\llama\llama-server.exe, ['-m',gguf,'--host','127.0.0.1','--port',p,'--jinja','--no-webui','--offline','-c',ctx,'-np','1','--sleep-idle-seconds','600','--reasoning-budget','0','--cache-ram','0'], {cwd:<resources>\llama, env:{LLAMA_API_KEY}})`; ctx = 4096 small tier / 8192 mid tier; `os.setPriority(pid, PRIORITY_BELOW_NORMAL)`; threads = physical cores - 1 | GGUF sha256 verified at install time (flag in DB) and size re-checked at start; `/health` 200; then the built-in self-test (section 9.3) |

---

## 2. Data flow: webhook -> triage -> item state -> approval -> execution

### 2.1 Ingest (doorbell + database, never trust the webhook body)

```
bridge --POST /hook/<secret>--> WebhookListener
   checks: secret path, X-Bridge-Token, Host, no Origin, application/json, <=20 MB   -> uniform 404 on failure
   replies 200 IMMEDIATELY (bridge sends synchronously inside its event handler)
   enqueue scan(chatJID) at +300 ms and +2 s (store/webhook ordering is unknown)

Ingestor.scan():   BridgeDbReader opens <userData>\bridge\store\messages.db READ-ONLY, short txn
   SELECT rowid, id, chat_jid, sender, content, timestamp, is_from_me, media_type, deleted_at
     FROM messages WHERE rowid > :cursor ORDER BY rowid LIMIT 500      -- rowid scan: no timestamp index needed
   also runs: every 60 s while ONLINE, on bridge (re)connect, on stdout marker "History sync complete"
```

Filters, in order (each drop is counted for the diagnostics screen, none is an error):

1. chat is a DM (`@s.whatsapp.net` or `@lid`); groups, `status@broadcast`, newsletters, broadcasts dropped.
2. `timestamp >= watermark` where `watermark = pairedAt - backlogWindow` (backlog window chosen in onboarding: **from now** (default) / 24 h / 3 days). This is the history-sync gate; older rows only update `chats` metadata.
3. chat not muted by the user.
4. reactions, deleted messages and media without text are recorded as activity only.
5. Timestamps are parsed defensively (go-sqlite3 text format UNVERIFIED) into epoch ms.

Result: `chats` upserted, a **minimal snapshot** of the message is written to `item_messages`, and:

- inbound message -> open item for that chat is created or touched -> **card is pushed to the renderer now** (D1) -> per-chat debounce timer (15 s quiet, 45 s hard cap) -> TriageQueue.
- outbound message (`is_from_me`, thanks to `FORWARD_SELF=true`):
  - matches a just-approved send (same chat, same text, <= 60 s) -> action marked `confirmed`, card shows "נשלח";
  - otherwise the user answered from the phone: if the open item has no unapproved event proposal -> item closed `answered_elsewhere` (deterministic, no LLM); if it has one -> keep the card, collapse the draft, show chip "כבר ענית מהטלפון".

### 2.2 Pre-filter (deterministic, < 1 ms)

```
known sender?  (user has ever sent a message in this chat, or chats.name is non-numeric)
   no  -> item stays state=needs_reply, analysis='skipped_unknown_sender', raw text only, button "Analyse this chat"
cue present in the debounced window?
   lexicon HE: יום ראשון..שבת, היום, מחר, מחרתיים, הערב, בבוקר, בצהריים, שבוע הבא, נפגש, ניפגש, פגישה, קפה, תור, לקבוע, מתי, בשעה, ב-<digit>
   lexicon EN: weekdays, today, tomorrow, tonight, next week, meet, meeting, call, coffee, lunch, schedule, when, at <digit>, am/pm
   patterns: HH:MM, d/m, d.m, question mark, the open item already has a proposal
   no cue -> state=ignored (reason 'no_cue'), NO LLM call
   cue    -> analysis='queued'
```

The lexicon lives in `src/main/triage/cues.{he,en}.json` so it can be tuned without touching code. The "Ignored" drawer lets the user press "Analyse anyway", which also feeds a local counter used to evaluate the lexicon.

### 2.3 Triage (LLM, concurrency 1, persistent queue)

```
TriageOrchestrator.run(itemId):
  ctx = last <=12 messages of THIS chat only, <=1500 chars each, role labels "THEM"/"ME" (no names, no JIDs, no media)
        sanitised (bidi/invisible chars stripped, datamarked as untrusted data)
  system = static English prompt (cache-friendly prefix)  +  AFTER it: 14-day date table (he+en weekday names,
           Asia/Jerusalem, Sunday-first), reply-language directive (script counting), user gender setting
  loop (max 3 rounds, max 4 tool calls, provider fixed for the whole run):
      r = provider.chat({system, messages, tools: ToolBroker.llmTools(), final: ProposalSchema}, signal)
      r.kind == 'tool_calls' -> ToolBroker.execute(each)  (READ allowlist, pinned args, projected results) -> append -> continue
      r.kind == 'final'      -> break
      r.kind == 'refusal' | 'truncated' | invalid JSON twice -> analysis='failed', card keeps raw message + manual reply
  proposal = ProposalValidator(r.final)     // zod .strict(), then deterministic checks, then DATE RESOLUTION IN TS
  item.state = decide(proposal)
```

The model never does date arithmetic. It emits `when: { dayRef: {kind:'weekday',weekday:4,weekOffset:0} | {kind:'offset',days:1} | {kind:'date',d,m,y?}, time:'HH:MM'|null, timeAmbiguous:boolean, durationMin|null }`. `resolveWhen()` in TypeScript turns it into `startIso/endIso` (Asia/Jerusalem, default duration from settings = 60 min). Ambiguous hour without cue ("ב-5"): hours 1-7 -> PM, 8-11 -> AM, flagged with an amber chip "הנחתי 17:00" and editable. It goes to `needs_reply`, not to `info_missing` (fewer round trips for the user).

Shortcut for speed: the tool round is skipped entirely when the first answer has no resolvable date+time (nothing to check availability for). On the Local provider this saves 10-20 s.

### 2.4 Item state machine

`state` is exactly one of the four locked values. Lifecycle is orthogonal (`closed_at`, `closed_reason`), so a list shows `state = X AND closed_at IS NULL`.

```
                        +--> ignored            (no cue | needsReply=false and no event | user "התעלמות")
inbound msg -> [card] --+--> info_missing       (scheduling intent, missing[] not empty)  draft = question asking for details
                        +--> needs_reply        (reply expected; event fully resolved or no event at all)
needs_reply / info_missing --(new inbound or outbound message)--> re-triage, same item (edit-lock, 2.6)
needs_reply --[user approves "הוספה ליומן" -> create-event OK]--> in_calendar   (reply draft stays actionable on the card)
any open --(reply sent by approval, no event pending)--> closed 'replied'
any open --(answered from phone, no event pending)--> closed 'answered_elsewhere'
in_calendar --(event start passed + 1 day | event no longer found in Google on sync)--> closed 'past' | 'removed_in_google'
ignored --("Analyse anyway")--> queued
```

"In calendar" is the truth in Google, not just our memory: `CalendarSync` (app code, no LLM) calls `list-events` with `privateExtendedProperty: waAgent=1` every 15 min and on window show, and reconciles `calendar_events`.

### 2.5 Approval -> execution

```
Renderer card:  [textarea: exact bytes to send]  [event card rendered from structured fields, editable]
  click "אישור ושליחה"   -> ipc 'action:approve' {actionId, kind:'send_reply', editedText, shownHash}
  click "הוספה ליומן"    -> ipc 'action:approve' {actionId, kind:'create_event', editedEvent, shownHash}

Main, ActionExecutor:
  assertTrustedSender(frame); zod parse; action exists, kind matches, not expired (24 h), sha256(canonical(action)) == shownHash
  apply user edits (trusted, still schema-validated); idempotency key (item_id, kind, proposal_version) UNIQUE
  send_reply:   chatJid comes from OUR DB (the source item), must match ^[0-9]{5,20}@s\.whatsapp\.net$ ; RateLimiter;
                bridge POST /api/send {recipient, message}   -- never media_path, never typing/react
  create_event: fresh get-freebusy (app code) -> if busy: inline confirm "יש אירוע אחר בזמן הזה - להוסיף בכל זאת?"
                mcp.callTool('create-event', whitelist{calendarId:setting, summary, start, end, timeZone, location,
                description: app template, sendUpdates:'none', allowDuplicates:false,
                extendedProperties.private:{waAgent:'1', waItem:<itemId>}})   -- no attendees, recurrence, conference
  result -> actions row (executed | failed + ErrorCode) -> push 'items:changed'
```

UI feedback contract: the button turns into a spinner within 50 ms, success shows a 5-second inline confirmation with **"Open in Google Calendar"** (htmlLink validated against `https://calendar.google.com/` / `https://www.google.com/calendar/`), failure keeps the card intact with the error line and a Retry button. Nothing is ever lost on failure.

`@lid` chats (unmapped to a phone): analysis and draft work, the send button is replaced by "העתקה" with the hint "אי אפשר לשלוח לצ'אט הזה מהאפליקציה - העתיקו והדביקו ב-WhatsApp". (Whether `/api/send` accepts `@lid` is UNVERIFIED; safe default.)

### 2.6 Edit-lock (avoids the "stale view" trap)

If the user has focus inside a card (typing in the draft or editing the event), a re-triage result for that item is **held**: the card shows a chip "יש עדכון - הצג" and swaps content only on click. Without this, the shownHash check would reject the approval exactly when the user is most engaged.

---

## 3. LLM provider abstraction

```ts
// src/main/llm/types.ts
export type ProviderId = 'local' | 'claude' | 'gemini';

export interface ToolSpec { name: string; description: string; inputSchema: JsonSchema }   // app-authored, trimmed
export interface NeutralMessage {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolResults?: { callId: string; name: string; content: string; isError: boolean }[];
  providerState?: unknown;        // opaque: Claude content blocks incl. thinking signatures / Gemini interaction.steps
}
export interface ChatRequest {
  system: string;                 // static prefix first (cacheable), dynamic date table last
  messages: NeutralMessage[];
  tools: ToolSpec[];              // READ tools only - the type system has no place for write tools
  final: { name: 'submit_proposal'; schema: JsonSchema };
  maxOutputTokens: number;        // 700
}
export type ChatResult =
  | { kind: 'tool_calls'; assistant: NeutralMessage; usage: Usage }
  | { kind: 'final'; json: unknown; assistant: NeutralMessage; usage: Usage }
  | { kind: 'refusal' | 'truncated'; usage: Usage };

export interface LlmProvider {
  readonly id: ProviderId;
  health(): Promise<ProviderHealth>;               // ready | not_configured | downloading | loading | error(code)
  validateCredentials?(key: string): Promise<KeyCheck>;
  listModels?(): Promise<ModelOption[]>;
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
}
```

| | Local | Claude | Gemini |
|---|---|---|---|
| Transport | `fetch` to `http://127.0.0.1:<p>/v1/chat/completions`, Bearer LLAMA_API_KEY | `@anthropic-ai/sdk@0.127.0`, main only, `maxRetries:2`, `timeout:60_000` | `@google/genai@~2.23.0`, Interactions API, **`store:false` enforced in one function + unit test** |
| Tool calling | `response_format: json_schema` with a union: `{"action":"call_tool","name":<enum>,"arguments":{...}}` or `{"action":"final","proposal":{...}}`. The adapter translates this into `tool_calls` / `final`, so the orchestrator cannot tell the difference. Avoids template tool-call parser bugs (#25986, Qwen3.5 PEG) and the unconstrained-argument problem. | native `tools`, `tool_choice:auto`, manual loop, all `tool_result` blocks in one user message, assistant content replayed verbatim through `providerState` | native `{type:'function'}` tools, schemas through the whitelist sanitizer, `function_result` steps, `interaction.steps` replayed verbatim |
| Final answer | the `final` branch of the same grammar | `output_config.format` JSON schema (works alongside tools) | `response_format` JSON schema (Gemini 3.x combines with function calling) |
| Default model | tier manifest: Gemma 4 E2B Q4_K_M (< 12 GB RAM), **Gemma 4 E4B Q4_K_M** (>= 12 GB), Gemma 4 12B QAT UD-Q4_K_XL (dedicated VRAM >= 7.5 GB and RAM >= 15 GB, or RAM >= 30 GB). Thinking off. Fallback family Qwen3.5 stays in the manifest, hidden. | `claude-sonnet-5` (balanced cost/latency); dropdown from `models.list()`; `effort:'low'` only where supported; never temperature/prefill | `gemini-3.8-flash`; id editable; `thinking_level:'low'`; never temperature |
| Name shim | `-` <-> `_` mapping for tool names in every adapter (uniform) | same | same |
| Args re-validation | `ajv` against the app-authored schema in ToolBroker for all providers | same | same |
| Privacy gate | none (default, "stays on this PC") | versioned blocking consent screen before first use | same + explicit free-tier training warning |

Always, regardless of provider: zod `.strict()` validation of the final JSON in `ProposalValidator`, one repair retry ("your JSON failed validation: ..."), then `analysis='failed'`.

Proposal schema (LLM-facing; deliberately no recipient, attendees, calendarId, eventId, sendUpdates, URLs):

```ts
Proposal = { intent: 'schedule_request'|'reschedule'|'cancel'|'confirmation'|'question'|'smalltalk'|'other',
             needsReply: boolean,
             event: { title: string(1..80), when: WhenExpr, location?: string(..120) } | null,
             missing: ('date'|'time'|'duration'|'location'|'who'|'confirmation')[],
             draftReply: string(..600) | null,
             replyLang: 'he'|'en',
             suspicious: boolean }
```

The UI localises enums; only `draftReply`, `event.title`, `event.location` are free text (rendered as text, `dir="auto"`, never as HTML/markdown).

---

## 4. How MCP calendar tools reach the LLM, and how WRITE is gated

```
MCP server tools/list  ->  McpHost  ->  policy table (hard-coded, default deny)
                                          |
        +---------------------------------+----------------------------------+
        | READ (LLM may call)             | WRITE (ActionExecutor only)      | ADMIN / APP (no LLM)
        | get-freebusy                    | create-event                     | manage-accounts  (wizard, settings)
        | list-events   (projected)       |                                  | list-calendars   (settings picker)
        | get-current-time                |                                  | list-events      (CalendarSync)
        +---------------------------------+----------------------------------+
Not enabled at the server at all in v1: update-event, delete-event, create-events, respond-to-event, search-events, get-event, list-colors
```

1. **ToolBroker.llmTools()** returns app-authored `ToolSpec`s for the three READ tools: same MCP tool names, trimmed descriptions and trimmed schemas (small models choke on six rich schemas; type arrays like `["string","null"]` crash `gemma4.jinja`). The `account`, `calendarId`, `timeZone` parameters are removed from the LLM-facing schema and **pinned host-side** from settings. Time windows are clamped (window <= 14 days, horizon <= 60 days).
2. **ToolBroker.execute()** is the single path from an LLM tool call to `mcp.callTool`: name must be in the READ set (else the call gets an `is_error` result "tool not available" and the item gets the "possible manipulation" flag), args validated with ajv, pinned args injected, result **projected** (`list-events` -> `[{start,end,title<=60 chars}]`; `get-freebusy` -> busy intervals) and datamarked as untrusted before it goes back to the model.
3. **Structural gate**: `McpHost` exposes two methods, `callRead(name,args)` and `callWrite(name,args)`. `callWrite` is imported only by `src/main/actions/ActionExecutor.ts`. An ESLint `no-restricted-imports`/`no-restricted-syntax` rule plus a unit test that greps the import graph make this a build failure, not a convention. `ChatRequest.tools` is typed as `ReadToolSpec[]`.
4. **Approval gate**: `ActionExecutor` runs only from the `action:approve` IPC handler (section 2.5). Arguments are rebuilt from the stored, user-visible proposal through a field whitelist; nothing is spread from model output; no fresh LLM turn happens between the click and the call.
5. **Server gate**: `ENABLED_TOOLS` means a bug in layers 1-4 still cannot delete or update anything, and cannot email attendees.

This satisfies the locked decision literally (the app is the MCP host; the active LLM calls the MCP server's calendar tools through tool calling) while the only state-changing tool is outside the model's universe.

---

## 5. App SQLite schema (`<userData>\data\app.db`, node:sqlite, WAL, `foreign_keys=ON`)

Behind a small `Db` interface so better-sqlite3@13 can be swapped in. Migrations are numbered SQL files applied in a transaction at startup; the DB is copied to `app.db.bak` before a migration.

```sql
CREATE TABLE meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- schema_version, install_id, paired_at, watermark_ms, bridge_cursor_rowid
CREATE TABLE settings  (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE secrets   (name TEXT PRIMARY KEY, blob BLOB NOT NULL, updated_at INTEGER NOT NULL);  -- safeStorage ciphertext: anthropic_key, gemini_key
CREATE TABLE consents  (kind TEXT, version INTEGER, accepted_at INTEGER, PRIMARY KEY(kind,version)); -- whatsapp_tos, cloud_claude, cloud_gemini

CREATE TABLE chats (
  jid TEXT PRIMARY KEY, display_name TEXT, phone TEXT, lang TEXT CHECK(lang IN ('he','en')),
  is_known INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
  last_inbound_ms INTEGER, last_outbound_ms INTEGER, updated_at INTEGER NOT NULL);

CREATE TABLE items (
  id TEXT PRIMARY KEY,                               -- ulid
  chat_jid TEXT NOT NULL REFERENCES chats(jid),
  state TEXT NOT NULL CHECK(state IN ('needs_reply','info_missing','in_calendar','ignored')),
  analysis TEXT NOT NULL CHECK(analysis IN ('none','queued','running','done','failed','skipped_unknown_sender','waiting_model')),
  analysis_error TEXT,                               -- ErrorCode
  ignore_reason TEXT,                                -- no_cue | not_needed | user
  last_inbound_ms INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  closed_at INTEGER, closed_reason TEXT,             -- replied | answered_elsewhere | dismissed | past | removed_in_google | superseded
  current_proposal_id TEXT, flags_json TEXT NOT NULL DEFAULT '[]');   -- badges: link_removed, personal_details, manipulation, assumed_pm, lang_mismatch
CREATE UNIQUE INDEX ux_items_open_chat ON items(chat_jid) WHERE closed_at IS NULL AND state <> 'in_calendar';
CREATE INDEX ix_items_list ON items(state, closed_at, updated_at DESC);

CREATE TABLE item_messages (                          -- minimal snapshot; purged by retention
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  msg_id TEXT NOT NULL, chat_jid TEXT NOT NULL, from_me INTEGER NOT NULL, ts_ms INTEGER NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (msg_id, chat_jid));

CREATE TABLE proposals (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, intent TEXT NOT NULL, needs_reply INTEGER NOT NULL,
  draft_reply TEXT, reply_lang TEXT, missing_json TEXT NOT NULL,
  event_json TEXT,                                   -- {title, startIso, endIso, timeZone, location, whenExpr, assumptions[]}
  freebusy_json TEXT, created_at INTEGER NOT NULL, UNIQUE(item_id, version));

CREATE TABLE actions (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), proposal_id TEXT NOT NULL REFERENCES proposals(id),
  kind TEXT NOT NULL CHECK(kind IN ('send_reply','create_event')),
  payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,            -- canonical action shown to the user
  status TEXT NOT NULL CHECK(status IN ('pending','executing','executed','confirmed','failed','expired','superseded')),
  final_json TEXT, error_code TEXT, created_at INTEGER NOT NULL, approved_at INTEGER, executed_at INTEGER,
  UNIQUE(item_id, kind, proposal_id));

CREATE TABLE calendar_events (
  google_event_id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, item_id TEXT REFERENCES items(id),
  title TEXT NOT NULL, start_iso TEXT NOT NULL, end_iso TEXT NOT NULL, html_link TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','removed')), created_at INTEGER NOT NULL, last_seen_at INTEGER);

CREATE TABLE llm_runs (                                -- powers the usage counter and the "why is it slow" diagnostics
  id TEXT PRIMARY KEY, item_id TEXT, provider TEXT, model TEXT, started_at INTEGER, ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, tool_calls INTEGER, outcome TEXT, error_code TEXT);

CREATE TABLE model_installs (
  model_key TEXT PRIMARY KEY, repo TEXT, commit_sha TEXT, file TEXT, size_bytes INTEGER, sha256 TEXT,
  path TEXT, bytes_done INTEGER NOT NULL DEFAULT 0, status TEXT CHECK(status IN ('none','downloading','paused','verifying','ready','failed')),
  tok_per_s REAL, hwaccel TEXT, verified_at INTEGER);

CREATE TABLE rate_events (bucket TEXT NOT NULL, ts_ms INTEGER NOT NULL);      -- sends/chat, sends/global, creates, llm runs
CREATE INDEX ix_rate ON rate_events(bucket, ts_ms);
```

Retention job (daily + at startup): `item_messages` and `proposals.draft_reply` of closed items older than `privacy.retentionDays` (default 30) are deleted; `llm_runs` > 90 days; bridge media janitor deletes files in `<userData>\bridge\store\<jid>\` older than 7 days (never `*.db`).

Child PIDs are NOT in SQLite: `<userData>\run\children.json` (`{name,pid,exePath,startedAt}`), written atomically, so the orphan reaper works even if the DB is locked or corrupt.

---

## 6. IPC surface

Sandboxed CJS preload exposes `window.api.invoke(channel, payload)` and `window.api.on(channel, cb)`; both check the channel against a compile-time allow-list; main validates every payload with zod and checks `senderFrame` (top frame, `app://` origin).

| Invoke channel | Payload -> result | Notes |
|---|---|---|
| `app:getBootstrap` | -> `{lang, dir, onboarding, health, settingsPublic, version}` | one call paints the first frame |
| `health:get` | -> `AppHealth` | |
| `items:list` | `{state, limit<=50, before?}` -> `ItemCard[]` | cards carry display-ready fields + `actions[{id,kind,shownHash}]` |
| `items:get` | `{id}` -> `ItemDetail` (messages snapshot, proposal, badges) | |
| `items:dismiss` | `{id}` | -> ignored / closed `dismissed` |
| `items:reanalyse` | `{id}` | also used by "Analyse anyway" |
| `items:setEditing` | `{id, editing}` | drives the edit-lock (2.6) |
| `action:approve` | `{actionId, kind, editedText?, editedEvent?, shownHash}` -> `{ok} | {error: ErrorCode}` | the only path to a side effect |
| `chats:setMuted` | `{jid, muted}` | jid must exist in `chats` |
| `onboarding:getState` / `onboarding:setStep` | | resumable |
| `whatsapp:getPairing` | -> `{status, qrDataUrl?, expiresAt?}` | QR PNG fetched by main, passed as data URL |
| `whatsapp:newCode` / `whatsapp:relink` | | kill + respawn; relink deletes only `store\whatsapp.db` after confirm |
| `google:importCredentials` | `{filePath}` (from main-owned open dialog or drop) -> validation result | |
| `google:startSignIn` / `google:getStatus` / `google:disconnect` / `google:listCalendars` | | `manage-accounts` driven, `shell.openExternal(auth_url)` after host check `accounts.google.com` |
| `llm:getHardware` | -> `{ramGb, gpus[], recommendedTier, freeDiskGb}` | |
| `llm:setProvider` | `{provider}` | refuses cloud without consent |
| `llm:setKey` / `llm:testKey` | `{provider, key}` -> `KeyCheck` | key goes main-only, never echoed back |
| `llm:listModels` | `{provider}` | |
| `model:startDownload` / `model:pause` / `model:resume` / `model:cancel` / `model:selfTest` | | |
| `settings:get` / `settings:set` | whitelisted keys only | |
| `ui:setLanguage` | `{lang:'system'|'he'|'en'}` | main persists, rebuilds tray, broadcasts |
| `consent:accept` | `{kind, version}` | |
| `diagnostics:export` | -> path of a redacted zip | user-initiated |
| `app:openExternal` | `{target: enum}` | enum of known URLs from `links.json`, never a free URL |

| Push channel (main -> renderer) | Payload |
|---|---|
| `health:changed` | `AppHealth` |
| `items:changed` | `{upserted: ItemCard[], removedIds: string[]}` |
| `items:updateHeld` | `{id}` (edit-lock chip) |
| `model:progress` | `{modelKey, bytesDone, bytesTotal, bps, etaSec, status}` (throttled 4/s) |
| `pairing:changed` | `{status, qrDataUrl?, expiresAt?}` |
| `google:changed` | `{status, email?}` |
| `ui:languageChanged` | `{lang, dir}` |
| `ui:navigate` | `{view, itemId?}` (from tray / notification click) |

---

## 7. Onboarding flow

Principles: one decision per screen, one primary button, large type, language toggle always visible top corner (auto-selected from `app.getPreferredSystemLanguages()`, `iw` treated as `he`), every step resumable, closing the window during onboarding hides to tray and keeps downloads alive, a slim progress rail "1 בינה - 2 WhatsApp - 3 יומן".

| Step | Screen | What happens underneath |
|---|---|---|
| 0 Welcome | Three bullets: what it reads, what it drafts, **"שום דבר לא נשלח ולא נקבע בלי אישור שלך"**. Checkbox: unofficial WhatsApp connection / small ban risk / uses one linked-device slot. | `consents(whatsapp_tos)`. Hardware probe starts silently (RAM, free disk, `llama-server --list-devices`). |
| 1 Choose the AI | Three cards. **Local (recommended)**: "פרטי לגמרי, בחינם, הורדה חד-פעמית של X GB" with the result of the probe in plain words ("המחשב שלך מתאים למודל הרגיל"). Claude / Gemini: "מהיר יותר, דורש מפתח, ההודעות נשלחות לענן". | Local: download starts at once, user is moved on immediately; a progress pill lives in the header for the rest of onboarding and on the dashboard. Free disk < 12 GB -> small tier or a clear "not enough space" message with the needed number. Cloud: consent screen -> paste key -> live validation (`models.retrieve` / `models.get`) with specific errors (bad key, no credits, old Gemini key format). |
| 2 Link WhatsApp | Big QR, three illustrated phone steps in the user's language (WhatsApp -> Linked devices -> Link a device), countdown ring synced to `expires_at`, automatic refresh, "קוד חדש" button on timeout. Success: check mark + "מחובר". Then one question: look at messages **from now on** (default) / last 24 h / last 3 days. | Bridge spawn, poll `/api/pairing/status` 1.5 s, fetch `qr.png` in main. All exits respawn silently; the user only ever sees "מכין קוד..." . `paired_at` + watermark stored. Errors: no free linked-device slot / logged out / "Client outdated" each have their own screen. |
| 3 Connect Google Calendar | Intro with honest expectation: "כ-5 דקות, פעם אחת". Buttons: **"בואו נתחיל"** and **"אחר כך"** (skip). Then the 5-step wizard from the calendar research: each step = one deep link button + annotated screenshot + "סיימתי, הבא"; JSON drop zone with specific validation errors ("יצרת לקוח מסוג Web - צריך Desktop app"); sign-in step with an explainer picture of the "Google hasn't verified this app" screen shown **before** the browser opens. | `manage-accounts add` -> `shell.openExternal(auth_url)` -> poll `list` every 2 s up to 5 min -> smoke `list-events` for today -> show email + calendar name. Links and screenshots come from `resources/onboarding/links.json` so they can be patched. Steers to "Publish app" to avoid the 7-day expiry. |
| 4 Ready | Checklist with live states (AI: downloading 43% / ready; WhatsApp: connected; Calendar: connected / not yet). Checkbox "הפעלה עם Windows (מוסתר ליד השעון)" default checked. Picture of the Windows 11 hidden-icons flyout showing where the app lives. Button "לדשבורד". | Optional 20-second **demo**: a built-in sample conversation ("נפגש ביום חמישי ב-17:00 לקפה?") runs through the real pipeline and shows a sample card. This doubles as the model self-test and tok/s benchmark (9.3). |

After onboarding, anything unfinished is a **setup strip** at the top of the dashboard ("היומן עדיין לא מחובר - חיבור"), never a modal.

While the model is still downloading, incoming messages that pass the pre-filter become cards with `analysis='waiting_model'` ("ינותח כשההורדה תסתיים - 12 דק'"), and are analysed oldest-first when the model is ready.

---

## 8. Dashboard (the only main view)

- Default window 980 x 680, min 420 x 560. >= 900 px: three columns; narrower: one column with three collapsible sections. In RTL the first column ("ממתינות לתשובה") is on the right. Column titles: **ממתינות לתשובה / חסרים פרטים / ביומן** - Needs reply / Information missing / In calendar. Each shows the latest 20 with a count badge and "עוד".
- Header: app name, **health pill** (one dot: green "הכול פועל", amber "עובד על זה", red "דרוש טיפול"; click expands three rows WhatsApp / AI / Calendar with a state sentence and one action each), model-download pill when relevant, pause toggle, language toggle (עב / EN), settings gear. Footer: "Ignored (n)" drawer link, usage counter for cloud providers.
- Card anatomy: contact name `<bdi>` + phone `<bdi dir="ltr">`, relative time, last inbound message (`dir="auto"`, plain text, 3 lines, expandable to the snapshot thread), badges, event block rendered by the app from structured fields (weekday + date + `<bdi>` time range + time zone when not Asia/Jerusalem; inline-editable date, time, duration, title, location), draft textarea, buttons. Primary button depends on the list: needs_reply -> "אישור ושליחה" (+ "הוספה ליומן" when an event exists); info_missing -> "בקשת פרטים" (sends the clarifying question, still by explicit click); in_calendar -> "פתיחה ביומן" (+ send if the confirmation reply is still unsent). Secondary: "העתקה", "התעלמות", overflow: re-analyse, mute chat.
- Analysis progress on the card: "מנתח..." with elapsed seconds and step ("בודק ביומן..."); queue position when > 1 ("2 לפניך"). Never a global blocking spinner.
- Empty states teach: "אין הודעות שמחכות לך. האפליקציה ממשיכה לעקוב ברקע."
- Stack: React 19 + zustand + Tailwind 4 logical utilities, i18next with bundled `en.json`/`he.json`, system Segoe UI (no bundled font in v1), all dates via `Intl` with explicit `he-IL`/`en-IL`, `h23`, explicit time zone. No markdown, no `dangerouslySetInnerHTML` (lint-banned).

---

## 9. Local model management

### 9.1 Tiering (first match wins; never count iGPU shared memory)
free disk < 12 GB -> small; dedicated VRAM >= 7.5 GB and RAM >= 15 GB -> mid full offload; dedicated VRAM 5.5-7.5 GB and RAM >= 15 GB -> mid partial; no dGPU and RAM >= 30 GB -> mid on CPU; RAM >= 12 GB -> small E4B; else small E2B. The user sees the recommendation in words and may override ("מודל קטן ומהיר יותר" / "מודל גדול ומדויק יותר").

### 9.2 Downloader
Own implementation in main: manifest entries pin `repo`, `commit`, `file`, `size`, `sha256` at build time; always request `https://huggingface.co/<repo>/resolve/<commit>/<file>` (signed CDN redirect expires), HTTP Range resume into `<userData>\models\<file>.part`, host allow-list for redirects, progress with speed and ETA, pause/resume/cancel, survives app restart and sleep, free-space check before and during, SHA-256 in the hash worker, atomic rename, only then `status='ready'`. Friendly errors: no internet / disk full / hash mismatch (auto re-download once) / blocked by proxy. If the user profile path is non-ASCII (Hebrew Windows username) and the self-test fails to load the model, fall back to `C:\ProgramData\WhatsAppCalendarAgent\models` (UNVERIFIED need).

### 9.3 Self-test and benchmark (also the onboarding demo)
After load: run the golden sample through the real pipeline. Must return schema-valid JSON with the right weekday; measure decode tok/s. Garbage output or crash -> restart with `--device none`, persist `hwaccel='off'` (Intel iGPU Vulkan bugs). < 5 tok/s -> *suggest* (never auto) the smaller model or a cloud provider. Result shown in Settings -> AI as "מהירות: טובה / איטית".

---

## 10. Settings (one scrolling page, six groups, no jargon)

| Group | Settings |
|---|---|
| General | language (System / עברית / English); start with Windows hidden; notifications (off / "new item" without content / with contact name - default: with name, never message text) |
| WhatsApp | connection state + "קישור מחדש"; analyse only known contacts (default on); muted chats list; backlog window; "pause watching" |
| Calendar | connected account + reconnect / disconnect / replace credentials; target calendar (from `list-calendars`); default event duration (60); time zone (Asia/Jerusalem); event title language = chat language |
| AI | provider radio with privacy one-liner each; Local: model tier, speed result, hardware acceleration Auto/Off, "analyse on battery" (default on), delete model; Claude: key, model dropdown, test; Gemini: key, model, test, free-tier warning; daily cloud token budget with counter |
| Replies | my gender for Hebrew phrasing (m / f / unspecified); tone (casual default / formal) |
| Privacy and data | what leaves the PC (table); retention days (30); delete all app data; consents given; export redacted diagnostics; licences (bridge MIT, llama.cpp MIT, Gemma Apache-2.0, MCP server MIT) |

Secrets: `safeStorage` async API -> `secrets` BLOBs; decrypt failure = "key missing" state, not a crash. Clients are always constructed with an explicit key (stray `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` env vars are removed from child/env usage).

---

## 11. Tray lifecycle

- `requestSingleInstanceLock()`; second launch re-shows the window. `app.setAppUserModelId(appId)`.
- Window `close` -> `preventDefault(); hide()` unless `isQuitting`. **First time only**: a toast + in-window coach mark before hiding: "האפליקציה ממשיכה לעבוד ליד השעון, תחת 'סמלים מוסתרים'. ליציאה מלאה: לחיצה ימנית על הסמל -> יציאה", with the flyout picture, and a tip how to drag the icon out of the overflow (Windows gives no API to promote it).
- Tray: left click toggles the window; tooltip = app name + state + open count; icon variants: normal / attention (open items) / error / paused. Menu: Open - status line (disabled) - Pause/Resume watching - Settings - **Quit**. Menu and tooltip are rebuilt on language change from the main-process i18next instance. No Tray GUID while unsigned.
- Quit (tray only): `isQuitting=true` -> stop intake -> abort running LLM call -> close MCP transport -> kill llama -> kill bridge (`child.kill()`, then `taskkill /PID <pid> /T /F` after 3 s, by PID only, never by image name because the user's other bridge uses the same image) -> clear `children.json` -> `app.exit`. If there are actions in `executing`, wait up to 5 s.
- Windows shutdown/logoff: `session-end` on the window (+ `powerMonitor` shutdown) triggers the same kill path; whether a hidden window receives it is UNVERIFIED, so the orphan reaper at next start is mandatory: for each entry in `children.json`, kill only if the PID is alive **and** its image path equals our resources path.
- Autostart: `setLoginItemSettings({openAtLogin, args:['--hidden']})` only when packaged; `--hidden` starts without creating the window.
- Notifications: new open item -> toast "פריט חדש מ<bdi>דנה</bdi>" (no message text). Click -> show window -> `ui:navigate` to the card. No action buttons on toasts.

---

## 12. Error and restart strategy

`HealthHub` merges supervisor states into one `AppHealth = { overall, whatsapp, llm, calendar, queue:{pending,running}, paused }`. Each sub-state is `{ state, code?, since }`. Each `ErrorCode` has i18n keys `errors.<code>.title|body|action` in both languages and an action enum.

| Component | Detection | Automatic recovery | If that fails - what the user sees (one action) |
|---|---|---|---|
| Bridge process exit (always code 0) | `exit` event and not quitting | respawn, backoff 2 / 5 / 15 / 60 s, fresh port + token | after 5 exits in 10 min: `BRIDGE_CRASH_LOOP` "החיבור ל-WhatsApp נכשל שוב ושוב" -> "נסו שוב" |
| Bridge port bind failed | stdout `REST API server error` or no 200 in 10 s | respawn on a new port | same as above |
| Bridge exe missing / hash mismatch (Defender quarantine) | pre-spawn check | none | `BRIDGE_BINARY_BLOCKED`: explains antivirus, "פתיחת הוראות" |
| WhatsApp disconnected | `/api/health` 503 (poll 20 s) | bridge self-heals; after 10 min kill + respawn; catch-up scan on reconnect | amber "מתחבר מחדש..." (no action needed); red after 30 min with "בדקו את האינטרנט" |
| Logged out from phone | pairing status `error` + logged-out text / stdout marker | none (needs the user) | `WA_LOGGED_OUT` "המכשיר נותק מהטלפון" -> "קישור מחדש" (deletes only `store\whatsapp.db` after confirm) |
| `Client outdated` | stdout marker | none | `BRIDGE_OUTDATED` "נדרש עדכון לאפליקציה" -> "בדיקת עדכון"; drafting continues on stored data, sending disabled, copy works |
| Webhook missed | cannot be detected directly | 60 s rowid scan + scan on reconnect | invisible |
| MCP server exit | transport `onclose` | restart x3 with backoff, re-verify `tools/list` | `CAL_UNAVAILABLE` "היומן לא זמין כרגע" -> "נסו שוב"; cards keep working, "הוספה ליומן" disabled with reason |
| Google token invalid (`invalid_grant`, 7-day Testing expiry) | tool error text mapping | none | `CAL_RECONNECT` "החיבור ל-Google פג" -> "התחברות מחדש" (+ hint about Publish if Testing was chosen) |
| OAuth callback ports 3500-3505 busy | `EADDRINUSE` text | retry once | `CAL_PORT_BUSY` with plain instruction |
| MCP spawned a second GUI instead of the server (fuse off) | initialize timeout + packaging test | - | build-time test blocks the release |
| llama-server crash / garbage | exit, `/health` fail, self-test fail | restart once; then `--device none` persisted | `LLM_LOCAL_FAILED` -> "בדיקה חוזרת" / "מעבר למודל קטן" |
| Model file missing / corrupt | size check at start, hash flag | offer re-download | `MODEL_MISSING` -> "הורדה מחדש" |
| Out of memory / very slow | self-test < 5 tok/s, load failure | suggest smaller tier | suggestion chip, never automatic |
| Cloud 401 / 403 | SDK error class / status | none | `KEY_INVALID` -> "עדכון מפתח" |
| Cloud 402 / spend cap / Gemini `quota_exceeded` | error codes (no retry-after) | no retry; queue paused until next day or key change | `CLOUD_QUOTA` -> "פתיחת הגדרות AI" (offers switching to Local) |
| Cloud 429 rate / 5xx / network | SDK retries (2) then queue backoff 30 s -> 10 min | automatic | amber only |
| Model id retired (404) | error code | fall back to the provider default from `models.list()` | toast "המודל הוחלף ל-..." |
| LLM output invalid twice | validator | one repair retry | card: "לא הצלחתי לנתח - אפשר לענות ידנית" + "ניתוח חוזר" |
| Send failed | `/api/send` non-200 / timeout | none (never auto-resend) | inline on the card: "השליחה נכשלה" -> "נסו שוב" / "העתקה" |
| Send unconfirmed | no matching `is_from_me` row in 60 s | - | chip "נשלח (לא אומת)" |
| Rate limit hit (6/h per chat, 20/h, 60/day) | RateLimiter | - | inline: "הגעת למגבלת השליחה לשעה - מגן על החשבון שלך" |
| App DB corrupt / migration failed | open/migrate error | restore `app.db.bak` | `DB_RECOVERY` screen -> "שחזור" / "התחלה מחדש" (bridge pairing is unaffected) |
| safeStorage decrypt fails | exception | treat as missing | `KEY_MISSING` |

Startup recovery: `analysis='running'` -> `queued`; `actions.status='executing'` older than 2 min -> `failed` with `UNKNOWN_OUTCOME` and the card says "בדקו ב-WhatsApp / ביומן אם הפעולה בוצעה" (never blind-retry a side effect); partial downloads resume; orphans reaped.

Logging: one redaction choke point (`log.ts`): no message text, no phone numbers (hashed suffix), no tokens/keys. Bridge stdout is parsed for markers only and never persisted. Rotating files in `<userData>\logs`, 5 x 1 MB.

---

## 13. Packaging layout

electron-builder 26.15.3, NSIS `oneClick:true`, `perMachine:false`, x64 only, `npmRebuild:false`, `deleteAppDataOnUninstall:false` (uninstaller offers a checkbox "מחיקת הנתונים והמודל"), no auto-update in v1.

```
<install>\WhatsApp Calendar Agent\
  WhatsApp Calendar Agent.exe
  resources\
    app.asar                                   main (ESM), preload (CJS), renderer, locales
    bridge\whatsapp-bridge.exe                 exact pinned build, + LICENSE (MIT)
    llama\llama-server.exe, *.dll, LICENSE     all ggml-cpu-*.dll variants + ggml-vulkan.dll; nothing removed
    calendar-mcp\node_modules\...              npm install --omit=dev --ignore-scripts @cocal/google-calendar-mcp@2.6.3
    tray\*.ico                                 normal / attention / error / paused
    onboarding\*.webp, links.json              wizard screenshots (he + en) and patchable console URLs
    manifests\models.json, bridge.json         pinned commits, sizes, sha256
    THIRD_PARTY_NOTICES.txt

%APPDATA%\WhatsApp Calendar Agent\   (userData)
  data\app.db (+ -wal, .bak)
  bridge\            <- bridge cwd
     store\whatsapp.db, messages.db, <jid>\media...     created by the bridge; app opens messages.db read-only only
     outbox-empty\
  google\gcp-oauth.keys.json, tokens.json
  models\*.gguf, *.part
  run\children.json
  logs\
```

Fuses: RunAsNode **on** (D10), EnableNodeOptionsEnvironmentVariable off, EnableNodeCliInspectArguments off, OnlyLoadAppFromAsar on, EmbeddedAsarIntegrityValidation on (if it works with 26.15.3 - UNVERIFIED), GrantFileProtocolExtraPrivileges off (renderer on `app://`), CookieEncryption on.

Expected installer ~200-240 MB (Electron ~110, bridge 43 -> ~15 compressed, llama ~30, calendar-mcp/googleapis ~200 unpacked -> ~25 compressed). Build-time gates: bridge hash check, llama zip hash check, a packaged-app smoke test that performs an MCP `initialize` through `process.execPath`, and an NSIS install/upgrade test on a path with a space.

Bridge binary intake: `scripts\import-bridge.ps1` (run by the user or a build agent without executing the exe) copies **only** `whatsapp-bridge.exe` into `vendor\bridge\`, verifies SHA-256 against `manifests\bridge.json`, and refuses otherwise; Go sources are vendored under `vendor\whatsapp-bridge-src\` for reference. The script never enumerates the source folder and never touches `store\`.

---

## 14. Directory structure

```
C:\dev\whatsapp agent\
  package.json  electron.vite.config.ts  electron-builder.yml  tsconfig*.json  eslint.config.js
  docs\research\*  docs\proposals\*
  scripts\import-bridge.ps1  fetch-llama.ps1  build-calendar-mcp.ps1  pin-models.ts
  vendor\bridge\whatsapp-bridge.exe  vendor\whatsapp-bridge-src\  vendor\llama\win-x64-vulkan\
  build-resources\calendar-mcp\  build-resources\tray\  build-resources\onboarding\
  src\
    shared\            ipc.ts (channel map + zod schemas)  proposal.ts  errors.ts (ErrorCode enum)  health.ts
                       locales\en.json he.json   i18n\languages.ts format.ts   when.ts (WhenExpr + resolveWhen)
    main\
      index.ts  lifecycle.ts  tray.ts  window.ts  protocol.ts (app://, CSP)  i18n.ts  log.ts
      db\        Db.ts  migrations\001_init.sql  repos\{items,chats,proposals,actions,settings,models}.ts
      security\  secrets.ts  consent.ts  sanitize.ts  rateLimiter.ts  ipcGuard.ts
      proc\      ProcessSupervisor.ts  pidRegistry.ts  orphanReaper.ts  ports.ts
      bridge\    BridgeSupervisor.ts  BridgeClient.ts  WebhookListener.ts  BridgeDbReader.ts  stdoutMarkers.ts  mediaJanitor.ts
      ingest\    Ingestor.ts  filters.ts  jid.ts  timestamps.ts
      triage\    PreFilter.ts  cues.he.json  cues.en.json  TriageQueue.ts  TriageOrchestrator.ts  prompt\system.ts dateTable.ts replyLang.ts
                 ProposalValidator.ts  stateDecider.ts
      llm\       types.ts  registry.ts  local\LocalProvider.ts LlamaSupervisor.ts unionSchema.ts
                 claude\ClaudeProvider.ts  gemini\GeminiProvider.ts schemaSanitizer.ts
      mcp\       McpHost.ts  policy.ts  ToolBroker.ts  projections.ts  GoogleAccount.ts  CalendarSync.ts
      actions\   ActionExecutor.ts  actionHash.ts            <- only importer of McpHost.callWrite and BridgeClient.send
      models\    hardware.ts  manifest.ts  Downloader.ts  hashWorker.ts  selfTest.ts
      onboarding\ state.ts
      health\    HealthHub.ts
      ipc\       register.ts  handlers\*.ts
    preload\index.ts
    renderer\
      main.tsx  App.tsx  store\*.ts  i18n.ts  styles.css
      views\     Dashboard.tsx  Onboarding\{Welcome,ChooseAi,LinkWhatsApp,GoogleWizard,Ready}.tsx  Settings.tsx
      components\ ItemCard.tsx  EventEditor.tsx  DraftBox.tsx  HealthPill.tsx  DownloadPill.tsx  SetupStrip.tsx  Badge.tsx  IgnoredDrawer.tsx
  tests\
    unit\ (vitest node + jsdom)   golden\he-en-triage.jsonl (40-60 items)   fakes\fake-bridge.ts fake-mcp.ts fake-llm.ts
    e2e\ (Playwright _electron against the unpackaged build with fakes)
```

Tests that matter most for this angle: onboarding resume at every step; card appears < 1 s after a fake webhook; edit-lock; approval hash/stale/expired; "write tool unreachable" import-graph test; RTL snapshot tests of cards with mixed Hebrew/English/phone numbers; every `ErrorCode` has both translations and an action (unit test over the enum); the golden set per provider.

---

## 15. Perceived-performance budget (weak laptop: 8 GB RAM, no dGPU)

| Moment | Budget | How |
|---|---|---|
| Tray click -> window visible | < 300 ms (hidden window), < 1.5 s (recreated) | window kept alive; `app:getBootstrap` single round trip; dashboard reads from app.db |
| WhatsApp message -> card on screen | < 1.5 s | doorbell + rowid scan + immediate push (D1) |
| Card -> analysed (Local, E2B/E4B CPU) | 25-60 s typical, shown as progress | static prompt prefix cached in the llama slot, ctx 4096, thinking off, output <= 250 tokens, tool round skipped when no date+time, concurrency 1, below-normal priority |
| Card -> analysed (cloud) | 2-6 s | low effort / thinking level, non-streaming |
| Approve click -> feedback | < 50 ms spinner, 1-3 s result | optimistic UI state, never blocks other cards |
| Idle footprint | Electron ~250 MB + bridge ~80 MB + MCP ~120 MB; llama 0 when asleep | llama idle-sleep 600 s; renderer destroyed after 10 min hidden on low-RAM tier |

---

## 16. Decisions to put to the user (option dialog candidates)

1. Claude default model: `claude-sonnet-5` (proposed) vs `claude-opus-5` vs `claude-haiku-4-5`.
2. Backlog on first pairing: from now (proposed) / 24 h / 3 days.
3. Start with Windows: pre-checked (proposed) vs unchecked.
4. Ambiguous hour ("ב-5"): assume and flag (proposed) vs send to "Information missing".
5. Notifications: with contact name (proposed) vs generic vs off.
6. Analyse unknown senders: off (proposed) vs on.
7. "Needs reply" scope: scheduling + direct questions (proposed) vs scheduling only vs everything.
8. Bundle Heebo font vs system Segoe UI (proposed).
9. v1 create-only calendar (proposed) vs also enabling `update-event` for app-created events with a before/after approval card.

---

## 17. Honest weaknesses of this proposal

1. **runAsNode fuse is left enabled** (D10), against the security report's recommendation. Anyone who can run our exe with `ELECTRON_RUN_AS_NODE=1` gets a Node runtime under our name. Mitigated only partially (other fuses, per-user install). The clean fix (a custom transport or a verified shared OAuth flow in-process) is deferred.
2. **The Google step is still painful.** A non-technical user must create a Google Cloud project and click through an "unverified app" warning. Screenshots rot as Google changes its console. The wizard and the skip button soften it; only a publisher-verified OAuth client removes it, and that is out of scope here.
3. **The keyword pre-filter will miss messages** (slang, typos, transliteration, "סגור, נדבר על זה אחרי החג"). Missed items sit silently in "Ignored". This trades recall for speed, cost and privacy; the lexicon needs real-world tuning and there is no telemetry to guide it.
4. **Local "tool calling" is emulated with a JSON-schema union grammar**, not the model's native tool-call format. It is more reliable on small models, but it is an interpretation of "expose MCP tools through tool calling", and `anyOf` unions in llama.cpp b10964's schema-to-grammar converter are UNVERIFIED. If unions fail, the fallback is two constrained calls (decide-tool, then final), which costs more latency.
5. **Slow on CPU regardless.** 25-60 s per item, non-streaming; a busy morning with 15 cue-matching chats means a 10-minute queue and a warm laptop. D1 hides the wait but does not remove it. No streaming of the draft in v1.
6. **One open item per chat** collapses parallel topics with the same person into one card; the newest triage wins and an older, still-valid proposal can be superseded.
7. **Create-only calendar.** Reschedules and cancellations produce only a reply draft and a hint; "In calendar" can show an event the conversation has since moved. CalendarSync detects deletion in Google but not semantic staleness.
8. **A second plaintext copy of private message text** lives in `app.db` (`item_messages`, drafts) next to the bridge's own unencrypted DBs. Retention purging limits but does not remove this; same-user malware can read everything.
9. **Three child processes plus Electron on an 8 GB machine** is tight with E2B loaded (~4 GB). The low-RAM window destruction and idle sleep help, but paging is likely while the user has a browser open.
10. **Background download during onboarding** competes for bandwidth with the Google console pages and QR pairing on slow connections, and makes onboarding state more complex (more resume paths to test).
11. **Send confirmation is heuristic** (`/api/send` returns no message id; we match text in `messages.db` within 60 s). Edited-by-WhatsApp text or a slow store write yields "sent (unverified)", which may worry the user.
12. **`@lid` chats cannot be answered from the app** in v1 (copy only), which will feel like a bug to the user who cannot know what a LID is.
13. **Unknown senders are not analysed by default**, so a first message from a new contact proposing a meeting gets no draft until the user clicks.
14. **The bridge is an unsigned, locally modified binary nobody here can rebuild.** When WhatsApp bumps the protocol the app's core stops and the best we offer is a clear "needs update" message. SmartScreen/Defender friction at install is likely and no UX copy fully fixes it.
15. **Autostart pre-checked and a tray icon that Windows hides by default**: some users will forget the app is running; others will think it vanished. The coach mark is a one-time fix for a persistent OS behaviour.
16. **Hebrew copy, the cue lexicon and the phone-menu wording are unreviewed by a native-speaking tester**, and ~4B models write mediocre Hebrew (gender agreement, register); the Edit-first card design compensates rather than solves.
17. **`node:sqlite` is release-candidate** and synchronous on the main thread; the `Db` interface is the only hedge.
18. Several load-bearing facts are UNVERIFIED until a supervised first run: bridge timestamp format, `session-end` on hidden windows, Unicode model paths, ASAR integrity on Windows, combining tools with structured output on each cloud API, and `manage-accounts` behaviour under `ENABLED_TOOLS`.
