// src/main/db/repos/chats.ts - Repos['chats'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
import { CHAT_AUTO_POLICIES, DM_PHONE_JID_RE, LIMITS } from '../../../shared/types';
import type * as T from '../../../shared/types';
import { RepoContractError, RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { createAuditRepo } from './audit';
import { updateItemRow } from './items';
import { CHAT_COLUMNS, type ChatRow, toChat, intOf } from './rows';

export type ChatsRepo = Repos['chats'];

const selectById = (db: Db, id: T.ChatRef): T.Chat | null => {
  const row = db.prepare<ChatRow>(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?`).get(id);
  return row ? toChat(row) : null;
};
const selectByJid = (db: Db, jid: string): T.Chat | null => {
  const row = db.prepare<ChatRow>(`SELECT ${CHAT_COLUMNS} FROM chats WHERE jid = ?`).get(jid);
  return row ? toChat(row) : null;
};

export function createChatsRepo(db: Db): ChatsRepo {
  const auditRepo = createAuditRepo(db);
  return {
    upsertFromBridge(jid, name, isKnown, now) {
      return db.transaction(() => {
        const existing = selectByJid(db, jid);
        const sendable = DM_PHONE_JID_RE.test(jid);
        if (!existing) {
          db.prepare(
            `INSERT INTO chats(jid, display_name, is_known, force_known, sendable, policy, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, 'default', ?, ?)`,
          ).run(jid, name, intOf(isKnown), intOf(sendable), now, now);
          return selectByJid(db, jid)!;
        }
        // is_known is monotonic (OR): a chat the user has written in never becomes unknown again.
        db.prepare(
          `UPDATE chats SET display_name = COALESCE(?, display_name), is_known = MAX(is_known, ?), sendable = ?, updated_at = ? WHERE id = ?`,
        ).run(name, intOf(isKnown), intOf(sendable), now, existing.id);
        return selectById(db, existing.id)!;
      });
    },

    /**
     * [R2] LID resolution. One transaction. When no phone-JID row exists the @lid row is simply re-keyed; otherwise the @lid row's
     * ITEMS move to the phone-JID row (ARCHITECTURE 4.6 step 4: "merges an older @lid row and its items"), `is_known` is OR'ed and
     * the @lid row is deleted.
     * [W1-04 note] CONTRACTS 15.1 says "items/actions", but `actions.chat_id` is frozen by `trg_actions_frozen`, so an action row can
     * NOT follow its item into another chat (safety I3 pins the recipient at proposal time), and `chat_id REFERENCES chats(id)` has no
     * ON DELETE clause, so it cannot stay behind either. The @lid chat's own action rows are therefore DELETED with the chat row.
     * That is only safe for rows whose side effect can no longer be in flight:
     *   - an @lid chat is not sendable, so `validate.ts` never drafts a `send_reply` for it - at most `create_event` rows exist here;
     *   - `pending` has no side effect and `rejected/expired/superseded` never had one;
     *   - `done/failed/unknown_outcome` keep their evidence outside the row: audit_log is append-only (`action_approved`, `action_done`,
     *     ...) and `items.calendar_event_id` moves with the item.
     * An `approved`/`executing` row is different: it is a side effect IN FLIGHT, and deleting it would drop the idempotency key and the
     * handle that `reconcileUnknown` needs for an event Google may already hold. So the merge is DEFERRED while one exists and the @lid
     * row is returned unchanged; the next ONLINE transition retries it (bounded: `recoverOnStartup` settles every `executing` row).
     * See ops/agent-notes/W1-04-db.md (REQUESTS) - the contract wording needs the orchestrator's confirmation.
     */
    mergeLidInto(lidChatId, phoneJid, now) {
      return db.transaction(() => {
        const lid = selectById(db, lidChatId);
        if (!lid) throw new RowNotFoundError('chats', lidChatId);
        const target = selectByJid(db, phoneJid);
        if (!target || target.id === lid.id) {
          db.prepare(`UPDATE chats SET jid = ?, sendable = ?, updated_at = ? WHERE id = ?`).run(
            phoneJid,
            intOf(DM_PHONE_JID_RE.test(phoneJid)),
            now,
            lid.id,
          );
          return selectById(db, lid.id)!;
        }
        // Deferral guard (see the doc comment): never destroy an approval whose side effect may already be running.
        const inFlight = db
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM actions WHERE chat_id = ? AND state IN ('approved','executing')`,
          )
          .get(lid.id);
        if ((inFlight?.n ?? 0) > 0) return lid;
        // [V2-W1-01] I8: an automatic write of this chat that can still be undone keeps the merge deferred too. Deleting the @lid
        // chat's action rows (below) cascades to event_revisions, auto_decisions and auto_writes (ON DELETE CASCADE), which would
        // silently drop the Undo of that write. The deferral is bounded by undo_until (<= 72 h, DDL CHECK).
        const undoable = db
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM auto_writes w JOIN actions a ON a.id = w.action_id
               WHERE a.chat_id = ? AND w.undo_state = 'available' AND w.undo_until > ?`,
          )
          .get(lid.id, now)!;
        if (undoable.n > 0) return lid;
        // Partial unique index ux_items_open allows exactly one open item per chat: keep the newer trigger, supersede the other.
        const lidOpen = db
          .prepare<{ id: number; trigger_ts: number }>(
            `SELECT id, trigger_ts FROM items WHERE chat_id = ? AND state IN ('needs_reply','info_missing')`,
          )
          .get(lid.id);
        const targetOpen = db
          .prepare<{ id: number; trigger_ts: number }>(
            `SELECT id, trigger_ts FROM items WHERE chat_id = ? AND state IN ('needs_reply','info_missing')`,
          )
          .get(target.id);
        if (lidOpen && targetOpen) {
          const loser = lidOpen.trigger_ts > targetOpen.trigger_ts ? targetOpen.id : lidOpen.id;
          updateItemRow(db, loser, { closedReason: 'superseded' }, now);
        }
        db.prepare(`DELETE FROM actions WHERE chat_id = ?`).run(lid.id);
        db.prepare(`UPDATE items SET chat_id = ?, updated_at = ? WHERE chat_id = ?`).run(target.id, now, lid.id);
        // [repair data-integrity-3] `triage_queue.chat_id REFERENCES chats(id)` has no ON DELETE clause, so the @lid row cannot
        // stay behind - but it must not simply VANISH either. resolveLidChats() merges on the bridge's ONLINE transition, which
        // can land inside the 20 s debounce: the item moves across still `analysis='queued'`, and with its queue row gone nothing
        // ever triages it (agent/queue reads only triage_queue, recoverRunning rescues only 'running'), so it is counted and never
        // listed until expireOld closes it days later. The row therefore follows the work: earliest due_at and first_enqueued_at
        // win, the higher attempts count is kept. A queue row costs an LLM run, so it is still dropped when nothing analysable
        // came across - the case chats.test.ts has always covered, and the one handleChat() re-arms via handleInbound anyway.
        const analysable = db
          .prepare<{ n: number }>(
            `SELECT COUNT(*) AS n FROM items WHERE chat_id = ? AND analysis IN ('queued','running') AND closed_at IS NULL`,
          )
          .get(target.id);
        // [repair correctness-pipeline-2] The UPSERT below also bumps `rev`, because pulling the @lid chat's work onto
        // this row IS a re-arm. Without it a run already in flight for the surviving chat would hand its stale rev to
        // remove()'s compare-and-set and delete the row that now carries the merged-in work.
        if ((analysable?.n ?? 0) > 0) {
          db.prepare(
            `INSERT INTO triage_queue(chat_id, due_at, first_enqueued_at, attempts, last_error)
               SELECT ?, due_at, first_enqueued_at, attempts, last_error FROM triage_queue WHERE chat_id = ?
             ON CONFLICT(chat_id) DO UPDATE SET
               due_at            = MIN(triage_queue.due_at, excluded.due_at),
               first_enqueued_at = MIN(triage_queue.first_enqueued_at, excluded.first_enqueued_at),
               attempts          = MAX(triage_queue.attempts, excluded.attempts),
               rev               = triage_queue.rev + 1`,
          ).run(target.id, lid.id);
        }
        db.prepare(`DELETE FROM triage_queue WHERE chat_id = ?`).run(lid.id);
        // [V2-W1-01] media_cache.chat_id is ON DELETE CASCADE: the cached pictures follow their items to the surviving chat (a row
        // whose (chat_id, wa_msg_id) already exists there is the same picture and is dropped with the @lid chat).
        db.prepare(`UPDATE OR IGNORE media_cache SET chat_id = ? WHERE chat_id = ?`).run(target.id, lid.id);
        // [V2-W1-01] the automatic-mode opt-out and taint merge fail-closed: 'never' wins, the later taint wins (B28).
        db.prepare(
          `UPDATE chats SET is_known = MAX(is_known, ?), force_known = MAX(force_known, ?), display_name = COALESCE(display_name, ?), updated_at = ?,
                            auto_policy = CASE WHEN ? = 'never' THEN 'never' ELSE auto_policy END,
                            auto_tainted_until = CASE WHEN ? IS NULL THEN auto_tainted_until
                                                      ELSE MAX(COALESCE(auto_tainted_until, ?), ?) END
             WHERE id = ?`,
        ).run(
          intOf(lid.isKnown),
          intOf(lid.forceKnown),
          lid.displayName,
          now,
          lid.autoPolicy,
          lid.autoTaintedUntil,
          lid.autoTaintedUntil,
          lid.autoTaintedUntil,
          target.id,
        );
        db.prepare(`DELETE FROM chats WHERE id = ?`).run(lid.id);
        return selectById(db, target.id)!;
      });
    },

    byId(id) {
      return selectById(db, id);
    },

    byJid(jid) {
      return selectByJid(db, jid);
    },

    touch(id, p) {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (p.lastInboundTs !== undefined) {
        sets.push('last_inbound_ts = ?');
        params.push(p.lastInboundTs);
      }
      if (p.lastOutboundTs !== undefined) {
        sets.push('last_outbound_ts = ?');
        params.push(p.lastOutboundTs);
      }
      if (p.lang !== undefined) {
        sets.push('lang = ?');
        params.push(p.lang);
      }
      if (p.lastTriagedMsgId !== undefined) {
        sets.push('last_triaged_msg_id = ?');
        params.push(p.lastTriagedMsgId);
      }
      if (sets.length === 0) return;
      // `touch` carries no clock (CONTRACTS 15.1); updated_at follows the newest timestamp the caller supplied, never goes backwards.
      const stamps = [p.lastInboundTs, p.lastOutboundTs].filter((t): t is T.EpochMs => typeof t === 'number');
      if (stamps.length > 0) {
        sets.push('updated_at = MAX(updated_at, ?)');
        params.push(Math.max(...stamps));
      }
      params.push(id);
      db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    setPolicy(id, policy) {
      const changes = db.prepare(`UPDATE chats SET policy = ? WHERE id = ?`).run(policy, id).changes;
      if (changes !== 1) throw new RowNotFoundError('chats', id);
      return selectById(db, id)!;
    },

    setForceKnown(id) {
      const changes = db.prepare(`UPDATE chats SET force_known = 1 WHERE id = ?`).run(id).changes;
      if (changes !== 1) throw new RowNotFoundError('chats', id);
      return selectById(db, id)!;
    },

    /** chat:listPolicies (C2 8): policy != 'default' or forceKnown ; [V2] or auto_policy = 'never' (the automatic-mode opt-out). */
    withPolicies() {
      return db
        .prepare<ChatRow>(
          `SELECT ${CHAT_COLUMNS} FROM chats WHERE policy <> 'default' OR force_known = 1 OR auto_policy = 'never' ORDER BY id`,
        )
        .all()
        .map(toChat);
    },
    // ---- [V2 ADD] C2 16.1 (V2-W1-01-db) ----
    /** chat:setPolicy {autoPolicy} (B28): 'never' opts the chat out of automatic mode; 'inherit' follows the global policy. */
    setAutoPolicy(id, p) {
      if (!(CHAT_AUTO_POLICIES as readonly string[]).includes(p))
        throw new RepoContractError('unknown chat auto policy');
      const changes = db.prepare(`UPDATE chats SET auto_policy = ? WHERE id = ?`).run(p, id).changes;
      if (changes !== 1) throw new RowNotFoundError('chats', id);
      return selectById(db, id)!;
    },

    /**
     * S4 / automatic undo (B28, F10): auto_tainted_until = MAX(old, until) - a taint only ever extends, a shorter one never shortens
     * a longer one - and one `auto_taint {chatRef, untilTs}` audit row (ids and numbers only), in ONE transaction.
     * [V2-W1-01] The repo carries no clock; every caller passes `until = now + LIMITS.autoTaintMs` (C2 1.3, B10), so the audit row is
     * stamped `until - LIMITS.autoTaintMs` - the caller's own `now`, which keeps a virtual-clock test deterministic.
     */
    taint(id, until) {
      if (!Number.isFinite(until)) throw new RepoContractError('taint needs a finite until');
      db.transaction(() => {
        const changes = db
          .prepare(`UPDATE chats SET auto_tainted_until = MAX(COALESCE(auto_tainted_until, ?), ?) WHERE id = ?`)
          .run(until, until, id).changes;
        if (changes !== 1) throw new RowNotFoundError('chats', id);
        const effective = selectById(db, id)!.autoTaintedUntil;
        auditRepo.append('auto_taint', String(id), { chatRef: id, untilTs: effective }, until - LIMITS.autoTaintMs);
      });
    },
  };
}
