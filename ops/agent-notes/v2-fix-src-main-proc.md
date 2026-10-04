# v2-fix-src-main-proc: agent notes

Task: fix the confirmed finding **cli-sandbox-4** (minor) in `src/main/proc/jobRunner.ts`: a descendant of a job that exits normally is never killed and never recorded.

## Verdict
The finding is real. I reproduced it with real processes (system node.exe only) before touching the code. The new test failed: the detached grandchild was still alive after `jobs.run()` resolved. **Fixed.**

## Fix (src/main/proc/jobRunner.ts, additive only)
- **Post-exit orphan sweep.** On every job `'exit'` (normal or killed), the runner reads the Win32_Process table once. It then tree-kills, BY PID (`killPid(pid, true)`, which runs `taskkill /PID /T /F`), every process that meets all three conditions:
  - its `ParentProcessId` is the dead job's pid;
  - its `CreationDate` lies within `[Date.now() before spawn, Date.now() at 'exit']`;
  - it is neither the job pid nor the app's own pid.

  Windows never reparents orphans, so this finds the vendor helper. It never kills by image name, so a claude.exe the user runs interactively on the same PC is safe.
- **Pid-reuse guard.** The creation-time window does this job:
  - A row created before the job started belongs to an EARLIER holder of the pid (a stale ParentProcessId).
  - A row created after the exit belongs to a LATER holder.

  The window uses the wall clock (`Date.now`), not the injected `now`, because it is compared against OS creation times.
- **`job.done` (and so `run()`) waits for the sweep.** The tree is gone when the run is over. `killAll()` (the quit path) also waits for in-flight sweeps.
  - A background sweep was tried in design and rejected. It leaves a tracked `powershell.exe` running at test end, which the T7 leak guard rejects. It would also let concurrent sweeps pile up.
- **Process table query (`createWindowsProcessTable`).** It is a single `powershell.exe` call with `shell:false` and `windowsHide`.
  - The argv is constant (`JOB_SWEEP_PS_ARGS`): no pid or path is ever appended or interpolated.
  - It is bounded by `JOB_SWEEP_QUERY_TIMEOUT_MS` (5 s, then the query is killed) and an 8 MB output cap.
  - Any failure (spawn error, timeout, unparsable output) means the sweep kills nothing and logs `job_orphan_sweep_failed`. The job itself never fails.
  - Kills are logged as `job_orphans_killed {kind, count}`, with no pids and no names.
- **Default wiring.**
  - The production defaults (no `proc.spawn` injected, win32) get the real table.
  - If `proc.spawn` is injected (fake pids), there is NO default sweep. A real-table sweep for children of fake pid 4001 could kill an unrelated real process.
  - `processTable: null` disables the sweep explicitly.
  - `compose.ts` needs no change: it never injects `jobProc` in production.
- **Scope: kind `cli` only (`JOB_SWEEP_KINDS`).** I first applied the sweep to every kind. The full suite then showed the cost: `tests/security/media-text-isolation.test.ts` runs 25 real fake-whisper jobs per test, and with roughly 1 s of PowerShell per job, 10 voice batches failed on `h.settle()`. The reasons for limiting the sweep to `cli`:
  - whisper-cli.exe is our own SHA-pinned single-process binary, and its env is secret-free (`WHISPER_ENV_KEYS`).
  - The finding concerns the opaque vendor CLIs (agy, claude) and the S3 `WCA_MCP_TOKEN`.
- **Production cost.** Each claude or agy run takes about 1 s more, while the `cli` mutex is held. Those runs take many seconds anyway.

## Reviewer's proposed fix vs. this one
- I agree with "enumerate by ParentProcessId after exit" and added the pid-reuse guard the verifier asked for.
- I tree-kill only the DIRECT children of the dead job. Their own subtrees go via `/T`, because the child is alive. This is consistent with the B2 "taskkill /PID /T /F" rule.
- I did not add the proposed e2e assertion. I did not run e2e. The colocated real-process test covers the same property at lower cost: real job, real detached grandchild, real PowerShell table, real taskkill, plus a bystander that must survive.
- **Residual (documented in code).** Suppose a grandchild's own parent (an intermediate helper) also exited before the job did. The grandchild's ParentProcessId then names a dead pid that nothing links to the job, so it cannot be found after the fact. Closing that gap would need a Windows Job Object, which means a native dependency, and new npm dependencies are forbidden.

## Tests (written first; red before the fix: 13 failed, including the real-process scenario)
- `src/main/proc/jobRunner.orphans.test.ts` (new, 17 tests) covers:
  - `selectJobOrphans`: the window boundaries; stale and late rows; never self or the job pid; dedupe and sort.
  - `parseProcessTableJson`: the PS 5.1 `/Date(ms)/` shape and the PS 7 ISO shape; malformed rows are skipped; garbage gives null.
  - `createWindowsProcessTable`: constant argv (no `$args` or `--`), `shell:false`, `windowsHide`; rejects on a spawn error or garbage; the timeout kills the query.
  - The runner:
    - after exit 0, only the in-window child is tree-killed;
    - `done` waits for the sweep;
    - `killAll` waits for the sweep its kill started;
    - a failed query kills nothing, is logged and never fails the job;
    - a rejecting taskkill is swallowed;
    - an injected fake spawn means no sweep;
    - `null` disables the sweep;
    - voice jobs are never swept.
  - Production defaults (win32): the reviewer's scenario as an S3-env `cli` job. The detached grandchild is dead after `run()`, `job_orphans_killed {cli, 1}` is logged, an unrelated node sleeper started by the test survives, and no pid file remains.

## Verification (2026-10-04)
- `npx vitest run`, full suite: **323 files passed, 7522 passed, 1 expected fail, 1 skipped**.
  - An earlier full run had 8 red files in exec/, renderer and runner.test. They were mid-edit by other agents and all passed on re-run. Only media-text-isolation was mine; the `cli`-only scope fixed it.
- `npm run lint`: 0. `npm run typecheck`: 0. `prettier --check src/main/proc`: clean.

## NEW defect found in passing (not fixed: outside this finding, not reviewer-confirmed). Please route it.
**The startup reaper's production process query can never succeed** (`src/main/proc/reaper.ts`, `PS_QUERY_ARGS` together with `createWindowsProcessQuery`).
- It runs `powershell.exe -NoProfile -NonInteractive -Command '<script using [int]$args[0]>' -- <pid>`. With `-Command`, PowerShell joins EVERY token after it into the script text. So `$args[0]` is empty, and the script ends `... | ConvertTo-Json -- <pid>`.
- Reproduced from node with `spawnSync('powershell.exe', [...PS_QUERY_ARGS, '--', String(pid)], {shell:false})`:
  - exit status 1;
  - stderr: "ConvertTo-Json : The input object cannot be bound to any parameters...";
  - stdout: empty.
- `parseProcessJson` therefore returns null, `query()` resolves null, and the reaper never matches or reaps any orphan (supervised children or jobs).
- `reaper.test.ts` only exercises a fake spawn, so this was never caught.
- Suggested fix: a constant script with no arguments, filtered in JS (as `JOB_SWEEP_PS_ARGS` does here), or a validated-integer pid inside the script text. Add a real-PowerShell test against the test runner's own pid.
