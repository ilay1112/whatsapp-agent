# closeout-e2e - v2 close-out, e2e alignment and run (2026-10-04)

Agent label: closeout-e2e (workflow wa-agent-v2-closeout). Owned: tests/e2e/**, playwright.config.ts, scripts/mark-e2e-build.mjs.
Edited no src/**, no tests/fakes/**, no board / progress / decision file. Nothing committed. Only the fakes ran (system node.exe);
no vendor binary, bridge, packaged app or external service was touched.
Note: the task named `ops/agent-notes/closeout-main.md`; that file does not exist - the main close-out notes are
`ops/agent-notes/v2-closeout-src-main.md` (read instead).

## Changes

1. `tests/e2e/cli-connect.spec.ts` (8) experimental Gemini: the stale soft `agy-workspace-diff toBeVisible` is replaced by HARD
   assertions of the isolated-mode outcome: `agy-workspace`, `agy-workspace-diff`, `agy-workspace-allow` all absent. Basis:
   D-063 (agy runs in the isolated `<userData>\agy-home` profile by default, F3) + the v2 repair of REQUEST 9
   (`compose.ts`: `cliStatus.recordWorkspaceTrusted(true)` when `AGY_PROFILE_MODE === 'isolated'`). Unchanged hard checks:
   user's settings.json byte-identical, no backup, zero `agy_workspace` dialogs, "Use Gemini" enabled, consent with Terms date.
   Header comment updated. This is a stronger test than before (soft -> hard), not a weaker one.
2. `tests/e2e/helpers/fakes.ts` `mcpChild(ctx, label, seed?, userDataDir?, opts={control?})`: with `control:true` the child gets
   `calendarControlArgv(<fresh random secret>)` (ephemeral 127.0.0.1 port). New `McpChild.control(timeoutMs?)`
   (= `waitForCalendarControl(journalFile, secret)`, latest child wins after a respawn) and `controlVerb(verb, args)`
   (= `calendarControl`). Without `control:true`, `control()` rejects with a clear message. The secret is NOT pushed to the
   sentinels (it is a test-only value; the fake already journals it as `[REDACTED]`).
3. `tests/e2e/helpers/auto.ts` `launchAutoWorld(..., opts={calendarControl?})` passes it through.
4. `tests/e2e/undo.spec.ts` new case "a Google-side edit before Undo => blocked_changed, nothing written":
   automatic create via `enableAutoViaUi()` (chat 8) -> baseline readback recorded -> `userEditsInGoogle {summary}` over the
   control channel -> Undo in the AutoStrip -> `auto_writes.undo_state = blocked_changed`; AutoStrip row `data-state`
   blocked_changed + the short line; card Undo door `undo-state-<item>` blocked_changed + the full UX2 6.4 sentence, no Undo
   button; after 2 s: zero update-event / delete-event, no extra create, `undo_action_id` NULL, no `update_event` action on the
   item, Google's copy (control `state`) keeps the user's summary, status confirmed and the etag of the user's edit.
   Why the AUTOMATIC path: `blocked_changed` is an `auto_writes.undo_state` (B10 pre-check for automatic undo); a manual undo
   goes through the normal executor gates (drift => needs_confirm_drift), which edit-change.spec covers.

## Run results (raw logs: `ops/agent-notes/closeout-e2e/`)

| Step | Exit | Result |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.tests.json` | 0 | clean |
| `npx eslint tests/e2e --max-warnings 0` | 0 | clean; prettier clean on the 4 edited files |
| `npm run build:e2e` (build-e2e.txt) | 0 | `out\.e2e-build` marker written |
| `npm run test:e2e` (e2e-run1.txt, rebuilds first) | 0 | **47 passed / 0 failed / 0 flaky** (46 before + the new undo case), 4.6 min, no retry used |

Previously red, now green with no test change other than (8): `cli-connect` (7b), (7c), (9) (jobRunner shutdown latch,
v2-closeout-src-main #3) and `undo.spec` manual reschedule (soft 15:00 check; ItemList keyed by item id, closeout-renderer).
`cli-connect` (8) green with the isolated-mode assertions. The new blocked_changed case passed first time (8.9 s).

## Notes for the orchestrator
- T2 10 row `cli-connect.spec.ts` (8) still describes the workspace-trust diff / backup; it applies only to the global-profile
  fallback. Doc owner may amend it to cite D-063 / F3 (the spec now does).
- `undo.spec` manual case keeps its 15:00 check SOFT (unchanged); it is now green, so it could be made hard in a later round.
- `out\` is an e2e build now; run `npm run build` before any packaging step.
