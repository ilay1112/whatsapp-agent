# fix-src-main-db — repair of the four confirmed `src/main/db` defects

Lane: phase 3 repair. Scope: `src/main/db` (+ the two non-db call sites named inside the data-integrity-2 finding).
Status: **all four findings fixed, all with regression tests.** No finding turned out to be wrong.

This run resumed an earlier session that was cut off by a usage limit. Most product changes were already on disk when I
started; what I added this run is listed under "Added this run". Everything below was re-verified from scratch.

---

## What was wrong, and what the fix actually is

### data-integrity-1 (major) + data-integrity-2 (blocker) — one root cause, one fix

Both findings are the same mechanism. `actions.retry_of TEXT REFERENCES actions(id) ON DELETE SET NULL` (migrations v1,
line 82) is implemented by SQLite as an implicit `UPDATE actions SET retry_of = NULL`, and with `PRAGMA foreign_keys=ON`
(`db/index.ts`) that UPDATE fires `trg_actions_frozen`, whose v1 guard demanded `NEW.retry_of IS OLD.retry_of`. So
deleting **any** action that a retry clone pointed at aborted with `approved content is immutable`:

- `retention.purge`'s `DELETE FROM items` rolled its whole transaction back — nothing was ever purged again and
  `data:purgeNow` answered INTERNAL. One failed send in the app's lifetime was enough.
- `chats.mergeLidInto`'s `DELETE FROM actions WHERE chat_id = ?` aborted inside ingest's scan transaction, which also
  carries `bridge_rowid_watermark`, so the batch rolled back and ingest re-read and re-failed the same rows forever.

**Fix: migration v2** (`migrations.ts`), `actions_frozen_allows_retry_unlink`. The trigger is I3's second line of defence
and is **not** dropped. It is recreated with a guard that names the two legitimate shapes and only those:

1. the retention purge of a terminal row's payload (the v1 hatch, unchanged), and
2. the FK's own NULLing of a dangling retry back-pointer.

Everything that pins an approval to its recipient and its bytes — `chat_id`, `item_id`, `proposal_id`, `kind`,
`content_sha256`, `idempotency_key`, `attempt` — stays frozen in **both** shapes.

**I deliberately did NOT take the reviewer's cheaper option** ("drop `retry_of` from the `BEFORE UPDATE OF` column
list"). That would stop the trigger firing on a `retry_of`-only update at all, leaving `retry_of` freely **re-aimable** on
a live approval. I proved this is a real hole by mutation-testing it — see "Mutation testing" below. Shape 2 therefore
also insists on `OLD.retry_of IS NOT NULL` (so it stays a NULLing of a *real* back-pointer and cannot be used as a no-op
that smuggles a second `canonical_json` pass past shape 1's `OLD.canonical_json IS NOT NULL`) and on
`NEW.canonical_json IS OLD.canonical_json`.

Secondary hardening for -2, both named in the finding:

- `bridge/ingest.ts` — `resolveLidChats` is now `async`. It was a plain arrow returning `Promise.resolve(...)` that called
  `repos.db.transaction(...)` synchronously, so an abort was a **synchronous throw** and compose's
  `void ingest.resolveLidChats().catch(() => undefined)` never got to attach its handler.
- `bridge/launcher.ts` — **added this run**, see below.

### data-integrity-3 (minor) — `mergeLidInto` dropped the @lid chat's queue row

`triage_queue.chat_id REFERENCES chats(id)` has no `ON DELETE` clause, so the @lid row *must* go — but it must not simply
vanish. `resolveLidChats()` merges on the bridge's ONLINE transition, which can land inside the 20 s debounce: the item
moved across still `analysis='queued'` with its queue row gone, so nothing ever triaged it.

Fix in `repos/chats.ts`: the queue row now **follows the work** — an upsert onto the target with
`MIN(due_at)`, `MIN(first_enqueued_at)`, `MAX(attempts)`, guarded by "is anything analysable actually moving across?".
When nothing analysable moves, the row is still dropped (a queue row costs an LLM run) — the case `chats.test.ts` always
covered.

The verifier's extra test-D leak (a superseded item keeps `analysis='queued'` forever and `expireOld` skips closed rows,
so the "Analysing N" counter sticks) is fixed **in `repos/items.ts` `counts()`** rather than by clearing `analysis` on
close, which the fix note suggested. `counts().analysing` now filters `closed_at IS NULL`. Reason: `analysis` is the
record of how far the pipeline actually got, and blanking it on close would destroy that history for every close path.
`analysing` is the header's *live work* counter, so the right place to exclude history is the query, not the row.

### correctness-pipeline-7 (minor) — `defer()` inflated the retry backoff

`defer()` ran `attempts = attempts + 1` unconditionally. Exactly four call sites exist; two are **not** failures and pass
no error (`agent/queue.ts:120` edit-lock deferral, `bridge/ingest.ts:270` Stage-0 `deferred`). Since `attempts` is the
backoff **tier** over `RETRY_BACKOFF_MS = [1 min, 5 min, 30 min]`, edit-lock deferrals alone pushed a chat into the 30-min
tier before its first genuine provider failure, where the item waits at `analysis='queued'` — counted but never listed.

Fix in `repos/queue.ts`: two statements; the counter advances only when the caller passed a `lastError`.

**Deviation from the reviewer's wording, on purpose.** The proposal was "increment only when `lastError` is a real
ErrorCode". I used the **presence** of `lastError` as the failure signal, and kept `errorCodeOrNull` deciding only
whether the code is *safe to store* ([R2] — a provider/zod message can echo attacker-controlled text). Under the literal
proposal, a real provider failure whose message is not a known `ErrorCode` would be redacted to NULL **and** silently
reset to the 1-minute tier forever: redaction is a logging concern and must not rewrite the retry policy. Pinned by
`repos.test.ts` — `defer(..., 'Error: rate limited by provider, retry in 3s')` gives `attempts: 2, lastError: null`.

---

## Added this run

1. **`bridge/launcher.ts` — the last open item of data-integrity-2's fix direction.** `setStatus` and `onPairingState`
   fanned out with a bare `for (const cb of [...cbs]) cb(next)`. One throwing subscriber skipped every subscriber
   registered after it and tore the exception out through whatever caused the transition. compose registers
   `healthHub.setBridge` / `healthHub.setPairing` and the renderer emit **last**, so a throw upstream left the health
   model and the UI stale while the caller mislabelled the cause (health tick flipped the bridge to 'reconnecting' every
   tick; the pairing poll logged `pairing_poll_failed{reason:'other'}`). Replaced both loops with one `fanOut` helper:
   per-subscriber `try`, and it logs the error **name** only, never the message ([R2]), following the existing
   `*_listener_failed` convention in `compose.ts`. Both new tests were **red first** — the pairing one even produced an
   unhandled rejection.

2. **Negative tests for the relaxed trigger** (`migrations.test.ts`, new describe block). Migration v2 relaxes a safety
   trigger and nothing pinned the new hatch shut: `tests/security/approval-binding.test.ts` covers `canonical_json`,
   `chat_id`, `kind` and `content_sha256`, but nothing covered `retry_of`. Five tests now assert the hatch permits only
   the FK's NULLing, and still refuses to aim `retry_of` at any value, to smuggle a payload/recipient rewrite alongside
   the NULLing, or to blank a live row.

### Mutation testing (evidence the new tests discriminate)

Rather than assume the negative tests were meaningful, I mutated `migrations.ts` three times, ran the suite, and restored
the file each time (byte-identical, sha256 `621fa4ef…` verified before and after). **All three mutants were caught:**

| Mutation | Caught by |
|---|---|
| drop `retry_of` from the v2 `BEFORE UPDATE OF` list (**the reviewer's "cheaper option"**) | `still refuses to AIM retry_of at anything` |
| drop `NEW.canonical_json IS OLD.canonical_json` from shape 2 | `still refuses to smuggle a payload or recipient rewrite…` |
| drop `OLD.retry_of IS NOT NULL` from shape 2 | `still refuses to AIM retry_of at anything` |

The first is the load-bearing result: it is direct evidence that the cheaper fix the finding suggested would have opened
a hole in I3, and is why the column stays in the list.

---

## Verification

- `npx vitest run src/main/db src/main/bridge tests/integration tests/security` → **1017 passed, 48 files, 0 failed.**
- `npx eslint` over every touched file → clean. `npx prettier --check` → clean.
- `npm run typecheck` → the only errors are in **other lanes' files**, `src/main/agent/prompt.purity.test.ts` and
  `src/renderer/src/components/ItemCard.test.tsx`. Nothing in `src/main/db` or `src/main/bridge`.

### Red tests I did NOT cause, and did not touch (for the orchestrator)

`npx vitest run src/main/agent` is **red: 11–12 failures in 4 files** (the count moved between two runs minutes apart).
This is another lane working in the same tree right now, not a regression from this repair:

- `src/main/agent/sanitize.ts` / `sanitize.test.ts` were modified at **10:17:23 / 10:17:39 today, while my run was in
  progress**. That accounts for `prompt.purity.test.ts` (2, `TypeError: Cannot read properties of undefined`) and
  `validate.test.ts` `scrubDraft` (2, homoglyph + non-ASCII digits).
- The other 7 (`validate.test.ts` "the item row can change while the run is in flight" ×5, `queue.test.ts` "keeps a queue
  row that was re-armed WHILE the run was in flight", `items.test.ts` `UNIQUE constraint failed: items.chat_id`) are
  red-first TDD tests dated **2026-09-23 18:06–18:07** against sources still dated **02:16–02:33** — i.e. tests written,
  product fix pending, in that lane.

None of them touch `mergeLidInto`, `retention.purge`, `trg_actions_frozen` or `defer()`'s `attempts`; they exercise
`agent/queue.ts`'s `remove()` decision, `agent/validate.ts`'s mid-run re-read, `agent/items.ts`'s `retriage()` and
`agent/sanitize.ts`. Reported, not deleted, skipped or weakened.

## Open question for the orchestrator

`repos/chats.ts` still carries the W1-04 REQUEST: CONTRACTS 15.1 says `mergeLidInto` moves "items/actions", but
`actions.chat_id` is frozen by `trg_actions_frozen` (I3 pins the recipient at proposal time), so actions **cannot** follow
their item into another chat and are deleted with the @lid chat row instead. Migration v2 does not change that — it only
lets the delete succeed. The contract wording still needs your confirmation.

## Files touched

- `src/main/db/migrations.ts` — migration v2 (pre-existing this run; restored byte-identical after mutation testing)
- `src/main/db/repos/chats.ts`, `src/main/db/repos/queue.ts`, `src/main/db/repos/items.ts` — pre-existing this run
- `src/main/bridge/ingest.ts` — `resolveLidChats` async; pre-existing this run
- `src/main/bridge/launcher.ts` — **added this run**: guarded `fanOut`
- Tests: `src/main/db/migrations.test.ts` (**added this run**), `src/main/db/retention.test.ts`,
  `src/main/db/repos/chats.test.ts`, `src/main/db/repos/items.test.ts`, `src/main/db/repos/repos.test.ts`,
  `src/main/bridge/launcher.test.ts` (**added this run**)
