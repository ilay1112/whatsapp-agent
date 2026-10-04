// tests/helpers/ledger.ts - the side-effect ledger (TESTS 8.1; owner W0 types -> W1-11 bodies; v2 rules 6-12 V2-W1-04).
// Every fake records the side effects it received (sends, create-events) here; the ledger hook cross-checks them against the
// approval records in the app DB after each test: a side effect without a matching approved action fails the test.
//
// TWO entry points, both always on:
//   * `ledger` - the lightweight registry a fake can push into directly (no DB needed).
//   * `assertLedger({ bridge, calendar, db, ... })` - the full TESTS 8.1 cross-check against the app DB. The harness attaches its
//     sources with `attachLedgerSources()`; the global `afterEach` in ledger-hook.ts then runs it for every integration/security test.
import fs from 'node:fs';
import path from 'node:path';
import { registerFake } from '../setup-guards.ts';
import { eventIdFor } from '../../src/main/exec/buildCreateEventArgs.ts';
import { buildUpdateEventArgs } from '../../src/main/exec/buildUpdateEventArgs.ts';
import { UpdateEventPayloadSchema } from '../../src/shared/schemas.ts';
import type { Settings } from '../../src/shared/settings.ts';
import { neverDeleteProblems, neverForeignProblems } from '../fakes/fake-mcp-calendar.ts';
import type { ApprovedEventContent } from '../../src/main/exec/buildCreateEventArgs.ts';
import type { Db } from '../../src/main/db/index.ts';
import type { FakeBridge } from '../fakes/fake-bridge.ts';
import type { FakeMcpCalendar } from '../fakes/fake-mcp-calendar.ts';

export type LedgerKind = 'send_reply' | 'create_event' | 'update_event'; // [V2] T2 8.1 rule 6
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
  approved_by: string | null; // [V2] F18 / T2 8.1 rules 6-7
}

export interface LedgerSources {
  bridge?: Pick<FakeBridge, 'sends'> & { violations?: readonly string[] };
  /** [V2] `appCreated` (the fake calendar v2) switches rule 9 on: every update-event must target an app-created event of this fake. */
  calendar?: Pick<FakeMcpCalendar, 'calls'> & {
    violations?: readonly string[];
    appCreated?: ReadonlyArray<{ eventId: string; priv: Record<string, string> }>;
  };
  db?: Db;
  /** StubLlm.unmatched, when the harness exposes it (TESTS 8.1 item 4). */
  unmatchedLlm?: () => number;
  /** Captured log text + the strings that must never appear in it (TESTS 8.1 item 5). */
  logText?: () => string;
  sentinels?: readonly string[];
  // ---- [V2] T2 8.1 rules 10-12 (sources wired by their owners) ----
  /** fake-bridge `/api/media` journal (rule 10, V2-W1-07). */
  mediaRequests?: () => ReadonlyArray<{ chatJid: string; messageId: string }>;
  /** parsed fake CLI / whisper journal lines with their violations (rule 11, V2-W1-06 via cli-fakes-hook.ts). */
  fakeJournals?: () => ReadonlyArray<{ kind: string; violations: readonly string[] }>;
  // ---- [V2] rule 12 sweep surfaces (V2-W1-04): each is checked for every sentinel and every per-run MCP token ----
  /** the temp userData: every FILE NAME below it is swept (excluding app.db*, bridge\store and `sweepExcludeDirs`). */
  userDataDir?: string;
  /** directories (absolute, or relative to userDataDir) whose file names are not swept (the fakes' own journals). */
  sweepExcludeDirs?: readonly string[];
  /** auto:export output(s), recorded toasts, the tray template labels and the window title. */
  exportTexts?: () => readonly string[];
  toasts?: () => ReadonlyArray<{ title: string; body: string; actions?: readonly string[] }>;
  trayLabels?: () => readonly string[];
  windowTitle?: () => string;
  /** the per-run MCP token(s) collected from the tool-server registry. */
  runTokens?: () => readonly string[];
}

/** [V2] T2 8.1 rule 12: the sentinel set the sweep gains (each test that seeds one passes it in `sentinels`). */
export const V2_SENTINELS = [
  'SENTINEL_TRANSCRIPT',
  'SENTINEL_TRANSCRIPT_STDOUT',
  'SENTINEL_WHISPER_STDERR',
  'SENTINEL_OCR',
  'SENTINEL_WA_ROW_',
  'SENTINEL_OTHER_CHAT',
  'SENTINEL_CLI_STDOUT',
] as const;

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
              a.approved_at, a.approved_final_json, c.jid AS jid, a.approved_by
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

/** [V2] true when `decisionId` is an auto_decisions row for `actionId` with verdict 'auto' (rule 6/7 helper). */
function autoDecisionCovers(db: Db, decisionId: string, actionId: string): boolean {
  try {
    return (
      db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM auto_decisions WHERE id = ? AND action_id = ? AND verdict = 'auto'`,
        )
        .get(decisionId, actionId)!.n > 0
    );
  } catch {
    return false;
  }
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
    // [V2] rule 7: approved by a click ('user') or by a live-policy auto decision for THIS action; never by the toast.
    for (const r of chain) {
      if (r.approved_by === 'user') continue;
      if (r.approved_by === null || r.approved_by === 'user_toast') {
        problems.push(`create-event approved_by is ${r.approved_by === null ? 'NULL' : 'user_toast'}`);
        continue;
      }
      if (s.db && !autoDecisionCovers(s.db, r.approved_by, r.id))
        problems.push('create-event approved_by names no auto decision of this action');
    }
  }

  // [V2] rule 6 (update_event): every update-event call has exactly one approved update_event row (by a click / the toast with an
  // action_approved audit row, or by a live-policy auto decision with an auto_writes pre_json), and its arguments are exactly
  // buildUpdateEventArgs(approved_final_json, pre-flight identity) for that row's chain.
  const usedByUpdate = new Set<string>();
  for (const call of s.calendar?.calls ?? []) {
    if (call.tool !== 'update-event') continue;
    if (rows === null || !s.db) {
      problems.push('an update-event was recorded but no app DB was attached to prove it was approved');
      continue;
    }
    const found = matchUpdateRow(s.db, rows, call.args as Record<string, unknown>, approved);
    if (typeof found === 'string') {
      problems.push(found);
      continue;
    }
    if (usedByUpdate.has(found.id)) problems.push('two update-event calls share one approved action (rule 6)');
    usedByUpdate.add(found.id);
  }
  // [V2] rule 8: never delete - zero delete-event calls, independent of the fake's own violation.
  for (const pr of neverDeleteProblems(s.calendar?.calls ?? [])) problems.push(`${pr} (rule 8)`);
  // [V2] rule 9: never foreign - zero update_on_foreign_event violations; every update targets an app-created event of this fake.
  if (s.calendar?.appCreated !== undefined) {
    const calls = s.calendar.calls as ReadonlyArray<{ tool: string; args: Record<string, unknown> }>;
    const foreign = neverForeignProblems({
      appCreated: s.calendar.appCreated,
      calls,
      violations: s.calendar.violations ?? [],
    });
    for (const pr of foreign) problems.push(`${pr} (rule 9)`);
  }
  // [V2] rule 10 (media): the fake bridge refuses and journals a request for an unknown row (media_unknown_row), a non-media row
  // (media_non_media_row) and more than two requests per message per triage (media_retry_storm) - its violations are checked above;
  // here every journaled request must at least name a message.
  for (const m of s.mediaRequests?.() ?? []) {
    if (typeof m.chatJid !== 'string' || m.chatJid === '' || typeof m.messageId !== 'string' || m.messageId === '')
      problems.push('a /api/media request named no message (rule 10)');
  }
  // [V2] rule 11 (jobs): every fake CLI / whisper journal entry is violation-free.
  for (const j of s.fakeJournals?.() ?? [])
    for (const v of j.violations) problems.push(`${j.kind} fake violation: ${v}`);

  // 5. no sentinel anywhere in the captured log
  if (s.logText && s.sentinels) {
    const text = s.logText();
    for (const sentinel of s.sentinels)
      if (sentinel !== '' && text.includes(sentinel)) problems.push('a sentinel leaked into the log');
  }
  // [V2] rule 12: the sweep also covers file names under userData, auto:export output, toasts, the tray and the window title, and
  // the per-run MCP token(s) are sentinels too.
  problems.push(...sentinelSweepProblems(s));

  if (problems.length) throw new Error(`side-effect ledger: ${[...new Set(problems)].join('; ')}`);
}

export { registerFake };

// ---------------------------------------------------------------------------------------------------------------------
// [V2] rule 6 helper - one approved update_event row per update-event call
// ---------------------------------------------------------------------------------------------------------------------

function targetCalendarOf(db: Db): string | null {
  try {
    const row = db.prepare<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = 'settings'`).get();
    if (row === undefined) return null;
    const parsed = JSON.parse(row.value_json) as { calendar?: { targetCalendarId?: unknown } };
    return typeof parsed.calendar?.targetCalendarId === 'string' ? parsed.calendar.targetCalendarId : null;
  } catch {
    return null;
  }
}

function autoDecisionWithPre(db: Db, decisionId: string, actionId: string): boolean {
  try {
    const row = db
      .prepare<{ n: number }>(
        `SELECT COUNT(*) AS n FROM auto_decisions d JOIN auto_writes w ON w.decision_id = d.id
          WHERE d.id = ? AND d.action_id = ? AND d.verdict = 'auto' AND w.action_id = ? AND w.pre_json IS NOT NULL`,
      )
      .get(decisionId, actionId, actionId);
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function eventOfItem(db: Db, itemId: number): string | null {
  try {
    const row = db
      .prepare<{ calendar_event_id: string | null }>(`SELECT calendar_event_id FROM items WHERE id = ?`)
      .get(itemId);
    return row?.calendar_event_id ?? null;
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** Returns the one matching row, or the problem text. */
function matchUpdateRow(
  db: Db,
  rows: ActionRowLite[],
  args: Record<string, unknown>,
  approved: Set<string>,
): ActionRowLite | string {
  const ext = (args.extendedProperties as { private?: Record<string, string> } | undefined)?.private ?? {};
  const candidates = rows.filter((r) => {
    if (r.kind !== 'update_event' || !EXECUTED_STATES.has(r.state) || r.approved_final_json === null) return false;
    const parsed = UpdateEventPayloadSchema.safeParse(safeJson(r.approved_final_json));
    return (
      parsed.success &&
      parsed.data.targetEventId === args.eventId &&
      chainKeyOf(rows, r).rootId === ext.waUpdate &&
      String(parsed.data.baseRevision + 1) === ext.waRev
    );
  });
  if (candidates.length === 0) return 'an update-event has NO approved update_event action record (rule 6)';
  if (candidates.length > 1) return 'an update-event matches more than one approved update_event action (rule 6)';
  const row = candidates[0]!;
  const final = UpdateEventPayloadSchema.parse(safeJson(row.approved_final_json!));
  if (row.approved_by === null) return 'an update-event action has approved_by NULL (rule 6)';
  if (row.approved_by === 'user' || row.approved_by === 'user_toast') {
    if (!approved.has(row.id)) return 'an update-event has no audit_log action_approved row (rule 6)';
    if (row.approved_by === 'user_toast' && (final.change !== 'undo' || final.revertOf === undefined))
      return "an update-event approved by 'user_toast' is not an undo (rule 6)";
  } else if (!autoDecisionWithPre(db, row.approved_by, row.id)) {
    return 'an automatic update-event has no auto decision with an auto_writes pre_json (rule 6)';
  }
  const target = targetCalendarOf(db);
  if (target === null || args.calendarId !== target)
    return 'an update-event targets another calendar than the configured one (rule 6)';
  if (eventOfItem(db, final.targetItemId) !== final.targetEventId)
    return "an update-event target is not the source item's calendar event (rule 6)";
  let expected: Record<string, unknown>;
  try {
    expected = buildUpdateEventArgs(
      final,
      { rootActionId: ext.waUpdate ?? '', chainKey: '' },
      {
        etag: typeof args.ifMatch === 'string' ? args.ifMatch : '',
        priv: { waAgent: ext.waAgent ?? null, waItem: ext.waItem ?? null, waAction: ext.waAction ?? null },
      },
      { calendar: { targetCalendarId: target } } as unknown as Settings,
      { descriptionTemplate: '' },
    ) as unknown as Record<string, unknown>;
  } catch {
    return 'an update-event carried no valid pre-flight identity / etag (rule 6)';
  }
  if (JSON.stringify(sortKeys(expected)) !== JSON.stringify(sortKeys(args)))
    return 'update-event arguments differ from buildUpdateEventArgs(approved_final_json, pre-flight identity) (rule 6)';
  return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// [V2] rule 12 helper - the sentinel sweep over every surface a user or another process can see
// ---------------------------------------------------------------------------------------------------------------------

/** File names below `root` (names only; the contents of app.db and the bridge store are swept by their own tests). */
export function fileNamesUnder(root: string, exclude: readonly string[] = []): string[] {
  const out: string[] = [];
  const skip = new Set(exclude.map((d) => path.resolve(root, d).toLowerCase()));
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (skip.has(full.toLowerCase())) continue;
      if (/^app\.db(-wal|-shm|-journal)?$/i.test(e.name)) continue;
      out.push(e.name);
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** T2 8.1 rule 12: every sentinel (and every per-run MCP token) absent from every swept surface. */
export function sentinelSweepProblems(s: LedgerSources): string[] {
  const needles = [...(s.sentinels ?? []), ...(s.runTokens?.() ?? [])].filter((x) => x !== '');
  if (needles.length === 0) return [];
  const surfaces: Array<[string, string]> = [];
  if (s.userDataDir !== undefined) {
    const exclude = [path.join('bridge', 'store'), ...(s.sweepExcludeDirs ?? [])];
    surfaces.push(['a file name under userData', fileNamesUnder(s.userDataDir, exclude).join('\n')]);
  }
  for (const text of s.exportTexts?.() ?? []) surfaces.push(['the auto:export output', text]);
  for (const t of s.toasts?.() ?? []) surfaces.push(['a toast', [t.title, t.body, ...(t.actions ?? [])].join('\n')]);
  if (s.trayLabels) surfaces.push(['the tray menu', s.trayLabels().join('\n')]);
  if (s.windowTitle) surfaces.push(['the window title', s.windowTitle()]);
  const problems: string[] = [];
  for (const [where, text] of surfaces) {
    if (needles.some((n) => text.includes(n))) problems.push(`a sentinel leaked into ${where} (rule 12)`);
  }
  return problems;
}
