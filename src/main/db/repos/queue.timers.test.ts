// src/main/db/repos/queue.timers.test.ts - v2-repair-v2-main-defects REQUEST 1: the e2e `WCA_TIMERS.debounceMs` / `debounceCapMs`
// seam reaches the triage debounce of the queue repo (it used to read LIMITS directly, so every e2e inbound waited 20 s).
// Production (no timers) keeps LIMITS.debounceMs / LIMITS.debounceCapMs exactly.
import { afterEach, describe, expect, it } from 'vitest';
import { createRepos } from '../index';
import { cleanup, memDb, seedChat, T0 } from '../__fixtures__/testDb';
import { createQueueRepo } from './queue';
import { LIMITS } from '../../../shared/types';

afterEach(() => cleanup());

describe('queue repo debounce timers (WCA_TIMERS seam)', () => {
  it('createQueueRepo(db, timers) debounces to min(now + debounceMs, first + debounceCapMs)', () => {
    const db = memDb();
    const repos = createRepos(db);
    const chat = seedChat(repos);
    const queue = createQueueRepo(db, { debounceMs: 500, debounceCapMs: 1_200 });
    queue.enqueue(chat.id, T0);
    expect(queue.nextDue(T0 + 499)).toBeNull();
    expect(queue.nextDue(T0 + 500)!.dueAt).toBe(T0 + 500);
    queue.enqueue(chat.id, T0 + 1_000); // now + 500 would exceed the 1.2 s cap
    expect(queue.nextDue(T0 + 1_200)!.dueAt).toBe(T0 + 1_200);
  });

  it('createRepos(db, {queueTimers}) threads the seam; an absent or partial seam keeps LIMITS for the missing value', () => {
    const db = memDb();
    const repos = createRepos(db, { queueTimers: { debounceMs: 250 } });
    const chat = seedChat(repos);
    repos.queue.enqueue(chat.id, T0);
    expect(repos.queue.nextDue(T0 + 250)!.dueAt).toBe(T0 + 250);
    repos.queue.enqueue(chat.id, T0 + LIMITS.debounceCapMs - 100);
    expect(repos.queue.nextDue(T0 + LIMITS.debounceCapMs)!.dueAt).toBe(T0 + LIMITS.debounceCapMs); // cap from LIMITS

    const plain = createRepos(memDb());
    const c2 = seedChat(plain);
    plain.queue.enqueue(c2.id, T0);
    expect(plain.queue.nextDue(T0 + LIMITS.debounceMs - 1)).toBeNull();
    expect(plain.queue.nextDue(T0 + LIMITS.debounceMs)!.dueAt).toBe(T0 + LIMITS.debounceMs);
  });

  it('a non-positive or non-finite seam value is ignored (LIMITS kept)', () => {
    const db = memDb();
    const repos = createRepos(db);
    const chat = seedChat(repos);
    const queue = createQueueRepo(db, { debounceMs: -5, debounceCapMs: Number.NaN });
    queue.enqueue(chat.id, T0);
    expect(queue.nextDue(T0 + LIMITS.debounceMs - 1)).toBeNull();
    expect(queue.nextDue(T0 + LIMITS.debounceMs)!.dueAt).toBe(T0 + LIMITS.debounceMs);
  });
});
