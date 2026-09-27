# W1-11-exec - working notes

Package: `ActionExecutor`, action hash, arg builders, rate limiter, reconcile, `action:*` handlers, side-effect ledger.
Owned paths: `src/main/exec/**`, `src/main/ipc/handlers/actions.ts` (+ its colocated test), `tests/helpers/{ledger,ledger-hook}.ts`,
plus my own locale fragment `src/shared/locales/pending/W1-11-exec.json`.

## Status

Done. Every owned file is implemented (no `NotImplementedError` anywhere in the package), every row of TESTS 5.3 `exec/*` and the
approval-binding cases of TESTS 8.2 items 5, 6 and 12c are covered by colocated tests.

| Check | Result |
|---|---|
| `npx eslint src/main/exec src/main/ipc/handlers/actions*.ts tests/helpers/ledger*.ts --max-warnings 0` | clean |
| `npm run typecheck` (node + tests projects) | no error in any file I own |
| `npx vitest run --project main src/main/exec src/main/ipc/handlers/actions.test.ts` | 161 tests green |
| coverage on `src/main/exec/**` + `handlers/actions.ts` (threshold: 100 % lines / 95 % branches / 100 % functions, per file) | **100 % lines, 100 % functions, 98.09 % branches** |
| `npx vitest run --project integration --project security` (my `ledger-hook.ts` is their setup file) | green |

Files written this session: `actionExecutor.test.ts`, `rateLimiter.test.ts`, `reconcile.test.ts`, `outcome.test.ts`,
`ipc/handlers/actions.test.ts`, `src/shared/locales/pending/W1-11-exec.json`; small edits to `buildCreateEventArgs.ts`,
`reconcile.ts` and `buildCreateEventArgs.test.ts` (see "Changes to existing code" below).
The production modules themselves came from an earlier interrupted attempt and were continued, not rewritten.

## Continuation from the earlier attempt

`actionExecutor.ts`, `actionHash.ts`, `buildSendArgs.ts`, `buildCreateEventArgs.ts`, `outcome.ts`, `rateLimiter.ts`,
`reconcile.ts`, `ipc/handlers/actions.ts`, `tests/helpers/ledger.ts` and `ledger-hook.ts` already existed and were complete.
I read each one against ARCH 6.6 / PIPELINE 9 / CONTRACTS 5, 8, 14, 15.1 before adding tests and found the gate order, the
write-ahead and the retry-clone rules implemented as specified. What was missing was the test surface (only `actionHash`,
`buildSendArgs` and `buildCreateEventArgs` had colocated tests) and the notes file.

## Decisions and assumptions

1. **Tests drive the REAL app DB, not a repos double.** `openDb(':memory:')` + `createRepos()` gives the production
   `markApprovedExecuting` compare-and-set and the frozen `trg_actions_*` triggers, so the "double click" and "CAS miss" cases
   assert the behaviour that actually ships. Only the send / write / free-busy clients are recording doubles.
   A minimal repos double is used in exactly three places, each one for a state the frozen triggers make unreachable through the
   repos (a `canonical_json` that no longer parses, an item row that vanished, a `markDone` that loses its compare-and-set).
2. **The injected `sleep` IS the virtual clock** in the executor tests (`sleep(ms)` -> `clock.advance(ms)`). That makes the jitter
   observable (band + ordering vs. the write-ahead), keeps `drain()` terminating deterministically, and means no test anywhere in
   this package uses a real timer.
3. **Double click is proved twice.** `send_reply` exercises the synchronous `inFlight` guard (second call arrives while the first
   awaits the bridge). `create_event` uses a SECOND executor over the same database - a second `inFlight` set - with a slow
   free/busy, so the race genuinely reaches the DB compare-and-set. Both assert exactly one side effect, `ACTION_STALE` for the
   loser, no retry clone and no `action_failed` audit row.
4. **`calendar.eventDescription` was not in `en.json`.** Per build-plan 1.2 (my prefix is `calendar.eventDescription*`) I added it
   to my own fragment `src/shared/locales/pending/W1-11-exec.json` with an `en` and a `he` value. It is an app template: no model
   text, no contact name. Asserted in `actionExecutor.test.ts` for both languages.
5. **`ActionExecutorDeps.detail` stays optional** (the refinement the earlier attempt documented in the file's doc comment):
   `exec/**` may not import `agent/**`, so `ItemService.detail` is injected by `compose.ts`, and `ipc/handlers/actions.ts`
   re-reads the detail after every approve anyway. Both paths are covered, and the row-only fallback is asserted to contain no JID
   and no message text.
6. **Unreachable-by-construction branches that remain uncovered** (5 of 263, all defensive `??` / ternary fallbacks that the
   frozen schemas and triggers make unreachable): `FLAT_LOCALES[lang]['calendar.eventDescription'] ?? ''`,
   `chat?.jid ?? ''` in `prepareArgs` (the sendable gate already returned), the `'EVENT_INVALID'` arm of the `prepareArgs` catch
   (`buildCreateEventArgs` does not throw), `repos.actions.byId(a.id) ?? a` after a successful write-ahead, and
   `payload.timeZone || settingsZone` in `reconcile.ts` (`CreateEventPayloadSchema` forbids an empty zone). They are kept as
   belt-and-braces; branch coverage is 98.09 %, well above the 95 % gate.

## Changes to existing code (all inside owned paths)

- `buildCreateEventArgs.ts`: `eventIdFor` now encodes **the first 20 bytes** of the sha256 digest instead of all 32 and then
  slicing to 32 characters. 20 bytes = 160 bits = exactly 32 base32hex characters, so the encoder has no leftover-bits branch any
  more. **The produced ids are byte-identical** - the first 32 base32 characters only ever depended on the first 160 bits; the
  known-answer vectors in `buildCreateEventArgs.test.ts` are unchanged and still pass. This was needed because the removed
  `if (bits > 0)` tail was unreachable for a 32-byte digest and would have failed the per-file 95 % branch gate for that file.
- `reconcile.ts`: `reconcileCreate` now evaluates `deps.timeZone()` into a local before the `payload.timeZone || …` fallback
  instead of only inside the short circuit. Same behaviour, but the injected `timeZone` seam is actually exercised (it was a
  never-called function otherwise, which broke the 100 % function/line gate for `actionExecutor.ts`, whose `recoverOnStartup`
  passes that closure).
- `buildCreateEventArgs.test.ts`: a literal U+200B in a template literal was replaced by the `​` escape (the file failed
  `no-irregular-whitespace`). The test's intent - `stripInvisible` removes it before the collapse - is unchanged.

## Dead ends

- Tried to reach `verifyShownHash('')` (a retention-nulled `canonical_json`) and a corrupted stored payload through the real
  repos. Both are blocked by `trg_actions_frozen`: `canonical_json` may only be set to NULL, and only from a terminal state,
  where the `state !== 'pending'` gate fires first. The '' case is covered directly in `actionHash.test.ts`; the corrupted-payload
  case uses a one-method repos double.
- Tried to reach the `payload.timeZone || …` fallback with `timeZone: ''` in the approved payload. `CreateEventPayloadSchema`
  rejects it, so `parseFinalPayload` returns null first. Replaced that test with one that asserts the lookup window is built in
  the zone the user approved, with a day of margin on each side.

## REQUESTS

- **W1-15-renderer-dashboard:** `src/shared/locales/locales.test.ts > locale parity > every Hebrew value differs from the English
  one` is red on `master` right now because `src/shared/locales/pending/W1-15-renderer-dashboard.json` gives `card.provider.claude`
  and `card.provider.gemini` the same text in `he` as in `en`. Not caused by this package (my fragment has distinct values) and not
  mine to fix - either translate them or get them added to `SAME_ON_PURPOSE`. Everything else in `--project main` is green
  (2496 passed / 1 failed).
- **W2-01-compose-integration:**
  1. `ActionExecutor.recoverOnStartup()` runs `reconcileUnknown` with `bridgeDb: null`, because the frozen `ActionExecutorDeps`
     carries no bridge DB handle. Calendar actions are therefore reconciled at startup but `send_reply` ones are not. Please call
     `reconcileUnknown({ repos, bridgeDb, read, now, timeZone })` a second time from `compose.ts` once the bridge store is open, so
     a send that was in flight across a crash can be matched against `messages.db`.
  2. Wire `ItemService.detail` into `ActionExecutorDeps.detail` (optional, see decision 5) so the executor's own
     `ApproveOutcome.item` is the real view model and not the row-only fallback.
  3. When you fold `src/shared/locales/pending/` into the base files, `calendar.eventDescription` (en + he) comes from
     `W1-11-exec.json`.
  4. `npx prettier --check` currently fails for 67+ files across the tree, including the ones this package owns. I deliberately did
     NOT run `prettier --write` on my paths only, to avoid creating a second, inconsistent style island in a tree other agents are
     editing right now. `npm run format:check` is yours in Wave 2 - a single repo-wide `prettier --write` will fix mine too.
  5. `tests/helpers/ledger.ts` / `ledger-hook.ts` have no colocated unit test of their own: no vitest project's `include` glob
     matches `tests/helpers/**`, so one cannot be added from here. They are exercised end to end by the integration and security
     projects (both green). If you want them directly tested, the test has to live under `tests/integration/`.

## BLOCKED-BY

None. No test in this package fails because of another package's Wave 0 stub.

---

## Fix round (2026-09-23) - audit follow-up

The audit (`ops/agent-notes/wave1-audit.md`) attributes **no red item and no defect** to this package: section 2.1/2.2
name W1-08 and W1-14, section 2.4 confirms no `NotImplementedError` in any file I own, section 3 records zero
BLOCKED-BY, and section 4.1 (Wave-1 -> Wave-1 requests still open) contains no row addressed to W1-11.

The three items handed to me in this round are the ones **listed in audit section 5, "Wave-2 backlog carried out of
Wave 1"** under the bullet `**W1-11**`. Section 5's own preamble is explicit that these are
"deferred by design, not Wave-1 debt", and section 4's preamble says requests addressed to W2-01 "are deferred by
design ... so the orchestrator can hand them to Wave 2". They are requests **from W1-11 to W2-01**, not the other way
round: all three land in `src/main/compose.ts` and `src/shared/locales/{en,he}.json`, which build-plan section 6 gives
to **W2-01-compose-integration**, and build-plan rule 1.2 forbids a Wave-1 package from wiring itself. I therefore did
not touch them; see "What W2-01 has to write" below, where each one is reduced to the exact call site, because
everything they need already exists and is exported from this package.

### Re-verification of the whole package on today's tree

| Check | Result |
|---|---|
| `npx vitest run --project main src/main/exec src/main/ipc/handlers/actions.test.ts` | **8 files / 161 tests green** |
| `npx eslint src/main/exec src/main/ipc/handlers/actions.ts src/main/ipc/handlers/actions.test.ts tests/helpers/ledger.ts tests/helpers/ledger-hook.ts --max-warnings 0` | **clean (exit 0)** |
| `npm run typecheck` (node + web + tests) | **no error in any file I own** (see below) |
| coverage `src/main/exec/**` | 100 % stmts / **98.09 % branches** / 100 % funcs / 100 % lines (gate: 100 line / 95 branch) |
| coverage `src/main/ipc/handlers/actions.ts` | **100 % / 100 % / 100 % / 100 %** |
| `npx vitest run --project integration --project security` (my `ledger-hook.ts` is their setup file) | 4 files / 108 tests green |
| `npx vitest run --project main src/shared/locales src/shared/i18n` | 75 tests green - my fragment passes parity + usage |

Nothing in my owned paths changed this round: there was nothing to repair.

### Requests of mine that the audit closes

- **W1-15-renderer-dashboard** - the locale-parity red I reported is gone (`card.provider.*` no longer exists anywhere
  under `src/shared/locales/`). Re-ran `src/shared/locales` + `src/shared/i18n`: 75 green. **Request withdrawn.**
- **W1-13-ipc-preload** - `ipc/handlers/actions.ts` has its colocated test and 100 % coverage. Closed.

### Repo-wide reds today (neither mine nor caused by me - do not attribute to W1-11)

- `src/main/bridge/launcher.ts(668,3)` / `(671,3)` **TS2322**: the object returned at the end of `createBridgeLauncher`
  is missing `lastRefusalCode` and `errorCode` from `BridgeLauncherHandle`. Owner **W1-02-bridge-process**. It is the
  only error left in `npm run typecheck` on all three projects (the three `src/shared/when.test.ts` TS2532 errors the
  audit reported are fixed). My files compile clean in the node and the tests project.
- `npx prettier --check .` is still repo-wide red; per audit 2.3 that is W2-01's single formatting pass. Unchanged
  position: I still do not run `prettier --write` on my paths alone.

### What W2-01 has to write (the three items, reduced to their call sites)

1. **Second `reconcileUnknown` with the real bridge store.** `ActionExecutor.recoverOnStartup()` passes
   `bridgeDb: null` because the frozen `ActionExecutorDeps` (CONTRACTS section 14) carries no bridge handle, so that
   pass resolves `create_event` only. I deliberately did **not** widen `ActionExecutorDeps` with a `bridgeDb` seam: the
   blocker is lifecycle, not plumbing - at `recoverOnStartup()` time the bridge store is usually not open yet, so even
   an injected getter would hand back `null` and the post-open call would still be needed. `reconcileUnknown` and its
   public `ReconcileDeps` are already exported from `src/main/exec/reconcile.ts` and the `bridgeDb`-non-null
   (`send_reply`) path is covered by `reconcile.test.ts`. W2-01 adds, once the store is open:
   `await reconcileUnknown({ repos, bridgeDb, read, now: clock.now, timeZone: () => settings().general.timeZone })`.
   It is idempotent and read-only, so running it again after every `qr_pending -> connected` transition is safe.
2. **`detail`.** `ActionExecutorDeps.detail?` already exists (additive-optional, documented at
   `src/main/exec/actionExecutor.ts:38-43`); W2-01 passes `ItemService.detail` into `createActionExecutor({ ... })`.
   Note the consequence is smaller than it looks: `ipc/handlers/actions.ts` re-reads the detail through
   `deps.items.detail(...)` after every approve, so the renderer already receives the real view model today. Wiring it
   only fixes non-IPC callers of `executor.approve`.
3. **Locale fold-in.** `calendar.eventDescription` (en + he) comes from `src/shared/locales/pending/W1-11-exec.json`.
   It is an app template - no model text, no contact name - and `actionExecutor.test.ts` asserts both languages, so the
   test moves with the key: after the fold-in the assertion reads the value out of the merged resources exactly as it
   does now and needs no edit.
