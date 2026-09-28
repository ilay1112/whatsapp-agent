# Agent notes - v2-contracts (spec agent for docs/specs/v2-contracts.md)

Date: 2026-09-28. Task: write `docs/specs/v2-contracts.md` = verbatim TS/SQL deltas over `docs/specs/contracts.md` for the
binding `docs/ARCHITECTURE-v2.md` (B1-B32, I1'-I12). Previous attempt produced no file ("Try again" run); started from scratch.

## Inputs read
- docs/ARCHITECTURE-v2.md (all 603 lines), docs/specs/contracts.md sections 0, 9-18 + concerns.
- Live sources (authoritative over contracts.md where they differ): src/shared/{types,errors,health,settings,schemas,state,ipc}.ts,
  src/main/llm/types.ts, src/main/agent/{toolDefs,toolGate}.ts (head), src/main/db/migrations.ts, src/main/db/index.ts (transaction impl),
  src/main/mcp/readClient.ts, src/main/proc/supervisor.ts (exports).
- Research: v2-event-editing 1.7/2.x/3.x/4.x, v2-auto-mode-safety 3-8, v2-whatsapp-mcp-readonly 4-6, v2-cli-mcp-bridge 4-8,
  v2-image-events 4-7, v2-whisper-local 8; proposal v2-ux 5-13.

## Findings that shaped the spec (details in the spec's "Architecture concerns")
1. The migration runner wraps every migration in `db.transaction()` (BEGIN IMMEDIATE). `PRAGMA foreign_keys=OFF` inside a
   transaction is a documented no-op in SQLite, so B22's "12-step" cannot be written inside `m.sql`. With FKs ON, `DROP TABLE items`
   runs an implicit DELETE that cascades into item_messages/runs/proposals/actions = data loss. Spec adds `Migration.foreignKeysOff`
   + runner steps (OFF before BEGIN, foreign_key_check before COMMIT, ON in finally).
2. B22 lists items/actions/consents/runs for the rebuild, but `proposals.provider` and `model_files.id` also carry CHECK lists that
   must widen (claude_cli/antigravity_cli; voice + mmproj ids). Both are rebuilt in the same v4 migration.
3. "approved_by joins the frozen column list" cannot be literal: `trg_actions_frozen` fires on UPDATE OF its columns and the approve
   UPDATE itself sets approved_by, so it would abort every approval. Spec uses a dedicated `trg_actions_approver_frozen`
   (set once, only on pending->approved).
4. Retention vs FKs (same bug class as v1 migration 2): auto_decisions 90 d vs auto_writes 180 d with a plain FK; items.linked_item_id
   without ON DELETE blocks the closed-item purge; media_cache.chat_id without ON DELETE blocks chats.mergeLidInto. Spec adds ON DELETE
   clauses and makes append-only triggers column-scoped so FK SET NULL still works.
5. `llm.cli.claudeExePath` in SettingsPatchSchema = a file path over IPC (section 10 forbids) and lets a compromised renderer point
   the app at any `claude.exe`. Spec: not settable via settings:set; new main-owned native picker `cli:pickExe`.
6. `LlmError('unsupported')` (ARCH 4.2) is missing from the ProviderErrorCode additions; added.
7. v1 settings JSON lacks the new groups; `SettingsSchema` is strict so `parse` would fail after upgrade. v4 migration also runs a
   `json_insert` data step on the settings row.
8. Renderer "keys the calendar list by calendar_event_id" conflicts with the v1 rule that event ids never cross IPC; spec sends an
   opaque `eventKey` computed in main.

## Verification done (scratch folder outside the repo; the repo was not executed or modified except the spec + this note)
- Shared v2 files (live src/shared + the spec blocks) + v1 contracts.md src/main blocks + v2 src/main seam blocks compiled with
  typescript 6.0.3 + zod 4.6.5: zero new errors (only the pre-existing v1 contract gap ApprovedEventContent in section 14).
- Runtime checks (esbuild bundle, Node 24.19): schema key parity, update payload refinements via the 3-way union, v1 payloads still valid,
  StoredExtractionSchema, settings v1 row + json_insert values parse, SettingsPatchSchema rejects auto / llm.provider / claudeExePath,
  depth-2 partial patch merge, IPC schemas (72 channels / 11 events), ErrorCode actions, deriveState v2.
- v4 SQL run in node:sqlite 3.53.3 on a v3 DB built by the LIVE migrations 1-3 and seeded in every action state: 37 assertions pass
  (row counts, integrity_check, foreign_key_check, backfills, every I1' trigger path, policy triggers, retention + LID-merge shapes).
  Re-run with the SQL extracted from the finished spec: same 37 ok / 0 fail.
- 21 const tuples == their DDL CHECK lists.
- Proved concern #1 (FK OFF no-op inside the runner transaction => item_messages silently emptied) and #2 (partial unique index on state
  allows shadow + on) by running them.
- toLcd rules verified against zod 4.6.5 (safe-integer bounds, key order, strictness not visible in JSON).

## Hand-off
- Spec: docs/specs/v2-contracts.md (20 architecture concerns at the end; items 1-5 found by execution).
- Orchestrator: consider decisions for concerns #1 (runner change), #5 (cli:pickExe), #7 (undo_unavailable), #9 (CLOUD_QUOTA action),
  #12 (412 after write-ahead), #20 (golden gates vs defaults) alongside D-042..D-057.
