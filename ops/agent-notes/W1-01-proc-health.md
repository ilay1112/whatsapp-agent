# W1-01-proc-health - builder notes

Package: `W1-01-proc-health` (Wave 1, parallel).
Brief: `docs/specs/build-plan.md` section 7, heading `### W1-01-proc-health`.
Reads used: ARCH 3, 13, 14; CONTRACTS 3, 13; TESTS 3.6, 4.3, 5.3 row `proc/*`; `docs/specs/wave0-seams.md` sections 1, 8, 9;
`ops/agent-notes/W0-scaffold.md`.
Date: 2026-09-22. No earlier partial implementation of this package existed on disk (the four owned source files were still
W0 stubs throwing `NotImplementedError`; `tests/fakes/fake-child.mjs` was already complete from W0).

**Fix round 2026-09-23.** The audit (`ops/agent-notes/wave1-audit.md` section 5) attributed exactly one item to this
package: W2-01's *"RATIFY OR REVERT"* on the three additive-optional parameters. **Answered in section 2a: ratified**, and
backed by compile-time conformance pins so the "every frozen-shape caller still compiles" claim is now enforced by
`npm run typecheck`. No production source was touched - the round added only three `describe('frozen-signature
conformance')` blocks (6 tests) and two import lines to the colocated test files. Owned tests went 124 -> 130, all green.

Owned paths (build-plan section 6): `src/main/proc/**`, `src/main/health/**`, `tests/fakes/fake-child.mjs`
(+ colocated `*.test.ts` next to each owned source file). Nothing outside those was edited.

---

## 1. What was built

| File | Contents |
|---|---|
| `src/main/proc/supervisor.ts` | `createSupervisor`, `parsePidFile`, `taskkillArgs`, `handleFromChildProcess`, `realClock`, `createTaskkillOnlyQuery`, `createSyncTaskkill`, `isInsideDir`, `isSamePath`, `isChildName` + the exported constants (`MAX_BACKOFF_MS`, `JITTER_RATIO`, `DEFAULT_GRACE_MS`, `DEFAULT_PROBE_INTERVAL_MS`, `DEFAULT_PROBE_MISSES`, `STOP_ORDER`, `CHILD_NAMES`, `MAX_PID`) |
| `src/main/proc/reaper.ts` | `reapOrphans`, `createWindowsProcessQuery`, `parseProcessJson`, `parseCreationDate`, `PS_QUERY_ARGS`, `CREATION_TOLERANCE_MS` |
| `src/main/proc/freePort.ts` | `freePort`, `NEVER_PORTS`, `FREE_PORT_MAX_ATTEMPTS` |
| `src/main/health/healthHub.ts` | `createHealthHub`, `severityOf`, `INITIAL_*` boot states |
| `src/main/proc/{supervisor,reaper,freePort}.test.ts`, `src/main/health/healthHub.test.ts` | 124 tests |
| `tests/fakes/fake-child.mjs` | two small fixes, see section 4 |

### Supervisor behaviour decisions (all of them testable, none of them invented where a spec said otherwise)

- **Backoff** = `min(60 s, backoffMs[min(attempt, len-1)])` + jitter in `[0, 15 %)` of that value, so a delay is always
  `>= base` and `< base * 1.15`. ARCH 14's `min(60 s, base*2^n)` is the generic formula; the per-child `backoffMs` table of
  CONTRACTS 13 IS that sequence, so the table is indexed and capped rather than recomputed.
- **`stableAfterMs` resets `attempt` only, NOT the breaker window.** If a stable run also cleared the exit list, a child that
  survives just over `stableAfterMs` between crashes could never open its breaker, and ARCH 14's "5 exits / 10 min" would be
  unreachable for exactly the crash loop it is meant to catch.
- **Any exit while not stopping is a crash, including code 0** - including a `spec.start()` that *throws* (documented in
  CONTRACTS 13), which is funnelled through the same exit path.
- **`terminal()` -> `failed` without opening the breaker**, so `resetBreaker()` + `start()` recovers once the terminal
  condition is gone (the launcher's `logged_out` / `BRIDGE_OUTDATED` / spawn-refused cases are W1-02's to drive).
- **Kill escalation**: `handle.kill()`, race the real exit against `graceMs` on the injected clock, then
  `processQuery.kill(pid, true)` (`taskkill /PID <pid> /T /F`) and *synthesise* the exit locally. Synthesising is what makes
  `stop()` / `stopAll()` bounded: a child that ignores both signals cannot hang the quit sequence. A late real exit event is
  dropped by the per-handle `generation` counter.
- **`killAllSync()` bumps the generation BEFORE killing.** Without that the synchronous `handle.kill()` fires the exit
  callback, which schedules a backoff respawn - on the `session-end` / `process 'exit'` path, where nothing may be respawned.
  (This was a real bug caught by the "no pending timers after killAllSync" assertion.)
- **Liveness probe**: a throwing probe counts as a miss, never as a crash; a success resets the counter; on
  `probeMisses` consecutive misses the child is killed and the normal crash path restarts it.
- **PID file** `<runDir>\<name>.pid.json` is written `tmp` + `renameSync` (atomic replace on one volume) and removed on every
  exit, stop and `killAllSync`. A failed write is logged, never thrown - a missing pid file only costs the next run's reaper.

### Reaper

`parsePidFile()` runs **first**, on text, and nothing is spawned, queried or killed for a file it rejects. Accepted only when
`pid` is a safe integer in `(0, 2**31)`, `startedAt` is a safe integer `> 0`, and `exePath` is absolute, NUL-free and (after
`path.resolve`) strictly inside `ownResourcesDir` or exactly `execPath`. A file whose *name* is not one of the three
`ChildName`s is discarded the same way. Comparison of paths is case-insensitive (Windows) and prefix-safe
(`<dir>-evil\x.exe` is not inside `<dir>`). Kill happens only when pid + executable path + `CreationDate` (+-2 s) all match.

The default `ProcessQuery` spawns `powershell.exe` with the pid as its **own argv element after `--`**; a test asserts the
`-Command` string contains `[int]$args[0]` and does **not** contain the pid. `taskkill` is always `/PID <n> [/T] /F`;
three separate tests assert `/IM` appears nowhere.

TESTS 5.3 asks that the reaper "works with the DB locked": it is DB-free **by construction** (it reads only
`<runDir>\*.pid.json`), and a source-level test asserts `reaper.ts` imports no database module - that seemed more honest
than a test that locks a database the module never opens.

### HealthHub

`overall` is computed with the **shared** `overallOf()` from `src/shared/health.ts` and a `severityOf` that maps every code
not listed in `ERROR_SEVERITY` to `'attention'`, so the tray, the pill and main can never drift. `since` moves only on a
**state** change (a changed `ErrorCode` alone does not move it, per the CONTRACTS comment). `onChange` is deduplicated
against the serialised `AppHealth`, so a setter that changes nothing is silent. `setPairing` deliberately does **not** fire
`onChange`: `PairingState` is not part of `AppHealth` and has its own push channel (`AppRuntimeEvent = 'pairing'`).
Boot values: `whatsapp: not_started`, `llm: starting` (provider `local`, model `''`), `calendar: not_configured` -> overall
`'working'` until `compose()` sets the real values. The truth-table test walks all 11 x 13 x 9 = 1 287 state triples against
an independently written oracle plus one case per `ErrorCode`.

---

## 2. Deviation: three frozen signatures gained ADDITIVE OPTIONAL parameters

Global rule 7 freezes exported shapes, but TESTS 4.3 names `proc/supervisor.ts` and `proc/reaper.ts` as **S-CLOCK and
S-SPAWN injection points** ("spawn function + queryProcess(pid) + killPid(pid)"), the brief says the Win32_Process lookup
goes "through an injected `ProcessQuery`", and TESTS 5.3 requires `freePort` to be driven by "an injected fake `listen` that
yields 8080 first". The CONTRACTS blocks carry no such parameters. The two specs are only satisfiable together by widening
the parameter objects with **optional** keys, which is backwards compatible: every caller written against the frozen shape
compiles unchanged and gets the production default.

| Frozen | Now | Added (all optional) |
|---|---|---|
| `createSupervisor(deps: { runDir; now; log })` | `createSupervisor(deps: SupervisorDeps)` | `clock?: Clock`, `processQuery?: ProcessQuery`, `killSync?: (pid) => void`, `random?: RandomSource` |
| `reapOrphans(runDir, ownResourcesDir)` | same + a third parameter | `deps?: { processQuery?, spawn?, execPath?, log?, toleranceMs? }` |
| `freePort(opts?: { exclude?: number[] })` | `freePort(opts?: FreePortOpts)` | `listen?: () => Promise<number>`, `maxAttempts?: number` |

Verified compatible with the one existing consumer type: `src/main/llm/local/llamaServer.ts` declares
`freePort: (opts: { exclude?: number[] }) => Promise<number>` and still accepts the implementation.

Nothing else changed shape. `Supervisor`, `ChildSpec`, `ChildHandle`, `PidFile`, `HealthHub`, `HealthPartInput` and every
return type are byte-identical to CONTRACTS / `wave0-seams.md`.

No new file was added to `src/main/proc/` or `src/main/health/`: ARCH 18's file list for those two directories is unchanged.
The production `ProcessQuery` lives in `reaper.ts` (which owns the Win32_Process lookup) and the supervisor keeps a
kill-only default, so there is no import cycle between the two files.

---

## 2a. [FIX ROUND 2026-09-23] "RATIFY OR REVERT" (W2-01-compose-integration, via `ops/agent-notes/wave1-audit.md` section 5)

**Decision: RATIFIED.** The three widenings of section 2 stay. They are now *pinned* by compile-time conformance tests, so
the property W2-01 was asked to trust ("every caller written against the frozen shape still compiles") is machine-checked
on every `npm run typecheck` instead of being a claim in prose. The final call remains the orchestrator's; this section is
the evidence, not an attempt to amend build-plan rule 7 myself. **No production behaviour changed in this round** - the
only edits were three appended `describe('frozen-signature conformance')` blocks and their imports.

### Why not revert

Reverting is not a no-op that costs a little ergonomics; it makes specified tests unimplementable without breaking a hard
rule. Concretely:

1. **The frozen seam layer already declares the injection.** `src/main/deps.ts` (W0, frozen) defines `ProcessQuery` with
   the comment *"Process lookup / kill by PID only (never by image name). **Used by `proc/reaper.ts` and
   `proc/supervisor.ts`**"*. A frozen type that names both of my modules as its consumers, while the frozen call signatures
   give neither module any way to receive it, is an internal contradiction in the spec set - not a licence I took.
2. **TESTS 4.3 names both modules as seams.** Row S-SPAWN is `proc/supervisor.ts`, `bridge/launcher.ts`,
   `llm/local/llamaServer.ts`, `proc/reaper.ts` with the seam shape *"spawn function + `queryProcess(pid)` +
   `killPid(pid)`"*; row S-CLOCK names *"reaper start-time compare"* explicitly.
3. **TESTS 5.3 requires the fakes.** The `proc/*` row demands the `[R2]` hostile pid files prove *"no spawn and no kill
   (S-SPAWN spy)"*, that the PowerShell argv be asserted, that `taskkill` argv never contain `/IM`, and that `freePort`
   *"never returns 8080 (**inject a fake `listen`** that yields 8080 first)"*.
4. Without the parameters the only remaining ways to satisfy 2-3 are module-level monkey-patching of `node:child_process`
   (which `tests/setup-guards.ts` exists to prevent) or actually spawning `powershell.exe` / `taskkill` and real processes
   against real PIDs - which the hard rules forbid and which would make the suite non-deterministic on a shared tree.

So revert => either delete tests TESTS 5.3 mandates (forbidden: "a red test is reported, never deleted or weakened") or
run real kills. Ratify costs nothing measurable. Ratify wins.

### Why this is safe to ratify (the actual risk, and how it is now closed)

The risk build-plan rule 7 protects against is a *downstream caller breaking*. That risk is zero today and is now pinned
against tomorrow:

- **Today, empirically.** The only two cross-package call sites of any of the three are `src/main/bridge/launcher.ts:469`
  (`freePort({ exclude: [doorbellPort] })`) and `src/main/llm/local/llamaServer.ts:206` (`deps.freePort({ exclude: [...] })`),
  both written against the frozen shape, both compiling. `createSupervisor` and `reapOrphans` have **no** caller outside
  `src/main/proc/**` yet - W2-01 writes the first one - so ratifying now costs no rework anywhere.
- **Tomorrow, mechanically.** Each of the three test files gained a `frozen-signature conformance` block containing the
  CONTRACTS / `wave0-seams` declaration pasted **verbatim** as a type, assigned from the implementation:

  | Pin | File | Fails if |
  |---|---|---|
  | `FrozenCreateSupervisor` | `src/main/proc/supervisor.test.ts` | any of `clock` / `processQuery` / `killSync` / `random` becomes required, or a positional parameter is added |
  | `FrozenReapOrphans` | `src/main/proc/reaper.test.ts` | the third parameter stops being optional |
  | `FrozenFreePort` (+ the `LlamaServerDeps`-shaped consumer type) | `src/main/proc/freePort.test.ts` | `listen` / `maxAttempts` becomes required |

  These are **type** assertions, so `tsc -p tsconfig.tests.json` (i.e. `npm run typecheck`) is what enforces them; the
  `expect(frozen).toBe(fn)` line is only there to give the assertion a test to live in.
- **The pin was proved to bite**, not assumed to. A scratch file with three cases - (A) an *optional* extra key,
  (B) a *required* extra key, (C) an extra positional parameter - compiled under `--strict` gives exactly one error for B
  (`Property 'clock' is missing in type 'FrozenDeps' but required in type 'BreakingDeps'`), one for C
  (`Target signature provides too few arguments`), and **none** for A, which is the shape actually shipped. `strict: true`
  in `tsconfig.tests.json` implies `strictFunctionTypes`, which is what makes the parameter position contravariant and
  therefore load-bearing here.
- Each block also carries a runtime companion that calls the function through the frozen shape only:
  `createSupervisor({ runDir, now, log })` (no injected clock/query/random) produces a working supervisor;
  `reapOrphans(runDir, resourcesDir)` - a genuine **two-argument** call, which no test made before this round - runs on the
  production defaults, returns `{ killed: [], stalePidFiles: 1 }` for a hostile pid file and, asserted with a `cp.spawn`
  spy, **spawns nothing**; `freePort` is assigned into the `llamaServer.ts` consumer type and called.

### If the orchestrator decides REVERT anyway

The mechanical consequence, so the cost is visible before the decision: TESTS 5.3's `proc/*` row and TESTS 4.3's S-CLOCK /
S-SPAWN entries have to be amended in the same edit, and roughly 100 of the 130 tests in `src/main/proc/**` lose their
injection point. I did not do that unilaterally because `docs/specs/**` is not mine to edit (global rule 6).

---

## 3. Definition of done (build-plan 1.1)

| # | Criterion | Result |
|---|---|---|
| a | no `NotImplementedError` left in owned source | **PASS** - `grep -r NotImplementedError src/main/proc src/main/health` is empty |
| b | TESTS 5.3 rows for `proc/*` + HealthHub covered by colocated tests | **PASS** - see section 5 |
| c | `npx eslint src/main/proc src/main/health tests/fakes/fake-child.mjs --max-warnings 0` | **PASS** (exit 0) |
| d | `npm run typecheck` reports no error in owned files | **PASS** - and as of the fix round `tsc -p tsconfig.node.json` and `tsc -p tsconfig.tests.json` are now **both entirely clean repo-wide** (zero diagnostics), so the list that used to be in section 6 is obsolete |
| e | `npx vitest run --project main src/main/proc src/main/health` | **PASS** - 4 files, **130 tests**, 0 failures (124 + the 6 frozen-signature conformance tests of section 2a) |
| f | coverage thresholds of TESTS 13 for my files | **PASS** - `src/main/proc/**` aggregate lines **98.11 %** / funcs **95.50 %** / branches **90.32 %** (glob threshold 90/90/85), per file `supervisor.ts` 97.35/96.92/90.37, `reaper.ts` 100/88.88/93.10, `freePort.ts` 100/100/83.33 - the threshold is the glob aggregate, and no `src/main/proc/**` or health threshold ERROR is emitted. `src/main/health/healthHub.ts` **100 / 100 / 100** (global bar 85/85/80) |
| g | notes file | this file |

Full `npx vitest run --project main --project renderer` (fix round, 2026-09-23): **133 files, 2 971 tests, 0 failures.**
The three `src/main/bridge/doorbell.test.ts` failures reported in the first round are gone (W1-03 fixed them); that
BLOCKED-BY-adjacent note is closed.

---

## 4. `tests/fakes/fake-child.mjs` (owned, was already complete)

Two fixes, no behaviour removed:

1. The `--ignore-kill` grandchild was re-spawned with `new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')`.
   The project path contains a space, so `pathname` yields `%20` and the grandchild would fail to start. Replaced with
   `fileURLToPath(import.meta.url)` (global builder rule 1).
2. `--write-pid` now writes `{pid, exePath: process.execPath, startedAt}` instead of `{pid, startedAt}`, so the file the fake
   produces is a real `PidFile` that `parsePidFile()` accepts. A test spawns the fake with `--write-pid` and parses the
   result, which keeps the fake and the parser from drifting.

`--ignore-kill` is deliberately **not** used by any test in this package: its grandchild ignores signals, and a leaked
grandchild would outlive the vitest worker (`tests/setup-guards.ts` T7 only tracks direct children). Taskkill escalation is
tested with a scripted handle whose `kill()` is a no-op, which proves the same code path without leaving a process behind.

---

## 5. Where each TESTS 5.3 clause is tested

`proc/supervisor.ts`, `proc/reaper.ts`, `proc/freePort.ts` row:

| Clause | Test |
|---|---|
| state machine | `state machine >` (3 tests) + `crash handling >` |
| backoff sequence + jitter bounds | `walks the backoff table...`, `caps the delay at 60 s...`, `adds jitter inside [d, d * 1.15)` |
| reset after 60 s stable | `resets the backoff position after stableAfterMs...` |
| breaker opens after N exits / window, only `userRetry()` closes it | `opens the breaker after maxExits crashes...`, `forgets exits that fell out of the breaker window` |
| exit code 0 while not stopping = crash | `exit code 0 while not stopping is a crash` + `treats a real clean exit (code 0) as a crash` (fake-child.mjs) |
| `stopAll({graceMs})` then `taskkill /PID <pid> /T /F`, argv never `/IM` | `escalates to taskkill...`, `stops llama, then calendar-mcp, then bridge`, `taskkill argv >`, `createTaskkillOnlyQuery...`, `createWindowsProcessQuery > kills by PID...` |
| `killAllSync` | `killAllSync kills every live child by PID...` (+ the no-children case) |
| reaper kills only when pid + exe path + start time match; three negative cases | `reapOrphans - the three negative cases` |
| tolerates a corrupt pid file | `the file is not JSON`, `the file is empty`, `an unreadable pid file (a directory)` |
| works with the DB locked | `the reaper is database-free` (source-level; the module opens no database) |
| `[R2]` hostile pid files => `parsePidFile` null, no spawn, no kill | `reapOrphans - [R2] hostile pid files...` (6 cases + foreign exePath + foreign file name), `parsePidFile >` (17 rejection cases) |
| PowerShell argv: pid as its own element after `--`, never in `-Command` | `passes the pid as its own argv element after --...` |
| `freePort` never 8080 (injected listener yields it first) | `never returns 8080 - the injected listener yields it first` |
| *(fix round, not a TESTS clause)* frozen signatures stay additively widened | `frozen-signature conformance >` in all three files - 6 tests, 3 of them compile-time type pins (section 2a) |

`HealthHub` (row `shared/errors.ts, shared/health.ts`, clause "HealthHub merge truth table -> overall"):
`merge truth table -> overall` (1 287 triples + one case per `ErrorCode`), `since` semantics, change-event dedup, pairing.

---

## REQUESTS

- **W2-01-compose-integration** - when wiring `compose()`, pass the optional deps of section 2 so production gets the real
  seams instead of the module defaults:
  - `createSupervisor({ runDir: paths.runDir, now: () => clock.now(), log, clock, processQuery, killSync, random })`
    where `processQuery` is `createWindowsProcessQuery({ spawn })` from `src/main/proc/reaper.ts` (the supervisor's own
    default is kill-only and never queries).
  - `reapOrphans(paths.runDir, ownResourcesDir, { processQuery, execPath, log })` **before any spawn** (ARCH 13).
  - `killAllSync()` must be reachable from `session-end` and `process.on('exit')`; it is synchronous and safe to call twice.
  - `stopAll({ graceMs: 3000 })` already walks llama -> calendar-mcp -> bridge; do not re-order it in the quit sequence.
- **W2-01-compose-integration** - `ownResourcesDir` for `reapOrphans` must be the directory the shipped child executables
  live in (`resources\` in a packaged install). If it is passed as the app root, `parsePidFile` will accept more than it
  should; if it is passed too narrowly, live orphans are never reaped. Worth one assertion in the compose test.
- **W1-02-bridge-process / W1-07-llm-local** - `handleFromChildProcess(child, exePath)` (exported from
  `src/main/proc/supervisor.ts`) turns a `ChildProcess` into the `ChildHandle` the supervisor wants, including the
  `error` -> exit mapping. Please reuse it rather than re-implementing `onExit`. `exePath` must be the **real** executable
  path, because it is what lands in the pid file and what the reaper compares against `Win32_Process.ExecutablePath`.
- **W1-02-bridge-process** - `ChildSpec.probe` for the bridge should resolve `true` for both 200 and 503 from
  `/api/health` (ARCH 14: a 503 is "reconnecting", not a dead process); the supervisor treats `false` **and** a throw as a
  miss, so a fetch rejection is already handled.
- **W1-12-shell-main** - `createHealthHub` is where the tray reads `AppHealth`; `agentStatusOf(hub.get())` gives the tray
  status line directly. `onChange` fires only on a real change, so rebuilding the tray menu on every event is safe.
- **W2-01-compose-integration** - *(fix round)* the "RATIFY OR REVERT" question is **answered: ratified**, with the
  reasoning, the counted cost of reverting and the machine-checked evidence in section 2a. Nothing is required of W2-01
  beyond noting it; the two bullets above are still the actual wiring work. No production code changed in this round.
- ~~**W1-03-bridge-ingest** - `doorbell.test.ts` is red~~ **CLOSED (fix round)**: the whole suite is green
  (133 files / 2 971 tests), `doorbell.test.ts` included.
- ~~**W2-01-compose-integration** - `npm run typecheck` is red outside my paths~~ **CLOSED (fix round)**: both
  `tsconfig.node.json` and `tsconfig.tests.json` now typecheck with zero diagnostics repo-wide. Section 6 is kept only as a
  record of what those errors were and who fixed them.

## BLOCKED-BY

None. No test of this package fails because of another package's Wave 0 stub: `proc/**` and `health/**` depend only on
`src/main/deps.ts`, `src/shared/health.ts`, `src/shared/errors.ts` and `src/shared/types.ts`, all of which W0 implemented.

---

## 6. Pre-existing errors outside my paths (NOT fixed, per global rule 6)

> **Fix-round update (2026-09-23): this whole list is RESOLVED by its owners.** `npx tsc --noEmit -p tsconfig.node.json`
> and `-p tsconfig.tests.json` both exit clean with zero diagnostics. Kept below only as the historical record.

`npx tsc --noEmit -p tsconfig.node.json`:
- `src/main/app/i18n.ts(23,17)` - i18next `init()` overload (`lng` / `initImmediate`) - **W1-12**
- `src/main/app/protocol.ts(87,33)` - `Cannot find name 'BodyInit'` (DOM lib missing from `tsconfig.node.json`) - **W1-12** / **W2-01**
- `src/main/bridge/doorbell.ts(73,39)` - `Object is possibly 'undefined'` - **W1-03**
- `src/main/db/repos/items.ts(33,6)` - `Item` -> `Record<string, unknown>` conversion - **W1-04**
- `src/main/llm/consent.ts(16,71)` - `'whatsapp_tos'` not assignable to the cloud-only consent kind - **W1-12**
- `src/main/testSeams.ts(120,17)` - implicit `any` parameter - **W1-12**
- `src/shared/when.ts(252,37)` and `(252,75)` - `string | undefined` - **W1-08**

`npx tsc --noEmit -p tsconfig.tests.json` additionally reports errors in `src/main/app/*.test.ts` (electron-mock members
`resetElectronMock`, `Tray.instances`, `Menu.built`, `Protocol.privileged/handlers` are used by the tests but not declared
on `tests/mocks/electron.ts`) - **W1-12** owns both sides of that pair.

`npm run format:check` is still red for the reason W0 recorded (93 spec-verbatim files vs `printWidth: 120`). I did not run
prettier on anything, including my own files, because the decision belongs to W2-01 and a partial reformat would make the
eventual answer harder. *(Fix round: still true - `prettier --check src/main/proc src/main/health` warns on the same five
files it warned on before, all for the spec-verbatim long lines. The blocks I appended this round were extracted and
checked on their own and are **Prettier-clean**, so the repo-wide pass has nothing new to undo.)*

## 7. Dead ends / things that cost time

- Mixing a real spawned child with the virtual clock works, but only because the virtual clock never advances on its own:
  `killChild` races the child's real `exit` against a virtual `sleep(graceMs)` that nobody fires, so the real exit always
  wins and `stop()` is deterministic. A test that *wants* the escalation must advance the clock explicitly while `stop()` is
  in flight (`const p = sup.stop(...); await clock.advance(graceMs); await p;`).
- First attempt routed the backoff-timer respawn straight into `startEntry`, bypassing the `pending` promise that `stop()`
  awaits; `stop()` during a backoff retry could then be overtaken by the very start it was cancelling. Every entry into
  `startEntry` now goes through one `launch()` helper that publishes the promise.
- `syncBuiltinESMExports()` in `tests/setup-guards.ts` does not reliably propagate a replaced builtin to *named* ESM
  imports (W0 hit the same thing with `node:sqlite`). Both owned modules therefore use the **default** import
  (`import cp from 'node:child_process'`, `import fs from 'node:fs'`) and call `cp.spawn` / `fs.readFileSync` at call time,
  so the guards in `setup-guards.ts` are always in force.
