// TESTS 5.3 row `db/*`: backup `VACUUM INTO` + keep-3 rotation, the pre-migration copy, and
// `quick_check` failure => restore newest => else start empty.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { backupNow, DEFAULT_KEEP, moveAside, newestBackup, openDbWithRecovery, restoreNewest } from './backup';
import { backupBeforeMigration, DbCorruptError, openDb, type Db } from './index';
import { MigrationError, MIGRATIONS } from './migrations';
import { cleanup, fileRepos, memDb, T0, tempDir, track } from './__fixtures__/testDb';

afterEach(cleanup);

const backupsOf = (dir: string): string[] => fs.readdirSync(dir).sort();
/** A `Db` that reports an empty schema - the state of a file SQLite has only just created. */
const emptyDb = (dbPath: string): Db => ({
  path: dbPath,
  exec: () => undefined,
  prepare: <Row>() => ({
    get: () => ({ n: 0 }) as Row,
    all: () => [],
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
  }),
  transaction: <R>(fn: () => R) => fn(),
  userVersion: () => 0,
  close: () => undefined,
});

describe('backupNow', () => {
  it('writes app-YYYYMMDD.db, creates the directory and keeps the newest 3', () => {
    const dir = tempDir();
    const backups = path.join(dir, 'backups');
    const { db, repos } = fileRepos(dir);
    repos.meta.set('paired_at', String(T0));
    const day = new Date(T0).toISOString().slice(0, 10).replace(/-/g, '');
    const first = backupNow(db, { backupsDir: backups, now: () => T0 });
    expect(path.basename(first)).toBe(`app-${day}.db`);
    expect(fs.statSync(first).size).toBeGreaterThan(0);
    // a second copy on the same day gets a time suffix instead of overwriting the first
    const second = backupNow(db, { backupsDir: backups, now: () => T0 + 1_000 });
    expect(path.basename(second)).toMatch(new RegExp(`^app-${day}-\\d{6}\\.db$`));
    expect(backupsOf(backups)).toHaveLength(2);
    for (let i = 1; i <= 4; i++) backupNow(db, { backupsDir: backups, now: () => T0 + i * 86_400_000 });
    expect(backupsOf(backups)).toHaveLength(DEFAULT_KEEP);
    expect(newestBackup(backups)).toBe(path.join(backups, backupsOf(backups).at(-1)!));
  });

  it('honours an explicit keep and the backup is a readable database', () => {
    const dir = tempDir();
    const backups = path.join(dir, 'backups');
    const { db, repos } = fileRepos(dir);
    repos.meta.set('onboarding_step', 'ready');
    const copy = backupNow(db, { backupsDir: backups, now: () => T0, keep: 1 });
    const restored = track(openDb(copy));
    expect(restored.prepare<{ value: string }>(`SELECT value FROM meta WHERE key='onboarding_step'`).get()!.value).toBe(
      'ready',
    );
    restored.close();
    const newer = backupNow(db, { backupsDir: backups, now: () => T0 + 86_400_000, keep: 1 });
    expect(backupsOf(backups)).toEqual([path.basename(newer)]);
  });

  it('newestBackup ignores foreign file names and a missing directory', () => {
    const dir = tempDir();
    expect(newestBackup(path.join(dir, 'nothing-here'))).toBeNull();
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.writeFileSync(path.join(dir, 'backups', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'backups', 'app-2026.db'), 'x');
    expect(newestBackup(path.join(dir, 'backups'))).toBeNull();
  });
});

describe('backupBeforeMigration', () => {
  it('copies a populated database and skips a fresh file / an in-memory one', () => {
    const dir = tempDir();
    const { db, dbPath } = fileRepos(dir);
    backupBeforeMigration(db, dbPath)();
    expect(backupsOf(path.join(dir, 'backups'))).toHaveLength(1);

    // a brand-new file has no tables yet: nothing to lose, so no copy is taken
    const freshDir = tempDir();
    backupBeforeMigration(emptyDb(path.join(freshDir, 'app.db')), path.join(freshDir, 'app.db'))();
    expect(fs.existsSync(path.join(freshDir, 'backups'))).toBe(false);
    // an in-memory database has no directory to copy into
    backupBeforeMigration(memDb(), ':memory:')();
  });

  it('never fails the upgrade when the copy cannot be written', () => {
    const dir = tempDir();
    const { db, dbPath } = fileRepos(dir);
    fs.writeFileSync(path.join(dir, 'backups'), 'not a directory');
    expect(() => backupBeforeMigration(db, dbPath)()).not.toThrow();
  });
});

describe('restoreNewest / openDbWithRecovery', () => {
  const corrupt = (dbPath: string): void => fs.writeFileSync(dbPath, 'this is definitely not a sqlite file');

  it('openDb reports a file that is not a database', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'app.db');
    corrupt(dbPath);
    expect(() => openDb(dbPath)).toThrow(DbCorruptError);
  });

  it('restores the newest backup and moves the unreadable file aside', () => {
    const dir = tempDir();
    const backups = path.join(dir, 'backups');
    const { db, repos, dbPath } = fileRepos(dir);
    repos.meta.set('paired_at', 'from-backup');
    backupNow(db, { backupsDir: backups, now: () => T0 });
    db.close();
    corrupt(dbPath);

    const recovered = openDbWithRecovery(dbPath, backups, () => T0 + 1);
    track(recovered.db);
    expect(recovered.recovered).toBe('restored');
    expect(recovered.restoredFrom).toBe(newestBackup(backups));
    expect(recovered.db.prepare<{ value: string }>(`SELECT value FROM meta WHERE key='paired_at'`).get()!.value).toBe(
      'from-backup',
    );
    expect(fs.existsSync(`${dbPath}.corrupt-${T0 + 1}`)).toBe(true);
  });

  it('starts empty when there is no backup at all', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'app.db');
    corrupt(dbPath);
    const recovered = openDbWithRecovery(dbPath, path.join(dir, 'backups'), () => T0);
    track(recovered.db);
    expect(recovered).toMatchObject({ recovered: 'fresh', restoredFrom: null });
    expect(recovered.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM meta`).get()!.n).toBe(0);
    expect(fs.existsSync(`${dbPath}.corrupt-${T0}`)).toBe(true);
  });

  it('starts empty when the newest backup is broken too', () => {
    const dir = tempDir();
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    fs.writeFileSync(path.join(backups, 'app-20260922.db'), 'rubbish');
    const dbPath = path.join(dir, 'app.db');
    corrupt(dbPath);
    const recovered = openDbWithRecovery(dbPath, backups, () => T0);
    track(recovered.db);
    expect(recovered.recovered).toBe('fresh');
  });

  it('opens a healthy database untouched', () => {
    const dir = tempDir();
    const { db, repos, dbPath } = fileRepos(dir);
    repos.meta.set('tray_hint_seen', '1');
    db.close();
    const opened = openDbWithRecovery(dbPath, path.join(dir, 'backups')); // the default clock is the real one
    track(opened.db);
    expect(opened).toMatchObject({ recovered: 'none', restoredFrom: null });
    expect(opened.db.prepare<{ value: string }>(`SELECT value FROM meta WHERE key='tray_hint_seen'`).get()!.value).toBe(
      '1',
    );
  });

  /**
   * [v2-fix-src-main-db] data-integrity-v4-6: a migration that fails DETERMINISTICALLY fails the same way on the pre-migration
   * backup (it is a copy of the same file), and the old fall-through then moved app.db aside and opened an EMPTY database - every
   * item, approval record and undo record gone from the app. A MigrationError never ends in 'fresh': the call throws (the caller
   * surfaces a blocking DB_RECOVERY) and app.db is the user's own, untouched v3 file again, ready for a fixed build.
   */
  describe('a migration that fails on the file AND on its backup', () => {
    /** A v3 file with one item whose v4 migration fails at step 1 (the table name it creates is taken). */
    function v3ThatCannotMigrate(dbPath: string): void {
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA foreign_keys=ON');
      for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
        raw.exec(m.sql);
        raw
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, 1);
      }
      raw.exec('PRAGMA user_version = 3');
      raw.exec(`INSERT INTO chats (id, jid, created_at, updated_at) VALUES (1, '972550000001@s.whatsapp.net', 1, 1)`);
      raw.exec(`INSERT INTO items (id, chat_id, state, trigger_msg_id, trigger_ts, created_at, updated_at)
                VALUES (1, 1, 'needs_reply', 'MSG1', 1, 1, 1)`);
      raw.exec('CREATE TABLE auto_policies (x INTEGER)');
      raw.close();
    }
    const itemsIn = (dbPath: string): { version: number; items: number } => {
      const raw = new DatabaseSync(dbPath);
      try {
        return {
          version: (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
          items: (raw.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n,
        };
      } finally {
        raw.close();
      }
    };

    it('throws the MigrationError instead of opening an empty database, and puts the original file back', () => {
      const dir = tempDir();
      const dbPath = path.join(dir, 'app.db');
      const backups = path.join(dir, 'backups');
      v3ThatCannotMigrate(dbPath);

      let err: unknown;
      try {
        track(openDbWithRecovery(dbPath, backups, () => T0).db);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MigrationError);
      expect(itemsIn(dbPath)).toEqual({ version: 3, items: 1 }); // the user's data, where the next start looks for it
      expect(newestBackup(backups)).not.toBeNull(); // the pre-migration copy is kept too
      expect(fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'))).toEqual([]);
    });

    it('also throws (no fresh database) when there is no backup to try', () => {
      const dir = tempDir();
      const dbPath = path.join(dir, 'app.db');
      v3ThatCannotMigrate(dbPath);
      // the pre-migration copy lands in <dir>\backups; point recovery at an empty directory instead
      expect(() => openDbWithRecovery(dbPath, path.join(dir, 'no-backups-here'), () => T0)).toThrow(MigrationError);
      expect(itemsIn(dbPath)).toEqual({ version: 3, items: 1 });
    });
  });

  it('restoreNewest answers null when the directory holds nothing', () => {
    const dir = tempDir();
    expect(restoreNewest(path.join(dir, 'app.db'), path.join(dir, 'backups'), () => T0)).toBeNull();
  });

  it('moveAside also handles the WAL sidecars and a missing file', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'app.db');
    fs.writeFileSync(dbPath, 'x');
    fs.writeFileSync(`${dbPath}-wal`, 'x');
    moveAside(dbPath, T0);
    expect(fs.existsSync(`${dbPath}.corrupt-${T0}`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal.corrupt-${T0}`)).toBe(true);
    expect(() => moveAside(dbPath, T0)).not.toThrow();
  });
});
