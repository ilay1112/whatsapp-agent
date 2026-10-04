# v2-fix: src/main/compose.ts, the notifier onUndo handler (finding auto-mode-1)

Phase: v2 phase 3, repair. Finding: auto-mode-1 [major]. Status: FIXED.

## The defect (confirmed)
- The toast Undo (`onUndo` in `createNotifier({...})`) called `notifier.autoUndone(r.ok)`.
- `executor.undoAuto` answers `ok:true` for outcomes that are not a restore: `failed`, `needs_confirm_conflict` and `needs_confirm_drift`. So the last toast said "Calendar change undone" when the event was NOT restored.
- `runUndo` (actionExecutor) also fires `notifyAuto({kind:'undo'})` whenever it reaches `approveAs`. compose maps that to `autoUndone(undo_state === 'undone')`, which is the correct toast. The result:
  - on failure: a correct "Could not undo" toast, then a false "undone" toast;
  - on success: two "undone" toasts.

## Why the reviewer's first suggestion alone was not enough
"Drop the second toast" is wrong for the refusals that come BEFORE `approveAs`: undo window over / event started, changed in Google, ACTION_STALE, NOT_FOUND, CAL_UNAVAILABLE on the pre-read, and a thrown error. `notifyAuto` never fires on those paths, so the click would end with no toast at all. A new test proves this path: "window over".

Their second suggestion, `r.ok && r.value.outcome === 'done'`, makes the toast truthful. On its own it keeps the double toast, though: "failed" + "failed" on a failure, "undone" + "undone" on a success.

## The fix (compose.ts only, the smallest surface)
- New `toastUndos: Map<autoWriteId, boolean>`. It records whether runUndo's `notifyAuto('undo')` already toasted for a toast Undo that is still running.
- `onUndo` adds the id, then awaits `undoAuto`. It toasts ONLY if notifyAuto did not, using `r.ok && r.value.outcome === 'done'`. A throw toasts `false`. `settle` is idempotent, so a throw in `emitAutoChanged` cannot add a second toast.
- A second click on the same toast's Undo while the first is still running is ignored. The executor's inFlight guard would answer ACTION_STALE anyway, and ignoring the click avoids a stray "failed" toast.
- The `notifyAuto` 'undo' branch marks the id when it is tracked, and its toast is unchanged. The in-app undo (auto:undo IPC) behaves exactly as before.
- Approval-first is untouched: nothing here writes, and the undo is still approved as 'user_toast' inside the executor.

## Tests (written first, red, then green)
`tests/integration/auto-mode.flow.test.ts` runs the real compose() through the L3 harness. It has a new helper, `oneAutomaticCreate`, and three new tests:
1. "a successful toast Undo shows exactly one 'Calendar change undone' toast". RED before the fix: two "undone" toasts.
2. "a toast Undo whose calendar write fails says it could not undo". `failNext('update-event','error')` makes the outcome 'failed' with ok:true. RED before the fix: "Could not undo" followed by "Calendar change undone".
3. "a toast Undo refused before any calendar call (window over) still says it could not undo, once". It was GREEN before the fix and is a guard that the fix keeps the failure toast when notifyAuto never fires.

The reviewer's scenario was a reschedule whose old slot is now busy (needs_confirm_conflict). Driving that through compose would need the delta pipeline. The 'failed' outcome takes the same `ok:true`-but-not-done branch through the same handler, so test 2 covers it.

## Scratch test note
`ops/agent-notes/v2-review-auto-mode.scratch` auto-mode-1 asserts that `executor.undoAuto(...)` itself returns `ok:false`, so it STAYS RED. I did not change the executor contract. `ok:true` + `outcome` is the documented ApproveOutcome shape (C2 8), and the in-app undo door relies on it to show "add anyway" / drift prompts. The defect was the compose mapping, and that is now fixed and covered by the tests above.

## Verification
- `npx vitest run tests/integration/auto-mode.flow.test.ts`: 5/5 pass, run twice.
- `npx vitest run tests/integration src/main/app src/main/compose`: 38 files, 435 tests pass.
- `npx vitest run src/main/exec`: 462 pass.
- `tests/security/media-text-isolation.test.ts` is RED (voice transcripts null). It is unrelated: it has no undo or toast path, and other agents are editing the voice/job files concurrently.
- An earlier wide run also showed transient reds in exec and pipeline-happy while other agents were mid-edit. Re-run in isolation, they pass.
- Lint: no problems in my files. The 2 errors are in other agents' files (src/renderer/src/App.tsx:525 and src/main/exec/actionExecutor.v2fix.test.ts).
- Typecheck: no errors in my files. The only errors are TS2783 in src/main/llm/cli/runner.ts:399-402, another agent's in-progress edit.
- Prettier: clean on both files.
- Concurrency note: during this work, another agent's compose.ts change (auto-mode-6, account-bound snapshot) briefly made `auto:requestEnable` answer AUTO_CALENDAR_NOT_OWNED in the L3 harness. It resolved on its own, and my tests need no workaround.

Files touched: src/main/compose.ts, tests/integration/auto-mode.flow.test.ts, this notes file.
