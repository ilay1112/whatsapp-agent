# W1-02-bridge-process - builder notes

Package: `W1-02-bridge-process` (Wave 1, parallel).
Brief: `docs/specs/build-plan.md` section 7, heading `### W1-02-bridge-process`.
Reads used: ARCH 4.1-4.4 + A15/A16; CONTRACTS 12; `docs/research/bridge-contract.md` 2-5, 8, 9; TESTS 3.1, 4.1-4.3, 5.2, 5.3 bridge rows,
section 13; `docs/specs/wave0-seams.md` sections 1, 2, 9, 10, 11; `ops/agent-notes/W0-scaffold.md`.
Date: 2026-09-22.

Owned paths (build-plan section 6): `src/main/bridge/{launcher,invariants,readClient,sendClient,pairing,stdoutMarkers,janitor}.ts`,
`tests/fakes/fake-bridge.ts`, plus the colocated tests of those source files.
Nothing outside those paths was touched. `src/main/bridge/{doorbell,bridgeDb,ingest,timestamps}.ts` and `tests/fakes/fake-bridge-db.ts`
belong to W1-03 and were only READ.

Hard rules honoured: the reference folder `C:\Users\ilay1\Documents\minime\whatsapp-mcp\` was never opened (the Go source was read from
`vendor/whatsapp-bridge-src/`); `whatsapp-bridge.exe` was never executed; no network call left loopback; no new dependency, no version change,
no `git commit`; every fixture JID is `9725500000NN@s.whatsapp.net` (TESTS T5) and no real message text exists anywhere.

---

## 1. What was built

| File | Substance |
|---|---|
| `stdoutMarkers.ts` | `matchMarkers()` - ANSI-SGR strip, CRLF split, **line-anchored** match. A line matching `MESSAGE_ECHO_RE` yields nothing at all. A whatsmeow `HH:MM:SS.fff [Client LEVEL] ` prefix and the bridge's own decoration glyphs (`✓ ⚠️ ❌ …`) are stripped first, both as fixed prefixes, after the echo guard. Added `MARKER_NAMES`, `isHintMarker()`, `isAnnotationMarker()`. |
| `invariants.ts` | `assertBridgeSpawnInvariants()` collecting **every** `SPAWN_VIOLATIONS` member in table order; `sha256OfFile()` (streamed); `errorCodeForViolations()`; `isPathInside()` (shared with the janitor and the launcher). |
| `readClient.ts` | `createBridgeReadClient()` - base URL always `http://127.0.0.1:<port>`, `Authorization: Bearer`, `redirect:'error'`, 15 s cap, zod-validated wire shapes, QR PNG capped at `QR_PNG_MAX_BYTES` and content-type checked. Exactly three methods. |
| `sendClient.ts` | `createBridgeSendClient()` - `POST /api/send` with a body built from exactly `{recipient, message}` (anything smuggled onto the request object is dropped at serialisation), 60 s cap, full status mapping incl. `403 text => auth` vs `403 JSON => rejected`, abort => `timeout`. Exactly one method. |
| `pairing.ts` | `toPairingState()` (pure) + `createPairingPoller()` - 1.5 s while pairing, 15 s once connected/logged out, QR refetched only when `expires_at` changes, errors collapse to `unavailable` and polling continues. |
| `janitor.ts` | `runMediaJanitor()` - per-chat folders only, never `*.db`/dot-files/store-root files/directories, `realpathSync` + prefix assertion before every unlink, every fs failure is a skip rather than an abort. |
| `launcher.ts` | `createBridgeLauncher()` - the ARCH 4.2 spawn contract, the ARCH 4.2 `[R2]` readiness contract, the ARCH 4.3 host state machine, backoff + breaker, `relink`/`unlinkAndWipe` with path-prefix assertions, `childSpec()` for the Supervisor, and `resolveBridgeExe()` (the e2e exe resolver of TESTS 4.2). |
| `tests/fakes/fake-bridge.ts` | Fully implemented, in-process **and** child mode. Verified to run under bare `node` type-stripping and, in child mode, to serve `/api/health`, reject an unauthenticated call with 401, accept `__control/*` verbs and print the real stdout markers + the privacy bait line. |

### Decisions inside the launcher that are not spelled out in a spec line

- **Self-supervision vs the Supervisor.** `BridgeLauncher.start()` must work on its own (it is the IPC entry point), but `childSpec()` exists
  for W1-01's `Supervisor`. Rule implemented: the launcher runs its own backoff/breaker **until the first call to `childSpec().start()`**,
  after which it only kills and reports `backoff` and leaves every restart to the Supervisor. So W2-01 gets exactly one owner of restarts.
- **`start()` is the user's "Try again".** `BridgeLauncher` has no `resetBreaker()`, so an explicit `start()` (and `relink` /
  `unlinkAndWipe` / `restartForNewCode`) clears the terminal flag, the exit window and the annotation list.
- **The ErrorCode travels as a status.** `onStatus` only carries a `BridgeStatus`, so the launcher encodes the decision in the status:
  breaker open with a fresh `client_outdated` annotation => `outdated` (=> `BRIDGE_OUTDATED`), otherwise `failed` (=> `BRIDGE_CRASH_LOOP`);
  a spawn refusal => `refused`. The distinction `BRIDGE_BINARY_BLOCKED` vs `BRIDGE_SPAWN_REFUSED` is in the `spawn_refused` audit detail
  (`{violations, code, attempt}`) - see REQUESTS.
- **"Token never sent to a 401/403 listener"** is implemented as: the readiness probe sends the token once; the first `401`/`403` poisons
  that port, ends the attempt immediately (no further request of any kind goes to it) and the next attempt uses a fresh port. The test asserts
  exactly one `/api/pairing/status` request per abandoned port.
- **`token_banner` / `invalid_port` / `token_too_short`** are honoured only while `status === 'starting' && !readinessAnswered`, which is the
  only window in which the bridge cannot yet have echoed an incoming message. Everywhere else they are logged by name and ignored.
- **Media roots.** The invariants also require `WHATSAPP_MEDIA_ROOTS` to resolve inside `userData` (violation `outbox_outside_userdata`);
  the spec only named the outbox directory, but the env value is what the bridge actually writes to.

---

## 2. Refinements to frozen seams (all purely additive; nothing was renamed or removed)

Global rule 7 freezes exported names and shapes. Three optional parameters were added because TESTS 4.3 requires the injection points
and the W0 signature blocks did not carry them. Every existing call shape keeps its exact meaning.

| Seam | Addition | Why |
|---|---|---|
| `assertBridgeSpawnInvariants(plan, fs)` | optional 3rd arg `SpawnInvariantOptions {expectedSha256?, resourcesDir?, allowedArgs?}` | TESTS 4.3 **S-HASH**: "`bridge/invariants.ts` - `expectedSha256` + `exePath` are parameters". `BridgeSpawnPlan` carries only the *computed* hash, so without this the pin would be a module constant and TESTS 4.2's `WCA_BRIDGE_CMD` (which replaces the pin) could not work. `resourcesDir` is the root `exe_outside_resources` is measured against (absent => the weaker "never under userData" rule). `allowedArgs` defaults to `[]`, so `args_not_empty` behaves exactly as specified for production. |
| `createBridgeReadClient(ep)` | optional 2nd arg `fetchFn: FetchFn = globalThis.fetch` | TESTS 4.3 **S-FETCH** lists `bridge/readClient.ts` as taking `fetch` by injection. The launcher passes `deps.fetch` so the whole bridge stack runs on one injected fetch. |
| `createBridgeSendClient(ep)` | optional 2nd arg `fetchFn: FetchFn = globalThis.fetch` | same, S-FETCH lists `bridge/sendClient.ts`. |

Also additive, in owned files only: `MARKER_NAMES`, `isHintMarker`, `isAnnotationMarker`, `SpawnInvariantFs`, `SpawnInvariantOptions`,
`errorCodeForViolations`, `sha256OfFile`, `isPathInside`, `BRIDGE_READ_TIMEOUT_MS`, `QR_PNG_MAX_BYTES`, `BRIDGE_SEND_TIMEOUT_MS`,
`PAIRING_POLL_MS`, `PAIRING_CONNECTED_POLL_MS`, the launcher's timing constants, `BRIDGE_ENV_ALLOW_LIST`, `bridgeSpawnFs`,
`resolveBridgeExe`; and on `FakeBridge` the extra `readonly stdoutLines: string[]` plus the exported `FAKE_QR_PNG_BASE64` /
`SENTINEL_MSG_TEXT` constants.

One comment (not a signature) was corrected: `PairingPollerDeps.pollMs` said "default 2_000"; ARCH 4.3 and the brief both say 1.5 s, so the
default is `PAIRING_POLL_MS = 1_500` and the comment now says so.

---

## 3. Assumptions

- `token_weak` is `!/^[0-9a-f]{64}$/` (ARCH 4.2 prescribes `randomBytes(32).toString('hex')`); the bridge itself would accept >= 16 chars.
- `webhook_no_secret` is `!/^\/hook\/[A-Za-z0-9_-]{22,}$/` - a 32-byte base64url secret is 43 chars, so 22 is a generous floor.
- `port_8080` wins over `port_invalid` for the literal value 8080 (8080 is a valid port, just a forbidden one).
- `expires_at` is untrusted, so `toPairingState` drops a value more than 60 s in the past or more than 5 min in the future.
- A stdout chunk longer than 64 KiB without a newline is dropped rather than buffered (a message body is attacker-controlled and unbounded).
- Health-probe misses: 3 consecutive unanswered probes respawn, matching `ChildSpec.probeMisses` so the supervised and unsupervised paths agree.
- The launcher passes `resourcesDir` (and therefore enforces `exe_outside_resources`) **except** in seam mode, i.e. when `deps.exeArgs` is
  non-empty - which per TESTS 4.1 can only happen when both e2e locks are open. `args_not_empty` is relaxed the same way, and only for that
  exact argv; `--full-history-pair` is refused unconditionally.

## 4. Dead ends / things that cost time

- `tests/setup-guards.ts` T7 fails a test whose fake is still registered at `afterEach`, so a `beforeAll`-scoped `FakeBridge` breaks the
  *next* test (the guard stops the fake for you). Every test that starts the fake creates and stops it per test.
- `new Response(body, {status: 204})` throws (null-body status). Two "unexpected status" tests silently exercised the transport-error path
  until the statuses were changed to 500 / 418.
- `BridgeAuthError` / `BridgeUnreachableError` are frozen as bare `extends Error {}`, so `err.name` is `'Error'`. The pairing poller logs a
  computed `reason` (`auth` | `unreachable` | `other`) instead of a class name, which also survives minification.
- The launcher awaits a **real** streamed file hash before every spawn, so a virtual-clock test must let the event loop turn (a
  `setImmediate` chain alone is not always enough); the tests use a `tick()`/`flush()` pair and a `runUntilSettled()` driver.
- `path.join(a, '..', b)` normalises the `..` away, so the cwd-traversal fixture has to be a raw string.

---

## 5. Definition of done (build-plan 1.1)

| # | Criterion | Result |
|---|---|---|
| a | no `NotImplementedError` left in owned source | **PASS** - `grep -n NotImplementedError src/main/bridge/{launcher,invariants,readClient,sendClient,pairing,stdoutMarkers,janitor}.ts` is empty; `tests/fakes/fake-bridge.ts` no longer throws. |
| b | TESTS 5.3 rows covered by colocated tests | **PASS** - `bridge/invariants` (one test per violation + the streamed hash), `bridge/launcher + stdoutMarkers + pairing` (readiness, 401 poisoning, state machine, breaker/annotation, the `stdout_marker` security matrix over **every** `BRIDGE_MARKERS` string as an echo line *and* as multi-line content, ANSI/UTF-8 chunk splitting, S-LOG capture holds marker names only), `bridge/readClient + sendClient` (base URL, redirect, bearer, two-key body, `expectTypeOf` + runtime key lists, error mapping), `bridge/janitor`. |
| c | `npx eslint <owned paths> --max-warnings 0` | **PASS** (exit 0). |
| d | `npm run typecheck` clean in owned files | **PASS.** `tsconfig.node.json` and `tsconfig.web.json` are now clean repo-wide. `tsconfig.tests.json` still reports 3 errors, none of them mine: `src/shared/when.test.ts(129,12)`, `(140,12)`, `(141,12)` `TS2532: Object is possibly 'undefined'` - owner **W1-08-shared-utils** (see REQUESTS). |
| e | `npx vitest run --project main <owned paths>` green | **PASS** - 134 tests in the seven owned test files; the whole `main` project is 61 files / 1525 tests green. |
| f | coverage thresholds of TESTS section 13 | **PASS.** Safety-critical (100 % lines / 95 % branches / 100 % functions, perFile): `invariants.ts` 100/100/100, `sendClient.ts` 100/97.22/100, plus `stdoutMarkers.ts` 100/100/100. `src/main/bridge/**` rest (90/85/90): `launcher.ts` 97.53/85.41/95.24, `readClient.ts` 100/96.30/100, `pairing.ts` 100/100/100, `janitor.ts` 100/100/100. |
| g | notes written | this file. |

Extra verification: `tests/fakes/fake-bridge.ts` was imported under bare `node` (type stripping) and run once in child mode from a scratchpad
cwd - `/api/health` 200 with the bearer, 401 without it, `__control/inbound` 200, `Starting REST API server on 127.0.0.1:<port>...` and the
bait line on stdout. The `store/` directory that run created was deleted immediately; a repo scan afterwards finds no `store` directory and
no `*.db` file outside `node_modules`.

---

## REQUESTS

- **W2-01-compose-integration** - the launcher cannot write to the database (`BridgeLauncherDeps` has no `repos`), so `compose()` must wire
  these two ARCH 4.3 `[R2]` side effects itself:
  1. on every `onStatus` edge **away from `'online'`** (and on app quit): `meta.last_online_ts = now` - the backlog gate of A14/ARCH 4.6
     depends on it;
  2. on every `onPairing` edge **`qr_pending` -> `connected`** (the launcher also writes an audit row `kind:'pairing', detail:{event:'paired'}`
     at that exact moment): `meta.paired_at = now`, recompute `live_from_ts`, then `ingest.resolveLidChats()`.
     `ingest.resolveLidChats()` should additionally run on every edge **into** `'online'`.
- **W2-01-compose-integration** - `onMarker('history_sync_done')` is the end of the "syncing" window and must call `ingest.poke()`; the
  launcher deliberately does nothing with it beyond forwarding the name. `onMarker` is also where `syncing()` for `IngestDeps` should flip.
- **W2-01-compose-integration** - use `resolveBridgeExe({bridgeExe: paths.bridgeExe, e2e, seamBridgeCmd})` from `src/main/bridge/launcher.ts`
  to pick `exePath` / `exeArgs` / `expectedSha256`. It returns `null` in e2e mode without `WCA_BRIDGE_CMD` (bridge disabled) and **never**
  returns a path ending in `whatsapp-bridge.exe` in e2e mode, which is the unit-tested safety rule of TESTS 4.2.
- **W2-01-compose-integration** - map `BridgeStatus` to `ErrorCode` as: `outdated -> BRIDGE_OUTDATED`, `failed -> BRIDGE_CRASH_LOOP`,
  `refused -> ` the `code` field of the most recent `spawn_refused` audit row (`BRIDGE_BINARY_BLOCKED` or `BRIDGE_SPAWN_REFUSED`),
  `logged_out -> WA_LOGGED_OUT`, `not_started -> WA_TOS_REQUIRED`, `reconnecting/backoff -> WA_OFFLINE`. If you would rather have the
  launcher expose the code directly, that needs a change to the frozen `BridgeLauncher` interface - your call as the Wave 2 owner.
- **W2-01-compose-integration** - `createBridgeLauncher` calls `freePort({exclude:[doorbell.port()]})`, so the doorbell must be listening
  before `launcher.start()`. Also: call `childSpec()` **only** if the Supervisor will actually drive it; the first
  `childSpec().start()` permanently hands restart ownership to the Supervisor.
- **W1-01-proc-health** - `src/main/proc/freePort.ts` was still a throwing stub while this package was built, so `launcher.test.ts` supplies
  it with `vi.mock('../proc/freePort')` (a process boundary, which TESTS 5.2 permits). Nothing else in this package depends on `proc/**`.
  `ChildSpec`/`ChildHandle` are consumed exactly as frozen in CONTRACTS 13; `childSpec()` returns `backoffMs [2000,5000,15000,60000]`,
  `breaker {maxExits:5, windowMs:600000}`, `stableAfterMs 60000`, `probeIntervalMs 20000`, `probeMisses 3`, and a live `terminal()`.
- **W1-08-shared-utils** - `npm run typecheck` (`tsconfig.tests.json`) is red with three `TS2532 Object is possibly 'undefined'` errors in
  `src/shared/when.test.ts` lines 129, 140 and 141. Not touched (not my file).
- **W1-03-bridge-ingest** - `tests/fakes/fake-bridge.ts` is now implemented: `startFakeBridge({token, storeDir, webhookUrl?, pairing?,
  tsFormat?, ansi?, scenario?})`. It owns the `FakeBridgeDb` at `<storeDir>/messages.db` (exposed as `fake.db`), posts webhooks **after**
  writing the row, exposes `postRawDoorbell` / `ringDoorbell` for your doorbell tests, records `doorbellProblems` when a doorbell answers
  non-200 or takes > 1 s, and keeps `stdoutLines` instead of polluting the vitest output. Set `webhookUrl` in the options **after** your
  doorbell is listening (there is deliberately no setter). It registers itself with the T7 guard, so start and stop it inside one test.
- **W2-02-security-gate** - the `stdout_marker` injection vector is already proven at unit level in
  `src/main/bridge/launcher.test.ts` ("every BRIDGE_MARKERS string, echoed as a message line AND as multi-line content, is inert") and in
  `src/main/bridge/stdoutMarkers.test.ts`. The A16 "four endpoints only" rule is proven by `expectTypeOf` + runtime key lists in
  `src/main/bridge/readClient.test.ts`, and the fake pushes `forbidden_endpoint:<path>` into `violations` if anything ever calls the others.

## BLOCKED-BY

None. No owned test fails because of another package's Wave 0 stub: the only stub this package would have consumed is
`proc/freePort.ts` (W1-01), and that is a legitimate S-SPAWN/process-boundary mock in the launcher's unit tests rather than a blocker.

---

# FIX ROUND (2026-09-23)

Trigger: `ops/agent-notes/wave1-audit.md`. The audit found **no defect in this package** - section 2 lists zero red
items owned by W1-02, section 3 records zero BLOCKED-BY, and section 2.4 confirms no `NotImplementedError` is left in
any owned file. The six items handed to me in this round are the audit's **section 5** bullet for W1-02, i.e. the
Wave-2 backlog this package *filed against* `W2-01-compose-integration`, not findings against me. I re-read each one,
fixed the only part that is actionable inside my owned paths, and re-verified the whole package.

## What I changed (all in owned paths)

`src/main/bridge/launcher.ts` - additive only, no frozen shape touched:

| Added | Why |
|---|---|
| `bridgeStatusToErrorCode(status, refusedCode?): ErrorCode \| null` | The audit item *"map BridgeStatus to ErrorCode in compose (BridgeLauncher has no errorCode(), the interface is frozen)"*. The mapping is a property of the bridge's state machine (ARCH 4.4), so it now lives with the state machine as a pure function instead of being re-derived by hand in `compose.ts`. `'online'`, `'starting'`, `'needs_pairing'` and `'stopped'` return `null` - they are progress, not errors. |
| `refusalCode` (private) + `lastRefusalCode(): ErrorCode \| null` | Previously the `BRIDGE_BINARY_BLOCKED` vs `BRIDGE_SPAWN_REFUSED` distinction existed **only** inside a `spawn_refused` audit row, so compose would have had to read audit rows back out of the DB to render one dialog. The launcher now keeps the code it already computed. `resetBreaker()` clears it, so an explicit `start()` / `relink()` / `unlinkAndWipe()` / `restartForNewCode()` wipes a stale refusal exactly like it wipes `terminal`. |
| `errorCode(): ErrorCode \| null` | `bridgeStatusToErrorCode(status(), lastRefusalCode())`, bound. |
| `export type BridgeLauncherHandle` | Names what `createBridgeLauncher` already returned (`BridgeLauncher & {childSpec()}`) and carries the two new accessors. |
| the `token_banner` / `invalid_port` / `token_too_short` startup refusal now sets `refusalCode` and audits `{marker, code}` | It was the one refusal path that produced a `spawn_refused` row **without** a `code` field; compose's "most recent `spawn_refused` row" lookup would have found `undefined` there. |

**Why this is not a seam violation.** `BridgeLauncher` (CONTRACTS 12) is untouched - the two accessors are on the
*return type*, which was already a widening (`& { childSpec(): ChildSpec }`) authored by W0. Every existing caller that
holds a `BridgeLauncher` still compiles and behaves identically, and nothing in the launcher's behaviour changed:
`errorCode()` is a read of state that was already published.

`src/main/bridge/launcher.test.ts`:

- new describe block `[FIX] the BridgeStatus -> ErrorCode surface W2-01 composes against` - 7 tests: the mapping table is
  asserted against `BRIDGE_STATUSES` itself (a status added to CONTRACTS later fails this test rather than silently
  mapping to `null`); a refusal code never leaks onto a non-`refused` status; hash mismatch => `BRIDGE_BINARY_BLOCKED`
  on the launcher **and** in the audit row; any other violation => `BRIDGE_SPAWN_REFUSED`; the startup-marker refusal;
  `online`/`stopped` => `null` and a fresh `start()` clearing an earlier refusal; breaker + fresh `client_outdated`
  annotation => `BRIDGE_OUTDATED`.
- new helpers `settleUntil(read, want, rounds)` and `firstChild(h, rounds)`, and two call sites converted to them.
  **This fixed a real latent flake**, not a red test: `token_banner / invalid_port / token_too_short only act while
  STARTING with no REST answer yet` failed roughly 1 run in 3, and once under `--coverage`.

  Root cause, and it is worth remembering for every test in this file: the launcher awaits a **real streamed SHA-256 of
  the exe** before it spawns, so the child does **not** reliably exist when the first `flush()` after a non-awaited
  `start()` returns. The test then did `h.children[0]?.say(MARKER)` - the optional chain **silently no-opped**, the
  launcher never saw the line, and the status stayed `'starting'`. The two `flush()`es were a red herring; waiting
  longer alone (my first attempt, `settleUntil` only) did not fix it because the line had never been written.

  `firstChild()` waits for the child and **asserts it exists**, so the silent no-op is now a named failure
  (`'the launcher never spawned a child'`). `settleUntil()` waits for the settled value and returns whatever it last
  saw, so a genuinely wrong value still fails the `expect`. Neither assertion was weakened; the file went from
  ~1-in-3 flaky to 5/5 clean runs plus a clean `--coverage` run.

## Verification (definition of done, build-plan 1.1)

| # | Criterion | Result |
|---|---|---|
| a | no `NotImplementedError` in owned source | **PASS** |
| c | `npx eslint <owned paths> --max-warnings 0` | **PASS** (exit 0) |
| d | `npm run typecheck` | **PASS, exit 0 repo-wide** - the three `src/shared/when.test.ts` TS2532 errors I filed against W1-08 are fixed; that REQUEST is now **closed**. |
| e | owned tests | **PASS** - 7 owned test files, 155 tests (was 148), 5 consecutive clean runs after the flake fix. Whole `--project main`: 103 files / **2553 tests, 0 failures**. |
| f | TESTS 13 coverage | **PASS** - safety-critical (100/95/100 perFile): `invariants.ts` 100/100/100, `sendClient.ts` 100/97.22/100, `stdoutMarkers.ts` 100/100/100. `src/main/bridge/**` (90/85/90): `launcher.ts` 97.62/86.13/95.45, `readClient.ts` 100/96.29/100, `pairing.ts` 100/100/100, `janitor.ts` 100/100/100. No threshold ERROR names a bridge path. |
| g | notes | this section |

Prettier: `launcher.ts` and `launcher.test.ts` are still in the repo-wide unformatted set (audit 2.3). Deliberately
**not** run `--write` on them - audit 2.3 assigns the single tree-wide pass to W2-01 and a style island here would
collide with it.

Note for the orchestrator: a concurrent agent was running `vitest --coverage` against the shared `coverage/`
directory during this round, which crashes both runs (`Something removed the coverage directory ".../coverage/.tmp"`).
I re-ran with `--coverage.reportsDirectory` pointed at my scratchpad. Nothing was written to `coverage/`.

## REQUESTS (fix round)

Still open, and **not fixable from my owned paths** - all four are `src/main/compose.ts`, which build-plan section 6
assigns exclusively to W2-01. My launcher exposes everything each one needs; none of them is a defect in this package.

- **W2-01-compose-integration** - `meta.last_online_ts = now` on every `onStatus` edge **away from `'online'`** and on
  quit. The launcher does emit a status on quit (`stop()` ends in `setStatus('stopped')`), so a plain
  `prev === 'online' && next !== 'online'` check on the `onStatus` stream is sufficient; no launcher change needed.
- **W2-01-compose-integration** - `meta.paired_at = now` + recompute `live_from_ts` + `ingest.resolveLidChats()` on every
  `onPairing` edge `qr_pending -> connected` (the launcher writes the `kind:'pairing', detail:{event:'paired'}` audit row
  at that same instant, verified by `launcher.test.ts` "qr_pending => needs_pairing, and connected-after-QR audits
  `paired`"). `resolveLidChats()` should additionally run on every edge **into** `'online'`.
- **W2-01-compose-integration** - `onMarker('history_sync_done')` must call `ingest.poke()` and end the
  `IngestDeps.syncing()` window. The launcher forwards the marker **by name only** and deliberately does nothing else
  with it (`launcher.ts`, the `default:` arm of the marker switch); the forwarding is covered by a test that asserts
  `deps.onMarker` was called with `'history_sync_done'`.
- **W2-01-compose-integration** - start the doorbell **before** `launcher.start()`: `createBridgeLauncher` calls
  `freePort({exclude: [doorbell.port()]})`, and `deps.doorbell.rotateSecret()` must already return a live
  `http://127.0.0.1:<doorbell port>/hook/<secret>` or the spawn is refused with `webhook_wrong_port` /
  `webhook_no_secret`.

Fulfilled this round, from my side:

- **`BridgeStatus -> ErrorCode`** - no longer a compose-side inference job: call `launcher.errorCode()`, or the pure
  `bridgeStatusToErrorCode(status, refusedCode)` if you are mapping a status you received over IPC.
- **`resolveBridgeExe({bridgeExe, e2e, seamBridgeCmd})`** - already exported from `src/main/bridge/launcher.ts` since
  Wave 1 and unit-tested (`describe('resolveBridgeExe')`), including the rule that it never returns a path ending in
  `whatsapp-bridge.exe` in e2e mode (TESTS 4.2). Nothing to change.

Closed since Wave 1: the W1-08 `when.test.ts` TS2532 request (typecheck is green), and the W1-01 `freePort` note
(`launcher.test.ts` still mocks it at the process boundary by design, which TESTS 5.2 permits).

## BLOCKED-BY (fix round)

None.
