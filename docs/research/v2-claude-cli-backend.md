# v2 research: Claude Code CLI as a subscription-backed headless completion backend

Research label: `claude-cli-backend` · Date: 2026-09-27 · Status: complete, with UNVERIFIED items marked inline.

Scope: how the WhatsApp Calendar Agent (Electron + TypeScript, Windows 11) can use the user's **Claude Pro/Max subscription login** (no API key) as a completion backend for the verified pipeline (S1 extract → S2 resolve → S3 draft → S4 validate), per locked decision D-038. Everything below was checked against the official docs at `code.claude.com/docs` on 2026-09-27, the npm registry, and the CLI binary actually installed on this machine (`2.1.258`). Nothing was run against the user's account; the CLI was only invoked with `--version` and `--help`.

---

## 0. Executive summary (what the plan should assume)

| Question | Answer | Confidence |
|---|---|---|
| Can a desktop app use the user's Pro/Max login headlessly? | Yes: spawn the **user-installed, unmodified** `claude.exe` with `-p`; it authenticates with the subscription OAuth stored by `claude auth login` (precedence rank 7). The app never touches the credential. | High (docs) |
| Can the Claude **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) run on subscription auth? | Technically yes: it spawns the same CLI binary, which reads the same OAuth login when `ANTHROPIC_API_KEY` is absent. Officially, Anthropic says SDK products should use API keys and does not allow third parties to "offer claude.ai login". | High (mechanism), policy risk (see §11) |
| Structured JSON output? | `--output-format json --json-schema '<draft-07 schema>'` → `structured_output` field. | High |
| Read-only / no shell / no file edits? | `--restricted --tools "" --disallowedTools "..." --permission-mode dontAsk --strict-mcp-config --disable-slash-commands`. `--bare` is **not** usable: bare mode never reads OAuth. | High |
| Attach the app's MCP server? | `--mcp-config <file>` + `--strict-mcp-config` + `--allowedTools "mcp__<name>__*"`. Prefer loopback HTTP with a per-run bearer token written to a temp file, so ToolGate stays in the Electron main process. | High |
| Images (pictures feature)? | `--input-format stream-json` with a user message containing an `image` content block (base64). Fallback: allow `Read` on a temp dir; Read renders images. | Medium (documented for SDK; SDK uses this same stdin protocol; CLI path UNVERIFIED end-to-end) |
| Detect installed / logged in? | `claude --version` (exit 0, prints `2.1.258 (Claude Code)`); `claude auth status --json` → JSON with boolean `loggedIn`. | High / Medium (other fields UNVERIFIED) |
| Rate limits? | Shared 5-hour + weekly windows across claude.ai and Claude Code. Headless: `rate_limit_event` lines in stream-json (status, resetsAt, rateLimitType, isUsingOverage) and a final result with `is_error: true` and text like `You've hit your session limit`. No headless utilisation percentage. | High |
| Cost visibility? | `total_cost_usd` in the result is a client-side list-price **estimate**; on subscription it is not billed. Only `isUsingOverage: true` means real money (usage credits). | High |
| Bundle the CLI? | No. Ship nothing; require user install (`irm https://claude.ai/install.ps1 \| iex`). Bundling requires Commercial ToS and unmodified-binary rules; the Agent SDK's optional-dependency binaries would count as bundling. | High (legal page) |
| Minimum version to require | `>= 2.1.221` (MCP startup wait + `--strict-mcp-config` semantics). Several nicer flags need `>= 2.1.259` (`--permission-prompts none`). This machine has `2.1.258`. | High |

Recommendation: **spawn `claude.exe` directly with `child_process.spawn` (no SDK, no bundled binary)**, always with `--input-format stream-json --output-format stream-json --verbose --no-session-persistence`, a dedicated empty working directory owned by the app, the read-only flag set above, and a wrapper that maps failures to `NOT_INSTALLED | NOT_LOGGED_IN | USAGE_LIMIT | RATE_LIMITED | OVERLOADED | MODEL_UNAVAILABLE | TIMEOUT | ABORTED | BAD_OUTPUT | UNKNOWN`. Keep the API-key provider (direct `@anthropic-ai/sdk`) as the advanced fallback per D-038.

---

## 1. What is installed on this machine (observed, not from memory)

```
C:\Users\ilay1\.local\bin\claude.exe       -> "2.1.258 (Claude Code)"  (native installer layout)
C:\Users\ilay1\.local\share\claude\versions\{2.1.251, 2.1.252, 2.1.258}
C:\Users\ilay1\.claude\                     (config dir; contains settings.json, plugins, projects, ...)
```

- `claude` is **not** on the PATH of the Git Bash shell this session used (`which claude` failed), so the app must resolve the executable explicitly (see §9).
- `claude auth` subcommands present in `--help`: `login [--claudeai|--console|--sso|--email]`, `logout`, `status [--json (default) | --text]`.
- `--restricted`, `--tools`, `--strict-mcp-config`, `--json-schema`, `--input-format stream-json`, `--no-session-persistence`, `--session-id`, `--fallback-model`, `--effort`, `--setting-sources`, `--disable-slash-commands` all appear in the local `--help` of 2.1.258.
- npm registry (2026-09-25): `@anthropic-ai/claude-code` latest **2.1.283**, license field `SEE LICENSE IN README.md` (proprietary), `bin: {"claude": "bin/claude.exe"}`, native binary via optional deps (`@anthropic-ai/claude-code-win32-x64`, ...). `@anthropic-ai/claude-agent-sdk` latest **0.3.283** (tracks the CLI patch number), peer deps `zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `engines.node >=18`.

---

## 2. Non-interactive mode (`claude -p`)

Source: https://code.claude.com/docs/en/headless and https://code.claude.com/docs/en/cli-reference

- `-p` / `--print`: run one prompt and exit. Reads stdin (capped at **10 MB**; over the cap → non-zero exit with an error). The workspace-trust dialog is skipped; settings files that fail validation are silently ignored.
- Exit codes: `0` on success, non-zero "when the run fails". **Caveat (open bug #79500, seen on 2.1.49):** an API-level failure (e.g. rate limit) can come back as `{"type":"result","subtype":"success","is_error":true,"result":"API Error: Rate limit reached", ...}` with exit code `0`. Always check `is_error` first, never `subtype` or the exit code alone.
- Missing authentication inside the run is printed **as the result on stdout**, not stderr (docs).
- SIGTERM → exit code `143`, turn left unfinished; on Windows `child.kill()` is a hard terminate, so kill the whole tree (`taskkill /T /F /PID`) because the CLI spawns MCP children.
- Piped stdin on Windows was fixed in 2.1.211 (earlier versions crashed on unreadable stdin).
- `--bg` and `--cloud <description>` are rejected with `-p`.

### 2.1 Output formats

| `--output-format` | What you get |
|---|---|
| `text` (default) | plain text |
| `json` | one JSON object: `type:"result"`, `subtype`, `is_error`, `result` (text), `structured_output` (with `--json-schema`), `session_id`, `stop_reason`, `duration_ms`, `duration_api_ms`, `num_turns`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, `uuid` |
| `stream-json` | newline-delimited JSON events. First line `{"type":"system","subtype":"init",...}` (model, tools, `mcp_servers[{name,status}]`, `mcp_server_errors`, `plugins`, `capabilities`), then `assistant` / `user` messages, `system/api_retry`, `rate_limit_event`, and a final `result` line (same fields as `json`). Add `--verbose`; add `--include-partial-messages` for token deltas. |

Result `subtype` values (Agent SDK docs, same envelope): `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`. `result` text is only present on `success`. All variants carry `total_cost_usd`, `usage`, `num_turns`, `session_id`. `stop_reason` may be `end_turn`, `max_tokens`, `refusal` (check it: a `refusal` on a success-looking result is not a usable answer), or `null` after a crash.

`system/api_retry` event fields: `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (HTTP or null), `error` ∈ `authentication_failed | oauth_org_not_allowed | account_on_hold | billing_error | rate_limit | overloaded | invalid_request | model_not_found | server_error | max_output_tokens | cloud_credential_error | unknown`. Useful for UI progress and for early classification.

### 2.2 Structured output

- `--json-schema '<JSON Schema>'` **requires** `--output-format json` (or `stream-json`; the SDK gets `structured_output` from the stream-json result). Without the JSON format you get plain text and no `structured_output`.
- Schema is validated at startup (since 2.1.205): invalid schema → `Error: --json-schema is not a valid JSON Schema` + exit. Validator is **draft-07**; `format` is accepted but not enforced. Supported: basic types, `enum`, `const`, `required`, nested objects, `$ref`. (Zod: `z.toJSONSchema(schema, { target: "draft-7" })`.)
- The CLI re-prompts on validation mismatch; on exhaustion the result subtype is `error_max_structured_output_retries`. A `success` result **without** `structured_output` is also possible; treat as failure.
- Known bug #87234 (2.1.233, closed "not planned"): on **tool-less** `--json-schema` calls, ~27% of first attempts emit literal `$PARAMETER_NAME` keys; the CLI retries internally and self-corrects (costs one extra model round-trip). With at least one tool available (e.g. `Read`) the rate was 0%. Mitigation options: accept the retry, or keep `Read` enabled but confined (`--restricted` confines file tools to the working dirs). The app must still validate `structured_output` itself (S4 already does).

### 2.3 System prompt and model flags

- `--system-prompt "<text>"` replaces the default Claude Code prompt entirely (recommended for a pure completion backend: smaller, deterministic, cache-friendly; you lose Claude Code's tool/safety guidance, which is fine with no tools). `--system-prompt-file <path>` same from a file. `--append-system-prompt` / `--append-system-prompt-file` keep the default and append.
- Cache tip (2.1.275+): a line containing only `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` in `--system-prompt` splits static vs. per-request parts into two cache blocks. `--exclude-dynamic-system-prompt-sections` only applies to the default prompt.
- `--model <alias|id>`: aliases `default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`; full ids e.g. `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5`, `claude-fable-5-1`. Runtime default for Pro/Max is **Opus 5.5** (expensive for the 5-hour window; pick `sonnet` for S1/S3 and `haiku` for cheap classification). The error reference contains `Claude Opus is not available with the Claude Pro plan` → treat as `MODEL_UNAVAILABLE` and fall back. `[1m]` variants need usage credits on Pro → avoid.
- `--fallback-model sonnet,haiku` (print mode only): automatic fallback when the primary is overloaded/unavailable; retried at each user turn.
- `--effort low|medium|high|xhigh|max` (levels depend on model). Use `low` for extraction/classification.
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` env vars also exist; the flag wins.

### 2.4 Session isolation (fresh context per call)

- Each `claude -p` process is one conversation; nothing carries over unless you pass `--continue` / `--resume`. Sessions are keyed by working directory: run every call in a dedicated, empty, app-owned directory (e.g. `%APPDATA%\<app>\claude-cwd\`) so no project `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, or hooks are picked up.
- `--no-session-persistence` (print mode only): the transcript is **not written to `~/.claude/projects/...`**. This matters for privacy (WhatsApp message text would otherwise be persisted on disk by the CLI). Env equivalent: `CLAUDE_CODE_SKIP_PROMPT_HISTORY`.
- `--session-id <uuid>` (2.1.200+, print mode) lets the app tag runs; optional.
- `--restricted` (present in 2.1.258 help; docs page for it not found → minimum version UNVERIFIED): "ignores user, project and local settings files (managed settings and --settings still apply)", removes command-running tools and WebFetch, confines file tools to the working directories, refuses `bypassPermissions`. This is the closest thing to a clean-room run that still reads OAuth.
- `--setting-sources ""` (2.1.200+) is documented as disabling settings loading from files/env; `--restricted` already covers the files. UNVERIFIED whether the empty value is accepted on 2.1.258 (local help shows a comma list of `user, project, local`).
- `--disable-slash-commands` disables skills; `--strict-mcp-config` ignores user-level MCP servers (the user has many). `--bare` would be ideal but **does not read OAuth/keychain** ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper") → unusable for the subscription path.

### 2.5 Making the run read-only (no file edits, no shell)

Layered, belt-and-braces (all documented unless noted):

1. `--tools ""` — "Pass an empty value to disable all built-in tools" (cli-reference). Local help: `Use "" to disable all tools, "default" to use all tools`.
2. `--disallowedTools "Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate"` — bare names remove tools from context (belt for the braces; harmless if already absent). Do **not** use `"*"` alone if you need MCP tools (it removes them too).
3. `--restricted` — removes code-running tools and WebFetch, confines file tools, ignores settings files (so no user hooks run).
4. `--permission-mode dontAsk` — anything that would prompt is denied instead (in `-p` with no host it is denied anyway, but `dontAsk` also tells Claude not to retry). `--permission-prompts none` is the newer equivalent but needs **2.1.259+** (this machine: 2.1.258) → gate on version.
5. `--strict-mcp-config` + only the app's server in `--mcp-config`; `--allowedTools "mcp__<server>__*"` (MCP tools always need an allow rule; `acceptEdits` does not cover them; wildcard allowed only after a literal `mcp__<server>__` prefix).
6. `--max-turns N` (e.g. 1 for extract, 6 for draft-with-tools) and app-side timeout (there is no `--timeout` flag).
7. Never `--dangerously-skip-permissions` / `bypassPermissions`.

Per the permissions docs, `EndConversation` cannot be removed while any other tool remains; `ToolSearch` stays if MCP tools are deferred (fine, read-only). The `system/init` event's `tools` array tells you exactly what remained; assert on it in tests and log it.

### 2.6 MCP servers headlessly

- `--mcp-config <file-or-json>` (space-separated, repeatable). Format:
  ```json
  { "mcpServers": {
      "wa": { "type": "http", "url": "http://127.0.0.1:<port>/mcp",
              "headers": { "Authorization": "Bearer <per-run-token>" } } } }
  ```
  stdio form: `{ "type": "stdio", "command": "node", "args": ["..."], "env": {...} }`. `"streamable-http"` is an accepted alias for `"http"` in JSON configs. A `url` entry without `type` is skipped at validation and reported in `system/init.mcp_server_errors` (2.1.219+).
- `--strict-mcp-config`: local help (2.1.258): "Only use MCP servers from --mcp-config, ignoring all other MCP configurations". Newer docs (2.1.221+) add: "fail startup if any server doesn't connect". Both behaviours are desirable here.
- With `-p` and `--mcp-config`, the CLI waits for pending servers before the first turn, up to `MCP_TIMEOUT` (30 s default) (2.1.221+). `MCP_TOOL_TIMEOUT` bounds a single tool call. `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` (2.1.274+) overrides the first-turn wait.
- Tool names: `mcp__<server>__<tool>`. `system/init.mcp_servers[].status` ∈ `pending | connected | failed | needs-auth | disabled`. Fail fast on `failed`/`needs-auth`; `pending` can mean "cached tool list".
- MCP output > 25,000 tokens is spilled to a file (`MAX_MCP_OUTPUT_TOKENS` raises the cap) — keep the app's list/search tools paginated.
- Why loopback HTTP rather than stdio for the app's server: a stdio server is spawned **by the CLI**, so ToolGate would have to live in that child. With HTTP on `127.0.0.1` the Electron main process hosts the server, ToolGate and the approval store stay in-process (invariants I1–I7 unchanged), and the same server serves Gemini's CLI. Put the config in a temp file with restrictive ACLs and pass the **path** to `--mcp-config` so the bearer token is not visible in the process command line. Rotate the token per run; bind to loopback only.

### 2.7 Image input in headless mode

Documented mechanism (Agent SDK streaming-input page; the SDK talks to the CLI over exactly this `--input-format stream-json` stdin protocol): write one JSON line to stdin and close stdin:

```json
{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[
  {"type":"text","text":"<instruction + data>"},
  {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"<base64>"}}]}}
```

Command: `claude -p --input-format stream-json --output-format stream-json --verbose ...` (no positional prompt). The docs state that single-message (`-p "text"`) mode "does not support direct image attachments"; streaming input mode does. UNVERIFIED end-to-end on the CLI (documented for the SDK, which is the same transport) → the build ticket must include a fake-free smoke test the user runs once with their login. Constraints: stdin cap 10 MB; API image limits apply (resize/compress to ≤ ~1.5 MB JPEG before encoding; strip base64 newlines). `--json-schema` works in this mode too (the SDK obtains `structured_output` from the stream-json result).

Fallback if the stdin image path misbehaves: save the picture to the app-owned working directory and run with `--tools "Read" --allowedTools "Read" --restricted` (file tools confined to the working directory); the `Read` tool renders images as visual input. This re-enables one read-only tool, which also sidesteps bug #87234.

---

## 3. Authentication and detection

Source: https://code.claude.com/docs/en/authentication

- Login: `claude auth login` (default `--claudeai` = Claude subscription; `--console` = API billing). Opens the browser; Anthropic's own flow completes there. The **app must not run or proxy this flow**; it may launch a terminal that runs `claude auth login --claudeai` and then poll `claude auth status --json`.
- Credential storage on Windows: `%USERPROFILE%\.claude\.credentials.json` (or under `CLAUDE_CONFIG_DIR`), protected by the profile directory ACLs. **Never read, copy, or parse this file** (hard rule; also forbidden by Anthropic's terms: developers "may not collect, store, or intermediate Claude.ai credentials or session tokens").
- Precedence (first wins): cloud-provider env → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` (in `-p` "the key is always used when present") → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profile/WIF → **subscription OAuth from `/login`**. Therefore the subscription provider must **strip** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}` from the child environment (and must not pass `--settings` with an `apiKeyHelper`).
- `claude setup-token` mints a 1-year OAuth token for `CLAUDE_CODE_OAUTH_TOKEN` (requires Pro/Max/Team/Enterprise; model requests only). Not needed for a desktop app that runs as the logged-in user, and storing it would make the app an intermediary of a session token → do not use.
- Expiry: login lifetime is finite; `Login expired · Please run /login` on each request after expiry; `/status` shows `Expired — log in again` (2.1.210+). Headless detection: the result text.
- Detection commands:
  - Installed: spawn `<path>\claude.exe --version` → stdout `2.1.258 (Claude Code)`, exit 0. `ENOENT` → `NOT_INSTALLED`.
  - Logged in: `claude auth status --json` → JSON object with boolean `loggedIn` (community-verified; other fields such as email/org/plan are present but names UNVERIFIED — do not persist them). Parse `loggedIn` from stdout regardless of exit code; treat unparsable output as "unknown", not "logged out" (ordinary CLI errors also exit 1). UNVERIFIED whether `auth status` makes a network request; assume local and cheap, but do not call it more than once per minute.
  - `claude doctor` prints read-only diagnostics (install health, auto-update status) — useful for a "Diagnostics" button, not for gating.

---

## 4. Usage limits, 429 behaviour, cost visibility

Sources: costs page, errors page, support article "Using Claude Code with your Pro or Max plan" (updated 2026-08-19), issue #78476.

- Pro and Max share **one** usage pool across claude.ai web/desktop/mobile and Claude Code (and the Agent SDK): a rolling **5-hour session window** plus a **weekly** window; some plans also have per-model-family (Opus/Sonnet) weekly limits. Prompt-cache TTL is 1 h on subscription (5 min when drawing on usage credits). "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK" (legal page) — a background loop that calls the CLI for every incoming WhatsApp message is at risk of being non-ordinary; keep the local llama triage in front and call the cloud only for S1/S3 on demand or in batches.
- Headless signals:
  - `rate_limit_event` lines in `stream-json` (observed 2.1.209): `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784283600,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1785542400,"isUsingOverage":false}}`. `status` values other than `allowed` UNVERIFIED (likely `allowed_warning` / `rejected`). Utilisation percentages are **not** exposed headlessly (feature request closed "not planned"). Surface `resetsAt` and `isUsingOverage` in the UI; `isUsingOverage: true` means the user is paying for usage credits at API rates.
  - Hard stop: result with `is_error: true` and text `You've hit your session limit` / `You've hit your weekly limit` / `You've hit your Opus limit` / `You've hit your Sonnet limit` (model-family limits: switching model family keeps working). The interactive message includes the reset time (`continuing automatically at 3:45pm`); the interactive auto-wait does **not** apply to `-p`. Also possible: `You've hit your monthly spend limit`, `Credit balance is too low`.
  - Server 429 (organisation TPM/RPM, distinct from plan limits): `Request rejected (429)` / `Server is temporarily limiting requests`; the CLI retries with `system/api_retry` (`error: "rate_limit"`) before giving up.
  - 529 / overload: `API Error: Repeated 529 Overloaded errors`, `Opus is experiencing high load` → `--fallback-model` helps; map to `OVERLOADED`.
- Cost fields: `total_cost_usd` / `modelUsage[].costUSD` are **client-side estimates at list price** computed from a bundled price table; on a subscription they are not what the user pays (the `/usage` Session block note: "Claude Max and Pro subscribers have usage included in their subscription, so the session cost figure isn't relevant for billing"). Show them as "equivalent API cost" only. `--max-budget-usd` is enforced against this estimate and still works on subscription as a runaway guard.
- Concurrency: nothing forbids parallel `claude -p` processes, but they share the same windows. Serialize with a small queue (1–2 in flight) and back off until `resetsAt` after a `USAGE_LIMIT`.

---

## 5. Agent SDK (TypeScript) on subscription auth — the authoritative answer

Sources: SDK overview, SDK TypeScript reference, authentication page, legal page, DEV article (2026-05-10).

- Mechanism: `@anthropic-ai/claude-agent-sdk` "bundles a native Claude Code binary for your platform as an optional dependency" (`@anthropic-ai/claude-agent-sdk-win32-x64`) and spawns it; `pathToClaudeCodeExecutable` can point at a separately installed `claude` instead. The SDK version tracks the bundled CLI version (0.3.283 ↔ 2.1.283). The subprocess resolves credentials exactly like `claude -p`, so with no `ANTHROPIC_API_KEY` in `options.env` it uses the subscription OAuth (rank 7) or `CLAUDE_CODE_OAUTH_TOKEN` (rank 5). The authentication page confirms: "`apiKeyHelper`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN` apply to the CLI and the surfaces that wrap it, including the VS Code extension, the Agent SDK, and GitHub Actions" — i.e. the SDK is a wrapper over the same auth stack. The quickstart nevertheless tells developers to "set your API key".
- Official position (SDK overview, verbatim): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." Legal page: "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication ... Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." And: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
- So: "many sources say it requires an API key" is wrong as a **technical** statement and right as a **policy** statement for products distributed to other users. For this project (one user, their own machine, their own login done through Anthropic's own flow, unmodified binary, app never sees the token) the CLI-spawn path fits the "end user signing in to the unmodified Claude Code binary" carve-out better than the SDK path, because the SDK ships its own copy of the binary inside the app (that is "preinstalling Claude Code in your product", which the legal page conditions on the Commercial ToS) and sets `CLAUDE_AGENT_SDK_CLIENT_APP` to identify the embedding app.
- SDK option shapes worth knowing if we ever switch (from docs; the `.d.ts` could not be fetched whole → exact TS unions UNVERIFIED): `systemPrompt: string | string[] | { type: 'preset', preset: 'claude_code', append?, excludeDynamicSections?, snapshot? }`; `tools: string[] | { type: 'preset', preset: 'claude_code' }` (`[]` removes all built-ins); `strictMcpConfig: boolean`; `settingSources: SettingSource[]` (`[]` skips user/project/local); `persistSession: boolean`; `env`; `outputFormat: { type: 'json_schema', schema }`; `abortController`; `maxTurns`; `maxBudgetUsd`; `permissionMode`; `permissionPrompts: 'host' | 'none'` (2.1.259+); `effort`; `thinking`; `mcpServers` incl. in-process `createSdkMcpServer({ name, version, tools: [tool(name, desc, zodShape, handler, { annotations: { readOnlyHint: true } })] })`. Result: `message.type === 'result'`, `subtype`, `structured_output`, `total_cost_usd`, `modelUsage`, `stop_reason`. The SDK's default system prompt is a **minimal** one (not the Claude Code prompt) unless the preset is set. A single-shot `query()` throws after yielding an error result.
- Verdict for D-038: do not add the SDK dependency in v2. Its two real advantages (in-process MCP tools, typed messages) are outweighed by bundling a second 100+ MB binary that would need its own update cadence, the policy exposure, and the fact that the app's MCP server must be out-of-process anyway to serve Gemini's CLI. Revisit only if the direct-spawn wrapper proves brittle.

---

## 6. Licensing, bundling, Windows install paths, version pinning

Sources: legal-and-compliance page, setup page, npm registry.

- Claude Code is proprietary (`SEE LICENSE IN README.md`); Pro/Max use is under the **Consumer Terms**. "Preinstalling or running Claude Code in your products or services ... requires agreeing to our Commercial Terms of Service" plus: binary unmodified, no removing/restricting auth methods, "each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential", no reselling/intermediating. Naming: you may say in plain text that the product "runs Claude Code"; you may not use the Claude Code/Anthropic names or logos in the product name/logo or imply endorsement. The SDK branding guidance additionally prefers "Claude Agent"/"Powered by Claude" and forbids "Claude Code"-branded UI.
- **Decision input:** do not bundle. Detect a user-installed CLI; if absent, show the official install command and a "Sign in" button that opens a terminal running `claude auth login --claudeai`. Label the provider "Claude (your subscription, via Claude Code)".
- Windows install paths:
  - Native installer (recommended by Anthropic; **observed here**): `irm https://claude.ai/install.ps1 | iex` → `%USERPROFILE%\.local\bin\claude.exe` (launcher) + `%USERPROFILE%\.local\share\claude\versions\<ver>\`. Auto-updates in the background; `autoUpdatesChannel: "stable" | "latest"`, `minimumVersion` floor, `DISABLE_AUTOUPDATER=1` (background only), `DISABLE_UPDATES` (all). Pin a specific version: `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) 2.1.258` or `claude install <version>`.
  - npm: `npm install -g @anthropic-ai/claude-code` (Node 22+ for the package, but the installed binary does not use Node) → `%APPDATA%\npm\claude.cmd` → `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.
  - WinGet: `winget install Anthropic.ClaudeCode` (no auto-update; install path UNVERIFIED — resolve via `where.exe claude`).
  - Requirements: Windows 10 1809+; Git for Windows optional (only for the Bash tool, which we disable). Binaries are Authenticode-signed by "Anthropic, PBC" (`Get-AuthenticodeSignature`) — the app can verify the signer before spawning (cheap integrity check; UNVERIFIED that the launcher `.exe` and the versioned binary are both signed).
- Version policy for the app: because the native install auto-updates, the app cannot pin; instead it reads `--version` at provider start, requires `>= 2.1.221`, gates optional flags by version (`--permission-prompts none` ≥ 2.1.259, `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` ≥ 2.1.275, `--settings <file>` with `-p` ≥ 2.1.281), and asserts the `system/init.tools` list is empty-or-allowed at runtime (fails closed if a future version changes `--tools ""` semantics). Do not modify the user's `~/.claude/settings.json`.

---

## 7. Exact command lines

Placeholders: `$CLAUDE` = resolved `claude.exe`; `$CWD` = app-owned empty dir; `$MCP` = temp file with the loopback MCP config.

### 7.1 `extract(schema)` — S1, no tools, JSON schema

```
"$CLAUDE" -p ^
  --input-format stream-json --output-format stream-json --verbose ^
  --no-session-persistence --restricted --disable-slash-commands ^
  --tools "" --strict-mcp-config --permission-mode dontAsk ^
  --disallowedTools "Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate" ^
  --max-turns 1 --effort low --model sonnet --fallback-model haiku ^
  --system-prompt-file "<app>\prompts\s1-extract.system.txt" ^
  --json-schema "<S1 draft-07 schema as one JSON string>"
```
stdin: one `{"type":"user",...}` line (text, plus optional image block for the pictures feature), then EOF. Read stdout line-by-line; take `structured_output` from the `result` line.

(`--system-prompt-file` avoids Windows argument-length limits and process-list leakage; `--json-schema` must be an argument, so keep schemas small; UNVERIFIED whether `--json-schema` accepts a file path — assume not.)

### 7.2 `draft(tools via MCP)` — S3, read-only app tools

```
"$CLAUDE" -p ^
  --input-format stream-json --output-format stream-json --verbose ^
  --no-session-persistence --restricted --disable-slash-commands ^
  --tools "" --permission-mode dontAsk ^
  --mcp-config "$MCP" --strict-mcp-config ^
  --allowedTools "mcp__wa__*" --disallowedTools "<same list as 7.1>" ^
  --max-turns 6 --effort medium --model sonnet --fallback-model haiku ^
  --system-prompt-file "<app>\prompts\s3-draft.system.txt" ^
  --json-schema "<S3 draft schema>"
```
Env for both: `MCP_TIMEOUT=15000`, `MCP_TOOL_TIMEOUT=20000`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`? (no — leave default; we spawn no background tasks), plus the stripped-key environment from §3. The MCP server exposes only the D-040 read-only tools plus D-038 calendar read-only tools; ToolGate denies everything else; update-event stays reachable only from ActionExecutor (D-036).

### 7.3 Detection

```
"$CLAUDE" --version                 -> parse /^(\d+)\.(\d+)\.(\d+)/
"$CLAUDE" auth status --json        -> JSON.parse(stdout).loggedIn === true
```

---

## 8. Minimal TypeScript wrapper shape

```ts
// src/main/providers/claude-cli/ClaudeCliProvider.ts  (shape only; not the full implementation)
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type ClaudeCliErrorCode =
  | "NOT_INSTALLED" | "VERSION_TOO_OLD" | "NOT_LOGGED_IN" | "USAGE_LIMIT"
  | "RATE_LIMITED" | "OVERLOADED" | "MODEL_UNAVAILABLE" | "ACCOUNT_ON_HOLD"
  | "TIMEOUT" | "ABORTED" | "BAD_OUTPUT" | "MCP_UNAVAILABLE" | "UNKNOWN";

export class ClaudeCliError extends Error {
  constructor(public code: ClaudeCliErrorCode, message: string,
              public resetsAt?: number, public raw?: unknown) { super(message); }
}

export interface RunOptions {
  systemPromptFile: string;
  userContent: Array<{ type: "text"; text: string } |
                     { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
  jsonSchema?: object;          // draft-07
  mcpConfigPath?: string;       // loopback HTTP server config, per-run bearer token inside
  allowedTools?: string[];      // e.g. ["mcp__wa__*"]
  maxTurns: number;
  model: "sonnet" | "haiku" | "opus" | string;
  fallbackModel?: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult<T> {
  structured?: T; text?: string; sessionId: string;
  estimateUsd: number; usage: unknown; rateLimit?: { status: string; resetsAt?: number; type?: string; usingOverage?: boolean };
  initTools: string[]; mcpServers: Array<{ name: string; status: string }>;
}

const DENY = "Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate";
const STRIP_ENV = ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_PROFILE","ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID","CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX","CLAUDE_CODE_USE_FOUNDRY"];

export class ClaudeCliProvider {
  constructor(private exe: string, private cwd: string, private version: [number, number, number]) {}

  static async detect(exeOverride?: string): Promise<ClaudeCliProvider> {
    const exe = exeOverride ?? (await resolveClaudeExe());          // where.exe → %USERPROFILE%\.local\bin\claude.exe → %APPDATA%\npm\claude.cmd
    if (!exe) throw new ClaudeCliError("NOT_INSTALLED", "Claude Code CLI not found");
    const v = parseVersion(await execFileText(exe, ["--version"])); // ENOENT → NOT_INSTALLED
    if (cmp(v, [2, 1, 221]) < 0) throw new ClaudeCliError("VERSION_TOO_OLD", `claude ${v.join(".")} < 2.1.221`);
    return new ClaudeCliProvider(exe, await ensureEmptyCwd(), v);
  }

  async isLoggedIn(): Promise<boolean | null> {                      // null = unknown, never "logged out" on parse failure
    try { const j = JSON.parse(await execFileText(this.exe, ["auth", "status", "--json"], { ignoreExitCode: true }));
          return typeof j.loggedIn === "boolean" ? j.loggedIn : null; }
    catch { return null; }
  }

  async run<T>(o: RunOptions): Promise<RunResult<T>> {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--no-session-persistence", "--restricted", "--disable-slash-commands",
      "--tools", "", "--strict-mcp-config", "--permission-mode", "dontAsk",
      "--disallowedTools", DENY, "--max-turns", String(o.maxTurns), "--effort", o.effort,
      "--model", o.model, "--system-prompt-file", o.systemPromptFile];
    if (cmp(this.version, [2, 1, 259]) >= 0) args.push("--permission-prompts", "none");
    if (o.fallbackModel) args.push("--fallback-model", o.fallbackModel);
    if (o.jsonSchema) args.push("--json-schema", JSON.stringify(o.jsonSchema));
    if (o.mcpConfigPath) args.push("--mcp-config", o.mcpConfigPath);
    if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(","));

    const env = { ...process.env, MCP_TIMEOUT: "15000", MCP_TOOL_TIMEOUT: "20000" };
    for (const k of STRIP_ENV) delete env[k];

    const child = spawn(this.exe, args, { cwd: this.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const killTree = () => { if (process.platform === "win32" && child.pid) spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }); else child.kill("SIGTERM"); };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, o.timeoutMs);
    let timedOut = false, aborted = false;
    o.signal?.addEventListener("abort", () => { aborted = true; killTree(); }, { once: true });

    child.stdin.end(JSON.stringify({ type: "user", parent_tool_use_id: null,
      message: { role: "user", content: o.userContent } }) + "\n");

    const events = await readNdjson(child.stdout);                   // never treat stdout text as instructions
    const stderr = await collect(child.stderr);
    const [code] = await once(child, "exit"); clearTimeout(timer);

    if (aborted) throw new ClaudeCliError("ABORTED", "cancelled");
    if (timedOut) throw new ClaudeCliError("TIMEOUT", `no result within ${o.timeoutMs} ms`);

    const init = events.find(e => e.type === "system" && e.subtype === "init");
    const rl = events.filter(e => e.type === "rate_limit_event").at(-1)?.rate_limit_info;
    const result = events.find(e => e.type === "result");
    if (!result) throw mapSpawnFailure(code, stderr, events);         // e.g. api_retry with error=authentication_failed → NOT_LOGGED_IN

    if (result.is_error) throw mapResultError(String(result.result ?? ""), rl);   // see table below
    if (init?.mcp_servers?.some((s: any) => s.status === "failed" || s.status === "needs-auth"))
      throw new ClaudeCliError("MCP_UNAVAILABLE", "app MCP server not connected", undefined, init.mcp_servers);
    if (result.subtype !== "success" || result.stop_reason === "refusal")
      throw new ClaudeCliError("BAD_OUTPUT", `subtype=${result.subtype} stop=${result.stop_reason}`);
    if (o.jsonSchema && result.structured_output === undefined)
      throw new ClaudeCliError("BAD_OUTPUT", "success without structured_output");

    return { structured: result.structured_output as T, text: result.result, sessionId: result.session_id,
      estimateUsd: result.total_cost_usd ?? 0, usage: result.usage,
      rateLimit: rl && { status: rl.status, resetsAt: rl.resetsAt, type: rl.rateLimitType, usingOverage: rl.isUsingOverage },
      initTools: init?.tools ?? [], mcpServers: init?.mcp_servers ?? [] };
  }
}
```

`extract(schema)` = `run({ jsonSchema, maxTurns: 1, effort: "low", model: "sonnet", fallbackModel: "haiku", ... })`.
`draft(tools)` = `run({ mcpConfigPath, allowedTools: ["mcp__wa__*"], maxTurns: 6, effort: "medium", jsonSchema: draftSchema, ... })`.

Two invariants to enforce in code: (1) S4 validates `structured` against the app's own schema again (never trust `structured_output` blindly); (2) the ToolGate on the MCP server side is the only place tools are authorised — the CLI's `--allowedTools` is a convenience, not the security boundary.

### 8.1 Error mapping table (`mapResultError` / `mapSpawnFailure`)

| Signal (case-insensitive regex on `result` text, or event) | Code | Notes |
|---|---|---|
| spawn `ENOENT` / `where.exe` empty | `NOT_INSTALLED` | show install command |
| version `< 2.1.221` | `VERSION_TOO_OLD` | show `claude update` |
| `Not logged in` · `Please run /login` · `Login expired` · `Authentication required` · `OAuth session expired` · `Invalid API key` · `401` · `api_retry.error === "authentication_failed"` | `NOT_LOGGED_IN` | show "Sign in" (opens terminal `claude auth login --claudeai`) |
| `account is on hold` · `api_retry.error === "account_on_hold"` | `ACCOUNT_ON_HOLD` | link claude.ai/restricted |
| `You've hit your (session\|weekly\|Opus\|Sonnet\|individual usage) limit` · `monthly spend limit` · `Credit balance is too low` · `rate_limit_info.status !== "allowed"` | `USAGE_LIMIT` | carry `resetsAt` (epoch s); pause queue until then; if the text names Opus/Sonnet only, retry once with the other family |
| `Rate limit reached` · `429` · `temporarily limiting requests` · `api_retry.error === "rate_limit"` (final) | `RATE_LIMITED` | exponential backoff (30 s, 60 s, 120 s), max 3 |
| `529` · `Overloaded` · `experiencing high load` · `api_retry.error === "overloaded"` · `No response from API` · `Request timed out` | `OVERLOADED` | retry with `--fallback-model` already in place; then backoff |
| `not a recognized model id` · `Model .* not found` · `not available with the Claude Pro plan` · `restricted by your organization` · `does not support this model` · `api_retry.error === "model_not_found"` | `MODEL_UNAVAILABLE` | switch to `sonnet`; surface in settings |
| `subtype === "error_max_structured_output_retries"` · success without `structured_output` · `stop_reason === "refusal"` | `BAD_OUTPUT` | one retry with a simplified schema, then fail the proposal (never guess) |
| `subtype === "error_max_turns"` | `BAD_OUTPUT` | raise `maxTurns` only for draft, never for extract |
| init `mcp_servers[].status ∈ {failed, needs-auth}` or `mcp_server_errors` non-empty | `MCP_UNAVAILABLE` | app bug; log init event |
| killed by timeout / abort | `TIMEOUT` / `ABORTED` | exit 143 on SIGTERM (POSIX); on Windows the taskkill exit code |
| anything else | `UNKNOWN` | keep `raw` (redacted) for diagnostics |

Redaction: before logging any `result` text or stderr, apply the project's credential redaction (the CLI should never echo tokens, but stderr under `--verbose` can include request metadata; the app's `--mcp-config` file contains the loopback bearer token and must be deleted after each run).

---

## 9. Executable resolution on Windows

Order: (1) explicit path from app settings (validated: exists, ends with `claude.exe` or `claude.cmd`); (2) `where.exe claude` (first hit); (3) `%USERPROFILE%\.local\bin\claude.exe`; (4) `%APPDATA%\npm\claude.cmd`; (5) not found. Spawn `.exe` directly without a shell; for `.cmd` use `shell: false` with `cmd.exe /c` semantics or prefer resolving the underlying `.exe` under `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`. Optional integrity check: `Get-AuthenticodeSignature` signer `Anthropic, PBC` (UNVERIFIED for the launcher stub).

---

## 10. Things that changed recently and are easy to get wrong

- `--bare` is recommended by the docs for scripted calls "and will become the default for `-p` in a future release", but it **cannot** use the subscription. If Anthropic flips the default, the app must pass an explicit non-bare mode (watch the changelog; assert `system/init.apiKeySource`/auth in a smoke test; `apiKeySource` literal values UNVERIFIED — docs list `user | project | org | temporary | none` style values, the `.d.ts` reportedly also has `oauth`).
- `-p` without `--bare` runs hooks from `~/.claude/settings.json` and connects `.mcp.json` servers of the working directory (no trust prompt). `--restricted` + `--strict-mcp-config` + an empty app-owned cwd neutralise that.
- The default permission mode for `-p` is Manual on every plan; with no host to answer, prompts are denied (and, without `dontAsk`/`--permission-prompts none`, Claude may keep retrying).
- `--json-schema` + zero tools → the `$PARAMETER_NAME` self-healing bug (extra round-trip ≈ extra usage).
- `--strict-mcp-config` meaning grew in 2.1.221 (now also "fail if a server doesn't connect").
- `total_cost_usd` on a resumed session now includes earlier runs (2.1.277+); we never resume, so irrelevant.
- Session transcripts are written to disk by default; `--no-session-persistence` is mandatory for our privacy rules.
- `--system-prompt` turns off system-prompt snapshotting (fine for single-shot runs).

---

## 11. Policy / risk register for D-038 (Claude side)

1. **Enforcement risk (medium).** On 2026-04-04 Anthropic blocked "third-party harnesses" (OpenClaw et al.) from using Pro/Max subscriptions; coverage says OAuth is restricted to Claude.ai and Claude Code; a community project that spawns the Agent SDK as a subprocess reported being affected (UNVERIFIED which technical signal is used; possibly `CLAUDE_AGENT_SDK_CLIENT_APP` / user agent, possibly account-level review). Our path (unmodified user-installed CLI, user's own login, single user, ordinary volume) matches the legal page's explicit carve-out, but Anthropic "may enforce ... without prior notice". Mitigation: keep the provider pluggable (local llama default, Gemini, API key), never store tokens, keep call volume ordinary, and surface a clear error if `oauth_org_not_allowed`/authentication failures start appearing.
2. **Terms.** Consumer Terms govern the user's subscription; the app must not "offer claude.ai login" (it doesn't — it tells the user to run Anthropic's own `claude auth login`), must not intermediate credentials, and must not brand itself with Claude Code. Provider label: "Claude via your Claude Code sign-in".
3. **Usage windows.** Shared with the user's own claude.ai/Claude Code use; a chatty background loop can lock the user out of their own tools for hours. Default: cloud calls only for S1/S3 of chats the local triage flags, with a per-hour cap in settings and a visible "resets at" indicator from `rate_limit_event`.
4. **Auto-update drift.** The native install auto-updates; flags may change. Gate by version, assert `init.tools`, and run the smoke test on provider start (one tiny `extract` with a 1-field schema, `--max-turns 1`, haiku) — costs a few hundred tokens.
5. **Privacy.** With `--no-session-persistence` the CLI does not persist transcripts, but Anthropic still processes the message text server-side under the consumer terms (data used per the user's claude.ai privacy settings). State this in the settings UI when the user enables the Claude provider.

---

## 12. Sources

- Headless / `-p`: https://code.claude.com/docs/en/headless
- CLI reference (flags, subcommands): https://code.claude.com/docs/en/cli-reference
- Authentication, precedence, credential storage, `setup-token`: https://code.claude.com/docs/en/authentication
- Legal and compliance (bundling, OAuth policy): https://code.claude.com/docs/en/legal-and-compliance
- Setup, Windows install, version pinning, code signing: https://code.claude.com/docs/en/setup
- Model aliases, plans, fallback: https://code.claude.com/docs/en/model-config
- Costs, `/usage`, usage credits, limit messages: https://code.claude.com/docs/en/costs
- Error reference (exact strings): https://code.claude.com/docs/en/errors
- Interactive-mode usage-limit wait (not applicable to `-p`): https://code.claude.com/docs/en/interactive-mode
- Agent SDK overview (policy note, license): https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK TypeScript reference (options, bundled binary): https://code.claude.com/docs/en/agent-sdk/typescript
- Structured outputs: https://code.claude.com/docs/en/agent-sdk/structured-outputs
- MCP in the SDK/CLI: https://code.claude.com/docs/en/agent-sdk/mcp
- Custom tools / `tools: []`: https://code.claude.com/docs/en/agent-sdk/custom-tools
- Streaming input (images): https://code.claude.com/docs/en/agent-sdk/streaming-input
- Permissions evaluation, `dontAsk`: https://code.claude.com/docs/en/agent-sdk/permissions
- Agent loop, result subtypes: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Cost tracking semantics: https://code.claude.com/docs/en/agent-sdk/cost-tracking
- System prompts (`--system-prompt`, boundary marker): https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- Pro/Max support article (updated 2026-08-19): https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- npm registry: https://registry.npmjs.org/@anthropic-ai/claude-code , https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk
- Issue: headless API errors reported as `subtype: success` + exit 0 (open): https://github.com/anthropics/claude-code/issues/79500
- Issue: `--json-schema` `$PARAMETER_NAME` keys on tool-less calls (closed, not planned): https://github.com/anthropics/claude-code/issues/87234
- Issue: `rate_limit_event` shape / no headless utilisation (closed, not planned): https://github.com/anthropics/claude-code/issues/78476
- Community: `claude auth status --json` → `loggedIn` parsing (lezli01/vincent PR #460): https://github.com/lezli01/vincent/pull/460
- Community: Agent SDK on Pro/Max (2026-05-10): https://dev.to/aviv_shaked/how-to-use-your-claude-promax-subscription-with-the-agent-sdk-python-typescript-4emi
- Press on the 2026-04-04 harness block: https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and ; https://github.com/thedotmack/claude-mem/issues/1826
