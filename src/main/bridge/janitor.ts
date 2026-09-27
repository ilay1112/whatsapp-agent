// src/main/bridge/janitor.ts - deletes old media files under <userData>\bridge\store\<jid>\ (build-plan section 3; owner W1-02). S-FS.
import { readdirSync, realpathSync, statSync, unlinkSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EpochMs } from '../../shared/types';
import { isPathInside } from './invariants';

export interface MediaJanitorInput {
  storeDir: string; // <userData>\bridge\store (path-prefix asserted; never touches *.db files)
  now: () => EpochMs;
  maxAgeDays: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** Never the bridge's own databases, whatever folder they turn up in. */
const DB_FILE_RE = /\.(db|db-journal|db-wal|db-shm|sqlite|sqlite3)$/i;
const MS_PER_DAY = 24 * 3600_000;

/** Removes media files older than maxAgeDays inside per-chat folders only; never messages.db / whatsapp.db. */
export function runMediaJanitor(input: MediaJanitorInput): { deleted: number } {
  let root: string;
  try {
    // realpath first: every later prefix assertion compares real paths, so a junction/symlink cannot smuggle a target out of the store.
    root = realpathSync(resolve(input.storeDir));
  } catch {
    return { deleted: 0 };
  }
  const cutoff = input.now() - Math.max(0, input.maxAgeDays) * MS_PER_DAY;
  let deleted = 0;

  let chatDirs: Dirent[];
  try {
    chatDirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }

  for (const entry of chatDirs) {
    // Files in the store ROOT (messages.db, whatsapp.db, .bridge-token) are never candidates: only real per-chat folders are.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    let chatDir: string;
    try {
      chatDir = realpathSync(join(root, entry.name));
    } catch {
      continue;
    }
    if (!isPathInside(chatDir, root) || chatDir === root) continue;

    let files: Dirent[];
    try {
      files = readdirSync(chatDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || file.name.startsWith('.') || DB_FILE_RE.test(file.name)) continue;
      let target: string;
      try {
        target = realpathSync(join(chatDir, file.name));
      } catch {
        continue;
      }
      if (!isPathInside(target, root)) continue; // path-prefix assertion before every delete
      let mtimeMs: number;
      try {
        const st = statSync(target);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs >= cutoff) continue;
      try {
        unlinkSync(target);
        deleted += 1;
      } catch {
        // a file the bridge still holds open stays; the next hourly run retries
      }
    }
  }
  return { deleted };
}
