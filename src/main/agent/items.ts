// src/main/agent/items.ts - ItemService: view models + user item actions (build-plan section 3; owner W1-10).
// Builds every ItemCard / ItemDetail / ChatView that crosses IPC (JIDs never; phoneDisplay is formatted here).
// [R2] No calendarHtmlLink in any view model: "Open in calendar" is external:open {itemId, target:'calendarEvent'} and main
// builds that URL itself from event_start_ts.
import { EventEditSchema } from '../../shared/schemas';
import { cardKind, deriveStatus, isListed, isOpen } from '../../shared/state';
import {
  DM_PHONE_JID_RE,
  LIMITS,
  type ActionDisabledReason,
  type ActionState,
  type ActionView,
  type ApprovalAction,
  type Chat,
  type ChatView,
  type DashboardData,
  type EpochMs,
  type Item,
  type ItemCard,
  type ItemDetail,
  type ItemId,
  type ItemState,
  type MessageView,
  type Result,
} from '../../shared/types';
import type { Clock, Logger } from '../deps';
import type { Repos } from '../db/index';
import type { Settings } from '../../shared/settings';
import type { IpcReq } from '../../shared/ipc';
import type { ErrorCode } from '../../shared/errors';

export interface ItemService {
  dashboard(): DashboardData;
  detail(id: ItemId): Result<ItemDetail>;
  ignored(): { items: ItemCard[] }; // last 20 with closed_reason='dismissed'
  dismiss(id: ItemId): Result<ItemDetail>;
  restore(id: ItemId): Result<ItemDetail>;
  retriage(id: ItemId): Result<ItemDetail>; // RATE_LIMIT_RETRIAGE when over budget
  setEditing(id: ItemId, on: boolean): Result<null>;
  completeEvent(req: IpcReq<'item:completeEvent'>): Result<ItemDetail>; // proposal (provider 'user') + pending create_event
  setChatPolicy(req: IpcReq<'chat:setPolicy'>): Result<ChatView>;
  listPolicies(): { chats: ChatView[] };
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
}

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
  });

  const disabledReasonFor = (kind: ApprovalAction['kind']): ActionDisabledReason | null => {
    if (kind === 'send_reply') {
      if (deps.bridgeOutdated()) return 'bridge_outdated';
      if (!deps.bridgeOnline()) return 'wa_offline';
      return null;
    }
    return deps.calendarConnected() ? null : 'calendar_unavailable';
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

  const cardOf = (item: Item, now: EpochMs): ItemCard | null => {
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
      calendar: item.eventState === 'created' ? { eventStartTs: item.eventStartTs } : null,
      editingLocked: item.editingUntil > now,
      updatedAt: item.updatedAt,
    };
  };

  const detailOf = (item: Item, now: EpochMs): ItemDetail | null => {
    const card = cardOf(item, now);
    if (card === null) return null;
    const messages: MessageView[] = repos.items
      .messages(item.id)
      .map((m, i) => ({ seq: i, fromMe: m.fromMe, ts: m.ts, text: m.text }));
    return { ...card, messages };
  };

  const detailResult = (id: ItemId): Result<ItemDetail> => {
    const item = repos.items.byId(id);
    if (item === null) return err('NOT_FOUND');
    const detail = detailOf(item, clock.now());
    return detail === null ? err('NOT_FOUND') : { ok: true, value: detail };
  };

  const listOf = (state: ItemState, now: EpochMs): ItemCard[] => {
    const cards: ItemCard[] = [];
    for (const item of repos.items.list(state, LIMITS.listSize)) {
      const card = cardOf(item, now);
      if (card !== null) cards.push(card);
    }
    return cards;
  };

  return {
    dashboard(): DashboardData {
      const now = clock.now();
      const counts = repos.items.counts();
      return {
        needsReply: listOf('needs_reply', now),
        inCalendar: listOf('in_calendar', now),
        infoMissing: listOf('info_missing', now),
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
      const cards: ItemCard[] = [];
      for (const item of repos.items.list('ignored', IGNORED_SCAN_LIMIT)) {
        if (item.closedReason !== 'dismissed') continue;
        const card = cardOf(item, now);
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
      if (item.closedReason !== null || item.eventState === 'created') return err('ACTION_STALE');
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
        'forceKnown' in req ? repos.chats.setForceKnown(req.chatRef) : repos.chats.setPolicy(req.chatRef, req.policy);
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
  };
}

/** Kept exported for the dashboard tests and W1-13: an item is only LISTED when its analysis says so (ARCHITECTURE 6.1). */
export { isListed };
