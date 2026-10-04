// src/main/bridge/waReadClient.ts   ADD (frozen once accepted) - the READ facade over BridgeDb that ToolGate touches (D-040, B17).
// NO write method exists; no bridge HTTP client is in scope (import-graph test: never bridge/sendClient, bridge/readClient, mcp/*, exec/**, llm/**, electron).
// Owner V2-W1-05-wa-toolserver. Everything returned is RAW, UNTRUSTED text; the projection (agent/waTools.ts) sanitises it.
import type { BridgeDb, BridgeMessageRowV2 } from './bridgeDb';
import type { ChatRef, EpochMs, Message, Chat, TranscriptRecord } from '../../shared/types';
import type { Settings } from '../../shared/settings';
import { parseBridgeTs } from './timestamps';

export type WaScope = 'trigger_chat' | 'all_chats';
export interface WaReadQuery {
  nowMs: EpochMs;
  windowMs: number;
} // app-pinned by the gate (settings.whatsapp.readTools.windowDays), never by a model
export interface WaChatSummary {
  chatId: ChatRef;
  lastTs: EpochMs | null;
  lastRole: 'me' | 'contact' | null;
  lastText: string;
} // lastText raw, UNTRUSTED
/** Row filter applied by every method: deleted rows out; media_type reaction/sticker out; text-less rows out UNLESS media_type = 'audio' and a
 *  transcripts row with status 'done' exists (then Message.voice is set and text = '') ; groups / status / newsletter JIDs never appear;
 *  chats with policy 'never' and unknown-sender chats (unless settings.whatsapp.processUnknownSenders) are invisible ; SQLITE_BUSY => [] / null. */
export interface WaReadClient {
  /** DM chats the model may see (all_chats scope only), newest activity first. Unknown JIDs are skipped, never created. */
  recentChats(q: WaReadQuery, n: number): WaChatSummary[];
  /** Last n rows of ONE chat with rowid < beforeRowid (null = newest), oldest -> newest. */
  chatMessages(chatId: ChatRef, beforeRowid: number | null, n: number, q: WaReadQuery): Message[];
  /** Substring search (needle already NFKC + stripInvisible + trimmed by the gate). chatId = null only when scope === 'all_chats';
   *  the facade re-checks the scope and returns [] otherwise. */
  search(needle: string, chatId: ChatRef | null, n: number, q: WaReadQuery, scope: WaScope): Message[];
  /** Target row + up to before/after neighbours of the SAME chat by rowid. null when the rowid is not in that chat or out of scope. */
  context(
    rowid: number,
    before: number,
    after: number,
    q: WaReadQuery,
    scope: WaScope,
    triggerChatId: ChatRef,
  ): { chatId: ChatRef; target: Message; before: Message[]; after: Message[] } | null;
}

/** DM JIDs only: a phone JID or its @lid twin. Groups (@g.us), status@broadcast, newsletters and anything else never appear. */
const DM_JID_RE = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;
/** Rows read per page when the facade over-reads and filters (like Ingest.contextFor over-reads). */
const PAGE_ROWS = 200;
/** Upper bound of rows one facade call walks (the window is <= 90 d; a pathological chat must not turn a tool call into a table scan). */
const MAX_SCAN_ROWS = 2_000;
/** Media types that never reach a model (reaction = an emoji pointing at another row; sticker = a picture without text). */
const HIDDEN_MEDIA = new Set(['reaction', 'sticker']);

function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}
/** SQLITE_BUSY / SQLITE_LOCKED anywhere below (incl. the v1 BridgeDb helpers) => the empty answer; anything else propagates to the gate,
 *  which maps it to 'unavailable' (never an exception to the model). */
function busySafe<T>(empty: T, read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (isBusy(e)) return empty;
    throw e;
  }
}
function wholeCount(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(n)));
}

export function createWaReadClient(deps: {
  bridgeDb: BridgeDb;
  chats: { byJid(jid: string): Chat | null; byId(id: ChatRef): Chat | null }; // repos.chats subset
  transcripts: { get(chatJid: string, waMsgId: string): TranscriptRecord | null }; // repos.transcripts subset
  settings: () => Settings;
}): WaReadClient {
  const { bridgeDb } = deps;

  /** Scope-independent visibility of an app chat: DM, policy not 'never', and known (or forced, or unknown senders processed). */
  const visible = (chat: Chat | null): chat is Chat => {
    if (chat === null || !DM_JID_RE.test(chat.jid)) return false;
    if (chat.policy === 'never') return false;
    return chat.isKnown || chat.forceKnown || deps.settings().whatsapp.processUnknownSenders;
  };

  /** Bridge JID (either form) -> the app chat it belongs to; unknown JIDs are skipped, never created. */
  const chatOfJid = (jid: string): Chat | null => {
    if (!DM_JID_RE.test(jid)) return null;
    const direct = deps.chats.byJid(jid);
    if (direct !== null) return direct;
    if (!jid.endsWith('@lid')) return null;
    const phone = bridgeDb.phoneJidForLid(jid);
    return phone === null ? null : deps.chats.byJid(phone);
  };

  const transcriptOf = (row: BridgeMessageRowV2, chat: Chat): TranscriptRecord | null =>
    deps.transcripts.get(row.chat_jid, row.id) ??
    (row.chat_jid === chat.jid ? null : deps.transcripts.get(chat.jid, row.id));

  /** Row filter + window (parsed timestamps only; an unparseable timestamp makes the row invisible). null = the row never reaches a model. */
  const toMessage = (row: BridgeMessageRowV2, chat: Chat, q: WaReadQuery): Message | null => {
    if (row.deleted_at !== null) return null;
    const mediaType = row.media_type ?? '';
    if (HIDDEN_MEDIA.has(mediaType)) return null;
    const ts = parseBridgeTs(row.timestamp);
    if (ts === null || ts < q.nowMs - q.windowMs) return null;
    const base = {
      rowid: row.rowid,
      waMsgId: row.id,
      chatJid: row.chat_jid,
      senderUser: row.sender,
      ts,
      fromMe: Number(row.is_from_me) === 1,
      mediaType,
      deleted: false,
    };
    if (mediaType === 'audio') {
      // audio surfaces ONLY through app.db transcripts (B18): never the bytes, never the file name
      const t = transcriptOf(row, chat);
      if (t === null || t.status !== 'done' || t.text === null || t.text.trim() === '') return null;
      return { ...base, text: '', voice: { transcript: t.text, language: t.language, seconds: t.seconds } };
    }
    const text = row.content ?? '';
    if (text.trim() === '') return null; // media-only rows carry no analysable text and no metadata may leak
    return { ...base, text };
  };

  /** Newest-first walk of ONE chat below `beforeRowid`, `want` visible rows at most (returned newest-first). */
  const newestVisible = (chat: Chat, beforeRowid: number | null, want: number, q: WaReadQuery): Message[] => {
    const out: Message[] = [];
    let cursor = beforeRowid;
    let scanned = 0;
    while (out.length < want && scanned < MAX_SCAN_ROWS) {
      const page = bridgeDb.messagesBefore(chat.jid, cursor, PAGE_ROWS);
      for (const row of page) {
        const m = toMessage(row, chat, q);
        if (m !== null) out.push(m);
        if (out.length >= want) break;
      }
      scanned += page.length;
      if (page.length < PAGE_ROWS) break;
      cursor = page[page.length - 1]!.rowid;
    }
    return out;
  };

  const chatMessages = (chatId: ChatRef, beforeRowid: number | null, n: number, q: WaReadQuery): Message[] => {
    const chat = deps.chats.byId(chatId);
    if (!visible(chat)) return [];
    const want = wholeCount(n, MAX_SCAN_ROWS);
    if (want === 0) return [];
    return newestVisible(chat, beforeRowid, want, q).reverse();
  };

  return {
    recentChats: (q, n) =>
      busySafe<WaChatSummary[]>([], () => {
        const want = wholeCount(n, PAGE_ROWS);
        if (want === 0) return [];
        const out: WaChatSummary[] = [];
        const seen = new Set<ChatRef>();
        for (const { jid } of bridgeDb.recentDmChats(Math.min(PAGE_ROWS, Math.max(want * 3, 30)))) {
          const chat = chatOfJid(jid);
          if (!visible(chat) || seen.has(chat.id)) continue;
          seen.add(chat.id);
          const last = newestVisible(chat, null, 1, q)[0];
          if (last === undefined) continue; // nothing inside the window
          out.push({
            chatId: chat.id,
            lastTs: last.ts,
            lastRole: last.fromMe ? 'me' : 'contact',
            lastText: last.voice ? last.voice.transcript : last.text,
          });
          if (out.length >= want) break;
        }
        return out;
      }),

    chatMessages: (chatId, beforeRowid, n, q) => busySafe<Message[]>([], () => chatMessages(chatId, beforeRowid, n, q)),

    search: (needle, chatId, n, q, scope) =>
      busySafe<Message[]>([], () => {
        const want = wholeCount(n, PAGE_ROWS);
        if (want === 0 || needle === '') return [];
        const read = Math.min(PAGE_ROWS, Math.max(want * 4, 40));
        const out: Message[] = [];
        if (chatId === null) {
          if (scope !== 'all_chats') return []; // the gate pins; the facade re-checks (defence in depth)
          for (const row of bridgeDb.searchContent(needle, null, 0, read)) {
            const chat = chatOfJid(row.chat_jid);
            if (!visible(chat)) continue;
            const m = toMessage(row, chat, q);
            if (m !== null) out.push(m);
            if (out.length >= want) break;
          }
          return out;
        }
        const chat = deps.chats.byId(chatId);
        if (!visible(chat)) return [];
        for (const row of bridgeDb.searchContent(needle, chat.jid, 0, read)) {
          const m = toMessage(row, chat, q);
          if (m !== null) out.push(m);
          if (out.length >= want) break;
        }
        return out;
      }),

    context: (rowid, before, after, q, scope, triggerChatId) =>
      busySafe<ReturnType<WaReadClient['context']>>(null, () => {
        const row = bridgeDb.messageByRowid(rowid);
        if (row === null) return null;
        const chat = chatOfJid(row.chat_jid);
        if (!visible(chat)) return null;
        if (scope !== 'all_chats' && chat.id !== triggerChatId) return null;
        const target = toMessage(row, chat, q);
        if (target === null) return null;
        const nBefore = wholeCount(before, MAX_SCAN_ROWS);
        const nAfter = wholeCount(after, MAX_SCAN_ROWS);
        const older = nBefore === 0 ? [] : newestVisible(chat, target.rowid, nBefore, q).reverse();
        return {
          chatId: chat.id,
          target,
          before: older,
          after: nAfter === 0 ? [] : newerThan(chat, target, nAfter, q),
        };
      }),
  };

  /** The `want` visible rows right AFTER the target (oldest -> newest). BridgeDb reads newest-first below a cursor, so the walk starts at
   *  the newest row and keeps the rows closest to the target; when the scan cap is hit before reaching the target, nothing is returned
   *  (never a wrong neighbourhood). */
  function newerThan(chat: Chat, target: Message, want: number, q: WaReadQuery): Message[] {
    let kept: Message[] = []; // newest-first
    let cursor: number | null = null;
    let scanned = 0;
    while (scanned < MAX_SCAN_ROWS) {
      const page = bridgeDb.messagesBefore(chat.jid, cursor, PAGE_ROWS);
      for (const row of page) {
        if (row.rowid <= target.rowid) return kept.slice(-want).reverse();
        const m = toMessage(row, chat, q);
        if (m !== null) kept.push(m);
        if (kept.length > want) kept = kept.slice(-want);
      }
      scanned += page.length;
      if (page.length < PAGE_ROWS) return kept.slice(-want).reverse();
      cursor = page[page.length - 1]!.rowid;
    }
    return [];
  }
}
