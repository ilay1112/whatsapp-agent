# W1-10-agent-pipeline — working notes

Owned paths (build-plan §6): `src/main/agent/{stage0,queue,extract,draft,validate,orchestrator,items}.ts`,
`tests/fakes/stub-llm.ts`, `tests/golden/**`, `tests/helpers/goldenLoader.ts`, plus the colocated tests of those
source files (`X.test.ts`, `__fixtures__/X/**`).

## State — done

Resumed from an interrupted earlier attempt. The seven `src/main/agent/*.ts` sources were already implemented (no
`NotImplementedError` left in any owned source). This session added the whole test suite, the scripted LLM fake, the
golden loader and the 42-case golden evaluation set, and fixed two lint defects in the pre-existing sources
(an unused `ChatRef` import in `items.ts`, a literal U+00A0 inside `PHONE_RE` in `validate.ts` — now ` `).

| File | Status |
|---|---|
| `src/main/agent/stage0.ts` + `stage0.test.ts` | done — 36 tests, 100 % lines / 100 % branches |
| `src/main/agent/queue.ts` + `queue.test.ts` | done — 17 tests, 97.9 % lines |
| `src/main/agent/extract.ts` + `extract.test.ts` | done — 11 tests, 100 % |
| `src/main/agent/draft.ts` + `draft.test.ts` | done — 25 tests, 100 % lines / 97.1 % branches |
| `src/main/agent/validate.ts` + `validate.test.ts` | done — 31 tests, 100 % lines / 100 % branches |
| `src/main/agent/orchestrator.ts` + `orchestrator.test.ts` | done — 26 tests, 100 % lines / 97.1 % branches |
| `src/main/agent/items.ts` + `items.test.ts` | done — 33 tests, 100 % lines / 96.7 % branches |
| `tests/fakes/stub-llm.ts` | implemented (rules, `script`, `fromGoldenCase`, `fromScriptFile`, `unmatched`, providerData identity check) |
| `tests/helpers/goldenLoader.ts` | implemented (+ `stubExtractionOf`, `goldenTimeline`, corpus validation) |
| `tests/golden/{he,en,mixed}.jsonl` | 42 cases (he 20, en 15, mixed 7), 6 injection rows |
| `tests/golden/golden.test.ts` | 89 tests green (scripted mode) |
| `tests/golden/golden.live.test.ts` | opt-in only (`WCA_GOLDEN_LIVE=1`); skipped in every agent run |
| `tests/golden/testDb.ts` | shared fixture builder (real in-memory app.db + repos + recording READ client + real ToolGate) |

Coverage over `src/main/agent/**` from the owned suites: **99.74 % lines, 98.52 % branches, 99.24 % functions**.
`stage0.ts` and `validate.ts` (safety-critical, 100 % / 95 % required) are at 100 % lines and 100 % branches.

Verification commands run:
- `npx eslint src/main/agent tests/fakes/stub-llm.ts tests/helpers/goldenLoader.ts tests/golden --max-warnings 0` → clean
- `npx tsc --noEmit -p tsconfig.node.json` → clean; `-p tsconfig.tests.json` → no error in any owned file
- `npx vitest run --project main src/main/agent` → 405/405
- `npx vitest run --project integration tests/golden/golden.test.ts` → 89/89
- `npx vitest run --project golden-live` → 1 passed, 1 skipped (the opt-in guard)
- `npx prettier --check` on every owned file → clean

## Assumptions / decisions

1. **`ValidateOptions.calendarConnected` as a trailing optional argument.** The frozen `ValidateInput` of
   `docs/specs/wave0-seams.md` carries no calendar-connectivity flag, but ARCH 6.5 requires `create_event` to be
   proposed only when the calendar is connected. It arrives as an optional trailing parameter so the frozen shape is
   untouched; the default is `false` (fail closed). `validate.test.ts` pins that default.
2. **`Stage0Deps.budgets.cloudDailyTokenBudget()` is the allowance LEFT for today**, not the configured ceiling.
   S0 holds the item when it is `<= 0`, and never applies it to the Local provider. See REQUESTS → W2-01.
3. **The golden scripted runner does not use `tests/helpers/harness.ts`.** TESTS 7.2 describes the runner on top of
   `createHarness()`, which is a W0 stub owned by W2-01 and still rejects with `NotImplementedError`. Rather than land
   the whole golden suite red (and therefore useless as a regression gate for S0/S2/S4), `tests/golden/golden.test.ts`
   drives the **real** `createOrchestrator` over a real in-memory `openDb(MEMORY_DB)` + `createRepos` with the virtual
   clock, `StubLlm.fromGoldenCase()`, the real `ToolGate` and a recording READ-only calendar double. It asserts
   everything TESTS 7.2 asks for — item state, resolved slot, `missing`, badges, reply language, the pending actions,
   and the dashboard list the item appears in (through `ItemService.dashboard()`) — plus "every action is still
   PENDING", which is the approval-first invariant the ledger exists to protect. What it does not exercise is the
   bridge/IPC plumbing that only `compose()` provides. **This is a deliberate deviation from TESTS 7.2** and is
   flagged for W2-01 under REQUESTS; re-pointing the runner at `createHarness()` later needs no change to the data
   files or the expectations.
4. **`GoldenCase` shape.** TESTS 7.1 says the shape of `agent-pipeline.md` wins and that `goldenLoader.ts` adapts. The
   W0 stub of `tests/helpers/goldenLoader.ts` already declared a final `GoldenCase` type that is neither the TESTS 7.1
   nor the PIPELINE 11 shape. Since the only importers are `tests/fakes/stub-llm.ts` (mine) and
   `tests/helpers/harness.ts` (type-only, currently unused), I kept the W0 type as the on-disk contract and **extended
   it additively** with the PIPELINE 11 fields the runner needs (`category`, `settings`, `calendar.busy`,
   `expect.state`, `expect.replyLang`, `expect.actions`, `expect.endLocal`, `expect.extraction`, `expect.draft`,
   `note`). No existing field changed name or type, so nothing that compiles today can break.
5. **`StubLlm` `providerData` identity check.** TESTS 3.3 requires the stub to prove verbatim replay without a real
   provider. Every assistant message gets a fresh opaque object; on the next `chat()` the stub verifies each assistant
   turn in the incoming history carries one of the objects it issued **by identity** and throws a plain `Error` (not an
   `LlmError`) when it does not — so a replay bug surfaces as a test failure, not as a swallowed "provider error".
   The stub also reports usage through `opts.onUsage`, so the `runs` token columns are exercised.
6. **`tests/golden/testDb.ts`** is the shared fixture builder used by the colocated agent tests and by the golden
   runner. It lives under `tests/golden/` because that whole directory is mine; `tests/helpers/` is W0 → W2-01.
7. **`queue.ts` `poke()` uses a trailing debounce of `LIMITS.pokeDebounceMs`** — one pending check covers a burst of
   doorbells. The 20 s / 60 s message debounce lives in `repos.queue.enqueue()` (W1-04, CONTRACTS 15.1), not here.
8. **The golden corpus is hand-authored JSONL with hand-computed expectations.** Every `startLocal`/`missing`/`badges`
   value was derived by hand from `resolveWhen` + `deriveBadges` before the suite was first run; two rows
   (`inj-en-02`, `inj-en-03`) were corrected afterwards because the *context builder* — not S4 — adds the
   `personal_details` badge when the attacker payload itself contains an e-mail address or a phone number. That is
   correct behaviour and is now pinned by the corpus.

## Dead ends

- Driving the golden suite through `createHarness()` first: it rejects with `NotImplementedError` (W2-01) and every
  case failed for a reason unrelated to the pipeline. Replaced as described in assumption 3.
- A first draft of `queue.test.ts` let a deliberately-hanging `runChat` stay unresolved across the `afterEach`, which
  hung `queue.stop()` and then tripped the T7 leak guard in the *next* test. Every hanging run now registers its
  resolver so the teardown can always release it.

## REQUESTS

- **W2-01**: `compose()` must supply `Stage0Deps.budgets.cloudDailyTokenBudget()` as the tokens *remaining* for the
  current day (configured ceiling minus `repos.runs.cloudTokensSince(startOfDay)`), and must pass
  `{ calendarConnected }` into `validateAndPersist()` from the MCP host's connectivity (assumptions 1-2).
- **W2-01**: `ItemServiceDeps.enqueueRetriage` is expected to be `TriageQueue.poke` bound to the queue; the
  `triage_queue` row is written by `ItemService` itself inside its own transaction, so `poke` must not enqueue again.
- **W2-01**: once `createHarness()` exists, re-point `tests/golden/golden.test.ts` at it (assumption 3). The data
  files and the expectations do not need to change.
- **W1-08 / W1-09**: `npx prettier --check` reports style issues in files you own — `agent/resolve.ts`,
  `dateTable.ts`, `minimize.ts`, `replyLang.ts`, `contextBuilder.ts` and their tests (W1-08) and `agent/sanitize.ts`,
  `prompt.ts`, `toolDefs.ts`, `toolGate.ts` and their tests (W1-09). `npm run verify` runs `format:check`, so these
  will fail the gate. I did not touch them.
- **W1-14**: `src/shared/locales/locales.test.ts` fails — `card.provider.claude` and `card.provider.gemini` have
  identical `he` and `en` values ("untranslated he values"). It is the only red test in the whole `main` project.

## BLOCKED-BY

None. No owned test fails because of another package's Wave 0 stub: the golden runner deliberately avoids the one
stub that would have blocked it (`createHarness`, W2-01) rather than leaving 89 tests red — see assumption 3.

---

## Fix round (2026-09-23) — response to `ops/agent-notes/wave1-audit.md`

The audit attributes four items to W1-10. All four are the *same* four REQUESTS this package filed against
W2-01 at the end of Wave 1 (audit section 5, bullet "W1-10"). Checked each one against the code as it stands
today; nothing in an owned file was wrong, so this round is verification + making the wiring contract explicit
at the seam W2-01 will read, not a rewrite.

| Audit item | State in my owned paths | Action this round |
|---|---|---|
| `cloudDailyTokenBudget()` = tokens **remaining**, not the ceiling | already correct — `stage0.ts` holds with `reason:'budget'` as soon as the closure returns `<= 0`, and only for a cloud provider (`consentKind !== undefined`). Pinned by `stage0.test.ts` "rule 5c: an exhausted cloud daily token budget holds the item, and never applies to Local" (`tokensLeft` 0 → held, 1 → queued) and "rule 5c beats rule 6" | added a `WIRING CONTRACT (W2-01)` doc comment on `Stage0Deps.budgets` naming the exact formula (`settings.llm.cloudDailyTokenBudget` − `repos.runs.cloudTokensSince(startOfDay)`) and spelling out that passing the raw ceiling disables the gate. It sits on the declaration W2-01 wires against, not only at the use site |
| `{ calendarConnected }` into `validateAndPersist()`, default false (fail closed) | already correct — `ValidateOptions.calendarConnected?: boolean`, `opts.calendarConnected === true` at `validate.ts:140`, so `undefined` is false; `eventToPropose` is `null` without it, so no `create_event` action row is ever written. `validate.test.ts` "NEVER creates create_event while the calendar is not connected (default is fail closed)" pins the default. The orchestrator derives the flag from the real gate (`gate.exposedTools().length > 0`, `orchestrator.ts:211`), which is itself driven by `ToolGateDeps.calendarConnected` — so even a mis-wire in compose cannot propose an event through an unexposed tool | none needed (doc comment on `ValidateOptions` already states the fail-closed rule) |
| `enqueueRetriage` = `TriageQueue.poke` bound, not a second enqueue | already correct — both call sites (`items.ts` `retriage()` and `setChatPolicy({forceKnown})`) write the `triage_queue` row themselves via `repos.queue.enqueue(...)` **inside** the same `repos.db.transaction(...)` as the item update, then call `deps.enqueueRetriage(chatRef)` outside it as a pure doorbell | sharpened the `ItemServiceDeps.enqueueRetriage` comment into a `WIRING CONTRACT (W2-01)` block that says why a second `enqueue` here would re-arm the debounce and double-book the chat |
| re-point `tests/golden/golden.test.ts` at `createHarness()` | **not possible yet** — `tests/helpers/harness.ts` (owner W2-01) is byte-for-byte the Wave-0 stub: `createHarness()` still returns `Promise.reject(NotImplementedError)` at line 43, and `src/main/compose.ts:43` still throws `NotImplementedError('W2-01','compose')`. Re-pointing today would turn 89 green tests red for a reason unrelated to the pipeline | none. Stays as assumption 3: the runner drives the real `createOrchestrator` over a real in-memory `app.db`. The deviation is stated in the file header; the data files and every expectation survive the switch unchanged. Carried to "unresolved" |

No test was deleted, skipped or weakened; no file outside the owned paths was touched.

### Verification re-run after the two comment edits (all from `"C:\dev\whatsapp agent"`)

- `npx vitest run --project main src/main/agent` → **409 passed / 18 files** (405 at the end of Wave 1; the extra 4 are W1-08/W1-09 tests in the same directory, not mine)
- `npx vitest run --project integration tests/golden/golden.test.ts` → **89 passed**
- `npx vitest run --project golden-live` → 1 passed, 1 skipped (the opt-in guard; `WCA_GOLDEN_LIVE` unset, so no model and no network)
- `npx eslint src/main/agent tests/fakes/stub-llm.ts tests/helpers/goldenLoader.ts tests/golden --max-warnings 0` → clean
- `npx tsc --noEmit -p tsconfig.node.json` → clean; `-p tsconfig.tests.json` → **clean repo-wide now** (W1-08 fixed the three `src/shared/when.test.ts` TS2532 errors; that request can be closed)
- `npx prettier --check` over every owned file → clean
- coverage over `src/main/agent/**` from the owned suites: **99.62 % lines, 98.52 % branches, 99.24 % functions** (thresholds 90/85/90; `stage0.ts` and `validate.ts` at 100 % lines / 100 % branches)

### REQUESTS — status after this round

- **W2-01** (unchanged, all four): remaining-token budget closure; `{ calendarConnected }` from the MCP host into
  `validateAndPersist()`; `enqueueRetriage` = bound `TriageQueue.poke`; re-point the golden runner at
  `createHarness()` once it exists. The first three are now documented as `WIRING CONTRACT` comments on the
  declarations themselves, so the requirement is visible where the wiring is written.
- **W1-09-agent-guard** (re-verified today, still open): `npx prettier --check` fails on `src/main/agent/sanitize.ts`,
  `toolDefs.ts` and `toolGate.ts`. `npm run verify` runs `format:check`, so these fail the gate. W1-08's files
  (`resolve.ts`, `dateTable.ts`, `minimize.ts`, `replyLang.ts`, `contextBuilder.ts`) are formatted now — closed.
- **W1-09-agent-guard** (new, low priority, from audit section 4.1): W1-08 asks the S1 prompt to emit
  `missing:['date']` for past-weekday phrasing ("last Thursday"). `prompt.ts` has no such rule. I deliberately did
  **not** add an `edge-01` row to `tests/golden/*.jsonl` for it: in scripted mode the row would only replay a stub
  extraction and prove nothing about the prompt, and in live mode it would encode a red expectation against another
  package's unimplemented rule. The corpus row is ready to add (en, jid `972550000043@s.whatsapp.net`,
  category `past_weekday`) the moment W1-09 lands the rule.
- **W1-14-renderer-shell**: the `locales.test.ts` failure reported at the end of Wave 1 is fixed
  (`card.provider.*` is gone) — closed.
