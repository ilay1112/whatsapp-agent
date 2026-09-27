# Adversarial code review — lens `process-lifecycle`

Reviewer label: `review-process-lifecycle`. Date: 2026-09-23.
Scope: the three managed children (bridge, calendar-mcp, llama) and the app lifecycle — supervisor
backoff/breaker arithmetic, the PID-file reaper, port selection, orphans after a hard crash or logoff,
the doorbell server, spawn invariants, token/port rotation on respawn, shutdown ordering and the
tray/window/quit sequence.

Files read: `src/main/proc/{supervisor,reaper,freePort}.ts`, `src/main/bridge/{launcher,doorbell,invariants}.ts`,
`src/main/mcp/host.ts`, `src/main/llm/local/llamaServer.ts`, `src/main/app/{window,tray}.ts`,
`src/main/index.ts`, `src/main/compose.ts`, `src/main/paths.ts` and the neighbouring `*.test.ts`.

**No product file was edited.** Proof tests live in
`ops/agent-notes/review-process-lifecycle.scratch/` (outside `tests/`, not part of `npm test`):

```
npx vitest run --config "ops/agent-notes/review-process-lifecycle.scratch/vitest.scratch.config.ts"
```

`lifecycle.test.ts` (3 tests) and `bridge-double-spawn.test.ts` (1 test) all pass — they assert the
**defective** behaviour, so a green run is the proof that findings 1–4 are real. Turn each assertion
around to get the regression test the fix needs.

---

## process-lifecycle-1 — a synchronous `onExit` wedges the supervisor in a phantom `running` state (blocker)

`src/main/proc/supervisor.ts:399-451` (`startEntry`), triggered by `src/main/llm/local/llamaServer.ts:323-329`.

`llamaServer`'s `ChildHandle.onExit` invokes the callback **inline** when the process has already died:

```ts
onExit: (cb) => {
  if (exitInfo !== null) { cb(exitInfo); return; }   // synchronous, inside startEntry
  exitListeners.push(cb);
},
```

`startEntry` calls `handle.onExit(...)` *before* `setState(e, 'running')`:

```ts
e.handle = handle;
writePidFile(e, handle);
handle.onExit((info) => onExit(e, generation, info));   // <- may run onExit() right here
setState(e, 'running');                                  // <- then overwrites the state it just set
e.stableTimer = clock.setTimeout(...);
scheduleProbe(e);
```

The inline `onExit` does its full crash bookkeeping (`e.handle = null`, `e.generation += 1`,
`setState('backoff')`, backoff timer armed) and returns; `startEntry` then unconditionally overwrites
the state with `'running'`. The entry is now `state === 'running'` with `handle === null`.

Failure scenario: llama-server answers `GET /health` 200 and dies immediately afterwards (OOM on the
first real prompt-sized allocation, Vulkan device lost, VC++ CRT unload). `ensureStarted()` resolves,
`childSpec.start()` reads `child`, returns the handle; the `exit` event lands in the microtask gap
before the supervisor attaches. Then:

* the armed backoff timer fires → `launch()` → `startEntry` → `if (e.state === 'running') return;` → **refused**;
* `scheduleProbe` runs, the probe misses 3×, calls `killChild(e, …)` → `if (!handle) return;` → **no-op**;
* `supervisor.state('llama')` reports `'running'` forever, so `healthHub`/tray show a healthy local LLM;
* every later `supervisor.start('llama')` is refused for the same reason.

Proof: `lifecycle.test.ts` › `process-lifecycle-1`.

Fix: in `startEntry`, capture the generation *after* attaching and re-check it, e.g. set the state and
arm the timers first and only then call `handle.onExit(...)`, or defer the callback
(`queueMicrotask`) and bail out of the rest of `startEntry` when `e.generation !== generation`.
Belt and braces: make `llamaServer`'s `onExit` always asynchronous.

---

## process-lifecycle-2 — `PidFile.startedAt` is stamped after readiness, so the reaper can never match `CreationDate` (blocker)

`src/main/proc/supervisor.ts:248-259` (`writePidFile`) vs `src/main/proc/reaper.ts:105-109` (`matches`) and
`src/main/compose.ts:206` (`REAPER_TOLERANCE_MS = 2_000`).

`writePidFile` records `startedAt: now()` — the instant `spec.start(attempt)` **resolves**. Both
spawning specs only resolve after a readiness handshake:

* `llamaServer.childSpec().start` awaits `ensureStarted()`, which polls `GET /health` until 200 with a
  **180 s** budget (`LLAMA_READY_TIMEOUT_MS`, `llamaServer.ts:53`). A cold multi-GB gguf takes tens of seconds.
* `launcher.childSpec().start` awaits `waitForReadiness`, budget **10 s** (`launcher.ts:66`).

The reaper then demands `Math.abs(info.creationDate - file.startedAt) <= 2000`, where `creationDate`
is the real `Win32_Process.CreationDate`. The two numbers differ by the whole readiness time.

Failure scenario: the app is hard-killed (power loss, `TerminateProcess`, a Windows logoff that
outruns `session-end`) while llama-server is serving. Next boot, `reapOrphans` reads
`<userData>\run\llama.pid.json`, queries the still-live PID, gets `creationDate = spawn − 45 s`,
decides `stale`, logs `reaper_pidfile_stale`, **deletes the pid file and kills nothing**. The orphaned
`llama-server.exe` keeps the model resident in RAM/VRAM forever, and the new instance spawns a second
one beside it. The guard is effectively dead code for llama and unreliable for the bridge (any cold
start, first-run SQLite migration or slow disk pushes readiness past 2 s).

Proof: `lifecycle.test.ts` › `process-lifecycle-2` (45 s of drift, `killed == []`, `stalePidFiles == 1`).

Fix: have `ChildHandle` carry the spawn instant (`spawnedAt`, taken at `cp.spawn()` / `deps.spawn()`
return, not at readiness) and write *that* into the pid file; the ±2 s window is then meaningful.
All three specs already know the value — `launcher.ts:564` sets `startedAt = deps.clock.now()` right
after the spawn and simply does not pass it on.

---

## process-lifecycle-3 — stopping `calendar-mcp` always force-kills a PID that has already exited, unverified (blocker)

`src/main/mcp/host.ts:429-432` + `:450` and `src/main/proc/supervisor.ts:343-364` (`killChild`).

The handle the supervisor holds is:

```ts
kill: () => void host.stop(),
onExit: (cb) => { exitCbs.push(cb); },
```

and `host.stop()` is:

```ts
async stop() {
  exitCbs = [];            // <- drops the supervisor's exit callback
  await teardown('not_configured');
}
```

`teardown` sets `client = null` **before** `await c.close()`, so the `c.onclose` handler
(`host.ts:390-396`, the only other place that fires `exitCbs`) short-circuits on `if (client !== c) return;`.
Net effect: the supervisor's `onExit` is never called on this path, `waitForExit(e)` never resolves,
and `killChild` runs its full escalation every single time:

```ts
await Promise.race([exitedPromise, grace.promise]);   // grace always wins
...
log('proc_taskkill', { name, pid });
await processQuery.kill(pid, true);                   // taskkill /PID <pid> /T /F
```

Failure scenario: every app quit and every `supervisor.stop('calendar-mcp')` / `restart`. The stdio
transport's `close()` already terminated the child cleanly; 3 s later the app issues
`taskkill /PID <pid> /T /F` against a PID Windows is free to have handed to an unrelated process —
and `/T` takes that process's children with it. Nothing in `killChild` re-verifies the target: unlike
the reaper, it never calls `processQuery.query(pid)` to compare `ExecutablePath`/`CreationDate`
before force-killing. `ProcessQuery.query` is available on the very object it uses.

Aggravating detail on the same line: `handle.pid` is `childPid ?? 0` (`host.ts:448`), and `killChild`
does not guard `pid > 0` (`killAllSync` at `:548` does), so a transport that exposes no pid produces
`taskkill /PID 0 /T /F`.

Proof: `lifecycle.test.ts` › `process-lifecycle-3` — the child is dead (`alive === false`) and
`taskkilled == [{ pid: 9001, tree: true }]` anyway.

Fix: (a) make `host.stop()` fire `exitCbs` (or move the drain after `teardown`) so the supervisor sees
the clean exit; (b) in `killChild`, before escalating, `await processQuery.query(pid)` and only
`taskkill` when the row still matches the child's `exePath` and creation time — and skip when `pid <= 0`.

---

## process-lifecycle-4 — "New QR code" / "Relink" / "Unlink & wipe" spawn a second bridge and orphan the first (blocker)

`src/main/compose.ts:977-992` (`bridgeControl`), `src/main/bridge/launcher.ts:688-718`
(`restartForNewCode` / `relink` / `unlinkAndWipe`) and `:502-612` (`spawnOnce`).

`compose` routes the three user actions as `stopBridge()` → `launcher.<action>()` → `startBridge()`.
But `launcher.restartForNewCode()` (and `relink`, `unlinkAndWipe`) end in `await launchLoop()`, which
calls `spawnOnce()` directly — the launcher's own, **unsupervised** spawn path. There is no
`if (supervised) return;` guard on those three methods (unlike `respawn()` at `:334-344`, which has one).
`startBridge()` then calls `supervisor.start('bridge')` → `childSpec().start()` → `spawnOnce()` a second
time. `spawnOnce` has no "am I already running" check, and neither does
`assertBridgeSpawnInvariants` — there is no `already_running` violation in `SPAWN_VIOLATIONS`.

`spawnOnce` overwrites the module-level `child` with the new process, so the first one loses its only
reference:

* two `whatsapp-bridge.exe` processes run at once against the **same** `<userData>\bridge\store\whatsapp.db`
  (two whatsmeow clients on one device session, plus SQLite contention);
* the first has **no pid file** (only the supervisor writes those), so `killAllSync()` cannot reach it
  and the reaper will never learn about it — it survives the app's exit and every later boot;
* `spawnOnce` rotated the doorbell secret (`deps.doorbell.rotateSecret()`, `:515`) for the second
  process, so the orphan's webhooks now hit `/hook/<old-secret>` and are 404'd by the doorbell.

Proof: `bridge-double-spawn.test.ts` — after the exact `compose` sequence, three spawns happened and
PIDs 2001 and 2002 are both alive.

Fix: make `restartForNewCode` / `relink` / `unlinkAndWipe` mutate state only (audit, delete the store
file, `resetBreaker()`) and let the caller restart through the supervisor — i.e. the same
`if (supervised) return;` early-out `respawn()` already uses. Add an `already_running` spawn invariant
as a backstop.

---

## process-lifecycle-5 — the llama breaker and backoff are silently bypassed, and the bypassed child gets no pid file (major)

`src/main/compose.ts:659-666`:

```ts
const supervisedLlama: LlamaRuntime = {
  ...llamaRuntime,
  async ensureStarted() {
    await supervisor.start('llama');          // may be refused; returns void either way
    return llamaRuntime.ensureStarted();      // <- spawns regardless
  },
};
```

`supervisor.start` resolves silently when it refuses (`startEntry`, `supervisor.ts:400-404`:
`if (e.breakerOpen) { log('proc_start_refused'); return; }`), and the fall-through call goes straight
to the raw runtime, which spawns.

Failure scenario: llama-server crashes 3× in 10 minutes (the `LLAMA_BREAKER` budget). The breaker
opens and `state('llama')` becomes `'failed'`. The next triage item calls the local provider →
`supervisedLlama.ensureStarted()` → `supervisor.start` refused → `llamaRuntime.ensureStarted()`
spawns a fresh `llama-server.exe` **with no backoff, no breaker and no `llama.pid.json`**. Each
queued item repeats this (`starting` only dedupes concurrent calls; after a failure it is `null`
again), so a crashing model turns into an unthrottled spawn loop of a multi-GB process, and none of
those processes is reachable by `killAllSync()` or the reaper. The same fall-through defeats the
`'backoff'` delay: `startEntry` accepts `state === 'backoff'` and starts immediately.

Fix: make `supervisor.start` report refusal (return a boolean or throw) and have `supervisedLlama`
propagate an `LLM_LOCAL_FAILED` instead of calling the raw runtime; alternatively, gate
`llamaRuntime.ensureStarted()` on `supervisor.state('llama') !== 'failed'`.

---

## process-lifecycle-6 — an open breaker is permanent: `Supervisor.resetBreaker()` is never called (major)

`src/main/proc/supervisor.ts:517-524`. A repo-wide grep over `src/**` (excluding `*.test.ts`) finds
`resetBreaker` only in `supervisor.ts` itself and in `launcher.ts`, where it is the launcher's own
private function — nothing in `compose.ts`, `ipc/handlers/**` or `index.ts` ever calls
`supervisor.resetBreaker(name)`. Its own contract comment says "only from a user click (Try again)";
that click does not exist.

Failure scenario: the calendar MCP server exits 3× in 10 minutes (`MCP_BREAKER`) — e.g. a transient
`EADDRINUSE` on the OAuth callback port. `e.breakerOpen` latches, `state('calendar-mcp')` is `'failed'`,
and `supervisor.start('calendar-mcp')` (`compose.ts:1230`, the **only** start path for that child) is
refused for the rest of the session. `stop()` even preserves it on purpose
(`supervisor.ts:470`: `if (e.state === 'failed' && …) return;`). The user has no way back except
restarting the whole app, and the UI offers none. For the bridge the same latch makes `startBridge()`
a no-op, so the only thing that appears to "recover" it is the orphan-producing unsupervised path of
finding 4.

Fix: wire `resetBreaker` into the existing retry IPC (the same handler that calls
`bridgeControl.restartForNewCode` / re-connects the calendar), and call it from
`bridgeControl.start()` when `supervisor.state(name) === 'failed'`.

---

## process-lifecycle-7 — quitting during startup spawns children *after* `stopChildren` has run (major)

`src/main/compose.ts:1192-1196` (`start`) and `:1268-1295` (`shutdown`); `src/main/index.ts:267-295`, `:341-354`.

`index.ts` creates the tray — including its **Quit** item — and then `await rt.start()`. `rt.start()`
is not short: `startBridge()` alone can take `MAX_LAUNCH_ATTEMPTS × READINESS_BUDGET_MS` = 30 s, and
`supervisor.start('calendar-mcp')` adds `MCP_STARTUP_TIMEOUT_MS`. Throughout that window the user can
click Quit.

`compose`'s `start()` guards only on `isStarted`; it never reads the `quitting` flag that `shutdown()`
sets (`:1269-1270`). So `shutdown()` runs `runQuitSequence` → `stopChildren` → `supervisor.stopAll()`
concurrently with a `start()` that then continues and calls `supervisor.start('calendar-mcp')`,
registering and spawning a child *after* the stop pass. `runQuitSequence` also races its own
`timeoutMs` (`window.ts:194`), so `index.ts` can reach `app.exit(0)` with a spawn still in flight —
and `startEntry`'s "stop overtook us" compensation (`supervisor.ts:421-428`, `handle.kill()`) never
runs because the main process is already gone. The child is orphaned, and finding 2 guarantees the
reaper will not clean it up on the next boot either.

Fix: add `if (quitting) return;` at the top of `compose.start()` and re-check it after each `await`
in the child-start block; have `shutdown()` await an in-flight `start()` (keep its promise) before
`stopChildren`.

---

## process-lifecycle-8 — the doorbell rate limit is applied before authentication and counts rejections (minor)

`src/main/bridge/doorbell.ts:79-85`, `:120-133`.

`withinRateLimit()` is the **first** statement of `handle()`, before the loopback check, the method
check, the secret comparison and the `X-Bridge-Token` comparison. It pushes a timestamp for every
request it lets through the gate, including the ones that are rejected a microsecond later. The
budget is a single global 30-per-1000 ms window (`RATE_MAX_PER_WINDOW`), with no per-peer scoping.

Failure scenario: any other process on the machine (the doorbell is loopback-only, so this is a local
adversary or simply a misbehaving tool) sends `GET /` at 100 req/s. Each window fills with 30
rejections, so every genuine `POST /hook/<secret>` from the bridge gets 404. The bridge does not retry
(`doorbell.ts:28-29`), so those rings are lost and ingest falls back to the 30 s
`LIMITS.scanIntervalMs` poll (`compose.ts:1245`) for as long as the flood lasts. The same starvation
happens benignly during a history sync or a busy group, where >30 messages per second is ordinary.

Fix: authenticate first and rate-limit only *after* the secret and token have matched (or keep two
budgets: a wide pre-auth one for obvious garbage and a narrow post-auth one). Do not charge the
window for requests that were rejected.

---

## process-lifecycle-9 — unpackaged, `llama.pid.json` is always rejected by `parsePidFile` (minor)

`src/main/paths.ts:47-49` vs `src/main/proc/supervisor.ts:104-109` and `compose.ts:389-396`.

Unpackaged, `resourcesDir = <appRoot>\resources` but `llamaDir = <appRoot>\vendor\llama\win-x64-vulkan`,
so `llamaServerExe` is **not** inside `ownResourcesDir`. `parsePidFile` accepts an `exePath` only when
it is inside `ownResourcesDir` or equals `execPath`, so every `llama.pid.json` written by a dev or e2e
run is discarded as a forged/stale file and the orphan is never killed. (Packaged builds are fine:
`llamaDir = <resources>\llama`.) `bridgeExe` and the MCP child (`execPath`) are unaffected.

Failure scenario: an e2e run or a `npm run dev` session is killed hard while llama-server is up; the
next run reaps nothing and the orphan accumulates. Combined with finding 2 this is the second
independent reason llama orphans are never collected.

Fix: pass the set of legal child roots (`resourcesDir`, `llamaDir`, `mcpRoot`, `execPath`) to
`parsePidFile`/`reapOrphans` instead of the single `ownResourcesDir`.

---

## process-lifecycle-10 — a renderer crash leaks the old window and can loop unbounded (minor)

`src/main/index.ts:223-253` and `src/main/app/window.ts:95-98`.

```ts
onRenderProcessGone: () => { log.warn('render_process_gone', {}); win = buildWindow(false); },
```

The crashed `BrowserWindow` is never `destroy()`ed. It stays in `BrowserWindow.getAllWindows()` and
stays visible showing the dead-renderer page, still carrying its `installCloseToTray` handler — so
clicking its X only hides it. `rt.attachWindow(created)` merely overwrites `windowRef`
(`compose.ts:363-366`), so the old window is no longer trusted by `isTrusted` and no longer receives
pushed events, but it is still there. There is also no guard and no counter: if the renderer dies
during load (bad bundle, GPU driver fault), every rebuild crashes again and the handler builds another
window, forever. `quitting` is not consulted either, so a renderer killed during the quit sequence
creates and shows a brand-new window while the app is shutting down.

Fix: `const dead = win; win = buildWindow(false); dead?.destroy();`, skip the rebuild when `quitting`,
and cap the rebuilds (e.g. 3 within 60 s, then surface an error instead of looping).

---

## Checked and found sound

* `taskkillArgs` / `createWindowsProcessQuery` / `createSyncTaskkill` are **always by PID, never `/IM`**
  (`supervisor.ts:62-64`, `reaper.ts:80-89`), and the PowerShell lookup passes the pid as its own argv
  element after `--` with `[int]$args[0]` — no shell string, no WQL literal, `shell: false`.
* `parsePidFile` correctly rejects the user's *other* `whatsapp-bridge.exe`: its path is outside
  `ownResourcesDir`, so a forged or foreign pid file produces no query and no kill. The reaper's
  `matches()` also requires an exact `ExecutablePath` match, so PID reuse alone cannot cause a wrong
  kill **there** (the unverified kill lives in `killChild`, see finding 3).
* `STOP_ORDER = ['llama','calendar-mcp','bridge']` matches ARCHITECTURE 13 (leaves first, bridge last),
  and `runQuitSequence` races a hard `timeoutMs` so a stuck child cannot keep the app alive.
* Bridge port/token/doorbell-secret really are fresh per attempt (`spawnOnce`: `freePort`,
  `random.bytes(32)`, `rotateSecret()`), and `freePort` excludes the live doorbell port and 8080.
* `killAllSync` invalidates the generation *before* killing, so a late exit cannot schedule a respawn
  on the way out, and it guards `pid > 0`.
* The backoff arithmetic itself is right: `backoffMs[min(attempt, len-1)]`, capped at `MAX_BACKOFF_MS`,
  jitter in `[0, 15 %)`, `attempt` reset after `stableAfterMs` while the breaker window is deliberately
  not reset; the breaker window prune `exits.filter(x => x > t - windowMs)` is correct.
* Doorbell auth: constant-time comparison of both the URL secret and `X-Bridge-Token` (both hashed
  first so the length does not leak), loopback-only, `Host` pinned, `Origin` rejected, uniform 404 +
  socket destroy on every reject path, and the body is never parsed. `requestTimeout` /
  `headersTimeout` / `maxHeadersCount` are set as specified.
* `assertBridgeSpawnInvariants` is thorough on env allow-listing, the 8080 ban, token shape, the
  loopback webhook + port + secret-length check, the outbox containment and the exe hash pin. Its one
  gap is the missing "already running" check (finding 4).
