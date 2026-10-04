# closeout-renderer - v2 close-out, renderer defects (2026-10-04)

Agent label: closeout-renderer (workflow wa-agent-v2-closeout, phase Close-out). Scope: src/renderer/**, src/shared/i18n/**,
src/shared/locales/**. Main (src/main/**) was another agent's, running in parallel; I edited no main, docs, tests/e2e or ops
board file. Nothing committed. No vendor binary, bridge, GUI or external service was touched.
Method per item: failing test first (each was seen red for the stated reason), then the fix, then the surrounding suite.

## Results

| Item | Status | Fix | Tests (red first) |
|---|---|---|---|
| e2e #5 / undo.spec:87 - "In calendar" card keeps the pre-undo time | FIXED | `ItemList.tsx keyOf()` now keys EVERY card by item id. `dedupeByEvent` still draws one card per event (B20), but React no longer hands item 1's ItemCard (and its local draft / edit / result state) to item 2 when the event moves between items. Before: item 2's card went dirty with no edit (`draft !== suggestion`), `refresh()` pinned it and marked it stale. | `Dashboard.v2.test.tsx` "an event moving to another item never inherits the first card: Undo shows the restored time at once" - the exact sequence: item 1 in calendar 15:00 -> reschedule lands on item 2 (17:00, same eventKey) -> Undo on card 2 -> card 2 shows 15:00, no `stale-2`. Red at `dirtyItemIds.has(2) === true`. |
| editing-undo-5 - B24 correction card | COMPONENT READY; main's view model NOT there yet | `ItemCard.tsx`: `correctionOf(item)` / `offeredChangeOf(item)`. An in-calendar card is a correction when `status === 'in_calendar'`, `eventState` is `created` or `updated`, `change !== null` with `kind` reschedule or move, and a PENDING `update_event` is in `actions`. It is drawn exactly like a Change card: ChangeLine (`from` = Google's copy -> `to` = approved), the EventChip shows `to` as proposed, the amber note `change.correctionNote`, "Approve change" (ApproveButton: one `action:approve` with the shownHash, focus-steal guarded, double click ignored) and "Keep 15:00" / "Keep the old place" (`action:reject`, fail-safe, not guarded). The sheet shows "Now in your calendar" (from) and the editor in change mode. Cancel / undo kinds, no pending update_event, or a `change_unclear` badge draw nothing. | `ItemCard.v2.test.tsx` describe "B24 correction card (editing-undo-5)" (8 cases incl. he) |
| ux-i18n-v2-3 (b) - no Renew for an `on` policy in its last 7 days | FIXED (renderer, existing channels) | `AutomaticMode.tsx`: "Renew" in the `on` state card when <= 7 days are left AND the fresh dialog could be granted (no unmet precondition, provider allows automatic mode). Main refuses `auto:requestEnable` while a policy is live, so Renew = `auto:disable` (fail-safe direction) then ONE `auto:requestEnable {scope: <the live policy's scope>, trial:false}`; main's native dialog still decides. A refused stop asks for nothing and shows the error. The page says before the click what happens (`auto.renewNote`, aria-describedby): if the dialog is cancelled automatic mode stays off. Guarded like every enable control. `auto:requestEnable` still has exactly one caller file (structural test unchanged, green). | `AutomaticMode.test.tsx` 4 new cases (guard, order disable->enable + scope + one call on dblclick, refused stop, no Renew > 7 days or with an unmet precondition). The reviewer scratch "on + ends in 2 days: Renew exists" is now green. |
| ux-i18n-v2-4 - voice intent forgotten on restart | FIXED (renderer) | `store/settings.ts`: `voiceIntent` is mirrored in the renderer's own web storage (`wca.voiceIntent` = `{tier, at}`; a tier id and a timestamp only). Read at store creation, validated against `VOICE_TIERS`, dropped when older than 7 days, removed when settled or cleared. Every storage access is try/catch (storage that throws leaves window memory). The app scheme is registered `standard + secure` in the default session, so the storage persists across restarts. App's existing effect settles the intent on start-up. | `store/settings.test.ts` describe "voice intent survives a restart" (4 cases; the restart is `vi.resetModules()` + a fresh import) |
| ux-i18n-v2-10 - trial page says "Nothing happened automatically yet." | FIXED (what the existing data allows) | `AutoActivity.tsx`: during a trial (`policy.state === 'shadow'`) the page shows the trial's own tally (`AutoState.shadowTally`: "Trial so far: N decisions seen - M would have been done automatically.", pluralised en `_one/_other`, he `_one/_two/_other`) and the empty line says "Nothing is written to your calendar during the trial." Per-decision ROWS still need main's read channel (REQUEST 4 below). | `AutoActivity.test.tsx` 3 new cases (tally + empty text, 1 decision / no tally outside a trial, he dual) |
| ux-i18n-v2-8 - sheet says "Added automatically" for moves / cancels | FIXED | The sheet's Automatic block takes its key from the write row's `kind` (fallback: the card's event state): `card.autoBlock.addedOn` / `movedOn` / `cancelledOn`, agreeing with the chip. | `ItemCard.v2.test.tsx` describe "sheet Automatic block names the write it describes (ux-i18n-v2-8)" (create / update / cancel + he) |

New locale keys (en + he, parity kept; he `_two` only where Hebrew has a dual): `change.correctionNote`, `auto.renewNote`,
`activity.emptyTrial`, `activity.trial_one/_other` (+ he `_two`), `card.autoBlock.movedOn`, `card.autoBlock.cancelledOn`.

## B24 view model the renderer expects (for main / the contract owner)

Main has NOT yet changed `src/main/agent/items.ts changeViewOf` (still `eventState !== 'change_proposed'` => null) and
`docs/specs/v2-contracts.md` has no correction shape. No new type is needed; the renderer draws the correction from the
existing C2 1.5 `ItemCard` fields:
- `status: 'in_calendar'`, `eventState: 'created' | 'updated'` (unchanged - the item stays the live event's card);
- `change: ChangeView` built from the pending update_event's PAYLOAD: `kind` 'reschedule' | 'move', `from` = Google's
  found copy, `to` = the approved content, `baseRevision`, `confidence` (any value);
- `actions` contains that `update_event` with `state: 'pending'` (its `shownHash` is echoed by Approve change).
When main sets `change` that way the buttons appear with no further renderer change. If main instead adds an explicit flag,
`correctionOf()` is the single place to read it.

## Not fixed (needs main - unchanged REQUESTS from v2-fix-src-renderer-src.md)
1. REQUEST 1 (cleaner Renew): a `renew` flag on `auto:requestEnable` would let Renew keep the current policy if the dialog is
   cancelled. The renderer Renew above works with today's channels but a cancelled dialog leaves automatic mode off (said in
   the UI).
2. REQUEST 3 (ux-i18n-v2-5): main's `settings:set` still has no guard on `whatsapp.readTools.enabled` for a stored
   `all_chats` scope. Renderer side was fixed earlier. The reviewer scratch test for it stays red as a mock artifact (its
   `wa:setReadScope` mock answers `all_chats` to every call).
3. REQUEST 4 (ux-i18n-v2-10 rows): no `auto:listDecisions` read channel, so individual shadow / fallback decisions cannot be
   listed; the tally is shown instead.
4. REQUEST 5: distinct ErrorCodes for the BAD_REQUEST family, and `cli:signIn` should invalidate the status cache.
5. ux-i18n-v2-4: "Delete all data" in main does not clear the renderer's `wca.voiceIntent` entry (a tier id, max 7 days old).

## Verification (this session)
- `npx vitest run --project renderer`: 64 files, 1086 tests passed.
- `npx vitest run src/shared` (locale parity / plural tests): 10 files, 710 passed.
- `npm run lint`: exit 0. `npm run typecheck`: exit 0. `prettier --check src/renderer/src src/shared/locales`: clean.
- Reviewer scratch (`v2-review-ux-i18n-v2.scratch`): 11/12 (the remaining red is the mock artifact above).
- e2e not run (not in this task; undo.spec:87 should now pass - the e2e agent re-runs it).

## Notes for the orchestrator
- New B24 test describe and the ux-i18n-v2-8 describe were appended at the END of `ItemCard.v2.test.tsx`: React `useId`
  values in the "Change card snapshots" depend on how many cards rendered before them in the file; inserting earlier shifted
  the ids and failed 6 snapshots with no real change. Snapshots were not updated.
- Approval-first: no new write path. Approve change on the correction card is the existing ApproveButton/controller
  (single flight, shownHash, focus-steal guard). Renew reaches automatic mode only through main's native dialog; its first
  step is the fail-safe `auto:disable`.
