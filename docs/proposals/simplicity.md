# Architecture Proposal - SIMPLICITY-FIRST

Project: WhatsApp Calendar Agent (Electron + TypeScript, Windows 11 x64)
Date: 2026-09-21
Angle: fewest processes, fewest dependencies, smallest surface that still satisfies every locked requirement; must be
finishable by a ~15-agent parallel build and must not break at packaging time.

Inputs: all ten reports in `docs/research/`. Where reports disagree, this document picks one side and says why.

---

## 0. The ten decisions that define this proposal

| # | Decision | Why (simplicity argument) |
|---|---|---|
| D1 | **Zero native Node addons.** No `node-llama-cpp`, no `better-sqlite3`, no `electron-rebuild`, `npmRebuild:false`, no `asarUnpack`. | Every packaging failure mode in the research (ABI coupling, asarUnpack globs, 695 MB of CUDA optional deps, ESM-only externals) comes from native addons. Removing the category removes the risk. |
| D2 | **Local LLM = official `llama-server.exe` (Vulkan x64 zip, pinned b10964) as a lazily started child**, spoken to over OpenAI-compatible HTTP on loopback. | It is "a folder of plain files in `extraResources`", uses the same supervisor the bridge already needs, a GPU driver crash cannot take down the app, and the Local provider becomes ~150 lines of `fetch`. Still "llama.cpp embedded, no Ollama". |
| D3 | **No utilityProcess, no worker threads.** Everything the app owns runs in the Electron main process. | All heavy work is already out-of-process (bridge, llama-server, MCP server, cloud APIs). Main only does I/O and small synchronous SQLite queries. |
| D4 | **Exactly three managed children, one `Supervisor` class:** `whatsapp-bridge.exe` (always), calendar MCP server (once Google is configured), `llama-server.exe` (only while provider = Local and work exists). | One restart/kill/orphan-reap implementation, three small config objects. |
| D5 | **One ingestion path: scan the bridge's `messages.db` by `rowid` watermark.** The webhook is a body-discarding doorbell that calls the same `scan()` function; a 30 s timer calls it too. | Text webhooks have no message id/timestamp and no retry, so a DB scan is mandatory anyway. Making it the *only* path deletes the webhook-payload parser, the dedupe logic and a whole class of race bugs. Verified in `main.go`: messages are written with `INSERT ... ON CONFLICT(id, chat_jid) DO UPDATE`, not `INSERT OR REPLACE`, and the table is not `WITHOUT ROWID`, so rowids are stable and monotonic. |
| D6 | **Unit of work = a chat, not a message. At most one open item per chat.** | Removes message-level dedupe, makes re-triage idempotent, maps 1:1 to dashboard rows. |
| D7 | **One bounded tool loop shared by all three providers, terminated by a virtual tool `submit_triage`.** No `response_format`/`output_config`/grammar special cases per provider. | Tool calling is the one structured-output mechanism all three providers have in common. One orchestrator, three thin adapters. |
| D8 | **The LLM only ever sees app-authored tool definitions** (2 calendar READ tools + `submit_triage`). MCP write tools are reachable from exactly one function (`executor.ts`) that is called from exactly one IPC handler. | Gating by construction instead of by policy tables spread across modules. |
| D9 | **MCP server runs over stdio via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; the `runAsNode` fuse stays ON.** | The only verified way to run a Node stdio server on a machine without Node. The alternatives (HTTP transport = unauthenticated localhost calendar-write endpoint; custom MessagePort transport = a spike) are both worse or riskier. |
| D10 | **Renderer: React + react-i18next + plain CSS modules with logical properties.** No Tailwind, no zustand, no router, no component library, no electron-log, no ajv, no openai SDK. | Three lists, one settings page, one wizard. Every removed dependency is one less version trap (the research lists five npm `latest` traps already). |

Runtime `dependencies` (complete list): `@anthropic-ai/sdk@0.127.0`, `@google/genai@2.23.0`, `@modelcontextprotocol/sdk@1.30.0`,
`zod@4.6.5`, `i18next@26.4.2`. All pure JS. Renderer libraries are dev dependencies bundled by Vite.

---

## 1. Process model

```
                         Windows 11 user session
┌──────────────────────────────────────────────────────────────────────────────┐
│ Electron MAIN (ESM, Node 24.21)  - owns ALL logic, state, secrets, policy    │
│   db (node:sqlite app.db)  |  bridgeDb (node:sqlite, READ-ONLY messages.db)  │
│   doorbell http 127.0.0.1:<rand>/hook/<secret>                               │
│   Supervisor x3  |  ingest  |  triage loop  |  executor  |  tray  |  ipc     │
├───────────────┬──────────────────┬─────────────────────┬─────────────────────┤
│ RENDERER      │ whatsapp-bridge  │ calendar MCP server │ llama-server.exe    │
│ sandboxed,    │ .exe (Go)        │ (Electron-as-Node)  │ (llama.cpp b10964)  │
│ app:// , CSP  │ cwd=<userData>\  │ stdio JSON-RPC      │ HTTP 127.0.0.1:rand │
│ connect-src   │ bridge           │ @cocal/google-      │ + LLAMA_API_KEY     │
│ 'none'        │ REST 127.0.0.1:  │ calendar-mcp@2.6.3  │ LAZY: only when     │
│ IPC only      │ rand + bearer    │ started after Google│ provider=Local and  │
│               │ ALWAYS running   │ creds exist         │ a triage is queued  │
└───────────────┴──────────────────┴─────────────────────┴─────────────────────┘
        Cloud (only if chosen + consented): api.anthropic.com | generativelanguage.googleapis.com
        Google Calendar: reached ONLY by the MCP server child. App code contains no Google REST call.
```

Rules:

- **Main** is the only process with secrets, DB handles, network clients and child handles. It is ESM (`"type":"module"`).
- **Renderer** is a dumb view: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, served from `app://`, CSP
  `default-src 'self'; connect-src 'none'; img-src 'self' data:`. It never sees API keys, tokens, ports or file paths.
  The QR code is fetched by main and handed over as a `data:` URL.
- **Preload** is CJS (`out/preload/index.cjs`), exposes `window.api.invoke(channel, payload)` and `window.api.on(cb)` for
  an allow-listed channel set. Nothing else.
- **No utility processes.** `node:sqlite` is synchronous, but every query is an indexed point/range read on tiny tables;
  the bridge DB scan is `rowid > ?` (primary B-tree). Budget: no query over 20 ms; enforced by a dev-mode timer warning.
- **Bridge child**: spawned at app start once onboarding step "WhatsApp" has begun; kept alive while the app lives
  (including while hidden in the tray).
- **MCP child**: spawned when `<userData>\google\gcp-oauth.keys.json` exists; otherwise absent and calendar features show
  "not connected".
- **llama-server child**: spawned on first queued triage when `settings.llm.provider === 'local'` and a verified GGUF
  exists; `--sleep-idle-seconds 600` unloads the model when idle; killed when the provider is switched away or on quit.

Steady-state process count with a cloud provider: main + renderer (+ Chromium GPU/utility helpers) + bridge + MCP = 2 app
children. With Local: 3.

---

## 2. Data flow

### 2.1 Ingestion (deterministic, no LLM)

```
bridge writes row to messages.db ──► (then) POST doorbell ──┐
30 s safety timer ──────────────────────────────────────────┼──► ingest.scan()
bridge (re)start / app start / resume from sleep ───────────┘
```

Doorbell handler (whole thing): check method POST, path === `/hook/<secret>`, `Host` is `127.0.0.1:<port>`, no `Origin`
header, constant-time compare of `X-Bridge-Token`; **answer 200 immediately**; drain and discard the body (hard cap 20 MB,
then destroy socket); call `ingest.poke()` (coalesced with a 250 ms trailing debounce). Anything else gets a uniform 404.
The body is never parsed, so image base64 never enters the app.

`ingest.scan()`:

1. Open/reuse a read-only handle on `<userData>\bridge\store\messages.db` (`readOnly:true`, `PRAGMA query_only=1`,
   `busy_timeout=2000`). If the file does not exist yet, return.
2. `SELECT rowid, id, chat_jid, sender, content, timestamp, is_from_me, media_type FROM messages WHERE rowid > ? ORDER BY rowid LIMIT 500`
   with `?` = `kv.bridge_rowid_watermark`. Loop until fewer than 500 rows.
3. Per row, in TypeScript (no SQL date math - the on-disk timestamp format is UNVERIFIED; `parseBridgeTs()` accepts
   `YYYY-MM-DD HH:MM:SS[.fff][+HH:MM|Z]` and RFC 3339, returns epoch ms or `null`):
   - drop if `chat_jid` is not `^[0-9]{5,20}@s\.whatsapp\.net$` **or** `^[0-9]+@lid$` (groups, `status@broadcast`,
     newsletters, broadcasts are ignored here, centrally);
   - drop if `media_type === 'reaction'`;
   - drop if `ts < kv.activation_ts` - this is the **history-sync gate**: `activation_ts` is set to "now" the first time
     the bridge reports `connected` after a pairing, so the months of backlog that arrive without webhooks are never
     triaged, never shown, never sent to a cloud LLM;
   - drop if the chat is muted in `chats.muted`.
4. Group surviving rows by `chat_jid`. For each chat: upsert `chats` (name from the bridge `chats.name`, `last_in_ts`,
   `last_out_ts`). If the newest row is `is_from_me = 1` -> **auto-resolve**: an open `needs_reply`/`info_missing` item
   whose `trigger_ts` is older becomes `ignored` with `closed_reason='answered_elsewhere'` (this is why `FORWARD_SELF=true`
   and why own messages are scanned). Otherwise enqueue the chat for triage with a **20 s trailing debounce** (people
   send plans in bursts of short messages).
5. Persist the new watermark in the same app-DB transaction as the queue rows.

### 2.2 Triage (the only place an LLM runs)

Queue: table `triage_queue`, concurrency **1**, FIFO, survives restarts. One run = one chat.

1. Read the last 12 messages (max 6,000 chars, 2,000 per message) of that chat from the bridge DB. Skip the run if the
   newest inbound message id equals `chats.last_triaged_msg_id`.
2. `sanitizeForModel()` (NFKC, strip Unicode TAG block, bidi controls, zero-width, C0) on every text.
3. Build the prompt:
   - **system**: a constant English string + three trusted interpolations only (`nowIso`, IANA tz, reply language
     directive). Never names, never chat text.
   - **user**: a 14-day date table (`2026-09-24 | Thursday | יום חמישי`) computed in TS for `settings.timeZone`
     (default `Asia/Jerusalem`, Sunday-first), then the transcript as JSON inside per-run nonce delimiters with role
     labels `contact` / `me` (no names, no JIDs, no phone numbers).
   - Reply language = deterministic Hebrew-vs-Latin script count over the last 5 inbound messages.
4. Run the shared tool loop (section 4). Terminal output = the arguments of `submit_triage`, validated by a strict zod
   schema:

   ```ts
   // src/shared/triage.ts
   export const TriageResult = z.object({
     intent: z.enum(['schedule','reschedule','cancel','confirmation','question','smalltalk','other']),
     needsReply: z.boolean(),
     event: z.object({
       title: z.string().min(1).max(80),
       date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),       // must be a row of the injected date table
       time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
       durationMin: z.number().int().min(5).max(720).nullable(),
       location: z.string().max(120).nullable(),
       dateText: z.string().max(80),                         // verbatim phrase the date came from ("יום חמישי ב-5")
     }).strict().nullable(),
     missing: z.array(z.enum(['date','time','ampm','duration','location','confirmation'])).max(6),
     draftReply: z.string().max(600).nullable(),
     suspicious: z.boolean(),
   }).strict();
   ```

   Deliberately absent: recipient, attendees, calendarId, eventId, sendUpdates, recurrence, URLs, any "auto/approve" flag.
5. Deterministic post-validation (`agent/validate.ts`, no LLM):
   - `date` must be one of the 14 table rows or a valid future date <= 12 months; weekday words found in `dateText`
     (small he/en dictionary) must match the weekday of `date`, else add `missing:'date'`;
   - hour 1-7 with no am/pm cue in `dateText` -> add `missing:'ampm'` (product default: ambiguous "ב-5" goes to
     Information missing with a draft that asks; no silent 17:00 guess);
   - strip URLs from `draftReply`/`title`/`location`; flag phone/e-mail/6+ digit runs in the draft (amber badge);
   - `suspicious`, a blocked tool call, or an injection-heuristic hit -> red badge, draft collapsed by default;
   - `durationMin` null -> `settings.calendar.defaultDurationMin` (60).
6. No schema-valid `submit_triage` after one nudge retry -> item `info_missing` with `flags.unparsed`, no draft.

### 2.3 Item state (exactly four, derived by one pure function)

```ts
// src/main/agent/state.ts
export function deriveState(i: ItemCore): ItemState {
  if (i.eventStatus === 'created')                         return 'in_calendar';
  if (i.closedReason)                                      return 'ignored';
  if (isScheduling(i.intent) && i.missing.length > 0)      return 'info_missing';
  if (i.needsReply || i.event)                             return 'needs_reply';
  return 'ignored';
}
```

- `needs_reply`: there is a draft and/or a complete event proposal. The card shows the draft textarea with **Send** and,
  when `event` is complete, an event card with **Add to calendar**. Two independent approvals, two independent clicks.
- `info_missing`: scheduling intent but something is missing; the draft is a question asking for exactly the missing
  pieces. Card shows localized chips for `missing[]`, the draft with **Send**, and an inline mini-form so the user can
  fill the gap themselves and press **Add to calendar** without another LLM turn.
- `in_calendar`: event created through the app. Shows title, time, Google `htmlLink`; if the reply was never sent, the
  draft **Send** button is still available on the card.
- `ignored`: smalltalk/other, dismissed by the user, answered from the phone, superseded, or expired (open items older
  than 7 days are closed by the janitor). Not shown on the dashboard; visible in a "Recent activity" drawer for undo.

A new inbound message in a chat with an open item **re-triages and overwrites** that item (same row, `revision+1`,
previous draft discarded unless the user edited it - then the edit is kept and a "new messages arrived" badge is shown).

`reschedule`/`cancel` intents in v1: land in `needs_reply` with a badge "change the event in Google Calendar" and a link
to the existing event if the app created it. The app does not update or delete events in v1 (see 5.1).

### 2.4 Approval and execution (no LLM anywhere in this path)

```
renderer click ──invoke('items:approveReply' | 'items:approveEvent', {id, revision, payload})──► ipc handler
   ► senderFrame check ► zod-validate payload ► load item, compare revision (stale -> reject, UI refreshes)
   ► executor.sendReply(item, text)      or      executor.createEvent(item, eventFields)
```

`executor.ts` is the **only** module that imports `bridgeClient.send` and `mcp.callWrite`. An ESLint
`no-restricted-imports` rule plus a unit test over the import graph enforce it.

`executor.sendReply`:
- recipient = `item.chat_jid` from the DB (regex-checked again); never from the renderer, never from the model;
- text = exactly the textarea bytes from the click payload, sanitized for invisible/bidi chars, 1..2000 chars;
- never `media_path`, never quoted-message fields, never `/api/typing` or `/api/react`;
- rate limits (hard, in `kv`): 6/h per chat, 20/h and 60/day global; sends are serialized;
- `POST http://127.0.0.1:<port>/api/send` with bearer token; on `{success:true}` set `reply_status='sent'`, write
  `actions` row. The next scan sees our own outgoing row and keeps the item resolved.

`executor.createEvent`:
- args built from a field whitelist: `{calendarId: settings.calendar.id, summary, start, end, timeZone, location?,
  description: <app template: "Created by WhatsApp Calendar Agent from a chat with {{name}}">, sendUpdates:'none',
  allowDuplicates:false, account:'personal', extendedProperties:{private:{waAgent:'1', waItem:<id>}}}`;
  no attendees, no recurrence, no conference data in v1;
- `mcp.callWrite('create-event', args)`; on success store `calendar_event_id` + `htmlLink`, `event_status='created'`;
- a duplicate/conflict response from the server is shown to the user verbatim-safe (projected) with "Create anyway"
  being a **second explicit click** that sets `allowDuplicates:true`.

Every execution writes an append-only `actions` row (what, when, content sha256, result). That is the audit trail.

---

## 3. LLM provider abstraction

One interface, one orchestrator, three adapters. Adapters do **format translation and one HTTP round**; they never loop,
never execute tools, never see MCP.

```ts
// src/main/llm/provider.ts
export type ToolDef = { name: string; description: string; parameters: JsonSchema };   // app-authored only
export type ToolCall = { id: string; name: string; args: unknown };
export type ChatMsg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; opaque?: unknown }        // opaque = raw provider turn
  | { role: 'tool'; results: { callId: string; name: string; content: string; isError: boolean }[] };

export interface ChatRequest {
  system: string;
  messages: ChatMsg[];
  tools: ToolDef[];
  toolChoice: 'auto' | { force: string };      // adapters MAY degrade force -> auto; orchestrator copes
  maxOutputTokens: number;                       // 1024
  signal: AbortSignal;
}
export interface ChatResponse {
  assistant: Extract<ChatMsg, { role: 'assistant' }>;
  stop: 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'error';
  usage?: { inputTokens: number; outputTokens: number };
}
export interface LlmProvider {
  readonly id: 'local' | 'claude' | 'gemini';
  chat(req: ChatRequest): Promise<ChatResponse>;
  validate(): Promise<{ ok: true } | { ok: false; reason: 'bad_key'|'no_model'|'no_credit'|'offline'|'not_ready' }>;
  dispose(): Promise<void>;
}
```

`opaque` carries what each provider needs replayed verbatim (Claude `response.content` incl. thinking blocks; Gemini
`interaction.steps` incl. thought signatures; nothing for Local). A run always finishes on the provider that started it.

| Adapter | Transport | Notes (all from the research) |
|---|---|---|
| `local.ts` | `fetch` to `http://127.0.0.1:<port>/v1/chat/completions`, `Authorization: Bearer <LLAMA_API_KEY>` | OpenAI `tools`/`tool_calls`; `toolChoice.force` -> `tool_choice:"required"` with a single-tool list; `chat_template_kwargs:{enable_thinking:false}`; `parallel_tool_calls:false`; no sampling overrides except `temperature:0.2`. Ensures the llama-server child is running (`runtime.ensure()`), waits for `/health` 200. |
| `claude.ts` | `@anthropic-ai/sdk` `client.messages.create` (never `toolRunner`, never `mcpTools`, never the MCP connector) | `tools:[{name,description,input_schema}]`; force -> `tool_choice:{type:'tool',name}`, degraded to `auto` on a 400; `output_config:{effort:'low'}` only for models that accept it; never temperature/prefill; explicit `apiKey` (ignores stray env vars); maps 401/402/429-spend-cap to distinct reasons. Default model `claude-sonnet-5`; dropdown from `client.models.list()`. |
| `gemini.ts` | `@google/genai` `ai.interactions.create`, **`store:false` hard-coded in one place + unit test** | `tools:[{type:'function',...}]`; force -> `generation_config.tool_choice:{allowed_tools:{mode:'any',tools:[name]}}`; `thinking_level:'low'`; no temperature. Default `gemini-3.8-flash`, model id editable. Because tool schemas are app-authored and already Gemini-safe, **no schema sanitizer is needed**. |

Because the three tool definitions are written by us (flat objects, string/number/enum only, `additionalProperties:false`,
no `$ref`, no type arrays), the biggest cross-provider risk in the research - sanitizing arbitrary MCP JSON Schemas for
Gemini, Claude strict mode and the `gemma4.jinja` type-array crash - disappears.

---

## 4. How MCP calendar tools reach the LLM, and how WRITE is gated

### 4.1 MCP host (`src/main/mcp/host.ts`)

- `StdioClientTransport({ command: process.execPath, args:[<resources>/calendar-mcp/node_modules/@cocal/google-calendar-mcp/build/index.js,
  'start','--transport','stdio'], env:{...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE:'1', GOOGLE_OAUTH_CREDENTIALS,
  GOOGLE_CALENDAR_MCP_TOKEN_PATH, GOOGLE_ACCOUNT_MODE:'personal', ENABLED_TOOLS}, cwd:<mcpRoot>, stderr:'pipe' })`.
- `ENABLED_TOOLS = list-calendars,list-events,get-freebusy,create-event,manage-accounts` - five tools. `delete-event`,
  `update-event`, `create-events`, `respond-to-event`, `search-events`, `get-event`, `list-colors`, `get-current-time`
  are **not even enabled in the server**. "Delete my calendar" is impossible through this app regardless of bugs.
- On connect, `listTools()` must return exactly those five names, else fail closed (calendar = "error", nothing exposed).
- The module exports three narrow functions and **not** the client:

  ```ts
  export function callRead(name: 'get-freebusy'|'list-events', args: PinnedReadArgs): Promise<Projected>;   // used by the triage loop
  export function callWrite(name: 'create-event', args: CreateEventArgs): Promise<CreatedEvent>;            // imported ONLY by agent/executor.ts
  export function callAdmin(name: 'manage-accounts'|'list-calendars', args: unknown): Promise<unknown>;     // imported ONLY by google wizard/settings
  ```

### 4.2 What the active LLM sees (identical for Local / Claude / Gemini)

```ts
// src/main/agent/tools.ts  - compile-time constant, app-authored descriptions
calendar_get_freebusy { timeMin: string(ISO local), timeMax: string(ISO local) }   -> MCP get-freebusy
calendar_list_events  { timeMin, timeMax }                                         -> MCP list-events   (only if settings.calendar.shareTitles)
submit_triage         { ...TriageResult }                                          -> virtual, no side effect, ends the run
```

This satisfies the locked requirement: the app is the MCP host, and the active LLM reaches Google Calendar **only**
through MCP tool calls that it decides to make. The tool *definitions* are ours (defeats tool-description poisoning and
schema incompatibilities); the *execution* is a real MCP `tools/call`.

### 4.3 The loop (`src/main/agent/loop.ts`, ~120 lines, provider-agnostic)

```
turn 1: tools=[freebusy,(list_events),submit_triage], toolChoice='auto'
  model calls calendar_*  -> gate: name in READ table? per-run call budget (3)? -> pin args:
        calendarId = settings.calendar.id (never model-chosen), account='personal',
        window clamped to [now, now+60d], length <= 14d, timeZone = settings
     -> mcp.callRead -> PROJECT result to [{start,end,title?<=60 chars sanitized}] -> nonce-wrapped tool result
  model calls submit_triage -> validate -> DONE
  model calls anything else -> synthetic {"error":"tool not available"}, audit row; 2 strikes -> abort, flag suspicious
turn 2..3: same. Last allowed turn (turn 3, or as soon as a calendar tool was used twice):
        tools=[submit_triage], toolChoice={force:'submit_triage'}
no submit_triage at the end -> one nudge ("Call submit_triage now") -> else item info_missing/unparsed
limits: 3 model turns (+1 nudge), 3 tool calls, 60 s cloud / 240 s local wall clock, 1024 output tokens
never execute tool calls from a max_tokens or refusal turn
```

If the calendar is not connected, the calendar tools are simply not offered and triage still works (drafts only).

Conflict awareness is therefore LLM-driven (it may ask for free/busy and write "I'm busy at 5, how about 6?"), while
the **write** path never involves the model: the approve-click handler calls `executor.createEvent`, which calls
`mcp.callWrite`. There is no code path from `loop.ts` to `callWrite` (lint rule + import-graph test + a security test
that scripts a stub LLM to emit `create-event` and asserts a blocked-call audit row and zero MCP write calls).

---

## 5. App SQLite schema (`<userData>\app.db`, `node:sqlite`, WAL, `foreign_keys=ON`)

Six tables. Message bodies are **not** copied into the app DB (the bridge DB is the source; items keep a 200-char
snippet for the card). Migrations = ordered SQL strings in `db/migrations.ts` driven by `PRAGMA user_version`.

```sql
CREATE TABLE kv (                       -- settings + runtime state, JSON values, zod-validated on read
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);  -- keys: settings, bridge_rowid_watermark, activation_ts, paired_at, consent.claude, consent.gemini,
    --       ratelimit.*, llama.force_cpu, onboarding.step, model.active

CREATE TABLE secrets (                  -- safeStorage (DPAPI) ciphertext only
  name TEXT PRIMARY KEY,                -- 'anthropic_api_key' | 'gemini_api_key'
  blob BLOB NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE chats (
  jid TEXT PRIMARY KEY, name TEXT, lang TEXT,               -- 'he'|'en'
  muted INTEGER NOT NULL DEFAULT 0,
  last_in_ts INTEGER, last_out_ts INTEGER, last_triaged_msg_id TEXT
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  chat_jid TEXT NOT NULL REFERENCES chats(jid),
  state TEXT NOT NULL CHECK (state IN ('needs_reply','info_missing','in_calendar','ignored')),  -- = deriveState(), stored for indexing
  revision INTEGER NOT NULL DEFAULT 1,
  intent TEXT NOT NULL, needs_reply INTEGER NOT NULL,
  trigger_msg_id TEXT NOT NULL, trigger_ts INTEGER NOT NULL, snippet TEXT NOT NULL,
  event_json TEXT,                       -- {title,date,time,durationMin,location,dateText} (user-editable)
  missing_json TEXT NOT NULL DEFAULT '[]',
  draft_reply TEXT, draft_edited INTEGER NOT NULL DEFAULT 0, reply_lang TEXT NOT NULL,
  reply_status TEXT NOT NULL DEFAULT 'none'  CHECK (reply_status IN ('none','draft','sent')),
  event_status TEXT NOT NULL DEFAULT 'none'  CHECK (event_status IN ('none','proposed','created')),
  calendar_event_id TEXT, calendar_html_link TEXT, event_start_ts INTEGER,
  flags_json TEXT NOT NULL DEFAULT '{}', -- suspicious, unparsed, linkRemoved, personalDetails, newMessages
  closed_reason TEXT,                    -- dismissed|answered_elsewhere|superseded|expired|not_relevant
  provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX items_open_per_chat ON items(chat_jid) WHERE state IN ('needs_reply','info_missing');
CREATE INDEX items_state_updated ON items(state, updated_at DESC);

CREATE TABLE triage_queue (
  chat_jid TEXT PRIMARY KEY, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
);

CREATE TABLE actions (                  -- append-only audit of executed side effects + security events
  id INTEGER PRIMARY KEY, item_id INTEGER, kind TEXT NOT NULL,  -- send_reply|create_event|tool_blocked|consent
  content_sha256 TEXT, result TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL
);
```

Dashboard queries are `SELECT ... FROM items WHERE state=? ORDER BY updated_at DESC LIMIT 20` (x3); "In calendar" also
filters `event_start_ts >= now-1d` so past events fall off.

---

## 6. IPC surface

One `invoke` function, one event stream. Contract lives in `src/shared/ipc.ts` as a single map
`channel -> { req: zodSchema, res: zodSchema }`; preload allow-list and main router are generated from that map.
Every handler checks `event.senderFrame.url` starts with `app://` and zod-parses the request.

| Channel | Purpose |
|---|---|
| `app:snapshot` | `{status:{bridge,calendar,llm,queueDepth,paused}, lists:{needsReply[],infoMissing[],inCalendar[]}, settings(public), onboarding}` - the renderer's single bootstrap call |
| `items:get` | full item for the detail card (incl. last 12 messages read live from the bridge DB) |
| `items:saveDraft` | `{id, revision, draftReply}` |
| `items:saveEvent` | `{id, revision, event}` (user edits / fills missing info; re-runs `validate` + `deriveState`) |
| `items:approveReply` | `{id, revision, text}` -> executor.sendReply |
| `items:approveEvent` | `{id, revision, event, allowDuplicate?}` -> executor.createEvent |
| `items:dismiss` / `items:restore` / `items:retriage` | close, undo, re-run the LLM |
| `chats:mute` | `{jid, muted}` |
| `settings:get` / `settings:set` | patch, zod-validated; language change also rebuilds tray |
| `secrets:set` / `secrets:clear` | `{provider, key}`; returns only `{ok, reason?}` after `provider.validate()`; keys never travel back |
| `consent:accept` | `{provider, version}` - required before a cloud provider can be activated |
| `llm:test` | validate the active provider end-to-end with a canned Hebrew sample |
| `model:plan` / `model:download` / `model:cancel` / `model:delete` | hardware tier + manifest entry; start/cancel the GGUF download |
| `bridge:pairing` / `bridge:newCode` / `bridge:unlink` | `{state, qrDataUrl?, expiresAt?}`; respawn for a fresh QR; stop + delete `store\whatsapp.db` + respawn |
| `google:importCreds` / `google:connect` / `google:status` / `google:disconnect` / `google:calendars` | wizard + settings; `importCreds` opens the native file dialog **in main** (renderer never supplies a path) |
| `app:openLink` | `{linkId}` - ids into a static table of external URLs (Cloud console, AI Studio, Anthropic console); never a raw URL |
| `app:pause` | pause/resume triage |

Events (main -> renderer, one channel `evt`, discriminated union): `status`, `itemsChanged`, `pairing`, `modelProgress`,
`languageChanged`, `toast`. The renderer reacts to `itemsChanged` by re-invoking `app:snapshot` - no client-side cache
to keep coherent, hence no store library.

---

## 7. Onboarding flow (single wizard view, resumable, `kv.onboarding.step`)

| Step | Screen | Main-process work |
|---|---|---|
| 1 | Language (He/En, default from `app.getPreferredSystemLanguages()`) + plain-language disclosure: unofficial WhatsApp client / ban risk, approval-first promise, what stays local | store language + `consent.tos` |
| 2 | Choose the brain: **Local (private, default)** / Claude / Gemini. Local: show detected tier, file size, free disk, **Download** with progress/ETA/cancel/resume - runs in the background while the user continues. Cloud: blocking versioned consent (Gemini free-tier training warning), paste key, validated live | `hardware.detect()`, `modelDownload.start()`; or `secrets:set` |
| 3 | Link WhatsApp: QR image, 3-line instruction ("Linked devices -> Link a device"), needs one free linked-device slot. States: connecting / qr / connected / timeout ("Show new code") / error | spawn bridge; poll `/api/pairing/status` every 1.5 s; fetch `qr.png` on `expires_at` change; on `connected` set `paired_at` and `activation_ts = now` |
| 4 | Connect Google Calendar (skippable, can be done later from Settings): the 5-step guided wizard from `calendar-mcp.md` section 6.3, steering to "External + Publish app"; Browse for the client JSON -> validate (`installed` key etc.) -> write to `<userData>\google\` -> spawn MCP -> `manage-accounts add` -> `shell.openExternal(auth_url)` -> poll `list` every 2 s up to 5 min -> pick calendar from `list-calendars` | `google:*` handlers |
| 5 | Done: "Closing the window keeps the app running in the hidden-icons area of the taskbar" (with a picture), autostart toggle (default off) | show dashboard |

The dashboard works in a degraded, clearly labelled mode whenever a step is incomplete (no model yet -> items queue up;
no Google -> drafts only, "Add to calendar" disabled with a "Connect" link).

---

## 8. Settings (one page, one zod schema, stored as one JSON value in `kv.settings`)

```ts
export const Settings = z.object({
  ui:       z.object({ language: z.enum(['system','en','he']), autostart: z.boolean(), notifications: z.boolean() }),
  llm:      z.object({ provider: z.enum(['local','claude','gemini']),
                       claudeModel: z.string(), geminiModel: z.string(),
                       local: z.object({ modelId: z.string().nullable(), acceleration: z.enum(['auto','off']) }) }),
  calendar: z.object({ id: z.string(), defaultDurationMin: z.number().int(), shareTitles: z.boolean() }),
  agent:    z.object({ paused: z.boolean(), timeZone: z.string(), lookbackHoursOnPair: z.number().int().min(0).max(72),
                       mediaRetentionDays: z.number().int(), userGender: z.enum(['m','f','unspecified']) }),
}).strict();
```

Sections on the page: General (language, autostart, notifications) - AI engine (three radio cards; Local shows model,
size, delete/re-download, acceleration Auto/Off; cloud cards show key status, model dropdown, data-leaves-device note) -
WhatsApp (status, linked since, Unlink, muted chats) - Google Calendar (account, calendar picker, Reconnect, Disconnect,
"share event titles with the AI" off by default) - Privacy & data (open data folder, export diagnostics with redaction,
delete all app data).

---

## 9. Tray lifecycle (Windows 11)

- `app.requestSingleInstanceLock()`; second instance -> show + focus the existing window. `app.setAppUserModelId(appId)`.
- Window `close` event: if `!isQuitting` -> `preventDefault(); win.hide()`. First time only: a toast "Still running in
  the hidden icons area". Windows 11 puts new tray icons in the overflow automatically - that *is* the requested
  behaviour; no Tray GUID in v1 (unsigned exe).
- Tray: left click / double click = show window. Context menu (rebuilt on language change from the main-process i18next
  instance): Open - Pause/Resume agent - separator - **Quit**. Tooltip shows counts ("2 need reply"); three icons:
  normal / attention (open items) / paused-or-error.
- **Quit** is the only real exit: `isQuitting = true` -> stop queue -> abort in-flight LLM call -> `supervisor.stopAll()`
  (child.kill, then `taskkill /PID <pid> /T /F` after 2 s, by PID only, never by image name) -> close DBs -> `app.quit()`.
- `session-end` (Windows shutdown/logoff) runs the same synchronous kill. Orphans from a hard crash are reaped at next
  start from `<userData>\run\*.pid.json` (`{pid, exePath, startedAt}`; kill only if the live process image path equals
  our bundled exe path - the user's other live bridge has a different path and is never touched).
- Autostart: `setLoginItemSettings({openAtLogin, args:['--hidden']})` only when packaged; `--hidden` skips `win.show()`.

---

## 10. Error / restart strategy

One `Supervisor` (Electron-free, unit-testable with a fake child): `spawn(shell:false, windowsHide:true)`, readiness
probe, backoff restart, circuit breaker, stdout line reader through the **redacting logger** (bridge stdout contains
message bodies and phone numbers: only whitelisted line patterns are logged - connection state, "REST API server error",
"Client outdated", "logged out" - everything else is dropped).

| Child | Pre-spawn guards | Ready when | On exit / unhealthy | Breaker |
|---|---|---|---|---|
| bridge | sha256 of exe == pinned `AC23221E...2FF5`; cwd resolved inside `userData`; all five env vars set (`WHATSAPP_BRIDGE_PORT` free ephemeral, `WHATSAPP_BRIDGE_TOKEN` 64-hex per launch, `WEBHOOK_URL` = our doorbell, `FORWARD_SELF=true`, `WHATSAPP_MEDIA_ROOTS=<userData>\bridge\outbox`); minimal env otherwise; refuse to spawn if any guard fails | `/api/pairing/status` answers 200 **to our token** within 10 s (401/timeout = port stolen or REST bind failed -> kill, new port) | any exit (code is always 0) and not quitting -> respawn 2 s, 5 s, 15 s, 60 s; `/api/health` 503 for 10 min -> respawn; status `error`+"logged out" -> delete `store\whatsapp.db` only -> respawn -> pairing; stdout "Client outdated" -> terminal state "bridge needs update", no respawn loop | 5 exits / 10 min -> stop, red status, manual "Restart" |
| MCP | creds file exists; entry JS exists | `listTools()` == the 5 expected names | `transport.onclose` -> respawn 2 s, 10 s, 60 s; auth errors (`invalid_grant`) are **not** restarts -> status "reconnect Google" | 3 / 10 min |
| llama-server | GGUF size + sha256 verified flag in `kv`; free RAM sanity check | `/health` 200 (<= 180 s) then a 1-prompt self-test ("reply with OK") | exit before ready or garbage self-test and acceleration=auto -> retry once with `--device none`, persist `llama.force_cpu`; otherwise backoff | 3 / 10 min -> "Local model failed" with actions: switch to CPU / re-download / choose cloud |

Other failure policies:
- **LLM call fails**: queue row `attempts+1`, retry at +1 min, +5 min, +30 min, then park with an "AI unavailable" banner.
  Quota/spend-cap/bad-key errors park immediately (no retry storm) and name the fix.
- **Doorbell missed / app was closed**: next `scan()` picks rows up by watermark; rows older than
  `now - lookbackHoursOnPair` at app start are auto-ignored so a week-old message does not pop up as urgent.
- **Bridge DB locked/missing**: scan returns, retried by the 30 s timer.
- **Stale approval** (item changed since render): rejected by `revision` check; UI refreshes; nothing is sent.
- **safeStorage decrypt failure**: treated as "key missing".
- **Janitor** (hourly): delete media files under `<userData>\bridge\store\<jid>\` older than `mediaRetentionDays`
  (never `*.db`, never dot-files); expire open items > 7 days; trim `actions` > 90 days.

---

## 11. Packaging layout

electron-builder 26.15.3, NSIS `oneClick`, `perMachine:false`, x64 only, `asar:true`, **`npmRebuild:false`, no
`asarUnpack`**, no auto-updater in v1, unsigned in v1.

```yaml
extraResources:
  - { from: resources/bridge,            to: bridge,       filter: ["whatsapp-bridge.exe","LICENSE","SHA256SUMS"] }
  - { from: vendor/llama/win-x64-vulkan, to: llama,        filter: ["llama-server.exe","*.dll","LICENSE*"] }
  - { from: build-resources/calendar-mcp, to: calendar-mcp }
  - { from: resources/icons,             to: icons }
electronFuses:
  runAsNode: true                     # REQUIRED by the MCP stdio child (D9) - do not "harden" this off
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  onlyLoadAppFromAsar: true
  enableCookieEncryption: true
  grantFileProtocolExtraPrivileges: false     # renderer is on app://
  enableEmbeddedAsarIntegrityValidation: false # UNVERIFIED on Windows with this builder version; revisit after v1
```

Installed tree:

```
%LOCALAPPDATA%\Programs\WhatsApp Calendar Agent\
  WhatsApp Calendar Agent.exe
  resources\app.asar                       # main + preload + renderer + 5 pure-JS deps
  resources\bridge\whatsapp-bridge.exe     # exact user build, hash-pinned; LICENSE (MIT)
  resources\llama\llama-server.exe + ggml*.dll, llama*.dll ...   # b10964 Vulkan zip, allow-listed
  resources\calendar-mcp\node_modules\@cocal\google-calendar-mcp\...   # isolated npm install --omit=dev --ignore-scripts
  resources\icons\tray*.ico
%APPDATA%\WhatsApp Calendar Agent\          # userData - survives uninstall (deleteAppDataOnUninstall:false)
  app.db  logs\  run\*.pid.json
  bridge\   (bridge cwd)  store\whatsapp.db  store\messages.db  store\<jid>\media  outbox\ (always empty)
  google\   gcp-oauth.keys.json  tokens.json
  models\   <file>.gguf  <file>.gguf.part
```

Build-time fetch scripts (run once by a build agent, outputs git-ignored except hashes):
- `scripts/fetch-llama.mjs`: download the pinned zip, verify sha256 `1ee3ad95...c642`, unzip, keep the allow-list.
- `scripts/fetch-calendar-mcp.mjs`: `npm install --prefix build-resources/calendar-mcp --omit=dev --ignore-scripts @cocal/google-calendar-mcp@2.6.3`.
- `scripts/hash-bridge.mjs`: compute the sha256 of `resources/bridge/whatsapp-bridge.exe` and compare with the pinned
  constant. **The exe is copied into `resources/bridge/` by the user (or an explicitly user-approved step) - it is never
  executed by build or test agents, and nothing else is read from that folder except Go source.**
- `scripts/pin-models.mjs`: resolve HF commit + `lfs.sha256` + size for each manifest entry and write
  `src/main/llm/local/manifest.ts`.

Model manifest (one family = one prompt style; user can override tier in Settings):

| Tier | Rule (first match) | File |
|---|---|---|
| mid | discrete GPU (NVIDIA / Radeon RX / Arc discrete from `--list-devices` + `app.getGPUInfo`) with >= 7.5 GiB VRAM and RAM >= 15 GB; or no dGPU and RAM >= 30 GB; and free disk >= 12 GB | `unsloth/gemma-4-12B-it-qat-GGUF` `gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` (6.72 GB) |
| small | RAM >= 12 GB | `unsloth/gemma-4-E4B-it-GGUF` `gemma-4-E4B-it-Q4_K_M.gguf` (4,977,171,584 B, sha256 `85a896a0...ab87`) |
| tiny | otherwise | `unsloth/gemma-4-E2B-it-GGUF` `gemma-4-E2B-it-Q4_K_M.gguf` (3.11 GB) |

Integrated-GPU shared memory is never counted as VRAM. Downloader: own ~150 lines - `fetch` with `Range` to `.part`,
always re-request the `resolve/<commit>/` URL (signed CDN redirects expire), streaming sha256, atomic rename, progress
events at 4 Hz. After load, a micro-benchmark; below 5 tok/s the UI *suggests* a smaller tier (never automatic).

---

## 12. Directory structure and parallel-build ownership

```
C:\dev\whatsapp agent\
  package.json  electron.vite.config.ts  electron-builder.yml  tsconfig*.json  vitest.config.ts  playwright.config.ts  eslint.config.js
  build\icon.ico
  resources\bridge\  resources\icons\
  vendor\whatsapp-bridge-src\   (Go source, reference only)      vendor\llama\  build-resources\   (fetched, git-ignored)
  scripts\  fetch-llama.mjs  fetch-calendar-mcp.mjs  hash-bridge.mjs  pin-models.mjs  make-icons.mjs
  src\
    shared\        ipc.ts  types.ts  settings.ts  triage.ts  locales\en.json  locales\he.json  i18n\{languages,format}.ts
    main\
      index.ts  paths.ts  logger.ts  secrets.ts  window.ts  tray.ts  protocol.ts  i18n.ts  janitor.ts
      db\          index.ts  migrations.ts  items.ts  chats.ts  kv.ts  queue.ts  actions.ts
      proc\        supervisor.ts  reaper.ts  freePort.ts
      bridge\      launcher.ts  client.ts  doorbell.ts  bridgeDb.ts  pairing.ts
      mcp\         host.ts  google.ts                      # google.ts = wizard/account admin
      llm\         provider.ts  claude.ts  gemini.ts  local.ts  local\{runtime,hardware,download,manifest}.ts
      agent\       ingest.ts  prompt.ts  tools.ts  loop.ts  validate.ts  state.ts  executor.ts  dates.ts  sanitize.ts  ratelimit.ts
      ipc\         router.ts  handlers\{app,items,settings,secrets,model,bridge,google}.ts
    preload\index.ts
    renderer\      index.html  main.tsx  App.tsx  api.ts  i18n.ts  base.css
                   views\{Dashboard,Settings,Onboarding}.tsx
                   components\{ItemList,ItemCard,EventCard,DraftBox,StatusBar,QrPairing,ModelDownload,GoogleWizard,ConsentDialog}.tsx (+ .module.css each)
  tests\  fakes\{fakeBridge.ts, fakeMcpServer.ts, stubProvider.ts}  unit\  e2e\  golden\he-en-triage.jsonl
```

**Wave 0 (one agent, blocks everyone, ~1 hour): scaffold + freeze the contracts** - `package.json` with exact pins,
configs, `src/shared/*`, `llm/provider.ts`, `db/migrations.ts`, the exported signatures of `mcp/host.ts`,
`bridge/client.ts`, `proc/supervisor.ts`, and the three fakes' interfaces. After that, 14 agents work in disjoint
folders against interfaces and fakes:

| # | Owner of | Tested against |
|---|---|---|
| 1 | `proc/*` | fake child script |
| 2 | `bridge/launcher,client,pairing,doorbell` | `fakeBridge` (Node http server; **never the real exe**) |
| 3 | `bridge/bridgeDb` + `agent/ingest` | a `node:sqlite` fixture DB created with the schema from `bridge-contract.md` section 6 |
| 4 | `db/*` | in-memory sqlite |
| 5 | `mcp/host` + `mcp/google` | `fakeMcpServer` over the SDK's `InMemoryTransport`; plus the real server with dummy creds for `tools/list` only |
| 6 | `llm/claude` | recorded fixtures, no key |
| 7 | `llm/gemini` | recorded fixtures, no key |
| 8 | `llm/local/*` + `scripts/fetch-llama`, `pin-models` | fake OpenAI-compatible server; real llama-server smoke is a manual step |
| 9 | `agent/prompt,tools,loop,validate,state,dates,sanitize` + `tests/golden` | `stubProvider` |
| 10 | `agent/executor,ratelimit` + `ipc/handlers/items` + security tests | fakes |
| 11 | `main/index,window,tray,protocol,i18n,janitor,secrets,logger` | electron mock |
| 12 | `ipc/router`, remaining handlers, `preload` | contract tests generated from `shared/ipc.ts` |
| 13 | renderer Dashboard + components + both locales | jsdom, RTL snapshot tests |
| 14 | renderer Onboarding + Settings + GoogleWizard + ConsentDialog | jsdom |
| 15 | packaging (`electron-builder.yml`, fuses, scripts) + Playwright e2e on the unpackaged build with all fakes (`WCA_FAKES=1`) + packaged smoke: MCP `initialize` through `process.execPath` to prove the runAsNode fuse is alive | - |

---

## 13. Honest weaknesses of this proposal

1. **`runAsNode` fuse stays enabled.** The security report lists "RunAsNode off" as recommended hardening. With it on,
   same-user malware can run arbitrary JS under our signed-looking exe identity. I accept this because same-user malware
   can already read `whatsapp.db` and DPAPI secrets, and both alternatives (unauthenticated localhost HTTP MCP, or an
   unproven custom transport) are worse for a 15-agent build. It must be guarded by the packaged smoke test, or a
   well-meaning agent will turn it off and the MCP spawn will silently open a second GUI instance.
2. **The LLM sees only 2 of the server's read tools, with app-authored schemas.** This is a narrow reading of "expose
   the MCP server's calendar tools to the LLM". It is deliberate (small-model reliability, injection surface, no schema
   sanitizer), but a reviewer may call it too thin; `search-events`/`get-event` can be added to the constant table
   later at the cost of per-provider schema testing.
3. **No update/delete of events in v1.** Reschedule and cancel requests produce a draft and a link, and the user edits
   Google Calendar by hand. Simple and safe, but a visible product gap for a "scheduling assistant".
4. **Tool calling on a ~4B local model is the shakiest part.** The research recommends grammar-constrained JSON rather
   than template tool-call parsers; I chose the tool path for one shared loop. Mitigations: forced single-tool final turn
   (llama-server grammar-constrains `tool_choice:"required"` - UNVERIFIED for Gemma 4 on b10964), one nudge retry,
   strict zod, fall to `info_missing/unparsed`. If the golden-set bake-off shows < ~85% valid submissions, the fallback
   is a Local-only final turn using `response_format: json_schema` - a contained change inside `local.ts` + `loop.ts`,
   but it would break the "one mechanism" purity.
5. **Forced `tool_choice` is not uniformly available** (rejected on `claude-fable-5-1`; interaction with adaptive
   thinking on Opus 5/Sonnet 5 is UNVERIFIED). The adapter degrades to `auto` + nudge; worst case costs an extra turn.
6. **Rowid-watermark ingestion depends on bridge internals** (`ON CONFLICT DO UPDATE`, rowid table, write-before-webhook
   ordering). Verified in today's `main.go`, but a future bridge binary could change it. Edited messages (same rowid)
   are not re-seen - acceptable. The timestamp text format is UNVERIFIED until the first supervised run; the parser is
   defensive and a parse failure drops the row with a counter surfaced in diagnostics rather than mis-triaging it.
7. **Everything in the main process.** A pathological synchronous query, a 20 MB doorbell body being drained, or sha256
   of a 43 MB exe before each spawn (~100 ms) runs on the UI-owning thread of main. Tray/menu could hitch. Mitigation is
   discipline (indexed queries, streaming hash), not isolation.
8. **One open item per chat** loses information when a contact raises two separate plans in one burst; the model is asked
   for the most actionable one. Re-triage overwrites unedited drafts, which may surprise a user who was reading one.
9. **No message mirror in the app DB**: item detail reads the bridge DB live. If the user unlinks/relinks and the bridge
   store is reset, old cards lose their transcript (they keep the 200-char snippet).
10. **Plain CSS and no state library** puts more burden on two renderer agents to stay consistent; there is no design
    system. Acceptable for three lists, but the UI will look plainer than a Tailwind/shadcn build.
11. **Own GGUF downloader and own redacting logger** are two pieces of hand-written infrastructure where libraries exist
    (`ipull`, `electron-log`). They are small, but they are ours to debug (resume edge cases, signed-URL expiry).
12. **`googleapis` bloat (~200 MB unpacked, thousands of files)** ships as-is inside `resources\calendar-mcp`; install and
    uninstall will be slow. Not optimized in v1 on purpose (the esbuild re-bundle is UNVERIFIED).
13. **Vulkan-only acceleration**; no CUDA pack. NVIDIA laptops run slower than they could. iGPU Vulkan bugs are handled
    only by a self-test + CPU fallback.
14. **ASAR integrity validation is off and nothing is code-signed** in v1: SmartScreen warnings, possible Defender
    quarantine of the two bundled exes, and no tamper detection of `app.asar` (only the bridge exe is hash-pinned).
15. **Unfixable-by-us dependencies remain**: the bridge is an opaque prebuilt binary that will eventually hit
    "Client outdated" (Go is not installed; v1 only detects and explains it), and Google onboarding still requires the
    user to create their own Cloud project (about 5 minutes, "unverified app" warning).
16. **UNVERIFIED items this design leans on** (need the first supervised run): bridge exe answers `/api/pairing/status`;
    `messages.db` timestamp format; llama-server b10964 file list, VC++ runtime need, `--list-devices` output format,
    Hebrew/space-containing model paths; `manage-accounts` stays registered under `ENABLED_TOOLS`; electron-builder/NSIS
    on a project path containing a space.
