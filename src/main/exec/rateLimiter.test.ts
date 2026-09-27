// src/main/exec/rateLimiter.test.ts - TESTS 5.3 row `exec/*` + TESTS 8.2 item 12c: every window is driven with the VIRTUAL
// clock over a real `rate_events` table, so the limits are the persisted ones and survive a "restart" (a second limiter over
// the same database). An over-limit approval is refused inline - it is never queued for later delivery.
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_DB, createRepos, openDb } from '../db/index';
import { LIMITS } from '../../shared/types';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { createRateLimiter } from './rateLimiter';
import type { Db, Repos } from '../db/index';
import type { ChatRef, EpochMs } from '../../shared/types';

const NOW_0 = Date.UTC(2026, 8, 21, 9, 0, 0);
const HOUR = 3_600_000;
const CHAT = 1 as ChatRef;

const open: Db[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

function rig() {
  const db = openDb(MEMORY_DB);
  open.push(db);
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW_0);
  const limiter = createRateLimiter({ repos, now: () => clock.now() as EpochMs });
  return { db, repos, clock, limiter };
}

/** A "restart": a brand new limiter over the SAME database, with no in-memory state of its own. */
const restart = (repos: Repos, now: () => EpochMs) => createRateLimiter({ repos, now });

describe('checkSend', () => {
  it('allows the first send to a chat', () => {
    const { limiter } = rig();
    expect(limiter.checkSend(CHAT)).toEqual({ ok: true });
  });

  it('enforces the minimum gap per chat and reports the remaining wait', async () => {
    const { limiter, clock } = rig();
    limiter.recordSend(CHAT);
    await clock.advance(LIMITS.sendMinGapPerChatMs - 1_000);
    expect(limiter.checkSend(CHAT)).toEqual({ ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: 1_000 });
    await clock.advance(1_000);
    expect(limiter.checkSend(CHAT)).toEqual({ ok: true });
  });

  it("does not apply one chat's gap to another chat", async () => {
    const { limiter } = rig();
    limiter.recordSend(CHAT);
    expect(limiter.checkSend(2 as ChatRef)).toEqual({ ok: true });
  });

  it('enforces the per-chat hourly cap and releases it as the window slides', async () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < LIMITS.sendPerChatPerHour; i++) {
      expect(limiter.checkSend(CHAT)).toEqual({ ok: true });
      limiter.recordSend(CHAT);
      await clock.advance(LIMITS.sendMinGapPerChatMs);
    }
    expect(limiter.checkSend(CHAT)).toEqual({ ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: HOUR });
    await clock.advance(HOUR); // the first record falls out of the window
    expect(limiter.checkSend(CHAT)).toEqual({ ok: true });
  });

  it('enforces the GLOBAL hourly cap across chats', async () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < LIMITS.sendGlobalPerHour; i++) {
      limiter.recordSend((i + 1) as ChatRef); // a different chat every time: only the global window can bite
      await clock.advance(1_000);
    }
    expect(limiter.checkSend(999 as ChatRef)).toEqual({ ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: HOUR });
  });

  it('enforces the GLOBAL daily cap when the hourly one keeps resetting', async () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < LIMITS.sendGlobalPerDay; i++) {
      limiter.recordSend((i + 1) as ChatRef);
      await clock.advance(15 * 60_000); // 60 sends spread over 15 hours: never 20 inside one hour
    }
    const verdict = limiter.checkSend(999 as ChatRef);
    expect(verdict).toEqual({ ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: 24 * HOUR });
  });

  it('records both the per-chat and the global bucket', () => {
    const { limiter, repos } = rig();
    limiter.recordSend(CHAT);
    expect(repos.rate.countSince('send_chat', String(CHAT), 0 as EpochMs)).toBe(1);
    expect(repos.rate.countSince('send_global', 'global', 0 as EpochMs)).toBe(1);
    expect(repos.rate.countSince('create_global', 'global', 0 as EpochMs)).toBe(0);
  });

  it('[12c] survives a restart: a fresh limiter over the same DB still sees the gap', async () => {
    const { limiter, repos, clock } = rig();
    limiter.recordSend(CHAT);
    const reborn = restart(repos, () => clock.now() as EpochMs);
    expect(reborn.checkSend(CHAT).ok).toBe(false);
    await clock.advance(LIMITS.sendMinGapPerChatMs);
    expect(reborn.checkSend(CHAT)).toEqual({ ok: true });
  });
});

describe('checkCreate', () => {
  it('allows the first create', () => {
    expect(rig().limiter.checkCreate()).toEqual({ ok: true });
  });

  it('enforces the hourly cap and releases it as the window slides', async () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < LIMITS.createPerHour; i++) {
      expect(limiter.checkCreate()).toEqual({ ok: true });
      limiter.recordCreate();
      await clock.advance(60_000);
    }
    expect(limiter.checkCreate()).toEqual({ ok: false, code: 'RATE_LIMIT_CREATE', retryAfterMs: HOUR });
    await clock.advance(HOUR);
    expect(limiter.checkCreate()).toEqual({ ok: true });
  });

  it('enforces the daily cap when the hourly one keeps resetting', async () => {
    const { limiter, clock } = rig();
    for (let i = 0; i < LIMITS.createPerDay; i++) {
      limiter.recordCreate();
      await clock.advance(40 * 60_000); // 30 creates over 20 hours: never 10 inside one hour
    }
    expect(limiter.checkCreate()).toEqual({ ok: false, code: 'RATE_LIMIT_CREATE', retryAfterMs: 24 * HOUR });
  });

  it('records only the create bucket, and creates never block sends', () => {
    const { limiter, repos } = rig();
    limiter.recordCreate();
    expect(repos.rate.countSince('create_global', 'global', 0 as EpochMs)).toBe(1);
    expect(repos.rate.countSince('send_global', 'global', 0 as EpochMs)).toBe(0);
    expect(limiter.checkSend(CHAT)).toEqual({ ok: true });
  });

  it('[12c] survives a restart', async () => {
    const { limiter, repos, clock } = rig();
    for (let i = 0; i < LIMITS.createPerHour; i++) limiter.recordCreate();
    expect(restart(repos, () => clock.now() as EpochMs).checkCreate().ok).toBe(false);
  });
});
