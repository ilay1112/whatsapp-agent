// src/main/db/repos/retention.ts - Repos['retention'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// What retention does NOT do: it never deletes a hash (`item_messages.text_sha256`, `actions.content_sha256` stay) and it never
// touches a non-terminal action - `trg_actions_frozen` would abort the statement, which is exactly the intended guard.
import type { Db, Repos } from '../index';
import { TERMINAL_ACTION_STATES } from './actions';

export type RetentionRepo = Repos['retention'];

const TERMINAL_LIST = TERMINAL_ACTION_STATES.map((s) => `'${s}'`).join(',');

export function createRetentionRepo(db: Db): RetentionRepo {
  return {
    purge(p) {
      return db.transaction(() => {
        const messageRows = db
          .prepare(`UPDATE item_messages SET text = NULL WHERE text IS NOT NULL AND ts < ?`)
          .run(p.before).changes;
        const proposalRows = db
          .prepare(
            `UPDATE proposals SET draft_text = NULL, extraction_json = NULL, event_json = NULL, freebusy_json = NULL
               WHERE created_at < ?
                 AND (draft_text IS NOT NULL OR extraction_json IS NOT NULL OR event_json IS NOT NULL OR freebusy_json IS NOT NULL)`,
          )
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
        // Closed items go completely, with their messages, proposals, runs and actions (ON DELETE CASCADE).
        const itemsDeleted = db
          .prepare(`DELETE FROM items WHERE closed_at IS NOT NULL AND closed_at < ?`)
          .run(p.closedBefore).changes;
        return { textRows: messageRows + proposalRows, actionRows, itemsDeleted };
      });
    },
  };
}
