// T2 5 row `bridge/bridgeDb.ts (+4 SELECTs), bridge/waReadClient.ts` over the REAL facade and a REAL messages.db written by
// tests/fakes/fake-bridge-db.ts (T2 3.5: WaReadClient is on the never-mock list). Owner V2-W1-05-wa-toolserver.
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb, type BridgeDb, type BridgeMessageRowV2 } from './bridgeDb';
import { createWaReadClient, type WaReadClient, type WaReadQuery } from './waReadClient';
import { createRepos, openDb, MEMORY_DB, type Db, type Repos } from '../db/index';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { ChatRef, Message, TranscriptRecord } from '../../shared/types';
import { createFakeBridgeDb, type FakeBridgeDb, type FakeTsFormat } from '../../../tests/fakes/fake-bridge-db';
import { seedWaWorld, WA_WORLD_JIDS, type WaWorld } from '../../../tests/helpers/waWorld';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const DAY = 24 * 3_600_000;
const Q30: WaReadQuery = { nowMs: NOW, windowMs: 30 * DAY };
const Q90: WaReadQuery = { nowMs: NOW, windowMs: 90 * DAY };

interface Rig {
  fake: FakeBridgeDb;
  bridge: BridgeDb;
  db: Db;
  repos: Repos;
  world: WaWorld;
  wa: WaReadClient;
  settings: Settings;
  transcripts: Map<string, TranscriptRecord>;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function transcript(over: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    chatJid: WA_WORLD_JIDS.trigger,
    waMsgId: 'WAWTAUD1',
    status: 'done',
    text: 'SENTINEL_TRANSCRIPT let us meet on Thursday',
    language: 'en',
    seconds: 4,
    modelLabel: 'fake-whisper',
    errorCode: null,
    createdAt: NOW,
    ...over,
  };
}

function rig(
  opts: { tsFormat?: FakeTsFormat; historyDays?: number; settings?: Partial<Settings['whatsapp']> } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'wca-wareadclient-'));
  const fake = createFakeBridgeDb({ path: join(dir, 'messages.db'), tsFormat: opts.tsFormat, now: new Date(NOW) });
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  // withVoice:false - the audio row is seeded, its transcripts row comes from the Map below (repos.transcripts is V2-W1-01's)
  // [v2-closeout] one transaction for the whole world: per-row autocommits (journal fsync per row) timed this file out under load
  const world = fake.batch(() =>
    seedWaWorld(fake, repos, { nowMs: NOW, historyDays: opts.historyDays, withVoice: false }),
  );
  const bridge = createBridgeDb(fake.path);
  const transcripts = new Map<string, TranscriptRecord>([[`${WA_WORLD_JIDS.trigger}|WAWTAUD1`, transcript()]]);
  const r: Rig = {
    fake,
    bridge,
    db,
    repos,
    world,
    settings: { ...DEFAULT_SETTINGS, whatsapp: { ...DEFAULT_SETTINGS.whatsapp, ...opts.settings } },
    transcripts,
    wa: undefined as unknown as WaReadClient,
  };
  r.wa = createWaReadClient({
    bridgeDb: bridge,
    chats: repos.chats,
    transcripts: { get: (jid, id) => transcripts.get(`${jid}|${id}`) ?? null },
    settings: () => r.settings,
  });
  cleanups.push(() => {
    bridge.close();
    fake.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return r;
}
const texts = (ms: Message[]): string[] => ms.map((m) => (m.voice ? `voice:${m.voice.transcript}` : m.text));
const tid = (r: Rig): ChatRef => r.world.trigger.chatId!;

describe('WaReadClient - read-only by construction (I2)', () => {
  it('exposes exactly the four read methods, no write method (type + runtime key list)', () => {
    const r = rig();
    expect(Object.keys(r.wa).sort()).toEqual(['chatMessages', 'context', 'recentChats', 'search']);
    expectTypeOf<keyof WaReadClient>().toEqualTypeOf<'recentChats' | 'chatMessages' | 'search' | 'context'>();
  });
});

describe('chatMessages - one chat, oldest -> newest, window in TypeScript, row filter', () => {
  it('returns the newest n visible rows of the trigger chat in chronological order', () => {
    const r = rig();
    const rows = r.wa.chatMessages(tid(r), null, 4, Q30);
    expect(texts(rows)).toEqual([
      'SENTINEL_WA_ROW_59 note number 59 about the plan',
      'I can do Wednesday afternoon',
      'voice:SENTINEL_TRANSCRIPT let us meet on Thursday',
      'can we move it to 5pm instead?',
    ]);
    expect(rows.map((m) => m.rowid)).toEqual([...rows.map((m) => m.rowid)].sort((a, b) => a - b));
    const voice = rows[2]!;
    expect(voice).toMatchObject({ text: '', mediaType: 'audio', voice: { language: 'en', seconds: 4 } });
    expect(rows[1]!.fromMe).toBe(true);
  });
  it('deleted, reaction, sticker, media-only (image / document) and garbage-timestamp rows never surface', () => {
    const r = rig();
    const all = texts(r.wa.chatMessages(tid(r), null, 500, Q90)).join('\n');
    for (const hidden of ['SENTINEL_DELETED_ROW', 'SENTINEL_GARBAGE_TS', '\u{1F44D}'])
      expect(all).not.toContain(hidden);
    const kinds = r.wa.chatMessages(tid(r), null, 500, Q90).map((m) => m.mediaType);
    expect(kinds.filter((k) => k !== '' && k !== 'audio')).toEqual([]);
  });
  it('the window is app-pinned: 30 days hides the older rows, 90 days shows all 60', () => {
    const r = rig();
    const n30 = r.wa.chatMessages(tid(r), null, 500, Q30).filter((m) => m.text.startsWith('SENTINEL_WA_ROW_')).length;
    const n90 = r.wa.chatMessages(tid(r), null, 500, Q90).filter((m) => m.text.startsWith('SENTINEL_WA_ROW_')).length;
    expect(n90).toBe(60);
    expect(n30).toBeGreaterThan(30);
    expect(n30).toBeLessThan(60);
    for (const m of r.wa.chatMessages(tid(r), null, 500, Q30)) expect(m.ts!).toBeGreaterThanOrEqual(NOW - 30 * DAY);
  });
  it.each(['go-sqlite3', 'rfc3339', 'epoch_s', 'epoch_ms'] as const)(
    'parses %s timestamps the same way',
    (tsFormat) => {
      const r = rig({ tsFormat });
      expect(r.wa.chatMessages(tid(r), null, 500, Q30).length).toBe(
        rig().wa.chatMessages(tid(rig()), null, 500, Q30).length,
      );
    },
  );
  it('a store whose every timestamp is garbage shows nothing (unparseable => invisible)', () => {
    const r = rig({ tsFormat: 'garbage' });
    expect(r.wa.chatMessages(tid(r), null, 500, Q90)).toEqual([]);
  });
  it('pages with beforeRowid (rows strictly older than the anchor)', () => {
    const r = rig();
    const first = r.wa.chatMessages(tid(r), null, 3, Q90);
    const older = r.wa.chatMessages(tid(r), first[0]!.rowid, 3, Q90);
    expect(older.every((m) => m.rowid < first[0]!.rowid)).toBe(true);
    expect(older).toHaveLength(3);
  });
  it('n <= 0, NaN or an unknown chat id => []', () => {
    const r = rig();
    expect(r.wa.chatMessages(tid(r), null, 0, Q30)).toEqual([]);
    expect(r.wa.chatMessages(tid(r), null, Number.NaN, Q30)).toEqual([]);
    expect(r.wa.chatMessages(999_999, null, 5, Q30)).toEqual([]);
  });
  it('policy never and unknown-sender chats are invisible; processUnknownSenders makes the stranger visible', () => {
    const r = rig();
    expect(r.wa.chatMessages(r.world.never.chatId!, null, 10, Q30)).toEqual([]);
    expect(r.wa.chatMessages(r.world.stranger.chatId!, null, 10, Q30)).toEqual([]);
    r.settings = { ...r.settings, whatsapp: { ...r.settings.whatsapp, processUnknownSenders: true } };
    expect(texts(r.wa.chatMessages(r.world.stranger.chatId!, null, 10, Q30))).toEqual([
      'SENTINEL_STRANGER_ROW hello 5pm',
    ]);
    expect(r.wa.chatMessages(r.world.never.chatId!, null, 10, Q30)).toEqual([]); // never stays never
    const forced = r.repos.chats.setForceKnown(r.world.stranger.chatId!);
    expect(forced.forceKnown).toBe(true);
  });
  it('a force-known chat is visible without processUnknownSenders', () => {
    const r = rig();
    r.repos.chats.setForceKnown(r.world.stranger.chatId!);
    expect(r.wa.chatMessages(r.world.stranger.chatId!, null, 10, Q30)).toHaveLength(1);
  });
  it('the @lid twin rows are merged into the phone-JID chat (aliasJids)', () => {
    const r = rig();
    expect(texts(r.wa.chatMessages(r.world.fixture.lidChatId, null, 10, Q30))).toEqual([
      'SENTINEL_LID_ROW written under the lid form',
      'SENTINEL_LID_PHONE_ROW written under the phone form',
    ]);
  });
  it('voice rows need a DONE transcript with text; otherwise the audio row is invisible', () => {
    for (const t of [
      null,
      transcript({ status: 'failed', text: null }),
      transcript({ text: '   ' }),
      transcript({ text: null }),
    ]) {
      const r = rig();
      if (t === null) r.transcripts.clear();
      else r.transcripts.set(`${WA_WORLD_JIDS.trigger}|WAWTAUD1`, t);
      expect(r.wa.chatMessages(tid(r), null, 100, Q30).some((m) => m.mediaType === 'audio')).toBe(false);
    }
  });
  it('a voice row stored under the @lid form finds its transcript under the app chat JID too', () => {
    const r = rig();
    r.fake.seedMediaRow({
      chatJid: WA_WORLD_JIDS.lid,
      id: 'LIDAUD1',
      mediaType: 'audio',
      ts: new Date(NOW - 3_600_000),
    });
    r.transcripts.set(
      `${WA_WORLD_JIDS.lidPhone}|LIDAUD1`,
      transcript({ chatJid: WA_WORLD_JIDS.lidPhone, waMsgId: 'LIDAUD1', text: 'lid voice' }),
    );
    expect(texts(r.wa.chatMessages(r.world.fixture.lidChatId, null, 10, Q30))).toContain('voice:lid voice');
  });
  it('walks page after page when many rows are hidden, and stops at the scan cap', () => {
    const r = rig();
    // 450 reaction-free rows OUTSIDE the window on top of the chat: the visible rows are found below them (paging)
    r.fake.seedBulk({ chatJid: WA_WORLD_JIDS.other, rows: 450, startTs: NOW - 80 * DAY, stepMs: 1 });
    const old = r.wa.chatMessages(r.world.other.chatId!, null, 2, Q30);
    // the two in-window rows have OLDER rowids than the 450 invisible bulk rows: found only by walking page after page
    expect(old.map((m) => m.waMsgId)).toEqual(['WAWOADR1', 'WAWOJID1']);
    const rq = rig();
    rq.fake.seedBulk({ chatJid: WA_WORLD_JIDS.other, rows: 450, startTs: NOW - 40 * DAY, stepMs: 1 });
    expect(texts(rq.wa.chatMessages(rq.world.other.chatId!, null, 2, Q90))).toEqual(['bulk row 448', 'bulk row 449']);
    // 2,100 rows all outside the window: the scan cap ends the walk with nothing visible (never a table scan)
    const cap = rig();
    cap.fake.seedBulk({ chatJid: WA_WORLD_JIDS.other, rows: 2_100, startTs: NOW - 200 * DAY, stepMs: 1 });
    expect(cap.wa.chatMessages(cap.world.other.chatId!, null, 5, Q90)).toEqual([]);
  });
});

describe('search - bound instr() needle, scope re-check', () => {
  it('finds case-insensitive ASCII and exact non-ASCII substrings of ONE visible chat, newest first', () => {
    const r = rig();
    expect(texts(r.wa.search('WEDNESDAY', tid(r), 5, Q30, 'trigger_chat'))).toEqual(['I can do Wednesday afternoon']);
    r.fake.addMessage({
      id: 'HEB1',
      chatJid: WA_WORLD_JIDS.trigger,
      sender: '972550000011',
      content: 'נפגש ביום רביעי',
      fromMe: false,
      timestamp: r.fake.formatTs(new Date(NOW - 60_000)),
    });
    expect(texts(r.wa.search('רביעי', tid(r), 5, Q30, 'trigger_chat'))).toEqual(['נפגש ביום רביעי']);
    const hits = r.wa.search('SENTINEL_WA_ROW_5', tid(r), 3, Q90, 'trigger_chat');
    expect(hits.map((m) => m.rowid)).toEqual([...hits.map((m) => m.rowid)].sort((a, b) => b - a));
    expect(hits).toHaveLength(3);
  });
  it('a needle with SQL / LIKE metacharacters is data, never syntax', () => {
    const r = rig();
    for (const needle of ["' OR 1=1 --", '%', '"); DROP TABLE messages; --']) {
      expect(r.wa.search(needle, tid(r), 5, Q90, 'trigger_chat')).toEqual([]);
    }
    expect(r.wa.chatMessages(tid(r), null, 1, Q30)).toHaveLength(1);
  });
  it('chatId null is answered only in all_chats scope, and only from visible DM chats', () => {
    const r = rig({ settings: { processUnknownSenders: false } });
    expect(r.wa.search('5pm', null, 10, Q30, 'trigger_chat')).toEqual([]);
    const all = r.wa.search('5pm', null, 10, Q30, 'all_chats');
    expect(texts(all)).toEqual(['can we move it to 5pm instead?']); // group / status / newsletter / stranger / never invisible
    const addr = r.wa.search('address', null, 10, Q30, 'all_chats');
    expect(addr.map((m) => m.chatJid)).toEqual([WA_WORLD_JIDS.other]);
    expect(r.wa.search('lid form', null, 10, Q30, 'all_chats')).toHaveLength(1); // @lid rows map to their phone chat
  });
  it('empty needle, n <= 0 and invisible chats => []', () => {
    const r = rig();
    expect(r.wa.search('', tid(r), 5, Q30, 'trigger_chat')).toEqual([]);
    expect(r.wa.search('plan', tid(r), 0, Q30, 'trigger_chat')).toEqual([]);
    expect(r.wa.search('private', r.world.never.chatId!, 5, Q30, 'all_chats')).toEqual([]);
    expect(r.wa.search('plan', tid(r), 2, { nowMs: NOW, windowMs: 1 }, 'trigger_chat')).toEqual([]); // window
  });
});

describe('context - neighbours of the SAME chat, scope re-check', () => {
  it('returns the target plus up to before/after rows, oldest -> newest', () => {
    const r = rig();
    const got = r.wa.context(r.world.fixture.rowids.fromMeRecent, 2, 2, Q30, 'trigger_chat', tid(r))!;
    expect(got.chatId).toBe(tid(r));
    expect(got.target.text).toBe('I can do Wednesday afternoon');
    expect(texts(got.before)).toEqual([
      'SENTINEL_WA_ROW_58 note number 58 about the plan',
      'SENTINEL_WA_ROW_59 note number 59 about the plan',
    ]);
    expect(texts(got.after)).toEqual([
      'voice:SENTINEL_TRANSCRIPT let us meet on Thursday',
      'can we move it to 5pm instead?',
    ]);
    expect(r.wa.context(r.world.fixture.rowids.fromMeRecent, 0, 0, Q30, 'trigger_chat', tid(r))).toMatchObject({
      before: [],
      after: [],
    });
  });
  it('another chat is out of scope in trigger_chat and visible in all_chats; hidden / missing / invisible rows => null', () => {
    const r = rig();
    const other = r.world.fixture.rowids.otherAddress;
    expect(r.wa.context(other, 1, 1, Q30, 'trigger_chat', tid(r))).toBeNull();
    expect(r.wa.context(other, 1, 1, Q30, 'all_chats', tid(r))?.chatId).toBe(r.world.other.chatId);
    expect(r.wa.context(999_999, 1, 1, Q30, 'all_chats', tid(r))).toBeNull();
    expect(r.wa.context(-1, 1, 1, Q30, 'all_chats', tid(r))).toBeNull();
    const groupRow = r.fake.maxRowid(); // the last seeded rows are group/status/... - find one by search
    expect(groupRow).toBeGreaterThan(0);
    for (const rowid of Array.from({ length: r.fake.maxRowid() }, (_, i) => i + 1)) {
      const got = r.wa.context(rowid, 0, 0, Q90, 'all_chats', tid(r));
      if (got === null) continue;
      expect([tid(r), r.world.other.chatId, r.world.fixture.lidChatId]).toContain(got.chatId);
      expect(got.target.text + (got.target.voice?.transcript ?? '')).not.toMatch(
        /SENTINEL_(GROUP|STATUS|NEWSLETTER|STRANGER|NEVER|DELETED|GARBAGE)/,
      );
    }
    expect(
      r.wa.context(r.world.fixture.rowids.triggerMessage, 1, 1, { nowMs: NOW, windowMs: 1 }, 'trigger_chat', tid(r)),
    ).toBeNull();
  });
  it('finds the after-neighbours below many newer rows, and gives up (after = []) past the scan cap', () => {
    const r = rig();
    r.fake.seedBulk({ chatJid: WA_WORLD_JIDS.trigger, rows: 450, startTs: NOW - 60_000, stepMs: 1 });
    const got = r.wa.context(r.world.fixture.rowids.fromMeRecent, 0, 2, Q30, 'trigger_chat', tid(r))!;
    expect(texts(got.after)).toEqual([
      'voice:SENTINEL_TRANSCRIPT let us meet on Thursday',
      'can we move it to 5pm instead?',
    ]);
    const cap = rig();
    cap.fake.seedBulk({ chatJid: WA_WORLD_JIDS.trigger, rows: 2_100, startTs: NOW - 60_000, stepMs: 1 });
    expect(cap.wa.context(cap.world.fixture.rowids.fromMeRecent, 1, 2, Q30, 'trigger_chat', tid(cap))!.after).toEqual(
      [],
    );
  });
});

describe('recentChats - DM only, visible only, newest activity first', () => {
  it('lists the visible DM chats with their last visible row (raw text)', () => {
    const r = rig();
    const chats = r.wa.recentChats(Q30, 10);
    expect(chats.map((c) => c.chatId)).toEqual([r.world.fixture.lidChatId, r.world.other.chatId, tid(r)]); // MAX(rowid) order, no timestamp math
    expect(chats[2]).toMatchObject({ lastRole: 'contact', lastText: 'can we move it to 5pm instead?' });
    expect(r.wa.recentChats(Q30, 1)).toHaveLength(1);
    expect(r.wa.recentChats(Q30, 0)).toEqual([]);
  });
  it('a chat whose rows are all outside the window, and an unmapped @lid chat, are skipped', () => {
    const r = rig();
    r.fake.addMessage({
      id: 'UNMAPPED1',
      chatJid: '972550000077@lid',
      sender: '972550000077',
      content: 'unmapped lid',
      fromMe: false,
      timestamp: r.fake.formatTs(new Date(NOW - 60_000)),
    });
    const chats = r.wa.recentChats({ nowMs: NOW, windowMs: 36 * 3_600_000 }, 10);
    expect(chats.map((c) => c.chatId)).toEqual([r.world.fixture.lidChatId, r.world.other.chatId, tid(r)]); // MAX(rowid) order, no timestamp math
    expect(r.wa.recentChats({ nowMs: NOW, windowMs: 10 * 60_000 }, 10).map((c) => c.chatId)).toEqual([tid(r)]);
  });
  it('a voice last row reports its transcript as the last text', () => {
    const r = rig();
    r.transcripts.set(
      `${WA_WORLD_JIDS.other}|OAUD`,
      transcript({ chatJid: WA_WORLD_JIDS.other, waMsgId: 'OAUD', text: 'other voice' }),
    );
    r.fake.seedMediaRow({
      chatJid: WA_WORLD_JIDS.other,
      id: 'OAUD',
      mediaType: 'audio',
      ts: new Date(NOW - 60_000),
      fromMe: true,
    });
    const first = r.wa.recentChats(Q30, 1)[0]!;
    expect(first).toMatchObject({ chatId: r.world.other.chatId, lastRole: 'me', lastText: 'other voice' });
  });
});

describe('SQLITE_BUSY => [] / null, never a throw; other errors propagate', () => {
  it('answers empty while the bridge holds an exclusive lock longer than busy_timeout', async () => {
    const r = rig();
    r.bridge.open();
    const lock = r.fake.holdWriteLock(2_600);
    expect(r.wa.chatMessages(tid(r), null, 5, Q30)).toEqual([]);
    expect(r.wa.search('plan', tid(r), 5, Q30, 'trigger_chat')).toEqual([]);
    expect(r.wa.context(r.world.fixture.rowids.triggerMessage, 1, 1, Q30, 'trigger_chat', tid(r))).toBeNull();
    expect(r.wa.recentChats(Q30, 5)).toEqual([]);
    await lock;
    expect(r.wa.chatMessages(tid(r), null, 5, Q30)).toHaveLength(5);
  }, 20_000);
  it('a non-busy failure below the facade propagates (the gate maps it to unavailable)', () => {
    const r = rig();
    const broken = {
      ...r.bridge,
      messagesBefore: (): BridgeMessageRowV2[] => {
        throw new Error('disk I/O error');
      },
    } as BridgeDb;
    const wa = createWaReadClient({
      bridgeDb: broken,
      chats: r.repos.chats,
      transcripts: { get: () => null },
      settings: () => r.settings,
    });
    expect(() => wa.chatMessages(tid(r), null, 5, Q30)).toThrow(/disk I\/O/);
    const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
    const locked = {
      ...r.bridge,
      recentDmChats: (): never => {
        throw busy;
      },
      phoneJidForLid: (): never => {
        throw Object.assign(new Error('locked'), { errcode: 6 });
      },
    } as BridgeDb;
    const wa2 = createWaReadClient({
      bridgeDb: locked,
      chats: r.repos.chats,
      transcripts: { get: () => null },
      settings: () => r.settings,
    });
    expect(wa2.recentChats(Q30, 5)).toEqual([]);
    const row = r.bridge.messageByRowid(r.world.fixture.rowids.otherAddress)!;
    const lidRow = { ...row, chat_jid: '972550000088@lid' };
    const wa3 = createWaReadClient({
      bridgeDb: { ...locked, messageByRowid: () => lidRow } as BridgeDb,
      chats: r.repos.chats,
      transcripts: { get: () => null },
      settings: () => r.settings,
    });
    expect(wa3.context(row.rowid, 1, 1, Q30, 'all_chats', tid(r))).toBeNull();
  });
});

describe('defensive edges', () => {
  it('NULL media_type / NULL content rows: a NULL media type is plain text, a NULL-content text row is invisible', async () => {
    const r = rig();
    r.fake.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(r.fake.path);
    const at = String(r.fake.formatTs(new Date(NOW - 30_000)));
    raw
      .prepare(
        `INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, deleted_at) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`,
      )
      .run('NULLMT1', WA_WORLD_JIDS.trigger, '972550000011', 'null media type row', at);
    raw
      .prepare(
        `INSERT INTO messages(id, chat_jid, sender, content, timestamp, is_from_me, media_type, deleted_at) VALUES (?, ?, ?, NULL, ?, 0, '', NULL)`,
      )
      .run('NULLCT1', WA_WORLD_JIDS.trigger, '972550000011', at);
    raw.close();
    const last = r.wa.chatMessages(tid(r), null, 2, Q30);
    expect(texts(last)).toEqual(['can we move it to 5pm instead?', 'null media type row']);
    expect(last[1]!.mediaType).toBe('');
  });
  it('an every-chat search skips a DM JID with no app chat and hidden rows, and stops at n', () => {
    const r = rig();
    r.fake.addMessage({
      id: 'NOAPP1',
      chatJid: '972550000066@s.whatsapp.net',
      sender: '972550000066',
      content: 'plan from a jid the app never saw',
      fromMe: false,
      timestamp: r.fake.formatTs(new Date(NOW - 60_000)),
    });
    const hits = r.wa.search('plan', null, 2, Q30, 'all_chats');
    expect(hits).toHaveLength(2);
    expect(hits.map((m) => m.chatJid)).toEqual([WA_WORLD_JIDS.trigger, WA_WORLD_JIDS.trigger]);
    // matches exist only OUTSIDE the window in a visible chat: every candidate is dropped
    expect(r.wa.search('SENTINEL_WA_ROW_1 ', null, 5, Q30, 'all_chats')).toEqual([]);
  });
  it('a target whose chat walk comes back short (row vanished between reads) yields no neighbours instead of wrong ones', () => {
    const r = rig();
    const gone = { ...r.bridge, messagesBefore: (): BridgeMessageRowV2[] => [] } as BridgeDb;
    const wa = createWaReadClient({
      bridgeDb: gone,
      chats: r.repos.chats,
      transcripts: { get: () => null },
      settings: () => r.settings,
    });
    const got = wa.context(r.world.fixture.rowids.fromMeRecent, 2, 2, Q30, 'trigger_chat', tid(r))!;
    expect(got).toMatchObject({ before: [], after: [] });
    expect(got.target.text).toBe('I can do Wednesday afternoon');
  });
});
