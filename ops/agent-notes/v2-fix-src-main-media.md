# v2-fix-src-main-media - fix notes (v2 phase 3, repair)

## data-integrity-v4-2 (minor) - FIXED

**Defect (confirmed, reproduced):** `media/mediaCache.ts` named the cache files `hash(<chatRef>|<waMsgId>)`. `chats.mergeLidInto()`
(`db/repos/chats.ts:137`) re-keys `media_cache.chat_id` to the surviving chat and does not touch the files. After an @lid merge,
`thumb()`/`dataUrl()` looked under `hash(target|msg)`, which does not exist, so the card lost its thumbnail and "View picture".
`deleteForItem()` (Dismiss) deleted the row but unlinked names that do not exist, so both real files stayed on disk with no row
naming them. The header comment ("an @lid merge deletes the row by FK cascade") was stale since V2-W1-01.

**Test first:** `src/main/media/mediaCache.test.ts`, new describe `createMediaCache across an @lid merge (data-integrity-v4-2)`:
1. Unit test over the in-memory repo: the row is re-keyed exactly as the merge does it. Thumb and full picture are unchanged, and
   deleteForItem leaves the directory empty. **Failed before the fix** (`{thumb:null, full:null}`).
2. End-to-end test over the real SQLite repos (`db/__fixtures__/testDb` memRepos + the real `mergeLidInto`): an @lid chat with a
   picture card merges into an existing phone-JID chat. **Failed before the fix** with `thumbAfterMerge: false`, which is the
   reviewer's `{thumbAfterMerge:false, deleted:1, filesLeft:2}`.
3. Guard for the new naming: a re-put of the same message with different bytes leaves no superseded files. It passed before,
   because the old name was content-independent. It is there so the fix cannot add a new orphan path.
The reviewer's scratch reproduction (`-t data-integrity-v4-2`) now passes.

**Fix:** the file name is now `sha256(<waMsgId>|<content sha256>)` (+ `.jpg` / `.thumb.jpg`). Both values are columns of the row and
nothing re-keys them, because the merge moves only `chat_id`. Details:
- New exported pure helper `mediaCacheFileNames(hash, {waMsgId, sha256}) -> [jpg, thumb]`, the single naming function.
  `jpgOf`/`thumbOf`/`unlink` derive from it.
- `put()`: when an existing row for (chat, msg) has a different `sha256`, its old files are unlinked after the new ones are
  written. The upsert overwrites `sha256`, so otherwise the old files would orphan.
- Header comment rewritten. Doc comments in `src/shared/types.ts` (MediaCacheRecord) and `src/main/paths.ts` (mediaCacheDir)
  updated to the new naming.
- B27 still holds: the name is a 64-hex hash only, with no JID, message id or contact text.
- Bonus: a merge-dropped duplicate row (same wa_msg_id already on the target, so `UPDATE OR IGNORE` skips it and the FK cascade
  deletes it) now names the SAME files as its survivor. Under the old scheme those files orphaned too.

**Why not the reviewer's alternatives:**
- *Store the file base in the row:* this needs a DDL change (new column + migration) and a frozen `MediaCacheRecord` shape change
  (v2-contracts wins on shapes). The derived name gives the same stability without either.
- *Rename after the merge commits:* the merge runs inside ingest's scan transaction. That would need a new fs hook across
  `bridge/ingest.ts` and the db layer, plus crash-consistency handling between COMMIT and the rename. That is a larger surface.
- *Name = content sha256 alone (`<sha256>.jpg`, which retention's old `mediaFileNames` assumed):* rejected. The same picture
  forwarded in two chats gives identical normalised bytes, so two rows would share one file. Dismissing or purging one row would
  then delete the other card's picture unless every unlink is refcounted, which needs a new repo query. Including `waMsgId` keeps
  the files of distinct messages distinct.

**Residual (accepted, documented):** two rows share files only if the SAME wa_msg_id with IDENTICAL bytes exists under two chats at
once. That is the pre-merge @lid/phone duplicate, and the merge resolves it by dropping one row. If the user Dismisses one of those two
cards before the merge, the other card loses its thumbnail. No data is lost (the bridge still has the media, and a re-triage re-puts
the picture). No legacy fallback for files written under the old name: v2 has not shipped, so no installed build wrote them.
`data:purgeNow` wipes the directory anyway.

## CROSS-AGENT CONFLICT - needs the orchestrator (data-integrity-v4-1, retention)

While I worked, `v2-fix-src-main-db` was editing `src/main/db/repos/retention.ts` for data-integrity-v4-1. Their in-progress
version rebuilds the file names as `sha256Hex(\`${chat_id}|${wa_msg_id}\`)`, which is the OLD cache naming. That scheme is itself
broken by v4-2: after an @lid merge, retention would compute `hash(target|msg)` for files written under `hash(lid|msg)`.

After both fixes land, `src/main/db/retention.test.ts` > "retention x media/mediaCache - one naming convention
(data-integrity-v4-1)" FAILS, by design: it drives the real `createMediaCache`, so it catches the drift. Observed during my run:
3 failures in retention.test.ts. Two of them were the db fixer's not-yet-updated `<sha256>.jpg` assertions, and one is this drift.

**Recommended reconciliation:**
1. In `retention.ts`, SELECT `wa_msg_id, sha256` instead of `chat_id, wa_msg_id`.
2. Build the names with `mediaCacheFileNames(sha256Hex, { waMsgId: m.wa_msg_id, sha256: m.sha256 })` from `media/mediaCache.ts`,
   or keep a local `mediaFileNames(waMsgId, sha256)` that hashes `` `${waMsgId}|${sha256}` ``.
3. In the drift test, expect `young = sha(\`IMGMSG0002|${picture.sha256}\`)`.

compose passes `hash: (text) => sha256Hex(text)` to the cache (compose.ts ~1352), so `sha256Hex` from `db/repos/actions` produces
identical names. I did NOT edit retention.ts / retention.test.ts: another agent owns them and was mid-edit.

## Verification
- `npx vitest run src/main/media src/main/db tests/integration/pipeline-image.test.ts src/main/ipc/handlers/data.test.ts`: before
  the db fixer's concurrent retention edits, 24 files / 333 tests passed. The later run shows only the retention conflict above.
- `npx eslint` on every file I touched: clean. `npm run lint` overall: 4 errors, all in `tests/integration/auto-mode.flow.test.ts`
  (another agent's in-flight file, not mine).
- `npm run typecheck`: no error in my files. The errors present are in retention.ts / llm/cli (other agents mid-edit).
- `prettier --check` on my files: clean.
- Full `npx vitest run`: 7411 passed, 52 failed. Apart from the retention drift test, every failure is in another agent's area under
  concurrent edit: golden.v2 auto pass, auto-mode.flow, items.v2 (UNIQUE items.chat_id / transcripts, which mock the media cache),
  orchestrator.v2, resolveDelta, validate.v2, jobRunner.orphans. None of them reads the cache file naming.

## Files touched
- src/main/media/mediaCache.ts (fix + header)
- src/main/media/mediaCache.test.ts (3 new tests; the 2 existing name assertions moved from `sha('7|<msg>')` to
  `sha('<msg>|<content sha>')`. This is the spec change itself, not a weakening: both still assert the exact file list.)
- src/shared/types.ts, src/main/paths.ts (doc comments only)
- Spec text `docs/specs/v2-contracts.md:704` and ARCHITECTURE-v2 B19 still say `sha256(chatJid|waMsgId)`. Those docs are the
  orchestrator's to amend. Suggested wording: `<sha256(waMsgId|contentSha256)>.jpg` (stable across an @lid merge).
