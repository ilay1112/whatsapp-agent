# repair-test-fakes — working notes

Owner of `tests/fakes/**`, `tests/golden/**`, `src/main/ipc/register.fixtures.ts`.
Phase 3 repair session, 2026-09-23. Four items, all delivered; no test was deleted, skipped or weakened.

## 1. `tests/fakes/fake-mcp-calendar.ts` — child guard + `delay(tool, ms)`

**Child guard (REQUEST from W2-04-packaging).** Widened `/fake-mcp-calendar\.ts$/` to
`/(^|\/)fake-mcp-calendar\.(ts|mjs)$/` so the type-stripped `.mjs` copy TESTS 11 check 2 needs can start itself.

The `(^|/)` anchor is **load-bearing and was not in the requested regex**. `scripts/smoke-packaged.mjs` writes its
launcher as `launch-fake-mcp-calendar.mjs`, whose path *ends with* `fake-mcp-calendar.mjs`. With the plain
`/fake-mcp-calendar\.(ts|mjs)$/` the launcher's `import` of the fake would have matched `process.argv[1]`, run
`runChild()`, and connected a **second** `McpServer` to the same stdio transport — two servers answering one JSON-RPC
stream. Verified both ways with real child processes (Node 24, `stripTypeScriptTypes`, repo-relative so the SDK
resolves):

| entry | result |
|---|---|
| `fake-mcp-calendar.mjs` (direct) | starts, answers `initialize` + `tools/list` — one response per request |
| `launch-fake-mcp-calendar.mjs` (the smoke's launcher, imports the fake) | still exactly one response per request |

So W2-04 may now spawn the stripped `.mjs` directly and delete the launcher, **or** keep the launcher — both work.
Temp files were written under a `.tmp-mjs-check/` dir inside the repo (needed for `node_modules` resolution) and removed
again; nothing of it is left behind.

**`delay(tool, ms)` (REQUEST from W2-02-security-gate).** Per-tool *sticky* delay — every subsequent call of that tool
waits `ms`; `ms <= 0` clears it. Sticky rather than next-call-only because TESTS 8.2 item 5 needs **both** halves of the
create-event double click parked inside the fresh free/busy pre-check at the same time. Real `setTimeout`, like the
existing `slow:<ms>` scenario: the server half of the in-memory pair has no injected clock. Like `failNext`/`setBusy` it
is lost if `setToolList()` re-creates the server (that is the pre-existing shape of those controls, not new).

Measured directly: baseline `get-freebusy` 3 ms; with `delay('get-freebusy', 400)` two *concurrent* calls both returned
after 402 ms (they overlap, which is exactly the interleaving the race test wants); `get-current-time` stayed at 1 ms;
after `delay('get-freebusy', 0)` back to 1 ms.

## 2. `tests/fakes/fake-bridge.ts` — `historySync` control verb

Added `case 'historySync'` to the child-mode control server (REQUEST 11 from W2-03-e2e). Rows land in `messages.db`
with no webhook, exactly like the in-process method.

**JSON has no `Date`.** `FakeBridge.historySync` takes `ts: Date` and hands it to `db.formatTs`, so the verb revives
every row's `ts` (ISO string or epoch number) through a new `reviveDate()` before calling the fake. Verified against a
real child: two rows (one `Date`-serialised, one explicit ISO string) both stored with correct `is_from_me` and
go-sqlite3 timestamps.

**Also added a `.catch` on the control server's request promise.** It had none: any throwing verb (a malformed payload,
a bad `JSON.parse`) produced an unhandled rejection in the child and a response that never arrived, i.e. the calling
spec hung until its timeout. Now the verb answers `500 {"error": ...}`, which `control()` in
`tests/e2e/helpers/fixtures.ts` already turns into a thrown `Error`. Verified: `historySync` with `ts: "nope"` →
`500 {"error":"fake-bridge control: not a timestamp: \"nope\""}`, and the child stayed alive and served `exit`
afterwards.

**Left alone, reported instead:** `case 'inbound'` and `case 'outboundFromPhone'` still cast the parsed JSON straight to
their parameter type, so a caller that passes `ts` over the control server hands the fake a **string** where the code
expects a `Date`. No spec does that today (W2-03's note says every spec passes `ts: new Date()`, and those runs are in
attach mode where the object is in the test process), so this is latent, not broken. One `reviveDate()` call in each
case fixes it if a child-mode spec ever needs a timestamped inbound.

## 3. `tests/golden/golden.test.ts` — re-pointed at `createHarness()`

The data files and every expectation are unchanged. **All 42 cases × 2 assertions + the 5 corpus checks = 89 tests pass
on the harness route, first run, with no expectation touched.**

What the real route adds around the orchestrator: the fake bridge's `messages.db`, the real ingest + backlog gate, the
real triage queue, the real MCP calendar over the in-memory transport, and `dashboard:get` / `dashboard:getIgnored`
through the real IPC registration instead of a hand-built `createItemService`.

Three route-level decisions, each written into the file's header so nobody has to re-derive them:

1. **`whatsapp.processUnknownSenders` is turned ON.** The corpus contains no outbound message, and through the real
   ingest `isKnown` comes from `bridgeDb.userHasSentIn(jid)` — so every golden chat is a stranger and S0 holds all 42
   cases with `unknown_sender`. The old runner asserted the same thing by inserting the chat row with `isKnown: true`.
   Seeding a from-me message instead would push an extra line into the model's context window, i.e. into the thing
   under test, so the gate is turned off rather than faked around. Sanity-checked by flipping it back: `he-01` then
   fails with `analysis 'held'` / `card 'raw'`, which proves the test really runs through ingest + S0 and is not
   passing trivially.
2. **The timeline is delivered as a history-sync burst** (`bridge.historySync`, no webhook) while the virtual clock is
   one minute before the oldest message, and only then is the clock advanced to the case's `nowIso` and the scan poked.
   Otherwise `live_from_ts` (seeded at harness start) would make the whole timeline backlog and no item would exist.
3. **One harness per `it`, not per case.** The T7 leak guard in `tests/setup-guards.ts` is an `afterEach`: an app that
   outlives the test that created it is reported as a leaked fake + open DB handle. So `runCase()` runs twice per case.
   Cost: the whole file is 10.9 s.

### FINDING (benign, but it is a real semantic difference)

The two routes anchor stage 1 on **different instants**, and the corpus happens not to notice.

- Hand-built runner: the item was created directly with `triggerTs: Date.parse(c.nowIso)`.
- Real route: ingest sets `triggerTs` to the **trigger message's own timestamp**, and `orchestrator.runChat` uses
  `anchorMs = item.triggerTs` (PIPELINE 5.1: "the trigger's timestamp, never `Date.now()`") to build `nowIso` and the
  day table the model sees.

Every golden case's newest message is 1–50 minutes before `nowIso`, so the day table the model gets is anchored up to
50 minutes earlier than before. All 42 rows resolve identically (same local date bucket, same clock hour), so nothing
moved — but a future case whose expectation depends on the minute (e.g. "today at 09:30" with `nowIso` at 10:00 and
`agoMin: 50`) would resolve differently on the two routes. The real route is the correct one; the corpus's `nowIso` is
now only the moment the *scan* happens, not the anchor.

Two assertions were added while re-pointing (they cost nothing on this route and they are the property the file is
named after): no `/api/send` reached the fake bridge and no `create-event` reached the fake calendar during a run, and
`calendar.violations` is empty.

## 4. `src/main/ipc/register.fixtures.ts`

Deleted the `/* v8 ignore start */` … `/* v8 ignore stop */` pair and rewrote the stale REQUEST comment above it
(`**/*.fixtures.*` is in `coverage.exclude` in `vitest.config.ts`, so the hint is redundant). Proved the exclusion is
real rather than assumed: a coverage run reporting into a temp directory lists no `*.fixtures.*` entry.

Side observation for whoever owns it (**not** my file, nothing done): `src/main/db/__fixtures__/testDb.ts` **is** in the
coverage report — the exclude glob is `**/*.fixtures.*`, which does not match a `__fixtures__/` directory.

## Verification

Every command below was run with `$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH`
prepended (PowerShell) / the same two directories prepended to `PATH` (bash), from the quoted project path.

| Command | Result |
|---|---|
| `npx vitest run --project integration tests/golden/golden.test.ts` | **89 passed** (10.9 s) |
| `npx vitest run --project main --project integration --project security` | **132 files / 3251 tests passed** |
| `npx tsc --noEmit -p tsconfig.tests.json` | clean |
| `npx tsc --noEmit -p tsconfig.node.json` | clean |
| `npx eslint <the four owned files> --max-warnings 0` | clean |
| `npx prettier --check tests/fakes tests/golden src/main/ipc/register.fixtures.ts` | clean (the two fakes were `--write`-formatted after editing) |
| ad-hoc child-process checks | `.mjs` self-start, launcher non-double-start, `delay()` timing, child-mode `historySync` + its 500 path |

Not run, by rule: the e2e suite (W2-03's lane, needs a build), `npm run test:smoke` (needs a packed app, W2-04's lane),
the NSIS installer and any packaged GUI start (manual user steps). No binary was executed other than `node` itself; no
network, no WhatsApp, no Google.

### One transient red, not mine

The first full run showed `scripts/fetch-llama.test.mjs > writes the llama.cpp MIT text into THIRD_PARTY_NOTICES.txt`
failing with `TypeError: Cannot read properties of undefined (reading 'split')`. `scripts/fetch-llama.mjs` and its test
were rewritten on disk at 08:19:07 and 08:19:23, i.e. **while** that run was executing (08:19:08–08:19:26) — a
concurrent agent's edit landing mid-run. Re-running the file alone right afterwards: **56 passed**. Reported because a
red is always reported, not because anything is wrong with it.

## REQUESTS

- **W2-02-security-gate**: `calendar.delay('get-freebusy', 500)` now exists with exactly the semantics TESTS 8.2 item 5
  assumes. The double-click race in `approval-binding.test.ts` can stop relying on the incidental yield.
- **W2-03-e2e**: the `historySync` control verb now exists in child mode, so the 300-row burst can run in the built app
  instead of attach mode. Two things to know: `ts` may be an ISO string or an epoch number (both revived), and a
  malformed payload now returns HTTP 500 with a message rather than hanging your `control()` call.
- **W2-04-packaging**: check 2 can spawn the stripped `fake-mcp-calendar.mjs` directly and drop the 9-line launcher. If
  you keep the launcher, keep its name — the guard is anchored at a path separator on purpose, and a file named
  `*fake-mcp-calendar.mjs` that merely *imports* the fake is safe only because of that anchor.
- **Orchestrator**: the golden corpus now anchors on the trigger message (see the FINDING above). If a future case is
  meant to test minute-level resolution against `nowIso`, it must set the last message's `agoMin` to 0.

## BLOCKED-BY

None.
