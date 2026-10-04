# v2-fix-src-main-app - agent notes

Phase: v2 phase 3 (repair). Task: fix confirmed finding auto-mode-7 (src/main/exec/autoPolicy.ts:197 / src/main/app/autoDialog.ts).

## auto-mode-7 [minor] - FIXED

**Defect (confirmed):** `autoPolicy.requestEnable` stored the scope sent by the renderer as the immutable grant. The main-owned native dialog only saw
`{calendarName, trial, validityDays, endsOn}`, so a renderer could send `cancels: true` or `quietHours: null` and the user's confirmation
never showed either.

**Why only cancels and quietHours:** I checked every `AutoScopeSchema` field against `DEFAULT_AUTO_SCOPE` and the six fixed bullets.
- `horizonDays` (max 30), `maxMinutes` (max 240), `perChatPerDay` (max 3), `globalPerDay` (max 15) and `moveMaxDays` (max 14) are each capped at
  exactly the default value the bullets state. They can only make the grant NARROWER than what the dialog says, which is safe.
- `edits` is covered by "added to and changed in"; `edits: false` is narrower.
- `validityDays` is already shown ("ends by itself after N days" plus "Ends on").
- `cancels: true` is wider: no bullet, the checkbox or the message mentions cancelling.
- `quietHours` is wider when it is null. It is ALSO wider when it is non-null but differs from 22-07: e.g. `{from:3,to:4}` leaves the night
  open. The reviewer's fix (a bullet only when quietHours is null) missed this case; mine covers it.

**Fix (smallest surface):**
- `AutoDialog.confirmEnable` takes an optional `scope?: AutoScope`. `autoPolicy.requestEnable` passes `scope.data`, the exact parsed object
  that is then inserted as the grant.
- New exported helper `scopeWideningLines(t, scope)` in autoDialog.ts. It appends lines after the six bullets and before "Ends on":
  - `cancels` -> `auto.dialog.cancels`
  - `quietHours === null` -> `auto.dialog.anyHour`
  - quietHours different from the default -> `auto.dialog.quietCustom` with the real HH:00-HH:00 window
- When `cancels` is true, the checkbox the user must tick becomes `auto.dialog.checkboxCancels` ("added, moved or cancelled").
- The default scope still produces exactly the six bullets and the old checkbox. The UX2 4.5.1 parity test (`auto.happens.*` == the
  settings list) is untouched: the new keys live under `auto.dialog.*`, not `auto.happens.*`.
- New keys exist in both en.json and he.json. The Hebrew "Undo" wording reuses "ביטול השינוי" (UX2 15.7).

**Spec note for the orchestrator:** ARCH-v2 6.1 and UX2 4.5.1 say the dialog detail is "exactly the six bullets; no information appears only
in the dialog". The extra lines appear only for a scope the user changed in Settings, and they restate that toggle's setting (Settings shows
`auto.scope.cancels` / `auto.scope.quiet`). The spec copy should be amended to say the dialog adds one line per widening toggle. I did not edit
the specs.

**Alternative rejected:** forcing `cancels: false` and default quiet hours in main. That would silently ignore a choice the user made
legitimately in Settings (the toggles exist in AutomaticMode.tsx). Showing the choice keeps the native dialog as the trust anchor without
taking away a feature.

## Tests (written first, seen red, then green)
- `src/main/app/autoDialog.test.ts`, "auto-mode-7: a widened scope ... is SHOWN": checks the default scope gives 6 bullets and the standard
  checkbox; the widened scope gives 8 bullets, ends with the end date and uses the cancel checkbox; custom quiet hours show the window; Hebrew
  has the same lines. It was red: 6 bullets where 8 were expected.
- `src/main/exec/autoPolicy.test.ts`, "auto-mode-7: the scope that becomes the grant is exactly the scope the dialog was shown": it was red
  (`p.scope` undefined). I also extended the existing exact-`toEqual` expectation of the dialog call with `scope: DEFAULT_AUTO_SCOPE`, a
  contract addition. It is not weakened.

## Verification
- `npx vitest run src/main/app src/main/exec src/main/ipc src/shared tests/security`: 99 files, 2789 tests pass.
- eslint on the four touched TS files: clean. prettier --check on all six touched files: clean.
- `tsc -p tsconfig.web.json`: clean. `tsc -p tsconfig.node.json` and `tsconfig.tests.json` fail ONLY in files other concurrent agents are
  editing (`src/main/llm/cli/runner.ts` duplicate env keys, `src/main/proc/jobRunner.orphans.test.ts` missing exports). None of the errors are
  in my files.
- `npm run lint` fails on one error in `src/renderer/src/App.tsx:511` (react-hooks/set-state-in-effect). That file is not mine; it is in
  progress elsewhere.
- `src/renderer/src/views/settings/AutomaticMode.test.tsx` has 4 red tests (auto-precondition / auto-refused / role=alert elements). That file
  is being edited by another agent (red-first). The tests are unrelated to the dialog and the new keys.
- The e2e `auto-mode.spec.ts` only asserts that a checkbox label is non-empty, so the change is compatible. I did not run the e2e tests.

## Files touched
- src/main/app/autoDialog.ts, src/main/app/autoDialog.test.ts
- src/main/exec/autoPolicy.ts, src/main/exec/autoPolicy.test.ts
- src/shared/locales/en.json, src/shared/locales/he.json (4 new keys each under auto.dialog)
