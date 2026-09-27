# fix-src-main-mcp — repair notes

Label: `fix-src-main-mcp`. Date: 2026-09-23. Phase 3 (repair + adversarial review).
Assigned finding: **process-lifecycle-3 [major]** — `src/main/mcp/host.ts:431` (`host.stop()` drops the
Supervisor's exit callbacks, so every quit / stop of `calendar-mcp` stalls the full 3 s grace window and
then fires an unverified `taskkill /PID <pid> /T /F`).

Verdict: **CONFIRMED and FIXED.** Both halves of the reviewer's proposed fix were needed; I implemented
the first half as proposed and the second half with one deliberate deviation (see section 3).

---

## 1. What was actually wrong

The chain in the finding holds line for line against the real code:

1. `childSpec().start()` returns a `ChildHandle` whose `kill` is `() => void host.stop()` and whose
   `onExit` pushes into the module-level `exitCbs`.
2. `host.stop()` did `exitCbs = []` — reassigning a *fresh* array, so the callback the Supervisor pushed
   was discarded, not invoked.
3. `teardown()` sets `client = null` **before** `await c.close()`, so the SDK's `c.onclose` handler
   short-circuits on `if (client !== c) return;`. That path could not have fired the exit either, so the
   clearing at step 2 was not even the only leak — it was the second of two.
4. `supervisor.killChild` therefore never saw `waitForExit` resolve; `Promise.race` was always won by the
   grace timer, and it ran `processQuery.kill(pid, true)` unconditionally.

Nothing in production calls `mcpHost.stop()` outside the Supervisor (`compose.ts` registers
`mcpHost.childSpec()` and quits through `supervisor.stopAll`), so the clearing protected nothing. And
`supervisor.onExit` already distinguishes a deliberate stop from a crash via `e.stopping`, so firing the
callbacks cannot be misread as a crash — I re-checked that refutation angle and it does not hold.

## 2. Fix A — `src/main/mcp/host.ts` (my file, the root cause)

```ts
async stop() {
  await teardown('not_configured');
  for (const cb of exitCbs.splice(0)) cb({ code: null, signal: null });
},
```

* Drains **after** teardown, so the child really is gone before the Supervisor is told.
* `splice(0)` instead of reassignment: a callback fires exactly once, a second `stop()` is a silent no-op,
  and a registration made between the two can still be served. `exitCbs` is now `const`; every drain in
  the module (here and in `c.onclose`) uses `splice(0)`, so the two paths can never double-fire.
* Nothing else in `host.ts` changed. `teardown()`'s `client = null`-before-`close()` ordering is left
  alone on purpose: it is what makes a *stale* client's `onclose` harmless, and `host.test.ts` pins that.

## 3. Fix B — `src/main/proc/supervisor.ts` (the external-harm guard)

Fix A stops the calendar-mcp path from ever reaching the escalation, but the escalation itself was the
part with real external blast radius: `taskkill /T /F` on a bare pid, 3 s after we last saw the process,
takes the tree of whatever now holds that pid. `killChild` now consults a `taskkillVeto(e, handle)` first:

| veto | condition |
|---|---|
| `bad_pid` | `pid <= 0`, non-integer or `>= MAX_PID` (`handle.pid` is `childPid ?? 0` for the MCP and `child.pid ?? -1` for a spawned child) |
| `exe_mismatch` | `Win32_Process.ExecutablePath` is not `handle.exePath` |
| `created_after_start` | `CreationDate > entry.startedAt + PID_REUSE_TOLERANCE_MS` (2 s) |

A veto logs `proc_taskkill_skipped {name, pid, reason}` and skips the kill; the synthesised exit still
runs, so the entry can never wedge in `stopping`. `Entry` gained `startedAt`, which `writePidFile` now
records (the same value it writes to the pid file).

**Deviation from the reviewer's proposal, and why.** The reviewer asked for "only taskkill when the row
still matches". Taken literally that means *positive confirmation required*, and it is wrong here: the
Supervisor's own default `ProcessQuery` (`createTaskkillOnlyQuery`) has `query: () => Promise.resolve(null)`
by design — the Win32 lookup belongs to `proc/reaper.ts`. Requiring a matching row would silently disable
the escalation for every consumer on that default (and on any box where the PowerShell lookup fails),
leaving real orphan bridges and llama-servers alive holding ports and the user's WhatsApp session. So the
rule is **veto on contradiction, not on absence of proof**:

* a row that contradicts us → skip (this is the recycled-pid hazard, and production wiring —
  `index.ts:197` injects `createWindowsProcessQuery` — does return a row for a live recycled pid);
* `query()` returns `null` (pid gone, or lookup unavailable) → proceed; `taskkill` against a dead pid is
  a no-op error, so nothing is harmed;
* `query()` throws → treated as `null`.

Direction of the creation-time test matters: our child was created at or *before* the instant we adopted
its handle, while a recycled pid's process must have been created *after* ours died. So only
`creationDate > startedAt + tolerance` is evidence of reuse. I did **not** use the reaper's symmetric
`Math.abs(...) <= 2s` match: `ChildSpec.start()` resolves after a readiness handshake (calendar-mcp does
`initialize` + `tools/list` + a `manage-accounts` probe; llama polls `/health` for up to 180 s), so a
symmetric window would reject our own child and turn every legitimate escalation into a skip.

`PID_REUSE_TOLERANCE_MS` is declared locally rather than imported from `reaper.ts`, because `reaper.ts`
imports `supervisor.ts` and the dependency must not become a cycle.

## 4. Tests (written red first, then made green)

`src/main/mcp/host.test.ts`
* **rewrote** `stop() closes the client and clears the exit callbacks` → `... and REPORTS the exit to the
  Supervisor (never swallows it)`. The old test asserted `exits` stayed `[]` — it *encoded the defect*.
  It now asserts the exit arrives once, and that a second `stop()` does not re-fire it.
* new: `the handle kill() path reports the exit too` — drives the fire-and-forget `void host.stop()` the
  way the Supervisor actually calls it.
* new `describe('calendar-mcp under the real Supervisor')` — the REAL `createMcpHost` + REAL
  `createSupervisor` + the real `tests/fakes/fake-mcp-calendar` over an InMemoryTransport pair, with a
  virtual clock and a recording `processQuery`. Three tests:
  * a deliberate `stop` resolves **without advancing the clock at all** (no 3 s stall), leaves
    `taskkilled == []` and `clock.pendingCount() === 0`;
  * `stopAll` (the app-quit path) likewise;
  * a transport that exposes no pid is never taskkilled as PID 0.
  These are the direct inversions of the verifier's scratch assertions in
  `ops/agent-notes/verify-process-lifecycle-3.scratch/plc3.test.ts`.

`src/main/proc/supervisor.test.ts` — four new tests under `describe('stop')`: recycled pid with a foreign
image is not killed (and logs `proc_taskkill_skipped`, and still reaches `stopped`); a same-image row
created after our start is not killed; a row that confirms our child **is** killed (the escalation is not
weakened); `pid 0` is never killed. The pre-existing
`escalates to taskkill /PID <pid> /T /F after the grace period` test still passes unchanged — that is the
proof the veto did not turn into a blanket disable.

Runs: `npx vitest run src/main/mcp src/main/proc src/main/app src/main/compose.test.ts` → **15 files,
454 tests, all green**. `npx eslint src/main/mcp src/main/proc` → clean.
`npx tsc -p tsconfig.node.json --noEmit` reports nothing in `src/main/mcp` or `src/main/proc`.

## 5. Concurrency: other agents were editing the same files during this repair

Worth flagging for the orchestrator — I saw live, mid-flight edits by other agents in three files I also
touched, and the tool reported them as on-disk changes between my reads:

* `src/main/mcp/host.ts` / `host.test.ts` — someone added an `ErrorCode` import and a
  `mcpStatusToErrorCode` symbol (the test imported it before the export existed; it exists now).
* `src/main/proc/supervisor.ts` / `supervisor.test.ts` — someone is repairing **process-lifecycle-1**
  (phantom `running` after a synchronous `onExit`) and **process-lifecycle-2** (`ChildHandle.spawnedAt`,
  the spawn instant vs the readiness instant) and widened `parsePidFile` to accept several roots
  (process-lifecycle-9).

My edits are disjoint from theirs at line level and all merged cleanly. One overlap is worth naming: the
`startedAt` line inside `writePidFile` is the exact line process-lifecycle-2 needs. I wrote it as
`handle.spawnedAt` when it is a safe integer `> 0`, else `now()` — which is what their three
`pid-file startedAt (process-lifecycle-2)` tests assert, and all three are green. **If that agent lands
their own version of that line, keep one of the two, not both.**

Transient reds I observed in the full suite that are **not** mine and are in other agents' lanes
(`llm/local/llamaServer`, `bridge/ingest`, `db/repos/actions`, the renderer esbuild transforms,
`tests/security/redaction`, `tests/integration/pipeline-states`, `agent/contextBuilder.test.ts`
typecheck): reported, not touched, not deleted.

## 6. REQUEST to the process-lifecycle-2 owner

`host.ts`'s `childSpec().start()` returns a handle with **no** `spawnedAt`, so `writePidFile` stamps the
readiness instant — which for calendar-mcp is after `initialize` + `tools/list` + the `manage-accounts`
probe. That is harmless for my `killChild` veto (it only vetoes on a creation time *later* than
`startedAt`), but it is exactly the reaper-tolerance problem process-lifecycle-2 is about. The host could
stamp `now()` immediately before `c.connect(t, …)` (the SDK spawns the child inside `connect`). I left it
alone to keep this repair's surface minimal and because the `spawnedAt` design is that agent's to finish.

## 7. Nothing else changed

No new dependency, no version change, no commit, no installer build, no binary executed, no network call.
No approval path was touched — `host.stop()` reports a process exit; it cannot send a WhatsApp message or
write to the calendar. No secrets, phone numbers or message content appear in any file I wrote.

---

## 8. Resumed session — re-verification (2026-09-27)

The previous run was cut off by a usage limit after the repair had landed. On resume I re-checked the
working tree against sections 2-4 above: both fixes are on disk unchanged (`host.ts:471` drains via
`exitCbs.splice(0)`; `supervisor.ts:383/424` has `taskkillVeto` + `proc_taskkill_skipped`), and all the
tests described in section 4 are present and executing.

**Red-first proof (this was the step the cut-off interrupted).** I had written the tests before the fix,
but had not recorded the inverse experiment. Done now, by temporarily reverting each fix in isolation and
restoring it from a backup immediately after:

* Revert Fix A only (`host.ts` `stop()` back to a bare `exitCbs.splice(0)` with no drain) →
  `src/main/mcp/host.test.ts` **4 failed / 56 passed**. The two `calendar-mcp under the real Supervisor`
  stop tests fail by *timing out at ~5 s* — i.e. they reproduce the finding's 3 s grace stall directly,
  not by an assertion technicality.
* Revert Fix B only (`killChild`'s `const veto = await taskkillVeto(e, handle)` forced to `null`) →
  `src/main/proc/supervisor.test.ts` **3 failed / 78 passed** (recycled-image, created-after-start, pid 0).

Worth recording: **`a transport that exposes no pid is never taskkilled as PID 0` still passes with Fix A
reverted.** That is the layering working as intended, not a weak test — Fix A removes the stall, Fix B is
the independent guard on the escalation itself, and the PID-0 case is Fix B's to catch. Neither fix alone
closes the finding; the finding needed both, which is why I implemented both.

Both files were restored from byte-for-byte backups and re-verified after the experiment.

**Final state:** `npx vitest run src/main/mcp src/main/proc src/main/app src/main/compose.test.ts` →
15 files, **454 passed**. `npx eslint src/main/mcp src/main/proc` → clean.
`npx tsc -p tsconfig.node.json --noEmit` → clean (whole main project, not just my lane).
`git diff --stat` → empty, because this module is still untracked (`?? src/main/mcp/`), not because
nothing changed.

### Reds elsewhere in the repo — reported, NOT touched, NOT skipped

`npm run typecheck` and `npm run lint` are both **red at the project level**, entirely outside my lane.
Flagging for the orchestrator; I did not edit another agent's files:

* `src/main/agent/sanitize.test.ts:51` — `error TS1161: Unterminated regular expression literal` (also
  breaks `npm run lint` as a parse error). Cause: the regex literal on that line contains **raw U+2028 /
  U+2029 characters**, which TypeScript treats as line terminators, so the literal never closes. The test
  is about stripping exactly those code points, so the author almost certainly meant the escapes
  `/[\r\n\u2028\u2029]/u`. One-line fix, but it belongs to the `src/main/agent` owner.
* `src/main/agent/sanitize.ts:20` and `:46` — `LINE_SEPARATOR_RE` and `DECIMAL_DIGIT_RE` assigned but
  never used (`@typescript-eslint/no-unused-vars`). Same lane, and plausibly the same half-finished edit.
* `src/main/bridge/ingest.ts:404` — warning: unused `eslint-disable` for
  `@typescript-eslint/require-await`; `--max-warnings 0` promotes it to a failure.

`npm run lint`: 3 errors + 1 warning, all in the three files above. Nothing in `src/main/mcp` or
`src/main/proc`. My lane's own `lint`/`typecheck`/`vitest` are green, so this repair is complete; the
project-level scripts cannot go green until the `agent` and `bridge` owners land their fixes.
