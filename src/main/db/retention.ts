// src/main/db/retention.ts - daily retention job over repos.retention (owner W1-04). S-CLOCK.
// ARCHITECTURE section 10: text after settings.privacy.retentionDays, closed items after 90 days, runs/audit_log/rate_events after
// 180 days. `data:purgeNow` runs the SAME job with retentionDays = 0, then deletes every file in `backups\` and takes one fresh
// backup, so purged text does not survive in the daily copies.
import fs from 'node:fs';
import path from 'node:path';
import { backupNow } from './backup';
import type { Repos } from './index';
import type { Settings } from '../../shared/settings';
import type { EpochMs } from '../../shared/types';

export const CLOSED_ITEM_MAX_AGE_MS = 90 * 24 * 3600_000;
export const LOG_MAX_AGE_MS = 180 * 24 * 3600_000;

/** The slice of node:fs the job uses, so a test never touches a real directory (S-FS). */
export interface RetentionFs {
  readdirSync(dir: string): string[];
  rmSync(target: string, options: { force: boolean }): void;
}
const NODE_FS: RetentionFs = {
  readdirSync: (dir) => fs.readdirSync(dir),
  rmSync: (target, options) => fs.rmSync(target, options),
};

export interface RetentionDeps {
  // [W1-04] `db` widened into the Pick so the 180-day prune of runs/audit_log/rate_events can run here; compose passes the whole
  // `repos` object, which satisfies the wider Pick unchanged.
  repos: Pick<Repos, 'retention' | 'audit' | 'meta' | 'db'>;
  settings: () => Settings; // privacy.retentionDays ; closed items after 90 d
  now: () => EpochMs;
  /** [W1-04] 'purgeNow' = retentionDays 0 + wipe `backups\` + one fresh backup (ARCHITECTURE section 10, `data:purgeNow`). */
  mode?: 'daily' | 'purgeNow';
  /** Required for the backup rotation of 'purgeNow'; omitted by a pure in-memory test. */
  backups?: { dir: string; keep?: number; fs?: RetentionFs };
}
export interface RetentionRun {
  textRows: number;
  actionRows: number;
  itemsDeleted: number;
  /** [W1-04] additive: the fresh backup taken by 'purgeNow' (null for the daily run). */
  backupPath?: string | null;
}

/** before = now - retentionDays ; closedBefore = now - 90 d ; audits 'purge'. Used by the daily timer and data:purgeNow. */
export function runRetention(deps: RetentionDeps): RetentionRun {
  const now = deps.now();
  const purgeNow = deps.mode === 'purgeNow';
  const retentionDays = purgeNow ? 0 : deps.settings().privacy.retentionDays;
  const before = now - retentionDays * 24 * 3600_000;
  const closedBefore = now - CLOSED_ITEM_MAX_AGE_MS;

  const result = deps.repos.retention.purge({ before, closedBefore });

  // Metadata tables: 180 days, independent of retentionDays (they hold no text - see AUDIT_KINDS / runs column comments).
  const logsBefore = now - LOG_MAX_AGE_MS;
  const db = deps.repos.db;
  db.transaction(() => {
    db.prepare(`DELETE FROM runs WHERE started_at < ?`).run(logsBefore);
    db.prepare(`DELETE FROM audit_log WHERE ts < ?`).run(logsBefore);
    db.prepare(`DELETE FROM rate_events WHERE ts < ?`).run(logsBefore);
  });

  let backupPath: string | null = null;
  if (purgeNow && deps.backups) {
    const io = deps.backups.fs ?? NODE_FS;
    let names: string[];
    try {
      names = io.readdirSync(deps.backups.dir);
    } catch {
      names = [];
    }
    for (const name of names) io.rmSync(path.join(deps.backups.dir, name), { force: true });
    backupPath = backupNow(db, { backupsDir: deps.backups.dir, now: () => now, keep: deps.backups.keep });
    deps.repos.meta.set('last_backup_at', String(now));
  }

  deps.repos.audit.append(
    'purge',
    null,
    {
      mode: purgeNow ? 'purgeNow' : 'daily',
      retentionDays,
      textRows: result.textRows,
      actionRows: result.actionRows,
      itemsDeleted: result.itemsDeleted,
    },
    now,
  );
  return { ...result, backupPath };
}
