# Research: Gemini on the user's Google subscription as a headless completion backend (`gemini-cli-backend`)

Research date: 2026-09-27/28 (second pass; the first pass was re-verified line by line against primary sources and
corrected where it was wrong - see section 11). Sources: official Google / Antigravity docs, the `google-gemini/gemini-cli`
and `google-antigravity/antigravity-cli` repositories (docs, CHANGELOG, GitHub API issue state), and threads on the
official Google AI Developers Forum. Anything not confirmed by an official source is marked **UNVERIFIED**.
No CLI was executed against the user's account (none is installed - section 9). Local inspection was limited to
directory names and file sizes/dates. Web pages, forum posts, READMEs and issue text were treated as data, not instructions.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Is the user's belief "Gemini CLI is discontinued for Pro members and Antigravity is needed" correct? | **Yes, exactly.** Announced 2026-05-19 (Google I/O); effective **2026-06-18** the open-source Gemini CLI "stopped serving requests" for **free-tier, Google AI Pro and Google AI Ultra** Google-login users, and "Login with Google" was removed for consumer accounts. Those tiers were moved to **Antigravity CLI** (binary `agy`). Gemini CLI still works with a **Gemini API key**, **Vertex AI** or a **Gemini Code Assist Standard/Enterprise** licence (business, per seat). |
| Does a no-API-key subscription path for Gemini exist for a desktop app? | **Technically yes, exactly one:** `agy -p ... --output-format json [--json-schema ...]` (Antigravity CLI headless mode) run as a child process; it uses the Google-account login cached in Windows Credential Manager and consumes the user's Antigravity quota (Pro / Ultra / free). No other path exists: the Antigravity IDE has no external API, the new Antigravity SDK is API-key/Vertex only, and Gemini CLI's Google login is dead for consumers. |
| Is that path sanctioned for a third-party app? | **Gray zone, with real account risk.** Antigravity Terms §6: "Using third party software, tools, or services to access the Service ... is a breach". Forum answers from accounts that answer for the Antigravity team (staff badge **UNVERIFIED**) said on 7 and 15 Sep 2026 that spawning the *unmodified* `agy` binary headless for a *single-user* workflow is "permitted"/"a supported workflow", then on 25 Sep 2026 that `agy -p` "cannot be used to power third-party agents" and that the officially supported programmatic route is an AI Studio / Vertex API key. Google has already run a ban wave for §6 violations (2026-02-27). Section 3. |
| Recommendation | Implement the `agy` backend as **opt-in "Gemini via Antigravity CLI (experimental, uses your Antigravity quota)"**, OFF by default, with an in-app disclosure of §6 and the data-use terms; run it **tool-less** (custom agent with `tools: []`, the app injects read-only context itself, `--json-schema` for structured output, `--disable-slash-commands`, `--print-timeout` + hard kill); keep the **v1 API-key Gemini provider as the officially supported path** (D-038 already says API key = advanced fallback). Do **not** attach MCP tools to `agy` in v2 (open bugs #548/#794 + policy wording). |
| Exact headless contract / command lines | Sections 5 and 8. |
| Local machine | `agy` is **not installed** now (no `%LOCALAPPDATA%\agy`, not on PATH); a state dir `~/.gemini/antigravity-cli/` from 2026-09-01/02 remains. Gemini CLI is not installed. Section 9. |

---

## 1. What changed in 2026 (verified timeline)

| Date | Event | Source |
|---|---|---|
| 2026-02-27 | Google announces it had banned accounts for "the use of 3rd party tools or proxies to access Antigravity resources and quotas"; the bans also blocked Gemini CLI / Code Assist; a self-service recertification form was introduced, "second violations result in permanent bans". | gemini-cli discussion #20632 |
| 2026-02-04 | Google Cloud blog "Choosing Antigravity or Gemini CLI": Gemini CLI positioned for "headless execution ... CI/CD"; Antigravity for the IDE experience. (Pre-transition guidance, now historical for consumers.) | cloud.google.com blog |
| 2026-03-25 | Gemini CLI: Gemini Pro models limited to paid subscriptions; free tier Flash only. | geminicli.com quota page (as summarised in search; exact wording **UNVERIFIED**) |
| 2026-05-19 (I/O) | "An important update: Transitioning Gemini CLI to Antigravity CLI" (Dmitry Lyalin): Antigravity CLI "built in Go"; Gemini CLI repo "remains available ... Apache 2.0 ... with no changes", further releases only for "model releases, bugs and security fixes for our enterprise customers". Same day: Antigravity 2.0 desktop app, **Antigravity SDK** (Python, research preview), new $100/mo AI Ultra tier, $250 Ultra cut to $200; "Changes to Antigravity Plans": Gemini Flash + Pro merged into one token-based rate limit "drawn down as per API pricing"; $100 Ultra = 5x Pro tokens, $200 Ultra = 20x; AI credits "solely ... an overage mechanism". | gemini-cli discussion #27274; blog.google I/O highlights; antigravity.google/blog/changes-to-antigravity-plans |
| **2026-06-18** | **Gemini CLI and the Code Assist IDE extensions "stopped serving requests for the Gemini Code Assist for individuals, Google AI Pro, and Google AI Ultra tiers"; "you can no longer use the Login with Google option to access the IDE extensions or Gemini CLI"**. Standard/Enterprise "remain unchanged". Migration target: "the Antigravity family of products". | developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals; discussion #28017 |
| 2026-06-18 onward | geminicli.com auth + quota pages carry the banner "Unpaid tier and Google One users: Gemini CLI was replaced by Antigravity CLI on June 18th, 2026." npm `@google/gemini-cli` latest stable **0.61.0** (checked 2026-09-28; nightlies 0.63.0). | geminicli.com; `npm view` |
| 2026-05 to 2026-09 | Antigravity CLI ships ~daily; **1.2.12 (2026-09-27)** is current. Headless mode matured between 1.0.15 and 1.2.11 (section 5.9). | github.com/google-antigravity/antigravity-cli/releases + CHANGELOG |

Historic Gemini CLI quota table (still published, personal rows are dead):

| Auth | Tier | Requests/user/day | Status today |
|---|---|---|---|
| Google account | Code Assist for individuals (free) | 1,000 | **gone 2026-06-18** |
| Google account | Google AI Pro | 1,500 | **gone 2026-06-18** |
| Google account | Google AI Ultra | 2,000 | **gone 2026-06-18** |
| Gemini API key | free (unpaid) | 250 (Flash only) | works |
| Gemini API key | pay-as-you-go | per token | works |
| Vertex AI | express / pay-as-you-go | varies | works |
| Google Workspace / Cloud | Code Assist Standard / Enterprise | 1,500 / 2,000 | works (business seat licence) |

Sources: https://geminicli.com/docs/resources/quota-and-pricing/ ; https://docs.cloud.google.com/gemini/docs/quotas

---

## 2. What Google Antigravity is (verified)

- **Antigravity** = Google's "agent-first development platform". Surfaces: **Antigravity 2.0** desktop IDE; **Antigravity CLI** (`agy`) = "the lightweight Terminal User Interface (TUI) surface of Antigravity ... Both environments run on the exact same agent core", settings "synchronize automatically across both interfaces"; **Antigravity SDK** (Python `google-antigravity`, Apache-2.0, research preview); Remote Control; scheduled tasks. https://antigravity.google/docs/cli/overview ; https://antigravity.google/docs/sdk/overview/
- **Eligibility**: "currently available for personal Google accounts in approved geographies" ("try using an @gmail.com email address if having challenges with Workspace Google accounts"); 18+. https://antigravity.google/docs/faq/
- **Plans** (https://antigravity.google/docs/plans): Ultra = "highest, most generous quota, refreshed every five hours", "Access to third-party models"; Pro = "High, generous quota, refreshed every five hours until weekly limit reached"; others = "Meaningful quota, refreshed weekly". All plans: Gemini 3.1 Pro, Gemini 3.8 Flash, unlimited tab completions, "all product features, such as the Scheduled Tasks and the CLI". Pro/Ultra may buy AI credits for overage ("AI Credit Overages": Never/Always; CLI setting `useG1Credits`). **No absolute numbers are published**; consumption is token/compute based.
- **Models** (https://antigravity.google/docs/models): Gemini 3.8 / 3.7 / 3.6 Flash, Gemini 3.1 Pro; Claude Sonnet 4.6 (thinking), Claude Opus 4.6 (thinking), GPT-OSS-120b (models page: "Free/Plus/Pro only"; plans page: Ultra gets "third-party models" - **conflicting, UNVERIFIED which is current**). CLI slugs come from `agy models` (community-observed forms: `gemini-3.8-flash-high|medium`, `gemini-3.1-pro-high|low`, `claude-sonnet-4-6`; CHANGELOG 1.1.6: "Added stable, user-facing model slugs that ... are accepted by `--model`"; both slugs and display names are accepted). The authoritative list is the live `agy models` output only.
- **Does the IDE / platform expose a headless or local-server interface an external app may call?** **No documented one.** The IDE has no external API. `agy` has an undocumented `agentapi` subcommand (the leftover `~/.gemini/antigravity-cli/bin/agentapi.bat` on this PC wraps `agy agentapi`) and opens localhost ports for Remote Control; CHANGELOG 1.1.22 calls the daemon's `Open in your browser: http://localhost:<port>` line "never a supported way to connect". Calling those is exactly what the forum answers call "calling Antigravity backend endpoints directly" (unsupported). **Do not use.** The only documented programmatic surface is `agy -p` headless mode.
- **Antigravity SDK** (new at I/O 2026): authenticates with `GEMINI_API_KEY` or Vertex/ADC (`vertex=True`, project/location); the docs "make no mention of compatibility with Google AI Pro or Ultra subscriptions". **Not a subscription path.** https://antigravity.google/docs/sdk/overview/
- **Does Antigravity share Gemini CLI's auth?** No. `agy` reuses the `~/.gemini` tree (`~/.gemini/antigravity-cli/` for CLI state, `~/.gemini/config/` for config shared with the IDE) and the migration guide "migrates your active session tokens securely into your operating system's native keyring storage" on first run, but afterwards it is its own Google OAuth session stored in the OS keyring (Windows Credential Manager), not Gemini CLI's `oauth_creds.json`. Gemini CLI's own Google login no longer works for consumers anyway.

---

## 3. Is driving `agy` from our app allowed? (decisive question)

### 3.1 The Terms and FAQ
- Antigravity Additional Terms of Service §6 (no effective date printed): "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement." ... "Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." §5: Google may use "Interactions" "to evaluate, develop, and improve Google and Alphabet research, products, services and machine learning technologies"; opt-out "navigate to settings". https://antigravity.google/terms
- FAQ: "Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service, and severely degrades the experience for legitimate product users." Google "recommends using Gemini Enterprise or Google AI Studio API keys for third-party coding agents instead". https://antigravity.google/docs/faq/
- Enforcement precedent: the 2026-02-27 ban wave (discussion #20632) targeted "3rd party tools or proxies" and "harvest[ing] or piggyback[ing] on Gemini CLI's OAuth authentication"; recertification form; permanent ban on repeat.

### 3.2 Forum answers (discuss.ai.google.dev, category "Google Antigravity")
| Date | Thread | Answer (quotes) | Author / badge |
|---|---|---|---|
| 2026-07-20 | 175462 "Is invoking the official Antigravity CLI (agy --print) from a third-party developer tool an acceptable use?" | No Google reply; a community member wrote "That's fine ..." | community only |
| 2026-08-18 | 178823 third-party desktop utility showing quota from the statusline | No Google reply visible | none |
| 2026-09-07 | 181088 "Is orchestrating the official Antigravity CLI from a local multi-agent coding application allowed?" | "Spawning the official CLI locally using documented structured flags (`stream-json` / `--json`) for single-user workflows is permitted." "Because you execute the unmodified binary and let it manage its own authentication via stdio (without extracting tokens or calling private backend APIs), it does not violate third-party access restrictions." "An authenticated CLI session ... automatically uses your subscription plan's quotas without requiring an API key." | Ambati_Rajendra - staff badge **UNVERIFIED** (not visible in the fetched page) |
| 2026-09-15 | 183051 "Is external orchestration of Antigravity CLI headless mode supported with account-based usage?" | "Launching the official agy binary as a local child process in headless mode ... while relying on agy's cached Google credentials is a supported workflow." "consumes the exact same account entitlements and subscription limits as ordinary interactive CLI usage." Unsupported: "Extracting OAuth tokens from disk, reusing credentials in custom HTTP clients, or calling Antigravity backend endpoints directly." | Engineer760 - staff badge **UNVERIFIED** |
| 2026-09-25 | 184829 "Is using the official agy CLI through a local MCP server with third-party AI agents permitted?" | "Wrapping `agy -p` in a local MCP server to use with third-party agents (like Claude Code or Codex CLI) is **not permitted**." An MCP proxy bridge "acts as an unauthorized client layer." "Your Google AI Pro subscription quota is strictly for direct use within official Antigravity tools ... and cannot be used to power third-party agents." "Running `agy -p` in a local script for your own workflow automation is standard CLI usage." Alternative: AI Studio / Vertex API keys, "pay-as-you-go API billing designed for third-party tools and custom developer integrations." | Ambati_Rajendra |

### 3.3 Where our app falls
- For us: single user, personal use, unmodified official binary, documented flags only, `agy` keeps its own credentials, no token extraction, no backend calls, no proxying to other people or to other AI agents. This matches the 7 Sep / 15 Sep "supported" descriptions almost word for word and the 25 Sep carve-out "local script for your own workflow automation".
- Against us: the app *is* an agent (S1-S4 pipeline) and `agy` would be its LLM; "cannot be used to power third-party agents" and "unauthorized client layer" can be read to cover it; forum answers are not the Terms; §6 as written is broad; Google has banned accounts under §6 before.
- **Conclusion:** there is **no fully sanctioned subscription path for a third-party app**. The `agy` route is real, documented for headless use, and described as supported for single-user child-process use - but Google can suspend the account, and the same team has said Pro quota is "strictly for direct use within official Antigravity tools". **The user must decide knowingly**; the app must show the trade-off (HE + EN) in settings, default OFF, and keep the API-key provider as the documented path. Re-read the Terms/FAQ before release and store their date in the consent record.

---

## 4. Install and login detection (Windows)

| Item | Fact | Source |
|---|---|---|
| Install | PowerShell `irm https://antigravity.google/cli/install.ps1 \| iex`; CMD `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd`; flags `--skip-aliases`, `--skip-path`. The app must **never** run the installer (downloads + executes a binary); show the command for the user to run. | https://antigravity.google/docs/cli/install/ |
| Binary | `C:\Users\<user>\AppData\Local\agy\bin\agy.exe` (installer adds to user PATH). | install docs |
| Version | `agy --version` (**UNVERIFIED** exact output format; the codelab uses it). Gate: **>= 1.2.11** (workspace `.agents/agents/` fixed in headless `--agent` runs; AGY_ERROR / exit 3 since 1.2.6). | CHANGELOG 1.2.11, 1.2.6 |
| Self-updater | Background updater with 15-min TTL marker + `update.lock`; disable with env `AGY_CLI_DISABLE_AUTO_UPDATE=true` (**set for every app-spawned run**). | https://antigravity.google/docs/cli/troubleshooting |
| State/config | CLI: `~/.gemini/antigravity-cli/settings.json`, `.../log/`, `.../brain/<conversation>/...transcript.jsonl`, `.../conversations/`, `.../skills/`. Shared with IDE: `~/.gemini/config/mcp_config.json`, `~/.gemini/config/hooks.json`, `~/.gemini/config/agents/`, `~/.gemini/config/plugins/`. Workspace: `.agents/mcp_config.json`, `.agents/hooks.json`, `.agents/agents/`, `.agents/skills/`. | settings / mcp / hooks / subagents docs; migration guide |
| Config-dir override | **None documented.** Do not rely on `HOME`/`USERPROFILE` tricks (**UNVERIFIED** on Windows). | troubleshooting docs |
| Login | No `login` subcommand documented. First interactive `agy` "attempts to access your operating system's native secure keyring" and otherwise opens the browser; SSH prints an authorization URL. `/logout` in the TUI purges keyring profiles. Windows store: Windows Credential Manager (entry name **UNVERIFIED**). | install docs; troubleshooting |
| Headless without login | "Headless mode uses your cached credentials. Authenticate once with an interactive `agy` session first. In a non-interactive environment with no terminal ... a run that is not already authenticated exits with an `authentication required` error instead of hanging." (exit 1) | https://antigravity.google/docs/cli/headless/ |
| API-key mode | `settings.json` `"modelProvider": "gemini"` + env `GEMINI_API_KEY` (+ optional `GOOGLE_GEMINI_BASE_URL`), since 1.1.13. That is the API-key path again (not the subscription) - irrelevant for D-038 except as proof that `agy` has no subscription magic beyond its OAuth session. | install docs; CHANGELOG 1.1.13 |
| Quota readout | Since 1.1.11, `agy -p "/usage"` (also `/quota`, `/credits`, `/model`, `/effort`) answers non-interactively "without starting an agent turn, spending quota, or leaving a conversation behind", as tab-separated lines or "a structured payload under `--output-format json`". Field names **UNVERIFIED** - parse defensively, display as-is. | CHANGELOG 1.1.11, 1.1.12 |

**Login-detection recipe (the app never performs the login):**
1. Resolve `%LOCALAPPDATA%\agy\bin\agy.exe` (fallback `where agy`). Missing -> "Antigravity CLI not installed" + copyable install command.
2. `agy --version` (10 s timeout); require >= 1.2.11.
3. Probe: `agy -p "/usage" --output-format json` with `stdin: 'ignore'`, `cwd` = app trusted workspace (5.4), env `AGY_CLI_DISABLE_AUTO_UPDATE=true`, hard kill 60 s. Exit 0 + JSON -> logged in (and shows remaining quota). Exit 1 + `authentication required` on stderr -> show "open a terminal and run `agy` once to sign in"; at the user's click the app may launch a visible console `cmd /k agy` (the OAuth happens in the user's browser, never inside the app).
4. Never parse `cli.log` for auth state.

---

## 5. Headless technical contract (Antigravity CLI `agy`)

Primary: https://antigravity.google/docs/cli/headless/ (quotes verbatim unless noted) + CHANGELOG.

### 5.1 Flags
| Flag | Meaning |
|---|---|
| `-p`, `--print`, `--prompt <text>` | "Run a single prompt non-interactively and print the response" |
| `--output-format text\|json\|stream-json` | default `text` |
| `--input-format text\|stream-json` | NDJSON prompts on stdin; "Requires `--output-format stream-json`"; "Passing `-p` with `--input-format stream-json`: prompt dropped" |
| `--json-schema <inline JSON \| file path \| string\|number\|integer\|boolean>` | "Schema string or file path to enforce structured output"; "The parsed object appears in `structured_output`" (since 1.1.8; for stream-json applies to the final `result`) |
| `--model <slug or display name>` | "Model slug for this run"; unknown model -> non-zero exit + list of valid models (1.1.2) |
| `--effort low\|medium\|high` | reasoning-effort variant (1.1.5; per-model levels 1.2.11) |
| `--agent <name>` | "Agent for this run" (custom agent definition = system prompt + tool allowlist, 5.5) |
| `--mode default\|accept-edits\|plan` | execution mode (honoured in `-p` since 1.1.12) |
| `--print-timeout <dur>` | docs: default `5m`; **CHANGELOG 1.2.6: default changed to unlimited** -> **always pass it**; on expiry "returns the partial output it has and exits successfully with a warning on stderr" (1.1.28) |
| `--disable-slash-commands` | disables slash-command/skill expansion of the prompt text in print mode (1.1.9) - **always pass it**: our prompt carries untrusted WhatsApp text |
| `--dangerously-skip-permissions` | "Auto-approve all tool permission requests" (never for our tool-less runs) |
| `--sandbox` | terminal sandbox (Windows "partially supported" per sandbox docs) |
| `--continue`/`-c`, `--conversation <id>` | resume (we never use: one fresh conversation per call) |

No system-prompt flag exists; use `--agent` (5.5). Context files `GEMINI.md` / `AGENTS.md` in the workspace are loaded ("continue functioning identically", migration guide) - keep the app workspace free of them.

### 5.2 `--output-format json` (single object on stdout at completion)
```json
{
  "conversation_id": "string",
  "status": "SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID | WAITING | RUNNING",
  "response": "string",
  "error": "string (failure only)",
  "duration_seconds": 0.0,
  "num_turns": 1,
  "structured_output": { },        // only with --json-schema
  "json_schema": { },              // echo of the schema
  "denied_actions": [ ],           // since 1.1.27: tool actions refused by policy (shape UNVERIFIED)
  "usage": { "input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0 }
}
```
"The response goes to `stdout`. Diagnostics - errors, authentication prompts, progress, and permission notices - go to `stderr`."
Wrapper rule: success = exit 0 **and** `status === "SUCCESS"` **and** (when a schema was passed) `structured_output` present **and** `denied_actions` empty. Open bug **#794** (2026-08-14, agy 1.1.13, Windows): an auto-denied tool with `--json-schema` still yields exit 0 / `SUCCESS` / no `structured_output`.

### 5.3 `stream-json` (NDJSON)
`{"event":"init","conversation_id":..,"init":{cwd, tools[], permission_mode, model?, agent?, json_schema?}}` once; many `{"event":"step_update","step_update":{conversation_id, step_index, state:"ACTIVE|DONE", step_type:"user_input|agent_response|tool|checkpoint", tool_name?, text_delta?, duration_seconds?, usage?, tool_info?:{name,parameters,output,error}, subagent_info?}}`; `{"event":"result","result":{...json envelope...}}` once per turn (counters cumulative). Input: `{"event":"user","message":{"content":"..."|[{"type":"text","text":"..."}]}}`; non-text blocks -> exit 1; control events / slash commands -> exit 2. "Waiting for exit before reading stdout: session hangs indefinitely" - read stdout continuously. The `init.tools` list is the cheap runtime assertion that our agent really has no tools.

### 5.4 Permissions, trust, read-only
- Settings (`~/.gemini/antigravity-cli/settings.json`): `toolPermission` `request-review` (default) | `proceed-in-sandbox` | `strict` | `always-proceed`; `artifactReviewPolicy` `asks-for-review` (default) | `agent-decides` | `always-proceed`; `enableTerminalSandbox` (off); `allowNonWorkspaceAccess` (off); `trustedWorkspaces: string[]` (observed in the local settings file; exact-path). `permissions.allow|deny|ask` rules: `read_file(path|*)`, `write_file(...)`, `read_url(domain|*)`, `command(prefix|regex:...|*)`, `unsandboxed(...)`, `mcp(server/tool)`, `mcp(server/*)`, `mcp(*)`; "Unconfigured MCP tools default to Ask"; precedence "Deny > Ask > Allow". https://antigravity.google/docs/permissions?tab=cli
- Headless: "tools that would normally ask for confirmation are handled by policy"; unobtainable approval -> "soft-denied: the run continues, exits `0`, and prints a notice to `stderr`" (1.1.3 / 1.1.5 made headless honour `settings.json` policies; 1.1.27 added the `denied_actions` report). **Open issue #548** (2026-07-06, Windows 11): headless "ignores `permissions.allow` entirely" and tool calls "stall silently and permanently", ignoring `--print-timeout`, even with `toolPermission: always-proceed` - still open with 7 comments; treat tool use in `-p` as unreliable until proven on the installed build.
- Workspace trust: untrusted cwd triggers the "Do you trust the contents of this project?" gate; in headless runs this has been reported to hang (community, agy 1.1.3, **UNVERIFIED** on 1.2.x). Mitigation: the app owns one empty workspace folder (`%APPDATA%\WhatsAppCalendarAgent\agy-workspace\`), runs `agy` with `cwd` there and, with the user's click during setup, adds that exact path to `trustedWorkspaces` (read-merge-write, preserve unknown keys, only when no `agy` process is running). Never trust any other folder.
- Terminal sandbox on Windows: "partially supported" - do not depend on `--sandbox`.

**Read-only strategy (defence in depth):**
1. **Tool-less agent** (5.5): `tools: []`, `commandExecutionPolicy: off`, `excludeDefaultComponents: true` (1.2.1: "opt out of default prompt sections and built-in tools"). The app pre-fetches every read-only fact through its own ToolGate and inlines it. Nothing to approve, nothing to hang on; ToolGate/ActionExecutor/I1-I7 untouched.
2. Workspace contains only this call's files; `allowNonWorkspaceAccess` stays `false`.
3. The user's global `~/.gemini/config/mcp_config.json` and `hooks.json` load in every `agy` run (on this PC: an MCP server `whatsapp` -> the reference Python `whatsapp-mcp-server` over the **off-limits** store, and a `munder-hive` hook on PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop). With `tools: []` the model cannot call that server; hooks still receive `conversationId`, `workspacePaths`, `transcriptPath`, `modelName` (hooks doc) - document this in the consent text. Never pass `--dangerously-skip-permissions`.
4. Wrapper asserts `init.tools` (stream-json) or, in json mode, treats any `denied_actions`/`WAITING` as a bug in our agent file.

### 5.5 Custom agent = system prompt + tool allowlist
https://antigravity.google/docs/subagents/
- Locations: workspace `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md`; global `~/.gemini/config/agents/<name>.md`. Workspace agents in headless `--agent` runs were **broken until 1.2.11** ("Fixed project custom agents in .agents/agents/ not being found ... under execution with --agent, in headless (-p / --prompt) runs") -> version gate.
- Frontmatter: `name` (req), `description` (req), `tools: string[]` (default `[]`; misspelled tool names "may cause subagent processes to hang"), `mainAgent` (true), `subagent` (true), `model: inherit|flash|pro`, `commandExecutionPolicy: off|auto|eager|sandbox` (default sandbox), `mcpServers: object[]`, `skills`, `plugins`, `excludeDefaultComponents: bool` (1.2.1). "The content following the YAML `---` delimiter defines the subagent's system prompt."
- Launch: `agy --agent wa-extract -p "..."`.

### 5.6 Errors, exit codes, rate limits
| Exit | Meaning | Source |
|---|---|---|
| 0 | completed, incl. soft-denied tools and `--print-timeout` expiry with partial output (1.1.28) - check `status`, `structured_output`, `denied_actions`, stderr | headless docs; CHANGELOG |
| 1 | unknown model, malformed stream input, **authentication required**, dropped agent stream (1.1.18) | headless docs |
| 2 | unsupported stream message (control events, CLI slash commands) | headless docs |
| **3** | since 1.2.6: turn ended on a model/agent API failure; stderr gets one line `AGY_ERROR: {...}` "with canonical status, HTTP or gRPC error code, retryability, and error ID"; 1.2.10 extended it to partially streamed failures and puts the partial response in the JSON | CHANGELOG 1.2.6, 1.2.10 |
`AGY_ERROR` field names **UNVERIFIED** (not in docs). Wrapper: parse a stderr line `/^AGY_ERROR:\s*(\{.*\})$/` as JSON; classify by a `retryable`-like boolean when present, else by substrings (`RESOURCE_EXHAUSTED`, `429`, `quota`, `rate`) -> "Gemini quota exhausted; resets within 5 h (Pro/Ultra) or weekly"; `UNAUTHENTICATED` / `authentication required` -> re-login prompt; also 1.1.28's stable `error:` stderr marker. Retry at most once.
Rate limits: none published (token-based, 5-hourly for Pro/Ultra, weekly otherwise). `agy -p "/usage" --output-format json` is the headless readout (4). Run **at most one `agy` process at a time**.

### 5.7 Model pinning
- Unknown model -> hard fail with list (1.1.2; issue #581 still open for slug *forms* on 1.1.1). Issue **#687** (`gemini-3.1-pro-high` silently resolved to Gemini 3.6 Flash (High) in `-p`) was **closed 2026-09-16** (fix version not stated). The JSON envelope has **no model field**; `stream-json init.model` is present only "when overridden". Populate the settings dropdown from `agy models` at settings time; default to a Flash slug; show "as reported by the CLI".

### 5.8 Data / privacy
Terms §5 (interactions used to improve products; opt-out in settings - CLI key **UNVERIFIED**; `enableTelemetry` exists). `agy` persists every conversation locally under `~/.gemini/antigravity-cli/brain/<id>/...transcript.jsonl` and `conversations/` -> **our role-labelled WhatsApp prompts will be written to disk by agy**. Consent record `cloud_gemini_cli` must say: text leaves the PC under Antigravity consumer terms, may be used to improve Google products unless opted out, is stored locally by agy, and the §6 risk (with Terms date). Consider deleting the run's conversation dir afterwards (**UNVERIFIED** whether agy tolerates it).

### 5.9 Headless bug ledger (GitHub API state, 2026-09-28)
| Issue | Opened | State | Relevance |
|---|---|---|---|
| #76 `-p` drops stdout when not a TTY (Windows 11) | 2026-05-21 | **closed 2026-07-12** (fixed 1.0.15; 1.1.1 also fixed silent server-side errors and the stdin hang) | Node `child_process` capture works; keep `stdin: 'ignore'` |
| #408 `--print` writes nothing when piped (Windows, 1.0.9) | 2026-06-17 | **closed 2026-09-04**; reporters confirm fixed on Windows 11 with 1.1.8 and 1.1.13 (incl. .NET `Process` with no console); community bridge README: `agy -p "..." \| cat` "printed normally on agy 1.2.11 (Windows, checked Sep 2026)" | resolved |
| #318 `-p` hangs in non-TTY (Windows, 1.0.6) | 2026-06-06 | **closed as obsolete 2026-09-03**; two later comments reproduce a 0-byte hang on **Linux** 1.2.0/1.2.3 under `setsid`/`tee` | Windows OK; always hard-kill |
| #548 headless ignores `permissions.allow`, stalls on tool prompts (Windows 11) | 2026-07-06 | **open** | tool-less design |
| #581 `--model` slug forms silently default (1.1.1) | 2026-07-11 | open | use `agy models` names |
| #687 silent Pro->Flash downgrade in `-p` (1.1.7) | 2026-07-26 | **closed 2026-09-16** | verify once on the installed build |
| #794 `--json-schema` + auto-denied tool -> SUCCESS w/o `structured_output` | 2026-08-14 | open | treat missing `structured_output` as failure |
| #947 print mode never exits after answer for ~55 KB+ prompts with structured output (Linux 1.1.26) | 2026-09-05 | open | hard-kill after stdout JSON is complete; keep prompts small |
| #1044 turn ends SUCCESS while a `run_command` still runs | 2026-09-18 | open | irrelevant tool-less |
Also 1.1.24: "Fixed headless CLI invocations with piped standard output or standard error hanging on exit" (FD_CLOEXEC); 1.2.9: daemon background processes now terminate at run end.

---

## 6. Gemini CLI (open source) - fallback contract (API key / Vertex / Code Assist Standard)

Apache-2.0, maintained for enterprise, npm `@google/gemini-cli` **0.61.0** stable. Useful only with a Gemini API key (free 250 req/day Flash-only, or paid), Vertex, or a Code Assist Standard/Enterprise seat. With an API key the v1 in-process `@google/genai` provider is strictly better (no child process, native function calling + `responseSchema`, `store:false`). For completeness:
- Headless: `gemini -p "<prompt>" --output-format json` -> `{ "response", "stats", "error"? }`; `stream-json` events `init|message|tool_use|tool_result|error|result`; exit 0 / 1 / 42 (input error) / 53 (turn limit). https://geminicli.com/docs/cli/headless/
- Flags: `-m/--model` (default `auto`), `-o/--output-format`, `--approval-mode default|auto_edit|yolo|plan` (`--yolo` deprecated), `--allowed-mcp-server-names a,b`, `--allowed-tools` (deprecated -> Policy Engine), `--include-directories`, `--sandbox`, `-e/--extensions`, `--resume`. https://geminicli.com/docs/cli/cli-reference/
- **No custom-schema flag**: issue #13388 "Support Custom Structured Output Schemas" closed **not planned 2026-05-06** ("engineering team is focusing all resources on critical system maintenance"); #12692/#5021 closed as duplicates. Schema must be prompt-enforced and validated by S4.
- System prompt: `GEMINI_SYSTEM_MD=<path>` (full replacement; supports `${AvailableTools}` etc.). https://geminicli.com/docs/cli/system-prompt/
- Read-only via Policy Engine (`~/.gemini/policies/*.toml`; Windows admin tier `C:\ProgramData\gemini-cli\policies`): `[[rule]] toolName="*" decision="deny" priority=10` + `[[rule]] mcpName="wa-agent" decision="allow" priority=100`; headless: "ask_user" is "treated as `deny`". https://geminicli.com/docs/reference/policy-engine/
- MCP: `settings.json` (Windows user file `C:\Users\<u>\AppData\Local\.gemini\settings.json` per the reference; project `.gemini/settings.json`) `mcpServers.<name>` `{command,args,env,cwd | url | httpUrl, headers, timeout, trust, includeTools, excludeTools}`; `mcp.allowed/excluded`; `tools.core/allowed/exclude`. Auth env: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_GENAI_USE_VERTEXAI`. https://geminicli.com/docs/reference/configuration/
- `@path` injects files, "intended for text-based files ... binary files or very large files might be skipped or truncated" -> images via `@` **UNVERIFIED**/unreliable.

---

## 7. Honest options

| Option | Subscription used? | Sanctioned for a 3rd-party app? | Structured output | Tools | Vision | Effort |
|---|---|---|---|---|---|---|
| A. `agy -p` headless (Antigravity CLI) | **Yes** (Antigravity quota of Pro/Ultra/free) | Gray (§6 vs forum answers; 3) | `--json-schema` native | possible, but #548/#794 + policy -> avoid | TUI yes; `-p` **UNVERIFIED** | medium |
| B. Gemini API key via v1 provider | No (250/day free Flash or pay-as-you-go) | **Yes** (Google's own recommendation) | native | native function calling | native | done |
| C. Gemini CLI + API key | No | Yes | prompt-only | Policy Engine | weak | pointless vs B |
| D. Code Assist Standard seat + Gemini CLI | business licence, not the consumer plan | Yes | prompt-only | Policy Engine | weak | needs a Google Cloud purchase |
| E. Antigravity SDK | No (API key / Vertex) | Yes | native | native | native | Python runtime + key -> no gain over B |
| F. IDE / `agentapi` / localhost ports | Yes | **No** | - | - | - | forbidden |

**Recommendation: A as opt-in with disclosure, B stays the documented Gemini path, never F.** Same app-side pipeline on A or B (D-038).

---

## 8. Exact command lines and wrapper shapes

### 8.1 App-owned files (created at setup in the trusted workspace `W = %APPDATA%\WhatsAppCalendarAgent\agy-workspace`)
```
W\.agents\agents\wa-extract.md      # S1/S2 extraction agent (no tools)
W\.agents\agents\wa-draft.md        # S3 drafting agent (no tools in v2)
W\schemas\extract.schema.json       # draft-07 JSON schema (same as S4 zod)
W\schemas\draft.schema.json
W\attachments\<runId>\image.jpg     # only for a picture read; deleted in finally
```
`wa-extract.md`:
```md
---
name: wa-extract
description: Extract scheduling intent from a role-labelled chat window. Returns JSON only.
tools: []
commandExecutionPolicy: off
excludeDefaultComponents: true
model: inherit
mainAgent: true
subagent: false
---
(the v1 S1 system prompt verbatim; the chat window arrives inside the nonce-delimited data block as untrusted data)
```

### 8.2 `extract(schema)`
```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH
$env:AGY_CLI_DISABLE_AUTO_UPDATE = "true"
& "$env:LOCALAPPDATA\agy\bin\agy.exe" `
  --agent wa-extract --model gemini-3.8-flash-medium `
  --output-format json --json-schema "$W\schemas\extract.schema.json" `
  --print-timeout 2m --disable-slash-commands `
  -p "<prompt text with the chat window inlined, role labels only>"
```
Prompts near the Windows command-line limit (~32 k chars) go through `--input-format stream-json --output-format stream-json` on stdin instead (one `user` event, then close stdin).

### 8.3 `draft(tools)` - v2 tool-less variant (recommended)
The app runs ToolGate tools itself (`list-events`, free/busy, existing event by chain id) and inlines the results:
```powershell
agy.exe --agent wa-draft --model gemini-3.8-flash-high --output-format json `
        --json-schema "$W\schemas\draft.schema.json" --print-timeout 3m --disable-slash-commands -p "<prompt>"
```
Schema returns `{ reply_draft, proposal: { kind: "create"|"delta"|"none", ... } }` exactly as S3 emits today; S4 validates; ToolGate + ActionExecutor unchanged.

### 8.4 `draft(tools via MCP)` - deferred variant (only after #548/#794 are verified fixed on the installed build and the policy position is clearer)
`W\.agents\mcp_config.json`:
```json
{ "mcpServers": { "wa-agent": {
    "command": "C:\\...\\WhatsAppCalendarAgent.exe",
    "args": ["--mcp-readonly", "--token-file", "<per-run token path>"],
    "cwd": "C:\\...\\agy-workspace", "disabledTools": [] } } }
```
`settings.json` (merged with consent): `"permissions": { "allow": ["mcp(wa-agent/*)"], "deny": ["command(*)", "write_file(*)", "read_url(*)", "unsandboxed(*)"] }`; agent `tools:` = the read-only names only; `--output-format stream-json` to watch `tool_info`; still no `--dangerously-skip-permissions`; kill at `--print-timeout` + 30 s. Note the 25 Sep forum wording targets exactly "MCP + third-party agent" set-ups - the deferral is deliberate.

### 8.5 Node wrapper shape (main process, TypeScript)
```ts
export interface AgyRunOptions { agent: 'wa-extract'|'wa-draft'; model: string; prompt: string; schemaPath: string; timeoutMs: number; attachments?: string[] }
export type AgyResult =
  | { ok: true; structured: unknown; usage: AgyUsage; conversationId: string }
  | { ok: false; kind: 'not_installed'|'version'|'auth'|'quota'|'timeout'|'model'|'denied'|'invalid'|'other'; message: string; retryable: boolean };

export async function runAgy(o: AgyRunOptions, d: { exe: string; workspace: string; spawn: typeof spawn }): Promise<AgyResult> {
  const args = ['--agent', o.agent, '--model', o.model, '--output-format', 'json', '--json-schema', o.schemaPath,
                '--print-timeout', `${Math.ceil(o.timeoutMs / 60000)}m`, '--disable-slash-commands',
                '-p', o.prompt + (o.attachments?.map(a => ` @${a}`).join('') ?? '')];
  const child = d.spawn(d.exe, args, { cwd: d.workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...minimalEnv(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } }); // PATH, USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot only
  // read stdout/stderr continuously (cap 8 MB); hard kill at timeoutMs + 30_000 with `taskkill /T /F` (kills the MCP/daemon tree);
  // stderr: /^AGY_ERROR:\s*(\{.*\})$/ -> classify (retryable/quota/auth)  [field names UNVERIFIED]; /authentication required/i -> 'auth';
  // exit 0 && status==='SUCCESS' && structured_output && !(denied_actions?.length) -> ok (validate with the S4 zod schema);
  // status==='WAITING' || denied_actions.length -> 'denied' (our agent file is wrong: it tried to use a tool);
  // missing structured_output with exit 0 -> 'invalid' (bug #794), retry once; exit 3 -> AGY_ERROR classification.
}
```
Invariants: `stdin: 'ignore'`; `cwd` = trusted workspace; one process at a time (mutex); redact prompt text before logging; delete `attachments/<runId>` in `finally`; never write outside `W` and the two consented settings keys (`trustedWorkspaces`, nothing else).

---

## 9. Local machine findings (2026-09-27/28, names and dates only)
- `%LOCALAPPDATA%\agy\` **absent**, `agy` not on PATH -> **not installed**. `~/.gemini/antigravity-cli/` exists (settings.json 196 B dated 2026-09-01; `updater/update_status.json` 2026-09-02 "Update successful, restart CLI to use"; `bin/` holds only `agentapi.bat` and `webm_encoder.exe`; state dirs `brain/`, `conversations/`, `mcp/`, `log/`, `history.jsonl`, `cli.log` **not opened**). The CLI was installed ~2026-09-01 and later removed. Version last used **UNVERIFIED**.
- `~/.gemini/config/` (shared with the IDE): `config.json`, `hooks.json`, `mcp_config.json`, `projects/`. First pass noted `mcp_config.json` defines a `whatsapp` server that runs the reference Python `whatsapp-mcp-server` over the **off-limits** reference store, and `hooks.json` registers a `munder-hive` hook on all five events -> `tools: []` is mandatory for privacy, and the consent text must mention user-level hooks.
- Gemini CLI: not installed (no `%APPDATA%\npm`).

---

## 10. Build-time checks that need the real binary (with the user's consent, on his account)
1. `agy --version` >= 1.2.11; `--agent <workspace agent> -p ... --json-schema` returns `structured_output`, `init.tools` (stream-json) is empty, no stall (#548/#794) - **blocker**.
2. `@image.jpg` in `-p` delivers the picture to the model (TUI lists PNG/JPEG/GIF/WebP/BMP/TIFF/SVG via paste; `-p` path **UNVERIFIED**; a forum thread reported PNG reads breaking after an Aug-2026 update) - **blocker for D-039 "pictures via cloud" on Gemini**.
3. `AGY_ERROR` JSON field names; `denied_actions` element shape; `agy -p "/usage" --output-format json` field names; Windows Credential Manager entry name.
4. `agy models` output format (no documented JSON mode) -> parse lines defensively.
5. Whether the trust gate still blocks headless runs on an untrusted cwd on 1.2.x, and whether editing `trustedWorkspaces` while agy is closed persists.
6. Whether deleting the run's `brain/<conversation_id>` afterwards is tolerated.
7. Re-read https://antigravity.google/terms and the forum category before release; put the §6 text + date into consent `cloud_gemini_cli` v1.

## 11. Corrections versus the first pass (2026-09-27)
- Non-TTY stdout bugs #76/#318/#408 are **closed and fixed** (1.0.15 -> 1.1.1 -> 1.1.8; confirmed on Windows 11 with 1.1.13 and 1.2.11) - the first pass listed #318 as closed but did not state that piped capture on Windows is verified working.
- #687 (silent model downgrade) is **closed 2026-09-16**; #581 remains open.
- Default headless timeout is **unlimited since 1.2.6** (docs page still says 5m) -> `--print-timeout` mandatory.
- Version gate raised to **>= 1.2.11** (workspace agents in headless `--agent` runs).
- Added `--disable-slash-commands`, `--mode`, `denied_actions`, `excludeDefaultComponents`, and the documented headless `/usage` readout.
- Gemini CLI custom schema: **closed not planned 2026-05-06**.
- Antigravity SDK exists (I/O 2026) but is API-key/Vertex only - no subscription path.
- Staff badges of the forum responders could not be confirmed -> marked UNVERIFIED; added the 2026-02-27 ban precedent and the FAQ wording.

---

## Sources
- Transition + deprecation: https://github.com/google-gemini/gemini-cli/discussions/27274 ; https://github.com/google-gemini/gemini-cli/discussions/28017 ; https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals ; https://github.com/google-gemini/gemini-cli/discussions/20632 (bans, 2026-02-27) ; https://cloud.google.com/blog/topics/developers-practitioners/choosing-antigravity-or-gemini-cli
- Plans / I/O: https://antigravity.google/docs/plans ; https://antigravity.google/blog/changes-to-antigravity-plans ; https://blog.google/innovation-and-ai/technology/developers-tools/google-io-2026-developer-highlights/ ; https://antigravity.google/docs/models ; https://antigravity.google/docs/faq/ ; https://antigravity.google/terms
- Antigravity CLI docs: https://antigravity.google/docs/cli/overview ; https://antigravity.google/docs/cli/install/ ; https://antigravity.google/docs/cli/headless/ ; https://antigravity.google/docs/cli/reference/ ; https://antigravity.google/docs/cli/troubleshooting ; https://antigravity.google/docs/cli/gcli-migration ; https://antigravity.google/docs/cli/prompting/ ; https://antigravity.google/docs/settings?tab=cli ; https://antigravity.google/docs/permissions?tab=cli ; https://antigravity.google/docs/mcp?tab=cli ; https://antigravity.google/docs/subagents/ ; https://antigravity.google/docs/hooks ; https://antigravity.google/docs/sdk/overview/ ; https://antigravity.google/blog/introducing-google-antigravity-sdk
- antigravity-cli repo: https://github.com/google-antigravity/antigravity-cli/releases ; https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md ; issues #76, #318, #408, #548, #581, #687, #794, #947, #1044 (state via GitHub API 2026-09-28)
- Forum (Google Antigravity category): https://discuss.ai.google.dev/t/.../175462 ; /178823 ; /181088 ; /183051 ; /184829
- Gemini CLI docs: https://geminicli.com/docs/cli/headless/ ; https://geminicli.com/docs/cli/cli-reference/ ; https://geminicli.com/docs/reference/configuration/ ; https://geminicli.com/docs/reference/policy-engine/ ; https://geminicli.com/docs/cli/system-prompt/ ; https://geminicli.com/docs/reference/commands/ ; https://geminicli.com/docs/get-started/authentication/ ; https://geminicli.com/docs/resources/quota-and-pricing/ ; https://docs.cloud.google.com/gemini/docs/quotas ; gemini-cli issues #13388, #12692, #5021, #8022
- Community (symptoms only, never instructions): https://github.com/rhishi99/agy-headless-bridge (README: fixed upstream on 1.2.11 Windows)
