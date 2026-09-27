# fix-src-shared-when.ts (resolveWhen) - phase 3 repair notes

Label: `fix-src-shared-when.ts (resolveWhen` (file name fixed by the task assignment).
Scope: one confirmed finding, `correctness-pipeline-8` [minor], `src/shared/when.ts:312` / `resolveWhen`.

## Finding (restated)

`resolveWhen` builds `endLocal` with wall-clock `addMinutes` and never asks whether the wall times it produced exist.
Inside a DST spring-forward gap (Asia/Jerusalem 2026-03-27, 02:00 IST -> 03:00 IDT) the wall times 02:00..02:59 do not
happen. `localToEpochMs` deliberately collapses all of them onto the transition instant (documented behaviour, covered by
`src/shared/when.test.ts` "spring gap 2026-03-27"). So a slot like 02:00-02:30 came out of S2 as `complete`, was inserted
by `validate.ts` as a pending `create_event`, and `eventSanity` (`src/main/exec/actionExecutor.ts`) then computed
`minutes = 0 < LIMITS.eventMinMin` and returned `EVENT_INVALID` - an action that can never be approved.

The reviewer and the skeptic agree on the mechanism. The skeptic's refutation of the *consequences* holds and I confirmed
it while working: `ItemCard` disables the approve control via `validateFields` (which mirrors `eventSanity`), so the user
saw a disabled, error-labelled, editable card rather than a button failing on every click. That is why this stays minor -
but the slot is still mis-classified as `complete` when it should degrade to info_missing, and that is what I fixed.

## Tests first (both red before the fix)

`src/shared/when.test.ts`, new describe `resolveWhen - wall times swallowed by a DST spring-forward gap`:

1. start inside the gap (02:00 + 30 min) -> `startLocal`/`endLocal` empty, `missing` contains `time`, not `date`.
2. end inside the gap (01:30 + 60 min, real start, unreal end) -> same degrade.
3. control: 03:00 + 30 min on the same night, and the *ambiguous but real* autumn wall time 2026-10-25T01:30, are
   untouched (`missing: []`).

Red run before the fix: tests 1 and 2 failed with `expected '2026-03-27T02:00:00' to be ''` / `'2026-03-27T01:30:00'`;
test 3 passed from the start (it is the regression guard).

`src/main/agent/resolve.test.ts`, one added case in `resolveExtraction - sub-states`: the same gap extraction now yields
`state: 'incomplete'`, `missing` contains `time`, `event = { startLocal: '', endLocal: '', dateHint: '2026-03-27' }` -
i.e. the card goes to "Information missing" with the day pre-filled, which is the user-visible point of the fix.

## The fix (smallest surface: `src/shared/when.ts` only)

- new private helper `existsInZone(local, timeZone)` = `epochMsToLocal(localToEpochMs(local, tz), tz) === local`
  (the reviewer's round-trip test, expressed once).
- in `resolveWhen`, right after `startLocal`/`endLocal` are built: if either end does not exist in the zone, clear both
  and `missing.add('time')`.

## Where I deviated from the proposed fix, and why

The reviewer proposed a new `WhenProblem`. I did **not** add one:

- `WHEN_PROBLEMS` is frozen in `docs/specs/contracts.md` section 7 (verbatim, same five members). A repair ticket is not
  the place to widen a frozen enum, and nothing would consume the new member: `resolve.ts` only reads
  `when.problems.length === 0`, no i18n key or DB column carries a problem value.
- `missing: ['time']` already blocks completion (`BLOCKING_MISSING` in `resolve.ts`) and is the *precise* statement of
  what happened: the day is fine, the hour the model picked is not a real hour. A `problem` would also have forced
  `missing += 'date'` under the existing bookkeeping, which would wrongly throw away a perfectly good date.
- There is an exact precedent for "no problem, just missing time": the `ambiguousHour: 'ask'` branch a few lines above.

I also keep the invariant `time === '' <=> startLocal === ''` by clearing both ends, so no caller can see a
`missing: ['time']` result that still carries a start.

`localToEpochMs`'s gap behaviour itself is left alone on purpose: it is intentional, documented, and other callers
(e.g. the in_past comparison, `eventSanity`) rely on it being total.

## Verification

- `npx vitest run --project main src/shared/when.test.ts src/main/agent/resolve.test.ts` -> 103 passed.
- `npx vitest run --project integration tests/golden/golden.test.ts` -> 89 passed (every golden row's `expect.resolved`
  unchanged).
- coverage of `src/shared/when.ts` still 100% stmts / 100% branch / 100% funcs (the file is safety-critical: 100/95/100).
- `npx eslint` + `npx prettier --check` on the three touched files: clean.

### Pre-existing red, NOT caused by this change (reported, not touched)

A full `--project main renderer integration security` run at 17:58 showed 71 failures in 13 files. All of them come from
other repair agents editing the tree while I ran (file mtimes 17:58-18:01, my `when.ts` edit was 17:57):

- `src/main/compose.ts`: `ReferenceError: createSupervisedLlama is not defined` -> every harness-based integration test.
- `src/main/exec/buildCreateEventArgs.ts` `eventIdFor`: `Cannot read properties of undefined (reading 'title')` ->
  3 `actionExecutor.test.ts` create-outcome tests.
- `src/main/db/repos/actions.ts` (`insertPending`), `src/main/app/window.test.ts`, `src/main/mcp/host.test.ts`,
  `src/main/proc/supervisor.ts`, `src/main/ipc/handlers/data.test.ts`, `ItemCard.test.tsx` focus-guard, redaction purge.
- `npm run typecheck` reports exactly one error, `src/main/proc/supervisor.ts(558,30)` (missing `startedAt` on `Entry`) -
  also another agent's in-flight edit. Nothing in `src/shared/**` or `src/main/agent/**` fails to typecheck.

None of these touch `when.ts`, `resolve.ts` or anything downstream of my change; the suites that do cover it are green.

## Residual, out of scope (for the orchestrator to decide)

If the user *manually* types a gap wall time in the event editor, `validateFields` still rejects it with
`event.error.duration` - correct refusal, slightly misleading label ("duration" when the real cause is "that hour does not
exist tonight"). Closing that would mean a new i18n key plus a matching `eventSanity` reason code, i.e. a contract change
in `src/shared/errors.ts`; I left it alone. After this fix the agent itself never proposes such a slot, so the path is
only reachable by hand.

## Files touched

- `src/shared/when.ts` (helper + 6-line guard in `resolveWhen`)
- `src/shared/when.test.ts` (new describe, 3 cases)
- `src/main/agent/resolve.test.ts` (1 case)

## Re-verification after the session resumed (2026-09-27, 10:14-10:16)

The fix and both test files were already on disk from the earlier run; I re-ran everything rather than trust the
previous log, because other repair agents kept editing the tree in between.

- `npx vitest run --project main src/shared/when.test.ts src/main/agent/resolve.test.ts` -> **104 passed** (one more
  than the 103 logged above; another agent added a case to `resolve.test.ts` after my run - not mine, and green).
- `npx vitest run --project integration tests/golden/golden.test.ts` -> **89 passed**, unchanged.
- `npx eslint` + `npx prettier --check` on `src/shared/when.ts`, `src/shared/when.test.ts`,
  `src/main/agent/resolve.test.ts` -> clean.

### Still-red elsewhere, proven NOT mine

`npx vitest run --project main src/shared src/main/agent` -> 11 failed / 801 passed, in 5 files, none of them
`when.test.ts` or `resolve.test.ts`:

- `src/main/agent/sanitize.test.ts` - **parse error**, "Unterminated regular expression literal" at line 51. The same
  three errors are the *only* output of `npm run typecheck` now, and `npm run lint` additionally reports
  `LINE_SEPARATOR_RE` / `DECIMAL_DIGIT_RE` assigned-but-unused in `src/main/agent/sanitize.ts`. That file is mid-refactor
  by another agent. (The `src/main/proc/supervisor.ts(558,30)` typecheck error logged earlier is now gone - fixed by
  whoever owns it.)
- `src/main/agent/validate.test.ts` - 2 `scrubDraft` cases (homoglyph separator, non-ASCII decimal digits) that depend on
  the half-refactored `sanitize.ts`, plus 5 "item row can change while the run is in flight" concurrency cases.
- `src/main/agent/queue.test.ts`, `src/main/agent/items.test.ts`, `src/main/agent/prompt.purity.test.ts` - 1-2 cases each,
  all in the same concurrency / sanitize areas.

**Proof they are not caused by this change:** I temporarily deleted the 5-line gap guard from `resolveWhen`, re-ran
those four files, and got the *identical* `11 failed | 82 passed (93)`, then restored `when.ts` byte-for-byte
(prettier --check clean, 104/104 green again). The failure set is invariant under my change.

Nothing was deleted, skipped or weakened. Finding `correctness-pipeline-8` stays **fixed**.
