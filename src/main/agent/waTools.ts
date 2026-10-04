// src/main/agent/waTools.ts   ADD (B17, D-040) - owner V2-W1-05-wa-toolserver.
// The four WhatsApp READ tools' execute() bodies (pin through RunCtx.handles -> WaReadClient facade -> projection). Pure over the injected
// facade: imports none of bridge/sendClient, bridge/readClient, mcp/writeClient, mcp/adminClient, mcp/host, exec/**, llm/**, electron.
// The row/container shapes below are the binding "Tool result row shape" of C2 10 (JSON inside the nonce block); no field carries a name,
// number, JID, WhatsApp id, file name or clock time (I5' regex sweep test). The gate (agent/toolGate.ts) parses the zod args, owns the
// budgets and wraps the returned value in the run's nonce block; this module never sees the model-supplied tool NAME and never echoes,
// logs or audits the search query.
import type { ChatRef, EpochMs, Message } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import type { WaReadClient, WaReadQuery, WaScope } from '../bridge/waReadClient';
import type { RunCtx } from './toolGate';
import type { ReadFacades } from './toolDefs';
import { ageLabelFor } from './minimize';
import { sanitizeForModel, stripInvisible } from './sanitize';

/** One projected row (all four tools). `text` sanitised (sanitizeForModel) and cut to LIMITS.waTextChars. */
export interface WaToolRow {
  id: string; // m_N
  chat: string; // chat_N
  from: 'contact' | 'me';
  ago: string; // "3 d ago" - relative age, app-computed
  day: string; // YYYY-MM-DD - coarse day, app-computed
  kind: 'text' | 'voice';
  text: string;
}
export interface WaChatMessagesResult {
  chat: string;
  messages: WaToolRow[];
  more: boolean;
}
export interface WaSearchResult {
  hits: WaToolRow[];
  truncated: boolean;
}
export interface WaContextResult {
  chat: string;
  before: WaToolRow[];
  message: WaToolRow;
  after: WaToolRow[];
}
export interface WaListChatsResult {
  chats: Array<{ chat: string; last_from: 'contact' | 'me' | null; last_ago: string; last_text: string }>; // last_text <= 120
}
export type WaToolName = 'wa_get_chat_messages' | 'wa_search_messages' | 'wa_get_message_context' | 'wa_list_chats';
export type WaToolResult = WaChatMessagesResult | WaSearchResult | WaContextResult | WaListChatsResult;

const DAY_MS = 24 * 3_600_000;
const TRUNCATION_MARKER = ' [truncated]';
/** `last_text` cap of wa_list_chats (C2 10 container shape). */
export const WA_LAST_TEXT_CHARS = 120;
/** Default / range of every numeric argument (the ranges live in the tool descriptions and here - never in the zod shape, B17). */
const ARG_RANGES = {
  chatLimit: { def: 12, min: 1, max: LIMITS.waRowsPerCall },
  searchLimit: { def: 5, min: 1, max: LIMITS.waSearchHits },
  side: { def: 4, min: 0, max: LIMITS.waContextSide },
  listLimit: { def: LIMITS.waListChats, min: 1, max: LIMITS.waListChats },
} as const;
/** Size placeholders: the result is fitted to LIMITS.waResultChars with the LONGEST legal handles, and real handles are handed out
 *  only to the rows that survive the cut (so a handle is never allocated for a row the model was not shown). */
const MAX_MSG_HANDLE = 'm_99999';
const MAX_CHAT_HANDLE = 'chat_9999';

/** `s` cut to `max` UTF-16 units including the marker, never splitting a surrogate pair. */
function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - TRUNCATION_MARKER.length;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end) + TRUNCATION_MARKER;
}

/** Local calendar day `YYYY-MM-DD` of an instant in the run zone (coarse: never a clock time). */
function dayOf(ts: EpochMs | null, timeZone: string): string {
  if (ts === null) return 'unknown';
  const fmt = (zone: string): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(ts),
    );
  try {
    return fmt(timeZone);
  } catch {
    return fmt('UTC'); // an unusable zone never throws into the gate
  }
}

/** The model-facing text of one row: the transcript for a voice row, else the message text; sanitised, trimmed, capped. */
function rowText(m: Message): string {
  const raw = m.voice ? m.voice.transcript : m.text;
  return cutText(sanitizeForModel(raw).text.trim(), LIMITS.waTextChars);
}

/** Projection step 5 for one bridge row: handles only (ctx.handles), role label, relative age + coarse day, sanitised text. */
export function projectWaRow(m: Message, chatRef: number, ctx: RunCtx, nowMs: EpochMs, timeZone: string): WaToolRow {
  return {
    id: ctx.handles.msgHandle(m.rowid),
    chat: ctx.handles.chatHandle(chatRef),
    from: m.fromMe ? 'me' : 'contact',
    ago: ageLabelFor(m.ts, nowMs),
    day: dayOf(m.ts, timeZone),
    kind: m.voice ? 'voice' : 'text',
    text: rowText(m),
  };
}

/** Query normalisation (B17): NFKC, invisible / bidi / TAG / C0 stripped, whitespace collapsed, trimmed; 2..64 code points else null. */
export function normalizeWaQuery(raw: string): string | null {
  const q = stripInvisible(raw.normalize('NFKC')).replace(/\s+/gu, ' ').trim();
  const len = [...q].length;
  if (len < LIMITS.waQueryMinChars || len > LIMITS.waQueryChars) return null;
  return q;
}

function intArg(v: unknown, r: { def: number; min: number; max: number }): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return r.def;
  return Math.min(r.max, Math.max(r.min, Math.trunc(v)));
}

interface Prepared {
  m: Message;
  chatId: ChatRef;
  text: string;
}

/** execute() of wa_get_chat_messages / wa_search_messages / wa_get_message_context / wa_list_chats (READ_TOOLS[*].execute delegates here).
 *  `parsed` is the zod-parsed argument object. Returns null for bad arguments (unknown / out-of-scope handle, bad query) BEFORE any row
 *  is served, so the gate can answer blocked_bad_args (no strike) and roll the budget back. A facade exception propagates (=> unavailable). */
export async function executeWaTool(
  name: WaToolName,
  parsed: Record<string, unknown>,
  ctx: RunCtx,
  deps: Pick<ReadFacades, 'wa' | 'settings'>,
): Promise<WaToolResult | null> {
  await Promise.resolve(); // the facade is synchronous; keep one async boundary so a throw becomes a rejection for the gate
  const readTools = deps.settings().whatsapp.readTools;
  const scope: WaScope = readTools.scope === 'all_chats' ? 'all_chats' : 'trigger_chat';
  const windowDays = Math.min(LIMITS.waWindowDaysMax, Math.max(1, Math.trunc(Number(readTools.windowDays) || 1)));
  const q: WaReadQuery = { nowMs: ctx.nowMs, windowMs: windowDays * DAY_MS };
  const wa = deps.wa;
  const trigger = ctx.handles.triggerChatId;

  /** A chat handle the model passed: it must have been shown in THIS run and, in 'trigger_chat' scope, be the trigger chat (chat_1). */
  const pinChat = (handle: unknown): ChatRef | null => {
    if (typeof handle !== 'string') return null;
    const id = ctx.handles.chatIdOf(handle);
    if (id === null) return null;
    if (scope === 'trigger_chat' && id !== trigger) return null;
    return id;
  };
  const prepare = (m: Message, chatId: ChatRef): Prepared | null => {
    const text = rowText(m);
    return text === '' ? null : { m, chatId, text };
  };
  const draft = (p: Prepared): WaToolRow => ({
    id: MAX_MSG_HANDLE,
    chat: MAX_CHAT_HANDLE,
    from: p.m.fromMe ? 'me' : 'contact',
    ago: ageLabelFor(p.m.ts, ctx.nowMs),
    day: dayOf(p.m.ts, ctx.timeZone),
    kind: p.m.voice ? 'voice' : 'text',
    text: p.text,
  });
  const fits = (payload: unknown): boolean => JSON.stringify(payload).length <= LIMITS.waResultChars;
  /** Served rows feed runs.wa_rows_served, proposals.cross_chat_rows and the S4 cross-chat leak guard (memory only). */
  const served = (chatId: ChatRef, text: string): void => {
    ctx.waRowsServed += 1;
    if (chatId !== ctx.chatId) {
      ctx.crossChatRows += 1;
      ctx.otherChatTexts.push(text);
    }
  };
  const finalRow = (p: Prepared): WaToolRow => {
    served(p.chatId, p.text);
    return { ...draft(p), id: ctx.handles.msgHandle(p.m.rowid), chat: ctx.handles.chatHandle(p.chatId) };
  };
  const compact = <T>(xs: Array<T | null>): T[] => xs.filter((x): x is T => x !== null);

  switch (name) {
    case 'wa_get_chat_messages': {
      const chatId = pinChat(parsed.chat);
      if (chatId === null) return null;
      let beforeRowid: number | null = null;
      if (parsed.before_message !== undefined) {
        beforeRowid = typeof parsed.before_message === 'string' ? ctx.handles.rowidOf(parsed.before_message) : null;
        if (beforeRowid === null) return null;
        // the paging anchor must be a row of THIS chat (facade re-check; a handle of another chat is a bad argument)
        const anchor = wa.context(beforeRowid, 0, 0, q, scope, trigger);
        if (anchor === null || anchor.chatId !== chatId) return null;
      }
      const limit = intArg(parsed.limit, ARG_RANGES.chatLimit);
      const rows = wa.chatMessages(chatId, beforeRowid, limit + 1, q); // oldest -> newest ; one extra row answers `more`
      let more = rows.length > limit;
      const kept = compact(rows.slice(-limit).map((m) => prepare(m, chatId)));
      while (kept.length > 0 && !fits({ chat: MAX_CHAT_HANDLE, messages: kept.map(draft), more: true })) {
        kept.shift(); // oldest dropped first
        more = true;
      }
      const chat = ctx.handles.chatHandle(chatId);
      return { chat, messages: kept.map(finalRow), more };
    }

    case 'wa_search_messages': {
      const needle = typeof parsed.query === 'string' ? normalizeWaQuery(parsed.query) : null;
      if (needle === null) return null;
      let chatId: ChatRef | null;
      if (parsed.chat === undefined)
        chatId = scope === 'trigger_chat' ? trigger : null; // PINNED, not blocked
      else {
        chatId = pinChat(parsed.chat);
        if (chatId === null) return null;
      }
      const limit = intArg(parsed.limit, ARG_RANGES.searchLimit);
      const hits = wa.search(needle, chatId, limit, q, scope); // newest first
      const kept = compact(
        hits.map((m) => {
          // an every-chat search learns each hit's chat through the same scope-checked facade (never from the bridge JID)
          const owner = chatId ?? wa.context(m.rowid, 0, 0, q, scope, trigger)?.chatId ?? null;
          return owner === null ? null : prepare(m, owner);
        }),
      );
      let truncated = false;
      while (kept.length > 0 && !fits({ hits: kept.map(draft), truncated: true })) {
        kept.pop(); // oldest hit dropped first
        truncated = true;
      }
      return { hits: kept.map(finalRow), truncated };
    }

    case 'wa_get_message_context': {
      const rowid = typeof parsed.message === 'string' ? ctx.handles.rowidOf(parsed.message) : null;
      if (rowid === null) return null;
      const before = intArg(parsed.before, ARG_RANGES.side);
      const after = intArg(parsed.after, ARG_RANGES.side);
      const found = wa.context(rowid, before, after, q, scope, trigger);
      if (found === null) return null;
      const target = prepare(found.target, found.chatId) ?? { m: found.target, chatId: found.chatId, text: '' };
      const older = compact(found.before.map((m) => prepare(m, found.chatId)));
      const newer = compact(found.after.map((m) => prepare(m, found.chatId)));
      const shape = (): unknown => ({
        chat: MAX_CHAT_HANDLE,
        before: older.map(draft),
        message: draft(target),
        after: newer.map(draft),
      });
      while ((older.length > 0 || newer.length > 0) && !fits(shape())) {
        if (older.length > 0)
          older.shift(); // oldest dropped first
        else newer.pop();
      }
      const chat = ctx.handles.chatHandle(found.chatId);
      const beforeRows = older.map(finalRow);
      const message = finalRow(target);
      return { chat, before: beforeRows, message, after: newer.map(finalRow) };
    }

    case 'wa_list_chats': {
      if (scope !== 'all_chats') return null; // exposed only under all_chats; defence in depth behind the gate's exposure check
      const limit = intArg(parsed.limit, ARG_RANGES.listLimit);
      const entries = wa.recentChats(q, limit).map((c) => ({
        chatId: c.chatId,
        last_from: c.lastRole,
        last_ago: ageLabelFor(c.lastTs, ctx.nowMs),
        last_text: cutText(sanitizeForModel(c.lastText).text.trim(), WA_LAST_TEXT_CHARS),
      }));
      // No LIMITS.waResultChars cut is needed here: <= LIMITS.waListChats (10) entries of <= WA_LAST_TEXT_CHARS (120) characters stay
      // below 4,000 even when JSON doubles every character (waTools.test.ts pins the worst case).
      return {
        chats: entries.map((e) => {
          served(e.chatId, e.last_text);
          return {
            chat: ctx.handles.chatHandle(e.chatId),
            last_from: e.last_from,
            last_ago: e.last_ago,
            last_text: e.last_text,
          };
        }),
      };
    }
  }
}
export type { WaReadClient };
