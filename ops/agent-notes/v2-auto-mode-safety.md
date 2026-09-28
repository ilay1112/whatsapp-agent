# Agent notes: v2-auto-mode-safety (research, 2026-09-27; re-run 2026-09-28)

Output: `docs/research/v2-auto-mode-safety.md`.

## Re-run (2026-09-28, "try again")
The 2026-09-27 draft existed and its summary was already in `ops/agent-notes/v2-research-digest.md`. I re-verified every code claim against the tree and the load-bearing web claims against primary sources, then corrected the draft in place instead of rewriting it. Changes:
- Electron: PR #48132 was auto-backported to 40/41 (manual for 38/39) and is in the v42.0.0 notes - the draft's "backported to 37-41" was wrong. 44.4.3 (package.json) has it.
- Alignment with `v2-event-editing.md` (read 2026-09-28): the delta lives on a NEW item linked via `items.linked_item_id`; the private tag carries the SOURCE item id. The draft's ownership check `waItem === String(item.id)` would have rejected every legitimate auto edit - fixed to the linked source item. Adopted the editing design's full private map on every update (`waAgent,waItem,waAction,waUpdate,waRev`, identity values copied from the pre-flight read), its `event_revisions` table and its `item:undoChange` undo path; dropped my separate `undo_auto` action kind. `auto_writes` is now a ledger (pre_json captured BEFORE the write for I8, `revision_id` on success, undo window/state) instead of a second copy of the previous version. Flagged the editing doc's `approved_by IN ('user','auto') DEFAULT 'user'` sketch as superseded (Q8) - a constant cannot be verified by the trigger.
- Q1 resolved: nspady `ALLOWED_EVENT_FIELDS` (src/utils/field-mask-builder.ts) includes etag/updated/sequence/creator/organizer/status/extendedProperties/attendees/recurrence/recurringEventId. Only `status` + `If-Match` on update-event still need the vendored patch.
- Q4 resolved: the server emits `accessRole`; `adminClient.projectCalendars` already parses it but collapses to `writable` with `null => true`. Auto needs the raw role and `'owner'` exactly; absent = not owned.
- Q5 narrowed: `v2-claude-cli-backend.md` shows `--tools "" --strict-mcp-config --disallowedTools` + a `system/init.tools` assertion. New M16: auto only for runs whose assertion passed; Gemini CLI equivalent UNVERIFIED -> auto unavailable with Gemini CLI until shown.
- Added never-auto for media-derived proposals (`from_image`/`image_unclear`, voice transcripts) per `v2-image-events.md`; `media_derived` and `provider_unsafe` reasons; M16/M17 in the MUST list; tests A7/A9/A10/A12/A19 updated.

## Verified this run (primary sources unless noted)
OWASP Agentic Top 10 2026 list (Promptfoo mirror, secondary); OWASP AI Agent Security Cheat Sheet quotes; Meta Rule of Two via Willison (2025-11-02); arXiv 2606.02965 (Ojewale & Venkatasubramanian, 2026-06-01 rev. 2026-08-03); tianpan.co 2026-07-05; Electron Notification docs (`actions` macOS+Windows, `actionIndex`/`selectionIndex`); PR #48132 page; nspady registry.ts (update-event: no status, no etag, sendUpdates default "all"; delete-event present, never enabled), field-mask-builder.ts, ListCalendarsHandler.ts.

## Assumptions / dead ends
- The GitHub releases page summary returned implausible dates for v42.0.0 (May 2025, before the Feb 2026 merge) - treated as a summariser error; dates left UNVERIFIED, version facts kept.
- Did not run any CLI, binary, or MCP tool; did not touch the reference bridge store; no session MCP tools used.
- `src/handlers/utils/field-mask-builder.ts` 404s; the real path is `src/utils/field-mask-builder.ts` (import `../utils/field-mask-builder.js` from `src/tools/`).

## Hand-off
- Build tickets implied: ONE migration shared with editing (table rebuild + auto_policies/auto_decisions/auto_writes + actions.approved_by + trigger), `exec/autoGate.ts`, `CalendarInfo.accessRole`, `ipc/handlers/auto.ts` + native dialog, toast actions, "Automatic" list + activity page, vendored MCP patch (status + If-Match), tests A1-A20.
- Decisions the orchestrator must record: F1 option (A vs soft cancel); approved_by = decision id (supersedes editing doc 3.5); auto unavailable with Gemini CLI until tool-disable is verified.
