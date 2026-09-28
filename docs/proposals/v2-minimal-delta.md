# v2 Architecture Proposal - MINIMAL-DELTA

Project: WhatsApp Calendar Agent v2 (Electron 44.4.3 + TypeScript, Windows 11 x64). Date: 2026-09-28.
Angle: **the smallest change to the verified v1 architecture that satisfies every locked v2 decision (D-036 .. D-040); reuse every existing seam; rewrite nothing that works.**
Inputs: `docs/ARCHITECTURE.md` (A1-A23, I1-I7, sections 3-11, 15-19), `docs/specs/{contracts,agent-pipeline}.md`, `ops/DECISIONS.md` D-001..D-041, `ops/CONTEXT.md` "v2 request", the eight research reports `docs/research/v2-*.md`, and the v1 sources named inline (`src/main/**`, `src/shared/**`). Every version, flag and vendor fact below is taken from those reports (each re-verified 2026-09-27/28); nothing was run against any vendor CLI, WhatsApp, Google or a model (hard rules).
Status: proposal for the v2 judge/design phase. Not binding until folded into ARCHITECTURE / contracts.

Reading rules: **KEEP** = a v1 mechanism reused unchanged; **EXTEND** = additive change to a frozen v1 signature, table or constant (needs a `[V2+]` line in `ops/DECISIONS.md`); **ADD** = new file/table/channel; **NEVER** = rejected for v2. Where the research reports disagree, section 1 records the choice and the reason. `UNVERIFIED` items are collected in section 16.

---

## 0. The delta in one table

The proposal's test of "minimal": every v2 capability must land on an existing seam, and the number of *new mechanisms* (a new gate, a new process kind, a new approval path, a new transport family) must be zero. Everything below is either an extension of a v1 mechanism or a new *instance* of one.

| v2 decision | v1 seam it lands on | What is new (ADD) | What grows (EXTEND) | What is NOT touched (KEEP) |
|---|---|---|---|---|
| D-036 event editing | `ActionExecutor` (one more `kind`), `McpWriteClient` (one more method), S1 flat schema (+3 fields), S2 pure TS (+1 resolver), ingest's "new open item while the last is `in_calendar`" path | `agent/existingEvent.ts`, `agent/resolveDelta.ts`, `exec/buildUpdateEventArgs.ts`, `event_revisions` table, `item:undoChange` | `MCP_TOOLS` +2 names, `actions.kind`, `items.event_state`, `proposals.delta_json`, `items.linked_item_id/event_revision`, `deriveState()` +3 values | ToolGate (the model never sees `get-event`/`update-event`), `trg_actions_*` semantics, `eventIdFor()` for creates, `create_event` path |
| D-037 automatic mode | `ActionExecutor` (auto path = `approve()` from the load step onward with no `IpcContext`), `trg_actions_state` (one more `WHEN`), `rate_events` (two more buckets), `Notification` (toast buttons exist in Electron 44.4.3), the undo of D-036 | `exec/autoGate.ts` (pure), `auto_policies`/`auto_decisions`/`auto_writes` tables, `ipc/handlers/auto.ts`, one native `dialog.showMessageBox` | `actions.approved_by`, `chats.auto_policy`, `proposals.blocked_calls`, `AUDIT_KINDS` +9, `RATE_BUCKETS` +2, tray status line | prompts, tool defs, `ToolGate`, `approve()`'s click contract, `send_reply` (never automatic) |
| D-038 subscription CLIs | `LlmProvider` (two more implementations), `factory.ts` (consent-first, cache), `proc/supervisor.ts` `taskkillArgs` + pid files + reaper, `proc/freePort.ts`, `agent/draft.ts` loop, `mcp/host.ts` patterns (`buildMcpEnv` allow-list, `verifyToolset` fail-closed, `stderrMarkersOf`) | `llm/cli/{locator,runner,claudeCli,antigravityCli}.ts`, `mcp/toolServer.ts` (loopback Streamable HTTP over the same `ToolGate`) | `PROVIDER_IDS` +2, `CONSENT_KINDS` +2, `LlmProvider.loop`/`runAgentic`, `LIMITS.cliWallClockMs`, `AUDIT_KINDS` + `cli_run`, `ErrorCode` +3, `settings.llm.provider` enum | S1-S4 stages, prompts (verbatim), `ToolGate.invoke()` steps 1-6, `ActionExecutor`, API-key providers (kept as "Advanced") |
| D-039 voice | `TriageQueue` (concurrency 1) + `orchestrator.runChat` (one step before S1), `ModelManager` (four more tiers, `GGML` magic), `BridgeReadClient` (one more endpoint), the llama VC++ pre-flight, `contextBuilder` data block | `voice/{ogg,decode,whisperCli,service}.ts`, `resources/whisper/`, `transcripts` table, `scripts/fetch-whisper.mjs` | A16 four -> six endpoints (`GET /api/media`, `POST /api/download`, one caller module), `Message.mediaType==='audio'` rows become triggers, `ModelTier` union, `ErrorCode` +6 | A3 (whisper-cli is a short-lived job, not a fourth supervised child), the LLM stages, prompts |
| D-039 pictures | `llama-server.exe` (same child, `--mmproj`), `LlmProvider.structured()` (one more call with an image part), S2 pure TS (one more branch), the same `getMedia()` as voice, `nativeImage` (already in main) | `agent/readImage.ts` (stage V1), `media/{normalizeImage,imageDims,mediaCache}.ts`, `media_cache` table, `IMAGE_READ_SCHEMA` | `LlmMessage.user.content` accepts an image part, `CallOpts.purpose` + `'read_image'`, `runs.stage` + `'read_image'`, manifest lifts "never download mmproj-*", `BADGES` +3, `item:getImage` | S1/S3/S4 builders (they never emit an image part), ToolGate (V1 has no tools), A3 |
| D-040 read-only WhatsApp MCP | `ToolGate` (a second transport over the same gate), `BridgeDb` (four more SELECTs), `sanitize`/`minimize`/`wrapDataBlock`, `toolDefs.ts` READ table | `bridge/waReadClient.ts`, `agent/waTools.ts`, `agent/handles.ts`, `mcp/toolServer.ts` (shared with D-038) | `READ_TOOL_NAMES` 2 -> 6, `RunCtx` + `handles`, `ToolGateDeps` + `wa`/`waAvailable`, `LIMITS` `draftToolCalls` 4 -> 6 / `draftTurnsWithTools` 3 -> 4 + `wa*`, `settings.whatsapp.readTools` | I2's shape (default-deny, sha8 audit, two strikes), the calendar MCP child (never exposed to a CLI), no send tool exists anywhere |

Counted: **0 new gates, 0 new supervised children, 0 new approval paths, 0 new native addons, 1 new transport instance** (loopback MCP over the existing gate), **1 migration** (v4), **4 new runtime npm packages** (all MIT/Apache/BSD, pure JS), **2 new vendored binaries** (whisper zip; the vendor CLIs are detected, never bundled), **1 vendored two-line patch** (calendar MCP `status`), **~14 new source files** in `src/main`, **8 new IPC channels + 1 push event**.

---

## 1. Decisions this proposal takes on the reports' open questions

One answer per open question, chosen by the minimal-delta rule (smallest mechanism that satisfies the locked decision; defer every SHOULD that is not needed for a MUST).

| # | Question (report) | Decision here | Why minimal |
|---|---|---|---|
| Q1 | D-042 candidate: express "cancelled" via a vendored `status` patch of `@cocal/google-calendar-mcp@2.6.3` or a soft cancel (`event-editing` 1.6, `auto-mode` 8.3) | **Vendored patch, `status` only (the two insertions of event-editing 1.6), sha256-pinned, fail-closed startup guard (`CAL_TOOLSET_MISMATCH` when `update-event.inputSchema.properties.status.enum` lacks `cancelled`). No `CANCEL_MODE` dual path, no `If-Match` insertion in v2.0.** | D-036's letter ("cancel = update with status cancelled") is locked, so the patch is required; a second soft-cancel branch doubles the executor tests for a case the guard already fails closed. `If-Match` is a third insertion plus a 412 mapping; the executor's pre-flight `get-event` + `baseRevision` compare-and-set + post-write readback already give compare-and-set at app level (residual TOCTOU window of one round-trip, section 14). File the upstream PR (SHOULD S9). |
| Q2 | Keep the confined `Read` tool on tool-less Claude CLI runs to dodge bug #87234? (`claude-cli-backend`) | **No. Strictly tool-less (`--tools ""`); accept the ~27 % first-attempt self-heal retry.** | One flag set for S1, V1 and the tool-less fallback; the CLI-side assertion `init.tools == []` stays a single literal. |
| Q3 | Default Claude model on subscription | **`sonnet` alias for S1/S3/V1, `--fallback-model haiku`.** Setting `llm.claudeCliModel` (regex-validated alias or id). | Opus 5.5 burns the shared 5-hour window and may be unavailable on Pro. |
| Q4 | Expose `resetsAt` / `isUsingOverage` in the UI | **Yes, as two optional fields on `AppHealth.llm`** (`resetsAt?: EpochMs`, `usingOverage?: boolean`); the pill says "Claude usage window resets at HH:MM". | Two fields on an existing object; no new channel. |
| Q5 | Verify the Authenticode signer of `claude.exe` before spawning | **No.** Resolve the exe by the documented paths only; version-gate; assert `system/init`. | UNVERIFIED that the launcher stub is signed; a PowerShell spawn per run for a same-user-trust check adds nothing the init assertion does not. |
| Q6 | Loopback HTTP vs stdio; per-run listener vs long-lived registry (`cli-mcp-bridge`, `whatsapp-mcp-readonly`) | **Loopback Streamable HTTP, stateless, one listener per run, closed in `finally`.** | No registry, nothing outlives the run; the same 404-after-run guarantee. |
| Q7 | Ship the Antigravity (`agy`) provider at all given the 2026-09-25 forum wording (`gemini-cli-backend`) | **Ship it as opt-in "Gemini via Antigravity CLI (experimental)", OFF by default, tool-less (`loop:'prefetch'`), behind consent `cloud_antigravity_cli` whose text quotes Terms §6 with its read date, the on-disk transcript and the user-level hooks/MCP config.** The API-key Gemini provider stays the documented Gemini path. | The user asked for the subscription; the prefetch loop is the *smallest* provider in the tree (no MCP server, no agentic loop: `structured()` + one no-tool completion). Auto mode is unavailable while it is active (Q14). |
| Q8 | agy prompts: reuse the v1 S1/S3 constants or a shorter variant (#947 ~55 KB hang) | **Reuse verbatim** (they are < 8 KB; the data block is capped by `contextChars` 6,000). | One prompt constant per stage for every backend (I4 purity test unchanged). |
| Q9 | Pictures on agy when `@path` is unverified | **Local vision (or `image_unread`) while `antigravity_cli` is active; the agy picture path is compiled out until M-IMG-1b.** | Zero code for an unverified mechanism. |
| Q10 | Who edits `trustedWorkspaces` in the user's `~/.gemini/antigravity-cli/settings.json` | **The provider setup screen, with the user's click, read-merge-write of exactly that one key, only when no `agy` process is running; shown as a diff.** No other key is ever written. | Needed for headless runs; one function, one test. |
| Q11 | Flash slug default; live model list | **`gemini-3.8-flash-high` for every stage; the settings dropdown is filled from `agy models` at settings time (never hard-coded).** | One setting `llm.antigravityModel`, same regex as the v1 model ids. |
| Q12 | MCP server name / tool name across reports | **`wca`; `wa_get_chat_messages`.** | Claude rule `mcp__wca__*`, Antigravity rule `mcp(wca/*)` (v2.1 only). |
| Q13 | Extend the LCD JSON-schema subset with `minimum/maximum`? | **No. Keep the v1 LCD; ranges in `description` + clamps in the gate; `toLcd()` throws on any non-LCD keyword.** | The I4 byte-identity test for the two calendar tools stays green without a shim. |
| Q14 | Automatic mode with a vendor CLI provider | **Allowed with `claude_cli` only for proposals whose run passed the `system/init` assertion (`runs.init_ok = 1`); never with `antigravity_cli` in v2.0 (`provider_unsafe`).** | The Claude assertion is a literal (`tools ⊆ mcp__wca__*`, `mcp_servers == [wca]`); the agy `init.tools` content is UNVERIFIED (U4). |
| Q15 | Who builds the fake `claude.exe` / fake `agy.exe` | **The CLI lane (`llm/cli/*`) owns `tests/fakes/fake-claude-cli.mjs` and `fake-agy.mjs`; the tool-server tests consume them.** | Same "scripted attacker" idea as v1's attacker provider. |
| Q16 | Golden edit cases location | **New `tests/golden/edits.jsonl`** (loader gains the file; per-language counts of the v1 files untouched). | No change to existing assertions. |
| Q17 | Auto-mode threshold for deltas; auto-apply the re-create after an undo? | **`changeConfidence==='high'` + `refersToExisting===true` + zero badges + `blocked_calls===0`; the re-create after a failed undo-of-cancel runs under the user's Undo click (`approved_by='user'`), never through AutoGate.** | Exactly the auto-mode M8/6.2 text; no special case. |
| Q18 | Close T-401 with the "edited retry of a found create becomes an update" rule | **Yes** - `offerRetryForUnknown` checks `findAppEvent` first; found + edited => `update_event` from the found content; found + unedited => `done` (as today). | The update machinery exists after D-036; ~20 lines in `exec/reconcile.ts`. |
| Q19 | One editable event per chat | **Yes (the newest `in_calendar` item with a `calendar_event_id`); UI copy says "changes apply to the latest event of this chat".** | Two live events per chat needs a disambiguation UI; deferred. |
| Q20 | A16 amendment for media | **Amend A16 from four to six endpoints: `GET /api/media` and `POST /api/download` are added, callable only from `src/main/media/fetch.ts` (import-graph test), only with regex-validated ids from `messages.db` rows.** Voice reads the `.ogg` through `/api/media` too - never from the store directory. | One client method pair serves voice AND pictures (the bridge's `/api/media` streams `voice-note.ogg` as well as `photo.jpg`, `bridge-contract.md` 3.8); the whisper report's `audioLocator` filesystem path (realpath prefix, filename regex, 30 s file wait) is deleted from the plan. |
| Q21 | Voice default tier | **`voice-hebrew` (ivrit-ai large-v3-turbo f16, forced `-l he`), decided finally by the he/en/mixed voice golden set; `voice-multilingual` is one click away.** | Per the WER evidence (0.071 vs 0.128 on WhatsApp Hebrew). |
| Q22 | whisper-cli per note vs whisper-server | **whisper-cli per note; the swap to a lazy fourth child is documented, not built.** | Keeps A3 at three supervised children. |
| Q23 | D-022 licence allow-list | **Yes: the forbidden-packages test gains an SPDX allow-list (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`) over every production package.** | ~15 lines in an existing test; blocks `codec-parser` (LGPL) forever. |
| Q24 | Who records the real Hebrew voice note for the golden set | **The user, as a manual release-gate item (M-VOICE-1).** Agents produce only synthetic fixtures. | Hard rule 1. |
| Q25 | Pictures: Local provider without the projector (`image-events` Q1) | **Raw card "Photo" with one action "Download picture reading (0.99 GB)"; no modal, no auto-download.** | Same pattern as the `MODEL_MISSING` card. |
| Q26 | `images.cloud` default when a cloud provider is active (`image-events` Q2) | **On, exactly as D-039 reads - but only once the provider's consent record is at version 2, whose text names pictures.** No separate `cloud_images` consent kind. | One consent bump per cloud kind covers transcripts, pictures and (when chosen) other-chat rows; three new consent kinds would be three dialogs for one data-flow decision. |
| Q27 | Thumbnails after the item closes (`image-events` Q3) | **Deleted by the same 30-day retention job that nulls message text; "Dismiss" and "Never analyse" delete them at once.** | One more `unlink` in an existing job. |
| Q28 | A separate `cli_extra_servers` / `tool_session` audit kind (`whatsapp-mcp-readonly` 12.7) | **No: `cli_run` carries `initOk`, `extraServers`, `toolCalls`, `blockedCalls`; the per-run token is never audited (not even hashed).** | One audit kind for the whole CLI run. |
| Q29 | SHOULD items of the auto-mode report (taint cooldown, user-participation, user-echo, allowlist mode, provider-change re-shadow, summary toast, tiny-tier caveat) | **Deferred to v2.1** except the summary toast for bursts (3+ writes in 10 min), which is a toast-fatigue safety property. | MUST list M1-M17 is complete without them; each SHOULD is a v2.1 ticket. |

Superseded sketches recorded for the orchestrator: `v2-event-editing.md` 3.5 (`approved_by IN ('user','auto') DEFAULT 'user'`, `AutoApprover` calling `approve()` with a fake `IpcContext`) is replaced by `v2-auto-mode-safety.md` 8.1/8.4 (decision-id binding verified by the trigger; `approve()` stays click-only); the WA report's Gemini CLI wiring is replaced by Antigravity no-tools mode; the `ToolSessionRegistry` variant is replaced by the per-run listener; `audioLocator.ts` is replaced by `/api/media`.

---

## 2. Process model changes

```
                                Windows 11 user session
+------------------------------------------------------------------------------------------------------+
| Electron MAIN (unchanged shape) - the only process with secrets/power                                 |
|  ... v1 blocks unchanged ...                                                                          |
|  Agent:  TriageQueue(1) -> [V0 transcribe] -> S0 -> [V1 read-image] -> S1 -> S2 -> S3 -> S4          |
|          ToolGate -> McpReadClient | WaReadClient(BridgeDb)   <- ONE gate, TWO transports:           |
|             (a) in-process tool loop (local / API-key providers)                                     |
|             (b) mcp/toolServer.ts  127.0.0.1:<rand>/mcp  bearer per run  (vendor CLI runs)  [ADD]    |
|  Exec:   ActionExecutor -> BridgeSendClient | McpWriteClient { createEvent, updateEvent }  [EXTEND]  |
|          + AutoGate (pure) + auto_* ledger                                                  [ADD]    |
|  LLM:    LlmProvider { local | claude | gemini | claude_cli | antigravity_cli }              [EXTEND]  |
|  Media:  media/fetch.ts (GET /api/media) -> voice/service.ts | media/normalizeImage.ts      [ADD]    |
+------+-----------------+----------------------+---------------------+----------------+---------------+
       | IPC             | spawn, REST+Bearer   | spawn, stdio        | spawn, HTTP    | short-lived JOBS (pid files, reaper, taskkill /T)
       v                 v                      v                     v                v
+------------+ +-------------------+ +----------------------+ +-----------------+ +--------------------------------------------+
| RENDERER   | | whatsapp-bridge   | | calendar MCP server  | | llama-server    | | whisper-cli.exe   (per voice note)         |
| unchanged  | | UNCHANGED         | | 2.6.3 + 2-line patch | | + --mmproj when | | claude.exe -p     (per S1/S3/V1 run)       |
|            | |                   | | ENABLED_TOOLS +2     | | images enabled  | | agy.exe -p        (per S1/S3 run, opt-in)  |
+------------+ +-------------------+ +----------------------+ +-----------------+ +--------------------------------------------+
                                                                                      user-installed CLIs: detected, never bundled
```

| Process | v1 | v2 change | Class |
|---|---|---|---|
| Bridge | always running | unchanged spawn contract; two more REST endpoints used by the app (`GET /api/media`, `POST /api/download`) | KEEP + A16 EXTEND |
| Calendar MCP | supervised child | `ENABLED_TOOLS` gains `get-event`, `update-event`; bundle carries the `status` patch (sha256-pinned); toolset check expects 8 names + `destructiveHint:true` on `update-event` + the `status` enum | EXTEND |
| llama-server | lazy supervised child | spawned with `--mmproj <file> --mmproj-device none --image-max-tokens 1120|560` (+ `--batch-size 2048 --ubatch-size 2048` on `mid`) when `images.enabled && mmprojReady`; toggling restarts it like changing acceleration; readiness additionally checks `/props.modalities.vision` | EXTEND (same child) |
| **whisper-cli.exe** | - | **short-lived job**, one per voice note, inside `runChat` (queue concurrency 1 => never concurrent with llama-server on the app's behalf); minimal env, `cwd` = bin dir, `stdio:['ignore','ignore','pipe']`, BELOW_NORMAL, pid file, `taskkill /PID /T /F` on abort, breaker 5/10 min | ADD (job, not a Supervisor child) |
| **claude.exe / agy.exe** | - | **short-lived job** per S1/S3/V1 run, one at a time (`CliRunner` mutex), pid file, reaper matches pid + exe path (the locator's resolved path is added to the reaper's accepted `exePath` set) + creation time, killed by PID only - never by image name (the user runs Claude Code interactively on the same PC) | ADD (job) |
| **Loopback tool endpoint** | - | in-process `node:http` listener, `127.0.0.1:<freePort>`, alive for one run (<= 120 s), closed in `finally`; not a process | ADD (in-process) |

A3 stays "exactly three supervised children". The three job kinds reuse `proc/supervisor.ts`'s `taskkillArgs(pid, true)` and pid-file scheme and `proc/reaper.ts` without new code paths; the only reaper change is the accepted exe-path set (`<resources>\whisper\whisper-cli.exe` plus the two locator-resolved CLI paths).

---

## 3. Provider abstraction changes (`src/main/llm/types.ts`, additive)

```ts
export type ProviderId = 'local' | 'claude' | 'gemini' | 'claude_cli' | 'antigravity_cli';   // [V2+] PROVIDER_IDS + 2
export type LlmImagePart = { type: 'image'; mime: 'image/jpeg' | 'image/png'; base64: string };
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | LlmImagePart> }   // [V2+] additive; S1/S3/S4 builders keep passing a string
  | ... (assistant / tool unchanged);
export interface CallOpts { signal; maxOutputTokens; purpose: 'extract' | 'draft' | 'read_image'; onUsage? }   // [V2+]

export interface AgenticRunInput  { system: string; user: string; specs: readonly ToolSpec[]; ctx: RunCtx; gate: ToolGate; maxTurns: number }
export interface AgenticRunResult { text: string; toolCalls: number; blockedCalls: number; initOk: boolean;
                                    stopReason: 'end' | 'max_turns' | 'aborted' | 'killed' | 'bad_output'; usage?: LlmUsage }
export interface LlmProvider {
  readonly id: ProviderId; readonly model: string;
  readonly loop: 'turn' | 'agentic' | 'prefetch';        // [V2+] turn = v1 (draft.ts owns the loop) ; agentic = claude_cli ; prefetch = antigravity_cli
  readonly capabilities: { images: boolean };            // [V2+] local (mmproj loaded) / claude / gemini / claude_cli = true ; antigravity_cli = false in v2.0
  structured<T>(messages, schema, opts): Promise<T>;     // unchanged contract ; CLI: one run, --json-schema, no MCP server, --max-turns 1
  chat(messages, tools, opts): Promise<LlmResponse>;     // unchanged ; loop:'agentic' throws LlmError('unsupported') - draft.ts branches on loop first
  runAgentic?(input: AgenticRunInput, opts: CallOpts): Promise<AgenticRunResult>;   // [V2+] claude_cli only
  validate(signal): ...;                                 // CLI: exe found + version floor ; NO login probe
  dispose(): Promise<void>;                              // CLI: kill any in-flight child
}
```

| | `claude_cli` | `antigravity_cli` |
|---|---|---|
| Binary | user-installed `%USERPROFILE%\.local\bin\claude.exe` (observed 2.1.258) or the npm layout's `claude.exe` (never the `.cmd`); `where.exe claude` as the last resort; **floor 2.1.221**; never bundled | `%LOCALAPPDATA%\agy\bin\agy.exe` (absent on the dev PC today); **floor 1.2.11**; never bundled |
| `structured()` (S1, V1) | `claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --restricted --disable-slash-commands --tools "" --strict-mcp-config --permission-mode dontAsk --disallowedTools <deny list> --max-turns 1 --effort low --model <alias> --fallback-model haiku --system-prompt <verbatim S1/V1 constant> --json-schema <schema>`; user message (text + optional image block) as ONE stdin line; `structured_output` -> the existing zod `.strict()` validation | `agy --agent wca-extract --model <slug> --effort low --output-format stream-json --json-schema <runDir>\schema.json --print-timeout <wall-10s> --disable-slash-commands -p "<user text>"`, `stdin:'ignore'`, `cwd` = the app's trusted workspace; agent file frontmatter `tools: []`, `commandExecutionPolicy: off`, `excludeDefaultComponents: true`, body = verbatim S1 constant |
| S3 draft | `loop:'agentic'`: `runAgentic()` starts `mcp/toolServer.ts` with `gate.exposedSpecs()`, then the same argv with `--mcp-config '{"mcpServers":{"wca":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer ${WCA_MCP_TOKEN}"}}}}' --allowedTools mcp__wca__* --max-turns <draftTurnsWithTools+1> --effort medium`; token only in the child env | `loop:'prefetch'`: the orchestrator runs `gate.prefetchFreeBusy()` (exists) + `gate.prefetchWaContext()` (new, same `execute` as `wa_get_chat_messages`, budget-free) and inlines both projections in the nonce block; then ONE no-tool completion through `structured()` with the `{reply}` draft schema |
| Fail-closed init assertion | `system/init`: `mcp_servers == []` (S1/V1) or `[{wca, connected|pending}]` (S3); `plugins == []`; `mcp_server_errors` absent; `tools ⊆ {mcp__wca__<exposed names>}` (S3) or `== []` (S1/V1); else kill + audit `toolset_mismatch {provider, reason}` + `CLI_TOOLSET_MISMATCH` | `init.agent === 'wca-<stage>'`, `init.tools == []` (record the observed set in the first smoke run, U4), `init.permission_mode === 'request-review'`; `status:'WAITING'` or non-empty `denied_actions` => `LLM_BAD_OUTPUT` + strike |
| Result check | `is_error` FIRST (issue #79500), then `subtype==='success'`, `stop_reason!=='refusal'`, `structured_output` present when a schema was passed; `rate_limit_event` -> `AppHealth.llm.resetsAt/usingOverage`; `api_retry.error` -> `authentication_failed|oauth_org_not_allowed|account_on_hold` => `CLOUD_AUTH` (new `ErrorCode`), `rate_limit|overloaded` => backoff, `model_not_found` => `MODEL_NOT_FOUND` | exit 0 + `status==='SUCCESS'` + `structured_output` + empty `denied_actions`; exit 1 + `authentication required` => `CLOUD_AUTH`; exit 3 + `AGY_ERROR:` line => regex classification (`RESOURCE_EXHAUSTED|429|quota` => `CLOUD_QUOTA`), else `CLOUD_UNAVAILABLE` |
| Env (allow-list, asserted literally by a test like `buildMcpEnv`) | `SystemRoot, PATH(=System32), TEMP/TMP(=runDir), USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, WCA_MCP_TOKEN, MCP_TIMEOUT=10000, MCP_TOOL_TIMEOUT=25000, ENABLE_TOOL_SEARCH=false, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, DISABLE_TELEMETRY=1, DISABLE_ERROR_REPORTING=1, DISABLE_AUTOUPDATER=1, DISABLE_BUG_COMMAND=1, CI=1`; **never** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_*`, the bridge token, the doorbell secret, the llama key | `SystemRoot, PATH, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/TMP, AGY_CLI_DISABLE_AUTO_UPDATE=true`; never `GEMINI_API_KEY` |
| cwd | fresh empty `<userData>\cli-runs\<runId>\`, deleted in `finally` | `<userData>\agy-workspace\` (trusted once, section 9), per-run subfolder for the agent file / schema, deleted in `finally` |
| Wall clock / abort | `LIMITS.cliWallClockMs` 120 s (S3) / 60 s (S1, V1); `AbortSignal.any` as `draft.ts`; `child.kill()` then `taskkill /PID /T /F` after 500 ms; `toolServer.close()`; run dir removed | same + `--print-timeout` = wall clock - 10 s (the CLI has no default timeout since 1.2.6) |
| Consent (`factory.ts` `assertConsent`) | `cloud_claude_cli` v1: "runs the Claude Code you installed under your own sign-in; Anthropic processes the text under the consumer terms; Anthropic's subscription policy has changed three times in 2026; usage counts against your 5-hour/weekly window" | `cloud_antigravity_cli` v1: the §6 text + read date, "may be used to improve Google products unless opted out", "agy stores the (role-labelled, sanitised) prompt under ~/.gemini/antigravity-cli/brain", "your user-level hooks and MCP config load in every run (they receive metadata, never a tool call: the agent has no tools)" |
| Sign-in | never performed by the app: `cli:openSignIn` launches a visible console `cmd /k "<claude.exe>" auth login --claudeai`; the settings pill polls `claude auth status --json` (`loggedIn` only) at most once a minute | `cmd /k "<agy.exe>"` (interactive first run does the OAuth); probe `agy -p "/usage" --output-format json` (exit 0 = logged in; the JSON is displayed as-is, never parsed into fields) |
| Model list | aliases `default/best/fable/opus/sonnet/haiku` shown as ordering hints; free text id allowed | `agy models` output parsed defensively into a dropdown |
| Secrets | none (`SECRET_FOR` has no entry; `factory.usable()` checks `cliLocator.find(id)` + floor + consent instead of a key) | none |

`draft.ts` delta (the only pipeline file that learns about `loop`): `if (provider.loop === 'agentic') return runAgenticDraft(...)` (one function: start server -> `runAgentic` -> map `AgenticRunResult` onto the existing `DraftOutcome`, strikes -> `manipulation` exactly as the in-process loop) and `if (provider.loop === 'prefetch') { ... one turn with tools: [] ... }`. `cleanDraft()`, `blockedCallsAbort`, the wall-clock abort and S4 are byte-identical for all five providers.

`factory.ts` delta: `CONSENT_KIND_FOR` +2, `SECRET_FOR` unchanged (typed as `Exclude<ProviderId, 'local'|'claude_cli'|'antigravity_cli'>`), cache key for CLI providers = `id|model|exePath|version`, `invalidate()` kills any in-flight CLI child. "Never silent fallback" (A20) holds: a CLI that is not installed / not logged in / too old is `held/waiting_llm` with the matching `ErrorCode` (`CLI_NOT_INSTALLED`, `CLOUD_AUTH`, `CLI_VERSION`), never a switch to the API-key provider.

---

## 4. Pipeline changes

```
Ingest.scan() -> S0 -> triage_queue -> orchestrator.runChat(chat):
   V0 TRANSCRIBE   for each live audio row without a transcripts row: voice.transcribe()          [ADD; local always; before S1]
   V1 READ-IMAGE   if the newest unread image row is in the window: readImage()                    [ADD; tool-less; result = value object]
   S1 EXTRACT      provider.structured(context + app_context.existing_event, EXTRACTION_SCHEMA+3)  [EXTEND: 3 fields, 1 addendum, existing_event in the data block]
   S2 RESOLVE      resolveExtraction() | resolveDelta() | image_absolute branch                    [EXTEND: 2 pure branches]
   S3 DRAFT        loop:'turn' (v1) | 'agentic' (Claude CLI over the tool server) | 'prefetch' (agy)   [EXTEND: draft.ts branch]
   S4 VALIDATE     + update_event action, + change_unclear/from_image/image_unclear badges, + cross-chat leak guard, + blocked_calls persisted   [EXTEND]
   -> proposals + actions (pending) -> executor.tryAuto(actionId) [ADD] -> card | automatic write
```

### 4.1 V0 transcribe (D-039 voice; always local)
- Trigger: `ingest.toMessage()` keeps `media_type='audio'` rows as `Message{text:'', mediaType:'audio'}`; `isNeverTrigger()`/`isNeverTriggerRow()` stop dropping them (`sticker`/`video`/`document` stay context-only). `BridgeDb.ROW_COLUMNS` needs no `filename` (bytes come from `/api/media`).
- Steps (`voice/service.ts`): `media/fetch.ts getMedia(chatJid, waMsgId, {maxBytes: 64 MiB})` (404 -> one `requestDownload()` -> one retry 10 s later -> else `VOICE_AUDIO_MISSING`, `TriageRetryError`) -> `voice/ogg.ts demuxOggOpus()` (app-authored RFC 3533/7845 demuxer, CRC-checked, single-stream, 64 MiB cap, duration from the last granule BEFORE decoding; > 15 min => `VOICE_TOO_LONG`) -> `voice/decode.ts` (`opus-decoder@0.7.12`, 16 kHz mono Float32 -> PCM16 WAV, 44-byte header written by the app) -> `voice/whisperCli.ts` (`whisper-cli.exe -m <model> -f <wav> -l he|auto -t <threads> -oj -of <tmp> -np -nt --vad --vad-model <silero> --vad-threshold 0.5 --vad-min-speech-duration-ms 250 --vad-min-silence-duration-ms 400 --vad-speech-pad-ms 60 --vad-max-speech-duration-s 30 -bs 5 -bo 5 -tp 0 -et 2.4 -sns`; timeout `clamp(30 s, 4 x seconds x benchFactor, 600 s)`; exit 3 => `VOICE_MODEL_MISSING`; `-1073741515` => `LLM_VCREDIST_MISSING` (reused); no JSON => `VOICE_DECODE_FAILED`) -> `transcripts` row (`done|empty|failed|aborted`, `text`, `language` validated `^[a-z]{2,3}$`, `seconds`, `model_label`).
- Into S1/S3: the row enters the existing nonce data block as `{from, ago, source:'voice_transcript', language, text}` after `sanitizeForModel` + `LIMITS.messageChars`; empty transcript => never a trigger. The system prompt is untouched (prompt purity test extended to the transcript field).
- Models via the existing `ModelManager`: `ModelManifestEntry` gains `kind: 'llm'|'asr'|'vad'` and `magic: 'GGUF'|'GGML'`; tiers `voice-hebrew` (ivrit-ai `ggml-model.bin` 1,624,555,275 B, sha256 `c8090411…8641b1`), `voice-multilingual` (`ggml-large-v3-turbo-q8_0.bin` 874,188,075 B, `317eb69c…e259a1`), `voice-lite` (`ggml-small-q8_0.bin` 264,464,607 B, `49c8fb02…7779bf`), `voice-vad` (`ggml-silero-v6.2.0.bin` 885,098 B, `2aa269b7…b6987`); `pin-models.mjs` re-checks size + sha + first 4 bytes (`6c 6d 67 67`).
- Cost of the step on the queue: a long note delays the next chat by its transcription time; accepted (queue stats already expose `running`).

### 4.2 V1 read-image (D-039 pictures)
- Trigger: an image row (`media_type='image'`, bytes sniffed `FF D8 FF` / `89 50 4E 47`) with or without caption is a trigger when `settings.images.enabled`. One image per run (the newest unread in the window). Bytes: the same `getMedia()`; `media/imageDims.ts` (JPEG SOF / PNG IHDR; reject > 10 MiB or > 25 MP) -> `media/normalizeImage.ts` (Electron `nativeImage`: long edge 1536, `toJPEG(85)`, 320-px thumbnail data URL; `jimp@1.6.1` is the only permitted pure-JS fallback, added only if the fixture tests show a `nativeImage` gap) -> `<userData>\media-cache\<sha256(chatJid|waMsgId)>.jpg` + `media_cache` row.
- Provider routing (`agent/readImage.ts`): the active provider when `provider.capabilities.images && settings.images.cloud && consent current` (Claude API image block; Gemini API `inline_data`; `claude_cli` stdin image block first, text second, `--tools "" --max-turns 1`, init `tools == []` asserted); otherwise the local provider if `mmprojReady`; otherwise badge `image_unread` + raw card with the download action. `antigravity_cli` reports `images:false` in v2.0. The picture run **never** carries an MCP config (argv snapshot test).
- Call = `provider.structured(messagesWithImagePart, IMAGE_READ_SCHEMA, {purpose:'read_image', maxOutputTokens: 768})` -> zod `ImageRead.strict()` (flat, sentinels `0/24/7`, no nulls) -> one repair retry -> `LLM_BAD_OUTPUT` (raw card with thumbnail). V1 system prompt = the verbatim constant of `image-events` 4.3 (copy-never-compute, `suspicious` on instructions inside the picture). No new provider interface: V1 is one more `structured()` call.
- Merge: `readText` enters S1's data block as `imageText` on the trigger row (S1 rule 1 gains one constant sentence); `day/month/year/weekday/hour/minute/endHour` feed `resolve.ts`'s new `image_absolute` branch (code computes the ISO date; S1's own resolved date wins when present and disagreement => `conflict` badge; weekday word vs digits mismatch => `image_unclear`). Badges: `from_image` (info) always, `image_unclear` (amber) on `confidence:'low'|readable:false`, `manipulation` (red) on `suspicious`. Stored as `proposals.image_json` for the card. V1 failure never blocks S1 (text-only run + `image_unread`).

### 4.3 S1 extension (D-036)
- `agent/existingEvent.ts findExistingEvent(repos, chatId, nowMs)`: newest `in_calendar` item of the chat with `calendar_event_id IS NOT NULL`, `event_state IN ('created','updated')`, `event_start_ts >= now - 24 h`; `items.linked_item_id` is set on the new open item before S1 (re-evaluated per re-triage). The event (title/location = contact-derived text, dates app-computed) is injected as `app_context.existing_event` **inside** the nonce data block; `eventId`, item ids, JIDs never.
- `EXTRACTION_JSON_SCHEMA` += `refersToExisting: boolean`, `change: enum(no_change|reschedule|move|cancel|new_event)`, `changeConfidence: enum(high|medium|low)`, `confidence: enum(high|medium|low)` (the auto-mode self-report for creates); all four required; the few-shots gain them with null-event defaults; the S1 addendum of `event-editing` 2.4 (rules 10-12 + four examples) is appended as a byte constant; CLI runs get the one extra constant line "Return the JSON object only, on one line, no markdown" and `extract.ts` strips one leading/trailing code fence before `JSON.parse`.

### 4.4 S2 extension
- `agent/resolveDelta.ts` (pure): inherit date/time from the trusted event; nearest-hour disambiguation for an ambiguous hour near the existing start; sanity as v1; `to === from` => `no_change`; `cancel` with a named new slot => `reschedule`; `move` = location only; `changeConfidence:'low'` => no delta + `change_unclear` badge + the draft asks; free/busy prefetch for the new slot minus the block equal to `from`. Output `EventDelta {kind, targetEventId, sourceItemId, baseRevision, from, to, assumptions, problems, confidence}`.
- `image_absolute` branch (4.2). No other S2 change; `resolveWhen()` untouched.

### 4.5 S3 / S4 extension
- S3 prompt addendum rule 8 (acknowledge the change, never claim the calendar is updated) as a constant; the `app_computed` object gains `delta`. `draft.ts` branches on `provider.loop` (section 3); tools offered = `gate.exposedTools()` (calendar + `wa_*`, section 6).
- S4: insert `update_event` when `delta && calendarConnected && confidence !== 'low' && existing.status === 'confirmed'` (`create_event` and `update_event` mutually exclusive per proposal); badges `change_unclear`, `from_image`, `image_unclear`, `image_unread` added to `BADGES`; `change_in_google` retired (kept in the enum for old rows); `proposals.blocked_calls` persisted for AutoGate; cross-chat leak guard (24-char rolling window of any other-chat row text in the draft => `manipulation`, only reachable in `all_chats` scope); then `executor.tryAuto(actionId)` for each pending calendar action (section 5).

---

## 5. Automatic mode: policy, executor, undo (D-037)

The approval path is not duplicated. `tryAuto()` is `approve()` from the "load action" step onward with two substitutions: no `IpcContext`/`shownHash`/`edit`, and `approved_by = <auto_decisions.id>` instead of `'user'`. Everything below the write-ahead (`runCreate`/`runUpdate`, outcome CAS, reconcile, audit) is the same code.

### 5.1 Policy record (the toggle is a row, not a boolean)
- `auto_policies` (section 7): exactly one live row (`shadow|on|paused`), `expires_at` (30 d default, 90 max), `shadow_until` (24 h), `confirmed_by:'native_dialog'` + `confirm_json`, `scope_json` (zod `strictObject` with hard ceilings: `horizonDays<=30`, `maxMinutes<=240`, `perChatPerDay<=3`, `globalPerDay<=15`, `knownContactsOnly: literal true`, `creates: literal true`, `edits`, `cancels` default false, `quietHours` default 22-07, `validityDays 30|90`), `snapshot_sha` = sha256 of `{targetCalendarId, googleAccountSha8, provider, appMajor}`.
- Enable only via `auto:requestEnable` from a focused, visible window outside the focus guard, calendar connected and `accessRole === 'owner'` for the target calendar (cached in `meta.calendar_roles_json` from the last `list-calendars`; absent => not owned), then a **main-owned** `dialog.showMessageBox(win, {defaultId:0, cancelId:0, checkboxLabel, buttons:[Cancel, Start trial|Enable now]})`; rate-limited 3/h. No `settings:set` path (the strict patch schema has no `auto` group).
- Pause automatically (`paused_reason`) on: snapshot change, calendar disconnect, any auto budget hit, 2 undos / 24 h, any `unknown_outcome`, 7 days without window focus; resume = one click in a focused window. Expiry => `expired` + banner. Disable = one click from settings, tray or the activity page, no confirmation.
- Shadow is the default first state: decisions are recorded with `verdict:'shadow'`, the card shows `auto_shadow` and the user approves as in v1; `auto:endShadow` needs >= 3 shadow decisions and a click; nothing switches itself on.

### 5.2 AutoGate (`exec/autoGate.ts`, pure, LLM-free, import-graph-tested against `agent/**` and `llm/**`)
Evaluates, in order, the exhaustive `AUTO_REASONS` of `auto-mode` 5.5 (`no_policy`, `policy_shadow`, `policy_paused`, `policy_expired`, `snapshot_changed`, `calendar_disconnected`, `calendar_not_owned`, `unknown_contact` (`is_known` only; `force_known` does not count), `chat_opted_out`, `badge_red|amber|info`, `blocked_tool_call`, `suspicious`, `assumed_hour`, `missing_fields`, `low_confidence`, `intent_not_eligible`, `title_rejected`, `media_derived` (voice/picture items never auto in v2.0), `provider_unsafe` (Q14), `beyond_horizon`, `too_long`, `too_soon` (15 min create / 2 h edit both slots), `quiet_hours`, `conflict`, `duplicate`, `auto_budget`, `edits_not_in_scope`, `cancel_not_in_scope`, `cancel_too_soon` (< 24 h), `not_app_event`, `wrong_item`, `not_own_copy`, `event_has_attendees`, `event_cancelled`, `modified_in_google`, `move_too_far` (> 14 d), `edit_budget` (> 2 auto edits per event), `unknown_prev_state`). Any failure => `verdict:'fallback'` + the reason shown on the ordinary v1 card ("Not automatic: ..."); never fed to the model.

### 5.3 Executor delta (`exec/actionExecutor.ts`, additive)
```ts
tryAuto(actionId): Promise<AutoDecision>;                 // called by the orchestrator after S4 for create_event / update_event only
undoAuto(autoWriteId, by: 'user'|'user_toast'): Promise<Result<ApproveOutcome>>;   // toast button + activity page ; drives item:undoChange
// deps += autoPolicy(): LiveAutoPolicy|null ; autoRate: AutoRateLimiter (buckets auto_chat 1/30min,2/h,3/d ; auto_global 4/h,15/d) ; windowFocusedRecently()
```
Order: `inFlight` guard -> load, kind, state, expiry -> policy state -> `AutoGate.evaluate()` -> for `update_event`: the same pre-flight `get-event` the manual path runs (drift/gone/foreign) plus ownership (`waAgent==='1'`, `waItem === String(items[deltaItem.linked_item_id].id)`, same `chat_id`, `creator.self`, no attendees/recurrence, `status !== 'cancelled'`, `updated` equals our last recorded write) - every failure is a fallback, never `needs_confirm_drift` -> `eventSanity` + auto bounds -> fresh free/busy -> `prepareArgs` -> general + auto rate check -> **one transaction**: `auto_decisions {verdict:'auto'}`, `markApprovedExecuting(id, finalJson, now, decision.id)` (the trigger verifies the join), `auto_writes {pre_json}`, audit `action_approved {by:'auto'}` + `auto_decision` -> `runCreate`/`runUpdate` (no retry clone on failure: a failed auto write becomes an ordinary pending card) -> post-write `get-event` (`post_etag/updated/sequence`, `revision_id`) -> toast + `dashboard:changed` + `autoRate.record` + breaker evaluation.

### 5.4 update_event and undo (D-036, shared by manual and automatic)
- Payload `UpdateEventPayloadSchema` (event-editing 4.1): `targetEventId` pinned from `items.calendar_event_id` at proposal time (regex `^[a-v0-9]{5,1024}$`), `targetItemId`, `baseRevision`, `change: reschedule|move|cancel|undo`, `from`, `to` (+`status`), `revertOf?`; `applyEdit` touches `to` only.
- `McpWriteClient.updateEvent(UpdateEventArgs)` built key by key from `UPDATE_EVENT_KEYS = [calendarId, account, eventId, summary, start, end, timeZone, location, description, status, sendUpdates, checkConflicts, extendedProperties]`: always an absolute patch of all five content fields, `sendUpdates:'none'` (server default is `'all'`), `checkConflicts:false`, the full private map `{waAgent, waItem, waAction, waUpdate, waRev}` with the three identity values copied from the pre-flight read. Never attendees/recurrence/modificationScope/originalStartTime/futureStartDate/calendarsToCheck/conferenceData/attachments/reminders/colorId/visibility/transparency/guestsCan*/anyoneCanAddSelf.
- `McpReadClient.getEvent(calendarId, eventId)` (read class, app-side only, `fields: [etag, updated, sequence, status, creator, organizer, attendees, recurrence, recurringEventId, extendedProperties]`) -> `OwnedEventProjection`; raw server text never leaves `projection.ts`.
- Manual approve gate order for `update_event` = event-editing 4.3 (pre-flight: gone => `failed CAL_EVENT_GONE` + a pending `create_event` with `to`; foreign => `CAL_EVENT_FOREIGN`; drift => `needs_confirm_drift` with `ApproveReq.confirmDrift`; `baseRevision` mismatch => `ACTION_STALE`); `done` requires readback `eventId === targetEventId && status === to.status && (cancelled || start/end equal)`; else `unknown_outcome`; the outcome transaction also writes `event_revisions` + `applyUpdateSuccess` (acting item -> `updated|cancelled`, source item -> `closed_reason='superseded'`).
- Idempotency: absolute PATCH on a fixed id + `waUpdate` tag + `baseRevision`; `reconcileUpdate` uses `get-event` (never `list-events`: cancelled events are invisible to it); stale clones => `superseded`.
- Undo = `item:undoChange {itemId, revisionId}` (trusted frame, focused window, same gate as `action:approve`): newest revision, not reverted => new proposal (provider `'user'`) + pending `update_event {change:'undo', from: next_json, to: prev_json, revertOf}` approved immediately through `approve()` with `approved_by 'user'|'user_toast'`. Undo of a cancel = `status:'confirmed'` + prev fields; if Google refuses (404/410/readback cancelled) => `CAL_EVENT_GONE` + a pending `create_event` "Add it back" (user click). `auto_writes` adds only bookkeeping (`undo_state`, `undo_until = min(written_at + 72 h, event end)`, `undo_action_id`) and a pre-check that `updated/etag` still equals `post_*` (`blocked_changed` otherwise; `blocked_started` after the event began).
- Toast (`app/notifications.ts`): app text only, buttons **Undo** / **Show** (Electron 44.4.3 has Windows toast actions, PR #48132); `action` index 0 => `executor.undoAuto(id, 'user_toast')` with the id main stored when it created the toast; `notifications:'off'` does not silence auto-write toasts; 3+ writes in 10 min => one summary toast. Dashboard gains an "Automatic" list (last 7 days) above the three v1 lists; Settings gains an "Automatic activity" page with export (metadata only).

### 5.5 I1' trigger text (binding DDL in section 7)
`approved` requires `approved_by`; `send_reply` requires `'user'`; a calendar write requires `'user'|'user_toast'` **or** `EXISTS(SELECT 1 FROM auto_decisions d JOIN auto_policies p ON p.id=d.policy_id WHERE d.id=NEW.approved_by AND d.action_id=NEW.id AND d.verdict='auto' AND p.state='on')`. `approved_by` joins the frozen column list of `trg_actions_frozen`.

---

## 6. Read-only WhatsApp MCP (D-040) = a second transport over the same ToolGate

```
local / API-key providers:   draft.ts loop --> ToolGate.invoke(call, ctx) --+--> McpReadClient (calendar child)
                                                                            +--> WaReadClient  (BridgeDb, in-process, read-only)
vendor CLI (claude_cli):     claude.exe --HTTP--> mcp/toolServer.ts (127.0.0.1:<port>/mcp, bearer) --> ToolGate.invoke(call, ctx)  (same RunCtx, budgets, audit, nonce)
antigravity_cli (v2.0):      no tools ; orchestrator -> gate.prefetchFreeBusy() + gate.prefetchWaContext() -> inlined in the data block
```

- `agent/toolDefs.ts` becomes the single zod-first table `ToolSpec {name, backend:'calendar'|'whatsapp', description, args: z.strictObject, maxCallsPerRun, exposedWhen, execute}`; the LLM-facing LCD JSON is derived once with `z.toJSONSchema(args, {target:'draft-07'})` + `toLcd()` (strips `$schema`, adds `required: []` on empty objects, throws on `minimum/maximum/minLength/maxLength/$ref/anyOf`) and frozen by the existing I4 test (byte-identical to the v1 literals for `get_current_time` / `get_freebusy`); the MCP server registers `spec.args.shape` (SDK 1.30.0 `registerTool` takes `ZodRawShapeCompat`). Local, API-key and CLI backends therefore see byte-identical tools.
- Tools (report 5.1-5.4, unchanged): `wa_get_chat_messages {chat, before_message?, limit?}` (2/run), `wa_search_messages {query, chat?, limit?}` (3/run; `instr()` bound parameter, NFKC + invisible-stripped, 2..64 chars, never echoed or audited), `wa_get_message_context {message, before?, after?}` (2/run), `wa_list_chats {limit?}` (1/run, exposed only in `all_chats` scope). Handles `chat_N`/`m_N` are run-scoped (`agent/handles.ts`; the trigger chat is always `chat_1`); results carry role labels, relative age + coarse day, sanitised text - **never names, numbers, JIDs, WhatsApp message ids or clock times**; caps `waRowsPerCall 20`, `waTextChars 500`, `waResultChars 4000`, `waWindowDays` setting (30); `wrapDataBlock(nonce)` around every result.
- `bridge/waReadClient.ts` (`recentChats`, `chatMessages`, `search`, `context`) over four additive `BridgeDb` SELECTs (`messagesBefore`, `messageByRowid`, `searchContent`, `recentDmChats`; rowid-ordered, time windows filtered in TypeScript via `parseBridgeTs`, no new indexes, `SQLITE_BUSY` => `[]`); DM JIDs only, `policy <> 'never'`, known-sender filter, audio rows shown through `transcripts`.
- `mcp/toolServer.ts startToolServer({gate, ctx, specs, appVersion})`: `McpServer({name:'wca'})`, `StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: ['127.0.0.1:<port>']})`, `node:http` on `127.0.0.1:<freePort>` (`NEVER_PORTS` excludes 8080); **our handler runs before the SDK's** (its Origin/Host options are `@deprecated` in 1.30.0): `POST /mcp` only, `Host === 127.0.0.1:<port>`, no `Origin` header, `Authorization: Bearer <token>` compared with `timingSafeEqual`, body <= 64 KiB, `requestTimeout` 2 s, `Connection: close`; anything else => `404` (never 401/403); `close()` in `finally`. The token (32 random bytes, base64url) exists only in the child env (`WCA_MCP_TOKEN`) and the server's memory; never on argv, disk, log or audit.
- Only importer of `@modelcontextprotocol/sdk/server/*`; ESLint boundary: `toolserver` (here `mcp/toolServer.ts`), `bridge/waReadClient.ts`, `agent/waTools.ts`, `agent/handles.ts` never value-import `bridge/sendClient`, `bridge/readClient`, `mcp/writeClient`, `mcp/adminClient`, `mcp/host`, `exec/**`, `electron`. No send/react/typing/mark-read/download tool exists anywhere; `BLOCKED_NAMES` in the tool-gate test gains every reference-server name (incl. v0.7.0's `mark_messages_read`, `view_media`) and `mcp__wca__wa_search_messages` (the FQN must never be accepted by the gate itself).
- Bundling the reference Python server: NEVER (18 tools incl. 5 senders, opens `whatsapp.db`, `"Name (phone)"` in every row, Python 3.11 + uv + faster-whisper).

---

## 7. DB schema deltas - ONE migration (v4, `SCHEMA_VERSION` 3 -> 4)

`items.event_state`, `items.closed_reason`, `actions.kind`, `consents.kind`, `runs.stage` are SQLite `CHECK` constraints => the 12-step table rebuild (`PRAGMA foreign_keys=OFF; BEGIN; CREATE ..._new; INSERT SELECT; DROP; RENAME; recreate indexes + triggers; PRAGMA foreign_key_check; COMMIT`). The runner's `backupBefore()` runs once before it. Test: a v3 fixture DB with rows in every state round-trips and the section-18 consistency tests pass.

```sql
-- items (rebuild)
  event_state CHECK IN ('none','incomplete','proposed','created','declined','change_proposed','updated','cancelled')
  + linked_item_id INTEGER REFERENCES items(id)      -- the source in_calendar item of a delta item (app-computed)
  + event_revision INTEGER NOT NULL DEFAULT 0
  + calendar_updated TEXT                            -- RFC3339 `updated` of OUR last write (auto ownership baseline)
-- actions (rebuild)
  kind CHECK IN ('send_reply','create_event','update_event')
  + approved_by TEXT                                 -- 'user' | 'user_toast' | <auto_decisions.id> ; NULL until approve time ; frozen after
  trg_actions_state: v1 text + the three I1' WHEN clauses of section 5.5 ; trg_actions_frozen column list + approved_by
-- consents (rebuild)
  kind CHECK IN ('whatsapp_tos','cloud_claude','cloud_gemini','cloud_claude_cli','cloud_antigravity_cli')
-- runs (rebuild)
  stage CHECK IN ('extract','draft','read_image')   + init_ok INTEGER                    -- CLI runs: system/init assertion passed
-- proposals (ADD COLUMN)
  + delta_json TEXT, + blocked_calls INTEGER NOT NULL DEFAULT 0, + image_json TEXT
-- chats (ADD COLUMN)
  + auto_policy TEXT NOT NULL DEFAULT 'inherit' CHECK(auto_policy IN ('inherit','never'))
-- meta keys: calendar_roles_json, agy_workspace_trusted_at
-- NEW tables
CREATE TABLE event_revisions (id INTEGER PRIMARY KEY, calendar_event_id TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','reschedule','move','cancel','undo')),
  prev_json TEXT, next_json TEXT NOT NULL, action_id TEXT NOT NULL REFERENCES actions(id), applied_at INTEGER NOT NULL,
  reverted_by INTEGER REFERENCES event_revisions(id));
CREATE UNIQUE INDEX ux_event_rev ON event_revisions(calendar_event_id, revision);
CREATE TABLE auto_policies (id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('shadow','on','paused','disabled','expired')),
  enabled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, shadow_until INTEGER NOT NULL,
  confirmed_by TEXT NOT NULL CHECK(confirmed_by IN ('native_dialog')), confirm_json TEXT NOT NULL, scope_json TEXT NOT NULL,
  snapshot_sha TEXT NOT NULL CHECK(length(snapshot_sha)=64),
  paused_reason TEXT CHECK(paused_reason IS NULL OR paused_reason IN ('user','circuit_breaker_rate','circuit_breaker_undo','circuit_breaker_unknown','unattended','calendar_disconnected','snapshot_changed')),
  disabled_at INTEGER, disabled_reason TEXT);
CREATE UNIQUE INDEX ux_auto_policies_live ON auto_policies(state) WHERE state IN ('shadow','on','paused');
CREATE TABLE auto_decisions (id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES auto_policies(id),
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES chats(id), kind TEXT NOT NULL CHECK(kind IN ('create','update','cancel')),
  verdict TEXT NOT NULL CHECK(verdict IN ('auto','shadow','fallback')), reason TEXT NOT NULL, checks_json TEXT NOT NULL, decided_at INTEGER NOT NULL);
CREATE INDEX ix_auto_decisions_chat ON auto_decisions(chat_id, decided_at);
CREATE TABLE auto_writes (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES auto_decisions(id),
  action_id TEXT NOT NULL UNIQUE REFERENCES actions(id), item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','update','cancel')), pre_json TEXT,
  revision_id INTEGER REFERENCES event_revisions(id), post_etag TEXT, post_updated TEXT, post_sequence INTEGER,
  undo_state TEXT NOT NULL DEFAULT 'available' CHECK(undo_state IN ('available','undone','expired','blocked_changed','blocked_started','failed')),
  undo_until INTEGER NOT NULL, undo_action_id TEXT REFERENCES actions(id), written_at INTEGER NOT NULL);
CREATE TABLE transcripts (chat_jid TEXT NOT NULL, wa_msg_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('done','empty','failed','aborted')),
  text TEXT, language TEXT, seconds REAL NOT NULL, model_label TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(chat_jid, wa_msg_id)) WITHOUT ROWID;
CREATE TABLE media_cache (item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, chat_id INTEGER NOT NULL REFERENCES chats(id),
  wa_msg_id TEXT NOT NULL, sha256 TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(chat_id, wa_msg_id));
```
Unchanged: `secrets` (CLI providers hold no secret), `chats.policy`, `item_messages`, `triage_queue`, `audit_log` (kinds are app constants: += `event_updated`, `event_cancelled`, `event_reverted`, `auto_policy_enabled|shadow_ended|paused|resumed|disabled|expired`, `auto_decision`, `auto_write`, `auto_undo`, `cli_run`), `rate_events` (buckets += `auto_chat`, `auto_global`), `model_files` (rows for the four voice files and three projectors; `kind` is in the manifest, not the table). Retention: `transcripts.text` and `proposals.delta_json/image_json` nulled with the 30-day job; `media-cache` files unlinked by the same job; `auto_decisions` 90 d, `auto_writes` 180 d, `auto_policies` kept.

---

## 8. IPC deltas (`src/shared/ipc.ts`; every handler keeps the trusted-frame + zod `.strict()` + `Result` shape)

| Channel | Request | Notes |
|---|---|---|
| `action:approve` (EXTEND) | `+ confirmDrift?: true` | `needs_confirm_drift` outcome for `update_event` (mirror of `needs_confirm_conflict`) |
| `item:undoChange` (ADD) | `{itemId, revisionId}` | focused window + focus-steal guard, same as approve; one path for manual and automatic undo |
| `item:getImage` (ADD) | `{itemId}` | full-size normalised picture as a data URL (<= 400 KB); the card list carries only the 320-px thumbnail |
| `auto:getState` (ADD) | - | policy summary, counters, shadow tally, budgets used today |
| `auto:requestEnable` (ADD) | `{scope: AutoScopeSchema, trial: boolean}` | opens the main-owned native dialog; 3/h |
| `auto:disable` (ADD) | `{reason:'user'}` | no confirmation (fail-safe direction); also from the tray |
| `auto:endShadow` (ADD) | `{confirm:true}` | >= 3 shadow decisions shown |
| `auto:listWrites` (ADD) | `{sinceTs}` | the "Automatic activity" page; titles come from `proposals` at render time, never from audit rows |
| `cli:getStatus` (ADD) | `{provider:'claude_cli'|'antigravity_cli'}` | `{installed, version, loggedIn: boolean|null, floorOk}`; cached 60 s |
| `cli:openSignIn` (ADD) | `{provider}` | main launches the visible console running the vendor's own login; never proxies OAuth |
| `llm:listModels` (EXTEND) | `{provider}` | CLI providers: aliases / `agy models` output |
| `model:*` (KEEP) | `{tier?}` | `tier` enum grows with `voice-*` and `mmproj-<llmTier>`; no new channel |
| `settings:set` (EXTEND) | patch groups `voice`, `images`, `whatsapp.readTools`, `llm.claudeCliModel`, `llm.antigravityModel` | still no `auto` group, still no `llm.provider` |
| push `auto:changed` (ADD) | - | policy state / new auto write; `health:changed` carries `llm.resetsAt/usingOverage` and the new `voice` part |

Rule kept: **no channel accepts a JID, URL, file path, tool name, MCP argument, event id or token**; `revisionId`/`autoWriteId` are opaque ids main minted. `auto:*`, `item:undoChange`, `action:approve` never appear on any MCP surface a CLI or a model can reach (tool list = compile-time constant; test A18).

---

## 9. Settings + onboarding deltas

```ts
llm: { provider: z.enum(['local','claude','gemini','claude_cli','antigravity_cli']),           // [V2+]
       claudeModel, geminiModel (unchanged),
       claudeCliModel: z.string().regex(/^[A-Za-z0-9._[\]-]+$/),      // default 'sonnet'
       antigravityModel: z.string().regex(/^[A-Za-z0-9._-]+$/),       // default 'gemini-3.8-flash-high'
       local: { tier, acceleration, forceCpu }, cloudDailyTokenBudget },
whatsapp: { processUnknownSenders, backlogHours,
            readTools: { enabled: boolean /* true */, scope: z.enum(['trigger_chat','all_chats']) /* trigger_chat */, windowDays: int 1..90 /* 30 */ } },
voice:  { enabled: boolean /* true once a voice model is ready */, tier: z.enum(['auto','voice-hebrew','voice-multilingual','voice-lite']), maxMinutes: 15, threads: 'auto' | int },
images: { enabled: boolean /* true */, cloud: boolean /* true */ },
// NO `auto` group: the policy row (section 5.1) is the only representation.
```
Consent versions: `cloud_claude` and `cloud_gemini` -> **2** (text now names voice-note transcripts, pictures when `images.cloud`, other-chat rows when `scope='all_chats'`); new `cloud_claude_cli` v1, `cloud_antigravity_cli` v1 (section 3). `consent:accept` keeps rejecting any version but the current one; the factory throws without the exact version, so switching to a CLI provider or widening the scope is impossible without the dialog.

Settings page groups: AI engine gains two radio cards above the API-key ones ("Claude - your subscription, via the Claude Code you installed" with a detect/version/signed-in pill and a "Sign in" button; "Gemini - your subscription, via Antigravity CLI (experimental)" with the §6 warning line); API keys move under "Advanced". WhatsApp gains "Let the AI read older messages / other chats" (scope radio, `windowDays` slider) and "Voice notes: Off / Hebrew-optimised / Auto-detect language / Lite" with the download size. AI engine gains "Read pictures" and "Read pictures with the cloud AI" + "Download picture reading (0.99 GB)". New group **Automatic mode** (state, remaining validity, budgets, scope checkboxes with the checkbox ceilings, Enable/Trial/Pause/Resume/Disable, link to "Automatic activity"). Tray status line gains "Automatic: on / trial / paused".

Onboarding: step 1 "Choose the AI" gains the two subscription cards (detection runs silently; a missing CLI shows the vendor's install command as copyable text - the app never runs an installer) and one "Voice notes: on" toggle that queues the voice tier download after the LLM tier (same downloader, one connection at a time). Pictures (projector download) and automatic mode are settings-only, never in onboarding. Step 4 checklist gains "Voice model". Step 3 (Google) unchanged except the calendar picker now stores `accessRole` per calendar in `meta.calendar_roles_json`. The Antigravity setup adds one consent-gated step "Trust the app's workspace" (section 1 Q10).

---

## 10. Invariants I1-I7 as amended (+ I8, I9)

| # | v2 text (changes in bold) | Enforced by | Test |
|---|---|---|---|
| I1' | No WhatsApp send without a per-action user click. No calendar write without EITHER a per-action user click OR an **`auto_decisions` row bound to this action and to a live, natively confirmed `auto_policies` row** | `trg_actions_state` (section 5.5); only `ActionExecutor` holds send/write clients; `AutoGate` imports no `agent/**`/`llm/**` | I1 tests unchanged + `auto-mode.i1-trigger`, injection corpus with a live `on` policy, obedient attacker with `change:'cancel'`/`targetEventId` in model output => zero writes without an approval record |
| I2' | The LLM can reach only READ tools (calendar time/free-busy, **WhatsApp read**) with app-pinned arguments, **only through `ToolGate` - whether the caller is the in-process loop or a vendor CLI on the loopback endpoint**; **the model is never told automatic mode exists** | default-deny + facades with no write method (`McpReadClient`, `WaReadClient`) + a tool server with no capability of its own; `get-event`/`update-event` are app-side MCP classes never in the READ table | fake provider AND fake CLI emit every write/unknown/case-variant/reference-server name -> blocked + audited; `tools/list` == exposed names, all `readOnlyHint:true`; prompt purity over every auto-policy state |
| I3 | unchanged (replies are never automatic) | unchanged | unchanged |
| I4' | Untrusted text never enters the system prompt or tool definitions; **transcripts, picture text and tool results are data-block content** | typed `buildSystemPrompt()`; tool defs derived from compile-time zod constants; V1 output is a value object | property test extended to `imageText`, `voice_transcript`, `wa_*` defs, V1 prompt |
| I5' | One **trigger** chat per LLM context; **WhatsApp read tools are scoped to the trigger chat unless the user chose `all_chats` (default off, consent v2)**; every payload and tool result carries no names, numbers, JIDs, WhatsApp message ids or clock times - **only run-scoped handles**, role labels and sanitised text; **a draft can never contain text read from another chat** | `ContextBuilder(chatId)`, `minimize()`, `handles.ts`, `projectWaRows`, S4 cross-chat guard | payload snapshot per provider incl. tool results; regex sweep; `wr-exfil-other-chat` |
| I6' | The bridge can never touch the user's live store, port 8080 or the default webhook/outbox; **the tool server reads only `messages.db` through `BridgeDb` read-only and never listens on 8080; the app calls only the six A16 endpoints** | `assertBridgeSpawnInvariants()`; `NEVER_PORTS`; import-graph for `media/fetch.ts` | one unit test per precondition; `invariants.test.ts` asserts no other module references `/api/media` or `/api/download` |
| I7' | A crash of any child **or job** never takes down the tray app and never duplicates a side effect; **updates are write-ahead + readback-verified; an `executing` update found at startup becomes `unknown_outcome` and is reconciled by `get-event`, never re-patched blindly**; **a failing tool-server listener degrades the CLI provider to `not_ready`, never crashes** | supervisor + pid files for jobs; `eventIdFor()` for creates; `waUpdate` + `baseRevision` for updates | kill tests incl. `claude.exe`/`whisper-cli` fakes; "crash between PATCH and markDone -> reconcile -> done, exactly one patch" |
| **I8** (new) | **Every automatic write is reversible by one user click for at least the undo window, and the pre-write state needed to reverse it is stored BEFORE the write** | `auto_writes.pre_json` in the write-ahead transaction; `event_revisions`; `item:undoChange` | `auto-mode.undo` (create -> one cancel patch; update -> one patch back; `blocked_changed`; idempotent) |
| **I9** (new) | **The app never writes to a calendar event it did not create, and never to a calendar it does not own automatically** | `create-event` always tags `waAgent='1'`; `update-event` only after `get-event` shows `waAgent`, `waItem` = the linked source item, same chat, `creator.self`; auto requires `accessRole === 'owner'` (absent => not owned) | `auto-mode.ownership` (missing tag, foreign item, other chat, `creatorSelf=false`, attendees, recurrence, cancelled, `updated` drift => zero calls) |

The auto-mode report's I10 (native-dialog toggle, expiry, one-click disable) is enforcement text under I1' (section 5.1), not a separate invariant.

---

## 11. Packaging deltas (`electron-builder.yml`, scripts, dependencies)

| Item | Delta |
|---|---|
| `extraResources` | `+ { from: vendor/whisper/win-x64-cpu, to: whisper, filter: ["whisper-cli.exe","whisper.dll","ggml.dll","ggml-base.dll","ggml-cpu-*.dll","msvcp140.dll","vcruntime140.dll","vcruntime140_1.dll"] }` - its own folder (whisper's ggml b5130 must never mix with llama's b10964), its own CRT copy (3 x ~1 MB duplicated) |
| `scripts/fetch-whisper.mjs` (ADD, clone of `fetch-llama.mjs`) | downloads `whisper-bin-x64.zip` from tag `b5130` (8,573,270 B, sha256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c`), verifies, strips the `Release/` prefix, keeps the allow-list, writes `vendor/whisper/MANIFEST.txt`, appends the whisper.cpp MIT text to `THIRD_PARTY_NOTICES.txt`; runs in the packaging lane only (D-017 rule) |
| `vendor/whisper.pin.json` (ADD) | mirrors `llama.pin.json` |
| `scripts/stage-calendar-mcp.mjs` (EXTEND) | after `npm ci`, applies the two-line `status` patch to `build/index.js` iff its sha256 equals the pinned 2.6.3 bundle hash; refuses any other bytes; refuses to patch twice; records the post-patch hash; `smoke-packaged.mjs` gate 4a compares the patched bundle |
| `scripts/pin-models.mjs` (EXTEND) | voice files (`GGML` magic) + `mmproj-F16.gguf` per tier (E2B 985,654,080 B `140be8d7…8215fa`; E4B 990,372,672 B `ddf46c21…6170a51`; 12B 175,115,840 B `ecc4e931…97aaadd3`, at the v1 commits) |
| `package.json` dependencies | `+ opus-decoder@0.7.12` (MIT; brings `@wasm-audio-decoders/common` MIT, `simple-yenc` MIT, `@eshaz/web-worker` Apache-2.0; WASM embedded as a string - no `.wasm` file, no `asarUnpack`); `jimp@1.6.1` only if the `nativeImage` fixture tests fail (D-022 permits it: no `binding.gyp`). **Never** `ogg-opus-decoder` (LGPL `codec-parser`), `sharp`, `@anthropic-ai/claude-agent-sdk`, `@google/gemini-cli`, ffmpeg |
| Forbidden-packages test (EXTEND) | + SPDX allow-list over every production package (Q23); + `ogg-opus-decoder`, `codec-parser`, `@anthropic-ai/claude-agent-sdk`, `sharp` on the forbidden list |
| `smoke-packaged.mjs` (EXTEND) | gates: `resources\whisper\` file set; `tools/list` of the packaged calendar server == 8 names, `update-event.inputSchema.properties.status.enum` contains `cancelled`, `get-event` present; `/props.modalities.vision` after spawning llama with the mid projector once (M-IMG-2); no `claude.exe`/`agy.exe` anywhere under `resources\` (never bundled) |
| Reaper (`proc/reaper.ts`, EXTEND) | accepted `exePath` set += `<resources>\whisper\whisper-cli.exe` and the two locator-resolved CLI paths (exact string match, still pid + creation time) |
| Fuses / `runAsNode` / CSP / `npmRebuild:false` / no `asarUnpack` | unchanged (`img-src 'self' data:` already allows thumbnails) |
| Installer size | + ~4 MB compressed (whisper) ; the vendor CLIs and all models stay downloads/user installs |
| THIRD_PARTY_NOTICES | + whisper.cpp MIT, opus-decoder chain, libopus BSD-3 (patent note), ivrit-ai Apache-2.0, OpenAI whisper MIT, Silero VAD MIT, the calendar-mcp patch notice |

---

## 12. Test strategy deltas (named for the invariants; all against fakes)

- New fakes: `tests/fakes/fake-claude-cli.mjs` (node script launched via `process.execPath`: reads `--mcp-config`, connects with the SDK `Client` + `StreamableHTTPClientTransport`, calls one `wa_*` tool and one forbidden name, prints canned `system/init` + `result`; modes `attacker|no_tools|api_key_leak|rate_limit|is_error_success`), `fake-agy.mjs` (prints `init` + `result`; modes `waiting|denied|exit3`), `whisper-cli.mjs` (copies a fixture JSON to `-of`; modes `slow|exit3|nojson|crash`), `fake-mcp-calendar.ts` gains real `update-event`/`get-event` handlers + scenarios `event_missing`, `status_field_absent`, `drift`, `timeout`, `restore_refused`; `fake-bridge.ts` gains `GET /api/media` + `POST /api/download` with a ledger.
- Security gate additions: CLI argv literal tests (`--restricted --strict-mcp-config --tools ""` present; never `--bare`/`--dangerously-skip-permissions`/`bypassPermissions`/`--add-dir`; token in no argv/log); env allow-list literal for both CLIs; init-mismatch aborts; tool-server 404 matrix (wrong/absent token, `Origin`, `Host`, `GET`, > 64 KiB) with zero gate calls; `wa_row` injection-corpus vector (8 EN/HE twins of `whatsapp-mcp-readonly` 8.3); `tests/golden/edits.jsonl` (11 change + 7 false-positive + 2 injection rows, >= 90 % `change` accuracy per provider before the delta path is default for that provider); auto-mode A1-A20 (`auto-mode` section 9) incl. the table-driven gate over every `AUTO_REASONS` value; `vision-no-tools` argv/request snapshot; voice fixtures (synthetic DTX Ogg generator + one user-recorded note, M-VOICE-1); 24-image synthetic golden set (4 injection images => `suspicious`); migration v3 -> v4 round-trip; import-graph parts B (toolserver/wa lanes) and C (`exec/autoGate.ts`, `media/fetch.ts`).
- Manual release-gate items added to ACCEPTANCE: M-CLI-1 (one S3 run with the real `claude.exe` and the user's login against the fake bridge DB: pin the observed `system/init.tools` set, U2/U9), M-IMG-1 (stdin image block on the raw CLI), M-IMG-1b (agy `@path`, only if agy is ever installed), M-IMG-2 (packaged llama + mid projector), M-AGY-1 (agy `init.tools` in no-tools mode, U4), M-VOICE-1, M-AUTO-1 (toast buttons activate the packaged app on a clean Windows 11 VM), M-CAL-1 (events.patch merge semantics of `extendedProperties.private` on a dummy event; restore of a cancelled event).

---

## 13. Build slicing (disjoint ownership, additive to ARCH 18)

| Lane | Owns (new / extended files) | Depends on |
|---|---|---|
| L1 schema + migration | `shared/{types,schemas,settings,ipc,errors}.ts` deltas, `db/migrations.ts` v4, repos (`eventRevisions`, `autoPolicies`, `autoDecisions`, `autoWrites`, `transcripts`, `mediaCache`), `shared/state.ts` | none (Wave 0 of v2) |
| L2 calendar MCP | `mcp/{readClient,writeClient,projection,host}.ts` (+2 tools, guard), `stage-calendar-mcp.mjs` patch step, fake MCP | L1 |
| L3 editing pipeline | `agent/{existingEvent,resolveDelta}.ts`, `schemas` addendum, prompt addenda, `validate.ts`, golden edits | L1 |
| L4 executor | `exec/{actionExecutor,buildUpdateEventArgs,reconcile,outcome,autoGate}.ts`, `ipc/handlers/{actions,auto}.ts`, `app/notifications.ts` toast buttons | L1, L2 |
| L5 tool gate + WA read | `agent/{toolDefs,toolGate,waTools,handles}.ts`, `bridge/{bridgeDb,waReadClient}.ts`, `mcp/toolServer.ts` | L1 |
| L6 CLI providers | `llm/cli/*`, `llm/{types,factory,consent}.ts` deltas, `draft.ts` branch, fakes `fake-claude-cli.mjs`/`fake-agy.mjs` | L5 (tool server) |
| L7 media + voice | `media/{fetch,imageDims,normalizeImage,mediaCache}.ts`, `bridge/readClient.ts` (+2 methods), `voice/*`, `fetch-whisper.mjs`, manifest tiers, `whisper-cli.mjs` fake | L1 |
| L8 vision | `agent/readImage.ts`, `resolve.ts` image branch, `contextBuilder.ts`, `llm/{claude,gemini,local}.ts` image part, `llamaServer.ts` `--mmproj` | L7, L6 (claude_cli image path) |
| L9 renderer | delta card, Undo, Automatic list + activity page, ImageBubble, voice badge, settings groups, onboarding cards, i18n he/en keys | L1 |
| L10 packaging + e2e | `electron-builder.yml`, `smoke-packaged.mjs`, `pin-models.mjs`, licence gate, Playwright | all |

---

## 14. Honest weaknesses of this proposal

1. **A vendored patch of a minified third-party bundle is the load-bearing piece of D-036's "cancel".** The sha256 pin turns a version bump into a build failure and the startup guard into `CAL_TOOLSET_MISMATCH`, but until upstream accepts a `status` field every server upgrade is a manual re-patch. Choosing `status`-only (no `If-Match`) leaves a TOCTOU window of one Google round-trip between the pre-flight `get-event` and the PATCH; the post-write readback catches a lost update after the fact (=> `unknown_outcome`, reconcile), it does not prevent it.
2. **Two vendor CLIs the app does not control auto-update daily.** Claude Code's docs already announce that `--bare` (which never reads OAuth) "will become the default for `-p`"; agy's flag semantics have drifted between 1.0 and 1.2. Version floors + the per-run `system/init` assertion + a tolerant stream-json parser turn drift into a visible `CLI_TOOLSET_MISMATCH`, not into a silent capability change - but the subscription providers can stop working overnight with no code change on our side. The API-key providers remain one click away for exactly this reason.
3. **Policy risk is carried by the user.** Anthropic's subscription policy flipped three times in 2026 and "may enforce without prior notice"; Google's Antigravity Terms §6 is broad, a ban wave happened on 2026-02-27, and the 2026-09-25 forum answer says `agy -p` "cannot be used to power third-party agents". The consent texts say so, the agy provider is opt-in and experimental, and neither token is ever touched - but an account suspension is a possible outcome the app cannot prevent.
4. **Automatic mode is bounded, not safe.** With every control in place a known contact can still, through a message, cause a bounded, undoable add/move on the user's own calendar within 30 days, with an app-templated description and a toast. The `manipulation`/`suspicious` gates depend on the model's own honesty for the self-reported fields (an attacker can make it say `high`); the cage and the undo, not the model, are the controls. Media-derived items and Antigravity runs are excluded in v2.0, and the deferred SHOULDs (taint cooldown, user-participation, user-echo) would each narrow the residual further.
5. **The delta path's accuracy on terse Hebrew with a 4B local model is unmeasured.** "בוא נזיז ל-5" vs "אנחנו 5 אנשים" relies on the prompt addendum + S2 cross-checks; the golden gate (>= 90 % on 18 rows) is the only evidence and it is per provider - the delta path may ship manual-only on the `tiny` tier.
6. **A loopback listener with a bearer token is open for up to 120 s per run.** Bound to `127.0.0.1`, per-run token, 404-on-everything-unknown, Origin/Host checks, body cap - but any process running as the same user could in principle reach it during a run (read-only data that user already owns). Windows Defender behaviour for the packaged `node:http` listener is UNVERIFIED (v1 already listens on loopback without a prompt).
7. **Shared usage windows.** A chatty background pipeline draws down the user's own Claude 5-hour/weekly window and Antigravity 5-hourly quota; the app cannot read utilisation percentages headlessly. Concurrency 1, the existing per-hour LLM caps and the `resetsAt` pill are the only brakes; usage credits (`isUsingOverage`) cost real money.
8. **New parsers over attacker-controlled bytes.** The app now demuxes Ogg (own ~150 lines, bounds- and CRC-checked) and decodes Opus in WASM, and sniffs/decodes JPEG/PNG with Electron's `nativeImage` (no decompression-bomb guard of its own - our dimension sniff is the guard). `opus-decoder` under Electron 44's Node is UNVERIFIED until the W0 import smoke; `nativeImage` progressive-JPEG coverage is UNVERIFIED (jimp is the fallback).
9. **Pictures and voice widen the injection surface** (text inside a picture, a spoken instruction). Both are treated as data-block text with the same defences as message text; the vendor agent that reads a picture runs under a system prompt the app does not control, with structural defences only (zero tools, zero MCP, empty cwd, one turn, JSON schema). Hebrew OCR quality of Gemma 4 E2B/E4B is unmeasured; the card shows the literal text so the user can catch reversals.
10. **Whisper speed on the laptop target is unmeasured** (the only public CPU number is a 2010 CPU). Transcription is a background job with a visible state and a 15-minute cap; if model load dominates, the documented swap to `whisper-server` as a lazy fourth child breaks A3's "exactly three". English audio through the Hebrew tier with forced `-l he` may transliterate; the golden set decides the default tier.
11. **The consent-version bump is coarse.** One `cloud_claude`/`cloud_gemini` v2 covers transcripts, pictures and the optional other-chat scope; a user who wants cloud drafting but not cloud pictures must find `images.cloud` in settings after accepting. It is smaller than three consent kinds; it is not finer.
12. **Two items per event while a change is pending** (source `in_calendar` + new `needs_reply`); the renderer keys the calendar list by `calendar_event_id` to avoid showing the event twice, but the state machine really has two rows until the update lands. One editable event per chat (Q19) is a product limitation, not a bug.
13. **Migration v4 is a five-table rebuild** with trigger re-creation; a mistake there corrupts approval invariants. The pre-migration backup and the v3-fixture round-trip test are the safety net; there is no partial migration.
14. **The app edits one key in a user-owned config file** (`trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`) - with a shown diff and a click, only when agy is not running, never any other key. It is still a write to a file the app does not own; if agy's settings format changes the merge can fail (the provider then stays `not_ready`).
15. **Nothing here has been executed against a real CLI, a real Google calendar, a real model or a real voice note** (hard rules). Section 16 lists what the user must verify before build lock; eight of those checks need the user's own logins and are release-gate manual items.

---

## 15. Rejected alternatives (delta-specific; v1's section 20 stands)

| Idea | Why not (minimal-delta argument) |
|---|---|
| `AutoApprover` calling `approve()` with a fake `IpcContext` and `approved_by IN ('user','auto')` | a constant cannot be verified by the DB; the decision-id join is the same code size and gives I1' teeth |
| Separate `undo_auto` action kind / separate undo path for automatic writes | one undo path (`item:undoChange` over `event_revisions`) = one reconcile, one test set |
| Soft cancel (`[Cancelled]` summary + `transparency:transparent`) or a `CANCEL_MODE` dual path | violates D-036's letter; doubles the executor branches |
| `If-Match` insertion in the vendored patch (v2.0) | third insertion + 412 mapping for a window the readback already detects; revisit with the upstream PR |
| Claude Agent SDK / bundling either CLI | +200 MB binary, Claude-only, explicit legal conditions; detection is ~60 lines |
| `--bare`, `--dangerously-skip-permissions`, `bypassPermissions`, `claude setup-token` + `@anthropic-ai/sdk` | no OAuth / removes the CLI-side deny / the prohibited token intermediation |
| stdio MCP child spawned by the CLI; long-lived listener + `ToolSessionRegistry`; warm CLI session | second process needing IPC back to main; more lifetime state; shares context across chats (I5) |
| MCP tools through Antigravity in v2.0 | #548/#916 open, no strict-mcp equivalent, the user's global config registers a `send_message` server |
| Gemini CLI | stopped serving Pro/Ultra/free logins on 2026-06-18 |
| Separate `VisionProvider` interface per backend | one more `structured()` call with an image part is smaller; routing is one function |
| Reading `.ogg` files from the store directory (`audioLocator.ts`) | `/api/media` already serves them with validation; one client for voice and pictures |
| whisper-server as a fourth supervised child (v2.0) | breaks A3; documented swap if the bench demands it |
| `ogg-opus-decoder`, static ffmpeg, Chromium's decoder in a hidden window | LGPL demuxer / 165 MiB / message bytes in a renderer |
| A `cloud_images` consent kind, an `auto_mode` consent kind, a `settings.auto` boolean | the provider consent v2 text, the policy row with `confirm_json`, and the policy row respectively |
| Extending the LCD schema subset with numeric ranges | breaks the byte-identity purity test for no functional gain |
| Bundling the reference Python WhatsApp MCP server | 5 senders, no disable switch, opens `whatsapp.db`, `"Name (phone)"` in every row, a second runtime |
| Exposing the calendar MCP child directly to a CLI | it now has `update-event`; the loopback endpoint exposes only `ToolGate` |

---

## 16. UNVERIFIED register (consolidated; the user closes each with the named check)

| # | Fact | Posture in this proposal | Closed by |
|---|---|---|---|
| V2-1 | With `--tools ""` + `ENABLE_TOOL_SEARCH=false` the `mcp__wca__*` names appear in `system/init.tools`; `apiKeySource` literal for OAuth | init assertion pins the observed set after the first run; env allow-list guarantees "no API key" | M-CLI-1 |
| V2-2 | The raw `claude -p --input-format stream-json` honours an `image` block with `--tools ""` | documented for the SDK over the same transport; fallback `--tools "Read"` on a one-file cwd exists in the design, compiled out | M-IMG-1 |
| V2-3 | `agy` `init.tools` in no-tools mode; `--agent` honours `tools: []` on >= 1.2.11; trust gate in headless runs; `AGY_ERROR` fields; `/usage` fields; `agy models` format; `@path` images | tool-less provider, opt-in; auto mode unavailable; pictures local | M-AGY-1, M-IMG-1b |
| V2-4 | `events.patch` merge-vs-replace for `extendedProperties.private`; restore of a cancelled event via `status:'confirmed'`; `location:''` clears the field; retention window of cancelled events | full private map always sent; re-create fallback after a failed restore; stale location accepted | M-CAL-1 |
| V2-5 | Windows toast buttons activate the packaged app (AppUserModelID + Start-menu shortcut) on a clean Windows 11 VM | the dashboard "Automatic" card carries the same Undo; the toast is additive | M-AUTO-1 |
| V2-6 | `opus-decoder@0.7.12` imports and decodes under Electron 44 main; DTX synthetic packets decode without `errors[]`; peak memory of a 15-min note | W0 import smoke; fixture generator falls back to a dev-only WASM encoder | W0 probe + M-VOICE-1 |
| V2-7 | CPU speed of turbo f16 on the laptop target; English audio through the Hebrew tier; the exact ivrit-ai checkpoint behind the ggml repo | first-run bench suggests `lite`; golden set decides the default tier | M-VOICE-1 |
| V2-8 | Vulkan behaviour of Gemma 4 projectors; CPU projector + 1120-token prefill time; Hebrew OCR quality of E2B/E4B/12B; `nativeImage` progressive JPEG; `cache_prompt` with image chunks | projector on CPU by default; `imageSec` bench; 24-image golden set; jimp fallback | M-IMG-2 + golden set |
| V2-9 | Windows Defender prompt for the packaged `node:http` loopback listener | v1 already listens on loopback without a prompt | packaged smoke |
| V2-10 | `recentDmChats` `GROUP BY` cost on a multi-year store | 1 call/run cap; measure on a 10^6-row fake DB | bridge lane bench |
| V2-11 | Whether editing `trustedWorkspaces` while agy is closed persists; whether deleting the run's `brain/<conversation>` dir is tolerated | consent text says the CLI stores the prompt locally; no deletion attempted in v2.0 | M-AGY-1 |
| V2-12 | Anthropic's 2026-06-15 "paused" policy note and Google's §6 stance on the release date | consent texts carry the read date; providers pluggable; API-key fallback kept | re-read before release |

---

## 17. Decisions the orchestrator must record (all `[V2+]` unless marked D-0xx)

1. **D-042**: cancel = vendored `status` patch (two insertions, sha256-pinned, fail-closed guard); no soft-cancel branch; `If-Match` deferred; upstream PR filed.
2. **D-043**: MCP server name `wca`; tool name `wa_get_chat_messages`; LCD subset unchanged (ranges in descriptions + gate clamps).
3. **D-044**: `approved_by` = decision id (auto-mode 8.1/8.4) supersedes event-editing 3.5; `approve()` stays click-only; one undo path.
4. **D-045**: Antigravity provider ships tool-less, opt-in, experimental, consent `cloud_antigravity_cli`; auto mode unavailable while it is active; pictures local while it is active; MCP-to-agy is a v2.1 variant gated on #548/#916 and M-AGY-1.
5. **D-046**: auto mode with `claude_cli` only for proposals whose run has `runs.init_ok = 1`; media-derived items never auto in v2.0.
6. **D-047**: A16 amended to six endpoints (`GET /api/media`, `POST /api/download`), callable only from `src/main/media/fetch.ts`; voice and pictures share it.
7. **D-048**: A3 unchanged ("exactly three supervised children"); whisper-cli and the vendor CLIs are short-lived jobs under the pid-file/reaper scheme.
8. **D-049**: consent versions `cloud_claude`/`cloud_gemini` -> 2 (transcripts, pictures, optional other-chat scope); new kinds `cloud_claude_cli`, `cloud_antigravity_cli`; no `cloud_images` / `auto_mode` consent kinds; the auto policy row is the auto-mode consent record.
9. Frozen-signature additions: `PROVIDER_IDS` +2; `LlmProvider.loop/capabilities/runAgentic`; `LlmMessage.user.content` image part; `CallOpts.purpose` + `read_image`; `BridgeReadClient.getMedia/requestDownload`; `BridgeDb` +4 SELECTs; `RunCtx` + `handles`; `ToolGateDeps` + `wa`/`waAvailable`; `ToolGate.exposedSpecs/prefetchWaContext`; `McpReadClient.getEvent`; `McpWriteClient.updateEvent`; `ActionExecutor.tryAuto/undoAuto`; `ApproveReq.confirmDrift`; `LIMITS` (`draftToolCalls` 6, `draftTurnsWithTools` 4, `cliWallClockMs`, `wa*`); `BADGES` +4; `AUDIT_KINDS` +13; `RATE_BUCKETS` +2; `ErrorCode` + `CLI_NOT_INSTALLED`, `CLI_VERSION`, `CLI_TOOLSET_MISMATCH`, `CLOUD_AUTH`, `CAL_EVENT_GONE`, `CAL_EVENT_FOREIGN`, `CAL_UPDATE_FAILED`, `AUTO_NOT_CONFIRMED`, `AUTO_CALENDAR_NOT_OWNED`, `VOICE_*` (6), `IMAGE_UNREAD`; migration v4 as one rebuild.
10. T-401 closed by the found-create-becomes-update rule.
11. Deferred to v2.1: auto-mode SHOULDs S1-S5, `If-Match`, MCP-to-agy, agy pictures, whisper-server swap, two editable events per chat, CLI exe-path overrides in settings, `jimp` unless needed.
