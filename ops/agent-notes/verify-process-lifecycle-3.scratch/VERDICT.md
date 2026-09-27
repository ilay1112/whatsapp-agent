# process-lifecycle-3 - CONFIRMED (severity corrected blocker -> major)

Traced end to end in the real code and reproduced with the REAL createMcpHost + REAL createSupervisor
(plc3.test.ts in this dir, run with vitest.scratch.config.ts; scratch only, not part of `npm test`).

Chain:
1. src/main/mcp/host.ts:450  handle.kill = `() => void host.stop()` (not awaited).
2. src/main/mcp/host.ts:431  stop() does `exitCbs = []` BEFORE teardown.
3. src/main/mcp/host.ts:292  teardown sets `client = null` before `await c.close()`,
   so the onclose handler at :385 short-circuits on `if (client !== c) return;` - nothing left to fire anyway.
4. src/main/proc/supervisor.ts:349-362  waitForExit never resolves -> Promise.race is won by the grace
   timer -> `processQuery.kill(pid, true)` = `taskkill /PID <pid> /T /F`, with no query()/identity check and
   no `pid > 0` guard (killAllSync at :548 has that guard; killChild does not).
5. Production wiring: compose.ts:1224 registers mcpHost.childSpec(); compose.ts:1284 stopAll on every quit
   with QUIT_CHILD_GRACE_MS = 3_000 (src/main/app/window.ts:158).

Scratch run output:
- stop(calendar-mcp): host.status() == 'not_configured' (child already gone) and still
  taskkilled == [{pid: 9001, tree: true}] 3 s later.
- transport without a pid: taskkilled == [{pid: 0, tree: true}].
- control: a server-side close (real crash) DOES reach the supervisor (state 'backoff', no taskkill),
  so only the stop path loses the exit signal.

Severity: not blocker. No approval bypass, no WhatsApp/calendar write, no app data loss, app stays usable
(the exit is synthesised at supervisor.ts:363 and the state reaches 'stopped'). It is a broken requirement:
every quit/stop of calendar-mcp stalls 3 s and then force-kills a PID the supervisor has not verified, with
/T - the exact hazard the reaper guards against (reaper.ts:161 queries ExecutablePath/CreationDate first).
Windows PID recycling inside that 3 s window would tree-kill an unrelated process. => major.
