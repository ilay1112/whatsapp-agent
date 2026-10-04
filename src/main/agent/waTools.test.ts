// T2 5 row `agent/toolDefs.ts, toolGate.ts, waTools.ts, handles.ts`: projection (I5'), caps, handles, query normalisation - over the
// REAL WaReadClient and a REAL messages.db (tests/helpers/waWorld.ts). Owner V2-W1-05-wa-toolserver.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from '../bridge/bridgeDb';
import { createWaReadClient, type WaReadClient } from '../bridge/waReadClient';
import { createRepos, openDb, MEMORY_DB, type Repos } from '../db/index';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { LIMITS, type ChatRef, type TranscriptRecord } from '../../shared/types';
import { createHandleTable } from './handles';
import type { RunCtx } from './toolGate';
import {
  executeWaTool,
  normalizeWaQuery,
  projectWaRow,
  WA_LAST_TEXT_CHARS,
  type WaChatMessagesResult,
  type WaContextResult,
  type WaListChatsResult,
  type WaSearchResult,
  type WaToolName,
} from './waTools';
import { createFakeBridgeDb, type FakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { FakeWaReadClient, fakeWaMessage } from '../../../tests/fakes/fake-wa-read-client';
import { seedWaWorld, WA_WORLD_JIDS, type WaWorld } from '../../../tests/helpers/waWorld';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NONCE = 'a1b2c3d4e5f60789';

interface World {
  fake: FakeBridgeDb;
  repos: Repos;
  world: WaWorld;
  wa: WaReadClient;
  settings: Settings;
  ctx: RunCtx;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function withScope(scope: 'trigger_chat' | 'all_chats', windowDays = 30): Settings {
  return {
    ...DEFAULT_SETTINGS,
    whatsapp: { ...DEFAULT_SETTINGS.whatsapp, readTools: { enabled: true, scope, windowDays } },
  };
}
function makeCtx(trigger: ChatRef, over: Partial<RunCtx> = {}): RunCtx {
  return {
    runId: 1,
    itemId: 1,
    chatId: trigger,
    nowMs: NOW,
    timeZone: 'Asia/Jerusalem',
    nonce: NONCE,
    calls: {},
    totalCalls: 0,
    blockedCalls: 0,
    signal: new AbortController().signal,
    handles: createHandleTable(trigger),
    waRowsServed: 0,
    crossChatRows: 0,
    otherChatTexts: [],
    ...over,
  };
}
function world(scope: 'trigger_chat' | 'all_chats' = 'trigger_chat'): World {
  const dir = mkdtempSync(join(tmpdir(), 'wca-watools-'));
  const fake = createFakeBridgeDb({ path: join(dir, 'messages.db'), now: new Date(NOW) });
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const w = seedWaWorld(fake, repos, { nowMs: NOW, withVoice: false });
  const bridge = createBridgeDb(fake.path);
  const t: TranscriptRecord = {
    chatJid: WA_WORLD_JIDS.trigger,
    waMsgId: 'WAWTAUD1',
    status: 'done',
    text: 'SENTINEL_TRANSCRIPT let us meet on Thursday',
    language: 'en',
    seconds: 4,
    modelLabel: 'fake',
    errorCode: null,
    createdAt: NOW,
  };
  const out: World = {
    fake,
    repos,
    world: w,
    settings: withScope(scope),
    ctx: makeCtx(w.trigger.chatId!),
    wa: undefined as unknown as WaReadClient,
  };
  out.wa = createWaReadClient({
    bridgeDb: bridge,
    chats: repos.chats,
    transcripts: { get: (jid, id) => (jid === t.chatJid && id === t.waMsgId ? t : null) },
    settings: () => out.settings,
  });
  cleanups.push(() => {
    bridge.close();
    fake.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return out;
}
const run = (w: World, name: WaToolName, args: Record<string, unknown>) =>
  executeWaTool(name, args, w.ctx, { wa: w.wa, settings: () => w.settings });

/** I5' regex sweep: none of this may appear in any serialised tool result. */
function sweep(json: string, w: WaWorld): void {
  expect(json).not.toMatch(/@s\.whatsapp\.net|@lid|@g\.us|@broadcast|@newsletter/);
  expect(json).not.toMatch(/\d{9,}/);
  expect(json).not.toMatch(/\d\d:\d\d/);
  for (const name of w.fixture.names) expect(json).not.toContain(name);
  for (const id of w.fixture.msgIds) expect(json).not.toContain(`"${id}"`);
  for (const id of w.fixture.msgIds) expect(json).not.toMatch(new RegExp(`\\b${id}\\b`));
  for (const f of w.fixture.filenames) expect(json).not.toContain(f);
  expect(json).not.toMatch(/\.(opus|jpg|webp|pdf)\b/);
}

describe('projectWaRow - handles, role label, relative age + coarse day, sanitised text (I5)', () => {
  const ctx = makeCtx(7);
  it('projects a text row', () => {
    const m = fakeWaMessage(42, 'call me +972-55-000-0099 or a@b.example, see https://evil.example/x', {
      ts: NOW - 3 * DAY,
    });
    expect(projectWaRow(m, 7, ctx, NOW, 'Asia/Jerusalem')).toEqual({
      id: 'm_1',
      chat: 'chat_1',
      from: 'contact',
      ago: '3 d ago',
      day: '2026-09-18',
      kind: 'text',
      text: 'call me [number] or [email], see [link]',
    });
  });
  it('voice rows carry their transcript; `me` rows; a null timestamp and an unusable zone never throw', () => {
    const v = fakeWaMessage(43, '', {
      voice: { transcript: 'the \u202Etranscript', language: 'he', seconds: 3 },
      fromMe: true,
      ts: null,
    });
    expect(projectWaRow(v, 8, ctx, NOW, 'Not/AZone')).toEqual({
      id: 'm_2',
      chat: 'chat_2',
      from: 'me',
      ago: 'unknown',
      day: 'unknown',
      kind: 'voice',
      text: 'the transcript',
    });
    expect(projectWaRow(fakeWaMessage(44, 'x', { ts: NOW - 60_000 }), 7, ctx, NOW, 'Not/AZone').day).toBe('2026-09-21');
  });
  it('cuts the text to LIMITS.waTextChars including the marker, never splitting a surrogate pair', () => {
    const long = projectWaRow(fakeWaMessage(45, 'a'.repeat(900)), 7, ctx, NOW, 'UTC').text;
    expect(long).toHaveLength(LIMITS.waTextChars);
    expect(long.endsWith(' [truncated]')).toBe(true);
    const emoji = '\u{1F600}'.repeat(400); // 800 UTF-16 units
    const cut = projectWaRow(fakeWaMessage(46, emoji), 7, ctx, NOW, 'UTC').text;
    expect(cut.endsWith(' [truncated]')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(LIMITS.waTextChars);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    const oddCut = projectWaRow(fakeWaMessage(47, 'b' + emoji), 7, ctx, NOW, 'UTC').text;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(oddCut)).toBe(false);
  });
});

describe('normalizeWaQuery - NFKC + invisible-stripped + whitespace-collapsed, 2..64 code points', () => {
  it.each([
    ['coffee', 'coffee'],
    ['  cof\u200Bfee\u202E ', 'coffee'],
    ['\uFF43\uFF4F\uFF46\uFF46\uFF45\uFF45', 'coffee'],
    ['new\n\tplan', 'new plan'],
    ['רביעי', 'רביעי'],
    ['ab', 'ab'],
    ['\u{1F600}\u{1F600}', '\u{1F600}\u{1F600}'],
    ['x'.repeat(64), 'x'.repeat(64)],
  ])('%j -> %j', (raw, want) => expect(normalizeWaQuery(raw)).toBe(want));
  it.each(['', 'a', ' a ', '\u200B\u200B', '\u{E0041}\u{E0042}', 'x'.repeat(65)])('%j is refused', (raw) => {
    expect(normalizeWaQuery(raw)).toBeNull();
  });
});

describe('wa_get_chat_messages', () => {
  it('default 12 rows of chat_1, oldest -> newest, more:true, handles in first-seen order', async () => {
    const w = world();
    const out = (await run(w, 'wa_get_chat_messages', { chat: 'chat_1' })) as WaChatMessagesResult;
    expect(out.chat).toBe('chat_1');
    expect(out.messages).toHaveLength(12);
    expect(out.more).toBe(true);
    expect(out.messages.map((m) => m.id)).toEqual(Array.from({ length: 12 }, (_, i) => `m_${i + 1}`));
    expect(out.messages.at(-1)).toMatchObject({
      from: 'contact',
      ago: '5 m ago',
      day: '2026-09-21',
      text: 'can we move it to 5pm instead?',
    });
    expect(out.messages.at(-2)).toMatchObject({ kind: 'voice', text: 'SENTINEL_TRANSCRIPT let us meet on Thursday' });
    expect(w.ctx.waRowsServed).toBe(12);
    expect(w.ctx.crossChatRows).toBe(0);
    sweep(JSON.stringify(out), w.world);
  });
  it('limit clamps to 1..20; paging with before_message returns strictly older rows; more:false at the window edge', async () => {
    const w = world();
    const one = (await run(w, 'wa_get_chat_messages', { chat: 'chat_1', limit: 0 })) as WaChatMessagesResult;
    expect(one.messages).toHaveLength(1);
    const many = (await run(w, 'wa_get_chat_messages', { chat: 'chat_1', limit: 500 })) as WaChatMessagesResult;
    expect(many.messages).toHaveLength(LIMITS.waRowsPerCall);
    const page2 = (await run(w, 'wa_get_chat_messages', {
      chat: 'chat_1',
      before_message: many.messages[0]!.id,
      limit: 20,
    })) as WaChatMessagesResult;
    expect(page2.messages.length).toBeGreaterThan(0);
    const older = page2.messages.map((m) => w.ctx.handles.rowidOf(m.id)!);
    expect(Math.max(...older)).toBeLessThan(w.ctx.handles.rowidOf(many.messages[0]!.id)!);
    const last = (await run(w, 'wa_get_chat_messages', {
      chat: 'chat_1',
      before_message: page2.messages[0]!.id,
      limit: 20,
    })) as WaChatMessagesResult;
    expect(last.more).toBe(false); // nothing older inside the 30-day window
  });
  it('bad arguments => null before any row is served (unknown / foreign handle, anchor of another chat)', async () => {
    const w = world('all_chats');
    for (const args of [
      { chat: 'chat_9' },
      { chat: 42 },
      { chat: 'chat_1', before_message: 'm_77' },
      { chat: 'chat_1', before_message: 5 },
    ]) {
      expect(await run(w, 'wa_get_chat_messages', args)).toBeNull();
    }
    // an anchor shown for ANOTHER chat cannot page the trigger chat
    const other = (await run(w, 'wa_search_messages', { query: 'address' })) as WaSearchResult;
    expect(other.hits[0]!.chat).toBe('chat_2');
    expect(await run(w, 'wa_get_chat_messages', { chat: 'chat_1', before_message: other.hits[0]!.id })).toBeNull();
    const served = w.ctx.waRowsServed;
    expect(await run(w, 'wa_get_chat_messages', { chat: 'chat_1', before_message: 'm_01' })).toBeNull();
    expect(w.ctx.waRowsServed).toBe(served);
  });
  it('LIMITS.waResultChars: the oldest rows are dropped first, more:true, and dropped rows get NO handle', async () => {
    const w = world();
    for (let i = 0; i < 20; i += 1) {
      w.fake.addMessage({
        id: `LONG${i}`,
        chatJid: WA_WORLD_JIDS.trigger,
        sender: '972550000011',
        content: `LONGROW${i} ${'q'.repeat(480)}`,
        fromMe: false,
        timestamp: w.fake.formatTs(new Date(NOW - 60_000 + i)),
      });
    }
    const out = (await run(w, 'wa_get_chat_messages', { chat: 'chat_1', limit: 20 })) as WaChatMessagesResult;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.waResultChars);
    expect(out.more).toBe(true);
    expect(out.messages.length).toBeLessThan(20);
    expect(out.messages.at(-1)!.text.startsWith('LONGROW19 ')).toBe(true); // newest kept
    expect(out.messages.every((m) => m.text.length <= LIMITS.waTextChars)).toBe(true);
    expect(w.ctx.handles.rowidOf(`m_${out.messages.length + 1}`)).toBeNull();
    expect(w.ctx.waRowsServed).toBe(out.messages.length);
  });
});

describe('wa_search_messages', () => {
  it('trigger_chat: pinned to chat_1 whether `chat` is omitted or chat_1; other chats never surface', async () => {
    const w = world();
    const a = (await run(w, 'wa_search_messages', { query: 'address' })) as WaSearchResult;
    expect(a).toEqual({ hits: [], truncated: false }); // SENTINEL_OTHER_CHAT lives in another chat
    const b = (await run(w, 'wa_search_messages', { query: '5pm', chat: 'chat_1' })) as WaSearchResult;
    expect(b.hits.map((h) => [h.chat, h.text])).toEqual([['chat_1', 'can we move it to 5pm instead?']]);
    expect(await run(w, 'wa_search_messages', { query: '5pm', chat: 'chat_2' })).toBeNull();
    expect(await run(w, 'wa_search_messages', { query: 'x' })).toBeNull();
    expect(await run(w, 'wa_search_messages', { query: 7 })).toBeNull();
    sweep(JSON.stringify(b), w.world);
  });
  it('all_chats: every visible chat, hits carry run handles; cross-chat rows are counted and kept for the S4 guard', async () => {
    const w = world('all_chats');
    const out = (await run(w, 'wa_search_messages', { query: 'SENTINEL', limit: 10 })) as WaSearchResult;
    const texts = out.hits.map((h) => h.text).join('\n');
    expect(texts).not.toMatch(/SENTINEL_(GROUP|STATUS|NEWSLETTER|STRANGER|NEVER|DELETED|GARBAGE)/);
    expect(new Set(out.hits.map((h) => h.chat))).toEqual(new Set(['chat_1', 'chat_2', 'chat_3']));
    expect(w.ctx.crossChatRows).toBe(out.hits.filter((h) => h.chat !== 'chat_1').length);
    expect(w.ctx.otherChatTexts.join('\n')).toContain('SENTINEL_OTHER_CHAT');
    const jid = (await run(w, 'wa_search_messages', { query: 'call me' })) as WaSearchResult;
    expect(jid.hits[0]!.text).toBe('[email] call me at [number]');
    sweep(JSON.stringify(out) + JSON.stringify(jid), w.world);
  });
  it('an every-chat hit whose chat the facade cannot confirm is dropped (never labelled with a guessed chat)', async () => {
    const fake = new FakeWaReadClient({
      messages: [fakeWaMessage(5, 'plan A'), fakeWaMessage(6, 'plan B')],
      chatOfRow: (r) => (r === 5 ? null : 9),
    });
    const ctx = makeCtx(3);
    const out = (await executeWaTool('wa_search_messages', { query: 'plan' }, ctx, {
      wa: fake,
      settings: () => withScope('all_chats'),
    })) as WaSearchResult;
    expect(out.hits.map((h) => h.text)).toEqual(['plan B']);
  });
  it('LIMITS.waResultChars: oldest hits dropped first, truncated:true', async () => {
    const fake = new FakeWaReadClient({
      messages: Array.from({ length: 10 }, (_, i) => fakeWaMessage(i + 1, `needle ${i} ${'"'.repeat(470)}`)),
    });
    const ctx = makeCtx(3);
    const out = (await executeWaTool('wa_search_messages', { query: 'needle', limit: 10 }, ctx, {
      wa: fake,
      settings: () => withScope('trigger_chat'),
    })) as WaSearchResult;
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.waResultChars);
    expect(out.hits[0]!.text.startsWith('needle 9 ')).toBe(true); // newest first, kept
  });
});

describe('wa_get_message_context', () => {
  it('returns the neighbours of a message shown earlier in this run', async () => {
    const w = world();
    const hit = (await run(w, 'wa_search_messages', { query: 'Wednesday' })) as WaSearchResult;
    const out = (await run(w, 'wa_get_message_context', {
      message: hit.hits[0]!.id,
      before: 1,
      after: 1,
    })) as WaContextResult;
    expect(out.chat).toBe('chat_1');
    expect(out.message).toMatchObject({ id: hit.hits[0]!.id, from: 'me', text: 'I can do Wednesday afternoon' });
    expect(out.before.map((r) => r.text)).toEqual(['SENTINEL_WA_ROW_59 note number 59 about the plan']);
    expect(out.after.map((r) => r.kind)).toEqual(['voice']);
    sweep(JSON.stringify(out), w.world);
    expect(await run(w, 'wa_get_message_context', { message: 'm_999' })).toBeNull();
    expect(await run(w, 'wa_get_message_context', { message: null })).toBeNull();
  });
  it('a message of another chat is out of scope in trigger_chat (null); defaults are 4 / 4', async () => {
    const fake = new FakeWaReadClient({ messages: [fakeWaMessage(5, 'x')], chatOfRow: () => 9 });
    const ctx = makeCtx(3);
    ctx.handles.msgHandle(5);
    expect(
      await executeWaTool('wa_get_message_context', { message: 'm_1' }, ctx, {
        wa: fake,
        settings: () => withScope('trigger_chat'),
      }),
    ).toBeNull();
    const w = world();
    const first = (await run(w, 'wa_get_chat_messages', { chat: 'chat_1', limit: 1 })) as WaChatMessagesResult;
    await run(w, 'wa_get_message_context', { message: first.messages[0]!.id });
    const out = (await run(w, 'wa_get_message_context', { message: first.messages[0]!.id })) as WaContextResult;
    expect(out.before).toHaveLength(4);
    expect(out.after).toHaveLength(0);
  });
  it('fits LIMITS.waResultChars by dropping the oldest `before` rows first, then the farthest `after` rows; the target is always kept', async () => {
    const rows = Array.from({ length: 17 }, (_, i) => fakeWaMessage(i + 1, `row ${i} ${'\\'.repeat(470)}`));
    const fake = new FakeWaReadClient({ messages: rows });
    const ctx = makeCtx(3);
    ctx.handles.msgHandle(9);
    const out = (await executeWaTool('wa_get_message_context', { message: 'm_1', before: 8, after: 8 }, ctx, {
      wa: fake,
      settings: () => withScope('trigger_chat'),
    })) as WaContextResult;
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.waResultChars);
    expect(out.message.text.startsWith('row 8 ')).toBe(true);
    expect(out.before).toEqual([]);
    expect(out.after.length).toBeGreaterThan(0);
    expect(out.after[0]!.text.startsWith('row 9 ')).toBe(true);
  });
  it('a target whose text sanitises to nothing is still the anchor (empty text), never dropped', async () => {
    const fake = new FakeWaReadClient({ messages: [fakeWaMessage(5, '\u200B\u202E')] });
    const ctx = makeCtx(3);
    ctx.handles.msgHandle(5);
    const out = (await executeWaTool('wa_get_message_context', { message: 'm_1' }, ctx, {
      wa: fake,
      settings: () => withScope('trigger_chat'),
    })) as WaContextResult;
    expect(out.message).toMatchObject({ id: 'm_1', text: '' });
  });
});

describe('wa_list_chats', () => {
  it('only under all_chats; lists visible DM chats as handles with sanitised, capped last text', async () => {
    expect(await run(world(), 'wa_list_chats', {})).toBeNull();
    const w = world('all_chats');
    const out = (await run(w, 'wa_list_chats', { limit: 50 })) as WaListChatsResult;
    expect(out.chats).toHaveLength(3);
    expect(out.chats.map((c) => c.chat).sort()).toEqual(['chat_1', 'chat_2', 'chat_3']);
    for (const c of out.chats) expect(c.last_text.length).toBeLessThanOrEqual(WA_LAST_TEXT_CHARS);
    sweep(JSON.stringify(out), w.world);
    expect(w.ctx.crossChatRows).toBe(2);
  });
  it('the worst case (10 entries of 120 JSON-escaped characters) stays inside LIMITS.waResultChars', async () => {
    const fake = new FakeWaReadClient({
      recentChats: Array.from({ length: 10 }, (_, i) => ({
        chatId: 100 + i,
        lastTs: NOW - 99 * DAY,
        lastRole: 'contact' as const,
        lastText: '"\\'.repeat(200),
      })),
    });
    const out = (await executeWaTool('wa_list_chats', { limit: 10 }, makeCtx(3), {
      wa: fake,
      settings: () => withScope('all_chats'),
    })) as WaListChatsResult;
    expect(out.chats).toHaveLength(10);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LIMITS.waResultChars);
  });
});

describe('window setting is app-pinned (windowDays 1..90)', () => {
  it('90 days shows all 60 history rows; an out-of-range setting is clamped', async () => {
    const w = world();
    w.settings = withScope('trigger_chat', 90);
    const all = async (): Promise<number> => {
      let n = 0;
      let before: string | undefined;
      for (;;) {
        const page = (await executeWaTool(
          'wa_get_chat_messages',
          { chat: 'chat_1', limit: 20, ...(before ? { before_message: before } : {}) },
          w.ctx,
          { wa: w.wa, settings: () => w.settings },
        )) as WaChatMessagesResult;
        n += page.messages.filter((m) => m.text.startsWith('SENTINEL_WA_ROW_')).length;
        if (!page.more || page.messages.length === 0) return n;
        before = page.messages[0]!.id;
      }
    };
    expect(await all()).toBe(60);
    w.settings = withScope('trigger_chat', 5000);
    w.ctx = makeCtx(w.world.trigger.chatId!);
    expect(await all()).toBe(60);
    w.settings = withScope('trigger_chat', Number.NaN);
    w.ctx = makeCtx(w.world.trigger.chatId!);
    const tiny = (await run(w, 'wa_get_chat_messages', { chat: 'chat_1', limit: 20 })) as WaChatMessagesResult;
    expect(tiny.messages.every((m) => m.ago.endsWith('h ago') || m.ago.endsWith('m ago'))).toBe(true);
  });
});
