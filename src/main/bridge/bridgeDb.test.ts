// TESTS 5.3 row `bridge/bridgeDb.ts`: read-only connection, DM rows, is_known semantics ([R2] reactions/empty/deleted excluded),
// LID resolution, SQLITE_BUSY. The fake bridge DB (tests/fakes/fake-bridge-db.ts) writes the real schema.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeDb, type BridgeDb, type BridgeMessageRowV2 } from './bridgeDb';
import { createFakeBridgeDb, type FakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';

const CHAT_A = '972550000001@s.whatsapp.net';
const CHAT_B = '972550000002@s.whatsapp.net';
const LID = '55500001@lid';

const dirs: string[] = [];
const closers: Array<() => void> = [];

function newStore(): { path: string; fake: FakeBridgeDb } {
  const dir = mkdtempSync(join(tmpdir(), 'wca-bridgedb-'));
  dirs.push(dir);
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path });
  closers.push(() => fake.close());
  return { path, fake };
}

function open(path: string): BridgeDb {
  const db = createBridgeDb(path);
  closers.push(() => db.close());
  return db;
}

afterEach(() => {
  while (closers.length > 0) {
    try {
      closers.pop()?.();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
});

describe('createBridgeDb - opening', () => {
  it('returns false when the store file does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-bridgedb-'));
    dirs.push(dir);
    const db = open(join(dir, 'store', 'messages.db'));
    expect(db.open()).toBe(false);
    expect(db.maxRowid()).toBe(0);
    expect(db.rowsAfter(0, 10)).toEqual([]);
    expect(db.lastMessages(CHAT_A, 5)).toEqual([]);
    expect(db.userHasSentIn(CHAT_A)).toBe(false);
    expect(db.phoneJidForLid(LID)).toBeNull();
    expect(db.chatName(CHAT_A)).toBeNull();
    expect(db.outboundAfter(CHAT_A, 0, 5)).toEqual([]);
  });

  it('opens read-only: a write through an identically opened connection is refused', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'm1', chatJid: CHAT_A, sender: '972550000001', content: 'hi', fromMe: false });
    const db = open(path);
    expect(db.open()).toBe(true);
    expect(db.open()).toBe(true); // idempotent

    const probe = new DatabaseSync(path, { readOnly: true });
    closers.push(() => probe.close());
    probe.exec('PRAGMA query_only=1');
    expect(() => probe.exec("INSERT INTO messages(id, chat_jid, content) VALUES ('x','y','z')")).toThrow();
    expect(() => probe.exec('CREATE INDEX ix_test ON messages(timestamp)')).toThrow();
    expect(() => probe.exec('DELETE FROM messages')).toThrow();
    expect((probe.prepare('PRAGMA query_only').get() as { query_only: number }).query_only).toBe(1);
  });

  it('contains no write SQL and no journal-mode change in its own source', () => {
    const src = readFileSync(fileURLToPath(new URL('./bridgeDb.ts', import.meta.url)), 'utf8');
    const statements = src.match(
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|VACUUM|ATTACH)\s+(INTO|TABLE|INDEX|FROM|OR)\b/gi,
    );
    expect(statements).toBeNull();
    expect(src).not.toMatch(/journal_mode/i);
    expect(src).toMatch(/readOnly: true/);
    expect(src).toMatch(/query_only=1/);
    expect(src).toMatch(/busy_timeout=2000/);
  });

  it('close() is idempotent and re-open works', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'm1', chatJid: CHAT_A, sender: '972550000001', content: 'hi', fromMe: false });
    const db = open(path);
    db.open();
    db.close();
    db.close();
    expect(db.open()).toBe(true);
    expect(db.maxRowid()).toBeGreaterThan(0);
  });
});

describe('createBridgeDb - reading rows', () => {
  it('pages by rowid and preserves every column', () => {
    const { path, fake } = newStore();
    fake.addChat(CHAT_A, 'Dana');
    const r1 = fake.addMessage({ id: 'm1', chatJid: CHAT_A, sender: '972550000001', content: 'one', fromMe: false });
    const r2 = fake.addMessage({ id: 'm2', chatJid: CHAT_A, sender: '972550000001', content: 'two', fromMe: true });
    const db = open(path);

    const all = db.rowsAfter(0, 500);
    expect(all.map((r) => r.rowid)).toEqual([r1, r2]);
    expect(all[0]).toMatchObject({
      id: 'm1',
      chat_jid: CHAT_A,
      sender: '972550000001',
      content: 'one',
      media_type: '',
      deleted_at: null,
    });
    expect(Number(all[1]?.is_from_me)).toBe(1);
    expect(db.rowsAfter(r1, 500).map((r) => r.id)).toEqual(['m2']);
    expect(db.rowsAfter(0, 1)).toHaveLength(1);
    expect(db.maxRowid()).toBe(r2);
    expect(db.chatName(CHAT_A)).toBe('Dana');
    expect(db.chatName(CHAT_B)).toBeNull();
  });

  it('normalises NULL and non-text column values without guessing', () => {
    const { path, fake } = newStore();
    fake.addChat(CHAT_A, null);
    fake.close();
    const raw = new DatabaseSync(path);
    raw.exec(
      `INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, deleted_at)
       VALUES ('n1', '${CHAT_A}', 'x', NULL, NULL, NULL, NULL, NULL)`,
    );
    raw.exec(`INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, deleted_at)
       VALUES ('n2', '${CHAT_A}', 'x', 'txt', x'00', 1, '', x'00')`);
    raw.close();
    const rows = open(path).rowsAfter(0, 10);
    expect(rows[0]).toMatchObject({
      id: 'n1',
      content: null,
      timestamp: null,
      is_from_me: 0,
      media_type: null,
      deleted_at: null,
    });
    expect(rows[1]).toMatchObject({ id: 'n2', timestamp: null, deleted_at: null, is_from_me: 1 });
    expect(open(path).chatName(CHAT_A)).toBeNull();
  });

  it('lastMessages returns the last n rows of ONE chat, newest last', () => {
    const { path, fake } = newStore();
    for (let i = 1; i <= 5; i++)
      fake.addMessage({ id: `a${i}`, chatJid: CHAT_A, sender: '972550000001', content: `a${i}`, fromMe: false });
    fake.addMessage({ id: 'b1', chatJid: CHAT_B, sender: '972550000002', content: 'b1', fromMe: false });
    const db = open(path);
    expect(db.lastMessages(CHAT_A, 3).map((r) => r.content)).toEqual(['a3', 'a4', 'a5']);
    expect(db.lastMessages(CHAT_B, 3).map((r) => r.content)).toEqual(['b1']);
    expect(db.lastMessages(CHAT_A, 0)).toEqual([]);
  });

  it('outboundAfter returns only own rows newer than the given rowid, newest first', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'in1', chatJid: CHAT_A, sender: '972550000001', content: 'in', fromMe: false });
    const base = fake.addMessage({ id: 'out1', chatJid: CHAT_A, sender: 'me', content: 'first', fromMe: true });
    fake.addMessage({ id: 'out2', chatJid: CHAT_A, sender: 'me', content: 'second', fromMe: true });
    const db = open(path);
    expect(db.outboundAfter(CHAT_A, 0, 10).map((r) => r.content)).toEqual(['second', 'first']);
    expect(db.outboundAfter(CHAT_A, base, 10).map((r) => r.content)).toEqual(['second']);
    expect(db.outboundAfter(CHAT_A, 0, 0)).toEqual([]);
  });
});

describe('createBridgeDb - userHasSentIn (A13 / [R2])', () => {
  it('an own TEXT message makes the chat known', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'x', chatJid: CHAT_A, sender: 'me', content: 'hello', fromMe: true });
    expect(open(path).userHasSentIn(CHAT_A)).toBe(true);
  });

  it.each([
    ['an own reaction', { mediaType: 'reaction', content: '\u{1F44D}' }],
    ['an own empty row', { mediaType: 'image', content: '' }],
    ['an own deleted row', { content: 'oops', deleted: true }],
  ])('%s does NOT make the chat known', (_label, extra) => {
    const { path, fake } = newStore();
    fake.addMessage(Object.assign({ id: 'x', chatJid: CHAT_A, sender: 'me', fromMe: true, content: '' }, extra));
    expect(open(path).userHasSentIn(CHAT_A)).toBe(false);
  });

  it('an inbound message never makes the chat known', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'x', chatJid: CHAT_A, sender: '972550000001', content: 'hi there', fromMe: false });
    expect(open(path).userHasSentIn(CHAT_A)).toBe(false);
  });

  it('an own text row next to an own reaction still counts', () => {
    const { path, fake } = newStore();
    fake.addMessage({
      id: 'r',
      chatJid: CHAT_A,
      sender: 'me',
      content: '\u{1F44D}',
      fromMe: true,
      mediaType: 'reaction',
    });
    fake.addMessage({ id: 't', chatJid: CHAT_A, sender: 'me', content: 'ok', fromMe: true });
    expect(open(path).userHasSentIn(CHAT_A)).toBe(true);
  });
});

describe('createBridgeDb - phoneJidForLid', () => {
  it('resolves a seeded whatsmeow_lid_map row to the full phone JID', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'x', chatJid: LID, sender: '55500001', content: 'hi', fromMe: false });
    fake.addLidMapping(LID, CHAT_A);
    const db = open(path);
    expect(db.phoneJidForLid(LID)).toBe(CHAT_A);
    expect(db.phoneJidForLid('55599999@lid')).toBeNull();
  });

  it('accepts a mapping keyed by the user part and completes a bare phone number', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'x', chatJid: LID, sender: '55500001', content: 'hi', fromMe: false });
    fake.addLidMapping('55500001', '972550000001');
    const db = open(path);
    expect(db.phoneJidForLid(LID)).toBe(CHAT_A);
    expect(db.phoneJidForLid('55500001')).toBe(CHAT_A); // bare user part, no @server
  });

  it('[repair] lastMessages of a phone JID also returns the rows the bridge kept under the @lid twin', () => {
    // The LID residue: app.db was re-keyed to the phone JID by mergeLidInto, messages.db still keys the rows under @lid.
    // A chat-scoped read that trusts chats.jid alone hands S1 an EMPTY context window.
    const { path, fake } = newStore();
    fake.addMessage({ id: 'l1', chatJid: LID, sender: '55500001', content: 'coffee?', fromMe: false });
    fake.addMessage({ id: 'l2', chatJid: LID, sender: 'me', content: 'when?', fromMe: true });
    fake.addLidMapping(LID, CHAT_A);
    const db = open(path);
    expect(db.lastMessages(CHAT_A, 10).map((r) => r.content)).toEqual(['coffee?', 'when?']);
    expect(db.outboundAfter(CHAT_A, 0, 10).map((r) => r.content)).toEqual(['when?']);
  });

  it('[repair] a chat-scoped read merges both JID forms in rowid order and never leaks another contact', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'l1', chatJid: LID, sender: '55500001', content: 'old-lid', fromMe: false });
    fake.addMessage({ id: 'o1', chatJid: CHAT_B, sender: '972550000002', content: 'other', fromMe: false });
    fake.addMessage({ id: 'p1', chatJid: CHAT_A, sender: '972550000001', content: 'new-phone', fromMe: false });
    fake.addLidMapping(LID, CHAT_A);
    const db = open(path);
    expect(db.lastMessages(CHAT_A, 10).map((r) => r.content)).toEqual(['old-lid', 'new-phone']);
    expect(db.lastMessages(LID, 10).map((r) => r.content)).toEqual(['old-lid', 'new-phone']);
    expect(db.lastMessages(CHAT_B, 10).map((r) => r.content)).toEqual(['other']);
  });

  it('returns null when the store has no whatsmeow_lid_map table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-bridgedb-'));
    dirs.push(dir);
    const path = join(dir, 'messages.db');
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT)');
    raw.exec(
      'CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, media_type TEXT, deleted_at TIMESTAMP)',
    );
    raw.close();
    const db = open(path);
    expect(db.phoneJidForLid(LID)).toBeNull();
    expect(db.phoneJidForLid(LID)).toBeNull(); // the probe result is remembered
  });
});

describe('createBridgeDb - concurrency', () => {
  it('surfaces SQLITE_BUSY instead of corrupting or waiting forever', async () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 'x', chatJid: CHAT_A, sender: '972550000001', content: 'hi', fromMe: false });
    const db = open(path);
    expect(db.rowsAfter(0, 10)).toHaveLength(1);

    const lock = fake.holdWriteLock(2500); // longer than the 2 s busy_timeout
    let error: unknown = null;
    try {
      db.rowsAfter(0, 10);
    } catch (e) {
      error = e;
    }
    await lock;
    expect(String((error as Error | null)?.message ?? '')).toMatch(/locked|busy/i);
    // the next trigger succeeds again
    expect(db.rowsAfter(0, 10)).toHaveLength(1);
  }, 15_000);
});

// =====================================================================================================================================
// [V2] B17 / C2 12: the four SELECT-only reads + the `filename` column (owner V2-W1-05-wa-toolserver)
// =====================================================================================================================================
describe('[V2] createBridgeDb - the four WhatsApp-tool reads', () => {
  const seed = (fake: FakeBridgeDb, chat: string, n: number, prefix: string): number[] =>
    Array.from({ length: n }, (_, i) =>
      fake.addMessage({
        id: `${prefix}${i}`,
        chatJid: chat,
        sender: '972550000001',
        content: `${prefix} text ${i}`,
        fromMe: i % 2 === 0,
      }),
    );

  it('messagesBefore: one contact (both JID forms), rowid < before, newest first, LIMIT n', () => {
    const { path, fake } = newStore();
    fake.addLidMapping(LID, CHAT_A);
    const a = seed(fake, CHAT_A, 3, 'a');
    seed(fake, CHAT_B, 2, 'b');
    const l = seed(fake, LID, 2, 'l');
    const db = open(path);
    expect(db.messagesBefore(CHAT_A, null, 10).map((r) => r.id)).toEqual(['l1', 'l0', 'a2', 'a1', 'a0']);
    expect(db.messagesBefore(LID, null, 10).map((r) => r.id)).toEqual(['l1', 'l0', 'a2', 'a1', 'a0']);
    expect(db.messagesBefore(CHAT_A, l[0]!, 2).map((r) => r.rowid)).toEqual([a[2], a[1]]);
    expect(db.messagesBefore(CHAT_A, null, 0)).toEqual([]);
    expect(db.messagesBefore(CHAT_A, null, Number.NaN)).toEqual([]);
    expect(db.messagesBefore('972550000009@s.whatsapp.net', null, 5)).toEqual([]);
  });

  it('messageByRowid: the row with its chat_jid; unknown / invalid rowids => null', () => {
    const { path, fake } = newStore();
    const [r0] = seed(fake, CHAT_B, 1, 'b');
    const db = open(path);
    expect(db.messageByRowid(r0!)).toMatchObject({ id: 'b0', chat_jid: CHAT_B, content: 'b text 0', filename: null });
    for (const bad of [0, -1, 1.5, Number.NaN, 999_999]) expect(db.messageByRowid(bad)).toBeNull();
  });

  it('searchContent: instr() on a BOUND needle (ASCII case-folded + exact), deleted / NULL content excluded, newest first', () => {
    const { path, fake } = newStore();
    fake.addMessage({ id: 's1', chatJid: CHAT_A, sender: '1', content: 'Coffee on Wednesday?', fromMe: false });
    fake.addMessage({ id: 's2', chatJid: CHAT_B, sender: '1', content: 'coffee later', fromMe: false });
    fake.addMessage({ id: 's3', chatJid: CHAT_A, sender: '1', content: 'נקבע קפה ברביעי', fromMe: true });
    fake.seedDeleted({ id: 's4', chatJid: CHAT_A, sender: '1', content: 'deleted coffee', fromMe: false });
    fake.addMessage({ id: 's5', chatJid: CHAT_A, sender: '1', content: "100% ' OR 1=1 -- _x_", fromMe: false });
    const db = open(path);
    expect(db.searchContent('coffee', CHAT_A, 0, 10).map((r) => r.id)).toEqual(['s1']);
    expect(db.searchContent('COFFEE', null, 0, 10).map((r) => r.id)).toEqual(['s2', 's1']);
    expect(db.searchContent('קפה', CHAT_A, 0, 10).map((r) => r.id)).toEqual(['s3']);
    expect(db.searchContent("' OR 1=1 --", null, 0, 10).map((r) => r.id)).toEqual(['s5']);
    expect(db.searchContent('%', null, 0, 10).map((r) => r.id)).toEqual(['s5']); // literal, not a LIKE wildcard
    expect(db.searchContent('coffee', null, 0, 1).map((r) => r.id)).toEqual(['s2']);
    const s1 = db.searchContent('Wednesday', CHAT_A, 0, 1)[0]!.rowid;
    expect(db.searchContent('coffee', null, s1, 10).map((r) => r.id)).toEqual(['s2']); // rowid > sinceRowid
  });

  it('recentDmChats: DM JIDs only (phone + @lid), MAX(rowid) order, no group / status / newsletter', () => {
    const { path, fake } = newStore();
    seed(fake, CHAT_A, 1, 'a');
    fake.seedGroupRow({ chatJid: '972550000003-1700000000@g.us', id: 'g0', content: 'group' });
    fake.seedStatusRow({ id: 'st0', content: 'status' });
    fake.seedNewsletterRow({ chatJid: '972550000004@newsletter', id: 'n0', content: 'news' });
    seed(fake, LID, 1, 'l');
    seed(fake, CHAT_B, 1, 'b');
    const db = open(path);
    expect(db.recentDmChats(10).map((c) => c.jid)).toEqual([CHAT_B, LID, CHAT_A]);
    expect(db.recentDmChats(1)).toHaveLength(1);
    expect(db.recentDmChats(0)).toEqual([]);
  });

  it('every SELECT carries the UNTRUSTED filename column; a store without the column reads NULL instead of failing', () => {
    const { path, fake } = newStore();
    fake.seedMediaRow({ chatJid: CHAT_A, id: 'img1', mediaType: 'image', filename: 'IMG-0001.jpg' });
    const db = open(path);
    expect(db.rowsAfter(0, 5)[0]).toMatchObject({ id: 'img1', filename: 'IMG-0001.jpg', media_type: 'image' });
    expect((db.lastMessages(CHAT_A, 1)[0] as BridgeMessageRowV2).filename).toBe('IMG-0001.jpg');

    const dir = mkdtempSync(join(tmpdir(), 'wca-bridgedb-'));
    dirs.push(dir);
    const oldPath = join(dir, 'messages.db');
    const raw = new DatabaseSync(oldPath);
    raw.exec(
      'CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, media_type TEXT, deleted_at TIMESTAMP)',
    );
    raw
      .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, 0, ?, NULL)')
      .run('o1', CHAT_A, '1', 'old', '2026-09-21 10:00:00+03:00', '');
    raw.close();
    const old = open(oldPath);
    expect(old.messagesBefore(CHAT_A, null, 5)[0]).toMatchObject({ id: 'o1', filename: null });
  });

  it('SQLITE_BUSY => [] / null for the four reads (never a throw); the connection stays read-only', async () => {
    const { path, fake } = newStore();
    const [r0] = seed(fake, CHAT_A, 2, 'a');
    const db = open(path);
    db.open();
    const lock = fake.holdWriteLock(2_600);
    expect(db.messagesBefore(CHAT_A, null, 5)).toEqual([]);
    expect(db.messageByRowid(r0!)).toBeNull();
    expect(db.searchContent('text', null, 0, 5)).toEqual([]);
    expect(db.recentDmChats(5)).toEqual([]);
    await lock;
    expect(db.messagesBefore(CHAT_A, null, 5)).toHaveLength(2);
    const src = readFileSync(fileURLToPath(new URL('./bridgeDb.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/\bCREATE INDEX\b/i);
  }, 20_000);

  it('a non-busy failure propagates, and a closed / missing store answers empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-bridgedb-'));
    dirs.push(dir);
    const missing = open(join(dir, 'nope', 'messages.db'));
    expect(missing.messagesBefore(CHAT_A, null, 5)).toEqual([]);
    expect(missing.recentDmChats(5)).toEqual([]);
    expect(missing.messageByRowid(1)).toBeNull();
    const p = join(dir, 'broken.db');
    const raw = new DatabaseSync(p);
    raw.exec('CREATE TABLE unrelated (x INTEGER)');
    raw.close();
    const broken = open(p);
    expect(() => broken.messagesBefore(CHAT_A, null, 5)).toThrow(/no such table/);
  });
});
