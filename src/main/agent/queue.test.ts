// src/main/agent/queue.test.ts - TriageQueue (TESTS 5.3 row `agent/queue.ts`; owner W1-10).
// Queue persistence across restart (`running` -> `queued`), concurrency 1, debounce/cap, edit-lock defers,
// Pause aborts the in-flight call via AbortSignal, and the 1/5/30 min retry backoff - all on the virtual clock.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCAN_MS, RETRY_BACKOFF_MS, TriageRetryError, createTriageQueue, type TriageQueue } from './queue';
import { LIMITS, type Chat, type ChatRef, type EpochMs } from '../../shared/types';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import { ANCHOR_MS, createTestEnv, seedChat, seedOpenItem, type TestEnv } from '../../../tests/golden/testDb';

interface Run {
  chatId: ChatRef;
  signal: AbortSignal;
}

describe('createTriageQueue', () => {
  let env: TestEnv;
  let clock: VirtualClock;
  let chat: Chat;
  let runs: Run[];
  let behaviour: (chatId: ChatRef, signal: AbortSignal) => Promise<void>;
  let queue: TriageQueue;
  /** Resolvers of every deliberately-hanging run, so a failed assertion can never hang the afterEach. */
  const releasers: Array<() => void> = [];

  const build = (): TriageQueue =>
    createTriageQueue({
      repos: env.repos,
      runChat: (chatId, signal) => {
        runs.push({ chatId, signal });
        return behaviour(chatId, signal);
      },
      clock,
      log: env.log,
    });

  /** Lets the worker's scan timer fire `rounds` times. */
  const tick = async (rounds = 1): Promise<void> => {
    for (let i = 0; i < rounds; i++) await clock.advance(DEFAULT_SCAN_MS);
  };

  beforeEach(() => {
    env = createTestEnv();
    clock = createVirtualClock(ANCHOR_MS);
    chat = seedChat(env.repos);
    runs = [];
    behaviour = () => Promise.resolve();
    queue = build();
  });
  afterEach(async () => {
    try {
      for (const release of releasers.splice(0)) release();
      await queue.stop();
    } finally {
      env.dispose();
    }
  });

  it('runs a due chat exactly once and removes its queue row', async () => {
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await tick(); // not due yet (20 s debounce)
    expect(runs).toHaveLength(0);
    await clock.advance(LIMITS.debounceMs);
    await tick();
    expect(runs.map((r) => r.chatId)).toEqual([chat.id]);
    expect(env.repos.queue.size()).toBe(0);
  });

  it('keeps a queue row that was re-armed WHILE the run was in flight', async () => {
    // t0: message A arrives. t0+20 s: the worker starts the run and snapshots the context window (A only).
    // Mid-run: message B arrives - ingest re-arms the same row (enqueue only moves due_at) and puts the item back to
    // `queued`. The run must not delete that row, or B is never analysed and nothing re-arms the chat.
    const item = seedOpenItem(env.repos, chat);
    env.repos.queue.enqueue(chat.id, clock.now());
    behaviour = (chatId) => {
      env.repos.items.update(item.id, { analysis: 'queued', triggerMsgId: 'wamid.B' }, clock.now());
      env.repos.queue.enqueue(chatId, clock.now());
      return Promise.resolve();
    };
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick();
    expect(runs).toHaveLength(1);
    expect(env.repos.queue.size()).toBe(1); // re-armed, never dropped

    // ...and the second run really happens, so B is analysed.
    behaviour = () => {
      env.repos.items.update(item.id, { analysis: 'done' }, clock.now());
      return Promise.resolve();
    };
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    expect(runs).toHaveLength(2);
    expect(env.repos.queue.size()).toBe(0);
  });

  it('respects the 60 s debounce cap when messages keep arriving', async () => {
    const first = clock.now();
    env.repos.queue.enqueue(chat.id, first);
    for (let i = 1; i <= 5; i++) env.repos.queue.enqueue(chat.id, first + i * 15_000);
    // With a cap the due time can never drift past first + 60 s.
    queue.start();
    await clock.advanceTo(first + LIMITS.debounceCapMs);
    await tick();
    expect(runs).toHaveLength(1);
  });

  it('never runs two chats concurrently', async () => {
    const other = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net' });
    behaviour = () => new Promise<void>((resolve) => void releasers.push(resolve));
    env.repos.queue.enqueue(chat.id, clock.now());
    env.repos.queue.enqueue(other.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick(3);
    expect(runs).toHaveLength(1);
    expect(queue.stats()).toEqual({ pending: 2, running: 1, transcribing: null });
    releasers.shift()!();
    await tick(3);
    expect(runs).toHaveLength(2);
    expect(queue.stats()).toEqual({ pending: 1, running: 1, transcribing: null });
  });

  it('defers an edit-locked chat instead of running it, and runs it once the lock expires', async () => {
    const item = seedOpenItem(env.repos, chat);
    const until = (clock.now() + LIMITS.editLockMs) as EpochMs;
    env.repos.items.update(item.id, { editingUntil: until }, clock.now());
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    expect(runs).toHaveLength(0);
    expect(env.repos.queue.size()).toBe(1); // deferred, never dropped

    env.repos.items.update(item.id, { editingUntil: 0 as EpochMs }, clock.now());
    await clock.advanceTo(until + 1);
    await tick(2);
    expect(runs).toHaveLength(1);
  });

  it('applies the 1 / 5 / 30 min backoff to a retryable failure and records the ErrorCode only', async () => {
    const failedAt: number[] = [];
    behaviour = () => {
      failedAt.push(clock.now());
      return Promise.reject(new TriageRetryError('CLOUD_UNAVAILABLE'));
    };
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);

    // Attempt 4 uses the last entry again: every further attempt waits 30 min.
    for (const [attempt, backoff] of [...RETRY_BACKOFF_MS, RETRY_BACKOFF_MS.at(-1)!].entries()) {
      await tick(2);
      expect(runs).toHaveLength(attempt + 1);
      const row = env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!;
      expect(row.attempts).toBe(attempt + 1);
      expect(row.lastError).toBe('CLOUD_UNAVAILABLE');
      expect(row.dueAt).toBe(failedAt[attempt]! + backoff);
      await clock.advanceTo(row.dueAt);
    }
  });

  it('never stores a provider message in last_error', async () => {
    behaviour = () => Promise.reject(new TriageRetryError('CLOUD_UNAVAILABLE'));
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    const row = env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!;
    expect(row.lastError).toBe('CLOUD_UNAVAILABLE');
    expect(new TriageRetryError('CLOUD_UNAVAILABLE').message).toBe('CLOUD_UNAVAILABLE');
  });

  it('recovers an unexpected throw: the item leaves `running` and the chat keeps its queue row', async () => {
    const item = seedOpenItem(env.repos, chat);
    env.repos.items.update(item.id, { analysis: 'running' }, clock.now());
    behaviour = () => Promise.reject(new TypeError('bug in the pipeline'));
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
    const row = env.repos.queue.nextDue(Number.MAX_SAFE_INTEGER)!;
    expect(row.lastError).toBe('INTERNAL');
    expect(env.log.lines.some((l) => l.event === 'triage_run_error')).toBe(true);
    // The logged metadata is the error NAME, never its message (which may echo model output).
    const line = env.log.lines.find((l) => l.event === 'triage_run_error')!;
    expect(line.meta).toEqual({ chatId: chat.id, name: 'TypeError' });
  });

  it('logs "unknown" when a non-Error value is thrown', async () => {
    behaviour = () => Promise.reject('a string');
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    expect(env.log.lines.find((l) => l.event === 'triage_run_error')!.meta).toMatchObject({ name: 'unknown' });
  });

  it('start() recovers `running` items to `queued` (crash recovery, ARCHITECTURE 6.6)', () => {
    const item = seedOpenItem(env.repos, chat);
    env.repos.items.update(item.id, { analysis: 'running' }, clock.now());
    queue.start();
    expect(env.repos.items.byId(item.id)!.analysis).toBe('queued');
    expect(env.log.lines.some((l) => l.event === 'triage_recovered')).toBe(true);
  });

  it('start() is idempotent', async () => {
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick();
    expect(runs).toHaveLength(1);
  });

  it('Pause aborts the in-flight call and stops picking new work; resuming pokes the worker', async () => {
    let aborted = false;
    behaviour = (_c, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick();
    expect(runs).toHaveLength(1);

    queue.setPaused(true);
    await tick();
    expect(aborted).toBe(true);
    queue.setPaused(true); // idempotent
    behaviour = () => Promise.resolve();
    const other = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net' });
    env.repos.queue.enqueue(other.id, clock.now() - LIMITS.debounceMs);
    await tick(2);
    expect(runs).toHaveLength(1); // paused: nothing new starts

    queue.setPaused(false);
    await clock.advance(LIMITS.pokeDebounceMs);
    await tick(2);
    expect(runs.length).toBeGreaterThan(1);
  });

  it('abortInFlight() aborts without pausing', async () => {
    let aborted = false;
    behaviour = (_c, signal) =>
      new Promise<void>((resolve) => signal.addEventListener('abort', () => void ((aborted = true), resolve())));
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    await clock.advance(LIMITS.debounceMs);
    await tick();
    queue.abortInFlight();
    await tick();
    expect(aborted).toBe(true);
  });

  it('poke() debounces a burst of doorbells into one check', async () => {
    env.repos.queue.enqueue(chat.id, clock.now() - LIMITS.debounceMs);
    queue.start();
    for (let i = 0; i < 10; i++) queue.poke();
    expect(runs).toHaveLength(0);
    await clock.advance(LIMITS.pokeDebounceMs);
    expect(runs).toHaveLength(1);
  });

  it('poke() before start() and after stop() does nothing', async () => {
    const idle = build();
    idle.poke();
    expect(clock.pendingCount()).toBe(0);
    idle.start();
    await idle.stop();
    idle.poke();
    expect(clock.pendingCount()).toBe(0);
  });

  it('stop() clears the timers and waits for the in-flight run', async () => {
    let settle: (() => void) | null = null;
    behaviour = () => new Promise<void>((resolve) => void (settle = resolve));
    env.repos.queue.enqueue(chat.id, clock.now());
    queue.start();
    queue.poke();
    await clock.advance(LIMITS.debounceMs);
    await tick();
    expect(runs).toHaveLength(1);
    const stopping = queue.stop();
    settle!();
    await stopping;
    expect(clock.pendingCount()).toBe(0);
  });

  it('emits stats only when they change and unsubscribes cleanly', async () => {
    const seen: Array<{ pending: number; running: number }> = [];
    const off = queue.onStats((s) => void seen.push({ ...s }));
    queue.start();
    expect(seen).toEqual([{ pending: 0, running: 0, transcribing: null }]); // [V2] + transcribing (queue:changed)
    await tick(3);
    expect(seen).toHaveLength(1); // nothing changed

    env.repos.queue.enqueue(chat.id, clock.now());
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    expect(seen.length).toBeGreaterThan(1);
    off();
    const before = seen.length;
    env.repos.queue.enqueue(chat.id, clock.now());
    await clock.advance(LIMITS.debounceMs);
    await tick(2);
    expect(seen).toHaveLength(before);
  });

  it('[V2] reports the V0 transcription line through queue:changed stats, numbers only', async () => {
    const seen: Array<{ transcribing?: { seconds: number } | null }> = [];
    queue.onStats((st) => void seen.push({ transcribing: st.transcribing ?? null }));
    queue.start();
    queue.setTranscribing!(42.4);
    expect(queue.stats().transcribing).toEqual({ seconds: 42 });
    queue.setTranscribing!(42);
    queue.setTranscribing!(0);
    queue.setTranscribing!(-3); // unknown => 0 (no change: not emitted twice)
    queue.setTranscribing!(Number.NaN);
    queue.setTranscribing!(null);
    expect(queue.stats().transcribing).toBeNull();
    expect(seen.map((x) => x.transcribing)).toEqual([null, { seconds: 42 }, { seconds: 0 }, null]);
  });

  it('honours the injected e2e scan interval', async () => {
    const fast = createTriageQueue({
      repos: env.repos,
      runChat: (chatId, signal) => {
        runs.push({ chatId, signal });
        return Promise.resolve();
      },
      clock,
      log: env.log,
      timers: { scanMs: 10 },
    });
    env.repos.queue.enqueue(chat.id, clock.now() - LIMITS.debounceMs);
    fast.start();
    await clock.advance(10);
    expect(runs).toHaveLength(1);
    await fast.stop();
  });
});
