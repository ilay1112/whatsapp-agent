# Adversarial code review — lens "approval-first" (invariant I1)

Agent label: `review-approval-first`. Phase 3. Subject: the BUILT code under `src/`; docs were context only.
No product file was edited. Failing proofs live in `ops/agent-notes/review-approval-first.scratch/` (never under `tests/`).

## What I traced

Every path that can reach `BridgeSendClient.send*` or `McpWriteClient.createEvent`:

- `grep` over `src/**` (non-test) for `sendText` / `createEvent`: the only production callers are
  `exec/actionExecutor.ts:266` and `exec/actionExecutor.ts:290`. `compose.ts` is the only constructor of both clients
  (`compose.ts:854-855`) and hands them to nothing else. `exec/reconcile.ts` is read-only (it only *looks* for evidence).
- `ActionExecutor.approve` is called from exactly one place, `ipc/handlers/actions.ts:30`; `register.ts` does the
  trusted-sender check, the `.strictObject` zod parse and the ctx sampling before it.
- The LLM can reach only `toolGate.invoke`, whose name table is `READ_TOOL_NAMES = ['get_current_time','get_freebusy']`
  (`agent/toolDefs.ts:8`), and `McpHost.callerFor(cls)` re-asserts the tool class at run time. No LLM-reachable write.
- The write-ahead is a real CAS inside one transaction (`db/repos/actions.ts:120-139`) and the SQL triggers
  (`db/migrations.ts:89-112`) independently refuse `pending -> executing`, `executing` without `approved_final_json`,
  a return to `pending`, and any rewrite of `canonical_json` / `chat_id` / `kind` / `approved_final_json`.
- Crash recovery never re-executes: `executing -> unknown_outcome` (`actionExecutor.ts:453-464`), then read-only
  reconcile, then `offerRetryForUnknown()` inserts a fresh **pending** clone — a new approval, not a replay.
- Expiry, shown-hash (constant-time, `''` for a retention-nulled row), kind match, edit re-validation, sendable/online
  preconditions, event sanity, fresh free/busy, rate limits and the in-flight set are all in the documented order and all
  sit before the write-ahead.

I could not break I1 itself: I found no path that reaches a client without a committed `executing` row whose
`approved_final_json` records what the user approved. The three findings below are breaks in the *binding* between the
approval and its effect, not in the existence of an approval record.

## Findings

### approval-first-1 (major) — a retry clone re-sends the chain's event id, so an EDITED re-approval silently writes nothing

`exec/buildCreateEventArgs.ts:63` derives the client-supplied Google `eventId` from the retry **chain key** only
(`${itemId}:create_event:${proposalVersion}`, stripped of the `:rN` suffix) — never from the content the user approved.
`exec/actionExecutor.ts:295` then maps Google's 409 (`McpErrorKind 'id_exists'`) to **success**, and
`outcome.ts:applyCreateSuccess` stamps the *new* payload's `eventStartTs` on the item row.

That pairing is correct only while attempt N+1 carries the same content as the attempt that actually created the event.
It does not, whenever the user uses the event editor on the retry card — which is a first-class feature
(`applyEdit` merges `EventEditSchema` field by field, `actionExecutor.ts:156-164`).

Failure scenario (proven): create_event for 17:00–18:00 is approved; the MCP call times out after Google created the
event (`markUnknown` -> `unknown_outcome` + a pending clone). The user fixes the time to 19:00–20:00 on the retry card
and clicks "Add again". `chainRootOf` yields the same chain key, so the same `eventId` goes out, Google answers 409,
the executor returns `outcome: 'done'`, the card says "Added to calendar" and the item row says 19:00 — while the
calendar still holds 17:00. The user's second, explicit approval produced no calendar change and was reported as done.
Same shape after a `bad_response` / `unavailable` failure that nevertheless created the event.

Proof: `ops/agent-notes/review-approval-first.scratch/retry-eventid.node.test.ts` (fails;
`calendarStart` is `2026-09-24T17:00:00` where `2026-09-24T19:00:00` was approved).

Fix direction: mix the approved content into the deterministic id (e.g. `eventIdFor(chainKey + ':' + contentSha)`) so an
edited retry gets its own id, **or** on `id_exists` re-read the event (`read.findAppEvent`) and, when it does not match
the approved slot, fail the action with a code that tells the user the event already exists at the old time.
Do not silently report `done`.

### approval-first-2 (major) — "Add anyway" is an approval control that bypasses the renderer focus-steal guard

`renderer/src/store/health.ts:33` and the header of `renderer/src/components/ItemCard.tsx` both state the rule: *every*
approval control ignores click / Enter / Space for `LIMITS.focusGuardRendererMs` after the window gained focus or became
visible. `isActivationBlocked()` is consulted in exactly two places — `ItemCard.tsx:315` and `:324`, both inside
`approveHandlers`.

`ResultRowView` renders `ResultAction`s as a bare `<button ... onClick={a.run}>` (`ItemCard.tsx:552-555`), and the
`needs_confirm_conflict` row installs `result-add-anyway` whose `run` calls
`runApproveRef.current?.(action, { confirmConflict: true })` (`ItemCard.tsx:279-287`). That call performs the calendar
write over a conflict the app already flagged, with no `isActivationBlocked()` check and no `e.detail > 1` check.

Main does not cover this: `actionExecutor.ts:363` only guards windows opened by a **notification** click
(`ctx.shownByNotificationAt + LIMITS.focusGuardMainMs`), and `handlers/actions.ts:26` only requires the window to be
visible and focused — which a focus-stealing click makes true. So on Windows click-through activation (the window is
behind another app, the user clicks at the "Add anyway" position, the click both activates the window and lands on the
button) the event is created from a click the user aimed elsewhere. The primary Approve buttons are immune; this one is not.

Proof: `ops/agent-notes/review-approval-first.scratch/add-anyway-focusguard.dom.test.tsx` (fails; a second
`action:approve` is issued while the guard is armed).

Fix direction: route `ResultAction.run` through the same guarded handler (or have `ResultRowView` call
`isActivationBlocked()` / drop `e.detail > 1` before invoking `run`). Existing coverage only exercises `ApproveButton`
(`ItemCard.test.tsx:144-180`), which is why this slipped through.

### approval-first-3 (major) — a reply the user already sent by hand stays approvable when an event is pending

`bridge/ingest.ts:182-198` `handleOutbound`: when the user answers from their phone, the item gets
`replyState: 'answered_elsewhere'`, but pending actions are superseded **only** when no event is pending:

```ts
if (!eventPending) repos.actions.supersedePending(item.id, now);
```

The guard exists because `supersedePending(itemId)` is item-wide and would also kill the pending `create_event` — but a
per-kind variant already exists in the same repo (`actions.supersedePendingRepliesOfChat`), so the coarse API is the only
reason the reply survives.

On the ordinary card that carries both a drafted reply and a proposed event (`agent/validate.ts:217-244` inserts both
pending actions in one transaction), the `send_reply` action therefore stays `pending`. `agent/items.ts:113` still lists
it (its `proposalId` is the current one and `pending` is a visible state), `deriveState` still returns `needs_reply`
(`shared/state.ts:17`), so `ItemCard.tsx:784` renders the Send button — and `ActionExecutor.approve` has no
`replyState` / `closedReason` gate at all. One click sends a second, duplicate reply to a conversation the app has
already recorded as answered.

Proof: `ops/agent-notes/review-approval-first.scratch/answered-elsewhere.dom.test.tsx` (fails; `approve-send-1` is
rendered on an `answered_elsewhere` card).

Fix direction: in `handleOutbound`, supersede the item's pending `send_reply` actions unconditionally (kind-scoped) and
keep the `create_event` one; belt-and-braces, add a `replyState === 'answered_elsewhere'` refusal to the `send_reply`
branch of `approve`.

## Things I checked and did NOT report (no defect found)

- Two concurrent approvals of the same action: `inFlight` is set before the first `await` and the DB CAS is the second
  line of defence; the loser gets `ACTION_STALE` with no failure row, no clone, no audit.
- Superseded / expired / rejected rows: `markApprovedExecuting` requires `state='pending'`, and `trg_actions_state`
  aborts every forged transition.
- `execute()` (the internals entry point) refuses anything not already `executing`, before touching a client, and is not
  exported over IPC.
- Rate-limit check and record are in the same synchronous block as the write-ahead — no interleaving window.
- Retention nulls `canonical_json` only on terminal rows; `verifyShownHash` maps `''` to `false`, so such a row can never
  be approved again, and `offerRetryForUnknown` skips rows whose `approved_final_json` is gone rather than guessing.
- `buildSendArgs` re-derives the recipient from `actions.chat_id` and emits exactly two keys; `buildCreateEventArgs` /
  `createMcpWriteClient` build an exhaustive whitelist key by key (no spread).
- One marginal timing gap I judged not worth a finding: for `create_event`, expiry is checked before the
  `await freshBusy(...)` and not re-checked at the write-ahead, so an action can execute a few seconds past its TTL.
  `LIMITS.actionTtlMs` is 24 h and the free/busy read is bounded, so there is no realistic failure scenario.

## How to run the proofs

```
npx vitest run --config "ops/agent-notes/review-approval-first.scratch/vitest.scratch.config.ts"
```

All three tests are expected to FAIL today; each one is written to pass once the corresponding defect is fixed. Nothing
under `src/` or `tests/` was touched.
