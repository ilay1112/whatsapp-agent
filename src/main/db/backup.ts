// src/main/db/backup.ts - VACUUM INTO backups + restore (owner W1-04). S-FS: dirs are parameters.
// ARCHITECTURE section 10: backup daily and before every migration, keep 3; on a corrupt file restore the newest backup, and when
// there is none start empty (pairing and the model files live in separate files and survive either way).
import fs from 'node:fs';
import path from 'node:path';
import { DbCorruptError, openDb, type Db } from './index';
import { MigrationError } from './migrations';
import type { EpochMs } from '../../shared/types';

export interface BackupDeps {
  backupsDir: string;
  now: () => EpochMs;
  keep?: number; // rotate, default 3 (build-plan section 7 `W1-04-db`, TESTS 5.3 row `db/*`)
}

export const DEFAULT_KEEP = 3;
/** `app-YYYYMMDD.db`, plus `-HHmmss` (and a counter) when that name is taken - a pre-migration and a daily copy can share a day. */
const BACKUP_RE = /^app-\d{8}(-\d{6})?(-\d+)?\.db$/;

function stamp(now: EpochMs): { day: string; time: string } {
  const d = new Date(now);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return {
    day: `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`,
  };
}

function listBackups(backupsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(backupsDir);
  } catch {
    return [];
  }
  return (
    names
      .filter((n) => BACKUP_RE.test(n))
      .map((n) => {
        const full = path.join(backupsDir, n);
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          return null;
        }
        return { full, name: n, mtimeMs };
      })
      .filter((e): e is { full: string; name: string; mtimeMs: number } => e !== null)
      // newest first; the name is the tie-breaker so the order is stable when two files share an mtime (fast tests, copied dirs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
      .map((e) => e.full)
  );
}

/** `VACUUM INTO '<backupsDir>\app-<ts>.db'`; rotates old files; returns the new file path. */
export function backupNow(db: Db, deps: BackupDeps): string {
  fs.mkdirSync(deps.backupsDir, { recursive: true });
  const { day, time } = stamp(deps.now());
  let target = path.join(deps.backupsDir, `app-${day}.db`);
  if (fs.existsSync(target)) target = path.join(deps.backupsDir, `app-${day}-${time}.db`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(deps.backupsDir, `app-${day}-${time}-${n}.db`);
  // The path is ours (never user text); SQLite string literals escape a quote by doubling it. VACUUM never runs inside a transaction.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const keep = deps.keep ?? DEFAULT_KEEP;
  for (const stale of listBackups(deps.backupsDir).slice(keep)) {
    try {
      fs.rmSync(stale, { force: true });
    } catch {
      /* a backup we cannot delete is not worth failing the app over; the next rotation tries again */
    }
  }
  return target;
}

/** Newest backup file path or null. */
export function newestBackup(backupsDir: string): string | null {
  return listBackups(backupsDir)[0] ?? null;
}

/** Copies the newest backup over appDb (after the corrupt file was moved aside as app.db.corrupt-<ts>). Caller re-opens. */
export function restoreNewest(
  appDbPath: string,
  backupsDir: string,
  now: () => EpochMs,
): { restoredFrom: string } | null {
  const newest = newestBackup(backupsDir);
  if (newest === null) return null;
  moveAside(appDbPath, now());
  fs.copyFileSync(newest, appDbPath);
  return { restoredFrom: newest };
}

/** Renames the unreadable file (and its WAL sidecars) to `<name>.corrupt-<ts>` so a support export can still pick it up. */
export function moveAside(appDbPath: string, now: EpochMs): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${appDbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, `${from}.corrupt-${now}`);
    } catch {
      try {
        fs.rmSync(from, { force: true });
      } catch {
        /* nothing else we can do; openDb will report DB_RECOVERY again */
      }
    }
  }
}

export type RecoveryOutcome = 'none' | 'restored' | 'fresh';
/**
 * [W1-04 addition] The startup sequence of ARCHITECTURE section 10 in one place, so the composition root does not re-derive it:
 * open -> on `quick_check` failure / an unreadable file / a failed migration, restore the newest backup -> if there is none (or the
 * restored copy is broken too), move the file aside and start empty. `recovered !== 'none'` is what the caller surfaces as DB_RECOVERY.
 */
export function openDbWithRecovery(
  appDbPath: string,
  backupsDir: string,
  now: () => EpochMs = () => Date.now(),
): { db: Db; recovered: RecoveryOutcome; restoredFrom: string | null } {
  try {
    return { db: openDb(appDbPath), recovered: 'none', restoredFrom: null };
  } catch (e) {
    if (!(e instanceof DbCorruptError) && !(e instanceof MigrationError)) throw e;
  }
  const restored = restoreNewest(appDbPath, backupsDir, now);
  if (restored !== null) {
    try {
      return { db: openDb(appDbPath), recovered: 'restored', restoredFrom: restored.restoredFrom };
    } catch (e) {
      if (!(e instanceof DbCorruptError) && !(e instanceof MigrationError)) throw e;
    }
  }
  moveAside(appDbPath, now());
  return { db: openDb(appDbPath), recovered: 'fresh', restoredFrom: null };
}
