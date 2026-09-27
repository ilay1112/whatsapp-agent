// src/main/db/repos/secrets.ts - Repos['secrets'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// Only safeStorage (DPAPI) CIPHERTEXT is ever stored here; this repo never sees, formats or logs a plaintext key.
import { SECRET_NAMES } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';

export type SecretsRepo = Repos['secrets'];

export function createSecretsRepo(db: Db): SecretsRepo {
  const assertName = (name: string): void => {
    if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new RepoContractError('unknown secret name');
  };
  return {
    put(name, ciphertext) {
      assertName(name);
      db.prepare(
        `INSERT INTO secrets(name, ciphertext, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      ).run(name, ciphertext, Date.now());
    },
    get(name) {
      assertName(name);
      const row = db.prepare<{ ciphertext: Uint8Array }>(`SELECT ciphertext FROM secrets WHERE name = ?`).get(name);
      return row ? row.ciphertext : null;
    },
    delete(name) {
      assertName(name);
      db.prepare(`DELETE FROM secrets WHERE name = ?`).run(name);
    },
  };
}
