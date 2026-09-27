// src/main/agent/toolGate.ts   (frozen signatures)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-09). Steps 1-6 of ARCHITECTURE 5.3 / PIPELINE 6.2.
// Default-deny: a model-supplied tool name is matched case-SENSITIVELY against the app-authored READ table, arguments are
// re-built by the app from settings, results are projected and wrapped in the run's nonce block. The gate NEVER throws and
// NEVER stores, logs or exports the model-supplied name (only sha8 + length).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LlmTool, LlmToolCall, LlmToolResult } from '../llm/types';
import type { McpReadClient, PinnedWindow } from '../mcp/readClient';
import type { BusyBlock, EpochMs, ItemId, ChatRef, RunId, LocalDateTime } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { Settings } from '../../shared/settings';
import { READ_TOOLS, READ_TOOL_NAMES, type ReadToolName } from './toolDefs';
import { wrapDataBlock } from './contextBuilder';

/** Mutable per-run state owned by agent/draft.ts; one per S3 run; never shared between chats (I5). */
export interface RunCtx {
  runId: RunId;
  itemId: ItemId;
  chatId: ChatRef;
  nowMs: EpochMs;
  timeZone: string;
  nonce: string; // 16 hex chars ; data-block delimiter <<DATA-nonce>> ... <<END-nonce>>
  calls: Record<string, number>; // per LLM-facing tool name
  totalCalls: number; // <= LIMITS.draftToolCalls
  blockedCalls: number; // >= LIMITS.blockedCallsAbort => abort run + badge 'manipulation'
  signal: AbortSignal;
}
export type ToolGateVerdict =
  'executed' | 'blocked_unknown_tool' | 'blocked_not_exposed' | 'blocked_budget' | 'blocked_bad_args' | 'unavailable';
export interface ToolGateOutcome {
  result: LlmToolResult; // ALWAYS present: projected JSON in a nonce data block, or {"error":"tool not available"|"unavailable"}
  verdict: ToolGateVerdict;
  abortRun: boolean; // true once ctx.blockedCalls reaches the limit
}
export interface ToolGateDeps {
  read: McpReadClient; // facade with NO write method (I2)
  settings: () => Settings;
  calendarConnected: () => boolean;
  audit: (kind: 'tool_blocked', ref: string, detail: Record<string, string | number | boolean | null>) => void;
}
export interface ToolGate {
  /** Tool definitions to offer this run: [] when the calendar is not connected, else both READ tools. */
  exposedTools(): LlmTool[];
  /** Steps 1-6 of ARCHITECTURE 5.3. Never throws. Names are matched case-SENSITIVELY against READ_TOOL_NAMES.
   *  A blocked call audits ONLY { nameSha8, nameLen, verdict, runId } - never the name [R2]. */
  invoke(call: LlmToolCall, ctx: RunCtx): Promise<ToolGateOutcome>;
  /** App-side prefetch (window [start-2h, end+2h]) used by S2 for the `conflict` badge and by S3 for the prompt; same pin/clamp/projection path;
   *  does not consume the model's budget. [R2] Runs in S2 whenever a COMPLETE slot exists and the calendar is connected - independent of needsReply. */
  prefetchFreeBusy(
    slot: { startLocal: LocalDateTime; endLocal: LocalDateTime },
    ctx: Pick<RunCtx, 'nowMs' | 'timeZone' | 'signal' | 'itemId' | 'chatId'>,
  ): Promise<BusyBlock[] | null>;
}

const ERROR_NOT_AVAILABLE = '{"error":"tool not available"}';
const ERROR_UNAVAILABLE = '{"error":"unavailable"}';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PREFETCH_PAD_MS = 2 * HOUR_MS;

/** LLM args for `get_freebusy`; `.strict()` so calendarId / account / query / privateExtendedProperty / fields are rejected. */
const FreeBusyArgs = z.strictObject({ timeMin: z.string(), timeMax: z.string() });
/** `get_current_time` takes no arguments at all. */
const EmptyArgs = z.strictObject({});

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

function isReadToolName(name: string): name is ReadToolName {
  return (READ_TOOL_NAMES as readonly string[]).includes(name);
}

/** `YYYY-MM-DDTHH:mm[:ss]` (local wall clock, no zone suffix) -> canonical `YYYY-MM-DDTHH:mm:ss`; null when not a real instant. */
function normalizeLocal(raw: string): LocalDateTime | null {
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
function wallMs(local: LocalDateTime): number {
  const m = LOCAL_RE.exec(local)!; // only ever called with a value normalizeLocal produced
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]!));
}

function fromWallMs(ms: number): LocalDateTime {
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
function pinWindow(
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
  ctx: Pick<RunCtx, 'nowMs' | 'timeZone'>,
  settings: Settings,
): PinnedWindow | null {
  const parsed = FreeBusyArgs.safeParse(raw);
  if (!parsed.success) return null;
  return pinWindow(parsed.data.timeMin, parsed.data.timeMax, ctx.nowMs, ctx.timeZone, settings);
}

function sha8(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
}

/** Projection step 5: only the shapes the app authored ever reach a model; raw server text never does. */
function projectBusy(blocks: unknown): Array<{ start: string; end: string }> | null {
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

export function createToolGate(deps: ToolGateDeps): ToolGate {
  const blockedOutcome = (
    call: LlmToolCall,
    ctx: RunCtx,
    verdict: ToolGateVerdict,
    strike: boolean,
  ): ToolGateOutcome => {
    if (strike) ctx.blockedCalls += 1;
    // [R2] The model-supplied name is attacker-influenced text: only its hash and length are ever recorded.
    deps.audit('tool_blocked', String(ctx.itemId), {
      nameSha8: sha8(call.name),
      nameLen: call.name.length,
      verdict,
      runId: ctx.runId,
    });
    return {
      result: { toolCallId: call.id, name: call.name, content: ERROR_NOT_AVAILABLE, isError: true },
      verdict,
      abortRun: ctx.blockedCalls >= LIMITS.blockedCallsAbort,
    };
  };
  const unavailableOutcome = (call: LlmToolCall, ctx: RunCtx): ToolGateOutcome => ({
    result: { toolCallId: call.id, name: call.name, content: ERROR_UNAVAILABLE, isError: true },
    verdict: 'unavailable',
    abortRun: ctx.blockedCalls >= LIMITS.blockedCallsAbort,
  });

  return {
    exposedTools(): LlmTool[] {
      if (!deps.calendarConnected()) return [];
      return READ_TOOL_NAMES.map((n) => READ_TOOLS[n].def);
    },

    async invoke(call: LlmToolCall, ctx: RunCtx): Promise<ToolGateOutcome> {
      // ---- step 1: name in the READ table AND exposed? (the ONLY step that scores a manipulation strike, ARCH 5.3) ----
      if (!isReadToolName(call.name)) return blockedOutcome(call, ctx, 'blocked_unknown_tool', true);
      if (!deps.calendarConnected()) return blockedOutcome(call, ctx, 'blocked_not_exposed', true);

      // ---- step 2: per-run budgets ----
      const spec = READ_TOOLS[call.name];
      const used = ctx.calls[call.name] ?? 0;
      if (used >= spec.maxCallsPerRun || ctx.totalCalls >= LIMITS.draftToolCalls) {
        return blockedOutcome(call, ctx, 'blocked_budget', false);
      }

      // ---- step 3: app-built arguments ----
      const settings = deps.settings();
      let window: PinnedWindow | null = null;
      if (call.name === 'get_freebusy') {
        window = constrainReadArgs(call.input, ctx, settings);
        if (window === null) return blockedOutcome(call, ctx, 'blocked_bad_args', false);
      } else if (!EmptyArgs.safeParse(call.input).success) {
        return blockedOutcome(call, ctx, 'blocked_bad_args', false);
      }

      if (ctx.signal.aborted) return unavailableOutcome(call, ctx);

      // ---- step 4: the READ facade (no write method exists on it, I2) ----
      ctx.calls[call.name] = used + 1;
      ctx.totalCalls += 1;
      let payload: unknown;
      try {
        if (window !== null) {
          const res = await deps.read.getFreeBusy(window);
          if (!res.ok) return unavailableOutcome(call, ctx);
          payload = projectBusy(res.value); // ---- step 5: projection ----
        } else {
          const res = await deps.read.getCurrentTime();
          if (!res.ok) return unavailableOutcome(call, ctx);
          const v = res.value as { nowIso?: unknown; timeZone?: unknown };
          payload =
            typeof v?.nowIso === 'string' && typeof v?.timeZone === 'string'
              ? { nowIso: v.nowIso, timeZone: v.timeZone }
              : null;
        }
      } catch {
        return unavailableOutcome(call, ctx); // a throwing client is an outage, never an exception to the model
      }
      if (payload === null || payload === undefined) return unavailableOutcome(call, ctx);

      // ---- step 6: wrap in the run's nonce data block ----
      return {
        result: {
          toolCallId: call.id,
          name: call.name,
          content: wrapDataBlock(ctx.nonce, JSON.stringify(payload)),
          isError: false,
        },
        verdict: 'executed',
        abortRun: ctx.blockedCalls >= LIMITS.blockedCallsAbort,
      };
    },

    async prefetchFreeBusy(slot, ctx): Promise<BusyBlock[] | null> {
      if (!deps.calendarConnected()) return null;
      const start = normalizeLocal(slot.startLocal);
      const end = normalizeLocal(slot.endLocal);
      if (start === null || end === null) return null;
      const window = pinWindow(
        fromWallMs(wallMs(start) - PREFETCH_PAD_MS),
        fromWallMs(wallMs(end) + PREFETCH_PAD_MS),
        ctx.nowMs,
        ctx.timeZone,
        deps.settings(),
      );
      if (window === null) return null;
      if (ctx.signal.aborted) return null;
      try {
        const res = await deps.read.getFreeBusy(window);
        if (!res.ok) return null;
        return projectBusy(res.value) === null ? null : [...res.value];
      } catch {
        return null;
      }
    },
  };
}
