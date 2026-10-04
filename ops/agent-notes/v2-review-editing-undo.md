# v2 adversarial review - lens "editing-undo"

Agent label: `v2-review-editing-undo` (v2 phase 3). Scope: event editing and undo in the BUILT code under `src/`: delta
extraction / `resolveDelta`, he/en reschedule and cancel phrasing, one editable event per chat, linked items, the
`update_event` executor (pre-flight, If-Match / 412, baseRevision CAS, readback, reconcile), the `event_revisions` undo
chain and Restore original, R13, and T-401.

No product file was edited. No test under `tests/` or `src/` was touched.

## Proof
Failing tests that prove the findings live in `ops/agent-notes/v2-review-editing-undo.scratch/`. They are NOT part of
`npm test`. Run them from the project root with:

    npx vitest run --config "ops/agent-notes/v2-review-editing-undo.scratch/vitest.scratch.config.ts"

Result on 2026-10-04: 11 tests, 11 red (each test asserts the CORRECT behaviour, so red means the defect is real).
- `editing-undo.review.test.ts`: findings 1, 2, 3, 4, 5 (+10 as a soft assertion), 8, 9. These use the real executor, real
  repos (in-memory SQLite) and the fake calendar through `tests/helpers/ledger.execRig.ts`.
- `resolveDelta.review.test.ts`: findings 6 and 7 (pure `resolveDeltaOutcome`).

## Findings (most severe first)

### editing-undo-9 (major): sending the reply after the event was added closes the event card, so the event is no longer editable
- Where: `src/main/exec/outcome.ts:43` (`applySendSuccess`). It closes the item `'replied'` whenever `eventState` is not
  proposed/incomplete. That includes `created` / `updated` / `cancelled`. `deriveState` then returns `'ignored'`
  (`src/shared/state.ts:13`). `EDITABLE_EVENT_FILTER` requires `state = 'in_calendar'` (`src/main/db/repos/items.ts:18`).
- Scenario: the user clicks "Add to calendar" and then "Approve & send" on the same card. This always happens in automatic
  mode, where S5a writes the event before the user sends the reply. It also happens after a change card is approved and its
  reply is then sent.
- Result: the item becomes `ignored` with `closed_reason='replied'`, and `findExistingEvent()` returns null. The next "let's
  move it to 5" from the contact takes the v1 path and offers a second create. The in-calendar card (with Undo, Cancel event
  and Restore original) also leaves the dashboard.
- Proof: scratch test `editing-undo-9`.
- Fix: do not close an item whose `eventState` is `created|updated|cancelled`. The v1 state machine says "any OPEN item".
  Alternatively, drop `state='in_calendar'` from the editable filter in favour of `closed_reason IS NULL OR closed_reason='replied'`.

### editing-undo-1 (major): T-401 is not closed. An edited retry of a create whose first attempt landed creates a second event
- Where: `src/main/exec/actionExecutor.ts:891-937`. The create approve path never asks `findAppEvent(chainRoot)` before writing.
  B24 exists only in `src/main/exec/reconcile.ts:111` (startup reconcile, and only for edits made in Google).
- Scenario: Approve create, then `create-event` times out (it did land), so the action becomes `unknown_outcome` and
  `markUnknown` inserts a pending clone right away. The card is still `proposed` and editable. The user changes the time and
  clicks "Add again". `eventIdFor` hashes the edited content, so Google accepts a second event.
- Result: two app events in the calendar. Research section 4.4 / D-055 require "edited retry of a found create => update_event".
- Proof: scratch test `editing-undo-1` (2 confirmed `waAgent` events).

### editing-undo-8 (major): after an "Apply again" lands, reconcile of the original unknown update throws a UNIQUE violation
- Where: `src/main/exec/reconcile.ts:235` compares `items[targetItemId].eventRevision` (the SOURCE item) with `baseRevision`.
  But `applyUpdateSuccess` (`src/main/exec/outcome.ts:165-180`) moves the revision onto the ACTING delta item and never
  bumps the source.
- Scenario: Approve change, then the PATCH times out (it did not land), so the action is unknown and a clone is created.
  "Apply again" lands as rev 2, with `waUpdate` = the chain root = the original action id. At the next startup the reconcile
  sees source rev 1 == base 1, so it does not supersede. The readback has `waUpdate === root` and the slot equals `to`, so
  `commitUpdateDone` tries to insert rev 2 a second time.
- Result: `UNIQUE constraint failed: event_revisions...` is thrown out of `reconcileUnknown`. That happens on EVERY start.
  The original stays `unknown_outcome` forever, and every unknown row after it in that pass is skipped and offered as a
  "... again" clone. The third pass in compose.ts catches and logs it. `executor.recoverOnStartup()` (compose.ts:2120) is NOT
  wrapped, so a reachable calendar at that point would reject `start()`.
- Proof: scratch test `editing-undo-8`.
- Fix: compare against the event's newest revision (`eventRevisions.newestFor(targetEventId).revision`) or the holder's
  revision, and treat "a clone of this chain is done" as superseded.

### editing-undo-2 (major): an unedited "Apply again" after an update that landed but timed out breaks undo permanently
- Where: `src/main/exec/actionExecutor.ts:810-822`. The pre-flight drift check does not recognise the app's own landed write:
  `pf.priv.waUpdate === chainRoot`. After "Apply anyway", `from` is replaced by Google's copy, which already equals `to`, and
  `equalContent(to, from)` is not re-checked.
- Scenario: Approve the reschedule WED to THU. The PATCH lands and times out, so the action is unknown and a clone is created.
  "Apply again" answers `needs_confirm_drift` and shows THU as "changed in Google". "Apply anyway" then sends a no-op PATCH
  and records a revision with `prev = next = THU`.
- Result: that revision is the undo candidate forever. Undo builds `from = to = THU` and gets `ACTION_STALE`, so WED can never
  be restored. The same path with an EDITED retry, the T-401 variant for updates, records `prev` = the first attempt's `to`,
  so undo restores the abandoned slot instead of the original.
- Proof: scratch test `editing-undo-2`.
- Fix: in `approveUpdate`, a pre-flight whose `priv.waUpdate === chainRootOf(a).rootActionId` means an earlier attempt of
  this chain landed. Resolve the original (as reconcile does) and keep the ORIGINAL `from` as the revision's `prev`.

### editing-undo-3 (major): an undo whose PATCH timed out can never be retried
- Where: `src/main/exec/actionExecutor.ts:1360-1366`. The idempotency guard counts `unknown_outcome` undo actions of the same
  `revertOf`. The retry clone that `markUnknown` inserts is a pending `update_event` on an in-calendar card. `ItemCard.tsx:1116-1119`
  draws update buttons only for `change_proposed`, so no UI reaches it. The clone also expires after 24 h.
- Scenario: Undo times out without landing. The Undo door is still shown, because the candidate is unchanged. Every click
  answers `ACTION_STALE`. After restart the reconcile cannot find it applied, so it stays unknown and the door stays blocked.
- Proof: scratch test `editing-undo-3`.

### editing-undo-5 (major): B24's correction card (F38) cannot be approved or kept
- Where: `src/main/exec/reconcile.ts:111/190-224` inserts the pending `update_event` on the create item, which stays
  `event_state='created'` with a proposal whose `delta` is null. `src/main/agent/items.ts:178` (`changeViewOf`) returns null
  unless the item is `change_proposed` with a delta. `src/renderer/src/components/ItemCard.tsx:1116-1119/1468-1504` draws
  Approve / Keep only for that case.
- Result: "exactly one pending update_event" exists but the user has no control for it. The user-visible change promised in
  U-v2-14 ("now proposes a change card") never appears.
- Proof: scratch test `editing-undo-5`: detail has `eventState 'created'` and `change null`.

### editing-undo-4 (minor): a refused undo leaves the card showing the restore target, not Google's content
- Where: `src/main/exec/actionExecutor.ts:1369-1394`. `insertChange` commits the new proposal (event = restore target) and
  moves `currentProposalId` BEFORE `approveAs` runs its gates. `items.ts` draws `event: proposal.event`.
- Scenario: Undo while the calendar is disconnected (or rate limit, conflict, drift, 412) fails, but the card now shows WED
  while Google still has THU.
- Proof: scratch test `editing-undo-4`.

### editing-undo-6 (minor): R10 marks a natural reschedule "unclear" when the text names the OLD day or says "שבת שלום"
- Where: `src/main/agent/resolveDelta.ts:316-320`. Every weekday word in the trigger counts, including the existing event's
  own weekday and the Friday greeting "שבת שלום" (matched by `heWeekday('שבת')`).
- Failing inputs:
  - "can we move Wednesday's meeting to tomorrow?" / "אפשר להזיז את הפגישה של רביעי למחר?" (Monday, event Wednesday).
  - "אפשר להזיז ל-17:00? שבת שלום" (Friday, event Sunday).
- Result: `change_unclear`, no delta.
- Proof: scratch `resolveDelta.review.test.ts`.
- Fix: for a reschedule, accept the existing date's weekday as well, and exclude "שבת שלום".

### editing-undo-7 (minor): R8 turns a cancel of next week's event into a move to today
- Where: `src/main/agent/resolveDelta.ts:286-293`.
- Scenario: on Wednesday, for an event next Wednesday, "sorry, I have to cancel Wednesday" with `dateKind weekday 3,
  weekOffset 0` resolves to today. The named slot is not equal to the event start, so the code treats it as a reschedule
  to today 15:00. R10 and R11 both pass, so a reschedule card is offered for a cancel message.
- Proof: scratch `resolveDelta.review.test.ts`.
- Fix: a cancel's named date equal to the existing event's WEEKDAY (or within the event's own week) should stay a cancel.

### editing-undo-10 (minor): reconcile resolving a create to done leaves its "Add again" clone pending on the in-calendar card
- Where: `src/main/exec/reconcile.ts:105-112`. Nothing supersedes the pending create clone that `markUnknown` inserted.
- Result: the in-calendar card keeps a live "Add to calendar" button (`ItemCard.tsx:1452`) for an event that exists.
- Proof: the soft assertion inside scratch `editing-undo-5`.

## Checked and found sound (no finding)
- `buildUpdateEventArgs`: exhaustive keys, `ifMatch` from the pre-flight, `sendUpdates:'none'`, tags copied.
- `sameContent` normalises both sides, so a URL-bearing title does not cause false drift. `SUMMARY_MAX` equals `LIMITS.titleChars`.
- The 412 path fails the action and puts `driftShown` on the clone. "Apply anyway" re-reads the etag.
- R13 `rejectedDeltaTo` keys on `(targetEventId, baseRevision)` with a `json_valid` guard. A `suppressed` outcome keeps `declined`.
- Undo chain: `undoCandidate` skips undo and reverted rows. Restore original's span stops at the newest user-approved revision.
  `commitUpdateDone` marks extras reverted and auto writes undone.
- Concurrent click and auto writes on the same event are protected by If-Match (the second PATCH gets 412).

## Side notes (not findings)
- `reject()` (`actionExecutor.ts:1555`) sets `event_state='declined'` on the ACTING item. This is correct for a delta item.
  If B24 / undo / cancel cards ever get a Keep button (see finding 5), rejecting would decline the event HOLDER and hide a
  live event.
- B24's `findAppEvent` window is the approved slot +/-24 h. A create the user moved more than a day away in Google is not
  found and stays unknown.
