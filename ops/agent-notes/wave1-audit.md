# wave1-audit — read-only audit of all 16 Wave-1 packages

Auditor package: `wave1-audit`. I edited nothing except this file and the raw command output under
`ops/agent-notes/audit/`. No source, test, config or other agent's notes file was touched.

Date of run: 2026-09-23. Commands run from `"C:\dev\whatsapp agent"` with
`$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH`.

## 1. Raw results

| Command | Exit | Output file |
|---|---|---|
| `npm run lint` (`eslint . --max-warnings 0`) | **0** | `ops/agent-notes/audit/lint.txt` |
| `npm run typecheck` (node + web + tests projects) | **2** | `ops/agent-notes/audit/typecheck.txt` |
| `npx vitest run --project main` | **0** — 103 files, 2499 tests, all passing | `ops/agent-notes/audit/vitest-main.txt` |
| `npx vitest run --project renderer` | **1** — 30 files, 422 tests, **1 failed** | `ops/agent-notes/audit/vitest-renderer.txt` |
| `npx prettier --check .` (extra, because `npm run verify` runs `format:check`) | **1** — 212 files unformatted | `ops/agent-notes/audit/format-check.txt` |

Not run (out of scope for a Wave-1 audit, and they depend on the still-stubbed `compose()` / `createHarness()`):
`--project integration`, `--project security`, `test:e2e`, `test:smoke`, `test:coverage`.

Headline: **lint is clean; both non-test tsconfig projects are clean; the whole `main` vitest project is
green; exactly one renderer test and three test-file type errors are red.** Both red items were already
reported by a package other than their owner, so nothing here is a surprise to the orchestrator.

## 2. Every red item, mapped to its owner (build-plan section 6)

### 2.1 `npm run typecheck` — 3 errors, all in one file

```
src/shared/when.test.ts(129,12): error TS2532: Object is possibly 'undefined'.
src/shared/when.test.ts(140,12): error TS2532: Object is possibly 'undefined'.
src/shared/when.test.ts(141,12): error TS2532: Object is possibly 'undefined'.
```

- Owner: **W1-08-shared-utils** (`src/shared/when.ts` is W1-08's; the colocated-test rule of build-plan 1.1/1.6
  makes `when.test.ts` W1-08's too).
- Classification: **(a) genuine defect in the owner's own file.**
- Cause: `tsconfig.tests.json` has the stricter index checking that `tsconfig.node.json` does not, and the three
  lines index without a guard — `rows[13].date` (129) and `buildDayTable(late, TZ, 1)[0].date` /
  `buildDayTable(late, 'UTC', 1)[0].date` (140, 141). The runtime assertions are correct; only the types are
  unguarded, which is why `vitest run --project main` is green on the same file (45 tests pass).
- Cross-reported by **W1-02-bridge-process** and **W1-06-llm-cloud**, both of which listed it in their notes as a
  REQUEST to W1-08 and correctly did not fix it. The request is still **unfulfilled**.
- Impact: `npm run typecheck` is non-zero repo-wide, so **`npm run verify` cannot pass** and W2-01 inherits a red
  gate. Fix is three non-null assertions or a local `const r = rows[13]!` — entirely inside W1-08's file.
- Note: every other typecheck error named in the Wave-1 self-reports has since been fixed — the four W1-12 errors
  (`app/i18n.ts`, `app/protocol.ts`, `llm/consent.ts`, `testSeams.ts`), the W1-04 `db/repos/items.ts(33,6)` error,
  the W1-15 `ItemCard.test.tsx` / `store/dashboard.test.ts` / `views/Dashboard.test.tsx` errors, and the files
  W1-05 listed (`agent/draft.test.ts`, `llm/local/selfTest.test.ts`, `RawCard.test.tsx`,
  `Onboarding/LinkWhatsApp.test.tsx`). Those requests are **fulfilled**.

### 2.2 `--project renderer` — 1 failing test

```
FAIL  src/renderer/src/App.test.tsx > App - bootstrap and routing
      > starts in onboarding when the bootstrap step is not done and walks the steps
      TestingLibraryElementError: Unable to find an element by: [data-testid="onboarding-choose-ai"]
      at src/renderer/src/App.test.tsx:52
```

- Owner of the failing file: **W1-14-renderer-shell** (`src/renderer/src/App.tsx` + its colocated test).
- Classification: **(b) failure caused by an unfulfilled cross-package REQUEST**, filed by
  **W1-16-renderer-setup** against W1-14 and still open.
- Cause: the test still drives the Wave-0 `Welcome` stub — it clicks the `onboarding-welcome` container and
  expects the step to advance. W1-16 shipped the real step 0, which is a consent gate: the rendered DOM in the
  failure dump shows a language fieldset, a risk section, a `welcome-accept` checkbox and a **disabled**
  `welcome-start` button. The click on the container does nothing, so `onboarding-choose-ai` never appears and
  `onboarding:setStep` is never invoked. W1-16's own `views/Onboarding/Welcome.test.tsx` (7 tests) is green, so
  the component is right and only the shell's test is stale. W1-16 says a replacement snippet is in its notes.
- Impact: `npm run test:unit` is red. Fix is W1-14's alone (check `welcome-accept`, then click `welcome-start`).
- There is **no genuine defect in W1-16** here, and nothing in this failure is caused by a Wave-0 stub — it is not
  a BLOCKED-BY.

### 2.3 `npx prettier --check .` — 212 files (repo-wide, not a Wave-1 package defect)

- Reported in advance by **W1-05-mcp-calendar** (~182 files at the time) and **W1-11-exec** (67+ files), both of
  which deliberately did not run `prettier --write` on their own paths to avoid creating a style island. That was
  the right call under build-plan rule 8.
- Root cause is structural, not any one package's: W0 pasted the CONTRACTS signature blocks verbatim and those
  blocks are not Prettier-formatted, so the unformatted set spans nearly the whole tree including
  `vitest.config.ts` and other W0-frozen files.
- Owner of the fix: **W2-01-compose-integration** (it owns the config hot spots from Wave 2 and is the only agent
  that can format the tree in one pass). `npm run verify` cannot pass until that single pass happens.
- Classification: neither (a) nor (b) — a Wave-2 integration task. Recorded here so it is not re-litigated.

### 2.4 (c) `NotImplementedError` stubs still present

`grep -rn "NotImplementedError" src/` (excluding the definition in `src/main/notImplemented.ts`):

| File | Line | Owner | Status |
|---|---|---|---|
| `src/main/compose.ts` | 43 (`throw new NotImplementedError('W2-01', 'compose')`) | **W2-01-compose-integration** | expected — Wave 2 work, Wave-1 packages are forbidden to wire themselves |

Outside `src/**`, one more stub of the same kind is still standing, also W2-01's:
`tests/helpers/harness.ts:43` (`createHarness()` throws a hand-rolled `NotImplementedError`). W1-10 asks for
`tests/golden/golden.test.ts` to be re-pointed at it once implemented; today that test builds its own orchestrator
over a real in-memory `app.db` instead, which is why nothing is BLOCKED-BY it.

**No Wave-1-owned source file anywhere in `src/**` still throws `NotImplementedError`.** Definition-of-done item
(a) holds for all 16 packages.

## 3. BLOCKED-BY claims

**Zero open BLOCKED-BY entries across all 16 notes files.** Every Wave-1 package self-reported
`blockedBy=-`, and the audit confirms it: the only surviving stubs are W2-01's, and no Wave-1 test fails because
of them. The three Wave-1 self-reports that mentioned another package's red test at the time of writing
(W1-01 -> `doorbell.test.ts`, W1-08 -> `supervisor.test.ts` `DEFAULT_PROBE_INTERVAL_MS`, W1-12 ->
`tests/mocks/electron.ts` missing `resetElectronMock` / `Tray.instances` / `Menu.built` / `Protocol.privileged`)
are all **now green** — `doorbell.test.ts` passes 35 tests, `supervisor.test.ts` and every `src/main/app/*.test.ts`
pass. Those requests are fulfilled and can be closed.

## 4. Cross-package REQUESTS still unfulfilled at the end of Wave 1

Only requests addressed to a **Wave-1** package can still be actioned inside Wave 1. Those are listed first.
Requests addressed to W2-01 / W2-02 / W2-04 are deferred by design — they are inventoried in section 5 so the
orchestrator can hand them to Wave 2 rather than treat them as Wave-1 debt.

### 4.1 Wave-1 -> Wave-1, still open

| From | To | Request | Consequence today |
|---|---|---|---|
| W1-06-llm-cloud, W1-02-bridge-process | **W1-08-shared-utils** | fix the three TS2532 errors in `src/shared/when.test.ts` | **repo-wide `npm run typecheck` is red** (section 2.1) |
| W1-16-renderer-setup | **W1-14-renderer-shell** | replace the stale `App.test.tsx` onboarding walk (it drives the Wave-0 Welcome stub) | **`--project renderer` is red** (section 2.2) |
| W1-16-renderer-setup | **W1-14-renderer-shell** | make `tests/setup-renderer.ts`'s `llm:setProvider` / `secrets:set` / `secrets:clear` fakes stateful over one shared `LlmConfig` | **unfulfilled** — verified: lines 147/150/152 still answer with the pristine constants `llmConfig` / `keyStatus`. No red test today; a view that re-reads the whole config after a provider switch will see a stale consent/key map, so this is a latent trap for W2-03 |
| W1-08-shared-utils | **W1-09-agent-guard** | the S1 prompt must emit `missing:['date']` for past-weekday phrases ("last Thursday"), because `resolveWhen`/`resolveExtraction` never see the text and cannot detect it | **unfulfilled** — verified: `src/main/agent/prompt.ts` has no past-weekday rule (rule 6 only says "Only list what is genuinely absent"), and there is no `edge-01` case in `tests/golden/*.jsonl`. No unit test is red because this only shows up against a live model (`test:golden:live`), but the behaviour W1-08 depends on does not exist |
| W1-15-renderer-dashboard | **W1-14-renderer-shell** (+ W2-01 decision) | `card.suggestedBy` ("Suggested by: {{provider}}", UX 7.4) is unrenderable — CONTRACTS' `ItemCard`/`ItemDetail` carry no `provider` field | **unfulfilled and undecided** — verified: the key is still only in `src/shared/locales/pending/W1-15-renderer-dashboard.json` (lines 35/102). Either CONTRACTS gains `provider` (a W2-01 contract change) or the key is dropped when the fragment is folded in. Not a failure today |
| W1-15-renderer-dashboard | **W1-14-renderer-shell** | `App.tsx`'s `openUndoDrawer()` can drop its optional-property cast now that `setUndoDrawerOpen` is a real action | **unfulfilled, cosmetic** — verified: `App.tsx:274` still casts to `{ setUndoDrawerOpen?: ... }` while `store/dashboard.ts:146` exports the real action. Works, but the optional call would silently no-op if the store ever changed |
| W1-15-renderer-dashboard | **W1-14-renderer-shell** | UX 13.4 wants approval success announced as "Sent to <name>." in the app-level polite region; cards currently announce in their own `role="status"` row | **unfulfilled, accessibility polish**, no red test |
| W1-16-renderer-setup | **W1-14-renderer-shell** | `i18n.usage.test.ts`'s `SEEDED_FOR_OTHER_PACKAGES` (`welcome.`, `ai.`, `pair.`, `google.`) and `SEEDED_KEYS` (`app.back`, `app.close`) are now genuinely referenced and could be dropped to tighten the test | explicitly non-blocking; test is green either way |

### 4.2 Requests that were open in the self-reports and are now **fulfilled** (close them)

- W1-13 -> W1-11: `src/main/ipc/handlers/actions.ts` has a colocated test now (`actions.test.ts`, 15 tests, green),
  so the 100 %/perFile coverage hole is closed.
- W1-11/W1-10/W1-16 -> W1-15: `locales.test.ts` "every Hebrew value differs from the English one" is green —
  `card.provider.claude` / `card.provider.gemini` no longer exist anywhere under `src/shared/locales/`.
- W1-08 -> W1-01: `supervisor.test.ts` `DEFAULT_PROBE_INTERVAL_MS` ReferenceError is gone.
- W1-01 -> W1-03: `doorbell.test.ts` is green (35 tests, including the 20 MB body cap and both `net.connect` cases).
- W1-12/W1-08 -> W1-12: `tests/mocks/electron.ts` now satisfies `src/main/app/*.test.ts`; all of `app/*.test.ts` passes.
- W1-01 -> W1-02 / W1-07: `handleFromChildProcess(child, exePath)` is exported from `src/main/proc/supervisor.ts`
  and is the shared implementation.
- W1-04 -> W1-03: `repos.actions.supersedePendingRepliesOfChat` is called from `ingest.ts:219` inside the item
  transaction, and has its own `[R2]` test.
- W1-02 -> W1-09: the `stdout_marker` vectors are in `injection-corpus.en.json` as `en-marker-*` (20 occurrences).
- W1-09 -> W2-02: `WCA_SENTINEL_MSG_TEXT` is present in `injection-corpus.en.json`; note that
  `tests/fakes/obedient-attacker-llm.ts` does not define the constant itself, so W2-02 must export/derive
  `SENTINEL_MSG_TEXT` when it writes `tests/security/*.test.ts`.
- W1-15 -> W1-14: `undoDrawerOpen` + `setUndoDrawerOpen` exist on `store/dashboard.ts` and `Dashboard.tsx` binds
  `UndoDismissDrawer` to them.
- W1-04 -> W2-01 (partially self-served): `openDbWithRecovery` (`db/backup.ts:111`) and `setSlowStatementHandler`
  (`db/index.ts:60`) are both exported and ready to be wired.

## 5. Wave-2 backlog carried out of Wave 1 (deferred by design, not Wave-1 debt)

For W2-01-compose-integration (largest set; full wording lives in each package's own notes):

- **W1-01**: pass the optional seams to `createSupervisor(...)`; call `reapOrphans(runDir, ownResourcesDir, {...})`
  before any spawn and assert `ownResourcesDir` is the shipped-children directory; make `killAllSync()` reachable
  from session-end and `process.on('exit')`. **Ratify or revert** the three additive-optional parameter widenings
  (`createSupervisor` deps, `reapOrphans` third arg, `freePort` opts) — they are additive and every frozen-shape
  caller still compiles, but they touch frozen signatures and need an explicit decision.
- **W1-02**: `meta.last_online_ts` on every edge away from `online`; `meta.paired_at` + `live_from_ts` +
  `ingest.resolveLidChats()` on `qr_pending -> connected`; `onMarker('history_sync_done')` -> `ingest.poke()`;
  `resolveBridgeExe(...)`; `BridgeStatus -> ErrorCode` mapping; doorbell before `launcher.start()`.
- **W1-03**: two **contract corrections** that need the orchestrator, not W2-01, to amend `docs/specs/contracts.md`
  section 12 — (i) `BridgeDb.userHasSentIn`'s SQL literal is TRUE for a reaction row and contradicts its own prose,
  A13 and TESTS 5.3 (ARCH 4.6 step 4's form is what is implemented); (ii) the `older_message` encoding
  ("raw card, analysis held is NOT used") is structurally impossible and was implemented as
  `analysis='held', hold_reason=NULL`, never enqueued. Both are **doc defects, not code defects.**
- **W1-04**: `chats.mergeLidInto` was implemented items-only (the frozen `trg_actions_frozen` makes
  `actions.chat_id` immutable, safety I3) against CONTRACTS 15.1's wording — same class of doc-vs-code conflict,
  needs the orchestrator to confirm or amend.
- **W1-05**: `createMcpReadClient/WriteClient/AdminClient` over `host.callerFor(...)`, never the host itself;
  `createMcpHost` / `createGoogleAuth` dependency bags; the repo-wide Prettier pass (section 2.3).
- **W1-07**: lazy `createLocalProvider` (its `dispose()` is what stops `llama-server.exe`); `allowHttpLoopback`
  false in production.
- **W1-10**: `cloudDailyTokenBudget()` must be tokens **remaining** today, not the ceiling; pass
  `{ calendarConnected }` into `validateAndPersist()` (defaults false, fail closed); `enqueueRetriage` =
  `TriageQueue.poke` bound, not a second enqueue; re-point `tests/golden/golden.test.ts` at `createHarness()`.
- **W1-11**: second `reconcileUnknown()` with the real `bridgeDb`; wire `ItemService.detail` into
  `ActionExecutorDeps.detail`; `calendar.eventDescription` comes from `W1-11-exec.json` when folding locales.
- **W1-12**: logger wiring (`electron-log/main` imported only in `compose.ts`); `Notification 'click'` ->
  `notifier.handleClick()`; `safeStorage` async API; `registerAppSchemes()` at module top level.
- **W1-13**: add a `.fixtures.ts` glob to `coverage.exclude` in `vitest.config.ts` (then the `v8 ignore` pair in
  `register.fixtures.ts` can go); the `SettingsBus` implementation **must** fire `onChange` after `patch()` and
  `setInternal()` — language switch, tray rebuild and autostart happen nowhere else.
- **W1-14**: no IPC exists for the `DB_RECOVERY` dialog's Restore / Start fresh buttons (both reload the window
  today) — document recovery as automatic in main, or add `data:restoreBackup` / `data:startFresh`.
- **Locale fold-in**: `src/shared/locales/pending/` still holds three fragments — `W1-11-exec.json`,
  `W1-15-renderer-dashboard.json`, `W1-16-renderer-setup.json`. W2-01 folds them into `en.json`/`he.json`, deletes
  `pending/`, re-runs `locales.test.ts` + `i18n.usage.test.ts` and shrinks the allow-lists.

For W2-02-security-gate: `SENTINEL_MSG_TEXT` (section 4.2), the ready-made `en-marker-*` corpus cases, the
`gguf-download` gate item 12b reusing `tests/fakes/fake-llama-server.ts` + `isAllowedDownloadUrl` /
`DOWNLOAD_HOST_ALLOWLIST`, and the already-proven stdout_marker / A16 four-endpoints unit coverage.

For W2-04-packaging: re-run `scripts/fetch-llama.mjs` with `VC_REDIST_CRT_DIR` set and replace the placeholder
`llama.sha256` / `llama.size` and the three null `vcRedistCrt.files` hashes in `vendor/llama.pin.json`
(**shipping today would ship UNPINNED binaries**); icons in `resources/icons/**` + `build/icon.ico` already match
`electron-builder.yml`.

## 6. Verdict

Wave 1 is essentially complete. Fifteen of sixteen packages have no red artefact of any kind. Two fixes, both
small and both inside a single owner's own files, clear every failing gate this audit can reach:

1. **W1-08-shared-utils** — guard the three indexed reads in `src/shared/when.test.ts` (lines 129, 140, 141).
2. **W1-14-renderer-shell** — rewrite the onboarding walk in `src/renderer/src/App.test.tsx` against W1-16's real
   consent-gated Welcome (`welcome-accept`, then `welcome-start`).

After those, `npm run lint`, `npm run typecheck` and `npm run test:unit` are all green and Wave 2 starts from a
clean base. The remaining repo-wide blocker for `npm run verify` is the single Prettier pass, which is W2-01's by
ownership and cannot be done by a Wave-1 package without breaking build-plan rule 8.

Two items deserve an explicit orchestrator decision rather than silent inheritance: the **CONTRACTS section 12 /
15.1 doc defects** raised by W1-03 and W1-04 (code is right, the spec text is wrong), and W1-01's **three additive
optional parameters on frozen signatures**.

## REQUESTS

None. This package is read-only and produced no code. Everything actionable is attributed in sections 2, 4 and 5
and addressed to the owning package there.

## BLOCKED-BY

None.
