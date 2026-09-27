# Agent notes - spec-contracts (2026-09-21)

Output: `docs/specs/contracts.md` (only deliverable). No other project file touched. No secrets, numbers or message content in this file.

## What I read
- `docs/ARCHITECTURE.md` in full (binding), `docs/research/bridge-contract.md` in full, the tool-schema part of `docs/research/calendar-mcp.md`.
- Did not open the reference bridge folder at all (the research report already mirrors the Go source).

## Method
- Wrote every cross-module contract as verbatim TS blocks labelled with their target path.
- Verified in the session scratch folder (not in the repo, nothing installed globally): extracted the 31 blocks, compiled with typescript 6.0.3 strict + zod 4.6.5 -> 0 errors; ran the DDL in node:sqlite and exercised triggers / partial unique index / cascade; checked preload literal parity, enum-vs-CHECK parity, settings patch merge, approve-request zod (forged `chatJid` rejected, edit/kind mismatch rejected).

## Dead ends / gotchas for later agents
- The Write tool decodes backslash-u escapes inside file content. Regexes with unicode escapes must be produced by a script (String.fromCharCode(92) + 'u....') or checked afterwards. contracts.md is pure ASCII - keep it that way.
- Python is not installed on this PC; use node for scripting.
- `agent/**` may not import `mcp/host.ts`, so the capability-free MCP types (`McpResult`, `McpToolCaller` type, `MCP_TOOLS`) live in `mcp/readClient.ts`, and host imports from there.
- `agent/**` may not import `exec/**`, so `content_sha256` is computed in `db/repos/actions.ts.insertPending()`; `canonicalJson()` is in `src/shared/schemas.ts`.

## Decisions I had to take (all flagged `[C+]` in the spec, section 17) - orchestrator should confirm in DECISIONS.md
1. `ItemStatus` adds view-only `dismissed`; stored `items.state` stays 4 values.
2. New IPC channels: `dashboard:getIgnored`, `item:completeEvent`, `clipboard:writeText`, `chat:listPolicies`, `app:ackTrayHint`.
3. Retry model: failed / unknown_outcome(not found) => executor inserts a fresh `pending` clone (`attempt`, `retry_of`, key suffix `:rN`).
4. READ pre-checks (free/busy conflict) run BEFORE the write-ahead so `needs_confirm_conflict` leaves the action `pending`.
5. `/api/send` timeout => `unknown_outcome` (not `failed`).
6. DDL: `proposals.extraction_json` nullable, `ON DELETE CASCADE` under `items`, `schema_migrations` log table, `trg_actions_insert`, `trg_actions_frozen`, extra CHECKs and indexes.
7. `McpReadClient.findAppEvent()` for reconcile; `CallOpts.onUsage`; `LlmProvider.model`.
8. Supervisor takes a `ChildSpec.start()` returning a `ChildHandle` because the MCP child is spawned by the SDK transport.

## Open questions
- Should `trg_actions_state` also make `failed` terminal? Left verbatim (architecture quotes it as binding).
- Can `windowsHide` / below-normal priority be applied to the SDK-spawned MCP child? Lane 5 to verify.
- i18n key layout (`errors.<CODE>.*`, label keys per enum) is fixed by section 18; the i18n spec should adopt it.
