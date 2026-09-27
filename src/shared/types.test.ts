// CONTRACTS section 18 item 3: every const tuple in types.ts equals the matching DDL CHECK list (parsed from MIGRATIONS[0].sql).
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../main/db/migrations';
import {
  ACTION_KINDS,
  ACTION_STATES,
  ANALYSIS_STATES,
  CHAT_POLICIES,
  CLOSED_REASONS,
  CONSENT_KINDS,
  EVENT_STATES,
  HOLD_REASONS,
  ITEM_STATES,
  LANGS,
  MODEL_FILE_STATUSES,
  MODEL_TIERS,
  OPEN_ITEM_STATES,
  PROVIDER_IDS,
  REPLY_STATES,
  SECRET_NAMES,
  BADGE_SEVERITY,
  BADGES,
  CONSENT_VERSIONS,
  LIMITS,
} from './types';

const sql = MIGRATIONS[0]!.sql;

/** Extracts the quoted list of `<table>.<column> ... CHECK(... IN ('a','b'))` (first CHECK IN for that column inside the CREATE TABLE). */
function checkList(table: string, column: string): string[] {
  const tableStart = sql.indexOf(`CREATE TABLE ${table}`);
  expect(tableStart, `table ${table}`).toBeGreaterThanOrEqual(0);
  const body = sql.slice(tableStart, sql.indexOf(');', tableStart));
  const colIdx = body.search(new RegExp(`(^|[\\s(])${column}\\s`));
  expect(colIdx, `${table}.${column}`).toBeGreaterThanOrEqual(0);
  const rest = body.slice(colIdx);
  const m = rest.match(/IN\s*\(([^)]*)\)/);
  expect(m, `${table}.${column} CHECK IN`).not.toBeNull();
  return [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}
const sorted = (a: readonly string[]) => [...a].sort();

describe('const tuples == DDL CHECK lists', () => {
  it.each([
    ['items.state', ITEM_STATES, 'items', 'state'],
    ['items.analysis', ANALYSIS_STATES, 'items', 'analysis'],
    ['items.hold_reason', HOLD_REASONS, 'items', 'hold_reason'],
    ['items.reply_state', REPLY_STATES, 'items', 'reply_state'],
    ['items.event_state', EVENT_STATES, 'items', 'event_state'],
    ['items.closed_reason', CLOSED_REASONS, 'items', 'closed_reason'],
    ['chats.policy', CHAT_POLICIES, 'chats', 'policy'],
    ['chats.lang', LANGS, 'chats', 'lang'],
    ['actions.kind', ACTION_KINDS, 'actions', 'kind'],
    ['actions.state', ACTION_STATES, 'actions', 'state'],
    ['secrets.name', SECRET_NAMES, 'secrets', 'name'],
    ['consents.kind', CONSENT_KINDS, 'consents', 'kind'],
    ['runs.provider', PROVIDER_IDS, 'runs', 'provider'],
    ['model_files.id', MODEL_TIERS, 'model_files', 'id'],
    ['model_files.status', MODEL_FILE_STATUSES, 'model_files', 'status'],
  ] as const)('%s', (_name, tuple, table, column) => {
    expect(sorted(checkList(table, column))).toEqual(sorted(tuple));
  });
  it('proposals.provider = PROVIDER_IDS + user ; proposals.reply_lang = LANGS', () => {
    expect(sorted(checkList('proposals', 'provider'))).toEqual(sorted([...PROVIDER_IDS, 'user']));
    expect(sorted(checkList('proposals', 'reply_lang'))).toEqual(sorted(LANGS));
  });
  it('ux_items_open partial index lists exactly OPEN_ITEM_STATES', () => {
    const m = sql.match(/CREATE UNIQUE INDEX ux_items_open ON items\(chat_id\) WHERE state IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(sorted([...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!))).toEqual(sorted(OPEN_ITEM_STATES));
  });
  it('trigger terminal-state list = ACTION_STATES minus pending/approved/executing/unknown_outcome', () => {
    const m = sql.match(/WHEN OLD\.state IN \(([^)]*)\) THEN RAISE\(ABORT,'terminal state'\)/);
    expect(m).not.toBeNull();
    const terminal = [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
    expect(sorted(terminal)).toEqual(
      sorted(ACTION_STATES.filter((s) => !['pending', 'approved', 'executing', 'unknown_outcome'].includes(s))),
    );
  });
});

describe('tuple invariants', () => {
  it('BADGE_SEVERITY covers every badge', () => {
    expect(sorted(Object.keys(BADGE_SEVERITY))).toEqual(sorted(BADGES));
  });
  it('CONSENT_VERSIONS covers every consent kind with a positive integer', () => {
    expect(sorted(Object.keys(CONSENT_VERSIONS))).toEqual(sorted(CONSENT_KINDS));
    for (const v of Object.values(CONSENT_VERSIONS)) expect(Number.isInteger(v) && v > 0).toBe(true);
  });
  it('LIMITS are positive numbers and the backlog windows are ordered', () => {
    for (const [k, v] of Object.entries(LIMITS)) expect(v, k).toBeGreaterThan(0);
    expect(LIMITS.syncMaxAgeMs).toBeLessThan(LIMITS.ingestMaxAgeMs);
    expect(LIMITS.debounceMs).toBeLessThanOrEqual(LIMITS.debounceCapMs);
    expect(LIMITS.sendJitterMinMs).toBeLessThan(LIMITS.sendJitterMaxMs);
  });
});
