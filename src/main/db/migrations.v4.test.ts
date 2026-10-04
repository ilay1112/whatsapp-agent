// V2-W0-scaffold (build plan section 2 step 4; owner V2-W1-01-db afterwards): migration v4 smoke tests.
//  - `openDb(':memory:')` yields a v4 database with the finalisation columns, the F4 trigger clauses and the new reasons;
//  - the bundled `node:sqlite` supports `unixepoch('subsec')` (the F4 expiry clause needs SQLite >= 3.42);
//  - a hand-built v3 database with one row per table migrates to v4 with every row kept and the backfills applied.
// The full v3-fixture round-trip (tests/fixtures/v3.db) is V2-W1-01's.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSchema } from '../../shared/settings';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';
import { MEMORY_DB, openDb, type Db } from './index';
import { cleanup, tempDir, track } from './__fixtures__/testDb';

afterEach(cleanup);

const columnsOf = (db: Db, table: string): string[] =>
  db
    .prepare<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((r) => r.name);
const sqlOf = (db: Db, name: string): string =>
  db.prepare<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?').get(name)?.sql ?? '';
const count = (db: Db, table: string): number =>
  db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

describe('bundled SQLite', () => {
  it("supports unixepoch('subsec') (F4 expiry clause, SQLite >= 3.42)", () => {
    const db = track(openDb(MEMORY_DB));
    const row = db
      .prepare<{ v: number; ver: string }>("SELECT unixepoch('subsec') AS v, sqlite_version() AS ver")
      .get()!;
    expect(typeof row.v).toBe('number');
    expect(row.v).toBeGreaterThan(1_700_000_000);
    const [maj, min] = row.ver.split('.').map(Number) as [number, number];
    expect(maj > 3 || (maj === 3 && min >= 42), row.ver).toBe(true);
  });
});

describe("openDb(':memory:') is a v4 database", () => {
  it('is at SCHEMA_VERSION 4 with every migration recorded', () => {
    const db = track(openDb(MEMORY_DB));
    expect(SCHEMA_VERSION).toBe(4);
    expect(db.userVersion()).toBe(4);
    expect(
      db
        .prepare<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((r) => r.version),
    ).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('carries the finalisation columns (F1, F27, F28) and the v2 tables', () => {
    const db = track(openDb(MEMORY_DB));
    expect(columnsOf(db, 'items')).toEqual(
      expect.arrayContaining([
        'linked_item_id',
        'event_revision',
        'calendar_updated',
        'trigger_kind',
        'event_origin_item_id',
      ]),
    );
    expect(columnsOf(db, 'proposals')).toEqual(
      expect.arrayContaining(['delta_json', 'image_json', 'provider_class', 'cross_chat_rows', 'trigger_author']),
    );
    expect(columnsOf(db, 'event_revisions')).toEqual(expect.arrayContaining(['post_etag', 'post_updated']));
    expect(columnsOf(db, 'actions')).toContain('approved_by');
    expect(columnsOf(db, 'chats')).toEqual(expect.arrayContaining(['auto_policy', 'auto_tainted_until']));
    expect(columnsOf(db, 'consents')).toContain('terms_read_on');
    expect(columnsOf(db, 'model_files')).toContain('kind');
    for (const t of ['auto_policies', 'auto_decisions', 'auto_writes', 'event_revisions', 'transcripts', 'media_cache'])
      expect(sqlOf(db, t), t).toMatch(/^CREATE TABLE/);
  });

  it('has the F4 trigger clauses and the two finalisation reasons of auto_decisions', () => {
    const db = track(openDb(MEMORY_DB));
    const trg = sqlOf(db, 'trg_actions_state');
    expect(trg).toContain("NEW.approved_by = 'user_toast'");
    expect(trg).toContain("unixepoch('subsec')");
    expect(trg).toContain('NEW.approved_final_json = NEW.canonical_json');
    expect(trg).toContain("d.kind IN ('update','cancel')");
    const reasons = sqlOf(db, 'auto_decisions');
    for (const r of ['content_rejected', 'multiple_events', 'cross_chat_rows']) expect(reasons, r).toContain(`'${r}'`);
    expect(sqlOf(db, 'trg_actions_approver_frozen')).toMatch(/approver is immutable/);
  });
});

describe('v3 -> v4 smoke (one row per v3 table)', () => {
  const T = 1_790_000_000_000;
  const V1_SETTINGS = {
    general: { language: 'system', autostart: false, timeZone: 'Asia/Jerusalem', notifications: 'generic' },
    llm: {
      provider: 'local',
      claudeModel: 'claude-opus-5',
      geminiModel: 'gemini-3.8-flash',
      local: { tier: 'auto', acceleration: 'auto', forceCpu: false },
      cloudDailyTokenBudget: 200_000,
    },
    whatsapp: { processUnknownSenders: false, backlogHours: 0 },
    calendar: { targetCalendarId: 'primary', conflictCalendarIds: ['primary'], defaultDurationMin: 60 },
    agent: { paused: false, ambiguousHour: 'assume', userGender: 'unspecified' },
    privacy: { retentionDays: 30 },
  };
  const V3_TABLES = [
    'meta',
    'settings',
    'secrets',
    'consents',
    'chats',
    'items',
    'item_messages',
    'triage_queue',
    'runs',
    'proposals',
    'actions',
    'audit_log',
    'rate_events',
    'model_files',
  ] as const;

  /** A v3 file exactly as v0.1.x left it: migrations 1-3 applied by hand, one synthetic row in every table (T5). */
  function buildV3(file: string): void {
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys=ON');
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
      raw.exec(m.sql);
      raw
        .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, T);
    }
    raw.exec('PRAGMA user_version = 3');
    const sha = (c: string): string => c.repeat(64);
    raw.exec(`
      INSERT INTO meta VALUES ('onboarding_step', 'done');
      INSERT INTO settings VALUES ('settings', '${JSON.stringify(V1_SETTINGS)}', ${T});
      INSERT INTO secrets VALUES ('anthropic_api_key', x'00', ${T});
      INSERT INTO consents VALUES ('cloud_claude', 1, ${T});
      INSERT INTO chats (id, jid, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', ${T}, ${T});
      INSERT INTO items (id, chat_id, state, analysis, event_state, trigger_msg_id, trigger_ts, calendar_event_id, created_at, updated_at)
        VALUES (1, 1, 'in_calendar', 'done', 'created', 'MSG1', ${T}, 'evt0001', ${T}, ${T});
      INSERT INTO item_messages VALUES (1, 'MSG1', 0, ${T}, 'synthetic', '${sha('0')}');
      INSERT INTO triage_queue (chat_id, due_at, first_enqueued_at) VALUES (1, ${T}, ${T});
      INSERT INTO runs (item_id, stage, provider, model, started_at) VALUES (1, 'extract', 'claude', 'm', ${T});
      INSERT INTO proposals (id, item_id, version, provider, model, created_at) VALUES (1, 1, 1, 'gemini', 'm', ${T});
      INSERT INTO actions (id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, created_at, expires_at)
        VALUES ('a1', 1, 1, 1, 'create_event', '{}', '${sha('a')}', 'k1', ${T}, ${T + 1});
      UPDATE actions SET state = 'approved', approved_at = ${T}, approved_final_json = '{}' WHERE id = 'a1';
      UPDATE actions SET state = 'executing' WHERE id = 'a1';
      UPDATE actions SET state = 'done', executed_at = ${T} WHERE id = 'a1';
      INSERT INTO audit_log (ts, kind, ref, detail_json) VALUES (${T}, 'approved', 'a1', '{}');
      INSERT INTO rate_events VALUES ('llm', 'k', ${T});
      INSERT INTO model_files (id, path, size, sha256, mtime, status) VALUES ('small', 'm.gguf', 1, '${sha('b')}', ${T}, 'ready');
    `);
    raw.close();
  }

  it('keeps every row, applies the backfills and leaves no FK violation', () => {
    const file = path.join(tempDir(), 'app.db');
    buildV3(file);
    const db = track(openDb(file));
    expect(db.userVersion()).toBe(4);
    for (const t of V3_TABLES) expect(count(db, t), t).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    expect(db.prepare('SELECT event_revision, event_origin_item_id, trigger_kind FROM items').get()).toEqual({
      event_revision: 1,
      event_origin_item_id: 1,
      trigger_kind: 'text',
    });
    expect(db.prepare('SELECT provider_class, trigger_author FROM proposals').get()).toEqual({
      provider_class: 'api_key',
      trigger_author: 'contact',
    });
    expect(db.prepare('SELECT state, approved_by FROM actions').get()).toEqual({ state: 'done', approved_by: 'user' });
    expect(db.prepare('SELECT terms_read_on FROM consents').get()).toEqual({ terms_read_on: null });
    expect(db.prepare('SELECT kind FROM model_files').get()).toEqual({ kind: 'llm' });
    expect(db.prepare('SELECT auto_policy FROM chats').get()).toEqual({ auto_policy: 'inherit' });
    const settings = JSON.parse(
      db.prepare<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'settings'").get()!.value_json,
    ) as unknown;
    expect(SettingsSchema.safeParse(settings).success).toBe(true);
  });

  it('the v4 trigger refuses an approve without approved_by on a migrated database (F18, B6)', () => {
    const file = path.join(tempDir(), 'app.db');
    buildV3(file);
    const db = track(openDb(file));
    db.exec(`INSERT INTO actions (id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, created_at, expires_at)
             VALUES ('a2', 1, 1, 1, 'send_reply', '{}', '${'c'.repeat(64)}', 'k2', ${T}, ${T + 1})`);
    expect(() =>
      db.exec(`UPDATE actions SET state = 'approved', approved_at = ${T}, approved_final_json = '{}' WHERE id = 'a2'`),
    ).toThrow(/bad approve/);
    db.exec(
      `UPDATE actions SET state = 'approved', approved_at = ${T}, approved_final_json = '{}', approved_by = 'user' WHERE id = 'a2'`,
    );
    expect(db.prepare("SELECT approved_by FROM actions WHERE id = 'a2'").get()).toEqual({ approved_by: 'user' });
  });
});
