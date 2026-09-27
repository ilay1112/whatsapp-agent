// src/main/bridge/bridgeDb.ts   (frozen signatures; the ONLY module that opens <userData>\bridge\store\messages.db, always readOnly)
// Frozen signatures pasted verbatim from docs/specs/contracts.md section 12 (owner W1-03).
// READ-ONLY BY CONSTRUCTION: the connection is opened with {readOnly:true} + `PRAGMA query_only=1`, every statement below is a SELECT,
// the journal mode is never touched and no index is ever created (bridge-contract.md section 6).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/** Raw row as read from the bridge's `messages` table (schema: bridge-contract.md section 6). */
export interface BridgeMessageRow {
  rowid: number;
  id: string;
  chat_jid: string;
  sender: string; // user part only
  content: string | null;
  timestamp: string | number | null; // on-disk format UNVERIFIED => parsed ONLY by bridge/timestamps.ts parseBridgeTs()
  is_from_me: number | boolean | null;
  media_type: string | null; // '', image, video, audio, document, sticker, reaction
  deleted_at: string | number | null;
}
export interface BridgeChatRow {
  jid: string;
  name: string | null;
}
export interface BridgeDb {
  /** false when the file does not exist yet. Opens with {readOnly:true}, PRAGMA query_only=1, busy_timeout=2000 ; never changes journal mode ; never adds indexes. */
  open(): boolean;
  close(): void;
  maxRowid(): number;
  /** SELECT rowid,id,chat_jid,sender,content,timestamp,is_from_me,media_type,deleted_at FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ? */
  rowsAfter(watermark: number, limit: number): BridgeMessageRow[];
  /** Last n rows of ONE chat (context window), newest last. Ordered by rowid (no SQL date math).
   *  [repair] "One chat" means the CONTACT, not one JID string: the read covers the given JID and its @lid/phone twin from
   *  whatsmeow_lid_map, because a re-keyed app chat and the bridge's own rows can disagree on which form was used. */
  lastMessages(chatJid: string, n: number): BridgeMessageRow[];
  /** [R2] EXISTS(SELECT 1 FROM messages WHERE chat_jid=? AND is_from_me=1 AND (media_type IS NULL OR media_type NOT IN ('', 'reaction') OR content <> '')
   *  AND content IS NOT NULL AND content <> '' AND deleted_at IS NULL) - i.e. a REAL message the user typed or sent: an own reaction, an empty row
   *  or a deleted row never makes a chat "known". Ingest ORs this over both JID forms of a contact (phone JID and its @lid twin). */
  userHasSentIn(chatJid: string): boolean;
  /** [R2] Read-only LID -> phone-JID resolution using the bridge's own tables (whatsmeow_lid_map / chats), null when unmapped.
   *  Called by ingest for every @lid chat on every bridge ONLINE transition; a hit re-keys app.db chats to the phone JID and merges items. */
  phoneJidForLid(lidJid: string): string | null;
  chatName(chatJid: string): string | null;
  /** Reconcile: newest is_from_me rows of a chat with rowid > sinceRowid. Covers both JID forms, like `lastMessages`. */
  outboundAfter(chatJid: string, sinceRowid: number, limit: number): BridgeMessageRow[];
}

const ROW_COLUMNS = 'rowid AS rowid, id, chat_jid, sender, content, timestamp, is_from_me, media_type, deleted_at';

/** [R2] The doc comment of `userHasSentIn` in CONTRACTS spells the media-type guard as
 *  `(media_type IS NULL OR media_type NOT IN ('', 'reaction') OR content <> '')`, which is TRUE for a reaction row whose content is the
 *  emoji and would make an own thumbs-up flip a stranger's chat to "known" - exactly what the same comment (and ARCHITECTURE 4.6 step 4,
 *  A13 and TESTS 5.3) forbid. The behavioural rule wins; ARCHITECTURE's form is used. Recorded in ops/agent-notes/W1-03-bridge-ingest.md. */
const USER_HAS_SENT_SQL =
  `SELECT EXISTS(SELECT 1 FROM messages WHERE chat_jid = ? AND is_from_me = 1` +
  ` AND (media_type IS NULL OR media_type <> 'reaction')` +
  ` AND content IS NOT NULL AND content <> '' AND deleted_at IS NULL) AS e`;

/** SQLite columns are typeless: anything that is not TEXT/INTEGER/REAL is normalised to null rather than guessed at. */
function asText(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function asTimestamp(v: unknown): string | number | null {
  return typeof v === 'string' || typeof v === 'number' ? v : null;
}

function normaliseRow(r: Record<string, unknown>): BridgeMessageRow {
  return {
    rowid: Number(r.rowid),
    id: String(r.id),
    chat_jid: String(r.chat_jid),
    sender: String(r.sender),
    content: asText(r.content),
    timestamp: asTimestamp(r.timestamp),
    is_from_me: Number(r.is_from_me ?? 0),
    media_type: asText(r.media_type),
    deleted_at: asTimestamp(r.deleted_at),
  };
}

export function createBridgeDb(path: string): BridgeDb {
  let db: DatabaseSync | null = null;
  /** whatsmeow_lid_map does not exist in an old store; probed once, then remembered. */
  let lidMapUsable: boolean | null = null;

  const open = (): boolean => {
    if (db) return true;
    if (path !== ':memory:' && !existsSync(path)) return false;
    const handle = new DatabaseSync(path, { readOnly: true });
    // read-only hardening: query_only rejects every write statement on this connection as well.
    handle.exec('PRAGMA query_only=1');
    handle.exec('PRAGMA busy_timeout=2000');
    db = handle;
    lidMapUsable = null;
    return true;
  };

  const conn = (): DatabaseSync | null => {
    if (db === null) open();
    return db;
  };

  /** [repair] The bridge keys a contact's rows under whichever JID form whatsmeow handed it, and an unresolved `@lid` residue (shared/types.ts
   *  198-200) is exactly the case `phoneJidForLid` / `mergeLidInto` exist for: app.db is re-keyed to the phone JID while messages.db keeps the
   *  `@lid` rows. A chat-scoped read that trusts `chats.jid` alone then returns ZERO rows - an empty S1 context window and a permanently
   *  unreconcilable send. So every chat-scoped read below runs over BOTH forms of the contact, the way ingest already ORs `userHasSentIn`. */
  const aliasJids = (chatJid: string): string[] => {
    const c = conn();
    if (!c) return [chatJid];
    if (!lidMapPresent(c)) return [chatJid];
    const out = [chatJid];
    const user = chatJid.includes('@') ? chatJid.slice(0, chatJid.indexOf('@')) : chatJid;
    const push = (jid: string): void => {
      if (jid !== '' && !out.includes(jid)) out.push(jid);
    };
    if (chatJid.endsWith('@lid')) {
      const phone = phoneJidForLidOn(c, chatJid);
      if (phone !== null) push(phone);
      return out;
    }
    // phone JID -> every @lid twin the bridge's own mapping knows.
    const rows = c.prepare('SELECT lid FROM whatsmeow_lid_map WHERE pn = ? OR pn = ?').all(chatJid, user) as Array<{
      lid: unknown;
    }>;
    for (const r of rows) {
      const lid = asText(r.lid) ?? '';
      if (lid === '') continue;
      push(lid.includes('@') ? lid : `${lid}@lid`);
    }
    return out;
  };

  const lidMapPresent = (c: DatabaseSync): boolean => {
    if (lidMapUsable === null) {
      const t = c
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'whatsmeow_lid_map'`)
        .get();
      lidMapUsable = t !== undefined;
    }
    return lidMapUsable;
  };

  const phoneJidForLidOn = (c: DatabaseSync, lidJid: string): string | null => {
    if (!lidMapPresent(c)) return null;
    const user = lidJid.includes('@') ? lidJid.slice(0, lidJid.indexOf('@')) : lidJid;
    const row = c.prepare('SELECT pn FROM whatsmeow_lid_map WHERE lid = ? OR lid = ? LIMIT 1').get(lidJid, user) as
      { pn: unknown } | undefined;
    const pn = asText(row?.pn) ?? '';
    if (pn === '') return null;
    return pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
  };

  const all = (sql: string, ...params: Array<string | number>): BridgeMessageRow[] => {
    const c = conn();
    if (!c) return [];
    return (c.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(normaliseRow);
  };

  return {
    open,
    close: () => {
      if (db?.isOpen) db.close();
      db = null;
      lidMapUsable = null;
    },
    maxRowid: () => {
      const c = conn();
      if (!c) return 0;
      const r = c.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages').get() as { m: number } | undefined;
      return Number(r?.m ?? 0);
    },
    rowsAfter: (watermark, limit) =>
      all(
        `SELECT ${ROW_COLUMNS} FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        Math.trunc(watermark),
        Math.trunc(limit),
      ),
    lastMessages: (chatJid, n) => {
      const jids = aliasJids(chatJid);
      return all(
        `SELECT ${ROW_COLUMNS} FROM messages WHERE chat_jid IN (${jids.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`,
        ...jids,
        Math.max(0, Math.trunc(n)),
      ).reverse();
    },
    userHasSentIn: (chatJid) => {
      const c = conn();
      if (!c) return false;
      const r = c.prepare(USER_HAS_SENT_SQL).get(chatJid) as { e: number } | undefined;
      return Number(r?.e ?? 0) === 1;
    },
    phoneJidForLid: (lidJid) => {
      const c = conn();
      if (!c) return null;
      return phoneJidForLidOn(c, lidJid);
    },
    chatName: (chatJid) => {
      const c = conn();
      if (!c) return null;
      const r = c.prepare('SELECT name FROM chats WHERE jid = ?').get(chatJid) as { name: unknown } | undefined;
      return asText(r?.name);
    },
    outboundAfter: (chatJid, sinceRowid, limit) => {
      const jids = aliasJids(chatJid);
      return all(
        `SELECT ${ROW_COLUMNS} FROM messages WHERE chat_jid IN (${jids.map(() => '?').join(',')}) AND is_from_me = 1 AND rowid > ? ORDER BY rowid DESC LIMIT ?`,
        ...jids,
        Math.trunc(sinceRowid),
        Math.max(0, Math.trunc(limit)),
      );
    },
  };
}
