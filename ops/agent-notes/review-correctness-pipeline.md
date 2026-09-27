# Adversarial code review — lens `correctness-pipeline`

Agent label: `review-correctness-pipeline`. Phase 3, read-only review. **No product file was edited.**

Scope reviewed: `src/main/bridge/{ingest,timestamps,bridgeDb}.ts`, `src/main/agent/{stage0,queue,orchestrator,extract,resolve,draft,validate,items,contextBuilder,minimize,replyLang,dateTable}.ts`,
`src/shared/{when,state,types,schemas}.ts`, `src/main/db/repos/{items,chats,queue,actions}.ts`, plus the consumers that pin the behaviour
(`src/main/exec/{actionExecutor,outcome,reconcile}.ts`, `src/main/compose.ts`) and the existing tests next to each.

## How to run the proofs

Nine scratch tests reproduce eight of the nine findings. They live **outside `tests/`** as required:

```
ops/agent-notes/review-correctness-pipeline.scratch/findings.test.ts
ops/agent-notes/review-correctness-pipeline.scratch/vitest.scratch.config.ts
```

```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH
cd "C:\dev\whatsapp agent"
npx vitest run --config "ops/agent-notes/review-correctness-pipeline.scratch/vitest.scratch.config.ts"
```

All 9 pass. **Every `expect` asserts the CURRENT (buggy) behaviour**, with a comment saying what it should be — so they are
characterisation tests of the defect, not red tests. Converting each to a red test is a one-line flip of the annotated assertion.
No test under `tests/` or `src/**/*.test.ts` was touched, added or weakened; the existing suite was not re-run (nothing was changed).

---

## correctness-pipeline-1 — `Ingest.contextFor()` returns an empty window for every LID-migrated chat — **blocker**

`src/main/bridge/ingest.ts:400-406`

```ts
return bridgeDb
  .lastMessages(chat.jid, want * 2)
```

`handleChat` (ingest.ts:277-287) resolves an `@lid` chat to its phone JID through `bridgeDb.phoneJidForLid()` and re-keys the
app-db chat row (`chats.mergeLidInto` / `upsertFromBridge(effectiveJid, …)`). The **bridge's `messages` rows keep the `@lid`
`chat_jid`** — that is exactly the "unresolved residue" case `src/shared/types.ts:198-200` describes. `contextFor` then asks
`lastMessages()` for the *phone* JID and gets nothing back.

Failure scenario (proof: `correctness-pipeline-1` in the scratch file):
1. Contact writes from a chat the bridge could not resolve; `messages.chat_jid = '55500001@lid'`, `whatsmeow_lid_map` has the phone number.
2. `scanNow()` creates the app chat under `972550000001@s.whatsapp.net` **and an open item** (so a triage run is scheduled).
3. `orchestrator.runChat` calls `ingest.contextFor(chatId, 12)` → `[]`.
4. S1 EXTRACT runs against an **empty data block**, `repos.items.snapshotMessages(item.id, [])` wipes the card's message list,
   and the card shows `trigger.text = null`. The model still returns an `Extraction`, so the item ends as a `done` card built
   from no evidence at all — `needsReply` and a draft are possible.

Same root cause, second site: `src/main/exec/reconcile.ts:95-101` (`findOutboundMatch(bridgeDb, chat.jid, …)`) can never match the
outbound row of such a chat, so an `unknown_outcome` send is never reconciled and the card keeps offering "Send again" for a
message that was already delivered.

Fix: resolve the *bridge-side* JID for a chat instead of assuming it equals `chats.jid` — keep the `@lid` alias (e.g. a
`chats.bridge_jid` column, or `phoneJidForLid` run in reverse) and read/reconcile over both forms, the way
`handleChat` already ORs `userHasSentIn` over both.

---

## correctness-pipeline-2 — `runOne` deletes a queue row that was re-armed during the run — **major**

`src/main/agent/queue.ts:80`

```ts
await deps.runChat(chatId, ac.signal);
repos.queue.remove(chatId);
```

The `triage_queue` row stays in place for the whole run, and `enqueue()` on an existing row only moves `due_at`. So anything
that re-queues the chat while `runChat` is awaiting the provider is erased by this unconditional `remove()`.

Failure scenario A — a lost message (proof: `correctness-pipeline-2`):
1. `t0` message A → item created, `queue.enqueue` (due `t0+20 s`).
2. `t0+20 s` the worker starts `runChat`. `ingest.contextFor` snapshots the window **as it is now** — A only.
3. `t0+25 s` message B arrives. `ingest.handleInbound` (ingest.ts:203-258) finds the open item, sets `analysis='queued'`,
   overwrites `triggerMsgId/triggerTs` with B's, and calls `queue.enqueue` → `due_at = t0+60 s`.
4. `t0+40 s` the run finishes; `validateAndPersist` writes `analysis='done'`; `runOne` then removes the queue row.
5. B never gets a run. The card's trigger preview is B's text (ingest wrote it), but the draft and the extraction answer A.
   Nothing re-arms the chat until a *third* message arrives.

Failure scenario B — "Analyse again" silently does nothing: `ItemService.retriage()` (`src/main/agent/items.ts:257-277`) sets
`analysis='queued'` and `queue.enqueue`s while a run is in flight; the same `remove()` drops it and `validateAndPersist`
overwrites `analysis` back to `done`. The user sees the old proposal and no error.

Fix: remember the queue row's identity (e.g. `first_enqueued_at` / a monotonic `revision`) when the run starts and make
`remove()` a compare-and-set that only deletes the row it dequeued; otherwise leave the re-armed row alone.

---

## correctness-pipeline-3 — the store-wipe watermark reset only fires when the new store is *smaller* — **major**

`src/main/bridge/ingest.ts:319-327`

```ts
const max = bridgeDb.maxRowid();
if (max < watermark) {
  // store wiped: rowids restarted. Reset; …
```

The store is only recognised as wiped when its current `MAX(rowid)` is below the stored watermark. A wipe followed by a WhatsApp
history re-sync routinely produces *more* rows than the app had seen, so the branch never runs and every row with
`rowid <= watermark` is skipped permanently (`rowsAfter` is `WHERE rowid > ?`).

Failure scenario (proof: `correctness-pipeline-3`): watermark `3`; the store folder is deleted (re-pair, antivirus, manual
cleanup) and the bridge re-syncs 5 rows. `maxRowid() = 5 > 3`, so rows 1-3 are never even read — including any message that
lands during the backfill before the row counter passes the stale watermark. In a real store the gap is the whole pre-wipe
history depth (thousands of rows), which on a fresh sync is the *newest* conversation.

`unlinkAndWipe` resets the watermark explicitly (`compose.ts:1289` area), so only the app-driven wipe is covered; an
external/bridge-driven one is not.

Fix: detect the identity of the store, not its size — e.g. persist the `(rowid, wa_msg_id)` of the last row scanned and reset
the watermark whenever that row is no longer present (or no longer carries that id).

---

## correctness-pipeline-4 — the 120 s "syncing" window permanently swallows anything older than 24 h — **major**

`src/main/bridge/ingest.ts:142` together with `src/main/compose.ts:890`

```ts
// ingest.ts
if (bridgeSyncing() || !bridgeOnlineOnce()) return age > LIMITS.syncMaxAgeMs ? 'context' : 'live';
return age <= LIMITS.ingestMaxAgeMs ? 'live' : 'older';
```
```ts
// compose.ts
if (s === 'starting') syncingUntil = at + SYNCING_WINDOW_MS;   // 120 s, armed on EVERY app start
```

`syncing` is armed on every bridge `starting` transition — i.e. on every ordinary app launch, not only on a genuine history
re-sync — and `compose.ts` pokes ingest immediately on `online`, so the **first scan of every session runs with
`syncing === true`** unless the `history_sync_done` marker happens to arrive first. Inside that window the age cap is
`syncMaxAgeMs` (24 h) and anything older is `context` — no item, no card. The row is then behind the watermark, so the later
non-syncing scans can never reconsider it.

This defeats the case `src/shared/types.ts:159-161` was written for: *"live-trigger age cap 24 h -> 7 d (laptop closed over a weekend)"*.

Failure scenario (proof: `correctness-pipeline-4`, two tests): a message received 48 h ago, never seen by the app.
- scanned inside the sync window → `isLive === false`, **no item at all**, watermark advances past it;
- scanned outside it → `isLive === true`, a normal queued item (48 h < `ingestMaxAgeMs`).

Same row, opposite outcome, decided purely by whether the scan happened within 120 s of the bridge spawning.

Fix: distinguish "the bridge is replaying history WhatsApp already delivered before" from "the app was simply not running".
The sync cap should apply to rows the app has already had a chance to see (`ts < last_online_ts`), not to the whole 24 h+ tail.

---

## correctness-pipeline-5 — "answered elsewhere" leaves the drafted reply approvable — **major**

`src/main/bridge/ingest.ts:186-196`

```ts
const eventPending = item.eventState === 'proposed' || item.eventState === 'incomplete';
repos.items.update(item.id, eventPending ? { replyState: 'answered_elsewhere' } : { … }, now);
if (!eventPending) repos.actions.supersedePending(item.id, now);
```

When an event proposal is still open, the pending `send_reply` is **not** superseded. `items.ts:111-137` (`actionViewsFor`)
filters only on `proposalId === currentProposalId` and `VISIBLE_ACTION_STATES`, and `actionExecutor.approve`
(`src/main/exec/actionExecutor.ts:346-400`) checks the *action* row, the chat's sendability and the bridge — never
`items.reply_state`. So the card keeps a live Send control.

Failure scenario (proof: `correctness-pipeline-5`): contact asks "meet Tuesday 17:00?"; the run drafts a reply **and** proposes
the event. The user answers from their phone ("yes, see you then"). Ingest sets `replyState='answered_elsewhere'`, but the
drafted "Sure, Tuesday 17:00 works." stays `pending`. The user comes to the card to click "Add to calendar", clicks Send too (or
clicks it first), and the contact receives a **second, duplicate answer** from the app.

Approval-first is not violated (the user did click), but the app offers an action it knows is obsolete.

Fix: supersede the pending `send_reply` in both branches — only the `create_event` action needs to survive
`answered_elsewhere` — or add a `replyState` guard to `approve()` / `actionViewsFor`.

---

## correctness-pipeline-6 — S4 persists a stale `item` snapshot and resurrects a dismissed card — **major**

`src/main/agent/validate.ts:162-172` (`item` comes from `orchestrator.ts:84`, read **before** the provider call)

```ts
const eventState: EventState = item.eventState === 'created' ? 'created' : EVENT_STATE_OF[slot.state];
const closedReason = item.closedReason ?? closureFor(extraction, slot);
const replyState: ReplyState = STICKY_REPLY_STATES.has(item.replyState) ? item.replyState : …
```

`item` is the row as it looked before S1; a cloud draft turn alone may take up to `LIMITS.draftWallClockCloudMs` (60 s) and a
local one 240 s. Anything the user or `exec/**` does to the row in that window is read from the stale object and then written
back by `repos.items.update` — and `updateItemRow` clears `closed_at` whenever `closedReason` is `null`
(`src/main/db/repos/items.ts:35`), so the row genuinely re-opens.

Failure scenario (proof: `correctness-pipeline-6`): the user hits **Dismiss** while the run is awaiting the model.
`items.dismiss` supersedes the pending actions and sets `closed_reason='dismissed'` (state `ignored`). The run finishes;
`validateAndPersist` writes `closedReason = null` (the stale snapshot had none, `closureFor` returns null because
`needsReply` is true), the item is `needs_reply` again, and a **fresh pending `send_reply` is inserted**. The card the user
explicitly dismissed is back on the dashboard with an approvable draft.

The same staleness applies to `item.badges` (validate.ts:157), `item.eventState` and `item.replyState`: an `exec` outcome that lands
mid-run (`applySendSuccess` / `applyCreateSuccess`, `src/main/exec/outcome.ts`) is read back as its pre-run value.

Fix: re-read the item inside the `repos.db.transaction` in `validateAndPersist` and merge against the *current* row (and bail
out when it closed or its `eventState` became `created` while the run was in flight).

---

## correctness-pipeline-7 — non-error deferrals inflate the retry backoff counter — **minor**

`src/main/db/repos/queue.ts:44`

```ts
defer(chatId, dueAt, lastError) {
  db.prepare(`UPDATE triage_queue SET due_at = ?, attempts = attempts + 1, last_error = ? WHERE chat_id = ?`)
```

`attempts` is the input to `backoffFor()` (`src/main/agent/queue.ts:71`, `RETRY_BACKOFF_MS = [1 min, 5 min, 30 min]`), but
`defer()` is also the edit-lock/rate-window deferral path and bumps the counter there:
- `src/main/agent/queue.ts:113` — the worker defers an edit-locked chat;
- `src/main/bridge/ingest.ts:255-257` — `enqueue()` immediately followed by `defer(chat.id, verdict.until)` for a Stage-0
  `deferred` verdict, so a **brand-new** queue row starts at `attempts = 1`.

Failure scenario: the user opens the card and types in it twice, and the chat hits a Stage-0 rate window once → `attempts = 3`.
The next genuinely retryable provider failure (rate-limited / overloaded) backs off **30 minutes instead of 1 minute**, and the
card sits at `analysis='queued'` — invisible on the dashboard, because `isListed('queued')` is false — for half an hour.

Fix: only increment `attempts` when `lastError` is an `ErrorCode`, or give the deferral path its own method.

---

## correctness-pipeline-8 — a slot inside the Asia/Jerusalem spring-forward gap can be proposed but never approved — **minor**

`src/shared/when.ts:312-326` (`localToEpochMs` maps every wall time in the gap to the transition instant) meeting
`src/main/exec/actionExecutor.ts:168-176` (`eventSanity`).

Failure scenario (proof: `correctness-pipeline-8`, verified against `Intl` — Israel DST starts 2026-03-27, 02:00 → 03:00):
- `resolveWhen` produces `startLocal = 2026-03-27T02:00:00`, `endLocal = 2026-03-27T02:30:00` (wall-clock `addMinutes`, which is
  correct by design). Neither wall time exists.
- `eventSanity` resolves both to the same instant → `minutes = 0 < LIMITS.eventMinMin` → `EVENT_INVALID`.
- S4 proposed the action, the card renders "Add to calendar", and every click returns `EVENT_INVALID` with no explanation. The
  action is never superseded, so the dead button stays.
- Related, same night: an event starting at `02:30` for 60 min resolves to a **30-minute** span (second test), i.e. the
  free/busy conflict check and the duration the user sees disagree with the instant Google will be given.

Fix: have `resolveWhen` flag a start/end that `localToEpochMs` cannot round-trip (`epochMsToLocal(localToEpochMs(x)) !== x`)
as a `WhenProblem`, so the slot degrades to `info_missing` instead of producing an un-approvable action.

---

## correctness-pipeline-9 — an own message hides an inbound trigger in the same ingest batch — **minor**

`src/main/bridge/ingest.ts:74-76` and `277-282`

```ts
function isNeverTrigger(m: Message): boolean {
  return m.mediaType === 'reaction' || m.deleted || m.text.trim() === '';
}
…
let newest: Message | null = null;
for (const m of msgs) if (!isNeverTrigger(m)) newest = m;
if (newest === null) return;
if (newest.fromMe) handleOutbound(chat, newest, now, touched);
```

Ingest's `isNeverTrigger` does **not** exclude `fromMe`, while Stage 0's `isNeverTriggerRow`
(`src/main/agent/stage0.ts:58-61`) does. "The newest trigger-eligible row decides" therefore lets an own message win, and
`handleOutbound` returns immediately when `repos.items.openForChat` is `null`.

Failure scenario: the contact writes "can we meet Tuesday?" and the user taps a quick "one sec" on their phone five seconds
later. Both rows land in the same 250 ms-debounced scan. `newest` is the outbound row, `handleOutbound` finds no open item and
returns — **no item is ever created for the scheduling request**, and no later scan revisits it. (Ingest also only calls
`chats.touch({lastOutboundTs})` for the batch's newest row, so intermediate outbound rows never update the chat.)

If "the user is already handling it" is the intended semantic, it should be recorded (a closed item with
`closedReason='answered_elsewhere'`), not left as no row at all.

---

## Checked and found correct (no finding)

- `parseBridgeTs` (`bridge/timestamps.ts`): the rowid/epoch/`go-sqlite3` text forms, 1-9 fractional digits truncated not
  rounded, leap-second clamp, `Date.UTC` roll-over rejection (`2026-02-31`), zone-offset sign. No off-by-one.
- The rowid watermark itself: `rowsAfter` is `rowid > ?`, the watermark is `batchMax`, and it is written in the **same**
  `repos.db.transaction` as the item/queue writes (`ingest.ts:296-308`). Correct; the only defect is the reset condition (#3).
- The debounce arithmetic `min(now + 20 s, first_enqueued_at + 60 s)` (`src/main/db/repos/queue.ts:20-34`) — the cap is honoured and a
  chatty chat is still triaged within a minute. Only `attempts` (#7) is wrong.
- `buildDayTable` / `renderDayRows`: day arithmetic is done on a pseudo-UTC epoch derived from `todayIn(tz)`, so it is
  DST-free; the two `offset` formulas in `agent/dateTable.ts` and `agent/contextBuilder.ts` agree. (`renderDayTable` in
  `dateTable.ts` is dead — only its own test imports it — but that is not a correctness defect.)
- The ambiguous-hour rule matches `docs/specs/agent-pipeline.md:263` exactly, including the deliberate choice to record
  `hour_assumed_*` from the **resolved** hour so the amber badge survives a model that already applied PM.
- Hebrew weekday/relative-date resolution (`resolveWhen`, `src/shared/when.ts:215-219`): `(((weekday - isoWeekday(anchor)) % 7) + 7) % 7`
  is the correct non-negative modulus, `weekOffset` and `daysFromToday` are schema-bounded (0-2, 0-60).
- `localToEpochMs` fall-back (autumn) ambiguity: `Math.min(...valid)` correctly picks the first occurrence.
- `deriveState` is the single writer of `items.state` and every mutation goes through `updateItemRow`; `mergeLidInto`
  correctly defers while an `approved`/`executing` action exists and resolves the `ux_items_open` collision by superseding the
  older trigger.
- `minimize` / `contextBuilder` snapshot zip: `nonEmpty.slice(nonEmpty.length - minimized.length)` lines up because
  `minimize` only ever drops from the oldest end.
- `LIMITS.draftToolCalls` is enforced (in `toolGate.ts:223`, not in `draft.ts`) — the doc comment on `runDraft` is accurate.
