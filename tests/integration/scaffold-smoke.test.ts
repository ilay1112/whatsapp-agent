// W0 smoke for the integration project (owner W2-01 from Wave 2): the fake bridge DB writes the real schema on disk, the app DB
// migrates in a temp file (WAL), and the T2/T3 guards of tests/setup-guards.ts are live in this project.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeBridgeDb, formatGoSqlite3 } from '../fakes/fake-bridge-db.ts';
import { openDb } from '../../src/main/db/index.ts';
import { SCHEMA_VERSION } from '../../src/main/db/migrations.ts';
import { DatabaseSync } from 'node:sqlite';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wca-w0-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('fake bridge DB', () => {
  it('creates the bridge schema (rollback journal), upserts on (id, chat_jid), seeds LID mappings', () => {
    const dir = tmp();
    const fb = createFakeBridgeDb({ path: join(dir, 'store', 'messages.db') });
    fb.addChat('972550000001@s.whatsapp.net', 'Test Contact');
    const r1 = fb.addMessage({
      id: 'M1',
      chatJid: '972550000001@s.whatsapp.net',
      sender: '972550000001',
      content: 'coffee Thursday at 5?',
      fromMe: false,
    });
    const r2 = fb.addMessage({
      id: 'M1',
      chatJid: '972550000001@s.whatsapp.net',
      sender: '972550000001',
      content: 'coffee Thursday at 6?',
      fromMe: false,
    });
    expect(r2).toBe(r1);
    fb.addLidMapping('123456789@lid', '972550000001@s.whatsapp.net');
    fb.close();

    const ro = new DatabaseSync(join(dir, 'store', 'messages.db'), { readOnly: true });
    try {
      expect((ro.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('delete');
      const cols = (ro.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
      for (const c of [
        'id',
        'chat_jid',
        'sender',
        'content',
        'timestamp',
        'is_from_me',
        'media_type',
        'filename',
        'deleted_at',
        'quoted_message_id',
      ])
        expect(cols).toContain(c);
      const row = ro.prepare('SELECT content, timestamp FROM messages WHERE id = ?').get('M1') as {
        content: string;
        timestamp: string;
      };
      expect(row.content).toBe('coffee Thursday at 6?');
      expect(row.timestamp).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,9})?[+-]\d\d:\d\d$/);
      expect(
        (ro.prepare('SELECT pn FROM whatsmeow_lid_map WHERE lid = ?').get('123456789@lid') as { pn: string }).pn,
      ).toBe('972550000001@s.whatsapp.net');
      expect((ro.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n).toBe(1);
    } finally {
      ro.close();
    }
  });
  it('formats go-sqlite3 timestamps with trailing zeros trimmed', () => {
    expect(formatGoSqlite3(new Date(Date.UTC(2026, 8, 21, 17, 15, 3, 120)), 180, 0)).toBe(
      '2026-09-21 20:15:03.12+03:00',
    );
    expect(formatGoSqlite3(new Date(Date.UTC(2026, 8, 21, 17, 15, 3, 0)), 180, 0)).toBe('2026-09-21 20:15:03+03:00');
    expect(formatGoSqlite3(new Date(Date.UTC(2026, 8, 21, 17, 15, 3, 123)), 180, 456789)).toBe(
      '2026-09-21 20:15:03.123456789+03:00',
    );
    expect(formatGoSqlite3(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0)), 0, 0)).toBe('2026-01-01 00:00:00Z');
  });
});

describe('app DB on disk', () => {
  it('openDb migrates a temp file in WAL mode', () => {
    const dir = tmp();
    const db = openDb(join(dir, 'app.db'));
    try {
      expect(db.userVersion()).toBe(SCHEMA_VERSION);
      expect(db.prepare<{ journal_mode: string }>('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
    } finally {
      db.close();
    }
    expect(existsSync(join(dir, 'app.db'))).toBe(true);
  });
});

describe('guards are live', () => {
  it('T2: the reference store path is refused by node:sqlite and fs', () => {
    // a NON-existent path under tmpdir that merely matches the forbidden pattern (the real store is never touched, not even by this test)
    const forbidden = join(tmp(), 'whatsapp-mcp', 'whatsapp-bridge', 'store', 'messages.db');
    expect(() => new DatabaseSync(forbidden, { readOnly: true })).toThrow(/FORBIDDEN_PATH_IN_TESTS/);
    expect(() => existsSync(forbidden)).toThrow(/FORBIDDEN_PATH_IN_TESTS/);
  });
  it('T3: non-loopback fetch is refused before any socket opens', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(/NETWORK_FORBIDDEN_IN_TESTS/);
  });
});
