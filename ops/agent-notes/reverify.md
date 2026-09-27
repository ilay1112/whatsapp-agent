# reverify - whole-repo re-verification after the repair round (2026-09-23)

Read-only agent. I edited nothing except this file and `ops/agent-notes/reverify/` (raw stage output).
Nothing was committed, no dependency changed, no red test was deleted, skipped or weakened.

## Stage results

| Stage | Command | Exit | Output |
|---|---|---|---|
| lint | `npm run lint` | 0 | `reverify/lint.txt` |
| typecheck | `npm run typecheck` | 0 | `reverify/typecheck.txt` |
| format | `npm run format:check` | 0 | `reverify/format-check.txt` |
| unit+int | `npx vitest run --project main --project renderer --project integration --project security` | 0 - 162 files, **3678 passed / 0 failed** | `reverify/vitest.txt` |
| smoke | `npm run test:smoke` | 0 - all six packaged checks green | `reverify/smoke.txt` |
| e2e | `npm run test:e2e` | 1 - **18 passed / 4 failed** (22 specs) | `reverify/e2e.txt` |

Note on "all projects": the fifth vitest project `golden-live` was deliberately NOT run. It is the only test that
talks to a real model (Anthropic / Google AI / a real llama-server) and the operating rules forbid that; it also
self-skips without `WCA_GOLDEN_LIVE=1`. Every other project ran.

## e2e failures (all deterministic - each failed on its first run and on Playwright's retry; the onboarding one was
re-run 4x standalone with the same failure)

### 1+2. `tests/e2e/approval-first.spec.ts:144` and `:213` - ASSERTION IS WRONG (test seam), not a product defect
Assertion: `expect.poll(() => health().llm.state).toBe('ready')` - received `'idle'`, 20 s timeout.
Both specs seed `settings.llm.provider = 'local'`. `compose.ts:733-737` maps a usable LOCAL provider to
`llm.state = 'idle'` on purpose ("Local configured, llama-server not running (lazy)"), and
`docs/specs/contracts.md:541,562` confirms `OK_LLM = ['ready','idle']` - `'idle'` IS the healthy local state.
The `WCA_LLM` seam the specs were blocked on is now genuinely wired (`src/main/index.ts:37-58` ->
`ComposeDeps.providerOverride` -> `compose.ts:677,698` -> `createProviderFactory({ seamProvider })` ->
`llm/factory.ts:75`), so the BLOCKED-BY note in those specs is stale. The precondition line should accept
`'idle'` (or the specs should seed a cloud provider + consent). I could not confirm the rest of either spec,
because both stop at this precondition.

### 3. `tests/e2e/onboarding.spec.ts:139` (QR scanned/expired/re-issued) - test-seam race, not a product defect
Assertion: no expect fails; the spec dies on `TypeError: fetch failed` (`ECONNREFUSED`, on retry `ECONNRESET`)
from the `control()` helper (`tests/e2e/helpers/fixtures.ts:217`).
Evidence I collected:
- The ToS repair WORKS. Captured main log of the run: `proc_state bridge starting` -> `bridge_marker qr_phase` ->
  `proc_state bridge running` -> `bridge_status needs_pairing`, all after `welcome-accept`. The bridge does start
  from `consent:accept` (`compose.ts:1109-1118`) on a fresh profile.
- A process/port watcher showed the fake-bridge child alive with its control server reachable from ~2.9 s to ~4.4 s,
  then gone; `proc_state bridge stopping` in the log at the same moment.
- The Playwright trace shows the failing fetch is the SECOND `control()` call, immediately after
  `page.getByTestId('qr-new-code').click()`.
That click is `pairing:newCode` -> `restartForNewCode()` (`compose.ts:977-981`) = stop + restart + start, which is
correct product behaviour. But the child-mode control server lives INSIDE the fake bridge child
(`tests/fakes/fake-bridge.ts:632-705`), so it dies with the restarted child, and the spec fires
`control(setPairing qr_pending)` at it with no wait/retry. Verified the fake itself is fine: run standalone, the
same verb answers HTTP 200.
Fix belongs in the e2e helper (retry `control()` until the restarted child's port is listening again, or wait for
`bridge_status` to return to `needs_pairing` first). Secondary hardening worth having: `control.listen()` in the
fake has no `'error'` handler, so any bind failure kills the child silently.

### 4. `tests/e2e/tray-lifecycle.spec.ts:145` (second launch exits, first window re-shows) - test-seam defect created
by a CORRECT product repair
Assertion: never reached - `electron.launch: Target page, context or browser has been closed` at
`tests/e2e/helpers/fixtures.ts:270`, i.e. inside the fixture's own `launch()`.
`src/main/index.ts` now really takes `app.requestSingleInstanceLock()` in e2e mode (the repair), so the second
instance quits within milliseconds - before Playwright finishes attaching over the debugger/DevTools websockets
(both sockets disconnect in the browser log, exitCode 0). The spec's stale comment still says an e2e build never
takes the lock; the product side is fixed. The helper cannot launch a process that is designed to exit instantly:
the second instance has to be started as a raw child process (or `electron.launch` wrapped so the close is the
expected outcome) and then asserted on its exit code + the first window's visibility.

## Judgement summary
- Product code: no defect proven by any of the four failures. The three repairs I could observe directly
  (bridge-after-ToS, WCA_LLM seam, single-instance lock) all behave as intended.
- All four red e2e specs are test-side: two stale assertions/comments (approval-first), one missing re-wait after a
  deliberate bridge restart (onboarding), one launch helper that cannot model an instantly-exiting instance
  (tray-lifecycle).
- Everything else in the repo is green: lint, typecheck, format, 3678 vitest tests, and the packaged smoke run.
