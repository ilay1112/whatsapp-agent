// src/main/db/repos/items.ts - Repos['items'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// `items.state` is written ONLY here (CONTRACTS 15.1: "The ONLY mutator ... recomputes state = deriveState()"): every write goes
// through `updateItemRow()`, which is also the entry point db/repos/chats.ts uses while merging an @lid chat.
import { deriveState } from '../../../shared/state';
import { LIMITS } from '../../../shared/types';
import type * as T from '../../../shared/types';
import { RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { ITEM_COLUMNS, type ItemRow, toItem, toItemMessage, type ItemMessageRow, intOf } from './rows';

export type ItemsRepo = Repos['items'];
export type ItemPatch = Parameters<ItemsRepo['update']>[1];

/** in_calendar cards close 1 day after the event started (ARCHITECTURE section 7: "in_calendar --event start + 1 day--> closed 'past'"). */
export const PAST_EVENT_GRACE_MS = 24 * 3600_000;

/** [V2] The editable-event filter of findExistingEvent (two parameters: chat_id, sinceTs). */
const EDITABLE_EVENT_FILTER = `chat_id = ? AND state = 'in_calendar' AND calendar_event_id IS NOT NULL
      AND event_state IN ('created','updated') AND event_start_ts IS NOT NULL AND event_start_ts >= ?`;

const selectById = (db: Db, id: T.ItemId): T.Item | null => {
  const row = db.prepare<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`).get(id);
  return row ? toItem(row) : null;
};

/**
 * The single writer of `items.state`. Applies the defined keys of `patch`, recomputes `state` with the shared `deriveState()`
 * and bumps `updated_at`. `closed_at` follows `closed_reason`: it is stamped with `now` when a row closes without an explicit
 * `closedAt` and cleared again when a row is re-opened.
 */
export function updateItemRow(db: Db, id: T.ItemId, patch: ItemPatch, now: T.EpochMs): T.Item {
  const current = selectById(db, id);
  if (!current) throw new RowNotFoundError('items', id);
  const next: T.Item = { ...current };
  for (const [key, value] of Object.entries(patch) as Array<[keyof T.Item, unknown]>) {
    if (value === undefined) continue;
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  if (next.closedReason === null) next.closedAt = null;
  else if (next.closedAt === null) next.closedAt = now;
  next.state = deriveState(next);
  next.updatedAt = now;
  db.prepare(
    `UPDATE items SET state=?, analysis=?, hold_reason=?, error_code=?, reply_state=?, event_state=?, trigger_msg_id=?, trigger_ts=?,
            missing_json=?, badges_json=?, current_proposal_id=?, editing_until=?, calendar_event_id=?, calendar_html_link=?,
            event_start_ts=?, closed_reason=?, closed_at=?, updated_at=?,
            linked_item_id=?, event_revision=?, calendar_updated=?, trigger_kind=?, event_origin_item_id=?
       WHERE id=?`,
  ).run(
    next.state,
    next.analysis,
    next.holdReason,
    next.errorCode,
    next.replyState,
    next.eventState,
    next.triggerMsgId,
    next.triggerTs,
    JSON.stringify(next.missing),
    JSON.stringify(next.badges),
    next.currentProposalId,
    next.editingUntil,
    next.calendarEventId,
    next.calendarHtmlLink,
    next.eventStartTs,
    next.closedReason,
    next.closedAt,
    next.updatedAt,
    next.linkedItemId,
    next.eventRevision,
    next.calendarUpdated,
    next.triggerKind,
    next.eventOriginItemId,
    id,
  );
  return next;
}

export function createItemsRepo(db: Db): ItemsRepo {
  const openStates = `('needs_reply','info_missing')`;
  const listedAnalysis = `('done','held','failed')`;

  return {
    openForChat(chatId) {
      const row = db
        .prepare<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE chat_id = ? AND state IN ${openStates}`)
        .get(chatId);
      return row ? toItem(row) : null;
    },

    createOpen(p) {
      const state = deriveState({ analysis: p.analysis, replyState: 'none', eventState: 'none', closedReason: null });
      const info = db
        .prepare(
          `INSERT INTO items(chat_id, state, analysis, hold_reason, reply_state, event_state, trigger_msg_id, trigger_ts,
                           missing_json, badges_json, editing_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'none', 'none', ?, ?, '[]', '[]', 0, ?, ?)`,
        )
        .run(p.chatId, state, p.analysis, p.holdReason, p.triggerMsgId, p.triggerTs, p.now, p.now);
      return selectById(db, info.lastInsertRowid)!;
    },

    update(id, patch, now) {
      return updateItemRow(db, id, patch, now);
    },

    byId(id) {
      return selectById(db, id);
    },

    list(state, limit) {
      return db
        .prepare<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM items WHERE state = ? AND analysis IN ${listedAnalysis} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(state, limit)
        .map(toItem);
    },

    counts() {
      const out = { needsReply: 0, inCalendar: 0, infoMissing: 0, ignored: 0, analysing: 0 };
      const byState = db
        .prepare<{ state: string; n: number }>(
          `SELECT state, COUNT(*) AS n FROM items WHERE analysis IN ${listedAnalysis} GROUP BY state`,
        )
        .all();
      for (const row of byState) {
        if (row.state === 'needs_reply') out.needsReply = row.n;
        else if (row.state === 'in_calendar') out.inCalendar = row.n;
        else if (row.state === 'info_missing') out.infoMissing = row.n;
        else if (row.state === 'ignored') out.ignored = row.n;
      }
      // `analysing` is the header's live "Analysing N chats..." (CONTRACTS 15.1: queued + running). A row that CLOSES while it is
      // still queued - superseded by an @lid merge, expired by expireOld, dismissed - keeps analysis='queued' forever (there is no
      // honest terminal Analysis to move it to, and expireOld skips closed rows), so it has to be excluded here or the counter
      // sticks at a number the user can never clear.
      out.analysing = db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM items WHERE analysis IN ('queued','running') AND closed_at IS NULL`,
        )
        .get()!.n;
      return out;
    },

    heldWith(reason, opts) {
      const since = opts?.triggerTsSince;
      return since === undefined
        ? db
            .prepare<ItemRow>(
              `SELECT ${ITEM_COLUMNS} FROM items WHERE analysis = 'held' AND hold_reason = ? ORDER BY trigger_ts ASC, id ASC`,
            )
            .all(reason)
            .map(toItem)
        : db
            .prepare<ItemRow>(
              `SELECT ${ITEM_COLUMNS} FROM items WHERE analysis = 'held' AND hold_reason = ? AND trigger_ts >= ? ORDER BY trigger_ts ASC, id ASC`,
            )
            .all(reason, since)
            .map(toItem);
    },

    recoverRunning(now) {
      const ids = db.prepare<{ id: number }>(`SELECT id FROM items WHERE analysis = 'running' ORDER BY id`).all();
      return db.transaction(() => {
        for (const { id } of ids) updateItemRow(db, id, { analysis: 'queued' }, now);
        return ids.length;
      });
    },

    expireOld(now) {
      // Open items whose last triggering message is older than the TTL, and in_calendar items whose event started > 1 day ago.
      const expired = db
        .prepare<{ id: number }>(`SELECT id FROM items WHERE state IN ${openStates} AND trigger_ts <= ? ORDER BY id`)
        .all(now - LIMITS.openItemTtlMs);
      const past = db
        .prepare<{ id: number }>(
          `SELECT id FROM items WHERE state = 'in_calendar' AND event_start_ts IS NOT NULL AND event_start_ts <= ? ORDER BY id`,
        )
        .all(now - PAST_EVENT_GRACE_MS);
      return db.transaction(() => {
        for (const { id } of expired) updateItemRow(db, id, { closedReason: 'expired' }, now);
        for (const { id } of past) updateItemRow(db, id, { closedReason: 'past' }, now);
        return expired.length + past.length;
      });
    },

    snapshotMessages(itemId, rows) {
      db.transaction(() => {
        db.prepare(`DELETE FROM item_messages WHERE item_id = ?`).run(itemId);
        const insert = db.prepare(
          `INSERT INTO item_messages(item_id, wa_msg_id, from_me, ts, text, text_sha256) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const m of rows) insert.run(itemId, m.waMsgId, intOf(m.fromMe), m.ts, m.text, m.textSha256);
      });
    },

    messages(itemId) {
      return db
        .prepare<ItemMessageRow>(
          `SELECT item_id, wa_msg_id, from_me, ts, text, text_sha256 FROM item_messages WHERE item_id = ? ORDER BY ts ASC, wa_msg_id ASC`,
        )
        .all(itemId)
        .map(toItemMessage);
    },
    // ---- [V2 ADD] C2 16.1 (V2-W1-01-db) ----
    /** findExistingEvent's query (P2 7.1, B20): the NEWEST (created_at, then id) in_calendar item of the chat holding an event id with
     *  event_state created|updated (a cancelled event is never an edit target) and event_start_ts >= sinceTs. */
    newestEditableEvent(chatId, sinceTs) {
      const row = db
        .prepare<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM items WHERE ${EDITABLE_EVENT_FILTER} ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(chatId, sinceTs);
      return row ? toItem(row) : null;
    },

    /** [F31] the same filter, counted per DISTINCT event (a source item and the delta item acting on it hold the same event id). */
    countEditableEvents(chatId, sinceTs) {
      return db
        .prepare<{ n: number }>(
          `SELECT COUNT(DISTINCT calendar_event_id) AS n FROM items WHERE ${EDITABLE_EVENT_FILTER}`,
        )
        .get(chatId, sinceTs)!.n;
    },

    /** Every item holding this event (source + acting items), oldest first. */
    byCalendarEventId(eventId) {
      return db
        .prepare<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM items WHERE calendar_event_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(eventId)
        .map(toItem);
    },
  };
}
