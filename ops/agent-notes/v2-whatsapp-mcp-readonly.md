# Agent notes: v2-whatsapp-mcp-readonly (research; first pass 2026-09-27, second pass 2026-09-28)

Deliverable: `docs/research/v2-whatsapp-mcp-readonly.md` (rewritten in the second pass; the first-pass summary lives in `ops/agent-notes/v2-research-digest.md`).

## Why a second pass
The orchestrator re-ran the task ("Try again"). Re-reading the first draft against the sibling v2 reports showed it was internally sound but disagreed with them on load-bearing facts. The second pass keeps the design (one gate, two transports, four `wa_*` tools, handles, scope setting, reject bundling) and corrects:
- C1 Gemini path: Gemini CLI stopped serving Pro/Ultra/free logins on 2026-06-18; the subscription path is Antigravity CLI `agy` (`serverUrl` + literal headers in `.agents/mcp_config.json`, rule `mcp(wca/*)`, no strict-config flag, no env expansion). `v2-gemini-cli-backend.md` recommends `agy` tool-less in v2; the server design is unchanged by that.
- C2 Server name: `wca` (was `waagent`; siblings used `wca` / `wa` / `wa-agent`). Flagged as a decision to record.
- C3 `claude.exe` 2.1.258 IS installed at `%USERPROFILE%\.local\bin`; I read its `--help` (never ran it with the login). `--restricted`, `--tools ""`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode dontAsk`, `--json-schema` confirmed. U1 closed.
- C4 The corpus already has a `tool_result` vector (calendar result via harness); the WhatsApp rows need a new `wa_row` vector seeded into the fake bridge DB.
- C5 SDK 1.30.0 marks `allowedHosts` / `allowedOrigins` / `enableDnsRebindingProtection` as `@deprecated ("Use external middleware")` - the Host / Origin / token guard is now specified in our own `node:http` handler, SDK options set as belt and braces.
- C6 Transcript table is `transcripts (chat_jid, wa_msg_id)` per the whisper report (U5 closed). C7 `registerTool` takes zod objects (U6 closed).
- C8 Claude Code tool search is default-on: MCP tools are surfaced through a built-in `ToolSearch` call; runner must treat `ToolSearch` / `WaitForMcpServers` as neutral; interplay with `--tools ""` is the new U2.

## What I read (and did not)
- Reference repo SOURCE only: `whatsapp-mcp-server/main.py`, `whatsapp.py`, `mcp_config.py`, `pyproject.toml`, `CHANGELOG.md`. The `whatsapp-bridge/store` directory was never listed, globbed or opened.
- App: `agent/{toolGate,toolDefs,minimize,sanitize,contextBuilder,draft,validate}.ts`, `mcp/{host,readClient}.ts`, `bridge/{bridgeDb,timestamps}.ts`, `proc/freePort.ts`, `paths.ts`, `shared/{types,settings}.ts`, `tests/security/{tool-gate,injection-corpus,import-graph}.test.ts`, `tests/fakes/{fake-bridge-db,obedient-attacker-llm}.ts`, `eslint.config.js` boundary blocks, contracts section 10, SDK 1.30.0 `.d.ts` files.
- Sibling reports: cli-mcp-bridge, claude-cli-backend, gemini-cli-backend, whisper-local, event-editing, research digest.
- Web (2026-09-28): npm registry (SDK latest 1.30.1), code.claude.com MCP docs, antigravity.google mcp / permissions / cli headless docs, MCP spec 2025-11-25 tools page, upstream releases page (v0.7.0 2026-09-23).
- Local checks: `claude.exe --version` / `--help` only; `where gemini agy` -> not on PATH.

## Assumptions
- `cli-mcp-bridge` owns argv, auth files, init-event parsing and the fake CLI; this report only states the requirements the tool server imposes on it.
- The event-editing report keeps S1 tool-less; the delta case is decided in S3 with search -> context.
- Adding to frozen signatures needs orchestrator decisions; all listed in report section 12.

## Dead ends / rejected
- Separate stdio MCP child (own DB connection): second gate, cannot share budgets/handles/nonce, one more process to reap.
- Exposing app.db `chats.id` or bridge `messages.id` to the model: stable identifiers => cross-run correlation / WhatsApp-visible ids. Run-scoped `chat_N` / `m_N` instead.
- Timestamp filtering in SQL: on-disk format is UNVERIFIED per bridge-contract; filter in TS after `parseBridgeTs`.
- Relying on the SDK's deprecated DNS-rebinding options as the control.
- Bundling the Python server (Python + uv + faster-whisper, opens whatsapp.db, 18 tools incl. senders, no disable switch, "Name (phone)" output).

## Things the orchestrator / judge should watch
- Name alignment across reports: server `wca`; tool `wa_get_chat_messages` vs `wa_read_messages`.
- I5 tension: cross-chat reading is a real privacy expansion; default `trigger_chat`, `all_chats` behind consent v2, S4 leak guard.
- `draftToolCalls` 4 -> 6 and `draftTurnsWithTools` 3 -> 4 raise cloud spend per draft run slightly.
- Antigravity has no strict-config equivalent and needs a rule in the user's own settings file; `agy` ships tool-less first.
- U2 (Claude `--tools ""` + tool search) needs one smoke run with the user present.

## Hand-off
- Lanes: bridge (BridgeDb additions + WaReadClient), agent (waTools, handles, toolGate/toolDefs, validate guard), toolserver (registry + HTTP server), security (tests + `wa_row` corpus rows), settings/renderer (scope setting + consent v2), cli-mcp-bridge (argv / config files / fake CLI).
