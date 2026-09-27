// src/main/exec/rateLimiter.ts - send / create rate limits over repos.rate (build-plan section 3; owner W1-11). Safety-critical.
// Every counter lives in `rate_events`, so the limits survive a restart (TESTS 8.2 item 12c). An over-limit approval is REJECTED
// with an inline error code - it is never queued for later delivery (ARCH 6.6 step 6: "approvals never queue").
import { LIMITS } from '../../shared/types';
import type { Repos } from '../db/index';
import type { ChatRef, EpochMs } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type RateVerdict = { ok: true } | { ok: false; code: ErrorCode; retryAfterMs: number };

export interface RateLimiter {
  /** LIMITS.sendMinGapPerChatMs / sendPerChatPerHour / sendGlobalPerHour / sendGlobalPerDay -> RATE_LIMIT_SEND. */
  checkSend(chatId: ChatRef): { ok: true } | { ok: false; code: ErrorCode; retryAfterMs: number };
  recordSend(chatId: ChatRef): void;
  /** LIMITS.createPerHour / createPerDay -> RATE_LIMIT_CREATE. */
  checkCreate(): { ok: true } | { ok: false; code: ErrorCode; retryAfterMs: number };
  recordCreate(): void;
}

export function createRateLimiter(deps: { repos: Pick<Repos, 'rate'>; now: () => EpochMs }): RateLimiter {
  const { repos } = deps;

  /** `repos.rate` exposes counts and the newest timestamp only, so a window cap reports the FULL window as the conservative
   *  retry hint. It is advisory metadata (the user sees the error code, never a countdown) - see ops/agent-notes/W1-11-exec.md. */
  const overWindow = (
    bucket: 'send_chat' | 'send_global' | 'create_global',
    key: string,
    windowMs: number,
    max: number,
  ): boolean => repos.rate.countSince(bucket, key, deps.now() - windowMs) >= max;

  return {
    checkSend(chatId) {
      const now = deps.now();
      const key = String(chatId);
      const last = repos.rate.lastTs('send_chat', key);
      if (last !== null && now - last < LIMITS.sendMinGapPerChatMs) {
        return { ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: LIMITS.sendMinGapPerChatMs - (now - last) };
      }
      if (overWindow('send_chat', key, HOUR_MS, LIMITS.sendPerChatPerHour)) {
        return { ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: HOUR_MS };
      }
      if (overWindow('send_global', 'global', HOUR_MS, LIMITS.sendGlobalPerHour)) {
        return { ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: HOUR_MS };
      }
      if (overWindow('send_global', 'global', DAY_MS, LIMITS.sendGlobalPerDay)) {
        return { ok: false, code: 'RATE_LIMIT_SEND', retryAfterMs: DAY_MS };
      }
      return { ok: true };
    },

    recordSend(chatId) {
      const now = deps.now();
      repos.rate.record('send_chat', String(chatId), now);
      repos.rate.record('send_global', 'global', now);
    },

    checkCreate() {
      if (overWindow('create_global', 'global', HOUR_MS, LIMITS.createPerHour)) {
        return { ok: false, code: 'RATE_LIMIT_CREATE', retryAfterMs: HOUR_MS };
      }
      if (overWindow('create_global', 'global', DAY_MS, LIMITS.createPerDay)) {
        return { ok: false, code: 'RATE_LIMIT_CREATE', retryAfterMs: DAY_MS };
      }
      return { ok: true };
    },

    recordCreate() {
      repos.rate.record('create_global', 'global', deps.now());
    },
  };
}
