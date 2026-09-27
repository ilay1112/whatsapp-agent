// TESTS 5.3 row `db/*`: migrations from user_version 0..N on an empty file, and tuple-vs-CHECK parity - every closed set of
// `src/shared/types.ts` must be exactly the list the frozen DDL of CONTRACTS 15.2 enforces (CONTRACTS 0, "Enums").
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations';
import { openDb } from './index';
import { cleanup, tempDir, track } from './__fixtures__/testDb';
import {
  ACTION_KINDS,
  ACTION_STATES,
  ANALYSIS_STATES,
  CHAT_POLICIES,
  CLOSED_REASONS,
  CONSENT_KINDS,
  EVENT_STATES,
  HOLD_REASONS,
  ITEM_STATES,
  LANGS,
  MODEL_FILE_STATUSES,
  MODEL_TIERS,
  OPEN_ITEM_STATES,
  PROVIDER_IDS,
  REPLY_STATES,
  SECRET_NAMES,
} from '../../shared/types';

afterEach(cleanup);

const DDL = MIGRATIONS.map((m) => m.sql).join('\n');
/** Every `<column> IN ('a','b')` of the DDL, grouped by column (a column may appear in a CHECK and in a partial index). */
const LISTS = ((): Map<string, string[][]> => {
  const out = new Map<string, string[][]>();
  for (const match of DDL.matchAll(/(\w+)\s+IN\s*\(\s*([^)]*?)\s*\)/g)) {
    const values = match[2]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    out.set(match[1]!, [...(out.get(match[1]!) ?? []), values]);
  }
  return out;
})();

const sorted = (values: readonly string[]): string[] => [...values].sort();
function expectListFor(column: string, tuple: readonly string[]): void {
  const lists = (LISTS.get(column) ?? []).map(sorted);
  expect(lists, `no CHECK/index list for column ${column}`).toContainEqual(sorted(tuple));
}

describe('migrations', () => {
  it('brings an empty file to the current version and is idempotent', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'app.db');
    expect(fs.existsSync(dbPath)).toBe(false);
    const db = track(openDb(dbPath));
    expect(db.userVersion()).toBe(SCHEMA_VERSION);
    const applied = db
      .prepare<{ version: number; name: string; applied_at: number }>(
        'SELECT * FROM schema_migrations ORDER BY version',
      )
      .all();
    expect(applied.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(applied.every((r) => Number.isFinite(r.applied_at))).toBe(true);
    db.close();

    const reopened = track(openDb(dbPath));
    expect(reopened.userVersion()).toBe(SCHEMA_VERSION);
    expect(reopened.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n).toBe(
      MIGRATIONS.length,
    );
  });

  it('is append-only: every entry has a unique ascending version and a name', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      [...MIGRATIONS].sort((a, b) => a.version - b.version).map((m) => m.version),
    );
    expect(new Set(MIGRATIONS.map((m) => m.version)).size).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.every((m) => m.name.length > 0 && m.sql.trim().length > 0)).toBe(true);
  });
});

describe('tuple-vs-CHECK parity', () => {
  it.each([
    ['name (secrets)', 'name', SECRET_NAMES],
    ['policy (chats)', 'policy', CHAT_POLICIES],
    ['lang (chats)', 'lang', LANGS],
    ['reply_lang (proposals)', 'reply_lang', LANGS],
    ['analysis (items)', 'analysis', ANALYSIS_STATES],
    ['hold_reason (items)', 'hold_reason', HOLD_REASONS],
    ['reply_state (items)', 'reply_state', REPLY_STATES],
    ['event_state (items)', 'event_state', EVENT_STATES],
    ['closed_reason (items)', 'closed_reason', CLOSED_REASONS],
    ['stage (runs)', 'stage', ['extract', 'draft']],
    ['outcome (runs)', 'outcome', ['ok', 'failed', 'aborted']],
    ['status (model_files)', 'status', MODEL_FILE_STATUSES],
    ['id (model_files)', 'id', MODEL_TIERS],
  ])('%s', (_label, column, tuple) => {
    expectListFor(column, tuple);
  });

  it('kind covers both closed sets (consents and actions)', () => {
    expectListFor('kind', CONSENT_KINDS);
    expectListFor('kind', ACTION_KINDS);
  });

  it('state covers items, actions and the partial open-item index', () => {
    expectListFor('state', ITEM_STATES);
    expectListFor('state', ACTION_STATES);
    expectListFor('state', OPEN_ITEM_STATES);
  });

  it('provider is the three ids, plus the user-authored proposal', () => {
    expectListFor('provider', PROVIDER_IDS);
    expectListFor('provider', [...PROVIDER_IDS, 'user']);
  });

  it('the DDL rejects a value that is not in the tuple', () => {
    const db = track(openDb(':memory:'));
    db.exec(`INSERT INTO chats(id, jid, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', 1, 1)`);
    expect(() =>
      db.exec(
        `INSERT INTO items(id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at) VALUES (1, 1, 'archived', 'm', 1, 1, 1)`,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        `INSERT INTO model_files(id, path, size, sha256, mtime, status) VALUES ('huge', 'p', 1, 'a', 1, 'ready')`,
      ),
    ).toThrow(/CHECK/);
  });
});

/**
 * Migration v2 RELAXED `trg_actions_frozen`, which is I3's second line of defence ("an approval is pinned to its recipient and
 * its bytes"). The relaxation exists only so the FK's own `ON DELETE SET NULL` on a dangling `retry_of` back-pointer can run -
 * without it, deleting any action a retry clone pointed at aborted, which killed retention.purge and stalled ingest inside
 * chats.mergeLidInto. These tests pin the NEW hatch shut around that one shape: the hatch must not become a way to re-aim an
 * approval, to smuggle a payload rewrite past the purge shape, or to unfreeze a live row.
 */
describe('trg_actions_frozen after v2 (I3 second line of defence)', () => {
  const ACTION_COLUMNS =
    'id, item_id, proposal_id, chat_id, kind, canonical_json, content_sha256, idempotency_key, attempt, retry_of, state, created_at, expires_at';
  const SHA = 'a'.repeat(64);

  /** A chat, an item, a proposal and a `failed` parent + `pending` clone whose `retry_of` points at the parent. */
  function seed(): ReturnType<typeof openDb> {
    const db = track(openDb(':memory:'));
    db.exec(`INSERT INTO chats(id, jid, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', 1, 1)`);
    db.exec(
      `INSERT INTO items(id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at) VALUES (1, 1, 'needs_reply', 'm', 1, 1, 1)`,
    );
    db.exec(
      `INSERT INTO proposals(id, item_id, version, provider, model, created_at) VALUES (1, 1, 1, 'local', 'm', 1)`,
    );
    // born pending with content (trg_actions_insert), then driven to a terminal state through the legal transitions
    db.exec(
      `INSERT INTO actions(${ACTION_COLUMNS}) VALUES ('a1', 1, 1, 1, 'create_event', '{"v":1}', '${SHA}', 'k1', 1, NULL, 'pending', 1, 9)`,
    );
    db.exec(`UPDATE actions SET state='approved', approved_at=2, approved_final_json='{"v":1}' WHERE id='a1'`);
    db.exec(`UPDATE actions SET state='executing' WHERE id='a1'`);
    db.exec(`UPDATE actions SET state='failed', error_code='CAL_UNAVAILABLE' WHERE id='a1'`);
    db.exec(
      `INSERT INTO actions(${ACTION_COLUMNS}) VALUES ('a2', 1, 1, 1, 'create_event', '{"v":1}', '${SHA}', 'k2', 2, 'a1', 'pending', 3, 9)`,
    );
    return db;
  }

  it("permits the FK's own NULLing of a dangling retry back-pointer (the whole point of v2)", () => {
    const db = seed();
    expect(() => db.exec(`DELETE FROM actions WHERE id='a1'`)).not.toThrow();
    expect(db.prepare<{ retry_of: string | null }>(`SELECT retry_of FROM actions WHERE id='a2'`).get()!.retry_of).toBe(
      null,
    );
    // and the clone's own payload survived the unlink untouched
    expect(
      db
        .prepare<{ canonical_json: string; idempotency_key: string }>(
          `SELECT canonical_json, idempotency_key FROM actions WHERE id='a2'`,
        )
        .get(),
    ).toMatchObject({ canonical_json: '{"v":1}', idempotency_key: 'k2' });
  });

  it('still refuses to AIM retry_of at anything - the hatch is a NULLing, not a re-link', () => {
    const db = seed();
    // a2 -> a1 re-aimed at itself, and a fresh link on a row that never had one
    expect(() => db.exec(`UPDATE actions SET retry_of='a2' WHERE id='a2'`)).toThrow(/approved content is immutable/);
    expect(() => db.exec(`UPDATE actions SET retry_of='a2' WHERE id='a1'`)).toThrow(/approved content is immutable/);
    // a no-op NULLing of a row that had no back-pointer is refused too (OLD.retry_of IS NOT NULL)
    expect(() => db.exec(`UPDATE actions SET retry_of=NULL WHERE id='a1'`)).toThrow(/approved content is immutable/);
  });

  it('still refuses to smuggle a payload or recipient rewrite alongside the retry_of NULLing', () => {
    const db = seed();
    db.exec(`INSERT INTO chats(id, jid, created_at, updated_at) VALUES (2, '972550000002@s.whatsapp.net', 1, 1)`);
    for (const sql of [
      `UPDATE actions SET retry_of=NULL, canonical_json='{"v":"evil"}' WHERE id='a2'`,
      `UPDATE actions SET retry_of=NULL, canonical_json=NULL WHERE id='a2'`,
      `UPDATE actions SET retry_of=NULL, chat_id=2 WHERE id='a2'`,
      `UPDATE actions SET retry_of=NULL, kind='send_reply' WHERE id='a2'`,
      `UPDATE actions SET retry_of=NULL, content_sha256='${'f'.repeat(64)}' WHERE id='a2'`,
      `UPDATE actions SET retry_of=NULL, idempotency_key='k-evil' WHERE id='a2'`,
      `UPDATE actions SET retry_of=NULL, attempt=99 WHERE id='a2'`,
    ]) {
      expect(() => db.exec(sql), sql).toThrow(/approved content is immutable/);
    }
    expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM actions WHERE retry_of='a1'`).get()!.n).toBe(1);
  });

  it('still purges a TERMINAL row and still refuses to blank a live one (the v1 hatch is unchanged)', () => {
    const db = seed();
    expect(() => db.exec(`UPDATE actions SET canonical_json=NULL WHERE id='a1'`)).not.toThrow(); // 'failed'
    expect(() => db.exec(`UPDATE actions SET canonical_json=NULL WHERE id='a2'`)).toThrow(
      /approved content is immutable/,
    ); // 'pending'
  });

  it('purges a terminal row whose retry_of was already NULLed earlier (the two shapes compose)', () => {
    const db = seed();
    db.exec(`DELETE FROM actions WHERE id='a1'`); // NULLs a2.retry_of via the FK
    db.exec(`UPDATE actions SET state='rejected' WHERE id='a2'`);
    expect(() => db.exec(`UPDATE actions SET canonical_json=NULL WHERE id='a2'`)).not.toThrow();
  });
});
