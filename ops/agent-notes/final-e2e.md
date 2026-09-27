# final-e2e - closing the last e2e test-seam defects (2026-09-27)

Owner of `tests/e2e/**` and `playwright.config.ts` for this run. Read first: `reverify.md` (the four traced failures),
`repair-compose-defects.md` (REQUEST 1, REQUEST 3), `repair-renderer-csp.md` and `repair-test-fakes.md` (hand-offs).

**No product file was changed.** Everything below is under `tests/e2e/`. `playwright.config.ts` needed no change.
No dependency added, no version changed, nothing committed, no installer built, no packaged GUI, no real binary, no
network target other than 127.0.0.1, nothing under the reference bridge's `store` touched.

## 0. Result

| Gate | Command | Result |
|---|---|---|
| e2e (full, run A) | `npm run test:e2e` (= `build:e2e` + `playwright test`) | **22 passed / 0 failed / 0 flaky**, exit 0, 1.6 min |
| e2e (full, run B, same tree) | `npm run test:e2e` | see section 6 (appended after the run) |
| lint | `npm run lint` | see section 6 |
| typecheck | `npm run typecheck` | see section 6 |
| format | `npm run format:check` | see section 6 |
| e2e tree gates | `prettier --check tests/e2e`, `tsc -p tsconfig.tests.json`, `eslint tests/e2e --max-warnings 0` | clean after every edit |

"Flaky" here means a spec that passed only on Playwright's retry; run A had no retry at all (every spec `ok` on its first
attempt, no `retry #1` line in the reporter output). Starting point was `reverify.md`'s **18 passed / 4 failed**.

Raw reporter output of every run is in my scratchpad only (not in the repo); the numbers above are copied from it.

## 1. The four diagnosed defects - verified against the code, then fixed

### 1.1 `approval-first.spec.ts` - `'ready'` precondition (both scripted specs)

Verified: `compose.ts` ~L816-819 publishes `llm.state = 'idle'` for a usable LOCAL provider ("Local configured,
llama-server not running (lazy)") and `'ready'` for a cloud provider with a key; `docs/specs/contracts.md` L562
`OK_LLM = ['ready', 'idle']` makes `'idle'` a healthy state. Both specs seed `provider: 'local'`.

Fix: one `HEALTHY_LLM = /^(ready|idle)$/` with the citation, both `expect.poll(...).toBe('ready')` ->
`.toMatch(HEALTHY_LLM)`. Anything outside the set (`model_missing`, `consent_missing`, `failed`, ...) still fails.
The three stale BLOCKED-BY notes (file header, both test doc comments, both inline comments) are gone; the header now
names the real wiring (`index.ts` -> `ComposeDeps.providerOverride` -> `createProviderFactory({ seamProvider })`).

### 1.2 `onboarding.spec.ts` - `control()` after "new code"

Verified: `pairing:newCode` -> `bridgeControl.restartForNewCode()` = `stopBridge()` + `launcher.restartForNewCode()` +
`startBridge()` (`compose.ts` ~L1060); the fake's control server is created inside `runChildMode()`
(`tests/fakes/fake-bridge.ts`), so it dies with the old child and comes back with the new one on the same port. The
Supervisor removes `bridge.pid.json` on exit and rewrites it on spawn (`proc/supervisor.ts`).

Fix (spec + helper, product untouched): capture the bridge pid before the click; after the click poll until
`readChildPids(userDataDir).bridge` is a different, non-null pid (proof the old child is gone and the new one is
tracked); then `waitForControl(port, secret, 30_000)` before the next `control()`. `waitForControl` /
`controlReachable` are new in `helpers/fixtures.ts`: they POST the non-existent verb `ping` with the secret - the fake
answers 404 without touching state, so any HTTP answer means "listening"; ECONNREFUSED/ECONNRESET means "not yet".
Waiting for the pid first closes the race where the OLD server would still answer the probe.

### 1.3 `tray-lifecycle.spec.ts` - second instance

Verified: `index.ts` L69 `const gotLock = app.requestSingleInstanceLock()` is unconditional; L99 `app.quit()` without
it; L118 `second-instance` shows + focuses the window. Playwright's `electron.launch` cannot attach to a process that
quits within milliseconds (the trace shows both websockets connect and then drop, exit code 0).

Fix: `E2eContext.spawnRaw({ userDataDir, env })` in `helpers/fixtures.ts` starts the app with `node:child_process`
using the SAME argv / cwd / minimal env as `launch()` (both now come from one private `launchSpec()`), and the same
executable Playwright resolves (`require('electron/index.js')` via `createRequire`, verified against
`playwright-core/lib/coreBundle.js`: Playwright passes `options.env` through untouched and only prepends
`-r loader.js` when no `executablePath` is given - which is why `launch()` itself was left exactly as it was).
The spec asserts: exit within 20 s, no signal, exit code 0, no child pid file created by the second instance, then the
first window is visible, focused, still the only window, and the first app is still running. A raw instance still
alive on dispose is killed by an `onStop` hook.

### 1.4 `helpers/fixtures.ts` - facade alignment + console rule

- `WcaTest` is now a mapped type over `WcaTestHooks` from `src/main/testSeams.ts` (seven read hooks + `trayClick`,
  promisified), so a hook that disappears from the frozen facade becomes a TYPE error in the helper. `notify` and the
  `tray` / `clickTray` fallbacks are gone; `wca()` calls each hook by its frozen name and throws on a missing one.
  `hasHook()` takes `keyof WcaTestHooks` now.
- `ALWAYS_ALLOWED_CONSOLE` is gone entirely; `allow` is exactly `opts.allowConsoleErrors ?? []`. No other console
  message surfaced in any run (every spec collects renderer console errors and fails on dispose if any exist), so
  there is nothing to report here. `app.spec.ts`'s per-launch opt-in for its deliberate `connect-src` refusal is
  unchanged.

## 2. Two MORE test-seam defects, found once the scripted specs could run past their precondition

`reverify.md` was explicit that it could not see past the precondition. Once it was fixed, `approval-first.spec.ts`
"approve -> ... create-event" was still red, for two reasons that were never visible before. Both are test-side; both
were traced through kept profiles (`E2E_KEEP_TMP=1`, section 4) and one instrumented run, and in both cases the
product behaves exactly as its own specs say.

### 2.1 No calendar was ever connected, so "Add to calendar" could not exist (both scripted specs)

`validate.ts` ~L203-212 inserts a `create_event` action "only if event_state='proposed' and the calendar is connected"
(ARCHITECTURE 6.5, verbatim); `compose.ts` L625 `calendarConnected = mcpHost.status() === 'connected'`, and the MCP
host is only started when `<userData>\google\gcp-oauth.keys.json` exists (`compose.ts` L606 / L1342). The spec seeded
`targetCalendarId: 'primary'` but never called `seedGoogleCredentials(userDataDir)` (which `tray-lifecycle.spec.ts`
does for the same reason), so the event chip rendered (it is data) but `approve-event-<id>` was withheld by design.

Fix: `seedGoogleCredentials(userDataDir)` in BOTH scripted specs, with the citation. For the attacker spec this is a
strengthening: with no calendar the tool gate exposes nothing and "no calendar write" held vacuously; now the attacker
model has a real `create-event` tool it could try to reach, and the assertion is about the gate + approval-first.
It stayed green.

### 2.2 In attach mode nothing rang the doorbell, so ingest depended on a 250 ms race (all three approval specs)

With the calendar connected, BOTH scripted specs then failed earlier: no card within 30 s, and the kept profile
showed `items` EMPTY and no `bridge_rowid_watermark` - ingest never scanned once after boot. Traced:

- In attach mode the fake bridge is started before the app exists, so it has no webhook URL and never POSTs the
  doorbell (`fake-bridge.ts postWebhook`: returns when `webhookUrl === undefined`).
- After boot, ingest is poked only on the bridge's `online` transition and at the end of `compose.start()`
  (`compose.ts` L971 / L1356) - both BEFORE the spec writes its row - and then by the 30 s fallback timer
  `every(LIMITS.scanIntervalMs)` (L1359). `WCA_TIMERS.scanMs` does NOT shorten that timer: `compose.ts` L898 applies
  it to the triage queue only. The attach-mode launcher emits status only on change (`setStatus` early-return), so
  no periodic re-poke exists.
- Ingest's `poke()` has a 250 ms trailing debounce. The no-calendar runs passed only because the spec's row landed
  inside that window of the LAST boot poke; a connected calendar moves that poke ~250 ms earlier (the calendar-mcp
  spawn + handshake runs after the bridge's online transition), so the window was always missed, and the card
  deadline (30 s after the inbound) expired just before the 30 s timer's scan reached the UI. This also explains
  why the two scripted specs were the slow ones in `reverify.md`'s run (56 s: they waited for the 30 s timer).

Fix: `AttachedBridge.deliver(app, msg)` in `helpers/fakes.ts` = `fake.inbound(msg)` + `fake.ringDoorbell(url, payload)`
at `__wcaTest.doorbellUrl()` with the real webhook body shape (`sender/content/chatJID/isFromMe`), exactly what the
real bridge does per inbound (bridge-contract: one POST per message, `X-Bridge-Token` = the bridge token; attach mode
hands the doorbell the fake's token through `endpoint: attachedEndpoint`). The helper fails the spec on a non-200 ring.
All three attach-mode inbounds in `approval-first.spec.ts` now go through it; the first spec dropped from "6 s if the
race is won" to a deterministic path (still ~6 s, now for the right reason).

### 2.3 The edited-and-sent card stays put by design; the spec must press "Refresh card"

With 2.1 + 2.2 the send and the create-event both succeeded (fake bridge `sent` = 1, fake MCP `create-event` = 1,
`items.state = 'in_calendar'`, both actions `done` and approved in the kept DB) and only the last UI assertion failed:
the card was not under `list-in_calendar`. An instrumented run showed `dashboard:get` already answering
`needsReply: []` / `inCalendar: [item 1]`, while the DOM still had `card-1` in the needs-reply column with
`stale-1` + `refresh-1`, and the in-calendar column with `count 1`, `empty-in_calendar`, `more-in_calendar`.

That is the documented behaviour, not a defect: `docs/specs/ux.md` L421 (bold in the spec) "A card whose inputs have
focus or unsaved edits is never re-rendered from server data, never reordered and never removed; instead it shows the
inline notice 'This card changed - review again' with a 'Refresh card' button". `ItemCard.tsx` L169
`dirty = focusedInputs || draft !== suggestion`: the spec typed a different draft, the send consumed it, the proposal's
suggestion never changes, so the card stays dirty and pinned.

Fix: after the send succeeds the spec now asserts the `stale-<id>` notice, presses `refresh-<id>`, asserts the notice
is gone and that refreshing sent/wrote nothing, THEN approves the event on the clean card and asserts the automatic
move to "In calendar" (ux.md L542: "then the list refreshes - the item moves or leaves according to deriveState") and
that the card left the needs-reply column. The flow now proves both documented rules instead of assuming the second.

## 3. Files changed (all under my ownership)

| File | Change |
|---|---|
| `tests/e2e/helpers/fixtures.ts` | `WcaTest` mapped from `WcaTestHooks`; `notify` + fallbacks removed; `ALWAYS_ALLOWED_CONSOLE` removed; `controlReachable` / `waitForControl`; `electronExecutable`; `RawInstance` + `E2eContext.spawnRaw`; private `launchSpec()` shared by `launch()` and `spawnRaw()`; `E2E_KEEP_TMP=1` post-mortem opt-out in `dispose()` (section 4); doc comments |
| `tests/e2e/helpers/fakes.ts` | `AttachedBridge.deliver(app, msg)` (row + doorbell ring) |
| `tests/e2e/approval-first.spec.ts` | `HEALTHY_LLM` precondition x2; stale BLOCKED-BY notes removed; `seedGoogleCredentials` x2; `deliver()` x3; the Refresh-card step + two extra assertions |
| `tests/e2e/onboarding.spec.ts` | pid-change + `waitForControl` wait after `qr-new-code`; three stale comments rewritten (pairing-leg header, history-sync note, Google-leg header + assertion message) |
| `tests/e2e/tray-lifecycle.spec.ts` | second instance via `spawnRaw`; stale comment rewritten; exit-code / signal / no-child / single-window assertions |

Not changed: `playwright.config.ts`, every file outside `tests/e2e/`. No assertion was deleted, skipped or weakened;
the only assertion values that changed are the two `'ready'` -> `ready|idle` (cited in 1.1). Everything else is added.

## 4. New debugging affordance: `E2E_KEEP_TMP=1`

Set in the RUNNER's shell (it is not in `MINIMAL_ENV_KEYS`, so the app never sees it), `E2eContext.dispose()` keeps
the spec's temp root and prints its path. `<root>\<profile>\app.db` and `<root>\<profile>\logs\main.log` were the only
way to see what the app had done once a launch was gone (Playwright's Electron trace carried no DOM snapshots here).
Off by default; a green run leaves nothing behind. The four roots I kept during this session were deleted again.

## 5. Findings and observations for other owners (nothing done, reported only)

1. **`WCA_TIMERS.debounceMs` probably does not reach the triage queue.** In every scripted run the trigger row landed
   at T and `llm.factory.provider.created` / `triage_done` were logged at T + 20.1 s, which is `LIMITS.debounceMs`
   (20 000) - while the spec passes `debounceMs: 100`. `compose.ts` ~L892-900 does forward it to `createTriageQueue`.
   Not chased (product file); it costs each scripted spec ~20 s and is worth a look by the compose/queue owner.
2. **`WCA_TIMERS.scanMs` shortens the queue scan, not the 30 s ingest timer** (`LIMITS.scanIntervalMs`,
   `compose.ts` L1359). TESTS 4.2 does not say which scan it means. The e2e specs no longer depend on that timer
   (2.2), so this is a documentation/seam clarity point, not a blocker.
3. **UX observation (design as written, ux.md L421 vs L542):** after "(v) Sent" with an EDITED draft, the card keeps
   showing "This card changed - review again" and only moves after "Refresh card". A user who edits the draft (the
   product's main selling point) sees that notice on every send. Worth a product decision whether a successful
   approval should clear the dirty state of the input it consumed. The e2e spec now documents the current behaviour.
4. `onboarding.spec.ts` "Google sign-in leg": the recorder is installed (`__wcaTest.openedExternal`) and the test still
   stops at asserting that. Clicking "Sign in" and asserting the recorded `accounts.google.com` URL is a possible
   extension; not done here (outside the four defects, and a new assertion in a flow I did not verify).
5. Secondary hardening from `reverify.md` (the fake's `control.listen()` has no `'error'` handler) is still open;
   `tests/fakes/**` is not my path.
6. `docs/ACCEPTANCE.md` L127 still says "4 of 22 e2e tests are red" - the orchestrator may want to update it.

## 6. Second run + repo-wide gates

| Gate | Result |
|---|---|
| e2e run B (`npm run test:e2e`, same tree, fresh `build:e2e`) | **22 passed / 0 failed / 0 flaky**, exit 0, 1.5 min - again no `retry #1` line, every spec `ok` on its first attempt |
| `npm run lint` | exit 0 |
| `npm run typecheck` (node + web + tests) | exit 0 |
| `npm run format:check` | exit 0 |

Two consecutive full runs on the final tree, 44 spec executions, 0 failures, 0 retries. The four `wca-e2e-*` temp roots
kept for the post-mortems were deleted afterwards (none left under `%TEMP%`).

Final tally against the brief: the 4 diagnosed defects closed (1.1-1.4), plus 3 further test-seam defects that were
hidden behind them (2.1-2.3), all in `tests/e2e/**`; 0 product changes; 0 red tests left to report; 6 observations for
other owners in section 5 (one of them, the `debounceMs` seam, is worth a product-side look).
