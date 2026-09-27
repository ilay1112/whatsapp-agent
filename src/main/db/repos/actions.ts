// src/main/db/repos/actions.ts - Repos['actions'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// Every write is a compare-and-set on the OLD state; the frozen triggers of CONTRACTS 15.2 are the second line of defence.
import { createHash, randomUUID } from 'node:crypto';
import { ActionPayloadSchema, canonicalJson } from '../../../shared/schemas';
import type { ActionPayload } from '../../../shared/schemas';
import { LIMITS } from '../../../shared/types';
import type * as T from '../../../shared/types';
import { ActionStateError, RepoContractError, RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { ACTION_COLUMNS, type ActionRow, toAction } from './rows';

export type ActionsRepo = Repos['actions'];

/** States in which `trg_actions_frozen` permits the retention NULLing of `canonical_json` (CONTRACTS 15.2). */
export const TERMINAL_ACTION_STATES = [
  'done',
  'failed',
  'rejected',
  'expired',
  'superseded',
  'unknown_outcome',
] as const;

/** `${itemId}:${kind}:${proposalVersion}` - the chain root key; retry clones append `:r${attempt}` (CONTRACTS 14 `[R2]`). */
export function chainKeyOf(payload: ActionPayload): string {
  return `${payload.itemId}:${payload.kind}:${payload.proposalVersion}`;
}
/** Strips the `:rN` retry suffix, so every clone of a chain maps to the same key (and therefore the same deterministic eventId). */
export function stripRetrySuffix(idempotencyKey: string): string {
  return idempotencyKey.replace(/:r\d+$/, '');
}
export function sha256Hex(utf8: string): string {
  return createHash('sha256').update(utf8, 'utf8').digest('hex');
}

const selectById = (db: Db, id: T.ActionId): T.ApprovalAction | null => {
  const row = db.prepare<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM actions WHERE id = ?`).get(id);
  return row ? toAction(row) : null;
};

/** node:sqlite raises ERR_SQLITE_ERROR for a RAISE(ABORT) in a trigger; the CAS helpers map that to 'stale', never to a crash. */
function isSqliteError(e: unknown): boolean {
  return e instanceof Error && (e as { code?: string }).code === 'ERR_SQLITE_ERROR';
}
class CasMiss extends Error {}

export function createActionsRepo(db: Db): ActionsRepo {
  const casExecuting = (id: T.ActionId, sql: string, params: Array<string | number | null>, expected: string): void => {
    const changes = db.prepare(sql).run(...params, id).changes;
    if (changes !== 1) throw new ActionStateError(id, expected, changes);
  };

  return {
    insertPending(p) {
      const payload = ActionPayloadSchema.parse(p.payload);
      if (payload.itemId !== p.itemId) throw new RepoContractError('action payload itemId does not match the row');
      if (payload.chatRef !== p.chatId)
        throw new RepoContractError('action payload chatRef does not match the pinned chat');
      return db.transaction(() => {
        let attempt = 1;
        let key = chainKeyOf(payload);
        if (p.retryOf !== undefined) {
          const previous = selectById(db, p.retryOf);
          if (!previous) throw new RowNotFoundError('actions', p.retryOf);
          attempt = previous.attempt + 1;
          key = `${stripRetrySuffix(previous.idempotencyKey)}:r${attempt}`;
        }
        const canonical = canonicalJson(payload);
        const id = randomUUID();
        db.prepare(
          `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key,
                               attempt, retry_of, state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          id,
          p.itemId,
          p.proposalId,
          p.chatId,
          payload.kind,
          canonical,
          sha256Hex(canonical),
          key,
          attempt,
          p.retryOf ?? null,
          p.now,
          p.now + LIMITS.actionTtlMs,
        );
        return selectById(db, id)!;
      });
    },

    byId(id) {
      return selectById(db, id);
    },

    forItem(itemId) {
      return db
        .prepare<ActionRow>(
          `SELECT ${ACTION_COLUMNS} FROM actions WHERE item_id = ? ORDER BY created_at ASC, attempt ASC`,
        )
        .all(itemId)
        .map(toAction);
    },

    supersedePending(itemId, _now) {
      return db.prepare(`UPDATE actions SET state = 'superseded' WHERE item_id = ? AND state = 'pending'`).run(itemId)
        .changes;
    },

    /** [repair] Kind-scoped supersede of ONE item's pending actions; the item's other kinds stay pending. */
    supersedePendingOfKind(itemId, kind, _now) {
      return db
        .prepare(`UPDATE actions SET state = 'superseded' WHERE item_id = ? AND kind = ? AND state = 'pending'`)
        .run(itemId, kind).changes;
    },

    /** [R2] At most one approvable draft per chat: every pending send_reply of the chat's OTHER items is superseded. */
    supersedePendingRepliesOfChat(chatId, exceptItemId, _now) {
      return db
        .prepare(
          `UPDATE actions SET state = 'superseded' WHERE chat_id = ? AND item_id <> ? AND kind = 'send_reply' AND state = 'pending'`,
        )
        .run(chatId, exceptItemId).changes;
    },

    /** [R2] ONE transaction, two compare-and-sets; every miss (and every trigger ABORT) is reported as 'stale' - never a throw. */
    markApprovedExecuting(id, approvedFinalJson, now) {
      try {
        return db.transaction<'ok' | 'stale'>(() => {
          const approved = db
            .prepare(
              `UPDATE actions SET state = 'approved', approved_at = ?, approved_final_json = ? WHERE id = ? AND state = 'pending'`,
            )
            .run(now, approvedFinalJson, id);
          if (approved.changes !== 1) throw new CasMiss();
          const executing = db
            .prepare(`UPDATE actions SET state = 'executing' WHERE id = ? AND state = 'approved'`)
            .run(id);
          if (executing.changes !== 1) throw new CasMiss();
          return 'ok';
        });
      } catch (e) {
        if (e instanceof CasMiss || isSqliteError(e)) return 'stale';
        throw e;
      }
    },

    markDone(id, result, now) {
      // markDone is additionally allowed from 'unknown_outcome' (reconcile found the event / the sent message).
      casExecuting(
        id,
        `UPDATE actions SET state = 'done', result_json = ?, executed_at = ?, error_code = NULL WHERE id = ? AND state IN ('executing','unknown_outcome')`,
        [JSON.stringify(result), now],
        'executing|unknown_outcome',
      );
    },

    markFailed(id, code, now) {
      casExecuting(
        id,
        `UPDATE actions SET state = 'failed', error_code = ?, executed_at = ? WHERE id = ? AND state = 'executing'`,
        [code, now],
        'executing',
      );
    },

    markUnknownOutcome(id, now) {
      casExecuting(
        id,
        `UPDATE actions SET state = 'unknown_outcome', executed_at = ? WHERE id = ? AND state = 'executing'`,
        [now],
        'executing',
      );
    },

    /** Idempotent: a row that is no longer pending is left alone (the caller re-reads it and answers ACTION_STALE). */
    markRejected(id) {
      db.prepare(`UPDATE actions SET state = 'rejected' WHERE id = ? AND state = 'pending'`).run(id);
    },

    expireOverdue(now) {
      return db.prepare(`UPDATE actions SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?`).run(now)
        .changes;
    },

    executing() {
      return db
        .prepare<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM actions WHERE state = 'executing' ORDER BY created_at ASC`)
        .all()
        .map(toAction);
    },

    /** [R2] Follows retry_of to attempt 1. The chain is at most `attempt` long; the guard stops a corrupted cycle. */
    chainRoot(id) {
      let current = selectById(db, id);
      if (!current) throw new RowNotFoundError('actions', id);
      const seen = new Set<T.ActionId>([current.id]);
      while (current.retryOf !== null) {
        const parent = selectById(db, current.retryOf);
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        current = parent;
      }
      return current;
    },
  };
}
