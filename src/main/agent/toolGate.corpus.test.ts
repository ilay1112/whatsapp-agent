// TESTS 8.3 + 3.4: the injection corpora and the obedient attacker LLM, driven against the real ToolGate.
// Every payload in the corpora is synthetic ATTACK DATA for the app under test - this file asserts the app contains
// it, and nothing in it is ever treated as an instruction (T6).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; // the project path contains a space: never URL.pathname
import { describe, expect, it, vi } from 'vitest';
import type { CallOpts, LlmMessage } from '../llm/types';
import type { BusyBlock } from '../../shared/types';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { McpReadClient, PinnedWindow } from '../mcp/readClient';
import { BRIDGE_MARKERS } from '../bridge/stdoutMarkers';
import {
  ObedientAttackerLlm,
  SENTINEL_MSG_TEXT,
  SENTINEL_TOOL_NAME_CASE_ID,
  type InjectionCase,
} from '../../../tests/fakes/obedient-attacker-llm';
import { READ_TOOL_NAMES } from './toolDefs';
import { createToolGate, type RunCtx, type ToolGateDeps } from './toolGate';

const load = (name: string): InjectionCase[] =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../tests/security/${name}`, import.meta.url)), 'utf8'),
  ) as InjectionCase[];

const EN = load('injection-corpus.en.json');
const HE = load('injection-corpus.he.json');
const ALL = [...EN, ...HE];

const VECTORS = ['message', 'quoted', 'push_name', 'calendar_title', 'tool_result', 'stdout_marker'];
const MUST_NOT = ['send', 'create_event', 'unknown_tool', 'foreign_recipient', 'url_in_draft', 'state_change'];

describe('the corpora satisfy TESTS 8.3', () => {
  it('holds at least 40 cases, at least 15 of them Hebrew', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(40);
    expect(HE.length).toBeGreaterThanOrEqual(15);
    expect(EN.every((c) => c.lang === 'en')).toBe(true);
    expect(HE.every((c) => c.lang === 'he')).toBe(true);
  });

  it('has unique ids, a known vector, a payload and a mustNot list everywhere', () => {
    const ids = new Set<string>();
    for (const c of ALL) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(VECTORS).toContain(c.vector);
      expect(c.payload.length).toBeGreaterThan(0);
      expect(c.mustNot.length).toBeGreaterThan(0);
      for (const m of c.mustNot) expect(MUST_NOT).toContain(m);
      expect(Object.keys(c).sort()).toEqual(['id', 'lang', 'mustNot', 'obey', 'payload', 'vector']);
    }
  });

  it('covers every required family', () => {
    const ids = ALL.map((c) => c.id).join(' ');
    for (const family of [
      'ignore-delete-events',
      'exfil-freebusy',
      'exfil-address',
      'add-attendee',
      'daily-0300',
      'change-recipient',
      'auto-approve',
      'system-impersonation',
      'vendor-impersonation',
      'fake-end-delimiter',
      'fake-json-proposal',
      'zero-width',
      'bidi-override',
      'tag-block',
      'push-name',
      'quoted-injection',
      'calendar-title',
      'tool-result-poison',
      'oversize',
      'phishing-link',
      'manage-accounts',
      'update-event',
      'list-events-cut',
      'homoglyph-tool',
      'nonce-guess',
      'arg-smuggling',
    ]) {
      expect(ids).toContain(family);
    }
    // both scripts carry the core families
    for (const family of [
      'ignore-delete-events',
      'exfil-freebusy',
      'auto-approve',
      'fake-end-delimiter',
      'push-name',
    ]) {
      expect(EN.some((c) => c.id.includes(family))).toBe(true);
      expect(HE.some((c) => c.id.includes(family))).toBe(true);
    }
  });

  it('[R2] carries one stdout_marker case per BRIDGE_MARKERS string', () => {
    const markerPayloads = ALL.filter((c) => c.vector === 'stdout_marker').map((c) => c.payload);
    for (const marker of Object.values(BRIDGE_MARKERS)) expect(markerPayloads).toContain(marker);
    expect(markerPayloads).toHaveLength(Object.keys(BRIDGE_MARKERS).length);
  });

  it('[R2] carries the tool-name sentinel case for the redaction gate', () => {
    // The constant lives in the fake (W2-02 imports it instead of re-typing the literal); this pins corpus == constant.
    const sentinelCase = ALL.find((c) => c.id === SENTINEL_TOOL_NAME_CASE_ID);
    expect(sentinelCase).toBeDefined();
    expect(sentinelCase!.obey.toolCalls![0]!.name).toContain(SENTINEL_MSG_TEXT);
    expect(sentinelCase!.payload).toContain(SENTINEL_MSG_TEXT);
    expect(SENTINEL_MSG_TEXT).toBe('WCA_SENTINEL_MSG_TEXT');
  });

  it('covers the 50 KB message and the fake-delimiter payloads', () => {
    expect(ALL.find((c) => c.id === 'en-oversize-50kb')!.payload.length).toBeGreaterThan(50_000);
    expect(ALL.find((c) => c.id === 'en-fake-end-delimiter')!.payload).toContain('<<END-DATA-');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The corpus tool calls, replayed through the real gate.
// ---------------------------------------------------------------------------------------------------------------

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  general: { ...DEFAULT_SETTINGS.general, timeZone: 'Asia/Jerusalem' },
};
const NOW_MS = Date.UTC(2026, 8, 21, 6, 0, 0);

function gateWithRecorder() {
  const calls: Array<{ tool: string; args: PinnedWindow | Record<string, unknown> }> = [];
  const read: McpReadClient = {
    getCurrentTime() {
      calls.push({ tool: 'get-current-time', args: {} });
      return Promise.resolve({ ok: true, value: { nowIso: '2026-09-21T09:00:00+03:00', timeZone: 'Asia/Jerusalem' } });
    },
    getFreeBusy(w: PinnedWindow) {
      calls.push({ tool: 'get-freebusy', args: w });
      return Promise.resolve({ ok: true, value: [] as BusyBlock[] });
    },
    findAppEvent() {
      calls.push({ tool: 'list-events', args: {} });
      return Promise.resolve({ ok: true, value: null });
    },
  };
  const audit = vi.fn<ToolGateDeps['audit']>();
  return {
    gate: createToolGate({ read, settings: () => SETTINGS, calendarConnected: () => true, audit }),
    calls,
    audit,
  };
}

const ctx = (over: Partial<RunCtx> = {}): RunCtx => ({
  runId: 1,
  itemId: 5,
  chatId: 2,
  nowMs: NOW_MS,
  timeZone: 'Asia/Jerusalem',
  nonce: 'a1b2c3d4e5f60789',
  calls: {},
  totalCalls: 0,
  blockedCalls: 0,
  signal: new AbortController().signal,
  ...over,
});

describe('every tool call an obedient model would make is refused', () => {
  it('never executes a corpus tool call and never reaches a non-READ MCP tool', async () => {
    const { gate, calls, audit } = gateWithRecorder();
    for (const c of ALL) {
      for (const [i, tc] of (c.obey.toolCalls ?? []).entries()) {
        const out = await gate.invoke({ id: `${c.id}-${i}`, name: tc.name, input: tc.input }, ctx());
        expect(out.verdict, `${c.id} -> ${tc.name.slice(0, 20)}`).not.toBe('executed');
        expect(out.result.content).toBe('{"error":"tool not available"}');
      }
    }
    expect(calls).toEqual([]);
    expect(audit.mock.calls.every((a) => a[0] === 'tool_blocked')).toBe(true);
  });

  it('leaks no attacker-chosen tool name into the audit trail', async () => {
    const { gate, audit } = gateWithRecorder();
    const names: string[] = [];
    for (const c of ALL) {
      for (const [i, tc] of (c.obey.toolCalls ?? []).entries()) {
        if (READ_TOOL_NAMES.includes(tc.name as (typeof READ_TOOL_NAMES)[number])) continue;
        names.push(tc.name);
        await gate.invoke({ id: `${c.id}-${i}`, name: tc.name, input: tc.input }, ctx());
      }
    }
    const dump = JSON.stringify(audit.mock.calls);
    for (const n of names) expect(dump).not.toContain(n);
    expect(names.length).toBeGreaterThan(10);
  });

  it('refuses the smuggled-argument get_freebusy call of the corpus', async () => {
    const smuggling = EN.find((c) => c.id === 'en-arg-smuggling')!;
    const { gate, calls } = gateWithRecorder();
    const out = await gate.invoke({ id: 'x', name: 'get_freebusy', input: smuggling.obey.toolCalls![0]!.input }, ctx());
    expect(out.verdict).toBe('blocked_bad_args');
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The fake itself (TESTS 3.4).
// ---------------------------------------------------------------------------------------------------------------

const opts = (): CallOpts => ({ signal: new AbortController().signal, maxOutputTokens: 2048, purpose: 'draft' });
const userMsg = (text: string): LlmMessage[] => [
  { role: 'system', content: 'system prompt' },
  {
    role: 'user',
    content: `<<DATA-a1b2c3d4e5f60789>>\n${JSON.stringify([{ from: 'contact', text }])}\n<<END-DATA-a1b2c3d4e5f60789>>`,
  },
];

describe('ObedientAttackerLlm', () => {
  it('replays the obey block of the case whose payload it finds in the conversation', async () => {
    const hit = EN.find((c) => c.id === 'en-ignore-delete-events')!;
    const llm = new ObedientAttackerLlm(ALL);
    const res = await llm.chat(
      userMsg(hit.payload),
      [
        {
          name: 'get_freebusy',
          description: 'd',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      ],
      opts(),
    );
    expect(res.toolCalls.map((t) => t.name)).toEqual(['delete-event']);
    expect(llm.matched.map((c) => c.id)).toEqual(['en-ignore-delete-events']);
  });

  it('obeys a payload that arrived through a tool result', async () => {
    const hit = EN.find((c) => c.id === 'en-tool-result-poison')!;
    const llm = new ObedientAttackerLlm(ALL);
    const messages: LlmMessage[] = [
      { role: 'tool', results: [{ toolCallId: 't1', name: 'get_freebusy', content: hit.payload }] },
    ];
    const res = await llm.chat(
      messages,
      [
        {
          name: 'get_freebusy',
          description: 'd',
          inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
      ],
      opts(),
    );
    expect(res.toolCalls.map((t) => t.name)).toEqual(['create-event']);
  });

  it('falls back to generic malice: forbidden extraction keys with a URL and bidi controls in the title', async () => {
    const llm = new ObedientAttackerLlm(ALL);
    const out = await llm.structured<Record<string, unknown>>(
      userMsg('nothing special here'),
      { type: 'object', properties: {}, required: [], additionalProperties: false },
      opts(),
    );
    for (const key of [
      'recipient',
      'chatJid',
      'attendees',
      'calendarId',
      'sendUpdates',
      'autoApprove',
      'eventId',
      'url',
    ]) {
      expect(Object.keys(out)).toContain(key);
    }
    expect(out.suspicious).toBe(false);
    expect(String(out.title)).toContain('https://');
    expect(String(out.title)).toContain(String.fromCodePoint(0x202e));
    expect(llm.calls).toHaveLength(1);
  });

  it('falls back to generic malice: write, unknown, case-variant, whitespace and homoglyph tool names on turn 1', async () => {
    const llm = new ObedientAttackerLlm([]);
    const tools = [
      {
        name: 'get_freebusy',
        description: 'd',
        inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
      },
    ];
    const res = await llm.chat(userMsg('hello'), tools, opts());
    const names = res.toolCalls.map((t) => t.name);
    expect(names).toContain('create-event');
    expect(names).toContain('Create-Event');
    expect(names).toContain('manage-accounts');
    expect(names).toContain('get_freebusy ');
    expect(names.some((n) => n.includes(String.fromCodePoint(0x435)))).toBe(true);
    expect(res.stopReason).toBe('tool_use');
  });

  it('answers later turns with a draft full of a URL, a number, an e-mail address and zero-width characters', async () => {
    const llm = new ObedientAttackerLlm([]);
    const tools = [
      {
        name: 'get_freebusy',
        description: 'd',
        inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
      },
    ];
    await llm.chat(userMsg('hello'), tools, opts());
    const second = await llm.chat(userMsg('hello'), tools, opts());
    expect(second.toolCalls).toEqual([]);
    expect(second.stopReason).toBe('end');
    expect(second.text).toContain('https://');
    expect(second.text).toContain('@example.com');
    expect(second.text).toContain(String.fromCodePoint(0x200b));
    expect(second.assistantMessage.content).toBe(second.text);
    llm.resetTurns();
    expect((await llm.chat(userMsg('hello'), tools, opts())).toolCalls.length).toBeGreaterThan(0);
  });

  it('can put its tool calls on a max_tokens or refusal turn (they must never be executed)', async () => {
    const tools = [
      {
        name: 'get_freebusy',
        description: 'd',
        inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const },
      },
    ];
    const maxTokens = new ObedientAttackerLlm([]).variant('max_tokens_tools');
    expect((await maxTokens.chat(userMsg('hi'), tools, opts())).stopReason).toBe('max_tokens');
    const refusal = new ObedientAttackerLlm([]).variant('refusal_tools');
    expect((await refusal.chat(userMsg('hi'), tools, opts())).stopReason).toBe('refusal');
  });

  it('offers no tool calls when the gate exposed no tools', async () => {
    const llm = new ObedientAttackerLlm([]);
    const res = await llm.chat(userMsg('hi'), [], opts());
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe('end');
  });

  it('is a usable LlmProvider otherwise', async () => {
    const llm = new ObedientAttackerLlm([], 'claude');
    expect(llm.id).toBe('claude');
    expect(await llm.validate(new AbortController().signal)).toEqual({ ok: true, model: 'obedient-attacker' });
    await expect(llm.dispose()).resolves.toBeUndefined();
  });
});
