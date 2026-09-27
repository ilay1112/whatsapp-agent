# fix - compose.ts:550 `mcpHost.onStatus -> healthHub.setCalendar` (finding `ux-i18n-2`, major)

Label: `fix-src-main-compose-line-550`. Notes file name is the requested one truncated at `>` (`->` in the task's
title), which Windows forbids in a file name - same convention the other `fix-src-main-*` notes in this folder used.
Not to be confused with `fix-src-main-compose.ts (composition root, supervisedLlama wrapper at lines 659-666).md`,
which is a different agent working on a different defect in the same file.

## Verdict: finding CONFIRMED and FIXED

The reviewer + skeptic were right, and the defect reproduces in the real suite (not only in a scratch harness) - see
"Failing test first" below. The reviewer's *first* option was also the right one; I implemented that.

## What was wrong

`compose.ts:550` was the only status-driven calendar publisher:

```ts
mcpHost.onStatus((s) => {
  healthHub.setCalendar({ state: s });   // <- no ErrorCode, ever
});
```

Compare the bridge at `compose.ts:~893`, which does
`healthHub.setBridge(code === null ? { state: s } : { state: s, code })` with `bridgeStatusToErrorCode(...)`.

`healthHub.applyPart` then sets `part.code = undefined` and `freezePart` drops the key, so `AppHealth.calendar` in
production never carried a `code`. Two consequences, both proven below:

1. **No action on a red Calendar row (A17 / UX 1.2 breach).** `HealthPill.tsx:161-175` produces an `actionLabel` only
   when the part carries a `code`, or (calendar) the state is `not_configured | needs_sign_in`. So
   `reconnect_required | unavailable | port_busy | toolset_mismatch` rendered red, with a sentence and no button.
2. **The `CAL_RECONNECT` toast could never fire.** `compose.ts:~355` computes the attention code as
   `h.whatsapp.code ?? h.llm.code ?? h.calendar.code`; `calendar.code` was always `undefined`, so the
   `CAL_RECONNECT` entry of `ATTENTION_CODES` (`compose.ts:210`) was dead. `notifier.attention` has exactly one caller
   in the codebase, that one. An expired Google token therefore produced neither a button nor a notification.

The suite stayed green because `HealthPill.test.tsx:87` and `App.test.tsx:189` hand-build fixtures
(`{ state: 'reconnect_required', since: 0, code: 'CAL_RECONNECT' }`) that production never emitted. Those two tests
were testing a real requirement against a shape only the test could produce. They now describe production.

## Failing test first (both failed before the fix, on the assertion that matters)

New file `tests/integration/calendar-health.test.ts` - the production `compose()` over the harness fakes:

1. *"attaches CAL_RECONNECT and raises the toast when the Google token expires"*:
   `h.calendar.failNext('manage-accounts', 'auth')` (the fake answers the next `manage-accounts list` with
   `invalid_grant` - what an expired refresh token looks like) then `invoke('google:status')`, which runs
   `googleAuth.pollAccount() -> admin.manageAccounts('list') -> host.callerFor('admin')`. The host classifies the text
   as `auth` and calls `setStatus('reconnect_required')`, so the real `onStatus` handler at compose.ts:550 runs.
   Before the fix: `state === 'reconnect_required'` and `overall === 'attention'` already passed,
   `expect(health.calendar.code).toBe('CAL_RECONNECT')` got `undefined`. The toast assertion was the second half of
   the same test (`notifications` must contain the `errors.CAL_RECONNECT.title` toast).
2. *"attaches CAL_UNAVAILABLE when the calendar server goes away"*: `await h.calendar.stop()` closes the server half of
   the in-memory pair, the SDK client's `onclose` sets `unavailable`. Before the fix: `code` was `undefined`.
3. A negative control: `calendar: 'not_configured'` must have **no** `code` key at all and must not be `attention`
   (skipped Google = reply-only mode, not an error). Passed before and after.

Plus two unit tests in `src/main/mcp/host.test.ts` (new `describe('mcpStatusToErrorCode')`): the exhaustive table over
`MCP_STATUSES`, and an invariant test that ties the mapping to `shared/health`:

```
for every McpStatus: (mcpStatusToErrorCode(s) !== null) === (overallOf(healthy + calendar:s, severityOf) === 'attention')
```

That second one is the real guard - if someone adds a tenth `McpStatus` that `overallOf` classes as attention and
forgets to map it, this test fails instead of a user meeting a dead red row.

## The fix (smallest surface: 1 new exported function + 4 lines at the call site)

- `src/main/mcp/host.ts` - new exported pure function `mcpStatusToErrorCode(status: McpStatus): ErrorCode | null`,
  placed next to `statusForAccountList`, deliberately the exact twin of `bridgeStatusToErrorCode` in
  `src/main/bridge/launcher.ts` (same shape, same "frozen interface carries no `errorCode()`" reasoning in the
  doc comment). Mapping: `reconnect_required -> CAL_RECONNECT`, `port_busy -> CAL_PORT_BUSY`,
  `toolset_mismatch -> CAL_TOOLSET_MISMATCH`, `unavailable -> CAL_UNAVAILABLE`, everything else `null`.
  Also added `import type { ErrorCode }`.
- `src/main/compose.ts:550` - `const code = mcpStatusToErrorCode(s); healthHub.setCalendar(code === null ? { state: s } : { state: s, code });`
  and the import on line 98.

Nothing else changed. In particular:

- **`HealthPill.tsx` was NOT patched.** The reviewer's second option (teach the pill to special-case four calendar
  states) would have left the `CAL_RECONNECT` toast dead, because the toast reads `h.calendar.code`, not the pill.
  Fixing it in compose feeds both consumers from one source, and keeps the "renderer stores only what main pushes"
  rule intact.
- **`overallOf` classification is unchanged.** All four mapped states were already `attention` by state
  (`OK_CAL = connected|not_configured`, `WORKING_CAL = starting|signing_in|needs_sign_in`), and every mapped code is
  `attention` severity (`CAL_PORT_BUSY` is listed explicitly in `ERROR_SEVERITY`, the other three default to it).
  So no pill colour and no `overall` value moved; only the `code` key appeared.
- **`ERROR_ACTION` was NOT touched** - see the residual gap below.
- `compose.ts:1234` (`setCalendar({ state: 'not_configured' })` when no credentials file exists) is correct as-is:
  `not_configured` maps to `null` anyway.

## What this makes reachable (and what stays dead)

- `App.tsx:339-347` `code === 'CAL_TOOLSET_MISMATCH' -> exportDiagnostics()` is now reachable in production. It was
  genuinely dead before (the skeptic's one refuted sub-claim was about the *other* branch, `part === 'calendar' && !code`,
  which is and was the `not_configured | needs_sign_in` "Connect" path - confirmed, I did not touch it).
- `CAL_RECONNECT` -> label "Reconnect" -> falls through `onHealthAction` to `setView('settings')`, where
  `Settings.tsx:619` (`settings-google-reconnect`) is the working recovery path. The point of the finding was that the
  user had to find that unaided; now the red row points at it.
- `CAL_UNAVAILABLE` -> "Try again" -> settings.

**Residual, deliberate, NOT fixed: `port_busy` still renders with no button.** `ERROR_ACTION.CAL_PORT_BUSY` is
`'none'`, frozen in `docs/specs/contracts.md:475`, and `ARCHITECTURE.md:628` says the intended UX is
"`CAL_PORT_BUSY` -> plain instruction". After this fix the row at least carries that instruction
(`errors.CAL_PORT_BUSY.body`: "Another program is using the ports it needs (3500-3505). Close it and try again.")
instead of the bare `health.calendar.port_busy` sentence, so it is strictly better, but it is still a red row with no
button. There is a spec conflict worth a decision by the orchestrator, NOT a code change by me:

| Source | Says |
|---|---|
| `docs/specs/contracts.md:475` (wins on data shapes) | `CAL_PORT_BUSY: 'none'` |
| `docs/specs/ux.md:998` (error table) | action column = "Try again" |
| `src/shared/locales/{en,he}.json` | `errors.CAL_PORT_BUSY.action` exists ("Try again") - currently a string nothing renders |

Changing `ERROR_ACTION.CAL_PORT_BUSY` to `'try_again'` would close the A17 gap completely and the i18n string is
already there, but it edits a frozen contract table, so it is out of scope for this repair and left as a REQUEST.

### REQUEST (orchestrator)
Decide `CAL_PORT_BUSY`: keep `ERROR_ACTION 'none'` + "plain instruction" (then `ux.md:998`'s action column is wrong and
the `.action` i18n string is intentionally unused), or flip it to `'try_again'` (then `contracts.md:475` changes).
Either way one of the three sources above should be corrected so the next reviewer does not re-raise this.

## Verification run

| Command | Result |
|---|---|
| `npx vitest run tests/integration/calendar-health.test.ts src/main/mcp/host.test.ts` | 63 passed (the 4 new assertions among them; 2 of them failed before the fix, exactly as designed) |
| `npx vitest run src/main/mcp src/main/health src/renderer/src/components/HealthPill.test.tsx src/renderer/src/store/health.test.ts` | 199 passed |
| `npx vitest run tests/integration` | 12 files, 60 passed |
| `npx eslint` on the four touched files | clean |
| `npx prettier --check` on the touched files | clean |
| `npx tsc --noEmit -p tsconfig.node.json` | clean |

## Red things I saw that are NOT mine (reported, not touched, not weakened)

Other repair agents are editing this tree at the same time; these were failing/erroring from their in-flight work
while I ran, and none of them involve the calendar health part:

1. `tests/security/redaction.test.ts` > "after data:purgeNow neither app.db nor the daily backups still hold the
   message text" - FAILS: `item_messages.text=1`, `actions.canonical_json=1` survive `data:purgeNow`. The test file
   currently carries another agent's `'TEMP-DIAG'` instrumentation, so this is live work by the data-integrity repair.
   Nothing in my diff touches the DB, retention or purge.
2. `npm run typecheck` - errors in `src/renderer/src/components/ItemCard.tsx` / `ItemCard.test.tsx`
   (`Cannot redeclare block-scoped variable 'dismiss'`, `Expected 3 arguments, but got 2`, `lastError: string`) and in
   `src/main/agent/contextBuilder.test.ts` (`slotOf`, `NO_SLOT`, `slot` not in `BuildContextInput`).
   `tsconfig.node.json` (main process, where my change lives) is clean.
3. `npm run lint` - one error in `src/main/db/repos/chats.test.ts:290` (`'phone' assigned but never used`).
4. While I was working, `tests/integration/app-boot.test.ts` was briefly syntactically broken on disk by another
   agent's edit (`'C:\unused'` - an invalid `\u` escape, the whole file failed to transform). It was fixed by them a
   few minutes later; it is valid now. I had briefly put my new test in that file, and moved it to its own
   `tests/integration/calendar-health.test.ts` to avoid fighting over the same file - which is where it belongs
   anyway. I removed only the block I had added; their block is untouched.

## Files touched

- `src/main/mcp/host.ts` (+1 import, +`mcpStatusToErrorCode`)
- `src/main/compose.ts` (import on line 98; the `onStatus` handler at line ~550)
- `src/main/mcp/host.test.ts` (+2 tests, +imports)
- `tests/integration/calendar-health.test.ts` (new, 3 tests)
- `tests/integration/app-boot.test.ts` (net zero: my block added then removed again - see point 4 above)

---

## Resumption pass (2026-09-27) - re-verified after the session hit its usage limit

The work above had already landed on disk when the session was interrupted. This pass re-verified it against the
current tree (other repair agents have moved on since; `compose.ts:550` is now `compose.ts:584`) and changed no
product code.

### Red-before-green re-proven, not just asserted

Rather than trust the earlier write-up, I temporarily reverted the handler in place to the original
`healthHub.setCalendar({ state: s })` and re-ran `tests/integration/calendar-health.test.ts`:

| | Result |
|---|---|
| With the handler reverted | **2 failed, 1 passed** - `expected undefined to be 'CAL_RECONNECT'` and `expected undefined to be 'CAL_UNAVAILABLE'`; the third (the `not_configured` negative control) passed, as it should |
| Fix restored (byte-identical, from a scratchpad copy) | 3 passed |

So the tests fail for the stated reason and pass for the stated reason, and the negative control is not tautological.

### Verification run (current tree)

| Command | Result |
|---|---|
| `npx vitest run tests/integration/calendar-health.test.ts src/main/mcp/host.test.ts` | 63 passed |
| `npx vitest run tests/integration src/main/mcp src/main/health src/renderer/src/components/HealthPill.test.tsx src/renderer/src/store/health.test.ts src/shared/health.test.ts` | 21 files, **259 passed**, 0 failed |
| `npx eslint` + `npx prettier --check` on the four touched files | clean (exit 0) |
| `npx tsc --noEmit -p tsconfig.node.json` | clean |
| `npx tsc --noEmit -p tsconfig.web.json` | clean |

The residual `CAL_PORT_BUSY` gap is unchanged and still open: `src/shared/errors.ts:111` is still
`CAL_PORT_BUSY: 'none'`. The REQUEST above still stands.

### Red things that are NOT mine (current tree, reported not touched)

`npm run lint` and the `tsconfig.tests.json` leg of `npm run typecheck` are **red**, entirely on files I did not
touch. `src/main/agent/sanitize.test.ts` is syntactically broken on disk right now
(`TS1161: Unterminated regular expression literal` at line 51, and the matching eslint parse error), and
`src/main/agent/sanitize.ts` has two unused-const errors (`LINE_SEPARATOR_RE`, `DECIMAL_DIGIT_RE`). Both files were
modified at 10:17 today, i.e. **while this pass was running** - this is another agent's live in-flight edit, not a
regression from my change. There is also one pre-existing warning: an unused eslint-disable directive at
`src/main/bridge/ingest.ts:404`.

The three items the earlier pass reported as other agents' red (`ItemCard.tsx` / `ItemCard.test.tsx`,
`contextBuilder.test.ts`, `chats.test.ts:290`) are all **fixed** in the current tree - they no longer appear.
