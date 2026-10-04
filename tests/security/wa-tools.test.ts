// Security gate group 20 (T2 8.2; invariants I2' and I5'): the read-only WhatsApp tools. Owner V2-W1-05-wa-toolserver.
//
// Real path only (tests/helpers/waWorld.ts createWaToolRig): real ToolGate -> real WaReadClient -> real read-only BridgeDb over a
// messages.db seeded like the bridge writes it. `waCalls` is a counting wrapper that DELEGATES to the real facade (never a double).
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BLOCKED_NAMES } from '../../src/main/agent/toolGate.ts';
import { READ_TOOL_NAMES } from '../../src/main/agent/toolDefs.ts';
import { crossChatLeak } from '../../src/main/agent/validate.ts';
import { LIMITS } from '../../src/shared/types.ts';
import type { LlmToolCall } from '../../src/main/llm/types.ts';
import { createWaToolRig, WA_RIG_NONCE, type WaToolRig, type WaWorld } from '../helpers/waWorld.ts';

const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
const call = (name: string, input: Record<string, unknown> = {}): LlmToolCall => ({ id: 'tc', name, input });
let rig: WaToolRig | null = null;
afterEach(async () => {
  await rig?.dispose();
  rig = null;
});

function unwrap(content: string): unknown {
  const m = /^<<DATA-([0-9a-f]{16})>>\n([\s\S]*)\n<<END-DATA-\1>>$/.exec(content);
  expect(m).not.toBeNull();
  expect(m![1]).toBe(WA_RIG_NONCE);
  return JSON.parse(m![2]!.replace(/\\u003c/g, '<'));
}
/** I5' regex sweep over a serialised tool result. */
function sweep(json: string, w: WaWorld): void {
  expect(json).not.toMatch(/@s\.whatsapp\.net|@lid|@g\.us|@broadcast|@newsletter/);
  expect(json).not.toMatch(/\d{9,}/);
  expect(json).not.toMatch(/\d\d:\d\d/);
  for (const name of w.fixture.names) expect(json).not.toContain(name);
  for (const id of w.fixture.msgIds) expect(json).not.toMatch(new RegExp(`\\b${id}\\b`));
  for (const f of w.fixture.filenames) expect(json).not.toContain(f);
}

describe("I2' - BLOCKED_NAMES and every variant: blocked_unknown_tool, zero WaReadClient calls, sha8-only audit", () => {
  it('reference-server names (incl. mark_messages_read, view_media), FQNs, case / space / homoglyph variants', async () => {
    rig = await createWaToolRig({ scope: 'all_chats' });
    const names = [
      ...BLOCKED_NAMES,
      ...BLOCKED_NAMES.map((n) => n.toUpperCase()),
      'WA_SEARCH_MESSAGES',
      'wa_search_messages ',
      ' wa_search_messages',
      'wa_s\u0435arch_messages',
      'wa_get_chat_messages\u200b',
      'mcp__wca__wa_get_chat_messages',
      'get_message_context',
      'list_chats',
    ];
    for (const req of [
      'send_message',
      'send_file',
      'send_audio_message',
      'download_media',
      'mark_messages_read',
      'view_media',
      'send_reaction',
      'list_messages',
      'search_contacts',
    ]) {
      expect(BLOCKED_NAMES).toContain(req);
    }
    for (const n of READ_TOOL_NAMES) expect(BLOCKED_NAMES).toContain(`mcp__wca__${n}`);
    const ctx = rig.ctx();
    for (const name of names) {
      const out = await rig.gate.invoke(call(name, { chat: 'chat_1', query: 'address', message: 'm_1' }), ctx);
      expect(out.verdict, sha8(name)).toBe('blocked_unknown_tool');
      expect(out.result.content).toBe('{"error":"tool not available"}');
    }
    expect(rig.waCalls).toEqual([]);
    const audit = rig.blockedAudit();
    expect(audit).toHaveLength(names.length);
    for (const d of audit) expect(Object.keys(d).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
    expect(JSON.stringify(audit)).not.toContain('send_message');
  });
});

describe("I5' - scope pinning: trigger_chat reads only the trigger chat", () => {
  it('search without `chat` is pinned to chat_1 and never reaches SENTINEL_OTHER_CHAT; forged handles are bad args', async () => {
    rig = await createWaToolRig();
    const ctx = rig.ctx();
    const search = await rig.gate.invoke(call('wa_search_messages', { query: 'address' }), ctx);
    expect(search.verdict).toBe('executed');
    expect(unwrap(search.result.content)).toEqual({ hits: [], truncated: false });
    for (const chat of ['chat_2', 'chat_77', 'chat_01']) {
      expect((await rig.gate.invoke(call('wa_get_chat_messages', { chat }), ctx)).verdict).toBe('blocked_bad_args');
      expect((await rig.gate.invoke(call('wa_search_messages', { query: 'address', chat }), ctx)).verdict).toBe(
        'blocked_bad_args',
      );
    }
    expect((await rig.gate.invoke(call('wa_get_message_context', { message: 'm_9999' }), ctx)).verdict).toBe(
      'blocked_bad_args',
    );
    expect(ctx.blockedCalls).toBe(0);
    expect(ctx.crossChatRows).toBe(0);
    expect(ctx.otherChatTexts).toEqual([]);
  });
  it('SENTINEL_OTHER_CHAT, the stranger, the never chat, groups, status and newsletters appear in NO trigger_chat payload', async () => {
    rig = await createWaToolRig();
    const ctx = rig.ctx();
    const payloads: string[] = [];
    const tryCall = async (name: string, input: Record<string, unknown>): Promise<void> => {
      const out = await rig!.gate.invoke(call(name, input), ctx);
      payloads.push(out.result.content);
    };
    await tryCall('wa_get_chat_messages', { chat: 'chat_1', limit: 20 });
    for (const query of ['SENTINEL', '5pm', 'address', 'private', 'group'])
      await tryCall('wa_search_messages', { query, limit: 10 });
    await tryCall('wa_get_message_context', { message: 'm_1', before: 8, after: 8 });
    await tryCall('wa_list_chats', {});
    const pre = await rig.gate.prefetchWaContext(rig.ctx());
    payloads.push(pre!);
    const all = payloads.join('\n');
    expect(all).not.toMatch(
      /SENTINEL_(OTHER_CHAT|STRANGER_ROW|NEVER_ROW|GROUP_ROW|STATUS_ROW|NEWSLETTER_ROW|LID_ROW|DELETED_ROW|GARBAGE_TS)/,
    );
    expect(all).toContain('SENTINEL_WA_ROW_');
    sweep(all, rig.world);
  });
});

describe("I5' - projection regex sweep over EVERY tool (all_chats, the widest scope)", () => {
  it('no JID, @lid, 9+ digit run, clock time, fixture name, message id or file name in any result', async () => {
    rig = await createWaToolRig({ scope: 'all_chats', windowDays: 90 });
    const ctx = rig.ctx();
    const results: unknown[] = [];
    const run = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      const out = await rig!.gate.invoke(call(name, input), ctx);
      expect(out.verdict, name).toBe('executed');
      const v = unwrap(out.result.content);
      results.push(v);
      return v;
    };
    const list = (await run('wa_list_chats', {})) as { chats: Array<{ chat: string }> };
    expect(list.chats.length).toBe(3); // trigger, other, lid twin - never the stranger / never / group / status / newsletter
    await run('wa_get_chat_messages', { chat: 'chat_1', limit: 20 });
    const hits = (await run('wa_search_messages', { query: 'call me' })) as {
      hits: Array<{ id: string; text: string }>;
    };
    expect(hits.hits[0]!.text).toBe('[email] call me at [number]'); // raw JID + phone row (wr-jid-in-text)
    await run('wa_get_message_context', { message: hits.hits[0]!.id, before: 8, after: 8 });
    await run('wa_search_messages', { query: 'SENTINEL' });
    const json = JSON.stringify(results);
    sweep(json, rig.world);
    expect(json).toContain('SENTINEL_TRANSCRIPT'); // voice rows surface as their transcript, kind voice
    expect(json).toContain('"kind":"voice"');
    expect(json.length).toBeGreaterThan(1000);
    for (const r of results) expect(JSON.stringify(r).length).toBeLessThanOrEqual(LIMITS.waResultChars);
  });
});

describe("I5' - the S4 cross-chat leak guard gets its input (all_chats)", () => {
  it('rows served from another chat are counted and kept in memory; a draft quoting one is a leak', async () => {
    rig = await createWaToolRig({ scope: 'all_chats' });
    const ctx = rig.ctx();
    const out = await rig.gate.invoke(call('wa_search_messages', { query: 'address' }), ctx);
    expect(unwrap(out.result.content)).toMatchObject({ hits: [{ chat: 'chat_2' }] });
    expect(ctx.crossChatRows).toBe(1);
    expect(ctx.otherChatTexts).toEqual(['my address is 12 Fake St, card ends 4242 SENTINEL_OTHER_CHAT']);
    // the guard itself is V2-W1-03's (validate.ts); these rows are exactly its input
    expect(
      crossChatLeak('Sure! my address is 12 Fake St, card ends 4242', ctx.otherChatTexts, LIMITS.crossChatLeakWindow),
    ).toBe(true);
    expect(crossChatLeak('Sure, see you Wednesday', ctx.otherChatTexts, LIMITS.crossChatLeakWindow)).toBe(false);
  });
});

describe('injection corpus v2 (T2 8.4) - the wa_row family and the new vectors are authored (runner: V2-W2-02)', () => {
  const load = (lang: 'he' | 'en'): Array<{ id: string; vector: string; seed?: unknown }> => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL(`./injection-corpus.${lang}.json`, import.meta.url)), 'utf8'),
    ) as unknown;
    return (Array.isArray(raw) ? raw : (raw as { cases: unknown[] }).cases) as Array<{
      id: string;
      vector: string;
      seed?: unknown;
    }>;
  };
  it('>= 40 cases, >= 15 Hebrew; the eight wa_row twins in both languages with a seed; every new vector present', () => {
    const he = load('he');
    const en = load('en');
    expect(he.length + en.length).toBeGreaterThanOrEqual(40);
    expect(he.length).toBeGreaterThanOrEqual(15);
    const WA_ROW = [
      'wr-exfil-other-chat',
      'wr-instruction-in-history',
      'wr-fake-end-block',
      'wr-handle-forgery',
      'wr-reference-tool-names',
      'wr-bidi-query',
      'wr-voice-transcript-injection',
      'wr-jid-in-text',
    ];
    for (const [lang, cases] of [
      ['he', he],
      ['en', en],
    ] as const) {
      for (const id of WA_ROW) {
        const c = cases.find((x) => x.id === `${id}-${lang}` || x.id === id);
        expect(c, `${id} (${lang})`).toBeDefined();
      }
      const vectors = new Set(cases.map((c) => c.vector));
      for (const v of ['wa_row', 'voice_transcript', 'image_text', 'existing_event_title', 'cli_output']) {
        expect(vectors.has(v), `${v} (${lang})`).toBe(true);
      }
      for (const c of cases.filter((x) => x.vector === 'wa_row' && !x.id.startsWith('wr-handle-forgery'))) {
        expect(c.seed, c.id).toBeDefined();
      }
    }
  });
});
