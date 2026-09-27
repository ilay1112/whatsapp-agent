// src/main/db/repos/consents.ts - Repos['consents'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
import { CONSENT_KINDS, CONSENT_VERSIONS } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';
import { type ConsentRow, toConsent } from './rows';

export type ConsentsRepo = Repos['consents'];

export function createConsentsRepo(db: Db): ConsentsRepo {
  const assertKind = (kind: string): void => {
    if (!(CONSENT_KINDS as readonly string[]).includes(kind)) throw new RepoContractError('unknown consent kind');
  };
  return {
    accept(kind, version, now) {
      assertKind(kind);
      db.prepare(
        `INSERT INTO consents(kind, version, accepted_at) VALUES (?, ?, ?)
         ON CONFLICT(kind, version) DO UPDATE SET accepted_at = excluded.accepted_at`,
      ).run(kind, version, now);
    },
    latest(kind) {
      assertKind(kind);
      const row = db
        .prepare<ConsentRow>(
          `SELECT kind, version, accepted_at FROM consents WHERE kind = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(kind);
      return row ? toConsent(row) : null;
    },
    /** [R2] EXACT current version, never max() >= : bumping CONSENT_VERSIONS invalidates an older acceptance. */
    isCurrent(kind) {
      assertKind(kind);
      const row = db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM consents WHERE kind = ? AND version = ?`)
        .get(kind, CONSENT_VERSIONS[kind]);
      return (row?.n ?? 0) > 0;
    },
  };
}
