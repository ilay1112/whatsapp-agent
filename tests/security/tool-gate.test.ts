// Security gate item 1 (TESTS 8.2 row 1; invariant I2): default-deny tool allowlist.
//
// Everything under test is the PRODUCTION object: the real `createToolGate`, the real `createMcpReadClient`, the real
// `McpHost.callerFor` capability wrapper and a real `app.db` for the audit rows. The only doubles are the fakes
// (`tests/fakes/fake-mcp-calendar.ts` over an in-memory transport) and the LLM, which is exactly who the attacker is.
//
// Proves, for every hostile tool name a model can emit:
//   - the gate answers the synthetic `{"error":"tool not available"}` string and never reaches MCP;
//   - the audit row carries ONLY `{ nameSha8, nameLen, verdict, runId }` - [R2] the name itself appears in no audit
//     row, no log line and no diagnostics export;
//   - the fake MCP server sees zero non-READ calls;
//   - [R2] a monkey-patched `McpReadClient` that tries to smuggle `create-event` through its injected
//     `callerFor('read')` caller is rejected with `McpCapabilityError` before the fake sees a call;
//   - two strikes abort the run and raise the `manipulation` badge (end-to-end through the harness);
//   - argument smuggling (`calendarId`, `account`, `query`, `privateExtendedProperty`, `fields`) dies on `.strict()`;
//   - the clamps and the per-run budgets hold.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createToolGate, type RunCtx, type ToolGate } from '../../src/main/agent/toolGate.ts';
import { createHandleTable } from '../../src/main/agent/handles.ts';
// [V2] READ_TOOL_NAMES is the six-tool v2 list (C2 10); the gate under test is the v1 gate (Wave-0 remnant) with the two calendar tools.
import {
  V1_READ_TOOL_NAMES as READ_TOOL_NAMES,
  READ_TOOL_NAMES as V2_READ_TOOL_NAMES,
} from '../../src/main/agent/toolDefs.ts';
import { createMcpReadClient, McpCapabilityError, type McpReadClient } from '../../src/main/mcp/readClient.ts';
import { createMcpHost, type McpHostWithChildSpec } from '../../src/main/mcp/host.ts';
import { createRepos, openDb, MEMORY_DB, type Db } from '../../src/main/db/index.ts';
import type { Repos } from '../../src/main/db/index.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings.ts';
import { LIMITS, type EpochMs, type ItemId, type RunId } from '../../src/shared/types.ts';
import type { LlmToolCall } from '../../src/main/llm/types.ts';
import { ALL_REAL_TOOLS, createFakeMcpCalendar, type FakeMcpCalendar } from '../fakes/fake-mcp-calendar.ts';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { createWaToolRig, type WaToolRig } from '../helpers/waWorld.ts';

const NOW_MS = Date.UTC(2026, 8, 21, 6, 0, 0) as EpochMs; // 2026-09-21 09:00 Asia/Jerusalem
const NONCE = 'a1b2c3d4e5f60789';
const NOT_AVAILABLE = '{"error":"tool not available"}';

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  general: { ...DEFAULT_SETTINGS.general, timeZone: 'Asia/Jerusalem' },
  calendar: {
    ...DEFAULT_SETTINGS.calendar,
    targetCalendarId: 'work@example.com',
    conflictCalendarIds: ['primary', 'work@example.com'],
  },
};

const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

function ctx(over: Partial<RunCtx> = {}): RunCtx {
  return {
    runId: 7 as RunId,
    itemId: 42 as ItemId,
    chatId: 1 as RunCtx['chatId'],
    nowMs: NOW_MS,
    timeZone: 'Asia/Jerusalem',
    nonce: NONCE,
    calls: {},
    totalCalls: 0,
    blockedCalls: 0,
    signal: new AbortController().signal,
    // [V2] C2 10 RunCtx additions (a Wave 0 stub handle table; the v1 gate never reads them)
    handles: createHandleTable(1 as RunCtx['chatId']),
    waRowsServed: 0,
    crossChatRows: 0,
    otherChatTexts: [],
    ...over,
  };
}
const call = (name: string, input: Record<string, unknown> = {}): LlmToolCall => ({ id: 'tc_1', name, input });

// ---------------------------------------------------------------------------------------------------------------------
// The hostile name table. Every string here is attacker-controlled DATA (TESTS T6) - it is fed to the app, never obeyed.
// ---------------------------------------------------------------------------------------------------------------------

/** All 13 real MCP tool names in dash form, and the same names with `-` -> `_` (the LLM-facing spelling). */
const REAL_NAMES_BOTH_FORMS: readonly string[] = [
  ...ALL_REAL_TOOLS,
  ...ALL_REAL_TOOLS.map((n) => n.replace(/-/g, '_')),
];
/** The three WRITE/ADMIN classes by name - the ones an injection actually wants. */
const WRITE_AND_ADMIN: readonly string[] = [
  'create-event',
  'create_event',
  'create-events',
  'update-event',
  'update_event',
  'delete-event',
  'delete_event',
  'respond-to-event',
  'manage-accounts',
  'manage_accounts',
  'list-calendars',
  'list_calendars',
];
const CASE_VARIANTS: readonly string[] = ['GET_FREEBUSY', 'Get_Freebusy', 'gEt_fReEbUsY', 'GET_CURRENT_TIME'];
const WHITESPACE_VARIANTS: readonly string[] = [
  ' get_freebusy',
  'get_freebusy ',
  '\tget_freebusy',
  'get_freebusy\n',
  '\u00a0get_freebusy',
];
/** Cyrillic `е`/`о`/`с`/`а`, Greek `ο`, and a zero-width joiner inside an otherwise legal name. */
const HOMOGLYPHS: readonly string[] = [
  'gеt_freebusy', // Cyrillic e
  'get_freebusу', // Cyrillic u
  'gοt_current_time', // Greek omicron
  'get_free\u200dbusy', // ZWJ
  'get_freebusy\u200b', // ZWSP
];
const LONG_NAME = 'x'.repeat(300);
const UNKNOWN_NAMES: readonly string[] = ['', 'send_message', 'shell', '../../etc/passwd', '__proto__', LONG_NAME];

/** The full block list: everything the gate must refuse, minus the two names it is allowed to run. */
const BLOCKED_NAMES: readonly string[] = [
  ...new Set([
    ...REAL_NAMES_BOTH_FORMS,
    ...WRITE_AND_ADMIN,
    ...CASE_VARIANTS,
    ...WHITESPACE_VARIANTS,
    ...HOMOGLYPHS,
    ...UNKNOWN_NAMES,
  ]),
].filter((n) => !(READ_TOOL_NAMES as readonly string[]).includes(n));

// ---------------------------------------------------------------------------------------------------------------------
// Rig: real gate -> real read client -> real host caller -> fake MCP server, audit into a real app.db.
// ---------------------------------------------------------------------------------------------------------------------

interface Rig {
  gate: ToolGate;
  read: McpReadClient;
  host: McpHostWithChildSpec;
  calendar: FakeMcpCalendar;
  repos: Repos;
  db: Db;
  logs: string[];
  dispose(): Promise<void>;
}

async function rig(opts: { connected?: boolean } = {}): Promise<Rig> {
  const calendar = createFakeMcpCalendar({
    now: () => NOW_MS,
    timeZone: 'Asia/Jerusalem',
    accounts: 'personal_ok',
    pinned: { calendarIds: [...SETTINGS.calendar.conflictCalendarIds], timeZone: 'Asia/Jerusalem' },
  });
  const transport = calendar.clientTransport();
  await calendar.connect();

  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const logs: string[] = [];
  const record =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void => {
      logs.push(`${level} ${msg} ${fields === undefined ? '' : JSON.stringify(fields)}`);
    };

  const host = createMcpHost({
    execPath: process.execPath,
    mcpRoot: 'C:/nonexistent/calendar-mcp',
    credentialsPath: 'C:/nonexistent/credentials.json',
    tokenPath: 'C:/nonexistent/tokens.json',
    onStderrMarker: () => undefined,
    transportFactory: () => transport,
    clock: { now: () => NOW_MS },
    audit: (kind, ref, detail, at) => repos.audit.append(kind, ref, detail, at),
    log: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    } as unknown as Parameters<typeof createMcpHost>[0]['log'],
  });
  await host.start();

  const read = createMcpReadClient(host.callerFor('read'));
  const connected = opts.connected ?? true;
  const gate = createToolGate({
    read,
    settings: () => SETTINGS,
    calendarConnected: () => connected,
    audit: (kind, ref, detail) => repos.audit.append(kind, ref, detail, NOW_MS),
    wa: { recentChats: () => [], chatMessages: () => [], search: () => [], context: () => null }, // [V2] C2 10
    waAvailable: () => false, // [V2]
  });

  return {
    gate,
    read,
    host,
    calendar,
    repos,
    db,
    logs,
    async dispose() {
      await host.stop();
      await calendar.stop();
      db.close();
    },
  };
}

/**
 * Calls the fake MCP server saw that are not READ tools. `manage-accounts {action:'list'}` is excluded: it is the
 * host's OWN sign-in probe from `start()` (ARCH 5.1), issued by `compose`/`host`, never by a model.
 */
function nonReadCalls(calendar: FakeMcpCalendar): Array<{ tool: string; args: Record<string, unknown> }> {
  return calendar.calls.filter(
    (c) =>
      c.tool !== 'get-current-time' &&
      c.tool !== 'get-freebusy' &&
      !(c.tool === 'manage-accounts' && c.args.action === 'list'),
  );
}

/** Every `tool_blocked` audit row, newest last. */
function blockedRows(db: Db): Array<{ kind: string; ref: string | null; detail_json: string }> {
  return db
    .prepare<{
      kind: string;
      ref: string | null;
      detail_json: string;
    }>(`SELECT kind, ref, detail_json FROM audit_log WHERE kind='tool_blocked' ORDER BY id`)
    .all();
}
function allAuditText(db: Db): string {
  return db
    .prepare<{ kind: string; ref: string | null; detail_json: string | null }>(
      `SELECT kind, ref, detail_json FROM audit_log ORDER BY id`,
    )
    .all()
    .map((r) => `${r.kind} ${r.ref ?? ''} ${r.detail_json ?? ''}`)
    .join('\n');
}

let r: Rig | null = null;
afterEach(async () => {
  await r?.dispose();
  r = null;
});

// ---------------------------------------------------------------------------------------------------------------------

describe('I2 - default-deny name table', () => {
  beforeEach(async () => {
    r = await rig();
  });

  it(`blocks all ${BLOCKED_NAMES.length} hostile names with the synthetic error and zero MCP traffic`, async () => {
    const rr = r!;
    const before = rr.calendar.calls.length;
    for (const name of BLOCKED_NAMES) {
      const out = await rr.gate.invoke(
        call(name, { timeMin: '2026-09-21T10:00:00', timeMax: '2026-09-21T18:00:00' }),
        ctx(),
      );
      expect(out.verdict, `name ${sha8(name)} len ${name.length}`).toBe('blocked_unknown_tool');
      expect(out.result.isError).toBe(true);
      expect(out.result.content).toBe(NOT_AVAILABLE);
      // The gate echoes back the call id and name it was handed (the LLM plumbing needs the pairing), but nothing else.
      expect(out.result.content).not.toContain('busy');
    }
    // No hostile name ever produced an MCP request.
    expect(rr.calendar.calls.length).toBe(before);
    expect(nonReadCalls(rr.calendar)).toEqual([]);
  });

  it('every non-READ call the fake ever saw is zero - only READ tools reach the server', async () => {
    const rr = r!;
    for (const name of BLOCKED_NAMES) await rr.gate.invoke(call(name), ctx());
    await rr.gate.invoke(call('get_current_time'), ctx());
    await rr.gate.invoke(
      call('get_freebusy', { timeMin: '2026-09-21T10:00:00', timeMax: '2026-09-21T18:00:00' }),
      ctx(),
    );
    expect(nonReadCalls(rr.calendar)).toEqual([]);
    expect(rr.calendar.violations).toEqual([]);
  });

  it('a blocked call audits exactly { nameSha8, nameLen, verdict, runId } and nothing else', async () => {
    const rr = r!;
    await rr.gate.invoke(call('delete-event'), ctx({ runId: 11 as RunId, itemId: 99 as ItemId }));
    const rows = blockedRows(rr.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe('99');
    const detail = JSON.parse(rows[0]!.detail_json) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
    expect(detail).toEqual({
      nameSha8: sha8('delete-event'),
      nameLen: 'delete-event'.length,
      verdict: 'blocked_unknown_tool',
      runId: 11,
    });
  });

  it('[R2] the 300-char name and every homoglyph name appear in no audit row and no log line', async () => {
    const rr = r!;
    const secrets = [LONG_NAME, ...HOMOGLYPHS];
    for (const name of secrets) await rr.gate.invoke(call(name), ctx());
    const audit = allAuditText(rr.db);
    const logText = rr.logs.join('\n');
    for (const name of secrets) {
      expect(audit, `audit leaks ${sha8(name)}`).not.toContain(name);
      expect(logText, `log leaks ${sha8(name)}`).not.toContain(name);
      // The hash is what IS recorded, so the row must exist at all (a silent drop would pass the grep for free).
      expect(audit).toContain(sha8(name));
    }
    // The 300-char name must not even leak its length-300 shape as a substring of some other field.
    expect(audit).not.toContain('x'.repeat(40));
  });

  it('blocks every READ name too when the calendar is not connected, and exposes no tools at all', async () => {
    await r!.dispose();
    r = await rig({ connected: false });
    expect(r.gate.exposedTools()).toEqual([]);
    for (const name of READ_TOOL_NAMES) {
      const out = await r.gate.invoke(
        call(name, { timeMin: '2026-09-21T10:00:00', timeMax: '2026-09-21T12:00:00' }),
        ctx(),
      );
      expect(out.verdict).toBe('blocked_not_exposed');
      expect(out.result.content).toBe(NOT_AVAILABLE);
    }
    expect(r.calendar.calls.filter((c) => c.tool !== 'manage-accounts')).toEqual([]);
  });

  it('exposes exactly the two READ definitions when connected', () => {
    expect(r!.gate.exposedTools().map((t) => t.name)).toEqual([...READ_TOOL_NAMES]);
  });
});

describe('I2 - capability narrowing below the gate', () => {
  beforeEach(async () => {
    r = await rig();
  });

  it('[R2] a monkey-patched read client that calls create-event through callerFor("read") throws McpCapabilityError before the fake sees it', async () => {
    const rr = r!;
    const readCaller = rr.host.callerFor('read');
    const before = rr.calendar.calls.length;

    // This is the attack: a bug (or a cast) inside readClient.ts reaching for a WRITE tool with the READ caller it holds.
    const smuggle = readCaller as unknown as (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean }>;
    await expect(smuggle('create-event', { calendarId: 'primary', summary: 'x' })).rejects.toBeInstanceOf(
      McpCapabilityError,
    );
    for (const tool of ['create-event', 'update-event', 'delete-event', 'manage-accounts', 'list-calendars']) {
      await expect(smuggle(tool, {})).rejects.toThrow(/mcp_capability/);
    }
    expect(rr.calendar.calls.length).toBe(before);
    expect(rr.calendar.violations).toEqual([]);

    // ... and the refusal is audited with the hash-only detail shape, runId 0 (no run owns it).
    const rows = blockedRows(rr.db);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const detail = JSON.parse(rows[0]!.detail_json) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
    expect(detail.verdict).toBe('blocked_not_exposed');
    expect(detail.runId).toBe(0);
  });

  it('the READ facade has no write method and no caller property to borrow', () => {
    const surface = new Set<string>();
    for (let o: object | null = r!.read; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o) as object) {
      for (const k of Object.getOwnPropertyNames(o)) surface.add(k);
    }
    // [V2] + getEvent (C2 11: owned-event read, still no write method)
    expect([...surface].sort()).toEqual(['findAppEvent', 'getCurrentTime', 'getEvent', 'getFreeBusy']);
    for (const forbidden of ['createEvent', 'call', 'caller', 'client', 'write']) {
      expect(surface.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe('I2 - argument smuggling and clamps', () => {
  beforeEach(async () => {
    r = await rig();
  });

  const SMUGGLED: ReadonlyArray<[string, unknown]> = [
    ['calendarId', 'attacker@example.com'],
    ['account', 'other'],
    ['query', 'password'],
    ['privateExtendedProperty', 'waAction=1'],
    ['fields', '*'],
    ['attendees', [{ email: 'attacker@example.com' }]],
    ['timeZone', 'UTC'],
  ];

  it('.strict() rejects every extra key on get_freebusy, with no MCP call', async () => {
    const rr = r!;
    for (const [key, value] of SMUGGLED) {
      const before = rr.calendar.calls.length;
      const out = await rr.gate.invoke(
        call('get_freebusy', { timeMin: '2026-09-21T10:00:00', timeMax: '2026-09-21T12:00:00', [key]: value }),
        ctx(),
      );
      expect(out.verdict, key).toBe('blocked_bad_args');
      expect(out.result.content).toBe(NOT_AVAILABLE);
      expect(rr.calendar.calls.length, key).toBe(before);
    }
  });

  it('get_current_time takes no arguments at all', async () => {
    const rr = r!;
    const out = await rr.gate.invoke(call('get_current_time', { account: 'other' }), ctx());
    expect(out.verdict).toBe('blocked_bad_args');
    expect(rr.calendar.calls.filter((c) => c.tool === 'get-current-time')).toEqual([]);
  });

  it('a bad-args block scores no manipulation strike (only an unknown name does)', async () => {
    const rr = r!;
    const c = ctx();
    await rr.gate.invoke(call('get_freebusy', { timeMin: 'nonsense', timeMax: 'nonsense' }), c);
    await rr.gate.invoke(call('get_freebusy', { timeMin: 'nonsense', timeMax: 'nonsense' }), c);
    expect(c.blockedCalls).toBe(0);
    const c2 = ctx();
    await rr.gate.invoke(call('delete-event'), c2);
    expect(c2.blockedCalls).toBe(1);
  });

  it('the window the server receives is app-pinned and clamped, whatever the model asked for', async () => {
    const rr = r!;
    // Attacker asks for the whole of 2020 through 2030 on someone else's calendar.
    const out = await rr.gate.invoke(
      call('get_freebusy', { timeMin: '2020-01-01T00:00:00', timeMax: '2030-01-01T00:00:00' }),
      ctx(),
    );
    expect(out.verdict).toBe('executed');
    const fb = rr.calendar.calls.filter((c) => c.tool === 'get-freebusy');
    expect(fb).toHaveLength(1);
    const args = fb[0]!.args as Record<string, unknown>;
    expect(args.timeZone).toBe('Asia/Jerusalem');
    expect(args.account).toBe('personal');
    const ids = JSON.stringify(args.calendars ?? args.calendarId ?? args.calendarIds);
    expect(ids).toContain('primary');
    expect(ids).not.toContain('attacker');
    // timeMin >= now, and the window is at most 14 days.
    const min = String(args.timeMin);
    const max = String(args.timeMax);
    expect(min.slice(0, 10) >= '2026-09-21').toBe(true);
    const spanDays = (Date.parse(`${max.slice(0, 19)}Z`) - Date.parse(`${min.slice(0, 19)}Z`)) / 86_400_000;
    expect(spanDays).toBeGreaterThan(0);
    expect(spanDays).toBeLessThanOrEqual(LIMITS.toolWindowDays);
    expect(rr.calendar.violations).toEqual([]);
  });

  it('the result the model sees is projected and wrapped in the run nonce, never raw server text', async () => {
    const rr = r!;
    rr.calendar.setBusy([{ start: '2026-09-21T14:00:00', end: '2026-09-21T15:00:00' }]);
    const out = await rr.gate.invoke(
      call('get_freebusy', { timeMin: '2026-09-21T10:00:00', timeMax: '2026-09-21T18:00:00' }),
      ctx(),
    );
    expect(out.verdict).toBe('executed');
    expect(out.result.content.startsWith(`<<DATA-${NONCE}>>`)).toBe(true);
    expect(out.result.content.trimEnd().endsWith(`<<END-DATA-${NONCE}>>`)).toBe(true);
    const body = out.result.content.slice(`<<DATA-${NONCE}>>`.length).replace(`<<END-DATA-${NONCE}>>`, '').trim();
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    for (const b of parsed) expect(Object.keys(b).sort()).toEqual(['end', 'start']);
  });
});

describe('I2 - budgets and the two-strike abort', () => {
  beforeEach(async () => {
    r = await rig();
  });

  it('per-tool and per-run budgets are enforced without a strike', async () => {
    const rr = r!;
    const c = ctx();
    const args = { timeMin: '2026-09-21T10:00:00', timeMax: '2026-09-21T12:00:00' };
    for (let i = 0; i < 3; i++) expect((await rr.gate.invoke(call('get_freebusy', args), c)).verdict).toBe('executed');
    const fourth = await rr.gate.invoke(call('get_freebusy', args), c);
    expect(fourth.verdict).toBe('blocked_budget');
    expect(fourth.abortRun).toBe(false);
    expect(c.blockedCalls).toBe(0);
    expect(rr.calendar.calls.filter((x) => x.tool === 'get-freebusy')).toHaveLength(3);
  });

  it(`${LIMITS.blockedCallsAbort} unknown-name strikes set abortRun`, async () => {
    const rr = r!;
    const c = ctx();
    const first = await rr.gate.invoke(call('create-event'), c);
    expect(first.abortRun).toBe(false);
    const second = await rr.gate.invoke(call('delete-event'), c);
    expect(second.abortRun).toBe(true);
    expect(c.blockedCalls).toBe(LIMITS.blockedCallsAbort);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// End to end: the two-strike abort through the REAL pipeline raises the `manipulation` badge on the item.
// ---------------------------------------------------------------------------------------------------------------------

describe('I2 - two strikes abort the run and badge the item (end to end)', () => {
  const CHAT = '972550000011@s.whatsapp.net';
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.dispose();
    h = null;
  });

  it('a drafting model that calls create-event twice gets nothing and the card is badged `manipulation`', async () => {
    const rules: StubRule[] = [
      {
        when: { purpose: 'extract' },
        respond: {
          structured: extraction({
            intent: 'schedule_request',
            needsReply: true,
            title: 'coffee',
            dateKind: 'weekday',
            weekday: 4,
            time24h: '17:00',
            durationMin: 60,
          }),
        },
      },
      {
        when: { purpose: 'draft', turn: 0 },
        respond: {
          toolCalls: [{ name: 'create-event', input: { calendarId: 'primary', summary: 'pwned' } }],
          stopReason: 'tool_use',
        },
      },
      {
        when: { purpose: 'draft', turn: 1 },
        respond: {
          toolCalls: [{ name: 'delete-event', input: { eventId: '*' } }],
          stopReason: 'tool_use',
        },
      },
      { when: { purpose: 'draft' }, respond: { text: 'Sure.', stopReason: 'end' } },
    ];
    h = await createHarness({ rules });
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hi', ts: new Date(h.clock.now() - 3_600_000) });
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const cards = [...dash.value.needsReply, ...dash.value.infoMissing];
    expect(cards.length).toBeGreaterThan(0);
    const badges = cards.flatMap((c) => c.badges ?? []);
    expect(badges).toContain('manipulation');

    // Nothing was sent, nothing was written to the calendar, and no non-READ tool reached the server.
    expect(h.bridge.sent).toEqual([]);
    expect(h.calendar.calls.filter((c) => c.tool === 'create-event' || c.tool === 'delete-event')).toEqual([]);

    // Two `tool_blocked` rows, hash-only.
    const rows = blockedRows(h.repos.db);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const text = allAuditText(h.repos.db);
    expect(text).not.toContain('create-event');
    expect(text).not.toContain('delete-event');
    expect(text).toContain(sha8('create-event'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] (owner V2-W2-02) T2 8.2 group 1 extensions over the v2 gate: the v2 calendar names (`update-event`, `get-event`,
// `delete-event`, dash AND underscore, every casing / whitespace / homoglyph / FQN variant) and the `wa_*` variants. The rig is
// the REAL v2 gate -> real McpReadClient -> real McpHost caller -> fake calendar, and -> real WaReadClient -> real read-only
// BridgeDb (tests/helpers/waWorld.ts). Every name below is attacker DATA (T6).
// ---------------------------------------------------------------------------------------------------------------------

/** The v2 calendar write / owned-event names the model must never reach (C2 10 BLOCKED_NAMES + their variants). */
const V2_CALENDAR_NAMES: readonly string[] = [
  'update-event',
  'update_event',
  'get-event',
  'get_event',
  'delete-event',
  'delete_event',
  'UPDATE-EVENT',
  'Update_Event',
  'GET_EVENT',
  'gEt-EvEnT',
  'DELETE_EVENT',
  'Delete-Event',
  ' update_event',
  'update_event ',
  'get_event\n',
  '\tdelete-event',
  'updаte_event', // Cyrillic a
  'gеt_event', // Cyrillic e
  'delete​_event', // ZWSP
  'delete_events',
  'update-events',
  'patch_event',
  'cancel_event',
  'mcp__wca__update_event',
  'mcp__wca__delete-event',
  'mcp__calendar__update-event',
  'mcp__google-calendar__delete-event',
];
/** `wa_*` look-alikes: casing, whitespace, homoglyphs, dash spelling, FQNs and invented write verbs. */
const WA_VARIANTS: readonly string[] = [
  'WA_GET_CHAT_MESSAGES',
  'Wa_Search_Messages',
  'wa_get_message_context ',
  ' wa_list_chats',
  'wa_get_chat_messages​',
  'wa_sеarch_messages', // Cyrillic e
  'wa-get-chat-messages',
  'wa-search-messages',
  'mcp__wca__wa_get_chat_messages',
  'mcp__wca__wa_list_chats',
  'mcp__whatsapp__send_message',
  'wa_send_message',
  'wa_send_reply',
  'wa_get_media',
  'wa_download_media',
  'wa_mark_read',
  'wa_list_contacts',
];

describe('[V2] group 1 - update-event / get-event / delete-event and wa_* variants on the v2 gate', () => {
  let w: WaToolRig | null = null;
  afterEach(async () => {
    await w?.dispose();
    w = null;
  });

  it('every v2 calendar name and variant: blocked_unknown_tool + strike, zero calendar / WhatsApp calls, sha8-only audit', async () => {
    w = await createWaToolRig({ scope: 'all_chats' });
    const names = [...new Set([...V2_CALENDAR_NAMES, ...WA_VARIANTS])];
    for (const n of names) expect((V2_READ_TOOL_NAMES as readonly string[]).includes(n), n).toBe(false);
    const before = w.calendar.calls.length;
    for (const name of names) {
      const c = w.ctx();
      const out = await w.gate.invoke(
        call(name, {
          eventId: 'evt_1',
          calendarId: 'primary',
          summary: 'x',
          start: '2026-09-22T10:00:00',
          chat: 'chat_1',
          query: 'x',
          message: 'm_1',
        }),
        c,
      );
      expect(out.verdict, `name ${sha8(name)} len ${name.length}`).toBe('blocked_unknown_tool');
      expect(out.result.isError).toBe(true);
      expect(out.result.content).toBe(NOT_AVAILABLE);
      expect(c.blockedCalls, `strike for ${sha8(name)}`).toBe(1);
      expect(c.totalCalls).toBe(0);
    }
    // zero MCP traffic of any kind (not even a read), zero WhatsApp facade calls
    expect(w.calendar.calls.length).toBe(before);
    expect(w.calendar.violations).toEqual([]);
    expect(w.waCalls).toEqual([]);
    // the audit: one hash-only row per name, the name itself nowhere (audit or log)
    const audit = w.blockedAudit();
    expect(audit).toHaveLength(names.length);
    for (const d of audit) expect(Object.keys(d).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
    const auditText = JSON.stringify(audit);
    const logText = w.logs.join('\n');
    for (const name of names) {
      expect(auditText).toContain(sha8(name));
      expect(auditText, sha8(name)).not.toContain(JSON.stringify(name.trim()).slice(1, -1));
      expect(logText, sha8(name)).not.toContain(name.trim());
    }
  });

  it('two v2 strikes (update_event then delete-event) abort the run', async () => {
    w = await createWaToolRig();
    const c = w.ctx();
    expect((await w.gate.invoke(call('update_event', { eventId: 'e' }), c)).abortRun).toBe(false);
    const second = await w.gate.invoke(call('delete-event', { eventId: 'e' }), c);
    expect(second.abortRun).toBe(true);
    expect(c.blockedCalls).toBe(LIMITS.blockedCallsAbort);
  });

  it('wa_list_chats in trigger_chat scope is not exposed: blocked_not_exposed WITH a strike, zero WhatsApp calls', async () => {
    w = await createWaToolRig({ scope: 'trigger_chat' });
    const c = w.ctx();
    const out = await w.gate.invoke(call('wa_list_chats', {}), c);
    expect(out.verdict).toBe('blocked_not_exposed');
    expect(out.result.content).toBe(NOT_AVAILABLE);
    expect(c.blockedCalls).toBe(1);
    expect(w.waCalls).toEqual([]);
  });

  it('the v2 READ table: exactly six names, none a write / owned-event / reference-server name; exposure per scope', async () => {
    expect([...V2_READ_TOOL_NAMES].sort()).toEqual(
      [
        'get_current_time',
        'get_freebusy',
        'wa_get_chat_messages',
        'wa_get_message_context',
        'wa_list_chats',
        'wa_search_messages',
      ].sort(),
    );
    w = await createWaToolRig({ scope: 'all_chats' });
    expect(
      w.gate
        .exposedTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual([...V2_READ_TOOL_NAMES].sort());
    await w.dispose();
    w = await createWaToolRig({ scope: 'trigger_chat' });
    expect(w.gate.exposedTools().map((t) => t.name)).not.toContain('wa_list_chats');
    expect(w.gate.exposedTools()).toHaveLength(5);
    await w.dispose();
    w = await createWaToolRig({ calendarConnected: false, waAvailable: false });
    expect(w.gate.exposedTools()).toEqual([]);
  });

  it('exercising every exposed READ tool reaches only get-current-time / get-freebusy - never get-event or list-events', async () => {
    w = await createWaToolRig({ scope: 'all_chats' });
    const c = w.ctx();
    const args: Record<string, Record<string, unknown>> = {
      get_current_time: {},
      get_freebusy: { timeMin: '2026-09-22T10:00:00', timeMax: '2026-09-22T18:00:00' },
      wa_get_chat_messages: { chat: 'chat_1' },
      wa_search_messages: { query: 'address' },
      wa_get_message_context: { message: 'm_1' },
      wa_list_chats: {},
    };
    const before = w.calendar.calls.length;
    const verdicts: string[] = [];
    for (const t of w.gate.exposedTools())
      verdicts.push((await w.gate.invoke(call(t.name, args[t.name] ?? {}), c)).verdict);
    expect(c.blockedCalls).toBe(0);
    expect(verdicts.filter((v) => v === 'executed').length).toBeGreaterThanOrEqual(4);
    const tools = new Set(w.calendar.calls.slice(before).map((x) => x.tool));
    for (const t of tools) expect(['get-current-time', 'get-freebusy']).toContain(t);
    expect(tools.has('get-freebusy')).toBe(true);
    expect(w.nonReadCalendarCalls()).toEqual([]);
    expect(w.calendar.violations).toEqual([]);
  });
});
