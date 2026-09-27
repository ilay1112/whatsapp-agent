# fix-src-main-bridge — repair notes

Scope: the six confirmed findings against `src/main/bridge/**` (approval-first-3, correctness-pipeline-1, -4, -5,
process-lifecycle-4, process-lifecycle-8).

**Session note.** This run was resumed after a usage-limit interruption. Five of the six findings had already been
repaired in the interrupted run (production code + colocated tests, all present and green on re-verification below).
This session closed the sixth (process-lifecycle-8), removed a stale `eslint-disable` the earlier run left in
`ingest.ts`, and re-ran the surrounding suites. Each finding is documented below with the fix that is actually in the
tree, including where it deviates from the reviewer's proposal and why.

---

## 1. approval-first-3 + correctness-pipeline-5 (same defect) — FIXED

Two findings, one root cause: `handleOutbound` collapsed the spec's two separate consequences into one
`if (!eventPending)` guard, so a card carrying both a pending `send_reply` and a pending `create_event` kept an
approvable draft after the user answered from their phone.

Spec basis is verbatim and unconditional on the supersede: `docs/ARCHITECTURE.md:182`, `docs/specs/agent-pipeline.md:62`
and `:384` — *"reply_state='answered_elsewhere', pending send_reply superseded; the item closes unless an event
approval is still pending"*. Only the **closure** is conditional.

### Fix (two layers)

**Ingest (the mandated fix)** — `src/main/bridge/ingest.ts:205-209`:

```ts
if (eventPending) repos.actions.supersedePendingOfKind(item.id, 'send_reply', now);
else repos.actions.supersedePending(item.id, now);
```

**The reviewer's proposal to reuse `supersedePendingRepliesOfChat` is wrong**, exactly as the skeptic said: that
statement is `... WHERE chat_id = ? AND item_id <> ? AND kind = 'send_reply' AND state = 'pending'`
(`src/main/db/repos/actions.ts:111-119`), so passing this item as `exceptItemId` would skip the one row that must be
superseded. A new kind-scoped helper `supersedePendingOfKind(itemId, kind, now)` was added instead
(`src/main/db/repos/actions.ts`, declared in `src/main/db/index.ts:284`). `supersedePending` (item-wide) stays in the
non-event branch, where superseding everything is correct.

**Executor (defence in depth)** — `src/main/exec/actionExecutor.ts:403-406`, in the `send_reply` branch of `approve()`:

```ts
const owner = deps.repos.items.byId(a.itemId);
if (owner !== null && owner.replyState === 'answered_elsewhere') return fail('ACTION_STALE');
```

The executor never loaded the item before, so it had no way to refuse a stale approve that raced the ingest scan.
`ACTION_STALE` (not a new code) because the renderer already has copy and handling for it, and the action genuinely is
stale.

### Tests

- `src/main/bridge/ingest.test.ts:816` *"supersedes the pending send_reply of an item whose event approval is still
  pending"* — asserts `reply.state === 'superseded'` AND `event.state === 'pending'` AND `item.state === 'needs_reply'`.
  The pre-existing test at `:791` ("keeps an item with a pending event approval open") asserted only item fields and
  therefore pinned the bug; it is kept unchanged because its own assertions are still correct, and the new test covers
  the action states it never looked at.
- `src/main/db/repos/actions.test.ts:437` — `supersedePendingOfKind` supersedes one kind and spares the other, and is
  idempotent.
- `src/main/exec/actionExecutor.test.ts:495` — approve refused on an `answered_elsewhere` item.

### Not done, and deliberately

`docs/proposals/ux.md:108` also asks for the draft collapsed and a "you already answered from your phone" chip on the
surviving card. That is renderer work (`ItemCard.tsx` reads no `replyState` at all today, and `ItemDetail` does not
carry it in a form the card uses) and it is outside `src/main/bridge`. **Left for the renderer owner** — the safety
half is closed here: there is no approvable duplicate reply left to click. Worth a ticket.

---

## 2. correctness-pipeline-1 — FIXED (different fix from the proposal, and better)

`contextFor()` and `reconcile.findOutboundMatch()` read the bridge store with `chats.jid`, which after a LID→phone
merge no longer matches the `chat_jid` the bridge rows are stored under. Empty S1 context window;
`snapshotMessages(item.id, [])` wiping the card's message list; an `unknown_outcome` send that can never reconcile.

### Fix

The reviewer proposed persisting the bridge alias as a new `chats.bridge_jid` column set during the `@lid` merge, and
teaching `contextFor` and `findOutboundMatch` to read over both forms. **I did not do that**, for three reasons:

1. It needs a schema migration, and `contracts.md` wins on DDL — a new column is a contract change for a bug fix.
2. It only records **one** alias, the one seen at merge time. The bridge can key rows under either form at any time.
3. It fixes two call sites and leaves the next chat-scoped read to rediscover the bug.

Instead the alias resolution lives in `BridgeDb`, which is the layer that already owns `whatsmeow_lid_map`
(`phoneJidForLid`). `src/main/bridge/bridgeDb.ts:105-129` adds `aliasJids(chatJid)`: it maps `@lid` → phone via the
bridge's own mapping, and phone → every `@lid` twin the mapping knows, returning the input unchanged when the store has
no `whatsmeow_lid_map` (old stores). Both chat-scoped reads then run over the set:

- `lastMessages` — `WHERE chat_jid IN (?, ?...) ORDER BY rowid DESC` (`bridgeDb.ts:178`)
- `outboundAfter` — same, plus `is_from_me = 1` (`bridgeDb.ts:203`)

`contextFor` and `reconcile.findOutboundMatch` are unchanged and now correct, as is every future chat-scoped read.
Ordering is by `rowid`, so interleaved rows from both forms come back in true arrival order, not grouped by JID.
`rowsAfter` (the watermark scan) is deliberately **not** alias-scoped — it is global by rowid and already sees
everything.

The interface doc-comments at `bridgeDb.ts:33` and `:43` now state the both-forms contract, so an implementer of a
second `BridgeDb` cannot miss it.

### Tests

`src/main/bridge/bridgeDb.test.ts:237` and `:249` — a phone-JID read returns the rows kept under the `@lid` twin;
a chat-scoped read merges both forms **in rowid order** and never leaks another contact's rows (that second assertion
is the one that matters: `IN (...)` over a computed alias list is exactly the shape that leaks if `aliasJids` is
sloppy). `src/main/bridge/ingest.test.ts:481` — after the merge re-keys the chat, `contextFor` still returns both
messages, i.e. the scheduled triage run is not fed an empty window.

### On the skeptic's belt-and-braces suggestion

They suggested `orchestrator.ts` should refuse to run S1 on a zero-length window. I agree it is sound, but it is in
`src/main/agent/**`, not my surface, and with the root cause closed it would now only mask a *different* future bug
rather than this one. **Flagged for the agent-pipeline owner, not implemented here.**

---

## 3. correctness-pipeline-4 — FIXED

`compose.ts:890` arms `syncingUntil` on **every** `'starting'` transition (an ordinary launch, not only a real history
re-sync), so the first scan of every session ran with `syncing === true`, and the 24 h `syncMaxAgeMs` cap dropped any
unseen message older than a day as context-only — permanently, because the watermark advances past it. That defeats
exactly the case `LIMITS.ingestMaxAgeMs` was raised from 24 h to 7 d for (`shared/types.ts:159-161`, "laptop closed
over a weekend").

### Fix

`src/main/bridge/ingest.ts:142-152`, the reviewer's shape (gate the cap on `last_online_ts`):

```ts
if (bridgeSyncing() || !bridgeOnlineOnce()) {
  const lastOnline = metaNumber('last_online_ts');
  // lastOnline === null: the app has never been online (first pairing) - every row here IS the initial history dump.
  const couldHaveBeenSeen = lastOnline === null || ts <= lastOnline;
  if (couldHaveBeenSeen) return age > LIMITS.syncMaxAgeMs ? 'context' : 'live';
}
return age <= LIMITS.ingestMaxAgeMs ? 'live' : 'older';
```

The 24 h cap now suppresses only a **replay** — a row the app could already have seen. A row newer than
`last_online_ts` cannot be a replay, so it falls through to the normal 7-day gate and reaches `older_message`.
The `lastOnline === null` case is the important one: on a first launch after a QR scan there is no "already seen"
watermark at all, so every row genuinely is the initial dump and the cap must apply to all of it. That is why I did
**not** take the narrower alternative of not arming `syncingUntil` on an ordinary `'starting'` — as the skeptic noted,
that re-exposes the first-launch history dump once `backlogHours > 0`, which `live_from_ts` alone does not cover.

No change to `compose.ts` — the fix is entirely inside the gate, which is where the spec collision lives.

### Tests

- `src/main/bridge/ingest.test.ts:539` — `last_online_ts = now-3d`, message at `now-2d`, `syncing = true` ⇒ `isLive`,
  item `queued`, one queue row. This is the weekend case and it was red before the fix.
- `src/main/bridge/ingest.test.ts:553` — `last_online_ts = now-1d`, message at `now-30d`, `syncing = true` ⇒ still
  context-only, no item, no queue row. This is the genuine-replay case, and it is the test that stops the fix from
  simply deleting the cap.
- The pre-existing `:511` ("a 3-day-old row scanned while history is syncing is context-only") still passes unchanged:
  it sets no `last_online_ts`, i.e. the first-pairing dump, which must still be suppressed.

### Honest caveat (unchanged from the skeptic's)

The real-world ordering of offline-queue row writes versus a possible `history_sync_done` marker can only be observed
by running the real `whatsapp-bridge.exe`, which is out of bounds. Both branches are covered by the fix: with no
HistorySync the 120 s window runs in full; with one, the `'online'` poke still scans while `syncing === true`.

### Spec

This is a genuine collision inside A14, not a code deviation: `ARCHITECTURE.md:53` demands the weekend case while also
defining the syncing window as running from spawn for max 120 s. The code now satisfies both sentences.
**`docs/ARCHITECTURE.md` A14 should be amended to state the `last_online_ts` qualifier** — orchestrator's call, I did
not edit the spec.

---

## 4. process-lifecycle-4 — FIXED (with a stronger backstop than proposed)

`restartForNewCode` / `relink` / `unlinkAndWipe` ended in `launchLoop()`, the unsupervised spawn path. compose's
sequence is `stopBridge() -> launcher.X() -> startBridge()`, so the launcher spawned one bridge and the supervisor then
spawned a second; the module-level `child` was overwritten and the first became an untracked orphan — no pid file,
unreachable by `killAllSync()` and by the reaper, two whatsmeow clients on one `whatsapp.db`.

### Fix (two layers)

**Caller ownership** — `src/main/bridge/launcher.ts:690-740`: all three methods now mutate state (audit, store file,
`resetBreaker()`) and then `if (supervised) return;`, leaving the restart to whoever owns the child. This is the same
early-out `respawn()` at `:342` already carried; it simply had not been applied to the three user-facing methods.
Unsupervised callers (the test seam) keep the old self-restart, so the behaviour only changes where the supervisor is
actually driving.

**Spawn backstop** — `src/main/bridge/launcher.ts:510-514`, at the top of `spawnOnce()`:

```ts
if (child !== null) {
  log.warn('bridge_spawn_replacing_live_child', { attempt });
  await stopChild();
}
```

The reviewer proposed an `already_running` entry in `SPAWN_VIOLATIONS`. **I did not do that**, for a reason worth
recording: a `SpawnInvariantError` *refuses* the spawn and surfaces `BRIDGE_SPAWN_REFUSED` to the user — but in this
scenario the caller genuinely wants a bridge running, and refusing would leave the live-but-stale child in place after
a relink that just deleted its session file. Stopping the old child and continuing is what actually upholds the
invariant ("at most one bridge process"), and it makes the guard safe for the case the skeptic flagged: `supervised` is
`false` until `childSpec().start()` has run once, so `if (supervised) return` alone does not cover a launcher that was
only ever started unsupervised. `child !== null` does.

### Tests

`src/main/bridge/launcher.test.ts:825` — the verbatim compose sequence leaves exactly one live child, and `:850` —
`relink` and `unlinkAndWipe` still do their store work (the file really is deleted) and still leave the restart to the
supervisor.

### Scope correction accepted

The skeptic was right to trim the impact story: the orphan cannot duplicate ingest side effects, because the doorbell
secret is rotated for the second child and the orphan's webhooks are 404'd. I1 and I3 were never breached. What was
breached is ARCHITECTURE section 13 (every spawned child owned by the supervisor and reachable by pid file / reaper /
`killAllSync`) and the spirit of I7.

---

## 5. process-lifecycle-8 — FIXED (this session)

`withinRateLimit()` was the **first** statement of `handle()` (`doorbell.ts:121`), so every request spent one of the 30
slots in the single global window before the doorbell knew whether it came from our bridge. Any other local process
could fill the window with traffic that was 404'd a microsecond later, and every genuine `POST /hook/<secret>` inside
that second was rejected too. The bridge does not retry a ring, so those rings were lost and ingest degraded to the
30 s `LIMITS.scanIntervalMs` timer.

### Fix

`src/main/bridge/doorbell.ts` — authenticate first, charge the budget last. The cheap, allocation-free shape checks
(loopback remote, `POST`, no `Origin`, exact `Host`, `secret !== null`) keep their position above the two SHA-256
digests of `constantTimeEquals`, so the obvious unauthenticated flood is still turned away with zero hashing. The
limiter moved to the last statement before `accept()`:

```ts
if (!constantTimeEquals(presented, expected)) return reject(req, res);
if (!withinRateLimit()) return reject(req, res);
return accept(req, res);
```

**I did not add the reviewer's second, pre-auth budget.** Their caveat was that moving the limiter below the secret and
token checks lets an unauthenticated flood buy 4 SHA-256 digests per request instead of 0. That is true and it does not
matter, because **the limiter never was and cannot be a defence against local resource exhaustion**: by the time
`handle()` runs, the TCP accept and the full HTTP header parse have already happened, and those dwarf four digests of a
≤16 KB request line. What bounds that cost is `server.requestTimeout` (5 s), `headersTimeout` (2 s),
`maxHeadersCount` (32) and the immediate `socket.destroy()` on the reject path — all already in place. The limiter's
one real job, per ARCH 4.5, is to bound `onRing()` → `ingest.poke()`, which only an authenticated ring can trigger. A
second budget would add a constant, a branch and a coverage obligation to defend a cost the limiter does not sit in
front of. The reasoning is written into the code as a block comment so nobody "fixes" the ordering back.

No spec change: `ARCHITECTURE.md:175` says only "Intake limiter 30 req/s" and pins no ordering.

### Tests (written first, both red before the fix)

`tests/security/doorbell.test.ts:334` and `:349`, against the REAL `createDoorbell()` over real loopback sockets:

- 60 concurrent unauthenticated `GET /` (twice the whole window) all 404, `rings` stays empty, and a genuine ring
  immediately afterwards is **200**. Red before: `404`.
- 60 concurrent `POST /hook/<wrong-secret>` of the same length all 404, and a genuine ring afterwards is **200**. Red
  before: `404`. This second one is the load-bearing case: it only passes if the limiter sits *below* the constant-time
  secret comparison, not merely below the cheap shape checks.

The pre-existing `:321` ("rejects the 31st ring inside one window") is unchanged and still green — 35 sequential
genuine rings, ≤30 accepted — so the 30/s cap itself is not weakened, and the limiter's reject branch stays covered
(the `doorbell.ts` 100 % line-coverage requirement of build-plan section 3 still holds).

### Severity confirmed minor

The skeptic's two corrections stand and I verified neither changes the fix: history sync emits **no** webhooks
(`vendor/whatsapp-bridge-src/main.go` `handleHistorySync` only calls `StoreMessage`), and a busy group is a non-event
because a ring is a coalescing 250 ms-debounced poke, not a data channel. The 30 s timer scan
(`compose.ts:1245`) calls `ingest.poke()` in-process and is not attacker-reachable, so there was never data loss.

---

## 6. Stale lint directive removed

`src/main/bridge/ingest.ts:404` carried `// eslint-disable-next-line @typescript-eslint/require-await` on
`resolveLidChats`, left over from the data-integrity-2 repair. The rule no longer fires there, so the directive itself
was the only `npm run lint` failure in the tree (`--max-warnings 0` turns "unused eslint-disable directive" into a
build break). Removed; the explanatory doc-comment above it — which is the part that matters, since the `async`
keyword looks removable and is not — is kept verbatim.

---

## Verification

All commands run with `$env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;" + $env:PATH`.

| Command | Result |
|---|---|
| `npx vitest run src/main/bridge tests/security src/main/exec src/main/db` | **43 files, 1111 tests, all pass** |
| `npm run lint` | **clean** (0 errors, 0 warnings) |
| `npx prettier --check` on the three touched files | clean |
| `npm run typecheck` | 5 errors, **none in my surface** — see below |

### Red elsewhere in the tree — reported, not touched, not mine

These were red before this session's change and are unaffected by it (the only production edit was `doorbell.ts`'s
statement order plus deleting a lint comment). They belong to the agent-pipeline and renderer owners:

**Typecheck (5 errors, 2 files)**
- `src/main/agent/prompt.purity.test.ts:113,140` — `BuildContextInput` for `stage: 'draft'` now requires `slot:
  ResolvedSlot`; the test's two call sites do not pass it.
- `src/renderer/src/components/ItemCard.test.tsx:551,574,587` — `ActionView.lastError` is an `ErrorCode` union, the
  fixture passes a bare `string`.

**Vitest (11 failures, 4 files, all under `src/main/agent/**`)**
- `prompt.purity.test.ts` ×2 — throws in `contextBuilder.ts:82` (`appComputed`).
- `queue.test.ts` ×1 — "keeps a queue row that was re-armed WHILE the run was in flight".
- `validate.test.ts` ×7 — two `scrubDraft` cases (non-ASCII digits, homoglyph link separator) and five "item row
  changed mid-run" cases.
- `items.test.ts` ×1 — `retriage()` on an `ignored` item with no `closed_reason`, throwing from
  `repos/items.ts:44` via `agent/items.ts:267`.

I did not investigate or patch any of them: they are another owner's in-flight surface, and a green-by-my-hand test in
someone else's file is worse than an honest red.

## Files changed by me

| File | Change |
|---|---|
| `src/main/bridge/doorbell.ts` | limiter moved below authentication; block comment explaining why |
| `tests/security/doorbell.test.ts` | +2 tests (unauthenticated flood, wrong-secret flood) |
| `src/main/bridge/ingest.ts` | removed the stale `eslint-disable` on `resolveLidChats` |

Changed in the interrupted earlier run of this same task (verified green here, documented above):
`src/main/bridge/ingest.ts`, `src/main/bridge/bridgeDb.ts`, `src/main/bridge/launcher.ts`,
`src/main/exec/actionExecutor.ts`, `src/main/db/repos/actions.ts`, `src/main/db/index.ts`, and their colocated tests.

## Hand-off / open items for the orchestrator

1. **Renderer, from approval-first-3**: `docs/proposals/ux.md:108` wants the draft collapsed and an "already answered
   from your phone" chip on a card that survives `answered_elsewhere` with a pending event. The renderer reads no
   `replyState` at all today. Safety is closed; the affordance is not. Worth a ticket.
2. **Spec, from correctness-pipeline-4**: `ARCHITECTURE.md` A14 (line 53) should record the `last_online_ts` qualifier
   on the 24 h sync cap, otherwise the next reader re-finds the same collision.
3. **Agent pipeline, from correctness-pipeline-1**: consider refusing an S1 run on a zero-length context window in
   `orchestrator.ts`. Root cause is closed, so this is belt-and-braces only.
4. **Not mine, currently red**: the 5 typecheck errors and 11 vitest failures listed above.
