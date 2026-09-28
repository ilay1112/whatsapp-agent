# Agent notes: v2-safety (architecture proposal, safety-first angle)

Date: 2026-09-28. Output: `docs/proposals/v2-safety.md`. Task: the v2 ARCHITECTURE PROPOSAL, angle "safety-first" - design invariants, policy records, undo, budgets and CLI sandboxing first, then fit the five features.

## What I read
- `docs/ARCHITECTURE.md` in full (sections 1-20), `ops/CONTEXT.md` (v2 request + dialog), `ops/DECISIONS.md` (D-001..D-041), `ops/agent-notes/v2-research-digest.md`.
- All eight `docs/research/v2-*.md` in full (auto-mode-safety, event-editing, cli-mcp-bridge, claude-cli-backend, gemini-cli-backend, whatsapp-mcp-readonly, whisper-local, image-events).
- Live constants: `src/shared/types.ts` (LIMITS, BADGES, AUDIT_KINDS, CONSENT_KINDS/VERSIONS, RATE_BUCKETS, PROVIDER_IDS), `src/shared/errors.ts` (ERROR_CODES), `src/shared/ipc.ts` (IpcContext), `src/main/db/migrations.ts` (schema version 3 -> v2 migration is v4), `src/main` layout, `docs/proposals/safety.md` head (v1 style to match).
- Nothing under the reference bridge `store` was touched; no vendor CLI, llama-server, bridge or whisper binary was run; no MCP session tools were used.

## Method
Wrote the trust boundaries (B1-B6) and the invariant table (I1'-I12) first, then the safety primitives (policy records, approval provenance, one undo path, one budgets table, CLI sandbox contract + runtime proof, loopback server, media isolation, proposal provenance), and only then mapped each feature onto them. Every place where a feature needed a weaker primitive is in section 17 (rejected) instead of section 4-13.

## Decisions I took where research left questions open (all marked [LR] in the proposal, listed for the judge in section 15)
1. F1 (cancel semantics): vendored `status` + `If-Match` patch with two sha256 pins; **no** soft-cancel branch; guard failure disables only the update surface (`CAL_UPDATE_UNAVAILABLE`), creates keep working. Reason: one behaviour to test; soft cancel does not meet D-036's letter.
2. `approved_by` = decision id (auto-mode research) supersedes the editing research's `'user'|'auto' DEFAULT 'user'` sketch. Reason: the DB can verify a JOIN, not a constant.
3. Auto-mode extras beyond the research: >= 3 user-approved done creates before `auto:requestEnable`; user-participation check promoted from SHOULD to MUST; overage (`isUsingOverage`) is a hard stop by default; auto unavailable with Antigravity in v2.0 and with any run whose sandbox proof did not pass (`provider_class='cli_unproven'`).
4. Antigravity ships opt-in/experimental/no-tools (as both CLI reports recommend); the app may edit exactly one key (`trustedWorkspaces`) of the user's agy settings, only after a native dialog showing the diff, with a backup. Alternative considered: never touch the file and ask the user to paste JSON - rejected as too fragile for a non-technical user, but it is a one-line change if the judge prefers it.
5. Loopback server per run (cli-mcp-bridge) over the long-lived registry (whatsapp-mcp-readonly). Both give the same 404-after-run guarantee; per-run leaves nothing open between runs.
6. Media bytes for BOTH voice and pictures from the app-owned store file named by `messages.filename` (voice research), not `GET /api/media` (image research). Reason: one locator, one A16 amendment (`POST /api/download` only). UNVERIFIED U12 whether image rows carry `filename`; `getMedia()` fallback specified. The judge may flip this to `/api/media` for images with no other change.
7. Pictures: the `--tools "Read"` fallback of the image research is NOT adopted (it is the only place a vendor agent would get a file tool); Claude-CLI pictures fall back to local vision if the stdin image block fails M-IMG-1.
8. Authenticode check of `claude.exe`: advisory only (UNVERIFIED that the launcher stub is signed).
9. `wa_list_chats` kept but reachable only in `all_chats` scope; MCP server name `wca`; tool name `wa_get_chat_messages`; LCD schema kept (ranges in descriptions + gate).
10. Model defaults: Claude CLI `sonnet` + fallback `haiku`; agy Flash slugs listed live.

## Dead ends / things I deliberately did not do
- Did not re-verify web facts (versions, policy pages): the eight reports were re-verified on 2026-09-28 and the task said to rely on their digests for web facts; I cited them by section instead of restating. The proposal's UNVERIFIED register (section 16) carries the reports' open items plus three of my own (U12 image filename column, U13 opus-decoder under Electron, U14 toast activation on a clean VM).
- Did not write DDL or trigger text in full: contracts.md is the single source of truth for shapes; section 10 gives the semantics and the column list so the spec agent can write the binding text.
- Did not design the renderer beyond what safety needs (Automatic list, activity page, undo affordances, image/voice bubbles, cli status pill).

## Hand-off notes for the judge / spec agents
- Everything the orchestrator must record is in section 15 (D-042..D-052 candidates). Section 2 is meant to replace ARCH 2 wholesale; section 4 amends A3/A10; section 13 lists the packaging script and pin changes.
- Cross-report conflicts I resolved: server name (`wca`), tool name (`wa_get_chat_messages`), `approved_by` shape, per-run vs long-lived listener, media byte source, image `Read` fallback, auto with agy. Each is in section 15 or 17 with the reason.
- The security test gate (section 14) is numbered 13-25 to continue ARCH 18's twelve groups.
- No secrets, phone numbers, JIDs or real message content appear in the proposal or in this note.
