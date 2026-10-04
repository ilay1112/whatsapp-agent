// src/main/db/repos/autoPolicies.ts - Repos['autoPolicies'] (C2 16.1, [V2 ADD]; owner V2-W1-01-db).
// auto_policies (B7): at most ONE live row (shadow|on|paused - ux_auto_policies_live), born shadow|on (trg_auto_policies_insert),
// grant columns immutable (trg_auto_policies_frozen), closed rows (disabled|expired) final (trg_auto_policies_state). Never purged.
// The scope and the confirm record are re-validated on EVERY read: a row that no longer parses is "no policy" (fail closed).
import { AutoPolicyConfirmSchema, AutoScopeSchema } from '../../../shared/schemas';
import { AUTO_LIVE_STATES } from '../../../shared/types';
import type * as T from '../../../shared/types';
import { RepoContractError, RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { createAuditRepo } from './audit';
import { AUTO_POLICY_COLUMNS, type AutoPolicyRow, toAutoPolicy } from './rows';

export type AutoPoliciesRepo = Repos['autoPolicies'];

const LIVE_LIST = AUTO_LIVE_STATES.map((s) => `'${s}'`).join(',');

/**
 * `clock` stamps the `db_recovery` audit row of a corrupt live policy (the only write a read can cause). Optional so the frozen
 * `createAutoPoliciesRepo(db)` seam is unchanged; createRepos() passes none (wall clock), tests may pass a fixed one.
 */
export function createAutoPoliciesRepo(db: Db, clock: () => T.EpochMs = () => Date.now()): AutoPoliciesRepo {
  const audit = createAuditRepo(db);
  const rowById = (id: string): AutoPolicyRow | undefined =>
    db.prepare<AutoPolicyRow>(`SELECT ${AUTO_POLICY_COLUMNS} FROM auto_policies WHERE id = ?`).get(id);
  /** Called only after a statement touched exactly this row, so the row exists. */
  const recordById = (id: string): T.AutoPolicyRecord => {
    const rec = toAutoPolicy(rowById(id)!);
    if (!rec) throw new RepoContractError('auto policy row does not parse');
    return rec;
  };

  return {
    /**
     * The live row (shadow|on|paused). A live row whose scope_json / confirm_json no longer parses is treated as NONE: it is closed
     * ('expired' - the one closing transition that needs no reason, so the grant columns stay untouched as evidence and the single-live
     * index no longer blocks a fresh, valid grant) and one `db_recovery` audit row is written, in one transaction.
     */
    live() {
      const row = db
        .prepare<AutoPolicyRow>(
          `SELECT ${AUTO_POLICY_COLUMNS} FROM auto_policies WHERE state IN (${LIVE_LIST}) LIMIT 1`,
        )
        .get();
      if (!row) return null;
      const rec = toAutoPolicy(row);
      if (rec) return rec;
      db.transaction(() => {
        db.prepare(`UPDATE auto_policies SET state = 'expired' WHERE id = ? AND state IN (${LIVE_LIST})`).run(row.id);
        audit.append('db_recovery', row.id, { table: 'auto_policies', reason: 'bad_scope', policyId: row.id }, clock());
      });
      return null;
    },

    /** The newest row in any state (enabled_at, then rowid) - the "Ended on ..." line reads a closed one. A row that no longer
     *  parses reads as null. */
    newest() {
      const row = db
        .prepare<AutoPolicyRow>(
          `SELECT ${AUTO_POLICY_COLUMNS} FROM auto_policies ORDER BY enabled_at DESC, rowid DESC LIMIT 1`,
        )
        .get();
      return row ? toAutoPolicy(row) : null;
    },

    /** Validated with .parse() on write (AutoScopeSchema / AutoPolicyConfirmSchema); the trigger refuses any state but shadow|on and
     *  the partial unique index refuses a second live row. */
    insert(r) {
      const scope = AutoScopeSchema.parse(r.scope);
      const confirm = AutoPolicyConfirmSchema.parse(r.confirm);
      db.prepare(
        `INSERT INTO auto_policies(id, state, enabled_at, expires_at, shadow_until, confirmed_by, confirm_json, scope_json, snapshot_sha,
                                   paused_reason, disabled_at, disabled_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(
        r.id,
        r.state,
        r.enabledAt,
        r.expiresAt,
        r.shadowUntil,
        r.confirmedBy,
        JSON.stringify(confirm),
        JSON.stringify(scope),
        r.snapshotSha,
      );
      return recordById(r.id);
    },

    /**
     * on (from shadow = "Turn on for real", or from a paused `on` row; clears paused_reason) | paused + reason (records paused_from) |
     * resume (paused -> paused_from) | disabled + reason + at | expired. The state trigger (migration v5) refuses leaving a closed row,
     * any return to shadow except a paused trial's resume, a paused trial going to `on`, and a pause/disable without its reason.
     */
    setState(id, s) {
      let changes: number;
      switch (s.state) {
        case 'on':
          changes = db
            .prepare(`UPDATE auto_policies SET state = 'on', paused_reason = NULL WHERE id = ?`)
            .run(id).changes;
          break;
        case 'paused':
          // [v2-closeout auto-mode-8] the pause records the live state it left (`state` on the right-hand side is the OLD value); the
          // v5 trigger refuses any other paused_from. A repeated pause keeps the first record.
          changes = db
            .prepare(
              `UPDATE auto_policies SET state = 'paused', paused_reason = ?,
                 paused_from = CASE WHEN state = 'paused' THEN paused_from ELSE state END WHERE id = ?`,
            )
            .run(s.reason, id).changes;
          break;
        case 'resume':
          // [v2-closeout auto-mode-8] paused -> the state the user last confirmed (shadow for a trial, on otherwise). A paused trial
          // never becomes `on` here: only auto:endShadow ("Turn on for real") and the native enable dialog produce `on`.
          changes = db
            .prepare(
              `UPDATE auto_policies SET state = paused_from, paused_reason = NULL
                 WHERE id = ? AND state = 'paused' AND paused_from IN ('shadow','on')`,
            )
            .run(id).changes;
          break;
        case 'disabled':
          changes = db
            .prepare(`UPDATE auto_policies SET state = 'disabled', disabled_at = ?, disabled_reason = ? WHERE id = ?`)
            .run(s.at, s.reason, id).changes;
          break;
        case 'expired':
          changes = db.prepare(`UPDATE auto_policies SET state = 'expired' WHERE id = ?`).run(id).changes;
          break;
        default:
          throw new RepoContractError('unknown auto policy state');
      }
      if (changes !== 1) throw new RowNotFoundError('auto_policies', id);
      return recordById(id);
    },
  };
}
