// src/main/db/repos/autoDecisions.ts - Repos['autoDecisions'] (C2 16.1, [V2 ADD]; owner V2-W1-01-db).
// auto_decisions is fully IMMUTABLE (trg_auto_decisions_immutable, C2 concern 18): one row per action at most, written by AutoGate's
// caller, never updated. Its id is the value actions.approved_by carries for verdict 'auto', which trg_actions_state JOINs (I1').
// checks_json is METADATA ONLY (B8/B27): a flat object of enum-like strings, numbers, booleans and nulls - never message text.
import { AUTO_REASONS, AUTO_VERDICTS, AUTO_WRITE_KINDS } from '../../../shared/types';
import { RepoContractError } from '../errors';
import type { Db, Repos } from '../index';
import { AUTO_DECISION_COLUMNS, type AutoDecisionRow, toAutoDecision } from './rows';

export type AutoDecisionsRepo = Repos['autoDecisions'];

/** An id/enum/number-shaped string: letters, digits and `_ : . - / +` (time zones, ISO dates, uuids), at most 128 chars. Any
 *  other string (a space, a quote, a bidi mark, a newline - i.e. anything that could be prose) is refused. */
const CHECK_STRING_RE = /^[A-Za-z0-9_:.\-/+]{0,128}$/;
const MAX_CHECK_KEYS = 64;

function cleanChecks(checks: unknown): Record<string, string | number | boolean | null> {
  if (typeof checks !== 'object' || checks === null || Array.isArray(checks))
    throw new RepoContractError('checks must be a flat object');
  const entries = Object.entries(checks as Record<string, unknown>);
  if (entries.length > MAX_CHECK_KEYS) throw new RepoContractError('too many checks');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) throw new RepoContractError('bad check key');
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && CHECK_STRING_RE.test(v)) out[k] = v;
    else throw new RepoContractError('check values are metadata only');
  }
  return out;
}

export function createAutoDecisionsRepo(db: Db): AutoDecisionsRepo {
  return {
    /** Immutable afterwards. The DDL ties verdict auto|shadow to reason 'ok' and refuses an unknown reason; the enums are checked
     *  here too so a bad value fails with a contract error before SQLite sees it. */
    insert(r) {
      if (!(AUTO_WRITE_KINDS as readonly string[]).includes(r.kind))
        throw new RepoContractError('unknown decision kind');
      if (!(AUTO_VERDICTS as readonly string[]).includes(r.verdict)) throw new RepoContractError('unknown verdict');
      if (!(AUTO_REASONS as readonly string[]).includes(r.reason)) throw new RepoContractError('unknown auto reason');
      db.prepare(
        `INSERT INTO auto_decisions(id, policy_id, action_id, item_id, chat_id, kind, verdict, reason, checks_json, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id,
        r.policyId,
        r.actionId,
        r.itemId,
        r.chatId,
        r.kind,
        r.verdict,
        r.reason,
        JSON.stringify(cleanChecks(r.checks)),
        r.decidedAt,
      );
    },

    forAction(actionId) {
      const row = db
        .prepare<AutoDecisionRow>(`SELECT ${AUTO_DECISION_COLUMNS} FROM auto_decisions WHERE action_id = ?`)
        .get(actionId);
      return row ? toAutoDecision(row) : null;
    },

    /**
     * Trial tally (auto:getState / auto:endShadow). decisions = every decision of the policy ("seen"); wouldAuto = those with verdict
     * 'shadow' (reason ok: they WOULD have been automatic). The three outcomes are read from each wouldAuto decision's ACTION end state
     * (decisions themselves never change): approvedUnchanged = approved with approved_final_json == canonical_json; edited = approved
     * with a different final payload; dismissed = rejected | expired | superseded. Pending actions (and rows whose payloads retention
     * already purged) count in none of the three.
     */
    shadowTally(policyId) {
      const row = db
        .prepare<{
          decisions: number;
          would_auto: number | null;
          approved_unchanged: number | null;
          edited: number | null;
          dismissed: number | null;
        }>(
          `SELECT COUNT(*) AS decisions,
                  SUM(CASE WHEN d.verdict = 'shadow' THEN 1 ELSE 0 END) AS would_auto,
                  SUM(CASE WHEN d.verdict = 'shadow' AND a.approved_at IS NOT NULL AND a.approved_final_json IS NOT NULL
                            AND a.approved_final_json = a.canonical_json THEN 1 ELSE 0 END) AS approved_unchanged,
                  SUM(CASE WHEN d.verdict = 'shadow' AND a.approved_at IS NOT NULL AND a.approved_final_json IS NOT NULL
                            AND a.canonical_json IS NOT NULL AND a.approved_final_json <> a.canonical_json THEN 1 ELSE 0 END) AS edited,
                  SUM(CASE WHEN d.verdict = 'shadow' AND a.state IN ('rejected','expired','superseded') THEN 1 ELSE 0 END) AS dismissed
             FROM auto_decisions d LEFT JOIN actions a ON a.id = d.action_id
            WHERE d.policy_id = ?`,
        )
        .get(policyId)!;
      return {
        decisions: row.decisions,
        wouldAuto: row.would_auto ?? 0,
        approvedUnchanged: row.approved_unchanged ?? 0,
        edited: row.edited ?? 0,
        dismissed: row.dismissed ?? 0,
      };
    },
  };
}
