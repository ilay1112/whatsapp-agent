// src/main/db/repos/meta.ts - Repos['meta'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
import { META_KEYS } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';

export type MetaRepo = Repos['meta'];

export function createMetaRepo(db: Db): MetaRepo {
  const assertKey = (k: string): void => {
    if (!(META_KEYS as readonly string[]).includes(k)) throw new RepoContractError(`unknown meta key: ${k}`);
  };
  return {
    get(k) {
      assertKey(k);
      return db.prepare<{ value: string }>(`SELECT value FROM meta WHERE key = ?`).get(k)?.value ?? null;
    },
    set(k, v) {
      assertKey(k);
      db.prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(k, v);
    },
  };
}
