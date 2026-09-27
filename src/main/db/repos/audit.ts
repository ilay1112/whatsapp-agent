// src/main/db/repos/audit.ts - Repos['audit'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// Append-only (trg_audit_no_update) and METADATA ONLY: `detail` may hold numbers, enums, booleans and hashes - never a tool name,
// a message, a JID, a path or a provider error body (CONTRACTS 1, AUDIT_KINDS doc comment).
import { AUDIT_KINDS } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';

export type AuditRepo = Repos['audit'];

export function createAuditRepo(db: Db): AuditRepo {
  return {
    append(kind, ref, detail, now) {
      if (!(AUDIT_KINDS as readonly string[]).includes(kind)) throw new RepoContractError('unknown audit kind');
      db.prepare(`INSERT INTO audit_log(ts, kind, ref, detail_json) VALUES (?, ?, ?, ?)`).run(
        now,
        kind,
        ref,
        JSON.stringify(detail),
      );
    },
  };
}
