// src/main/db/repos/runs.ts - Repos['runs'] implementation over the Db wrapper (owner W1-04; v2 members V2-W1-01-db).
// Signatures: CONTRACTS 15.1 + C2 16.1.
// Metadata only: no prompt, no completion, no message text ever reaches this table (ARCHITECTURE section 10). The v2 CLI sandbox proof
// (runs.sandbox_json, B25/B26) is rebuilt from a closed key list before it is stored: enums, numbers and booleans only.
import { RepoContractError, RowNotFoundError } from '../errors';
import type { Db, Repos } from '../index';
import { cleanSandboxProof } from './rows';

export type RunsRepo = Repos['runs'];

export function createRunsRepo(db: Db): RunsRepo {
  return {
    start(p) {
      return db
        .prepare(`INSERT INTO runs(item_id, stage, provider, model, started_at) VALUES (?, ?, ?, ?, ?)`)
        .run(p.itemId, p.stage, p.provider, p.model, p.startedAt).lastInsertRowid;
    },
    finish(id, p) {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      const push = (column: string, value: string | number | null | undefined): void => {
        if (value === undefined) return;
        sets.push(`${column} = ?`);
        params.push(value);
      };
      push('finished_at', p.finishedAt);
      push('outcome', p.outcome);
      push('input_tokens', p.inputTokens);
      push('output_tokens', p.outputTokens);
      push('tool_calls', p.toolCalls);
      push('blocked_tool_calls', p.blockedToolCalls);
      push('error_code', p.errorCode);
      // [V2] wa_rows_served (B25: WhatsApp tool rows returned in this run). The sandbox columns go through finishCli only.
      push('wa_rows_served', p.waRowsServed);
      if (sets.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },
    /** Cloud budget accounting (settings.llm.cloudDailyTokenBudget); local runs never count.
     *  [V2] unchanged on purpose: the CLI providers run on the user's subscription, not on the API-key token budget. */
    cloudTokensSince(ts) {
      const row = db
        .prepare<{ input: number | null; output: number | null }>(
          `SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM runs WHERE provider IN ('claude','gemini') AND started_at >= ?`,
        )
        .get(ts)!;
      return { inputTokens: row.input ?? 0, outputTokens: row.output ?? 0 };
    },
    // ---- [V2 ADD] C2 16.1 (V2-W1-01-db) ----
    /** I11: the run's own init proof, re-built from its closed key list (B26). Fail closed: sandbox_ok = 1 only when the caller says ok
     *  AND the proof agrees (initOk, no mismatch) - a contradictory pair is stored as 0. */
    finishCli(id, p) {
      if (typeof p.sandboxOk !== 'boolean') throw new RepoContractError('sandboxOk must be a boolean');
      const proof = cleanSandboxProof(p.sandboxProof);
      if (proof === null) throw new RepoContractError('sandbox proof must be enums, counts and booleans only');
      const changes = db
        .prepare(`UPDATE runs SET sandbox_ok = ?, sandbox_json = ? WHERE id = ?`)
        .run(p.sandboxOk && proof.initOk && proof.mismatch === null ? 1 : 0, JSON.stringify(proof), id).changes;
      if (changes !== 1) throw new RowNotFoundError('runs', id);
    },
    /**
     * S1 + S3 `sandbox_ok` of the proposal version being written (providerClassOf: `cli_proven` needs every entry === true).
     * The version's runs are the item's extract/draft runs started at or after `proposalCreatedAfter` (the previous version's
     * created_at, or the item's trigger time for version 1), oldest first. `null` = not a CLI run or no proof recorded - never true.
     */
    sandboxOfVersion(itemId, proposalCreatedAfter) {
      return db
        .prepare<{ sandbox_ok: number | null }>(
          `SELECT sandbox_ok FROM runs WHERE item_id = ? AND stage IN ('extract','draft') AND started_at >= ?
             ORDER BY started_at ASC, id ASC`,
        )
        .all(itemId, proposalCreatedAfter)
        .map((r) => (r.sandbox_ok === null ? null : r.sandbox_ok === 1));
    },
  };
}
