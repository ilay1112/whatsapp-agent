# v2-fix-src-shared-locales

Phase 3 repair. Finding: ux-i18n-v2-7 [minor], "ends in {{count}} days" lines had no plural forms.

## Verdict

Confirmed. `health.sub.auto.on` and `setup.auto.expiring` were single base keys in both locales. All three call sites
(HealthPill.tsx:86, SetupStrip.tsx:74 via App.tsx:680, AutomaticMode.tsx:292) pass a `Math.ceil` day count, so the last
day of a policy is count 1, which rendered "1 days" / "1 ימים". In Hebrew, count 2 also rendered "2 ימים" when it should be
"יומיים".

## Test first (red, then green)

`src/shared/locales/locales.test.ts`, describe "v2 copy rules (V2-W1-12)", test
`ux-i18n-v2-7: the "automatic mode ends in N days" lines are pluralised (1 day, Hebrew dual for 2)`:
- Both bases have `_one`/`_other` in en and `_one`/`_two`/`_other` in he.
- It renders through a fresh `i18next.createInstance()` over the real merged `RESOURCES`:
  - en: count 1 gives "day", counts 2 and 5 give "days".
  - he: count 1 gives "יום אחד", count 2 gives "יומיים", count 5 gives "5 ימים".
  - Neither 1 nor 2 matches `\d ימים`.
- It was red before the fix: the first assertion failed with "expected ... to have property health.sub.auto.on_one". It passes after the fix.

## Fix (the reviewer's proposal was correct)

- en.json: `health.sub.auto.on` became `on_one`/`on_other`, and `setup.auto.expiring` became `expiring_one`/`expiring_other`.
- he.json: the same keys became `_one` ("יום אחד"), `_two` ("יומיים") and `_other` ("{{count}} ימים"), worded like the
  sibling `auto.state.on_*` and `activity.stateOn_*` keys.
- I did not change any call site, because i18next resolves the plural suffix from `count`. Count 0 (`Math.max(0, ...)`)
  falls into `_other` in both languages ("0 days" / "0 ימים"), the same as before.

## Verification

- Ran vitest over src/shared, src/renderer/src/i18n.usage.test.ts, src/renderer/src/components,
  src/renderer/src/views/settings, App.v2.test.tsx and notifications.v2.test.ts. Everything passed (1379 tests)
  except 4 tests in AutomaticMode.test.tsx: precondition, refused enable, refused resume and refused endShadow.
  - Another agent is building those right now. That file and the `auto.refused.*` / `auto.confirm.checkboxCancels` keys
    appeared in en/he.json while I was working. They fail on missing testids (`auto-precondition`, `auto-refused`,
    role=alert), not on these strings.
  - The AutomaticMode "ends in" line test (line 266) passes.
- App.v2 test "{ view: 'activity' } opens Settings": it failed once in a parallel batch run. It passed in 3 of 3 solo
  runs and in the later batch, so I'm treating it as timing flake and not related to this change.
- Prettier check on src/shared/locales: clean. eslint on src/shared/locales: clean.
- Repo-wide `npm run lint` has 1 error in App.tsx (react-hooks/set-state-in-effect), from another agent's in-progress
  edit. `npm run typecheck` has errors only in src/main/mcp/googleAuth.test.ts (`persistAccount`), also another agent's
  work. Neither touches my files.

## Caveat for the orchestrator

- To compare against baseline I briefly ran `git stash push -- <my 3 files>` / `git stash pop`. Because of
  core.autocrlf, that left the files with CRLF, and I converted them back to LF (prettier is clean again).
- The concurrent agent's additions to en/he.json are intact in the working tree. Even so, the orchestrator should
  confirm their keys are still present: `auto.refused.*`, `auto.confirm.checkboxCancels`/`cancels`/`anyHour`/`quietCustom`.
