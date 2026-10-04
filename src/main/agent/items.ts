// src/main/agent/items.ts - ItemService: view models + user item actions (build-plan section 3; owner W1-10).
// Builds every ItemCard / ItemDetail / ChatView that crosses IPC (JIDs never; phoneDisplay is formatted here).
// [R2] No calendarHtmlLink in any view model: "Open in calendar" is external:open {itemId, target:'calendarEvent'} and main
// builds that URL itself from event_start_ts.
import { EventEditSchema, type EventContentWithStatus } from '../../shared/schemas';
import { cardKind, deriveStatus, isListed, isOpen } from '../../shared/state';
import { localToEpochMs } from '../../shared/when';
import {
  DM_PHONE_JID_RE,
  LIMITS,
  type ActionDisabledReason,
  type ActionState,
  type ActionView,
  type ApprovalAction,
  type AutoCardView,
  type AutoPolicyRecord,
  type Chat,
  type ChangeView,
  type ChatView,
  type DashboardData,
  type EpochMs,
  type EventContentView,
  type ImageReadView,
  type Item,
  type ItemCard,
  type ItemDetail,
  type ItemId,
  type ItemState,
  type MessageView,
  type Proposal,
  type Result,
  type UndoView,
  type VoiceView,
} from '../../shared/types';
import type { Clock, Logger } from '../deps';
import type { Repos } from '../db/index';
import type { Settings } from '../../shared/settings';
import type { IpcReq } from '../../shared/ipc';
import type { ErrorCode } from '../../shared/errors';
import { createHash } from 'node:crypto';

/** C2 1.5 ItemCard.calendar.eventKey: first 16 hex of sha256('wca-event|' + calendar_event_id), computed in main so the Google event id
 *  never crosses IPC (C2 concern #10, UX2 C19). One-way and fixed-length: the key can never equal or contain the id. */
export function eventKeyOf(calendarEventId: string): string {
  return createHash('sha256').update(`wca-event|${calendarEventId}`, 'utf8').digest('hex').slice(0, 16);
}
/** A calendar item without an event id (never written by the executor; only a damaged row) still gets a stable, id-free key. */
function orphanEventKeyOf(itemId: ItemId): string {
  return createHash('sha256').update(`wca-item|${itemId}`, 'utf8').digest('hex').slice(0, 16);
}
/** Event states whose card carries `calendar` (C2 1.5: created | updated | cancelled). */
const CALENDAR_STATES: ReadonlySet<Item['eventState']> = new Set(['created', 'updated', 'cancelled']);
/** item:completeEvent is refused once an event exists or a change of one is pending (the executor would write a second event). */
const COMPLETE_EVENT_REFUSED_STATES: ReadonlySet<Item['eventState']> = new Set([
  'created',
  'updated',
  'cancelled',
  'change_proposed',
]);
/** The picture handed to the renderer is always a JPEG data URL; anything else from the cache is refused. */
const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export interface ItemService {
  dashboard(): DashboardData;
  detail(id: ItemId): Result<ItemDetail>;
  ignored(): { items: ItemCard[] }; // last 20 with closed_reason='dismissed'
  dismiss(id: ItemId): Result<ItemDetail>;
  restore(id: ItemId): Result<ItemDetail>;
  retriage(id: ItemId): Result<ItemDetail>; // RATE_LIMIT_RETRIAGE when over budget
  setEditing(id: ItemId, on: boolean): Result<null>;
  completeEvent(req: IpcReq<'item:completeEvent'>): Result<ItemDetail>; // proposal (provider 'user') + pending create_event
  setChatPolicy(req: IpcReq<'chat:setPolicy'>): Result<ChatView>; // [V2] + the {autoPolicy} member (repos.chats.setAutoPolicy)
  listPolicies(): { chats: ChatView[] };
  /** [V2 ADD] v2-build-plan 3 seam (owner V2-W1-10): item:getImage - the normalised picture as a data URL (<= LIMITS.imageDataUrlMaxBytes). */
  getImage(itemId: ItemId): Result<{ dataUrl: string }>;
}
export interface ItemServiceDeps {
  repos: Repos;
  settings: () => Settings;
  clock: Clock;
  log: Logger;
  bridgeOnline: () => boolean; // ActionView.disabledReason
  bridgeOutdated: () => boolean;
  calendarConnected: () => boolean;
  notifyChanged: (itemIds: number[]) => void;
  /**
   * WIRING CONTRACT (W2-01): this is `TriageQueue.poke` bound to the queue - a doorbell, nothing else.
   * `ItemService` has already written the `triage_queue` row inside its own transaction, so a second
   * `repos.queue.enqueue(...)` here would re-arm the debounce and double-book the chat.
   */
  enqueueRetriage: (chatRef: number) => void;
  // ---- [V2 ADD] optional so the v1 wiring keeps compiling; each ABSENT member fails closed ----
  /** McpHost.updateSurface().available (B4). Absent / false => update_event buttons greyed 'calendar_updates_unavailable'. */
  updatesAvailable?: () => boolean;
  /** V2-W1-07's media cache (B19). Absent => no thumbnails, item:getImage answers MEDIA_UNAVAILABLE.
   *  [fix data-integrity-v4-7] `deleteForItem` (rows + files) is used by "Never analyse"; absent => the chat's cached pictures stay
   *  until retention (logged), never a row deleted without its files. */
  mediaCache?: {
    thumb(itemId: ItemId): string | null;
    dataUrl(itemId: ItemId): string | null;
    deleteForItem?(itemId: ItemId): number;
  };
}

// [fix data-integrity-v4-7] ARCHITECTURE-v2 9.3 / B19 / v2-pipeline 4: transcripts.text and proposals.delta_json / image_json are nulled
// "with the 30-day job AND at once on Dismiss / 'Never analyse'" - the same columns repos.retention.purge() nulls, keyed by item / chat.
/** Transcripts of the item's own messages (the snapshot window + the trigger row), in the item's chat. */
const FORGET_ITEM_TRANSCRIPTS_SQL = `UPDATE transcripts SET text = NULL
   WHERE text IS NOT NULL
     AND chat_jid = (SELECT c.jid FROM items i JOIN chats c ON c.id = i.chat_id WHERE i.id = ?1)
     AND (wa_msg_id IN (SELECT wa_msg_id FROM item_messages WHERE item_id = ?1)
          OR wa_msg_id = (SELECT trigger_msg_id FROM items WHERE id = ?1))`;
const FORGET_ITEM_PROPOSALS_SQL = `UPDATE proposals SET delta_json = NULL, image_json = NULL
   WHERE item_id = ? AND (delta_json IS NOT NULL OR image_json IS NOT NULL)`;
const FORGET_CHAT_TRANSCRIPTS_SQL = `UPDATE transcripts SET text = NULL
   WHERE text IS NOT NULL AND chat_jid = (SELECT jid FROM chats WHERE id = ?)`;
const FORGET_CHAT_PROPOSALS_SQL = `UPDATE proposals SET delta_json = NULL, image_json = NULL
   WHERE item_id IN (SELECT id FROM items WHERE chat_id = ?) AND (delta_json IS NOT NULL OR image_json IS NOT NULL)`;
const CHAT_MEDIA_ITEMS_SQL = `SELECT DISTINCT item_id AS itemId FROM media_cache WHERE chat_id = ? AND item_id IS NOT NULL
   ORDER BY item_id`;

const HOUR_MS = 3_600_000;
/** Action states a card still shows a control or an error line for. */
const VISIBLE_ACTION_STATES: ReadonlySet<ActionState> = new Set<ActionState>([
  'pending',
  'approved',
  'executing',
  'failed',
  'unknown_outcome',
]);
/** `ignored()` returns dismissed cards only, so the raw list is read wider than the 20 rows that survive the filter. */
const IGNORED_SCAN_LIMIT = 200;

const err = <T>(code: ErrorCode): Result<T> => ({ ok: false, error: { code } });

/** Pure: '+972 50-123-4567' from a phone JID user part; '' for @lid. Display text only. */
export function formatPhoneDisplay(jid: string): string {
  if (!DM_PHONE_JID_RE.test(jid)) return '';
  const digits = jid.slice(0, jid.indexOf('@'));
  // Israeli mobile/landline numbers are the only ones this app realistically sees; everything else stays grouped by threes.
  if (digits.startsWith('972') && digits.length === 12) {
    return `+972 ${digits.slice(3, 5)}-${digits.slice(5, 8)}-${digits.slice(8)}`;
  }
  if (digits.startsWith('972') && digits.length === 11) {
    return `+972 ${digits.slice(3, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  const groups = digits.slice(1).replace(/(\d{3})(?=\d)/g, '$1 ');
  return `+${digits.slice(0, 1)}${groups === '' ? '' : ` ${groups}`}`;
}

export function createItemService(deps: ItemServiceDeps): ItemService {
  const { repos, settings, clock, log, notifyChanged } = deps;

  const chatViewOf = (chat: Chat): ChatView => ({
    chatRef: chat.id,
    displayName: chat.displayName ?? '',
    phoneDisplay: formatPhoneDisplay(chat.jid),
    sendable: chat.sendable,
    isKnown: chat.isKnown || chat.forceKnown,
    policy: chat.policy,
    autoPolicy: chat.autoPolicy, // [V2]
  });

  const disabledReasonFor = (kind: ApprovalAction['kind']): ActionDisabledReason | null => {
    if (kind === 'send_reply') {
      if (deps.bridgeOutdated()) return 'bridge_outdated';
      if (!deps.bridgeOnline()) return 'wa_offline';
      return null;
    }
    if (!deps.calendarConnected()) return 'calendar_unavailable';
    // [V2] B4 narrow fail-closed guard: without a verified update surface only the update buttons grey out; creates keep working.
    if (kind === 'update_event' && !(deps.updatesAvailable?.() ?? false)) return 'calendar_updates_unavailable';
    return null;
  };

  /**
   * [V2] A v2 decoration (revision, transcript, picture, automatic-mode row) is ADVISORY: the executor re-checks every one of them
   * at click time. A failing lookup therefore degrades that one field to its fail-closed value (no Undo door, no chip, no
   * thumbnail) and is logged by field name only - it never takes the dashboard down with it.
   */
  /** [fix data-integrity-v4-7] "Never analyse": null the chat's media-derived text in one transaction, then delete every cached picture
   *  of the chat's items through the media cache (rows + files). A media_cache row not linked to an item is left to retention. */
  const forgetChatMedia = (chatRef: number): void => {
    repos.db.transaction(() => {
      repos.db.prepare(FORGET_CHAT_TRANSCRIPTS_SQL).run(chatRef);
      repos.db.prepare(FORGET_CHAT_PROPOSALS_SQL).run(chatRef);
    });
    const itemIds = repos.db.prepare<{ itemId: number }>(CHAT_MEDIA_ITEMS_SQL).all(chatRef);
    if (itemIds.length === 0) return;
    const deleteForItem = deps.mediaCache?.deleteForItem;
    if (deleteForItem === undefined) {
      log.warn('media_cache_delete_unwired', { chatRef, items: itemIds.length });
      return;
    }
    for (const { itemId } of itemIds) {
      try {
        deleteForItem(itemId);
      } catch (e) {
        log.warn('media_cache_delete_failed', { chatRef, reason: e instanceof Error ? e.name : 'unknown' });
      }
    }
  };
  const decorate = <T>(field: string, itemId: ItemId, fallback: T, build: () => T): T => {
    try {
      return build();
    } catch (e) {
      log.warn('item_view_degraded', { field, itemId, name: e instanceof Error ? e.name : 'unknown' });
      return fallback;
    }
  };

  const contentView = (c: EventContentWithStatus): EventContentView => ({
    title: c.title,
    startLocal: c.startLocal,
    endLocal: c.endLocal,
    timeZone: c.timeZone,
    location: c.location,
    status: c.status,
  });

  /** C2 1.5 ChangeView: the pending delta of a change card, from proposals.delta_json (never renderer-supplied). */
  const changeViewOf = (item: Item, proposal: Proposal | null): ChangeView | null => {
    if (item.eventState !== 'change_proposed' || proposal === null || proposal.delta === null) return null;
    const d = proposal.delta;
    return {
      kind: d.kind,
      from: contentView(d.from),
      to: contentView(d.to),
      confidence: d.confidence,
      baseRevision: d.baseRevision,
    };
  };

  /** The start (epoch) a revision's undo would restore: prev start for a change, the created event's own start for a create. */
  const restoreTargetStart = (
    prev: EventContentWithStatus | null,
    next: EventContentWithStatus | null,
  ): EpochMs | null => {
    const target = prev ?? next;
    if (target === null) return null;
    try {
      return localToEpochMs(target.startLocal, target.timeZone);
    } catch {
      return null;
    }
  };

  /** The automatic write behind an action (auto_decisions -> auto_writes), or null for a click-approved one. */
  const autoWriteOf = (actionId: ApprovalAction['id']): ReturnType<Repos['autoWrites']['byId']> => {
    const decision = repos.autoDecisions.forAction(actionId);
    if (decision === null || decision.verdict !== 'auto') return null;
    return repos.autoWrites.since(decision.decidedAt).find((w) => w.actionId === actionId) ?? null;
  };

  /**
   * Whether this card CURRENTLY holds its event (F27 chain, same rule as the executor's holderOf): every applied change moves the event
   * to its acting item, so after a chain older cards (closed 'superseded') still carry the id with a stale event_revision. The holder
   * is the card with the highest event_revision (a tie keeps this card). The undo candidate may belong to an older card - after undo #1
   * of a chain it usually does - and the holder card is still the one door that shows it (W1-04 request).
   */
  const holdsEvent = (item: Item, eventId: string): boolean =>
    repos.items.byCalendarEventId(eventId).every((x) => x.id === item.id || x.eventRevision <= item.eventRevision);

  /**
   * C2 1.5 UndoView (B10, F1, F2): the event's undo CANDIDATE, shown only while undo is possible or its refusal must be explained.
   * Manual: until min(appliedAt + LIMITS.manualUndoWindowMs, start of the restore target). Automatic: auto_writes.undo_until and
   * its undo_state; `blocked_*` / `failed` stay visible (the card explains them), `expired` / `undone` never do.
   */
  const undoViewOf = (item: Item, now: EpochMs): UndoView | null => {
    if (!CALENDAR_STATES.has(item.eventState) || item.calendarEventId === null) return null;
    if (!holdsEvent(item, item.calendarEventId)) return null;
    const rev = repos.eventRevisions.undoCandidate(item.calendarEventId);
    if (rev === null) return null;
    const write = autoWriteOf(rev.actionId);
    if (write !== null) {
      if (write.undoState === 'undone' || write.undoState === 'expired') return null;
      if (write.undoState === 'available' && now >= write.undoUntil) return null;
      return { revisionId: rev.id, until: write.undoUntil, state: write.undoState, automatic: true };
    }
    const targetStart = restoreTargetStart(rev.prev, rev.next);
    if (targetStart === null) return null;
    const until = Math.min(rev.appliedAt + LIMITS.manualUndoWindowMs, targetStart);
    if (now >= until) return null;
    return { revisionId: rev.id, until, state: 'available', automatic: false };
  };

  /**
   * C2 1.5 AutoCardView (B11 door 3): the decision of this version's calendar action. Chip for `auto` / `shadow`; the muted
   * "Not automatic: {reason}" line only for a PENDING action while a policy is live, and never for `policy_shadow` (UX2 3.2).
   */
  const autoViewOf = (item: Item, live: AutoPolicyRecord | null): AutoCardView | null => {
    const calendarActions = repos.actions
      .forItem(item.id)
      .filter((a) => a.proposalId === item.currentProposalId && a.kind !== 'send_reply')
      .sort((x, y) => y.attempt - x.attempt);
    for (const action of calendarActions) {
      const decision = repos.autoDecisions.forAction(action.id);
      if (decision === null) continue;
      const chip = decision.verdict === 'auto' ? 'automatic' : decision.verdict === 'shadow' ? 'auto_shadow' : null;
      const reason =
        decision.verdict === 'fallback' &&
        action.state === 'pending' &&
        live !== null &&
        decision.reason !== 'policy_shadow' &&
        decision.reason !== 'ok'
          ? decision.reason
          : null;
      const autoWriteId = decision.verdict === 'auto' ? (autoWriteOf(action.id)?.id ?? null) : null;
      if (chip === null && reason === null) return null;
      return { chip, notAutomaticReason: reason, autoWriteId };
    }
    return null;
  };

  /** C2 1.5 VoiceView from app.db `transcripts` (B18). The transcript is UNTRUSTED and passed on as inert data only. */
  const voiceViewOf = (item: Item, chat: Chat, waMsgId: string): VoiceView => {
    const t = repos.transcripts.get(chat.jid, waMsgId);
    if (t === null) return { seconds: 0, language: null, transcript: null, status: 'pending' };
    return {
      seconds: t.seconds,
      language: t.language,
      transcript: t.status === 'done' ? t.text : null,
      status: t.status,
    };
  };

  /** C2 1.5 ImageReadView (B19): what V1 read (UNTRUSTED, inert) + the 320-px thumbnail from the media cache. */
  const imageViewOf = (item: Item, proposal: Proposal | null): ImageReadView | null => {
    if (proposal === null || proposal.imageRead === null) return null;
    const r = proposal.imageRead;
    return {
      thumbDataUrl: deps.mediaCache?.thumb(item.id) ?? null,
      readText: r.readText,
      dateText: r.dateText,
      timeText: r.timeText,
      location: r.location,
      confidence: r.confidence,
      kind: r.kind,
    };
  };

  /** "Change proposed - see Needs reply" on the SOURCE card: the chat's open item is a pending delta linked to this item. */
  const changePendingOn = (item: Item): boolean => {
    if (item.eventState !== 'created' && item.eventState !== 'updated') return false;
    const open = repos.items.openForChat(item.chatId);
    return (
      open !== null && open.id !== item.id && open.linkedItemId === item.id && open.eventState === 'change_proposed'
    );
  };

  const actionViewsFor = (item: Item): ActionView[] => {
    const rows = repos.actions
      .forItem(item.id)
      .filter((a) => a.proposalId === item.currentProposalId && VISIBLE_ACTION_STATES.has(a.state));
    // At most one control per kind: the newest attempt wins and carries the previous attempt's error as `lastError`.
    const newest = new Map<ApprovalAction['kind'], ApprovalAction>();
    for (const a of rows) {
      const prev = newest.get(a.kind);
      if (prev === undefined || a.attempt > prev.attempt) newest.set(a.kind, a);
    }
    const views: ActionView[] = [];
    for (const a of newest.values()) {
      const previous = a.retryOf === null ? null : repos.actions.byId(a.retryOf);
      views.push({
        actionId: a.id,
        kind: a.kind,
        shownHash: a.contentSha256,
        state: a.state,
        expiresAt: a.expiresAt,
        attempt: a.attempt,
        errorCode: a.errorCode,
        lastError: previous?.errorCode ?? null,
        disabledReason: disabledReasonFor(a.kind),
      });
    }
    return views.sort((x, y) => x.kind.localeCompare(y.kind));
  };

  /** The live automatic-mode policy, read ONCE per dashboard / detail build (the "Not automatic" line needs it). */
  const livePolicy = (): AutoPolicyRecord | null => decorate('autoPolicy', 0, null, () => repos.autoPolicies.live());

  const cardOf = (item: Item, now: EpochMs, live: AutoPolicyRecord | null): ItemCard | null => {
    const chat = repos.chats.byId(item.chatId);
    if (chat === null) return null;
    const proposal = repos.proposals.current(item.id);
    const snapshot = repos.items.messages(item.id);
    const triggerRow = snapshot.find((m) => m.waMsgId === item.triggerMsgId) ?? snapshot.at(-1) ?? null;
    const triggerText = triggerRow?.text ?? null;
    return {
      itemId: item.id,
      chat: chatViewOf(chat),
      status: deriveStatus(item),
      card: cardKind(item.analysis),
      analysis: item.analysis,
      holdReason: item.holdReason,
      errorCode: item.errorCode,
      replyState: item.replyState,
      eventState: item.eventState,
      closedReason: item.closedReason,
      trigger: {
        ts: item.triggerTs,
        text: triggerText === null ? null : triggerText.slice(0, LIMITS.triggerPreviewChars),
      },
      draft:
        proposal !== null && proposal.draftText !== null && proposal.replyLang !== null
          ? { text: proposal.draftText, lang: proposal.replyLang, proposalVersion: proposal.version }
          : null,
      event: proposal?.event ?? null,
      missing: item.missing,
      badges: item.badges,
      actions: actionViewsFor(item),
      // [V2] C2 1.5: created | updated | cancelled carry `calendar`; the key is the opaque hash, never the Google id (C19).
      calendar: CALENDAR_STATES.has(item.eventState)
        ? {
            eventStartTs: item.eventStartTs,
            eventKey: item.calendarEventId === null ? orphanEventKeyOf(item.id) : eventKeyOf(item.calendarEventId),
            revision: item.eventRevision,
            status: item.eventState === 'cancelled' ? 'cancelled' : 'confirmed',
          }
        : null,
      editingLocked: item.editingUntil > now,
      updatedAt: item.updatedAt,
      triggerKind: item.triggerKind,
      change: changeViewOf(item, proposal),
      changePending: decorate('changePending', item.id, false, () => changePendingOn(item)),
      undo: decorate('undo', item.id, null, () => undoViewOf(item, now)),
      auto: decorate('auto', item.id, null, () => autoViewOf(item, live)),
      image: item.triggerKind === 'image' ? decorate('image', item.id, null, () => imageViewOf(item, proposal)) : null,
      voice:
        item.triggerKind === 'voice'
          ? decorate('voice', item.id, null, () => voiceViewOf(item, chat, item.triggerMsgId))
          : null,
    };
  };

  const detailOf = (item: Item, now: EpochMs): ItemDetail | null => {
    const card = cardOf(item, now, livePolicy());
    if (card === null) return null;
    const messages: MessageView[] = repos.items.messages(item.id).map((m, i) => {
      const view: MessageView = { seq: i, fromMe: m.fromMe, ts: m.ts, text: m.text };
      // [V2] the trigger row of a voice / picture item carries its bubble data (the same objects as the card's).
      if (m.waMsgId === item.triggerMsgId) {
        if (card.voice !== null) view.voice = card.voice;
        if (card.image !== null) view.image = { thumbDataUrl: card.image.thumbDataUrl, readText: card.image.readText };
      }
      return view;
    });
    return { ...card, messages };
  };

  const detailResult = (id: ItemId): Result<ItemDetail> => {
    const item = repos.items.byId(id);
    if (item === null) return err('NOT_FOUND');
    const detail = detailOf(item, clock.now());
    return detail === null ? err('NOT_FOUND') : { ok: true, value: detail };
  };

  const listOf = (state: ItemState, now: EpochMs, live: AutoPolicyRecord | null): ItemCard[] => {
    const cards: ItemCard[] = [];
    for (const item of repos.items.list(state, LIMITS.listSize)) {
      const card = cardOf(item, now, live);
      if (card !== null) cards.push(card);
    }
    return cards;
  };

  /** [V2] B20 / UX2 3.3.3: the In-calendar list holds ONE entry per event - the newest card of each eventKey (lists are newest first). */
  const onePerEvent = (cards: ItemCard[]): ItemCard[] => {
    const seen = new Set<string>();
    return cards.filter((c) => {
      if (c.calendar === null) return true;
      if (seen.has(c.calendar.eventKey)) return false;
      seen.add(c.calendar.eventKey);
      return true;
    });
  };

  return {
    dashboard(): DashboardData {
      const now = clock.now();
      const counts = repos.items.counts();
      const live = livePolicy();
      return {
        needsReply: listOf('needs_reply', now, live),
        inCalendar: onePerEvent(listOf('in_calendar', now, live)),
        infoMissing: listOf('info_missing', now, live),
        counts: {
          needsReply: counts.needsReply,
          inCalendar: counts.inCalendar,
          infoMissing: counts.infoMissing,
          ignored: counts.ignored,
        },
        analysing: counts.analysing,
      };
    },

    detail: detailResult,

    ignored(): { items: ItemCard[] } {
      const now = clock.now();
      const live = livePolicy();
      const cards: ItemCard[] = [];
      for (const item of repos.items.list('ignored', IGNORED_SCAN_LIMIT)) {
        if (item.closedReason !== 'dismissed') continue;
        const card = cardOf(item, now, live);
        if (card !== null) cards.push(card);
        if (cards.length === LIMITS.listSize) break;
      }
      return { items: cards };
    },

    dismiss(id: ItemId): Result<ItemDetail> {
      const item = repos.items.byId(id);
      if (item === null) return err('NOT_FOUND');
      const now = clock.now();
      repos.db.transaction(() => {
        repos.actions.supersedePending(id, now);
        repos.items.update(id, { closedReason: 'dismissed' }, now);
        // [fix data-integrity-v4-7] 9.3: the media-derived text goes at once (the cached picture: compose's item:dismiss wrapper)
        repos.db.prepare(FORGET_ITEM_TRANSCRIPTS_SQL).run(id);
        repos.db.prepare(FORGET_ITEM_PROPOSALS_SQL).run(id);
      });
      notifyChanged([id]);
      log.info('item_dismissed', { itemId: id });
      return detailResult(id);
    },

    restore(id: ItemId): Result<ItemDetail> {
      const item = repos.items.byId(id);
      if (item === null) return err('NOT_FOUND');
      if (item.closedReason === null) return detailResult(id);
      // `ux_items_open` allows exactly one open item per chat; a newer conversation already owns the slot.
      const open = repos.items.openForChat(item.chatId);
      if (open !== null && open.id !== id) return err('ACTION_STALE');
      repos.items.update(id, { closedReason: null, closedAt: null }, clock.now());
      notifyChanged([id]);
      return detailResult(id);
    },

    retriage(id: ItemId): Result<ItemDetail> {
      const item = repos.items.byId(id);
      if (item === null) return err('NOT_FOUND');
      const now = clock.now();
      if (repos.rate.countSince('llm_chat', String(item.chatId), now - HOUR_MS) >= LIMITS.llmRunsPerChatPerHour) {
        return err('RATE_LIMIT_RETRIAGE');
      }
      const open = repos.items.openForChat(item.chatId);
      // `[+]` `ux_items_open` keys on STATE, not on closed_reason, and the two disagree: `deriveState` returns
      // 'ignored' for a done item with no draft and no slot even when `closureFor` left closed_reason NULL (an
      // intent:'cancel' run does exactly that). Guarding on `closedReason !== null` let such an item through while a
      // newer message already owned the chat's open slot, and the re-open raised a raw
      // `UNIQUE constraint failed: items.chat_id` that ipc/register.ts could only report as INTERNAL. `isOpen(state)`
      // is the same predicate the index uses, so the guard and the constraint now agree.
      if (!isOpen(item.state) && open !== null && open.id !== id) return err('ACTION_STALE');
      repos.db.transaction(() => {
        repos.items.update(
          id,
          { analysis: 'queued', holdReason: null, errorCode: null, closedReason: null, closedAt: null },
          now,
        );
        repos.queue.enqueue(item.chatId, now);
      });
      deps.enqueueRetriage(item.chatId);
      notifyChanged([id]);
      log.info('item_retriage', { itemId: id });
      return detailResult(id);
    },

    setEditing(id: ItemId, on: boolean): Result<null> {
      const item = repos.items.byId(id);
      if (item === null) return err('NOT_FOUND');
      const now = clock.now();
      repos.items.update(id, { editingUntil: on ? now + LIMITS.editLockMs : 0 }, now);
      return { ok: true, value: null };
    },

    completeEvent(req: IpcReq<'item:completeEvent'>): Result<ItemDetail> {
      const item = repos.items.byId(req.itemId);
      if (item === null) return err('NOT_FOUND');
      if (item.closedReason !== null || COMPLETE_EVENT_REFUSED_STATES.has(item.eventState)) return err('ACTION_STALE');
      if (!deps.calendarConnected()) return err('CAL_UNAVAILABLE');
      const parsed = EventEditSchema.safeParse(req.event);
      if (!parsed.success) return err('EVENT_INVALID');
      const edit = parsed.data;
      const chat = repos.chats.byId(item.chatId);
      if (chat === null) return err('NOT_FOUND');

      const now = clock.now();
      const timeZone = settings().general.timeZone;
      const previous = repos.proposals.current(item.id);
      repos.db.transaction(() => {
        const proposal = repos.proposals.insertNext({
          itemId: item.id,
          provider: 'user', // no LLM turn: the user filled the mini-form themselves
          model: '',
          extraction: previous?.extraction ?? null,
          draftText: previous?.draftText ?? null,
          replyLang: previous?.replyLang ?? null,
          event: {
            title: edit.title,
            startLocal: edit.startLocal,
            endLocal: edit.endLocal,
            timeZone,
            location: edit.location,
            assumptions: [],
            dateHint: '',
          },
          freeBusy: previous?.freeBusy ?? null,
          suspicious: previous?.suspicious ?? false,
          createdAt: now,
        });
        repos.actions.supersedePending(item.id, now);
        repos.items.update(item.id, { eventState: 'proposed', missing: [], currentProposalId: proposal.id }, now);
        repos.actions.insertPending({
          itemId: item.id,
          proposalId: proposal.id,
          chatId: chat.id,
          payload: {
            v: 1,
            kind: 'create_event',
            itemId: item.id,
            chatRef: chat.id,
            proposalVersion: proposal.version,
            title: edit.title,
            startLocal: edit.startLocal,
            endLocal: edit.endLocal,
            timeZone,
            location: edit.location,
          },
          now,
        });
      });
      notifyChanged([item.id]);
      log.info('item_complete_event', { itemId: item.id });
      return detailResult(item.id);
    },

    setChatPolicy(req: IpcReq<'chat:setPolicy'>): Result<ChatView> {
      const chat = repos.chats.byId(req.chatRef);
      if (chat === null) return err('NOT_FOUND');
      const updated =
        'forceKnown' in req
          ? repos.chats.setForceKnown(req.chatRef)
          : 'autoPolicy' in req
            ? repos.chats.setAutoPolicy(req.chatRef, req.autoPolicy) // [V2] V2-W1-01 implements the repo member
            : repos.chats.setPolicy(req.chatRef, req.policy);
      // [fix data-integrity-v4-7] "Never analyse" (9.3, B19): the chat's transcripts, delta / image JSON and cached pictures go at once.
      if ('policy' in req && req.policy === 'never') forgetChatMedia(req.chatRef);
      // "Analyse this chat" releases the held raw card of that chat straight away.
      if ('forceKnown' in req) {
        const now = clock.now();
        const open = repos.items.openForChat(req.chatRef);
        if (open !== null && open.analysis === 'held' && open.holdReason === 'unknown_sender') {
          repos.db.transaction(() => {
            repos.items.update(open.id, { analysis: 'queued', holdReason: null, errorCode: null }, now);
            repos.queue.enqueue(req.chatRef, now);
          });
          deps.enqueueRetriage(req.chatRef);
          notifyChanged([open.id]);
        }
      }
      log.info('chat_policy_set', { chatRef: req.chatRef, forceKnown: 'forceKnown' in req });
      return { ok: true, value: chatViewOf(updated) };
    },

    listPolicies(): { chats: ChatView[] } {
      return { chats: repos.chats.withPolicies().map(chatViewOf) };
    },

    /**
     * [V2] item:getImage (B19, C2 8): the normalised picture of THIS item as a JPEG data URL. Only for an item whose media_cache row
     * exists; the cache file is read in main (the renderer never names a file); anything that is not a JPEG data URL, or is larger
     * than LIMITS.imageDataUrlMaxBytes, is refused. Lists carry only the 320-px thumbnail.
     */
    getImage(itemId: ItemId): Result<{ dataUrl: string }> {
      if (repos.items.byId(itemId) === null) return err('NOT_FOUND');
      if (repos.mediaCache.forItem(itemId).length === 0) return err('NOT_FOUND');
      const dataUrl = deps.mediaCache?.dataUrl(itemId) ?? null;
      if (dataUrl === null || !dataUrl.startsWith(JPEG_DATA_URL_PREFIX)) return err('MEDIA_UNAVAILABLE');
      if (Buffer.byteLength(dataUrl, 'utf8') > LIMITS.imageDataUrlMaxBytes) {
        log.warn('item_image_too_large', { itemId });
        return err('MEDIA_UNAVAILABLE');
      }
      return { ok: true, value: { dataUrl } };
    },
  };
}

/** Kept exported for the dashboard tests and W1-13: an item is only LISTED when its analysis says so (ARCHITECTURE 6.1). */
export { isListed };
