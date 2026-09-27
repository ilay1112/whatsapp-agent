# fix-src-main-exec — repair notes

Scope: the confirmed finding **data-integrity-6** in `src/main/exec`. One finding, fixed.

## data-integrity-6 — torn success: `markDone` + item consequence + `action_done` audit were three transactions — FIXED

### What I confirmed before touching anything

The reviewer's and the skeptic's read of the code is correct. Re-verified by reading, not by trusting the write-up:

- `actionExecutor.ts` `runSend` and `runCreate` each issued three independent auto-committed statements:
  `repos.actions.markDone` → `applySendSuccess` / `applyCreateSuccess` (a `repos.items.update`) → `repos.audit.append('action_done')`.
  `reconcile.ts` `reconcileSend` and `reconcileCreate` repeated the same ungrouped triple with `action_reconciled`.
- Nothing downstream repairs a half-applied success: `recoverOnStartup` scans `state='executing'`, `reconcileUnknown`
  scans `state='unknown_outcome'`, `offerRetryForUnknown` scans `state='unknown_outcome'`. A row that reached `done`
  is invisible to all three, and the DB triggers in `migrations.ts` only police the *actions* state machine — nothing
  propagates a terminal action onto its item row.
- The contrast the skeptic cites is real: `db/repos/actions.ts markApprovedExecuting` and `agent/validate.ts`
  `validateAndPersist` both already wrap their multi-row writes in one `repos.db.transaction`, so the omission on the
  success path was an oversight, not a deliberate asymmetry.

I agree with the skeptic's two corrections. Invariant **I1 is not broken** — the duplicate still needs its own approval
click and its own approval record. What is actually lost is the item consequence, the closure and the audit row, after
which the user is offered a duplicate they cannot recognise as one. That dents **I7** ("never duplicates a side effect")
without breaching I1, which is why `minor` is the right band.

### The fix

The reviewer's proposed fix (one `repos.db.transaction` around all four sites) is the right one, and I implemented it
with one deviation, described below.

**`src/main/exec/actionExecutor.ts`**

- New helper next to the existing `auditedTransition`:
  ```ts
  const auditedSuccess = (ref: ActionId, fn: () => void): void =>
    auditedTransition(ref, () => deps.repos.db.transaction(fn));
  ```
- `runSend` (was lines 271–276) and `runCreate` (was 297–302) now run `markDone` + the `apply*Success` + the
  `action_done` append inside that one call.

**Deviation from the proposal — the `db_recovery` audit must stay outside the transaction.**
`auditedTransition` exists so a lost compare-and-set on a final-state transition is audited as `db_recovery` and then
rethrown (asserted by `actionExecutor.test.ts` "audits db_recovery and rethrows when a final-state transition loses its
compare-and-set"). If the `try/catch` had gone *inside* the transaction, the `db_recovery` row would be rolled back with
everything else and that audit trail would silently vanish. Composing the two the other way round — transaction inside
the audit guard — keeps the rollback and keeps the forensic row. Side benefit: a throw from `items.update` or from the
audit append is now audited as `db_recovery` too, which it previously was not.

**`src/main/exec/reconcile.ts`**

- `reconcileCreate` (was :86–89) and `reconcileSend` (was :104–108) wrap their `markDone` + `apply*Success` +
  `action_reconciled` append in `deps.repos.db.transaction`. No audit-guard wrapper here because `reconcile.ts` never
  had one; behaviour on a throw is unchanged (it still propagates out of `reconcileUnknown`).

All four sites sit past every `await`, so nothing async was pulled inside a synchronous SQLite transaction.

### After the fix, a torn success is recoverable

The rollback returns the action to `executing`, which is exactly the state `recoverOnStartup()` scans: the next start
turns it into `unknown_outcome`, `reconcileUnknown` looks for the evidence read-only, and `offerRetryForUnknown` offers
the clone. The previously unreachable state is now back on the recovery path.

### Tests (written red first, in the existing suites)

`src/main/exec/actionExecutor.test.ts` — new `describe('success atomicity')`, 4 tests:
- send_reply: a throwing `items.update` rolls `markDone` back; action is `executing` (and appears in
  `repos.actions.executing()`), `replyState` unchanged, audit `['action_approved','db_recovery']`.
- create_event: the same twin.
- a throwing `action_done` audit append rolls the whole success back too.
- control: the happy path still commits all three writes.

`src/main/exec/reconcile.test.ts` — new `describe('reconcileUnknown: atomicity')`, 2 tests: send_reply and create_event
each leave the action `unknown_outcome` with no `action_reconciled` row when the item consequence throws.

Red before the fix (5 of 6 failing with `expected 'done' to be 'executing' / 'unknown_outcome'`; the control passed),
all 6 green after. These are real-DB tests (`openDb(MEMORY_DB)` + `createRepos`) with only `items.update` / `audit.append`
doctored, following the style of the existing "defensive paths" tests.

### Verification

- `npx vitest run src/main/exec tests/security/crash-recovery.test.ts tests/security/approval-binding.test.ts`
  → **9 files, 195 tests, all passing.**
- `eslint` over the four touched files with `--max-warnings 0` → clean.
- `tsc -p tsconfig.tests.json` / `tsconfig.node.json` → no errors in `src/main/exec`.
- `prettier --write` over the four touched files.

### Caveat for the orchestrator: the worktree was being edited concurrently

While I worked, other repair agents were writing to the same checkout. Observed directly:
`src/main/exec/buildCreateEventArgs.ts` changed at 17:59:58 and its test at 18:00:39 (mid-edit: `eventIdFor` briefly took
a different argument shape, breaking 4 exec tests that had passed minutes earlier and passed again afterwards), and
`src/main/proc/supervisor.ts` at 18:00:47 (`ReferenceError: taskkillVeto is not defined` at runtime plus a `tsc` error
about a missing `Entry.startedAt`). A full `--project main --project security --project integration` run therefore showed
a *shifting* set of 16–25 failures in `proc/supervisor`, `db/repos/*`, `db/retention`, `mcp/host`, `llm/local`,
`tests/integration/*` and `tests/security/redaction` — **none of them in a file I touched**, and none of them mine.
I did not touch, fix or work around any of them. A clean full-suite verdict has to be taken once the other agents finish.

### Not changed on purpose

`markFailure` and `markUnknown` still use plain `auditedTransition` (four ungrouped writes each: the state transition,
the audit row, `applyFailure` and the retry clone). The same tearing argument applies to them in principle — a kill
between `markFailed` and `cloneForRetry` leaves a failed action with no "try again" offer — but that is a *different*
defect, it was not raised or confirmed, and the consequence is a missing offer rather than a duplicate one. Smallest
surface wins; flagging it here so a reviewer can decide whether to raise it separately.

---

## Resumption pass (session continued after a usage-limit interruption)

The fix above was already fully applied when I resumed. I re-verified it from scratch rather than trusting the
write-up, and added one piece of evidence that was missing.

### Re-verified, first hand

- All four sites still carry the fix: `db.transaction` appears once in `actionExecutor.ts` (the `auditedSuccess`
  helper at :232-233, used by `runSend` :284 and `runCreate` :314) and twice in `reconcile.ts` (:89 `reconcileCreate`,
  :112 `reconcileSend`).
- `npx vitest run src/main/exec tests/security/crash-recovery.test.ts tests/security/approval-binding.test.ts`
  -> **9 files, 195 tests, all green.**
- `npx eslint` over the four touched files with `--max-warnings 0` -> clean.
- `tsc --noEmit -p tsconfig.node.json` and `-p tsconfig.tests.json` -> **zero errors naming `src/main/exec`.**
- Confirmed `db.transaction` really is BEGIN IMMEDIATE / COMMIT / ROLLBACK-and-rethrow with nested calls joining the
  outer transaction (`src/main/db/index.ts:164`, covered by `db/index.test.ts:100`), so the rollback the fix depends on
  is a tested property, not an assumption.

### New: a positive control for the regression guards

The prior pass recorded "red before the fix" but left no reproducible artifact. I wanted to disable the transaction
temporarily to re-observe the red, but that edit was **blocked by the permission system as a security-test removal** -
a correct call, since it amounts to weakening a safety guard in product code. I did not pursue it by any other route,
and I verified both product files were byte-identical to their pre-attempt backups afterwards.

Instead I proved the same thing without touching product code, in
`ops/agent-notes/fix-src-main-exec.scratch/atomicity-control.test.ts` (own `vitest.scratch.config.ts`, 2/2 green):

- **CASE A** replays the OLD ungrouped shape against the real DB: `markDone` then a throwing consequence leaves
  `state='done'`, `actions.executing()` empty - the torn row no recovery pass can see. The defect, reproduced.
- **CASE B** replays the NEW shape: the same two statements inside `repos.db.transaction` roll back to
  `state='executing'` with the action back in `actions.executing()`.

Same inputs, same repos, one difference - the transaction. That is exactly the assertion the suite tests make, so they
are genuine regression guards and not tautologies.

The scratch dir is inert: `ops/**` is eslint-ignored, and no vitest project or tsconfig includes it, so it adds no
lint, typecheck or `npm test` surface. Delete it freely.

### Cross-agent breakage still present - NONE of it mine

`npm run lint` and `npm run typecheck` are **red repo-wide**, and `--project main --project security` reports
**7 failed / 3215 passed**. Every failure is outside `src/main/exec`:

- `src/main/agent/prompt.purity.test.ts` (2) - `buildContext` now requires a `slot`; the test still omits it.
- `src/main/agent/queue.test.ts` (1) - re-armed queue row dropped.
- `src/main/compose.breaker.test.ts` (1) + a `tsc` `ExitCb` mismatch.
- `src/main/db/migrations.test.ts` (1) and `src/main/db/repos/actions.test.ts` (2) - all about the `retry_of` /
  `trg_actions_frozen` hatch.
- `src/main/agent/sanitize.ts` - two unused regex consts. (Its `sanitize.test.ts` parse error, raw U+2028/U+2029 inside
  a regex literal, was still present at 10:14 and had been fixed by another agent by 10:21.)
- `src/renderer/src/components/ItemCard.test.tsx` - several `tsc` errors.

This is concurrent editing, not regression, and I can date it precisely: during my 10:22-10:23 test run,
`src/main/db/migrations.ts` was rewritten at **10:23:02** and `src/main/compose.ts` at **10:22:37**, while
`src/main/exec/actionExecutor.ts` and `reconcile.ts` have not changed since **09-23 18:02**. Two consecutive identical
runs also reported *different* failure sets (3 files, then 5), which only a moving worktree explains.

I did not touch, fix or work around any of them. **A clean repo-wide verdict still has to be taken once the other
agents finish** - my scope is green in isolation.
