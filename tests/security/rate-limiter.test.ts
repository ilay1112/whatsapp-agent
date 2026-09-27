// tests/security/rate-limiter.test.ts - gate item 12c of TESTS 8.2 (assumption A11). Owner: W2-02.
//
// The REAL `createRateLimiter` over a REAL `rate_events` table, and the REAL `ActionExecutor` for the jitter and the
// "an over-limit approval is REJECTED, never queued" rule. Time is the injected virtual clock (T7): no real sleeps.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { createRateLimiter } from '../../src/main/exec/rateLimiter.ts';
import { createActionExecutor } from '../../src/main/exec/actionExecutor.ts';
import { createRepos, openDb, type Db, type Repos } from '../../src/main/db/index.ts';
import { LIMITS } from '../../src/shared/types.ts';
import type { ActionId, ChatRef, EpochMs, ItemCard } from '../../src/shared/types.ts';
import type { IpcContext } from '../../src/shared/ipc.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHAT_A = 1 as ChatRef;
const CHAT_B = 2 as ChatRef;
const CHAT_JID = '972550000001@s.whatsapp.net';

const FOCUSED: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

// ---------------------------------------------------------------------------------------------------------------------
// a tiny standalone rig: a real migrated database + a virtual clock
// ---------------------------------------------------------------------------------------------------------------------
interface Rig {
  repos: Repos;
  db: Db;
  now: () => EpochMs;
  set: (ms: number) => void;
  tick: (ms: number) => void;
  close: () => void;
}

const tmpDirs: string[] = [];
function rig(dbPath = ':memory:'): Rig {
  const db = openDb(dbPath);
  const repos = createRepos(db);
  let t = Date.UTC(2026, 8, 23, 8, 0, 0);
  return {
    repos,
    db,
    now: () => t as EpochMs,
    set: (ms) => {
      t = ms;
    },
    tick: (ms) => {
      t += ms;
    },
    close: () => db.close(),
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. the send limits
// ---------------------------------------------------------------------------------------------------------------------
describe('A11 - send limits', () => {
  it('enforces the 5 s minimum gap per chat', () => {
    const r = rig();
    try {
      const limiter = createRateLimiter({ repos: r.repos, now: r.now });
      expect(limiter.checkSend(CHAT_A).ok).toBe(true);
      limiter.recordSend(CHAT_A);

      r.tick(LIMITS.sendMinGapPerChatMs - 1);
      const blocked = limiter.checkSend(CHAT_A);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe('RATE_LIMIT_SEND');
        expect(blocked.retryAfterMs).toBe(1);
      }
      // Another chat is unaffected: the gap is per chat.
      expect(limiter.checkSend(CHAT_B).ok).toBe(true);

      r.tick(1);
      expect(limiter.checkSend(CHAT_A).ok).toBe(true);
    } finally {
      r.close();
    }
  });

  it('enforces 6 sends per chat per hour', () => {
    const r = rig();
    try {
      const limiter = createRateLimiter({ repos: r.repos, now: r.now });
      for (let i = 0; i < LIMITS.sendPerChatPerHour; i++) {
        expect(limiter.checkSend(CHAT_A).ok, `send ${i + 1}`).toBe(true);
        limiter.recordSend(CHAT_A);
        r.tick(LIMITS.sendMinGapPerChatMs);
      }
      const blocked = limiter.checkSend(CHAT_A);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe('RATE_LIMIT_SEND');
        expect(blocked.retryAfterMs).toBe(HOUR);
      }
      // A different chat still has its own hourly budget.
      expect(limiter.checkSend(CHAT_B).ok).toBe(true);
      // The window slides: one hour after the first send the chat is free again.
      r.tick(HOUR);
      expect(limiter.checkSend(CHAT_A).ok).toBe(true);
    } finally {
      r.close();
    }
  });

  it('enforces 20 sends per hour and 60 per day globally', () => {
    const r = rig();
    try {
      const limiter = createRateLimiter({ repos: r.repos, now: r.now });
      // Spread over enough chats that neither the per-chat gap nor the per-chat hourly cap is the binding constraint.
      let chat = 0;
      for (let i = 0; i < LIMITS.sendGlobalPerHour; i++) {
        const c = (1 + (chat++ % 10)) as ChatRef;
        expect(limiter.checkSend(c).ok, `global send ${i + 1}`).toBe(true);
        limiter.recordSend(c);
        r.tick(60_000);
      }
      // 20 sends in the last 20 minutes: the hourly global cap bites, whatever the chat.
      const blocked = limiter.checkSend(99 as ChatRef);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.retryAfterMs).toBe(HOUR);

      // Fill the day: 60 global sends, each one more than an hour after the previous ones.
      const r2 = rig();
      try {
        const daily = createRateLimiter({ repos: r2.repos, now: r2.now });
        for (let i = 0; i < LIMITS.sendGlobalPerDay; i++) {
          r2.repos.rate.record('send_global', 'global', (r2.now() - i * 60_000) as EpochMs);
        }
        const overDay = daily.checkSend(77 as ChatRef);
        expect(overDay.ok).toBe(false);
        if (!overDay.ok) expect(overDay.code).toBe('RATE_LIMIT_SEND');
      } finally {
        r2.close();
      }
    } finally {
      r.close();
    }
  });

  it('a 100-approval burst is capped and the remainder is refused, never queued', () => {
    const r = rig();
    try {
      const limiter = createRateLimiter({ repos: r.repos, now: r.now });
      let allowed = 0;
      let refused = 0;
      for (let i = 0; i < 100; i++) {
        const c = (1 + (i % 25)) as ChatRef; // per-chat caps are not the binding constraint
        const verdict = limiter.checkSend(c);
        if (verdict.ok) {
          allowed += 1;
          limiter.recordSend(c);
        } else {
          refused += 1;
          expect(verdict.code).toBe('RATE_LIMIT_SEND');
        }
      }
      expect(allowed).toBe(LIMITS.sendGlobalPerHour);
      expect(refused).toBe(100 - LIMITS.sendGlobalPerHour);
      // Nothing was stored for later: the only rows in rate_events are the ones that really went out.
      const rows = r.db.prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE bucket='send_global'`).get() as {
        n: number;
      };
      expect(rows.n).toBe(LIMITS.sendGlobalPerHour);
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. the create limits
// ---------------------------------------------------------------------------------------------------------------------
describe('A11 - create-event limits', () => {
  it('enforces 10 creates per hour and 30 per day', () => {
    const r = rig();
    try {
      const limiter = createRateLimiter({ repos: r.repos, now: r.now });
      for (let i = 0; i < LIMITS.createPerHour; i++) {
        expect(limiter.checkCreate().ok, `create ${i + 1}`).toBe(true);
        limiter.recordCreate();
      }
      const blocked = limiter.checkCreate();
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) {
        expect(blocked.code).toBe('RATE_LIMIT_CREATE');
        expect(blocked.retryAfterMs).toBe(HOUR);
      }
      r.tick(HOUR + 1);
      expect(limiter.checkCreate().ok).toBe(true);

      // Day cap: 30 rows inside the last 24 h, all older than an hour.
      const r2 = rig();
      try {
        const daily = createRateLimiter({ repos: r2.repos, now: r2.now });
        for (let i = 0; i < LIMITS.createPerDay; i++) {
          r2.repos.rate.record('create_global', 'global', (r2.now() - HOUR - i * 60_000) as EpochMs);
        }
        const overDay = daily.checkCreate();
        expect(overDay.ok).toBe(false);
        if (!overDay.ok) {
          expect(overDay.code).toBe('RATE_LIMIT_CREATE');
          expect(overDay.retryAfterMs).toBe(DAY);
        }
      } finally {
        r2.close();
      }
    } finally {
      r.close();
    }
  });

  it('never mixes the send and create buckets', () => {
    const r = rig();
    try {
      const limiter = createRateLimiter({ repos: r.repos, now: r.now });
      for (let i = 0; i < LIMITS.createPerHour; i++) limiter.recordCreate();
      expect(limiter.checkCreate().ok).toBe(false);
      expect(limiter.checkSend(CHAT_A).ok).toBe(true); // creates never eat the send budget
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. the counters survive a restart (rate_events is on disk)
// ---------------------------------------------------------------------------------------------------------------------
describe('A11 - the limits survive a restart', () => {
  it('reads the counters back from rate_events after the process is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-rate-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'app.db');

    const first = rig(dbPath);
    const at = first.now();
    try {
      const limiter = createRateLimiter({ repos: first.repos, now: first.now });
      for (let i = 0; i < LIMITS.sendPerChatPerHour; i++) {
        limiter.recordSend(CHAT_A);
      }
      for (let i = 0; i < LIMITS.createPerHour; i++) limiter.recordCreate();
    } finally {
      first.close();
    }

    const second = rig(dbPath);
    second.set(at + 1_000); // a second later: same hour, same day
    try {
      const limiter = createRateLimiter({ repos: second.repos, now: second.now });
      const send = limiter.checkSend(CHAT_A);
      expect(send.ok, 'the per-chat hourly cap must survive the restart').toBe(false);
      const create = limiter.checkCreate();
      expect(create.ok, 'the hourly create cap must survive the restart').toBe(false);
    } finally {
      second.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. [R2] the jitter sleep - bounds and ordering
// ---------------------------------------------------------------------------------------------------------------------
const RULES: StubRule[] = [
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
  { when: { purpose: 'draft' }, respond: { text: 'Thursday 17:00 works', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function pendingSend(): Promise<{ harness: Harness; card: ItemCard }> {
  const harness = await createHarness({ rules: RULES });
  h = harness;
  await harness.bridge.outboundFromPhone({
    chatJid: CHAT_JID,
    text: 'hey',
    ts: new Date(harness.clock.now() - HOUR),
  });
  await harness.bridge.inbound({ chatJid: CHAT_JID, text: 'coffee Thursday at 5?' });
  await harness.settle();
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('dashboard failed');
  const card = dash.value.needsReply[0];
  if (card === undefined) throw new Error('no card');
  return { harness, card };
}

describe('[R2] A11 - the send jitter', () => {
  // `RandomSource.float()` is contractually [0, 1), so the upper bound is driven with the largest double below 1.
  const FLOAT_SUP = 0.9999999999999999;
  it.each([
    [0, LIMITS.sendJitterMinMs],
    [FLOAT_SUP, LIMITS.sendJitterMaxMs],
    [0.5, 5_500],
  ])('random()=%s sleeps %s ms, and only after the row is executing', async (rnd, expected) => {
    const { harness, card } = await pendingSend();
    const send = card.actions.find((a) => a.kind === 'send_reply')!;

    const sleeps: number[] = [];
    const statesAtSleep: string[] = [];
    const sentAfterSleep: boolean[] = [];
    let slept = false;

    const executor = createActionExecutor({
      repos: harness.repos,
      send: {
        sendText: () => {
          sentAfterSleep.push(slept);
          return Promise.resolve({ ok: true, waMsgId: null });
        },
      } as never,
      write: { createEvent: () => Promise.reject(new Error('not used')) } as never,
      read: { freeBusy: () => Promise.resolve([]), listEvents: () => Promise.resolve([]) } as never,
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => harness.repos.settings.get(),
      now: () => harness.clock.now(),
      sleep: (ms) => {
        sleeps.push(ms);
        statesAtSleep.push(harness.repos.actions.byId(send.actionId)?.state ?? 'missing');
        slept = true;
        return Promise.resolve();
      },
      random: () => rnd,
      notifyChanged: () => undefined,
    });

    const res = await executor.approve(
      { actionId: send.actionId as ActionId, kind: 'send_reply', shownHash: send.shownHash },
      FOCUSED,
    );
    expect(res.ok).toBe(true);
    expect(sleeps).toEqual([expected]);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(LIMITS.sendJitterMinMs);
    expect(sleeps[0]!).toBeLessThanOrEqual(LIMITS.sendJitterMaxMs);
    // [R2] the write-ahead already committed `executing` when the sleep started...
    expect(statesAtSleep).toEqual(['executing']);
    // ...and the side effect happened only after the sleep returned.
    expect(sentAfterSleep).toEqual([true]);
  });

  it('refuses an over-limit approve with the inline code and leaves the action pending (never queued)', async () => {
    const { harness, card } = await pendingSend();
    const send = card.actions.find((a) => a.kind === 'send_reply')!;
    const row = harness.repos.actions.byId(send.actionId)!;

    // Fill this chat's hourly budget with rows that are already in the database.
    for (let i = 0; i < LIMITS.sendPerChatPerHour; i++) {
      harness.repos.rate.record('send_chat', String(row.chatId), (harness.clock.now() - 10 * 60_000 - i) as EpochMs);
    }

    const touched: string[] = [];
    const executor = createActionExecutor({
      repos: harness.repos,
      send: {
        sendText: () => {
          touched.push('sendText');
          throw new Error('an over-limit approve must not reach the bridge');
        },
      } as never,
      write: { createEvent: () => Promise.reject(new Error('not used')) } as never,
      read: { freeBusy: () => Promise.resolve([]), listEvents: () => Promise.resolve([]) } as never,
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => harness.repos.settings.get(),
      now: () => harness.clock.now(),
      sleep: () => Promise.resolve(),
      random: () => 0,
      notifyChanged: () => undefined,
    });

    const res = await executor.approve(
      { actionId: send.actionId as ActionId, kind: 'send_reply', shownHash: send.shownHash },
      FOCUSED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('RATE_LIMIT_SEND');
    expect(touched).toEqual([]);
    expect(harness.bridge.sends).toHaveLength(0);
    // The action is still pending - the app never "remembers" the click for later.
    expect(harness.repos.actions.byId(send.actionId)?.state).toBe('pending');
    const clones = harness.repos.db.prepare(`SELECT COUNT(*) AS n FROM actions WHERE kind='send_reply'`).get() as {
      n: number;
    };
    expect(clones.n).toBe(1);
  });

  it('refuses an over-limit create with RATE_LIMIT_CREATE and no calendar call', async () => {
    const { harness, card } = await pendingSend();
    const create = card.actions.find((a) => a.kind === 'create_event')!;
    for (let i = 0; i < LIMITS.createPerHour; i++) {
      harness.repos.rate.record('create_global', 'global', (harness.clock.now() - 10 * 60_000 - i) as EpochMs);
    }

    const touched: string[] = [];
    const executor = createActionExecutor({
      repos: harness.repos,
      send: { sendText: () => Promise.reject(new Error('not used')) } as never,
      write: {
        createEvent: () => {
          touched.push('createEvent');
          throw new Error('an over-limit approve must not reach the calendar');
        },
      } as never,
      read: { freeBusy: () => Promise.resolve([]), listEvents: () => Promise.resolve([]) } as never,
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => harness.repos.settings.get(),
      now: () => harness.clock.now(),
      sleep: () => Promise.resolve(),
      random: () => 0,
      notifyChanged: () => undefined,
    });

    const res = await executor.approve(
      {
        actionId: create.actionId as ActionId,
        kind: 'create_event',
        shownHash: create.shownHash,
        confirmConflict: true,
      },
      FOCUSED,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('RATE_LIMIT_CREATE');
    expect(touched).toEqual([]);
    expect(harness.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);
    expect(harness.repos.actions.byId(create.actionId)?.state).toBe('pending');
  });
});
