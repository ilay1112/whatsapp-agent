# v2 review - lens "data-integrity-v4" (adversarial code review, v2 phase 3)

Reviewer label: `v2-review-data-integrity-v4`. Scope: migration v4 (table rebuilds, trigger recreation, v3 round trip, crash
mid-migration), the new tables and CHECKs, transaction boundaries around `auto_writes` / `event_revisions` / `actions`, retention
of the media cache and transcripts, anything that can corrupt `app.db`, lose an approval / undo record, or leave a dangling policy.
No product file was edited. No test under `tests/` was touched.

## Reproductions

`ops/agent-notes/v2-review-data-integrity-v4.scratch/` (outside `tests/`, not part of `npm test`):

- `findings.test.ts` - 8 tests, each asserts the CORRECT behaviour and FAILS on the current code (8/8 red, verified 2026-10-04).
  Real in-memory/temp-file `app.db` with the production triggers; the exec tests use `tests/helpers/ledger.execRig.ts` (fake
  calendar behind the real MCP clients, virtual clock). Synthetic ids only.
- `vitest.scratch.config.ts` - run with
  `npx vitest run --config ops/agent-notes/v2-review-data-integrity-v4.scratch/vitest.scratch.config.ts`

## What holds (checked, no finding)

- Migration v4 itself: rebuild order (auto_policies before the actions triggers, triggers recreated after the copies, so the
  INSERT...SELECT copies fire no trigger), `foreign_keys=OFF` outside the transaction + `foreign_key_check` before COMMIT, the
  backfills (`approved_by='user'` iff `approved_at`, `event_revision`/`event_origin_item_id` for v1 events, `provider_class`),
  index re-creation, `user_version` inside the transaction. `tests/security/migration-v4.test.ts` already injects a failure at
  every statement and proves byte-identical rollback; I found nothing it misses inside the runner.
- New CHECKs vs. the writers: `auto_writes` undo window (tryAuto computes min(+72 h, restore start) after the B9 lead checks),
  `event_revisions` create<->revision 1, `auto_decisions` verdict<->reason, `model_files.kind`.
- `trg_actions_state` v2 clauses (approved_by, toast-only-undo, live `on` policy + matching decision kind, unixepoch expiry),
  `trg_actions_approver_frozen`, `trg_auto_writes_insert`. tryAuto's decision + write-ahead + auto_writes insert is ONE
  transaction and a CAS miss rolls all of it back (the nested `markApprovedExecuting` returns 'stale', tryAuto throws `Stale`).
- `auto_policies` are never deleted; `auto_decisions.policy_id` has no cascade, so no decision can dangle from a policy.

## Findings

### data-integrity-v4-1 (major) - daily retention never deletes the cached picture files

- `src/main/db/repos/retention.ts:15-18,64-70,96` returns `mediaFileNames(m.sha256)` = `<sha256 of the JPEG bytes>.jpg/.thumb.jpg`.
- `src/main/media/mediaCache.ts:39-41` writes the files as `<hash(chatRef|waMsgId)>.jpg/.thumb.jpg` (`compose.ts:1308`
  passes `hash: sha256Hex`). The two names never coincide.
- `compose.ts:2208-2217` unlinks the names retention returned: `rmSync(force)` on non-existent files, silently.
- Failure: a picture item older than `privacy.retentionDays` -> the media_cache row is deleted, both files stay in
  `<userData>\media-cache\` forever (no row names them any more, so Dismiss cannot find them either). Only `data:purgeNow`'s
  directory wipe ever removes them. Contradicts ARCHITECTURE-v2 9.3 ("media-cache files unlinked with the 30-day job").
- Proof: scratch test `data-integrity-v4-1` (row gone, `readdirSync(dir)` still lists the 2 files).
- Fix: one naming function shared by both sides - retention returns `(chat_id, wa_msg_id)` pairs (or the cache stores its file
  base in the row) and compose unlinks via `media/mediaCache.ts`'s own `jpgOf/thumbOf`.

### data-integrity-v4-2 (minor) - an @lid merge re-keys `media_cache.chat_id` and orphans the picture files

- `src/main/db/repos/chats.ts:137` `UPDATE OR IGNORE media_cache SET chat_id = <target>`; the file name is derived from the
  chatRef at `put()` time (`mediaCache.ts:39`), so after the merge `thumb()/dataUrl()` look under `hash(targetRef|msg)` and
  `deleteForItem()` unlinks the wrong names. (The header comment at `mediaCache.ts:5` still claims the merge deletes the row by
  FK cascade - it does not since V2-W1-01.)
- Failure: an @lid chat with a picture card resolves to an existing phone-JID chat -> the card loses its thumbnail / "View
  picture" (null), and Dismiss removes the row but leaves both files on disk permanently.
- Proof: scratch test `data-integrity-v4-2` -> `{ thumbAfterMerge: false, deleted: 1, filesLeft: 2 }`.
- Fix: key the file name on something the merge does not change (the row's own stored base / wa_msg_id + content sha), or rename
  the files inside the merge's caller after COMMIT.

### data-integrity-v4-3 (major) - retention deletes the event ORIGIN item while another item still holds the live event

- `src/main/db/repos/retention.ts:72-74` deletes every closed item with `closed_at < now - 90 d`. A source item is closed
  `'superseded'` the moment a change card applies an edit (`exec/outcome.ts:178-180`) although the event lives on in Google.
- The delete fires `items.event_origin_item_id ... ON DELETE SET NULL` / `linked_item_id ... SET NULL` (`migrations.ts:228,232`)
  on the holder, and cascades the origin's create action -> its rev-1 `event_revisions` row (and any `auto_writes` /
  `auto_decisions` of that item).
- `exec/actionExecutor.ts:740-744` `ownershipOf`: `originId === null || origin === null` -> `'foreign'`.
- Failure: create an event 4+ months ahead (horizon is 12 months), reschedule it once from a later message; 91 days later the
  daily job runs. From then on every app write to that still-live event - reschedule, Cancel event, undo - ends
  `failed CAL_EVENT_FOREIGN`; tryAuto sees no source (`wrong_item`). The revision chain has lost its rev-1 row.
- Proof: scratch test `data-integrity-v4-3` -> `{ origin: null, outcome: 'failed', errorCode: 'CAL_EVENT_FOREIGN', stillLive: true }`.
- Fix: retention must not delete a closed item that a surviving item references through `event_origin_item_id` /
  `linked_item_id` (or whose `calendar_event_id` is still held by an in_calendar item); add the NOT EXISTS clause to the DELETE.

### data-integrity-v4-4 (major) - the revision CAS reads the SOURCE item, whose `event_revision` never moves when another item acts

- `exec/outcome.ts:210-211` `commitUpdateDone`: `revision = max(p.baseRevision, target.eventRevision) + 1` with
  `target = items.byId(p.targetItemId)` = the SOURCE. `applyUpdateSuccess` writes the new revision onto the ACTING item only
  (`outcome.ts:166-176`); the source keeps its old value and is closed.
- The same stale value is the CAS of `approveUpdate` (`actionExecutor.ts:790-793`, `target.eventRevision !== p.baseRevision`)
  and the "superseded" guard of `reconcileUpdateWith` (`reconcile.ts:234-235`). (The existing unit test "another change landed
  meanwhile => superseded" passes only because it bumps `source.eventRevision` by hand.)
- Failure (reachable from the normal UI): a change card's PATCH lands but answers `timeout` -> `unknown_outcome` + pending retry
  clone. (a) Reconcile resolves the original to `done` (revision 2). The user clicks "Apply again" on the clone: the CAS passes
  (source still 1) -> drift prompt -> "Apply anyway" -> a SECOND PATCH goes to Google -> `commitUpdateDone` computes revision 2
  again -> `ux_event_rev` UNIQUE aborts the outcome transaction -> the clone is stuck in `executing`, approve throws (IPC
  INTERNAL), and every later startup re-fails it. (b) Other order (clone applied first): `reconcileUnknown` throws the UNIQUE
  error for the original, and because the loop in `reconcile.ts:139-157` has no per-action catch, the whole pass aborts - every
  later `unknown_outcome` action (ORDER BY executed_at) is never reconciled, and `offerRetryForUnknown` offers clones for them.
- Proof: scratch tests `data-integrity-v4-4` (3 tests): first click answers `needs_confirm_drift` instead of `ACTION_STALE`;
  after confirm `{ thrown: 'UNIQUE constraint failed: event_revisions.calendar_event_id, event_revisions.revision',
  clone: 'executing', updates: 2 }`; `reconcileUnknown` throws the same error.
- Fix: the event's revision is `eventRevisions.newestFor(eventId).revision` (or the holder's `event_revision`): compute the new
  revision from it, compare `baseRevision` against it in approveUpdate and in the reconcile superseded guard, and supersede the
  pending retry clones of a chain when its root reconciles to `done`. Wrap each action of `reconcileUnknown` in try/catch.

### data-integrity-v4-5 (minor) - Restore original loses its extra reverts on any retry / reconcile path

- `actionExecutor.ts:1389` keeps `extraReverts` in the in-memory `undoExtras` map keyed by the FIRST action id; `runUpdate`
  reads it only for that id (`:689`). `reconcile.ts:266` always passes `extraReverts: []`, and a retry clone has a new id.
- Failure: Restore original over two automatic edits; the restore PATCH lands but times out (or the app crashes) -> reconcile
  (or "Apply again") commits it with only `revertOf` reverted. Automatic write #1 stays `undo_state='available'` and its
  revision `reverted_by NULL`, so it is the undo candidate again and AutoState counts it as undoable although Google already
  holds the original.
- Proof: scratch test `data-integrity-v4-5` -> `states ['available','undone']`, `reverted [false,true]`.
- Fix: persist the revert set in the undo payload (or recompute it at commit time from the revision chain: every unreverted
  automatic revision newer than the restore target), so reconcile and clones carry it.

### data-integrity-v4-6 (minor) - a v3 settings row that v1 tolerated aborts v4, and recovery opens an EMPTY database

- `migrations.ts:475-480` `UPDATE settings SET value_json = json_insert(value_json, ...)` raises `malformed JSON` on a
  non-JSON row. v1's `repos/settings.ts:13-23` explicitly tolerates such a row ("a hand-edited file, a restored backup ... falls
  back to DEFAULT_SETTINGS"), so a v0.1.x install can run with one.
- `db/backup.ts:117-136` `openDbWithRecovery`: MigrationError -> restore the newest backup = the pre-migration copy just taken
  -> same failure -> `moveAside` + `recovered: 'fresh'`.
- Failure: upgrading such an install moves `app.db` aside and starts with an empty database: every item, approval record, retry
  chain and consent disappears from the app (only `app.db.corrupt-<ts>` keeps them).
- Proof: scratch test `data-integrity-v4-6` -> `{ recovered: 'fresh', items: 0 }`.
- Fix: `... WHERE key = 'settings' AND json_valid(value_json) AND json_type(value_json) = 'object'` (the repo already falls back
  to defaults for anything else); and do not fall through to 'fresh' when the restored copy fails with the same MigrationError.

### data-integrity-v4-7 (minor) - Dismiss / "Never analyse" do not apply the v2 immediate retention

- ARCHITECTURE-v2 9.3: "`transcripts.text`, `proposals.delta_json/image_json` nulled and media-cache files unlinked ... at once
  on Dismiss / 'Never analyse'".
- `agent/items.ts:467-477` `dismiss` only supersedes actions and closes the item; `compose.ts:2001-2011` adds the media
  deletion. Nothing nulls the item's transcripts or its proposals' `delta_json` / `image_json`.
- `agent/items.ts:590-612` `setChatPolicy` ('never') deletes nothing - no media rows/files, no transcripts.
- Failure: the user marks a chat "Never analyse": its voice transcripts (text) and cached pictures stay until the 30-day job
  (and the pictures forever, see -1).
- Fix: in the same transaction as the dismiss / policy change, NULL `transcripts.text` for the chat's (item's) audio messages
  and the proposals' `delta_json` / `image_json`; on 'never' delete the chat's media_cache rows and unlink their files.

## Notes / dead ends

- `json_insert` with an absent intermediate group cannot happen for an app-written row (v1 always stores the full object).
- A pre-existing FK violation would also make v4 fail deterministically (`fk_violation` -> same 'fresh' path as -6), but v1
  always ran with `foreign_keys=ON`, so I found no way to produce one; not reported.
- `auto_writes` / `auto_decisions` cascade with the item on the 90-day purge, which would reset `countEditsOfEvent`; with the
  30-day auto horizon the event is past long before, so not reported.
