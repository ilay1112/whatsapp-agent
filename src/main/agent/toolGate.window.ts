// src/main/agent/toolGate.window.ts - owner V2-W1-05-wa-toolserver (build plan rule 8: `<ownedFile>.<suffix>.ts`).
// The calendar half of ARCHITECTURE 5.3 steps 3 and 5 (argument clamps + app pins, busy-block projection), moved verbatim out of the v1
// toolGate.ts so that agent/toolDefs.ts (the zod-first ToolSpec table whose get_freebusy.execute needs them) and agent/toolGate.ts (which
// re-exports the frozen `constrainReadArgs`) share one implementation without an import cycle between the two modules.
import { z } from 'zod';
import type { PinnedWindow } from '../mcp/readClient';
import type { BusyBlock, EpochMs, LocalDateTime } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { Settings } from '../../shared/settings';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** App-side prefetch pad (ARCHITECTURE 5.3: window [start-2h, end+2h]). */
export const PREFETCH_PAD_MS = 2 * HOUR_MS;

/** LLM args for `get_freebusy`; `.strict()` so calendarId / account / query / privateExtendedProperty / fields are rejected. */
const FreeBusyArgs = z.strictObject({ timeMin: z.string(), timeMax: z.string() });

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** `YYYY-MM-DDTHH:mm[:ss]` (local wall clock, no zone suffix) -> canonical `YYYY-MM-DDTHH:mm:ss`; null when not a real instant. */
export function normalizeLocal(raw: string): LocalDateTime | null {
  const m = LOCAL_RE.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? '0'),
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null; // 2026-02-30
  return fromWallMs(utc);
}

/** Wall-clock milliseconds of a canonical local string (zone-free arithmetic; used only for clamp deltas). */
export function wallMs(local: LocalDateTime): number {
  const m = LOCAL_RE.exec(local)!; // only ever called with a value normalizeLocal produced
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]!));
}

export function fromWallMs(ms: number): LocalDateTime {
  return new Date(ms).toISOString().slice(0, 19);
}

/** Epoch -> `YYYY-MM-DDTHH:mm:ss` in an explicit IANA zone. Returns null for an unusable zone (the gate never throws). */
function epochToLocal(ms: EpochMs, timeZone: string): LocalDateTime | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)!.value; // a missing part throws -> null
    const local = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    return normalizeLocal(local);
  } catch {
    return null;
  }
}

/** Clamps of ARCHITECTURE 5.3 step 3 + the app pins. `null` = unusable arguments. */
export function pinWindow(
  minRaw: string,
  maxRaw: string,
  nowMs: EpochMs,
  runTimeZone: string,
  settings: Settings,
): PinnedWindow | null {
  const nowLocal = epochToLocal(nowMs, runTimeZone);
  if (nowLocal === null) return null;
  let min = normalizeLocal(minRaw);
  let max = normalizeLocal(maxRaw);
  if (min === null || max === null) return null;
  if (wallMs(max) <= wallMs(min)) return null;

  if (wallMs(min) < wallMs(nowLocal)) min = nowLocal; // timeMin >= now
  const horizon = fromWallMs(wallMs(nowLocal) + LIMITS.toolHorizonDays * DAY_MS); // horizon <= 60 d
  if (wallMs(max) > wallMs(horizon)) max = horizon;
  const windowEnd = fromWallMs(wallMs(min) + LIMITS.toolWindowDays * DAY_MS); // window <= 14 d
  if (wallMs(max) > wallMs(windowEnd)) max = windowEnd;
  if (wallMs(max) <= wallMs(min)) return null; // entirely in the past / empty after clamping

  return {
    timeMinLocal: min,
    timeMaxLocal: max,
    timeZone: settings.general.timeZone, // pinned by the app, never by the model
    calendarIds: [...settings.calendar.conflictCalendarIds],
    account: 'personal',
  };
}

/** zod .strict() parse + clamp: timeMin >= now, window <= 14 d, horizon <= 60 d ; pins calendar ids / timeZone / account from settings. null = bad args. */
export function constrainReadArgs(
  raw: Record<string, unknown>,
  ctx: { nowMs: EpochMs; timeZone: string },
  settings: Settings,
): PinnedWindow | null {
  const parsed = FreeBusyArgs.safeParse(raw);
  if (!parsed.success) return null;
  return pinWindow(parsed.data.timeMin, parsed.data.timeMax, ctx.nowMs, ctx.timeZone, settings);
}

/** Projection step 5: only the shapes the app authored ever reach a model; raw server text never does. */
export function projectBusy(blocks: unknown): Array<{ start: string; end: string }> | null {
  if (!Array.isArray(blocks)) return null;
  const out: Array<{ start: string; end: string }> = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) return null;
    const { startLocal, endLocal } = b as { startLocal?: unknown; endLocal?: unknown };
    if (typeof startLocal !== 'string' || typeof endLocal !== 'string') return null;
    out.push({ start: startLocal, end: endLocal });
  }
  return out;
}

/** [V2] prefetchFreeBusy `excludeSelf` (P2 7.3): true when a busy block IS the existing event's own slot (same local start and end). */
export function isSameSlot(b: BusyBlock, slot: { startLocal: LocalDateTime; endLocal: LocalDateTime }): boolean {
  const bs = normalizeLocal(b.startLocal);
  const be = normalizeLocal(b.endLocal);
  return bs !== null && be !== null && bs === normalizeLocal(slot.startLocal) && be === normalizeLocal(slot.endLocal);
}
