// src/main/db/repos/consents.ts - Repos['consents'] implementation over the Db wrapper (owner W1-04; v2 delta V2-W1-01-db).
// Signatures: CONTRACTS 15.1 + C2 16.1.
import { CONSENT_KINDS, CONSENT_VERSIONS } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';
import { type ConsentRow, toConsent } from './rows';

export type ConsentsRepo = Repos['consents'];

/** consents.terms_read_on is a calendar date (the DDL GLOB checks the same shape). */
const ISO_DATE_RE = /^\d{4}-[01]\d-[0-3]\d$/;

export function createConsentsRepo(db: Db): ConsentsRepo {
  const assertKind = (kind: string): void => {
    if (!(CONSENT_KINDS as readonly string[]).includes(kind)) throw new RepoContractError('unknown consent kind');
  };
  return {
    /**
     * [V2 CHANGE] + termsReadOn. [V2-W1-01 final rule] The date belongs to the Antigravity consent only (B14: it records which
     * edition of the Antigravity Terms the consent text quoted, = ANTIGRAVITY_TERMS_READ_ON): it is REQUIRED for
     * `cloud_antigravity_cli` and REFUSED for every other kind, so no acceptance can be stored with a missing or stray date.
     */
    accept(kind, version, now, termsReadOn) {
      assertKind(kind);
      if (kind === 'cloud_antigravity_cli') {
        if (termsReadOn === undefined || !ISO_DATE_RE.test(termsReadOn))
          throw new RepoContractError('cloud_antigravity_cli consent needs termsReadOn (YYYY-MM-DD)');
      } else if (termsReadOn !== undefined) {
        throw new RepoContractError('termsReadOn is recorded for cloud_antigravity_cli only');
      }
      db.prepare(
        `INSERT INTO consents(kind, version, accepted_at, terms_read_on) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, version) DO UPDATE SET accepted_at = excluded.accepted_at, terms_read_on = excluded.terms_read_on`,
      ).run(kind, version, now, termsReadOn ?? null);
    },
    latest(kind) {
      assertKind(kind);
      const row = db
        .prepare<ConsentRow>(
          `SELECT kind, version, accepted_at, terms_read_on FROM consents WHERE kind = ? ORDER BY version DESC LIMIT 1`,
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
