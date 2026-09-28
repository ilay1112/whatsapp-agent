# Agent notes - v2-architecture-judge (workflow 5, synthesis step)

Date: 2026-09-28. Output: `docs/ARCHITECTURE-v2.md` (binding amendment set over v1). No code was written; nothing was executed except read-only version checks (`claude --version` on the installed exe, `npm view`, `where.exe agy`, three web fetches). The bridge `store\` folder was never touched; no vendor CLI was run with any login; no session-connected Google/Gmail/Drive tools were used.

## What I read
All three v2 proposals in full (minimal-delta 489 lines, safety 472, ux 634); v1 `ARCHITECTURE.md` in full (945 lines); the research digest; the load-bearing research sections verbatim (event-editing 1.6/1.7/2.3/4.1, auto-mode 5.5/8.1, cli-mcp-bridge 6.1-6.3, gemini-cli 8.1-8.3, whisper 2.1/6, wa-readonly 5.5/10, image-events 4.1/5.1); `ops/CONTEXT.md`, `ops/DECISIONS.md`; the live v1 constants (`src/shared/{errors,types}.ts`, `agent/toolGate.ts` `RunCtx`/`ToolGateDeps`, `shared/ipc.ts` `ApproveReqSchema`, `db/migrations.ts` v1-v3); `vendor/whatsapp-bridge-src/media_serve.go` (Go source only).

## Live verification (read-only, 2026-09-28)
- `%USERPROFILE%\.local\bin\claude.exe` -> `2.1.258 (Claude Code)`; npm `@anthropic-ai/claude-code` latest = 2.1.283. So the native install is behind npm and auto-updates itself: drift is a runtime condition (per-run init proof), not a build-time pin.
- `agy.exe` not at `%LOCALAPPDATA%\agy\bin\`, `where.exe agy` empty. GitHub releases page: 1.2.12 (2026-09-27), daily releases; 1.2.10 notes fixed exit code 3 + `AGY_ERROR` for headless model errors.
- `@cocal/google-calendar-mcp` 2.6.3 (modified 2026-09-02) still latest -> the vendored-patch pins are stable for now. `@modelcontextprotocol/sdk` 1.30.1 and `electron` 44.4.5 exist; v1 pins kept (unrelated to v2; separate ticket).
- `opus-decoder` 0.7.12 MIT; `@google/gemini-cli` 0.61.0.
- whisper.cpp releases: `v1.9.4` and `b5130` both dated 2026-09-11 (asset list did not load; the research listed the zip contents from the GitHub API earlier).
- Claude Code headless docs: "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release"; "In bare mode, Claude Code never reads OAuth credentials"; `--permission-prompts` requires >= 2.1.259; `mcp_server_errors` requires >= 2.1.219; the `--mcp-config` startup wait requires >= 2.1.221 (floor confirmed).

## Scoring (1-5: requirements fit / minimal disruption / safety / buildability / UX)
minimal-delta 5/5/3/5/3 = 21; safety 5/3/5/4/3 = 20; ux 5/4/4/3/5 = 21. Base = minimal-delta; grafts from safety (invariants I1'-I12, provenance columns, If-Match, track record + user-participation + taint as MUSTs, overage stop, `llm.cli` group, no `--tools Read`, security gate groups 13-25) and ux (Connect card + `cli:test`, AutoStrip instead of a fourth list, Change card, Voice/Image bubbles, transcribing header line, ErrorCode deck, dialog/settings copy).

## The design calls that are mine (not in any proposal as-is)
1. **Media bytes = `GET /api/media` only, no `/api/download`, no store-file reads.** All three proposals assumed two endpoints or a file path; `media_serve.go` shows `serveMedia()` calls `downloadMedia()` itself and validates `jid`/`message_id` before serving. One endpoint, one client method, and the smallest A16 amendment. Recorded as C1/B5 with U-M1 (history-synced rows, offline bridge) as the check.
2. **`If-Match` stays in the vendored patch.** minimal-delta deferred it arguing the readback catches a lost update; it does not - after a lost update the readback equals `to`. For automatic edits that is the only true compare-and-set. Three insertions instead of two; 412 mapped.
3. **agy prompt on stdin always.** Two proposals put the nonce block on `-p <text>`; argv is visible to every same-user process and to any process-listing tool. research 8.2 documents the stdin path; failure = `not_ready`, never an argv fallback (U-A6).
4. **Undo window for automatic writes = `min(72 h, event start)`**, not "event end" - `blocked_started` already refuses undo after the start.
5. **`runs.stage` does not gain `transcribe`** - transcription is not an LLM run.

## Conflicts settled (16, table C1-C16 in the doc)
Most notable: cancel = patch fail-closed narrowly (creates keep working) and no soft branch; auto never with Antigravity in v2.0; consents = bump `cloud_*` to v2 + two CLI kinds (no `cloud_images`/`auto_mode`); `chats.auto_policy` = `inherit|never` only; `llm.cli` settings group; one agy model setting; regex Claude model string.

## Gemini honesty
The task asked to say so where no subscription path exists: it does not exist through the Gemini CLI (cut on 2026-06-18). Antigravity is the only no-API-key path and is a policy gray zone with contradictory forum answers within 18 days. Shipped opt-in/experimental with a dated disclosure, no tools, auto off, pictures local, built last (L10), release-gated on M-AGY-1, and listed as open user decision U-v2-1 so the user can cut the lane. API-key Gemini stays the supported path.

## Dead ends / things I considered and dropped
- `CANCEL_MODE='soft'` as a runtime fallback (ux): would make "cancel" mean two things; the narrow disable of the update surface keeps "Add to calendar" working, which was ux's real concern.
- `chats.auto_policy='allow'`: meaningless without the deferred allow-list mode.
- Per-run proof for agy auto (ux P8): the proof content is UNVERIFIED because agy is installed nowhere the build can observe.
- Bumping SDK/Electron pins inside this delta: nothing in v2 needs them.
- A separate `cloud_images` consent: one dialog per data-flow decision; the v2 consent text names pictures.

## Hand-off notes
- Spec agents: sections 4.2 (provider types), 5 (pipeline), 7 (update_event payload/gate), 9 (DDL + trigger), 10 (IPC), 11 (settings) are the contracts to fold into `docs/specs/contracts.md` and `agent-pipeline.md`; contracts.md wins on shapes once updated.
- Build agents: section 15 has the 11 lanes (L1 = Wave 0 of v2; L10 Antigravity last); section 16 lists what only a supervised run can confirm; U-C1/U-C3/U-M1/U-V1 are on the critical path of headline features.
- Orchestrator: please copy D-042..D-057 and U-v2-1..6 into `ops/DECISIONS.md`; the amended invariants replace ARCHITECTURE section 2 for v2; `docs/ACCEPTANCE.md` gains the M-* items of section 14.
