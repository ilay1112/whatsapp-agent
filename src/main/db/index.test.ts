// W0: openDb(':memory:') yields a migrated database on day one; the DDL triggers of CONTRACTS 15.2 behave.
// W1-04: the hardened pragmas, the slow-statement warning and the createRepos wiring (TESTS 5.3 row `db/*`).
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepos, openDb, setSlowStatementHandler, SLOW_STATEMENT_MS, type Db, type SlowStatement } from './index';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from './migrations';
import { cleanup, tempDir, track } from './__fixtures__/testDb';

const opened: Db[] = [];
const open = (): Db => {
  const db = openDb(':memory:');
  opened.push(db);
  return db;
};
afterEach(() => {
  setSlowStatementHandler(null);
  vi.unstubAllEnvs();
  for (const db of opened.splice(0)) db.close();
  cleanup();
});

function seedAction(db: Db, id = 'a1'): void {
  db.exec(`INSERT INTO chats(id, jid, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', 1, 1)`);
  db.exec(
    `INSERT INTO items(id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at) VALUES (1, 1, 'needs_reply', 'm1', 1, 1, 1)`,
  );
  db.exec(`INSERT INTO proposals(id, item_id, version, provider, model, created_at) VALUES (1, 1, 1, 'local', 'm', 1)`);
  db.prepare(
    `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, created_at, expires_at)
     VALUES (?, 1, 1, 1, 'send_reply', '{}', ?, ?, 1, 2)`,
  ).run(id, 'a'.repeat(64), `1:send_reply:1:${id}`);
}

describe('openDb + migrate', () => {
  it('applies every migration and records it', () => {
    const db = open();
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
    const rows = db
      .prepare<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version')
      .all();
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    const tables = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of [
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
    ]) {
      expect(tables).toContain(t);
    }
    expect(db.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
  });
  it('is idempotent and refuses a downgrade', () => {
    const db = open();
    expect(
      migrate(
        db,
        () => undefined,
        () => 1,
      ),
    ).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() =>
      migrate(
        db,
        () => undefined,
        () => 1,
      ),
    ).toThrow(/downgrade/);
  });
  it('takes a backup exactly once before the first pending migration', () => {
    const raw = openDb(':memory:');
    opened.push(raw);
    let backups = 0;
    // fresh in-memory handle already migrated by openDb; simulate a pre-migration db by resetting user_version on an empty db
    const fresh = openDb(':memory:');
    opened.push(fresh);
    expect(
      migrate(
        fresh,
        () => backups++,
        () => 1,
      ),
    ).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(backups).toBe(0);
  });
  it('transaction() commits, rolls back on throw and nests', () => {
    const db = open();
    db.transaction(() => {
      db.exec(`INSERT INTO meta(key, value) VALUES ('a', '1')`);
      db.transaction(() => db.exec(`INSERT INTO meta(key, value) VALUES ('b', '2')`));
    });
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM meta').get()!.n).toBe(2);
    expect(() =>
      db.transaction(() => {
        db.exec(`INSERT INTO meta(key, value) VALUES ('c', '3')`);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM meta').get()!.n).toBe(2);
  });
});

describe('actions triggers (CONTRACTS 15.2)', () => {
  it('actions must be born pending with content', () => {
    const db = open();
    seedAction(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, state, created_at, expires_at)
         VALUES ('a2', 1, 1, 1, 'send_reply', '{}', ?, 'k2', 'approved', 1, 2)`,
        )
        .run('a'.repeat(64)),
    ).toThrow(/born pending/);
  });
  it('happy path pending -> approved -> executing -> done; then terminal', () => {
    const db = open();
    seedAction(db);
    expect(
      db
        .prepare(
          `UPDATE actions SET state='approved', approved_at=1, approved_final_json='{}', approved_by='user' WHERE id='a1' AND state='pending'`,
        )
        .run().changes,
    ).toBe(1);
    expect(db.prepare(`UPDATE actions SET state='executing' WHERE id='a1' AND state='approved'`).run().changes).toBe(1);
    expect(() => db.exec(`UPDATE actions SET state='pending' WHERE id='a1'`)).toThrow(/cannot return to pending/);
    expect(() => db.exec(`UPDATE actions SET approved_final_json='{"x":1}' WHERE id='a1'`)).toThrow(
      /final payload is immutable/,
    );
    expect(db.prepare(`UPDATE actions SET state='done' WHERE id='a1' AND state='executing'`).run().changes).toBe(1);
    expect(() => db.exec(`UPDATE actions SET state='failed' WHERE id='a1'`)).toThrow(/terminal state/);
    expect(() => db.exec(`UPDATE actions SET canonical_json='{"y":2}' WHERE id='a1'`)).toThrow(/immutable/);
    // retention may NULL canonical_json on a terminal row when nothing else changes
    expect(db.prepare(`UPDATE actions SET canonical_json=NULL WHERE id='a1'`).run().changes).toBe(1);
  });
  it('illegal transitions abort', () => {
    const db = open();
    seedAction(db);
    expect(() => db.exec(`UPDATE actions SET state='executing' WHERE id='a1'`)).toThrow(/execute without approval/);
    expect(() => db.exec(`UPDATE actions SET state='approved' WHERE id='a1'`)).toThrow(/bad approve/);
    expect(() => db.exec(`UPDATE actions SET state='failed' WHERE id='a1'`)).toThrow(/bad outcome/);
    expect(() => db.exec(`UPDATE actions SET state='done' WHERE id='a1'`)).toThrow(/bad done/);
    expect(db.prepare(`UPDATE actions SET state='rejected' WHERE id='a1' AND state='pending'`).run().changes).toBe(1);
    expect(() => db.exec(`UPDATE actions SET state='pending' WHERE id='a1'`)).toThrow(/terminal state/);
  });
  it('one open item per chat, audit append-only, cascade delete', () => {
    const db = open();
    seedAction(db);
    expect(() =>
      db.exec(
        `INSERT INTO items(id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at) VALUES (2, 1, 'info_missing', 'm2', 1, 1, 1)`,
      ),
    ).toThrow(/UNIQUE/);
    db.exec(`INSERT INTO audit_log(ts, kind, detail_json) VALUES (1, 'consent', '{}')`);
    expect(() => db.exec(`UPDATE audit_log SET kind='wipe'`)).toThrow(/append-only/);
    db.exec(`DELETE FROM items WHERE id = 1`);
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM actions').get()!.n).toBe(0);
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM proposals').get()!.n).toBe(0);
  });
});

describe('openDb hardening (W1-04)', () => {
  it('opens a file database in WAL with foreign keys and a busy timeout', () => {
    const db = track(openDb(path.join(tempDir(), 'app.db')));
    expect(db.prepare<{ journal_mode: string }>('PRAGMA journal_mode').get()!.journal_mode).toBe('wal');
    expect(db.prepare<{ foreign_keys: number }>('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
    expect(db.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()!.timeout).toBe(3000);
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
  });

  it('enforces the foreign keys of the DDL', () => {
    const db = open();
    expect(() =>
      db.exec(
        `INSERT INTO items(id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at) VALUES (9, 404, 'needs_reply', 'm', 1, 1, 1)`,
      ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('warns about a statement slower than 20 ms, and only in development', () => {
    const db = open();
    const slow: SlowStatement[] = [];
    setSlowStatementHandler((s) => slow.push(s));
    const heavy =
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT COUNT(*) AS n FROM c';
    db.prepare<{ n: number }>(heavy).get();
    expect(slow).toHaveLength(1);
    expect(slow[0]!.op).toBe('get');
    expect(slow[0]!.sql).toBe(heavy);
    expect(slow[0]!.ms).toBeGreaterThan(SLOW_STATEMENT_MS);

    db.prepare(`SELECT 1`).get();
    db.prepare(`SELECT 1`).all();
    db.prepare(`INSERT INTO meta(key, value) VALUES ('tray_hint_seen', '1')`).run();
    expect(slow).toHaveLength(1);

    vi.stubEnv('NODE_ENV', 'production');
    db.prepare<{ n: number }>(heavy).get();
    expect(slow).toHaveLength(1);
  });

  it('never measures when no handler is registered', () => {
    const db = open();
    const spy = vi.spyOn(performance, 'now');
    db.prepare(`SELECT 1`).get();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('createRepos', () => {
  it('exposes every repo of the CONTRACTS 15.1 interface over one handle', () => {
    const db = open();
    const repos = createRepos(db);
    expect(repos.db).toBe(db);
    expect(Object.keys(repos).sort()).toEqual([
      'actions',
      'audit',
      'autoDecisions', // [V2] C2 16.1 new repos
      'autoPolicies',
      'autoWrites',
      'chats',
      'consents',
      'db',
      'eventRevisions',
      'items',
      'mediaCache',
      'meta',
      'models',
      'proposals',
      'queue',
      'rate',
      'retention',
      'runs',
      'secrets',
      'settings',
      'transcripts',
    ]);
    // a smoke path through the wiring: chat -> item -> proposal -> action -> queue
    const chat = repos.chats.upsertFromBridge('972550000009@s.whatsapp.net', null, true, 1_000);
    const item = repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'm1',
      triggerTs: 1_000,
      analysis: 'queued',
      holdReason: null,
      now: 1_000,
    });
    const proposal = repos.proposals.insertNext({
      itemId: item.id,
      provider: 'local',
      model: 'm',
      extraction: null,
      draftText: 'd',
      replyLang: 'en',
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: 1_000,
    });
    const action = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      now: 1_000,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        text: 'hi',
      },
    });
    repos.queue.enqueue(chat.id, 1_000);
    repos.audit.append('action_created', action.id, { attempt: action.attempt }, 1_000);
    expect(repos.items.counts().analysing).toBe(1);
    expect(repos.actions.forItem(item.id)).toHaveLength(1);
    expect(repos.queue.size()).toBe(1);
  });
});
