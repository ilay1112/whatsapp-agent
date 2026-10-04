# v2-reverify - whole-repo re-verification after the v2 repair round (2026-10-04)

Scope: read-only re-verification. Nothing outside this file and `ops/agent-notes/v2-reverify/` was edited. No commit. No vendor
binary, bridge, whisper, llama-server, claude or agy was run; e2e used only the fakes. No installer was built, no GUI started.
Raw output of every stage is in `ops/agent-notes/v2-reverify/` (lint.txt, typecheck.txt, format.txt, vitest.txt, smoke.txt,
e2e.txt, e2e-rerun.txt).

## Results

| Stage | Command | Result |
|---|---|---|
| lint | `npm run lint` | exit 0 |
| typecheck | `npm run typecheck` | exit 0 |
| format | `npm run format:check` | exit 0 (clean) |
| unit/integration | `npx vitest run` (all projects) | exit 0 - 319 files; 7391 passed, 1 expected fail (`prompt.size.test.ts` it.fails, pre-existing), 1 skipped (`golden.live.test.ts`, skipIf !LIVE, user-run only) |
| packaged smoke | `npm run test:smoke` | exit 1 - checks 1, 2, 9 FAIL (environment), all others ok; **check 8 now passes** |
| e2e | `npm run test:e2e` | exit 1 - **43 passed / 3 failed of 46** (baseline 33/46); each failure failed on both attempts (retries 1) |

### Smoke
Check 8 (model manifest pins) is fixed: "the packaged model manifest deep-equals vendor/models.pin.json". Checks 1 and 2 fail with
`spawn UNKNOWN` on `dist\win-unpacked\WhatsApp Calendar Agent.exe` and check 9 depends on check 1's tools/list. Same diagnosis as
`v2-repair-v2-packaging-pins.md`: Windows Smart App Control refuses the freshly packed, unsigned exe (environment, not a product
defect). It still is NOT a pass: it needs a run on a machine without SAC/WDAC enforcement, or a signed build (user decision).

### E2E failures (all deterministic: failed twice in the full run and again in a single re-run with --retries=0)

1. `tests/e2e/undo.spec.ts:87` "a manual reschedule is undone from its card ..." - soft assertion
   `card-2 event-chip-range toContainText('15:00')`, received `17:00-18:00`. Everything else in the spec passed (hidden-window
   undo refused, exactly one PATCH back to 15:00, one undo revision).
   **Product defect (renderer), REQUEST 3 is NOT closed end-to-end.** The main-side repair works: in the kept DB, item 2's current
   proposal is v3 (provider `user`, 15:00-16:00) and `dashboard:get` returns `event.startLocal = ...T15:00` right after the undo
   (verified with a throwaway debug spec in the scratchpad that called `dashboard:get` and dumped the card). The card nevertheless
   stays at 17:00 and shows "This card changed - review again. / Refresh card"; after a page reload it shows 15:00 and "rev 3".
   Root cause: `ItemList.tsx keyOf()` keys `in_calendar` cards by `event-<eventKey>`, so when the event moves from the source item
   (1) to the delta item (2) React REUSES item 1's ItemCard instance. `useCardController` keeps item 1's local `draft` state
   ("old" suggestion, 23 chars) while item 2's suggestion is a different text, so `dirty = draft !== suggestion` is true with no
   user edit (the card already shows "Reset to suggestion" before the undo). A dirty card is pinned by `store/dashboard.ts
   refresh()/mergeColumn` and marked stale, so the undo's refresh never reaches it. Fix direction (renderer owner): key the card
   component by item id (or reset the controller state when `item.itemId` changes) so an event moving between items never inherits
   another item's local draft. This can hit any chain card, not only undo.

2. `tests/e2e/cli-connect.spec.ts:355` "(8) experimental Gemini ..." - soft assertion `agy-workspace-diff toBeVisible`, element
   not found. All hard assertions passed (user's agy settings untouched, no backup, no agy_workspace dialog, "Use Gemini" enabled,
   consent dialog with Terms date).
   **Test expectation now stale (not a product defect).** REQUEST 9 offered two fixes ("record not needed in isolated mode, or hide
   the block"); the main repair recorded `workspaceTrusted: true` in isolated agy mode (F3), so no workspace-trust diff is shown and
   the provider becomes selectable - exactly what REQUEST 9 asked for. The soft check still expects the diff that isolated mode by
   design never shows. The spec (tests/e2e, owner V2-W2-03) needs updating to assert the isolated-mode outcome (no diff, Use enabled)
   - orchestrator decision whether T2 10 (8) is amended accordingly.

3. `tests/e2e/cli-connect.spec.ts:410` "(9) quitting while a CLI job runs ..." - hard error from `E2eContext.quit`:
   `pid files left in run\: job-cli-<id>; job pid files left in run\ (1)`. The job pids the spec saw before the quit are all dead
   (no "survived" leak); `cli-runs\` is empty.
   **Product defect (main), REQUEST 10 NOT closed - and the remaining leak is a different job.** The built bundle contains the
   repaired `killAll()` (removes each killed job's pid file). In the kept userData of the re-run, the leftover pid file and its
   cli-runs dir were CREATED DURING the quit sequence: file mtime 20:57:21.051, while main.log shows calendar-mcp `stopping`
   at 21.039 / `stopped` 21.061 / `quit.exit done` 21.066 - i.e. after `killJobs` and after `supervisor.stopAll`'s own killAll.
   So a NEW CLI job was spawned mid-quit and never killed or cleaned up by the app (its node.exe was gone by the time I checked).
   Root cause class: `proc/jobRunner.ts` has no shutdown latch - `run()` keeps accepting jobs after `killAll()`. The trigger was
   not confirmed; most likely a provider-start smoke / health refresh started by `providerFactory.invalidate()` at the top of
   `stopChildren`, or by the killed smoke's failure handling (candidate: the repair-7 "refreshLlmHealth after every CLI run /
   readiness change" path). Fix direction: a `closing` flag set by killAll that refuses every later `run()` (JobSpawnError /
   aborted) plus a test that a run requested after killAll never spawns. This matters beyond the test: a CLI job started during
   quit can outlive the app (I7').

## Not flakes
No test passed only on retry in the full run (0 flaky). The three failures were re-run once (`--retries=0`) and failed identically.

## Housekeeping
- The single re-run used `E2E_KEEP_TMP=1` to inspect the DB/logs; I removed those three kept `%TEMP%\wca-e2e-*` roots afterwards.
- The throwaway debug spec + config live only in the session scratchpad (not in the repo).
- `npm run test:smoke` rebuilt `dist\win-unpacked` and `out\` (production); `npm run test:e2e` then rebuilt `out\` in e2e mode
  (`out\.e2e-build` marker present). Run `npm run build` before any packaging step that expects a production `out\`.
