// tests/fakes/fake-bridge-db.ts - builds a messages.db exactly like the bridge (bridge-contract.md section 6; TESTS 3.1; owner W1-03).
// FULLY IMPLEMENTED in Wave 0 (lane 3 needs it on day one). Spawnable-fake rules (TESTS 2.3): Node built-ins only, .ts imports, no src/**.
// Rollback journal (NOT WAL), upsert ON CONFLICT(id, chat_jid) DO UPDATE, ordinary rowid table, timestamps default to the go-sqlite3
// text form '2026-09-21 20:15:03.123456789+03:00' with trailing zeros trimmed like the driver. Also seeds whatsmeow_lid_map rows.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FakeTsFormat = 'go-sqlite3' | 'rfc3339' | 'epoch_s' | 'epoch_ms' | 'garbage';

export interface FakeBridgeMessageInput {
  id: string;
  chatJid: string;
  sender: string; // USER PART ONLY (digits)
  content: string;
  timestamp?: string | number; // explicit on-disk value; default: now in the configured format
  fromMe: boolean;
  mediaType?: string; // '', image, video, audio, document, sticker, reaction
  deleted?: boolean; // deleted_at set
  quotedMessageId?: string;
  filename?: string; // reactions: the reacted-to message id
}
export interface FakeBridgeDb {
  path: string;
  // CONTRACTS section 16 names
  addChat(jid: string, name: string | null): void;
  addMessage(m: FakeBridgeMessageInput): number; // returns rowid
  addLidMapping(lidJid: string, phoneJid: string): void;
  wipe(): void;
  // TESTS 3.1 aliases / extras
  upsertChat(jid: string, name: string | null): void;
  insertMessage(m: FakeBridgeMessageInput): number;
  maxRowid(): number;
  /** Holds a write lock for `ms` real milliseconds to provoke SQLITE_BUSY in the app's read-only connection.
   *  [W1-03] `BEGIN EXCLUSIVE`, not `BEGIN IMMEDIATE`: the bridge store uses the rollback journal (not WAL), where a RESERVED lock
   *  (= BEGIN IMMEDIATE) still lets readers through, so IMMEDIATE could never provoke the SQLITE_BUSY this helper exists for. */
  holdWriteLock(ms: number): Promise<void>;
  /** Formats an instant the way this fake writes timestamps (for tests that compare parsed values). */
  formatTs(date: Date): string | number;
  /** Advances the fake's own "now" (used for default timestamps). */
  setNow(date: Date): void;
  markDeleted(chatJid: string, id: string, at?: Date): void;
  close(): void;
  // ---- [V2] T2 3.5 seeders (complete in Wave 0; the WhatsApp read world and the U-D1 bench need them on day one) ----
  /** A media row (`content` = the caption, '' by default; `filename` UNTRUSTED like the bridge's). Returns the rowid. */
  seedMediaRow(r: FakeMediaRowInput): number;
  /** `rows` plain text rows in one transaction, timestamps `startTs + i * stepMs` (U-D1: 10^6 rows). Returns the last rowid. */
  seedBulk(r: FakeBulkInput): number;
  /** A row in a group chat (`...@g.us`); never listed, never searchable by the WhatsApp tools. */
  seedGroupRow(r: FakeSpecialRowInput): number;
  /** A `status@broadcast` row. */
  seedStatusRow(r: Omit<FakeSpecialRowInput, 'chatJid'>): number;
  /** A newsletter (`...@newsletter`) row. */
  seedNewsletterRow(r: FakeSpecialRowInput): number;
  /** A reaction row: media_type 'reaction', content = the emoji, filename = the reacted-to message id (bridge shape). */
  seedReaction(r: FakeReactionInput): number;
  /** A row whose deleted_at is set (content kept, as the bridge keeps it). */
  seedDeleted(r: Omit<FakeBridgeMessageInput, 'deleted'>): number;
  /**
   * [v2-closeout] Runs `fn` (synchronous seeding through any method above) inside ONE transaction on the fake's connection; a nested call
   * joins the outer transaction. Every bare addMessage is its own autocommit in rollback-journal mode = a journal file created, fsynced
   * and deleted PER ROW; under the full parallel suite that cost 5-20 ms a row and pushed the 60-300-row worlds of waTools /
   * waReadClient / ingest / pipeline-gates past their timeouts. One commit is what the real bridge does for a history-sync batch too.
   * Readers (the app's connection) see the rows once fn returns.
   */
  batch<T>(fn: () => T): T;
}
export type FakeMediaType = 'audio' | 'image' | 'video' | 'document' | 'sticker';
export interface FakeMediaRowInput {
  chatJid: string;
  id: string;
  mediaType: FakeMediaType;
  filename?: string;
  ts?: string | number | Date;
  fromMe?: boolean;
  sender?: string; // digits; default = the chat's user part (or '9725500000' + '00' for groups)
  caption?: string;
}
export interface FakeBulkInput {
  chatJid: string;
  rows: number;
  startTs: number; // epoch ms
  stepMs: number;
  idPrefix?: string; // default 'BULK'
  fromMeEvery?: number; // every n-th row is from_me (default 0 = never)
  text?: (i: number) => string; // default 'bulk row <i>'
}
export interface FakeSpecialRowInput {
  chatJid: string;
  id: string;
  content: string;
  ts?: string | number | Date;
  sender?: string;
  fromMe?: boolean;
}
export interface FakeReactionInput {
  chatJid: string;
  id: string;
  targetId: string;
  emoji: string;
  ts?: string | number | Date;
  fromMe?: boolean;
  sender?: string;
}
export interface FakeBridgeDbOptions {
  path: string; // <storeDir>/messages.db ; ':memory:' allowed for pure unit tests
  tsFormat?: FakeTsFormat; // default 'go-sqlite3'
  tzOffsetMinutes?: number; // process-local zone of the "bridge", default +180 (Asia/Jerusalem summer time)
  now?: Date;
}

export const BRIDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TIMESTAMP,
  ephemeral_expiration INTEGER NOT NULL DEFAULT 0,
  ephemeral_setting_timestamp INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  content TEXT,
  timestamp TIMESTAMP,
  is_from_me BOOLEAN,
  media_type TEXT,
  filename TEXT,
  url TEXT,
  media_key BLOB,
  file_sha256 BLOB,
  file_enc_sha256 BLOB,
  file_length INTEGER,
  deleted_at TIMESTAMP,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT, chat_jid TEXT, from_jid TEXT, timestamp TIMESTAMP,
  is_from_me BOOLEAN, call_type TEXT,
  is_group BOOLEAN,
  result TEXT,
  duration_sec INTEGER, ended_at TIMESTAMP, reason TEXT,
  PRIMARY KEY (call_id, chat_jid)
);
CREATE INDEX IF NOT EXISTS idx_calls_chat ON calls(chat_jid);
CREATE INDEX IF NOT EXISTS idx_calls_timestamp ON calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid);
CREATE TABLE IF NOT EXISTS whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
`;

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** go-sqlite3 stores time.Time as '2006-01-02 15:04:05.999999999-07:00' (trailing zeros of the fraction trimmed, fraction dropped when 0). */
export function formatGoSqlite3(date: Date, tzOffsetMinutes: number, nanos = 0): string {
  const local = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const base = `${y}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const totalNanos = local.getUTCMilliseconds() * 1_000_000 + nanos;
  let frac = '';
  if (totalNanos > 0) frac = '.' + pad(totalNanos, 9).replace(/0+$/, '');
  const sign = tzOffsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(tzOffsetMinutes);
  const tz = tzOffsetMinutes === 0 ? 'Z' : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${base}${frac}${tz}`;
}

export function createFakeBridgeDb(opts: FakeBridgeDbOptions): FakeBridgeDb {
  const tsFormat: FakeTsFormat = opts.tsFormat ?? 'go-sqlite3';
  const tz = opts.tzOffsetMinutes ?? 180;
  let now = opts.now ?? new Date(Date.UTC(2026, 8, 21, 17, 15, 3, 123));
  let nanoCounter = 456_789; // makes consecutive default timestamps distinct and exercises 1-9 fractional digits
  if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
  const db = new DatabaseSync(opts.path);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec(BRIDGE_SCHEMA_SQL);
  // the bridge adds this column at startup via ensureColumn (ALTER TABLE)
  const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'quoted_message_id'))
    db.exec('ALTER TABLE messages ADD COLUMN quoted_message_id TEXT');

  const formatTs = (date: Date): string | number => {
    switch (tsFormat) {
      case 'go-sqlite3':
        return formatGoSqlite3(date, tz, nanoCounter % 1000);
      case 'rfc3339':
        return date.toISOString();
      case 'epoch_s':
        return Math.floor(date.getTime() / 1000);
      case 'epoch_ms':
        return date.getTime();
      case 'garbage':
        return 'not-a-timestamp';
    }
  };
  const nextDefaultTs = (): string | number => {
    nanoCounter = (nanoCounter * 7 + 13) % 1_000_000_000;
    return formatTs(now);
  };

  const upsertChat = db.prepare(
    `INSERT INTO chats(jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, chats.name), last_message_time = excluded.last_message_time`,
  );
  const upsertMsg = db.prepare(
    `INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, filename, quoted_message_id, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, chat_jid) DO UPDATE SET content = excluded.content, timestamp = excluded.timestamp, is_from_me = excluded.is_from_me,
       media_type = excluded.media_type, filename = excluded.filename`,
  );
  const rowidOf = db.prepare('SELECT rowid AS rowid FROM messages WHERE id = ? AND chat_jid = ?');
  const maxRowidStmt = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM messages');
  const markDeletedStmt = db.prepare('UPDATE messages SET deleted_at = ? WHERE chat_jid = ? AND id = ?');
  const lidStmt = db.prepare(
    'INSERT INTO whatsmeow_lid_map(lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn',
  );

  // [V2] seeder helpers
  const tsOf = (ts: string | number | Date | undefined): string | number | undefined =>
    ts instanceof Date ? formatTs(ts) : ts;
  const userPart = (jid: string): string => {
    const u = jid.split('@')[0] ?? '';
    return /^\d+$/.test(u) ? u : '972550000000';
  };
  const special = (r: FakeSpecialRowInput): number =>
    addMessage({
      id: r.id,
      chatJid: r.chatJid,
      sender: r.sender ?? '972550000000',
      content: r.content,
      timestamp: tsOf(r.ts),
      fromMe: r.fromMe ?? false,
    });

  const addChat = (jid: string, name: string | null): void => {
    upsertChat.run(jid, name, formatTs(now));
  };
  const addMessage = (m: FakeBridgeMessageInput): number => {
    // the real bridge creates the chat row first (FOREIGN KEY)
    const exists = db.prepare('SELECT 1 FROM chats WHERE jid = ?').get(m.chatJid);
    if (!exists) addChat(m.chatJid, null);
    const ts = m.timestamp ?? nextDefaultTs();
    upsertMsg.run(
      m.id,
      m.chatJid,
      m.sender,
      m.content,
      ts,
      m.fromMe ? 1 : 0,
      m.mediaType ?? '',
      m.filename ?? null,
      m.quotedMessageId ?? null,
      m.deleted ? formatTs(now) : null,
    );
    const row = rowidOf.get(m.id, m.chatJid) as { rowid: number };
    return Number(row.rowid);
  };

  /** [v2-closeout] see FakeBridgeDb.batch: one transaction, nested calls join it. */
  const batch = <T>(fn: () => T): T => {
    if (db.isTransaction) return fn();
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  };

  const fake: FakeBridgeDb = {
    path: opts.path,
    addChat,
    addMessage,
    addLidMapping: (lidJid, phoneJid) => {
      lidStmt.run(lidJid, phoneJid);
    },
    wipe: () => {
      db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM calls; DELETE FROM whatsmeow_lid_map;');
      // sqlite_sequence only exists once an AUTOINCREMENT table has been created; the bridge schema has none.
      const hasSequence = db
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)
        .get();
      if (hasSequence !== undefined) db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages')");
      db.exec('VACUUM'); // rowids restart below the app's watermark, like a fresh store
    },
    upsertChat: addChat,
    insertMessage: addMessage,
    maxRowid: () => Number((maxRowidStmt.get() as { m: number }).m),
    holdWriteLock: (ms) =>
      new Promise<void>((resolve, reject) => {
        try {
          db.exec('BEGIN EXCLUSIVE');
        } catch (e) {
          reject(e);
          return;
        }
        setTimeout(() => {
          try {
            db.exec('COMMIT');
          } catch {
            /* ignore */
          }
          resolve();
        }, ms);
      }),
    formatTs,
    setNow: (date) => {
      now = date;
    },
    markDeleted: (chatJid, id, at) => {
      markDeletedStmt.run(formatTs(at ?? now), chatJid, id);
    },
    close: () => {
      if (db.isOpen) db.close();
    },
    // ---- [V2] seeders ----
    seedMediaRow: (r) =>
      addMessage({
        id: r.id,
        chatJid: r.chatJid,
        sender: r.sender ?? userPart(r.chatJid),
        content: r.caption ?? '',
        timestamp: tsOf(r.ts),
        fromMe: r.fromMe ?? false,
        mediaType: r.mediaType,
        filename: r.filename,
      }),
    seedBulk: (r) => {
      const prefix = r.idPrefix ?? 'BULK';
      const text = r.text ?? ((i: number) => `bulk row ${i}`);
      if (!db.prepare('SELECT 1 FROM chats WHERE jid = ?').get(r.chatJid)) addChat(r.chatJid, null);
      // one transaction (U-D1: 10^6 rows); [v2-closeout] joins the caller's when called inside batch()
      return batch(() => {
        for (let i = 0; i < r.rows; i += 1) {
          const fromMe = r.fromMeEvery !== undefined && r.fromMeEvery > 0 && i % r.fromMeEvery === 0;
          upsertMsg.run(
            `${prefix}${i}`,
            r.chatJid,
            userPart(r.chatJid),
            text(i),
            formatTs(new Date(r.startTs + i * r.stepMs)),
            fromMe ? 1 : 0,
            '',
            null,
            null,
            null,
          );
        }
        return Number((maxRowidStmt.get() as { m: number }).m);
      });
    },
    seedGroupRow: (r) => {
      if (!r.chatJid.endsWith('@g.us')) throw new Error('seedGroupRow: chatJid must be a group JID (...@g.us)');
      return special(r);
    },
    seedStatusRow: (r) => special({ ...r, chatJid: 'status@broadcast' }),
    seedNewsletterRow: (r) => {
      if (!r.chatJid.endsWith('@newsletter')) throw new Error('seedNewsletterRow: chatJid must end in @newsletter');
      return special(r);
    },
    seedReaction: (r) =>
      addMessage({
        id: r.id,
        chatJid: r.chatJid,
        sender: r.sender ?? userPart(r.chatJid),
        content: r.emoji,
        timestamp: tsOf(r.ts),
        fromMe: r.fromMe ?? false,
        mediaType: 'reaction',
        filename: r.targetId,
      }),
    seedDeleted: (r) => addMessage({ ...r, deleted: true }),
    batch,
  };
  return fake;
}
