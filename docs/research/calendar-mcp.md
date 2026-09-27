# Research: Google Calendar MCP server for WhatsApp Calendar Agent

Date: 2026-09-21. Author: research agent "calendar-mcp".
Scope: choose the MCP server through which the Electron app (acting as MCP client/host) reaches Google Calendar, and define spawn command, env vars, READ/WRITE tool gating, and the end-user Google Cloud setup wizard.

Anything marked **UNVERIFIED** was not confirmed from a primary source during this research and must be checked by the implementing agent.

---

## 0. TL;DR

- **Recommendation: `@cocal/google-calendar-mcp` v2.6.3** (GitHub `nspady/google-calendar-mcp`, MIT, TypeScript/Node, last release 2026-09-02). Ship it inside the app, spawn over **stdio** using **Electron's own binary with `ELECTRON_RUN_AS_NODE=1`** (no separate Node install needed), tokens and credentials stored under the app's `userData`.
- **Google's official remote Calendar MCP server exists** (`https://calendarmcp.googleapis.com/mcp/v1`) but is **Developer Preview only**, requires membership in the *Google Workspace Developer Preview Program*, which **does not accept personal gmail.com accounts**, and is documented only with a **"Web application" OAuth client** with fixed HTTPS redirect URIs (Claude / Antigravity). It is not usable today as the default for a consumer desktop app. Keep it as a future pluggable backend.
- **`taylorwilsdon/google_workspace_mcp`** is excellent but Python/uv based; would force bundling a Python runtime into an Electron app. Rejected for this stack.
- End-user setup (own Google Cloud project + OAuth *Desktop app* client + Calendar API + consent screen) is **unavoidable** unless the app publisher later ships a Google-verified OAuth client. Wizard design in section 6.
- Approval-first gating: the LLM only ever sees READ tools plus an app-defined virtual `propose_event` tool. WRITE MCP tools (`create-event`, `update-event`) are called **only by app code after a user click**. `delete-event`, `create-events`, `respond-to-event` are disabled at the server via `ENABLED_TOOLS`.

---

## 1. (a) Official Google Calendar / Workspace MCP server

### What exists (verified)

Google launched official **remote** Workspace MCP servers in 2026 (gradual rollout reported from May 2026).

| Server | Endpoint |
|---|---|
| Google Calendar | `https://calendarmcp.googleapis.com/mcp/v1` |
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` |
| Drive | `https://drivemcp.googleapis.com/mcp/v1` |
| Docs / Sheets / Slides | `https://docsmcp...`, `https://sheetsmcp...`, `https://slidesmcp.googleapis.com/mcp/v1` |
| Chat | `https://chatmcp.googleapis.com/mcp/v1` |
| People | `https://people.googleapis.com/mcp/v1` |

Calendar server facts (from Google's "Configure the Calendar MCP server" guide and MCP reference):

- Transport: **Streamable HTTP**. Auth: **OAuth 2.0**.
- Launch stage: **Developer Preview** - "Available as part of the Google Workspace Developer Preview Program".
- Prerequisites: Developer Preview Program membership, a Google Cloud project, gcloud CLI; enable **both** `calendar-json.googleapis.com` and `calendarmcp.googleapis.com` in the project.
- OAuth client type documented: **Web application**, with redirect URIs only for first-party-supported hosts: `https://claude.ai/api/mcp/auth_callback` and `https://antigravity.google/oauth-callback`. No Desktop-app / loopback flow is documented. No Dynamic Client Registration is mentioned.
- Scopes listed in the guide: `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.readonly` (the guide lists only these three even though write tools exist - the write scope requirement is **UNVERIFIED**).
- Tools (reference page): `list_events`, `get_event`, `list_calendars`, `suggest_time`, `search_events`, `create_event`, `update_event`, `delete_event`, `respond_to_event`. (The configure guide lists 8, the reference lists 9 incl. `search_events`.) Input schemas are not published in the docs; they must be read via `tools/list`.
- Google's own page carries an "indirect prompt injection" warning and points to Model Armor.

### Can a third-party desktop app authenticate end users to it?

**Not practically, as of 2026-09-21:**

1. The Developer Preview Program application requires a **Google Workspace (work/school) account**; personal Gmail accounts are rejected ("The email address has to be in a workspace domain (we cannot accept Gmail)"). Our target user is a personal-assistant user, most likely on gmail.com.
2. The MCP API must be enabled in a Cloud project enrolled in the preview; every end user would need their own enrolled project, or the publisher would need an enrolled + verified project.
3. Only the Web-application OAuth client type with hosted HTTPS redirect URIs is documented. Whether a Desktop client with loopback redirect (`http://127.0.0.1:<port>`) is accepted by `calendarmcp.googleapis.com` is **UNVERIFIED**.
4. Preview APIs can change or break without notice.

**Design implication:** make the calendar backend an interface (`CalendarMcpBackend`) with one implementation now (local stdio server). A second implementation using `StreamableHTTPClientTransport` against `calendarmcp.googleapis.com` can be added when Google reaches GA and supports consumer accounts. Note that the official tool names use `snake_case` (`create_event`) versus nspady's `kebab-case` (`create-event`), so the READ/WRITE classification table must be per-backend.

Sources:
- https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server
- https://developers.google.com/workspace/calendar/api/v3/reference/mcp
- https://developers.google.com/workspace/guides/configure-mcp-servers
- https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html
- https://developers.google.com/workspace/preview

---

## 2. (b) nspady/google-calendar-mcp (`@cocal/google-calendar-mcp`)

### Package facts (verified via `npm view` on 2026-09-21 and GitHub)

| Item | Value |
|---|---|
| npm name | `@cocal/google-calendar-mcp` |
| Latest version | **2.6.3**, published 2026-09-02 |
| License | MIT |
| Repo | https://github.com/nspady/google-calendar-mcp (about 1.2k stars, 330 forks, 1 open issue at time of check) |
| `type` | `module` (ESM) |
| `bin` | `google-calendar-mcp` -> `build/index.js` |
| `main` | `build/index.js` |
| `engines` | none declared; esbuild target is `node18` |
| Package size | 12 files, ~0.96 MB unpacked (own code is bundled by esbuild with `packages: 'external'`, so npm deps are still required at runtime) |
| Runtime deps | `@modelcontextprotocol/sdk ^1.27.0`, `googleapis ^171.4.0`, `google-auth-library ^10.5.0`, `gaxios ^7.1.3`, `open ^11.0.0`, `zod ^4.3.6` |
| Heavy dep | `googleapis@171.4.0` is **~200 MB unpacked** (199,646,715 bytes) |

Release cadence (GitHub releases): 2.2.0 (2025-12-07, in-chat account management), 2.3.0 (2026-01-06, focusTime/outOfOffice/workingLocation + tool filtering), 2.4.0 (2026-01-18), 2.5.0 (2026-02-28, batch `create-events`, per-field time zones), 2.6.0 (2026-02-28, **PKCE + OAuth state validation**), 2.6.1 (2026-03-02), 2.6.2 (2026-06-01, RE2-safe regexes), 2.6.3 (2026-09-02, HTTP transport session hardening). Actively maintained.

### CLI and configuration

Commands (from `src/index.ts`): `start` (default), `auth [account-id]`, `version`, `help`.

Flags / env (from `src/config/TransportConfig.ts`):

| Flag | Env | Default |
|---|---|---|
| `--transport <stdio\|http>` | `TRANSPORT` | `stdio` |
| `--port <n>` | `PORT` | `3000` (http only) |
| `--host <h>` | `HOST` | `127.0.0.1` (http only) |
| `--debug` | `DEBUG=true` | false |
| `--enable-tools a,b,c` | `ENABLED_TOOLS=a,b,c` | all tools. Invalid names abort startup with an error listing valid names. |

Auth-related env:

| Env | Meaning |
|---|---|
| `GOOGLE_OAUTH_CREDENTIALS` | Absolute path to the OAuth client JSON (the `{"installed": {...}}` file downloaded from Google Cloud). Fallback is `<package root>/gcp-oauth.keys.json`. |
| `GOOGLE_CALENDAR_MCP_TOKEN_PATH` | Absolute path of the token file. Default: `$XDG_CONFIG_HOME/google-calendar-mcp/tokens.json`, else `<homedir>/.config/google-calendar-mcp/tokens.json`. (`src/auth/paths.js` uses `XDG_CONFIG_HOME \|\| ~/.config`; the docs also mention `%APPDATA%\google-calendar-mcp\tokens.json` on Windows - the source and docs disagree, so **always set this env var explicitly**.) |
| `GOOGLE_ACCOUNT_MODE` | Default account id used when none is given. Defaults to `normal` (`test` when `NODE_ENV=test`). |

Token file: plain JSON on disk, keyed by account id; contains refresh tokens. Not encrypted (**UNVERIFIED** whether any file-mode hardening applies on Windows; assume none).

### OAuth flow

- Client type: **Desktop app** (`installed` JSON). Keep the `project_id` field in the JSON (docs say it avoids "User Rate Limit Exceeded").
- Scope requested: `https://www.googleapis.com/auth/calendar` (full calendar scope; `src/auth/server.ts`). `access_type=offline`, `prompt=consent`, PKCE + state since 2.6.0.
- Local callback server: tries ports **3500-3505**, redirect `http://localhost:<port>/oauth2callback`.
- Two ways to start it:
  1. CLI: `google-calendar-mcp auth [account-id]` - opens the system browser through the `open` package, prints the URL to stderr, exits 0 on success.
  2. **In-protocol (preferred for our app):** MCP tool `manage-accounts` with `{"action":"add","account_id":"personal"}`. It calls `authServer.startForMcpTool()` and returns JSON with `status: "awaiting_authentication"`, `auth_url`, `callback_url`, `expires_in_minutes: 5`. It does not need to open a browser itself - the app takes `auth_url` and calls `shell.openExternal(auth_url)`. Then poll `manage-accounts {"action":"list"}` until the account shows `status: "active"`.
- Start-up without tokens in stdio mode: the server **starts anyway** and logs "No authenticated accounts found ... Use the 'manage-accounts' tool with action 'add'" (source comment: "Don't exit - allow server to start so add-account tool is available"). Good for us: spawn first, authenticate later.
- If tokens become invalid mid-session, tool calls throw an `McpError`: "Authentication tokens are no longer valid. Please restart the server to re-authenticate." The app should catch this, show a "Reconnect Google" banner, run `manage-accounts add` again for the same id (or restart the child).

### Multi-account

- Account ids: `^[a-z0-9_-]{1,64}$` (reserved names such as `con`, `prn`, `.` rejected).
- `manage-accounts` schema: `action: "list" | "add" | "remove"`, `account_id?: string` (required for add/remove). `list` returns per account: `account_id`, `status` (`active|expired|error`), `email`, `calendar_count`, `primary_calendar {id,name,timezone}`, `token_expiry`. `remove` refuses to remove the last account.
- Read tools accept `account` as string or string[] (omit = all accounts); write tools accept a single `account` string (auto-selected when only one account exists).
- For v1 of our app: one account with fixed id `personal`. Multi-account is available later at zero cost.

### Tools - exact names and input schemas (from `src/tools/registry.ts`, v2.6.x main branch)

13 tools. Annotations are the server's own MCP `annotations`.

**READ (readOnlyHint: true)**

1. `list-calendars` - `account?: string | string[]`
2. `list-events` - `calendarId: string | string[]` (required; ids like `primary` or calendar *names*), `timeMin?`, `timeMax?` (ISO 8601), `timeZone?` (IANA), `fields?: string[]` (enum of extra event fields; defaults are id, summary, start, end, status, htmlLink, location, attendees), `privateExtendedProperty?: string[]` (`key=value`), `sharedExtendedProperty?: string[]`, `account?`
3. `search-events` - `calendarId` (required), `query: string` (required), `timeMin` (required), `timeMax` (required), `timeZone?`, `fields?`, `privateExtendedProperty?`, `sharedExtendedProperty?`, `account?`
4. `get-event` - `calendarId` (required), `eventId` (required), `fields?`, `account?: string`
5. `get-freebusy` - `calendars: {id: string}[]` (required), `timeMin` (required), `timeMax` (required, max 3 months after timeMin), `timeZone?`, `groupExpansionMax?: int<=100`, `calendarExpansionMax?: int<=50`, `account?: string | string[]`
6. `get-current-time` - `timeZone?`, `account?`
7. `list-colors` - `account?`

**WRITE**

8. `create-event` (readOnlyHint false, destructiveHint false, idempotentHint false) - required: `calendarId`, `summary`, `start`, `end`. `start`/`end` accept `'2026-09-24T17:00:00'` (timed), `'2026-09-24'` (all-day), or a JSON string `{"dateTime": "...", "timeZone": "Asia/Jerusalem"}`. Optional: `account`, `eventId` (custom, base32hex 5-1024), `description`, `timeZone`, `location`, `attendees[] {email, displayName?, optional?, responseStatus?, comment?, additionalGuests?}`, `colorId`, `reminders {useDefault, overrides[{method: "email"|"popup", minutes}]}`, `recurrence: string[]` (RFC 5545), `transparency: "opaque"|"transparent"`, `visibility: "default"|"public"|"private"|"confidential"`, `guestsCanInviteOthers`, `guestsCanModify`, `guestsCanSeeOtherGuests`, `anyoneCanAddSelf`, `sendUpdates: "all"|"externalOnly"|"none"`, `conferenceData`, `extendedProperties {private, shared}`, `attachments[]`, `source {url,title}`, `calendarsToCheck: string[]` (conflict check), `duplicateSimilarityThreshold: number 0-1 (default 0.7)`, `allowDuplicates: boolean (default false)`, `eventType: "default"|"focusTime"|"outOfOffice"|"workingLocation"` plus the matching `*Properties` objects.
9. `create-events` (bulk, 1-50 events; top-level defaults `account`, `calendarId` (default `primary`), `timeZone`, `sendUpdates`; `events[]` each with `summary`, `start`, `end` required)
10. `update-event` (destructiveHint true, idempotentHint true) - required: `calendarId`, `eventId`. Optional: same content fields as create, plus `sendUpdates` (**default `"all"`**), `modificationScope: "thisAndFollowing"|"all"|"thisEventOnly"`, `originalStartTime` (required with `thisEventOnly`), `futureStartDate` (required with `thisAndFollowing`), `checkConflicts`, `calendarsToCheck`.
11. `delete-event` (destructiveHint true) - `calendarId`, `eventId` required; `sendUpdates` (**default `"all"`**), `account?`
12. `respond-to-event` - `calendarId`, `eventId`, `response: "needsAction"|"declined"|"tentative"|"accepted"` required; `comment?`, `modificationScope?: "thisEventOnly"|"all"`, `originalStartTime?`, `sendUpdates?`, `account?`

**ADMIN**

13. `manage-accounts` - see above. Starts an OAuth flow / deletes tokens. Never expose to the LLM.

Useful extras for our use case:
- `extendedProperties.private` on create + `privateExtendedProperty` filter on list: tag every app-created event with e.g. `waAgent=1`, `waChatJid=<jid>`, `waMsgId=<id>`. The "In calendar" dashboard list can then be rebuilt from the calendar itself via `list-events` with `privateExtendedProperty: ["waAgent=1"]`.
- Built-in duplicate detection (`allowDuplicates: false` default) and conflict checking (`calendarsToCheck`) reduce double-booking from repeated approvals.
- `get-current-time` gives the LLM the calendar's time zone - important for Hebrew relative dates ("יום חמישי בחמש").

Tool-name compatibility: kebab-case names satisfy Anthropic's `^[a-zA-Z0-9_-]{1,64}$` and Gemini's function-name rules (letters, digits, `_`, `.`, `-`; **UNVERIFIED** for the exact current Gemini regex - if a provider rejects dashes, map `-` to `_` in the provider adapter and map back before `callTool`).

Sources:
- https://github.com/nspady/google-calendar-mcp
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/tools/registry.ts
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/auth/server.ts
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/auth/paths.js
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/auth/utils.ts
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/server.ts
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/handlers/core/ManageAccountsHandler.ts
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/src/config/TransportConfig.ts
- https://raw.githubusercontent.com/nspady/google-calendar-mcp/main/docs/authentication.md
- https://github.com/nspady/google-calendar-mcp/releases
- https://registry.npmjs.org/@cocal/google-calendar-mcp

---

## 3. (c) Alternatives

| Server | Runtime | Notes | Verdict |
|---|---|---|---|
| **taylorwilsdon/google_workspace_mcp** (`workspace-mcp` on PyPI) | **Python 3.10+ / uv** (`uvx workspace-mcp --tools calendar`) | MIT, ~3.2k stars, 12 Workspace services, `--tools calendar`, `--tool-tier core\|extended\|complete`, `--read-only`, env `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` or `GOOGLE_CLIENT_SECRET_PATH`, OAuth 2.1 multi-user mode over streamable-http (`MCP_ENABLE_OAUTH21=true`). Same user-owned Desktop OAuth client requirement. | Rejected: needs a Python runtime shipped inside an Electron/Node app (extra ~50-100 MB, second toolchain, AV false-positive surface with frozen Python exes). No advantage for calendar-only use. |
| Google official remote MCP | remote HTTP | See section 1. | Not usable for consumer accounts yet. Future backend. |
| iceener/google-calendar-streamable-mcp-server | Node/Hono, HTTP only | Streamable HTTP, aimed at remote hosting. | Smaller community, HTTP-only; no benefit. |
| thisnick / am2rican5 / Jackson88 / galacoder `google-calendar-mcp` forks | Node/TS | Small, low-activity projects. | Rejected (maintenance). |
| Hosted gateways (Composio, Zapier MCP, Pipedream, calendarmcp.ai) | remote | Zero Google Cloud setup for the user, but calendar data and tokens flow through a third party and require that vendor's account/API key. | Rejected for a privacy-centric personal assistant; could be an optional "easy mode" later. |
| Anthropic / Gemini built-in connectors | provider-side | Provider-specific, not available to the Local LLM, breaks the "one MCP tool surface for all three providers" rule. | Rejected. |

Sources: https://github.com/taylorwilsdon/google_workspace_mcp , https://github.com/iceener/google-calendar-streamable-mcp-server , https://github.com/thisnick/google-calendar-mcp , https://github.com/am2rican5/mcp-google-calendar

---

## 4. Recommendation and exact integration

### 4.1 Versions

- Server: `@cocal/google-calendar-mcp@2.6.3` (pin exactly; review diffs before bumping because it handles OAuth tokens).
- Client SDK in the app: `@modelcontextprotocol/sdk@1.30.0` (latest on npm on 2026-09-21; `engines.node >= 18`).
- Electron latest stable: `44.4.3` (released 2026-09-18), bundles **Node 24.21.0** and Chromium 152 - comfortably above the server's `node18` target.

### 4.2 Packaging: ship the server as an isolated resource directory (recommended)

Because `build/index.js` is ESM with external imports, it needs a real `node_modules` tree next to it. Do **not** rely on it living inside `app.asar` (ESM resolution from asar under `ELECTRON_RUN_AS_NODE` is **UNVERIFIED**; and asarUnpack globs cannot easily capture the hoisted transitive deps).

Build step (script in the app repo, run before electron-builder):

```powershell
# produces  <repo>\build-resources\calendar-mcp\node_modules\@cocal\google-calendar-mcp\build\index.js
npm install --prefix ".\build-resources\calendar-mcp" --omit=dev --no-audit --no-fund --ignore-scripts "@cocal/google-calendar-mcp@2.6.3"
```

electron-builder config:

```jsonc
"extraResources": [
  { "from": "build-resources/calendar-mcp", "to": "calendar-mcp" }
]
```

Runtime path resolution:

```ts
const mcpRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'calendar-mcp')
  : path.join(app.getAppPath(), 'build-resources', 'calendar-mcp');
const serverEntry = path.join(mcpRoot, 'node_modules', '@cocal', 'google-calendar-mcp', 'build', 'index.js');
```

Size note: `googleapis` is ~200 MB unpacked / many thousands of small files. It compresses very well in the NSIS installer (**UNVERIFIED** exact figure), and is small next to the multi-GB GGUF download, but it does slow install/uninstall. Optional later optimisation (**UNVERIFIED**, needs testing): re-bundle the server with esbuild aliasing `googleapis` to the 0.85 MB `@googleapis/calendar@20.0.0` package. Do not do this in v1.

Include the package's `LICENSE` (MIT) in the app's third-party notices.

### 4.3 Exact spawn command

Executable: `process.execPath` (the app's own `WhatsApp Calendar Agent.exe` / `electron.exe` in dev).

```
"<process.execPath>" "<serverEntry>" start --transport stdio
```

Env (pass explicitly - `StdioClientTransport` does NOT inherit the full parent env by default, it only passes a small safe list):

| Env var | Value |
|---|---|
| `ELECTRON_RUN_AS_NODE` | `1` |
| `GOOGLE_OAUTH_CREDENTIALS` | `<userData>\google\gcp-oauth.keys.json` |
| `GOOGLE_CALENDAR_MCP_TOKEN_PATH` | `<userData>\google\tokens.json` |
| `GOOGLE_ACCOUNT_MODE` | `personal` |
| `ENABLED_TOOLS` | `list-calendars,list-events,search-events,get-event,get-freebusy,get-current-time,create-event,update-event,manage-accounts` |
| `NODE_ENV` | `production` |
| plus | `SystemRoot`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP`, `TMP`, `PATH` copied from `process.env` (needed by Node/`open` on Windows) |

`<userData>` = `app.getPath('userData')`. Whether `manage-accounts` stays registered when `ENABLED_TOOLS` is set but omits it is **UNVERIFIED** - so it is listed explicitly. Verify at startup that `tools/list` returns exactly the expected nine names; fail closed otherwise.

Code shape (main process):

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, 'start', '--transport', 'stdio'],
  env: {
    ...getDefaultEnvironment(),
    ELECTRON_RUN_AS_NODE: '1',
    GOOGLE_OAUTH_CREDENTIALS: credsPath,
    GOOGLE_CALENDAR_MCP_TOKEN_PATH: tokenPath,
    GOOGLE_ACCOUNT_MODE: 'personal',
    ENABLED_TOOLS: ENABLED.join(','),
  },
  stderr: 'pipe',          // capture server logs into the app log (redact URLs with codes)
  cwd: mcpRoot,
});
const client = new Client({ name: 'whatsapp-calendar-agent', version: app.getVersion() });
await client.connect(transport);
const { tools } = await client.listTools();
```

Lifecycle: spawn lazily once `gcp-oauth.keys.json` exists; restart with backoff on `transport.onclose`; kill on real quit (tray "Quit"), not on window hide.

### 4.4 Electron fuse caveat (important)

`ELECTRON_RUN_AS_NODE` only works while the **`runAsNode` fuse is enabled** (it is by default). Many hardening guides and electron-builder/Forge fuse templates turn it off. **The packaging agent must leave `FuseV1Options.RunAsNode = true`**, or this spawn silently launches a second copy of the GUI app instead of Node.

`utilityProcess.fork()` cannot replace it for stdio: Electron docs state that configuring `stdin` to anything other than `ignore` is unsupported, so there is no stdin pipe for MCP stdio. If the project later insists on disabling the fuse, the fallback is: run the server in a `utilityProcess` with `--transport http --host 127.0.0.1 --port <random>` and connect with `StreamableHTTPClientTransport`. That exposes an unauthenticated localhost HTTP endpoint with calendar write access to any local process, so stdio + fuse enabled is the better trade-off for this app.

Sources: https://www.electronjs.org/docs/latest/tutorial/fuses , https://www.electronjs.org/docs/latest/api/utility-process , https://www.electronjs.org/docs/latest/api/environment-variables , https://releases.electronjs.org/release/v44.4.3

---

## 5. READ vs WRITE gating (approval-first)

Three layers, all enforced in the main process (never in the renderer, never in the prompt alone).

### Layer 1 - server-side allow-list (`ENABLED_TOOLS`)

Disabled entirely (not needed by a personal assistant v1, highest blast radius): `delete-event`, `create-events` (bulk up to 50), `respond-to-event`, `list-colors`.

### Layer 2 - host-side classification table

```ts
export const CALENDAR_TOOL_POLICY = {
  // READ: LLM may call autonomously
  'list-calendars':   'read',
  'list-events':      'read',
  'search-events':    'read',
  'get-event':        'read',
  'get-freebusy':     'read',
  'get-current-time': 'read',
  // WRITE: only app code, only inside an approved-action handler
  'create-event':     'write',
  'update-event':     'write',
  // ADMIN: only the setup wizard / settings screen
  'manage-accounts':  'admin',
} as const;
// anything not in this table => 'deny' (fail closed, covers future server upgrades)
```

Cross-check against the server's own annotations at startup: every tool classified `read` must report `annotations.readOnlyHint === true`; otherwise refuse to expose it.

### Layer 3 - what the LLM actually sees

- Tool list given to Local / Claude / Gemini = the six `read` tools (schemas passed through from `tools/list`) **plus one app-defined virtual tool** `propose_event` (not an MCP tool) whose arguments mirror the subset of `create-event` we support: `summary`, `start`, `end`, `timeZone`, `location`, `description`, `calendarId` (default `primary`), optional `updateOfEventId`.
- `propose_event` has no side effects: the host stores a pending proposal + the drafted WhatsApp reply and shows it on the dashboard.
- Only the IPC handler behind the user's **Approve** click calls `client.callTool({ name: 'create-event' | 'update-event', arguments })`. The arguments come from the stored (user-editable) proposal, not from a fresh LLM turn.
- The host always forces on writes: `sendUpdates: 'none'` (note: the server default for `update-event`/`delete-event` is `"all"`, which would email attendees), no `attendees` in v1, `allowDuplicates: false`, `calendarsToCheck: ['primary']`, and `extendedProperties.private = { waAgent: '1', waChatJid, waMsgId }`.
- `account` parameter: strip it from LLM-facing schemas and inject `account: 'personal'` host-side.
- Treat all tool results (event titles, descriptions written by other people) as untrusted data when fed back to the LLM - calendar invites are a known indirect prompt-injection vector (Google's own MCP guide warns about this). Since the LLM cannot reach any write tool, the worst case is a bad *proposal*, which the user sees before approving.

---

## 6. Unavoidable end-user setup and the in-app wizard

### 6.1 Why it is unavoidable

Both nspady and taylorwilsdon servers (and any local server) need an OAuth client. Google Calendar scopes are classified **sensitive** (not restricted): a publisher-owned shared client would need Google OAuth **verification** (homepage, privacy policy, domain ownership, demo video, scope justification; no CASA security assessment since the scope is not restricted) and, until verified, is capped at 100 users with the "unverified app" warning. For v1 (a personal tool) the user creates their own client. A publisher-verified client can be added later as "Quick connect" by simply shipping a default `gcp-oauth.keys.json`; Desktop-client secrets are not confidential per Google's installed-app model, and the server already uses PKCE.

Google rules that shape the wizard (verified, https://support.google.com/cloud/answer/15549945):
- Publishing status **Testing**: max 100 test users, only listed test users can authorize, and **authorizations (incl. refresh tokens) expire 7 days after consent**.
- Publishing status **In production** without verification: any Google account can authorize, user sees the **"Google hasn't verified this app"** screen (Advanced -> "Go to <app> (unsafe)"), cap of 100 new users in total, **no 7-day expiry**.
- User type **Internal** is only available to Workspace orgs; gmail.com users must pick **External**.

=> The wizard should steer personal users to **External + publish to "In production"** (no verification submission needed for own use) to avoid weekly re-login. Offer "stay in Testing" as the alternative with a clear "you will need to reconnect every 7 days" note; in that case the user must add their own email as a test user.

### 6.2 Exact manual steps (Google Cloud console, 2026 "Google Auth Platform" UI)

1. Create project: `https://console.cloud.google.com/projectcreate` (name e.g. "WhatsApp Calendar Agent").
2. Enable Calendar API: `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com` -> **Enable**.
3. Configure consent / branding: `https://console.cloud.google.com/auth/overview` -> Get started -> App name, user support email -> Audience **External** -> contact email -> agree -> Create.
4. Audience: `https://console.cloud.google.com/auth/audience` -> either **Publish app** (recommended) or add own Gmail under **Test users**.
5. (Optional) Data access: `https://console.cloud.google.com/auth/scopes` -> add `https://www.googleapis.com/auth/calendar`. Not strictly required for the flow to work in unverified mode (**UNVERIFIED**; nspady docs list it as a step).
6. Create client: `https://console.cloud.google.com/auth/clients` -> Create client -> Application type **Desktop app** -> name -> Create -> **Download JSON** immediately (newer console versions only show/download the client secret at creation time - **UNVERIFIED** detail, but tell the user to download right away).
7. Back in the app: drop the JSON file.
8. Browser consent: choose account -> "Google hasn't verified this app" -> **Advanced** -> **Go to ... (unsafe)** -> tick calendar permission -> Continue -> "Authentication successful" page on `localhost:3500-3505`.

(Console deep-link paths are from the current console layout; mark as **UNVERIFIED** and keep them in one config file so they can be patched without a release-blocking change.)

### 6.3 Wizard design (in-app, Hebrew RTL + English)

A 5-step modal, one action per screen, each with a single primary button that opens the exact console URL via `shell.openExternal`, a 1-2 sentence instruction, an annotated screenshot/GIF, and a "Done, next" button. Progress is persisted so the user can close to tray and resume.

| Step | Screen | App behaviour |
|---|---|---|
| 0 | "Connect Google Calendar" intro: why this is needed, "takes about 5 minutes, one time", privacy note (credentials and tokens stay on this PC). | - |
| 1 | Create project + enable Calendar API | Two buttons opening links 1 and 2. Tip: make sure the same Google account and the new project are selected in the console's top bar. |
| 2 | Consent screen (External) + **Publish app** | Opens links 3 and 4. Radio: "Publish (recommended, stays connected)" / "Keep in testing (reconnect every 7 days)". If testing: show the user's step "add your Gmail as test user". |
| 3 | Create **Desktop app** client and download JSON | Opens link 6. Copy-to-clipboard chip for the suggested client name. |
| 4 | Drop zone: "Drop the downloaded client_secret_*.json here" (or Browse) | Main process validates: parses JSON; top-level key is `installed` (if `web` -> specific error "You created a Web application client; create a Desktop app client instead"); `client_id` ends with `.apps.googleusercontent.com`; `client_secret` present; `redirect_uris` contains `http://localhost`. Writes it to `<userData>\google\gcp-oauth.keys.json`. Never logs the secret. Then spawns the MCP server. |
| 5 | "Sign in with Google" | Calls `manage-accounts {action:'add', account_id:'personal'}`, opens `auth_url` with `shell.openExternal`, shows a spinner + an explainer card of the "unverified app" screen ("This warning appears because the app is your own private Google project. Click Advanced -> Go to ..."). Polls `manage-accounts {action:'list'}` every 2 s for up to 5 min (server-side expiry). On `active`: show the connected email + primary calendar name/time zone, run a `list-events` smoke test for today, finish. On timeout: "Try again" re-issues `add`. |

Settings screen afterwards: connected email, status, "Reconnect", "Disconnect" (app deletes `tokens.json` after stopping the child, since `remove` refuses to delete the last account), "Replace credentials file", default calendar picker (from `list-calendars`).

Error mapping to friendly bilingual messages:
- `invalid_grant` / "Authentication tokens are no longer valid" -> "Google connection expired" banner + Reconnect (mention 7-day testing limit if the user chose Testing).
- `access_denied` / Error 403 "access_denied ... has not completed the Google verification process" -> the user is in Testing and not a test user -> link to step 2.
- `Google Calendar API has not been used in project ... or it is disabled` -> link to step 1 (Enable).
- `EADDRINUSE` on 3500-3505 -> "Close other apps using ports 3500-3505 and retry".
- Windows Firewall: the callback binds to localhost only, normally no prompt (**UNVERIFIED**).

### 6.4 Storage and security notes

- `<userData>\google\gcp-oauth.keys.json` and `<userData>\google\tokens.json` are plain files (the server requires file paths). Options to harden: keep the directory ACL'd to the current user (default under `%APPDATA%`), and optionally keep an encrypted copy via Electron `safeStorage` (DPAPI) that is decrypted to disk only while the child runs (adds complexity; defer).
- Never include these files in logs, crash reports or "export diagnostics".
- Pipe the child's stderr into the app log with redaction of `code=`, `access_token`, `refresh_token`, `client_secret` patterns.

---

## 7. Test plan hooks (for the build/test agents)

- Unit: policy table fail-closed behaviour; schema pass-through with `account` stripped; `propose_event` never reaches `callTool`.
- Integration without Google: spawn the real server with a dummy `gcp-oauth.keys.json`; assert `tools/list` equals the nine enabled names and `readOnlyHint` flags match the policy; assert a read tool call returns an auth error (not a crash). No real Google account is touched.
- Packaging: after `electron-builder --dir`, assert `<resources>\calendar-mcp\node_modules\@cocal\google-calendar-mcp\build\index.js` exists and that spawning with `ELECTRON_RUN_AS_NODE=1` answers MCP `initialize` (guards against the fuse being flipped).
- Do NOT use any session-connected Google MCP tools for testing (project hard rule 3).

---

## 8. Open items / UNVERIFIED list

1. Whether `manage-accounts` remains available when `ENABLED_TOOLS` is set and omits it (we include it explicitly to be safe).
2. ESM resolution of the server from inside `app.asar` under `ELECTRON_RUN_AS_NODE` (avoided by using `extraResources`).
3. Exact Windows default token path (docs say `%APPDATA%`, source says `~/.config`) - avoided by always setting `GOOGLE_CALENDAR_MCP_TOKEN_PATH`.
4. Google Cloud console deep-link paths and the "secret only downloadable at creation" behaviour.
5. Write-scope requirements and Desktop/loopback OAuth support of Google's official `calendarmcp.googleapis.com`.
6. Compressed installer size impact of `googleapis` (~200 MB unpacked).
7. Gemini function-name regex accepting `-` (add a name-mapping shim in the provider adapter regardless).
8. Small local models (~4B) with 6 read tools + rich schemas: consider trimming descriptions/optional params in the LLM-facing schema for the Local provider to save context; the host can always pass through to the full MCP schema.
