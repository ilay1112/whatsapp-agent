// src/main/db/repos/eventRevisions.ts - Repos['eventRevisions'] (C2 16.1, [V2 ADD]; owner V2-W1-01-db).
// event_revisions is the ONLY previous-version store (B10). Rows are append-only (trg_event_rev_frozen): after the insert only the
// bookkeeping columns reverted_by / post_etag / post_updated may change, and prev_json / next_json are NULLed by retention.
// Undo is defined over the revision CHAIN (F1): see undoCandidate() and unrevertedAutoSpan().
import { EventContentWithStatusSchema } from '../../../shared/schemas';
import { REVISION_KINDS } from '../../../shared/types';
import type * as T from '../../../shared/types';
import { RepoContractError, RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { EVENT_REVISION_COLUMNS, type EventRevisionRow, toEventRevision } from './rows';

export type EventRevisionsRepo = Repos['eventRevisions'];

/** Every revision of one event, newest first (ux_event_rev makes `revision` unique per event). */
const newestFirst = (db: Db, calendarEventId: string): T.EventRevisionRecord[] =>
  db
    .prepare<EventRevisionRow>(
      `SELECT ${EVENT_REVISION_COLUMNS} FROM event_revisions WHERE calendar_event_id = ? ORDER BY revision DESC`,
    )
    .all(calendarEventId)
    .map(toEventRevision);

export function createEventRevisionsRepo(db: Db): EventRevisionsRepo {
  const byId = (id: number): T.EventRevisionRecord | null => {
    const row = db
      .prepare<EventRevisionRow>(`SELECT ${EVENT_REVISION_COLUMNS} FROM event_revisions WHERE id = ?`)
      .get(id);
    return row ? toEventRevision(row) : null;
  };
  const contentJson = (c: T.EventRevisionRecord['prev']): string | null =>
    c === null ? null : JSON.stringify(EventContentWithStatusSchema.parse(c));

  return {
    /** revision = items.event_revision after the write (the caller's value; ux_event_rev rejects a duplicate, the DDL CHECK ties
     *  revision 1 to kind 'create'). prev/next are validated before they are stored. */
    insert(r) {
      if (!(REVISION_KINDS as readonly string[]).includes(r.kind)) throw new RepoContractError('unknown revision kind');
      const info = db
        .prepare(
          `INSERT INTO event_revisions(calendar_event_id, item_id, revision, kind, prev_json, next_json, action_id, applied_at,
                                       reverted_by, post_etag, post_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          r.calendarEventId,
          r.itemId,
          r.revision,
          r.kind,
          contentJson(r.prev),
          contentJson(r.next),
          r.actionId,
          r.appliedAt,
          r.postEtag,
          r.postUpdated,
        );
      return byId(info.lastInsertRowid)!;
    },

    /** The app's last write to the event: its post_* is the drift baseline of the next change / undo (F1/F5). */
    newestFor(calendarEventId) {
      return newestFirst(db, calendarEventId)[0] ?? null;
    },

    byId,

    /** [F1] The newest non-'undo' revision that is not reverted, such that EVERY newer revision is reverted or an 'undo' row. Walking
     *  newest-first, rows that are reverted or 'undo' are skipped; the first other row is the candidate. null when none is left. */
    undoCandidate(calendarEventId) {
      for (const r of newestFirst(db, calendarEventId)) {
        if (r.kind === 'undo' || r.revertedBy !== null) continue;
        return r;
      }
      return null;
    },

    /**
     * [F1] "Restore original": the automatic writes (a revision whose action has an auto_writes row) that are not reverted and are
     * NEWER than the newest revision approved by the user ('user' or 'user_toast'), oldest first. The first entry's prev is the
     * restore target; an empty list means there is nothing automatic to restore.
     */
    unrevertedAutoSpan(calendarEventId) {
      return db
        .prepare<EventRevisionRow>(
          `SELECT ${EVENT_REVISION_COLUMNS} FROM event_revisions r
             WHERE r.calendar_event_id = ?
               AND r.reverted_by IS NULL
               AND EXISTS (SELECT 1 FROM auto_writes w WHERE w.action_id = r.action_id)
               AND r.revision > COALESCE((SELECT MAX(u.revision) FROM event_revisions u JOIN actions a ON a.id = u.action_id
                                            WHERE u.calendar_event_id = r.calendar_event_id
                                              AND a.approved_by IN ('user','user_toast')), 0)
             ORDER BY r.revision ASC`,
        )
        .all(calendarEventId)
        .map(toEventRevision);
    },

    /** UPDATE ... SET reverted_by WHERE reverted_by IS NULL: the first undo wins, a second call is a no-op; an unknown id throws. */
    markReverted(id, byRevisionId) {
      const changes = db
        .prepare(`UPDATE event_revisions SET reverted_by = ? WHERE id = ? AND reverted_by IS NULL`)
        .run(byRevisionId, id).changes;
      if (changes === 0 && byId(id) === null) throw new RowNotFoundError('event_revisions', id);
    },
  };
}
