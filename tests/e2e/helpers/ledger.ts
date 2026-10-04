// tests/e2e/helpers/ledger.ts - the side-effect ledger for L5 (TESTS 8.1 + T2 8.1 rules 6-12; owner W2-03 -> V2-W2-03).
//
// Why this file exists instead of `tests/helpers/ledger.ts`: that module imports `tests/setup-guards.ts`, which calls
// `vi.mock()` at module scope. Playwright is not a vitest runtime, so the import throws
// ("Vitest mocker was not initialized in this environment"). The cross-check below is the same contract, run against the
// SQLite profile the app just wrote and against the journals the fakes kept. It reuses the PRODUCT builders
// (`eventIdFor`, `buildUpdateEventArgs`) and the frozen payload schema so an update-event is compared byte for byte with what
// the approval record allows - exactly like the vitest ledger does.
//
// It asserts, for the whole spec (per profile):
//   1. every bridge send has exactly one approved `send_reply` action whose chat JID == recipient and whose
//      approved_final_json.text == the message, approved BEFORE it was sent, with an `action_approved` audit row;
//   2. every MCP `create-event` has an approved `create_event` action (chain root = extendedProperties.private.waAction), the
//      deterministic event id of that chain + approved content, `sendUpdates:'none'`, only whitelisted keys, and
//      [V2 rule 7] `approved_by` = 'user' or an `auto_decisions` row of THIS action with verdict 'auto' (never NULL / 'user_toast');
//   3. [V2 rule 6] every `update-event` has exactly one executed `update_event` action (target event, chain root = waUpdate,
//      waRev = baseRevision + 1) approved by a click ('user' / the toast's 'user_toast' ONLY for an undo, both with an
//      `action_approved` audit row) or by an automatic decision with an `auto_writes.pre_json`; its arguments are exactly
//      `buildUpdateEventArgs(approved_final_json, pre-flight identity)`, the target calendar is the configured one and the target
//      event is the source item's calendar event;
//   4. [V2 rule 8] zero `delete-event` calls; [V2 rule 9] zero `update_on_foreign_event` violations and every `update-event` targets
//      an event an app `create-event` made in the SAME fake calendar with the same identity tags;
//   5. [V2 rule 10] every `/api/media` request names a message; [V2 rule 11] every fake CLI / whisper journal entry is violation-free;
//   6. every fake's `violations` list is empty;
//   7. [V2 rule 12] no sentinel in any log line, any FILE NAME under userData (app.db* and bridge\store excluded), any toast, the tray
//      menu / tooltip or a window title.
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eventIdFor, type ApprovedEventContent } from '../../../src/main/exec/buildCreateEventArgs.ts';
import { buildUpdateEventArgs } from '../../../src/main/exec/buildUpdateEventArgs.ts';
import { UpdateEventPayloadSchema } from '../../../src/shared/schemas.ts';
import type { Settings } from '../../../src/shared/settings.ts';

export interface SendRecord {
  at: number;
  recipient: string;
  message: string;
  /** The profile whose fake bridge recorded it (undefined = checked against every profile of the spec). */
  userDataDir?: string;
}
export interface CreateEventRecord {
  at: number;
  args: Record<string, unknown>;
  userDataDir?: string;
}
/** [V2] one tool call of a fake calendar (journalled by the child), with the fake's label so rule 9 can group per calendar. */
export interface CalendarCallRecord {
  at: number;
  tool: string;
  args: Record<string, unknown>;
  source: string;
  userDataDir?: string;
}
/** [V2] rule 10: one `/api/media` request the fake bridge served. */
export interface MediaRequestRecord {
  chatJid: string;
  messageId: string;
  userDataDir?: string;
}
/** [V2] rule 11: a fake CLI / whisper journal (parsed lear per invocation) - every entry must be violation-free. */
export interface FakeJournalSource {
  kind: 'claude' | 'agy' | 'whisper';
  entries(): ReadonlyArray<{ violations?: readonly string[] }>;
  userDataDir?: string;
}
/** [V2] rule 12: what a user or another process can see of the running app (captured just before the quit). */
export interface SurfaceCapture {
  toasts: ReadonlyArray<{ title: string; body: string; actions?: readonly string[] }>;
  trayLabels: readonly string[];
  windowTitles: readonly string[];
}

export interface LedgerSources {
  /** `<tmp userData>` of the launch under test. */
  userDataDir: string;
  /** Everything any fake bridge of this spec received. */
  sends: SendRecord[];
  /** Every `create-event` tool call any fake calendar of this spec received (v1 view; kept for the v1 specs). */
  createEvents: CreateEventRecord[];
  /** [V2] every tool call any fake calendar of this spec received (rules 6-9). */
  calendarCalls?: CalendarCallRecord[];
  /** [V2] rule 10. */
  mediaRequests?: MediaRequestRecord[];
  /** [V2] rule 11. */
  journals?: FakeJournalSource[];
  /** `violations` of every fake, flattened. */
  violations: string[];
  /** Strings that must never appear in a log line (message text, names, JIDs, keys, per-launch tokens). */
  sentinels: string[];
  /** [V2] rule 12. */
  surfaces?: SurfaceCapture[];
}

interface ActionRow {
  id: string;
  item_id: number;
  kind: string;
  state: string;
  retry_of: string | null;
  idempotency_key: string;
  approved_at: number | null;
  approved_final_json: string | null;
  approved_by: string | null;
  jid: string;
}

const ALLOWED_STATES = new Set(['executing', 'done', 'failed', 'unknown_outcome']);

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

function withDb<T>(appDb: string, fallback: T, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(appDb)) return fallback;
  const db = new DatabaseSync(appDb, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readActions(appDb: string): ActionRow[] {
  return withDb(appDb, [] as ActionRow[], (db) => {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(actions)`).all() as unknown as Array<{ name: string }>).map((c) => c.name),
    );
    const approvedBy = cols.has('approved_by') ? 'a.approved_by' : 'NULL';
    return db
      .prepare(
        `SELECT a.id AS id, a.item_id AS item_id, a.kind AS kind, a.state AS state, a.retry_of AS retry_of,
                a.idempotency_key AS idempotency_key, a.approved_at AS approved_at,
                a.approved_final_json AS approved_final_json, ${approvedBy} AS approved_by, c.jid AS jid
           FROM actions a JOIN chats c ON c.id = a.chat_id`,
      )
      .all() as unknown as ActionRow[];
  });
}

function readApprovedAudit(appDb: string): Map<string, number> {
  return withDb(appDb, new Map<string, number>(), (db) => {
    const out = new Map<string, number>();
    const rows = db.prepare(`SELECT ref, ts FROM audit_log WHERE kind = 'action_approved'`).all() as unknown as Array<{
      ref: string | null;
      ts: number;
    }>;
    for (const r of rows) if (r.ref !== null && !out.has(r.ref)) out.set(r.ref, r.ts);
    return out;
  });
}

function autoDecisionCovers(appDb: string, decisionId: string, actionId: string, needPre: boolean): boolean {
  return withDb(appDb, false, (db) => {
    try {
      const sql = needPre
        ? `SELECT COUNT(*) AS n FROM auto_decisions d JOIN auto_writes w ON w.decision_id = d.id
            WHERE d.id = ? AND d.action_id = ? AND d.verdict = 'auto' AND w.action_id = ? AND w.pre_json IS NOT NULL`
        : `SELECT COUNT(*) AS n FROM auto_decisions WHERE id = ? AND action_id = ? AND verdict = 'auto' AND ? IS NOT NULL`;
      const row = db.prepare(sql).get(decisionId, actionId, actionId) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    } catch {
      return false;
    }
  });
}

function targetCalendarOf(appDb: string): string | null {
  return withDb(appDb, null as string | null, (db) => {
    try {
      const row = db.prepare(`SELECT value_json FROM settings WHERE key = 'settings'`).get() as
        { value_json: string } | undefined;
      if (row === undefined) return null;
      const parsed = JSON.parse(row.value_json) as { calendar?: { targetCalendarId?: unknown } };
      return typeof parsed.calendar?.targetCalendarId === 'string' ? parsed.calendar.targetCalendarId : null;
    } catch {
      return null;
    }
  });
}

/**
 * Every calendar event the item has carried: its current `calendar_event_id` plus every event of an `event_revisions` row it wrote.
 * The ledger runs on the END state of the profile, and an item's event can legitimately change later in the spec (an undo of a
 * cancel that Google refused ends in "Add it back" = a NEW event on the same item) - rule 6 is about the event at proposal time.
 */
function eventsOfItem(appDb: string, itemId: number): Set<string> {
  return withDb(appDb, new Set<string>(), (db) => {
    const out = new Set<string>();
    try {
      const row = db.prepare(`SELECT calendar_event_id FROM items WHERE id = ?`).get(itemId) as
        { calendar_event_id: string | null } | undefined;
      if (row?.calendar_event_id) out.add(row.calendar_event_id);
      const revs = db
        .prepare(`SELECT calendar_event_id FROM event_revisions WHERE item_id = ?`)
        .all(itemId) as unknown as Array<{ calendar_event_id: string }>;
      for (const r of revs) out.add(r.calendar_event_id);
    } catch {
      /* a v1 profile has no event_revisions */
    }
    return out;
  });
}

/** The chain key = idempotency key without the `:rN` retry suffix; every clone of a chain shares it (CONTRACTS 14). */
function chainOf(rows: ActionRow[], row: ActionRow): { key: string; rootId: string } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let current = row;
  const seen = new Set([current.id]);
  while (current.retry_of !== null) {
    const parent = byId.get(current.retry_of);
    if (parent === undefined || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return { key: current.idempotency_key.replace(/:r\d+$/, ''), rootId: current.id };
}

function safeJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
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

function textOf(approvedFinalJson: string | null): string | null {
  const parsed = safeJson(approvedFinalJson) as { text?: unknown } | null;
  return parsed !== null && typeof parsed.text === 'string' ? parsed.text : null;
}

function eventContentOf(row: ActionRow): ApprovedEventContent | null {
  const p = safeJson(row.approved_final_json) as Record<string, unknown> | null;
  if (p === null || p.kind !== 'create_event') return null;
  const fields = ['title', 'startLocal', 'endLocal', 'timeZone', 'location'] as const;
  if (fields.some((f) => typeof p[f] !== 'string')) return null;
  return {
    title: p.title as string,
    startLocal: p.startLocal as string,
    endLocal: p.endLocal as string,
    timeZone: p.timeZone as string,
    location: p.location as string,
  };
}

function privOf(args: Record<string, unknown>): Record<string, string> {
  const ext = args.extendedProperties as { private?: Record<string, unknown> } | undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ext?.private ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
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

/** [V2] rule 12: file names below `root` (names only; app.db* and the bridge store are excluded - their CONTENT is data). */
export function fileNamesUnder(root: string, exclude: readonly string[] = []): string[] {
  const out: string[] = [];
  const skip = new Set(exclude.map((d) => resolve(root, d).toLowerCase()));
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (skip.has(full.toLowerCase())) continue;
      if (/^app\.db(-wal|-shm|-journal)?$/i.test(e.name)) continue;
      out.push(e.name);
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Rule 6: the one executed update_event row an update-event call is bound to, or the problem text. */
function matchUpdateRow(
  appDb: string,
  rows: ActionRow[],
  args: Record<string, unknown>,
  approved: Map<string, number>,
  at: number,
): ActionRow | string {
  const ext = privOf(args);
  const candidates = rows.filter((r) => {
    if (r.kind !== 'update_event' || !ALLOWED_STATES.has(r.state) || r.approved_final_json === null) return false;
    const parsed = UpdateEventPayloadSchema.safeParse(safeJson(r.approved_final_json));
    return (
      parsed.success &&
      parsed.data.targetEventId === args.eventId &&
      chainOf(rows, r).rootId === ext.waUpdate &&
      String(parsed.data.baseRevision + 1) === ext.waRev
    );
  });
  if (candidates.length === 0) return 'an update-event has NO approved update_event action record (rule 6)';
  if (candidates.length > 1) return 'an update-event matches more than one approved update_event action (rule 6)';
  const row = candidates[0]!;
  const final = UpdateEventPayloadSchema.parse(safeJson(row.approved_final_json));
  if (row.approved_by === null) return 'an update-event action has approved_by NULL (rule 6)';
  if (row.approved_by === 'user' || row.approved_by === 'user_toast') {
    const auditTs = approved.get(row.id);
    if (auditTs === undefined) return 'an update-event has no audit_log action_approved row (rule 6)';
    if (auditTs > at) return 'an update-event was audited as approved AFTER it reached the calendar (rule 6)';
    if (row.approved_by === 'user_toast' && (final.change !== 'undo' || final.revertOf === undefined))
      return "an update-event approved by 'user_toast' is not an undo (rule 6)";
  } else if (!autoDecisionCovers(appDb, row.approved_by, row.id, true)) {
    return 'an automatic update-event has no auto decision with an auto_writes pre_json (rule 6)';
  }
  const target = targetCalendarOf(appDb);
  if (target === null || args.calendarId !== target)
    return 'an update-event targets another calendar than the configured one (rule 6)';
  if (!eventsOfItem(appDb, final.targetItemId).has(final.targetEventId))
    return "an update-event target is not the source item's calendar event (rule 6)";
  let expected: Record<string, unknown>;
  try {
    expected = buildUpdateEventArgs(
      final,
      { rootActionId: (ext.waUpdate ?? '') as never, chainKey: '' },
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

/** Throws with every problem it found; an empty return means the spec caused no unapproved side effect. */
export function assertE2eLedger(src: LedgerSources): void {
  const problems: string[] = [];
  const appDb = join(src.userDataDir, 'app.db');
  const actions = readActions(appDb);
  const approvedAudit = readApprovedAudit(appDb);
  const usedActionIds = new Set<string>();

  // ---- 1. sends -------------------------------------------------------------------------------------------------------
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
    if (action.approved_by !== null && action.approved_by !== 'user') {
      problems.push(
        `send_reply action ${action.id} is approved_by ${action.approved_by} (only a click may send - I1')`,
      );
    }
    const auditTs = approvedAudit.get(action.id);
    if (auditTs === undefined) problems.push(`action ${action.id} has no action_approved audit row`);
    else if (auditTs > send.at) problems.push(`action ${action.id} was audited after the send`);
  }

  // ---- 2. create-event (v1 rule + v2 rule 7) ----------------------------------------------------------------------------
  const createCalls: Array<{ at: number; args: Record<string, unknown> }> = src.calendarCalls
    ? src.calendarCalls.filter((c) => c.tool === 'create-event')
    : src.createEvents;
  for (const ev of createCalls) {
    const args = ev.args;
    for (const key of Object.keys(args))
      if (!CREATE_EVENT_KEYS.has(key)) problems.push(`create-event carried a non-whitelisted key: ${key}`);
    if (args.sendUpdates !== 'none') problems.push('create-event did not pin sendUpdates:none');
    const priv = privOf(args);
    const waAction = priv.waAction;
    if (waAction === undefined) {
      problems.push('create-event carries no extendedProperties.private.waAction');
      continue;
    }
    const root = actions.find((a) => a.id === waAction);
    if (root === undefined) {
      problems.push(`create-event names unknown action ${waAction}`);
      continue;
    }
    if (root.kind !== 'create_event') {
      problems.push(`create-event names a ${root.kind} action`);
      continue;
    }
    const chain = actions.filter(
      (a) =>
        a.kind === 'create_event' &&
        a.approved_at !== null &&
        ALLOWED_STATES.has(a.state) &&
        chainOf(actions, a).rootId === root.id,
    );
    if (chain.length === 0) {
      problems.push(`create-event executed for UNAPPROVED action ${waAction} (state=${root.state})`);
      continue;
    }
    const chainKey = chainOf(actions, chain[0]!).key;
    const expectedIds = chain
      .map(eventContentOf)
      .filter((c): c is ApprovedEventContent => c !== null)
      .map((c) => eventIdFor(chainKey, c));
    if (!expectedIds.includes(String(args.eventId)))
      problems.push('create-event eventId is not the deterministic chain + approved-content id');
    if (priv.waItem !== String(chain[0]!.item_id)) problems.push('create-event waItem does not match the action row');
    for (const r of chain) {
      if (r.approved_by === 'user') {
        const auditTs = approvedAudit.get(r.id) ?? approvedAudit.get(root.id);
        if (auditTs === undefined) problems.push(`create_event action ${r.id} has no action_approved audit row`);
        continue;
      }
      if (r.approved_by === null || r.approved_by === 'user_toast') {
        problems.push(`create-event approved_by is ${r.approved_by === null ? 'NULL' : 'user_toast'} (rule 7)`);
        continue;
      }
      if (!autoDecisionCovers(appDb, r.approved_by, r.id, false))
        problems.push('create-event approved_by names no automatic decision of this action (rule 7)');
    }
  }

  // ---- 3. update-event (v2 rule 6) --------------------------------------------------------------------------------------
  const usedByUpdate = new Set<string>();
  for (const call of src.calendarCalls ?? []) {
    if (call.tool !== 'update-event') continue;
    const found = matchUpdateRow(appDb, actions, call.args, approvedAudit, call.at);
    if (typeof found === 'string') {
      problems.push(found);
      continue;
    }
    if (usedByUpdate.has(found.id)) problems.push('two update-event calls share one approved action (rule 6)');
    usedByUpdate.add(found.id);
  }

  // ---- 4. never delete (rule 8) / never foreign (rule 9), per fake calendar ----------------------------------------------
  const bySource = new Map<string, CalendarCallRecord[]>();
  for (const c of src.calendarCalls ?? []) bySource.set(c.source, [...(bySource.get(c.source) ?? []), c]);
  for (const [source, calls] of bySource) {
    const deletes = calls.filter((c) => c.tool === 'delete-event' || c.tool === 'delete_event').length;
    if (deletes > 0) problems.push(`never-delete: ${deletes} delete-event call(s) reached calendar ${source} (rule 8)`);
    const created = new Map<string, Record<string, string>>();
    for (const c of calls) if (c.tool === 'create-event') created.set(String(c.args.eventId), privOf(c.args));
    for (const c of calls) {
      if (c.tool !== 'update-event') continue;
      const origin = created.get(String(c.args.eventId));
      if (origin === undefined) {
        problems.push(`never-foreign: update-event on an event no app create-event made in ${source} (rule 9)`);
        continue;
      }
      const priv = privOf(c.args);
      if (priv.waAgent !== '1' || priv.waItem !== origin.waItem || priv.waAction !== origin.waAction)
        problems.push(`never-foreign: update-event identity tags differ from the creating create-event (rule 9)`);
    }
  }
  for (const v of src.violations)
    if (v.startsWith('update_on_foreign_event:')) problems.push(`never-foreign: ${v} (rule 9)`);

  // ---- 5. media (rule 10) and job journals (rule 11) -----------------------------------------------------------------------
  for (const m of src.mediaRequests ?? []) {
    if (m.chatJid === '' || m.messageId === '') problems.push('a /api/media request named no message (rule 10)');
  }
  for (const j of src.journals ?? []) {
    for (const e of j.entries())
      for (const v of e.violations ?? []) problems.push(`${j.kind} fake journal violation: ${v} (rule 11)`);
  }

  // ---- 6. fake violations --------------------------------------------------------------------------------------------------
  if (src.violations.length > 0) problems.push(`fake violations: ${src.violations.join(', ')}`);

  // ---- 7. sentinels (v1 logs + v2 rule 12 surfaces) -----------------------------------------------------------------------
  const needles = src.sentinels.filter((s) => s.length >= 6);
  const logText = readLogText(src.userDataDir);
  for (const sentinel of needles) {
    if (logText.includes(sentinel)) {
      problems.push(`a log file leaked the sentinel ${JSON.stringify(sentinel.slice(0, 12))}...`);
    }
  }
  const surfaces: Array<[string, string]> = [
    ['a file name under userData', fileNamesUnder(src.userDataDir, [join('bridge', 'store')]).join('\n')],
  ];
  for (const s of src.surfaces ?? []) {
    for (const t of s.toasts) surfaces.push(['a toast', [t.title, t.body, ...(t.actions ?? [])].join('\n')]);
    surfaces.push(['the tray menu', s.trayLabels.join('\n')]);
    surfaces.push(['a window title', s.windowTitles.join('\n')]);
  }
  for (const [where, text] of surfaces) {
    const hit = needles.find((n) => text.includes(n));
    if (hit !== undefined)
      problems.push(`${where} leaked the sentinel ${JSON.stringify(hit.slice(0, 12))}... (rule 12)`);
  }

  if (problems.length > 0)
    throw new Error(`E2E side-effect ledger failed:\n  - ${[...new Set(problems)].join('\n  - ')}`);
}
