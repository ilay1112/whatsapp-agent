# fix-src-main-compose.ts (ownResourcesDir at compose.ts:390) — working notes

Label: `fix-compose-ownResourcesDir`. Phase 3 repair pass. One finding: **process-lifecycle-9 [minor]**.

## Verdict

CONFIRMED and FIXED. The reviewer's chain and the skeptic's proof both hold. Reproduced it myself as a *red*
integration test against the real `compose()` before touching product code (see "Proof it was red" below).

## What was wrong

`compose.ts` passed a single directory — `paths.resourcesDir` — as `ownResourcesDir` to `reapOrphans`, and
`parsePidFile` (supervisor.ts) accepted an `exePath` only when it was strictly inside that one directory or equal to
`process.execPath`.

Unpackaged (`npm run dev`, every e2e run) `createPaths` puts the three staged resource trees in three *sibling*
places, not nested under one root:

| tree | packaged | unpackaged |
|---|---|---|
| `resourcesDir` | `<resources>` | `<appRoot>\resources` |
| `llamaDir` | `<resources>\llama` | `<appRoot>\vendor\llama\win-x64-vulkan` |
| `mcpRoot` | `<resources>\calendar-mcp` | `<appRoot>\build-resources\calendar-mcp` |

So the `llama.pid.json` the supervisor itself had just written (exePath = `paths.llamaServerExe`) was rejected by the
reaper on the next boot as a forged file: `reaper_pidfile_rejected`, file deleted, `query()`/`kill()` never called, the
live orphan `llama-server.exe` left behind. Packaged builds were unaffected, which is why severity stays **minor** —
no invariant, no approval-first path and no user-facing requirement is touched in the configuration that ships. The
cost is a leaked dev process and a blind spot in the reaper's dev coverage.

## The fix

Smallest surface that closes it, in four places:

1. **`src/main/paths.ts`** — new pure helper `childExeRoots(paths): string[]` returning
   `[resourcesDir, llamaDir, mcpRoot]`. Packaged these collapse to `resourcesDir` plus two harmless nested duplicates;
   unpackaged they are the three real roots. Keeping the knowledge in `paths.ts` means the layout and the list of legal
   roots cannot drift apart.
2. **`src/main/proc/supervisor.ts`** — `parsePidFile(jsonText, ownResourcesDir, execPath)` widened both path
   parameters from `string` to `string | readonly string[]`. `exePath` is accepted when it is strictly inside **one of**
   the roots, or equals **one of** the execPaths. Every other `[R2]` check is untouched and runs first.
3. **`src/main/proc/reaper.ts`** — `reapOrphans`' second parameter and `ReapDeps.execPath` widened the same way.
4. **`src/main/compose.ts`** — passes `childExeRoots(paths)` and `[execPath, ...seamExePaths]`.

The widening is purely additive: a `(runDir: string, ownResourcesDir: string) => ...` value is still assignable from
the new `reapOrphans` (parameter contravariance), so the existing frozen-signature conformance tests
(`reaper.test.ts` "frozen-signature conformance", CONTRACTS section 13) stay green unchanged. No caller had to change.

### Security properties preserved

- An **empty** root list accepts no directory at all (asserted).
- Empty-string / non-string entries in either list are skipped, so a root can never degenerate into "everything".
- `isInsideDir` is still strict (the root itself is not a child) and still `..`-proof.
- A foreign exe (`C:\Windows\System32\cmd.exe`) is still rejected with **no** `query()` and **no** `kill()` — asserted
  both at the reaper unit level and end-to-end through `compose()`.
- `tests/security/bridge-invariants.test.ts` (the `[R2]` reaper invariants) passes unchanged.

### The reviewer's proposed fix was right but incomplete — and I implemented the correction

The skeptic's correction is correct: adding the three roots fixes `npm run dev` but leaves the **e2e** fake-llama pid
file rejected, because `tests/e2e/helpers/fakes.ts:142` sets `WCA_LLAMA_CMD.command` to the Playwright runner's
`process.execPath` (node.exe), which is in none of the three roots and is not the app's `execPath`.

So compose also passes the **seam commands** as extra exact `execPath` entries:

```ts
const seamExePaths = [seams?.bridgeCmd?.command, seams?.mcpCmd?.command, seams?.llamaCmd?.command]
  .filter((c): c is string => typeof c === 'string' && c.length > 0);
```

This is safe in production by construction, not by convention: `readSeams()` (testSeams.ts:74-78) returns `null`
unless **all three** locks are open — `!isPackaged` **and** `mode === 'e2e'` (constant-folded away in a production
build) **and** `WCA_E2E === '1'`. In production `seams` is `null`, `seamExePaths` is `[]`, and the accepted set is
exactly `childExeRoots(paths)` + `process.execPath`. I covered all three seams (bridge/mcp/llama), not just llama,
because `launcher.ts:120` and `mcp/host.ts:449` put the seam command into `ChildHandle.exePath` the same way
`llamaServer.ts:321` does.

## Tests (written red first)

- `src/main/proc/supervisor.test.ts` → `parsePidFile > several legal roots` (4 new cases): accepts inside any root;
  rejects inside none and rejects a root *itself*; empty root list accepts nothing but still honours execPath; accepts
  any of several exact exe paths (the seam command) and rejects one that is not listed.
- `src/main/proc/reaper.test.ts` → `reapOrphans - several legal child roots (dev/unpackaged layout)` (5 new cases),
  driving the **real** `createPaths({ isPackaged: false })`: a live llama orphan in the unpackaged vendor dir is now
  killed; an unpackaged calendar-mcp child is killed; an extra exact exe path (the seam command) is accepted; an exe
  inside none of the roots is still rejected with no query and no kill; and `childExeRoots` is pinned for both layouts.
- `tests/integration/app-boot.test.ts` → `compose() reaper roots (unpackaged layout)` (2 new cases). This is the one
  that actually covers **compose.ts:390**: it writes a `llama.pid.json` into a fresh userData `run\` dir with
  `exePath = createPaths({appRoot: REPO_ROOT, isPackaged:false}).llamaServerExe`, boots the real `compose()` through
  the L3 harness, and asserts the boot log says `reaper_pidfile_stale` (accepted, pid gone — the harness ProcessQuery
  answers "no such process") and **not** `reaper_pidfile_rejected`. The second case pins that a foreign exe is still
  rejected.

### Proof it was red

Temporarily reverted compose to `const ownResourcesDirs = [paths.resourcesDir]` and re-ran the integration file:
`1 failed | 7 passed` — exactly the "accepts a llama.pid.json written by an unpackaged run" case. Restored
immediately. Before the product fix, the 9 new unit cases failed too (5 reaper + 4 supervisor).

## Results

- `npx vitest run src/main/proc/reaper.test.ts src/main/paths.test.ts tests/integration/app-boot.test.ts tests/security/bridge-invariants.test.ts` → **128 passed**.
- `npx vitest run src/main/proc/supervisor.test.ts -t parsePidFile` → **31 passed, 50 skipped**.
- `npx eslint` over every file I touched (`paths.ts`, `reaper.ts`, `reaper.test.ts`, `paths.test.ts`,
  `app-boot.test.ts`) → clean.

## Gate re-run after the concurrent agents landed (2026-09-27, session resumed after a usage-limit stop)

I was interrupted mid-gate by a usage limit; nothing was left half-written (all four product edits were already on
disk). On resuming I re-verified the product changes were intact and re-ran every gate:

- `npx eslint` over my eight touched files (`paths.ts`, `paths.test.ts`, `compose.ts`, `proc/reaper.ts`,
  `proc/reaper.test.ts`, `proc/supervisor.ts`, `proc/supervisor.test.ts`, `tests/integration/app-boot.test.ts`)
  → **clean, 0 problems**.
- `npx tsc --noEmit -p tsconfig.node.json` → **clean**. `-p tsconfig.web.json` → **clean**.
- `npx vitest run src/main/proc/reaper.test.ts src/main/paths.test.ts src/main/proc/supervisor.test.ts
  tests/integration/app-boot.test.ts tests/security/bridge-invariants.test.ts` → **5 files, 209 passed, 0 failed**.
- `npx vitest run tests/security src/main/proc` → 19 files, 623 passed, 1 failed (see below).

The three reds I had recorded from other agents mid-flight are **all gone**: `supervisor.test.ts(1119)` TS2349 is
fixed, the 2 `process-lifecycle-1` supervisor failures are fixed, and `compose.ts:1182 childrenStopped` prefer-const
is fixed. Nothing of mine is red.

## Red results that are NOT mine (reported, not hidden, not touched)

Still open at the end of my pass, in files owned by the injection-repair agent, not by me:

- `npm run typecheck` (tsconfig.tests.json leg) → `src/main/agent/sanitize.test.ts(51,12) TS1161: Unterminated regular
  expression literal` (+ two cascade errors on line 53). Line 51 is
  `expect(/[\r\n  ]/u.test(JSON.stringify(forged))).toBe(false);` — the character class contains RAW U+2028/U+2029,
  which terminate the regex literal for the TS scanner. It needs `  ` escapes. The `node` and `web` tsc legs
  are clean, so **no product code is broken** — only that one test file.
- `npm run lint` → the same parse error, plus `src/main/agent/sanitize.ts` 20:7 `LINE_SEPARATOR_RE` and 46:7
  `DECIMAL_DIGIT_RE` assigned but never used, plus a warning `src/main/bridge/ingest.ts:404` unused eslint-disable.

I deliberately did not edit them: they are another repair agent's half-landed work on `sanitize.ts` and editing
around it would corrupt theirs. Both whole-repo gates will go green once that lands.

- `tests/security/redaction.test.ts > after data:purgeNow ...` failed again in the *parallel* 19-file run and passed
  again **30/30 in isolation** (`npx vitest run tests/security/redaction.test.ts`). Confirmed a parallel-run flake in
  the purge/backups-dir timing, with no path to pid-file root acceptance — my change touches only which `exePath`
  values `parsePidFile` accepts.

### Historical record (what was red mid-flight, before the re-run above)

Other repair agents are editing `src/main/proc/supervisor.ts`, `src/main/proc/supervisor.test.ts` and
`src/main/compose.ts` concurrently with me. At the time I ran the gates their work was mid-flight and produced:

- `npm run typecheck`: `src/main/proc/supervisor.test.ts(1119,5): error TS2349: This expression is not callable.
  Type 'never' has no call signatures.` — inside their new `describe('pid-file startedAt (process-lifecycle-2)')`
  block (their `resolveStart` narrowing), far from my additions at lines ~202-230. An earlier run of the same command
  showed two further errors from the same agent (`ProcessInfo` not imported, `Entry.startedAt` missing) which they had
  fixed by the next run.
- `npm run lint`: `src/main/compose.ts:1182 'childrenStopped' is never reassigned. Use 'const' instead` — inside the
  `[process-lifecycle-7]` quit-guard block, not my ~10 changed lines.
- `npx vitest run src/main/proc`: 2 failures in
  `supervisor.test.ts > a ChildHandle that reports an already-known exit (process-lifecycle-1)`.

None of these touch pid-file path acceptance. I deliberately did **not** edit around them — fixing another agent's
half-written code would corrupt their work. Both gates need a re-run once the process-lifecycle-1/2/7 fixes land.

Two further reds appeared once and did not reproduce in isolation, so I record them as parallel-run flakes rather than
regressions: `tests/security/redaction.test.ts > after data:purgeNow ...` (passes alone: 30/30) and
`tests/integration/pipeline-states.test.ts > an open item older than seven days expires` (passed on re-run). Neither
has any path to the reaper roots.

## Assumptions / dead ends

- I considered a `path.relative`-based containment check instead of a root list. Rejected: it does not express the real
  shape of the problem (three legal trees), and it would have widened the accepted set rather than enumerating it.
- I considered making the unpackaged `llamaDir`/`mcpRoot` live under `<appRoot>\resources` instead. Rejected: that is a
  build-layout change (`build-plan` section 3, `vendor/` and `build-resources/` staging) and would have touched far
  more than the defect.
- `killAllSync()` on process `'exit'` does not rescue a hard-killed dev session (the skeptic is right), and
  `--sleep-idle-seconds 600` only releases VRAM — so the reaper really is the only line of defence here.
