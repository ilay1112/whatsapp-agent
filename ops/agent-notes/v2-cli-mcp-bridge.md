# Agent notes: v2-cli-mcp-bridge (research 2026-09-27, retried and revised 2026-09-28)

Deliverable: `docs/research/v2-cli-mcp-bridge.md` (rewritten on the retry; the first run's StructuredOutput never reached the harness).

## What I did on the retry
- Re-read the v1 seam (`toolGate.ts`, `toolDefs.ts`, `draft.ts`, `contextBuilder.ts`, `prompt.ts`, `mcp/*.ts`, `llm/*.ts`, `proc/supervisor.ts`, `shared/{types,settings}.ts`) and the three sibling v2 reports plus the orchestrator's research digest.
- Local checks, no login: `claude.exe --help` 2.1.258 (full text, grep for every flag the design uses); `@modelcontextprotocol/sdk@1.30.0` server `.d.ts` + `webStandardStreamableHttp.js` (Host/Origin validation code); `zod@4.6.5` `toJSONSchema` target union and a `node -e` run on the exact strict shapes; `%LOCALAPPDATA%\agy\bin` and `where.exe agy` (absent).
- Web (fetched 2026-09-28): Claude Code cli-reference / mcp / headless / permissions / env-vars; issue #16963; the help-center "paused" note; Antigravity headless / mcp / permissions / subagents docs; antigravity-cli releases, issues #548 and #916; forum thread 183051.

## What changed vs the first draft
- U1 closed: `--max-turns` works but is hidden from `--help` (issue #16963).
- U3 closed: SDK `allowedHosts` is an exact `includes(hostHeader)` (list `127.0.0.1:<port>`); `allowedOrigins: []` skips the Origin check, so our handler must reject any Origin itself. Code sample fixed.
- U10 closed: zod target is `"draft-07"` (not `'draft-7'`); output carries `$schema`, omits `required` on empty objects, emits `minimum/maximum` for `.min()/.max()` -> `toLcd()` strips/adds/throws accordingly; ranges go to descriptions + `execute`.
- Antigravity: switched v2 to **no-tools mode** (agent file `tools: []`, app prefetches through ToolGate and inlines) to match `v2-gemini-cli-backend.md`, because #548 and #916 are still open and there is no strict-mcp / tools-off flag; MCP-to-agy kept as the v2.1 variant with the exact `mcp(wca/*)` recipe.
- Added the reconciliation table (0.1): Gemini CLI section of the WA report superseded by Antigravity; MCP server name `wca`; inline `--mcp-config` JSON with `${WCA_MCP_TOKEN}` instead of a temp file for Claude; per-run listener instead of a long-lived registry; auto-mode Q5 answered (Claude CLI ok via `--tools ""` + init assertion; Antigravity only with `init.tools` asserted empty).
- Added run profiles (S1 / S3 / V1 read-image) so the image-events `--tools Read` run has a place in the same runner; `ENABLE_TOOL_SEARCH=false` in the env allow-list; `--permission-prompts none` version-gated (>= 2.1.259; installed is 2.1.258).

## Dead ends / assumptions
- Did not run either CLI with the user's login (hard rule 2). Eight items remain UNVERIFIED (section 12), all closable by one user-run smoke per vendor; U2 (init.tools with tool search off) and U4 (agy init.tools in no-tools mode) are the ones that can change the design.
- `claude auth status --json` field names beyond `loggedIn` and `system/init.apiKeySource` literals are still unverified; the env allow-list (no `ANTHROPIC_API_KEY`) is the guarantee until then.
- The WA report's `ToolSessionRegistry` (long-lived listener) and my per-run listener are interchangeable; I recommended per-run for lifetime simplicity and said so.

## Hand-off
- Design ticket decisions listed in report section 10 (PROVIDER_IDS/CONSENT_KINDS/AUDIT_KINDS additions, `LIMITS.cliWallClockMs`, error codes, `LlmProvider.loop`, server name `wca`, Antigravity no-tools in v2, auto-mode rule).
- Smoke-test script for the user (not an agent) to close U2, U4-U9, U11 before build.
