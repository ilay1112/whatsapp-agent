# v4-manual-events — T-908 group D (T6 main, T7 UI + e2e)

Worker notes, 2026-10-19. Spec: `docs/specs/v4-calendar-handover.md` §2.5, §3 (I9′), §4 group D, plus the coordinator's design
correction (ARCH-v2 §10: no Google event id crosses IPC). No commit / push. PROGRESS / BOARD / DECISIONS untouched.

## State at hand-off (all green)
- `npx vitest run`: 361 files, 8338 passed, 1 expected fail, 1 skipped. No flaky failure seen this session.
- `npm run typecheck`, `npm run lint`, `npm run format:check`: clean.
- `npm run -s build:e2e && npx playwright test tests/e2e/v4-calendar.spec.ts tests/e2e/dashboard-v3.spec.ts tests/e2e/approval-first.spec.ts tests/e2e/undo.spec.ts`: 15 passed.
- Screenshots (read): `test-results/screens/calendar-foreign-{en,he}.png`, `calendar-popover-en.png`, `calendar-confirm-delete-en.png`.

## Contract summary
- **Migration v6 `manual_events`** (`SCHEMA_VERSION` 6, `foreignKeysOff`): rebuilds `actions` (+ `source` 'chat'|'manual', nullable
  `item_id`/`proposal_id`/`chat_id` with CHECKs, kind += `delete_event` manual-only, `send_reply` chat-only, index `ix_actions_manual`),
  `auto_decisions` (reason += `manual_only`), `event_revisions` (nullable `item_id`, kinds += `manual_create|manual_edit|manual_delete|manual_undo`,
  item_id NULL ⇔ manual kind, rev-1⇔create only for chat rows). Triggers recreated; `trg_actions_state` adds "manual needs a click"
  (`approved_by` must be `'user'`); `trg_actions_frozen` adds `source` and NULL-safe `IS` comparisons. Test: `src/main/db/migrations.v6.test.ts`.
- **New IPC**: `calendar:proposeCreate`, `calendar:proposeEdit {calendarId, eventKey, patch}`, `calendar:proposeDelete {calendarId, eventKey}`
  → `ManualProposal {actionId, kind, shownHash, summary}`; `action:undo {actionId}` (focus-gated) → `ApproveOutcome` manual member.
  `ApproveOutcome` gains `{outcome:'done'|'failed', item:null, manual: ManualOutcomeView}` (`ChatApproveOutcome` / `ManualApproveOutcome` helpers).
- **Action kinds**: `ACTION_KINDS` += `'delete_event'`; `ACTION_SOURCES` = `chat|manual`; payloads `ManualCreatePayload` /
  `ManualEditPayload` (absolute content PATCH, `baseEtag`, `from` snapshot) / `ManualDeletePayload`, union `ManualActionPayloadSchema`
  (separate from the strict chat `ActionPayloadSchema` - neither parses the other). Undo actions carry `undoOf`.
- **Errors / audit / auto**: `CAL_EVENT_FOREIGN_PROTECTED` (action none); audit `manual_event_proposed|executed|refused`; `AUTO_REASONS` += `manual_only`.
- **Server surface**: `delete-event` = 9th tool (class write) in `MCP_TOOLS`, `ENABLED_TOOLS_ENV`, staged pin (`vendor/calendar-mcp.pin.json`,
  `scripts/stage-calendar-mcp.mjs EXPECTED_TOOLS`, `scripts/smoke-packaged.mjs`), `DESTRUCTIVE_HINT_TOOLS`, `REQUIRED_INPUT_FIELDS`.
  `McpToolCaller` 4th arg `opts?: {source}`; write client `createManualEvent` / `updateManualEvent` / `deleteManualEvent`; `projectDeletedEvent`.

## Every place `source:'manual'` is checked
1. DB: `actions` CHECKs (ids / kinds per source), `trg_actions_state` ("manual needs a click"), `trg_actions_frozen` (source immutable).
2. `db/repos/actions.ts`: chat members filter `source = 'chat'` (byId, executing, countUserApprovedCreates, rejectedDeltaTo; chainRoot via byId);
   manual members filter `source = 'manual'` (manualById, manualExecuting, supersedePendingManual, manualUndosOf).
3. `db/repos/eventRevisions.ts`: chat members `item_id IS NOT NULL`; manual members `item_id IS NULL`.
4. `shared/schemas.ts`: `source: z.literal('manual')` in every manual payload; the chat union is strict (no `source`).
5. `exec/actionExecutor.ts approveAs`: `repos.actions.manualById` → `manualExec.approve`; `tryAuto` never sees a manual row (byId null).
6. `exec/manualEvents.ts approve`: refuses any approver but `'user'`.
7. `exec/autoGate.ts`: first check `manual_only` (`action.source === 'manual'` or payload source) - ends the run.
8. `mcp/host.ts callerFor`: `delete-event` only with `opts.source === 'manual'`; `mcp/writeClient.ts deleteManualEvent`: `args.source === 'manual'`.
9. Fake (`tests/fakes/fake-mcp-calendar.ts` callerFor) mirrors 8; ledgers: rule 13 (`tests/helpers/ledger.manual.ts`) proves each manual
   create/update/delete against one executed `source='manual'` action approved by `'user'` + its snapshot row; rule 8 allows only those deletes.

## Design decisions / deviations (please review)
- **Opaque keys (coordinator correction)**: `ForeignEventView` has NO `eventId` (C's field removed; C's tests updated) and gains `fromChat`,
  `undoActionId`. `CalendarEventsService.resolve(calendarId, eventKey)` maps back from the LIVE cache (TTL respected) → else `CAL_EVENT_GONE`.
  Block test id is `cal-block-f-<eventKey[0:8]>`. `eventKey` keeps C's formula `sha256('wca-event|'+id)[0:16]` (must equal the card key for de-dup).
- **Chat cards' events are refused** for manual edits (`fromChat` = private `waItem` set; reason `from_chat`, UI `cal-reason-fromchat`): a manual
  revision in a chat event's revision chain would break the card's CAS/undo chain. Manual creates are tagged `waAgent:'1', waManual:'1', waAction`
  and no `waItem`, so they stay manageable. **All-day events** are refused too (`all_day`, UI `cal-reason-allday`): the content PATCH is timed.
- Manual edit never sends `status` or `extendedProperties` (a foreign event is never tagged as ours); the fake treats a map-less update as manual
  and flags `manual_write_on_protected_event:*` / `manual_update_status`.
- Drift rule: the executor proceeds only when Google's copy still equals the snapshot the user saw (`sameContent`), then If-Match = pre-flight etag.
  An undo proceeds only while Google still holds exactly what the action wrote; window `LIMITS.manualUndoWindowMs` (7 d). Undo of an undo is refused.
- One pending manual proposal at a time (`supersedePendingManual` on each propose / undo); cancelling the confirm leaves the row pending until the
  next propose or the 24 h expiry (no reject channel added - `action:reject` answers an `ItemDetail`).
- Manual `executing` rows → `unknown_outcome` at startup, never re-executed, no retry clone (no reconcile for manual rows; the user re-checks the week).
- No free/busy conflict question for manual writes (the user is looking at the calendar); rate bucket `create_global` counts them.
- **Hue fix (group C bug found by the screenshots)**: Tailwind pruned 7 of the 8 `--color-cal-N` tokens (only read via inline `var()`), so
  blocks drew a black edge: moved them to `@theme static`. And the three seed calendars all hash to hue 1: `assignCalendarHues(ids)` spreads
  colliding calendars to the next free hue in list order (`calendarHueOf` uses it once the list is known).
- `cal.scopeNote` replaced in en + he as instructed (same key); `CalendarWeek.test.tsx` expectation updated.

## UI (T7) - files and test ids
- `components/ManualEventDialog.tsx` (`cal-dialog` data-mode create|edit|move, `cal-dialog-calendar` (writable only), `-title`, `-date`,
  `-start`, `-end`, `-location`, `-submit`, `-cancel`, `-error`), `components/ManualEventActions.tsx` (`useManualEvents`: `cal-new-event`,
  popover `cal-action-edit|move|delete|undo`, confirm `cal-confirm` data-op, `cal-confirm-question|before|after|ok|cancel|error`).
  `CalendarWeek` uses it when `renderEventActions` is not passed. Done → global toast `cal.doneCreate|Edit|Delete` with Undo (`action:undo`),
  then `cal.doneUndo` / `cal.undoUnavailable`. New locale keys (en+he): `cal.newEvent, edit, move, delete, undoLast, confirmCreate, confirmEdit,
  confirmDelete, refusedFromChat, refusedAllDay, confirm, save, field*, before, after, invalidTime, invalidTitle, done*, undoUnavailable`,
  `errors.CAL_EVENT_FOREIGN_PROTECTED.*`, `auto.reason.manual_only`.

## Tests added / changed
- New: `exec/manualEvents.test.ts` (hard requirements 1-7 incl. snapshot-before-write probe and ledger), `db/migrations.v6.test.ts` (9),
  `ManualEventDialog.test.tsx`, `ManualEventActions.test.tsx`, `tests/e2e/v4-calendar.spec.ts`, `tests/helpers/ledger.manual.ts`.
- Changed: host/readClient/writeClient/projection/calendarEvents/handlers calendar tests, `tests/security/never-delete.test.ts` (I9′ semantics),
  `migration-v4.test.ts`, migrations v4/v5 tests (SCHEMA_VERSION), `autoGate.fixtures.ts` (manual_only flip), smoke-packaged tests, ItemCard.v2
  snapshots (only `useId` ids shifted: one more AUTO_REASONS row rendered earlier in that file).

## Docs touched
- `docs/specs/contracts.md` §19.2 (`ForeignEventView` shape) and §19.3 filled (was a placeholder).
- `docs/ARCHITECTURE-v2.md` B33: "foreign events: opaque eventKey resolved in main from the week cache" sentence.
- Still for the docs worker: ux.md §6.12 / §14 / §16 can now list the test ids above; ARCH B3 row text still says "ENABLED_TOOLS = 8 names".

## Review fix pass (2026-10-20, against `ops/agent-notes/v4-review.md`)

Test-first for every item; the new tests failed before the change.

**Should-fix 1 - Refresh no longer resurrects decisions or burns the hourly budget.**
- `Ingest.reanalyseChat` (`src/main/bridge/ingest.ts`) returns `nothing` when the chat's newest card (closed - there is no open
  one) was dismissed, or was already made from the newest trigger-eligible inbound row (`LATEST_ITEM_SQL`). New
  `Ingest.newestInboundMsgId(chatId)` (optional on the interface, like `reanalyseChat`).
- `handlers/dashboard.ts`: an OPEN card with `analysis === 'done'` whose `triggerMsgId` equals the newest inbound row is skipped
  (`skippedNothingToAnalyse`). Deliberate refinement of the brief's "open or closed": an open card whose analysis `failed` (or a
  non-user-gated hold) is still retried - that is the point of Refresh for an open card, and retriage has its per-chat limit.
- Held new cards (unknown sender / paused) are counted as `queued` but no longer charged against `llm_global`: the guard uses a
  separate `charged` counter; the doorbell is poked only when something was charged.
- Tests: `ingest.reanalyse.test.ts` (no-action -> nothing; dismissed -> nothing, a NEW live message still makes a card through
  normal ingest; `newestInboundMsgId`; and the integration test "three presses in 90 s on 20 no-action chats charge zero runs"
  over the REAL ingest + refresh service); `dashboard.test.ts` (open+done skipped, open+failed retried, held not charged). The old
  "dismissed => new item" test was flipped; the remaining reanalyse tests now add the uncarded row after closing.

**Should-fix 2 - the calendar view follows `dashboard:changed`.** `useCalendarView` subscribes to `dashboard:changed` and bumps a
quiet `tick` (re-read of the same week + selection; `loading` stays false, the old answer stays up). Main already invalidates its
cache on every write door and on Refresh before the push, so the renderer does not call `calendar:invalidate` again. The
CAL_EVENT_GONE re-read already existed (`failedProposal`, `proposeDelete`); a test now pins it for propose-edit (form error +
exactly one more `calendar:listEvents`). New `src/renderer/src/store/calendarView.test.ts`.

**Nits.**
- `projection.ts`: `classifyEventErrorText`'s doc comment moved back onto it.
- Hues: `assignCalendarHues` runs in the `google:listCalendars` answer, only when the calendar id set changed - never in render.
- Location pre-fill: `ListedEventProjection` / `ForeignEventView` / `ForeignCalendarEntry` gain `location` (UNTRUSTED,
  `cleanLine(..., LOCATION_MAX=120)`), shown only as the edit form's input value. The projection minimisation test now allows
  `location` (description, links, emails, conference data still dropped).
- Cancel on `cal-confirm` calls `api.reject(actionId)` (best effort). Main: `executor.reject` handles a manual row (pending ->
  `rejected`, audit `action_rejected {kind, attempt:1}`, no item touched, no notifyChanged); `action:reject` answers `null` for a
  manual row, so its response type is now `ItemDetail | null` (`shared/ipc.ts`, contracts.md). Card callers ignore the value.
- Docs: ARCHITECTURE-v2 B3 now "9 names ... `delete-event` manual-only"; ux.md 6.11 popover reasons + 6.12 disabled-reasons list
  gain `cal-reason-fromchat` / `cal-reason-allday`; ux.md Refresh paragraph states the skip rules; contracts.md seams updated.

**Not done (out of brief):** manual writes still share the `create_global` bucket; nested scrollers in the dashboard.

**Runs:** `npx vitest run src/main/bridge src/main/ipc src/renderer/src/store src/renderer/src/components src/main/mcp src/main/exec`
2309/2310 - the one failure, `bridge/launcher.test.ts` "backoff respawn", passes 3/3 alone (load flake, file untouched);
`src/renderer src/shared src/main/agent tests` green except `tests/integration/mcp-real-toolslist.test.ts`, which passes alone
(real process spawn under load). typecheck, lint, format:check green. `build:e2e` + `v4-calendar.spec.ts` + `dashboard-v3.spec.ts`:
8/8 passed.
