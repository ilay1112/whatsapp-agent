# fix - src/main/compose.ts (lifecycle block, compose.start)

Phase 3 repair agent. Scope: the confirmed finding **process-lifecycle-7 [major]**. One finding, fixed.

## Verdict

CONFIRMED and fixed. `compose.start()` guarded only on `isStarted` and never read `quitting`, so a quit that landed
during the multi-tens-of-seconds startup carried on and started the next child after `runQuitSequence`'s stopChildren
pass had already run.

## Failing test first (it really did fail)

`tests/integration/quit-during-startup.test.ts` (new, L3, production `compose()` through the harness - nothing spawns).
Scenario: `start()` is called, and `shutdown()` is called before `start()` resumes from its first await - which is
exactly the tray-Quit window, because `shutdown()` sets `quitting` synchronously.

Against the unfixed code, test 1 failed with the child the finding predicted, plus a detail the finding did not
mention - an armed **respawn**:

```
- []
+ [ 'proc_state name="calendar-mcp" state="starting"',
+   'proc_start_failed name="calendar-mcp" attempt=0 reason="Error"',
+   'proc_crash name="calendar-mcp" code=-1 signal=""',
+   'proc_backoff name="calendar-mcp" attempt=1 delayMs=2012',
+   'proc_state name="calendar-mcp" state="backoff"' ]
```

So on a quitting app the supervisor was not only spawning calendar-mcp after the stop pass, it was scheduling a retry
~2 s later. Test 2 (`start()` called after `shutdown()`) failed with `Error: database is not open` out of
`repos.items.recoverRunning` - `start()` ran its recovery statements against the database the quit sequence had closed.

Both pass after the fix; `proc_state` is logged by `setState` *before* `spec.start()` runs, so the assertion catches the
spawn whether or not the handshake then succeeds.

## The fix (src/main/compose.ts, lifecycle block only)

1. `abortStart(at)` - reads `quitting`, logs `start_aborted_by_quit at=<checkpoint>`, returns true.
2. `start()` checks it at `entry` (before `isStarted = true`), and after every await: `recovery`
   (`executor.recoverOnStartup`), `reconcile` (`reconcileUnknown`), `bridge` (`startBridge`), `children`
   (`supervisor.start('calendar-mcp')`).
3. `startBridge()` returns immediately when `quitting` - that also covers its non-`start()` callers (the
   `consent:accept` side effect and the bridge IPC controls), which had the same hole.

Why the checks cannot be raced: `quitting` is set synchronously at the top of `shutdown()`, and between a check and the
`supervisor.start()` / `launcher.start()` that follows it there is no await (`credentialsExist()` is `fs.existsSync`,
`consents.isCurrent` is a sync statement, and `supervisor.launch` assigns `e.pending` synchronously before `spec.start`
suspends). So a check that passes is in the same microtask as the spawn it authorises.

Why the checks are also *sufficient* for the in-flight case: a child whose start was already in flight when the flag
flipped is collected by `supervisor.stop()`, which awaits `e.pending` before killing the handle. With the guard in
place, `start()` can only be inside calendar-mcp's launch once the bridge launch has returned, so whichever entry
`stopAll` walks past still has `pending !== null` - the STOP_ORDER hazard the skeptic's refutation 1 describes
(stopAll passes a *stopped* calendar-mcp, then start() launches it) is exactly what the guard removes.

## Where I disagree with the proposed fix

- **"keep the start() promise and have shutdown() await it before running stopChildren" - rejected.** The skeptic's
  own note is right that it only moves the abandonment (start() can outlast the 13 s quit budget), and it is worse than
  that: it would make stopChildren block on awaits that cannot spawn anything (`recoverOnStartup`, `reconcileUnknown`),
  turning a currently-fast quit into a 13 s one for no gain. The supervisor's own `pending` rendezvous already covers
  every await that *can* leave a child.
- **A compensating stop after the abort ("undo the child we started late") - written, then deleted.** Any continuation
  of `start()` that runs after `shutdown()` resolves is dead code in production: `index.ts` has
  `try { await runtime.shutdown() } finally { tray.destroy(); killAllSync(); app.exit(0) }` with no await in the
  finally, so the process is gone before the continuation could run. I removed it rather than ship an untestable
  branch that pretends to close a hole it cannot reach.

## Residual, NOT fixed here (belongs to src/main/proc/supervisor.ts + bridge/launcher.ts - REQUEST to their owners)

The part of the skeptic's analysis my file cannot close: while `spec.start()` is pending the OS child already exists,
but `e.handle` is null and no pid file has been written (`supervisor.ts` assigns both only after the handshake, at
~441-442). So if `runQuitSequence` hits its 13 s timeout while `stopAll` is rendezvousing with an in-flight launch,
`killAllSync()` kills nothing and the reaper (which walks `*.pid.json` only) cannot collect it next boot -
ARCHITECTURE 118 / 596 ("children become orphans, reaped at next start", "the reaper is mandatory") is still defeated
on that path. The fix is in the supervisor: record pid/handle (or write the pid file) the moment the OS process
exists, or give `spec.start` an abort signal. My guard removes the *common* case (the child started after the pass);
it does not remove the timeout case, and I did not want to edit another owner's file for it.

## Files touched

- `src/main/compose.ts` - lifecycle block only (`abortStart`, four checkpoints, `startBridge` guard).
- `tests/integration/quit-during-startup.test.ts` - new, 2 tests.
- `tests/helpers/harness.ts` - additive option `autoStart?: boolean` (default unchanged: the harness still awaits
  `app.start()`). It is the only way to observe a quit that lands *while* `start()` is in flight.

## Verification

- `npx vitest run tests/integration/quit-during-startup.test.ts` - 2 passed (both red before the fix).
- `npx vitest run --project integration --project security` - 29 files, 644 passed.
- `npx vitest run --project main src/main/proc src/main/app src/main/bridge/launcher.test.ts src/main/mcp` - 514 passed.
- `npx eslint` + `npx prettier --check` + `tsc -p tsconfig.node.json` on the touched files - clean.

**Red tests I did NOT cause, reported as required:** a full `--project main` run is currently 4-5 red in
`src/main/agent/contextBuilder.test.ts`, `src/main/bridge/bridgeDb.test.ts`, `src/main/bridge/ingest.test.ts`, and
`src/main/agent/sanitize.test.ts` fails to load at all (`tsc -p tsconfig.tests.json` reports
`sanitize.test.ts(51,12): TS1161 Unterminated regular expression literal`). Those files were being written while I ran
(mtimes inside my own session window) - another repair agent is mid-edit. None of them import `compose.ts` or
`tests/helpers/harness.ts`; `ingest.test.ts` has a local function called `harness()`, unrelated. Nothing of mine
touches them, and I did not modify, skip or weaken any of them.

## Re-verification after the session resumed (2026-09-27)

The fix and both tests were already on disk from the interrupted session; nothing was lost and nothing needed
re-doing. Re-ran the whole verification set against the current tree:

- `npx vitest run tests/integration/quit-during-startup.test.ts` - 2 passed.
- `npx vitest run --project integration --project security` - 29 files, 644 passed.
- `npx vitest run --project main src/main/proc src/main/app src/main/bridge/launcher.test.ts src/main/mcp` -
  16 files, 516 passed.
- `npx eslint` + `npx prettier --check` on `src/main/compose.ts`, `tests/integration/quit-during-startup.test.ts`,
  `tests/helpers/harness.ts` - clean (exit 0).
- `npx tsc -p tsconfig.node.json --noEmit` - no error in `compose.ts`.

**Red outside my scope, still reported, still untouched by me:**
- `npm run lint` (repo-wide) fails: `src/main/agent/sanitize.test.ts:51` parse error (unterminated regex),
  `src/main/agent/sanitize.ts` two unused consts (`LINE_SEPARATOR_RE`, `DECIMAL_DIGIT_RE`), plus a stale
  eslint-disable warning in `src/main/bridge/ingest.ts:404`.
- `npx tsc -p tsconfig.node.json --noEmit`: `src/main/ipc/handlers/data.ts(15,12) TS2554: Expected 4 arguments,
  but got 3` - this one is **new** since my first run; another owner's in-flight edit.
- `npx tsc -p tsconfig.tests.json --noEmit`: the same `sanitize.test.ts` parse errors.

None of these files import `compose.ts` or `tests/helpers/harness.ts`. I did not modify, skip or weaken any of them.
