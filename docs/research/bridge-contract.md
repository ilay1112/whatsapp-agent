# WhatsApp Bridge - Integration Contract (for the Electron host)

Research date: 2026-09-21. Author: research agent "bridge-contract".

Everything below was derived from reading the Go SOURCE only, plus a static (non-executing) string scan of the prebuilt exe. The exe was never run, the `store` directory was never opened, and no WhatsApp connection was made. Anything not provable from source is marked **UNVERIFIED**.

Process note: one initial file-glob of the bridge folder was not scoped to `*.go` and returned file NAMES (not contents) from `store\`. Nothing there was opened or read. All later access was limited to named source files.

## 0. Provenance

| Item | Value |
|---|---|
| Source dir (read-only reference) | `C:\Users\ilay1\Documents\minime\whatsapp-mcp\whatsapp-bridge` |
| Upstream | https://github.com/verygoodplugins/whatsapp-mcp (fork of https://github.com/lharries/whatsapp-mcp), MIT. `LICENSE` header: "Original work Copyright (c) 2025 Luke Harries / Modifications Copyright (c) 2026 Very Good Plugins". Ship this LICENSE text with the app. |
| Upstream version in checkout | `CHANGELOG.md` top entry: 0.4.1 (2026-06-26) |
| Go module | `module whatsapp-client`, `go 1.25.0` (go.mod) |
| Key deps (go.mod) | `go.mau.fi/whatsmeow v0.0.0-20260604205742-c6a4b703e48f`, `github.com/mattn/go-sqlite3 v1.14.45` (CGO), `github.com/mdp/qrterminal v1.0.1`, `rsc.io/qr v0.2.0`, `google.golang.org/protobuf v1.36.11` |
| Prebuilt exe | `whatsapp-bridge.exe`, 43,540,541 bytes, mtime 2026-07-12 10:23:10, SHA-256 `AC23221E8BCF3937A4CA346B3BD80A8DA09DF94CBECD949AF2916C4BC8D22FF5` |
| Exe embedded build info (static scan) | `go1.26.5`, `GOOS=windows GOARCH=amd64 CGO_ENABLED=1`, `vcs.revision=e5f1a9aef5c78198ad27d52d40d4513d3b7e0e2f`, `vcs.time=2026-07-08T19:15:06Z`, **`vcs.modified=true`**, deps match go.mod |

**The local source is NOT pure upstream.** It carries local, uncommitted additions (`vcs.modified=true`): `pairing_status.go` (`/api/pairing/status`, `/api/pairing/qr.png`), `group_status.go` (`/api/group/status`), `group_participant_count.go` (`/api/group/participant-count`), `media_serve.go` (`/api/media`), and the REST server being started BEFORE pairing. The upstream README does not document the pairing endpoints (checked on github.com 2026-09-21). The static scan confirmed every route string below is present in `whatsapp-bridge.exe`, and the exe mtime is 28 s after the last `main.go` edit, so exe == this source with high confidence (not provable without Go / execution: **UNVERIFIED** at byte level).

Consequence: "exactly this bridge" means **ship this exact exe (pin by SHA-256 above)**. A rebuild from upstream GitHub would lack the pairing/QR endpoints the GUI depends on. Vendor the local `*.go`, `go.mod`, `go.sum` for reference. Sibling files `whatsapp-bridge-perf-test.exe`, `whatsapp-client.exe`, `*.bak-*` are NOT the contract - ignore them.

## 1. Launch contract

### 1.1 Store location: cwd-relative, hard-coded (most important fact)

There is NO flag and NO env var for the store path. Every path is a relative literal resolved against the process **current working directory**:

| Literal in source | Purpose |
|---|---|
| `os.MkdirAll("store", 0755)` | created on start (main.go: `NewMessageStore`, `main`) |
| `file:store/whatsapp.db?_foreign_keys=on` | whatsmeow session/keys/contacts/LID map (`sqlstore.New`) |
| `file:store/messages.db?_foreign_keys=on` | app message archive |
| `store/.bridge-token` | bearer token file (auth.go `tokenFilePath`) |
| `store/<chatJID with ':' -> '_'>/<file>` | downloaded media cache (`downloadMedia`) |

So to get a fresh independent store: **spawn with `cwd = <userData>\bridge`**; the bridge creates `<userData>\bridge\store\...` itself. The exe can live anywhere (e.g. `process.resourcesPath\bridge\whatsapp-bridge.exe`); it never resolves anything relative to its own location. Never set cwd to the original bridge folder.

```ts
spawn(exePath, [], {
  cwd: path.join(app.getPath('userData'), 'bridge'),   // must exist before spawn
  env: { ...minimalEnv, WHATSAPP_BRIDGE_PORT, WHATSAPP_BRIDGE_TOKEN, WEBHOOK_URL, FORWARD_SELF, WHATSAPP_MEDIA_ROOTS },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

### 1.2 Environment variables (complete list read by the Go code)

| Var | Default | Semantics |
|---|---|---|
| `WHATSAPP_BRIDGE_PORT` | `8080` | int 1-65535; invalid -> logs `Invalid WHATSAPP_BRIDGE_PORT=...` and the process EXITS (code 0). |
| `WHATSAPP_BRIDGE_TOKEN` | unset | If set (trimmed) it always wins; must be >= 16 chars or the process exits (`WHATSAPP_BRIDGE_TOKEN is too short`). When set, **no token file is written or read**. |
| `WEBHOOK_URL` | `http://localhost:8769/whatsapp/webhook` | Read on EVERY webhook send (`os.Getenv` inside `sendWebhookPayload`). If unset the bridge still POSTs to the default URL (without token header). There is no way to disable webhooks. |
| `FORWARD_SELF` | **`true`** in code (note `.env.example` shows `false`) | Parsed once at process start. Accepts 1/true/yes/on, 0/false/no/off (case-insensitive); anything else -> default. |
| `WHATSAPP_MEDIA_ROOTS` | `%USERPROFILE%\.local\share\whatsapp-mcp\outbox` | Allowed roots for `/api/send` `media_path`. Separator is `os.PathListSeparator` = **`;` on Windows** (docs say colon - that is Unix). Entries must be absolute. If UNSET, the bridge **creates the default outbox dir under the user's home at startup** - a side effect outside userData and shared with the user's first instance. Always set it (e.g. `<userData>\bridge\outbox`, create the dir before spawn so it canonicalizes). |

Env vars `WHATSAPP_DB_PATH`, `WHATSMEOW_DB_PATH`, `WHATSAPP_API_URL`, `WHATSAPP_MCP_*` in `.env.example` belong to the Python MCP server, not the bridge. The bridge does not load `.env` files.

### 1.3 CLI flags

| Flag | Default | Semantics |
|---|---|---|
| `--full-history-pair` | false | Sets `DeviceProps.RequireFullSync=true`, `FullSyncDaysLimit=3650`, size/quota 102400 MB. Only effective on a fresh pair. Do NOT use for this app (huge sync, all message bodies logged to stdout). |

No other flags. No stdin commands are read (the "Type 'help' for commands" line is vestigial).

### 1.4 Bind address / port

`127.0.0.1:<port>` only (IPv4 loopback; `[::1]` is NOT listened on even though it is in the Host allow-list). Timeouts: Read 30 s, Write 60 s, Idle 120 s. If the port is taken the bridge only prints `REST API server error: ...` and **keeps running without REST** - the host must detect this (health poll never succeeds / stdout line) and respawn on another port. Pick a free port in the host first (listen on 0, close, pass it) and never use 8080 (the user's first instance).

## 2. Authentication

Every route is wrapped by `withAuth` (auth.go), in this order:

1. **Host allow-list** -> else `403` body `Forbidden: host not allowed`. Exact, case-insensitive match of the `Host` header against `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`. Use base URL `http://127.0.0.1:<port>` from Node (avoid `localhost`: Node may resolve it to ::1 which is not bound).
2. **Bearer token** -> else `401` body `Unauthorized`, header `WWW-Authenticate: Bearer realm="whatsapp-bridge"`. Header must be exactly `Authorization: Bearer <token>` (case-sensitive `Bearer ` prefix), constant-time compare.

Token resolution (`loadOrCreateBridgeToken`): env `WHATSAPP_BRIDGE_TOKEN` -> else contents of `store/.bridge-token` (trimmed) -> else generate 32 random bytes, hex-encode (64 chars), write `store/.bridge-token` (+`\n`, mode 0600 - meaningless on NTFS) and print a banner containing the token to stdout.

**Recommendation:** the host generates `crypto.randomBytes(32).toString('hex')` per launch (or stores one via Electron `safeStorage`) and injects it via `WHATSAPP_BRIDGE_TOKEN`. Result: no token on disk, no token banner in stdout, and the host already knows the value. The same token arrives back on webhooks as `X-Bridge-Token`.

`<img src>` cannot send an Authorization header, so the renderer cannot load `/api/pairing/qr.png` directly: fetch it in the main process and hand the renderer a data URL / IPC buffer. Never expose the token to the renderer.

## 3. REST endpoints (all under `http://127.0.0.1:<port>`)

Common: 403/401 as in section 2. Plain-text error bodies come from `http.Error` (`text/plain; charset=utf-8`, trailing newline). `net/http` ServeMux exact-path patterns. Method checks exist only where noted; `/api/health`, `/api/pairing/*` accept any method.

Available from process start (before pairing): all routes are registered then, but those needing a connection fail until connected.

### 3.1 `GET /api/health`
- 200 `{"status":"ok","connected":true,"timestamp":<unix s>}`
- **503** `{"status":"disconnected","connected":false,"timestamp":...}` while not connected (incl. the whole QR phase). Treat 503 as "process alive, WhatsApp down". `connected` is `client.IsConnected()` (websocket up), not "logged in".

### 3.2 `GET /api/pairing/status` (local addition)
Always 200. `{"status": "connecting"|"qr_pending"|"connected"|"timeout"|"error", "qr_present"?: true, "expires_at"?: <unix s>, "message"?: string}`. `qr_present`/`expires_at` only when a QR code is held; `expires_at` = time of last rotation + 20 s (a hint only). `message` on `timeout` (`QR code expired without being scanned`) and `error` (connect error text, or `Device was logged out -- restart the bridge to pair again`).

### 3.3 `GET /api/pairing/qr.png` (local addition)
- 200 `image/png`, `Cache-Control: no-store` - the current QR rendered with rsc.io/qr level M.
- 404 `no QR code available` when phase != `qr_pending`.
- 500 `failed to render QR code`.
The raw QR string is never exposed over REST; only the PNG (and the ASCII art on stdout).

### 3.4 `POST /api/send`  (APPROVAL-FIRST: only ever call from an explicit user click)
Request: `{"recipient": string, "message": string, "media_path"?: string, "quoted_message_id"?: string, "quoted_sender_jid"?: string, "quoted_content"?: string}`
- `recipient`: a bare phone number (digits, no `+`) -> `<n>@s.whatsapp.net`, or any full JID (contains `@`). Phone JIDs are auto-resolved to `@lid` for the wire (LID cache, then server `GetUserInfo`), but the row is persisted under the phone JID.
- Quoted reply is text-only and ignored if `media_path` is set. `quoted_sender_jid` should be the full JID of the quoted message's author.
- Responses: 200 `{"success":true,"message":"Message sent to <recipient>"}`; 400 text (`Invalid request format` | `Recipient is required` | `Message or media path is required`); 403 JSON `{"success":false,"message":"Only group admins can send messages in this group"}` or `{"success":false,"message":"media_path rejected: ..."}`; 405 text; **500** JSON `{"success":false,"message":"Not connected to WhatsApp" | "Error sending message: ..." | ...}`.
- **The response does not return the sent message ID.** The bridge stores the outbound row itself (`is_from_me=1`, `sender` = own phone user part); to find it query `messages` for the newest `is_from_me` row in that chat. No echo webhook is emitted for API-sent messages by this code path (whatsmeow does not re-emit own sends); messages the user sends from their phone DO arrive as `isFromMe:true` events when `FORWARD_SELF` is on.
- Honors the chat's disappearing-message timer automatically.
- Windows bug: for documents, title/filename = `mediaPath[LastIndex("/")+1:]`; the validated path uses backslashes, so the **full local Windows path would be sent as the document name**. Do not send documents through this build (the product does not need media sending at all).

### 3.5 `POST /api/react`  (side-effectful - approval-first applies)
Request `{"recipient": chatJID, "message_id": string, "from_me": bool, "sender_jid": string, "emoji": string}`; `emoji` is required (pointer) - `""` removes the reaction. Group reactions with `from_me=false` require `sender_jid`. 200 `{"ok":true}`; 400 text; 503 `Not logged in`; 500 `{"error":"..."}`; 405.

### 3.6 `POST /api/typing`  (side-effectful: visible to the contact)
Request `{"recipient": string, "is_typing": bool}`. 200 `{"success":true,"message":"Typing indicator set to true"}`; JID parse error -> **200** with `{"success":false,...}`; 500 `{"success":false,"message":"Failed to send typing indicator: ..."}`; 400/405 text. An approval-first app should not call this automatically.

### 3.7 `POST /api/download`
Request `{"message_id": string, "chat_jid": string}`. 200 `{"success":true,"message":"Successfully downloaded <type> media","filename":"...","path":"<absolute path under <cwd>\\store\\<jid>\\>"}`; 503 JSON when not connected; 500 `{"success":false,"message":"Failed to download media: ..."}`; 400/405 text. No input sanitising here (unlike `/api/media`) - only pass IDs that came from the DB.

### 3.8 `GET /api/media?jid=<chatJID>&message_id=<id>` (local addition)
Streams the decrypted file (`http.ServeContent`, Range supported). `Content-Disposition: inline; filename="photo.jpg|video.mp4|voice-note.ogg|sticker.webp|<doc name>"`, `Cache-Control: private, max-age=86400`. Validation: jid `^[A-Za-z0-9.\-]{1,100}@[a-z.]{1,40}$`, message_id `^[A-Za-z0-9]{1,128}$`; any failure -> 404 `media not found`. 405 on non-GET.

### 3.9 `GET /api/group/status?jid=` and `GET /api/group/participant-count?jid=` (local additions)
`{"is_group":bool,"can_send":bool,"is_announce":bool,"error"?:string}` and `{"is_group":bool,"count":int,"error"?:string}`. Always 200 on lookup errors (fail-open, error in body); 400 when `jid` missing; 405. Live `GetGroupInfo`, 10 s timeout. Not needed for a DM-only product.

### 3.10 What does NOT exist
No REST endpoint lists chats/messages/contacts, no logout/unpair endpoint, no shutdown endpoint, no mark-read, no SSE/WebSocket. **Reading messages = read `store/messages.db` directly (read-only) + the webhook as a change signal.** Unpair = stop the bridge and delete `store\whatsapp.db` (or unlink the device from the phone, which triggers `LoggedOut`).

## 4. Webhook (bridge -> host)

- `POST <WEBHOOK_URL>`, `Content-Type: application/json`, header `X-Bridge-Token: <token>` (only when `WEBHOOK_URL` is explicitly set and a token exists - both true in our setup). Basic-auth creds embedded in the URL are preserved. Host must verify `X-Bridge-Token` with a constant-time compare and bind its listener to 127.0.0.1 on a random port.
- Client: 30 s timeout, redirects never followed.
- **No retry, no queue, no backoff.** Success is `status == 200` exactly (`✓ Webhook sent...`); anything else logs `⚠ Webhook failed with status N`; transport errors log `Error sending webhook: ...`. The payload is then dropped.
- **Synchronous inside the whatsmeow event handler.** A slow receiver stalls all message processing for up to 30 s per message. The host MUST respond 200 immediately and process asynchronously.
- Not fired for history-sync messages, calls, revokes, or non-image media without text. Fired for: live messages with text (any type with a caption/text), image messages (even without caption), and reactions. Only if `FORWARD_SELF || !isFromMe`.

Payload (`WebhookPayload`, webhook.go):

```jsonc
{
  "eventType": "reaction",          // ONLY present for reactions; absent for normal messages
  "sender": "972501234567",         // USER PART ONLY (no @server); phone if resolvable, else LID digits
  "content": "coffee Thursday at 5?", // text/caption; for reactions = emoji ("" = removed)
  "chatJID": "972501234567@s.whatsapp.net", // full JID (LID chats normalised to phone JID when possible)
  "isFromMe": false,
  "quotedMessageId": "...",         // omitempty
  "quotedSender": "...",            // omitempty
  "quotedContent": "...",           // omitempty
  "messageId": "3EB0...",           // ONLY for image messages and reactions (omitempty)
  "mediaType": "image" | "reaction",// omitempty
  "mimeType": "image/jpeg",         // sniffed from bytes; image only
  "mediaFilename": "image_20260709_173744_<msgid>.jpg",
  "mediaBase64": "...",             // image only, omitted when > 10 MB or download failed
  "reactionToMessageId": "...",     // reactions only
  "reactionEmoji": "👍",            // reactions only (pointer: "" is emitted)
  "reactionRemoved": false          // reactions only
}
```

Critical gaps for the host:
1. **Plain text webhooks carry NO `messageId` and NO timestamp.** Treat the webhook as a "chat X changed" doorbell, then read the new rows from `messages.db` (`chat_jid = chatJID AND timestamp > last_seen`, or match `sender`+`content`). The row is written BEFORE the webhook is sent, so it is already there.
2. No sender display name in the payload - resolve via `chats.name` (section 6).
3. Filter in the host: drop `chatJID` ending `@g.us`, `status@broadcast`, `@newsletter`, `@broadcast`, and `eventType == "reaction"` for the scheduling pipeline. The bridge itself stores and forwards groups/status - the "ignored by default" rule is the host's job.
4. `FORWARD_SELF` semantics: `true` (code default) -> messages the user sends from their phone/other devices are forwarded with `isFromMe:true` (useful: marks a chat as "replied" so it leaves "Needs reply"). `false` -> only inbound. Either way own messages are stored in the DB. Recommendation: set `FORWARD_SELF=true` explicitly and never feed `isFromMe` content to the LLM as a request to act on.
5. Because there is no retry, on every host start (and after any bridge restart) do a DB catch-up scan rather than trusting webhooks alone.

## 5. Pairing / QR flow and states

Startup order (main.go `main`): open `store/whatsapp.db` -> create device if none -> open `messages.db` + LID migrations -> parse port -> token -> media roots -> **start REST** -> register event handler -> connect loop.

```
connecting --(no stored session: GetQRChannel + Connect)--> qr_pending (code rotates ~20 s; each rotation calls setQRCode)
qr_pending --scan OK ("success")--> connected
qr_pending --whatsmeow QR "timeout"--> timeout  (then the bridge idles until its 5-min attempt context ends, Disconnect, sleep 10 s, next attempt)
any connect error --> error (message = error text), sleep 5 s, next attempt
stored session present --> Connect() --> connected (no QR)
events.LoggedOut (device unlinked from phone) --> error "Device was logged out -- restart the bridge to pair again" (process stays alive, never re-enters QR)
```

- Max **3 attempts**, each bounded by a 5-minute context; then `main` returns -> **process exits with code 0**. So a pairing session lasts at most ~15 min; exit code 0 does NOT mean a clean user-requested stop. whatsmeow's own QR channel typically ends after ~160 s (first code 60 s + 5 x 20 s - whatsmeow behaviour, **UNVERIFIED** for this pinned version), after which status shows `timeout` with no QR until the 5-min attempt window closes. Host UX: on `timeout`, kill and respawn the bridge to get a fresh QR immediately ("Show new code" button).
- After a successful scan the code does `time.Sleep(2s)` then `if !client.IsConnected() -> "Failed to establish stable connection"` and exits. whatsmeow reconnects after pair-success, so this race can fire on a slow link. Host rule: **if the process exits for any reason and the user did not quit, respawn it** (with backoff); a respawn after a successful pair finds the stored session and connects without QR.
- `events.Connected` also sets `connected`. Note there is no transition back from `connected` on a transient disconnect - use `/api/health` (503) for live connectivity and `/api/pairing/status` only for onboarding.
- Host polling recipe: every 1-2 s `GET /api/pairing/status`; when `qr_pending`, fetch `qr.png` (re-fetch whenever `expires_at` changes); when `connected`, switch to a 15-30 s `/api/health` poll; on `error` with the logged-out message -> stop bridge, delete `store\whatsapp.db` (keep `messages.db`), respawn -> new QR.
- whatsmeow deletes its device row itself on LoggedOut (**UNVERIFIED**, library behaviour), so a plain respawn probably yields a QR too.
- Linked-device name shown on the phone is whatsmeow's default; not configurable in this build.
- The first connection after pairing triggers history sync (roughly the last ~3 months, phone decides). All synced messages land in `messages.db` without webhooks. The host must treat the initial backlog as history (e.g. only analyse messages newer than pairing time, or the last N days), not as "needs reply" items.

Reconnect behaviour after the initial success: on `Disconnected`/`ConnectFailure`/`StreamError` -> retry after 5 s, doubling to a 5 min cap, reset on success. `StreamReplaced` -> waits 30 s then reconnects. `ClientOutdated` -> only logs `❌ Client outdated - please update whatsmeow library`: the bundled exe then needs replacing (a real long-term maintenance risk since Go is not installed).

## 6. `messages.db` schema (from CREATE TABLE / ensureColumn in main.go)

```sql
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TIMESTAMP,
  ephemeral_expiration INTEGER NOT NULL DEFAULT 0,
  ephemeral_setting_timestamp INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,              -- USER PART ONLY, e.g. "972501234567" (or LID digits if unmapped)
  content TEXT,
  timestamp TIMESTAMP,
  is_from_me BOOLEAN,
  media_type TEXT,          -- "", image, video, audio, document, sticker, reaction
  filename TEXT,            -- for reactions: the reacted-to message ID
  url TEXT,
  media_key BLOB,
  file_sha256 BLOB,
  file_enc_sha256 BLOB,
  file_length INTEGER,
  deleted_at TIMESTAMP,     -- "delete for everyone" marker; content is kept
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
-- added by ensureColumn at startup (ALTER TABLE):
--   messages.quoted_message_id TEXT   (NULL for non-replies; never set by history sync)
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT, chat_jid TEXT, from_jid TEXT, timestamp TIMESTAMP,
  is_from_me BOOLEAN, call_type TEXT,      -- voice | video
  is_group BOOLEAN,
  result TEXT,                              -- in_progress | answered | rejected | missed | ended
  duration_sec INTEGER, ended_at TIMESTAMP, reason TEXT,
  PRIMARY KEY (call_id, chat_jid)
);
CREATE INDEX IF NOT EXISTS idx_calls_chat ON calls(chat_jid);
CREATE INDEX IF NOT EXISTS idx_calls_timestamp ON calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid);
```

Notes for the reader (Electron side):
- There is **no index on `messages.timestamp`**; "latest messages across all chats" is a full scan. Fine for a fresh store; do not add indexes to the bridge's DB - keep your own app DB for derived state (needs-reply / in-calendar / info-missing) and treat `messages.db` as read-only input.
- Rows are stored only when `content != ''` or `media_type != ''`. Upsert on `(id, chat_jid)`; replays overwrite content but never clear `deleted_at` or `quoted_message_id`.
- Timestamp encoding is whatever mattn/go-sqlite3 writes for `time.Time`: text like `2026-07-09 17:37:44+03:00` in the process-local zone (**UNVERIFIED** - the DB was deliberately not opened; this is go-sqlite3's documented format). Do not rely on string ordering across DST/zone changes; parse to epoch in the host.
- Bridge opens the DB with default journal mode (rollback journal, not WAL) and go-sqlite3's default 5 s busy timeout (**UNVERIFIED** default). Host must open `messages.db` **read-only**, keep read transactions short, handle `SQLITE_BUSY`, and must not switch the journal mode. With `better-sqlite3`: `new Database(p, { readonly: true, fileMustExist: true })`.
- `whatsapp.db` holds the Signal keys/session: never copy, log, back up to cloud, or expose it. Read-only lookups into `whatsmeow_contacts` / `whatsmeow_lid_map` are what the upstream Python MCP server does, but prefer `chats.name`.

## 7. JID forms and contact-name resolution

| Form | Meaning |
|---|---|
| `<digits>@s.whatsapp.net` | 1:1 chat keyed by phone number (`types.DefaultUserServer`). The canonical storage form for DMs. |
| `<digits>@lid` | "hidden user"/Linked-ID addressing (`types.HiddenUserServer`). The bridge normalises LID chats and senders to the phone form using `SenderAlt`/`RecipientAlt` from the live event, then whatsmeow's `whatsmeow_lid_map (lid, pn)`; if no mapping exists the row stays under `@lid` and `sender` is the LID digits. Startup migrations rewrite old LID rows once a mapping appears (chat JIDs may therefore CHANGE between runs - key your app state on the phone JID and re-resolve `@lid` keys at startup). |
| `<id>@g.us` | group (`types.GroupServer`); legacy IDs look like `<phone>-<ts>@g.us`. |
| `status@broadcast` | status updates - stored and forwarded by the bridge; host must drop. |
| `...@newsletter`, `...@broadcast` | channels / broadcast lists - host should drop. |
| device JIDs `user:device@server` / `user.agent:device` | stripped with `ToNonAD()` before storage. |

DM-only filter for this product: `chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid'`.

Name resolution order implemented by `GetChatName` (result cached in `chats.name`; an existing non-empty name is never recomputed):
1. existing `chats.name`;
2. groups: history-sync `DisplayName`/`Name` -> live `GetGroupInfo().Name` -> `Group <id>`;
3. contacts: whatsmeow contact store `FullName` -> local `whatsmeow_contacts` row for (`our_jid`, `their_jid`): `full_name` -> `push_name` -> `first_name` -> `business_name` -> the sender digits / JID user;
4. live inbound DM with a `PushName`: if the name is still empty or equals the numeric user, it is replaced by the PushName.

Host rule: display `chats.name`; if it is all digits, show it as a formatted phone number. Names can be Hebrew - render with `dir="auto"`. `messages.sender` has no server suffix: in a DM, the peer is simply `chat_jid`'s user part and `is_from_me` tells direction.

## 8. Shutdown behaviour

- Code waits on `signal.Notify(exitChan, SIGINT, SIGTERM)` then prints `Disconnecting...`, calls `client.Disconnect()`, returns (deferred `messageStore.Close()`).
- **Latent bug:** two goroutines receive from the same `exitChan` (buffer 1): main and the reconnect loop. One signal is delivered to only one of them; if the reconnect goroutine wins, it returns and **main keeps blocking** - the first Ctrl+C can be swallowed. A second signal then stops it.
- On Windows, Node's `child.kill()` (any signal name) is `TerminateProcess` - no Go signal handler runs at all. Go maps only console events (`CTRL_C`/`CTRL_BREAK` -> SIGINT, `CTRL_CLOSE/LOGOFF/SHUTDOWN` -> SIGTERM), which a `windowsHide` piped child will not receive from Electron without a native helper.
- Practical contract: **hard kill is the shutdown path**. It is safe enough: both SQLite DBs use rollback journals (crash-safe), whatsmeow tolerates abrupt socket loss, and the phone just shows the device as offline. Before killing, stop issuing REST calls; optionally wait for stdout to go quiet for ~500 ms. On app quit from the tray use `child.kill()` and, as a belt-and-braces, `taskkill /PID <pid> /T /F` if still alive after 3 s. Also kill the child on `before-quit`, `will-quit` and on `process.on('exit')`, and at startup reap an orphan from a previous crash (store the PID in userData and verify the image path before killing) - an orphan would hold the port and the DB.
- Exits you must expect (all exit code 0, via `return` from main): invalid port, short token, DB open failure, media-roots failure, 3 failed connect/QR attempts, unstable connection after pairing.

## 9. stdout/stderr worth parsing

Everything goes to **stdout** (whatsmeow `waLog.Stdout` with colour enabled + `fmt.Printf`); stderr is effectively unused except Go runtime panics. whatsmeow logger format: `HH:MM:SS.mmm [Module LEVEL] message`, wrapped in **ANSI colour codes** (strip `\x1b\[[0-9;]*m`). Modules: `Client` (level DEBUG - very chatty), `Database` (INFO). Output is UTF-8 with emoji; decode as UTF-8.

Useful markers (substring match after ANSI strip):

| Line | Meaning |
|---|---|
| `Starting REST API server on 127.0.0.1:<port>...` | REST about to listen |
| `REST API server error:` | port bind failed -> respawn on a new port |
| `Scan this QR code with your WhatsApp app:` | QR phase began (followed by a half-block ASCII QR - discard) |
| `Successfully connected and authenticated!` / `✓ Connected to WhatsApp!` / `✓ Successfully connected to WhatsApp servers` | paired / connected |
| `QR code timed out`, `Timeout waiting for QR code scan` | pairing timeout |
| `Device logged out` | session revoked from the phone |
| `Disconnected from WhatsApp servers`, `Attempting to reconnect`, `✓ Reconnected successfully`, `Reconnection failed` | connectivity |
| `Stream replaced by another session` | same session opened elsewhere |
| `Client outdated` | exe must be updated |
| `Failed to establish stable connection` | imminent exit -> respawn |
| `History sync complete. Stored N messages.` | backlog chunk finished -> trigger DB rescan |
| `✓ Webhook sent` / `⚠ Webhook failed with status` / `Error sending webhook:` | webhook delivery |
| `WHATSAPP BRIDGE AUTH TOKEN` banner | only when the bridge generated the token itself (avoid by injecting the token) |

**Privacy:** stdout contains full message text, sender numbers and chat names (`[ts] ← sender: content`, `Stored message: ...`, `Message content: ...`, DEBUG frames) and, if not injected, the auth token. Parse state from REST, use stdout only for the markers above, and never persist raw bridge stdout to a log file (or redact to marker lines only).

## 10. Runtime files / DLLs

- Built with `CGO_ENABLED=1` (mattn/go-sqlite3 requires it). Static string scan of the exe shows only OS DLL names: `kernel32, ntdll, advapi32, ws2_32, mswsock, crypt32, bcryptprimitives, iphlpapi, dnsapi, secur32, userenv, shell32, ole32, winmm, version, psapi, ...` plus the UCRT API sets `api-ms-win-crt-*-l1-1-0.dll`. **No** `libgcc_s_seh-1.dll`, `libwinpthread-1.dll`, `libstdc++-6.dll`, `msys-2.0.dll` or `sqlite3.dll` references were found -> MinGW (MSYS2 UCRT64) runtime and SQLite are statically linked. UCRT is part of Windows 10/11, so **the exe is self-contained: ship the single file.** (Import table not formally parsed: **UNVERIFIED** until a first supervised run by the user on a clean machine.)
- 64-bit only (`GOARCH=amd64`, `GOAMD64=v1`). Runs under emulation on Windows-on-ARM (**UNVERIFIED**).
- ~43.5 MB unsigned binary: expect SmartScreen/AV heuristics once repackaged in an installer; code-sign the installer and, ideally, the exe. With electron-builder put it in `extraResources` (NOT inside `app.asar` - an exe cannot be spawned from asar) and resolve via `process.resourcesPath`.
- Outbound network: WhatsApp websocket `web.whatsapp.com:443` and media CDN `*.whatsapp.net:443`; honours system proxy env vars per Go defaults (**UNVERIFIED**). Inbound: loopback only, so no Windows Firewall prompt is expected (binding 127.0.0.1 does not trigger it).

## 11. Running a SECOND independent instance - problems and mitigations

| # | Problem | Mitigation |
|---|---|---|
| 1 | Store is cwd-relative; wrong cwd = the bridge opens/creates a store somewhere unintended. Launching with cwd = the original folder would attach to the user's LIVE session. | Always spawn with `cwd=<userData>\bridge`; assert at startup that the resolved cwd is inside `app.getPath('userData')`; never pass the original folder anywhere. |
| 2 | Default port 8080 collides with the user's existing bridge; on bind failure the bridge does not exit, it just runs without REST. | Host picks a free ephemeral port, sets `WHATSAPP_BRIDGE_PORT`, verifies `/api/health` answers with OUR token (401 = someone else's bridge on that port). |
| 3 | Default webhook target `http://localhost:8769/whatsapp/webhook` is the user's other system (AutoHub). If `WEBHOOK_URL` were unset, the new instance would POST the user's private messages to that receiver. | Always set `WEBHOOK_URL=http://127.0.0.1:<hostPort>/<random-path>`. Refuse to spawn without it. |
| 4 | Default media root `%USERPROFILE%\.local\share\whatsapp-mcp\outbox` is shared with instance 1 and created outside userData. | Always set `WHATSAPP_MEDIA_ROOTS=<userData>\bridge\outbox` (Windows separator `;`). |
| 5 | Token file would live in the store; stdout banner leaks it. | Inject `WHATSAPP_BRIDGE_TOKEN`. |
| 6 | **Same WhatsApp account on two bridges** is fine protocol-wise - each pairing is a separate linked device (WhatsApp allows up to 4 companions; the user's existing bridge already uses one slot, plus any WhatsApp Web/Desktop). If slots are full, pairing fails on the phone. Two devices never share a store, so `StreamReplaced` ping-pong only happens if the SAME store were opened twice. | Document "needs one free linked-device slot". Add a single-instance lock (`app.requestSingleInstanceLock()`) so two copies of our app never open the same store. |
| 7 | Both bridges see every message; the user's other automation may also reply. Not a technical conflict, but duplicates are possible at the human level. | Approval-first already prevents auto-sends from our side. |
| 8 | First sync downloads history and the bridge **auto-downloads every media file** it sees live (images synchronously, others async) into `store\<jid>\` - unbounded disk growth (the existing store holds ~18k media files after ~2 months). No retention setting exists. | Host-side janitor: periodically delete media files in `<userData>\bridge\store\<jid>\` older than N days (safe: the bridge re-downloads on demand while WhatsApp still hosts the blob). Never touch `*.db` or `.bridge-token`. |
| 9 | `pairingState` is a process-wide singleton and the bridge is single-account by design. | One bridge process per app install; no multi-account. |
| 10 | No Go toolchain: a whatsmeow protocol bump (`Client outdated`, or pairing rejected as in upstream fix #128) cannot be fixed by the app. | Surface a clear "bridge needs update" state; keep the exe replaceable (resources file, SHA-256 pinned in config); plan an update channel. |
| 11 | Exe/source drift: the exe is a locally modified build (`vcs.modified=true`). | Pin SHA-256 `AC23221E...2FF5`; verify the hash before every spawn; vendor the exact local source next to it. |

## 12. Minimal host-side state machine (recommended)

```
STOPPED -> spawn -> STARTING (wait for /api/pairing/status to answer 200 with our token, <= 10 s)
STARTING -> status=qr_pending  => NEEDS_PAIRING (show qr.png, refresh on expires_at change)
STARTING -> status=connected   => ONLINE
NEEDS_PAIRING -> connected     => ONLINE (record pairedAt; ignore older messages for "needs reply")
NEEDS_PAIRING -> timeout|error => offer "new code" => kill + respawn
ONLINE: poll /api/health 15-30 s; 503 => RECONNECTING (bridge self-heals; after 10 min => kill + respawn)
any: process 'exit' and !userQuit => respawn with backoff 2 s, 5 s, 15 s, 60 s
status=error + "logged out" => kill, delete store\whatsapp.db only, respawn => NEEDS_PAIRING
webhook POST => verify X-Bridge-Token => 200 immediately => enqueue "scan chat <chatJID>"
startup / reconnect / "History sync complete" => full catch-up scan of messages.db
```

## 13. Sources

- Local source (authoritative for this contract): `main.go`, `auth.go`, `webhook.go`, `pairing_status.go`, `media_path.go`, `media_serve.go`, `group_status.go`, `group_participant_count.go`, `go.mod` under `C:\Users\ilay1\Documents\minime\whatsapp-mcp\whatsapp-bridge`; `README.md`, `.env.example`, `CHANGELOG.md`, `LICENSE` one level up.
- Upstream repo: https://github.com/verygoodplugins/whatsapp-mcp (MIT; README confirms token file, `X-Bridge-Token`, `WEBHOOK_URL` default; does not document pairing endpoints) - fetched 2026-09-21.
- Original project: https://github.com/lharries/whatsapp-mcp
- whatsmeow: https://github.com/tulir/whatsmeow (module `go.mau.fi/whatsmeow`, pinned pseudo-version `v0.0.0-20260604205742-c6a4b703e48f`); JID server constants in `types/jid.go`.
- go-sqlite3: https://github.com/mattn/go-sqlite3 (v1.14.45; CGO requirement, DSN params, time format).
