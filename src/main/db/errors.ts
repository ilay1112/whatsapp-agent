// src/main/db/errors.ts - error classes raised by the repos (owner W1-04).
// [W1-04 addition] CONTRACTS 15.1 names `ActionStateError` in the doc comment of actions.markDone/markFailed/markUnknownOutcome
// but does not declare it; this file declares it once and `db/index.ts` re-exports it so consumers import from `../db/index`.

/** A compare-and-set write that MUST have matched exactly one row matched none or many (a programming error; the caller audits 'db_recovery'). */
export class ActionStateError extends Error {
  readonly actionId: string;
  readonly expected: string;
  readonly changes: number;
  constructor(actionId: string, expected: string, changes: number) {
    super(`action ${actionId}: expected state ${expected}, ${changes} row(s) updated`);
    this.name = 'ActionStateError';
    this.actionId = actionId;
    this.expected = expected;
    this.changes = changes;
  }
}

/** A repo read for a row the caller asserted exists (items.update on a deleted item, chats.mergeLidInto on an unknown chat). */
export class RowNotFoundError extends Error {
  readonly table: string;
  constructor(table: string, id: string | number) {
    super(`${table} row not found: ${String(id)}`);
    this.name = 'RowNotFoundError';
    this.table = table;
  }
}

/** A payload handed to a repo does not satisfy its contract (kind/itemId/chatRef mismatch, unknown enum value). */
export class RepoContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoContractError';
  }
}
