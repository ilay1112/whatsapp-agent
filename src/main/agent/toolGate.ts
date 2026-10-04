// src/main/agent/toolGate.ts   (frozen signatures; C2 10 v2 block) - owner V2-W1-05-wa-toolserver
// Steps 1-6 of ARCHITECTURE 5.3 / PIPELINE 6.2 over ONE zod-first READ table (agent/toolDefs.ts) and two READ facades (calendar, WhatsApp).
// Default-deny: a model-supplied tool name is matched case-SENSITIVELY against the app-authored READ table, arguments are
// re-built by the app from settings, results are projected and wrapped in the run's nonce block. The gate NEVER throws and
// NEVER stores, logs or exports the model-supplied name (only sha8 + length). The loopback MCP tool server (mcp/toolServer.ts) is a
// second TRANSPORT over this same gate and RunCtx - never a second gate (B16).
import { createHash } from 'node:crypto';
import type { LlmTool, LlmToolCall, LlmToolResult } from '../llm/types';
import type { McpReadClient, PinnedWindow } from '../mcp/readClient';
import type { BusyBlock, EpochMs, ItemId, ChatRef, RunId, LocalDateTime } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { Settings } from '../../shared/settings';
import type { WaReadClient } from '../bridge/waReadClient'; // [V2 ADD]
import type { HandleTable } from './handles'; // [V2 ADD]
import type { ToolSpec } from './toolDefs'; // [V2 ADD]
import {
  READ_TOOL_NAMES,
  READ_TOOLS,
  llmToolOf,
  type ExposeEnv,
  type ReadFacades,
  type ReadToolName,
} from './toolDefs';
import {
  constrainReadArgs as constrainWindow,
  fromWallMs,
  isSameSlot,
  normalizeLocal,
  pinWindow,
  projectBusy,
  PREFETCH_PAD_MS,
  wallMs,
} from './toolGate.window';
import { wrapDataBlock } from './contextBuilder';

/** Mutable per-run state owned by agent/draft.ts; one per S3 run; never shared between chats (I5).
 *  [V2] For claude_cli the SAME object is handed to the per-run loopback tool server (B16): budgets, strikes and handles are shared by both transports. */
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
  // ---- [V2 ADD] ----
  handles: HandleTable; // run-scoped chat_N / m_N ; the trigger chat is always chat_1 (I5')
  waRowsServed: number; // -> runs.wa_rows_served
  crossChatRows: number; // rows served from chats other than ctx.chatId -> proposals.cross_chat_rows
  /** Sanitised texts of rows served from OTHER chats, memory only (never persisted, logged or audited); input of the S4 cross-chat leak guard. */
  otherChatTexts: string[];
}
export type ToolGateVerdict =
  'executed' | 'blocked_unknown_tool' | 'blocked_not_exposed' | 'blocked_budget' | 'blocked_bad_args' | 'unavailable';
export interface ToolGateOutcome {
  result: LlmToolResult; // ALWAYS present: projected JSON in a nonce data block, or {"error":"tool not available"|"unavailable"}
  verdict: ToolGateVerdict;
  abortRun: boolean; // true once ctx.blockedCalls reaches the limit
}
export interface ToolGateDeps {
  read: McpReadClient; // facade with NO write method (I2) ; [V2] getEvent/findAppEvent exist on it but no spec references them
  wa: WaReadClient; // [V2 ADD] facade with NO write method (I2')
  settings: () => Settings;
  calendarConnected: () => boolean;
  waAvailable: () => boolean; // [V2 ADD] settings.whatsapp.readTools.enabled && BridgeDb open
  audit: (kind: 'tool_blocked', ref: string, detail: Record<string, string | number | boolean | null>) => void;
}
export interface ToolGate {
  /** Tool definitions to offer this run = exposedSpecs().map(llmToolOf). [V2] Identical for every automatic-mode policy state (B29). */
  exposedTools(): LlmTool[];
  /** [V2 ADD] The specs exposed right now: calendar tools when connected; wa_get_chat_messages / wa_search_messages / wa_get_message_context
   *  when waAvailable(); wa_list_chats only when additionally settings.whatsapp.readTools.scope === 'all_chats'. The loopback tool server
   *  registers EXACTLY these (B16). */
  exposedSpecs(): ToolSpec[];
  /** Steps 1-6 of ARCHITECTURE 5.3. Never throws. Names are matched case-SENSITIVELY against READ_TOOL_NAMES.
   *  A blocked call audits ONLY { nameSha8, nameLen, verdict, runId } - never the name [R2].
   *  [V2] dispatches on READ_TOOLS[name].backend; wa_* args are pinned through ctx.handles: in 'trigger_chat' scope `chat` must be chat_1
   *  (a search that omits `chat` is PINNED to chat_1, not blocked); an unknown handle => 'blocked_bad_args' WITHOUT a strike; an unexposed
   *  name => 'blocked_not_exposed' WITH a strike (v1 rule). Every wa result: sanitizeForModel per row, role labels, relative age + coarse day,
   *  handles only, caps LIMITS.wa*, oldest dropped first + truncated:true, wrapDataBlock(ctx.nonce). */
  invoke(call: LlmToolCall, ctx: RunCtx): Promise<ToolGateOutcome>;
  /** App-side prefetch (window [start-2h, end+2h]) used by S2 for the `conflict` badge and by S3 for the prompt; same pin/clamp/projection path;
   *  does not consume the model's budget. [R2] Runs in S2 whenever a COMPLETE slot exists and the calendar is connected - independent of needsReply.
   *  [V2] S2 passes `excludeSelf` for a delta: the busy block equal to the existing event's own slot is removed before the conflict badge. */
  prefetchFreeBusy(
    slot: { startLocal: LocalDateTime; endLocal: LocalDateTime },
    ctx: Pick<RunCtx, 'nowMs' | 'timeZone' | 'signal' | 'itemId' | 'chatId'>,
    excludeSelf?: { startLocal: LocalDateTime; endLocal: LocalDateTime },
  ): Promise<BusyBlock[] | null>;
  /** [V2 ADD] loop 'prefetch' (antigravity_cli, B14): runs wa_get_chat_messages {chat:'chat_1', limit: LIMITS.waRowsPerCall} through the SAME
   *  spec.execute + projection + nonce wrap, budget-free, trigger chat only (never other chats, whatever the scope). null when !waAvailable(). */
  prefetchWaContext(ctx: RunCtx): Promise<string | null>;
}

/** [V2 ADD] Every name the gate refuses outright and audits as a strike, whatever the case (BLOCKED_NAMES): v1 calendar write/admin names,
 *  every tool name of the reference WhatsApp MCP server up to v0.7.0 (incl. send_message, send_file, send_audio_message, download_media,
 *  mark_messages_read, view_media) and the FQNs mcp__wca__<name> (the CLI-side name is never a valid in-process name). */
export const BLOCKED_NAMES: readonly string[] = [
  'create-event',
  'create_event',
  'update-event',
  'update_event',
  'delete-event',
  'delete_event',
  'get-event',
  'get_event',
  'list-events',
  'list_events',
  'list-calendars',
  'list_calendars',
  'manage-accounts',
  'manage_accounts',
  'respond-to-event',
  'search-events',
  'search_contacts',
  'get_contact',
  'list_messages',
  'list_chats',
  'get_chat',
  'get_direct_chat_by_contact',
  'get_contact_chats',
  'get_last_interaction',
  'get_message_context',
  'send_message',
  'send_reaction',
  'send_file',
  'send_audio_message',
  'download_media',
  'transcribe_audio_message',
  'mark_messages_read',
  'view_media',
  'transcribe_audio',
  ...READ_TOOL_NAMES.map((n) => `mcp__wca__${n}`),
]; // C2 10 "BLOCKED_NAMES content (binding)"; compared after toLowerCase(); each a strike + tool_blocked

const ERROR_NOT_AVAILABLE = '{"error":"tool not available"}';
const ERROR_UNAVAILABLE = '{"error":"unavailable"}';
const BLOCKED_LOWER: ReadonlySet<string> = new Set(BLOCKED_NAMES.map((n) => n.toLowerCase()));

/** Case-SENSITIVE membership in the READ table (a case variant such as WA_LIST_CHATS is not a READ name). */
function isReadToolName(name: unknown): name is ReadToolName {
  return typeof name === 'string' && (READ_TOOL_NAMES as readonly string[]).includes(name);
}

/** zod .strict() parse + clamp: timeMin >= now, window <= 14 d, horizon <= 60 d ; pins calendar ids / timeZone / account from settings. null = bad args. */
export function constrainReadArgs(
  raw: Record<string, unknown>,
  ctx: Pick<RunCtx, 'nowMs' | 'timeZone'>,
  settings: Settings,
): PinnedWindow | null {
  return constrainWindow(raw, ctx, settings);
}

function sha8(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
}

export function createToolGate(deps: ToolGateDeps): ToolGate {
  const facades: ReadFacades = { calendar: deps.read, wa: deps.wa, settings: deps.settings };

  const blockedOutcome = (
    call: LlmToolCall,
    ctx: RunCtx,
    verdict: ToolGateVerdict,
    strike: boolean,
  ): ToolGateOutcome => {
    if (strike) ctx.blockedCalls += 1;
    const name = String(call.name);
    // [R2] The model-supplied name is attacker-influenced text: only its hash and length are ever recorded.
    deps.audit('tool_blocked', String(ctx.itemId), {
      nameSha8: sha8(name),
      nameLen: name.length,
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

  /** B29: the exposure inputs carry NO policy / automatic-mode field; the scope is read only when the WhatsApp tools are available. */
  const exposedSpecs = (): ToolSpec[] => {
    const waAvailable = deps.waAvailable();
    const env: ExposeEnv = {
      calendarConnected: deps.calendarConnected(),
      waAvailable,
      waScope: waAvailable && deps.settings().whatsapp.readTools.scope === 'all_chats' ? 'all_chats' : 'trigger_chat',
    };
    return READ_TOOL_NAMES.map((n) => READ_TOOLS[n] as unknown as ToolSpec).filter((spec) => spec.exposedWhen(env));
  };

  return {
    exposedTools(): LlmTool[] {
      return exposedSpecs().map(llmToolOf);
    },

    exposedSpecs,

    async invoke(call: LlmToolCall, ctx: RunCtx): Promise<ToolGateOutcome> {
      try {
        // ---- step 1: name in the READ table AND exposed? (the ONLY step that scores a manipulation strike, ARCH 5.3) ----
        // BLOCKED_NAMES (any case) and every other non-READ name are the same refusal: blocked_unknown_tool + strike + sha8-only audit.
        if (typeof call.name === 'string' && BLOCKED_LOWER.has(call.name.toLowerCase())) {
          return blockedOutcome(call, ctx, 'blocked_unknown_tool', true);
        }
        if (!isReadToolName(call.name)) return blockedOutcome(call, ctx, 'blocked_unknown_tool', true);
        const spec = READ_TOOLS[call.name] as unknown as ToolSpec;
        if (!exposedSpecs().includes(spec)) return blockedOutcome(call, ctx, 'blocked_not_exposed', true);

        // ---- step 2: per-run budgets (per tool AND LIMITS.draftToolCalls across both backends); no strike ----
        const used = ctx.calls[call.name] ?? 0;
        if (used >= spec.maxCallsPerRun || ctx.totalCalls >= LIMITS.draftToolCalls) {
          return blockedOutcome(call, ctx, 'blocked_budget', false);
        }

        // ---- step 3a: the zod strict shape (the SAME object the MCP tool server advertises); no strike ----
        const input: unknown = call.input;
        const parsed = spec.args.safeParse(input);
        if (!parsed.success) return blockedOutcome(call, ctx, 'blocked_bad_args', false);

        if (ctx.signal.aborted) return unavailableOutcome(call, ctx);

        // The budget is taken BEFORE the first await, so two concurrent calls (the loopback MCP transport) cannot both pass step 2.
        ctx.calls[call.name] = used + 1;
        ctx.totalCalls += 1;
        let payload: unknown;
        try {
          // ---- steps 3b-5: app pins + clamps -> READ facade (no write method exists on it, I2') -> projection ----
          payload = await spec.execute(parsed.data, ctx, facades);
        } catch {
          return unavailableOutcome(call, ctx); // a throwing / failing facade is an outage, never an exception to the model
        }
        if (payload === null) {
          // bad arguments found while pinning (unknown / out-of-scope handle, bad query, bad window): no strike, budget given back
          ctx.calls[call.name] = used;
          ctx.totalCalls -= 1;
          return blockedOutcome(call, ctx, 'blocked_bad_args', false);
        }

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
      } catch {
        return unavailableOutcome(call, ctx); // never throws (e.g. settings unreadable, a hostile getter on the input object)
      }
    },

    async prefetchFreeBusy(slot, ctx, excludeSelf): Promise<BusyBlock[] | null> {
      try {
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
        const res = await deps.read.getFreeBusy(window);
        if (!res.ok || projectBusy(res.value) === null) return null;
        // [V2] a delta's own event is not a conflict with itself (P2 7.3)
        return excludeSelf === undefined ? [...res.value] : res.value.filter((b) => !isSameSlot(b, excludeSelf));
      } catch {
        return null;
      }
    },

    async prefetchWaContext(ctx: RunCtx): Promise<string | null> {
      try {
        if (!deps.waAvailable() || ctx.signal.aborted) return null;
        // the SAME spec.execute + projection + nonce wrap as a model call; budget-free; ALWAYS the trigger chat (chat_1), whatever the scope
        const payload = await READ_TOOLS.wa_get_chat_messages.execute(
          { chat: 'chat_1', limit: LIMITS.waRowsPerCall },
          ctx,
          facades,
        );
        if (payload === null) return null;
        return wrapDataBlock(ctx.nonce, JSON.stringify(payload));
      } catch {
        return null;
      }
    },
  };
}
