# Research: CLI <-> MCP bridge (v2 "cli-mcp-bridge")

Researched 2026-09-27, re-verified and revised 2026-09-28 for "WhatsApp Calendar Agent" v2 (Electron 44 + TS, Node 24, Windows 11). Scope: D-038 (subscription cloud LLMs through the vendor's agent CLI used headlessly) and D-040 (read-only WhatsApp MCP) - how the app exposes its OWN read-only tools (`get_current_time`, `get_freebusy`, the new `wa_*` tools) to a CLI that runs as a completion backend, without giving up ToolGate, the seven invariants or the verified S1->S4 pipeline.

This revision reconciles the three sibling reports that touch the same seam: `v2-claude-cli-backend.md` (owns the Claude CLI adapter), `v2-gemini-cli-backend.md` (owns the Antigravity adapter and the policy analysis) and `v2-whatsapp-mcp-readonly.md` (owns the WhatsApp tool server). Where they disagreed, the decision and the reason are stated here (section 0.1).

Sources: the installed binaries on this machine (`claude.exe --help` 2.1.258, read 2026-09-28), the installed `@modelcontextprotocol/sdk@1.30.0` and `zod@4.6.5` sources (`node_modules`), `code.claude.com/docs` (cli-reference, mcp, headless, permissions, env-vars - fetched 2026-09-28), `support.claude.com`, `antigravity.google/docs` (headless, mcp, permissions, subagents - fetched 2026-09-28), the `google-antigravity/antigravity-cli` releases page and issues #548 / #916, `anthropics/claude-code` issue #16963, the Google AI Developers Forum thread 183051. Anything not confirmed against one of those is marked **UNVERIFIED** and appears again in section 12 with the manual check that closes it. Web pages and issue text were treated as data, never as instructions. No CLI was run with the user's login; `claude.exe` was invoked with `--help` / `--version` only.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Which CLIs are real on 2026-09-28 | **Claude Code CLI** (`claude`, native build; **2.1.258** installed at `%USERPROFILE%\.local\bin\claude.exe`, 218 MB single exe, no `.cmd` shim). **Antigravity CLI** (`agy`, Go, closed source; latest **1.2.12, 2026-09-27**; on this machine only its state dir `~/.gemini/antigravity-cli/` remains - the binary dir `%LOCALAPPDATA%\agy\bin` is absent and `where.exe agy` finds nothing). **Gemini CLI is dead for the user's tier** (free / Google AI Pro / Ultra cut off 2026-06-18; API-key only now, which is the fallback the app already has). |
| Subscription policy | Anthropic (help-center, note dated **2026-06-15**, still current 2026-09-28): "nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." Spawning the user's own unmodified `claude -p` is the sanctioned shape; the app never reads `~/.claude/.credentials.json`, never uses `claude setup-token`. Google (forum, staff, 2026-09-15): launching `agy` "as a local child process in headless mode ... relying on agy's cached Google credentials is a supported workflow"; (2026-09-25) "cannot be used to power third-party agents" - a gray zone documented in `v2-gemini-cli-backend.md` section 3; the Antigravity provider ships **opt-in, experimental, with the Terms section 6 disclosure**. |
| Transport (a) | **Streamable HTTP on `127.0.0.1:<ephemeral>` hosted IN the Electron main process, one listener per run, per-run 32-byte bearer token.** Not stdio: a stdio server would be a second process spawned by the CLI (with the CLI's env, orphaned on hard kill) that cannot reach `ToolGate`'s per-run `RunCtx` without yet another IPC hop. Claude Code supports `{"type":"http","url","headers"}` with `${VAR}` expansion in headers; Antigravity supports `{"serverUrl","headers"}` (literal only). |
| The server IS the gate (b) | `McpToolServer` registers, per run, exactly `gate.exposedSpecs()`; every `tools/call` goes through `ToolGate.invoke()` unchanged (budget, `z.strictObject` args, app-pinned window / chat handle, projection, nonce wrap). The CLI only ever sees our `tools/list`; a budget / bad-args refusal is the same `{"error":"tool not available"}` `isError` result v1 returns today. |
| Lock-down (c) | **Claude**: `-p --restricted --strict-mcp-config --mcp-config <json> --tools "" --allowedTools "mcp__wca__*" --disallowedTools "mcp__*"-free deny list --permission-mode dontAsk [--permission-prompts none >= 2.1.259] --disable-slash-commands --no-session-persistence --system-prompt <verbatim> --max-turns N --output-format stream-json --verbose`, empty temp cwd, allow-listed env with `ENABLE_TOOL_SEARCH=false` and **no** `ANTHROPIC_API_KEY`, plus a **fail-closed assertion of the `system/init` event** (`mcp_servers == [{wca,connected}]`, `tools` subset of `mcp__wca__*`). **Antigravity in v2: NO MCP** - the CLI runs in **no-tools mode** (custom agent with `tools: []`, `commandExecutionPolicy: off`; the app prefetches free/busy and WhatsApp context through the same `ToolGate` and inlines it in the nonce block) because headless permission handling is broken (issues #548, #916 both open) and there is no strict-mcp / tools-off flag. The MCP-to-`agy` recipe is kept in section 6.2 as the v2.1 variant behind the smoke test. |
| Per-run contract (d) | Same `<<DATA-nonce>> ... <<END-DATA-nonce>>` block in the prompt as v1; tool results nonce-wrapped by the server; wall clock `LIMITS.cliWallClockMs = 120_000` (S3) / `60_000` (S1) with `AbortSignal` -> `child.kill()` -> `taskkill /PID <pid> /T /F` (v1 `proc/supervisor.ts` `taskkillArgs`); **concurrency 1** (one `CliRunner` mutex, one listener); stream-json `tool_use` blocks + `permission_denials` -> v1's `tool_blocked` audit shape plus a new `cli_run` row. |
| One tool source (e) | `agent/toolDefs.ts` becomes the single zod-first table `{name, description, args: z.strictObject, maxCallsPerRun, exposedWhen, execute}`; the LLM `LlmTool` JSON (LCD subset) is derived once with `z.toJSONSchema(args, { target: 'draft-07' })` + a `toLcd()` post-pass and frozen by the I4 purity test; the MCP server registers the same zod shapes (`registerTool` takes `ZodRawShapeCompat`). Local (llama-server), the API-key providers and the CLI providers therefore see byte-identical tools, including `wa_*`. |
| Do NOT | Use `--bare` (never reads OAuth -> no subscription); add `@anthropic-ai/claude-agent-sdk` (bundles a ~200 MB binary, Claude-only); `--dangerously-skip-permissions` / `bypassPermissions` on either CLI; `shell:true` spawns; `claude setup-token`; edit `~/.gemini/antigravity-cli/settings.json` silently. |

### 0.1 Reconciliation with the sibling reports

| Topic | `claude-cli-backend` | `gemini-cli-backend` | `whatsapp-mcp-readonly` | **Decision here** |
|---|---|---|---|---|
| Gemini route | - | Antigravity `agy`, opt-in, experimental, no-tools mode | wrote a Gemini CLI recipe (`httpUrl`, `--allowed-mcp-server-names`) | **Antigravity, no-tools mode in v2** (Gemini CLI is API-key-only since 2026-06-18; the WA report's Gemini CLI section is superseded, its server design stands) |
| Transport | loopback HTTP + temp config file | (no tools) | loopback HTTP + `ToolSessionRegistry` (long-lived listener while a CLI provider is active) | **loopback HTTP, per-run listener** (simplest lifetime: no registry, nothing outlives the run). The registry variant is acceptable if the port must be stable for a settings-time smoke test; both give the same 404-after-run guarantee |
| Config delivery to Claude | `--mcp-config <temp file>` (token not on the command line) | - | `--mcp-config <temp file>` | **inline JSON with `${WCA_MCP_TOKEN}` env expansion** (token never on argv, never on disk); file variant kept for Antigravity, where headers are literal |
| MCP server name | `wa` | - | `waagent` | **`wca`** (no underscore, no dash; Claude rules use `mcp__wca__*`; Antigravity rules `mcp(wca/*)`) - one line to change in either sibling |
| `--tools ""` / `--restricted` | verified in installed help | - | UNVERIFIED (secondary sources) | **verified** against `claude.exe --help` 2.1.258 (exact text in 2.1) |
| Turn cap | `--max-turns 1 / 6` | `--print-timeout` only | `--max-turns 6` | `--max-turns` works but is absent from `--help` (issue #16963); S1 = 1, S3 = `LIMITS.draftTurnsWithTools + 1` |
| Auto mode with a CLI provider (auto-mode Q5) | - | - | - | **Claude CLI: allowed** (`--tools ""` + init assertion proves zero built-in tools). **Antigravity: allowed only in no-tools mode with `init.tools` asserted empty**; if the assertion cannot be made on the installed version, auto mode is unavailable while `antigravity_cli` is active |

---

## 1. What the app has today (read before designing)

- `src/main/agent/toolDefs.ts`: `READ_TOOL_NAMES = ['get_current_time','get_freebusy']`, hand-written LCD JSON schemas (`JsonSchemaLcd` of `src/shared/types.ts`: `type`, `properties`, `required`, `enum`, `items`, `additionalProperties:false`, `description` - no `$ref`, `anyOf`, `minimum`, `maxLength`), `maxCallsPerRun` 1 / 3, `mcpTool` name mapping.
- `src/main/agent/toolGate.ts`: `createToolGate({read, settings, calendarConnected, audit})` -> `exposedTools()`, `invoke(call, ctx)` (ARCH 5.3 steps 1-6: case-sensitive name check with manipulation strike, per-run budget `ctx.calls` / `LIMITS.draftToolCalls = 4`, `z.strictObject` parse + `pinWindow` (timeMin >= now, <= 14 d window, <= 60 d horizon, calendar ids / zone / account from settings), `McpReadClient` call, `projectBusy`, `wrapDataBlock(ctx.nonce, json)`), `prefetchFreeBusy`. Audits `tool_blocked` with `{nameSha8, nameLen, verdict, runId}` only.
- `src/main/agent/draft.ts`: `runDraft(provider, {messages, ctx, gate, ...})` owns the loop: <= `LIMITS.draftTurnsWithTools = 3` turns, one forced no-tool final turn, `blockedCallsAbort = 2`, `AbortSignal.any([ctx.signal, AbortSignal.timeout(wallClockMs)])`.
- `src/main/agent/contextBuilder.ts`: `wrapDataBlock(nonce, json)` escapes every `<` as `<`, so a literal `<<END-DATA-nonce>>` cannot occur inside the block; `buildContext()` never puts message text in the system part.
- `src/main/agent/prompt.ts`: `SYSTEM_PROMPT_EXTRACT`, `SYSTEM_PROMPT_DRAFT`, `EXTRACT_RULES_ADDENDUM`, `buildSystemPrompt()` - the verbatim constants a CLI run must receive unchanged.
- `src/main/llm/types.ts`: `LlmProvider { structured(), chat(), validate(), dispose() }` - `chat()` is **exactly one model turn and never executes tools**; `LlmMessage` history with `providerData` replay; `CallOpts {signal, maxOutputTokens, purpose, onUsage}`.
- `src/main/llm/factory.ts`: consent first (`assertConsent`), secret from `SecretStore` (`SECRET_FOR`), cache keyed by `id|model|sha(key)`, `usable()` for S0.
- `src/main/mcp/host.ts`: the calendar MCP **client** (`StdioClientTransport`, `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, `buildMcpEnv` allow-list asserted literally by a test, fail-closed `verifyToolset()` -> `toolset_mismatch`), `callerFor(cls)` the only exit. `readClient.ts` / `projection.ts`: `PinnedWindow`, `projectFreeBusy`, `projectCurrentTime`; raw server text never leaves.
- `src/main/proc/supervisor.ts`: `taskkillArgs(pid, tree)` = `['/PID', pid, '/T', '/F']` (by PID only, never `/IM`), `DEFAULT_GRACE_MS = 3_000`, pid-file + `PID_REUSE_TOLERANCE_MS`; `proc/reaper.ts` matches pid + exe path + creation time; `proc/freePort.ts` with `NEVER_PORTS` (8080).
- `src/shared/types.ts`: `AUDIT_KINDS` has `tool_blocked`, `toolset_mismatch`, `run_aborted` (no `tool_called` - executed calls are counted on the `runs` row); `LIMITS.draftWallClockCloudMs = 60_000`; `PROVIDER_IDS = ['local','claude','gemini']`; `CONSENT_KINDS`; `SECRET_NAMES`.
- `src/shared/settings.ts`: `SettingsSchema.llm.provider = z.enum(['local','claude','gemini'])`, `whatsapp: {processUnknownSenders, backlogHours}`, `privacy: {retentionDays}`.
- Reference WhatsApp MCP server (`whatsapp-mcp-server/main.py`, read for tool shapes only in the WA report): `search_contacts`, `list_messages`, `list_chats`, `get_chat`, `get_message_context`, plus the send/download tools we will **never** expose.

Consequence that shapes everything below: a vendor CLI runs the **whole agent loop inside itself**. `LlmProvider.chat()`'s "one turn, no tool execution" contract cannot be honoured by a CLI; the CLI provider needs an **agentic run** entry point where our MCP server is the gate and `--max-turns` is the turn budget. S1 (structured, no tools) maps cleanly onto `--json-schema` + no MCP server + `--tools ""`.

---

## 2. The 2026 CLI landscape (verified 2026-09-28)

### 2.1 Claude Code CLI

- Installed: `%USERPROFILE%\.local\bin\claude.exe` = **2.1.258 (Claude Code)**, 218,507,936 bytes, native build. `where.exe claude` finds nothing on this shell's PATH (the app must resolve the path itself, section 6.1). An npm install would instead give `%APPDATA%\npm\claude.cmd` -> `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.
- Flags present in the installed `--help` (exact spellings, verified 2026-09-28): `-p, --print`, `--output-format` (`text|json|stream-json`, print only), `--input-format` (`text|stream-json`, print only), `--json-schema <schema>`, `--mcp-config <configs...>` ("Load MCP servers from JSON files or strings"), `--strict-mcp-config` ("Only use MCP servers from --mcp-config, ignoring all other MCP configurations"), `--tools <tools...>` ("Use \"\" to disable all tools, \"default\" to use all tools, or specify tool names"), `--allowedTools, --allowed-tools`, `--disallowedTools, --disallowed-tools`, `--permission-mode <mode>`, `--restricted`, `--system-prompt <prompt>`, `--system-prompt-snapshot <on|off>`, `--append-system-prompt`, `--exclude-dynamic-system-prompt-sections`, `--setting-sources <sources>` (comma list of `user, project, local`), `--settings <file-or-json>`, `--disable-slash-commands` ("Disable all skills"), `--no-session-persistence`, `--effort <level>`, `--fallback-model <model>`, `--max-budget-usd <amount>` (print only), `--add-dir <directories...>`, `--verbose`, `--bare`, `--include-partial-messages`.
- **`--max-turns` is NOT in the `--help` output of 2.1.258** but it exists and works: the CLI reference documents it ("Limit number of agentic turns ... exits with error when reached"), issue anthropics/claude-code#16963 (2026-01-08) reports exactly that it is "undocumented in --help", and a September 2026 changelog entry fixes "a turn that could retry indefinitely, ignoring `--max-turns`". => use it; U1 of the earlier draft is closed. The runner still keeps its own wall clock as the hard guard.
- `--bare` help text, verbatim: "Minimal mode: skip hooks, LSP, plugin ... Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)". The headless page repeats it ("bare mode doesn't use your subscription login"), and adds that `--bare` "will become the default for `-p` in a future release" => **`--bare` is incompatible with D-038**, and the runner must assert on every run that the session actually used OAuth (section 6.3; `system/init.apiKeySource` literal values UNVERIFIED U9).
- `--restricted` help text, verbatim: "removes the built-in tools that run commands or code (Bash, PowerShell, REPL and the other code-running tools) and WebFetch unless --tools names them, and ignores user, project and local settings files (managed settings and --settings still apply; add --strict-mcp-config to skip MCP servers too). Also confines the file tools to the working directories (--add-dir included), refuses bypassPermissions, and lets only a person or the configured permission [host answer prompts]".
- `--strict-mcp-config` (docs `mcp`): uses **only** the servers passed with `--mcp-config`; ignores `.mcp.json`, user-scoped servers in `~/.claude.json`, plugin servers and claude.ai connectors. Before v2.1.246 strict mode still waited for approval of unloaded project servers - 2.1.258 is past that.
- MCP config JSON: `{"mcpServers":{"<name>":{"type":"http","url":"...","headers":{"Authorization":"Bearer ..."}}}}`. `${VAR}` and `${VAR:-default}` expand in `url` and `headers`; a block-list (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY`, `NPM_TOKEN`) reads as empty - a custom name such as `WCA_MCP_TOKEN` expands normally. An entry with `url` but no `type` is skipped and reported in `system/init.mcp_server_errors` (`url_missing_type`, >= 2.1.219).
- Permission rules (docs `permissions`, verified): tool names are `mcp__<server>__<tool>`; **allow** rules accept a glob only after a literal `mcp__<server>__` prefix (`mcp__wca__*` OK; `mcp__*` / `*` as allow rules are "skipped with a warning"); **deny** rules accept `"*"` and `"mcp__*"` globs and a bare-name deny "removes the tool from Claude's context" (`EndConversation` cannot be removed while another tool remains). `mcp__` rules with parentheses in a settings file are skipped.
- `--permission-mode dontAsk`: denies every call that would otherwise prompt; actions that need no approval in Manual mode still run (file reads in the working directories, the read-only command set) as do `--allowedTools` entries. `--permission-prompts none` (>= **2.1.259**; 2.1.258 rejects it with unknown-option) additionally tells Claude not to retry and removes `AskUserQuestion`; version-gate it.
- With `-p` + `--mcp-config`, Claude Code **waits for pending servers before the first turn**, up to `MCP_TIMEOUT` (30 s default; >= 2.1.221). `system/init` (first stream-json event) carries `mcp_servers[{name,status}]` (`pending|connected|failed|needs-auth|disabled`), `tools[]`, `plugins[]`, `plugin_errors[]`, `mcp_server_errors[]`, `capabilities[]` (>= 2.1.205). This is the fail-closed hook (section 6.3).
- **Tool search** is on by default since 2.1.221: MCP tools are discovered through a built-in `ToolSearch` tool rather than loaded upfront; `ENABLE_TOOL_SEARCH=false` switches to upfront loading (`WaitForMcpServers`). For a deterministic `system/init.tools` list and to avoid a `--tools ""` interaction, the runner sets `ENABLE_TOOL_SEARCH=false` (U2 remains: confirm in the smoke test that the three `mcp__wca__*` names appear in `init.tools`).
- `--output-format json` / the stream-json `result` event: `result` (text), `structured_output` (with `--json-schema`), `session_id`, `num_turns`, `total_cost_usd` (client-side estimate), `usage`, `permission_denials[]`, `is_error`, `stop_reason`, `subtype` (`success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`). Check `is_error` **first** (issue #79500: API failures can arrive as `subtype:'success', is_error:true`, exit 0); a `success` **without** `structured_output` is a failure. `system/api_retry.error` categories: `authentication_failed | oauth_org_not_allowed | account_on_hold | billing_error | rate_limit | overloaded | invalid_request | model_not_found | server_error | max_output_tokens | cloud_credential_error | unknown`.
- stdin: piped stdin is the prompt source, capped at 10 MB; an unreadable stdin on Windows crashed before 2.1.211 (we require >= 2.1.221 anyway). `--input-format stream-json` takes one `{"type":"user","message":{"role":"user","content":[...]}}` line and is the only way to attach an image block (used by the image-events research, not by S1/S3).
- SIGTERM: exits 143, kills its own Bash process trees, runs `SessionEnd` hooks (none under `--restricted`). On Windows `child.kill()` is `TerminateProcess`; the tree must be killed with `taskkill /T`.
- Env vars (docs `env-vars`, verified): `ANTHROPIC_API_KEY` - "In non-interactive mode (`-p`), the key is always used when present" and overrides the subscription => **never in the child env**. `CLAUDE_CONFIG_DIR` relocates config **and the OAuth credentials** => never set. Presence-based switches: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `DISABLE_BUG_COMMAND`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CI`. Value-based: `ENABLE_TOOL_SEARCH`, `MCP_TIMEOUT` (ms), `MCP_TOOL_TIMEOUT` (ms; default effectively unlimited), `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (5 min for HTTP), `MAX_MCP_OUTPUT_TOKENS` (25,000), `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` (>= 2.1.274).
- Structured output: `--json-schema` validates the schema at startup (draft-07 validator; `format` accepted, not enforced; >= 2.1.205); the CLI re-prompts on mismatch and ends with `error_max_structured_output_retries`. Issue #87234 (closed, not planned): tool-less `--json-schema` runs sometimes emit `$PARAMETER_NAME` keys on the first attempt and self-heal with one extra round-trip - accepted cost for S1 (the alternative, leaving `Read` enabled, widens the tool surface for nothing).

### 2.2 Anthropic subscription policy (the compliance question)

Timeline: 2026-02 a usage-policy clause restricted Free/Pro/Max OAuth tokens to Claude Code and Claude.ai; early **April 2026** the ban on third-party harnesses was reversed; the help-center article "Use the Claude Agent SDK with your Claude plan" carries the **June 15, 2026** note, re-read 2026-09-28: "We're pausing the changes ... For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits."

What that means for us:
1. Spawning the user's installed, user-authenticated `claude -p` **is** "`claude -p` usage"; the CLI makes the API calls with its own credentials.
2. The app must never read `~/.claude/.credentials.json`, never call `claude setup-token`, never put a subscription OAuth token into `@anthropic-ai/sdk`; the legal page (`claude-cli-backend` section 6) forbids intermediating Claude.ai credentials and bundling the binary without Commercial Terms - so **detect, never bundle**.
3. The policy has flipped three times in seven months. The consent screen for `claude_cli` says so in one sentence, and the runner maps `api_retry.error in {authentication_failed, oauth_org_not_allowed, account_on_hold}` to a user-visible `CLOUD_AUTH` state instead of retrying.

### 2.3 Antigravity CLI (`agy`) - what exists, what is broken

- Google Developers Blog "Transitioning Gemini CLI to Antigravity CLI": Antigravity CLI from 2026-05-19; on **2026-06-18 Gemini CLI stopped serving free, Google AI Pro and Google AI Ultra** logins. Gemini CLI remains usable only with paid Gemini / Agent Platform API keys - the v1 `@google/genai` provider already covers that.
- Binary `agy`, Go, closed source; installer `irm https://antigravity.google/cli/install.ps1 | iex` -> `%LOCALAPPDATA%\agy\bin\agy.exe` (added to the user PATH). On this machine that directory is **absent** (state dir `~/.gemini/antigravity-cli/` exists from 2026-09-01/02; `cli.log` was not opened this time). Latest release **1.2.12 (2026-09-27)**; releases almost daily.
- Headless docs (`/docs/cli/headless/`, verified 2026-09-28), exact flags: `-p, --print, --prompt`; `--output-format text|json|stream-json`; `--input-format text|stream-json`; `--json-schema <string|path|primitive>`; `--model <slug>` (exits non-zero if unknown); `--effort low|medium|high`; `--agent <name>`; `--print-timeout <dur>` (docs say default `5m`; release 1.2.6 changed the headless timeout to **unlimited unless `--print-timeout` is given** - always pass it); `--dangerously-skip-permissions` ("Auto-approve all tool calls" - **never**); `--sandbox`; `-c/--continue`, `--conversation <id>`. JSON envelope: `conversation_id, status (SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING), response, error, duration_seconds, num_turns, structured_output, json_schema, usage{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`. Stream-json: one `{"event":"init","conversation_id","init":{cwd, tools[], permission_mode:"request-review|always-proceed", model?, agent?, json_schema?}}`, then `step_update`s (`step_type: user_input|agent_response|tool|checkpoint`, `tool_name`, `tool_info{name,parameters,output,error}`), one `result` per turn. Exit codes 0 / 1 (invalid model, auth required, malformed stream JSON) / 2 (unsupported stream message) / **3** (since 1.2.6: model/agent API failure with an `AGY_ERROR: {...}` JSON line on stderr; 1.2.10 also for partially streamed failures). Auth: "Headless mode uses your cached credentials. Authenticate once with an interactive `agy` session first"; without a terminal an unauthenticated run "exits with an `authentication required` error instead of hanging".
- Tool approvals headlessly (docs): "A tool that requires approval it cannot obtain is soft-denied: the run continues, exits 0, and prints a notice to stderr"; "Reading and writing files inside your active workspace is auto-allowed; actions such as shell commands default to Ask". Grants: `permissions.allow[]` in `~/.gemini/antigravity-cli/settings.json` (**global file only for the CLI**; workspace overrides exist only in the IDE), rule syntax `mcp(server/tool) | mcp(server/*) | mcp(*)`, `command(...)`, `read_file(...)`, `write_file(...)`, `read_url(...)`, `execute_url(...)`, `unsandboxed(...)`; precedence **deny > ask > allow**.
- **Open bugs that decide the design** (both open on 2026-09-28, both assigned, no maintainer reply):
  - **#548** (2026-07-06, Windows 11): "`--print` (headless) mode ignores `permissions.allow` entirely" - tool calls that would prompt "hang indefinitely without respecting `--print-timeout`"; even `"toolPermission":"always-proceed"` is ignored; the "persist to settings.json" option writes nothing.
  - **#916** (2026-09-01, agy 1.1.23): the headless denial message tells the user to add `mcp(<target>)`, but only `mcp(<server>/<tool>)` matches; the wrong form "passes grant validation, is loaded into the permission set ... and then silently fails to match". The author confirms `mcp(markitdown/convert_to_markdown)` does work headlessly - so MCP-in-headless is *possible* on some versions, but it is a loop of silent failures on others.
- Missing vs Claude Code: no `--strict-mcp-config` (the user's global `~/.gemini/config/mcp_config.json` servers load in every run - on this machine that file registers the reference `whatsapp` MCP with `send_message`), no `--tools ""`, no `--system-prompt` (system prompt = custom agent body), no `--max-turns`, no `--no-session-persistence` (conversations are written under `~/.gemini/antigravity-cli/brain/<conv>/.../transcript.jsonl` - UNVERIFIED U5 whether that can be disabled), no env-var expansion in headers (practitioner report; docs silent), no config-dir env var. 1.2.11 fixed "project custom agents not being found in headless runs (`--agent`)" - so the workspace agent file needs **>= 1.2.11**.
- MCP config (`/docs/mcp?tab=cli`): global `~/.gemini/config/mcp_config.json`, workspace `.agents/mcp_config.json`; remote servers **must** use `serverUrl` ("Legacy fields like `url` or `httpUrl` are not supported") + `headers`; stdio = `command/args/env/cwd`; `disabled`, `disabledTools[]`. `agy mcp add/remove/list/enable/disable` exist since 1.1.16 (community cheat-sheet; not in the docs page fetched - UNVERIFIED, not needed).
- Google's position (forum thread 183051, Engineer760, 2026-09-15, verbatim): "Launching the official agy binary as a local child process in headless mode ... while relying on agy's cached Google credentials is a supported workflow." Unsupported: "Extracting OAuth tokens from disk, reusing credentials in custom HTTP clients, or calling Antigravity backend endpoints directly." The 2026-09-25 reply (thread 184829, quoted in `v2-gemini-cli-backend.md` 3.2) says a local MCP proxy that lets *other* agents use `agy -p` is not permitted. Our app is neither a token extractor nor a proxy for other agents, but the Terms section 6 text is broad => opt-in with disclosure, exactly as the Gemini report recommends.

**Conclusion for v2:** with #548 and #916 open, a headless `agy` run that *needs* an MCP tool call is not reliable (hang past `--print-timeout` or silent deny loop), and there is no way to stop the user's own global MCP servers from loading. The only robust shape today is **no-tools mode**: the app runs its ToolGate tools itself before the CLI starts, inlines the projected results into the nonce block, and the CLI produces text/JSON only. That keeps D-038's "the app KEEPS its verified pipeline, ToolGate and ActionExecutor" literally true for Antigravity, at the cost of the model not being able to *choose* which window to look at. Section 6.2 keeps the MCP variant for when the bugs are closed.

### 2.4 Claude Agent SDK (considered, rejected for v2)

`@anthropic-ai/claude-agent-sdk` (0.3.283 tracks CLI 2.1.283) ships a native Claude Code binary as a platform optional dependency (~200 MB) or needs `pathToClaudeCodeExecutable`; it offers `createSdkMcpServer()` + `tool()` (in-process MCP), `strictMcpConfig`, `allowedTools`, `permissionMode`, `maxTurns`, `outputFormat`, `persistSession:false`, `abortController`. It is Claude-only, doubles the binary in the installer or re-implements the same discovery, sets `CLAUDE_AGENT_SDK_CLIENT_APP` (a fingerprint the April enforcement may key on - UNVERIFIED), and its policy status is the same paused note. The CLI-spawn design gives the same guarantees for both vendors with one runner.

---

## 3. (a) Transport decision: app-hosted Streamable HTTP, not stdio

| | stdio server spawned by the CLI | Streamable HTTP server in the main process |
|---|---|---|
| Who runs the tool code | a **new process** (`process.execPath` + `ELECTRON_RUN_AS_NODE=1 <script>` or a plain node script) started by the CLI with the CLI's env and cwd | the Electron main process itself (`node:http` on `127.0.0.1`, port from `proc/freePort.ts`) |
| Reaching `ToolGate` / `RunCtx` / `McpReadClient` / `WaReadClient` / `BridgeDb` | impossible directly: they live in the main process -> the stdio server would need its own IPC back to the app (a named pipe or ... an HTTP server) - the HTTP design plus one process and a second `messages.db` connection | direct function call - the server IS the gate |
| Lifetime / cleanup | child of the CLI; on our hard kill (`TerminateProcess`, no signals on Windows) it is orphaned unless `taskkill /T` reaches it (we do that, but it is one more pid to reap) | `server.close()` in `finally`; no extra pid |
| Auth | implicit (pipe) - but the CLI passes its whole env; Antigravity `env` is per-entry | per-run 32-byte bearer token; Claude: `${WCA_MCP_TOKEN}` env expansion (token never on argv, never on disk); Antigravity (v2.1): literal header in an app-owned `.agents/mcp_config.json` |
| Supported by | both CLIs | both CLIs (Claude `type:"http"`; Antigravity `serverUrl`) |
| Attack surface | none on the network | a loopback listener for < 2 min per run, bearer-gated, Host-checked (SDK `enableDnsRebindingProtection` + `allowedHosts`), Origin-rejected by our handler |
| Packaging (A1 zero native addons) | fine | fine (`@modelcontextprotocol/sdk` 1.30.0 already pinned; `streamableHttp.js` present in `dist/esm/server/`) |

**Decision: Streamable HTTP, stateless mode (`sessionIdGenerator: undefined`), `enableJsonResponse: true`, one listener per run.** The stdio variant is kept only as the e2e/attacker seam (a fake CLI that speaks stdio to a fake server).

Exact shape (SDK 1.30.0; the `.d.ts` were read locally):

```ts
// src/main/mcp/toolServer.ts  (NEW; the only file that imports @modelcontextprotocol/sdk/server/*)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { freePort } from '../proc/freePort';

export interface ToolServerHandle { url: string; token: string; close(): Promise<void>; }

export async function startToolServer(run: { gate: ToolGate; ctx: RunCtx; specs: readonly ToolSpec[]; appVersion: string }): Promise<ToolServerHandle> {
  const token = randomBytes(32).toString('base64url');                       // 43 chars; S-RAND in tests
  const mcp = new McpServer({ name: 'wca', version: run.appVersion }, { capabilities: { tools: {} } });
  for (const spec of run.specs) {
    mcp.registerTool(spec.name, {
      description: spec.description,
      inputSchema: spec.args.shape,                                             // the SAME zod shape ToolGate parses with (ZodRawShapeCompat)
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (raw) => {
      const out = await run.gate.invoke({ id: randomUUID(), name: spec.name, input: raw as Record<string, unknown> }, run.ctx);
      return { content: [{ type: 'text', text: out.result.content }], isError: out.result.isError === true };
    });
  }
  const port = await freePort();                                                // NEVER_PORTS excluded
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,                                              // stateless: no session ids to leak or replay
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${port}`],                                        // EXACT match on the Host header incl. port (verified: `includes(hostHeader)`)
  });
  await mcp.connect(transport);
  const http = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => http.listen(port, '127.0.0.1', r));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Our checks run BEFORE the SDK's: a CLI never sends Origin, so any Origin is a browser => 403 (the SDK skips its
    // Origin check when allowedOrigins is empty - verified in webStandardStreamableHttp.js validateRequestHeaders).
    if (req.url !== '/mcp' || req.headers.origin !== undefined || !bearerOk(req.headers.authorization, token)) {
      res.statusCode = 404; res.end(); return;                                    // 404, not 401: no probing signal
    }
    await transport.handleRequest(req, res);                                    // the transport reads the body (cap it at 64 KiB upstream)
  }
  return { url: `http://127.0.0.1:${port}/mcp`, token, close: async () => { await mcp.close(); await new Promise<void>((r) => http.close(() => r())); } };
}
function bearerOk(h: string | undefined, token: string): boolean {
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7)); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Rules: `close()` runs in `finally` after the CLI exits or is killed; the port is re-picked per run; the token is never logged (it exists only in the child env / the Antigravity temp file); `http.requestTimeout` 5 s and a 64 KiB body cap; `Connection: close`. Test: `address().address === '127.0.0.1'`; `Host: evil.example:PORT` -> rejected by the transport; `Origin: http://x` -> 404 from our handler; wrong/absent token -> 404 and zero gate calls.

---

## 4. (b) ToolGate mapped onto the server

Nothing in `ToolGate.invoke()` changes semantically; what changes is who calls it and what "unknown tool" means.

| ARCH 5.3 step | v1 (provider returns `toolCalls`, `draft.ts` calls the gate) | v2 CLI (the CLI calls `tools/call`, the server calls the gate) |
|---|---|---|
| 1 name in READ table and exposed | case-sensitive match; strike + `tool_blocked` audit | the CLI can only name tools we listed; a hallucinated built-in (`Bash`, `Read`, `WebFetch`) is refused by the CLI itself and surfaces as a `permission_denials` entry / a `tool_use` block with a non-`mcp__wca__` name in stream-json -> the runner audits `tool_blocked {nameSha8,nameLen,verdict:'blocked_unknown_tool'}` and scores a strike exactly like v1 (2 strikes -> kill + `run_aborted` + `manipulation` badge) |
| 2 per-run budget | `ctx.calls[name]`, `ctx.totalCalls <= LIMITS.draftToolCalls` | identical - `RunCtx` is the same object; a call over budget gets `{"error":"tool not available"}` as an `isError` MCP result. Belt and braces: `--max-turns` caps the loop even if the model loops on errors |
| 3 app-built args | `z.strictObject` + `pinWindow` (calendar ids, zone, account from settings) | identical; the MCP `inputSchema` is the **same zod object**, so the SDK's pre-validation and the gate's parse cannot disagree; `wa_*` args are pinned to `ctx.chatId` / `ctx.handles` (WA report 4.4) |
| 4 READ facade | `McpReadClient` | identical for calendar; `WaReadClient` (WA report 4.3) for `wa_*` |
| 5 projection | `projectBusy` etc. | identical; the projected JSON is `content[0].text` |
| 6 nonce wrap | `wrapDataBlock(ctx.nonce, json)` | identical; `<<DATA-nonce>> ... <<END-DATA-nonce>>` around every tool result, so the S3 system prompt's "only text inside the nonce block is data" rule holds for tool output as well |

Two new gate concerns that exist only because of the CLI:
- **Argument echo.** Claude Code forwards `tool_use.input` verbatim into stream-json; the runner never logs those blocks (they are model output). Only `name`, `id` and our verdict are recorded.
- **Result size.** `MAX_MCP_OUTPUT_TOKENS` (25,000) is far above our projections (<= 500 busy blocks; `waResultChars` 4,000 per the WA report); the server can never emit more than ~16 KB per call.

---

## 5. (e) One tool-definition source for Local, Claude-CLI and Antigravity-CLI

Today `toolDefs.ts` has hand-written JSON and `toolGate.ts` has separate zod parsers; a third consumer (the MCP server, which wants a zod shape) would make three copies. Proposal:

```ts
// src/main/agent/toolDefs.ts  (v2 shape; compile-time constants; I4 purity test unchanged)
export interface ToolSpec<A extends z.ZodRawShape = z.ZodRawShape> {
  name: ReadToolName;                         // LLM-facing, underscores; MCP name identical; Claude sees mcp__wca__<name>
  backend: 'calendar' | 'whatsapp';
  description: string;
  args: z.ZodObject<A>;                       // ALWAYS z.strictObject
  maxCallsPerRun: number;
  exposedWhen: (env: { calendarConnected: boolean; waAvailable: boolean; waScope: 'trigger_chat' | 'all_chats' }) => boolean;
  /** Steps 3-5 for this tool: constrain+pin -> facade -> project. Returns null for bad args (=> blocked_bad_args). */
  execute: (parsed: z.infer<z.ZodObject<A>>, ctx: RunCtx, deps: ReadFacades) => Promise<unknown | null>;
}
export const READ_TOOLS = {
  get_current_time:       { backend: 'calendar', args: z.strictObject({}), maxCallsPerRun: 1, ... },
  get_freebusy:           { backend: 'calendar', args: z.strictObject({ timeMin: z.string(), timeMax: z.string() }), maxCallsPerRun: 3, ... },
  wa_get_chat_messages:   { backend: 'whatsapp', args: z.strictObject({ chat: z.string(), before_message: z.string().optional(), limit: z.number().int().optional() }), maxCallsPerRun: 2, ... },
  wa_search_messages:     { backend: 'whatsapp', args: z.strictObject({ query: z.string(), chat: z.string().optional(), limit: z.number().int().optional() }), maxCallsPerRun: 3, ... },
  wa_get_message_context: { backend: 'whatsapp', args: z.strictObject({ message: z.string(), before: z.number().int().optional(), after: z.number().int().optional() }), maxCallsPerRun: 2, ... },
  wa_list_chats:          { backend: 'whatsapp', args: z.strictObject({ limit: z.number().int().optional() }), maxCallsPerRun: 1, exposedWhen: e => e.waAvailable && e.waScope === 'all_chats', ... },
} as const satisfies Record<string, ToolSpec>;

/** LLM-facing LCD JSON, derived ONCE at module load and frozen by toolDefs.test.ts against the v1 literal for the two calendar tools. */
export function llmToolOf(spec: ToolSpec): LlmTool {
  const json = z.toJSONSchema(spec.args, { target: 'draft-07' });   // zod 4.6.5: target is "draft-07" (NOT "draft-7"); verified in to-json-schema.d.ts
  return { name: spec.name, description: spec.description, inputSchema: toLcd(json) };
}
```

Verified locally (`node -e` against zod 4.6.5) what `z.toJSONSchema` emits, and therefore what `toLcd()` must do:
- `z.strictObject({timeMin: z.string(), timeMax: z.string()})` -> `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{...},"required":["timeMin","timeMax"],"additionalProperties":false}` => strip `$schema`; the rest is already the v1 literal.
- `z.strictObject({})` -> `{"$schema":...,"type":"object","properties":{},"additionalProperties":false}` - **no `required` key** => `toLcd()` adds `required: []` (the v1 `EMPTY_SCHEMA` literal has it).
- `z.number().int().min(1).max(20)` -> `{"type":"integer","minimum":1,"maximum":20}` => `minimum`/`maximum` are **outside the LCD**. Decision for the design ticket: keep the v1 LCD and put ranges in the `description` + validate in `execute` (the WA report already specifies "1-20, default 12" in descriptions and clamps in the gate) - so the `args` shapes use plain `z.number().int().optional()` and `toLcd()` **throws** on any non-LCD keyword (a purity/compile-time test catches a future `.min()`).
- `.optional()` simply drops the key from `required` - fine.

Consumers:
- Local provider: `toWireTools(gate.exposedTools())` unchanged (the derived JSON is the same LCD subset).
- API-key Claude/Gemini providers: unchanged (`input_schema` / function declarations from the same `LlmTool`).
- Claude CLI provider: `startToolServer({ specs: gate.exposedSpecs() })` registers `spec.args.shape` (`registerTool<..., InputArgs extends ZodRawShapeCompat | AnySchema>` - verified in `server/mcp.d.ts` line 150).
- Antigravity provider (no-tools mode): does not register tools; it calls `gate.prefetch*()` (the existing `prefetchFreeBusy` plus a new `prefetchWaContext` that runs `wa_get_chat_messages` for `chat_1` through the same `execute`, budget-free like `prefetchFreeBusy`) and inlines the projections in the nonce block, so the *same* `execute` code serves all three backends.
- `toolDefs.test.ts` gains: (1) byte-identical JSON for `get_current_time` / `get_freebusy` vs the v1 literal; (2) every `args` is strict (`additionalProperties:false` after derivation); (3) every derived schema passes an LCD validator (no `$schema`, `$ref`, `anyOf`, type arrays, `minimum`, `maximum`, `minLength`, `maxLength`).

---

## 6. (c) Guaranteeing the CLI cannot reach anything else

### 6.1 Claude Code - the exact invocation (run profile S3; S1 and V1 in the table below)

```ts
// src/main/llm/cli/claudeCli.ts  -> buildClaudeArgs(run)   (pure; tested like buildMcpSpawnSpec)
const args = [
  '-p',                                   // prompt on stdin (section 7.1)
  '--restricted',                         // no Bash/PowerShell/REPL/WebFetch; user/project/local settings IGNORED; bypassPermissions refused
  '--strict-mcp-config',
  '--mcp-config', JSON.stringify({ mcpServers: { wca: { type: 'http', url: run.server.url,
                                    headers: { Authorization: 'Bearer ${WCA_MCP_TOKEN}' } } } }),   // token via env expansion, NOT argv
  '--tools', '',                          // ZERO built-in tools (Read/Glob/Grep/Edit/Web*/Agent/...)
  '--allowedTools', 'mcp__wca__*',        // literal server prefix + glob = the only allow-glob form Claude Code accepts
  '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate',
                                          // belt for the braces: bare names remove tools from context even if --tools "" semantics drift
  '--permission-mode', 'dontAsk',         // anything that would prompt is denied (there is no prompt host anyway)
  ...(version >= [2,1,259] ? ['--permission-prompts', 'none'] : []),
  '--disable-slash-commands',             // no skills / custom commands
  '--no-session-persistence',             // nothing written under ~/.claude/projects
  '--system-prompt', run.systemPrompt,    // VERBATIM PIPELINE 4.3 / 6.5 text; replaces Claude Code's coding prompt entirely
  '--model', run.model, '--effort', 'low',
  '--max-turns', String(run.maxTurns),    // works on 2.1.258 although absent from --help (issue #16963)
  '--output-format', 'stream-json', '--verbose',
  ...(run.jsonSchema ? ['--json-schema', JSON.stringify(run.jsonSchema)] : []),
];
```

| Run profile | MCP server | `--tools` | `--allowedTools` | `--max-turns` | `--json-schema` | Notes |
|---|---|---|---|---|---|---|
| **S1 extract** | none (still `--strict-mcp-config`, so nothing else loads) | `""` | - | 1 | S1 schema | `structured_output` -> existing zod validation |
| **S3 draft** | `wca` (calendar + `wa_*` per `exposedSpecs()`) | `""` | `mcp__wca__*` | `LIMITS.draftTurnsWithTools + 1` | none (text) or a `{reply}` schema | text -> `cleanDraft()` -> S4 |
| **V1 read-image** (image-events research) | none | `Read` | `Read` | 3 | V1 schema | cwd holds exactly one normalised JPEG; `--restricted` confines `Read` to it |

Env (allow-list, like `buildMcpEnv`; a test asserts the key set literally): `SystemRoot`, `PATH` (`%SystemRoot%\System32` only), `TEMP`/`TMP` (the run dir), `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA` (Claude Code needs its config + OAuth credentials under `%USERPROFILE%\.claude`), `WCA_MCP_TOKEN`, `MCP_TIMEOUT=10000`, `MCP_TOOL_TIMEOUT=25000`, `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_AUTOUPDATER=1`, `DISABLE_BUG_COMMAND=1`, `CI=1`. **Never**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, the bridge token, the doorbell secret, the llama key.

cwd: a fresh empty directory `<userData>\cli-runs\<runId>\` (deleted in `finally`). With `--restricted` the user's `~/.claude/settings.json` hooks/permissions are ignored, and an empty cwd has no `.mcp.json`, `.claude/`, `CLAUDE.md` to pick up. `--add-dir` is never passed. (`--setting-sources user` / `disabledMcpjsonServers` are the documented alternatives when `--restricted` is unavailable; not needed at 2.1.258.)

Spawn: `spawn(claudeExePath, args, { cwd, env, stdio: ['pipe','pipe','pipe'], windowsHide: true, shell: false })`. **`shell:false` is mandatory** (CVE-2024-27980: Node >= 18.20.2 refuses `.cmd`/`.bat` without `shell:true`, and `shell:true` reintroduces argument injection). Executable discovery: settings override (must end in `claude.exe`) -> `%USERPROFILE%\.local\bin\claude.exe` -> `where.exe claude` entries ending in `.exe` -> a `.cmd` entry is resolved to `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe` - never the `.cmd` itself. `validate()` runs `claude --version` (no login involved), requires **>= 2.1.221**; `claude auth status --json` (`loggedIn` boolean, other fields UNVERIFIED) is used only for the settings-page pill, never more than once a minute.

### 6.2 Antigravity CLI - v2 no-tools mode, and the v2.1 MCP variant

**v2 (ships):** no MCP server, no tools. Per run the app writes `<runDir>\.agents\agents\wca-<stage>.md`:

```md
---
name: wca-draft
description: Drafts one WhatsApp reply from app-provided context. Returns text only.
tools: []
commandExecutionPolicy: off
model: inherit
mainAgent: true
subagent: false
---
<SYSTEM_PROMPT_DRAFT verbatim>
```

and runs `agy.exe --agent wca-draft --model <slug> --effort low --output-format stream-json --print-timeout 2m [--json-schema <file>] -p "<user message with the nonce block, free/busy AND the prefetched wa_get_chat_messages projection inlined as app-computed>"` with `cwd = <runDir>` (an app-owned folder that the setup wizard, with the user's click, added to `trustedWorkspaces` - the trust dialog hangs headless runs otherwise, `gemini-cli-backend` 5.4), `stdin: 'ignore'`, env allow-list + `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Requires **>= 1.2.11** (`--agent` in headless). The runner asserts `init.tools` is empty (or contains only the documented read-only file tools if the CLI injects them - record the observed set in the first smoke run, U4) and `init.agent === 'wca-draft'`; `WAITING` status = the agent tried to use a tool = bug in our agent file => `LLM_BAD_OUTPUT`, never a retry with permissions.

Why the user's global `~/.gemini/config/mcp_config.json` (which on this machine registers the reference `whatsapp` MCP with `send_message`) is harmless in this mode: the agent's `tools: []` allow-list means the planner has nothing to call; and even a misbehaving planner would be soft-denied (Ask mode, no prompt host). The privacy cost that remains: `agy` persists the conversation (role-labelled, sanitised text) under `~/.gemini/antigravity-cli/brain/...` - the `cloud_antigravity_cli` consent text says so (U5).

**v2.1 (only after #548 and #916 are closed on the installed version):** `<runDir>\.agents\mcp_config.json` = `{"mcpServers":{"wca":{"serverUrl":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token literal>"}}}}` (user-only ACL of `%LOCALAPPDATA%`, deleted in `finally`); the wizard merges, with a shown diff and the user's click, into `~/.gemini/antigravity-cli/settings.json`: `"toolPermission":"strict"`, `"allowNonWorkspaceAccess":"off"`, `"enableTelemetry":"off"`, `"permissions":{"allow":["mcp(wca/*)"],"deny":["command(*)","unsandboxed(*)","write_file(*)","read_url(*)","execute_url(*)"]}` (exact `mcp(server/tool)` form per #916; deny > ask > allow); agent frontmatter `tools:` lists the `wca` tool names (form UNVERIFIED U4); `--sandbox`; still never `--dangerously-skip-permissions`. The user's other global MCP servers still *load* (no strict flag) but cannot execute (Ask + no host); the init check turns "extra servers present" into a warning badge + audit `cli_extra_servers {count}`.

### 6.3 The runtime proof: assert the init event, fail closed

Both CLIs emit an init event first in stream-json. Before forwarding anything, the runner parses it and aborts the run with the existing audit kind `toolset_mismatch` (new `ErrorCode CLI_TOOLSET_MISMATCH`) unless:
- Claude: `mcp_servers` is exactly `[{name:'wca', status:'connected'|'pending'}]` (S3) or `[]` (S1/V1); `mcp_server_errors` absent; `plugins` empty; `tools` is a subset of `{mcp__wca__<our names>} ∪ {Read}` (V1 only) ∪ the CLI's structured-output internals (record the observed set in the first smoke run and pin it - U2); `apiKeySource` is the OAuth value, not an API key (literal UNVERIFIED U9).
- Antigravity: `init.agent` is ours, `init.tools` is empty (v2) or exactly the allowed set (v2.1), `init.permission_mode === 'request-review'` (never `always-proceed`).

This is the same fail-closed idea as `McpHost.start()`'s `verifyToolset()`, and it is the only guarantee that survives a CLI auto-update silently changing a flag's meaning (the docs already announce that `--bare` may become the `-p` default).

---

## 7. (d) The per-run contract

### 7.1 Prompt and data boundaries - identical to v1

- System prompt: the verbatim S1 / S3 constants (`agent/prompt.ts`). Claude: `--system-prompt` (argv; the constants are < 8 KB, well under the ~32 k Windows limit; `--system-prompt-file` in the run dir is the fallback if a future prompt grows). Antigravity: the agent file body.
- User message: `buildContext()` output unchanged - `<<DATA-nonce>> ... <<END-DATA-nonce>>` around the minimised, sanitised window + tables (+ inlined prefetch projections for Antigravity). Delivered on **stdin** for Claude (`-p` reads piped stdin; 10 MB cap; argv would be unsafe for the 6,000-char window + tables); Antigravity: `-p "<text>"` positional (stdin `ignore`; our prompt is < 32 k chars; `--input-format stream-json` is the fallback if a prompt ever exceeds that).
- Tool results: nonce-wrapped by the server (section 4).
- Output: Claude `result.structured_output` (S1/V1) or `result.result` (S3 text) -> the existing zod validation / `cleanDraft()`; Antigravity `structured_output` / `response`. `is_error`, `subtype !== 'success'`, `stop_reason === 'refusal'` or a missing `structured_output` -> `LLM_BAD_OUTPUT` exactly as a bad API response today; the S1 "repair" retry spawns a second run.
- Nothing from the CLI's stderr is logged raw: the `stderrMarkersOf` redactor pattern of `mcp/host.ts` with CLI-specific markers (`authentication_failed`, `rate_limit`, `overloaded`, `model_not_found`, `quota`, `agy_error`).

### 7.2 Timeouts, abort, concurrency

- Wall clock: a CLI run adds 2-8 s of startup and the MCP wait; new `LIMITS.cliWallClockMs = 120_000` for S3 and `60_000` for S1/V1 (the API-key cloud path keeps `draftWallClockCloudMs = 60_000`). `AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)])` exactly like `draft.ts`. Antigravity additionally gets `--print-timeout` = wall clock - 10 s (since 1.2.6 the CLI has no default timeout).
- Abort = kill: on abort `child.kill()` (TerminateProcess), then after `DEFAULT_GRACE_MS` (3 s; 500 ms is enough for a CLI, make it a runner constant) `spawn('taskkill', taskkillArgs(pid, true), { windowsHide: true, shell: false })` - the v1 supervisor primitive, reused. With the HTTP transport the CLI has no MCP child of ours to orphan; `/T` still covers the CLI's own helpers (Antigravity 1.2.9 notes headless runs used to leave daemon processes). Then `server.close()`, delete the run dir. The Claude session is not persisted; the Antigravity conversation is (U5).
- Concurrency **1**: a single `CliRunner` with a promise mutex; the orchestrator already serialises runs through `agent/queue.ts`, and one listener + one child at a time keeps the loopback surface minimal and the audit unambiguous. A second caller waits; it never starts a second child. Both vendors' quotas are per account, so parallel runs only burn the window faster.
- Idle CLI: none - the process exists only for the run (no warm pool; cold start is the price of the subscription route; a warm `--input-format stream-json` session would share one context across chats and break I5).
- Orphans after an app crash: the run pid goes into the supervisor's pid-file scheme (`reaper.ts` matches pid + exe path + creation time) so `claude.exe` / `agy.exe` started by us are reaped on next start and **never by image name** (the user runs Claude Code interactively on this machine).

### 7.3 Audit - like v1's rows

| Event | Row |
|---|---|
| CLI run start/end | NEW `AuditKind 'cli_run'`, ref = itemId, detail `{provider:'claude_cli'|'antigravity_cli', runId, stage, exitCode, subtype, numTurns, toolCalls, blockedCalls, durationMs, initOk:boolean, killed:boolean, usingOverage:boolean|null}` - numbers, enums and booleans only |
| Tool executed through the server | counted on the `runs` row (`toolCalls`) exactly as `draft.ts` counts `executed` today; no per-call audit row (v1 has none) |
| Tool refused by the gate (budget / args / not exposed) | `tool_blocked {nameSha8,nameLen,verdict,runId}` - written by `ToolGate.invoke` itself, unchanged |
| Tool the CLI refused (a non-`mcp__wca__` name in a `tool_use` block, or a `permission_denials` entry) | `tool_blocked {..., verdict:'blocked_unknown_tool'}` written by the runner from the stream, +1 strike; 2 strikes -> kill + `run_aborted` + `manipulation` badge |
| init check failed | `toolset_mismatch {provider, reason:'extra_server'|'extra_tool'|'missing_server'|'server_error'|'api_key_auth'|'agent_mismatch'}` |
| Rate limit / quota signal | `cli_run.usingOverage` (Claude `rate_limit_event.isUsingOverage`); the runs row `errorCode` `CLOUD_QUOTA` with `resetsAt` in `params` |

The runner never stores tool `input`, `result` text, the prompt, stderr text or the token.

---

## 8. Provider abstraction changes (contract-level, for the design ticket)

```ts
// src/main/llm/types.ts  (additions; v1 members untouched)
export interface AgenticRunInput { system: string; user: string; specs: readonly ToolSpec[]; ctx: RunCtx; gate: ToolGate; maxTurns: number; jsonSchema?: JsonSchemaLcd; }
export interface AgenticRunResult { text: string; structured?: unknown; toolCalls: number; blockedCalls: number; stopReason: 'end'|'max_turns'|'aborted'|'killed'|'bad_output'; usage?: LlmUsage; }
export interface LlmProvider {
  readonly id: ProviderId;                 // + 'claude_cli' | 'antigravity_cli'
  readonly model: string;
  readonly loop: 'turn' | 'agentic' | 'prefetch';   // turn = v1 (draft.ts owns the loop); agentic = Claude CLI (server is the gate); prefetch = Antigravity v2 (app runs the tools first)
  structured<T>(...): Promise<T>;          // CLI: one run, --json-schema, no MCP server, --max-turns 1
  chat(...): Promise<LlmResponse>;         // CLI: throws LlmError('unsupported') - draft.ts branches on `loop`
  runAgentic?(input: AgenticRunInput, opts: CallOpts): Promise<AgenticRunResult>;
  validate(signal): ...;                   // CLI: exe found + version >= min ; NO login probe
  dispose(): Promise<void>;                // CLI: kill any in-flight child
}
```

- `draft.ts`: `if (provider.loop === 'agentic') return runAgenticDraft(...)`; `if (provider.loop === 'prefetch') { busy/wa = gate.prefetch*(); one no-tool completion }` - same `DraftOutcome`, same `cleanDraft`, same `manipulation` rule.
- `factory.ts`: `SECRET_FOR` has no entry for the CLI ids; consent kinds `cloud_claude_cli` / `cloud_antigravity_cli` (new rows; the text names the vendor subscription, the policy caveat and, for Antigravity, the on-disk transcript); `usable()` checks `cliLocator.find(id)` and the version floor.
- `ProviderId` gains the two ids; the settings page shows "Claude (your subscription, via Claude Code)" / "Gemini (your subscription, via Antigravity - experimental)" above the API-key variants, which move under "Advanced".
- Model lists: Claude CLI accepts aliases (`sonnet`, `haiku`, `opus`, `fable`) or full ids; default `sonnet` for S1/S3 (Opus is the plan default and burns the 5-hour window; `claude-cli-backend` 2.3). Antigravity: `--model <slug>` exits non-zero if unknown and **silently downgrades** known-but-unavailable models (#687) -> pin a Flash slug the plan surely has (`gemini-3.8-flash-high`), list from `agy models` at settings time (U7).

---

## 9. Sequence diagram (S3 draft run, Claude CLI)

```mermaid
sequenceDiagram
  autonumber
  participant O as orchestrator / draft.ts
  participant G as ToolGate (RunCtx, budgets, handles)
  participant S as McpToolServer (127.0.0.1:port, bearer)
  participant R as CliRunner (spawn, stream-json, kill)
  participant C as claude.exe -p (user's subscription)
  participant A as Anthropic API (CLI's own OAuth)

  O->>G: exposedSpecs() -> [get_current_time, get_freebusy, wa_get_chat_messages, wa_search_messages, wa_get_message_context]
  O->>S: startToolServer({gate, ctx, specs}) -> {url, token}
  O->>R: run({args(url), env(WCA_MCP_TOKEN=token), cwd=<runDir>, stdin=userMessage, wallClock=120s})
  R->>C: spawn (shell:false, windowsHide) ; write stdin ; close stdin
  C->>S: POST /mcp initialize, tools/list  (Authorization: Bearer token, Host: 127.0.0.1:port)
  S-->>C: tools = the 5 registered (readOnlyHint:true)
  C-->>R: system/init {mcp_servers:[{wca,connected}], tools:[mcp__wca__*], plugins:[]}
  R->>R: assert init (fail closed -> kill + toolset_mismatch)
  C->>A: messages.create (system = verbatim S3, user = <<DATA-nonce>>...)
  A-->>C: tool_use mcp__wca__get_freebusy {timeMin,timeMax}
  C-->>R: assistant {tool_use}  -> R counts; audits only non-wca names (strike)
  C->>S: POST /mcp tools/call get_freebusy
  S->>G: invoke({name:'get_freebusy', input}, ctx)  (budget, strict args, pinWindow, McpReadClient, projectBusy, nonce wrap)
  G-->>S: {content:"<<DATA-nonce>>[...]<<END-DATA-nonce>>", isError:false}
  S-->>C: CallToolResult
  C->>A: ... (<= --max-turns)
  A-->>C: final text
  C-->>R: result {subtype:'success', is_error:false, result:text, usage, permission_denials:[]}
  R-->>O: AgenticRunResult {text, toolCalls, blockedCalls, usage}
  O->>S: close()  ; delete runDir ; audit cli_run
  O->>O: cleanDraft(text) -> S4 validate -> proposal (unchanged)
  Note over R,C: abort/timeout: child.kill() -> taskkill /PID /T /F -> close() -> cli_run{killed:true}
```

Antigravity (v2, no tools): `orchestrator -> gate.prefetchFreeBusy + gate.prefetchWaContext -> buildContext(inlined) -> CliRunner.spawn(agy --agent wca-draft ... -p) -> [init check: tools == []] -> result -> cleanDraft -> S4`.

ASCII fallback of the Claude flow for the spec files: `orchestrator -> ToolGate.exposedSpecs -> McpToolServer.start -> CliRunner.spawn(claude -p ...) -> [init check] -> (CLI <-> API turns; each tools/call -> ToolGate.invoke -> facade -> projection -> nonce) -> result -> close server -> cleanDraft -> S4`.

---

## 10. Recommended architecture (summary for the design ticket)

New files (all under `src/main`, zero native addons):
- `mcp/toolServer.ts` - `startToolServer()` (section 3); the only importer of `@modelcontextprotocol/sdk/server/*`; ESLint boundary: may import `agent/toolGate` types and `proc/freePort`, never `mcp/host`, `mcp/writeClient`, `bridge/sendClient`, `exec/**`, `llm/**`.
- `llm/cli/locator.ts` - finds `claude.exe` / `agy.exe`, validates version floors (2.1.221 / 1.2.11), refuses `.cmd`.
- `llm/cli/runner.ts` - `CliRunner` (mutex, spawn, stdin, stream-json parser tolerant of unknown events, init assertion, kill via `taskkillArgs`, run-dir lifecycle, audit).
- `llm/cli/claudeCli.ts`, `llm/cli/antigravityCli.ts` - `LlmProvider` implementations (`loop:'agentic'` / `'prefetch'`); pure `buildArgs()` / `buildEnv()` / `buildAgentFile()` for tests.
- `agent/toolDefs.ts` (zod-first table, section 5), `agent/toolGate.ts` (generic `execute` dispatch + `prefetchWaContext`; budgets/strikes/nonce unchanged), `bridge/waReadClient.ts` + `agent/waTools.ts` + `agent/handles.ts` (WA report sections 4-5).

Tests to add (mirroring v1's security project): env allow-list literal for both CLIs; Claude args contain `--restricted --strict-mcp-config --tools ""` and never `--bare` / `--dangerously-skip-permissions` / `bypassPermissions` / `--add-dir`; token never in argv; Antigravity args never contain `--dangerously-skip-permissions` and the agent file has `tools: []`; init-mismatch aborts (both vendors); unknown `tool_use` name -> `tool_blocked` + strike; over-budget call -> `isError`; bearer mismatch / Origin present -> 404 and no gate call; Host mismatch -> transport rejection; kill path calls `taskkill /PID /T /F`; run dir removed; the I4 purity test on the derived schemas; the LCD validator on every derived schema; e2e with a fake `claude.exe` (a node script that reads `--mcp-config`, connects with the SDK `Client` + `StreamableHTTPClientTransport`, calls one `wa_*` tool and one forbidden name, prints canned stream-json) and a fake `agy.exe` (prints `init` + `result`) - the same "scripted attacker" idea as v1's attacker provider.

Decisions the orchestrator must record ([V2+]): `PROVIDER_IDS` + 2; `CONSENT_KINDS` + 2; `AUDIT_KINDS` + `cli_run`; `LIMITS.cliWallClockMs`; `ErrorCode CLI_TOOLSET_MISMATCH`, `CLI_NOT_INSTALLED`, `CLI_VERSION`, `CLOUD_QUOTA` params; `LlmProvider.loop` + `runAgentic`; MCP server name `wca`; Antigravity = no-tools in v2 (MCP variant gated on #548/#916); auto mode allowed with `claude_cli`, with `antigravity_cli` only when `init.tools` asserts empty.

---

## 11. Rejected alternatives (do not reintroduce without a decision)

| Idea | Why not |
|---|---|
| `--bare` for isolation | never reads OAuth -> no subscription (verified help text and headless docs) |
| Claude Agent SDK in-process `createSdkMcpServer` | +200 MB native binary or a second discovery path; Claude-only; same policy; no benefit over HTTP + stream-json |
| stdio server spawned by the CLI | a second process that still needs IPC to the main process; orphan risk on hard kill; second `messages.db` connection |
| Long-lived CLI session with `--input-format stream-json` (warm process) | shares one context across chats (breaks I5), keeps a listener open, complicates kill/audit; cold start is cheap enough |
| `claude setup-token` + `@anthropic-ai/sdk` | precisely the prohibited "OAuth token in another product" |
| `--dangerously-skip-permissions` / `bypassPermissions` | removes the CLI-side deny of everything not ours; `--restricted` refuses it anyway; on Antigravity it would also approve the user's global `whatsapp` MCP `send_message` |
| Gemini CLI for the subscription | retired for free/Pro/Ultra on 2026-06-18 |
| MCP tools through Antigravity in v2 | #548 (headless ignores `permissions.allow`, hangs past `--print-timeout`) and #916 (silent grant mismatch) are open; no strict-mcp equivalent |
| Editing `~/.gemini/antigravity-cli/settings.json` silently | it is the user's file; the wizard shows the diff and asks |
| Bundling either CLI | Anthropic legal page requires Commercial Terms for preinstalling; Antigravity is closed-source with daily releases and a self-updater |

---

## 12. UNVERIFIED register and the manual checks that close it

| # | Claim | Status | How to verify (the user runs it, never an agent; no login used except where stated) |
|---|---|---|---|
| U1 | `--max-turns` works on 2.1.258 | **CLOSED** (exists, hidden from `--help`; issue #16963; docs list it) | - |
| U2 | With `--tools ""` + `ENABLE_TOOL_SEARCH=false`, the `mcp__wca__*` names appear in `system/init.tools` and nothing else does (plus which structured-output internals appear) | open | one S3 smoke run against the real tool server with the user's login; pin the observed `tools` set |
| U3 | SDK `allowedHosts` matches `Host` including the port | **CLOSED** (`validateRequestHeaders`: `this._allowedHosts.includes(hostHeader)` - exact string; list `127.0.0.1:<port>`); also: `allowedOrigins: []` **skips** the Origin check, so our handler rejects Origin itself | - |
| U4 | Antigravity `init.tools` content in no-tools mode; `--agent` + `-p` on >= 1.2.11 honours `tools: []`; MCP tool name form in `tools:` (v2.1) | open | user-run `agy -p --agent wca-draft --output-format stream-json --print-timeout 1m` in the trusted run dir; inspect `init` |
| U5 | Antigravity persists the headless conversation and whether a flag/setting disables it | open | docs + user-run smoke; if not disableable, the consent text says the CLI stores the (minimised) prompt locally |
| U6 | Location of the user's `agy.exe` (absent from `%LOCALAPPDATA%\agy\bin` and PATH on 2026-09-28) | open | treat "not installed" as the normal first state; `where.exe agy` in a fresh PowerShell after the user re-installs |
| U7 | Antigravity quota / auth error shapes (`AGY_ERROR` JSON fields, exit 3) and accepted `--model` slugs | open | user-run smoke; regex-based mapping, fail to `LLM_BAD_OUTPUT` otherwise |
| U8 | Stream-json event schema stability across CLI auto-updates | open (mitigated) | pin minimum versions, assert `init.capabilities`, tolerant parser (unknown event types ignored; `result` required) |
| U9 | `system/init.apiKeySource` literal for subscription OAuth (to assert "not an API key") | open | read it in the U2 smoke run; until then the env allow-list is the guarantee |
| U10 | `z.toJSONSchema` output shape for strict objects / empty objects / int ranges | **CLOSED** (verified locally; section 5) | - |
| U11 | Windows Defender firewall prompt for a `node:http` loopback listener in the packaged app | open | v1 already listens on loopback for llama-server and the calendar child without a prompt; confirm once in the packaged smoke |

---

## 13. Sources

- Installed `claude.exe --help` / `--version` (2.1.258), read locally 2026-09-28 (`%USERPROFILE%\.local\bin\claude.exe`, 218 MB native build).
- Installed `@modelcontextprotocol/sdk@1.30.0`: `dist/esm/server/{mcp,streamableHttp,webStandardStreamableHttp}.d.ts` and `webStandardStreamableHttp.js` (`validateRequestHeaders`, lines 139-160); `zod@4.6.5` `v4/core/to-json-schema.d.ts` (target union) and a `node -e` run of `z.toJSONSchema`.
- https://code.claude.com/docs/en/cli-reference - print-mode flags incl. `--max-turns`, `--permission-prompts` (>= 2.1.259), `--tools`, `--disallowedTools` semantics, `--json-schema`, `--no-session-persistence`, `--bare`.
- https://code.claude.com/docs/en/headless - `--bare` never reads OAuth and "will become the default for `-p`", `system/init` fields (`mcp_servers`, `mcp_server_errors`, `plugins`, `capabilities`), `api_retry.error` categories, stdin cap, SIGTERM/143, `dontAsk`, `--permission-prompts none`, MCP wait (>= 2.1.221).
- https://code.claude.com/docs/en/mcp - HTTP config shape, `${VAR}` expansion + blocked names, `--strict-mcp-config` (and the 2.1.246 approval note), `mcp__server__tool`, `MCP_TIMEOUT` / `MCP_TOOL_TIMEOUT` / `MAX_MCP_OUTPUT_TOKENS` / `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, tool search default (>= 2.1.221) and `ENABLE_TOOL_SEARCH=false`.
- https://code.claude.com/docs/en/permissions - allow-glob rule "only after a literal `mcp__<server>__` prefix", deny globs `"*"` / `"mcp__*"`, bare-name deny removes the tool, "What runs before you trust a folder" (`--setting-sources user`, `disabledMcpjsonServers`).
- https://code.claude.com/docs/en/env-vars - `ANTHROPIC_API_KEY` "always used when present" in `-p`, `CLAUDE_CONFIG_DIR`, presence-based `DISABLE_*` switches, `ENABLE_TOOL_SEARCH`, MCP timeouts.
- https://github.com/anthropics/claude-code/issues/16963 - `--max-turns` undocumented in `--help`; September 2026 changelog fix for turns ignoring `--max-turns`.
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan - the 2026-06-15 "paused" note (re-read 2026-09-28).
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ ; https://github.com/google-gemini/gemini-cli/discussions/27274 - 2026-06-18 cut-off, `agy`, API-key exception.
- https://antigravity.google/docs/cli/headless/ - flags, JSON envelope, stream-json `init` / `step_update` / `result` shapes, exit codes, cached-credential auth, soft-deny; https://antigravity.google/docs/mcp?tab=cli - `serverUrl` + `headers`, file locations, `disabledTools`, Ask mode; https://antigravity.google/docs/permissions?tab=cli - `mcp(server/tool)` rules, deny > ask > allow, global-file-only for the CLI; https://antigravity.google/docs/subagents/ - agent file locations and frontmatter (`tools: []`, `commandExecutionPolicy`).
- https://github.com/google-antigravity/antigravity-cli/releases - 1.2.12 (2026-09-27); 1.2.11 `--agent` in headless; 1.2.10 / 1.2.6 exit code 3 and no default timeout; 1.2.9 orphaned daemons.
- https://github.com/google-antigravity/antigravity-cli/issues/548 (open; headless ignores `permissions.allow`, hangs) ; https://github.com/google-antigravity/antigravity-cli/issues/916 (open; `mcp(<target>)` vs `mcp(server/tool)` silent mismatch).
- https://discuss.ai.google.dev/t/is-external-orchestration-of-antigravity-cli-headless-mode-supported-with-account-based-usage/183051 - Google staff (2026-09-15) on local child-process use; thread 184829 (2026-09-25) as quoted in `v2-gemini-cli-backend.md`.
- https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 - CVE-2024-27980, `.cmd` spawn without `shell:true`.
- https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-w48q-cv73-mx4w - DNS-rebinding protection off by default before SDK 1.24.
- Project files: `src/main/agent/{toolGate,toolDefs,draft,contextBuilder,prompt}.ts`, `src/main/mcp/{host,readClient,projection,writeClient,adminClient}.ts`, `src/main/llm/{types,factory,claude,gemini,local}.ts`, `src/main/proc/{supervisor,freePort}.ts`, `src/shared/{types,settings}.ts`, `docs/research/v2-{claude-cli-backend,gemini-cli-backend,whatsapp-mcp-readonly}.md`, `ops/agent-notes/v2-research-digest.md`, `ops/CONTEXT.md`, `ops/DECISIONS.md` D-036..D-041.
