# W2-01-compose-integration

Owns: `src/main/index.ts`, `src/main/compose.ts`, `tests/helpers/harness.ts`, `tests/integration/**` (except
`mcp-real-toolslist.test.ts`), `src/shared/locales/**`, the root configs of build-plan section 6 row 1,
`src/main/notImplemented.ts`; plus the **fix-up right** on any `src/**` file for integration defects.

## 0. Result

| Gate | Result |
|---|---|
| `npm run lint` | **exit 0** |
| `npm run typecheck` (node + web + tests) | **exit 0** |
| `npm test` (main + renderer + integration + security) | **exit 0** - 145 files / **3132 tests**, 0 failures |
| `npm run build` | **exit 0** |
| `npm run build:e2e` | exit 0; the e2e bundle contains the seam strings, the production bundle does **not** (`grep -c 'WCA_BRIDGE_CMD\|__wcaTest' out/main/index.js` = 1 vs 0) |
| coverage (`--coverage`, own reports dir) | no threshold ERROR; 95.6 % statements / 90.5 % branches / 92.7 % functions / 96.8 % lines |
| ledger | clean in every integration test (`tests/helpers/ledger-hook.ts` is an `afterEach` in the integration project and the harness attaches the fakes + app DB with `attachLedgerSources`) |
| `NotImplementedError` in `src/**` | **none**; `src/main/notImplemented.ts` deleted |
| `npx prettier --check .` | 204 files -> **14**, all owned by W2-02 / W2-04 (section 6) |

## 1. Baseline found at start (2026-09-23)

The two Wave-1 fix-round items in `wave1-audit.md` section 6 were **already fixed by their owners** before I started;
I verified before touching anything: lint 0, typecheck 0, `--project main` 103 files / 2553 tests green,
`--project renderer` 30 files / 427 tests green. The only red things in the repo were the ones this package owns
(`compose()` and `createHarness()` were still Wave-0 throwing stubs).

## 2. What was built

### 2.1 `src/main/compose.ts`

The wiring of build-plan section 7, in this order: paths/dirs -> `openDbWithRecovery` + `createRepos` (+ `db_recovery`
audit, slow-statement handler) -> settings bus -> OS time zone -> main i18n -> secrets + HealthHub -> window ref +
notifier -> **reaper before any spawn** -> supervisor -> **doorbell (listening before the launcher)** -> bridge launcher
-> bridgeDb + ingest -> MCP host + three narrowed facades + GoogleAuth -> model manager + lazy llama runtime + provider
factory -> ToolGate -> S0 / queue / orchestrator / ItemService -> ActionExecutor -> IPC handlers -> settings-driven side
effects -> timers -> `start()` / `shutdown()`.

Notable decisions:

- **The doorbell listens inside `compose()`, not inside `start()`.** `createBridgeLauncher` draws its port with
  `freePort({exclude:[doorbell.port()]})` and `rotateSecret()` must already return a live
  `http://127.0.0.1:<port>/hook/<secret>`, or the spawn is refused (`webhook_wrong_port` / `webhook_no_secret`).
  One secret is minted immediately, so `doorbellUrl()` is usable the moment `compose()` returns - which is what lets the
  L3 harness point its in-process fake bridge at the real doorbell.
- **All three children go through the Supervisor** (`bridge`, `calendar-mcp`, `llama`), because the Supervisor is the
  only thing that writes `<userData>\run\<name>.pid.json` and the Reaper is useless without those files (ARCH 3
  "Supervisor x3 + Reaper (PID files)"). The IPC-facing launcher is a thin facade whose `relink` /
  `unlinkAndWipe` / `restartForNewCode` stop the supervised child first and restart it through the Supervisor
  afterwards, so the two never race to spawn.
- **`AppRuntimeHandle`** widens the frozen `AppRuntime` (same additive pattern as `BridgeLauncherHandle` and
  `McpHostWithChildSpec`): `repos`, `settings`, `paths`, `recovery`, `attachWindow`, `windowState`, `isTrusted`,
  `trayState`, `t`, `uiLanguage`, `togglePause`, `killAllSync`, `poke`, `started`, `doorbellUrl`, `doorbellStats`.
  Every consumer written against `AppRuntime` still compiles. This is what keeps `index.ts` thin and what the harness
  drives.
- **`ComposeDeps.providerOverride?`** (additive, optional) is the whole-provider seam behind
  `ProviderFactoryDeps.seamProvider`. The frozen `sdk?` seam only covers the two cloud SDK *clients*, so there was no
  way to inject a `StubLlm` / `ObedientAttackerLlm` without it. Consent and key rules still run first, because the
  factory checks them before it asks for the seam.
- **Attach mode** (`seams.fakeBridge`, TESTS 4.2): when a bridge is already listening, nothing is spawned or
  supervised. The REST client, the pairing poller and `bridgeStatusToErrorCode` are the production modules; only the
  process lifecycle is skipped. `seams.fakeBridge.url` is read at call time so a test can start its fake after
  `compose()` returned.
- `llmStatusFor(code)` maps the `ProviderFactory.usable()` ErrorCode onto the right non-ready `LlmStatus`; a usable
  local provider reports `idle` (llama-server is lazy), a usable cloud provider reports `ready`.
- `cloudDailyTokenBudget()` is the ceiling **minus** `runs.cloudTokensSince(start of the local day)`, i.e. tokens
  REMAINING, per W1-10's wiring contract.

### 2.2 `src/main/index.ts`

`registerAppSchemes()` + `setAppUserModelId` + `requestSingleInstanceLock` at module top level before any `await`; the
e2e seam branch behind `import.meta.env.MODE === 'e2e'` (constant-folded out of production - verified); the real
`ElectronFacade` (async `encryptStringAsync`, synchronous `decryptString` so `secrets.has().last4` is exact from the
first read; the `Notification` `click` handler forwards to the notifier); `configureElectronLog` + `createLogger`;
`registerIpc(ipcMain, ...)` with `isTrusted` / `windowState` from the runtime; window + close-to-tray + coach mark +
`onRenderProcessGone` -> rebuild; tray; the seven `AppRuntimeEvent` -> `IpcEvent` pushes; `second-instance`;
`before-quit` -> `runtime.shutdown()` (which runs the real `runQuitSequence`) -> destroy tray -> `killAllSync` ->
`app.exit(0)`; `session-end` and `process.on('exit')` -> `killAllSync`.

`electron-log/main` is imported in `index.ts` only, and the ready-made `Logger` goes in through the frozen
`ComposeDeps.logger`. W1-12 asked for it "in compose.ts", but `compose.ts` has to load under plain Node in vitest, and
importing `electron-log/main` there would drag `electron` into every L3 test. The rule W1-12 cares about - one import
site, nothing else touches that module - holds.

### 2.3 `tests/helpers/harness.ts`

`createHarness(opts)` (exported again as `createTestApp`) over the **production `compose()`**: temp `userData` under
`os.tmpdir()`, a real `app.db` on disk, the in-process `FakeBridge` writing a real `messages.db`, `FakeMcpCalendar` over
`InMemoryTransport`, `StubLlm` / `ObedientAttackerLlm` through `providerOverride`, virtual clock + seeded random, a
captured logger, the electron mock's `safeStorage`, and a spawn that **throws** so no L3 test can ever start a child.
`invoke()` goes through the real `registerIpc` against an in-memory `ipcMain` double, so the trusted-sender check and
the zod parse are the shipped ones.

Two mechanics worth knowing before writing another L3 test:

- **`pumpUntil`**: `invoke()` and `dispose()` advance the VIRTUAL clock while their promise is pending. Without it
  `action:approve` deadlocks - the executor's send jitter is a `clock.setTimeout` nobody would fire - and `shutdown()`
  hangs in `executor.drain()`.
- **`settle()` never calls `clock.runAll()`**: `compose()` keeps four periodic timers armed for the whole process life
  (ingest scan, media janitor, retention, backup), so "run every pending timer" can never terminate. It advances in
  bounded rounds instead. It also burns ~10 minutes of virtual time, which is longer than `LIMITS.editLockMs` - a test
  about the edit lock must use a bounded `advance()` instead.
- The profile is seeded **once per userData directory** (detected by `app.db` not existing). A restart on the same
  directory re-opens exactly what the crash left behind, which is what the recovery tests need.

### 2.4 `tests/integration/**` - 11 files, 142 tests

| File | Covers |
|---|---|
| `app-boot.test.ts` | the harness itself: boot, every IPC channel through the real `register.ts`, strict-payload rejection + `ipc_rejected` audit, `assertSettingsBusContract(runtime.settings)`, health, clean dispose |
| `pipeline-happy.test.ts` | TESTS 6 row 1, en + he: doorbell -> scan -> debounce -> S1..S4 -> draft + proposed event + two pending actions; approve send -> exactly one `/api/send` with the textarea text and **no extra body keys**; approve create -> one `create-event` with whitelist args only -> `in_calendar` -> closes `replied` |
| `pipeline-burst-retriage.test.ts` | row 2: 5 messages -> one run; new inbound -> version+1, old actions superseded, approving the old `actionId` fails `ACTION_STALE` and sends nothing; the edit lock keeps the shownHash valid |
| `pipeline-states.test.ts` | row 3: `info_missing` + "Add to calendar" with **zero** extra LLM calls; confirmation + busy calendar -> `conflict` badge without S3; `needsReply=false` -> closed `not_needed`; answered from the phone (both the reply-only and the event-pending shapes); dismiss/restore; 7-day expiry |
| `pipeline-gates.test.ts` | row 4: a 300-row history sync -> zero items, zero runs, zero LLM calls; unknown sender -> raw held card -> "Analyse this chat" runs it; `never` policy; Pause; a cloud provider without consent -> `waiting_llm` + `consent_missing` |
| `pipeline-failures.test.ts` | row 5: schema-invalid twice -> `LLM_BAD_OUTPUT` raw card + re-triage; `auth` -> `KEY_INVALID`, one attempt, no fallback; `rate_limited` -> the chat is deferred, not hammered; no calendar -> drafting continues, empty tool list, no `create_event` |
| `bridge-lifecycle.test.ts` | row 6 (see the scope note in section 5): `meta.last_online_ts` on the edge away from online + `WA_OFFLINE`; `meta.paired_at` + `live_from_ts` on `qr_pending -> connected`; `resolveLidChats()` on an ONLINE transition; the 30 s scan catching up after a lost doorbell; a message whose TEXT is a bridge stdout marker is inert; a doorbell ring with the wrong token is rejected |
| `recovery.test.ts` | row 7: restart re-opens the same DB; `executing` -> `unknown_outcome`, never re-executed; reconcile promotes it to `done` from the outbound row; still-unknown -> "Send again" as a NEW pending action needing its own approval; `[R2]` "Add again" re-uses the chain-root `eventId` so only ONE event exists; `running` -> `queued` |
| `scaffold-smoke.test.ts` | W0's, kept |
| `mcp-real-toolslist.test.ts` | W1-05's, untouched |
| `tests/golden/golden.test.ts` | W1-10's, untouched (see REQUESTS) |

### 2.5 Locale fold-in

`src/shared/locales/pending/{W1-11-exec,W1-15-renderer-dashboard,W1-16-renderer-setup}.json` were folded into
`en.json` / `he.json` (**319 new keys per language**) and `pending/` was deleted. `calendar.eventDescription` came from
`W1-11-exec.json` and overwrote the seeded base value, exactly as W1-11 asked. `card.analyseExplain.cloud` keeps its
`{{vendor}}` interpolation. Key parity holds in both directions except the five Hebrew-only `_two` plural forms, which
`locales.test.ts` already allows. `locales.test.ts` (26) and `i18n.usage.test.ts` (7) are green.

`src/shared/i18n/resources.ts` keeps its `import.meta.glob('../locales/pending/*.json')`: it resolves to `{}` now and
leaves the mechanism in place for a future package, at the cost of ~14 uncovered lines in a file that is still at 97.5 %.

## 3. Fix-up edits to files this package does not own

Build-plan section 5 requires one line per edit.

| File | Reason |
|---|---|
| `src/main/exec/actionExecutor.ts` | **Integration defect found by TESTS 6 row 7.** After a crash, `recoverOnStartup()` marked the action `unknown_outcome` but nothing ever created the retry clone, so the card could not offer "Send again" / "Add again" - the row that TESTS section 6 requires was unreachable. The clone cannot be created inside `recoverOnStartup()` either, because `compose.ts` runs a SECOND `reconcileUnknown()` with the bridge store afterwards (the frozen `ActionExecutorDeps` carries no bridge DB) and an action that pass resolves to `done` must not get one. Added `offerRetryForUnknown()` on an additive `ActionExecutorHandle` return type (frozen `ActionExecutor` untouched) and called it from `compose.start()` after both reconcile passes. It is idempotent, skips a row whose approved payload retention has already nulled, and never replays anything. |
| `src/main/exec/actionExecutor.test.ts` | Four colocated tests for the method above - `src/main/exec/**` carries a 100 %-lines per-file coverage threshold, so the addition had to bring its own coverage. Also re-typed the rig's `exec` to `ActionExecutorHandle` (it was casting to `ActionExecutor & ActionExecutorInternals`). |
| `src/preload/index.ts`, `src/renderer/src/styles.css` | **Restored** to their pre-format bytes after the repo-wide Prettier pass and added to `.prettierignore` (which this package owns), because `src/preload/index.test.ts` and `src/renderer/src/styles.test.ts` assert on the exact SOURCE TEXT of those two files. Formatting them turned two green tests red. No content change. |
| everything else under `src/**`, `tests/fakes/**`, `tests/helpers/**`, `tests/mocks/**`, `tests/golden/**`, `tests/setup-renderer.ts` and the root configs | **Formatting only** - the single repo-wide Prettier pass assigned to this package by `wave1-audit.md` section 2.3. No behavioural edit. Verified afterwards: lint 0, typecheck 0, 3132 tests green, build 0. |

Nothing outside `src/**` was changed behaviourally, and nothing owned by W2-02 / W2-03 / W2-04 was touched at all.

## 4. Cross-package requests fulfilled

From every `ops/agent-notes/W1-*.md` REQUESTS section and `wave1-audit.md` section 5.

- **W1-01** - `createSupervisor({runDir, now, log, clock, processQuery, killSync, random})`; `processQuery` is
  `createWindowsProcessQuery({spawn})` built in `index.ts`; `reapOrphans(paths.runDir, ownResourcesDir, {...})` runs
  **before any spawn**; `ownResourcesDir` is `paths.resourcesDir` (the shipped-children directory); `killAllSync()` is
  reachable from `session-end`, `process.on('exit')` and the end of the quit sequence; `stopAll({graceMs:3000})` order
  untouched. The three additive optional parameters are **ratified by use**.
- **W1-02** - `meta.last_online_ts` on every edge away from `'online'` and on quit; `meta.paired_at` + recomputed
  `live_from_ts` + `ingest.resolveLidChats()` on `qr_pending -> connected`, and `resolveLidChats()` on every edge INTO
  `'online'`; `onMarker('history_sync_done')` -> `ingest.poke()` and the end of the `syncing()` window;
  `resolveBridgeExe({bridgeExe, e2e, seamBridgeCmd})`; `launcher.errorCode()` feeds the health part (no re-derivation
  from audit rows); the doorbell listens before `launcher.start()`.
- **W1-03** - `createIngest({bridgeOnlineOnce, syncing})`; `poke()` from the doorbell, the 30 s timer, app start, every
  ONLINE transition and the history-sync marker.
- **W1-05** - `createMcpReadClient/WriteClient/AdminClient(host.callerFor('read'|'write'|'admin'))` - the only three
  `callerFor` calls in the codebase; `createMcpHost` with `audit`, `clock`, `log`, `appVersion` and the `WCA_MCP_CMD`
  `spawnOverride`; `createGoogleAuth` over the same host instance; `host.childSpec()` registered with the Supervisor.
- **W1-06** - `client` is left undefined in production; `ComposeDeps.sdk` is never defaulted.
- **W1-07** - the local provider is built lazily by `llm/factory.ts` and disposed on every provider switch and on quit
  (`providerFactory.invalidate()` is the first step of `stopChildren`); `modelPath: () => modelManager.readyPath(tier) ?? ''`;
  `allowHttpLoopback` is false unless the `WCA_MODEL_MANIFEST` seam is set.
- **W1-10** - `cloudDailyTokenBudget()` is tokens REMAINING today; `enqueueRetriage` is `queue.poke` bound, never a
  second enqueue; `calendarConnected` reaches S2/S4 through the ToolGate and `ItemService`.
- **W1-11** - the second `reconcileUnknown({repos, bridgeDb, read, now, timeZone})` runs in `start()` once the bridge
  store is open; `ItemService.detail` is wired into `ActionExecutorDeps.detail`; `calendar.eventDescription` came from
  `W1-11-exec.json` at fold-in; the repo-wide Prettier pass ran.
- **W1-12** - `configureElectronLog(...)` + `createLogger(...)` with `electron-log/main` imported in exactly one file;
  the facade's `notify` forwards the `Notification` `click` to `notifier.handleClick()`; `safeStorage` uses the async
  encrypt API; `registerAppSchemes()` at module top level and `registerAppProtocol({rendererDir})` after ready;
  `createMainWindow({onRenderProcessGone})` rebuilds the window; `isHiddenStart(process.argv)` supplies `startHidden`.
- **W1-13** - `'**/*.fixtures.*'` added to `coverage.exclude` in `vitest.config.ts` (the `v8 ignore` pair in
  `register.fixtures.ts` can now go - that file is W1-13's); the `SettingsBus` notifies after `patch()` **and**
  `setInternal()`, and `app-boot.test.ts` proves it with `assertSettingsBusContract(runtime.settings)`;
  `windowState().shownByNotificationAt` comes from the notifier.
- **W1-14 / W1-15 / W1-16** - the locale fold-in; `pending/` is gone.

## 5. Not covered / deliberately left

- **`bridge-lifecycle.test.ts` runs in ATTACH mode.** The child-process half of the TESTS section 6 row - crash (exit 0)
  => respawn with a different port AND token, `bind_fail`, `foreign_listener`, `logged_out`, `client_outdated` +
  breaker - is spawn-lifecycle behaviour and is covered at L1/L2 by `src/main/proc/supervisor.test.ts` (W1-01) and
  `src/main/bridge/launcher.test.ts` (W1-02, 155 tests incl. every `BRIDGE_MARKERS` string echoed as message content).
  Driving it at L3 needs a second harness shape that spawns `node tests/fakes/fake-bridge.ts` as a real child with a
  control port and a matching `S-HASH` sha256 of `process.execPath`; W2-03 exercises the same path end to end in child
  mode. **This is a coverage gap at L3, not a defect, and it is the one row of TESTS section 6 that is not fully
  reproduced here.**
- **`npx prettier --check .` still reports 14 files**, all outside this package's ownership and all plausibly being
  edited by a Wave-2 agent right now: `electron-builder.yml`, `scripts/{hash-bridge,import-bridge,pin-models,smoke-packaged,stage-calendar-mcp}.mjs`
  (+ their `.test.mjs`), `tests/security/import-graph.test.ts`, `tests/security/injection-corpus.{en,he}.json`,
  `tests/setup-guards.ts`. Build-plan rule 8 forbids formatting another package's files, so they are listed under
  REQUESTS instead. `npm run verify` (W2-04's gate) needs those 14 formatted by their owners.
- `tests/golden/golden.test.ts` was **not** re-pointed at `createHarness()`. `tests/golden/**` is W1-10's path, not
  this package's, and the file is green as it stands (it builds its own orchestrator over a real in-memory `app.db`).
  Left as a REQUEST.

## 6. Dead ends / things that cost time

- **The virtual clock and `dispose()`.** The first harness deadlocked in `afterEach`: `executor.drain()` polls through
  the injected `sleep`, which is a `clock.setTimeout` nobody fires while the test awaits `shutdown()`. `pumpUntil`
  (advance the clock while the promise is pending) is the fix, and the same trick is what makes `action:approve`
  resolvable at all.
- **`clock.runAll()` is unusable in this app.** `compose()` always has four self-rearming timers, so `runAll` throws
  "timers keep rescheduling" by design. Every drain loop must be bounded by rounds.
- **Async polls only tick once per `advance()`.** The attached bridge's health poll and the pairing poller re-arm
  *after* their `await`, so a single `advance(60_000)` fires one tick, not three. `bridge-lifecycle.test.ts` has a
  `poll()` helper that advances repeatedly; forgetting it looks exactly like a wiring bug.
- **Formatting a file whose test greps its own source.** The repo-wide Prettier pass broke
  `src/preload/index.test.ts` and `src/renderer/src/styles.test.ts`. Restoring the two sources and adding them to
  `.prettierignore` keeps both `format:check` and the tests green; there is no third option that keeps both.
- **A frozen DB trigger blocks the obvious negative test.** `trg_actions_frozen` / `trg_actions_final_frozen` refuse a
  direct `UPDATE` of `approved_final_json` or `proposal_id` on a live row, so the "unparseable payload" branch of
  `offerRetryForUnknown` had to be reached the way the product actually reaches it: retention nulling the payload of a
  terminal row (which the trigger explicitly permits).
- The harness seeds the profile by opening `app.db` with the real `openDb` + `createRepos` **before** `compose()`,
  because consents and settings must already be on disk when `compose()` constructs the launcher and the factory.

## REQUESTS

- **W2-04-packaging** - `npm run verify` runs `format:check`, and 14 files still fail it (section 5). Ten of them are
  yours (`electron-builder.yml`, `scripts/{hash-bridge,import-bridge,smoke-packaged,stage-calendar-mcp}.mjs` and their
  `.test.mjs`); `scripts/pin-models.{mjs,test.mjs}` are W1-07's. A `npx prettier --write` over your own paths clears
  them. Do **not** format `src/preload/index.ts` or `src/renderer/src/styles.css` - they are in `.prettierignore` for a
  reason that is documented there.
- **W2-02-security-gate** - the remaining four unformatted files are yours: `tests/security/import-graph.test.ts`,
  `tests/security/injection-corpus.{en,he}.json` (W1-09's corpora, but inside your Wave-2 directory) and
  `tests/setup-guards.ts`. Also: `createHarness()` in `tests/helpers/harness.ts` is ready for you -
  `opts.llm: 'attacker'` + `opts.corpus` installs `ObedientAttackerLlm` through the real `ProviderFactory`, and
  `harness.app` exposes `doorbellStats()`, `trayState()` and the settings bus.
- **W2-03-e2e** - `compose()` supports the `WCA_FAKE_BRIDGE_URL` / `WCA_FAKE_BRIDGE_TOKEN` attach mode and the
  `WCA_BRIDGE_CMD` / `WCA_MCP_CMD` / `WCA_LLAMA_CMD` / `WCA_MODEL_MANIFEST` / `WCA_HW` / `WCA_TIMERS` seams;
  `globalThis.__wcaTest` in `index.ts` exposes `tray()`, `clickTray(id)`, `health()` and `notify(itemId)` in e2e mode
  only. The scripted-provider seam for e2e is `ComposeDeps.providerOverride`, which `index.ts` does **not** set today:
  if `WCA_LLM=stub|attacker` has to work in the built app, that is the one line to add and it needs a fake that does
  not import from `tests/**` at run time.
- **W1-10-agent-pipeline / orchestrator** - `tests/golden/golden.test.ts` can now be re-pointed at `createHarness()`
  (section 5). The file is yours; nothing in the data or the expectations has to change.
- **W1-13-ipc-preload** - `'**/*.fixtures.*'` is in `coverage.exclude` now, so the `/* v8 ignore start|stop */` pair in
  `src/main/ipc/register.fixtures.ts` can be deleted.
- **orchestrator** - two CONTRACTS doc defects raised by W1-03 and W1-04 in Wave 1 are still open and are **not**
  code defects: `contracts.md` section 12 `BridgeDb.userHasSentIn` (the SQL literal is TRUE for a reaction row and
  contradicts its own prose, A13 and ARCH 4.6 step 4) and the `older_message` encoding ("analysis 'held' is NOT used"
  is structurally impossible; the implementation uses `analysis='held', hold_reason=NULL`), plus W1-04's
  `chats.mergeLidInto` being items-only because `trg_actions_frozen` makes `actions.chat_id` immutable. The
  implementations follow ARCHITECTURE; the spec text needs amending, which only the orchestrator can do.
- **orchestrator / W1-15** - `card.suggestedBy` (UX 7.4 "Suggested by: {{provider}}") is still unrenderable: `ItemCard`
  carries no `provider` / `model`. W1-15 removed the key rather than ship a dead string, so nothing is broken today.
  Adding it is a `src/shared/types.ts` change plus two copies in `agent/items.ts`; it was out of scope for this
  package and no test depends on it.

## BLOCKED-BY

None.
