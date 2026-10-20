// [v4 T6] migration v6 'manual_events' (handover §2.5, I9'): a v5 file with chat actions, an event revision and an automatic
// decision is upgraded with every row intact (source 'chat'), and from then on the database itself
//  - accepts a manual row only WITHOUT item / proposal / chat, and a chat row only WITH all three;
//  - keeps delete_event manual-only and send_reply chat-only;
//  - lets a manual row be approved ONLY by a click ('user') - never the toast, never an automatic decision;
//  - keeps the identity of a manual row (source included) immutable;
//  - accepts manual event_revisions rows (item_id NULL, manual kinds only) next to the chat chain.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';
import { createRepos, openDb, type Db } from './index';
import { cleanup, tempDir, track } from './__fixtures__/testDb';

afterEach(cleanup);

const T = 1_790_000_000_000;
const SHA = 'b'.repeat(64);
const CREATE_JSON = JSON.stringify({ kind: 'create_event', v: 1 });

/** A v5 file: migrations 1-5 applied by hand (what a v3 build left on disk) + chat data. */
function buildV5(file: string): void {
  const raw = new DatabaseSync(file);
  for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
    if (m.foreignKeysOff) raw.exec('PRAGMA foreign_keys=OFF');
    raw.exec(m.sql);
    raw.exec('PRAGMA foreign_keys=ON');
    raw.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, T);
  }
  raw.exec('PRAGMA user_version = 5');
  raw.exec(`
    INSERT INTO chats(id, jid, is_known, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', 1, ${T}, ${T});
    INSERT INTO items(id, chat_id, state, analysis, trigger_msg_id, trigger_ts, created_at, updated_at, event_state, event_revision,
                      calendar_event_id)
      VALUES (1, 1, 'in_calendar', 'done', 'm1', ${T}, ${T}, ${T}, 'created', 1, 'abcdefgh01');
    INSERT INTO proposals(id, item_id, version, provider, model, created_at) VALUES (1, 1, 1, 'local', 'test', ${T});
    INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, state, created_at, expires_at)
      VALUES ('a-create', 1, 1, 1, 'create_event', '${CREATE_JSON}', '${SHA}', '1:create_event:1', 'pending', ${T}, ${T + 1000}),
             ('a-reply',  1, 1, 1, 'send_reply',   '{"kind":"send_reply"}', '${SHA}', '1:send_reply:1', 'pending', ${T}, ${T + 1000});
    UPDATE actions SET state = 'approved', approved_at = ${T}, approved_final_json = canonical_json, approved_by = 'user' WHERE id = 'a-create';
    UPDATE actions SET state = 'executing' WHERE id = 'a-create';
    UPDATE actions SET state = 'done', result_json = '{"kind":"create_event","eventId":"abcdefgh01","htmlLink":null}' WHERE id = 'a-create';
    INSERT INTO event_revisions(calendar_event_id, item_id, revision, kind, prev_json, next_json, action_id, applied_at)
      VALUES ('abcdefgh01', 1, 1, 'create', NULL, NULL, 'a-create', ${T});
  `);
  raw.close();
}

function upgraded(): Db {
  const file = path.join(tempDir(), 'app.db');
  buildV5(file);
  return track(openDb(file));
}

const insertManual = (
  db: Db,
  id: string,
  kind: string,
  extra: Partial<Record<'item' | 'proposal' | 'chat', number>> = {},
) =>
  db
    .prepare(
      `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, state, created_at,
                           expires_at, source)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'pending', ?, ?, 'manual')`,
    )
    .run(id, extra.item ?? null, extra.proposal ?? null, extra.chat ?? null, kind, SHA, `manual:${id}`, T, T + 1000);

const approve = (db: Db, id: string, by: string) =>
  db
    .prepare(
      `UPDATE actions SET state = 'approved', approved_at = ?, approved_final_json = canonical_json, approved_by = ? WHERE id = ?`,
    )
    .run(T, by, id);

describe('migration v6 manual_events', () => {
  it('is the newest migration and runs with foreign keys off', () => {
    expect(SCHEMA_VERSION).toBe(6);
    const m = MIGRATIONS.at(-1)!;
    expect(m).toMatchObject({ version: 6, name: 'manual_events', foreignKeysOff: true });
  });

  it('upgrades a v5 file with its chat actions, revision and FK graph intact (source chat)', () => {
    const db = upgraded();
    expect(db.userVersion()).toBe(6);
    const rows = db
      .prepare<{ id: string; source: string; state: string; item_id: number; approved_by: string | null }>(
        `SELECT id, source, state, item_id, approved_by FROM actions ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      { id: 'a-create', source: 'chat', state: 'done', item_id: 1, approved_by: 'user' },
      { id: 'a-reply', source: 'chat', state: 'pending', item_id: 1, approved_by: null },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    // the chat repos read the upgraded rows exactly as before
    const repos = createRepos(db);
    expect(repos.actions.forItem(1 as never).map((a) => a.id)).toEqual(['a-create', 'a-reply']);
    expect(repos.actions.byId('a-create' as never)).toMatchObject({ itemId: 1, chatId: 1, state: 'done' });
    expect(repos.eventRevisions.newestFor('abcdefgh01')).toMatchObject({ revision: 1, kind: 'create', itemId: 1 });
    // chat NOT NULL semantics survive: a chat row without its ids is refused by the CHECK
    expect(() =>
      db
        .prepare(
          `INSERT INTO actions(id, kind, canonical_json, content_sha256, idempotency_key, created_at, expires_at)
           VALUES ('x', 'create_event', '{}', ?, 'x', ?, ?)`,
        )
        .run(SHA, T, T + 1),
    ).toThrow(/CHECK/);
    // the chat triggers still hold (a done row is terminal)
    expect(() => db.prepare(`UPDATE actions SET state = 'failed' WHERE id = 'a-create'`).run()).toThrow(/terminal/);
  });

  it('a manual row has no item / proposal / chat; delete_event is manual-only, send_reply chat-only', () => {
    const db = upgraded();
    insertManual(db, 'm-create', 'create_event');
    insertManual(db, 'm-delete', 'delete_event');
    expect(() => insertManual(db, 'm-bad', 'create_event', { item: 1, proposal: 1, chat: 1 })).toThrow(/CHECK/);
    expect(() => insertManual(db, 'm-reply', 'send_reply')).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO actions(id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, created_at, expires_at)
           VALUES ('c-del', 1, 1, 1, 'delete_event', '{}', ?, 'c-del', ?, ?)`,
        )
        .run(SHA, T, T + 1),
    ).toThrow(/CHECK/);
  });

  it('a manual row is approved ONLY by a click: the toast and an automatic decision id are refused by the trigger', () => {
    const db = upgraded();
    insertManual(db, 'm1', 'update_event');
    expect(() => approve(db, 'm1', 'user_toast')).toThrow(/manual needs a click/);
    expect(() => approve(db, 'm1', 'some-decision-id')).toThrow(/manual needs a click/);
    approve(db, 'm1', 'user');
    expect(db.prepare<{ s: string }>(`SELECT state AS s FROM actions WHERE id = 'm1'`).get()!.s).toBe('approved');
  });

  it('source and the (NULL) ids of a manual row are immutable', () => {
    const db = upgraded();
    insertManual(db, 'm2', 'create_event');
    expect(() => db.prepare(`UPDATE actions SET source = 'chat' WHERE id = 'm2'`).run()).toThrow();
    expect(() => db.prepare(`UPDATE actions SET item_id = 1 WHERE id = 'm2'`).run()).toThrow();
    expect(() => db.prepare(`UPDATE actions SET source = 'manual' WHERE id = 'a-reply'`).run()).toThrow();
  });

  it('event_revisions: manual kinds with item_id NULL only; the chat rev-1 rule still holds for chat rows', () => {
    const db = upgraded();
    insertManual(db, 'm3', 'update_event');
    const rev = (item: number | null, kind: string, revision: number, ev = 'manualev01') =>
      db
        .prepare(
          `INSERT INTO event_revisions(calendar_event_id, item_id, revision, kind, action_id, applied_at) VALUES (?, ?, ?, ?, 'm3', ?)`,
        )
        .run(ev, item, revision, kind, T);
    rev(null, 'manual_edit', 1); // a foreign event's first revision is an edit
    rev(null, 'manual_undo', 2);
    expect(() => rev(null, 'reschedule', 3)).toThrow(/CHECK/);
    expect(() => rev(1, 'manual_edit', 4)).toThrow(/CHECK/);
    expect(() => rev(1, 'reschedule', 1, 'otherev01')).toThrow(/CHECK/); // chat rev 1 must be 'create'
    expect(() => rev(null, 'manual_edit', 2)).toThrow(/UNIQUE/);
  });

  it('auto_decisions accepts the new reason name (AUTO_REASONS parity) and keeps its rows', () => {
    const db = upgraded();
    const cols = db.prepare<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'auto_decisions'`).get()!.sql;
    expect(cols).toContain("'manual_only'");
    const triggers = db
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .all()
      .map((r) => r.name);
    expect(triggers).toEqual(
      expect.arrayContaining([
        'trg_actions_state',
        'trg_actions_insert',
        'trg_actions_frozen',
        'trg_actions_final_frozen',
        'trg_actions_approver_frozen',
        'trg_auto_decisions_immutable',
        'trg_auto_writes_insert',
        'trg_auto_writes_frozen',
        'trg_event_rev_frozen',
      ]),
    );
  });
});
