# v2 Architecture Proposal - SAFETY-FIRST

Project: WhatsApp Calendar Agent. Date: 2026-09-28. Author: v2 architecture agent, angle "safety-first". Status: **proposal** (input to the v2 judge; not binding until folded into `docs/ARCHITECTURE.md` and `docs/specs/*`).
Inputs: `docs/ARCHITECTURE.md` (v1, R3), `docs/specs/contracts.md`, the eight v2 research reports in `docs/research/v2-*.md`, `ops/CONTEXT.md` "v2 request", `ops/DECISIONS.md` D-036..D-041, and the live constants in `src/shared/{types,errors,ipc,settings}.ts` (schema version 3). Reasoning trail: `ops/agent-notes/v2-safety.md`.

Locked decisions D-036..D-040 and every v1 decision A1-A23 are taken as given. Where the research reports disagree, this document picks the lower-risk option and marks it `[LR]`; where a fact is unconfirmed it is marked **UNVERIFIED** and appears again in section 16 with the manual check that closes it. Everything the research verified is cited by report and section, not repeated.

**Design test used for every decision below** (the v1 test, extended by the two new actors):

> Assume the LLM is the attacker (it has just read a hostile message, a hostile voice note, a hostile picture, or a hostile row returned by a WhatsApp read tool). Assume the vendor CLI is an agent runtime we do not control and that auto-updates under us. Assume automatic mode is ON and the user is not looking. What is the worst thing that can happen?
> Required answer: at most one bounded, undoable calendar write on the user's own calendar within the next 30 days, visible within minutes with an Undo button; nothing is sent; no other chat's text leaves the machine; no vendor CLI ever runs a shell, edits a file, or reaches the user's live WhatsApp; the app recovers without user data loss.

The order of this document is deliberate: **section 1-3 design the trust boundaries, invariants and safety primitives first**; sections 4-13 then fit the five features into them. A feature that cannot be fitted without weakening a primitive is cut or deferred (section 17).

---

## 0. Executive summary (what changes, in one table)

| Area | v1 | v2 (this proposal) |
|---|---|---|
| Side effects | 2 kinds (`send_reply`, `create_event`), each behind one click | 3 kinds (+ `update_event`); replies stay click-only; calendar writes may be automatic **only** under a DB-verified policy decision (I1') |
| Who may run an agent loop | the app (`draft.ts`) | the app, **or** the user's unmodified `claude.exe` in a proven-tool-less sandbox with only our loopback MCP server; Antigravity `agy` only with **no tools at all** (opt-in, experimental) |
| Model-reachable tools | 2 calendar READ tools | 6 READ tools (2 calendar + 4 WhatsApp read), one `ToolGate`, two transports (in-process, loopback HTTP) |
| Untrusted inputs | text, names, calendar text, tool results | + voice transcripts (local whisper), + OCR text and digits from pictures, + WhatsApp rows returned by tools, + everything a vendor CLI prints |
| Undo | dismiss only | every calendar change (manual or automatic) has a stored previous version and a one-click undo through the same executor |
| Managed children (A3) | 3 resident | 3 resident (llama-server may carry `--mmproj`) + **short-lived jobs** (whisper-cli, claude.exe, agy.exe) under the same supervisor/reaper primitives; the loopback tool server is in-process |
| New trust records | consents | consents (+4 kinds), `auto_policies`, `auto_decisions`, `auto_writes`, `event_revisions`, sandbox proof per run |

---

## 1. Trust boundaries that are new in v2

| # | Boundary | What crosses it | Why it is new | Primitive that guards it (section) |
|---|---|---|---|---|
| B1 | **Automatic calendar write** | a proposal becomes a Google write with no human reading the card | v1 satisfied Meta's Rule of Two by the click; D-037 removes the click for one action class (auto-mode research section 0) | policy record + decision id + trigger (3.1, 3.2), cage + budgets (3.4), undo ledger (3.3), shadow default (7.2) |
| B2 | **Vendor CLI as an agent runtime below the app** | our system prompt + data block go in; the CLI's own loop calls our tools and returns text/JSON; the CLI has its own credentials, config files, hooks, MCP servers, auto-updater | D-038 puts a second executor under the app that could run shells, edit files, load the user's *reference* WhatsApp MCP (which can send) | sandbox contract + runtime proof, fail closed (3.5); provider taint on every proposal (3.8) |
| B3 | **Loopback listener** | JSON-RPC `tools/call` over `127.0.0.1` | v1 rejected the MCP HTTP transport ("unauthenticated loopback endpoint with calendar write access", ARCH 20) | the endpoint has **no capability of its own** (it is a transport to `ToolGate.invoke()`), read-only tools only, per-run 256-bit bearer, 404-on-everything-else, per-run lifetime (3.6) |
| B4 | **Attacker-supplied media bytes and derived text** | Ogg/Opus bytes and JPEG/PNG bytes parsed in the main process; ASR/OCR text enters the data block | v1 never touched media ("the app does not use media", ARCH 4.6) | media isolation (3.7): bounds-checked TS demuxer + WASM decoder, header sniff + caps before `nativeImage`, tool-less V1 stage, media-derived items never automatic |
| B5 | **User-owned config of a third-party tool** | `~/.gemini/antigravity-cli/settings.json` (trusted workspace), `~/.claude/*` | the app must not silently modify the user's own tools | Claude: never written (`--restricted` ignores it). Antigravity: one key, shown diff, native dialog, backup (5.3) |
| B6 | **The user's subscription windows and money** | every CLI run draws down a 5-hour/weekly window; `isUsingOverage` / AI credits cost real money | v1 API keys were a metered, user-chosen spend; a background pipeline on a subscription can lock the user out of their own tools or spend credits silently | CLI budgets, `resetsAt` backoff, overage = hard stop by default (3.4) |

---

## 2. Invariants (v1 I1-I7 amended, I8-I12 new)

Each invariant keeps a named test under `tests/security/` (section 14). "Enforced by" names code and DB objects, never prompts.

| # | Invariant (v2 text) | Enforced by | Test |
|---|---|---|---|
| **I1'** | **No WhatsApp send without a per-action user click. No calendar write (create, update, cancel) without EITHER a per-action user click OR an `auto_decisions` row that belongs to this action, has `verdict='auto'`, and references an `auto_policies` row in state `on` - verified by the database, not by an `if`.** | `trg_actions_state` v2 (10.2): `approved` requires `approved_by`; `send_reply` requires `'user'`; other approvers must JOIN to a live policy decision for `NEW.id`. Only `ActionExecutor` holds `BridgeSendClient` / `McpWriteClient` (unchanged). `approved_by` frozen with the rest. | `auto-mode.i1-trigger.test.ts` (every forged approver aborts); obedient-attacker corpus with a live `on` policy -> zero sends, writes only inside the cage |
| **I2'** | **The model can reach only READ tools (calendar time/free-busy, WhatsApp read) with app-pinned arguments, and only through `ToolGate` - whether the caller is the in-process tool loop or a vendor CLI on the loopback MCP endpoint.** `get-event`, `list-events`, `update-event`, `create-event` are app-side MCP classes the model never sees. | `ToolGate` default-deny (unchanged); `McpReadClient`/`WaReadClient` facades with no write method; the tool server registers exactly `gate.exposedSpecs()` and forwards every call to `gate.invoke()`; the calendar MCP child is **never** exposed to a CLI. | fake provider *and* fake CLI emit every write/unknown/case-variant/reference-server name -> blocked + audited; `tools/list` == exposed names, all `readOnlyHint:true` |
| I3 | Send recipient = chat of the trigger message | unchanged (replies are never automatic) | unchanged |
| **I4'** | **Untrusted text never enters a system prompt, a tool definition, a vendor agent file, or a CLI argument.** Adds: the V1 image prompt, the `wa_*` tool definitions, the Antigravity agent `.md` bodies are byte constants; the data block travels on stdin (Claude) or as one positional argument that is *only* the nonce-wrapped user message (agy); settings (incl. any auto-policy state) never change prompt bytes. | `buildSystemPrompt()` typed inputs (unchanged); `toolDefs` zod-first constants; `buildAgentFile()` pure with no untrusted parameter | prompt-purity property test extended to V1, `wa_*`, agent files, and `settings.auto`/policy state (bytes identical) |
| **I5'** | **One *trigger* chat per model context. WhatsApp read tools are scoped to the trigger chat unless the user chose `all_chats` (default off, consent v2 for cloud). Every payload and tool result carries no names, numbers, JIDs, WhatsApp message ids, file names or clock times - only run-scoped handles, role labels, relative ages and sanitised text. A draft can never contain text read from another chat.** | `ContextBuilder(chatId)`, `minimize()`, `HandleTable` per run, `projectWaRows`, S4 cross-chat leak guard | payload snapshot per provider incl. tool results; regex sweep; corpus row `wr-exfil-other-chat` |
| **I6'** | The bridge can never touch the user's live store, port 8080 or the default webhook/outbox - **and neither can any new component**: the tool server and `WaReadClient` read only `<userData>\bridge\store\messages.db` through `BridgeDb` (read-only); the media locator reads only files under `<userData>\bridge\store\<jid>\` named by `messages.filename` after a realpath-prefix + regex guard; no vendor CLI ever receives the bridge token, the doorbell secret, the llama key, `CLAUDE_CONFIG_DIR` or an API key. | `assertBridgeSpawnInvariants` (unchanged); env allow-lists asserted literally for `claude.exe`, `agy.exe`, `whisper-cli.exe`; `media/locator.ts` guards | unit test per precondition; env-literal tests; hostile `filename` rows (`..\`, absolute, `.db`, wrong prefix) -> `MEDIA_MISSING`, zero reads |
| **I7'** | A crash of any child or job never takes down the tray app and never duplicates a side effect. **Extended to updates**: an `update_event` is an absolute PATCH on a fixed id with a `baseRevision` compare-and-set; `executing` at startup -> `unknown_outcome`, reconciled read-only by `get-event` (never `list-events`, never a blind re-patch). CLI and whisper jobs are killed by PID (`taskkill /PID /T /F`), recorded in pid files, reaped by pid + exe path + creation time. | write-ahead log (unchanged); `event_revisions` + `items.event_revision`; supervisor/reaper primitives reused for jobs | kill tests for every job; "crash between PATCH and markDone" -> reconcile resolves `done` by `waUpdate` tag, exactly one patch |
| **I8 (new)** | **Every calendar change the app makes is reversible by one user click for at least the undo window, and the pre-write state needed to reverse it is stored BEFORE the write.** | `event_revisions.prev_json` (manual) / `auto_writes.pre_json` (automatic, same transaction as the write-ahead); undo = `item:undoChange` -> pending `update_event {revertOf}` through the normal executor | `auto-mode.undo.test.ts`, `editing.undo.test.ts` |
| **I9 (new)** | **The app never writes to a calendar event it did not create, never to an event with attendees or recurrence, and never to a calendar it does not own when the write is automatic.** | `create-event` always tags `extendedProperties.private.waAgent='1'`; `update-event` only after a pre-flight `get-event` shows `waAgent='1'`, `waItem` = linked source item, `creator.self`, no attendees, no recurrence; auto additionally requires `accessRole === 'owner'` (absent = not owned); `delete-event` is never enabled | `auto-mode.ownership.test.ts`, `editing.foreign.test.ts`, toolset guard |
| **I10 (new)** | **Automatic mode can be enabled only by a user gesture in a focused window confirmed in a native main-process dialog, is recorded as a policy row with an expiry and a settings snapshot, starts in shadow, never switches itself on, and can be disabled from anywhere with one click.** No `settings:set` path exists. | `auto:*` IPC channels + `dialog.showMessageBox` + `auto_policies` unique live row | `auto-mode.toggle.test.ts`, `auto-mode.shadow.test.ts` |
| **I11 (new)** | **A vendor CLI run is used only if the run itself proved it had no tools beyond our loopback server (Claude) or no tools at all (Antigravity); the proof is recorded on the run and no proposal from an unproven run can ever be automatic.** Never `--bare`, never `--dangerously-skip-permissions`/`bypassPermissions`, never a bundled binary, never a credential read. | `CliRunner.assertInit()` fail-closed before the first turn; `runs.sandbox_ok`; `AutoGate` reason `provider_unsafe`; argv/env literal tests | `cli.sandbox.test.ts`, fake `claude.exe`/`agy.exe` handshake e2e |
| **I12 (new)** | **Media bytes never reach native code unparsed, and text derived from media is untrusted forever.** Ogg pages are parsed by bounds-checked TypeScript and Opus by WASM; whisper-cli only ever sees a WAV the app wrote; pictures are header-sniffed and capped before `nativeImage`; V1 (picture reading) has zero tools on every provider; ASR/OCR text enters only the nonce data block; media-derived proposals are never automatic in v2.0. | `voice/ogg.ts`, `voice/decode.ts`, `media/normalizeImage.ts`, V1 argv/request builders, `AutoGate` reason `media_derived` | `vision-no-tools.test.ts`, hostile Ogg/JPEG fixtures, corpus vectors `voice_transcript`, `image_text` |

Trust/taint rule (ARCH 2) gains: **UNTRUSTED** also = voice transcripts, OCR text and digits, WhatsApp tool rows, every line a vendor CLI prints (stdout, stderr, `structured_output`, `result`), every file a vendor CLI writes, `filename` columns of the bridge DB, Antigravity `denied_actions`/`AGY_ERROR` text. **TRUSTED** additionally = the app-computed `existing_event` object (its `title`/`location` strings are quoted contact text and stay inside the data block), policy rows, decision rows, revisions.

---

## 3. Safety primitives, designed before the features

### 3.1 Policy records (auto mode is a row, never a boolean)

Adopted from `v2-auto-mode-safety.md` section 3 verbatim in shape; the ceilings are hard-coded in the zod schema so a UI can only make the mode stricter:

- `auto_policies` (one live row max; states `shadow|on|paused|disabled|expired`; `expires_at` default 30 d; `shadow_until` 24 h; `confirmed_by='native_dialog'`; `confirm_json`; `scope_json` validated by `AutoScopeSchema` with literals `creates:true`, `knownContactsOnly:true` and ceilings `horizonDays<=30`, `maxMinutes<=240`, `perChatPerDay<=3`, `globalPerDay<=15`, `moveMaxDays<=14`; `snapshot_sha` over `{targetCalendarId, googleAccountEmailSha8, provider, appMajorMinor}`).
- `auto_decisions` (one per considered action; `verdict auto|shadow|fallback`; `reason` from the exhaustive `AUTO_REASONS`; `checks_json` metadata only).
- `auto_writes` (the auto ledger: `pre_json` captured before the write in the write-ahead transaction, `revision_id` on success, `post_*` readback, `undo_state`, `undo_until = min(written_at + 72 h, event end)`).

`[LR]` Additional precondition this proposal adds to `auto:requestEnable`: **at least 3 `create_event` actions in state `done` with `approved_by='user'` must exist** (the user has seen the app's judgement on real events before delegating it). Cheap, deterministic, and it makes "enable auto on a fresh install" impossible.

### 3.2 Approval provenance: `actions.approved_by`

`approved_by TEXT` = `'user'` | `'user_toast'` | `<auto_decisions.id>`; `NULL` until approval; **no DEFAULT**. The trigger verifies the JOIN (10.2). This supersedes `v2-event-editing.md` section 3.5 (`approved_by IN ('user','auto') DEFAULT 'user'` + an `AutoApprover` calling `approve()` with a fake `IpcContext`): a bare constant cannot be verified by the DB, a DEFAULT lets an UPDATE that forgets the column pass, and `approve()` keeps its click-only contract. Record as one decision (section 15, D-044 candidate).

### 3.3 One undo path, one revision store

`event_revisions(calendar_event_id, item_id, revision, kind create|reschedule|move|cancel|undo, prev_json, next_json (readback), action_id, applied_at, reverted_by)` from the editing research is the **single** previous-version store for manual and automatic changes; `auto_writes` is a ledger over it, not a second copy. Undo of anything = `item:undoChange {itemId, revisionId}` -> new proposal (provider `'user'`) + pending `update_event {revertOf}` -> `executor.approve()` with `approved_by='user'` (or `undoAuto()` with `'user_toast'` from the toast button). Every gate the executor has (drift, gone, foreign, revision CAS, free/busy, rate limit, write-ahead, readback verification) runs on an undo. There is no `undo_auto` action kind and no bypass.

Undo of a `cancel` = patch `{status:'confirmed', ...prev}` (restore behaviour **UNVERIFIED**, editing research 6.3); if Google refuses, the executor inserts a pending `create_event` with `prev_json` content and the card offers "Add it back" - executed under the user's click, never through `AutoGate` (corrects the editing research's aside that a post-undo re-create is auto-applied).

### 3.4 Budgets and circuit breakers (one table, all persisted in `rate_events` or `LIMITS`)

| Resource | v1 | v2 addition | Breaker / fail behaviour |
|---|---|---|---|
| LLM runs | 6/h per chat, 60/h global, cloud daily token budget | unchanged for Local/API-key. **CLI providers: `settings.llm.cli.maxRunsPerHour` default 20 (ceiling 60), concurrency 1 (one `CliRunner` mutex, one listener, one child)** | `USAGE_LIMIT` -> queue held until `resetsAt` (Claude `rate_limit_event`) / 5 h (agy, no headless number); `RATE_LIMITED` backoff 30/60/120 s max 3; **`isUsingOverage:true` or `useG1Credits` overage detected -> provider paused, `ErrorCode CLOUD_OVERAGE`, items held** unless `settings.llm.cli.allowOverage` (default **false**: the user's money) |
| CLI wall clock | - | `LIMITS.cliWallClockMs` 120 s (S3) / 60 s (S1, V1); agy `--print-timeout` = wall clock - 10 s; abort = `child.kill()` then `taskkill /PID /T /F` after 500 ms | 3 consecutive kills or init failures in 10 min -> provider `not_ready` (`CLI_UNSTABLE`), items held as raw cards |
| Tool calls per run | 4 calls, 3 turns | **6 calls, 4 turns** (`draftToolCalls`, `draftTurnsWithTools`); per-tool 1/3/2/3/2/1; `--max-turns` = turns + 1 on Claude | over budget -> `{"error":"tool not available"}` (no strike); 2 unknown-name strikes -> kill + `run_aborted` + `manipulation` |
| Tool result size | - | `waRowsPerCall` 20, `waTextChars` 500, `waResultChars` 4,000, `waQueryChars` 64, window <= `settings.whatsapp.readTools.windowDays` (default 30, max 90) | projection truncates oldest-first, `truncated:true` |
| Automatic writes | - | per chat 1/30 min, 2/h, `perChatPerDay` (3); global 4/h, `globalPerDay` (15); creates+edits together; <= 2 edits per event; 1 auto create per item | any bucket hit -> decision `fallback/auto_budget` **and** policy `paused/circuit_breaker_rate`; 2 undos/24 h -> `circuit_breaker_undo`; any `unknown_outcome` -> `circuit_breaker_unknown`; 7 d unfocused -> `unattended`; snapshot change, calendar disconnect -> paused. Manual approvals keep working after any pause |
| Manual calendar writes | creates 10/h, 30/day | `create_global` bucket covers creates + updates + undos | inline "limit reached" |
| Voice notes | - | one whisper job at a time (inside `runChat`, queue concurrency 1); note <= 15 min (granule check **before** decode); file <= 64 MiB; timeout `clamp(30 s, 4 x seconds x benchFactor, 600 s)`; decode 20 s | 5 failures / 10 min -> `VOICE_LOCAL_FAILED` breaker, retry later; untranscribed notes are raw cards |
| Pictures | - | one image per run (the newest unread); bytes <= 10 MiB, <= 25 MP, long edge 1536 after normalisation; V1 timeout 180 s local / 120 s CLI; V1 failure never blocks the text path | `image_unread` badge, raw card with thumbnail |
| Loopback listener | - | body <= 64 KiB, `requestTimeout` 2 s, `Connection: close`, one listener per run, closed in `finally` | port collision after `FREE_PORT_MAX_ATTEMPTS` -> CLI provider `not_ready`, Local unaffected |
| Native dialogs | - | `auto:requestEnable` <= 3/h; consent dialogs unchanged | `BAD_REQUEST` |

### 3.5 CLI sandbox contract and runtime proof (I11)

**Claude Code** (`claude.exe` >= 2.1.221; installed 2.1.258; resolved explicitly, never `.cmd`, `shell:false`, `windowsHide`, empty per-run cwd `<userData>\cli-runs\<runId>\` deleted in `finally`). Exact argv is the `cli-mcp-bridge` section 6.1 list; the parts that are **security-relevant and asserted by a literal test**:

```
-p --restricted --strict-mcp-config --tools "" --permission-mode dontAsk [--permission-prompts none  (>= 2.1.259)]
--disallowedTools "Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate"
--disable-slash-commands --no-session-persistence --system-prompt <verbatim constant> --max-turns N
--output-format stream-json --input-format stream-json --verbose --model sonnet --effort low [--json-schema <draft-07>]
[S3 only] --mcp-config '{"mcpServers":{"wca":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer ${WCA_MCP_TOKEN}"}}}}' --allowedTools "mcp__wca__*"
```

Never on argv: `--bare` (never reads OAuth -> not the subscription, and the docs say it may become the `-p` default: the app must keep passing an explicit non-bare mode), `--dangerously-skip-permissions`, `--add-dir`, `--settings`, `--continue/--resume`, the token, any message text. Env = allow-list only (`SystemRoot`, `PATH`=System32, `TEMP/TMP`=run dir, `USERPROFILE`, `HOMEDRIVE/HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `WCA_MCP_TOKEN`, `MCP_TIMEOUT=10000`, `MCP_TOOL_TIMEOUT=25000`, `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_BUG_COMMAND=1`, `CI=1`); never `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_PROFILE`/`CLAUDE_CODE_OAUTH_TOKEN`/`CLAUDE_CONFIG_DIR`/`CLAUDE_CODE_USE_*`/`HTTPS_PROXY`, never the bridge token, doorbell secret or llama key. The user message (nonce data block, optional image block) is one JSON line on stdin.

**Runtime proof, fail closed** (`CliRunner.assertInit`, before any turn is consumed): the first stream-json event must be `system/init` with `mcp_servers` exactly `[]` (S1, V1) or `[{name:'wca', status: connected|pending}]` (S3), `mcp_server_errors` empty, `plugins` empty, `tools` ⊆ `{mcp__wca__<our exposed names>}` ∪ the CLI's neutral internals observed once and pinned (**UNVERIFIED U2**: which internals appear with `--tools ""` + `ENABLE_TOOL_SEARCH=false`), and - once the literal is known (**UNVERIFIED U9**) - `apiKeySource` = the OAuth value. Any mismatch -> kill, audit `toolset_mismatch {provider, reason}`, `ErrorCode CLI_TOOLSET_MISMATCH`, run failed, **no retry with looser flags, ever**. The result is classified on `is_error` first (issue #79500), then `subtype==='success'`, `stop_reason!=='refusal'`, and `structured_output` present when a schema was passed; a non-`mcp__wca__` `tool_use` name or a `permission_denials` entry is a `tool_blocked {nameSha8,nameLen,verdict:'blocked_unknown_tool'}` strike exactly as in v1. The proof is persisted as `runs.sandbox_ok=1` + `runs.sandbox_json` (`{initOk, toolsCount, mcpServers:['wca'], apiKeySource}` - enums/numbers only) and copied to `proposals.provider_class` (3.8).

Version drift: `claude --version` at provider start (floor 2.1.221; optional flags gated by version), plus a **provider-start smoke run** (1-field `--json-schema`, `--max-turns 1`, `haiku`) whose `system/init` must pass the same assertion; failure -> `CLI_TOOLSET_MISMATCH` before any user data is sent. `[LR]` Authenticode check of the signer (`Anthropic, PBC`) is **advisory only** (UNVERIFIED that the launcher stub is signed): logged, shown in diagnostics, never a hard gate in v2.0.

**Antigravity CLI** (`agy.exe` >= 1.2.11; not installed on the dev PC today): ships as **opt-in "Gemini via Antigravity CLI (experimental)"**, OFF by default, behind consent `cloud_antigravity_cli` whose text carries the Terms §6 wording with its date, the on-disk transcript (`~/.gemini/antigravity-cli/brain/...`), the user-level hooks/MCP servers that load in every run, and the API-key alternative. Run shape (`gemini-cli-backend` 8.1-8.5): `--agent wca-<stage> --model <flash slug> --effort low --output-format stream-json --print-timeout <wall-10 s> --disable-slash-commands --json-schema <file> -p "<nonce user message>"`, `stdin:'ignore'`, cwd = the app-owned trusted workspace `<userData>\agy-workspace\` containing **only** `.agents\agents\wca-*.md` (frontmatter `tools: []`, `commandExecutionPolicy: off`, `excludeDefaultComponents: true`, body = verbatim constant) and `schemas\*.json`; **no `.agents\mcp_config.json` exists in v2** (no tools at all; the app prefetches free/busy and WhatsApp context through `ToolGate` and inlines them); env allow-list + `AGY_CLI_DISABLE_AUTO_UPDATE=true`; never `--dangerously-skip-permissions`, never `--sandbox` reliance. Proof: `init.agent === 'wca-<stage>'`, `init.tools` empty (**UNVERIFIED U4**), `init.permission_mode === 'request-review'`; `status==='WAITING'`, non-empty `denied_actions`, or a missing `structured_output` = failure, never a permissions retry. **Auto mode is unavailable while `antigravity_cli` is the active provider in v2.0** (`provider_unsafe`); re-enabling requires U4 closed on the installed version *and* a code change (a decision), not a setting. The v2.1 MCP-attached variant stays documented in `cli-mcp-bridge` 6.2 and is out of scope here.

Both CLIs: the run pid goes into `<userData>\run\cli-<runId>.pid.json` (reaped by pid + exe path + creation time; never by image name - the user runs Claude Code interactively on the same machine); stderr passes the marker-only redactor; nothing the CLI prints is logged raw; `cli_run` audit rows carry numbers/enums/booleans only.

### 3.6 Loopback tool server (B3) - a transport, not a capability

`src/main/mcp/toolServer.ts` `[LR]` **per-run listener** (cli-mcp-bridge) rather than a long-lived registry (whatsapp-mcp-readonly): nothing outlives the run, the port is re-picked per run, and there is no token table to leak. Shape as `cli-mcp-bridge` section 3: `node:http` on `127.0.0.1:<freePort>` (`NEVER_PORTS`), SDK 1.30.0 `StreamableHTTPServerTransport` stateless (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), **our own guard before `handleRequest()`** (the SDK's `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` are `@deprecated` in 1.30.0 and are set only as a second layer): `POST /mcp` only, `Host` exactly `127.0.0.1:<port>`, **any `Origin` header -> 404**, `Authorization: Bearer <token>` compared with `timingSafeEqual`, body <= 64 KiB, `requestTimeout` 2 s; everything else `404` + `socket.destroy()` (no probing signal, no 401). Registered tools = `gate.exposedSpecs()` of *this* run with `readOnlyHint:true`; every `tools/call` -> `gate.invoke({id, name, input}, ctx)` with the run's `RunCtx` (budgets, handles, nonce). The server imports `agent/toolGate` types, `agent/toolDefs`, `proc/freePort`, the SDK server modules - and by ESLint boundary + import-graph test never `mcp/host`, `mcp/writeClient`, `mcp/adminClient`, `bridge/sendClient`, `bridge/readClient`, `exec/**`, `llm/**`, `electron`. Token delivery: Claude via `${WCA_MCP_TOKEN}` env expansion in the inline `--mcp-config` JSON (never argv, never disk); agy: n/a in v2. Windows Defender prompt for the packaged app's listener is **UNVERIFIED U11** (v1 already listens on loopback for llama-server and the calendar child).

Residual accepted: any process running as the same user can reach the endpoint during a run (< 2 min) with the token - it would obtain read-only, sanitised, handle-keyed rows of data that user already owns; the same-user attacker is the accepted v1 R4 residual.

### 3.7 Media isolation (B4, I12)

- **Bytes**: `[LR]` one locator for audio and pictures: `media/locator.ts` resolves `<userData>\bridge\store\<jid with ':'->'_'>\<messages.filename>` after `realpath` prefix assertion and a per-kind regex (`^audio_\d{8}_\d{6}_[A-Za-z0-9]{1,128}\.ogg$`, `^image_\d{8}_\d{6}_[A-Za-z0-9]{1,128}\.(jpg|jpeg|png)$`), size caps (64 MiB / 10 MiB), and waits up to 30 s for the bridge's async download. The image research preferred `GET /api/media`; this proposal uses the store file for both because the file name comes from the DB row (not reconstructed), the container parsers validate partial writes, and it keeps A16's amendment to **one** endpoint. **UNVERIFIED U12**: `messages.filename` is populated for image rows exactly as for audio rows (`extractMediaInfo` in the vendored `main.go`); if not, `BridgeReadClient.getMedia()` (image research 5.1) is the fallback and A16 grows by a second read-only endpoint.
- **A16 amendment** (decision D-046 candidate): "four endpoints" -> "five": `POST /api/download {message_id, chat_jid}` is allowed **only** from `media/locator.ts`, only for rows with `media_type IN ('audio','image')`, only after the 30 s local wait failed, with regex-validated ids from the bridge DB, at most once per message; `invariants.test.ts` asserts no other module references the path. The bridge contract documents the download as having no contact-visible effect.
- **Audio**: `voice/ogg.ts` (bounds-checked, CRC-checked, single-stream, RFC 3533/7845, ~150 lines TS) -> `opus-decoder@0.7.12` (MIT, WASM embedded, **UNVERIFIED U13** under Electron 44 main) at 16 kHz mono -> app-written PCM16 WAV -> `whisper-cli.exe` job (`-m -f -l he|auto -t N -oj -of <tmp> -np -nt --vad ... -bs 5 -bo 5 -tp 0 -et 2.4 -sns`, minimal env, `cwd`=bin dir, `stdio ['ignore','ignore','pipe']`, BELOW_NORMAL, no `--prompt`). The transcript is UNTRUSTED text (`sanitizeForModel`, `LIMITS.messageChars`, nonce block, `source:'voice_transcript'`), never in a system prompt, never in argv, never logged; stdout (which carries the transcript) is ignored. Nothing leaves the machine (D-039).
- **Pictures**: pure-TS JPEG SOF / PNG IHDR sniff -> reject > 10 MiB or > 25 MP (decompression-bomb guard `nativeImage` lacks) -> `nativeImage` resize to long edge 1536, `toJPEG(85)`, 320-px thumbnail; `jimp@1.6.1` is the only permitted pure-JS fallback; `sharp` stays forbidden. V1 READ-IMAGE is **tool-less on every provider** (local: no `tools`; API-key: no `tools`; Claude CLI: `--tools "" --strict-mcp-config --max-turns 1`, no `--mcp-config`, init asserts `tools == []` and `mcp_servers == []`; agy: not used for pictures in v2 - `@path` headless is UNVERIFIED, so Gemini pictures use the API-key provider's `inline_data` or local). The `--tools "Read"` fallback of the image research is **not adopted in v2.0** `[LR]`: it is the only configuration in the app where a vendor agent would get a file tool; if the stdin image block fails gate M-IMG-1, Claude-CLI pictures fall back to **local** vision until a decision reopens it. V1 output is a `.strict()` value object with sentinels; `suspicious` -> red `manipulation`; `confidence low`/unreadable -> amber `image_unclear`; every image-derived event -> `from_image`.
- **Never automatic**: any item whose trigger is a voice note or a picture (`items.trigger_kind IN ('voice','image')`) falls back with `media_derived` in v2.0 (auto-mode research M16). A later `scope.mediaAuto` flag may lift this after a shadow tally shows parity with text items.

### 3.8 Provenance on every proposal (what `AutoGate` may rely on without importing `agent/**`)

S4 persists on the `proposals` row, so the executor side reads facts instead of recomputing them: `blocked_calls INTEGER`, `provider_class TEXT CHECK IN ('local','api_key','cli_proven','cli_unproven')`, `trigger_kind` (copied from the item), `badges_json` (exists on items), `confidence`/`change_confidence` (from `extraction_json`), `context_from_me_recent INTEGER` (a `from_me` row within 24 h of the trigger existed in the window), `cross_chat_rows INTEGER` (rows served from other chats). `AutoGate` is a pure function over `{policy, action, item, chat, proposal, now}`; its import graph is tested to exclude `agent/**`, `llm/**`, `ipc/**`.

---

## 4. Process model

```
                                        Windows 11 user session
+----------------------------------------------------------------------------------------------------------+
| Electron MAIN (ESM; the only process with secrets/power)                                                 |
|  lifecycle | tray | window | app:// + CSP | IPC router (sender + zod .strict())                            |
|  Db (app.db v4) | secrets | HealthHub | Supervisor x3 + JobRunner + Reaper (pid files for children AND jobs)|
|  Bridge: launcher/invariants | BridgeReadClient | Doorbell | BridgeDb (ro) -> Ingest | media/locator (ro)   |
|  Voice:  ogg demux (TS) -> opus WASM -> WAV -> whisper-cli JOB (per note)          [nothing leaves]        |
|  Media:  sniff/caps -> nativeImage -> media-cache                                                          |
|  Agent:  TriageQueue(1) -> V0 transcribe -> S0 -> V1 read-image -> S1 -> S2(+delta) -> S3 -> S4           |
|          ToolGate (one gate) -> McpReadClient | WaReadClient (ro facades)                                   |
|          McpToolServer 127.0.0.1:<port> per CLI run (transport to ToolGate; NO capability)                 |
|  Exec:   AutoGate (pure) -> ActionExecutor -> BridgeSendClient (/api/send) | McpWriteClient (create/update)|
|  LLM:    LlmProvider { local | claude_cli | antigravity_cli | claude(api) | gemini(api) } + CliRunner(1)    |
+------+-----------+------------------+-------------------+---------------------+----------------------------+
       |           |                  |                   |                     |
       v           v                  v                   v                     v
  RENDERER    whatsapp-bridge.exe  calendar MCP child   llama-server.exe     JOBS (short-lived, killed by PID):
  sandbox     (unchanged, A15/I6)  (@cocal 2.6.3 +       (+ --mmproj when     whisper-cli.exe   (per voice note)
                                    vendored status/     pictures enabled)   claude.exe -p     (per S1/S3/V1 run, user-installed)
                                    If-Match patch)                          agy.exe -p        (opt-in, no tools)
```

| Process / job | Started | Holds | Crash effect | Kill / reap |
|---|---|---|---|---|
| Main, Renderer, Bridge, Calendar MCP | unchanged (ARCH 3) | unchanged | unchanged | unchanged |
| llama-server | unchanged; respawned with `--mmproj <tier-mmproj-F16.gguf> --mmproj-device none --image-max-tokens 1120|560 [--batch-size 2048 --ubatch-size 2048 mid]` when `images.enabled && mmprojPresent`; `/props.modalities.vision` is the readiness truth | model (+ projector in RAM) | item stays queued; V1 failure -> text-only run with `image_unread` | unchanged |
| **whisper-cli job** | per audio row inside `runChat` (shares queue concurrency 1) | 1.6 GB model mapped for the job | transcript row `failed/aborted`, retry by backoff; breaker 5/10 min | `taskkill /PID /T /F` after 3 s grace; pid file `job-voice-<id>` |
| **claude.exe job** | per S1/S3/V1 run when provider = `claude_cli`; concurrency 1 | its own OAuth (never ours); our loopback token in env (S3 only) | run failed -> raw card / retry by backoff; 3 kills in 10 min -> `CLI_UNSTABLE` | `child.kill()` then `taskkill /T` after 500 ms; run dir deleted; listener closed in `finally`; pid file `job-cli-<id>` |
| **agy.exe job** | per S1/S3 run when provider = `antigravity_cli` (opt-in) | its own Google login; **no token** (no tools) | same as above | same; the agy conversation dir is left alone (**UNVERIFIED U5** whether deleting it is tolerated) |
| **McpToolServer** (in-process) | per Claude S3 run | the run's `RunCtx` | listener error -> CLI provider `not_ready`; Local unaffected | `close()` in `finally` |

A3 ("exactly three managed children") is amended to: three resident managed children + short-lived **jobs** that use the same spawn rules (array argv, `shell:false`, minimal env, `windowsHide`, pid file, kill by PID, reaper by pid+exe+creation time) but no restart policy and no breaker beyond the per-job counters above. Quit: jobs are killed before `stopAll`.

---

## 5. Provider abstraction

`src/main/llm/types.ts` (additive; v1 members untouched):

```ts
export const PROVIDER_IDS = ['local', 'claude_cli', 'antigravity_cli', 'claude', 'gemini'] as const;  // 'claude'/'gemini' = API-key (Advanced)
export type ProviderLoop = 'turn' | 'agentic' | 'prefetch';
export interface AgenticRunInput { system: string; user: string; specs: readonly ToolSpec[]; ctx: RunCtx; gate: ToolGate; maxTurns: number; jsonSchema?: JsonSchemaLcd }
export interface AgenticRunResult { text: string; structured?: unknown; toolCalls: number; blockedCalls: number; sandboxOk: boolean;
  stopReason: 'end'|'max_turns'|'aborted'|'killed'|'bad_output'; usage?: LlmUsage; rateLimit?: { resetsAt: number|null; usingOverage: boolean|null } }
export type LlmImagePart = { type: 'image'; mime: 'image/jpeg'|'image/png'; base64: string };
export type LlmUserContent = string | Array<{ type: 'text'; text: string } | LlmImagePart>;   // only V1 ever builds an image part (purity test)
export interface LlmProvider {
  readonly id: ProviderId; readonly model: string; readonly loop: ProviderLoop;
  structured<T>(messages, schema, opts): Promise<T>;      // S1, V1: CLI = one run, --json-schema, no MCP server, --max-turns 1
  chat(messages, tools, opts): Promise<LlmResponse>;      // loop 'turn' only; CLI providers throw LlmError('unsupported')
  runAgentic?(input: AgenticRunInput, opts: CallOpts): Promise<AgenticRunResult>;   // loop 'agentic' (Claude CLI): server = gate
  validate(signal): Promise<{ok:true, model} | {ok:false, reason: ProviderErrorCode}>;  // CLI: exe + version + smoke init; NO login probe
  dispose(): Promise<void>;                               // CLI: kill in-flight child
}
```

- `draft.ts` branches on `loop`: `'turn'` = v1 loop; `'agentic'` = `runAgenticDraft()` (start tool server -> `runAgentic` -> close); `'prefetch'` = `gate.prefetchFreeBusy()` + `gate.prefetchWaContext()` inlined, one no-tool completion. Same `DraftOutcome`, same `cleanDraft`, same `manipulation` rule.
- `ProviderErrorCode` gains `'not_installed' | 'version' | 'not_logged_in' | 'usage_limit' | 'overage' | 'sandbox' | 'account_hold'`; `ErrorCode` gains `CLI_NOT_INSTALLED`, `CLI_VERSION`, `CLI_NOT_LOGGED_IN`, `CLI_TOOLSET_MISMATCH`, `CLI_UNSTABLE`, `CLOUD_AUTH`, `CLOUD_OVERAGE` (each with one bilingual action: "Show install command", "Update", "Sign in" = opens a **visible console** running `claude auth login --claudeai` / `agy`, "Export diagnostics", "Open AI settings").
- `factory.ts`: `SECRET_FOR` has no entry for CLI ids; consents `cloud_claude_cli` / `cloud_antigravity_cli` are required exactly like `cloud_claude`; `usable()` = exe found + version floor + last smoke init passed within 24 h. Never silent fallback between providers (A20 unchanged): a CLI failure holds the item, it never re-routes to an API key or to local.
- Model defaults `[LR]`: Claude CLI `sonnet` with `--fallback-model haiku` (Opus burns the 5-hour window and may be unavailable on Pro); agy `gemini-3.8-flash-medium` (S1) / `-high` (S3), listed live from `agy models` at settings time, "as reported by the CLI" (silent-downgrade history #687).
- Settings page order: "Claude (your subscription, via Claude Code)" and "Gemini (your subscription, via Antigravity - experimental)" above the API-key variants, which move under "Advanced" (D-038). The product may state in plain text that it runs Claude Code; it never uses the Claude Code/Anthropic or Antigravity names or logos in its own branding.

---

## 6. Pipeline v2

```
Ingest row -> [V0 transcribe: audio rows without a transcript -> whisper job; '' transcript never triggers]
  -> S0 filter (unchanged + trigger_kind text|voice|image; image rows with sniffed JPEG/PNG bytes ARE triggers when images.enabled)
  -> [V1 read-image: newest unread image in the window -> tool-less vision -> ImageRead (strict) -> imageText into the data block, digits into S2]
  -> S1 EXTRACT (structured, NO tools; schema + refersToExisting/change/changeConfidence/confidence; app_context.existing_event inside the nonce block)
  -> S2 RESOLVE (TS: dates; image_absolute branch; resolveDelta anchored on the trusted existing event; free/busy prefetch minus the event itself)
  -> S3 DRAFT (tools via ToolGate: 2 calendar + up to 4 WhatsApp read; in-process, agentic over loopback, or prefetch-inlined per provider.loop)
  -> S4 VALIDATE (badges + change_unclear + cross_chat_leak guard; persists provenance 3.8; actions: send_reply | create_event | update_event)
  -> [tryAuto: AutoGate -> auto | shadow | fallback]  -> card (fallback/shadow) or auto write (with toast + Undo)
  -> S5 ActionExecutor (click or decision id; no LLM anywhere)
```

- **V0** and **V1** run inside `orchestrator.runChat` before S1, so whisper-cli, llama-server and a CLI never compete for the CPU and the loopback surface stays one-at-a-time.
- **Delta extraction (D-036)**: `findExistingEvent(chatId)` = newest `in_calendar` item of the chat with `calendar_event_id` and `event_state IN ('created','updated')` starting >= now - 24 h; injected as `app_context.existing_event` (title/location are quoted contact text and stay inside the data block; `eventId`, item ids, JIDs never reach a model). S1 schema stays one flat schema for all providers; S2 owns the delta (inherit date/time, nearest-hour disambiguation, `to !== from`, weekday cross-check -> `change_unclear`). The delta rides on the NEW open item (`items.linked_item_id` -> source item), pins `targetEventId` and `baseRevision` at proposal time, and yields an `update_event` action. One editable event per chat in v2 (the newest); a second live event in the same chat is `new_event`.
- **S3 on the CLI**: identical system prompt constant via `--system-prompt`; tool results are nonce-wrapped by the server, so "only text inside the nonce block is data" holds for tool output too.
- **S4 additions**: badge `change_unclear` (amber); `change_in_google` retired (kept in the enum for old rows); cross-chat leak guard (any 24-char normalised substring of a row served from another chat appearing in the draft -> reject + `manipulation`); `proposals.provider_class` from `runs.sandbox_ok`.
- Every stage's data block gains the same rule: transcripts carry `source:'voice_transcript'`, images carry `imageText`/`imageKind`; the S1 system prompt gains exactly one static sentence for `imageText` and the static existing-event addendum (both byte constants).

---

## 7. Automatic mode (D-037) - the feature fitted into 3.1-3.4

### 7.1 Policy lifecycle
`auto:requestEnable {scope, trial}` (focused + visible window, focus-steal guard, rate 3/h, calendar connected with `accessRole==='owner'` cached from `list-calendars`, no live policy, **>= 3 user-approved done creates**, consent `auto_mode` current) -> native `dialog.showMessageBox(win, { type:'warning', noLink:true, checkboxLabel, buttons:[Cancel, Start trial|Enable now], defaultId:0, cancelId:0 })` -> `response===1 && checkboxChecked` -> insert policy (`shadow` by default; `on` only if the user chose "Enable now" - recorded) -> audit -> tray line "Automatic mode: trial/ON". `auto:disable` needs no confirmation and works from an unfocused window (fail-safe direction). Automatic pauses (3.4) resume only by a click. Expiry 30 d (ceiling 90) with a reminder 3 days before; renewal = a fresh dialog. App major/minor change -> `paused/snapshot_changed`.

### 7.2 Shadow first
`shadow` runs `AutoGate` for real, stores `verdict:'shadow'` decisions, shows the card with an `auto_shadow` badge ("would have been automatic") and the user approves as in v1; edits/dismissals are tallied in `checks_json`. `auto:endShadow` is accepted only after >= 3 shadow decisions and the settings page shows the tally; the app never flips to `on` by itself.

### 7.3 `AutoGate` (pure, `src/main/exec/autoGate.ts`) and `tryAuto`
`AUTO_REASONS` exactly as `v2-auto-mode-safety.md` 5.5 (policy / contact / quality / provider / cage / edit reasons) plus `media_derived`, `provider_unsafe`, `no_track_record`. Eligibility = `is_known` (not `force_known`) + `policy !== 'never'` + `auto_policy !== 'never'` + not tainted (7 d after a manipulation badge or blocked call) + zero badges of any severity + `blocked_calls === 0` + `suspicious === false` + no assumed hour + `missing.length === 0` + `confidence === 'high'` (deltas: `changeConfidence === 'high'`, `refersToExisting`) + `provider_class IN ('local','api_key','cli_proven')` + `trigger_kind === 'text'` + `context_from_me_recent === 1` (SHOULD -> MUST in this proposal `[LR]`: the user wrote in this chat within 24 h of the trigger; an attacker cannot forge `from_me` rows) + the cage (own calendar, horizon <= 30 d, 5 min-4 h, >= 15 min ahead for creates, >= 2 h both slots for edits, quiet hours 22-07 -> fallback, no conflict, no duplicate, <= 2 edits/event, move <= 14 d, cancel only if `scope.cancels` and >= 24 h ahead).

`ActionExecutor.tryAuto(actionId)` (called by the orchestrator right after S4 for `create_event`/`update_event`, never `send_reply`): `inFlight` guard -> load -> policy -> `AutoGate` -> for updates the pre-flight `get-event` ownership + unchanged-since checks (snapshot kept for `pre_json`) -> sanity + fresh free/busy + `prepareArgs` + general rate limit + auto buckets -> **one transaction**: `auto_decisions {auto}`, `markApprovedExecuting(id, finalJson, now, decision.id)` (trigger verifies the JOIN), `auto_writes {pre_json}`, audits -> `runCreate`/`runUpdate` -> readback verify -> `post_*`, `revision_id`, `items.calendar_updated` -> toast + "Automatic" card -> breaker evaluation. A failed auto write becomes an ordinary pending card (the retry needs a click). Every `fallback` reason is shown on the card as an app string and never fed to a model.

### 7.4 Notification and undo
Toast with **app text only** ("An event was added automatically") + buttons **Undo** / **Show** (Electron 44.4.3 has Windows toast actions; activation on a clean VM is **UNVERIFIED U14**); main stores `{autoWriteId}` when it creates the toast and calls `executor.undoAuto(id,'user_toast')` on action index 0; `notifications:'off'` does not silence auto-write toasts (they are a control, not a convenience); bursts of 3+ in 10 min collapse into one summary toast. Dashboard gains an **"Automatic"** list (last 7 days) with Undo; Settings gains an **"Automatic activity"** page (decisions, fallback reasons, budgets used, validity left, export JSON metadata-only). Undo pre-check: `updated`/`etag` equals `auto_writes.post_*` (else `blocked_changed`, no automatic reversal), event not started (else `blocked_started` -> explicit "Cancel event"); idempotent; audited; 2 undos/24 h pause the policy.

---

## 8. Read-only WhatsApp MCP (D-040) - the feature fitted into 3.6 and I5'

- **Facade**: `bridge/waReadClient.ts` over four additive `SELECT`-only `BridgeDb` methods (`messagesBefore`, `messageByRowid`, `searchContent` with `instr()` bound parameters, `recentDmChats` by `MAX(rowid)`); rowid ordering; time windows filtered in TypeScript via `parseBridgeTs`; `SQLITE_BUSY` -> `[]`; DM JIDs only; chats with `policy='never'` or unknown senders (unless `processUnknownSenders`/`force_known`) invisible; audio rows surface only through their `transcripts` row (`kind:'voice'`); media-only rows dropped. No write method exists; no bridge HTTP client is imported.
- **Tools** (compile-time constants in the zod-first `toolDefs` table, LCD JSON derived once and frozen by the purity test): `wa_get_chat_messages` (2/run), `wa_search_messages` (3/run), `wa_get_message_context` (2/run), `wa_list_chats` (1/run, **exposed only in `all_chats` scope**). Handles `chat_N`/`m_N` are per run (trigger chat is always `chat_1`); unknown handle -> `blocked_bad_args` (no strike); in `trigger_chat` scope the gate pins `chat` to `chat_1` and a search omitting `chat` is pinned, not blocked. The reference server's 18 tool names (incl. `send_message`, `mark_messages_read`, `download_media`, `view_media`) and `mcp__wca__*` FQNs join `BLOCKED_NAMES`.
- **Scope**: `settings.whatsapp.readTools {enabled:true, scope:'trigger_chat', windowDays:30}`; choosing `all_chats` with a cloud provider active requires `CONSENT_VERSIONS.cloud_* = 2` ("messages from other chats may be read by the AI"). `[LR]` `wa_list_chats` ships but is reachable only under `all_chats`; if the judge prefers, cutting it costs nothing (whatsapp-mcp-readonly open question).
- **Server name** `wca` everywhere (Claude allow rule `mcp__wca__*`; future Antigravity rule `mcp(wca/*)`); tool name `wa_get_chat_messages` (not `wa_read_messages`).
- **Stage**: S3 only; S1 stays tool-less; the delta case reads older rows through S3's search -> context pattern on Local/API-key/Claude CLI; on agy (prefetch) the app widens `Ingest.contextFor` instead.

---

## 9. Event editing executor (D-036) - `update_event`

- **Server surface**: `ENABLED_TOOLS` = 8 names (+ `get-event` read class, + `update-event` write class); startup guard requires exactly those names, `readOnlyHint` on the four read tools, `destructiveHint:true` on `update-event`, and **`update-event.inputSchema.properties.status.enum` containing `"cancelled"`** (variant A below).
- **F1 decision (D-042 candidate) `[LR]`: vendored patch, one behaviour, fail closed.** Apply the editing research's two insertions (`status` enum on the schema, `requestBody.status` in `buildUpdateRequestBody`) plus the auto-mode research's `ifMatch` insertion (`If-Match` header on `events.patch`, 412 -> distinct error text -> `McpErrorKind 'precondition'`) to the isolated `build-resources/calendar-mcp` bundle in `scripts/stage-calendar-mcp.mjs`, guarded by a sha256 pin of the unpatched 2.6.3 bundle (refuse to patch other bytes or twice) and a sha256 pin of the patched output written to `vendor/calendar-mcp.pin.json`. If the startup guard finds no `status` field: **creates keep working, the update surface is disabled** (`CAL_UPDATE_UNAVAILABLE` health line; delta proposals degrade to the v1 `change_in_google` info card; auto edits impossible). No soft-cancel branch ships: two cancel semantics double the test surface and the soft variant does not satisfy the letter of D-036. Upstream PR to `nspady/google-calendar-mcp` filed so the patch can retire.
- **`McpWriteClient.updateEvent(args)`** with the exhaustive `UPDATE_EVENT_KEYS` (`calendarId, account, eventId, summary, start, end, timeZone, location, description?, status, sendUpdates:'none', checkConflicts:false, ifMatch, extendedProperties`), built key by key, always all five content fields (absolute patch), always the **complete** private map with `waAgent/waItem/waAction` copied from the pre-flight read (merge-vs-replace semantics **UNVERIFIED U15**) plus `waUpdate=<chain root>` and `waRev`. Never attendees, recurrence, `modificationScope`, `calendarsToCheck`, conference/attachments/reminders/colour/visibility/`guestsCan*`.
- **Approve gate for `update_event`** (executor, additions): `to` deep-equals `from` -> `ACTION_STALE`; pre-flight `get-event` -> `not_found`/`410`/readback `cancelled` (non-undo) -> `failed CAL_EVENT_GONE` + a pending `create_event` offered; tags not ours -> `failed CAL_EVENT_FOREIGN`; drift (readback != `from`) -> `needs_confirm_drift` with the action still pending and `ApproveReq.confirmDrift` on the second click; `baseRevision !== items.event_revision` -> `ACTION_STALE`; fresh free/busy minus the event's own block; `create_global` bucket; write-ahead; `updateEvent`; **`done` requires** `eventId === targetEventId && status === to.status && (cancelled || start/end === to)` else `unknown_outcome`; outcome transaction = `markDone` + `applyUpdateSuccess` (acting item -> `updated|cancelled` = `in_calendar`, source item `closed_reason='superseded'`, `event_revision+1`) + `event_revisions` insert + audit `event_updated|event_cancelled|event_reverted`.
- **T-401** closes with the editing research's rule: an edited retry of a `create_event` whose chain-root event is found becomes an `update_event` from the found content to the edited content.
- Card copy: "Change: Wed 15:00 -> 17:00" with `<bdi>` sides; **Approve change** / **Keep {from}**; **Cancel event** / **Keep it**; applied changes show `Updated - rev N` + **Undo**; the calendar list is keyed by `calendar_event_id` so an event never shows twice while a change is pending.

---

## 10. DB schema deltas (one migration, `v4`, table rebuild for the CHECK lists)

### 10.1 Tables and columns
```sql
-- items (rebuild): event_state CHECK += 'change_proposed','updated','cancelled'; closed_reason unchanged
ALTER items ADD linked_item_id INTEGER REFERENCES items(id);             -- delta -> source in_calendar item
ALTER items ADD event_revision INTEGER NOT NULL DEFAULT 0;
ALTER items ADD calendar_updated TEXT;                                    -- RFC3339 `updated` of OUR last write
ALTER items ADD trigger_kind TEXT NOT NULL DEFAULT 'text' CHECK(trigger_kind IN ('text','voice','image'));
-- actions (rebuild): kind CHECK += 'update_event'; approved_by TEXT (NULL until approve; 'user'|'user_toast'|<auto_decisions.id>) - frozen
-- proposals
ALTER proposals ADD delta_json TEXT; ADD blocked_calls INTEGER NOT NULL DEFAULT 0;
ALTER proposals ADD provider_class TEXT NOT NULL DEFAULT 'local' CHECK(provider_class IN ('local','api_key','cli_proven','cli_unproven'));
ALTER proposals ADD context_from_me_recent INTEGER NOT NULL DEFAULT 0; ADD cross_chat_rows INTEGER NOT NULL DEFAULT 0; ADD image_sha256 TEXT;
-- runs: stage CHECK += 'read_image'; ADD sandbox_ok INTEGER; ADD sandbox_json TEXT; ADD wa_rows_served INTEGER NOT NULL DEFAULT 0
-- chats
ALTER chats ADD auto_policy TEXT NOT NULL DEFAULT 'inherit' CHECK(auto_policy IN ('inherit','never','allow')); ADD auto_tainted_until INTEGER;
CREATE TABLE event_revisions (...);            -- editing research 3.3 (unique (calendar_event_id, revision))
CREATE TABLE auto_policies (...); CREATE TABLE auto_decisions (...); CREATE TABLE auto_writes (...);   -- auto-mode research 3.2 (+ ux_auto_policies_live)
CREATE TABLE transcripts (chat_jid, wa_msg_id, status CHECK IN ('done','empty','failed','aborted'), text, language, seconds, model_label, error_code, created_at, PRIMARY KEY(chat_jid, wa_msg_id)) WITHOUT ROWID;
CREATE TABLE media_cache (item_id, chat_id, wa_msg_id, sha256, width, height, bytes, created_at);
-- consents: kind CHECK += 'cloud_claude_cli','cloud_antigravity_cli','cloud_images','auto_mode'   (versions: all 1; cloud_claude/cloud_gemini bump to 2 only when all_chats is chosen)
-- model_files: ADD kind TEXT NOT NULL DEFAULT 'llm' CHECK(kind IN ('llm','mmproj','asr','vad'))
-- rate_events buckets += 'auto_chat','auto_global','cli_global','auto_dialog'
-- meta keys += calendar_access_role, cli_last_smoke_ts, cli_last_version, agy_last_version
-- audit kinds += cli_run, tool_session, event_updated, event_cancelled, event_reverted, auto_policy_enabled/shadow_ended/paused/resumed/disabled/expired, auto_decision, auto_write, auto_undo, auto_taint, media_rejected, voice_job
```

### 10.2 `trg_actions_state` v2 (binding text lives in contracts.md; semantics here)
The v1 CASE list is kept verbatim and gains, in this order before the `executing` rule: `approved` with `approved_by IS NULL` -> ABORT; `approved` on `send_reply` with `approved_by <> 'user'` -> ABORT (`'user_toast'` is not valid for sends: no send from a toast, ever); `approved` on a calendar kind with `approved_by NOT IN ('user','user_toast')` and `NOT EXISTS (SELECT 1 FROM auto_decisions d JOIN auto_policies p ON p.id=d.policy_id WHERE d.id=NEW.approved_by AND d.action_id=NEW.id AND d.verdict='auto' AND p.state='on')` -> ABORT. `trg_actions_frozen` adds `approved_by`. `auto_decisions`/`auto_writes`/`event_revisions` get append-only triggers like `audit_log` (`UPDATE` allowed only on the bookkeeping columns `revision_id`, `post_*`, `undo_*`, `reverted_by`).

### 10.3 Retention, backup, recovery
`transcripts.text`, `media_cache` files and thumbnails follow `privacy.retentionDays` (30) and are deleted immediately on Dismiss / "Never analyse this chat"; `auto_decisions` 90 d, `auto_writes` 180 d, `auto_policies` kept (consent history); `event_revisions.prev_json/next_json` nulled after 180 d (undo window is 72 h). Migration runs after the existing pre-migration backup; a v3 fixture round-trip test with rows in every state is a release gate. `data:purgeNow` also wipes `media-cache\`, `voice\tmp\`, `cli-runs\`.

---

## 11. IPC deltas (all zod `.strict()`, trusted frame, `Result<T, ErrorCode>`; no channel accepts a JID, path, URL, tool name, token or MCP argument)

| Channel | Request | Notes |
|---|---|---|
| `auto:getState` | - | policy summary, counters, shadow tally, budgets used, next expiry |
| `auto:requestEnable` | `{scope: AutoScope, trial: boolean}` | focused window + focus guard + rate 3/h + preconditions (7.1) + **native dialog in main**; the only path to a live policy |
| `auto:disable` | `{reason:'user'}` | no confirmation, works unfocused |
| `auto:endShadow` | `{confirm:true}` | >= 3 shadow decisions |
| `auto:resume` | `{confirm:true}` | after an automatic pause; focused window |
| `auto:undo` | `{autoWriteId}` | -> `executor.undoAuto(id,'user')` |
| `auto:listWrites` / `auto:export` | `{sinceTs}` / - | metadata + rendered fields from proposals; export JSON metadata-only |
| `item:undoChange` | `{itemId, revisionId}` | focused window; same gate as `action:approve`; the single undo path |
| `item:getImage` | `{itemId}` | normalised picture as a data URL (<= 400 KB); thumbnails ride on `dashboard:get` |
| `action:approve` | `+ confirmDrift?: true` | for `update_event`; `edit` for updates applies to `to` only (`title,startLocal,endLocal,location`) |
| `chat:setPolicy` | `+ {chatRef, autoPolicy:'inherit'|'never'|'allow'}` | per-contact opt-out/allow-list |
| `llm:cliStatus` | `{provider:'claude_cli'|'antigravity_cli'}` | `{installed, version, versionOk, loggedIn: boolean|null, lastSmokeOk, resetsAt?, usingOverage?}`; `auth status` polled at most once a minute |
| `llm:cliSignIn` | `{provider}` | opens a **visible console** running the vendor's own login (`claude auth login --claudeai` / `agy`); the app never sees the flow |
| `llm:agyTrustWorkspace` | `{confirm:true}` | one-time: shows the exact JSON diff (`trustedWorkspaces` += `<userData>\agy-workspace`) in a native dialog, backs up the file, read-merge-writes only that key, only when no `agy` process is running (5.3, B5) |
| `voice:getState` / `voice:retry` | - / `{itemId}` | tier, model status, bench; retry a failed transcript |
| `model:*` | `tier` enum += `voice-hebrew|voice-multilingual|voice-lite|voice-vad|mmproj` | never a URL |
| `settings:set` | schema of 12.1 | **no `auto` group exists**; `llm.provider` still cannot be set here (consent/validation path) |
| `consent:get/accept` | kinds += 4 | exact-version rule unchanged |
| `external:open` | targets += `claude_install_docs`, `agy_install_docs`, `antigravity_terms`, `claude_usage_docs` | hard-coded table only |

Push events: `auto:changed`, `cli:changed` (status pill incl. `resetsAt`), `voice:progress`, `dashboard:changed` (unchanged). The tool server and any MCP surface a CLI sees expose **no** `auto`, `settings`, `approve`, `write`, `send` or `undo` capability (test A18).

---

## 12. Settings, consent, onboarding deltas

### 12.1 Settings schema (one JSON value; additions only)
```ts
llm: { provider: z.enum(PROVIDER_IDS), claudeModel, geminiModel,
       cli: z.strictObject({ claudeModel: z.string() /* 'sonnet' */, agyModel: z.string() /* 'gemini-3.8-flash-medium' */,
                             maxRunsPerHour: z.number().int().min(1).max(60) /* 20 */, allowOverage: z.boolean() /* false */,
                             claudeExePath: z.string() /* '' = auto-resolve; must end in claude.exe */ }),
       local: {...unchanged}, cloudDailyTokenBudget },
whatsapp: { processUnknownSenders, backlogHours, readTools: z.strictObject({ enabled: z.boolean() /* true */, scope: z.enum(['trigger_chat','all_chats']) /* trigger_chat */, windowDays: z.number().int().min(1).max(90) /* 30 */ }) },
voice:    z.strictObject({ enabled: z.boolean() /* false until a voice model is ready */, tier: z.enum(['auto','voice-hebrew','voice-multilingual','voice-lite']), maxMinutes: z.literal(15), threads: z.enum(['auto']).or(z.number().int().min(1).max(16)) }),
images:   z.strictObject({ enabled: z.boolean() /* true */, cloud: z.boolean() /* true when a cloud provider is active (D-039); requires consent cloud_images */ }),
// NO `auto` group: automatic mode lives only in auto_policies (I10)
```
`SettingsPatchSchema` mirrors it; `settings:set` with an `auto` key is `BAD_REQUEST` + audit `ipc_rejected`.

### 12.2 Consents (versioned bilingual text shipped in the app; exact-version rule)
`cloud_claude_cli` v1 (subscription is used; message text incl. voice transcripts and, if enabled, pictures go to Anthropic under the user's consumer terms; Anthropic's policy has changed three times in 2026 and the app will show `CLOUD_AUTH` if it changes again; usage shares the user's 5-hour/weekly windows; overage is off by default). `cloud_antigravity_cli` v1 (Terms §6 quoted with date; account-suspension risk is the user's; the CLI stores prompts locally under `~/.gemini/antigravity-cli`; user-level hooks/MCP servers load in every run; the API-key route is Google's recommended path; experimental). `cloud_images` v1 (picture bytes leave the PC to the named vendor). `auto_mode` v1 (what will happen without approval, the limits, the undo window, the expiry, "replies still need your approval"). `cloud_claude`/`cloud_gemini` -> v2 only when `all_chats` is chosen.

### 12.3 Onboarding
Step 1 "Choose the AI" gains, above the API-key cards: **Claude via your subscription** (detect `claude.exe`; not installed -> the official install command shown as text to copy, the app never downloads or runs an installer; not signed in -> "Sign in" opens the vendor's own console flow; consent; then the smoke init run) and **Gemini via Antigravity (experimental)** hidden behind "Advanced" with the same detect/consent/trust-workspace steps. Automatic mode is **not** offered in onboarding at all (it needs three approved events first); voice and picture models are offered as optional background downloads on the Ready step with sizes shown (1.62 GB / 874 MB / 264 MB; projector 0.99 GB or 175 MB). The setup strip on the dashboard carries "Voice notes: model downloading 43 %" and "Automatic mode: trial - 2 of 3 decisions seen".

---

## 13. Packaging deltas

- **Not bundled, ever**: `claude.exe`, `agy.exe`, the Agent SDK (a bundled binary would need Commercial Terms and doubles the installer); detect only.
- **whisper.cpp** `b5130` `whisper-bin-x64.zip` (8,573,270 B, sha256 `f9ec6c52...5316f3c`) fetched at build time by `scripts/fetch-whisper.mjs` (clone of `fetch-llama.mjs`), `Release/` prefix stripped, explicit allow-list `whisper-cli.exe, whisper.dll, ggml.dll, ggml-base.dll, ggml-cpu-*.dll` into `resources/whisper/` (its own folder - whisper's ggml b5130 must never mix with llama's b10964), MIT text into `THIRD_PARTY_NOTICES.txt`, CRT DLLs staged beside it when `VC_REDIST_CRT_DIR` is set (same `LLM_VCREDIST_MISSING` pre-flight and exit-code mapping as llama). No Vulkan zip exists; v2 whisper is CPU-only.
- **Models on demand** through the existing downloader (HTTPS, one-hop `*.hf.co`, Range resume, streamed sha256, atomic rename): voice tiers (`ivrit-ai` turbo f16 1,624,555,275 B `c8090411...`; OpenAI turbo q8_0 874,188,075 B `317eb69c...`; small q8_0 264,464,607 B `49c8fb02...`; Silero VAD 885,098 B `2aa269b7...`, magic `GGML`) and the three `mmproj-F16.gguf` projectors at the v1 commits (985,654,080 / 990,372,672 / 175,115,840 B, magic `GGUF`); `pin-models.mjs` checks size + oid + first 4 bytes at pin time. The manifest rule "never download `mmproj-*`" is lifted for exactly these three pins.
- **Calendar MCP**: `stage-calendar-mcp.mjs` gains the vendored-patch step with two sha256 pins (unpatched 2.6.3 bundle, patched output) and fails the build on drift; the packaged smoke (`smoke-packaged.mjs`) asserts `tools/list` == 8 names and the `status` enum.
- **Dependencies**: + `opus-decoder@0.7.12` (MIT; transitive `@wasm-audio-decoders/common` MIT, `simple-yenc` MIT, `@eshaz/web-worker` Apache-2.0); + `jimp@1.6.1` only if `nativeImage` proves insufficient. `ogg-opus-decoder` (LGPL `codec-parser`), `sharp`, `ffmpeg`, `@discordjs/opus`, `node-opus` are added to the forbidden list; the D-022 package gate gains a **licence allow-list** (`MIT`, `Apache-2.0`, `BSD-2/3-Clause`, `ISC`, `0BSD`) for every production package. `npm audit --omit=dev` covers the four new packages.
- **electron-builder.yml**: `extraResources` += `{ from: vendor/whisper/win-x64-cpu, to: whisper, filter: [allow-list] }`; nothing unpacked; `npmRebuild:false` unchanged; fuses unchanged (`runAsNode` still required by the calendar child).
- **Test fakes shipped in the repo** (never vendor binaries): `tests/fakes/fake-claude.mjs` (reads `--mcp-config`, connects with the SDK client over Streamable HTTP, calls one `wa_*` tool and one forbidden name, prints canned `system/init` + `result`, honours `WCA_FAKE_CLI_MODE=extra_tool|api_key_auth|rate_limit|is_error_success|kill_me`), `tests/fakes/fake-agy.mjs` (`init` + `result`, modes `waiting|denied|no_structured|exit3`), `tests/fakes/whisper-cli.mjs` (copies a fixture JSON to `-of`; modes `slow|exit3|nojson|crash`), synthetic Ogg generator, 24 synthetic images. Installer growth: ~10 MB (whisper) + patched MCP bundle; models are downloads.

---

## 14. Security test gate v2 (release blockers, all against fakes; extends ARCH 18's twelve groups)

13. **I1' trigger table**: every forged `approved_by` (NULL, `'auto'`, a decision of another action, a decision whose policy is `shadow|paused|expired|disabled`, `'user_toast'` on `send_reply`) -> `RAISE(ABORT)`.
14. **Auto cage under the obedient attacker**: v1 corpus + 20 auto-mode cases with a live `on` policy -> zero sends; zero writes for non-known/tainted/`force_known` chats; <= `perChatPerDay` writes per known chat; every write has no attendees, `sendUpdates:'none'`, template description, target calendar, a decision + ledger row; zero `delete-event`; zero `update-event` on an untagged/foreign/attendee/recurring/user-modified event.
15. **AutoGate exhaustiveness**: table-driven, one row per `AUTO_REASONS` value, all-clear fixture -> `ok`; import graph excludes `agent/**`, `llm/**`, `ipc/**`.
16. **Toggle**: no `settings:set` path; unfocused / focus-guard / dialog cancel / no checkbox / `accessRole` writer-reader-absent / < 3 track-record creates / 4th request per hour -> no policy row; shadow never flips itself; snapshot change / unattended / budget / 2 undos / unknown_outcome -> paused.
17. **Undo**: create -> exactly one `{status:'cancelled', sendUpdates:'none'}`; update -> one patch with `prev_json` + full private map; drift -> `blocked_changed`, zero calls; started -> `blocked_started`; double undo -> one call; refused restore -> re-create with `approved_by='user'` and no decision row.
18. **CLI sandbox** (fake `claude.exe`/`agy.exe`): argv literally contains `--restricted --strict-mcp-config --tools ""` and never `--bare`/`--dangerously-skip-permissions`/`bypassPermissions`/`--add-dir`; env key set equals the allow-list literally; token in no argv, no file, no log; init mismatch (extra tool, extra server, `api_key` auth, agent mismatch, non-empty agy tools) -> kill + `toolset_mismatch` + no turn consumed; `is_error:true` with `subtype:'success'` -> failure; unknown `tool_use` -> strike; kill path calls `taskkill /PID /T /F`; run dir removed; `runs.sandbox_ok` recorded; a proposal with `provider_class='cli_unproven'` is never automatic.
19. **Tool server**: `tools/list` == exposed names with `readOnlyHint:true`; wrong/absent/expired token, `Host: evil.example`, any `Origin`, `GET`, body > 64 KiB -> 404/413 and zero gate calls; `address().address === '127.0.0.1'`; listener closed after the run (connection refused); per-run handles never leak between runs.
20. **WhatsApp read tools**: `BLOCKED_NAMES` incl. every reference-server name and `mcp__wca__*` FQNs; scope pinning; `wa_list_chats` blocked in `trigger_chat`; projection regex sweep (no JID, phone, message id, filename, clock time, `chats.name`); corpus vectors `wa_row` (`wr-exfil-other-chat`, `wr-instruction-in-history`, `wr-fake-end-block`, `wr-handle-forgery`, `wr-reference-tool-names`, `wr-bidi-query`, `wr-voice-transcript-injection`, `wr-jid-in-text`); S4 cross-chat leak guard.
21. **Media isolation**: hostile Ogg fixtures (bad CRC, wrong serial, truncated page, missing `OpusTags`, > 15 min granule, 65 MiB) -> `VOICE_*` errors, zero whisper spawns; hostile `filename` rows -> zero file reads; whisper argv never carries message text; `stdio[1]` ignored; JPEG/PNG bomb (26 MP header) rejected before decode; V1 argv/request builders carry no tools and no MCP config on every provider; 4 injection images -> `suspicious` -> `manipulation`; voice/image items -> `media_derived` fallback with a live policy.
22. **Editing executor**: drift, gone, foreign, stale `baseRevision`, readback mismatch -> `unknown_outcome`, reconcile by `get-event` never `list-events`, never re-patch; `never-delete` ledger assertion across the suite; toolset guard `status_field_absent` -> `CAL_UPDATE_UNAVAILABLE` with creates still working.
23. **Purity and payloads**: V1 prompt, `wa_*` defs, agent files, and `settings.auto`/policy state -> identical bytes; provider payload snapshots incl. tool results and image parts; `ANTHROPIC_*`/`GOOGLE_*` env poisoning of a CLI run -> stripped.
24. **Migration v4**: v3 fixture with rows in every state round-trips; all triggers re-created; section-18 consistency tests pass.
25. **Golden gates (per provider, before the delta path or images are default-on for that provider)**: edits >= 90 % `change` accuracy on the 18 non-injection rows; images >= 80 % exact date/time on printed he/en, all 4 injections `suspicious`; voice key-phrase gate he/en/mixed (decides the default voice tier).

---

## 15. Decisions requested from the orchestrator (record in `ops/DECISIONS.md`)

| ID (candidate) | Decision proposed here |
|---|---|
| D-042 | F1: vendored `status` + `If-Match` patch of `@cocal/google-calendar-mcp@2.6.3` with two sha256 pins and a fail-closed startup guard; no soft-cancel branch; update surface disables alone (`CAL_UPDATE_UNAVAILABLE`), creates keep working. |
| D-043 | I1'..I12 wording of section 2 replaces ARCH 2; A3 amended to "three resident children + short-lived jobs under the same supervisor/reaper primitives"; A10 rewritten to "WRITE = `create-event` + `update-event`, executor-only; `delete-event` never enabled". |
| D-044 | `actions.approved_by` = `'user'` / `'user_toast'` / decision id (no DEFAULT), trigger-verified; `tryAuto`/`AutoGate` design supersedes `v2-event-editing.md` 3.5; one undo path (`item:undoChange` over `event_revisions`); `auto_writes` is a ledger. |
| D-045 | Auto-mode preconditions and defaults: shadow first; >= 3 user-approved creates before enabling; user-participation check is a MUST; media-derived items never automatic in v2.0; auto unavailable with `antigravity_cli` and with any `cli_unproven` run; cancels off by default; overage off by default. |
| D-046 | A16 -> five endpoints: `POST /api/download` only from `media/locator.ts`, audio/image rows, after the 30 s wait; media bytes for voice and pictures come from the app-owned store file named by `messages.filename` (U12 fallback: `GET /api/media`). |
| D-047 | Vendor CLI contract: Claude Code spawned unmodified with the section 3.5 argv/env and the fail-closed init proof; never `--bare`, never bundled, never credential reads; `sandbox_ok` recorded per run. Antigravity ships opt-in, experimental, **no tools**, with the §6 consent; the app edits exactly one key (`trustedWorkspaces`) of the user's agy settings after a native dialog showing the diff, with a backup. |
| D-048 | Loopback tool server per run, in-process, our own Host/Origin/token guard, MCP server name `wca`, tool name `wa_get_chat_messages`; `wa_list_chats` exposed only under `all_chats`; LCD schema kept (ranges in descriptions + gate). |
| D-049 | Voice: whisper-cli per note (CPU zip b5130), default tier `hebrew` pending the golden set, `opus-decoder` + app demuxer (LGPL `codec-parser` forbidden), licence allow-list in the package gate. |
| D-050 | Pictures: V1 tool-less on every provider; the `--tools "Read"` fallback is not adopted (local fallback instead); Gemini pictures via API-key `inline_data` or local until `agy @path` is proven; consent `cloud_images`; mmproj F16 pins at the v1 commits. |
| D-051 | Provider ids `claude_cli`/`antigravity_cli` first-class, API-key `claude`/`gemini` under Advanced; consents +4; `LIMITS` additions of 3.4; `ErrorCode` additions of section 5; audit kinds of 10.1. |
| D-052 | T-401 closed by the edited-retry-becomes-update rule. |

---

## 16. UNVERIFIED register and the manual gates that close it (user-supervised; agents never run vendor binaries with the user's login)

| # | Claim | Posture in this design | Closed by |
|---|---|---|---|
| U2 | With `--tools ""` + `ENABLE_TOOL_SEARCH=false` the `mcp__wca__*` names appear in `system/init.tools` and nothing else does | fail closed; pin the observed set | one S3 smoke run with the real tool server (M-CLI-1) |
| U4 | agy `init.tools` empty with the `tools: []` agent on >= 1.2.11; trust gate does not hang headless | agy tool-less; auto unavailable with agy | user runs `agy -p --agent wca-draft --output-format stream-json --print-timeout 1m` in the trusted workspace (M-AGY-1) |
| U5 | agy persists the conversation; deleting `brain/<id>` tolerated | consent text says it is stored; dir untouched | M-AGY-1 |
| U9 | `system/init.apiKeySource` literal for subscription OAuth | env allow-list is the guarantee | read it in M-CLI-1, then assert |
| U11 | Defender prompt for the packaged app's loopback listener | v1 precedent (llama, calendar child) | packaged smoke |
| U12 | `messages.filename` populated for image rows | `getMedia()` fallback specified | first supervised launch: inspect the app-owned DB |
| U13 | `opus-decoder@0.7.12` imports/decodes under Electron 44 main; no `Worker`/`window` at import; DTX fixture yields no `errors[]` | Wave-0 probe like `node:sqlite` | Wave 0 |
| U14 | Windows toast buttons activate the packaged app (AppUserModelID + Start-menu shortcut) on a clean VM | Undo also on the dashboard card | packaged smoke on a clean Windows 11 VM |
| U15 | `events.patch` merges vs replaces `extendedProperties.private`; `location:''` clears; `status:'confirmed'` restores a cancelled event; retention of API-cancelled events | full map always sent; re-create fallback for undo-of-cancel | packaged smoke with a dummy event (never the user's real calendar during development) |
| U16 | Raw `claude -p --input-format stream-json` honours an `image` block with `--tools ""` and returns `structured_output`; `$PARAMETER_NAME` rate with an image | local fallback; zod + one repair retry | M-IMG-1 |
| U17 | `agy -p "... @path"` delivers pixels headlessly | not used | M-IMG-1b (only if the user installs agy) |
| U18 | Hebrew quality: whisper tier on English/mixed with forced `-l he`; Gemma 4 OCR on Hebrew; 4B `change` accuracy on terse Hebrew | golden gates decide defaults; delta path manual-only below 90 % | golden sets |
| U19 | CPU speed of whisper turbo f16 and of the E4B projector on the laptop target | background jobs with visible state; bench suggests tiers, never auto-switches | first-run bench |
| U20 | Authenticode signer of `claude.exe` launcher and versioned binary | advisory only | one `Get-AuthenticodeSignature` by the user |
| U21 | Claude/Antigravity subscription policy stability (Anthropic paused changes 2026-06-15; Google forum wording 2026-09-25) | providers pluggable; API-key fallback kept; `CLOUD_AUTH` state; consent text dated | re-read before each release; date stored in the consent record |

---

## 17. Rejected ideas (do not reintroduce without a decision)

| Idea | From | Why rejected here |
|---|---|---|
| Auto mode as a settings boolean | v2 request wording | any `settings:set` bug or renderer compromise flips it; a policy row is referenceable, expiring, snapshot-bound and DB-verifiable |
| `approved_by IN ('user','auto') DEFAULT 'user'` + `AutoApprover` with a fake `IpcContext` | editing research 3.5 | not verifiable by the DB; a DEFAULT hides a missing column write; `approve()` stays click-only |
| Auto-applying the re-create after an undo-of-cancel | editing research 3.3 | runs under the user's Undo click; never through `AutoGate` |
| Separate `undo_auto` action kind / second previous-version store | - | one undo path, one revision store, one reconcile |
| `--bare`, Agent SDK, `claude setup-token`, bundled CLI binaries, reading `~/.claude/.credentials.json` | claude-cli research | no subscription / policy and licence violations / credential intermediation |
| `--dangerously-skip-permissions`, `bypassPermissions`, `--add-dir`, `--tools "Read"` for pictures | image research fallback | the only configurations that give a vendor agent a file tool; local fallback instead |
| Antigravity with MCP tools in v2 | whatsapp-mcp-readonly draft | open bugs #548/#916; no strict-config; the 2026-09-25 forum wording targets exactly MCP + third-party agents |
| Editing `~/.gemini/antigravity-cli/settings.json` silently, or any key other than `trustedWorkspaces` | - | user's file; diff shown, one key, backup |
| Long-lived loopback listener with a token registry | whatsapp-mcp-readonly | per-run lifetime is simpler and leaves nothing open between runs |
| stdio MCP child spawned by the CLI; exposing the calendar MCP child to a CLI; bundling the Python reference server | cli-mcp-bridge, whatsapp-mcp-readonly | second gate / second process / send tools by design |
| Soft cancel (`[Cancelled]` prefix + transparent) as a shipped branch | editing research 1.6 B | two cancel semantics; does not meet D-036; fail closed instead |
| `delete-event` for cancel or undo | - | D-036; loses the id for undo |
| `whisper-server` as a 4th resident child; GPU whisper; local re-quantisation in v2.0 | whisper research | port with no auth; no Windows Vulkan zip; unverified determinism |
| `ogg-opus-decoder`, static ffmpeg, Chromium decoding in a hidden window, native Opus addons | whisper research 7.1 | LGPL / size / message content in a renderer / A1 |
| Webhook `mediaBase64`, reading the reference store, `/api/media` streaming as the primary path | image research 5.1 | doorbell must stay body-less; hard rule; one endpoint amendment is enough (U12 fallback kept) |
| Confidence thresholds as the main auto control | - | an attacker can make the model say "high"; the cage and provenance are the controls, confidence is a fallback trigger only |
| Auto replies, auto deletes, auto attendees, auto for strangers or `force_known` chats, auto from toasts/tray | - | D-037 and I1'/I9/I10 |

---

## 18. Honest weaknesses of this design

1. **Automatic mode still lets a known contact write to the user's calendar.** With every control in place, someone the user has written to in the last 24 h can, by message, add or move a bounded event on the user's own calendar within 30 days, a few times a day, with a toast and an Undo. That is the accepted residual of D-037; the misleading-title residual exists until the user reads the toast/card. "Unattended" is a focus heuristic, not proof the user read anything.
2. **The vendor CLI is trusted code we do not control.** `--tools ""`, `--restricted`, `--strict-mcp-config` and the init proof are documented switches of a self-updating binary whose docs already announce that `--bare` may become the default. The proof catches drift *we can observe* (tools, servers, plugins); it cannot see what the binary does with the user's `%USERPROFILE%` it must be given for OAuth. Same for `agy`, which also persists our prompts on disk and loads the user's hooks in every run.
3. **Policy risk is outside the code.** Anthropic's subscription stance changed three times in 2026; Google's forum answers contradict each other within eighteen days and are not the Terms. The user's accounts can be affected by using this feature; the app can only disclose, default to the safer option, keep the API-key path, and fail visibly.
4. **Six UNVERIFIED items sit on the critical path** (U2, U4, U12, U13, U16, U15) and can only be closed with the user present. Each has a fail-closed posture, so a "no" costs a feature (agy, Claude-CLI pictures, image bytes path), not safety - but the build cannot prove the happy path without those runs.
5. **The vendored calendar patch is a maintenance burden.** Two sha256 pins turn silent drift into a loud failure, and the update surface disables alone, but every server bump means re-applying and re-pinning a patch to a minified bundle until upstream accepts `status`/`If-Match`.
6. **Undo of a cancel depends on Google.** Restoring a cancelled event via `status:'confirmed'` is documented as possible but not as an API contract; the re-create fallback keeps undo possible at the cost of a new event id and a broken `waAction` chain for that event.
7. **More attack surface in the main process.** v2 parses attacker-supplied Ogg containers and image headers in TypeScript, runs a WASM decoder on attacker bytes, hosts a loopback HTTP listener, and reads a far larger slice of the bridge DB through tools. Each is bounded (caps, sniffing, 404, handles), none is process-isolated; capability separation stays module-level, as in v1.
8. **Cross-chat reading is a real expansion of I5 when the user opts in.** Handles and sanitisation hide identifiers, and the S4 guard stops verbatim leaks, but a model can paraphrase another chat's content into a draft. Default-off and consent v2 make it a conscious choice; they do not make it safe.
9. **OCR/ASR quality for Hebrew is unmeasured.** The literal-fields contract and the card's "as written" lines let the user catch errors before approval; automatic mode is denied to media items for exactly this reason. If the golden gates fail, pictures and voice may ship as "read-only context for the human", not as event sources.
10. **Product friction.** Shadow first, three approved events before enabling, per-chat 3/day, media never automatic, quiet hours, and a card that says "not automatic because ..." may make the mode feel like approval with extra steps. The reasons are shown so the behaviour is predictable; the heuristics that cause the most fallbacks (user-participation, user-echo) are measurable in shadow before they are tightened or relaxed.
11. **Two items per event while a change is pending** and one editable event per chat are simplifications the UI must carry (list keyed by `calendar_event_id`; "changes apply to the latest event of this chat").
12. **Migration v4 is a multi-table rebuild with trigger re-creation.** A mistake there corrupts the approval invariants; the pre-migration backup and the v3 fixture round-trip are the only nets.
13. **The human approving without reading still defeats everything** that is not automatic - and automatic mode formalises exactly that trade for one action class.
