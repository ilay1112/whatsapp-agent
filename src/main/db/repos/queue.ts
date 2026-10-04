// src/main/db/repos/queue.ts - Repos['queue'] implementation over the Db wrapper (owner W1-04). Signatures: CONTRACTS 15.1.
import { ERROR_CODES } from '../../../shared/errors';
import { LIMITS } from '../../../shared/types';
import type { Db, Repos } from '../index';
import { type QueueRow, toQueueEntry } from './rows';

export type QueueRepo = Repos['queue'];
const QUEUE_COLUMNS = 'chat_id, due_at, first_enqueued_at, attempts, last_error, rev';

/** [R2] `triage_queue.last_error` holds an ErrorCode or nothing: a provider/zod message can echo attacker-controlled text. */
function errorCodeOrNull(lastError: string | undefined): string | null {
  return lastError !== undefined && (ERROR_CODES as readonly string[]).includes(lastError) ? lastError : null;
}

/** [v2-repair] The e2e `WCA_TIMERS` seam (delays only, testSeams.ts); production passes nothing and keeps LIMITS exactly. */
export interface QueueTimers {
  debounceMs?: number;
  debounceCapMs?: number;
}
const positiveOr = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

export function createQueueRepo(db: Db, timers?: QueueTimers): QueueRepo {
  const debounceMs = positiveOr(timers?.debounceMs, LIMITS.debounceMs);
  const debounceCapMs = positiveOr(timers?.debounceCapMs, LIMITS.debounceCapMs);
  return {
    /** Debounce: due = min(now + 20 s, first_enqueued_at + 60 s) - a chatty conversation still gets triaged within a minute. */
    enqueue(chatId, now) {
      db.transaction(() => {
        const existing = db
          .prepare<{ first_enqueued_at: number }>(`SELECT first_enqueued_at FROM triage_queue WHERE chat_id = ?`)
          .get(chatId);
        if (!existing) {
          db.prepare(`INSERT INTO triage_queue(chat_id, due_at, first_enqueued_at, attempts) VALUES (?, ?, ?, 0)`).run(
            chatId,
            now + debounceMs,
            now,
          );
          return;
        }
        const due = Math.min(now + debounceMs, existing.first_enqueued_at + debounceCapMs);
        // `rev` is bumped on every re-arm so the worker's `remove(chatId, rev)` can tell "the row I dequeued" from
        // "a row a newer message re-armed under me". `due_at` cannot serve: under the 60 s cap it re-computes to the
        // SAME value the worker dequeued, and `first_enqueued_at` deliberately does not move here.
        db.prepare(`UPDATE triage_queue SET due_at = ?, rev = rev + 1 WHERE chat_id = ?`).run(due, chatId);
      });
    },
    nextDue(now) {
      const row = db
        .prepare<QueueRow>(
          `SELECT ${QUEUE_COLUMNS} FROM triage_queue WHERE due_at <= ? ORDER BY due_at ASC, chat_id ASC LIMIT 1`,
        )
        .get(now);
      return row ? toQueueEntry(row) : null;
    },
    /**
     * `attempts` is the retry-backoff TIER (agent/queue.ts `backoffFor` over RETRY_BACKOFF_MS = 1 min / 5 min / 30 min), so only a
     * real failure may advance it. Two of the four call sites are not failures and pass no error: the worker's edit-lock deferral
     * (agent/queue.ts pump) and ingest's Stage-0 `deferred` verdict, which defers a row it has just enqueued. Counting those put a
     * chat into the 30-minute tier before its first genuine provider failure, where the item waits at analysis='queued' -
     * counted on the dashboard but never listed (isListed('queued') is false). The PRESENCE of `lastError` is the failure signal;
     * `errorCodeOrNull` only decides whether the code is safe to store ([R2]).
     */
    defer(chatId, dueAt, lastError) {
      const sql =
        lastError === undefined
          ? `UPDATE triage_queue SET due_at = ?, last_error = ? WHERE chat_id = ?`
          : `UPDATE triage_queue SET due_at = ?, attempts = attempts + 1, last_error = ? WHERE chat_id = ?`;
      db.prepare(sql).run(dueAt, errorCodeOrNull(lastError), chatId);
    },
    /** Compare-and-set when `rev` is given: a row whose rev moved on was re-armed while the run was in flight and MUST
     *  survive, or the newer trigger is analysed by nobody (no sweeper re-arms a `queued` item without a queue row). */
    remove(chatId, rev) {
      if (rev === undefined) {
        db.prepare(`DELETE FROM triage_queue WHERE chat_id = ?`).run(chatId);
        return;
      }
      db.prepare(`DELETE FROM triage_queue WHERE chat_id = ? AND rev = ?`).run(chatId, rev);
    },
    size() {
      return db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM triage_queue`).get()!.n;
    },
  };
}
