// src/main/bridge/ingest.ts   (frozen signatures)
// Interface verbatim from docs/specs/contracts.md section 12 (owner W1-03) + the createIngest seam of build-plan section 3.
// The ONLY path from bridge message rows to the app DB. Electron-free; every collaborator is injected.
import type { Clock, ClockTimer, Logger } from '../deps';
import type { Repos } from '../db/index';
import type { Settings } from '../../shared/settings';
import { isSelfTriggerCandidate, type Stage0Fn } from '../agent/stage0';
import { findExistingEvent } from '../agent/existingEvent';
import type { BridgeDb, BridgeMessageRow, BridgeMessageRowV2 } from './bridgeDb';
import { DM_LID_JID_RE, DM_PHONE_JID_RE, LIMITS } from '../../shared/types';
import type {
  Analysis,
  ApprovalAction,
  Badge,
  Chat,
  ChatRef,
  EpochMs,
  HoldReason,
  Item,
  ItemId,
  Message,
  TriggerKind,
} from '../../shared/types';
import { parseBridgeTs } from './timestamps';

export interface IngestStats {
  scanned: number;
  kept: number;
  unparseableTs: number;
  watermark: number;
  olderLive: number;
}
/** [R2] Backlog gate (ARCHITECTURE 4.6 step 3): a row is CONTEXT-ONLY when ts < live_from_ts, or when it was scanned while the bridge is
 *  (re)syncing history (spawn .. first `history_sync_done` hint or 120 s) and now - ts > LIMITS.syncMaxAgeMs. A row scanned after the bridge has
 *  been ONLINE at least once in this app life (or with meta.last_online_ts set) is a LIVE trigger when now - ts <= LIMITS.ingestMaxAgeMs;
 *  older-but-live rows still create a raw card (analysis 'held' is NOT used; badge 'older_message', no LLM run) instead of being dropped. */
export interface Ingest {
  poke(): void; // 250 ms trailing debounce ; doorbell, timer, startup, reconnect, history-sync hint
  scanNow(): Promise<IngestStats>; // serialised ; SQLITE_BUSY => retry at the next trigger
  /** [R2] On every bridge ONLINE transition: for each @lid chat in app.db, BridgeDb.phoneJidForLid() -> repos.chats.mergeLidInto(). */
  resolveLidChats(): Promise<{ merged: number }>;
  /** Context window for S1/S3 (live read of ONE chat) - the only path from message text to the agent. */
  contextFor(chatId: import('../../shared/types').ChatRef, n: number): import('../../shared/types').Message[];
}
// ---------- supplementary seam (build-plan section 3; W0-authored, frozen in Wave 1) ----------
export interface IngestDeps {
  bridgeDb: BridgeDb;
  repos: Repos;
  classify: Stage0Fn; // agent/stage0.ts (W1-10); W1-03 uses the TYPE only
  settings: () => Settings;
  clock: Clock;
  log: Logger;
  onTsFormatError: (active: boolean) => void; // BRIDGE_TS_FORMAT streak (LIMITS.tsBadStreak) on / off
  notifyChanged: (itemIds: number[]) => void; // -> dashboard:changed
  /** Bridge lifecycle inputs for the backlog gate (ARCHITECTURE 4.6): has the bridge been ONLINE in this app life / is it (re)syncing. */
  bridgeOnlineOnce?: () => boolean;
  syncing?: () => boolean;
}

/** Where a row sits relative to the backlog gate (A14). */
type Liveness = 'context' | 'live' | 'older';

const BUSY_RE = /SQLITE_BUSY|database is locked|database table is locked/i;
const LID_CHATS_SQL = `SELECT id, jid FROM chats WHERE jid LIKE '%@lid'`;
/** [V2-W1-07, F28] Items of this chat holding a send_reply the app sent (or may have sent). Read-only; bounded. */
const SENT_REPLY_ITEMS_SQL = `SELECT DISTINCT item_id AS itemId FROM actions
  WHERE chat_id = ? AND kind = 'send_reply' AND state IN ('executing','done','unknown_outcome')
  ORDER BY item_id DESC LIMIT 50`;

function isBusyError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return BUSY_RE.test(String(e?.code ?? '')) || BUSY_RE.test(String(e?.message ?? ''));
}

function isDmJid(jid: string): boolean {
  return DM_PHONE_JID_RE.test(jid) || DM_LID_JID_RE.test(jid);
}

/** [V2] P2 2: audio (voice note) and image rows carry no text yet are still part of the conversation - V0 / V1 turn them into text. */
export function isVoiceOrImage(m: Message): boolean {
  return m.mediaType === 'audio' || m.mediaType === 'image';
}
/** Rows of the conversation window: reactions, deleted rows and text-less rows are out, EXCEPT audio / image rows (P2 2, B18/B19). */
export function isWindowRow(m: Message): boolean {
  return m.mediaType !== 'reaction' && !m.deleted && (m.text.trim() !== '' || isVoiceOrImage(m));
}
/** ARCHITECTURE 4.6 step 3 / PIPELINE 1.3 item 1: these rows may be context, never a trigger. [V2] an INBOUND audio / image row
 *  without text is a trigger candidate (S0 decides by settings.voice / settings.images); an own (from_me) text-less row never is. */
function isNeverTrigger(m: Message): boolean {
  if (!isWindowRow(m)) return true;
  return m.text.trim() === '' && m.fromMe;
}

/** [V2] items.trigger_kind at item creation (P2 2): the media type of the row that created the item. */
export function triggerKindOf(m: Message): TriggerKind {
  if (m.mediaType === 'audio') return 'voice';
  if (m.mediaType === 'image') return 'image';
  return 'text';
}

export function toMessage(r: BridgeMessageRow): Message {
  const filename = (r as Partial<BridgeMessageRowV2>).filename;
  return {
    rowid: r.rowid,
    waMsgId: r.id,
    chatJid: r.chat_jid,
    senderUser: r.sender,
    text: r.content ?? '',
    ts: parseBridgeTs(r.timestamp),
    fromMe: r.is_from_me === true || Number(r.is_from_me ?? 0) === 1,
    mediaType: r.media_type ?? '',
    deleted: r.deleted_at !== null && r.deleted_at !== undefined && r.deleted_at !== '',
    // [V2] B5: UNTRUSTED, diagnostics only - never a path, never sent to a model or the renderer
    mediaFilename: typeof filename === 'string' ? filename : null,
  };
}

/** [V2-W1-07] The raw P1 section 2 window of one chat INCLUDING audio rows that have no transcript yet (the V0 source; W2-01 wires it
 *  into VoiceServiceDeps.window). Oldest -> newest; nothing here is ever sent anywhere. */
export function mediaWindowFor(
  deps: { bridgeDb: BridgeDb; repos: Pick<Repos, 'chats'> },
  chatId: ChatRef,
  n: number,
): Message[] {
  const chat = deps.repos.chats.byId(chatId);
  if (chat === null) return [];
  if (!deps.bridgeDb.open()) return [];
  const want = Math.max(1, Math.trunc(n));
  return deps.bridgeDb
    .lastMessages(chat.jid, want * 2)
    .map(toMessage)
    .filter(isWindowRow)
    .slice(-want);
}

/** The text the user approved for an outbound action (post-edit wins), or null when the payload is gone (retention) or not a reply. */
function approvedSendText(a: ApprovalAction): string | null {
  const raw = a.approvedFinalJson !== null && a.approvedFinalJson !== '' ? a.approvedFinalJson : a.canonicalJson;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; text?: unknown };
    return parsed.kind === 'send_reply' && typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

export function createIngest(deps: IngestDeps): Ingest {
  const { bridgeDb, repos, classify, settings, clock, log, onTsFormatError, notifyChanged } = deps;

  let tsBadStreak = 0;
  let tsErrorActive = false;
  let pokeTimer: ClockTimer | null = null;
  let inFlight: Promise<IngestStats> | null = null;
  let dirty = false;

  // ---------------------------------------------------------------------------------------------------------------
  // backlog gate (A14)
  // ---------------------------------------------------------------------------------------------------------------
  const metaNumber = (
    key: 'paired_at' | 'live_from_ts' | 'bridge_rowid_watermark' | 'last_online_ts',
  ): number | null => {
    const raw = repos.meta.get(key);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const liveFromTs = (): EpochMs | null => {
    const stored = metaNumber('live_from_ts');
    if (stored !== null) return stored;
    const paired = metaNumber('paired_at');
    if (paired === null) return null;
    const hours = Math.min(72, Math.max(0, settings().whatsapp.backlogHours));
    return paired - hours * 3_600_000;
  };

  const bridgeOnlineOnce = (): boolean => deps.bridgeOnlineOnce?.() ?? metaNumber('last_online_ts') !== null;
  const bridgeSyncing = (): boolean => deps.syncing?.() ?? false;

  const liveness = (ts: EpochMs | null, now: EpochMs): Liveness => {
    if (ts === null) return 'context'; // unparseable timestamp is treated as backlog (ARCH 4.6 step 3)
    const from = liveFromTs();
    if (from !== null && ts < from) return 'context';
    const age = now - ts;
    // [repair] The 24 h sync cap suppresses a HISTORY REPLAY - rows the app could already have seen. compose.ts arms `syncing` on every
    // ordinary launch, so applying the cap to every row also swallowed the messages that arrived WHILE the app was off, which is exactly
    // the "laptop closed over a weekend" case LIMITS.ingestMaxAgeMs was raised to 7 d for (A14, shared/types.ts:159-161). A row newer than
    // meta.last_online_ts cannot be a replay of something already seen, so it takes the normal 7-day gate instead.
    if (bridgeSyncing() || !bridgeOnlineOnce()) {
      const lastOnline = metaNumber('last_online_ts');
      // lastOnline === null: the app has never been online (first pairing) - every row here IS the initial history dump.
      const couldHaveBeenSeen = lastOnline === null || ts <= lastOnline;
      if (couldHaveBeenSeen) return age > LIMITS.syncMaxAgeMs ? 'context' : 'live';
    }
    return age <= LIMITS.ingestMaxAgeMs ? 'live' : 'older';
  };

  // ---------------------------------------------------------------------------------------------------------------
  // BRIDGE_TS_FORMAT streak (LIMITS.tsBadStreak consecutive unparseable rows)
  // ---------------------------------------------------------------------------------------------------------------
  const countTimestamp = (m: Message, stats: IngestStats): void => {
    if (m.ts === null) {
      stats.unparseableTs += 1;
      tsBadStreak += 1;
      if (tsBadStreak >= LIMITS.tsBadStreak && !tsErrorActive) {
        tsErrorActive = true;
        log.error('bridge_ts_format', { streak: tsBadStreak });
        onTsFormatError(true);
      }
      return;
    }
    tsBadStreak = 0;
    if (tsErrorActive) {
      tsErrorActive = false;
      onTsFormatError(false);
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // per-chat handling (ARCHITECTURE 4.6 steps 4-6)
  // ---------------------------------------------------------------------------------------------------------------
  const ownSendMatches = (itemId: ItemId, m: Message, now: EpochMs): boolean => {
    const ts = m.ts ?? now;
    for (const a of repos.actions.forItem(itemId)) {
      if (a.kind !== 'send_reply') continue;
      if (a.state !== 'executing' && a.state !== 'done' && a.state !== 'unknown_outcome') continue;
      const at = a.executedAt ?? a.approvedAt;
      if (at === null || Math.abs(ts - at) > LIMITS.reconcileSendWindowMs) continue;
      if (approvedSendText(a) === m.text) return true;
    }
    return false;
  };

  /** [V2-W1-07, F28] P2 2 item 5 "does not match an app send": the row's wa id is the recorded result of, or its text equals the approved
   *  text of, ANY executing / done / unknown_outcome send_reply of the chat (no time window - a false match only keeps the v1 path). */
  const isAppSendInChat = (chatId: ChatRef, m: Message): boolean => {
    const ids = repos.db.prepare<{ itemId: number }>(SENT_REPLY_ITEMS_SQL).all(chatId);
    for (const { itemId } of ids) {
      for (const a of repos.actions.forItem(itemId as ItemId)) {
        if (a.kind !== 'send_reply') continue;
        if (a.state !== 'executing' && a.state !== 'done' && a.state !== 'unknown_outcome') continue;
        if (a.result?.kind === 'send_reply' && a.result.waMsgId !== null && a.result.waMsgId === m.waMsgId) return true;
        if (approvedSendText(a) === m.text) return true;
      }
    }
    return false;
  };

  /**
   * [V2-W1-07, F28 / P2 2 item 5] The ENQUEUE half of the self trigger. The user's own live text row that is not an app send, in a chat
   * whose findExistingEvent() is non-null and whose S0 verdict (every gate after the from_me rule) is queued / deferred, re-arms the open
   * item (or opens one, trigger = this row) and enqueues the chat; the orchestrator's selfTriggerRow() then runs it as a self run (only an
   * update_event, no S3). The v1 bookkeeping is kept: reply_state 'answered_elsewhere' and the pending send_reply superseded. Returns false
   * (=> the caller takes the unchanged v1 path) when any condition fails. An open item with a pending v1 event approval
   * (event_state proposed / incomplete) keeps the v1 path: a self run inserts only an update_event and would close that card not_needed.
   */
  const trySelfTrigger = (chat: Chat, m: Message, open: Item | null, now: EpochMs, touched: ItemId[]): boolean => {
    if (!isSelfTriggerCandidate(m)) return false;
    if (open !== null && (open.eventState === 'proposed' || open.eventState === 'incomplete')) return false;
    if (liveness(m.ts, now) !== 'live') return false; // backlog / history replay / older-than-7-d: never a run
    if (findExistingEvent(repos, chat.id, now) === null) return false; // without an editable event: v1 exactly
    if (isAppSendInChat(chat.id, m)) return false;
    const verdict = classify({
      chat,
      message: m,
      isLive: true,
      isOlderLive: false,
      hasOpenItem: open !== null,
      nowMs: now,
      selfTrigger: true,
    });
    if (verdict.kind !== 'queued' && verdict.kind !== 'deferred') return false;

    const triggerTs = m.ts ?? now;
    let item: Item;
    if (open === null) {
      item = repos.items.createOpen({
        chatId: chat.id,
        triggerMsgId: m.waMsgId,
        triggerTs,
        analysis: 'queued',
        holdReason: null,
        now,
      });
      // at most ONE approvable draft per chat (R2) - and the user just wrote in this chat themselves
      repos.actions.supersedePendingRepliesOfChat(chat.id, item.id, now);
    } else {
      item = repos.items.update(
        open.id,
        { replyState: 'answered_elsewhere', analysis: 'queued', holdReason: null, triggerMsgId: m.waMsgId, triggerTs },
        now,
      );
      repos.actions.supersedePendingOfKind(open.id, 'send_reply', now);
    }
    touched.push(item.id);
    repos.queue.enqueue(chat.id, now);
    if (verdict.kind === 'deferred') repos.queue.defer(chat.id, verdict.until);
    log.info('ingest_self_trigger', { chatId: chat.id, itemId: item.id, opened: open === null });
    return true;
  };

  const handleOutbound = (chat: Chat, m: Message, now: EpochMs, touched: ItemId[]): void => {
    if (m.ts !== null) repos.chats.touch(chat.id, { lastOutboundTs: m.ts });
    const item = repos.items.openForChat(chat.id);
    // our own approved send landing in messages.db is not "answered elsewhere"; exec/reconcile.ts records the wa_msg_id.
    if (item !== null && ownSendMatches(item.id, m, now)) return;
    if (trySelfTrigger(chat, m, item, now, touched)) return;
    if (item === null) return;
    const eventPending = item.eventState === 'proposed' || item.eventState === 'incomplete';
    repos.items.update(
      item.id,
      eventPending
        ? { replyState: 'answered_elsewhere' }
        : { replyState: 'answered_elsewhere', closedReason: 'answered_elsewhere', closedAt: now },
      now,
    );
    // ARCHITECTURE 182 / PIPELINE 62 + 384: "reply_state='answered_elsewhere', pending send_reply superseded; the item closes UNLESS an
    // event approval is still pending". Only the CLOSURE is conditional - the draft must never stay approvable, or one click on the
    // surviving card sends a second reply to a conversation this app itself recorded as already answered.
    if (eventPending) repos.actions.supersedePendingOfKind(item.id, 'send_reply', now);
    else repos.actions.supersedePending(item.id, now);
    touched.push(item.id);
    log.info('ingest_answered_elsewhere', { chatId: chat.id, eventPending });
  };

  const handleInbound = (chat: Chat, m: Message, now: EpochMs, stats: IngestStats, touched: ItemId[]): void => {
    const live = liveness(m.ts, now);
    if (m.ts !== null) repos.chats.touch(chat.id, { lastInboundTs: m.ts });
    const existing = repos.items.openForChat(chat.id);
    const verdict = classify({
      chat,
      message: m,
      isLive: live !== 'context',
      isOlderLive: live === 'older',
      hasOpenItem: existing !== null,
      nowMs: now,
    });
    if (verdict.kind === 'drop' || verdict.kind === 'context_only' || verdict.kind === 'no_item') return;

    const older = live === 'older';
    if (older) stats.olderLive += 1;

    // [R2] An older-but-live row is a raw card with badge 'older_message' and NEVER an LLM run, whatever S0 decided.
    let analysis: Analysis;
    let holdReason: HoldReason | null;
    if (verdict.kind === 'held') {
      analysis = 'held';
      holdReason = verdict.reason;
    } else if (older) {
      analysis = 'held';
      holdReason = null;
    } else {
      analysis = 'queued';
      holdReason = null;
    }

    const triggerTs = m.ts ?? now;
    let item: Item;
    if (existing === null) {
      item = repos.items.createOpen({ chatId: chat.id, triggerMsgId: m.waMsgId, triggerTs, analysis, holdReason, now });
      // [V2] trigger_kind is set at item creation from the row that created it (S4 rewrites it per proposal version, P2 2)
      const kind = triggerKindOf(m);
      if (kind !== 'text') item = repos.items.update(item.id, { triggerKind: kind }, now);
      if (older) item = repos.items.update(item.id, { badges: withOlderBadge([]) }, now);
      // [R2] at most ONE approvable draft per chat: a new open item supersedes pending send_reply actions of this chat's other items.
      repos.actions.supersedePendingRepliesOfChat(chat.id, item.id, now);
    } else {
      item = repos.items.update(
        existing.id,
        {
          analysis,
          holdReason,
          triggerMsgId: m.waMsgId,
          triggerTs,
          badges: older ? withOlderBadge(existing.badges) : existing.badges,
        },
        now,
      );
    }
    // [v2-repair REQUEST 7] a hold with a reason code (CLOUD_QUOTA) carries it on the item: the raw card says why, and compose
    // releases exactly these holds once the subscription window has reset.
    if (!older && verdict.kind === 'held' && verdict.code !== undefined) {
      item = repos.items.update(item.id, { errorCode: verdict.code }, now);
    }
    touched.push(item.id);

    if (older) return; // no queue row => no LLM run
    if (verdict.kind === 'queued' || verdict.kind === 'deferred') {
      repos.queue.enqueue(chat.id, now);
      if (verdict.kind === 'deferred') repos.queue.defer(chat.id, verdict.until);
    }
  };

  const handleChat = (jid: string, msgs: Message[], now: EpochMs, stats: IngestStats, touched: ItemId[]): void => {
    // [R2] @lid -> phone JID through the bridge's own mapping; an existing @lid chat row is merged into the phone-JID chat.
    let effectiveJid = jid;
    if (DM_LID_JID_RE.test(jid)) {
      const phone = bridgeDb.phoneJidForLid(jid);
      if (phone !== null && DM_PHONE_JID_RE.test(phone)) {
        const lidChat = repos.chats.byJid(jid);
        if (lidChat !== null) repos.chats.mergeLidInto(lidChat.id, phone, now);
        effectiveJid = phone;
      }
    }
    const bothForms = effectiveJid !== jid;
    const isKnown = bridgeDb.userHasSentIn(effectiveJid) || (bothForms && bridgeDb.userHasSentIn(jid));
    const name = bridgeDb.chatName(jid) ?? (bothForms ? bridgeDb.chatName(effectiveJid) : null);
    const chat = repos.chats.upsertFromBridge(effectiveJid, name, isKnown, now);

    // ARCHITECTURE 4.6 steps 5-6: the NEWEST trigger-eligible row of the chat decides.
    let newest: Message | null = null;
    for (const m of msgs) if (!isNeverTrigger(m)) newest = m;
    if (newest === null) return;
    if (newest.fromMe) handleOutbound(chat, newest, now, touched);
    else handleInbound(chat, newest, now, stats, touched);
  };

  // ---------------------------------------------------------------------------------------------------------------
  // scan
  // ---------------------------------------------------------------------------------------------------------------
  const processBatch = (rows: BridgeMessageRow[], batchMax: number, stats: IngestStats): ItemId[] => {
    const now = clock.now();
    const byChat = new Map<string, Message[]>();
    for (const r of rows) {
      stats.scanned += 1;
      const m = toMessage(r);
      countTimestamp(m, stats);
      if (!isDmJid(m.chatJid)) continue;
      if (isNeverTrigger(m)) continue;
      stats.kept += 1;
      const list = byChat.get(m.chatJid);
      if (list === undefined) byChat.set(m.chatJid, [m]);
      else list.push(m);
    }
    const touched: ItemId[] = [];
    // step 7: the watermark is persisted in the SAME transaction as the item/queue writes.
    repos.db.transaction(() => {
      for (const [jid, msgs] of byChat) handleChat(jid, msgs, now, stats, touched);
      repos.meta.set('bridge_rowid_watermark', String(batchMax));
    });
    return touched;
  };

  const runScan = (): IngestStats => {
    const stats: IngestStats = {
      scanned: 0,
      kept: 0,
      unparseableTs: 0,
      watermark: metaNumber('bridge_rowid_watermark') ?? 0,
      olderLive: 0,
    };
    if (!bridgeDb.open()) return stats; // file does not exist yet
    let watermark = stats.watermark;
    const max = bridgeDb.maxRowid();
    if (max < watermark) {
      // store wiped: rowids restarted. Reset; the backlog gate keeps the re-scanned rows context-only.
      watermark = 0;
      stats.watermark = 0;
      repos.db.transaction(() => repos.meta.set('bridge_rowid_watermark', '0'));
      log.warn('ingest_watermark_reset', { max });
    }
    for (;;) {
      const rows = bridgeDb.rowsAfter(watermark, LIMITS.ingestBatch);
      if (rows.length === 0) break;
      const batchMax = (rows[rows.length - 1] as BridgeMessageRow).rowid;
      const touched = processBatch(rows, batchMax, stats);
      watermark = batchMax;
      stats.watermark = batchMax;
      if (touched.length > 0) notifyChanged(touched);
      if (rows.length < LIMITS.ingestBatch) break;
    }
    return stats;
  };

  const scanOnce = async (): Promise<IngestStats> => {
    try {
      return await Promise.resolve().then(runScan);
    } catch (err) {
      if (isBusyError(err)) {
        // never change the journal mode, never retry in a tight loop: the next trigger picks the rows up.
        log.warn('ingest_busy');
        return {
          scanned: 0,
          kept: 0,
          unparseableTs: 0,
          watermark: metaNumber('bridge_rowid_watermark') ?? 0,
          olderLive: 0,
        };
      }
      throw err;
    } finally {
      inFlight = null;
      if (dirty) {
        dirty = false;
        poke();
      }
    }
  };

  const scanNow = (): Promise<IngestStats> => {
    if (inFlight !== null) {
      dirty = true;
      return inFlight;
    }
    inFlight = scanOnce();
    return inFlight;
  };

  function poke(): void {
    if (pokeTimer !== null) return;
    pokeTimer = clock.setTimeout(() => {
      pokeTimer = null;
      void scanNow().catch((err: unknown) => log.error('ingest_scan_failed', { error: (err as Error).name }));
    }, LIMITS.pokeDebounceMs);
  }

  /**
   * [repair data-integrity-2] `async`, not a plain arrow returning `Promise.resolve(...)`. Everything below runs synchronously
   * (`repos.db.transaction` is sync), so as a plain arrow a throw from `mergeLidInto` - a RowNotFoundError, a SQLite abort -
   * escaped BEFORE the Promise existed. `void ingest.resolveLidChats().catch(() => undefined)` (compose.ts) then never got to
   * attach its handler and the exception tore through the bridge status-callback loop that invoked it. `async` makes the
   * declared return type hold: every failure arrives as a rejection the caller can actually catch.
   */
  const resolveLidChats = async (): Promise<{ merged: number }> => {
    if (!bridgeDb.open()) return { merged: 0 };
    const now = clock.now();
    const rows = repos.db.prepare<{ id: number; jid: string }>(LID_CHATS_SQL).all();
    let merged = 0;
    for (const row of rows) {
      const phone = bridgeDb.phoneJidForLid(row.jid);
      if (phone === null || !DM_PHONE_JID_RE.test(phone)) continue;
      repos.db.transaction(() => repos.chats.mergeLidInto(row.id as ChatRef, phone, now));
      merged += 1;
    }
    if (merged > 0) log.info('ingest_lid_resolved', { merged });
    return { merged };
  };

  const contextFor = (chatId: ChatRef, n: number): Message[] => {
    const chat = repos.chats.byId(chatId);
    if (chat === null) return [];
    if (!bridgeDb.open()) return [];
    const want = Math.max(1, Math.trunc(n));
    const out: Message[] = [];
    for (const m of bridgeDb.lastMessages(chat.jid, want * 2).map(toMessage)) {
      if (!isWindowRow(m)) continue;
      if (m.mediaType === 'audio') {
        // [V2] C2 12 / P2 3.3: an audio row enters the window only with a 'done' transcript (Message.voice); failed / aborted / empty /
        // missing transcripts are omitted, never an empty-text row. The text stays UNTRUSTED (nonce block + inert VoiceBubble only).
        const t = repos.transcripts.get(m.chatJid, m.waMsgId);
        if (t === null || t.status !== 'done' || t.text === null || t.text === '') continue;
        out.push({ ...m, voice: { transcript: t.text, language: t.language, seconds: t.seconds } });
        continue;
      }
      out.push(m);
    }
    return out.slice(-want);
  };

  return { poke, scanNow, resolveLidChats, contextFor };
}

function withOlderBadge(badges: readonly Badge[]): Badge[] {
  return badges.includes('older_message') ? [...badges] : [...badges, 'older_message'];
}
