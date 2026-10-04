# v2-closeout-src-main - close-out of the open MAIN-PROCESS defects (2026-10-04)

Scope: src/main/**, tests/helpers/harness.ts, tests/integration/**, tests/security/** (the renderer was closeout-renderer's, in parallel).
Method per defect: a failing test first (each seen red for the stated reason), then the fix, then the surrounding suites. No new
dependency, no version change, no commit. Nothing vendor-owned was executed. The only processes I started were the system node.exe
(test children and the scratch measurements), powershell.exe (the production process queries) and taskkill (by PID, on test children).
Raw gate logs: `ops/agent-notes/v2-closeout-src-main/` (lint-N, typecheck-N, vitest-N; run 1 red, runs 2 and 3 the final pair).

## Results

| # | Defect | Status | Fix | Tests (red first) |
|---|---|---|---|---|
| 1 | auto-mode-8: Resume of a self-paused trial turned real writes on | FIXED, in code AND in the database | Migration **v5 `auto_policy_paused_from`**: column `paused_from` (shadow\|on) written by every pause (= the state it left; the trigger checks it); immutable while paused; trigger refuses paused -> on when paused_from is not 'on', and allows the only way back to shadow (paused -> shadow when paused_from = 'shadow'). Backfill of v4 paused rows: 'shadow' unless a "Turn on now" grant or a trial the user ended (audit `auto_policy_shadow_ended`). Repo: new `setState({state:'resume'})` = paused -> paused_from. `autoPolicy.resume()` uses it; audit detail `{to}`. The old ">= 3 decisions => on" rule and `trialNotEnded` are gone. Only the native dialog ("Turn on now") and auto:endShadow ("Turn on for real") produce `on`. | `autoPolicy.test.ts` (4 app-pause reasons x {resume => shadow, tryAuto stays shadow}, on-policy still resumes on, trial with 2/3 decisions => shadow); `autoPolicies.test.ts` (trigger refusals, paused_from immutable, forged paused_from refused); `migrations.v5.test.ts` (v4 file backfill x3); `tests/security/auto-mode.shadow.test.ts` (through `auto:resume`, unattended + calendar disconnect, zero writes, raw promotion refused) |
| 2 | Startup orphan reaper query always failed | FIXED | `reaper.ts`: the pid travels in the query process's own minimal env (`REAPER_QUERY_PID` + SystemRoot/windir), the argv is a constant script (`$p = [int]$env:REAPER_QUERY_PID; if ($p -le 0) { exit 2 }; Get-CimInstance ... -Filter ('ProcessId=' + $p) ... ConvertTo-Json -Compress`). Never interpolated, never in argv, never `$args`. A hung query is killed after 15 s (`REAPER_QUERY_TIMEOUT_MS`). `inAppClockBase()` moves creation times into the app clock base; index.ts uses it ONLY under the e2e `WCA_NOW` seam (pid files and the supervisor stamp the app clock). | `reaper.real.test.ts` (REAL powershell + taskkill): query(self) = exact exe + creation time; child within 2 s; dead pid => null; reapOrphans kills a node.exe orphan named by `llama.pid.json` AND one named by `job-cli-<uuid>.pid.json`; a same-image node.exe bystander with no pid file survives; a pid file with a mismatching creation time (pid reuse) is discarded, its process survives. Red before: query null, nothing killed. |
| 3 | jobRunner had no shutdown latch; CLI job spawned mid-quit | FIXED + trigger found | `jobRunner.ts`: `closed` latch set synchronously at the top of killAll(); checked in run(), when a queued run reaches the head of the mutex, and in runOnce right before spawn. Refusal = `JobRunnerClosedError` (subclass of JobAbortedError, not a breaker failure, logged `job_refused_closing`). Callers no longer even try: `createCliStatus({closed})` answers the last known status / 'unknown' without probing; `createProviderFactory({closed})` builds nothing and stops an in-flight CLI build before its provider-start smoke; `listAgyModelsNow` returns [] - compose sets `lifecycle.closing` at the top of shutdown(). Also: compose's `stopQueue` step now kills the jobs WHILE it awaits the in-flight run (see trigger 2). | `jobRunner.quit.test.ts` "the shutdown latch" (after killAll, during killAll, queued behind the mutex, voice kind; never spawned, no pid file); `locator.test.ts` closed; `factory.cli.test.ts` closed (2); `tests/integration/quit-cli-job.test.ts` through compose() with the spawned fake claude (2 scenarios) |
| 4 | "Delete all data" left agy-home transcripts | FIXED | `ipc/handlers/data.ts`: `wipeAgyTranscripts()` removes `<userData>\agy-home\.gemini\antigravity-cli\{brain, conversations, history.jsonl, log, cli.log}` when present (only those names); busy entries are counted (`purge_dir_entries_kept`, count only). settings.json (trusted workspace) and the rest of agy-home stay. | `data.test.ts` "[v2-closeout] ... Antigravity isolated profile" (3) |
| 5 | index.ts: no .catch, a MigrationError opened no window | FIXED | new `src/main/app/startupFailure.ts` `reportStartupFailure()`; index.ts `whenReady().then(...).catch(...)`. Before any window: log `startup_failed {reason: <class name>, surface}`, native `dialog.showErrorBox` with the existing copy (`errors.DB_RECOVERY` for MigrationError / DbCorruptError, `errors.INTERNAL` otherwise; system language), killAllSync, `app.exit(1)`. After the window exists: shown + logged, the app keeps running. Never the error text (may carry a path). The DB file is untouched (openDbWithRecovery never starts fresh on a MigrationError). | `startupFailure.test.ts` (6, incl. he, order, throwing box, source lock on index.ts) |
| 6 | B24 correction offer had no change view | FIXED (main side) | `agent/items.ts` `correctionViewOf()`: an item in `created`/`updated` with a PENDING `update_event` of its current proposal whose validated payload has `itemId === targetItemId === item.id`, change reschedule\|move and no revertOf => `change = {kind, from: Google's copy, to: approved content, confidence: 'high', baseRevision}` from the ACTION payload. Matches exactly what closeout-renderer's `correctionOf()` reads (status in_calendar + change + pending update_event in actions). | `tests/integration/correction-offer-view.test.ts`: real executor + reconcile + fake calendar + real ItemService: the view appears; Keep (reject) clears it and the card stays in_calendar; Approve = one PATCH and the view clears; no view on an ordinary card or on the source of a change card. Red before: change null. |
| 7 | auto-mode-5 (from_image => badge_info) | CONFIRMED FIXED (v2-fix-src-main-exec) | no code change | `tests/integration/auto-picture-gate.test.ts`: a REAL orchestrator run (S1 -> S4 over real repos, V1 outcome at its seam) with imagesPassed true writes exactly `['from_image']`, and AutoGate on those persisted facts answers auto/ok; gate closed in AutoGate => media_derived; this build's gates (false) => S4 adds image_unclear => **badge_amber** (correction to v2-fix-src-main-exec's note, which expected media_derived to be the reason shown; media_derived is in the fail list too, badge_info never). |
| 8 | vitest load timeouts (16 in waTools / waReadClient / ingest / pipeline-gates) | FIXED at the root, no timeout raised | Cause: every fake bridge row was its own autocommit into a rollback-journal FILE database (journal created, fsynced, deleted per row). Measured: 300 autocommit rows = 400 ms idle, ~1.8 s with 12 parallel writers; in one transaction 2 ms. Fix: `FakeBridgeDb.batch(fn)` (one transaction, nested calls join; seedBulk uses it) and the seeding sites use it: fake bridge `historySync`, the waTools / waReadClient worlds, the two big ingest loops, the harness `waWorld` option. | Measurement (scratch, 16 parallel disk-load writers, the 4 files only): before 51 s, slowest "pages through more than one batch" **4961 ms of its 5000 ms**; after 18 s, every test < 1 s except the deliberate SQLITE_BUSY test (13 s of its own 20 s budget: four synchronous reads each wait the 2 s busy_timeout by design). |

## Trigger of the mid-quit CLI job (item 3), found and proven

1. **cli-connect (9)** - proven by experiment: the quit kills the hanging "Test" smoke; `cli:test` then calls `status.invalidate()` and
   answers; ConnectCard.runTest immediately does `refresh(provider)` = `cli:getStatus` -> cache empty -> locator probes (`--version`,
   `auth status`) = a NEW job after killJobs. With the follow-up call removed from the test, no job is attempted; with it, the latch
   logged `job_refused_closing`. `providerFactory.invalidate()` at stopChildren clears the same cache, so any renderer status refresh
   during the quit had the same effect.
2. **A pipeline run whose provider-start smoke hangs** (found while reproducing): the smoke's signal is its own wall clock, not the
   queue's abort, so `theQueue.stop()` awaited it and the whole quit ran into its 13 s cap -> `app.exit()` BEFORE killJobs: the smoke
   job and its pid file survived. compose's stopQueue now stops the queue, kills the jobs (latched), then awaits the run.
3. (7b)/(7c) were not re-run (no e2e here). Both paths above plus an in-flight provider build (locate probes killed -> smoke) fit the
   observed "file created after killJobs"; all three are now guarded twice (no attempt + the latch).

## Existing tests whose assertion encoded a defect (revisited, not weakened)
- `autoPolicy.test.ts` "a paused TRIAL resumes only when ... (>= 3 decisions)" asserted resume -> `on` (the defect). Now: resume -> shadow.
- `reaper.test.ts` "passes the pid as its own argv element after `--`" pinned the argv that can never work; same property (pid never
  interpolated) now asserted for the env route. `bridge-invariants.test.ts` `[int]$args[0]` -> `[int]$env:REAPER_QUERY_PID`, no `$args`.
- `migrations.v4.test.ts`, `tests/security/migration-v4.test.ts`: SCHEMA_VERSION 4 pins -> 5 / `SCHEMA_VERSION` / `MIGRATIONS.length`,
  the v4 trigger list + `trg_auto_policies_paused_from`. Every v3 -> v4 data assertion is unchanged.

## Files outside my listed ownership (additive, please note)
- `tests/fakes/fake-bridge-db.ts` (`batch()`), `tests/fakes/fake-bridge.ts` (historySync in one batch). No behaviour change for readers.

## For the orchestrator (decisions / REQUESTS)
1. **Decision record needed (D-079 proposal)**: schema v5 `auto_policies.paused_from` + the v5 trigger text. `docs/specs/v2-contracts.md`
   (auto_policies DDL, Repos.autoPolicies.setState + 'resume') and ARCH-v2 B7 ("resume = back to the confirmed state; a paused trial
   resumes as shadow") should be updated by their owner. An older build opening a v5 file now refuses it (downgrade => DB_RECOVERY).
2. Locale owner: `errors.DB_RECOVERY.body` ("You can restore yesterday's backup...") is what the start-up error box shows for a failed
   migration; a dedicated body ("Your data is unchanged; install the newest version") would be clearer. No key was added by me.
3. Window.ts's documented order is still setQuitting -> stopQueue -> killJobs; in compose the jobs are now killed INSIDE the stopQueue
   step (before awaiting the run). Architecture text may want the same note.
4. The supervisor's taskkill veto (`created_after_start` / `exe_mismatch`) now really runs in production, because the query finally
   answers. That is its design; worth knowing if a stuck child is ever reported.
5. Not done (other lanes / not in this task): e2e cli-connect (8) stale soft assertion (test owner); ux-i18n-v2-5 main guard on
   `settings:set`; REQUEST 4 `auto:listDecisions`; the agy sign-in probe at every launch; `agy-home\AppData` is not wiped (contents
   unknown until M-AGY-1).

## Gate (final pair, back to back, unchanged tree between them)
| Run | lint | typecheck | `npx vitest run` (all projects) |
|---|---|---|---|
| 2 | exit 0 | exit 0 | exit 0 - 329 files, 7587 passed, 1 expected fail (`prompt.size` it.fails), 1 skipped (`golden.live`), 78.3 s |
| 3 | exit 0 | exit 0 | exit 0 - 329 files, 7587 passed, 1 expected fail, 1 skipped, 77.5 s |

Run 1 (before the last fix) was lint 0 / typecheck 0 / vitest 1: `electron-hardening` source lock - my first env name `WCA_REAP_PID`
matched the seam-only `WCA_*` pattern; renamed `REAPER_QUERY_PID`. e2e was not run (task rule). Prettier: every file I touched is clean.
