// src/main/agent/queue.ts - TriageQueue: per-chat debounce + serial runner (build-plan section 3; owner W1-10). S-CLOCK.
// Unit of work = a CHAT (ARCHITECTURE A7). Concurrency 1, persisted in `triage_queue`, edit-lock aware, Pause-abortable.
import { LIMITS, type ChatRef, type EpochMs } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { Clock, ClockTimer, Logger } from '../deps';
import type { Repos } from '../db/index';

export interface QueueStats {
  pending: number;
  running: number;
}
export interface TriageQueue {
  start(): void;
  stop(): Promise<void>;
  /** Re-checks repos.queue.nextDue() now (called by ingest after enqueue; LIMITS.pokeDebounceMs). */
  poke(): void;
  setPaused(b: boolean): void;
  abortInFlight(): void;
  stats(): QueueStats;
  onStats(cb: (s: QueueStats) => void): () => void;
}
export interface TriageQueueDeps {
  repos: Pick<Repos, 'queue' | 'items'>;
  runChat: (chatId: ChatRef, signal: AbortSignal) => Promise<void>; // orchestrator.runChat
  clock: Clock;
  log: Logger;
  timers?: { debounceMs?: number; debounceCapMs?: number; scanMs?: number }; // e2e WCA_TIMERS (delays only)
}

/**
 * `[+]` The channel the orchestrator uses to ask for a retry: a RETRYABLE provider failure (rate limited / overloaded /
 * network). Anything else is terminal for the run - the item already carries its ErrorCode and waits for "Analyse again".
 * `code` is an `ErrorCode`, never `err.message`: provider and zod messages echo model output ([R2], PIPELINE section 7).
 */
export class TriageRetryError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.name = 'TriageRetryError';
    this.code = code;
  }
}

/** ARCHITECTURE 14 / PIPELINE 10.3: queue backoff 1 / 5 / 30 min, then 30 min for every further attempt. */
export const RETRY_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000];
/** How often the worker looks for a due row when nothing pokes it. */
export const DEFAULT_SCAN_MS = 1_000;

export function createTriageQueue(deps: TriageQueueDeps): TriageQueue {
  const { repos, clock, log } = deps;
  const scanMs = deps.timers?.scanMs ?? DEFAULT_SCAN_MS;

  let started = false;
  let paused = false;
  let running = false;
  let inFlight: AbortController | null = null;
  let current: Promise<void> | null = null;
  let scanTimer: ClockTimer | null = null;
  let pokeTimer: ClockTimer | null = null;
  const listeners = new Set<(s: QueueStats) => void>();
  let lastStats: QueueStats = { pending: 0, running: 0 };

  const stats = (): QueueStats => ({ pending: repos.queue.size(), running: running ? 1 : 0 });
  const emit = (): void => {
    const s = stats();
    if (s.pending === lastStats.pending && s.running === lastStats.running) return;
    lastStats = s;
    for (const cb of listeners) cb(s);
  };

  const backoffFor = (attempts: number): number => RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)]!;

  /**
   * `[+]` `rev` is the revision of the row this run DEQUEUED. `nextDue()` only selects, so the row stays in the table
   * for the whole run, and `enqueue()` on an existing row is an UPDATE: a message arriving mid-run (ingest) or a user's
   * "Analyse again" (ItemService.retriage) re-arms that same row. Deleting it unconditionally dropped the newer
   * trigger - nothing re-arms a `queued` item without a queue row, and the bridge watermark is already past the
   * message. The delete is therefore a compare-and-set on `rev`; a re-armed row keeps its place and runs again.
   */
  const runOne = async (chatId: ChatRef, attempts: number, rev: number): Promise<void> => {
    const ac = new AbortController();
    inFlight = ac;
    running = true;
    emit();
    try {
      await deps.runChat(chatId, ac.signal);
      repos.queue.remove(chatId, rev);
    } catch (e) {
      if (e instanceof TriageRetryError) {
        const dueAt: EpochMs = clock.now() + backoffFor(attempts);
        repos.queue.defer(chatId, dueAt, e.code);
        log.info('triage_backoff', { chatId, attempts, code: e.code });
      } else {
        // An unexpected throw must not strand the chat in `running` forever, and must not silently drop its queue row.
        const open = repos.items.openForChat(chatId);
        if (open !== null && open.analysis === 'running')
          repos.items.update(open.id, { analysis: 'queued' }, clock.now());
        repos.queue.defer(chatId, clock.now() + backoffFor(RETRY_BACKOFF_MS.length), 'INTERNAL');
        log.error('triage_run_error', { chatId, name: e instanceof Error ? e.name : 'unknown' });
      }
    } finally {
      inFlight = null;
      running = false;
      emit();
    }
  };

  const pump = async (): Promise<void> => {
    if (!started || paused || running) return;
    const now = clock.now();
    const entry = repos.queue.nextDue(now);
    if (entry === null) {
      emit();
      return;
    }
    // Edit-lock (ARCHITECTURE 6.6): while the user types in the card the run is DEFERRED, never dropped, so the
    // shownHash the user is looking at stays valid.
    const open = repos.items.openForChat(entry.chatId);
    if (open !== null && open.editingUntil > now) {
      repos.queue.defer(entry.chatId, open.editingUntil);
      emit();
      return;
    }
    current = runOne(entry.chatId, entry.attempts, entry.rev);
    try {
      await current;
    } finally {
      current = null;
    }
  };

  const scheduleScan = (): void => {
    if (!started || scanTimer !== null) return;
    scanTimer = clock.setTimeout(() => {
      scanTimer = null;
      void pump().then(() => {
        scheduleScan();
      });
    }, scanMs);
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      // ARCHITECTURE 6.6 recovery: a crash left items mid-run; they go back to `queued` and are picked up again.
      const recovered = repos.items.recoverRunning(clock.now());
      if (recovered > 0) log.info('triage_recovered', { items: recovered });
      lastStats = { pending: -1, running: -1 }; // force the first emit
      emit();
      scheduleScan();
    },

    async stop(): Promise<void> {
      started = false;
      if (scanTimer !== null) {
        clock.clearTimeout(scanTimer);
        scanTimer = null;
      }
      if (pokeTimer !== null) {
        clock.clearTimeout(pokeTimer);
        pokeTimer = null;
      }
      inFlight?.abort();
      const pending = current;
      if (pending !== null) await pending;
    },

    poke(): void {
      if (!started || pokeTimer !== null) return; // trailing debounce: one pending check covers a burst of doorbells
      pokeTimer = clock.setTimeout(() => {
        pokeTimer = null;
        void pump();
      }, LIMITS.pokeDebounceMs);
    },

    setPaused(b: boolean): void {
      if (paused === b) return;
      paused = b;
      if (b) inFlight?.abort();
      else this.poke();
    },

    abortInFlight(): void {
      inFlight?.abort();
    },

    stats,

    onStats(cb: (s: QueueStats) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
