# Adversarial code review — lens: data-integrity

Reviewer label: `review-data-integrity`. Date: 2026-09-23.
Scope reviewed: `src/main/db/**` (migrations, wrapper, repos, backup, retention), `src/main/bridge/{bridgeDb,timestamps,ingest}.ts`,
`src/main/exec/{actionExecutor,outcome,reconcile}.ts`, `src/main/agent/{items,validate,queue}.ts`, `src/main/ipc/handlers/data.ts`,
and the DB-related wiring in `src/main/compose.ts`. **No product file was edited.**

Reproductions live in `ops/agent-notes/review-data-integrity.scratch/` (outside `tests/`):

- `probe1-fk-setnull.mjs` — raw `node:sqlite` probe against the verbatim migration SQL.
- `findings.test.ts` + `vitest.scratch.config.ts` — 8 tests driving the real repos.
  Run: `npx vitest run --config ops/agent-notes/review-data-integrity.scratch/vitest.scratch.config.ts`
  Result: **7 failed / 1 passed**. Each failure is one finding below; the single pass is the control
  (the same purge succeeds when no action has a `retry_of` parent). The assertions are written as
  "this should work" on purpose, so a red test = a live defect.

No product test was deleted, skipped or weakened. The existing suite stays green — none of its tests
exercises these combinations.

---

## data-integrity-1 — BLOCKER — retention can never delete a closed item that has a retry chain

**Where:** `src/main/db/migrations.ts:82` (`retry_of TEXT REFERENCES actions(id) ON DELETE SET NULL`)
combined with `src/main/db/migrations.ts:103` (`trg_actions_frozen`), hit by
`src/main/db/repos/retention.ts:42` (`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < ?`).

SQLite fires `BEFORE UPDATE OF ... retry_of` triggers for the implicit `ON DELETE SET NULL` write.
When an action row is deleted, every child whose `retry_of` points at it is updated to NULL, and
`trg_actions_frozen`'s `WHEN NOT (NEW.canonical_json IS NULL AND OLD.canonical_json IS NOT NULL AND ...)`
is true for that child (its `canonical_json` is either still present, or already NULL from an earlier
retention pass — both make the guarded expression false), so the statement aborts with
`approved content is immutable`. Verified in isolation by `probe1-fk-setnull.mjs` (case 1 deletes the
parent action directly; case 2 deletes the item and cascades).

**Failure scenario (reproduced):**

1. A `send_reply` is approved, executes, and the bridge answers `rejected`/`unreachable`.
   `actionExecutor.markFailure()` → `cloneForRetry()` inserts the clone with `retry_of = a1.id`
   (`src/main/exec/actionExecutor.ts:225`). Any failed or timed-out action produces this shape —
   it is the normal path, not an edge case.
2. The card is later dismissed/closed and ages past `closedBefore`.
3. `repos.retention.purge()` reaches its `DELETE FROM items`, the cascade to `actions` triggers the
   `SET NULL` on the clone, the trigger aborts, and because the whole repo method runs inside one
   `db.transaction`, **nothing at all is purged** — not the message text, not the proposals, not the
   action payloads.
4. `runRetention()` (`src/main/db/retention.ts:56`) therefore throws before its 180-day prune of
   `runs` / `audit_log` / `rate_events`, so that never runs either.

**Blast radius:** the daily job at `src/main/compose.ts:1254` is wrapped by `every()`, which swallows
the throw into a `timer_failed` warning — so retention silently stops forever with no user-visible
signal. `data:purgeNow` (`src/main/ipc/handlers/data.ts:18`) throws too and is mapped to `INTERNAL`
by `src/main/ipc/register.ts:147`: the user's "Delete now" button reports an internal error and
deletes nothing. A single failed send in the app's lifetime is enough to disable retention permanently.

**Fix:** needs migration v2 that recreates `trg_actions_frozen` so a NULLing of `retry_of` alone is
permitted (e.g. drop `retry_of` from the `UPDATE OF` column list and instead require
`(NEW.retry_of IS OLD.retry_of OR NEW.retry_of IS NULL)` inside the guarded expression), **or** change
the FK to `ON DELETE CASCADE` (a clone without its chain root has no root to resolve anyway) and adapt
`actions.chainRoot`. Do not "fix" it by dropping the trigger: it is the second line of defence for I3.

## data-integrity-2 — BLOCKER — the same trigger aborts the @lid → phone-JID merge

**Where:** `src/main/db/repos/chats.ts:94` (`DELETE FROM actions WHERE chat_id = ?`).

`mergeLidInto` deliberately deletes the @lid chat's action rows (its own doc comment explains why),
but the delete hits the same `ON DELETE SET NULL` → `trg_actions_frozen` abort as soon as one of those
rows is a retry parent. The deferral guard above it only covers `approved`/`executing`, so a
`failed` + `pending clone` pair walks straight into it.

**Failure scenario (reproduced):** a `create_event` for an @lid chat fails with `CAL_UNAVAILABLE`,
the executor clones a retry, and the next bridge ONLINE transition tries to merge that chat.

Two consequences, both worse than a lost merge:

1. `bridge/ingest.ts:268` (inside `handleChat`) calls `mergeLidInto` **inside `processBatch`'s transaction**,
   the one that also persists `bridge_rowid_watermark` (`ingest.ts:306`). The abort rolls the whole
   batch back, the watermark never advances, and the next scan re-reads exactly the same rows and
   fails again — **ingest stalls permanently**.
2. `resolveLidChats` (`ingest.ts:384`) is a *non-async* function returning a `Promise`, so the abort
   is a **synchronous** throw. `void ingest.resolveLidChats().catch(() => undefined)` at
   `compose.ts:887` and `:900` therefore does not catch it — the `.catch()` is never attached. The
   exception escapes into `launcher.setStatus`'s callback loop (`bridge/launcher.ts:200`), which has
   no try/catch either, so the remaining status subscribers (including `healthHub.setBridge`) are
   skipped and the throw reaches an async callback in the main process.

**Fix:** same migration as data-integrity-1. Independently: make `resolveLidChats` `async` (or wrap
its body in `try`) so the promise contract in its own type signature holds, and guard the
`for (const cb of statusCbs)` loop in `launcher.setStatus`.

## data-integrity-3 — MAJOR — the LID merge drops the surviving chat's pending triage

**Where:** `src/main/db/repos/chats.ts:96` (`DELETE FROM triage_queue WHERE chat_id = ?`).

The @lid chat's items are re-parented to the phone-JID chat (`chats.ts:95`) but its `triage_queue`
row is deleted without being merged into the target's row, and nothing re-enqueues the target.

**Failure scenario (reproduced):** a message arrives on an @lid chat, ingest creates the item with
`analysis = 'queued'` and enqueues the chat; before the 20 s debounce elapses the bridge goes ONLINE
and `resolveLidChats()` merges the chat. The item now lives on the phone-JID chat, still
`analysis = 'queued'`, with **no queue row anywhere**. `agent/queue.ts` only ever reads
`triage_queue`, and `items.recoverRunning()` only rescues `analysis = 'running'`, so the message is
never analysed. It is counted in `items.counts().analysing` but is not listed (`isListed()` excludes
`queued`), so the user sees a phantom "analysing" counter and no card until `items.expireOld()`
closes it as `expired` 7 days later.

**Fix:** in the merge branch, upsert the target's queue row to `MIN(due_at)` /
`MIN(first_enqueued_at)` of the two before deleting the @lid row.

## data-integrity-4 — MAJOR — `data:purgeNow` bypasses the purge job, so purged text survives in the backups

**Where:** `src/main/ipc/handlers/data.ts:15-26`.

The handler calls `deps.repos.retention.purge(...)` directly. `runRetention`'s entire
`mode: 'purgeNow'` branch (`src/main/db/retention.ts:47,64-72`) — wipe `backups\`, take one fresh
`VACUUM INTO` copy, record `last_backup_at` — is **dead code**: `grep -rn "purgeNow" src` shows no
product caller passes `mode`. The handler also skips the 180-day prune of `runs` / `audit_log` /
`rate_events` that `runRetention` performs, and skips the `purge` audit detail.

**Failure scenario:** the user presses "Delete now". `item_messages.text`, `proposals.draft_text` and
the terminal `actions.canonical_json` are NULLed in `app.db` — and remain readable verbatim in up to
three `backups\app-*.db` files, which `backupNow` keeps (`DEFAULT_KEEP = 3`) and which nothing in
this path touches. The comment at `src/main/db/retention.ts:3` states the opposite guarantee
("so purged text does not survive in the daily copies").

**Fix:** have the handler call `runRetention({ repos, settings, now, backups: { dir: paths.backupsDir } })`
(wired through `HandlerDeps`) instead of reaching into the repo.

## data-integrity-5 — MINOR — re-opening an item can violate `ux_items_open`

**Where:** `src/main/agent/items.ts:265`
(`if (item.closedReason !== null && open !== null && open.id !== id) return err('ACTION_STALE');`).

The guard keys on `closed_reason`, but the partial unique index keys on `state`. An item can be
non-open with `closed_reason IS NULL`: `deriveState` returns `'ignored'` whenever `analysis='done'`,
`reply_state='none'` and `event_state='none'`, and `agent/resolve.ts:74`'s `closureFor()` returns
`null` in exactly that shape whenever `needsCalendarChangeBadge(x)` is true, or when `needsReply` was
true but `scrubDraft` emptied the draft.

**Failure scenario (reproduced):** item A ends `ignored` with `closed_reason = NULL`; the chat's next
message opens item B (allowed — A is not open). `retriage(A)` skips the guard because
`A.closedReason === null`, and `items.update(A, { analysis: 'queued', closedReason: null })` derives
`needs_reply`, hitting `UNIQUE constraint failed: items.chat_id`. The IPC layer maps it to `INTERNAL`
(`ipc/register.ts:147`), so there is no corruption, but the raw SQLite error leaks into the handler
path and the user gets an unexplained internal error instead of `ACTION_STALE`.

**Fix:** guard with `isOpen(item.state)` (already exported from `shared/state.ts`) instead of
`item.closedReason !== null`, in both `restore()` and `retriage()`.

## data-integrity-6 — MINOR — a `done` action whose item consequence was lost is never repaired

**Where:** `src/main/exec/actionExecutor.ts:271-275` (and the identical shape at `:297-301`).

`markDone()`, `applySendSuccess()` and `audit.append('action_done')` are three separate
transactions. `recoverOnStartup()` only scans `state = 'executing'` (`actions.executing()`), and
`reconcileUnknown()` only looks at `unknown_outcome`, so nothing ever revisits a `done` action whose
item update did not land.

**Failure scenario (reproduced as a state assertion):** the process is killed (or `applySendSuccess`
throws) between `markDone` and `applySendSuccess`. The action is `done`, but the item keeps
`reply_state = 'draft'`. On the next triage `agent/validate.ts:165` sees a non-sticky `reply_state`
(`STICKY_REPLY_STATES` is `{'sent','answered_elsewhere'}`), drafts again, and
`validate.ts:218` inserts a **fresh pending `send_reply`** — so one approval can end up sending two
WhatsApp messages. The window is short (two synchronous statements, no await between), but the
outcome is a duplicate outbound message, which is the one thing the approval-first promise is about.

**Fix:** wrap `markDone` + `apply*Success` + the `action_done` audit in a single `repos.db.transaction`
in `runSend`/`runCreate` and in `exec/reconcile.ts:87,106`.

## data-integrity-7 — MINOR — retention strips the text of a live `older_message` card

**Where:** `src/main/db/repos/retention.ts:16`
(`UPDATE item_messages SET text = NULL WHERE text IS NOT NULL AND ts < ?`).

The predicate is the **WhatsApp message timestamp**, not the time the row was captured, while the
sibling statement for `proposals` correctly uses `created_at` (app time).

**Failure scenario (reproduced):** `LIMITS.ingestMaxAgeMs` is 7 days and the minimum allowed
`privacy.retentionDays` is 7. A row that arrives late (phone offline, delayed delivery) with
`ts = now - 8 d` is classified `'older'` by `ingest.liveness()`, which creates a raw card with badge
`older_message` that the user is expected to read and act on. The very next retention run NULLs its
`item_messages.text`, leaving an open `needs_reply` card whose trigger text is gone while the card
itself lives for another 7 days.

**Fix:** purge on a capture timestamp (`items.created_at` of the owning item, or a new
`item_messages.captured_at`) rather than on the message's own `ts`.

---

## Checked and found sound (no finding)

- `parseBridgeTs` (`bridge/timestamps.ts`): offset sign, 1–9 fractional digits truncated not rounded,
  leap-second clamp, `Date.UTC` roll-over rejection (`2026-02-31`), s-vs-ms threshold, range clamp.
  I could not construct a wrong-instant input.
- `bridgeDb.ts` read-only posture: `{ readOnly: true }` + `PRAGMA query_only=1`, every statement a
  `SELECT`, no journal-mode change, no index creation, `whatsmeow_lid_map` probed via `sqlite_master`.
- `trg_actions_state` / `trg_actions_insert` / `trg_actions_final_frozen`: the retention NULLing of
  `canonical_json` and `approved_final_json` passes all of them for every state in
  `TERMINAL_ACTION_STATES`; `approved` is unreachable as a resting state because both CAS statements
  live in one transaction.
- `markApprovedExecuting`'s CAS: correct as long as it is never nested inside another
  `db.transaction` — and no current caller nests it. Note for future work: `Db.transaction`
  (`db/index.ts:154`) joins a nested call to the outer transaction **without a SAVEPOINT**, so a
  nested method that catches its own error (as `markApprovedExecuting` does) would leak a half-applied
  write if it ever ran under an outer transaction. Not reachable today; worth a SAVEPOINT anyway.
- `idempotency_key` uniqueness: every `insertPending` call site pairs with a fresh
  `proposals.insertNext` version, and clones append `:rN` from `attempt`, so no collision path exists.
- `openDbWithRecovery` / `moveAside`: WAL sidecars are moved aside with the main file before a restore,
  so no stale `-wal` is applied to a restored copy.
- `migrate()`: backup-before, one transaction per migration, `PRAGMA user_version` inside it,
  downgrade detection — all correct.
