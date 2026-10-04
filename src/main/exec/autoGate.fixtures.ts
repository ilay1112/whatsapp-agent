// src/main/exec/autoGate.fixtures.ts - test support for exec/autoGate.ts (owner V2-W1-04-exec-auto; `<ownedFile>.<suffix>.ts`, excluded
// from coverage by vitest's `**/*.fixtures.*`). ONE all-clear AutoGateInput (a create and an update) and, for every AUTO_REASONS value,
// the smallest change that flips the all-clear fixture to exactly that reason (T2 8.2 group 15 table). Synthetic data only (T5).
import { DEFAULT_AUTO_SCOPE } from '../../shared/schemas';
import { localToEpochMs } from '../../shared/when';
import type { AutoGateInput } from './autoGate';
import type { OwnedEventProjection } from '../mcp/readClient';
import type {
  ApprovalAction,
  AutoPolicyRecord,
  AutoReason,
  Chat,
  EpochMs,
  Item,
  ItemId,
  Proposal,
  ProposalId,
} from '../../shared/types';
import type { CreateEventPayload, UpdateEventPayload } from '../../shared/schemas';

export const TZ = 'Asia/Jerusalem';
/** Monday 2026-10-05 10:00 in Jerusalem (07:00 UTC): outside the 22-07 quiet hours. */
export const NOW = localToEpochMs('2026-10-05T10:00:00', TZ);
export const EVENT_ID = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
export const SNAPSHOT = 'f'.repeat(64);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function policy(over: Partial<AutoPolicyRecord> = {}): AutoPolicyRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    state: 'on',
    enabledAt: (NOW - DAY) as EpochMs,
    expiresAt: (NOW + 29 * DAY) as EpochMs,
    shadowUntil: (NOW - DAY) as EpochMs,
    confirmedBy: 'native_dialog',
    confirm: {
      dialogResponse: 1,
      checkboxChecked: true,
      windowFocused: true,
      trial: false,
      appVersion: '2.0.0',
      electronVersion: '44.4.3',
      approvedCreates: 3,
    },
    scope: { ...DEFAULT_AUTO_SCOPE, cancels: true },
    snapshotSha: SNAPSHOT,
    pausedReason: null,
    disabledAt: null,
    disabledReason: null,
    ...over,
  };
}

export function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: 7,
    jid: '972550000007@s.whatsapp.net',
    displayName: 'Contact',
    isKnown: true,
    forceKnown: false,
    sendable: true,
    policy: 'default',
    lang: 'en',
    lastInboundTs: NOW,
    lastOutboundTs: (NOW - HOUR) as EpochMs,
    lastTriagedMsgId: null,
    createdAt: (NOW - 30 * DAY) as EpochMs,
    updatedAt: NOW,
    autoPolicy: 'inherit',
    autoTaintedUntil: null,
    ...over,
  };
}

export function item(over: Partial<Item> = {}): Item {
  return {
    id: 20 as ItemId,
    chatId: 7,
    state: 'needs_reply',
    analysis: 'done',
    holdReason: null,
    errorCode: null,
    replyState: 'draft',
    eventState: 'proposed',
    triggerMsgId: 'm-20',
    triggerTs: NOW,
    missing: [],
    badges: [],
    currentProposalId: 30 as ProposalId,
    editingUntil: 0,
    calendarEventId: null,
    calendarHtmlLink: null,
    eventStartTs: null,
    closedReason: null,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    linkedItemId: null,
    eventRevision: 0,
    calendarUpdated: null,
    triggerKind: 'text',
    eventOriginItemId: null,
    ...over,
  };
}

/** Wednesday 2026-10-07 15:00-16:00 (create) - 2 days ahead, well inside the cage. */
export const SLOT = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00', timeZone: TZ } as const;
/** The update fixture moves Wednesday 15:00 to Thursday 17:00 (later, +26 h). */
export const FROM = { title: 'Dentist', ...SLOT, location: '', status: 'confirmed' as const };
export const TO = {
  title: 'Dentist',
  startLocal: '2026-10-08T17:00:00',
  endLocal: '2026-10-08T18:00:00',
  timeZone: TZ,
  location: '',
  status: 'confirmed' as const,
};

export function createPayload(over: Partial<CreateEventPayload> = {}): CreateEventPayload {
  return {
    v: 1,
    kind: 'create_event',
    itemId: 20,
    chatRef: 7,
    proposalVersion: 1,
    title: 'Dentist',
    ...SLOT,
    location: '',
    ...over,
  };
}

export function updatePayload(over: Partial<UpdateEventPayload> = {}): UpdateEventPayload {
  return {
    v: 1,
    kind: 'update_event',
    itemId: 21,
    chatRef: 7,
    proposalVersion: 1,
    targetEventId: EVENT_ID,
    targetItemId: 10,
    baseRevision: 1,
    change: 'reschedule',
    from: { ...FROM },
    to: { ...TO },
    ...over,
  } as UpdateEventPayload;
}

export function action(kind: 'create_event' | 'update_event', over: Partial<ApprovalAction> = {}): ApprovalAction {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    itemId: (kind === 'create_event' ? 20 : 21) as ItemId,
    proposalId: 30 as ProposalId,
    chatId: 7,
    kind,
    canonicalJson: '{}',
    contentSha256: '0'.repeat(64),
    idempotencyKey: `20:${kind}:1`,
    attempt: 1,
    retryOf: null,
    state: 'pending',
    approvedAt: null,
    approvedFinalJson: null,
    executedAt: null,
    result: null,
    errorCode: null,
    createdAt: NOW,
    expiresAt: (NOW + DAY) as EpochMs,
    approvedBy: null,
    ...over,
  };
}

export function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 30 as ProposalId,
    itemId: 20 as ItemId,
    version: 1,
    provider: 'local',
    model: 'test',
    extraction: {
      intent: 'schedule_request',
      needsReply: true,
      title: 'Dentist',
      dateKind: 'absolute',
      isoDate: '2026-10-07',
      weekday: 0,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '15:00',
      timeAmbiguous: false,
      durationMin: 60,
      location: '',
      missing: [],
      suspicious: false,
      refersToExisting: false,
      change: 'no_change',
      changeConfidence: 'low',
      confidence: 'high',
    },
    draftText: 'See you then',
    replyLang: 'en',
    event: { title: 'Dentist', ...SLOT, location: '', assumptions: [], dateHint: '' },
    freeBusy: [],
    suspicious: false,
    createdAt: NOW,
    supersededAt: null,
    delta: null,
    imageRead: null,
    blockedCalls: 0,
    providerClass: 'local',
    contextFromMeRecent: true,
    crossChatRows: 0,
    triggerAuthor: 'contact',
    ...over,
  };
}

/** The pre-flight get-event projection of the app's own, untouched event (update fixture). */
export function projection(over: Partial<OwnedEventProjection> = {}): OwnedEventProjection {
  return {
    id: EVENT_ID,
    status: 'confirmed',
    startLocal: FROM.startLocal,
    endLocal: FROM.endLocal,
    timeZone: TZ,
    summary: 'Dentist',
    location: '',
    etag: '"etag-1"',
    updated: '2026-10-04T08:00:00.000Z',
    sequence: 0,
    creatorSelf: true,
    organizerSelf: true,
    hasAttendees: false,
    hasRecurrence: false,
    priv: { waAgent: '1', waItem: '10', waAction: 'root-action', waUpdate: null, waRev: null },
    ...over,
  };
}

/** The all-clear CREATE input => {verdict:'auto', reason:'ok'}. */
export function allClearCreate(): AutoGateInput {
  const payload = createPayload();
  return {
    policy: policy(),
    snapshotSha: SNAPSHOT,
    calendarConnected: true,
    updateSurfaceAvailable: true,
    targetAccessRole: 'owner',
    approvedCreates: 3,
    editsGatePassed: true,
    action: action('create_event'),
    payload,
    item: item(),
    chat: chat(),
    proposal: proposal(),
    sourceItem: null,
    preflight: null,
    lastRecordedWrite: null,
    editableEventsInChat: 0,
    triggerAuthor: 'contact',
    autoEditsOfEvent: 0,
    freshBusy: [],
    budget: { chatLast30Min: 0, chatLastHour: 0, chatToday: 0, globalLastHour: 0, globalToday: 0 },
    now: NOW,
    timeZone: TZ,
    mediaGates: { voicePassed: false, imagesPassed: false },
  };
}

/** The source in_calendar item of the update fixture (it holds the event; it is its own origin). */
export function sourceItem(over: Partial<Item> = {}): Item {
  return item({
    id: 10 as ItemId,
    state: 'in_calendar',
    eventState: 'created',
    calendarEventId: EVENT_ID,
    eventStartTs: localToEpochMs(FROM.startLocal, TZ),
    eventRevision: 1,
    calendarUpdated: '2026-10-04T08:00:00.000Z',
    eventOriginItemId: 10 as ItemId,
    ...over,
  });
}

/** The all-clear UPDATE (reschedule) input => {verdict:'auto', reason:'ok'}. */
export function allClearUpdate(): AutoGateInput {
  const payload = updatePayload();
  const x = proposal().extraction!;
  return {
    ...allClearCreate(),
    action: action('update_event'),
    payload,
    item: item({ id: 21 as ItemId, eventState: 'change_proposed', linkedItemId: 10 as ItemId }),
    proposal: proposal({
      itemId: 21 as ItemId,
      extraction: {
        ...x,
        intent: 'reschedule',
        refersToExisting: true,
        change: 'reschedule',
        changeConfidence: 'high',
      },
      delta: {
        kind: 'reschedule',
        targetEventId: EVENT_ID,
        sourceItemId: 10,
        baseRevision: 1,
        from: { ...FROM },
        to: { ...TO },
        confidence: 'high',
        assumptions: [],
        problems: [],
      },
    }),
    sourceItem: sourceItem(),
    preflight: projection(),
    lastRecordedWrite: { etag: '"etag-1"', updated: '2026-10-04T08:00:00.000Z' },
    editableEventsInChat: 1,
    autoEditsOfEvent: 0,
    freshBusy: [],
  };
}

type Flip = { base: 'create' | 'update'; apply: (i: AutoGateInput) => AutoGateInput };
const up = (i: AutoGateInput): UpdateEventPayload => i.payload as UpdateEventPayload;

/**
 * For every REACHABLE AUTO_REASONS value: the smallest change of an all-clear fixture that yields exactly that reason.
 * The three RESERVED reasons (policy_shadow, no_user_echo, duplicate) and 'ok' are absent on purpose (T2 concern 4).
 */
export const REASON_FLIPS: Record<Exclude<AutoReason, 'ok' | 'policy_shadow' | 'no_user_echo' | 'duplicate'>, Flip> = {
  no_policy: { base: 'create', apply: (i) => ({ ...i, policy: null }) },
  policy_paused: {
    base: 'create',
    apply: (i) => ({ ...i, policy: policy({ state: 'paused', pausedReason: 'user' }) }),
  },
  policy_expired: { base: 'create', apply: (i) => ({ ...i, policy: policy({ expiresAt: NOW }) }) },
  snapshot_changed: { base: 'create', apply: (i) => ({ ...i, snapshotSha: 'e'.repeat(64) }) },
  calendar_disconnected: { base: 'create', apply: (i) => ({ ...i, calendarConnected: false }) },
  calendar_not_owned: { base: 'create', apply: (i) => ({ ...i, targetAccessRole: 'writer' }) },
  no_track_record: { base: 'create', apply: (i) => ({ ...i, approvedCreates: 2 }) },
  undo_unavailable: { base: 'create', apply: (i) => ({ ...i, updateSurfaceAvailable: false }) },
  unknown_contact: { base: 'create', apply: (i) => ({ ...i, chat: chat({ isKnown: false, forceKnown: true }) }) },
  chat_opted_out: { base: 'create', apply: (i) => ({ ...i, chat: chat({ autoPolicy: 'never' }) }) },
  chat_tainted: { base: 'create', apply: (i) => ({ ...i, chat: chat({ autoTaintedUntil: (NOW + 1) as EpochMs }) }) },
  no_user_participation: {
    base: 'create',
    apply: (i) => ({ ...i, proposal: { ...i.proposal, contextFromMeRecent: false } }),
  },
  badge_red: { base: 'create', apply: (i) => ({ ...i, item: { ...i.item, badges: ['manipulation'] } }) },
  badge_amber: { base: 'create', apply: (i) => ({ ...i, item: { ...i.item, badges: ['conflict'] } }) },
  badge_info: { base: 'create', apply: (i) => ({ ...i, item: { ...i.item, badges: ['older_message'] } }) },
  blocked_tool_call: { base: 'create', apply: (i) => ({ ...i, proposal: { ...i.proposal, blockedCalls: 1 } }) },
  suspicious: { base: 'create', apply: (i) => ({ ...i, proposal: { ...i.proposal, suspicious: true } }) },
  assumed_hour: {
    base: 'create',
    apply: (i) => ({
      ...i,
      proposal: { ...i.proposal, event: { ...i.proposal.event!, assumptions: ['hour_assumed_pm'] } },
    }),
  },
  missing_fields: { base: 'create', apply: (i) => ({ ...i, item: { ...i.item, missing: ['location'] } }) },
  low_confidence: {
    base: 'create',
    apply: (i) => ({
      ...i,
      proposal: { ...i.proposal, extraction: { ...i.proposal.extraction!, confidence: 'medium' } },
    }),
  },
  intent_not_eligible: {
    base: 'create',
    apply: (i) => ({
      ...i,
      proposal: { ...i.proposal, extraction: { ...i.proposal.extraction!, intent: 'question' } },
    }),
  },
  title_rejected: { base: 'create', apply: (i) => ({ ...i, payload: createPayload({ title: '12:30 !!' }) }) },
  content_rejected: {
    base: 'create',
    apply: (i) => ({ ...i, payload: createPayload({ title: 'Dentist see www.example.com' }) }),
  },
  media_derived: { base: 'create', apply: (i) => ({ ...i, item: { ...i.item, triggerKind: 'voice' } }) },
  cross_chat_rows: { base: 'create', apply: (i) => ({ ...i, proposal: { ...i.proposal, crossChatRows: 2 } }) },
  multiple_events: { base: 'update', apply: (i) => ({ ...i, editableEventsInChat: 2 }) },
  provider_unsafe: {
    base: 'create',
    apply: (i) => ({ ...i, proposal: { ...i.proposal, providerClass: 'cli_unproven' } }),
  },
  beyond_horizon: {
    base: 'create',
    apply: (i) => ({
      ...i,
      payload: createPayload({ startLocal: '2026-11-05T15:00:00', endLocal: '2026-11-05T16:00:00' }),
    }),
  },
  too_long: {
    base: 'create',
    apply: (i) => ({
      ...i,
      payload: createPayload({ startLocal: '2026-10-07T10:00:00', endLocal: '2026-10-07T14:01:00' }),
    }),
  },
  too_soon: {
    base: 'create',
    apply: (i) => ({
      ...i,
      payload: createPayload({ startLocal: '2026-10-05T10:14:00', endLocal: '2026-10-05T11:14:00' }),
    }),
  },
  quiet_hours: {
    base: 'create',
    apply: (i) => ({
      ...i,
      payload: createPayload({ startLocal: '2026-10-07T22:00:00', endLocal: '2026-10-07T23:00:00' }),
    }),
  },
  conflict: {
    base: 'create',
    apply: (i) => ({ ...i, freshBusy: [{ startLocal: '2026-10-07T15:30:00', endLocal: '2026-10-07T16:30:00' }] }),
  },
  auto_budget: { base: 'create', apply: (i) => ({ ...i, budget: { ...i.budget, chatLast30Min: 1 } }) },
  edits_not_in_scope: {
    base: 'update',
    apply: (i) => ({ ...i, policy: policy({ scope: { ...policy().scope, edits: false } }) }),
  },
  cancel_not_in_scope: {
    base: 'update',
    apply: (i) => ({
      ...i,
      policy: policy({ scope: { ...policy().scope, cancels: false } }),
      payload: updatePayload({ change: 'cancel', to: { ...FROM, status: 'cancelled' } }),
    }),
  },
  cancel_too_soon: {
    base: 'update',
    apply: (i) => {
      const from = { ...FROM, startLocal: '2026-10-06T09:00:00', endLocal: '2026-10-06T10:00:00' };
      return {
        ...i,
        payload: updatePayload({ change: 'cancel', from, to: { ...from, status: 'cancelled' } }),
        preflight: projection({ startLocal: from.startLocal, endLocal: from.endLocal }),
      };
    },
  },
  not_app_event: {
    base: 'update',
    apply: (i) => ({ ...i, preflight: projection({ priv: { ...projection().priv, waAgent: null } }) }),
  },
  wrong_item: {
    base: 'update',
    apply: (i) => ({ ...i, preflight: projection({ priv: { ...projection().priv, waItem: '999' } }) }),
  },
  not_own_copy: {
    base: 'update',
    apply: (i) => ({ ...i, preflight: projection({ creatorSelf: false, organizerSelf: false }) }),
  },
  event_has_attendees: { base: 'update', apply: (i) => ({ ...i, preflight: projection({ hasAttendees: true }) }) },
  event_cancelled: { base: 'update', apply: (i) => ({ ...i, preflight: projection({ status: 'cancelled' }) }) },
  modified_in_google: { base: 'update', apply: (i) => ({ ...i, preflight: projection({ etag: '"etag-2"' }) }) },
  move_too_far: {
    base: 'update',
    apply: (i) => ({
      ...i,
      payload: updatePayload({ to: { ...TO, startLocal: '2026-10-22T15:01:00', endLocal: '2026-10-22T16:01:00' } }),
    }),
  },
  edit_budget: { base: 'update', apply: (i) => ({ ...i, autoEditsOfEvent: 2 }) },
  unknown_prev_state: { base: 'update', apply: (i) => ({ ...i, preflight: null }) },
};

/** Convenience for the update-only flips of up(). */
export function withUpdate(i: AutoGateInput, p: Partial<UpdateEventPayload>): AutoGateInput {
  return { ...i, payload: { ...up(i), ...p } as UpdateEventPayload };
}
