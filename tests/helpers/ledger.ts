// tests/helpers/ledger.ts - the side-effect ledger (TESTS 8.1; owner W0 types -> W1-11 bodies).
// Every fake records the side effects it received (sends, create-events) here; the ledger hook cross-checks them against the
// approval records in the app DB after each test: a side effect without a matching approved action fails the test.
//
// TWO entry points, both always on:
//   * `ledger` - the lightweight registry a fake can push into directly (no DB needed).
//   * `assertLedger({ bridge, calendar, db, ... })` - the full TESTS 8.1 cross-check against the app DB. The harness attaches its
//     sources with `attachLedgerSources()`; the global `afterEach` in ledger-hook.ts then runs it for every integration/security test.
import { registerFake } from '../setup-guards.ts';
import { eventIdFor } from '../../src/main/exec/buildCreateEventArgs.ts';
import type { ApprovedEventContent } from '../../src/main/exec/buildCreateEventArgs.ts';
import type { Db } from '../../src/main/db/index.ts';
import type { FakeBridge } from '../fakes/fake-bridge.ts';
import type { FakeMcpCalendar } from '../fakes/fake-mcp-calendar.ts';

export type LedgerKind = 'send_reply' | 'create_event';
export interface LedgerEntry {
  at: number;
  kind: LedgerKind;
  source: string; // fake name
  /** Correlation handles the fake could see: recipient JID / calendar eventId / extendedProperties.waAction. Never message text. */
  ref: { recipient?: string; eventId?: string; waAction?: string; waItem?: string };
}
export interface ApprovalLookup {
  /** Returns the approved+executing/done action ids for the given side effect, or [] when none exists. */
  approvedFor(entry: LedgerEntry): string[];
}
export interface Ledger {
  record(entry: LedgerEntry): void;
  entries(): LedgerEntry[];
  /** Registers the DB view used for cross-checking (set by the harness once the app DB exists). */
  attachApprovals(lookup: ApprovalLookup | null): void;
  /** Every entry must have >= 1 approval and every fake's `violations` must be empty. Throws with details otherwise. */
  assertClean(): void;
  reset(): void;
}

const entries: LedgerEntry[] = [];
let approvals: ApprovalLookup | null = null;

export const ledger: Ledger = {
  record: (e) => {
    entries.push(e);
  },
  entries: () => [...entries],
  attachApprovals: (lookup) => {
    approvals = lookup;
  },
  assertClean: () => {
    const problems: string[] = [];
    for (const e of entries) {
      if (!approvals) {
        problems.push(`${e.kind} from ${e.source} recorded with no approval lookup attached`);
        continue;
      }
      if (approvals.approvedFor(e).length === 0) problems.push(`${e.kind} from ${e.source} has NO approval record`);
    }
    if (problems.length) throw new Error(`side-effect ledger: ${problems.join('; ')}`);
  },
  reset: () => {
    entries.length = 0;
    approvals = null;
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// TESTS 8.1: the full cross-check between what the fakes received and what the app DB can prove was approved
// ---------------------------------------------------------------------------------------------------------------------

/** The exact key set `exec/buildCreateEventArgs.ts` is allowed to put on the wire (ARCH 5.4 whitelist). */
const CREATE_EVENT_KEYS = new Set([
  'calendarId',
  'account',
  'summary',
  'start',
  'end',
  'timeZone',
  'location',
  'description',
  'sendUpdates',
  'allowDuplicates',
  'eventId',
  'extendedProperties',
]);

interface ActionRowLite {
  id: string;
  item_id: number;
  chat_id: number;
  kind: string;
  state: string;
  attempt: number;
  retry_of: string | null;
  idempotency_key: string;
  approved_at: number | null;
  approved_final_json: string | null;
  jid: string | null;
}

export interface LedgerSources {
  bridge?: Pick<FakeBridge, 'sends'> & { violations?: readonly string[] };
  calendar?: Pick<FakeMcpCalendar, 'calls'> & { violations?: readonly string[] };
  db?: Db;
  /** StubLlm.unmatched, when the harness exposes it (TESTS 8.1 item 4). */
  unmatchedLlm?: () => number;
  /** Captured log text + the strings that must never appear in it (TESTS 8.1 item 5). */
  logText?: () => string;
  sentinels?: readonly string[];
}

let sources: LedgerSources | null = null;

/** Called by the harness (W2-01) / a security test once the fakes and the app DB exist. `null` disables the cross-check. */
export function attachLedgerSources(s: LedgerSources | null): void {
  sources = s;
}
export function ledgerSources(): LedgerSources | null {
  return sources;
}

function loadActions(db: Db): ActionRowLite[] {
  return db
    .prepare<ActionRowLite>(
      `SELECT a.id, a.item_id, a.chat_id, a.kind, a.state, a.attempt, a.retry_of, a.idempotency_key,
              a.approved_at, a.approved_final_json, c.jid AS jid
         FROM actions a LEFT JOIN chats c ON c.id = a.chat_id`,
    )
    .all();
}

function approvedIds(db: Db): Set<string> {
  return new Set(
    db
      .prepare<{ ref: string | null }>(`SELECT ref FROM audit_log WHERE kind = 'action_approved'`)
      .all()
      .map((r) => r.ref ?? ''),
  );
}

const EXECUTED_STATES = new Set(['executing', 'done', 'failed', 'unknown_outcome']);

function finalText(row: ActionRowLite): string | null {
  if (row.approved_final_json === null) return null;
  try {
    const parsed = JSON.parse(row.approved_final_json) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

/** The approved event content of a row, or null when the row carries no (parseable) create_event payload. */
function finalEventContent(row: ActionRowLite): ApprovedEventContent | null {
  if (row.approved_final_json === null) return null;
  let parsed: Partial<Record<keyof ApprovedEventContent, unknown>> & { kind?: unknown };
  try {
    parsed = JSON.parse(row.approved_final_json) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed.kind !== 'create_event') return null;
  const fields = ['title', 'startLocal', 'endLocal', 'timeZone', 'location'] as const;
  if (fields.some((f) => typeof parsed[f] !== 'string')) return null;
  return {
    title: parsed.title as string,
    startLocal: parsed.startLocal as string,
    endLocal: parsed.endLocal as string,
    timeZone: parsed.timeZone as string,
    location: parsed.location as string,
  };
}

/** The chain key = idempotency key without the `:rN` retry suffix; every clone of a chain shares it (CONTRACTS 14). */
function chainKeyOf(rows: ActionRowLite[], row: ActionRowLite): { key: string; rootId: string } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let current = row;
  const seen = new Set([current.id]);
  while (current.retry_of !== null) {
    const parent = byId.get(current.retry_of);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return { key: current.idempotency_key.replace(/:r\d+$/, ''), rootId: current.id };
}

/** TESTS 8.1: throws with every problem it found. Safe to call when nothing is attached (then it only checks `violations`). */
export function assertLedger(s: LedgerSources = sources ?? {}): void {
  const problems: string[] = [];
  const usedBySend = new Map<string, number>();

  for (const name of ['bridge', 'calendar'] as const) {
    for (const v of s[name]?.violations ?? []) problems.push(`${name} fake violation: ${v}`);
  }
  if (s.unmatchedLlm && s.unmatchedLlm() !== 0) problems.push(`StubLlm.unmatched = ${s.unmatchedLlm()}`);

  const rows = s.db ? loadActions(s.db) : null;
  const approved = s.db ? approvedIds(s.db) : new Set<string>();

  // 1. every send has exactly one approved action of the same chat whose approved text is byte-identical
  for (const sent of s.bridge?.sends ?? []) {
    if (sent.extraKeys.length > 0) problems.push(`send carried extra keys: ${sent.extraKeys.join(',')}`);
    if (rows === null) {
      problems.push('a send was recorded but no app DB was attached to prove it was approved');
      continue;
    }
    const matches = rows.filter(
      (r) =>
        r.kind === 'send_reply' &&
        r.approved_at !== null &&
        EXECUTED_STATES.has(r.state) &&
        r.jid === sent.recipient &&
        finalText(r) === sent.message,
    );
    if (matches.length === 0) {
      problems.push('a send has NO approved action record');
      continue;
    }
    const free = matches.filter((m) => (usedBySend.get(m.id) ?? 0) === 0);
    if (free.length === 0) {
      problems.push('two sends share one approved action');
      continue;
    }
    const used = free[0]!;
    usedBySend.set(used.id, 1);
    if (!approved.has(used.id)) problems.push('a send has no audit_log action_approved row');
  }

  // 2. every create-event call matches an approved action, the deterministic eventId and the chain-root waAction
  for (const call of s.calendar?.calls ?? []) {
    if (call.tool !== 'create-event') continue;
    const args = call.args as Record<string, unknown>;
    for (const key of Object.keys(args))
      if (!CREATE_EVENT_KEYS.has(key)) problems.push(`create-event carried a non-whitelisted key: ${key}`);
    if (args.sendUpdates !== 'none') problems.push('create-event did not pin sendUpdates:none');
    const priv = (args.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {};
    if (rows === null) {
      problems.push('a create-event was recorded but no app DB was attached to prove it was approved');
      continue;
    }
    const root = rows.find((r) => r.id === priv.waAction);
    if (!root) {
      problems.push('create-event waAction does not name an action of this database');
      continue;
    }
    const chain = rows.filter(
      (r) =>
        r.kind === 'create_event' &&
        r.approved_at !== null &&
        EXECUTED_STATES.has(r.state) &&
        chainKeyOf(rows, r).rootId === root.id,
    );
    if (chain.length === 0) {
      problems.push('a create-event has NO approved action record');
      continue;
    }
    // The id must be the deterministic function of the chain key AND the content of an APPROVAL RECORD of that chain:
    // a create-event whose id is not derived from something the user approved fails the ledger.
    const chainKey = chainKeyOf(rows, chain[0]!).key;
    const expectedIds = chain
      .map(finalEventContent)
      .filter((c): c is ApprovedEventContent => c !== null)
      .map((c) => eventIdFor(chainKey, c));
    if (!expectedIds.includes(String(args.eventId)))
      problems.push('create-event eventId is not the deterministic chain + approved-content id');
    if (priv.waItem !== String(chain[0]!.item_id)) problems.push('create-event waItem does not match the action row');
    if (!approved.has(root.id)) problems.push('a create-event has no audit_log action_approved row');
  }

  // 5. no sentinel anywhere in the captured log
  if (s.logText && s.sentinels) {
    const text = s.logText();
    for (const sentinel of s.sentinels)
      if (sentinel !== '' && text.includes(sentinel)) problems.push('a sentinel leaked into the log');
  }

  if (problems.length) throw new Error(`side-effect ledger: ${[...new Set(problems)].join('; ')}`);
}

export { registerFake };
