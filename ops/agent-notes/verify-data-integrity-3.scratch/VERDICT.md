# data-integrity-3 — skeptic verdict: CONFIRMED, severity corrected major -> minor

Run: `npx vitest run --config ops/agent-notes/verify-data-integrity-3.scratch/vitest.scratch.config.ts`
Result: 5/5 pass (verify.test.ts A/B/C, verify2.test.ts D/E). No product file touched.

## Refutation attempts that FAILED (i.e. the bug survives them)
1. "S0 never queues an @lid chat." — False. `createStage0` (src/main/agent/stage0.ts) gates on
   policy/is_known/pause/provider/budgets/edit-lock only. Nothing looks at `chat.sendable` or the JID
   shape beyond `isNeverTriggerRow`, which accepts `DM_LID_JID_RE`. An @lid chat reaches `{kind:'queued'}`.
2. "`resolveLidChats()` is followed by a scan that re-enqueues." — False. compose.ts:887 does
   `resolveLidChats()` then `later.pokeIngest()`, but `runScan` only reads rows **after**
   `bridge_rowid_watermark`. The already-ingested trigger row is below it, so nothing re-enqueues.
3. "`recoverRunning()` rescues it." — False. items.ts:145 selects `analysis = 'running'` only.
4. "The user can click Analyse again." — False. The item is `analysis='queued'`, `isListed()` returns
   false for 'queued' (src/shared/state.ts), and `items.list()` filters `analysis IN ('done','held','failed')`,
   so no card is rendered to click. `chat:setPolicy` only releases `held/unknown_sender`.
5. "An existing test covers it." — chats.test.ts:88 asserts `repos.queue.size() === 0` after a merge, but
   that test's @lid item is `analysis='done'`, so dropping the row is correct there. No test covers a
   `queued` item.
6. "The DELETE is needed for the chats FK." — Not a refutation: `triage_queue.chat_id REFERENCES chats(id)`
   with no ON DELETE, so *something* must clear the @lid row, but merging it into the target's would too.

## What is real
`mergeLidInto` (src/main/db/repos/chats.ts:95-96) re-parents `items` and then
`DELETE FROM triage_queue WHERE chat_id = <lid>` with no upsert onto the target. Reached from
`ingest.resolveLidChats()` (ingest.ts:392), which performs **no** enqueue afterwards.

Asymmetry (test E): the other caller, `handleChat` (ingest.ts:268), merges and then falls through to
`handleInbound` -> `repos.queue.enqueue(chat.id)`, so the scan path re-arms the debounce.
**Only the `resolveLidChats()` path strands the item.**

Observed end state (test A): item `chat_id` = phone chat, `analysis='queued'`, `state='needs_reply'`,
`queue.size()===0`, `nextDue()===null`, `counts().analysing===1`, `list('needs_reply')===[]`,
`recoverRunning()===0`; `expireOld()` closes it `expired` after `openItemTtlMs`.

Test D: when the phone chat already holds an open item the @lid item is superseded but keeps
`analysis='queued'`, so `counts().analysing` stays 1 **forever** (`expireOld` skips closed items).

Test B (partial mitigation): if the target chat happens to already have its own `triage_queue` row,
that row survives and the moved item is picked up by the target's run.

## Why minor rather than major
- No I1-I7 invariant is touched: no send, no calendar write, no approval bypass.
- No data loss: the message stays in WhatsApp, the item row survives and closes with a recorded reason.
- No crash.
- Self-healing: the next inbound message in that DM hits `handleInbound`, updates the existing item to
  `analysis='queued'` and calls `queue.enqueue(target)` (ingest.ts:245-256).
- Trigger is a narrow race: an @lid chat row must exist (mapping absent at ingest time) AND a phone-JID
  chat row for the same contact AND a queued-not-yet-run item AND an ONLINE/pairing transition inside
  the 20 s debounce.
Residue is a possibly missed triage for one message plus a stuck "analysing" counter — a real defect,
but below "a requirement broken or a likely crash".

## Note on the proposed fix
The MIN(due_at)/MIN(first_enqueued_at)/MAX(attempts) upsert is correct and sufficient for the queue row.
It does not address the secondary leak test D exposes: a superseded item keeps `analysis='queued'` and
inflates `counts().analysing` permanently. Whoever repairs this should also clear `analysis` (to 'done'
or 'held') when `updateItemRow(..., {closedReason:'superseded'})` fires at chats.ts:92.
