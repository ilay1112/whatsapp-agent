// src/main/db/repos/runs.ts - Repos['runs'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
// Metadata only: no prompt, no completion, no message text ever reaches this table (ARCHITECTURE section 10).
import type { Db, Repos } from '../index';

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
      if (sets.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },
    /** Cloud budget accounting (settings.llm.cloudDailyTokenBudget); local runs never count. */
    cloudTokensSince(ts) {
      const row = db
        .prepare<{ input: number | null; output: number | null }>(
          `SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM runs WHERE provider IN ('claude','gemini') AND started_at >= ?`,
        )
        .get(ts)!;
      return { inputTokens: row.input ?? 0, outputTokens: row.output ?? 0 };
    },
  };
}
