// TESTS 5.3 row `db/*`: backup `VACUUM INTO` + keep-3 rotation, the pre-migration copy, and
// `quick_check` failure => restore newest => else start empty.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupNow, DEFAULT_KEEP, moveAside, newestBackup, openDbWithRecovery, restoreNewest } from './backup';
import { backupBeforeMigration, DbCorruptError, openDb, type Db } from './index';
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
