# v2 Architecture Proposal - UX-FIRST angle

Project: WhatsApp Calendar Agent v2 (Windows 11, Electron 44.4.3 + TypeScript, Node 24). Date: 2026-09-28. Author angle: **the user must understand what automatic mode does, see every automatic change and undo it in one click, set up the vendor CLIs without a terminal tutorial, and get voice/picture cards that feel like a native part of the dashboard.** Everything below builds on the binding v1 `docs/ARCHITECTURE.md` (A1-A23, I1-I7), `docs/specs/contracts.md` (shapes win over prose) and `docs/specs/ux.md` (tokens, card anatomy, copy rules), and on the eight v2 research reports in `docs/research/v2-*.md`.

Reading rules: **MUST / NEVER** = release blockers for the feature they belong to. `[V2+]` = an addition to a frozen v1 signature that the orchestrator must record in `ops/DECISIONS.md`. `[LR]` = where reports disagree or facts are UNVERIFIED, the lower-risk option was chosen and the reason is given. `UNVERIFIED` = not confirmed from a primary source; section 18 lists every such fact with the manual check that closes it. Locked decisions D-036..D-041 are not relitigated; where a research report asked the orchestrator to choose, this document chooses and says why (section 16).

---

## 0. The eight decisions that define this proposal

| # | Decision | UX reason |
|---|---|---|
| U1 | **Automatic mode is a policy the user *grants*, not a switch the user *flips*.** It starts as a 24 h **trial** (shadow: cards say "would have been automatic"), needs one native Windows dialog to become real, expires after 30 days, and can be paused by the app and stopped by the user from anywhere in one click. The three-list dashboard stays; a collapsible **"Done automatically"** strip appears above the lists only while there is something to undo. | A user who never sees an approval again must still know what happened. The trial shows the user, on real cards, exactly which events the app *would* have added - before it adds any. "Ends in 30 days" is the plain-language cousin of "re-confirm". |
| U2 | **One Undo path, three doors.** Every automatic write and every applied change (manual or automatic) is reverted by the same `item:undoChange` executor path (a pending `update_event` whose payload is the previous version). Doors: the Windows toast's **Undo** button, the card's **Undo** chip, the "Automatic activity" page. Undo never needs a second confirmation. | Undo is the fail-safe direction; it must be the cheapest action in the app. One path = one set of tests and one reconcile. |
| U3 | **Subscription providers are "Connect" cards with three states - Not installed / Not signed in / Ready - and the app never installs, never logs in, never touches a credential.** Detection: `claude --version` + `claude auth status --json` (`loggedIn` only); `agy --version` + `agy -p "/usage" --output-format json` (free of quota). "Sign in" opens a *visible* console window running the vendor's own login command; "Check again" polls. A one-click **Test** runs one tiny completion and says "Ready - about 2 s". | The user asked for "works on my subscription". The setup must feel like connecting a printer: detect, guide, confirm. Copying an install command is the only terminal moment, and the app copies it for them. |
| U4 | **Voice and picture messages are first-class triggers with their own bubble kinds** (`VoiceBubble`, `ImageBubble`) inside the unchanged card anatomy. The transcript / literal read text is shown *as text the user can check* before any approval; the event chip, badges and buttons are the same as for text. | "Feels native" means: same card, same buttons, one new bubble. Trust comes from showing what the AI read, not from hiding it. |
| U5 | **Changes to an existing event are a "Change" card, not a new event card.** `Wed 15:00 -> 17:00` in one line, **Approve change / Keep 15:00**; after it lands, the calendar card shows `Updated · rev 2` + **Undo**. Cancel is a real cancel (event status `cancelled`) with **Undo** = restore. | The user's own words: "the LLM should tell the app there is a change and edit the calendar event". The card must show *from -> to*, never a second copy of the event. |
| U6 | **The AI may read more WhatsApp history through tools, but only of the same chat by default**, and the settings row says so in one sentence ("Let the AI read older messages of the same chat / of all chats"). Widening to all chats bumps the cloud consent version. | I5 ("one chat per context") is what the privacy table promises; the widening is a conscious, explained choice. |
| U7 | **Every new failure state has one plain sentence and one action**, extending the v1 `ErrorCode` deck: CLI not installed -> "Copy install command"; not signed in -> "Sign in"; usage limit -> "Continues at 15:40"; voice model missing -> "Download"; picture reading missing -> "Download (0.99 GB)"; event gone from Google -> "Add as new event". | v1's single strongest UX rule (A17) must survive four new subsystems. |
| U8 | **Nothing new is a resident process.** whisper-cli and the vendor CLIs are short-lived *jobs*; the app-hosted MCP tool server is an in-process loopback listener that lives for one run; local vision is the same llama-server child with `--mmproj`. The three managed children of A3 stay three. | Fewer things to crash, fewer things to explain in the status panel; the status panel keeps three rows (WhatsApp / AI / Calendar) with one new sub-line each. |

---

## 1. What the user sees - v2 surfaces at a glance

```
+------------------------------------------------------------------------------------------+
| WhatsApp Calendar Agent      (v) All running  v      [dl 62 % voice model]  [|| Pause]   |   header (unchanged) + DownloadPill also for voice/projector
+------------------------------------------------------------------------------------------+
| (i) Automatic mode - trial: 2 events would have been added. [Review]  Ends tomorrow      |   SetupStrip row (only in trial / paused / expired states)
+------------------------------------------------------------------------------------------+
| (auto) Done automatically today (2)                                              [ v ]   |   AutoStrip: collapsible; last 7 days; each row = app-rendered event + Undo
|   [24 SEP] Dentist 16:00-17:00  moved from 15:00  (12 min ago)     [Undo]  [Show]        |
+------------------------------------------------------------------------------------------+
| Needs reply (3)            | In calendar (5)              | Information missing (1)      |   the three lists of the brief, unchanged
|  Dana Levi     14:02 [...] |  Yossi     yesterday   [...] |  ...                         |
|  ,--------------------.    |  [24 SEP] Meeting            |                              |
|  | (mic) Voice message|    |   17:00-18:00                |                              |
|  | 0:42  Transcript:  |    |   Updated · rev 2  [Undo]    |                              |   in_calendar card after a change
|  | "בוא נזיז ל-5"     |    |                              |                              |
|  '--------------------'    |                              |                              |
|  Change: Wed 15:00 -> 17:00|                              |                              |   delta card (U5)
|  (~) 5 taken as 17:00      |                              |                              |
|  - - Draft reply - - - -   |                              |                              |
|  | בטח, 17:00 מתאים.   |    |                              |                              |
|  [Approve & send]          |                              |                              |
|  [Approve change] [Copy]   |                              |                              |
+------------------------------------------------------------------------------------------+
```

Status panel (5.2 of the UX spec) keeps three rows; each gains at most one muted sub-line:

| Part | New sub-lines (en) |
|---|---|
| WhatsApp | "Reading older messages: this chat only" / "all chats" (only when the AI tools are enabled) |
| AI | "Claude - your subscription - ready · usage resets 15:40" · "Gemini via Antigravity (experimental) - ready" · "Voice notes: Hebrew model ready" / "downloading 62 %" / "off" · "Pictures: ready" / "not downloaded" |
| Calendar | "Automatic mode: on - ends in 23 days" / "trial" / "paused - budget reached" / "off" (a click on the sub-line opens Settings > Automatic mode) |

Nothing else in the shell changes. The tray menu gains one line "Automatic mode: on (click to pause)" only while a policy is live.

---

## 2. Process model

v1's rule "exactly three managed children under one Supervisor" (A3) stays literally true. v2 adds two *other* kinds of process-like things and names them so the code and the status panel never confuse them:

| Kind | Instances | Lifetime | Supervised? | Crash effect |
|---|---|---|---|---|
| **Child** (v1) | bridge, calendar MCP server, llama-server (now optionally with `--mmproj`) | long-lived | yes (Supervisor, PID file, breaker) | as v1 |
| **Job** (new) | `whisper-cli.exe` per voice note; `claude.exe -p` per S1/S3/V1 run; `agy.exe -p` per run | one invocation, hard wall clock, killed by PID (`taskkill /PID /T /F` after 3 s grace) | no Supervisor; a `JobRunner` with a promise mutex (concurrency 1 per kind), PID file for the reaper, breaker 5 failures / 10 min per kind | the item's run fails with an `ErrorCode` and is retried by the TriageQueue's existing backoff; nothing else notices |
| **Listener** (new) | `McpToolServer` (loopback Streamable HTTP on `127.0.0.1:<ephemeral>`, in the main process) | one per CLI run that needs tools; closed in `finally` | n/a (in-process) | `EADDRINUSE` after the free-port retries => the CLI provider is `not_ready` (amber pill), the local provider is unaffected |

```
                                 Windows 11 user session
+----------------------------------------------------------------------------------------------------------+
| Electron MAIN (ESM)                                                                                       |
|  v1: lifecycle | tray | window | IPC | Db | HealthHub | Supervisor x3 | Bridge* | Ingest | Agent S0-S4 |  |
|      ToolGate -> McpReadClient | Exec: ActionExecutor -> BridgeSendClient | McpWriteClient(create,UPDATE)|
|  v2 additions (all in-process, all Electron-free except compose.ts / app/**):                            |
|      voice/  (audioLocator, ogg demux, opus-decoder WASM, wav, whisperJob)     -> Job: whisper-cli.exe    |
|      media/  (locator, sniff, nativeImage normalise, cache)                                                |
|      vision/ (V1 read-image over local | claude_cli | apiKey)                                              |
|      llm/cli/ (locator, JobRunner, claudeCli, antigravityCli)                  -> Job: claude.exe / agy.exe|
|      mcp/toolServer.ts  (Listener; registers gate.exposedSpecs(); every tools/call -> ToolGate.invoke())   |
|      bridge/waReadClient.ts (READ facade over BridgeDb)   agent/{waTools,handles,resolveDelta,readImage}   |
|      exec/{autoGate,autoPolicy,buildUpdateEventArgs,undo}  app/autoDialog.ts (native dialog owner)        |
+---------+-----------------+-------------------+------------------+---------------------+-----------------+
          | IPC             | spawn/REST/ro DB  | stdio MCP        | HTTP+key            | Jobs (spawn, stdin/argv, stream-json)
          v                 v                   v                  v                     v
   RENDERER          whatsapp-bridge.exe   calendar MCP 2.6.3   llama-server b10964    claude.exe (user's install, OAuth)
   +VoiceBubble      (unchanged)           (+get-event,          (+--mmproj on demand)  agy.exe (user's install, Google login)
   +ImageBubble                             +update-event,                              whisper-cli.exe (shipped, b5130)
   +AutoStrip                               vendored status patch)                          ^
   +ChangeCard                                                                   Listener: 127.0.0.1:<port>/mcp (per run, bearer)
```

Rules added to ARCHITECTURE section 3:

- A **Job** never inherits `process.env`; each kind has a literal env allow-list asserted by a test (whisper: the llama list; Claude: the cli-mcp-bridge list with `WCA_MCP_TOKEN`, `ENABLE_TOOL_SEARCH=false`, `DISABLE_*`, never `ANTHROPIC_API_KEY`/`CLAUDE_CONFIG_DIR`; agy: minimal + `AGY_CLI_DISABLE_AUTO_UPDATE=true`). `shell:false`, `windowsHide:true`, argv never carries message text (Claude: prompt on stdin; agy: `-p` positional is accepted only below 24 k chars, else stdin stream-json; whisper: paths only, random job ids).
- A Job's stdout is **never logged**: whisper stdout carries the transcript (ignored, `stdio:['ignore','ignore','pipe']`); CLI stdout is parsed as NDJSON and only enum/number fields reach the audit (`cli_run` row).
- Jobs are serialised **behind the TriageQueue** (concurrency 1): whisper runs inside `orchestrator.runChat` before S0, a CLI run *is* S1/S3/V1. So llama-server, whisper-cli and a vendor CLI never compete for the CPU on the app's behalf. Voice transcription of a 10-minute note therefore delays the next chat; the queue line says why (section 8).
- The **Listener** exists only between `startToolServer()` and its `close()` in the same `finally` as the Job kill; port from `proc/freePort` (never 8080); per-run 32-byte bearer token; our handler rejects any `Origin`, any `Host` other than `127.0.0.1:<port>`, any path other than `/mcp`, any method other than `POST`, bodies over 64 KiB, and answers **404** to everything unknown (no probing signal). The SDK's deprecated `allowedHosts`/`enableDnsRebindingProtection` are set as well but are not the control (`[LR]` per whatsapp-mcp-readonly C5).
- Reaper: Job PIDs use the v1 pid-file scheme (`<userData>\run\job-<kind>-<id>.pid.json`), matched by pid + exe path + creation time; **never by image name** - the user runs Claude Code and possibly `agy` interactively on the same machine.

---

## 3. Provider abstraction

`PROVIDER_IDS` `[V2+]` = `['local', 'claude_cli', 'antigravity_cli', 'claude', 'gemini']`. In the UI the order and labels are:

| id | Label (en / he) | Where in Settings | Auth | Consent kind |
|---|---|---|---|---|
| `local` | On this computer / במחשב הזה | first card (default) | - | - |
| `claude_cli` | Claude - your subscription / Claude - המנוי שלך | second card | user's Claude Code sign-in (OAuth held by the CLI) | `cloud_claude_cli` v1 |
| `antigravity_cli` | Gemini - your subscription (experimental) / Gemini - המנוי שלך (ניסיוני) | third card, collapsed behind "Show experimental" | user's Antigravity sign-in (Credential Manager, held by `agy`) | `cloud_antigravity_cli` v1 (text includes Antigravity Terms section 6 and the on-disk transcript fact) |
| `claude` | Claude with an API key / Claude עם מפתח API | "Advanced" group | API key (safeStorage) | `cloud_claude` |
| `gemini` | Gemini with an API key / Gemini עם מפתח API | "Advanced" group | API key | `cloud_gemini` |

The label text may say "runs Claude Code" in the description line; the provider name, icons and settings never use the Claude Code or Anthropic name or logo as the app's own branding (legal page constraint).

### 3.1 `LlmProvider` `[V2+]` (additive; v1 members untouched)

```ts
// src/main/llm/types.ts
export type ProviderLoop = 'turn' | 'agentic' | 'prefetch';
//  turn     = v1: draft.ts owns the tool loop; provider.chat() is ONE model turn (local, claude, gemini)
//  agentic  = the CLI runs the loop itself; our loopback MCP server is the gate (claude_cli)
//  prefetch = no tools at all; the app runs ToolGate tools BEFORE the call and inlines the projections (antigravity_cli v2)
export interface LlmImagePart { type: 'image'; mime: 'image/jpeg' | 'image/png'; base64: string }           // V1 only
export type LlmUserContent = string | Array<{ type: 'text'; text: string } | LlmImagePart>;                 // LlmMessage.user.content widens (callers keep passing strings)
export interface AgenticRunInput { system: string; user: string; specs: readonly ToolSpec[]; ctx: RunCtx; gate: ToolGate; maxTurns: number; jsonSchema?: JsonSchemaLcd }
export interface AgenticRunResult { text: string; structured?: unknown; toolCalls: number; blockedCalls: number; initOk: boolean;
                                    stopReason: 'end' | 'max_turns' | 'aborted' | 'killed' | 'bad_output'; usage?: LlmUsage;
                                    rateLimit?: { resetsAt: number | null; usingOverage: boolean | null } }
export interface LlmProvider {
  readonly id: ProviderId; readonly model: string; readonly loop: ProviderLoop;
  structured<T>(messages, schema, opts): Promise<T>;          // CLI: one job, --json-schema, no MCP server, max-turns 1
  chat(messages, tools, opts): Promise<LlmResponse>;          // CLI providers throw LlmError('unsupported'); draft.ts branches on `loop`
  runAgentic?(input: AgenticRunInput, opts: CallOpts): Promise<AgenticRunResult>;   // claude_cli only
  validate(signal): Promise<{ ok: true; model: string } | { ok: false; reason: ProviderErrorCode }>;   // CLI: exe found + version floor; NO login probe here
  dispose(): Promise<void>;                                   // CLI: kill the in-flight job
}
```

`draft.ts`: `loop === 'turn'` -> v1 loop; `'agentic'` -> `startToolServer({gate, ctx, specs})` then `provider.runAgentic(...)`, close in `finally`; `'prefetch'` -> `gate.prefetchFreeBusy()` + new `gate.prefetchWaContext()` (budget-free, same `execute` code as the tools), inline both as app-computed fields in the nonce block, one no-tool completion. Same `DraftOutcome`, same `cleanDraft()`, same `manipulation` rule for all three.

### 3.2 Claude CLI provider (`llm/cli/claudeCli.ts`)

The exact argv of cli-mcp-bridge 6.1 is adopted verbatim: `-p --restricted --strict-mcp-config [--mcp-config <inline JSON with "Bearer ${WCA_MCP_TOKEN}">] --tools "" [--allowedTools mcp__wca__*] --disallowedTools <bare deny list> --permission-mode dontAsk [--permission-prompts none >= 2.1.259] --disable-slash-commands --no-session-persistence --system-prompt <verbatim S1/S3/V1 constant> --model <alias> --effort low|medium --max-turns N --output-format stream-json --input-format stream-json --verbose [--json-schema <draft-07>]`, cwd = fresh `<userData>\cli-runs\<runId>\` deleted in `finally`, prompt as one stream-json user line on stdin, **never `--bare`**, never `--dangerously-skip-permissions`, never `--add-dir`. `[LR]` Two research questions closed here: **the S1/S3 runs stay strictly tool-less** (accept the `$PARAMETER_NAME` self-heal retry of bug #87234 rather than granting `Read` - "the AI has no tools" is the sentence the settings page promises); **`--system-prompt` on argv** (the constants are < 8 KB; `--system-prompt-file` in the run dir is the documented fallback if a prompt ever grows; `--append-system-prompt-file` is never used because it keeps Claude Code's coding prompt).

Fail-closed init assertion (every run, before the first turn): `mcp_servers` exactly `[{name:'wca', status:'connected'|'pending'}]` (S3) or `[]` (S1/V1); `mcp_server_errors` absent; `plugins` empty; `tools` a subset of `mcp__wca__<our names>` (+ `Read` only in the V1 fallback); otherwise kill + audit `toolset_mismatch` + `ErrorCode CLI_TOOLSET_MISMATCH`. The result's `initOk` is stored on the `runs` row and the proposal (`proposals.provider_proof`) because automatic mode reads it (section 5.3, reason `provider_unsafe`).

Model policy: default `sonnet` for S1/S3/V1 with `--fallback-model haiku` `[LR]` (Opus 5.5 is the plan default, burns the shared 5-hour window and is documented as unavailable on Pro); the settings model select offers `sonnet`, `haiku`, `opus` as *aliases* with the note "as available on your plan"; `MODEL_UNAVAILABLE` errors fall back to `sonnet` once and show `MODEL_NOT_FOUND` otherwise.

Error classification (`is_error` first, never the exit code): `NOT_LOGGED_IN` -> `CLI_NOT_SIGNED_IN`; `USAGE_LIMIT` (text `You've hit your ... limit`, or `rate_limit_info.status !== 'allowed'`) -> `CLOUD_QUOTA` with `params.resetsAt`; `RATE_LIMITED`/`OVERLOADED` -> `CLOUD_UNAVAILABLE` (working, backoff); `ACCOUNT_ON_HOLD` / `oauth_org_not_allowed` -> new `CLOUD_AUTH`; `BAD_OUTPUT` (`error_max_structured_output_retries`, success without `structured_output`, `stop_reason:'refusal'`) -> `LLM_BAD_OUTPUT` after the one repair retry; `TIMEOUT`/`ABORTED` as v1.

### 3.3 Antigravity CLI provider (`llm/cli/antigravityCli.ts`) - opt-in, tool-less in v2

Ships exactly as gemini-cli-backend 8 and cli-mcp-bridge 6.2 specify: per run the app writes `<runDir>\.agents\agents\wca-<stage>.md` (frontmatter `tools: []`, `commandExecutionPolicy: off`, `excludeDefaultComponents: true`, `mainAgent: true`, body = the verbatim S1/S3 constant), runs `agy.exe --agent wca-<stage> --model <slug> --effort low --output-format stream-json --print-timeout <wall clock - 10 s> --disable-slash-commands [--json-schema <file in runDir>] -p "<user message>"`, `stdin:'ignore'`, cwd = the run dir under the app-owned **trusted workspace** `<userData>\agy-workspace\`, and asserts `init.agent === 'wca-<stage>'`, `init.tools` empty, `init.permission_mode === 'request-review'`. `status === 'WAITING'` or non-empty `denied_actions` = our agent file tried a tool = `LLM_BAD_OUTPUT`, never a retry with permissions. Exit 3 + `AGY_ERROR:` stderr line -> quota/auth classification by regex (field names UNVERIFIED, U-A3). One `agy` process at a time. **No MCP server is ever attached to `agy` in v2** (open bugs #548/#916 + the 25 Sep policy wording); the v2.1 recipe stays in the research report.

Two user-visible consequences, both said in the settings card: (1) "The AI cannot look up older messages on its own with this provider; the app hands it the last 30 days of this chat instead" (`prefetchWaContext`, window = `whatsapp.readTools.windowDays`, capped at `LIMITS.waResultChars`); (2) "Antigravity stores a copy of what it was asked on this computer (`~/.gemini/antigravity-cli/brain`)" (U-A5) - the consent text carries it.

Trusted workspace: `agy` hangs headless runs on an untrusted cwd (community report, UNVERIFIED on 1.2.x). The Connect card's **Sign in / Set up** step therefore offers "Allow the app's folder in Antigravity" which, with the user's click and a shown diff, read-merge-writes exactly one key (`trustedWorkspaces += <userData>\agy-workspace`) into `~/.gemini/antigravity-cli/settings.json`, only when no `agy` process is running, preserving unknown keys, with a backup copy next to it. Nothing else in that file is ever touched (`[LR]`: the alternative - never editing the user's file - leaves the provider unusable).

### 3.4 API-key providers

Unchanged from v1 except: `LlmMessage.user.content` accepts the image part (V1 over `claude`/`gemini` uses the vendor's native image block / `inline_data`); the settings cards move under **Advanced** with the sentence "Use this if you do not have a subscription or the subscription route stops working." Never a silent fallback between any two providers (A20 stands).

---

## 4. Pipeline

```
Ingest.scan() -> [S0 filter] -> triage_queue (debounce 20 s, concurrency 1)
   -> [V0 TRANSCRIBE   local whisper-cli job, per audio row without a transcript]        -> transcripts row (UNTRUSTED text)
   -> [V1 READ-IMAGE   tool-less vision call, newest unread image in the window]         -> ImageRead (zod strict) -> imageText + literal digits
   -> [S1 EXTRACT      structured(), NO tools; data block now carries app_context.existing_event] -> Extraction (+ refersToExisting/change/changeConfidence/confidence)
   -> [S2 RESOLVE      TypeScript: dates; NEW branches image_absolute and delta-against-existing]  -> event | delta | incomplete | ignored
   -> [S3 DRAFT        loop per provider.loop; READ tools = calendar + wa_* via ToolGate]          -> draft text
   -> [S4 VALIDATE     deterministic; NEW cross-chat leak guard; persists blocked_calls, provider_proof] -> proposal + actions (send_reply | create_event | update_event)
   -> [S5a AUTO        executor.tryAuto(actionId) - AutoGate, pure, LLM-free]  -> auto write (+ toast + AutoStrip)  |  fallback => the v1 card with the reason
   -> [S5  EXECUTE     user click -> action:approve -> ActionExecutor]                                 (unchanged for send_reply / create_event; + update_event)
```

### 4.1 V0 TRANSCRIBE (voice, always local)

Runs inside `orchestrator.runChat` before S0 for every live row with `media_type='audio'` and no `transcripts` row for `(chat_jid, wa_msg_id, model_label)`. Steps: `voice/audioLocator.resolve(chatJid, messages.filename)` (realpath prefix under `<userData>\bridge\store\`, regex `^audio_\d{8}_\d{6}_[A-Za-z0-9]{1,128}\.ogg$`, <= 64 MiB; wait up to 30 s for the bridge's async download; then one `POST /api/download` and one more wait - section 15 amends A16) -> `voice/ogg.ts` demux (RFC 3533 CRC-checked, single stream) + `opus-decoder@0.7.12` -> 16 kHz mono PCM16 WAV in `<userData>\voice\tmp\<jobId>.wav` -> Job `whisper-cli.exe -m <tier> -f <wav> -l he|auto -t N -oj -of <tmp> -np -nt --vad ... -bs 5 -bo 5 -tp 0 -et 2.4 -sns` (exact flags per whisper-local 2.1), BELOW_NORMAL priority, timeout `clamp(30 s, 4 x seconds x benchFactor, 600 s)`, 15-minute hard cap -> `transcripts` row `{status: done|empty|failed|aborted, text, language, seconds, model_label}` -> temp files deleted in `finally`.

The transcript enters the nonce data block as `{ "source": "voice_transcript", "language": "he", "text": ... }` after `sanitizeForModel` + `LIMITS.messageChars`; **never** the system prompt (`prompt.purity.test.ts` extended). An empty transcript is never a trigger (raw card "Voice message - no speech detected"). Model tiers: `voice-hebrew` (default, ivrit-ai large-v3-turbo f16, forced `-l he`), `voice-multilingual` (OpenAI turbo q8_0, `-l auto`), `voice-lite` (small q8_0), `voice-vad` (Silero 6.2.0, always). `[LR]` `whisper-cli` per note, not `whisper-server` as a fourth child; the runner interface is transport-agnostic so the swap is a ticket, not a redesign, if the first-run bench shows model load > 40 % of wall time.

### 4.2 V1 READ-IMAGE (pictures, provider-dependent)

Runs after V0, at most one image per run (the newest unread `media_type='image'` row whose bytes sniff as JPEG/PNG), only when `settings.images.enabled`. Bytes: `media/locator.ts` resolves `messages.filename` the same way as audio (`image_*.jpg`), validates the container (JPEG SOI+EOI / PNG IHDR+IEND) and retries once after 5 s if it looks partial; `POST /api/download` is the same narrow fallback. `[LR]` File-first for both media kinds instead of `GET /api/media` (one media path, no streaming client, works for history-synced rows; the bridge writes whole files with `os.WriteFile`); the image lane switches to `/api/media` only if the packaged smoke shows partial files (U-I3). Normalise in main: pure-TS dimension sniff (reject > 10 MiB or > 25 MP), `nativeImage` resize to long edge 1536 + `toJPEG(85)`, 320-px thumbnail as a data URL; `jimp@1.6.1` is the only permitted pure-JS fallback; cache under `<userData>\media-cache\<sha256(chat|msg)>.jpg` + `media_cache` row.

Vision provider table (D-039 as read by this proposal):

| `llm.provider` | `images.cloud` | V1 runs on |
|---|---|---|
| `local` | - | llama-server with `--mmproj` (projector downloaded on demand from the card, section 9); else raw card `image_unread` |
| `claude_cli` | on (default) | Claude Code job: stream-json user line with the `image` block first, `--tools "" --strict-mcp-config --max-turns 1 --json-schema IMAGE_READ_SCHEMA`; consent `cloud_images` current. Fallback (only if gate M-IMG-1 fails): `--tools "Read" --allowedTools Read` on a one-file cwd - the single place a vendor agent ever gets a file tool |
| `claude` / `gemini` (API key) | on | native image block / `inline_data`, no tools declared |
| `antigravity_cli` | on | **local** (mmproj) until gate M-IMG-1b proves `agy -p "... @path"` delivers pixels headlessly; then the `wa-read-image` agent with `tools: []` |
| any | off | local if the projector is present, else `image_unread` |

Output = `ImageRead` (flat, strict, sentinels instead of nulls: `day/month/year` 0, `hour` 24, `weekday` 7; `readText` <= 1500; `confidence`; `suspicious`). Its `readText` enters S1 as `"imageText"` on the trigger message (third-party data; S1 prompt gains one constant sentence); its digits feed the new S2 branch `image_absolute` (code computes the ISO date; `year=0` = next occurrence; weekday word disagreeing with the digits => badge `image_unclear`, digits win). `suspicious` (V1 or S1) => red `manipulation`. V1 failure never blocks S1 (text-only run + `image_unread`). Wall clock 180 s local / 120 s CLI.

### 4.3 S1 EXTRACT with an existing event (D-036)

Before S1 the orchestrator calls `findExistingEvent(repos, chatId, now)`: the newest `in_calendar` item of the chat with `calendar_event_id` and `event_state IN ('created','updated')` whose start is not older than 24 h. If found, the new open item gets `items.linked_item_id = source.id` and the S1 data block becomes `{"app_context": {"existing_event": {title, date, weekday, start_local, end_local, time_zone, location, status}}, "messages": [...]}` - inside the nonce block (title/location are contact-derived text), never the event id, never item ids. `EXTRACTION_JSON_SCHEMA` gains `refersToExisting: boolean`, `change: enum(no_change|reschedule|move|cancel|new_event)`, `changeConfidence: enum(high|medium|low)` and, for auto-mode eligibility, `confidence: enum(high|medium|low)` - one flat schema for every provider, ranges enforced by zod after the call. Prompt addendum = event-editing 2.4 verbatim (constants, zero interpolation; I4 purity holds). Vendor-CLI runs get one extra constant line ("Return the JSON object only, on one line") and `extract.ts` strips one code fence before `JSON.parse`.

### 4.4 S2 RESOLVE - delta branch (`agent/resolveDelta.ts`, pure)

Rules per event-editing 2.5: `reschedule` inherits the date when only a time was said and the time when only a day was said; ambiguous hour picks the candidate nearest the existing start (`hour_assumed_near_existing`, still amber `time_assumed`); `cancel` = same content with `status:'cancelled'`; `move` changes only `location`; `new_event` = the v1 create path (second event); `changeConfidence:'low'` => no delta, amber `change_unclear`, draft asks. Weekday word contradicting the resolved weekday => `change_unclear`. Free/busy prefetch for the new slot minus the block equal to the old slot. Output `EventDelta {kind, targetEventId, sourceItemId, baseRevision, from, to, confidence, assumptions, problems}` pinned from app rows.

### 4.5 S3 DRAFT with WhatsApp read tools

`gate.exposedTools()` = calendar tools when connected + `wa_get_chat_messages`, `wa_search_messages`, `wa_get_message_context` when `waAvailable()` + `wa_list_chats` only when `scope === 'all_chats'`. `LIMITS.draftToolCalls` 4 -> 6, `draftTurnsWithTools` 3 -> 4 `[V2+]`. The S3 `app_computed` object gains `delta: {change, from, to, confidence}` and the S3 prompt gains the constant rule "acknowledge the change in one sentence; never claim the calendar is already updated".

### 4.6 S4 VALIDATE additions

`update_event` action inserted when `delta !== null && calendarConnected && confidence !== 'low' && existing.status === 'confirmed'` (mutually exclusive with `create_event`); new amber badge `change_unclear`; `change_in_google` retired (kept in the enum for old rows); cross-chat leak guard (any 24-char normalised window of a row read from another chat found in the draft => `manipulation`, reason `cross_chat_leak`); persists `proposals.blocked_calls`, `proposals.provider_proof` (`{provider, initOk}`), `proposals.delta_json`, `proposals.image_read_json` (the literal fields for the card). Every proposal then goes through **S5a `executor.tryAuto()`** (section 5) before the dashboard is notified, so the card the user sees already carries either the auto result or the fallback reason.

---

## 5. Automatic mode (D-037) - policy, gate, executor, undo, and the UX around them

### 5.1 The user-facing model: a *grant* with a trial and an expiry

Settings > **Automatic mode** (its own group, after "Google Calendar"):

```
Automatic mode                                                          [ Off ]
  The agent adds and changes events in "Family" by itself.
  Replies always wait for your approval.

  What happens without asking you                What never happens
  - events from people you have written to       - deleting an event
  - within the next 30 days, up to 4 hours long  - inviting anyone
  - up to 3 per contact per day, 15 per day      - sending a WhatsApp message
  - each one shows a notification with Undo      - anything from a voice note or a picture (for now)
  - the mode ends in 30 days unless you renew it - anything the AI was unsure about

  Also change events when the contact asks       ( o )   on
  Also cancel events when the contact asks       ( o )   off   "A cancelled event is removed from the calendar; Undo restores it."
  Quiet hours 22:00-07:00                        ( o )   on

                                              [ Start a 24-hour trial ]   [ Turn on now ]
```

State card at the top of the group (one line + one action, like the status panel rows):

| `auto_policies.state` | Line (en) | Action |
|---|---|---|
| none / `disabled` / `expired` | Off - events wait for your approval. (expired: "Ended on 27 Oct.") | Start a trial / Turn on now |
| `shadow` | Trial - 2 events would have been added, 1 changed. You approved 2 unchanged, edited 1. Ends tomorrow 14:00. | **Turn on** (enabled after >= 3 shadow decisions) / Stop |
| `on` | On - 4 of 15 today · ends in 23 days. | Pause / Stop / Renew (last 7 days) |
| `paused` | Paused - {reason sentence}. | Resume / Stop |

Reason sentences (`paused_reason`): `user` "you paused it"; `circuit_breaker_rate` "it reached today's limit"; `circuit_breaker_undo` "you undid two changes today - it stopped to be safe"; `circuit_breaker_unknown` "one change could not be confirmed"; `unattended` "the app was not opened for a week"; `calendar_disconnected` "Google Calendar is not connected"; `snapshot_changed` "the calendar, account, AI provider or app version changed since you turned it on". Hebrew copy in the locale files (parity test).

**Enable = native dialog owned by main (MUST, I10).** `auto:requestEnable {scope, trial}` runs only from a focused, visible window outside the 300 ms focus guard, at most 3 per hour, and shows `dialog.showMessageBox(mainWindow, { type:'warning', noLink:true, defaultId:0, cancelId:0, checkboxLabel, buttons:[Cancel, trial ? 'Start trial' : 'Turn on'] })`:

- title: "Turn on automatic mode?" / "להפעיל מצב אוטומטי?"
- message: "Events will be added to and changed in '{calendar}' without asking you first." / "אירועים יתווספו וישתנו ביומן '{calendar}' בלי לשאול אותך קודם."
- detail: the six "what happens" bullets above + "Every change shows a notification with Undo. Replies still wait for your approval. Ends in 30 days." (the same bullets as the settings page - no new information appears only in the dialog)
- checkbox: "I understand events can be added or moved without asking me" / "אני מבין/ה שאירועים עשויים להתווסף או לזוז בלי לשאול אותי"
- accepted only with `response === 1 && checkboxChecked`; then one `auto_policies` row (`state = trial ? 'shadow' : 'on'`, `expires_at = +30 d`, `shadow_until = +24 h`, `confirm_json`, `scope_json` validated by `AutoScopeSchema` with hard ceilings, `snapshot_sha`), audit `auto_policy_enabled`, `auto:changed`, tray line added.

Disable/pause/resume need no dialog (fail-safe direction); reachable from Settings, the tray, the AutoStrip header and the Automatic activity page. `auto:endShadow` (trial -> on) is a focused-window click after >= 3 shadow decisions; the app never switches itself on at `shadow_until` - it shows the tally and asks. Expiry: banner + toast 3 days before; renewal = a fresh dialog.

### 5.2 Where automatic writes show up

1. **Windows toast** for every auto write (also when `notifications:'off'` - it is a safety control, the settings copy says so): title "Calendar: an event was added automatically" / "... moved automatically" / "... cancelled automatically", body "Open the app to see it.", **buttons `Undo` and `Show`** (Electron 44.4.3 has Windows toast actions - PR #48132 in v42+; the packaged smoke must click one). Never a title, never a name, never message text. Three writes within 10 minutes collapse into one summary toast ("3 events were added automatically - review"). The toast stores `{autoWriteId}` in main; `action` index 0 calls `executor.undoAuto(id, 'user_toast')` - no renderer involved.
2. **AutoStrip** above the three lists (`AutoStrip.tsx`): header "Done automatically today (N)" / "in the last 7 days (N)", collapsible (state in renderer memory, default open while any row has Undo available). Row = app-rendered `EventChip` + "added" / "moved from Wed 15:00" / "cancelled" + relative time + **Undo** (accent outline) + **Show** (opens the sheet). After the undo window (`min(72 h, event end)`) the Undo button is replaced by the chip "Undo no longer available" and the row leaves the strip after 7 days. The strip is not a fourth list: the item itself still lives in "In calendar" with the chip `Automatic` and the same Undo.
3. **Card chips**: `automatic` (info, "Added automatically" / "נוסף אוטומטית"), `auto_shadow` (info, "Would have been automatic" / "היה מתבצע אוטומטית" - trial only), `auto_fallback:<reason>` rendered as one muted line under the buttons "Not automatic: {reason}" / "לא בוצע אוטומטית: {reason}" (only while a policy is live; never fed back to the model).
4. **Settings > Automatic activity** page (`AutoActivity.tsx`): per-day list joining `auto_writes` + `auto_decisions` + the proposal's rendered event (untrusted text in a quoted bubble), Undo state, fallback reasons for items that were *not* automatic, budgets used today, remaining validity, **Export** (JSON, metadata only). Retention: decisions 90 d, writes 180 d, policies forever.

### 5.3 `AutoGate` + `executor.tryAuto()` (MUST; pure, LLM-free, exhaustive reasons)

`exec/autoGate.ts` imports nothing from `agent/**`, `llm/**`, `ipc/**` (import-graph test). `tryAuto(actionId)` is called by the orchestrator right after S4 for `create_event` / `update_event` only (never `send_reply`), in this order, each failure = `verdict:'fallback'` + a reason from `AUTO_REASONS` (the exhaustive enum of auto-mode-safety 5.5, adopted verbatim) shown on the card:

1. `inFlight` guard; load action; kind, `state='pending'`, not expired.
2. Live policy (`repos.autoPolicies.live()` with `snapshot_sha` check); `shadow` => evaluate everything, store `verdict:'shadow'`, return; `paused`/`expired` => reason.
3. Eligibility: `chats.is_known` (not `force_known`), `policy !== 'never'`, `auto_policy !== 'never'`, not tainted; zero badges of any tone; `blocked_calls === 0`; `suspicious === false`; no assumed hour; `missing.length === 0`; intent in `{schedule_request, confirmation, reschedule}` (+ `cancel` only with `scope.cancels`); `confidence === 'high'` (deltas: `changeConfidence === 'high'` and `refersToExisting`); **never media-derived** (`from_image`, `image_unclear`, voice-transcript trigger) in v2.0; **`provider_proof.initOk === true` when the proposal came from a vendor CLI** (`provider_unsafe` otherwise - this is what makes auto mode available with `claude_cli` and with `antigravity_cli` only when the per-run `init.tools` assertion passed).
4. Cage: own calendar (`CalendarInfo.accessRole === 'owner'` in the cached `list-calendars` result; absent = not owned), horizon <= 30 d, 5 min - 4 h, start >= now + 15 min (creates) / both old and new start >= now + 2 h (edits), quiet hours, no attendees/recurrence (types cannot express them; edits additionally check the fetched event), move <= 14 d, <= 2 auto edits per event, cancel never < 24 h before start.
5. Edits: pre-flight `get-event` (read class, app-side only): `waAgent='1'`, `waItem === String(items[deltaItem.linked_item_id].id)` and same `chat_id`, `creator.self` (or `organizer.self`), `status !== 'cancelled'`, no attendees, no recurrence, `updated`/`etag` equal to the app's last write (`auto_writes.post_*` / `event_revisions` newest / `items.calendar_updated`); snapshot kept as `pre_json`.
6. Sanity, fresh free/busy (overlap => `conflict`), duplicate => fallback (never `allowDuplicates:true` automatically), general rate limit AND auto sub-budgets (per chat 1/30 min, 2/h, 3/day; global 4/h, 15/day; `rate_events` buckets `auto_chat`, `auto_global`; any hit also pauses the policy).
7. **One transaction**: insert `auto_decisions {verdict:'auto'}`, `markApprovedExecuting(id, finalJson, now, decision.id)` (the trigger verifies the join - section 14 I1'), insert `auto_writes {pre_json}`, audit `action_approved {by:'auto'}` + `auto_decision`.
8. `runCreate` / `runUpdate` exactly as the click path from the write-ahead onward; `done | failed | unknown_outcome`; **a failed auto write becomes an ordinary pending card** (no retry clone); on success `get-event` readback -> `auto_writes.post_*`, `revision_id`, `items.calendar_updated`.
9. Notify (toast + `dashboard:changed` + AutoStrip), `autoRate.record`, circuit-breaker evaluation (`2 undos / 24 h`, any `unknown_outcome`, budget hit, 7 days unattended, snapshot change, calendar disconnect => `paused` with a toast + banner).

`approve()` (the click) sets `approved_by:'user'` and is otherwise unchanged. The model never learns auto mode exists: `buildSystemPrompt()` bytes, `exposedTools()` and the MCP `tools/list` are identical for every policy state (prompt-purity test extended); `auto:*` channels are absent from every MCP surface.

### 5.4 Undo (MUST; I8)

`item:undoChange {itemId, revisionId}` (zod strict, trusted frame, focused window - the same gate as `action:approve`; the toast door passes `'user_toast'` from main without a renderer) loads the newest `event_revisions` row for the event, asserts `reverted_by IS NULL`, builds a new proposal (provider `'user'`, version+1) whose delta is `{kind:'undo', from: next_json, to: prev_json}`, inserts a pending `update_event` with `revertOf`, and approves it immediately through the normal executor (every gate - drift, gone, free/busy, rate limit - still runs). Auto adds bookkeeping: `auto_writes.undo_state`, a `get-event` pre-check that `updated`/`etag` still equals `post_*` (else `blocked_changed`: card says "You changed this event in Google after it was added - undo would overwrite your change" + link), `blocked_started` when the event already started (card offers "Cancel event" as an explicit click instead), idempotent on double click, two undos in 24 h pause the policy.

| Auto write | Undo does |
|---|---|
| create | `update-event {status:'cancelled', sendUpdates:'none'}` (F1 variant A) or the soft cancel (variant B); item -> `declined`; card re-offers "Add" as a new proposal version (fresh deterministic id, no 409 against the cancelled one) |
| update | patch back `summary,start,end,timeZone,location` from `prev_json` with the full private tag map |
| cancel | `status:'confirmed'` + `prev_json` fields; if Google will not restore (404/410 or readback still `cancelled` - UNVERIFIED U-E1) the executor inserts a pending `create_event` with the previous content and the card offers **Add it back** - a user click (`approved_by='user'`), never an AutoGate write |

Copy through the flow (voice rule "an action keeps its name"): button "Undo" -> progress "Undoing..." -> result "Undone" (chip on the card; the AutoStrip row greys out and says "Undone").

---

## 6. Event editing (D-036) - the Change card and the `update_event` executor

### 6.1 Cards

**Change card** (the new open item linked to the source `in_calendar` item; list "Needs reply"):

```
| (1) Dana Levi                          14:02 [...]|
| (2) ,-------------------------------------------.|
|     | בוא נזיז ל-5                              ||   QuotedBubble (or VoiceBubble / ImageBubble)
|     '-------------------------------------------'|
| (3) Change: Wed 15:00 -> 17:00                   |   ChangeLine: from/to each in <bdi>; he: "שינוי: יום רביעי 15:00 ← 17:00"
|     [24 SEP]  Meeting  17:00-18:00               |   EventChip shows the NEW slot; inline editor edits `to` only
| (4) (~) 5 taken as 17:00                         |
| (5) - - Draft reply - - - - - - - - - - - - - -  |
| (6) [Approve & send]                             |
|     [Approve change]      [Keep 15:00]   [Copy]  |   Approve change = action:approve(update_event); Keep = action:reject
```

Cancel variant: line "Cancel: Wed 15:00 meeting" and buttons **Cancel event** / **Keep it**. `change_unclear` (amber): no change buttons, draft asks the contact ("just to be sure - are we cancelling Wednesday?"). While the change is pending the source card in "In calendar" shows a muted chip "Change proposed - see Needs reply"; the renderer keys the calendar list by `calendar_event_id`, so an event is never shown twice.

**After the change lands**: the acting item becomes the `in_calendar` card (`event_state = 'updated' | 'cancelled'`, `event_revision + 1`), the source item closes `superseded`; the card shows the chip `Updated · rev 2` / `Cancelled` + **Undo** (7-day window for manual changes, `min(72 h, event end)` for automatic ones) + "Open in calendar". A cancelled card leaves the list after 24 h (`past`).

**Drift** (the user moved the event in Google before approving): `action:approve` returns `needs_confirm_drift` with the current Google values; the card shows "In Google it is now Thu 16:00 - apply the change anyway?" with **Apply anyway** (`confirmDrift:true`) / **Keep Google's**. **Gone** (404/410/cancelled): `CAL_EVENT_GONE` inline + a pending `create_event` with the new content, button **Add as new event**. **Foreign** (tags not ours): `CAL_EVENT_FOREIGN` info line, no action.

### 6.2 Executor

`McpWriteClient.updateEvent(args)` built key by key from `UPDATE_EVENT_KEYS` (`calendarId, account, eventId, summary, start, end, timeZone, location, description, status, transparency, sendUpdates:'none', checkConflicts:false, ifMatch?, extendedProperties`); **always all five content fields** (absolute patch), the **complete** private tag map (`waAgent, waItem, waAction, waUpdate, waRev`; identity values copied from the pre-flight read, never recomputed); never attendees, recurrence, reminders, colour, visibility, conference, attachments, scope fields. Approve gate for `update_event` = event-editing 4.3 (pre-flight `get-event` for gone/foreign/drift, `baseRevision` compare-and-set vs `items.event_revision`, free/busy minus self, write-ahead, `done` only when the readback equals `to`, one outcome transaction with the `event_revisions` row and the audit kind `event_updated | event_cancelled | event_reverted`). `unknown_outcome` reconciles through `get-event` (never `list-events`: cancelled events are invisible to it). T-401 closes with the rule "an edited retry of a create whose chain-root event is found becomes an `update_event`".

### 6.3 F1: how "cancelled" reaches Google (decision taken here)

Recommend **variant A**: the two-insertion vendored patch of `@cocal/google-calendar-mcp@2.6.3` (`status` enum on `update-event` + `requestBody.status`) plus the `ifMatch` insertion, applied by the staging script under a sha256 pin of the unpatched bundle, verified at startup (`tools/list['update-event'].inputSchema.properties.status.enum` contains `"cancelled"`), with an upstream PR filed. **UX rule that overrides the research's fail-closed suggestion:** when the startup guard finds no `status` field, the app does **not** disable the whole calendar write surface; it sets `CANCEL_MODE='soft'` (summary prefix "[Cancelled] " / "[מבוטל] ", `transparency:'transparent'`, private tag `waCancelled`), shows the status-panel sub-line "Cancellations are marked, not removed (component version)" and audits `toolset_mismatch {reason:'status_missing'}`. Both modes are tested; the user never loses "Add to calendar" because of a cancel-only gap. `[LR]`

---

## 7. Read-only WhatsApp MCP (D-040)

Adopted from whatsapp-mcp-readonly and cli-mcp-bridge with these recorded choices: MCP server name **`wca`** everywhere (Claude rule `mcp__wca__*`, Antigravity rule `mcp(wca/*)`); tool name **`wa_get_chat_messages`** (not `wa_read_messages`); **per-run listener** (not a long-lived registry) `[LR]`; **one zod-first `ToolSpec` table** in `agent/toolDefs.ts` (`{name, backend, description, args: z.strictObject, maxCallsPerRun, exposedWhen, execute}`) from which the LLM-facing LCD JSON is derived once (`z.toJSONSchema(args, {target:'draft-07'})` + `toLcd()` that strips `$schema`, adds `required: []`, and **throws** on any non-LCD keyword; ranges live in descriptions and `execute`) and frozen byte-identical to the v1 literals by the I4 test; the MCP server registers the same zod shapes.

| LLM name | Args | Pinned by the app | Max/run | Exposed when |
|---|---|---|---|---|
| `get_current_time` | `{}` | - | 1 | calendar connected |
| `get_freebusy` | `{timeMin, timeMax}` | ids, zone, account, clamps | 3 | calendar connected |
| `wa_get_chat_messages` | `{chat, before_message?, limit?}` | chat = trigger unless `all_chats`; window; row cap 20 | 2 | `waAvailable()` |
| `wa_search_messages` | `{query, chat?, limit?}` | query NFKC + strip invisible, 2..64; chat pinned to trigger in `trigger_chat`; hits <= 10 | 3 | `waAvailable()` |
| `wa_get_message_context` | `{message, before?, after?}` | chat derived from the row + scope check; sides <= 8 | 2 | `waAvailable()` |
| `wa_list_chats` | `{limit?}` | DM only, policy filter, window | 1 | `waAvailable() && scope === 'all_chats'` |

`WaReadClient` (`bridge/waReadClient.ts`, constructed in `compose.ts` from `BridgeDb` + `repos.chats` + `repos.transcripts`) has **only read methods**; `BridgeDb` gains four SELECT-only methods (`messagesBefore`, `messageByRowid`, `searchContent`, `recentDmChats`), rowid-ordered, time windows filtered in TypeScript via `parseBridgeTs`. Results: `sanitizeForModel` per row, role labels, relative age + coarse day, **run-scoped opaque handles** (`chat_1` = the trigger chat, `m_N` = first-seen order; never names, numbers, JIDs, WhatsApp ids or clock times), voice rows surface as `kind:'voice'` with the transcript, `waTextChars` 500 / `waResultChars` 4,000, nonce-wrapped. Unknown handle => `blocked_bad_args` (no strike); unexposed name => strike as v1. Import-graph test: `toolserver`, `waReadClient`, `waTools`, `handles` never import `bridge/sendClient`, `bridge/readClient`, `mcp/writeClient`, `mcp/adminClient`, `mcp/host`, `exec/**`, `electron`. Injection corpus gains the `wa_row` vector (seeded as bridge rows, `chat: 'trigger' | 'other'`) and `mustNot` values `cross_chat_leak`, `system_prompt_leak`.

Settings row (Working rules): "Let the AI read older messages" - radio **Of this chat only** (default) / **Of all my chats** (+ sentence "With a cloud AI this sends parts of other chats to {vendor}"; selecting it with a cloud provider active opens the consent v2 dialog and refuses until accepted), advanced slider "How far back: 30 days". `wa_list_chats` therefore never appears for a default user.

---

## 8. Voice cards (D-039, local always)

**VoiceBubble** replaces the QuotedBubble for an audio trigger:

```
,--------------------------------------------------.
| (mic) Voice message · 0:42          Hebrew        |   app text; duration from the Ogg granule position; language chip from whisper
| Transcript                                        |   label --text-xs 600 muted
| בוא נזיז ל-5, אני אהיה עסוקה עד אז                |   transcript: msg-text, dir="auto", 3-line clamp, "Show more" opens the sheet; inert
'--------------------------------------------------'
```

States: while the item is `queued/running` it is not listed (v1 visibility rule kept); the "Needs reply" header line says **"Transcribing a voice note (0:42)... / מתמלל הודעה קולית (0:42)..."** instead of "Analysing N chats" so a long note is never a mystery. Failed states become raw cards with the reason chip and one action: `VOICE_MODEL_MISSING` "Voice model not downloaded" -> **Download (1.6 GB)**; `VOICE_AUDIO_MISSING` "The audio was not received" -> **Try again**; `VOICE_TOO_LONG` "Longer than 15 minutes - not transcribed" (no action); `VOICE_DECODE_FAILED` / `VOICE_LOCAL_FAILED` -> **Analyse again**; `LLM_VCREDIST_MISSING` reused. Empty transcript: "Voice message - no speech detected" (no LLM run). No audio playback in v2.0 (the phone plays it; the renderer holds display data only) - listed as a weakness.

Sheet: the conversation block renders the voice message as the same bubble with the full transcript and "Transcribed on this computer with the Hebrew voice model" in muted text. Cloud consent copies gain "including transcripts of voice notes". Onboarding step 1 offers "Also understand voice notes (1.6 GB, Hebrew-optimised)" as a checkbox, default on when free disk >= 4 GiB and RAM >= 8 GiB; the download queues behind the LLM download in the same DownloadPill ("voice model 62 %"). Settings > AI > Voice notes: Off / Hebrew-optimised (recommended) / Auto-detect language / Lite, with the size before confirming, "Test" (bundled 5 s fixture, shows "about N s per minute of audio"; suggests Lite when > 2 x realtime, never auto-switches).

---

## 9. Picture cards (D-039, follows the provider)

**ImageBubble**:

```
,--------------------------------------------------.
| [thumb 96 px] Text read from the picture          |   thumbnail (data URL, object-fit cover, rounded, never a link)
|   חתונת דנה ויוסי · יום חמישי 24.9.26 ·          |   readText, dir="auto", 3-line clamp, inert
|   קבלת פנים 19:00 · אולמי הגן …        Show more |
'--------------------------------------------------'
[24 SEP]  חתונת דנה ויוסי  19:00-20:00
(i) Read from a picture   (~) Hard to read - check the picture
```

Badges `[V2+]`: `from_image` (info), `image_unclear` (amber, a button that opens the sheet with the date field focused, like `time_assumed`), `image_unread` (info, on the placeholder card). Placeholder card "Photo" keeps its one action: **Download picture reading (0.99 GB)** when the local projector is missing (`model:startDownload {tier:'mmproj'}` - answers image-events Q1: prompt on the card, never in onboarding), or **Turn on in Settings** when `images.enabled` is off, or **Choose an AI that can read pictures** when the provider is `antigravity_cli` and no projector exists. Sheet: full picture (max 360 px, `object-fit: contain`, alt "Picture sent by <name>"), collapsible "What the AI read from the picture" with the literal `readText` and the three "as written" lines (Date / Time / Place as written), and under the EventEditor's date field the hint "Check against the picture" when `image_unclear`. Thumbnails are deleted with the item's 30-day text retention and immediately on Dismiss / Never analyse (answers Q3). Consent `cloud_images` (own version) is asked once per cloud provider the first time a picture would leave the machine; `images.cloud` defaults on when a cloud provider is active (D-039) but the consent click is the real gate (answers Q2). A later picture that changes the date of an existing event goes through the normal delta path only if S1 says `refersToExisting`; otherwise it is a new proposal with the `conflict` badge (answers Q5; nothing new to build).

---

## 10. Setting up the CLIs painlessly

### 10.1 The Connect card (onboarding step 1 and Settings > AI share it)

```
( ) Claude - your subscription                 (shield) The analysed chat is sent to Anthropic through your Claude Code sign-in.
    Uses the Claude plan you already pay for. No API key.

    state A  (x) Claude Code is not installed on this computer.
             Run this in PowerShell, then come back:   irm https://claude.ai/install.ps1 | iex   [Copy command]  [Check again]
    state B  (~) Claude Code 2.1.258 is installed but not signed in.                              [Sign in]      [Check again]
    state C  (v) Ready - Claude Code 2.1.258, signed in.   Model [ sonnet v ]  [Run a test]  "Ready - about 2 s"
    state D  (!) Claude Code 2.1.150 is too old (needs 2.1.221).  Run: claude update                [Copy command]  [Check again]
```

Detection (`cli:getStatus {provider}`, cached 60 s, never more than one `auth status` per minute): resolve the executable (settings override that must end in `claude.exe` -> `%USERPROFILE%\.local\bin\claude.exe` -> `where.exe claude` `.exe` entries -> a `.cmd` entry is resolved to the underlying `bin\claude.exe`, never run through a shell) -> `claude --version` (ENOENT => A; `< 2.1.221` => D) -> `claude auth status --json` -> `loggedIn === true` => C, `false` => B, unparsable => "unknown" shown as B with the sentence "Could not tell whether you are signed in" (never assumed logged out). For `agy`: `%LOCALAPPDATA%\agy\bin\agy.exe` -> `where.exe agy` -> `agy --version` (`>= 1.2.11`) -> `agy -p "/usage" --output-format json` (no quota spent): exit 0 + JSON => C (and the quota line is shown "as reported by the CLI"), exit 1 + `authentication required` => B.

**Sign in** (`cli:signIn {provider}`): main opens a *visible* console window - `cmd.exe /k "<claude.exe>" auth login --claudeai` or `cmd.exe /k "<agy.exe>"` - so Anthropic's / Google's own browser flow runs in front of the user; the app then polls `cli:getStatus` every 3 s for up to 5 minutes and flips the card to C. The app never reads `~/.claude/.credentials.json`, never uses `claude setup-token`, never touches the Credential Manager, never proxies the OAuth page. The card says so in one line: "Sign-in happens in Anthropic's own window; the app never sees your password or token."

**Run a test** (`cli:test {provider}`): one S1-shaped extraction of a constant English sentence with a 1-field schema, `haiku` / the Flash slug, `--max-turns 1`, 30 s; result line "Ready - about 2 s" or the mapped `ErrorCode`. The button says "(uses a little of your quota)". Provider activation requires C + consent + a passed test (`llm:setProvider` fails with the reason inline otherwise; A20's "never silently fall back" stands).

Antigravity card adds, above the states: the experimental disclosure in plain words - "Google's terms for Antigravity forbid 'third-party tools' and Google has suspended accounts for it; Google staff have also said running the official CLI on your own computer is fine. The app runs the unmodified `agy` with your own sign-in and nothing else, but the risk is yours. (Terms read on 2026-09-28.)" - and a setup sub-step **Allow the app's folder** (section 3.3) with the shown one-line diff. The consent record stores the Terms date.

### 10.2 Quota and limits in the status panel

`rate_limit_event` (Claude) / `/usage` (agy) feed `AppHealth.llm.quota = { resetsAt: EpochMs | null; usingOverage: boolean | null; note: string | null }`. AI row sub-line: "usage resets 15:40"; when a run ends in `USAGE_LIMIT` the row becomes the amber `CLOUD_QUOTA` state with body "Your Claude usage limit is reached. Continues by itself at 15:40. Chats wait as plain cards." (params `resetsAt`), the queue holds items as `held/budget` until `resetsAt`, and the action is "Open usage page" (`external:open {target:'claude_usage'}`). `isUsingOverage === true` shows a one-time toast + status line "Claude is using paid extra usage now" (real money). Per-hour cloud caps keep their v1 defaults; the settings copy says both CLIs share the window with the user's own interactive use.

### 10.3 Version drift

The CLI auto-updates under the app. Every run asserts the init event (fail closed), the version floor is re-read at provider start, and `--permission-prompts none` / other flags are gated by version. `CLI_TOOLSET_MISMATCH` copy: "Claude Code changed in a way the app does not recognise - the AI is paused to stay safe. Chats wait as plain cards." action **Export diagnostics**; the local provider is offered in the same row ("Switch to the AI on this computer").

---

## 11. DB schema deltas - one migration v4 (`PRAGMA user_version 3 -> 4`)

SQLite `CHECK` lists on `items.event_state`, `items.closed_reason`, `actions.kind`, `consents.kind` change, so `items`, `actions` and `consents` are **rebuilt** (12-step, `foreign_keys=OFF`, backup before, `foreign_key_check` after) in **one** migration together with every table below (a torn rebuild restores the pre-migration backup; a v3 fixture round-trip test is a release gate).

```sql
-- items (rebuilt)
event_state  CHECK IN ('none','incomplete','proposed','change_proposed','created','updated','cancelled','declined')
closed_reason CHECK IN (... v1 ..., 'superseded')             -- already present; used for the source item of an applied change
+ linked_item_id INTEGER NULL REFERENCES items(id)            -- the source in_calendar item of a delta
+ event_revision INTEGER NOT NULL DEFAULT 0
+ calendar_updated TEXT                                       -- RFC3339 `updated` of OUR last write (ownership baseline)
+ trigger_kind TEXT NOT NULL DEFAULT 'text' CHECK(trigger_kind IN ('text','voice','image'))
-- actions (rebuilt)
kind CHECK IN ('send_reply','create_event','update_event')
+ approved_by TEXT                                            -- 'user' | 'user_toast' | <auto_decisions.id>; NULL until approve time; frozen with the rest
-- trg_actions_state: the I1' text of auto-mode-safety 8.1 (sends need 'user'; calendar writes need 'user'|'user_toast' or a live-policy decision for THIS action)
-- consents (rebuilt)
kind CHECK IN ('whatsapp_tos','cloud_claude','cloud_gemini','cloud_claude_cli','cloud_antigravity_cli','cloud_images','auto_mode')
-- proposals
+ delta_json TEXT, + blocked_calls INTEGER NOT NULL DEFAULT 0, + provider_proof TEXT, + image_read_json TEXT
-- chats
+ auto_policy TEXT NOT NULL DEFAULT 'inherit' CHECK(auto_policy IN ('inherit','never','allow')), + auto_tainted_until INTEGER
-- runs
stage CHECK IN ('extract','draft','read_image','transcribe')   -- metadata only, as v1
-- new tables (DDL verbatim from the research reports; binding text goes to contracts.md 15.2)
event_revisions (id, calendar_event_id, item_id, revision, kind IN ('create','reschedule','move','cancel','undo'), prev_json, next_json, action_id, applied_at, reverted_by)  UNIQUE(calendar_event_id, revision)
auto_policies   (id, state IN ('shadow','on','paused','disabled','expired'), enabled_at, expires_at, shadow_until, confirmed_by IN ('native_dialog'), confirm_json, scope_json, snapshot_sha, paused_reason, disabled_at, disabled_reason)  UNIQUE partial index: one live policy
auto_decisions  (id, policy_id, action_id UNIQUE, item_id, chat_id, kind IN ('create','update','cancel'), verdict IN ('auto','shadow','fallback'), reason, checks_json, decided_at)
auto_writes     (id, decision_id UNIQUE, action_id UNIQUE, item_id, event_id, kind, pre_json, revision_id, post_etag, post_updated, post_sequence, undo_state IN ('available','undone','expired','blocked_changed','blocked_started','failed'), undo_until, undo_action_id, written_at)
transcripts     (chat_jid, wa_msg_id, status IN ('done','empty','failed','aborted'), text, language, seconds, model_label, error_code, created_at)  PRIMARY KEY(chat_jid, wa_msg_id) WITHOUT ROWID
media_cache     (item_id, chat_id, wa_msg_id, sha256, width, height, bytes, created_at)
-- model_files: + kind IN ('llm','mmproj','asr','vad') ; rate_events: buckets auto_chat, auto_global ; audit_log kinds += cli_run, tool_session, event_updated, event_cancelled, event_reverted, auto_policy_* (6), auto_decision, auto_write, auto_undo, auto_taint
```

Retention job additions: `transcripts.text` nulled with message previews; `media_cache` files unlinked with the item's text; `auto_decisions` 90 d, `auto_writes` 180 d. `data:purgeNow` covers all of them. Secrets table unchanged (no CLI secret exists).

---

## 12. IPC deltas (`src/shared/ipc.ts`; every channel trusted-frame + zod `.strict()` + `Result<T, ErrorCode>`; no channel accepts a JID, path, URL, tool name or MCP argument)

| Channel | Request | Notes |
|---|---|---|
| `action:approve` | `+ confirmDrift?: literal(true)` | `update_event` drift confirmation; `edit` for `update_event` applies to `to` fields only |
| `item:undoChange` | `{itemId, revisionId}` | one undo path (5.4); focused window |
| `item:getImage` | `{itemId}` | full-size normalised picture as a data URL (<= 400 KB); card lists carry only the thumbnail |
| `auto:getState` | - | policy summary, counters, shadow tally, budgets used today |
| `auto:requestEnable` | `{scope: AutoScope, trial: boolean}` | opens the native dialog in main; 3/h rate limit; focused window |
| `auto:disable` / `auto:pause` / `auto:resume` | `{reason:'user'}` | no dialog |
| `auto:endShadow` | `{confirm:true}` | >= 3 shadow decisions |
| `auto:undo` | `{autoWriteId}` | delegates to `item:undoChange` with `'user'` |
| `auto:listWrites` | `{sinceTs}` | AutoStrip + activity page |
| `auto:export` | - | JSON, metadata only |
| `cli:getStatus` | `{provider: 'claude_cli' \| 'antigravity_cli'}` | `{state:'not_installed'|'too_old'|'not_signed_in'|'unknown'|'ready', version?, minVersion, quotaNote?}` |
| `cli:signIn` | `{provider}` | opens the vendor's own login in a visible console; returns when the window was opened |
| `cli:test` | `{provider}` | one tiny run; `{ok, ms}` or ErrorCode |
| `cli:allowWorkspace` | `{provider:'antigravity_cli', confirm:true}` | the one-key `trustedWorkspaces` merge, with the diff shown first via `cli:previewWorkspaceChange` |
| `model:startDownload` etc. | `tier` enum gains `'mmproj' \| 'voice-hebrew' \| 'voice-multilingual' \| 'voice-lite' \| 'voice-vad'` | one downloader queue; DownloadPill labels per kind |
| `voice:selfTest` | - | bundled fixture; stores `bench_json` |
| `consent:get/accept` | kind enum extended | exact-version rule unchanged |
| `chat:setPolicy` | `+ {chatRef, autoPolicy:'inherit'|'never'|'allow'}` | per-contact auto opt-out from the card's `[...]` menu ("Never automatic for this contact") |
| `settings:set` | new groups (section 13) | **no `auto` group exists** - `SettingsPatchSchema` rejects it |
| `external:open` | targets `+ claude_install, claude_usage, antigravity_install, antigravity_terms, whisper_licence` | hard-coded URL table |
| push `auto:changed`, `cli:changed`, `queue:changed {transcribing?: {seconds}}` | | AutoStrip / Connect cards / header line |

---

## 13. Settings and onboarding deltas

### 13.1 Settings schema (`[V2+]`, one zod object, one JSON value)

```ts
llm: { provider: z.enum(['local','claude_cli','antigravity_cli','claude','gemini']),
       claudeCliModel: z.enum(['sonnet','haiku','opus']),             // aliases; default 'sonnet'
       antigravityModel: z.string(),                                  // slug from `agy models` at settings time; default 'gemini-3.8-flash-high'
       claudeModel, geminiModel, local: {...}, cloudDailyTokenBudget }  // v1
voice: { enabled: boolean, tier: z.enum(['auto','voice-hebrew','voice-multilingual','voice-lite']), maxMinutes: literal(15), threads: 'auto'|int }
images: { enabled: boolean /* true */, cloud: boolean /* true */ }
whatsapp: { processUnknownSenders, backlogHours, readTools: { enabled: boolean /* true */, scope: z.enum(['trigger_chat','all_chats']), windowDays: int 1..90 /* 30 */ } }
calendar: { ... v1 ..., cancelMode: z.enum(['status','soft']) }      // read-only in the UI; set by the startup guard
// NO `auto` group: automatic mode is a policy row (5.1)
```

Settings page groups (additions in bold): General - **AI** (three provider cards + "Show experimental" + "Advanced: API keys"; sub-rows **Voice notes** and **Pictures** with "Read pictures with the cloud AI" toggle + consent date) - WhatsApp - Google Calendar - **Automatic mode** (5.1) - **Automatic activity** (5.2) - Working rules (**Let the AI read older messages** radio + slider; per-contact list gains an "Automatic: inherit / never" column) - Replies - Privacy and data ("What leaves this computer" table gains rows for voice (nothing), pictures (vendor when cloud), older messages (vendor when tools + cloud), Antigravity local transcript).

### 13.2 Onboarding

| Step | Change |
|---|---|
| 1 Choose the AI | Cards in the order of section 3; the two subscription cards are the Connect card of 10.1 in compact form (state line + one action); API keys under "Advanced". Below the cards: checkbox "Also understand voice notes (1.6 GB)" (default on when disk/RAM allow) and the sentence "Pictures are read by the AI you choose; the local picture model (0.99 GB) downloads only when the first picture arrives." Downloads start at once and continue in the background (v1 D4 kept). |
| 2 Link WhatsApp | unchanged |
| 3 Google Calendar | unchanged; one new sentence at the end: "Later, in Settings, you can let the agent add and change events by itself." (automatic mode is deliberately **not** offered during onboarding: the trial needs real cards first) |
| 4 Ready | checklist gains "Voice notes: downloading 62 % / ready / off" |

---

## 14. Invariants I1-I7 as amended, plus I8-I10

| # | v2 text | Enforced by | Test |
|---|---|---|---|
| **I1'** | No WhatsApp send without a per-action user click. No calendar write without EITHER a per-action user click OR an `auto_decisions` row that belongs to this action, references an `auto_policies` row in state `on`, was produced by `AutoGate` inside the executor, and was stored before the write-ahead. | `trg_actions_state` requires `approved_by`; `send_reply` needs `'user'`; calendar writes need `'user'|'user_toast'` or the decision-to-live-policy join; only `ActionExecutor` holds send/write clients | trigger table incl. `approved_by` NULL / bogus / another action's decision / shadow-paused-expired policies; obedient attacker over the corpus **with a live `on` policy**: zero writes for unknown chats, <= budgets for known chats, zero `delete-event` ever |
| **I2'** | The LLM can reach only READ tools (calendar time + free/busy, WhatsApp read) with app-pinned arguments, and only through `ToolGate` - whether the caller is the in-process loop or a vendor CLI on the loopback MCP endpoint. The model is never told automatic mode exists. | `ToolGate` default-deny; `McpReadClient` + `WaReadClient` facades with no write method; the tool server has no capability of its own; `get-event`, `update-event` are app-side MCP classes never in the LLM table; prompt-purity extended with policy state | fake provider and fake CLI emit every write / unknown / case-variant / reference-server name -> all blocked + audited; `tools/list` == exposed names, all `readOnlyHint:true` |
| I3 | Send recipient = chat of the trigger message; **an update targets only the event pinned from `items.calendar_event_id` at proposal time** (`targetEventId`, `baseRevision` not editable) | payload zod strict; executor re-reads the items row and refuses on mismatch | forged `targetEventId` in `edit` rejected |
| I4 | Untrusted text never enters the system prompt or tool definitions - now including transcripts, image read text, existing-event fields (inside the nonce block only) and derived tool JSON | constants; `toLcd()`; purity property test over V0/V1/S1/S3 | byte-identical output for random untrusted inputs incl. transcripts, readText, policy state |
| **I5'** | One *trigger* chat per LLM context; WhatsApp read tools are scoped to the trigger chat unless the user chose `all_chats` (default off, consent v2 for cloud); every payload and tool result carries no names, numbers, JIDs, WhatsApp ids or clock times - only run-scoped handles, role labels and sanitised text; a draft can never contain text read from another chat | `ContextBuilder`, `minimize()`, `HandleTable` per run, S4 leak guard | payload snapshots per provider incl. tool results; regex sweep; `wr-exfil-other-chat` |
| I6 | The bridge can never touch the user's live store, port 8080 or the default webhook/outbox - **and neither can any Job or Listener**: whisper/CLI jobs see allow-listed env only; the tool server binds `127.0.0.1` on an ephemeral port never 8080; media is read only from `<userData>\bridge\store\` after a realpath guard | spawn invariants; env allow-list tests per Job kind; locator tests | one unit test per violated precondition; env key-set literal tests |
| I7 | A crash of any child **or job** never takes down the tray app and never duplicates a side effect; updates are write-ahead + `get-event` readback; an `executing` update found at startup becomes `unknown_outcome` and is reconciled by `sequence`/`updated`, never re-patched blindly; a failed listener degrades the CLI provider only | supervisor; JobRunner kill + reaper; deterministic ids for creates; absolute patch + `baseRevision` for updates | kill tests incl. between write-ahead and patch; "Add again"/"Apply again" -> exactly one event / one applied version |
| **I8** (new) | Every automatic write is reversible by one user click for at least the undo window, and the pre-write state needed to reverse it is stored BEFORE the write, in the same transaction as the write-ahead | `auto_writes.pre_json`; `event_revisions`; single `item:undoChange` path | create/update/cancel undo tests; drift => `blocked_changed`; double click => one call |
| **I9** (new) | The app never writes to a calendar event it did not create, and never to a calendar it does not own (auto) / cannot write (manual) | private tag map + `creator.self` + linked-item ownership on every update; `accessRole === 'owner'` for auto | ownership table test incl. `waItem` of another item/chat, attendees, recurrence, cancelled, drifted |
| **I10** (new) | Automatic mode can be enabled only by a user gesture in a focused window confirmed in a native main-process dialog, is recorded as a policy row with an expiry, and can be disabled from anywhere with one click | `auto:requestEnable` handler + `dialog.showMessageBox` + `auto_policies`; no `settings:set` path | toggle tests incl. unfocused, focus guard, response 0, no checkbox, 4th request per hour, `accessRole` variants |

Trust/taint rule additions: **transcripts, image read text, existing-event title/location, WhatsApp tool results, CLI stdout/stderr, `structured_output`, `denied_actions`, `AGY_ERROR` text and `auth status` JSON beyond `loggedIn`** are UNTRUSTED. A transcript may appear only in the nonce block and in the inert VoiceBubble; readText only in the nonce block and the inert ImageBubble; never in toasts, tray, window title, logs, file names or `shell.openExternal`.

---

## 15. Packaging and build deltas

| Item | Change |
|---|---|
| `resources/whisper/` | `scripts/fetch-whisper.mjs` (clone of `fetch-llama.mjs`): `whisper-bin-x64.zip` from tag `b5130` (8,573,270 B, sha256 `f9ec6c52…5316f3c`), strip the `Release/` prefix, allow-list `whisper-cli.exe, whisper.dll, ggml.dll, ggml-base.dll, ggml-cpu-*.dll` (~10.5 MB) - **a separate folder from `resources/llama/`** (ggml builds must not mix), its own copy of the three VC++ CRT DLLs when `VC_REDIST_CRT_DIR` is set; MIT text into `THIRD_PARTY_NOTICES.txt`; `electron-builder.yml` `extraResources` entry with the explicit filter; `smoke-packaged.mjs` asserts the file set |
| Runtime deps | `+ opus-decoder@0.7.12` (MIT; WASM embedded as a string, no `.wasm` file, no addon), transitively `@wasm-audio-decoders/common` MIT, `simple-yenc` MIT, `@eshaz/web-worker` Apache-2.0. `ogg-opus-decoder` **forbidden** (LGPL `codec-parser`); `jimp@1.6.1` allowed only as the documented image fallback; `sharp`, `canvas`, `@napi-rs/*`, `@anthropic-ai/claude-agent-sdk`, `@google/gemini-cli` **forbidden**. D-022 gate gains a licence allow-list (MIT / Apache-2.0 / BSD-2/3 / ISC / 0BSD) for runtime packages |
| Models | manifest gains `mmproj-F16.gguf` per tier at the v1 commits (985,654,080 / 990,372,672 / 175,115,840 B, sha256 per image-events 2.1; "never download `mmproj-*`" lifted for exactly these), voice tiers (ivrit-ai turbo f16 1,624,555,275 B; OpenAI turbo q8_0 874,188,075 B; small q8_0 264,464,607 B; Silero 6.2.0 885,098 B), `magic 'GGUF' | 'GGML'` (`6c 6d 67 67`); `pin-models.mjs` re-checks all of them |
| Calendar MCP | `ENABLED_TOOLS` gains `get-event`, `update-event` (8 names; toolset check: `update-event` carries `destructiveHint:true`); `scripts/stage-calendar-mcp.mjs` applies the vendored `status` + `ifMatch` patch under a sha256 pin of the 2.6.3 bundle, refuses any other bytes, refuses to patch twice; the v1 tool-list hash pin is updated; `smoke-packaged.mjs` asserts `tools/list` shows the `status` enum |
| Vendor CLIs | **never bundled, never downloaded, never installed by the app**; `resources/links.json` gains the install/usage/terms URLs; the installer is unchanged in size for them |
| llama-server | spawn gains `--mmproj <file> --mmproj-device none --image-max-tokens 1120` (tiny 560; mid `--batch-size 2048 --ubatch-size 2048`) only when `images.enabled && mmprojPresent`; readiness adds `GET /props` `modalities.vision === true`; self-test adds one golden image and stores `imageSec` |
| A16 amendment `[V2+]` | "Only **five** bridge endpoints are implemented": the v1 four plus `POST /api/download {message_id, chat_jid}`, reachable only from `media/locator.ts`, only for `media_type IN ('audio','image')` rows, only after the 30 s local wait failed, ids regex-guarded; `invariants.test.ts` asserts no other module references the path. `GET /api/media` stays unimplemented (`[LR]`, section 4.2) |
| Installer size | + ~4 MB (whisper zip compressed) + ~0.3 MB (decoder); models and projectors are runtime downloads (voice 1.62 GB default, projector 0.99 GB on demand) |
| Fuses / hardening | unchanged (A19); the renderer gains no capability: thumbnails and pictures arrive as data URLs under the existing `img-src 'self' data:` |

---

## 16. Decisions this proposal takes where the research left a choice (for `ops/DECISIONS.md`)

| # | Question (report) | Choice here | Why (UX-first) |
|---|---|---|---|
| P1 | F1: vendored `status` patch vs soft cancel (event-editing, auto-mode-safety Q1) | **Variant A + runtime `CANCEL_MODE='soft'` fallback**, never disable the write surface for a missing `status` field | a real cancel matches what the user expects; a cancel-only gap must not cost "Add to calendar" |
| P2 | `approved_by IN ('user','auto') DEFAULT 'user'` (event-editing 3.5) vs decision-id binding (auto-mode-safety) | **decision id, NULL until approve time**; `approve()` stays click-only; a post-undo re-create runs under the user's click | the DB can verify a join, not a constant |
| P3 | Per-run listener vs long-lived registry (cli-mcp-bridge vs whatsapp-mcp-readonly) | **per run** | nothing outlives a run; one fewer state to explain |
| P4 | MCP server name / tool name | **`wca`** / **`wa_get_chat_messages`** | one name in three rule syntaxes |
| P5 | `Read` tool on tool-less Claude runs | **no** (accept the #87234 retry); `Read` only in the V1 image fallback | "the AI has no tools" must be literally true |
| P6 | Claude default model | **`sonnet`** + `--fallback-model haiku`; aliases only in the UI | Opus burns the shared 5-hour window and may be unavailable on Pro |
| P7 | Ship the `agy` backend at all (gemini-cli-backend Q1) | **yes, opt-in behind "Show experimental" with the section 6 disclosure**; API-key Gemini under Advanced | the user asked for the subscription route; hiding the risk would be worse than stating it |
| P8 | Auto mode with `antigravity_cli` (cli-mcp-bridge, auto-mode Q5) | **allowed only per run whose init assertion passed** (`provider_proof.initOk`), else `provider_unsafe` fallback; same rule for `claude_cli` | one rule for both CLIs; the card explains the fallback |
| P9 | `wa_list_chats` in v2 (whatsapp-mcp-readonly) | **kept, exposed only in `all_chats` scope** | costs nothing for the default user |
| P10 | Default voice tier | **`voice-hebrew`**; the golden set may flip the default to multilingual before release | halves WER on WhatsApp Hebrew; the setting is one click |
| P11 | Media bytes: store file vs `/api/media` (image-events vs whisper-local) | **file-first + `/api/download` fallback for both kinds** (A16 -> five endpoints) | one media path; no streaming client |
| P12 | Trial (shadow) default (auto-mode-safety 5.4) | **the dialog's primary button is "Start a 24-hour trial"; "Turn on now" is the secondary** | seeing "would have been automatic" on real cards is the explainer |
| P13 | Fourth dashboard list "Automatic" (auto-mode-safety 6.1) | **no fourth list**: AutoStrip + `automatic` chip on the `in_calendar` card | keeps the three lists the user asked for |
| P14 | Same-day-only reschedules in auto (auto-mode Q6) | **cage stays <= 14 d; default scope as researched**; the trial tally will show whether to tighten | not enough evidence to narrow; the trial produces it |
| P15 | Golden edit cases location | **new `tests/golden/edits.jsonl`** | keeps v1 per-language counts valid |
| P16 | Audio playback on the card | **not in v2.0** | keeps "renderer holds display data only"; the phone plays it |
| P17 | `--system-prompt` vs `--system-prompt-file` (image-events Q6) | **`--system-prompt` on argv**, file fallback only if a constant grows past 8 KB | one code path; nothing on disk |

`[V2+]` list to record: `PROVIDER_IDS` + 2; `CONSENT_KINDS` + 4; `AUDIT_KINDS` + 14; `BADGES` + `from_image, image_unclear, image_unread, change_unclear, automatic, auto_shadow`; `LIMITS` + `cliWallClockMs`, `wa*`, `draftToolCalls 6`, `draftTurnsWithTools 4`, `undoWindowMs`; `ERROR_CODES` + `CLI_NOT_INSTALLED, CLI_VERSION, CLI_NOT_SIGNED_IN, CLI_TOOLSET_MISMATCH, CLOUD_AUTH, VOICE_MODEL_MISSING, VOICE_AUDIO_MISSING, VOICE_DECODE_FAILED, VOICE_TOO_LONG, VOICE_TIMEOUT, VOICE_LOCAL_FAILED, CAL_EVENT_GONE, CAL_EVENT_FOREIGN, CAL_UPDATE_FAILED, AUTO_NOT_CONFIRMED, AUTO_CALENDAR_NOT_OWNED` (each with title/body/one action in both locales); `LlmProvider.loop`/`runAgentic`/`LlmImagePart`; `BridgeDb` + 4 read methods; `BridgeReadClient.requestDownload()`; `RunCtx` + `handles`, `toolToken`; `ToolGateDeps` + `wa`, `waAvailable`; `ToolGate.exposedSpecs()`, `prefetchWaContext()`; `McpReadClient.getEvent()`; `McpWriteClient.updateEvent()`; `ActionExecutorHandle.tryAuto()`, `undoAuto()`; `ENABLED_TOOLS` 8 names; A16 five endpoints; migration v4; the MCP `wca` name.

---

## 17. Weaknesses (honest)

1. **Automatic mode is "approval with extra steps" for many messages.** Zero-badge, high-confidence, known-contact, non-media, in-cage proposals are a minority of real traffic; the trial will show a low automatic share and the user may feel the mode does little. The fallback reason on every card is the only mitigation; the user-echo/participation heuristics are SHOULD-only until measured.
2. **The user may stop reading the toasts.** Summary toasts and the AutoStrip reduce fatigue, but a misleading event title from a known contact sits in the user's calendar until noticed (T13 residual of D-037). The 7-day unattended pause is a heuristic (window focus).
3. **Subscription routes rest on vendor policy, not on API contracts.** Anthropic's position flipped three times in 2026 and "may enforce without prior notice"; Google's Terms section 6 wording is broad and forum "supported" answers are not the Terms. The app can only detect the consequence (`CLOUD_AUTH`) and offer the local provider or an API key. The Antigravity route puts the user's account at risk by their own informed choice.
4. **The CLIs auto-update under the app.** Every run's init assertion fails closed, but a semantics change (for example `--bare` becoming the `-p` default) turns into "AI paused" for the user until the app ships a fix; no auto-updater exists (A23).
5. **Cloud quota is shared with the user's own interactive use** and headless usage percentages are not exposed (Claude) or not published (Antigravity). "Continues at 15:40" is the best the status panel can say; a chatty week can lock the user out of their own Claude Code for hours.
6. **Antigravity tool-less mode cannot let the model choose what to look up**; the app prefetches a fixed window. The delta case that needs "what did we say three weeks ago" works only on Local, API-key and Claude CLI until upstream bugs #548/#916 close.
7. **Antigravity persists a local transcript of every prompt** (`~/.gemini/antigravity-cli/brain`) and loads the user's global hooks; `tools: []` neutralises the tools, the consent text discloses the rest. Whether the transcript can be disabled is UNVERIFIED.
8. **A loopback listener with a bearer token is open for up to 120 s per run**; any same-user process could reach read-only data the user already owns. Windows Defender's reaction to the packaged app's listener is UNVERIFIED (v1 already listens on loopback without a prompt).
9. **The vendored calendar-MCP patch is fragile** (sha256-pinned, guarded, but re-applied on every upgrade) and "cancelled = deleted" undo depends on Google restoring cancelled single events (UNVERIFIED); the re-create fallback keeps undo possible at the cost of a new id.
10. **Voice: CPU speed of the 1.6 GB f16 Hebrew model on the laptop target is unmeasured**; a 10-minute note may take minutes and delays the next chat's triage (concurrency 1). English/mixed notes through the Hebrew tier with forced `-l he` are UNVERIFIED; the golden set decides the default. Notes over 15 minutes are not transcribed. No playback on the card.
11. **Pictures: Hebrew OCR of Gemma 4 E2B/E4B is unmeasured**; expect RTL reversals and final-letter confusions; the literal "as written" lines and `image_unclear` are the only defence. Local projector encode may take 5-30 s + prefill on CPU. Pictures on the Gemini subscription route are not possible until `agy @path` is proven (they use local or the API key).
12. **Image and voice text are a second injection channel** (typographic injection reached 64 % success in CSA's note); defences are structural (zero tools, one turn, schema, badges, never-auto for media). The card shows what was read, but a user approving without reading defeats everything (v1 caveat, unchanged).
13. **Two items per event while a change is pending** (source `in_calendar` + new `needs_reply`) is a real state the renderer must de-duplicate by `calendar_event_id`; a bug there shows the event twice.
14. **One editable event per chat** (the newest). Two live events in one chat are not disambiguated in v2; a change against the older one becomes a `new_event` or `change_unclear`.
15. **Migration v4 rebuilds three CHECK-constrained tables plus adds seven**; a torn rebuild relies on the pre-migration backup. Pending approvals are not reconstructed after a restore (v1 rule).
16. **The app writes one key into a user-owned file** (`~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`), with consent and a shown diff - a first for this app's security posture; a concurrent `agy` write could clobber it (the app refuses while `agy` runs, but cannot see the IDE).
17. **More disk and RAM on the default path**: +1.62 GB voice model, +0.99 GB projector on the tiny/small tiers when the first picture arrives, +~60 MB peak for a 15-minute note, +1 GB RAM while the projector is loaded. The tier rule and the "Free up X GB" flow absorb it, but the laptop target gets fuller.
18. **Twelve new UNVERIFIED facts need the user present** (section 18); several (Claude stdin image, `init.tools` with `--tools ""`, Windows toast buttons in the packaged app, `agy` on 1.2.x) are on the critical path of a headline feature and can only be closed with the user's login on the dev PC.

---

## 18. UNVERIFIED register and the manual gates that close them (extends ARCHITECTURE section 19)

| # | Fact | Posture in this design | Closed by (user-supervised, dev PC) |
|---|---|---|---|
| U-C1 | With `--tools ""` + `ENABLE_TOOL_SEARCH=false` the `mcp__wca__*` names appear in `system/init.tools` and nothing else does | fail-closed init assertion; the observed set is pinned after the first smoke | one S3 smoke run with the user's Claude login against a fake bridge DB |
| U-C2 | `system/init.apiKeySource` literal for subscription OAuth | env allow-list is the guarantee | read it in U-C1 |
| U-C3 | Raw `claude -p --input-format stream-json` honours the `image` block with `--tools ""` and returns `structured_output` | fallback `--tools "Read"` on a one-file cwd | gate M-IMG-1: one golden image |
| U-C4 | `claude auth status --json` fields beyond `loggedIn`; whether it makes a network call | only `loggedIn` parsed; <= 1/min | first Connect-card run |
| U-A1 | `agy` 1.2.x headless honours workspace `--agent` with `tools: []`; `init.tools` empty; trust gate with `trustedWorkspaces` | provider stays "experimental"; auto mode `provider_unsafe` until proven | user installs `agy`, runs the Connect-card test |
| U-A2 | `agy -p "... @path"` delivers pixels headlessly | pictures on `agy` use local/API key | gate M-IMG-1b |
| U-A3 | `AGY_ERROR` field names, `denied_actions` shape, `/usage` JSON fields, `agy models` output | regex mapping; `LLM_BAD_OUTPUT` otherwise; "as reported by the CLI" | same smoke |
| U-A4 | Whether the headless transcript under `brain/` can be disabled or safely deleted | consent text states it is kept | docs re-read + smoke |
| U-E1 | `patch {status:'confirmed'}` restores a cancelled single event; retention window of cancelled events | re-create fallback | packaged smoke with a dummy event on a test calendar |
| U-E2 | `events.patch` merge-vs-replace for `extendedProperties.private`; `location:''` clears | always send the full map; accept a stale location | same smoke |
| U-N1 | Windows toast action buttons activate the packaged app (AppUserModelID + Start-menu shortcut) | toast Undo is one of three doors; the card and the activity page always work | clean Windows 11 VM: click Undo on a toast |
| U-N2 | Defender firewall prompt for the packaged app's loopback listener | v1 precedent (llama, calendar child) | packaged smoke |
| U-V1 | `opus-decoder@0.7.12` imports and decodes under Electron 44 main; DTX fixture decodes without `errors[]`; peak memory of a 15-min note | Wave-0 probe like `node:sqlite`; synthetic fixture generator; 15-min cap | Wave 0 + one user-recorded note for the golden set |
| U-V2 | CPU speed of turbo f16 on the laptop; model load share of wall time; Hebrew tier on English/mixed audio | first-run bench + "suggest Lite"; golden set decides the default; `whisper-server` swap documented | first-run bench on the laptop |
| U-I1 | Hebrew OCR quality of Gemma 4 tiers; Vulkan projector behaviour; CPU encode time | golden set gate; projector on CPU by default; `imageSec` suggestion | golden set + packaged smoke loading the mid projector |
| U-I3 | Bridge-written media files are complete when `messages.filename` appears | container validation + one 5 s retry; `/api/media` as the documented switch | packaged smoke with a fake-bridge partial-write scenario + first real picture |

---

Appendix A - copy deck additions (both locales; parity test extends): `auto.*` (state lines, dialog title/message/detail/checkbox/buttons, reason sentences for every `AUTO_REASONS` value, toast titles, strip header, chips), `change.*` (line, buttons, drift/gone/foreign sentences), `voice.*` (bubble label, transcribing header line, tier names, error deck), `image.*` (bubble label, read heading, as-written lines, placeholder actions), `cli.*` (four states per provider, install command line, sign-in sentence, test result, disclosure), `errors.<NEW CODE>.{title,body,action}` for the sixteen new codes. Voice rules of `ux.md` 15.1 apply: "the agent" / "the AI", action nouns in Hebrew buttons, never "please", every untrusted value through `<bdi>` + `Trans`.
