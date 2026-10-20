// src/main/ipc/handlers/dashboard.ts - [v4 T3] `dashboard:refreshNow` (v4-calendar-handover 2.1).
// Refresh only READS and QUEUES: one ingest scan, then the chats active in the last 24 h go back on the triage queue through the
// same rules as "Analyse again" (ItemService.retriage: per-chat LLM budget, in-calendar refusal); a chat with NO open item is
// analysed again through ingest's own inbound path (Ingest.reanalyseChat: Stage 0, backlog gate, holds, new item, queue row).
// Then the calendar cache is invalidated and dashboard:changed is pushed. It never approves, sends or writes anything (I1': every
// send / calendar write still needs the action:approve click). The global hourly LLM budget is applied here (retriage skips
// stage 0); the report counts what the queue accepted, not what the model will run. Counts only leave this file - never a chat id, a name or message text.
import type { IpcHandlers } from '../../../shared/ipc';
import {
  LIMITS,
  type AuditEntry,
  type AuditKind,
  type ChatRef,
  type EpochMs,
  type ItemId,
  type ItemState,
  type RefreshReport,
  type Result,
} from '../../../shared/types';
import type { Clock, Logger } from '../../deps';
import type { Repos } from '../../db/index';
import type { Ingest } from '../../bridge/ingest';
import type { TriageQueue } from '../../agent/queue';
import { fail, ok } from '../register';

export type DashboardChannels = 'dashboard:refreshNow';

/** A second press inside this window returns the previous report with `cooldown: true` (main-side; review focus 3). */
export const REFRESH_COOLDOWN_MS = 30_000;
/** At most this many chats are re-queued per press, newest first. */
export const REFRESH_CHAT_CAP = 20;
const HOUR_MS = 3_600_000;

export interface RefreshDeps {
  /** scanNow + [v4 T3] reanalyseChat (absent on a v1-shaped double => such chats count as nothing to analyse) + [review fix]
   *  newestInboundMsgId (absent => an open card is never treated as already analysed). */
  ingest: Pick<Ingest, 'scanNow' | 'reanalyseChat' | 'newestInboundMsgId'>;
  repos: Pick<Repos, 'db' | 'items' | 'rate'>;
  /** ItemService.retriage - the "Analyse again" path (RATE_LIMIT_RETRIAGE / ACTION_STALE refusals, enqueue + doorbell). */
  items: { retriage(id: ItemId): Result<unknown> };
  queue: Pick<TriageQueue, 'poke'>;
  clock: Clock;
  log: Logger;
  audit: (kind: AuditKind, ref: string | null, detail: AuditEntry['detail'], now: EpochMs) => void;
  notifyChanged: (itemIds: number[]) => void;
  /** The calendar read cache's `calendar:invalidate` (group C's CalendarEventsService). Absent => calendarRefreshed: false. */
  invalidateCalendar?: () => void;
}

export interface RefreshService {
  refreshNow(): Promise<RefreshReport>;
}

/** Chats with a message (either direction) at or after `?`, newest first. Policy 'never' chats are never analysed. */
const RECENT_CHATS_SQL = `SELECT id, MAX(COALESCE(last_inbound_ts, 0), COALESCE(last_outbound_ts, 0)) AS last_ts
  FROM chats
  WHERE policy <> 'never' AND MAX(COALESCE(last_inbound_ts, 0), COALESCE(last_outbound_ts, 0)) >= ?
  ORDER BY last_ts DESC, id DESC
  LIMIT ?`;
/** The newest item of a chat (any state) - used only when the chat has no open item. */
const LATEST_ITEM_SQL = `SELECT state FROM items WHERE chat_id = ? ORDER BY id DESC LIMIT 1`;

/** 'held' = a new card that waits for the user (unknown sender / paused): reported as queued, never charged to the global LLM budget. */
type Outcome = 'queued' | 'held' | 'rate_limited' | 'in_calendar' | 'nothing';

export function createRefreshService(deps: RefreshDeps): RefreshService {
  const { repos, clock, log } = deps;
  let inFlight: Promise<RefreshReport> | null = null;
  let last: { at: EpochMs; report: RefreshReport } | null = null;

  const requeue = (chatId: ChatRef, now: EpochMs, touched: ItemId[]): Outcome => {
    const open = repos.items.openForChat(chatId);
    if (open !== null) {
      // User-gated holds stay held (an unknown sender is analysed only on the user's own "Analyse" click; a paused agent stays
      // paused); a run that is already pending is not queued twice; an edit-locked card keeps the shownHash the user is reading.
      if (open.analysis === 'held' && (open.holdReason === 'unknown_sender' || open.holdReason === 'paused'))
        return 'nothing';
      if (open.analysis === 'queued' || open.analysis === 'running') return 'nothing';
      if (open.editingUntil > now) return 'nothing';
      // [v4 review fix] An analysis that already finished on the chat's newest inbound row is not run again: nothing new arrived
      // since, and a re-run would only burn the hourly budget. A failed / non-user-gated held analysis is still retried.
      if (open.analysis === 'done' && open.triggerMsgId === deps.ingest.newestInboundMsgId?.(chatId)) return 'nothing';
      const res = deps.items.retriage(open.id);
      if (res.ok) {
        touched.push(open.id);
        return 'queued';
      }
      if (res.error.code === 'RATE_LIMIT_RETRIAGE') return 'rate_limited';
      return 'nothing';
    }
    const latest = repos.db.prepare<{ state: ItemState }>(LATEST_ITEM_SQL).get(chatId);
    // In-calendar items stay refused, exactly like "Analyse again" (items.retriage ACTION_STALE).
    if (latest?.state === 'in_calendar') return 'in_calendar';
    if (repos.rate.countSince('llm_chat', String(chatId), now - HOUR_MS) >= LIMITS.llmRunsPerChatPerHour)
      return 'rate_limited';
    // Not a doorbell on an empty chat: runChat analyses only an OPEN item, so ingest's own path creates it (or holds / refuses it).
    const res = deps.ingest.reanalyseChat?.(chatId);
    if (res === undefined || res.outcome === 'nothing' || res.itemId === null) return 'nothing';
    touched.push(res.itemId);
    return res.outcome === 'held' ? 'held' : 'queued';
  };

  const run = async (): Promise<RefreshReport> => {
    let newRows = 0;
    try {
      newRows = (await deps.ingest.scanNow()).kept;
    } catch (err) {
      // A broken scan must not block the re-analysis of what is already stored; the next ingest trigger retries the scan.
      log.warn('refresh_scan_failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
    const now = clock.now();
    const rows = repos.db
      .prepare<{ id: number; last_ts: number }>(RECENT_CHATS_SQL)
      .all(now - LIMITS.syncMaxAgeMs, REFRESH_CHAT_CAP);
    let queued = 0;
    let skippedRateLimited = 0;
    let skippedInCalendar = 0;
    let skippedNothingToAnalyse = 0;
    const touched: ItemId[] = [];
    // The retriage path does not pass stage 0, so the global hourly budget (LIMITS.llmRunsGlobalPerHour) is applied here: runs
    // already made this hour + LLM runs this press queued may not exceed it. A held card (unknown sender / paused) makes no run
    // until the user acts, so it is reported as queued but never charged.
    const globalUsed = repos.rate.countSince('llm_global', 'global', now - HOUR_MS);
    let charged = 0;
    for (const row of rows) {
      if (globalUsed + charged >= LIMITS.llmRunsGlobalPerHour) {
        skippedRateLimited += 1;
        continue;
      }
      const outcome = requeue(row.id as ChatRef, now, touched);
      if (outcome === 'queued') {
        queued += 1;
        charged += 1;
      } else if (outcome === 'held') queued += 1;
      else if (outcome === 'rate_limited') skippedRateLimited += 1;
      else if (outcome === 'in_calendar') skippedInCalendar += 1;
      else skippedNothingToAnalyse += 1;
    }
    if (charged > 0) deps.queue.poke();

    let calendarRefreshed = false;
    if (deps.invalidateCalendar !== undefined) {
      try {
        deps.invalidateCalendar();
        calendarRefreshed = true;
      } catch (err) {
        log.warn('refresh_calendar_invalidate_failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    deps.notifyChanged(touched);
    deps.audit('refresh_now', null, { newRows, queued, skippedRateLimited }, now);
    log.info('refresh_now', {
      newRows,
      queued,
      skippedRateLimited,
      skippedInCalendar,
      skippedNothingToAnalyse,
      chats: rows.length,
    });
    return {
      newRows,
      queued,
      skippedRateLimited,
      skippedInCalendar,
      skippedNothingToAnalyse,
      calendarRefreshed,
      cooldown: false,
    };
  };

  return {
    async refreshNow(): Promise<RefreshReport> {
      if (inFlight !== null) return { ...(await inFlight), cooldown: true };
      const now = clock.now();
      if (last !== null && now - last.at < REFRESH_COOLDOWN_MS) return { ...last.report, cooldown: true };
      const startedAt = now;
      inFlight = run();
      try {
        const report = await inFlight;
        last = { at: startedAt, report };
        return report;
      } finally {
        inFlight = null;
      }
    },
  };
}

/** The channel handler. An unwired service is a wiring bug and fails CLOSED (INTERNAL), never a pretend success. */
export function createDashboardHandlers(
  refresh: RefreshService | undefined,
  log: Logger,
): Pick<IpcHandlers, DashboardChannels> {
  return {
    'dashboard:refreshNow': async () => {
      if (refresh === undefined) {
        log.error('ipc_v4_unwired', { channel: 'dashboard:refreshNow' });
        return fail('INTERNAL');
      }
      try {
        return ok(await refresh.refreshNow());
      } catch (err) {
        log.warn('refresh_failed', { error: err instanceof Error ? err.name : 'unknown' });
        return fail('INTERNAL');
      }
    },
  };
}
