// src/main/db/repos/autoWrites.ts - Repos['autoWrites'] (C2 16.1, [V2 ADD]; owner V2-W1-01-db).
// auto_writes is the automatic-write ledger over event_revisions (B10). A row can only be inserted for an 'auto' decision of the
// same action (trg_auto_writes_insert); after the insert only the bookkeeping columns (revision_id, post_*, undo_state,
// undo_action_id) change (trg_auto_writes_frozen). pre_json is the pre-flight snapshot written in the write-ahead transaction (I8).
import { AUTO_UNDO_STATES, AUTO_WRITE_KINDS } from '../../../shared/types';
import { RepoContractError, RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { AUTO_WRITE_COLUMNS, type AutoWriteRow, toAutoWrite } from './rows';

export type AutoWritesRepo = Repos['autoWrites'];

export function createAutoWritesRepo(db: Db): AutoWritesRepo {
  const byId = (id: string): ReturnType<AutoWritesRepo['byId']> => {
    const row = db.prepare<AutoWriteRow>(`SELECT ${AUTO_WRITE_COLUMNS} FROM auto_writes WHERE id = ?`).get(id);
    return row ? toAutoWrite(row) : null;
  };
  const mustChange = (changes: number, id: string): void => {
    if (changes !== 1) throw new RowNotFoundError('auto_writes', id);
  };

  return {
    /** Born 'available', no readback yet. The DDL ties kind 'create' to a NULL pre snapshot and bounds undo_until to 72 h. */
    insert(r) {
      if (!(AUTO_WRITE_KINDS as readonly string[]).includes(r.kind))
        throw new RepoContractError('unknown auto write kind');
      db.prepare(
        `INSERT INTO auto_writes(id, decision_id, action_id, item_id, event_id, kind, pre_json, revision_id, post_etag, post_updated,
                                 post_sequence, undo_state, undo_until, undo_action_id, written_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'available', ?, NULL, ?)`,
      ).run(
        r.id,
        r.decisionId,
        r.actionId,
        r.itemId,
        r.eventId,
        r.kind,
        r.pre === null ? null : JSON.stringify(r.pre),
        r.undoUntil,
        r.writtenAt,
      );
      return byId(r.id)!;
    },

    /** The readback after a successful write: the revision row and Google's etag / updated / sequence (the undo drift baseline). */
    recordReadback(id, p) {
      mustChange(
        db
          .prepare(
            `UPDATE auto_writes SET revision_id = ?, post_etag = ?, post_updated = ?, post_sequence = ? WHERE id = ?`,
          )
          .run(p.revisionId, p.postEtag, p.postUpdated, p.postSequence, id).changes,
        id,
      );
    },

    /** Undo bookkeeping; an omitted undoActionId keeps the stored one. */
    setUndo(id, p) {
      if (!(AUTO_UNDO_STATES as readonly string[]).includes(p.undoState))
        throw new RepoContractError('unknown undo state');
      mustChange(
        db
          .prepare(`UPDATE auto_writes SET undo_state = ?, undo_action_id = COALESCE(?, undo_action_id) WHERE id = ?`)
          .run(p.undoState, p.undoActionId ?? null, id).changes,
        id,
      );
    },

    byId,

    /** Writes at or after `ts`, newest first (AutoStrip / activity page). */
    since(ts) {
      return db
        .prepare<AutoWriteRow>(
          `SELECT ${AUTO_WRITE_COLUMNS} FROM auto_writes WHERE written_at >= ? ORDER BY written_at DESC, rowid DESC`,
        )
        .all(ts)
        .map(toAutoWrite);
    },

    /** edit_budget (B9): automatic changes (update + cancel) ever written to this event. */
    countEditsOfEvent(eventId) {
      return db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM auto_writes WHERE event_id = ? AND kind IN ('update','cancel')`,
        )
        .get(eventId)!.n;
    },

    /**
     * Circuit breaker (B10: 2 undos / 24 h pause the policy): automatic writes in state 'undone' whose undo happened at or after `ts`.
     * The table keeps no undo timestamp, so the undo action's own clock is used (executed_at, else approved_at, else created_at);
     * a row without an undo action falls back to its written_at (an undo is never earlier than the write).
     */
    undosSince(ts) {
      return db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM auto_writes w LEFT JOIN actions u ON u.id = w.undo_action_id
             WHERE w.undo_state = 'undone' AND COALESCE(u.executed_at, u.approved_at, u.created_at, w.written_at) >= ?`,
        )
        .get(ts)!.n;
    },
  };
}
