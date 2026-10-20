// [v4 T3 follow-up] Ingest.reanalyseChat (v4-calendar-handover 2.1, Refresh): a chat active in the last 24 h with NO open item is
// analysed again by re-running ingest's OWN inbound path (handleInbound: Stage 0, backlog gate, holds, item creation, trigger
// kind, queue row) for the chat's newest trigger-eligible row. Real app DB, real bridge DB reader over the fake store, virtual clock,
// injected Stage 0 stand-in (same as ingest.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeDb } from './bridgeDb';
import { createIngest, type Ingest } from './ingest';
import { createRepos, openDb, type Repos } from '../db/index';
import { createFakeBridgeDb, type FakeBridgeDb } from '../../../tests/fakes/fake-bridge-db';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import type { Logger } from '../deps';
import type { Stage0Fn, Stage0Input, Stage0Verdict } from '../agent/stage0';
import { LIMITS, type ChatRef, type EpochMs, type Result } from '../../shared/types';
import { REFRESH_COOLDOWN_MS, createRefreshService } from '../ipc/handlers/dashboard';

const NOW = Date.UTC(2026, 9, 19, 9, 0, 0);
const HOUR = 3_600_000;
const CHAT_A = '972550000001@s.whatsapp.net';

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

/** Stage 0 stand-in mirroring the real gate order that matters here: backlog, policy 'never', unknown sender. */
const stage0 =
  (repos: Repos): Stage0Fn =>
  (i: Stage0Input): Stage0Verdict => {
    if (!i.isLive) return { kind: 'context_only' };
    const chat = repos.chats.byId(i.chat.id) ?? i.chat;
    if (chat.policy === 'never') return { kind: 'no_item' };
    if (!chat.isKnown && !chat.forceKnown) return { kind: 'held', reason: 'unknown_sender' };
    return { kind: 'queued' };
  };

interface Harness {
  repos: Repos;
  fake: FakeBridgeDb;
  clock: VirtualClock;
  ingest: Ingest;
  changed: number[][];
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      /* already closed */
    }
  }
});

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wca-reanalyse-'));
  const path = join(dir, 'store', 'messages.db');
  const fake = createFakeBridgeDb({ path, now: new Date(NOW) });
  const bridgeDb = createBridgeDb(path);
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const changed: number[][] = [];
  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: stage0(repos),
    settings: () => repos.settings.get(),
    clock,
    log: silentLog,
    onTsFormatError: () => undefined,
    notifyChanged: (ids) => void changed.push(ids),
    bridgeOnlineOnce: () => true,
    syncing: () => false,
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
  return { repos, fake, clock, ingest, changed };
}

const ts = (h: Harness, at: number): string | number => h.fake.formatTs(new Date(at));
function inbound(h: Harness, id: string, agoMs: number, p: { mediaType?: string; content?: string } = {}): void {
  h.fake.addMessage({
    id,
    chatJid: CHAT_A,
    sender: '972550000001',
    content: p.content ?? 'coffee Thursday at 5?',
    fromMe: false,
    timestamp: ts(h, NOW - agoMs),
    ...(p.mediaType === undefined ? {} : { mediaType: p.mediaType }),
  });
}
/** Scans the store, then closes the chat's open item with `reason` and empties the queue: "a chat with no open item". */
async function scannedThenClosed(h: Harness, reason: 'not_needed' | 'dismissed', known = true): Promise<ChatRef> {
  h.repos.chats.upsertFromBridge(CHAT_A, null, known, NOW as EpochMs);
  await h.ingest.scanNow();
  const chat = h.repos.chats.byJid(CHAT_A)!;
  const open = h.repos.items.openForChat(chat.id);
  if (open !== null) h.repos.items.update(open.id, { closedReason: reason, closedAt: NOW as EpochMs }, NOW as EpochMs);
  while (h.repos.queue.size() > 0) {
    const e = h.repos.queue.nextDue(Number.MAX_SAFE_INTEGER as EpochMs)!;
    h.repos.queue.remove(e.chatId, e.rev);
  }
  expect(h.repos.items.openForChat(chat.id)).toBeNull();
  return chat.id;
}
const itemCount = (h: Harness): number => h.repos.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM items`).get()!.n;

describe('Ingest.reanalyseChat', () => {
  it('a closed chat whose newest inbound row has no card yet gets ONE new open item (queued, trigger = newest row) and a queue row', async () => {
    const h = harness();
    inbound(h, 'm1', 3 * HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    inbound(h, 'm2', HOUR); // stored, but no card was made from it yet (e.g. it arrived as context during a history sync)
    const before = itemCount(h);
    const res = h.ingest.reanalyseChat!(chatId);
    expect(res.outcome).toBe('queued');
    const item = h.repos.items.openForChat(chatId)!;
    expect(res.itemId).toBe(item.id);
    expect(itemCount(h)).toBe(before + 1);
    expect(item.analysis).toBe('queued');
    expect(item.triggerMsgId).toBe('m2');
    expect(item.triggerTs).toBe(NOW - HOUR);
    expect(item.triggerKind).toBe('text');
    expect(h.repos.queue.size()).toBe(1);
    expect(h.repos.queue.nextDue(Number.MAX_SAFE_INTEGER as EpochMs)?.chatId).toBe(chatId);
  });

  it('the trigger kind follows ingest (a voice note newest => voice)', async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    inbound(h, 'v1', HOUR, { mediaType: 'audio', content: '' });
    const res = h.ingest.reanalyseChat!(chatId);
    expect(res.outcome).toBe('queued');
    expect(h.repos.items.openForChat(chatId)?.triggerKind).toBe('voice');
  });

  it('a chat whose newest inbound row is older than 24 h => nothing (backlog rule), no item, no queue row', async () => {
    const h = harness();
    inbound(h, 'm1', LIMITS.syncMaxAgeMs + HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    const before = itemCount(h);
    expect(h.ingest.reanalyseChat!(chatId)).toEqual({ outcome: 'nothing', itemId: null });
    expect(itemCount(h)).toBe(before);
    expect(h.repos.queue.size()).toBe(0);
  });

  it('[review fix] the newest (closed, no-action) card was already made from the newest inbound row => nothing, no item, no queue row', async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    inbound(h, 'm2', HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    expect(h.ingest.newestInboundMsgId!(chatId)).toBe('m2');
    const before = itemCount(h);
    expect(h.ingest.reanalyseChat!(chatId)).toEqual({ outcome: 'nothing', itemId: null });
    expect(itemCount(h)).toBe(before);
    expect(h.repos.queue.size()).toBe(0);
  });

  it('[review fix] a dismissed newest card is a user decision: Refresh never brings it back; a NEW message still makes a card via ingest', async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    const chatId = await scannedThenClosed(h, 'dismissed');
    const before = itemCount(h);
    expect(h.ingest.reanalyseChat!(chatId)).toEqual({ outcome: 'nothing', itemId: null });
    // a stored row without a card (context during a sync) does not resurrect the dismissed chat from Refresh either
    inbound(h, 'm2', HOUR);
    expect(h.ingest.reanalyseChat!(chatId)).toEqual({ outcome: 'nothing', itemId: null });
    expect(itemCount(h)).toBe(before);
    expect(h.repos.queue.size()).toBe(0);
    // ...but a NEW live message still produces a card through normal ingest
    inbound(h, 'm3', 60_000);
    await h.ingest.scanNow();
    expect(h.repos.items.openForChat(chatId)?.triggerMsgId).toBe('m3');
  });

  it('newestInboundMsgId: the newest trigger-eligible row when inbound; null when the user wrote last or the chat is unknown', async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    expect(h.ingest.newestInboundMsgId!(chatId)).toBe('m1');
    h.fake.addMessage({
      id: 'me1',
      chatJid: CHAT_A,
      sender: '972550000000',
      content: 'ok',
      fromMe: true,
      timestamp: ts(h, NOW - HOUR),
    });
    expect(h.ingest.newestInboundMsgId!(chatId)).toBeNull();
    expect(h.ingest.newestInboundMsgId!(99_999 as ChatRef)).toBeNull();
  });

  it("policy 'never' => nothing (Stage 0 no_item), no item", async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    inbound(h, 'm2', HOUR); // no card yet: only Stage 0 can refuse it
    h.repos.chats.setPolicy(chatId, 'never');
    const before = itemCount(h);
    expect(h.ingest.reanalyseChat!(chatId).outcome).toBe('nothing');
    expect(itemCount(h)).toBe(before);
  });

  it('an unknown sender is held exactly as ingest holds it (raw card, no queue row)', async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed', false);
    inbound(h, 'm2', HOUR);
    const res = h.ingest.reanalyseChat!(chatId);
    expect(res.outcome).toBe('held');
    const item = h.repos.items.openForChat(chatId)!;
    expect(item.analysis).toBe('held');
    expect(item.holdReason).toBe('unknown_sender');
    expect(h.repos.queue.size()).toBe(0);
  });

  it("the user's own row is newest (the chat was answered) => nothing", async () => {
    const h = harness();
    inbound(h, 'm1', 2 * HOUR);
    const chatId = await scannedThenClosed(h, 'not_needed');
    h.fake.addMessage({
      id: 'me1',
      chatJid: CHAT_A,
      sender: '972550000000',
      content: 'sure, see you',
      fromMe: true,
      timestamp: ts(h, NOW - HOUR),
    });
    expect(h.ingest.reanalyseChat!(chatId).outcome).toBe('nothing');
    expect(h.repos.items.openForChat(chatId)).toBeNull();
  });

  it('a chat that already has an open item, or an unknown chat id => nothing', async () => {
    const h = harness();
    inbound(h, 'm1', HOUR);
    h.repos.chats.upsertFromBridge(CHAT_A, null, true, NOW as EpochMs);
    await h.ingest.scanNow();
    const chatId = h.repos.chats.byJid(CHAT_A)!.id;
    const before = itemCount(h);
    expect(h.ingest.reanalyseChat!(chatId).outcome).toBe('nothing');
    expect(h.ingest.reanalyseChat!(99_999 as ChatRef).outcome).toBe('nothing');
    expect(itemCount(h)).toBe(before);
  });
});

describe('[review fix] Refresh over the real ingest: no-action chats cost nothing', () => {
  it('three presses in 90 s on 20 no-action chats charge zero runs (no item, no queue row, no retriage)', async () => {
    const h = harness();
    const jids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const jid = `9725500000${String(10 + i)}@s.whatsapp.net`;
      jids.push(jid);
      h.repos.chats.upsertFromBridge(jid, null, true, NOW as EpochMs);
      h.fake.addMessage({
        id: `n${i}`,
        chatJid: jid,
        sender: jid.split('@')[0]!,
        content: 'thanks!',
        fromMe: false,
        timestamp: ts(h, NOW - (i + 1) * 60_000),
      });
    }
    await h.ingest.scanNow();
    // the agent decided "no action" on every card: closed as not_needed (status 'ignored')
    for (const jid of jids) {
      const chat = h.repos.chats.byJid(jid)!;
      const open = h.repos.items.openForChat(chat.id)!;
      h.repos.items.update(open.id, { closedReason: 'not_needed', closedAt: NOW as EpochMs }, NOW as EpochMs);
    }
    while (h.repos.queue.size() > 0) {
      const e = h.repos.queue.nextDue(Number.MAX_SAFE_INTEGER as EpochMs)!;
      h.repos.queue.remove(e.chatId, e.rev);
    }
    const before = itemCount(h);
    const retriage = vi.fn((): Result<unknown> => ({ ok: true, value: null }));
    const poke = vi.fn();
    const svc = createRefreshService({
      ingest: h.ingest,
      repos: h.repos,
      items: { retriage },
      queue: { poke },
      clock: h.clock,
      log: silentLog,
      audit: () => undefined,
      notifyChanged: () => undefined,
    });
    for (let press = 0; press < 3; press += 1) {
      const report = await svc.refreshNow();
      expect(report).toMatchObject({ cooldown: false, queued: 0, skippedRateLimited: 0, skippedNothingToAnalyse: 20 });
      await h.clock.advance(REFRESH_COOLDOWN_MS);
    }
    expect(itemCount(h)).toBe(before);
    expect(h.repos.queue.size()).toBe(0);
    expect(retriage).not.toHaveBeenCalled();
    expect(poke).not.toHaveBeenCalled();
    expect(h.repos.rate.countSince('llm_global', 'global', (NOW - HOUR) as EpochMs)).toBe(0);
  });
});
