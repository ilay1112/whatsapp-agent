// tests/e2e/helpers/ledger.ts - the side-effect ledger for L5 (TESTS 8.1; owner W2-03).
//
// Why this file exists instead of `tests/helpers/ledger.ts`: that module imports `tests/setup-guards.ts`, which calls
// `vi.mock()` at module scope. Playwright is not a vitest runtime, so the import throws
// ("Vitest mocker was not initialized in this environment"). The cross-check below is the same contract, run against the
// SQLite profile the app just wrote and against the journals the fakes kept. See the REQUESTS section of
// ops/agent-notes/W2-03-e2e.md.
//
// It asserts, for the whole spec:
//   1. every bridge send has exactly one approved `send_reply` action whose chat JID == recipient and whose
//      approved_final_json.text == the message, approved BEFORE it was sent, with an `action_approved` audit row;
//   2. every MCP `create-event` has an approved `create_event` action carrying the same action id in
//      extendedProperties.private.waAction;
//   3. every fake's `violations` list is empty;
//   4. neither the log directory nor any captured line contains a sentinel (message text, JIDs, keys, tokens).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SendRecord {
  at: number;
  recipient: string;
  message: string;
}
export interface CreateEventRecord {
  at: number;
  args: Record<string, unknown>;
}

export interface LedgerSources {
  /** `<tmp userData>` of the launch under test. */
  userDataDir: string;
  /** Everything any fake bridge of this spec received. */
  sends: SendRecord[];
  /** Every `create-event` tool call any fake calendar of this spec received. */
  createEvents: CreateEventRecord[];
  /** `violations` of every fake, flattened. */
  violations: string[];
  /** Strings that must never appear in a log line (message text, names, JIDs, keys, per-launch tokens). */
  sentinels: string[];
}

interface ActionRow {
  id: string;
  kind: string;
  state: string;
  approved_at: number | null;
  approved_final_json: string | null;
  jid: string;
}

const ALLOWED_STATES = new Set(['executing', 'done', 'failed', 'unknown_outcome']);

function readActions(appDb: string): ActionRow[] {
  if (!existsSync(appDb)) return [];
  const db = new DatabaseSync(appDb, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT a.id AS id, a.kind AS kind, a.state AS state, a.approved_at AS approved_at,
                a.approved_final_json AS approved_final_json, c.jid AS jid
           FROM actions a JOIN chats c ON c.id = a.chat_id`,
      )
      .all() as unknown as ActionRow[];
  } finally {
    db.close();
  }
}

function readApprovedAudit(appDb: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(appDb)) return out;
  const db = new DatabaseSync(appDb, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT ref, ts FROM audit_log WHERE kind = 'action_approved'`).all() as unknown as Array<{
      ref: string | null;
      ts: number;
    }>;
    for (const r of rows) if (r.ref !== null && !out.has(r.ref)) out.set(r.ref, r.ts);
    return out;
  } finally {
    db.close();
  }
}

/** Every line of every log file the launch wrote, plus the file names (a name can leak a JID too). */
export function readLogText(userDataDir: string): string {
  const logsDir = join(userDataDir, 'logs');
  if (!existsSync(logsDir)) return '';
  let text = '';
  for (const name of readdirSync(logsDir)) {
    const file = join(logsDir, name);
    if (!statSync(file).isFile()) continue;
    text += `${name}\n${readFileSync(file, 'utf8')}\n`;
  }
  return text;
}

/** Throws with every problem it found; an empty return means the spec caused no unapproved side effect. */
export function assertE2eLedger(src: LedgerSources): void {
  const problems: string[] = [];
  const appDb = join(src.userDataDir, 'app.db');
  const actions = readActions(appDb);
  const approvedAudit = readApprovedAudit(appDb);
  const usedActionIds = new Set<string>();

  for (const send of src.sends) {
    const matches = actions.filter(
      (a) =>
        a.kind === 'send_reply' &&
        a.approved_at !== null &&
        ALLOWED_STATES.has(a.state) &&
        a.jid === send.recipient &&
        textOf(a.approved_final_json) === send.message,
    );
    if (matches.length === 0) {
      problems.push(`send to ${send.recipient} has NO approved send_reply action`);
      continue;
    }
    const fresh = matches.filter((m) => !usedActionIds.has(m.id));
    if (fresh.length === 0) {
      problems.push(`two sends share the single approved action ${matches[0]!.id}`);
      continue;
    }
    const action = fresh[0]!;
    usedActionIds.add(action.id);
    if ((action.approved_at ?? Number.POSITIVE_INFINITY) > send.at) {
      problems.push(`action ${action.id} was approved AFTER the send reached the bridge`);
    }
    const auditTs = approvedAudit.get(action.id);
    if (auditTs === undefined) problems.push(`action ${action.id} has no action_approved audit row`);
    else if (auditTs > send.at) problems.push(`action ${action.id} was audited after the send`);
  }

  for (const ev of src.createEvents) {
    const waAction = waActionOf(ev.args);
    if (waAction === null) {
      problems.push('create-event carries no extendedProperties.private.waAction');
      continue;
    }
    const action = actions.find((a) => a.id === waAction);
    if (action === undefined) problems.push(`create-event names unknown action ${waAction}`);
    else if (action.kind !== 'create_event') problems.push(`create-event names a ${action.kind} action`);
    else if (action.approved_at === null || !ALLOWED_STATES.has(action.state)) {
      problems.push(`create-event executed for UNAPPROVED action ${waAction} (state=${action.state})`);
    }
  }

  if (src.violations.length > 0) problems.push(`fake violations: ${src.violations.join(', ')}`);

  const logText = readLogText(src.userDataDir);
  for (const sentinel of src.sentinels) {
    if (sentinel.length >= 6 && logText.includes(sentinel)) {
      problems.push(`a log file leaked the sentinel ${JSON.stringify(sentinel.slice(0, 12))}...`);
    }
  }

  if (problems.length > 0) throw new Error(`E2E side-effect ledger failed:\n  - ${problems.join('\n  - ')}`);
}

function textOf(approvedFinalJson: string | null): string | null {
  if (approvedFinalJson === null) return null;
  try {
    const parsed = JSON.parse(approvedFinalJson) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

function waActionOf(args: Record<string, unknown>): string | null {
  const ext = args.extendedProperties as { private?: Record<string, unknown> } | undefined;
  const value = ext?.private?.waAction;
  return typeof value === 'string' ? value : null;
}
