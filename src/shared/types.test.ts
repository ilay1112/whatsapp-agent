// CONTRACTS section 18 item 3: every const tuple in types.ts equals the matching DDL CHECK list.
// [V2] C2 19 item 11: the lists are parsed from the NEWEST migration that (re)creates the table (v4 rebuilds items, proposals, runs,
// actions, consents and model_files as <table>_new and adds six tables), so the checks follow the live schema.
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../main/db/migrations';
import { SECRET_FOR } from '../main/llm/factory';
import { MODEL_MANIFEST } from '../main/llm/local/manifest';
import { CLAUDE_MIN_VERSION } from '../main/llm/cli/claudeCli';
import { AGY_MIN_VERSION } from '../main/llm/cli/antigravityCli';
import {
  API_KEY_PROVIDER_IDS,
  CLI_MIN_VERSION,
  CONSENT_KIND_FOR,
  DOWNLOAD_TARGETS,
  MMPROJ_IDS,
  PROVIDER_LOOP,
  VOICE_TIERS,
  modelFileKindOf,
} from './types';
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
  AUTO_DISABLED_REASONS,
  AUTO_LIVE_STATES,
  AUTO_PAUSED_REASONS,
  AUTO_POLICY_STATES,
  AUTO_REASONS,
  AUTO_UNDO_STATES,
  AUTO_VERDICTS,
  AUTO_WRITE_KINDS,
  CHAT_AUTO_POLICIES,
  MODEL_FILE_IDS,
  MODEL_FILE_KINDS,
  PROVIDER_CLASSES,
  REVISION_KINDS,
  TRANSCRIPT_STATUSES,
  TRIGGER_AUTHORS,
  TRIGGER_KINDS,
} from './types';

/** The SQL of the newest migration that creates `table` (plain or as the `<table>_new` of a rebuild). */
function tableSql(table: string): { sql: string; start: number } {
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const s = MIGRATIONS[i]!.sql;
    for (const name of [`${table}_new`, table]) {
      const m = new RegExp(`CREATE TABLE ${name}\\s*\\(`).exec(s);
      if (m) return { sql: s, start: m.index };
    }
  }
  return { sql: '', start: -1 };
}
/** The SQL of the newest migration containing `needle`. */
function newestSqlWith(needle: RegExp): string {
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) if (needle.test(MIGRATIONS[i]!.sql)) return MIGRATIONS[i]!.sql;
  return '';
}
const sql = newestSqlWith(/CREATE UNIQUE INDEX ux_items_open/);

/** Extracts the quoted list of `<table>.<column> ... CHECK(... IN ('a','b'))` (first CHECK IN for that column inside the CREATE TABLE). */
function checkList(table: string, column: string): string[] {
  const { sql, start: tableStart } = tableSql(table);
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
    ['model_files.id', MODEL_FILE_IDS, 'model_files', 'id'], // [V2] MODEL_TIERS -> MODEL_FILE_IDS (C2 1.1)
    ['model_files.status', MODEL_FILE_STATUSES, 'model_files', 'status'],
  ] as const)('%s', (_name, tuple, table, column) => {
    expect(sorted(checkList(table, column))).toEqual(sorted(tuple));
  });
  it('proposals.provider = PROVIDER_IDS + user ; proposals.reply_lang = LANGS', () => {
    expect(sorted(checkList('proposals', 'provider'))).toEqual(sorted([...PROVIDER_IDS, 'user']));
    expect(sorted(checkList('proposals', 'reply_lang'))).toEqual(sorted(LANGS));
  });
  // ---- [V2] C2 19 item 11: the new tuples against migration v4 ----
  it.each([
    ['proposals.provider_class', PROVIDER_CLASSES, 'proposals', 'provider_class'],
    ['proposals.trigger_author', TRIGGER_AUTHORS, 'proposals', 'trigger_author'],
    ['items.trigger_kind', TRIGGER_KINDS, 'items', 'trigger_kind'],
    ['model_files.kind', MODEL_FILE_KINDS, 'model_files', 'kind'],
    ['auto_policies.state', AUTO_POLICY_STATES, 'auto_policies', 'state'],
    ['auto_policies.paused_reason', AUTO_PAUSED_REASONS, 'auto_policies', 'paused_reason'],
    ['auto_policies.disabled_reason', AUTO_DISABLED_REASONS, 'auto_policies', 'disabled_reason'],
    ['auto_decisions.verdict', AUTO_VERDICTS, 'auto_decisions', 'verdict'],
    ['auto_decisions.kind', AUTO_WRITE_KINDS, 'auto_decisions', 'kind'],
    ['auto_decisions.reason', AUTO_REASONS, 'auto_decisions', 'reason'],
    ['auto_writes.kind', AUTO_WRITE_KINDS, 'auto_writes', 'kind'],
    ['auto_writes.undo_state', AUTO_UNDO_STATES, 'auto_writes', 'undo_state'],
    ['event_revisions.kind', REVISION_KINDS, 'event_revisions', 'kind'],
    ['transcripts.status', TRANSCRIPT_STATUSES, 'transcripts', 'status'],
    ['runs.stage', ['extract', 'draft', 'read_image'], 'runs', 'stage'],
  ] as const)('%s', (_name, tuple, table, column) => {
    expect(sorted(checkList(table, column))).toEqual(sorted(tuple));
  });
  it('chats.auto_policy (ALTER TABLE ... ADD COLUMN in v4) == CHAT_AUTO_POLICIES', () => {
    const v4 = newestSqlWith(/ADD COLUMN auto_policy/);
    const m = v4.match(/ADD COLUMN auto_policy [^;]*CHECK\(auto_policy IN \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    expect(sorted([...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!))).toEqual(sorted(CHAT_AUTO_POLICIES));
  });
  it('ux_auto_policies_live covers exactly AUTO_LIVE_STATES (partial unique index on the constant (1), C2 concerns #2)', () => {
    const v4 = newestSqlWith(/ux_auto_policies_live/);
    const m = v4.match(
      /CREATE UNIQUE INDEX ux_auto_policies_live ON auto_policies\(\(1\)\) WHERE state IN \(([^)]*)\)/,
    );
    expect(m).not.toBeNull();
    expect(sorted([...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!))).toEqual(sorted(AUTO_LIVE_STATES));
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

// =====================================================================================================================
// [V2] C2 19 items 16, 17 and 28 - the halves that need no Wave 1 body (V2-W0-scaffold). The provider-built half of 16 (the factory
// builds a provider whose loop === PROVIDER_LOOP[id]) is V2-W1-06's, the MEDIA_MODEL_MANIFEST half of 17 is V2-W1-07's.
// =====================================================================================================================
describe('C2 19 item 16 - provider tables', () => {
  it('PROVIDER_LOOP covers every ProviderId (turn / agentic / prefetch)', () => {
    expect(sorted(Object.keys(PROVIDER_LOOP))).toEqual(sorted(PROVIDER_IDS));
    expect(PROVIDER_LOOP).toEqual({
      local: 'turn',
      claude_cli: 'agentic',
      antigravity_cli: 'prefetch',
      claude: 'turn',
      gemini: 'turn',
    });
  });
  it('CONSENT_KIND_FOR covers every CloudProviderId; SECRET_FOR keys == API_KEY_PROVIDER_IDS', () => {
    expect(sorted(Object.keys(CONSENT_KIND_FOR))).toEqual(sorted(PROVIDER_IDS.filter((p) => p !== 'local')));
    for (const kind of Object.values(CONSENT_KIND_FOR)) expect(CONSENT_KINDS).toContain(kind);
    expect(sorted(Object.keys(SECRET_FOR))).toEqual(sorted(API_KEY_PROVIDER_IDS));
  });
});

describe('C2 19 item 17 - model file ids', () => {
  it('MODEL_FILE_IDS = LLM tiers + projectors + voice tiers + VAD; modelFileKindOf agrees', () => {
    expect([...MODEL_FILE_IDS]).toEqual([...MODEL_TIERS, ...MMPROJ_IDS, ...VOICE_TIERS, 'voice-vad']);
    for (const t of MODEL_TIERS) expect(modelFileKindOf(t)).toBe('llm');
    for (const m of MMPROJ_IDS) expect(modelFileKindOf(m)).toBe('mmproj');
    for (const v of VOICE_TIERS) expect(modelFileKindOf(v)).toBe('asr');
    expect(modelFileKindOf('voice-vad')).toBe('vad');
  });
  it('DOWNLOAD_TARGETS minus mmproj is a subset of MODEL_FILE_IDS', () => {
    for (const t of DOWNLOAD_TARGETS.filter((x) => x !== 'mmproj')) expect(MODEL_FILE_IDS).toContain(t);
  });
  it('MODEL_MANIFEST keeps its v1 LLM-only shape (F19): keys tiny|small|mid only', () => {
    expect(sorted(Object.keys(MODEL_MANIFEST))).toEqual(sorted(MODEL_TIERS));
  });
});

describe('C2 19 item 28 - CLI version floors', () => {
  it('CLAUDE_MIN_VERSION === 2.1.248 (F14) and the shared table agrees with both provider modules', () => {
    expect(CLAUDE_MIN_VERSION).toBe('2.1.248');
    expect(CLI_MIN_VERSION.claude_cli).toBe(CLAUDE_MIN_VERSION);
    expect(CLI_MIN_VERSION.antigravity_cli).toBe(AGY_MIN_VERSION);
  });
});
