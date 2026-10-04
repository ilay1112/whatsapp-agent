// src/main/db/repos/retention.ts - Repos['retention'] implementation over the Db wrapper (owner W1-04; v2 delta V2-W1-01-db).
// Signatures: CONTRACTS 15.1; v2 behaviour C2 16.1 / 16.3 + ARCHITECTURE-v2 9.3.
// What retention does NOT do: it never deletes a hash (`item_messages.text_sha256`, `actions.content_sha256`, `media_cache.sha256`
// stay until their row goes) and it never touches a non-terminal action - `trg_actions_frozen` would abort the statement, which is
// exactly the intended guard. `auto_policies` are never purged (they are the consent history of automatic mode).
import { LIMITS } from '../../../shared/types';
import type { Db, Repos } from '../index';
import { CLOSED_ITEM_MAX_AGE_MS } from '../retention';
import { TERMINAL_ACTION_STATES } from './actions';

export type RetentionRepo = Repos['retention'];

const TERMINAL_LIST = TERMINAL_ACTION_STATES.map((s) => `'${s}'`).join(',');

/** The files media/mediaCache.ts keeps for one media_cache row (C2 1.4: `<sha256>.jpg` + `<sha256>.thumb.jpg`), bare names only. */
export function mediaFileNames(sha256: string): string[] {
  return [`${sha256}.jpg`, `${sha256}.thumb.jpg`];
}

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
          .prepare<{ sha256: string }>(
            `SELECT sha256 FROM media_cache WHERE created_at < ? ORDER BY created_at, wa_msg_id`,
          )
          .all(p.before);
        db.prepare(`DELETE FROM media_cache WHERE created_at < ?`).run(p.before);
        // Closed items go completely, with their messages, proposals, runs, actions, revisions and decisions (ON DELETE CASCADE).
        const itemsDeleted = db
          .prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < ?`)
          .run(p.closedBefore).changes;
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
          mediaFiles: media.flatMap((m) => mediaFileNames(m.sha256)),
          revisionRows,
          autoWritesDeleted,
          autoDecisionsDeleted,
        };
      });
    },
  };
}
