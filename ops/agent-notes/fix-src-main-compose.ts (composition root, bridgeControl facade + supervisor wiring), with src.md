# fix - compose.ts (bridgeControl facade + supervisor wiring)

> Filename note: my assigned label contains a `:` ("composition root: bridgeControl facade..."), which Windows
> forbids in a path. Replaced with a comma, matching the other `fix-src-main-compose.ts (...)` notes in this folder.

Phase 3 repair agent. One confirmed finding: **process-lifecycle-6** (`Supervisor.resetBreaker()` has no production
caller, so a latched breaker outlives the whole session). Work was interrupted by a usage limit and resumed; the
bridge half was already in the tree from the first sitting, the calendar half was done in the second.

## Verdict

FIXED, in two halves, both TDD (red test first, then product code, then the surrounding suites).

### Half 1 - the bridge (already in the tree when I resumed)

- `src/main/compose.ts`: exported `clearLatchedBreaker(sup, name)` - resets the breaker **only** when
  `state(name) === 'failed'` - and called it from `startBridge()` immediately before `supervisor.start('bridge')`.
- `startBridge()` is the single chokepoint for every bridge start that a **user** can cause: first boot,
  `consent:accept`, and `bridgeControl.restartForNewCode / relink / unlinkAndWipe` (each is
  `stopBridge() -> launcher.<action>() -> startBridge()`). The Supervisor's own backoff respawn never goes through it,
  so the breaker still stops a crash *loop*; it just no longer outlives the user's retry (ARCHITECTURE 4.3,
  CONTRACTS 13).
- `src/main/compose.breaker.test.ts` (new file): drives the REAL `createSupervisor` with scripted child handles -
  3 exits inside the window latch the breaker, a plain `start()` is refused, 600 s of virtual clock does not help,
  `clearLatchedBreaker` brings it back. Plus a no-op case (running / backing off keeps its exit history, so a retry
  cannot launder a loop in progress) and a source-level guard that `startBridge()` still contains the call before
  `supervisor.start('bridge')` (the defect was "no caller", so a behavioural test alone would not catch a regression).

### Half 2 - calendar-mcp (this sitting)

The reviewer's headline scenario is the calendar, and the skeptic's Correction 1 is right that the latch is not the
whole story there: `supervisor.start('calendar-mcp')` ran **exactly once per session** (compose's `start()`), and the
wizard's own retries (`googleAuth.importCredentials()` -> `deps.host.start()`) reached *past* the Supervisor into the
raw `mcpHost`. So the supervised child stayed dead and an **unsupervised** one took its place - no
`calendar-mcp.pid.json`, therefore invisible to `killAllSync()` and `reapOrphans()` (ARCH 3), and no breaker or
backoff accounting.

- `src/main/compose.ts`: new exported `supervisedCalendarHost({ supervisor, host, ensureRegistered })` - the calendar
  twin of `llm/local/supervised.ts`. `start()` registers the child if `start()` has not yet, clears a **latched**
  breaker (it is a user action by construction: Import credentials / Replace key), calls
  `supervisor.start('calendar-mcp')` and returns `host.status()` - which is exactly what `googleAuth` maps to its
  `CAL_*` ErrorCodes, so a refused or failed start reports the same code it did before. `stop()` (Disconnect) goes
  through `supervisor.stop()` so the Supervisor sees its own child go down.
- `createGoogleAuth` now receives that facade instead of `mcpHost`. Nothing else in compose changed hands: the read /
  write / admin callers and `healthHub` still talk to `mcpHost` directly, because none of them starts a process.
- Registration ordering: `supervisor.register(mcpHost.childSpec())` moved behind an idempotent local
  `registerMcpChild()` (flag + single `register()`), called both from `compose.start()` and from the facade. A second
  `register()` would REPLACE the entry and throw away a live child's handle, pid file and exit history, so
  idempotence here is load-bearing, and it also means a wizard retry that lands before `start()` is still supervised
  rather than raw.
- Tests appended to `src/main/compose.breaker.test.ts`: real `createSupervisor` + a scripted host. Latch the calendar
  breaker with 3 exits, prove a plain `sup.start()` is refused and does not touch the host, then prove the facade
  revives it (`proc_breaker_reset`, state `running`, one more host start). Plus: the retry always goes through the
  Supervisor (registers once, never twice, `stop()` leaves state `stopped`), the crash loop in progress is not
  laundered, and a source guard that `createGoogleAuth`'s `host` argument is the facade.

## Where the reviewer's proposed fix was wrong

- "call `resetBreaker` from the existing retry IPC ... and from `bridgeControl.start()`": `bridgeControl.start()` is
  not reachable from IPC (`register.fixtures.ts` marks `launcher.start` unimplemented), and there is no calendar retry
  IPC to hang it on. The skeptic caught both. Putting the call in `startBridge()` instead covers **every** reachable
  bridge retry with one line, and the calendar needed a start path before it needed a reset.
- Putting the reset in an automatic path (the Supervisor's backoff, or `supervisedLlama.ensureStarted()`) would delete
  the breaker outright. Both call sites here are user actions, and both are additionally guarded by `'failed'`.

## Residual gaps (NOT fixed here - out of this finding's surface, worth their own tickets)

1. **`llama` has no user-reachable retry at all.** Its only start is `supervisedLlama.ensureStarted()`, which is
   automatic (per queue item), so clearing the breaker there would defeat it. `llm:setProvider('local')` is the
   natural "the user asked for the local model again" hook, but `HandlerDeps` carries no `supervisor`, so wiring it
   means touching `ipc/handlers/llm.ts` + `ipc/register.ts` - another agent's files. A latched `llama` breaker still
   survives the session today.
2. **Settings -> "Reconnect" (`google:startSignIn`) still cannot revive a dead host.** It calls
   `admin.manageAccounts('add')` directly and returns `unavailable` while `client === null`; it never starts the host.
   After this fix the working calendar retry is Replace key / Import credentials (which now goes through the
   Supervisor). Making `startSignIn()` start the host first is a one-line change in `mcp/googleAuth.ts` but it is a
   different defect (missing affordance, not a latched breaker), so I left it.
3. **The renderer's `try_again` action is still generic.** `App.tsx`'s `onHealthAction` only does `setView('settings')`
   for `BRIDGE_CRASH_LOOP` / `CAL_UNAVAILABLE`. From Settings the user now genuinely can recover both children, but a
   one-click retry IPC would be the honest implementation of ARCHITECTURE 4.3.
4. **Supervisor `'failed'` is still not wired to health.** There is no `supervisor.onState` subscription in compose,
   so a child whose breaker latched can show a stale `backoff` in the health row. Noted by the skeptic; not part of
   the breaker-reset defect.

## Gates

- `npm run lint` - fully clean at 10:24. A re-run at 10:29 reports 2 errors, both in files another agent edited in
  between (`src/main/db/repos/chats.ts`, `src/renderer/src/App.tsx:239` react-hooks/set-state-in-effect). Nothing in
  `compose.ts` / `compose.breaker.test.ts`.
- `npm run typecheck` - no errors in anything I touched. Pre-existing errors remain in other agents' in-flight files:
  `src/main/agent/prompt.purity.test.ts`, `src/renderer/src/App.test.tsx`,
  `src/renderer/src/components/ItemCard.test.tsx`, `src/renderer/src/store/dashboard.test.ts`.
- `npm run format:check` - my files pass; 5 other files are unformatted (`agent/contextBuilder.test.ts`,
  `bridge/bridgeDb.ts`, `llm/local/llamaServer.test.ts`, `components/ItemCard.test.tsx`, `components/ItemCard.tsx`).
- Targeted: `vitest run --project main --project integration src/main/compose.breaker.test.ts src/main/mcp
  src/main/proc src/main/llm/local tests/integration` - **29 files / 568 tests green**.
  `vitest run --project security` - 16 files / 497 tests green.
- Full `npm test` is unstable **because other agents are writing the tree while I run it**: a run at 10:25 showed 194
  failures with `no such column: rev` out of `db/repos/queue.ts` (the db agent's half-applied migration, mtimes
  10:23:30-10:23:56), the next run showed 9 failures in `agent/prompt.purity.test.ts`, and the one after that 4 in
  `components/ItemCard.test.tsx`. None of those files or their dependencies are touched by this change, and every
  suite around compose / proc / mcp / integration / security is green on repeated runs.

## Rules

No process was spawned, no binary executed, no network call, no new dependency, no commit. The scripted children and
the scripted host in the test are plain objects.
