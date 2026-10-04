// src/main/db/repos/retention.ts - Repos['retention'] implementation over the Db wrapper (owner W1-04; v2 delta V2-W1-01-db).
// Signatures: CONTRACTS 15.1; v2 behaviour C2 16.1 / 16.3 + ARCHITECTURE-v2 9.3.
// What retention does NOT do: it never deletes a hash (`item_messages.text_sha256`, `actions.content_sha256`, `media_cache.sha256`
// stay until their row goes) and it never touches a non-terminal action - `trg_actions_frozen` would abort the statement, which is
// exactly the intended guard. `auto_policies` are never purged (they are the consent history of automatic mode).
import { LIMITS, type Sha256Hex } from '../../../shared/types';
import { mediaCacheFileNames } from '../../media/mediaCache';
import type { Db, Repos } from '../index';
import { CLOSED_ITEM_MAX_AGE_MS } from '../retention';
import { sha256Hex, TERMINAL_ACTION_STATES } from './actions';
import { MEDIA_CACHE_COLUMNS, type MediaCacheRow, toMediaCache } from './rows';

export type RetentionRepo = Repos['retention'];

const TERMINAL_LIST = TERMINAL_ACTION_STATES.map((s) => `'${s}'`).join(',');

/**
 * [v2-fix-src-main-db, data-integrity-v4-1] The files media/mediaCache.ts keeps for one purged media_cache row, bare names only.
 * They come from the cache's OWN naming function with the hash compose wires into the cache (`sha256Hex(text)`), never re-derived
 * here: the old `<media_cache.sha256>.jpg` names never matched what the cache wrote, so the daily job deleted the rows, unlinked
 * files that did not exist (rmSync force) and left both pictures on disk with no row naming them.
 */
const cacheHash = (text: string): Sha256Hex => sha256Hex(text) as Sha256Hex;

/**
 * [v2-fix-src-main-db, data-integrity-v4-3] The ids of every item the 90-day closed-item rule must keep: the items it does not
 * select at all (open, or closed after `closedBefore`), plus - transitively - every item one of them still depends on:
 *   - its `event_origin_item_id` (I9 / F27: the chain root whose id is the event's `waItem` tag - ownershipOf needs the row),
 *   - its `linked_item_id` (B20: the source a change card acts for),
 *   - for an `in_calendar` item, every item holding the same `calendar_event_id` (the event's revision rows hang off them).
 * Without this, `ON DELETE SET NULL` nulled the live holder's origin / link and its own still-live event read as foreign
 * (CAL_EVENT_FOREIGN on cancel / reschedule / undo; tryAuto 'wrong_item'), and the cascade removed the event's revision history.
 */
const KEPT_ITEMS_CTE = `
  WITH RECURSIVE kept(id) AS (
    SELECT id FROM items WHERE closed_at IS NULL OR closed_at >= ?
    UNION
    SELECT dep.id
      FROM kept k
      JOIN items h ON h.id = k.id
      JOIN items dep ON dep.id = h.event_origin_item_id
                     OR dep.id = h.linked_item_id
                     OR (h.state = 'in_calendar' AND h.calendar_event_id IS NOT NULL
                         AND dep.calendar_event_id = h.calendar_event_id)
  )`;

export function createRetentionRepo(db: Db): RetentionRepo {
  return {
    /**
     * One transaction. Text rule (`before` = now - privacy.retentionDays; 0 days for data:purgeNow): item_messages.text, the
     * proposal payloads incl. [V2] delta_json / image_json, [V2] transcripts.text, terminal actions' payloads, and [V2] media_cache
     * rows (their file names are returned; the CALLER unlinks them). Closed items older than `closedBefore` go completely.
     * [V2] Fixed horizons (independent of retentionDays): event_revisions prev/next JSON after LIMITS.revisionJsonRetentionMs,
     * auto_writes after LIMITS.autoWritesRetentionMs, auto_decisions after LIMITS.autoDecisionsRetentionMs unless a remaining
     * auto_writes row still references them. The frozen signature carries no clock, so "now" for these horizons is recovered from
     * `closedBefore`, which the contract defines as now - 90 d (db/retention.ts CLOSED_ITEM_MAX_AGE_MS).
     */
    purge(p) {
      const now = p.closedBefore + CLOSED_ITEM_MAX_AGE_MS;
      return db.transaction(() => {
        const messageRows = db
          .prepare(`UPDATE item_messages SET text = NULL WHERE text IS NOT NULL AND ts < ?`)
          .run(p.before).changes;
        const proposalRows = db
          .prepare(
            `UPDATE proposals SET draft_text = NULL, extraction_json = NULL, event_json = NULL, freebusy_json = NULL,
                                  delta_json = NULL, image_json = NULL
               WHERE created_at < ?
                 AND (draft_text IS NOT NULL OR extraction_json IS NOT NULL OR event_json IS NOT NULL OR freebusy_json IS NOT NULL
                      OR delta_json IS NOT NULL OR image_json IS NOT NULL)`,
          )
          .run(p.before).changes;
        const transcriptRows = db
          .prepare(`UPDATE transcripts SET text = NULL WHERE text IS NOT NULL AND created_at < ?`)
          .run(p.before).changes;
        // Counted once per row even though the two columns are nulled by two statements (the frozen triggers fire per column list).
        const actionRows = db
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM actions
               WHERE created_at < ? AND state IN (${TERMINAL_LIST})
                 AND (canonical_json IS NOT NULL OR approved_final_json IS NOT NULL)`,
          )
          .get(p.before)!.n;
        db.prepare(
          `UPDATE actions SET canonical_json = NULL WHERE created_at < ? AND state IN (${TERMINAL_LIST}) AND canonical_json IS NOT NULL`,
        ).run(p.before);
        db.prepare(
          `UPDATE actions SET approved_final_json = NULL
             WHERE created_at < ? AND state IN (${TERMINAL_LIST}) AND approved_final_json IS NOT NULL`,
        ).run(p.before);
        // [V2] media_cache rows go with the text; their files are named from the row, so collect the names BEFORE the delete.
        const media = db
          .prepare<MediaCacheRow>(
            `SELECT ${MEDIA_CACHE_COLUMNS} FROM media_cache WHERE created_at < ? ORDER BY created_at, wa_msg_id`,
          )
          .all(p.before)
          .map(toMediaCache);
        db.prepare(`DELETE FROM media_cache WHERE created_at < ?`).run(p.before);
        // Closed items go completely, with their messages, proposals, runs, actions, revisions and decisions (ON DELETE CASCADE) -
        // except the ones a kept item still depends on (KEPT_ITEMS_CTE); they go together with the last item that needs them.
        const itemsDeleted = db
          .prepare(
            `${KEPT_ITEMS_CTE}
             DELETE FROM items
              WHERE closed_at IS NOT NULL AND closed_at < ?
                AND id NOT IN (SELECT id FROM kept)`,
          )
          .run(p.closedBefore, p.closedBefore).changes;
        // [V2] fixed horizons. Order matters: auto_writes first, so a decision is kept exactly while a write still references it.
        const revisionRows = db
          .prepare(
            `UPDATE event_revisions SET prev_json = NULL, next_json = NULL
               WHERE applied_at < ? AND (prev_json IS NOT NULL OR next_json IS NOT NULL)`,
          )
          .run(now - LIMITS.revisionJsonRetentionMs).changes;
        const autoWritesDeleted = db
          .prepare(`DELETE FROM auto_writes WHERE written_at < ?`)
          .run(now - LIMITS.autoWritesRetentionMs).changes;
        const autoDecisionsDeleted = db
          .prepare(
            `DELETE FROM auto_decisions
               WHERE decided_at < ? AND NOT EXISTS (SELECT 1 FROM auto_writes w WHERE w.decision_id = auto_decisions.id)`,
          )
          .run(now - LIMITS.autoDecisionsRetentionMs).changes;
        return {
          textRows: messageRows + proposalRows,
          actionRows,
          itemsDeleted,
          transcriptRows,
          mediaFiles: media.flatMap((m) => mediaCacheFileNames(cacheHash, m)),
          revisionRows,
          autoWritesDeleted,
          autoDecisionsDeleted,
        };
      });
    },
  };
}
