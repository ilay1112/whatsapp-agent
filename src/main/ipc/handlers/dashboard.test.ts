// [v4 T3] dashboard:refreshNow (v4-calendar-handover 2.1 + review focus 3). Real app DB (`openDb(':memory:')` + `createRepos`),
// virtual clock, a fake ingest `{scanNow}`, a spy for ItemService.retriage and the queue's doorbell. Refresh only scans and
// queues analysis: it never approves, sends or writes a calendar event (approval-first; nothing here can reach the executor).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepos, openDb, type Repos } from '../../db/index';
import { createVirtualClock, type VirtualClock } from '../../../../tests/helpers/virtualClock';
import type { Logger } from '../../deps';
import type { IngestStats } from '../../bridge/ingest';
import { LIMITS, type ChatRef, type EpochMs, type ItemId, type Result } from '../../../shared/types';
import {
  REFRESH_CHAT_CAP,
  REFRESH_COOLDOWN_MS,
  createDashboardHandlers,
  createRefreshService,
  type RefreshDeps,
} from './dashboard';

const NOW = Date.UTC(2026, 9, 19, 9, 0, 0);
const HOUR = 3_600_000;
const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

const openDbs: Array<ReturnType<typeof openDb>> = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
});

const stats = (kept: number): IngestStats => ({ scanned: kept, kept, unparseableTs: 0, watermark: 0, olderLive: 0 });

function quietLog(): Logger {
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
}

interface Harness {
  repos: Repos;
  clock: VirtualClock;
  deps: RefreshDeps;
  scanNow: ReturnType<typeof vi.fn>;
  retriage: ReturnType<typeof vi.fn>;
  poke: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  notifyChanged: ReturnType<typeof vi.fn>;
  invalidateCalendar: ReturnType<typeof vi.fn>;
  /** item ids whose retriage answers RATE_LIMIT_RETRIAGE */
  rateLimited: Set<number>;
  reanalyseChat: ReturnType<typeof vi.fn>;
  /** chat ids whose reanalyseChat answers this outcome instead of creating a queued item */
  reanalyseAs: Map<number, 'held' | 'nothing'>;
  /** chat id -> the newest inbound row id (default `n<chatId>`: a row newer than the item's `m<chatId>` trigger) */
  newestAs: Map<number, string | null>;
}

function harness(opts: { kept?: number; withCalendar?: boolean } = {}): Harness {
  const db = openDb(':memory:');
  openDbs.push(db);
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW);
  const rateLimited = new Set<number>();
  const scanNow = vi.fn(async () => stats(opts.kept ?? 3));
  // The real ItemService.retriage re-queues the chat; the spy does the same so "queued" is observable in triage_queue.
  const retriage = vi.fn((id: ItemId): Result<unknown> => {
    if (rateLimited.has(id)) return { ok: false, error: { code: 'RATE_LIMIT_RETRIAGE' } };
    const item = repos.items.byId(id)!;
    repos.queue.enqueue(item.chatId, clock.now());
    return { ok: true, value: null };
  });
  const poke = vi.fn();
  const reanalyseAs = new Map<number, 'held' | 'nothing'>();
  // Stand-in for Ingest.reanalyseChat (its own tests: bridge/ingest.reanalyse.test.ts): a new open item + a queue row.
  const reanalyseChat = vi.fn((chatId: ChatRef) => {
    const as = reanalyseAs.get(chatId);
    if (as === 'nothing') return { outcome: 'nothing' as const, itemId: null };
    const it = repos.items.createOpen({
      chatId,
      triggerMsgId: `r${chatId}`,
      triggerTs: NOW as EpochMs,
      analysis: as === 'held' ? 'held' : 'queued',
      holdReason: as === 'held' ? 'unknown_sender' : null,
      now: clock.now(),
    });
    if (as !== 'held') repos.queue.enqueue(chatId, clock.now());
    return { outcome: as ?? ('queued' as const), itemId: it.id };
  });
  const newestAs = new Map<number, string | null>();
  const newestInboundMsgId = vi.fn((chatId: ChatRef) => (newestAs.has(chatId) ? newestAs.get(chatId)! : `n${chatId}`));
  const audit = vi.fn();
  const notifyChanged = vi.fn();
  const invalidateCalendar = vi.fn();
  const deps: RefreshDeps = {
    ingest: { scanNow, reanalyseChat, newestInboundMsgId },
    repos,
    items: { retriage },
    queue: { poke },
    clock,
    log: quietLog(),
    audit,
    notifyChanged,
    ...(opts.withCalendar === false ? {} : { invalidateCalendar }),
  };
  return {
    repos,
    clock,
    deps,
    scanNow,
    retriage,
    poke,
    audit,
    notifyChanged,
    invalidateCalendar,
    rateLimited,
    reanalyseChat,
    reanalyseAs,
    newestAs,
  };
}

let jidSeq = 0;
/** A DM chat whose newest message is `agoMs` old (inbound unless `outbound`). */
function chat(h: Harness, agoMs: number, p: { outbound?: boolean; policy?: 'never' } = {}): ChatRef {
  jidSeq += 1;
  const c = h.repos.chats.upsertFromBridge(
    `9725500000${String(jidSeq).padStart(2, '0')}@s.whatsapp.net`,
    null,
    true,
    NOW,
  );
  const ts = (NOW - agoMs) as EpochMs;
  h.repos.chats.touch(c.id, p.outbound ? { lastOutboundTs: ts } : { lastInboundTs: ts });
  if (p.policy === 'never') h.repos.chats.setPolicy(c.id, 'never');
  return c.id;
}
/** An open item (needs_reply) with a finished analysis and a draft. */
function openItem(h: Harness, chatId: ChatRef, patch: Parameters<Repos['items']['update']>[1] = {}): ItemId {
  const it = h.repos.items.createOpen({
    chatId,
    triggerMsgId: `m${chatId}`,
    triggerTs: NOW as EpochMs,
    analysis: 'done',
    holdReason: null,
    now: NOW as EpochMs,
  });
  return h.repos.items.update(it.id, { replyState: 'draft', ...patch }, NOW as EpochMs).id;
}
function inCalendarItem(h: Harness, chatId: ChatRef): ItemId {
  const id = openItem(h, chatId);
  const it = h.repos.items.update(id, { eventState: 'created', replyState: 'sent' }, NOW as EpochMs);
  expect(it.state).toBe('in_calendar');
  return id;
}
const queuedChats = (h: Harness): number[] =>
  h.repos.db
    .prepare<{ chat_id: number }>(`SELECT chat_id FROM triage_queue ORDER BY chat_id`)
    .all()
    .map((r) => r.chat_id);

describe('dashboard:refreshNow - RefreshService', () => {
  it('awaits one scan, re-queues the chats active in the last 24 h and returns the report shape', async () => {
    const h = harness({ kept: 4 });
    const a = chat(h, HOUR);
    const aItem = openItem(h, a);
    const b = chat(h, 2 * HOUR); // no item at all -> ingest's reanalyseChat + doorbell
    const old = chat(h, LIMITS.syncMaxAgeMs + HOUR); // outside the 24 h window
    openItem(h, old);
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toEqual({
      newRows: 4,
      queued: 2,
      skippedRateLimited: 0,
      skippedInCalendar: 0,
      skippedNothingToAnalyse: 0,
      calendarRefreshed: true,
      cooldown: false,
    });
    expect(h.reanalyseChat).toHaveBeenCalledTimes(1);
    expect(h.reanalyseChat).toHaveBeenCalledWith(b);
    expect(h.scanNow).toHaveBeenCalledTimes(1);
    expect(h.retriage).toHaveBeenCalledTimes(1);
    expect(h.retriage).toHaveBeenCalledWith(aItem);
    expect(queuedChats(h)).toEqual([a, b].sort((x, y) => x - y));
    expect(h.poke).toHaveBeenCalled();
    expect(h.invalidateCalendar).toHaveBeenCalledTimes(1);
  });

  it('the scan finishes before any chat is looked at (rows the scan stores are part of the window)', async () => {
    const h = harness();
    const order: string[] = [];
    h.scanNow.mockImplementation(async () => {
      await Promise.resolve();
      order.push('scan');
      return stats(1);
    });
    const c = chat(h, HOUR);
    const id = openItem(h, c);
    h.retriage.mockImplementation((): Result<unknown> => {
      order.push('retriage');
      return { ok: true, value: null };
    });
    await createRefreshService(h.deps).refreshNow();
    expect(order).toEqual(['scan', 'retriage']);
    expect(h.retriage).toHaveBeenCalledWith(id);
  });

  it('counts an outbound-only recent chat too, and never a chat whose policy is "never"', async () => {
    const h = harness();
    const out = chat(h, HOUR, { outbound: true });
    chat(h, HOUR, { policy: 'never' });
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report.queued).toBe(1);
    expect(queuedChats(h)).toEqual([out]);
  });

  it(`caps one press at ${REFRESH_CHAT_CAP} chats, newest first`, async () => {
    const h = harness();
    const chats: ChatRef[] = [];
    for (let i = 0; i < REFRESH_CHAT_CAP + 5; i += 1) chats.push(chat(h, (i + 1) * 60_000));
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report.queued).toBe(REFRESH_CHAT_CAP);
    const newest = chats.slice(0, REFRESH_CHAT_CAP).sort((x, y) => x - y);
    expect(queuedChats(h)).toEqual(newest);
  });

  it('an in-calendar chat is refused (counted, not queued); a rate-limited retriage is counted, not queued', async () => {
    const h = harness();
    const booked = chat(h, HOUR);
    inCalendarItem(h, booked);
    const busy = chat(h, HOUR);
    const busyItem = openItem(h, busy);
    h.rateLimited.add(busyItem);
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toMatchObject({ queued: 0, skippedRateLimited: 1, skippedInCalendar: 1 });
    expect(queuedChats(h)).toEqual([]);
  });

  it('respects the global hourly LLM budget: once used + newly queued reaches it, the rest count as rate limited', async () => {
    const h = harness();
    const used = LIMITS.llmRunsGlobalPerHour - 2;
    for (let i = 0; i < used; i += 1) h.repos.rate.record('llm_global', 'global', (NOW - 1_000 * (i + 1)) as EpochMs);
    openItem(h, chat(h, HOUR));
    chat(h, 2 * HOUR);
    chat(h, 3 * HOUR);
    openItem(h, chat(h, 4 * HOUR));
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toMatchObject({ queued: 2, skippedRateLimited: 2 });
    expect(h.retriage).toHaveBeenCalledTimes(1);
  });

  it('a chat with no open item that already used its hourly LLM budget is counted as rate limited', async () => {
    const h = harness();
    const c = chat(h, HOUR);
    for (let i = 0; i < LIMITS.llmRunsPerChatPerHour; i += 1)
      h.repos.rate.record('llm_chat', String(c), (NOW - 60_000 * (i + 1)) as EpochMs);
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toMatchObject({ queued: 0, skippedRateLimited: 1 });
    expect(queuedChats(h)).toEqual([]);
  });

  it('leaves user-gated holds, running / already-queued analyses and an edit-locked card alone', async () => {
    const h = harness();
    openItem(h, chat(h, HOUR), { analysis: 'held', holdReason: 'unknown_sender', replyState: 'none' });
    openItem(h, chat(h, HOUR), { analysis: 'held', holdReason: 'paused', replyState: 'none' });
    openItem(h, chat(h, HOUR), { analysis: 'running' });
    openItem(h, chat(h, HOUR), { analysis: 'queued' });
    openItem(h, chat(h, HOUR), { editingUntil: (NOW + 60_000) as EpochMs });
    const report = await createRefreshService(h.deps).refreshNow();
    expect(h.retriage).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      queued: 0,
      skippedRateLimited: 0,
      skippedInCalendar: 0,
      skippedNothingToAnalyse: 5,
    });
  });

  it('a closed chat (no open item) is analysed again through ingest: a new open queued item + queue row, counted as queued', async () => {
    const h = harness();
    const c = chat(h, HOUR);
    const old = openItem(h, c);
    h.repos.items.update(old, { closedReason: 'not_needed', closedAt: NOW as EpochMs }, NOW as EpochMs);
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toMatchObject({ queued: 1, skippedNothingToAnalyse: 0 });
    expect(h.reanalyseChat).toHaveBeenCalledWith(c);
    const fresh = h.repos.items.openForChat(c)!;
    expect(fresh.id).not.toBe(old);
    expect(fresh.analysis).toBe('queued');
    expect(queuedChats(h)).toEqual([c]);
    expect(h.notifyChanged).toHaveBeenCalledWith([fresh.id]);
  });

  it('[review fix] an open card already analysed from the newest inbound row is skipped (no retriage, no run)', async () => {
    const h = harness();
    const c = chat(h, HOUR);
    openItem(h, c); // trigger m<c>, analysis done
    h.newestAs.set(c, `m${c}`);
    const report = await createRefreshService(h.deps).refreshNow();
    expect(h.retriage).not.toHaveBeenCalled();
    expect(report).toMatchObject({ queued: 0, skippedNothingToAnalyse: 1 });
    expect(queuedChats(h)).toEqual([]);
  });

  it('[review fix] an open card whose analysis FAILED is retried even when made from the newest row', async () => {
    const h = harness();
    const c = chat(h, HOUR);
    const id = openItem(h, c, { analysis: 'failed', replyState: 'none' });
    h.newestAs.set(c, `m${c}`);
    const report = await createRefreshService(h.deps).refreshNow();
    expect(h.retriage).toHaveBeenCalledWith(id);
    expect(report).toMatchObject({ queued: 1 });
  });

  it('[review fix] held new cards (unknown sender) count as queued but never charge the global hourly bucket', async () => {
    const h = harness();
    for (let i = 0; i < LIMITS.llmRunsGlobalPerHour - 1; i += 1)
      h.repos.rate.record('llm_global', 'global', (NOW - 1_000 * (i + 1)) as EpochMs);
    const held1 = chat(h, HOUR);
    const held2 = chat(h, 2 * HOUR);
    chat(h, 3 * HOUR); // takes the last run of the hour
    chat(h, 4 * HOUR); // over budget
    h.reanalyseAs.set(held1, 'held');
    h.reanalyseAs.set(held2, 'held');
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toMatchObject({ queued: 3, skippedRateLimited: 1 });
    expect(h.reanalyseChat).toHaveBeenCalledTimes(3);
  });

  it('ingest finds nothing to analyse => skippedNothingToAnalyse; a held new item (unknown sender) still counts as queued', async () => {
    const h = harness();
    const nothing = chat(h, HOUR);
    const held = chat(h, 2 * HOUR);
    h.reanalyseAs.set(nothing, 'nothing');
    h.reanalyseAs.set(held, 'held');
    const report = await createRefreshService(h.deps).refreshNow();
    expect(report).toMatchObject({ queued: 1, skippedNothingToAnalyse: 1 });
    expect(queuedChats(h)).toEqual([]);
  });

  it('an ingest without reanalyseChat (v1-shaped double) counts the chat as nothing to analyse and queues nothing', async () => {
    const h = harness();
    chat(h, HOUR);
    const report = await createRefreshService({ ...h.deps, ingest: { scanNow: h.deps.ingest.scanNow } }).refreshNow();
    expect(report).toMatchObject({ queued: 0, skippedNothingToAnalyse: 1 });
    expect(queuedChats(h)).toEqual([]);
  });

  it('review focus 3: a second press inside 30 s returns the same report with cooldown, one scan, no double queueing', async () => {
    const h = harness({ kept: 2 });
    openItem(h, chat(h, HOUR));
    chat(h, HOUR);
    const svc = createRefreshService(h.deps);
    const first = await svc.refreshNow();
    await h.clock.advance(REFRESH_COOLDOWN_MS - 1);
    const second = await svc.refreshNow();
    expect(second).toEqual({ ...first, cooldown: true });
    expect(h.scanNow).toHaveBeenCalledTimes(1);
    expect(h.retriage).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.invalidateCalendar).toHaveBeenCalledTimes(1);
    // after the cooldown a press runs again
    await h.clock.advance(1);
    const third = await svc.refreshNow();
    expect(third.cooldown).toBe(false);
    expect(h.scanNow).toHaveBeenCalledTimes(2);
  });

  it('two presses racing (the second while the first is still scanning) share one run', async () => {
    const h = harness();
    let release: (s: IngestStats) => void = () => undefined;
    h.scanNow.mockImplementation(() => new Promise<IngestStats>((r) => (release = r)));
    const svc = createRefreshService(h.deps);
    const p1 = svc.refreshNow();
    const p2 = svc.refreshNow();
    release(stats(1));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(h.scanNow).toHaveBeenCalledTimes(1);
    expect(r1.cooldown).toBe(false);
    expect(r2).toEqual({ ...r1, cooldown: true });
  });

  it('writes one refresh_now audit row (counts only) and pushes dashboard:changed', async () => {
    const h = harness({ kept: 5 });
    const id = openItem(h, chat(h, HOUR));
    h.rateLimited.add(id);
    chat(h, HOUR);
    await createRefreshService(h.deps).refreshNow();
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith('refresh_now', null, { newRows: 5, queued: 1, skippedRateLimited: 1 }, NOW);
    expect(h.notifyChanged).toHaveBeenCalledTimes(1);
  });

  it('without a calendar invalidation hook the report says calendarRefreshed: false; a throwing hook does not fail the refresh', async () => {
    const none = harness({ withCalendar: false });
    expect((await createRefreshService(none.deps).refreshNow()).calendarRefreshed).toBe(false);
    const broken = harness();
    broken.invalidateCalendar.mockImplementation(() => {
      throw new Error('boom');
    });
    expect((await createRefreshService(broken.deps).refreshNow()).calendarRefreshed).toBe(false);
  });

  it('a failing scan still re-queues recent chats (newRows 0) and starts the cooldown', async () => {
    const h = harness();
    h.scanNow.mockRejectedValue(new Error('SQLITE_CORRUPT'));
    chat(h, HOUR);
    const svc = createRefreshService(h.deps);
    const report = await svc.refreshNow();
    expect(report).toMatchObject({ newRows: 0, queued: 1, cooldown: false });
    expect((await svc.refreshNow()).cooldown).toBe(true);
  });
});

describe('dashboard:refreshNow - handler', () => {
  it('delegates to the refresh service and wraps the report', async () => {
    const h = harness({ kept: 1 });
    const handlers = createDashboardHandlers(createRefreshService(h.deps), h.deps.log);
    const res = await handlers['dashboard:refreshNow'](undefined, CTX);
    expect(res).toEqual({
      ok: true,
      value: {
        newRows: 1,
        queued: 0,
        skippedRateLimited: 0,
        skippedInCalendar: 0,
        skippedNothingToAnalyse: 0,
        calendarRefreshed: true,
        cooldown: false,
      },
    });
  });

  it('an unwired service fails closed (INTERNAL), a throwing one too', async () => {
    const log = quietLog();
    expect(await createDashboardHandlers(undefined, log)['dashboard:refreshNow'](undefined, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    const throwing = { refreshNow: () => Promise.reject(new Error('x')) };
    expect(await createDashboardHandlers(throwing, log)['dashboard:refreshNow'](undefined, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
  });
});
