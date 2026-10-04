# v2-fix-src-main-db - repair of three confirmed `src/main/db` defects (v2 phase 3)

Status: **all three fixed.** Each fix has a test that was red before it and is green after it. None of the three findings was wrong.
No new dependency, no version change, no commit.

## data-integrity-v4-3 (major): retention deleted the ORIGIN item of a still-live event

**Cause (confirmed).** `repos/retention.ts` ran `DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < ?`. A superseded source
card is closed while the change card that took the event over is still `in_calendar`. Events can be up to 12 months ahead. After 90
days the source was deleted, and `ON DELETE SET NULL` cleared the holder's `event_origin_item_id` and `linked_item_id`. From then on,
`ownershipOf` returned `foreign` for the app's own event. The cascade also removed the rev-1 `event_revisions` row.

**Fix.** The DELETE now skips the ids in a recursive CTE, `KEPT_ITEMS_CTE`. The kept set starts with the items the 90-day rule does
not select: open items, and items closed after `closedBefore`. It then adds, transitively, every item a kept item depends on:
- the item its `event_origin_item_id` points at (I9/F27 chain root);
- the item its `linked_item_id` points at (B20 source);
- for an `in_calendar` item, every item holding the same `calendar_event_id` (the event's revision rows hang off them).

A dependent item is deleted in the same purge as the last item that needs it. This is the reviewer's proposed fix, plus one change:
I made it transitive, so that a chain origin <- superseded middle <- holder stays consistent.

**Tests.**
- `src/main/db/retention.test.ts`, block "retention keeps the closed items a live event still depends on". It has 5 cases: holder ->
  origin, the 3-item chain, the shared event id with no link column, the chain deleted once the holder ages out (plus an unrelated
  item still deleted), and a young closed holder that keeps the origin until the holder ages out.
- `tests/security/retention-event-origin.test.ts` (new, I9). It runs the full click path through the real executor, the fake
  calendar and the ledger. The event is rescheduled, then purged 91 days later, then cancelled. The result is `done` and the event
  is no longer `confirmed`.
- Mutation check: with the NOT IN guard disabled, all 5 new cases that need it go red (4 unit cases and the security test). The
  "chain deleted" case is green either way, as intended.

## data-integrity-v4-1 (major): retention returned media file names the cache never writes

**Cause (confirmed).** Retention named the files after the `media_cache.sha256` column, which holds the image-content hash. The cache
names its files after a hash of the row key. `rmSync(force)` silently did nothing, the rows were gone, and both files stayed on disk
forever.

**Concurrent change.** While I was working, the data-integrity-v4-2 fixer (src/main/media) changed the cache naming to
`hash(waMsgId|sha256)` and exported `mediaCacheFileNames(hash, row)` "so any other code that has to unlink a row's files ... uses
this one naming function".

**Fix.** Retention no longer derives any name itself. It selects the full purged rows (`MEDIA_CACHE_COLUMNS` / `toMediaCache`) and
returns `mediaCacheFileNames(sha256Hex, row)`. That is the cache's own function, with the same hash `compose.ts` wires into the cache.
`compose.ts` is unchanged: it still unlinks plain names under `paths.mediaCacheDir`. The old exported `mediaFileNames(sha256)` is
removed. Its only user was retention.ts.

**Tests.**
- New block "retention x media/mediaCache - one naming convention". It drives the REAL `createMediaCache` on a temp dir with two
  pictures (one old, one young) and runs `runRetention`. It then applies the compose unlink loop verbatim and asserts that exactly the
  young picture's two files remain and that it is still readable through `cache.thumb`. The test never re-derives a name, so it holds
  whatever the cache's convention is.
- Two existing tests (retention.test.ts, "deletes old media_cache rows ..." and "daily: returns the purged media file names ...")
  asserted `'<sha256 column>.jpg'`. That pinned the defect. They now expect `mediaCacheFileNames(cacheSha, row)`, and the first one
  also asserts that the old name is NOT returned. This is a correction to the expected value, not a weakening.

**Layering.** The db layer now imports one pure function from media. `media/mediaCache.ts` imports only a type from `db/index`, so
there is no runtime cycle. Neither eslint nor the import-graph test restricts db -> media.

## data-integrity-v4-6 (minor): a non-JSON v3 settings row aborted v4, and recovery opened an EMPTY database

**Cause (confirmed).** Step 11's `json_insert` raised `malformed JSON`, but v1's settings repo explicitly tolerates such a row.
`openDbWithRecovery` then restored the pre-migration backup, which is the same file, so it failed again. The code then fell through
to moveAside and a fresh database.

**Fix, part 1 (migrations.ts step 11).**
`AND CASE WHEN json_valid(value_json) THEN json_type(value_json) = 'object' ELSE 0 END`. I used CASE rather than a plain AND because
SQLite does not promise short-circuit evaluation. A row that is not a JSON object is left untouched, and the repo reads it as
DEFAULT_SETTINGS, exactly as in v1. JSON arrays and strings were already a no-op for json_insert. They are pinned as regressions too.

**Fix, part 2 (backup.ts `openDbWithRecovery`).** A MigrationError never ends in `fresh`:
- **The restored copy also fails with a MigrationError.** The restored copy is dropped; it is only a copy of a backup that stays in
  backupsDir. If the first failure was also a MigrationError (the original file is intact, because the migration is one
  transaction), the original is renamed back from `.corrupt-<ts>` (`putBack`). The MigrationError is then thrown.
- **A MigrationError with no backup to try.** It is thrown, and the file is untouched.
- **Corrupt file + corrupt backup.** This still starts empty, as before (the existing tests pass unchanged).

**Tests.**
- `src/main/db/migrations.v4.test.ts`: `it.each` over not-JSON, array and string. Each checks that the file migrates to v4, every
  v3 table keeps its row, the settings row is unchanged, and `createRepos(db).settings.get()` equals DEFAULT_SETTINGS. The not-JSON
  case was red before the fix.
- `src/main/db/backup.test.ts`: "a migration that fails on the file AND on its backup". This uses a deterministic step-1 failure: a
  v3 file where `auto_policies` already exists.
  - With a backup: it throws MigrationError, `app.db` is the original v3 file with its item, the backup is kept, and no `.corrupt-`
    file is left behind.
  - Without a backup: it throws, and the file is untouched.
  - Both were red before the fix (one returned `fresh`, the other leaked a handle and did not throw).
- `tests/security/migration-v4.test.ts`: the table row "the real openDb() path fails at step 11 (malformed settings JSON)" asserted
  the defect itself, so I removed it and left a comment in its place. In the same describe I added "the real openDb() path MIGRATES a
  v3 file whose settings row is not JSON", using the committed v3 fixture. Step 11's abort and rollback stay covered by the existing
  per-statement injection `it.each` (abort after every statement k, including step 11).

## REQUESTS for the orchestrator

1. **index.ts must surface the thrown MigrationError.** `openDbWithRecovery` can now THROW a MigrationError (by design: the blocking
   DB_RECOVERY). `compose()` does not catch it, and `src/main/index.ts` runs `app.whenReady().then(async ...)` with no `.catch`. The
   result is an unhandled rejection and no window. Someone owning index.ts should catch it and show a blocking error dialog
   ("Your data could not be upgraded; it is untouched at <userData>\app.db - update the app or contact support"), then quit. I did not
   touch index.ts: it is outside my scope and another lane edits it.
2. **ARCHITECTURE section 10 / migrations.ts runner comment.** These still say "Any error => ... restore newest backup", with the
   fall-through to empty. Consider a DECISIONS entry: "a MigrationError never starts an empty database; it blocks with DB_RECOVERY".
3. **The cache naming doc is now stale.** C2 1.4 / B19 / the v2-contracts.md row comment say `<sha256(chatJid|waMsgId)>.jpg`. Since
   the v4-2 fix, the cache uses `hash(waMsgId|sha256)`. The docs need that update (the v4-2 fixer may already report it).

## Verification

- `npx vitest run src/main/db tests/security/migration-v4.test.ts src/main/media`: 23 files, 402 tests, all green.
- `tests/security/retention-event-origin.test.ts`: green.
- Reviewer scratch (`ops/agent-notes/v2-review-data-integrity-v4.scratch`): v4-1, v4-3 and v4-6 are now green. 7 of 8 pass. The one
  still red is a v4-4 case (exec, not mine).
- ESLint over src/main/db and my test files: clean. Full `npm run lint` shows only `src/main/exec/actionExecutor.v2fix.test.ts`
  (no-restricted-imports) and `src/renderer/src/App.tsx` (set-state-in-effect). Neither is mine; other lanes are editing them.
- Typecheck: no error in any file I touched. Full `npm run typecheck` currently fails on `src/main/llm/cli/runner.ts` (TS2783
  duplicate env keys) and `src/renderer/src/views/settings/ReadTools.test.tsx:149`. Both are other lanes' in-flight work.
- Prettier: my files are clean (`--write` on backup.test.ts and migrations.v4.test.ts, which touched only my hunks).
- Full `npx vitest run`, twice. The failing sets were different each time and came from other lanes' in-flight edits
  (exec/v2fix, llm/cli runner, bridge/waReadClient, agent/waTools, renderer). None of them was in db, retention, migration or
  backup.
  - `tests/security/media-text-isolation.test.ts` was red in one full run.
  - In isolation it is green both with and without my changes: I checked by temporarily restoring HEAD's three db files, then put my
    versions back. So that failure was load/timing, not caused by this fix.
