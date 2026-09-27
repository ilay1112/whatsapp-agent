// tests/helpers/virtualClock.ts - deterministic Clock (S-CLOCK) for vitest (owner W0, frozen). No real timers, no Date dependence.
import type { Clock, ClockTimer } from '../../src/main/deps.ts';

interface Pending {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

export interface VirtualClock extends Clock {
  /** Advances time, firing due timers in order (timers scheduled while firing run in the same advance when due). */
  advance(ms: number): Promise<void>;
  /** Jumps to an absolute instant (>= now). */
  advanceTo(ms: number): Promise<void>;
  /** Runs every pending timer regardless of its due time (at most `max` rounds). */
  runAll(max?: number): Promise<void>;
  pendingCount(): number;
  /** Injected sleep(ms, signal) compatible with ActionExecutorDeps.sleep. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function createVirtualClock(startMs = Date.UTC(2026, 8, 21, 9, 0, 0)): VirtualClock {
  let now = startMs;
  let nextId = 1;
  let seq = 0;
  const pending = new Map<number, Pending>();

  const nextDue = (): Pending | null => {
    let best: Pending | null = null;
    for (const p of pending.values()) {
      if (!best || p.at < best.at || (p.at === best.at && p.seq < best.seq)) best = p;
    }
    return best;
  };
  const fire = async (p: Pending): Promise<void> => {
    pending.delete(p.id);
    p.fn();
    await Promise.resolve(); // let continuations settle
  };
  const clock: VirtualClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { id, at: now + Math.max(0, ms), seq: seq++, fn });
      return id as unknown as ClockTimer;
    },
    clearTimeout: (t) => {
      pending.delete(t as unknown as number);
    },
    advance: async (ms) => {
      await clock.advanceTo(now + ms);
    },
    advanceTo: async (target) => {
      if (target < now) throw new Error('virtual clock cannot go backwards');
      for (;;) {
        const p = nextDue();
        if (!p || p.at > target) break;
        if (p.at > now) now = p.at;
        await fire(p);
      }
      now = target;
    },
    runAll: async (max = 10_000) => {
      for (let i = 0; i < max; i++) {
        const p = nextDue();
        if (!p) return;
        if (p.at > now) now = p.at;
        await fire(p);
      }
      throw new Error('virtual clock runAll: timers keep rescheduling');
    },
    pendingCount: () => pending.size,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const t = clock.setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clock.clearTimeout(t);
          reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  };
  return clock;
}

/** Deterministic RandomSource (S-RAND) for tests: xorshift32 seeded; `bytes` yields a repeatable sequence. */
export function createSeededRandom(seed = 0x2f6e2b1): import('../../src/main/deps.ts').RandomSource {
  let s = seed >>> 0 || 1;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return {
    bytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = next() & 0xff;
      return out;
    },
    int: (min, max) => min + (next() % Math.max(1, max - min)),
    float: () => next() / 0x1_0000_0000,
  };
}
