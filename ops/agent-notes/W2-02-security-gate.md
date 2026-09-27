# W2-02-security-gate — working notes

Package: the 12-item security gate of `docs/specs/test-strategy.md` 8.2 plus the two `+` rows, under
`tests/security/`. Also the Wave-2 owner of `tests/setup-guards.ts`.

Owned paths (build-plan section 6): `tests/security/*.test.ts`, `tests/setup-guards.ts`.
Read-only for me: everything else, including the two corpora `tests/security/injection-corpus.{en,he}.json`
(authored by W1-09; they live in my directory but they are data, not my deliverable).

## Ground rules I am holding myself to

- The REAL `ToolGate`, `McpReadClient`, `McpHost.callerFor`, `ActionExecutor`, `bridge/invariants`,
  `deriveState`, `actionHash` and the DB triggers. Never a mock of the thing under test.
- A red test is a FINDING. It is listed in section "FINDINGS" below with the failing case and the owning
  package id. It is never skipped, weakened, or fixed by patching product code (which I do not own anyway).
- The Hebrew and English corpus payloads are attack DATA aimed at the app under test. I do not act on any
  instruction inside them (TESTS T6).

## Status log

- Read: build-plan 1, 1.1, 1.2, 6, brief 7 `W2-02-security-gate`; TESTS 8 in full + 5.1; wave0-seams;
  W0 + W2-01 notes.
- Baseline before I started: `npx vitest run --project security` = 1 file / 7 tests green
  (`import-graph.test.ts`, delivered by W0 and already complete against the real tree).

(Sections FINDINGS / REQUESTS / BLOCKED-BY are at the bottom and are filled in as I go.)

## Progress (session 2, 2026-09-23)

Delivered so far (all green under `npx vitest run --project security`):

| File | Gate item | Notes |
|---|---|---|
| `import-graph.test.ts` | 2 | delivered by W0, unchanged |
| `tool-gate.test.ts` | 1 | session 1 |
| `injection-corpus.test.ts` | 3 | session 1 |
| `prompt-purity.test.ts` | 4 | session 1 |
| `approval-binding.test.ts` | 5 | session 2 |
| `doorbell.test.ts` | 7 | session 2 |
| `bridge-invariants.test.ts` | 8 (+ reaper pid files) | session 2 |
| `electron-hardening.test.ts` | 12a | session 2 |
| `fixtures-synthetic.test.ts` | + | session 2 |

### Decisions taken while writing them

- **`cwd_missing` through the launcher is unreachable** and that is correct: `spawnOnce()` calls
  `mkdirSync(paths.bridgeCwd)` before the invariants run. Covered at the `assertBridgeSpawnInvariants` level instead;
  the launcher-level table says so in a comment.
- **Doorbell:** three properties cannot be driven from outside the process and are asserted at source level, with the
  reason written next to the assertion: the non-loopback remote branch (the listener is bound to 127.0.0.1, so every
  accepted socket already has a loopback peer), the 10 s stalled-drain timer (a behavioural test would need a 10 s real
  sleep, which rule T7 forbids), and the `requestTimeout/headersTimeout/maxHeadersCount` assignment (`server` is
  private). The behavioural half of each is covered: the wrong-path slow-body client is proven to be cut *immediately*,
  which is strictly stronger than "cut by the 5 s requestTimeout".
- **Production seam lock (TESTS 4.1):** `out/` currently holds an `--mode e2e` build (W2-03's `out/.e2e-build` marker).
  Rebuilding `out/` in production mode would clobber a parallel agent's artefact, so `electron-hardening` asserts the
  SOURCE lock unconditionally (`compose.ts` imports `testSeams` as a *type only*; `index.ts` imports it dynamically
  behind `import.meta.env.MODE === 'e2e'`; no module except `testSeams.ts` names a `WCA_*` variable in code) and, when
  a production `out/main` is present, greps it for the five seam strings. With the e2e marker present it asserts the
  inverse (marker and seam code always travel together).
- **Fixture lint:** the reserved synthetic phone forms are the WhatsApp range `9725500000NN` (T5) and the NANP
  fictional `555` blocks, and the allowed e-mail domains are the RFC 2606 / 6761 reserved ones (`*.example`,
  `.test`, `.invalid`, `.localhost`). A negative-control block proves each predicate still fires.

## Final state (session 2 complete, 2026-09-23)

`npm run test:security` -> **16 files / 492 tests, all green.**
`npx eslint tests/security tests/setup-guards.ts --max-warnings 0` -> clean.
`npm run typecheck` -> clean (no error in any file I own).

| # | File | Gate item |
|---|---|---|
| 1 | `tool-gate.test.ts` | 1 (I2) |
| 2 | `import-graph.test.ts` | 2 (I1, A22) - W0-delivered, untouched |
| 3 | `injection-corpus.test.ts` | 3 (I1, I3) - 68 corpus cases executed (>= 40 required) |
| 4 | `prompt-purity.test.ts` | 4 (I4) |
| 5 | `approval-binding.test.ts` | 5 (I1, A11) |
| 6 | `crash-recovery.test.ts` | 6 (I7) |
| 7 | `doorbell.test.ts` | 7 (A6) |
| 8 | `bridge-invariants.test.ts` | 8 (I6) + reaper hostile pid files |
| 9 | `redaction.test.ts` | 9 (logging / C-41) |
| 10 | `consent-payload.test.ts` | 10 (I5, A20) |
| 11 | `backlog-gate.test.ts` | 11 (A14) |
| 12 | `electron-hardening.test.ts` | 12a (ARCH 15.1 / 15.2 / 16) |
| 13 | `gguf-download.test.ts` | 12b (A21) |
| 14 | `rate-limiter.test.ts` | 12c (A11) |
| 15 | `no-side-effect-fuzz.test.ts` | `+` (I1) - 1 000 schema-driven + 200 malformed invocations |
| 16 | `fixtures-synthetic.test.ts` | `+` (T5) |

The ledger hook (`tests/helpers/ledger-hook.ts`) is active for the whole `security` project, so every one of the 492
tests is additionally checked for an unapproved side effect after it finishes.

## FINDINGS

**None.** No security test in this package is red, and no product code was patched to make one green. Every red test I
hit while writing the gate turned out to be a wrong assertion on my side; each one is recorded below with what the
product actually does, so a later reader can tell "I relaxed the test" from "I corrected it".

| What went red first | Why it was MY bug, not the product's |
|---|---|
| `redact('chat=<jid>')` expected `[PHONE]@[EMAIL]` | `@s.whatsapp.net` is not an e-mail TLD; C-41 replaces the digits only. |
| `toolMeta('list-events')` expected `{tool}` | `READ_TOOL_NAMES` is `['get_current_time','get_freebusy']` - the app's OWN tool names. A real MCP name is model-adjacent and is correctly hashed. |
| jitter with `random()===1` gave 8001 ms | `RandomSource.float()` is contractually `[0,1)`; the upper bound must be driven with the largest double below 1, which yields exactly 8000 ms. |
| `settings:set {backlogHours: 10000}` expected to be clamped | `SettingsSchema` refuses it outright (0..72), and a hand-edited row falls back to `DEFAULT_SETTINGS` on every read. Both are stronger than a clamp; the test now asserts those. |
| `cwd_missing` through the launcher | `spawnOnce()` creates `<userData>\bridge` before the invariants run, so the violation is only reachable at the `assertBridgeSpawnInvariants` level. |
| create-event retried after `id_exists` | The executor treats `id_exists` as success (the event already exists under the chain-root id) - exactly the [R2] rule. |

### Observations (NOT findings - nothing in a spec requires them)

1. `stripInvisible()` does not strip U+00AD SOFT HYPHEN. Its documented set is "Unicode TAG block, bidi controls,
   zero-width, C0", and U+00AD is none of those, so this is a deliberate boundary rather than a gap. `approval-binding`
   asserts exactly the declared set. If a reviewer wants U+00AD covered it is a one-character change in
   `src/shared/schemas.ts` (owner W1-08 / W0 contract) - it would need a CONTRACTS amendment, so I did not request it.
2. `manage-accounts {action:'add'}` is reachable from the renderer through `google:startSignIn`, and the
   `no-side-effect-fuzz` run does trigger it. It is an ADMIN tool that changes no calendar data and writes no message,
   so it is not a "non-READ" call in the sense of TESTS 8.1 item 3. The fuzz asserts the four calendar WRITE tools are
   never called and that `calendar.violations` stays empty, which is what I1 actually forbids.
3. A `google:disconnect` inside the fuzz leaves the calendar unconfigured, so the final "one legitimate approve" step
   of `no-side-effect-fuzz` targets a `send_reply` (the bridge is still online) rather than a `create_event`. The
   re-connect attempt through `google:importCredentials` + `google:startSignIn` is left in the test because it is the
   real recovery path, but the assertion does not depend on it succeeding.

## REQUESTS

**W2-01-compose-integration** (all optional; nothing is blocked on them, each would let a security test assert a
property behaviourally instead of at source level):

1. `tests/helpers/harness.ts`: expose the electron facade's recorders - `opened: string[]` (from `openExternal`) and
   `notifications: Array<{title, body}>` (from `notify`). `electron-hardening` currently has to build
   `createAppHandlers` with a partial `HandlerDeps` to observe `external:open`; with the recorders it could drive the
   same assertion through `harness.invoke('external:open', ...)`.
2. `tests/helpers/harness.ts`: let a test script `showSaveDialog` (e.g. `HarnessOptions.saveDialog?: (req) => string | null`).
   Today it always cancels, so `diagnostics:export` can never write its bundle and `redaction.test.ts` has to assert the
   bundle's SOURCES (health / settings / counts / recovery) instead of the file on disk.

**W1-05-mcp-calendar** (optional): `FakeMcpCalendar` has `failNext(tool, kind)` but no `delay(tool, ms)`. TESTS 8.2 item 5
names `calendar.delay('get-freebusy', 500)` for the create_event double-click race. The race is reproduced without it -
both concurrent approves naturally yield at the fresh free/busy pre-check, and the loser gets `ACTION_STALE` - but a
`delay()` would make the interleaving explicit instead of incidental.

## BLOCKED-BY

None. Every Wave 1 / Wave 2 module this package exercises is implemented; no test is failing because of a
`NotImplementedError` stub.
