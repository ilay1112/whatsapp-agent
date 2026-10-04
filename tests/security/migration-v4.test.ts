// tests/security/migration-v4.test.ts - security gate group 24 of T2 8.2 (ARCHITECTURE-v2 B22, C2 16.2/16.3). Owner: V2-W1-01-db.
//
// The committed synthetic v0.1.x database `src/main/db/__fixtures__/v3.db` (built by scripts/gen-v3-fixture.mjs from the LIVE
// migrations 1-3: rows in every actions state x kind, every v3 event_state, consents, runs, audit, a v1 settings row) must migrate to
// v4 with every row and every column value kept, the exact v4 schema objects, the C2 backfills, one backup, and NO partial state:
// a failure injected at any step leaves the v3 file byte for byte as it was. A second run is a no-op.
//
// Fixture sha256 (regenerate with `node scripts/gen-v3-fixture.mjs`; the first test proves it is the generator's output):
//   2c96bc59c087d900fb238d995b0e766a8fa24f4d0817b61d9bfd784d34949ffb
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepos, openDb, type Db, type Stmt } from '../../src/main/db/index.ts';
import { migrate, MigrationError, MIGRATIONS, SCHEMA_VERSION } from '../../src/main/db/migrations.ts';
import { ActionPayloadSchema, canonicalJson } from '../../src/shared/schemas.ts';
import { SETTINGS_V2_ADDED, SettingsSchema } from '../../src/shared/settings.ts';
import { buildV3Fixture, V3_ACTION_STATES } from '../../scripts/gen-v3-fixture.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'src', 'main', 'db', '__fixtures__', 'v3.db');
const V3_SHA256 = '2c96bc59c087d900fb238d995b0e766a8fa24f4d0817b61d9bfd784d34949ffb';

const V3_TABLES = [
  'schema_migrations',
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
const NEW_TABLES = [
  'auto_policies',
  'auto_decisions',
  'auto_writes',
  'event_revisions',
  'transcripts',
  'media_cache',
] as const;

/** The complete, exact set of named schema objects of a v4 database (autoindexes included). */
const V4_TRIGGERS = [
  'trg_actions_approver_frozen',
  'trg_actions_final_frozen',
  'trg_actions_frozen',
  'trg_actions_insert',
  'trg_actions_state',
  'trg_audit_no_update',
  'trg_auto_decisions_immutable',
  'trg_auto_policies_frozen',
  'trg_auto_policies_insert',
  'trg_auto_policies_state',
  'trg_auto_writes_frozen',
  'trg_auto_writes_insert',
  'trg_event_rev_frozen',
];
const V4_INDEXES = [
  'ix_actions_item',
  'ix_actions_state',
  'ix_audit_ts',
  'ix_auto_decisions_chat',
  'ix_auto_decisions_item',
  'ix_auto_decisions_policy',
  'ix_auto_writes_item',
  'ix_auto_writes_revision',
  'ix_auto_writes_undo',
  'ix_auto_writes_undo_action',
  'ix_chats_policy',
  'ix_event_rev_action',
  'ix_event_rev_item',
  'ix_event_rev_reverted',
  'ix_items_analysis',
  'ix_items_chat',
  'ix_items_linked',
  'ix_items_list',
  'ix_media_cache_item',
  'ix_queue_due',
  'ix_rate',
  'ix_runs_item',
  'ix_runs_started',
  'sqlite_autoindex_actions_1',
  'sqlite_autoindex_actions_2',
  'sqlite_autoindex_auto_decisions_1',
  'sqlite_autoindex_auto_decisions_2',
  'sqlite_autoindex_auto_policies_1',
  'sqlite_autoindex_auto_writes_1',
  'sqlite_autoindex_auto_writes_2',
  'sqlite_autoindex_auto_writes_3',
  'sqlite_autoindex_chats_1',
  'sqlite_autoindex_consents_1',
  'sqlite_autoindex_item_messages_1',
  'sqlite_autoindex_media_cache_1',
  'sqlite_autoindex_meta_1',
  'sqlite_autoindex_model_files_1',
  'sqlite_autoindex_proposals_1',
  'sqlite_autoindex_secrets_1',
  'sqlite_autoindex_settings_1',
  'ux_auto_policies_live',
  'ux_event_rev',
  'ux_items_open',
];

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------
const dirs: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const h of handles.splice(0)) {
    try {
      h.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** A private copy of the fixture as `<tmp>/app.db` (+ its original bytes). */
function copyFixture(): { dir: string; file: string; bytes: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-v4-'));
  dirs.push(dir);
  const file = path.join(dir, 'app.db');
  fs.copyFileSync(FIXTURE, file);
  return { dir, file, bytes: fs.readFileSync(file) };
}

/** Raw handle (no migration). The caller closes it. */
function raw(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  handles.push(db);
  return db;
}

type Row = Record<string, unknown>;
function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}
/** Every row of `table`, projected on `cols`, in a content order independent of rowids. */
function rowsOf(db: DatabaseSync, table: string, cols: string[]): Row[] {
  const list = cols.map((c) => `"${c}"`).join(', ');
  const order = cols.map((_, i) => String(i + 1)).join(', ');
  return db.prepare(`SELECT ${list} FROM ${table} ORDER BY ${order}`).all() as Row[];
}
function snapshotV3(file: string): Record<string, { cols: string[]; rows: Row[] }> {
  const db = raw(file);
  const out: Record<string, { cols: string[]; rows: Row[] }> = {};
  for (const t of V3_TABLES) {
    const cols = columnsOf(db, t);
    out[t] = { cols, rows: rowsOf(db, t, cols) };
  }
  db.close();
  return out;
}

/**
 * A `Db` over a raw DatabaseSync (same transaction semantics as db/index.ts wrapDb) whose `exec` / `prepare` can inject a failure
 * into migration v4 at an exact step, so the runner's all-or-nothing contract can be exercised step by step.
 */
type Inject =
  { at: 'statement'; afterStatements: number } | { at: 'schema_migrations' } | { at: 'user_version' } | null;
function injectingDb(file: string, inject: Inject, statements: string[]): Db {
  const d = new DatabaseSync(file);
  handles.push(d);
  d.exec('PRAGMA foreign_keys=ON');
  let depth = 0;
  const v4 = MIGRATIONS[3]!.sql;
  const wrap = <R>(s: ReturnType<DatabaseSync['prepare']>): Stmt<R> => ({
    get: (...p) => s.get(...p) as R | undefined,
    all: (...p) => s.all(...p) as R[],
    run: (...p) => {
      const r = s.run(...p);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
  });
  return {
    path: file,
    exec(sql) {
      if (sql === v4 && inject?.at === 'statement') {
        for (const st of statements.slice(0, inject.afterStatements)) d.exec(st);
        throw new Error(`injected failure after statement ${inject.afterStatements}`);
      }
      if (inject?.at === 'user_version' && sql === 'PRAGMA user_version = 4') throw new Error('injected: user_version');
      d.exec(sql);
    },
    prepare<R>(sql: string) {
      if (inject?.at === 'schema_migrations' && sql.startsWith('INSERT INTO schema_migrations'))
        throw new Error('injected: schema_migrations');
      return wrap<R>(d.prepare(sql));
    },
    transaction<R>(fn: () => R): R {
      if (depth > 0) return fn();
      d.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const r = fn();
        d.exec('COMMIT');
        return r;
      } catch (e) {
        try {
          d.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      } finally {
        depth = 0;
      }
    },
    userVersion: () => Number((d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    close: () => d.close(),
  };
}

/**
 * Migration v4 split into its top-level statements (trigger bodies stay whole): each ';'-terminated chunk is grown until SQLite
 * accepts it as ONE complete statement against a scratch database that is advanced statement by statement.
 */
function v4Statements(): string[] {
  const scratch = new DatabaseSync(':memory:');
  try {
    for (const m of MIGRATIONS.slice(0, 3)) scratch.exec(m.sql);
    const parts = MIGRATIONS[3]!.sql.split(';');
    const out: string[] = [];
    let buf = '';
    for (let i = 0; i < parts.length; i++) {
      buf += parts[i] + (i < parts.length - 1 ? ';' : '');
      const code = buf
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (code === '' || code === ';') continue;
      try {
        scratch.prepare(buf);
      } catch (e) {
        if (/incomplete input/i.test((e as Error).message)) continue;
        throw e;
      }
      scratch.exec(buf);
      out.push(buf);
      buf = '';
    }
    expect(buf.trim()).toBe('');
    return out;
  } finally {
    scratch.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------------------------------------------------
describe('the committed v3 fixture', () => {
  it('is exactly the output of scripts/gen-v3-fixture.mjs (regenerable byte for byte)', () => {
    expect(sha(fs.readFileSync(FIXTURE))).toBe(V3_SHA256);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-v3gen-'));
    dirs.push(dir);
    const regenerated = buildV3Fixture(path.join(dir, 'v3.db')) as string;
    expect(regenerated).toBe(V3_SHA256);
  });

  it('is a v3 database with rows in every actions state x kind and every v3 event_state (synthetic only)', () => {
    const db = raw(FIXTURE);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    const pairs = db.prepare(`SELECT DISTINCT kind, state FROM actions`).all() as Array<{
      kind: string;
      state: string;
    }>;
    for (const kind of ['send_reply', 'create_event'])
      for (const state of V3_ACTION_STATES as string[])
        expect(pairs, `${kind}/${state}`).toContainEqual({ kind, state });
    const events = (db.prepare(`SELECT DISTINCT event_state AS e FROM items`).all() as Array<{ e: string }>).map(
      (r) => r.e,
    );
    expect(events.sort()).toEqual(['created', 'declined', 'incomplete', 'none', 'proposed']);
    for (const t of ['consents', 'runs', 'audit_log', 'settings', 'model_files', 'rate_events', 'triage_queue'])
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBeGreaterThan(0);
    // T5: only synthetic JIDs
    for (const { jid } of db.prepare('SELECT jid FROM chats').all() as Array<{ jid: string }>)
      expect(jid).toMatch(/^(9725500000\d\d@s\.whatsapp\.net|1000000000000\d@lid)$/);
    db.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the successful migration
// ---------------------------------------------------------------------------------------------------------------------
describe('v3 -> v4 through openDb', () => {
  it('keeps every v3 row and every v3 column value', () => {
    const { file } = copyFixture();
    const before = snapshotV3(file);
    const db = openDb(file);
    handles.push(db);
    for (const t of V3_TABLES) {
      const after = db
        .prepare<Row>(
          `SELECT ${before[t]!.cols.map((c) => `"${c}"`).join(', ')} FROM ${t} ORDER BY ${before[t]!.cols.map((_, i) => i + 1).join(', ')}`,
        )
        .all();
      if (t === 'settings') {
        // value_json is completed by the json_insert step on purpose (asserted below); key and updated_at are kept
        expect(
          after.map(({ value_json: _v, ...rest }) => rest),
          t,
        ).toEqual(before[t]!.rows.map(({ value_json: _v, ...rest }) => rest));
      } else if (t === 'schema_migrations') {
        expect(after.slice(0, 3), t).toEqual(before[t]!.rows);
        expect(after).toHaveLength(4);
      } else {
        expect(after, t).toEqual(before[t]!.rows);
      }
    }
  });

  it('is at SCHEMA_VERSION 4 with a clean foreign-key check and integrity', () => {
    const { file } = copyFixture();
    const db = openDb(file);
    handles.push(db);
    expect(SCHEMA_VERSION).toBe(4);
    expect(db.userVersion()).toBe(4);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    expect(
      db
        .prepare<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version')
        .all()
        .map((r) => `${r.version}:${r.name}`),
    ).toEqual(MIGRATIONS.map((m) => `${m.version}:${m.name}`));
  });

  it('has exactly the v4 trigger and index set, and the six new tables are empty', () => {
    const { file } = copyFixture();
    const db = openDb(file);
    handles.push(db);
    const names = (type: string): string[] =>
      db
        .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`)
        .all(type)
        .map((r) => r.name);
    expect(names('trigger')).toEqual(V4_TRIGGERS);
    expect(names('index')).toEqual(V4_INDEXES);
    expect(names('table')).toEqual([...V3_TABLES, ...NEW_TABLES, 'sqlite_sequence'].sort()); // sqlite_sequence: audit_log AUTOINCREMENT (v1)
    for (const t of NEW_TABLES) expect(db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n, t).toBe(0);
    // no leftover of the 12-step rebuilds
    expect(names('table').filter((n) => n.endsWith('_new'))).toEqual([]);
  });

  it('applies the C2 backfills (approved_by per concern 12, event_revision/origin, provenance, kinds, policies)', () => {
    const { file } = copyFixture();
    const db = openDb(file);
    handles.push(db);
    // approved_by: 'user' for every row a v1 click approved (approved_at set), NULL for the rest
    const actions = db
      .prepare<{ state: string; approved_at: number | null; approved_by: string | null }>(
        'SELECT state, approved_at, approved_by FROM actions',
      )
      .all();
    expect(actions.length).toBeGreaterThanOrEqual(20);
    for (const a of actions) expect(a.approved_by, a.state).toBe(a.approved_at === null ? null : 'user');
    expect(actions.some((a) => a.approved_by === 'user')).toBe(true);
    expect(actions.some((a) => a.approved_by === null)).toBe(true);
    // items: created + event id => revision 1, origin = itself ; everything else 0 / NULL ; text trigger ; no link
    for (const i of db
      .prepare<{
        id: number;
        event_state: string;
        calendar_event_id: string | null;
        event_revision: number;
        event_origin_item_id: number | null;
        linked_item_id: number | null;
        trigger_kind: string;
        calendar_updated: string | null;
      }>('SELECT * FROM items')
      .all()) {
      const created = i.event_state === 'created' && i.calendar_event_id !== null;
      expect(i.event_revision, `item ${i.id}`).toBe(created ? 1 : 0);
      expect(i.event_origin_item_id, `item ${i.id}`).toBe(created ? i.id : null);
      expect([i.linked_item_id, i.trigger_kind, i.calendar_updated]).toEqual([null, 'text', null]);
    }
    // proposals: provider_class api_key for claude|gemini, else local ; fail-closed provenance defaults
    for (const p of db
      .prepare<Row & { provider: string }>(
        'SELECT provider, provider_class, delta_json, image_json, blocked_calls, context_from_me_recent, cross_chat_rows, trigger_author FROM proposals',
      )
      .all())
      expect(p).toEqual({
        provider: p.provider,
        provider_class: p.provider === 'claude' || p.provider === 'gemini' ? 'api_key' : 'local',
        delta_json: null,
        image_json: null,
        blocked_calls: 0,
        context_from_me_recent: 0,
        cross_chat_rows: 0,
        trigger_author: 'contact',
      });
    expect(
      db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM runs WHERE sandbox_ok IS NOT NULL OR sandbox_json IS NOT NULL OR wa_rows_served <> 0`,
        )
        .get()!.n,
    ).toBe(0);
    expect(
      db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM consents WHERE terms_read_on IS NOT NULL`).get()!.n,
    ).toBe(0);
    expect(db.prepare<{ k: string }>(`SELECT DISTINCT kind AS k FROM model_files`).all()).toEqual([{ k: 'llm' }]);
    expect(db.prepare<Row>(`SELECT DISTINCT auto_policy, auto_tainted_until FROM chats`).all()).toEqual([
      { auto_policy: 'inherit', auto_tainted_until: null },
    ]);
  });

  it('completes the settings row with json_insert: SettingsSchema parses it and the v1 values are untouched', () => {
    const { file } = copyFixture();
    const v1 = JSON.parse(
      (raw(file).prepare(`SELECT value_json FROM settings WHERE key = 'settings'`).get() as { value_json: string })
        .value_json,
    ) as Record<string, Record<string, unknown>>;
    const db = openDb(file);
    handles.push(db);
    const stored = JSON.parse(
      db.prepare<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = 'settings'`).get()!.value_json,
    );
    const parsed = SettingsSchema.parse(stored);
    expect(parsed.llm.cli).toEqual(SETTINGS_V2_ADDED['llm.cli']);
    expect(parsed.whatsapp.readTools).toEqual(SETTINGS_V2_ADDED['whatsapp.readTools']);
    expect(parsed.voice).toEqual(SETTINGS_V2_ADDED.voice);
    expect(parsed.images).toEqual(SETTINGS_V2_ADDED.images);
    // json_insert only ADDS absent keys: every v1 value is still there, unchanged
    expect(stored).toMatchObject(v1);
    expect(createRepos(db).settings.get()).toEqual(parsed);
  });

  it('every v1 canonical_json parses with the v2 ActionPayloadSchema and hashes to the same content_sha256 (C2 19 #15)', () => {
    const { file } = copyFixture();
    const db = openDb(file);
    handles.push(db);
    const rows = db
      .prepare<{ canonical_json: string; content_sha256: string }>(
        'SELECT canonical_json, content_sha256 FROM actions WHERE canonical_json IS NOT NULL',
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const parsed = ActionPayloadSchema.parse(JSON.parse(r.canonical_json));
      expect(canonicalJson(parsed)).toBe(r.canonical_json);
      expect(createHash('sha256').update(r.canonical_json, 'utf8').digest('hex')).toBe(r.content_sha256);
    }
  });

  it('migrated rows keep moving through the v2 triggers: executing -> done (send and create), unknown_outcome -> done', () => {
    const { file } = copyFixture();
    const db = openDb(file);
    handles.push(db);
    const repos = createRepos(db);
    const executing = db
      .prepare<{ id: string; kind: string }>(`SELECT id, kind FROM actions WHERE state = 'executing' ORDER BY kind`)
      .all();
    expect(executing.map((a) => a.kind)).toEqual(['create_event', 'send_reply']);
    for (const a of executing) {
      repos.actions.markDone(
        a.id,
        a.kind === 'send_reply'
          ? { kind: 'send_reply', waMsgId: null }
          : { kind: 'create_event', eventId: 'syn0evt0000000000000000000000077', htmlLink: null },
        Date.now(),
      );
      expect(repos.actions.byId(a.id)).toMatchObject({ state: 'done', approvedBy: 'user' });
    }
    const unknown = db
      .prepare<{ id: string }>(`SELECT id FROM actions WHERE state = 'unknown_outcome' AND kind = 'send_reply'`)
      .get()!;
    repos.actions.markDone(unknown.id, { kind: 'send_reply', waMsgId: 'SYN-LATE' }, Date.now());
    expect(repos.actions.byId(unknown.id)!.state).toBe('done');
    // a migrated pending row approves only with an approver (v2 trigger) - 'user' is still the click path
    const pending = db
      .prepare<{ id: string; canonical_json: string }>(
        `SELECT id, canonical_json FROM actions WHERE state = 'pending' AND kind = 'send_reply' AND retry_of IS NULL`,
      )
      .get()!;
    expect(repos.actions.markApprovedExecuting(pending.id, pending.canonical_json, Date.now(), 'auto')).toBe('stale');
    expect(repos.actions.markApprovedExecuting(pending.id, pending.canonical_json, Date.now(), 'user')).toBe('ok');
    // v1 extraction rows read with the fail-closed v2 defaults
    const withExtraction = db
      .prepare<{ item_id: number }>(
        `SELECT item_id FROM proposals WHERE extraction_json IS NOT NULL AND superseded_at IS NULL LIMIT 1`,
      )
      .get()!;
    expect(repos.proposals.current(withExtraction.item_id)!.extraction).toMatchObject({
      refersToExisting: false,
      change: 'no_change',
      changeConfidence: 'low',
      confidence: 'low',
    });
  });

  it('takes exactly one backup before the migration, and a second open is a no-op', () => {
    const { dir, file } = copyFixture();
    const first = openDb(file);
    const schemaAfterFirst = first.prepare<{ sql: string }>(`SELECT sql FROM sqlite_master ORDER BY name`).all();
    first.close();
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    // the backup is the untouched v3 database
    const b = raw(path.join(dir, 'backups', backups[0]!));
    expect((b.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    b.close();

    const second = openDb(file);
    handles.push(second);
    expect(fs.readdirSync(path.join(dir, 'backups'))).toEqual(backups);
    expect(second.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations').get()!.n).toBe(4);
    expect(second.prepare<{ sql: string }>(`SELECT sql FROM sqlite_master ORDER BY name`).all()).toEqual(
      schemaAfterFirst,
    );
  });

  it('migrate(): backupBefore runs exactly once for the v3 -> v4 step and not at all on the second run', () => {
    const { file, bytes } = copyFixture();
    let backups = 0;
    const db = injectingDb(file, null, []);
    expect(
      migrate(
        db,
        () => backups++,
        () => 1,
      ),
    ).toEqual({ from: 3, to: 4 });
    expect(backups).toBe(1);
    expect(
      migrate(
        db,
        () => backups++,
        () => 2,
      ),
    ).toEqual({ from: 4, to: 4 });
    expect(backups).toBe(1);
    // control for the byte-identity cases below: the same adapter, NOT failing, does change the file
    db.close();
    expect(sha(fs.readFileSync(file))).not.toBe(sha(bytes));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// no partial migration
// ---------------------------------------------------------------------------------------------------------------------
describe('a failure at any step leaves the v3 file byte-identical', () => {
  const statements = v4Statements();

  it('the statement splitter sees the whole migration', () => {
    expect(statements.length).toBeGreaterThan(50);
    // nothing but trailing whitespace is left over, and nothing was reordered or dropped
    expect(statements.join('').trimEnd()).toBe(MIGRATIONS[3]!.sql.trimEnd());
  });

  function assertUntouched(file: string, bytes: Buffer): void {
    for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    expect(sha(fs.readFileSync(file))).toBe(sha(bytes));
    const again = raw(file);
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    again.close();
  }

  it.each(Array.from({ length: statements.length + 1 }, (_, k) => k))(
    'migration v4 aborted after %i of its statements',
    (k) => {
      const { file, bytes } = copyFixture();
      const db = injectingDb(file, { at: 'statement', afterStatements: k }, statements);
      let err: unknown;
      try {
        migrate(
          db,
          () => undefined,
          () => 1,
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MigrationError);
      expect((err as MigrationError).reason).toBe('failed');
      db.close();
      assertUntouched(file, bytes);
    },
  );

  it.each(['schema_migrations', 'user_version'] as const)('the runner fails at its %s step', (at) => {
    const { file, bytes } = copyFixture();
    const db = injectingDb(file, { at }, statements);
    expect(() =>
      migrate(
        db,
        () => undefined,
        () => 1,
      ),
    ).toThrow(MigrationError);
    db.close();
    assertUntouched(file, bytes);
  });

  /** Changes the COPY (it is still a v3 file) so that the real openDb() path fails at a chosen place. */
  function prepareCopy(sql: string): { file: string; bytes: Buffer } {
    const { file } = copyFixture();
    const d = raw(file);
    d.exec('PRAGMA foreign_keys=OFF');
    d.exec(sql);
    d.close();
    for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    return { file, bytes: fs.readFileSync(file) };
  }

  it.each([
    ['step 1 (auto_policies exists)', `CREATE TABLE auto_policies (x INTEGER)`, 'failed'],
    ['step 2 (items index name taken)', `CREATE INDEX ix_items_linked ON meta(value)`, 'failed'],
    ['step 6 (media_cache exists)', `CREATE TABLE media_cache (x INTEGER)`, 'failed'],
    [
      'step 7 (a v2 trigger name taken)',
      `CREATE TRIGGER trg_actions_approver_frozen BEFORE UPDATE ON meta BEGIN SELECT 1; END`,
      'failed',
    ],
    ['step 8 (consents_new exists)', `CREATE TABLE consents_new (x INTEGER)`, 'failed'],
    ['step 10 (chats column exists)', `ALTER TABLE chats ADD COLUMN auto_tainted_until INTEGER`, 'failed'],
    [
      'step 11 (malformed settings JSON)',
      `UPDATE settings SET value_json = '{not json' WHERE key = 'settings'`,
      'failed',
    ],
    [
      'the foreign-key check (an orphan row)',
      `INSERT INTO item_messages(item_id, wa_msg_id, from_me, ts, text, text_sha256) VALUES (999, 'ORPHAN', 0, 1, NULL, '${'f'.repeat(64)}')`,
      'fk_violation',
    ],
  ])('the real openDb() path fails at %s', (_label, sql, reason) => {
    const { file, bytes } = prepareCopy(sql);
    let err: unknown;
    try {
      handles.push(openDb(file));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as MigrationError).reason).toBe(reason);
    assertUntouched(file, bytes);
  });
});
