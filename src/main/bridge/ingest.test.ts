// TESTS 5.3 row `bridge/bridgeDb.ts, ingest.ts` + the backlog-gate cases of TESTS 8.2 item 11 that belong to ingest.
// Real app DB (`openDb(':memory:')` + `createRepos`), real bridge DB reader, fake bridge store, virtual clock, injected Stage 0.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb, type BridgeDb } from './bridgeDb';
import { createIngest, type Ingest } from './ingest';
import { createRepos, openDb, type Db, type Repos } from '../db/index';
import { createFakeBridgeDb, type FakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../deps';
import type { Stage0Fn, Stage0Input, Stage0Verdict } from '../agent/stage0';
import { LIMITS } from '../../shared/types';
import type { ActionId, ChatRef, ItemId } from '../../shared/types';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const DAY = 24 * 3_600_000;
const CHAT_A = '972550000001@s.whatsapp.net';
const CHAT_B = '972550000002@s.whatsapp.net';
const LID = '55500001@lid';

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

interface Harness {
  repos: Repos;
  db: Db;
  bridgeDb: BridgeDb;
  fake: FakeBridgeDb;
  clock: VirtualClock;
  ingest: Ingest;
  seen: Stage0Input[];
  changed: number[][];
  tsErrors: boolean[];
  setVerdict(fn: Stage0Fn): void;
  setSyncing(v: boolean): void;
  setOnline(v: boolean): void;
}

const cleanups: Array<() => void> = [];

/** The default stand-in for agent/stage0.ts (W1-10): context-only off-gate, held for strangers, queued otherwise. */
const defaultVerdict: Stage0Fn = (i: Stage0Input): Stage0Verdict => {
  if (!i.isLive) return { kind: 'context_only' };
  if (!i.chat.isKnown && !i.chat.forceKnown) return { kind: 'held', reason: 'unknown_sender' };
  return { kind: 'queued' };
};

function harness(opts: { storePath?: string; missingStore?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wca-ingest-'));
  const path = opts.storePath ?? join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  if (opts.missingStore) fake.close();
  const bridgeDb = createBridgeDb(opts.missingStore ? join(dir, 'nothing', 'messages.db') : path);
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const seen: Stage0Input[] = [];
  const changed: number[][] = [];
  const tsErrors: boolean[] = [];
  let verdict = defaultVerdict;
  let syncing = false;
  let online = true;

  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: (input) => {
      seen.push(input);
      return verdict(input);
    },
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: (active) => void tsErrors.push(active),
    notifyChanged: (ids) => void changed.push(ids),
    bridgeOnlineOnce: () => online,
    syncing: () => syncing,
  });

  cleanups.push(() => {
    bridgeDb.close();
    fake.close();
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  });

  return {
    repos,
    db,
    bridgeDb,
    fake,
    clock,
    ingest,
    seen,
    changed,
    tsErrors,
    setVerdict: (fn) => void (verdict = fn),
    setSyncing: (v) => void (syncing = v),
    setOnline: (v) => void (online = v),
  };
}

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      /* already closed */
    }
  }
  vi.restoreAllMocks();
});

const goTs = (fake: FakeBridgeDb, at: number): string | number => fake.formatTs(new Date(at));

describe('ingest - scanning and the watermark', () => {
  it('is a no-op when the store file does not exist yet', async () => {
    const h = harness({ missingStore: true });
    const stats = await h.ingest.scanNow();
    expect(stats).toEqual({ scanned: 0, kept: 0, unparseableTs: 0, watermark: 0, olderLive: 0 });
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBeNull();
  });

  it('creates a chat, an item and a queue row for a live inbound DM', async () => {
    const h = harness();
    h.fake.addChat(CHAT_A, 'Dana');
    h.fake.addMessage({
      id: 'm1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'coffee Thursday at 5?',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 60_000),
    });
    h.repos.chats.upsertFromBridge(CHAT_A, 'Dana', true, NOW); // known chat

    const stats = await h.ingest.scanNow();

    expect(stats.scanned).toBe(1);
    expect(stats.kept).toBe(1);
    expect(stats.olderLive).toBe(0);
    const chat = h.repos.chats.byJid(CHAT_A);
    expect(chat?.displayName).toBe('Dana');
    const item = h.repos.items.openForChat(chat!.id);
    expect(item?.analysis).toBe('queued');
    expect(item?.triggerMsgId).toBe('m1');
    expect(item?.triggerTs).toBe(NOW - 60_000);
    expect(h.repos.queue.size()).toBe(1);
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe(String(stats.watermark));
    expect(h.changed).toEqual([[item!.id]]);
  });

  it('pages through more than one batch of LIMITS.ingestBatch rows', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    const total = LIMITS.ingestBatch + 37;
    for (let i = 0; i < total; i++) {
      h.fake.addMessage({
        id: `m${i}`,
        chatJid: CHAT_A,
        sender: '972550000001',
        content: `hi ${i}`,
        fromMe: false,
        timestamp: goTs(h.fake, NOW - 60_000),
      });
    }
    const stats = await h.ingest.scanNow();
    expect(stats.scanned).toBe(total);
    expect(stats.watermark).toBe(h.fake.maxRowid());
    expect(h.repos.queue.size()).toBe(1); // one chat = one unit of work
  });

  it('coalesces overlapping scans and re-runs once when rows arrived meanwhile', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'm1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'one',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    const a = h.ingest.scanNow();
    const b = h.ingest.scanNow();
    expect(await a).toBe(await b);
    await h.clock.advance(LIMITS.pokeDebounceMs + 1);
  });

  it('resets the watermark when the store was wiped, without re-triaging', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    for (let i = 0; i < 4; i++) {
      h.fake.addMessage({
        id: `m${i}`,
        chatJid: CHAT_A,
        sender: '972550000001',
        content: `hello ${i}`,
        fromMe: false,
        timestamp: goTs(h.fake, NOW),
      });
    }
    const before = await h.ingest.scanNow();
    expect(before.watermark).toBeGreaterThan(1);
    const firstItem = h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id);
    expect(firstItem).not.toBeNull();
    h.repos.queue.remove(h.repos.chats.byJid(CHAT_A)!.id);

    // the store is wiped and re-synced with OLD rows: rowids restart below the watermark
    h.fake.wipe();
    h.repos.meta.set('live_from_ts', String(NOW - 60_000));
    h.fake.addMessage({
      id: 'old1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'ancient',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 30 * DAY),
    });

    const stats = await h.ingest.scanNow();
    expect(stats.scanned).toBe(1);
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe(String(stats.watermark));
    expect(h.repos.queue.size()).toBe(0); // backlog gate kept it context-only
    expect(h.seen.at(-1)?.isLive).toBe(false);
  });

  it('keeps the watermark and the item writes in ONE transaction', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'm1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'boom',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    h.setVerdict(() => {
      throw new Error('kill between steps');
    });
    await expect(h.ingest.scanNow()).rejects.toThrow('kill between steps');
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBeNull();
    expect(h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id)).toBeNull();
  });

  it('retries at the next trigger when the bridge DB is busy instead of crashing', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'm1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'hi',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    const spy = vi.spyOn(h.bridgeDb, 'rowsAfter').mockImplementationOnce(() => {
      throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    });

    const busy = await h.ingest.scanNow();
    expect(busy.scanned).toBe(0);
    expect(h.repos.queue.size()).toBe(0);
    spy.mockRestore();

    const later = await h.ingest.scanNow();
    expect(later.scanned).toBe(1);
    expect(h.repos.queue.size()).toBe(1);
  });

  it('propagates a non-busy failure instead of swallowing it', async () => {
    const h = harness();
    vi.spyOn(h.bridgeDb, 'maxRowid').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    await expect(h.ingest.scanNow()).rejects.toThrow('disk on fire');
  });
});

describe('ingest - deterministic row filter (PIPELINE 1.3 item 1)', () => {
  it.each([
    ['a group chat', '972550000001-1600000000@g.us'],
    ['status broadcast', 'status@broadcast'],
    ['a newsletter', '120363000000000000@newsletter'],
    ['a broadcast list', '972550000001@broadcast'],
  ])('drops %s entirely', async (_label, jid) => {
    const h = harness();
    h.fake.addMessage({
      id: 'm1',
      chatJid: jid,
      sender: '972550000001',
      content: 'hello',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    const stats = await h.ingest.scanNow();
    expect(stats.scanned).toBe(1);
    expect(stats.kept).toBe(0);
    expect(h.repos.chats.byJid(jid)).toBeNull();
    expect(h.seen).toHaveLength(0);
  });

  it.each([
    ['a reaction', { mediaType: 'reaction', content: '\u{1F44D}' }],
    ['an empty row', { content: '' }],
    ['a whitespace-only row', { content: '   ' }],
    ['a deleted row', { content: 'was here', deleted: true }],
  ])('never triggers on %s', async (_label, extra) => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage(
      Object.assign(
        { id: 'm1', chatJid: CHAT_A, sender: '972550000001', fromMe: false, content: '', timestamp: goTs(h.fake, NOW) },
        extra,
      ),
    );
    const stats = await h.ingest.scanNow();
    expect(stats.scanned).toBe(1);
    expect(stats.kept).toBe(0);
    expect(h.seen).toHaveLength(0);
    expect(h.repos.queue.size()).toBe(0);
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBe(String(stats.watermark));
  });

  it('lets the newest eligible row of a burst decide', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    for (const text of ['coffee?', 'thursday?', 'at 5?']) {
      h.fake.addMessage({
        id: `m-${text}`,
        chatJid: CHAT_A,
        sender: '972550000001',
        content: text,
        fromMe: false,
        timestamp: goTs(h.fake, NOW),
      });
    }
    h.fake.addMessage({
      id: 'r',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: '\u{1F44D}',
      fromMe: false,
      mediaType: 'reaction',
      timestamp: goTs(h.fake, NOW),
    });
    await h.ingest.scanNow();
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.message.text).toBe('at 5?');
    expect(h.repos.queue.size()).toBe(1);
  });
});

describe('ingest - is_known (A13) and @lid resolution', () => {
  it('marks a chat known from an own text row and not from an own reaction', async () => {
    const known = harness();
    known.fake.addMessage({
      id: 'own',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'sure',
      fromMe: true,
      timestamp: goTs(known.fake, NOW - 5 * 60_000),
    });
    known.fake.addMessage({
      id: 'in',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'and after?',
      fromMe: false,
      timestamp: goTs(known.fake, NOW),
    });
    await known.ingest.scanNow();
    expect(known.repos.chats.byJid(CHAT_A)?.isKnown).toBe(true);
    expect(known.seen[0]?.chat.isKnown).toBe(true);

    const stranger = harness();
    stranger.fake.addMessage({
      id: 'own',
      chatJid: CHAT_B,
      sender: 'me',
      content: '\u{1F44D}',
      fromMe: true,
      mediaType: 'reaction',
      timestamp: goTs(stranger.fake, NOW - 5 * 60_000),
    });
    stranger.fake.addMessage({
      id: 'in',
      chatJid: CHAT_B,
      sender: '972550000002',
      content: 'hello?',
      fromMe: false,
      timestamp: goTs(stranger.fake, NOW),
    });
    await stranger.ingest.scanNow();
    expect(stranger.repos.chats.byJid(CHAT_B)?.isKnown).toBe(false);
    const item = stranger.repos.items.openForChat(stranger.repos.chats.byJid(CHAT_B)!.id);
    expect(item?.analysis).toBe('held');
    expect(item?.holdReason).toBe('unknown_sender');
    expect(stranger.repos.queue.size()).toBe(0);
  });

  it('keys an @lid chat on its phone JID and ORs is_known over both forms', async () => {
    const h = harness();
    h.fake.addLidMapping(LID, CHAT_A);
    h.fake.addMessage({
      id: 'own',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'earlier',
      fromMe: true,
      timestamp: goTs(h.fake, NOW - 60 * 60_000),
    });
    h.fake.addMessage({
      id: 'in',
      chatJid: LID,
      sender: '55500001',
      content: 'hello again',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    await h.ingest.scanNow();
    expect(h.repos.chats.byJid(LID)).toBeNull();
    const chat = h.repos.chats.byJid(CHAT_A);
    expect(chat?.isKnown).toBe(true);
    expect(chat?.sendable).toBe(true);
    expect(h.repos.items.openForChat(chat!.id)?.analysis).toBe('queued');
  });

  it('leaves an unmapped @lid chat under its @lid JID', async () => {
    const h = harness();
    h.fake.addMessage({
      id: 'in',
      chatJid: LID,
      sender: '55500001',
      content: 'hello',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    await h.ingest.scanNow();
    const chat = h.repos.chats.byJid(LID);
    expect(chat).not.toBeNull();
    expect(chat?.sendable).toBe(false);
  });

  it('resolveLidChats() merges stored @lid chats once a mapping appears', async () => {
    const h = harness();
    h.fake.addMessage({
      id: 'in',
      chatJid: LID,
      sender: '55500001',
      content: 'hello',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    await h.ingest.scanNow();
    const lidChat = h.repos.chats.byJid(LID);
    expect(lidChat).not.toBeNull();

    expect(await h.ingest.resolveLidChats()).toEqual({ merged: 0 });
    h.fake.addLidMapping(LID, CHAT_A);
    expect(await h.ingest.resolveLidChats()).toEqual({ merged: 1 });

    expect(h.repos.chats.byJid(LID)).toBeNull();
    const phoneChat = h.repos.chats.byJid(CHAT_A);
    expect(phoneChat?.id).toBe(lidChat?.id);
    expect(h.repos.items.openForChat(phoneChat!.id)).not.toBeNull();
  });

  it('[repair] contextFor still finds the messages after the chat was re-keyed off its @lid JID', async () => {
    // The triage run that the merge schedules must NOT be fed an empty context window (S1 context contract, PIPELINE 1.3).
    const h = harness();
    h.fake.addMessage({
      id: 'in1',
      chatJid: LID,
      sender: '55500001',
      content: 'coffee Sunday at 5?',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 120_000),
    });
    h.fake.addMessage({
      id: 'in2',
      chatJid: LID,
      sender: '55500001',
      content: 'or Monday?',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 60_000),
    });
    h.fake.addLidMapping(LID, CHAT_A);

    await h.ingest.scanNow();

    const chat = h.repos.chats.byJid(CHAT_A);
    expect(chat).not.toBeNull();
    expect(h.repos.chats.byJid(LID)).toBeNull();
    expect(h.ingest.contextFor(chat!.id, 12).map((m) => m.text)).toEqual(['coffee Sunday at 5?', 'or Monday?']);
  });

  it('resolveLidChats() is a no-op without a store', async () => {
    const h = harness({ missingStore: true });
    expect(await h.ingest.resolveLidChats()).toEqual({ merged: 0 });
  });
});

describe('ingest - backlog gate (A14 / [R2])', () => {
  function seedInbound(h: Harness, ageMs: number): void {
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'm1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'coffee Sunday at 5?',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - ageMs),
    });
  }

  it('a 3-day-old row scanned while history is syncing is context-only', async () => {
    const h = harness();
    h.setSyncing(true);
    seedInbound(h, 3 * DAY);
    await h.ingest.scanNow();
    expect(h.seen[0]?.isLive).toBe(false);
    expect(h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id)).toBeNull();
    expect(h.repos.queue.size()).toBe(0);
  });

  it('[repair] a row that arrived while the app was OFF becomes an item even on the first (syncing) scan', async () => {
    // A14 / shared/types.ts:159-161: "a laptop closed over a weekend still gets 'coffee Sunday at 5?' as a card on Monday".
    // compose.ts arms `syncing` on EVERY launch, so this is the first scan of an ordinary session, not a real history re-sync.
    const h = harness();
    h.setSyncing(true);
    h.repos.meta.set('last_online_ts', String(NOW - 3 * DAY)); // the app was last up three days ago
    seedInbound(h, 2 * DAY); // the message arrived two days ago, i.e. AFTER the app went offline
    await h.ingest.scanNow();
    expect(h.seen[0]?.isLive).toBe(true);
    expect(h.seen[0]?.isOlderLive).toBe(false);
    expect(h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id)?.analysis).toBe('queued');
    expect(h.repos.queue.size()).toBe(1);
  });

  it('[repair] a genuine history replay older than last_online_ts stays context-only while syncing', async () => {
    const h = harness();
    h.setSyncing(true);
    h.repos.meta.set('last_online_ts', String(NOW - DAY));
    seedInbound(h, 30 * DAY); // predates the last online window: the app already had its chance to see this row
    await h.ingest.scanNow();
    expect(h.seen[0]?.isLive).toBe(false);
    expect(h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id)).toBeNull();
    expect(h.repos.queue.size()).toBe(0);
  });

  it('a 3-day-old row scanned after the bridge was ONLINE yesterday becomes an item', async () => {
    const h = harness();
    h.repos.meta.set('last_online_ts', String(NOW - DAY));
    seedInbound(h, 3 * DAY);
    await h.ingest.scanNow();
    expect(h.seen[0]?.isLive).toBe(true);
    expect(h.seen[0]?.isOlderLive).toBe(false);
    expect(h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id)?.analysis).toBe('queued');
    expect(h.repos.queue.size()).toBe(1);
  });

  it('a 10-day-old live row becomes a raw card with the older_message badge and NO run', async () => {
    const h = harness();
    seedInbound(h, 10 * DAY);
    const stats = await h.ingest.scanNow();
    expect(stats.olderLive).toBe(1);
    expect(h.seen[0]?.isOlderLive).toBe(true);
    const item = h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id);
    expect(item?.badges).toContain('older_message');
    expect(item?.analysis).toBe('held');
    expect(item?.state).toBe('needs_reply');
    expect(h.repos.queue.size()).toBe(0);
  });

  it('keeps the older_message badge when the same item is touched again', async () => {
    const h = harness();
    seedInbound(h, 10 * DAY);
    await h.ingest.scanNow();
    h.fake.addMessage({
      id: 'm2',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'still there?',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 9 * DAY),
    });
    await h.ingest.scanNow();
    const item = h.repos.items.openForChat(h.repos.chats.byJid(CHAT_A)!.id);
    expect(item?.badges.filter((b) => b === 'older_message')).toHaveLength(1);
    expect(h.repos.queue.size()).toBe(0);
  });

  it('treats rows before live_from_ts as context only, honouring backlogHours', async () => {
    const h = harness();
    h.repos.meta.set('paired_at', String(NOW - 2 * 3_600_000));
    h.repos.settings.patch({ whatsapp: { backlogHours: 1 } });
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'before',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'older than the window',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 4 * 3_600_000),
    });
    await h.ingest.scanNow();
    expect(h.seen[0]?.isLive).toBe(false);
    expect(h.repos.queue.size()).toBe(0);

    h.fake.addMessage({
      id: 'inside',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'inside the window',
      fromMe: false,
      timestamp: goTs(h.fake, NOW - 90 * 60_000),
    });
    await h.ingest.scanNow();
    expect(h.seen[1]?.isLive).toBe(true);
    expect(h.repos.queue.size()).toBe(1);
  });

  it('a 300-row history sync produces zero queue rows', async () => {
    const h = harness();
    h.setSyncing(true);
    h.repos.meta.set('live_from_ts', String(NOW));
    for (let i = 0; i < 300; i++) {
      const jid = i % 2 === 0 ? CHAT_A : CHAT_B;
      h.fake.addMessage({
        id: `h${i}`,
        chatJid: jid,
        sender: jid.slice(0, 12),
        content: `history ${i}`,
        fromMe: i % 3 === 0,
        timestamp: goTs(h.fake, NOW - (i + 1) * 3_600_000),
      });
    }
    const stats = await h.ingest.scanNow();
    expect(stats.scanned).toBe(300);
    expect(h.repos.queue.size()).toBe(0);
    expect(h.repos.items.counts().analysing).toBe(0);
    expect(h.seen.every((s) => !s.isLive)).toBe(true);
  });

  it('treats a row with an unparseable timestamp as backlog', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'bad',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'when?',
      fromMe: false,
      timestamp: 'not-a-timestamp',
    });
    const stats = await h.ingest.scanNow();
    expect(stats.unparseableTs).toBe(1);
    expect(h.seen[0]?.isLive).toBe(false);
    expect(h.repos.queue.size()).toBe(0);
  });

  it('a row timestamped in the future is still live', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'skew',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'clock skew',
      fromMe: false,
      timestamp: goTs(h.fake, NOW + 6 * 3_600_000),
    });
    await h.ingest.scanNow();
    expect(h.seen[0]?.isLive).toBe(true);
    expect(h.repos.queue.size()).toBe(1);
  });
});

describe('ingest - BRIDGE_TS_FORMAT streak', () => {
  it('raises the health error after LIMITS.tsBadStreak consecutive failures and clears it on the next good row', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    for (let i = 0; i < LIMITS.tsBadStreak - 1; i++) {
      h.fake.addMessage({
        id: `b${i}`,
        chatJid: CHAT_A,
        sender: '972550000001',
        content: `x${i}`,
        fromMe: false,
        timestamp: 'garbage',
      });
    }
    await h.ingest.scanNow();
    expect(h.tsErrors).toEqual([]);

    h.fake.addMessage({
      id: 'b-last',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'y',
      fromMe: false,
      timestamp: 'garbage',
    });
    const stats = await h.ingest.scanNow();
    expect(stats.unparseableTs).toBe(1);
    expect(h.tsErrors).toEqual([true]);

    h.fake.addMessage({
      id: 'good',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'z',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });
    await h.ingest.scanNow();
    expect(h.tsErrors).toEqual([true, false]);
  });
});

describe('ingest - outbound rows (ARCHITECTURE 4.6 step 5)', () => {
  function openItemWithPendingReply(h: Harness, text: string): { chatId: ChatRef; itemId: ItemId; actionId: ActionId } {
    const chat = h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    const item = h.repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: 'trigger',
      triggerTs: NOW - 60_000,
      analysis: 'done',
      holdReason: null,
      now: NOW,
    });
    const proposal = h.repos.proposals.insertNext({
      itemId: item.id,
      provider: 'user',
      model: 'test',
      extraction: null,
      draftText: text,
      replyLang: 'en',
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: NOW,
    });
    h.repos.items.update(item.id, { replyState: 'draft', currentProposalId: proposal.id }, NOW);
    const action = h.repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: { v: 1, kind: 'send_reply', itemId: item.id, chatRef: chat.id, proposalVersion: proposal.version, text },
      now: NOW,
    });
    return { chatId: chat.id, itemId: item.id, actionId: action.id };
  }

  it('marks the item answered_elsewhere when the user replied from the phone', async () => {
    const h = harness();
    const { chatId, itemId } = openItemWithPendingReply(h, 'our draft');
    h.fake.addMessage({
      id: 'phone',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'typed on the phone',
      fromMe: true,
      timestamp: goTs(h.fake, NOW),
    });

    await h.ingest.scanNow();

    const item = h.repos.items.byId(itemId);
    expect(item?.replyState).toBe('answered_elsewhere');
    expect(item?.closedReason).toBe('answered_elsewhere');
    expect(item?.state).toBe('ignored');
    expect(h.repos.actions.forItem(itemId)[0]?.state).toBe('superseded');
    expect(h.repos.chats.byId(chatId)?.lastOutboundTs).toBe(NOW);
    expect(h.seen).toHaveLength(0);
  });

  it('keeps an item with a pending event approval open', async () => {
    const h = harness();
    const { itemId } = openItemWithPendingReply(h, 'our draft');
    h.repos.items.update(itemId, { eventState: 'proposed' }, NOW);
    h.fake.addMessage({
      id: 'phone',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'typed on the phone',
      fromMe: true,
      timestamp: goTs(h.fake, NOW),
    });

    await h.ingest.scanNow();

    const item = h.repos.items.byId(itemId);
    expect(item?.replyState).toBe('answered_elsewhere');
    expect(item?.closedReason).toBeNull();
    expect(item?.state).toBe('needs_reply');
  });

  it('supersedes the pending send_reply of an item whose event approval is still pending', async () => {
    // ARCHITECTURE 182 / PIPELINE 62: superseding the draft is UNCONDITIONAL; only the item closure depends on a pending event.
    const h = harness();
    const { chatId, itemId } = openItemWithPendingReply(h, 'our draft');
    const item0 = h.repos.items.byId(itemId)!;
    const eventAction = h.repos.actions.insertPending({
      itemId,
      proposalId: item0.currentProposalId!,
      chatId,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId,
        chatRef: chatId,
        proposalVersion: 1,
        title: 'coffee',
        startLocal: '2026-01-04T17:00:00',
        endLocal: '2026-01-04T18:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: NOW,
    });
    h.repos.items.update(itemId, { eventState: 'proposed' }, NOW);
    h.fake.addMessage({
      id: 'phone',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'typed on the phone',
      fromMe: true,
      timestamp: goTs(h.fake, NOW),
    });

    await h.ingest.scanNow();

    const actions = h.repos.actions.forItem(itemId);
    const reply = actions.find((a) => a.kind === 'send_reply');
    const event = actions.find((a) => a.id === eventAction.id);
    expect(reply?.state).toBe('superseded'); // no approvable duplicate reply survives
    expect(event?.state).toBe('pending'); // the event approval survives, so the card stays open
    expect(h.repos.items.byId(itemId)?.state).toBe('needs_reply');
  });

  it('does NOT flag answered_elsewhere when the row is our own approved send within 120 s', async () => {
    const h = harness();
    const { itemId, actionId } = openItemWithPendingReply(h, 'see you at 5');
    expect(
      h.repos.actions.markApprovedExecuting(
        actionId,
        JSON.stringify({
          v: 1,
          kind: 'send_reply',
          itemId,
          chatRef: h.repos.actions.byId(actionId)!.chatId,
          proposalVersion: 1,
          text: 'see you at 5',
        }),
        NOW,
      ),
    ).toBe('ok');
    h.fake.addMessage({
      id: 'ours',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'see you at 5',
      fromMe: true,
      timestamp: goTs(h.fake, NOW + 30_000),
    });

    await h.ingest.scanNow();

    const item = h.repos.items.byId(itemId);
    expect(item?.replyState).toBe('draft');
    expect(item?.closedReason).toBeNull();
  });

  it('flags answered_elsewhere when our send is older than the 120 s window', async () => {
    const h = harness();
    const { itemId, actionId } = openItemWithPendingReply(h, 'see you at 5');
    h.repos.actions.markApprovedExecuting(
      actionId,
      JSON.stringify({ v: 1, kind: 'send_reply', itemId, chatRef: 1, proposalVersion: 1, text: 'see you at 5' }),
      NOW,
    );
    h.fake.addMessage({
      id: 'late',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'see you at 5',
      fromMe: true,
      timestamp: goTs(h.fake, NOW + LIMITS.reconcileSendWindowMs + 1_000),
    });

    await h.ingest.scanNow();
    expect(h.repos.items.byId(itemId)?.replyState).toBe('answered_elsewhere');
  });

  it('ignores an outbound row in a chat without an open item', async () => {
    const h = harness();
    h.fake.addMessage({
      id: 'own',
      chatJid: CHAT_A,
      sender: 'me',
      content: 'just me',
      fromMe: true,
      timestamp: goTs(h.fake, NOW),
    });
    await h.ingest.scanNow();
    expect(h.repos.chats.byJid(CHAT_A)?.isKnown).toBe(true);
    expect(h.changed).toEqual([]);
  });

  it('[R2] a NEW open item supersedes the pending send_reply of the chat’s other items', async () => {
    const h = harness();
    const { chatId, itemId, actionId } = openItemWithPendingReply(h, 'unsent draft');
    // the old item leaves the open states (it is now "in calendar")
    h.repos.items.update(itemId, { eventState: 'created', calendarEventId: 'evt-1' }, NOW);
    expect(h.repos.items.byId(itemId)?.state).toBe('in_calendar');
    h.fake.addMessage({
      id: 'new',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'one more thing',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });

    await h.ingest.scanNow();

    const fresh = h.repos.items.openForChat(chatId);
    expect(fresh).not.toBeNull();
    expect(fresh?.id).not.toBe(itemId);
    expect(h.repos.actions.byId(actionId)?.state).toBe('superseded');
  });
});

describe('ingest - poke debounce and contextFor', () => {
  it('poke() coalesces into one scan after LIMITS.pokeDebounceMs', async () => {
    const h = harness();
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.fake.addMessage({
      id: 'm1',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: 'hi',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });

    h.ingest.poke();
    h.ingest.poke();
    h.ingest.poke();
    await h.clock.advance(LIMITS.pokeDebounceMs - 1);
    expect(h.repos.meta.get('bridge_rowid_watermark')).toBeNull();

    await h.clock.advance(2);
    await new Promise((r) => setImmediate(r));
    expect(h.repos.meta.get('bridge_rowid_watermark')).not.toBeNull();
    expect(h.repos.queue.size()).toBe(1);
  });

  it('a failing scan behind poke() does not reject an unhandled promise', async () => {
    const h = harness();
    vi.spyOn(h.bridgeDb, 'maxRowid').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    h.ingest.poke();
    await h.clock.advance(LIMITS.pokeDebounceMs + 1);
    await new Promise((r) => setImmediate(r));
  });

  it('contextFor reads the live window of one chat, newest last', async () => {
    const h = harness();
    const chat = h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    h.repos.chats.upsertFromBridge(CHAT_B, null, true, NOW);
    for (let i = 1; i <= 6; i++) {
      h.fake.addMessage({
        id: `a${i}`,
        chatJid: CHAT_A,
        sender: '972550000001',
        content: `msg ${i}`,
        fromMe: i % 2 === 0,
        timestamp: goTs(h.fake, NOW - (10 - i) * 60_000),
      });
    }
    h.fake.addMessage({
      id: 'react',
      chatJid: CHAT_A,
      sender: '972550000001',
      content: '\u{1F44D}',
      fromMe: false,
      mediaType: 'reaction',
      timestamp: goTs(h.fake, NOW),
    });
    h.fake.addMessage({
      id: 'b1',
      chatJid: CHAT_B,
      sender: '972550000002',
      content: 'other chat',
      fromMe: false,
      timestamp: goTs(h.fake, NOW),
    });

    const window = h.ingest.contextFor(chat.id, 3);
    expect(window.map((m) => m.text)).toEqual(['msg 4', 'msg 5', 'msg 6']);
    expect(window.every((m) => m.chatJid === CHAT_A)).toBe(true);
    expect(window.at(-1)?.fromMe).toBe(true);
    expect(window.at(-1)?.ts).toBe(NOW - 4 * 60_000);
  });

  it('contextFor returns nothing for an unknown chat or a missing store', () => {
    const h = harness();
    expect(h.ingest.contextFor(999 as ChatRef, 5)).toEqual([]);
    const missing = harness({ missingStore: true });
    const chat = missing.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW);
    expect(missing.ingest.contextFor(chat.id, 5)).toEqual([]);
  });
});
