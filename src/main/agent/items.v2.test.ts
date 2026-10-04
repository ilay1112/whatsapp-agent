// src/main/agent/items.v2.test.ts - ItemService v2 view models (C2 1.5, UX2 12 / C19; owner V2-W1-10-main-platform).
// A REAL migrated in-memory app.db + the real repos; the v2 decoration inputs that need a whole executor run to exist (revision
// chains, automatic decisions and writes) are shaped with vi.spyOn on the repo members, so every branch of the view is reached
// without writing to a calendar. Every assertion is about what crosses IPC.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createItemService, eventKeyOf, type ItemService, type ItemServiceDeps } from './items';
import type { EventContentWithStatus, EventDelta, ImageRead } from '../../shared/schemas';
import {
  AUTO_REASONS,
  LIMITS,
  type ApprovalAction,
  type AutoDecisionRecord,
  type AutoPolicyRecord,
  type AutoWriteRecord,
  type Chat,
  type EpochMs,
  type EventRevisionRecord,
  type Item,
  type Proposal,
} from '../../shared/types';
import { localToEpochMs } from '../../shared/when';
import { ANCHOR_MS, TEST_TZ, createTestEnv, seedChat, type TestEnv } from '../../../tests/golden/testDb';

const HOUR = 3_600_000;
const EVENT_ID = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'; // synthetic base32hex id, eventIdFor-shaped (32 chars)
const OTHER_EVENT_ID = 'v9u8t7s6r5q4p3o2n1m0l9k8j7i6h5g4';

const FROM: EventContentWithStatus = {
  title: 'Meeting',
  startLocal: '2026-09-23T15:00:00',
  endLocal: '2026-09-23T16:00:00',
  timeZone: TEST_TZ,
  location: '',
  status: 'confirmed',
};
const TO: EventContentWithStatus = { ...FROM, startLocal: '2026-09-23T17:00:00', endLocal: '2026-09-23T18:00:00' };
const DELTA: EventDelta = {
  kind: 'reschedule',
  targetEventId: EVENT_ID,
  sourceItemId: 1,
  baseRevision: 1,
  from: FROM,
  to: TO,
  confidence: 'high',
  assumptions: [],
  problems: [],
};
const IMAGE_READ: ImageRead = {
  readable: true,
  kind: 'invitation',
  readText: 'Wedding <img src=x onerror=alert(1)> [link](https://evil.example)',
  language: 'en',
  title: 'Wedding',
  dateText: '12.10',
  day: 12,
  month: 10,
  year: 0,
  weekday: 7,
  timeText: '19:30',
  hour: 19,
  minute: 30,
  timeAmbiguous: false,
  endHour: 24,
  endMinute: 0,
  location: 'Hall',
  confidence: 'medium',
  suspicious: false,
};

function fakeProposal(itemId: number, over: Partial<Proposal> = {}): Proposal {
  return {
    id: 900 + itemId,
    itemId,
    version: 1,
    provider: 'local',
    model: 'stub',
    extraction: null,
    draftText: null,
    replyLang: null,
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: ANCHOR_MS,
    supersededAt: null,
    delta: null,
    imageRead: null,
    blockedCalls: 0,
    providerClass: 'local',
    contextFromMeRecent: false,
    crossChatRows: 0,
    triggerAuthor: 'contact',
    ...over,
  } as Proposal;
}
function fakeAction(itemId: number, proposalId: number, over: Partial<ApprovalAction> = {}): ApprovalAction {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    itemId,
    proposalId,
    chatId: 1,
    kind: 'create_event',
    state: 'pending',
    contentSha256: 'c'.repeat(64),
    expiresAt: ANCHOR_MS + 24 * HOUR,
    attempt: 1,
    retryOf: null,
    errorCode: null,
    approvedBy: null,
    ...over,
  } as ApprovalAction;
}
function revision(over: Partial<EventRevisionRecord> = {}): EventRevisionRecord {
  return {
    id: 7,
    calendarEventId: EVENT_ID,
    itemId: 1,
    revision: 2,
    kind: 'reschedule',
    prev: FROM,
    next: TO,
    actionId: '22222222-2222-4222-8222-222222222222',
    appliedAt: ANCHOR_MS,
    revertedBy: null,
    postEtag: null,
    postUpdated: null,
    ...over,
  };
}
function decision(over: Partial<AutoDecisionRecord> = {}): AutoDecisionRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    policyId: '44444444-4444-4444-8444-444444444444',
    actionId: '22222222-2222-4222-8222-222222222222',
    itemId: 1,
    chatId: 1,
    kind: 'update',
    verdict: 'auto',
    reason: 'ok',
    checks: {},
    decidedAt: ANCHOR_MS - 1000,
    ...over,
  };
}
function autoWrite(over: Partial<AutoWriteRecord> = {}): AutoWriteRecord {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    decisionId: '33333333-3333-4333-8333-333333333333',
    actionId: '22222222-2222-4222-8222-222222222222',
    itemId: 1,
    eventId: EVENT_ID,
    kind: 'update',
    pre: null,
    revisionId: 7,
    postEtag: null,
    postUpdated: null,
    postSequence: null,
    undoState: 'available',
    undoUntil: ANCHOR_MS + 10 * HOUR,
    undoActionId: null,
    writtenAt: ANCHOR_MS,
    ...over,
  };
}
const LIVE_POLICY = { id: '44444444-4444-4444-8444-444444444444', state: 'on' } as AutoPolicyRecord;

describe('ItemService v2 view models', () => {
  let env: TestEnv;
  let chat: Chat;
  let service: ItemService;
  let now: EpochMs;
  let calendar: boolean;
  let updates: boolean | undefined;
  let thumbs: Map<number, string>;
  let fullImages: Map<number, string | null>;

  const build = (over: Partial<ItemServiceDeps> = {}): ItemService =>
    createItemService({
      repos: env.repos,
      settings: () => env.settings,
      clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined },
      log: env.log,
      bridgeOnline: () => true,
      bridgeOutdated: () => false,
      calendarConnected: () => calendar,
      notifyChanged: () => undefined,
      enqueueRetriage: () => undefined,
      ...(updates === undefined ? {} : { updatesAvailable: () => updates! }),
      mediaCache: { thumb: (id) => thumbs.get(id) ?? null, dataUrl: (id) => fullImages.get(id) ?? null },
      ...over,
    });

  /** An item in the given event state (analysis done), holding EVENT_ID unless told otherwise. */
  const seedItem = (patch: Partial<Item>, msgId = `wamid.${Math.random().toString(36).slice(2)}`): Item => {
    const created = env.repos.items.createOpen({
      chatId: chat.id,
      triggerMsgId: msgId,
      triggerTs: ANCHOR_MS,
      analysis: 'queued',
      holdReason: null,
      now: ANCHOR_MS,
    });
    return env.repos.items.update(created.id, { analysis: 'done', ...patch }, ANCHOR_MS);
  };
  const inCalendar = (patch: Partial<Item> = {}): Item =>
    seedItem({
      eventState: 'created',
      calendarEventId: EVENT_ID,
      eventStartTs: localToEpochMs(FROM.startLocal, TEST_TZ),
      eventRevision: 1,
      ...patch,
    });

  beforeEach(() => {
    env = createTestEnv();
    now = ANCHOR_MS;
    calendar = true;
    updates = undefined;
    thumbs = new Map();
    fullImages = new Map();
    chat = seedChat(env.repos);
    service = build();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.dispose();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // calendar + eventKey (C2 1.5, C19)
  // ---------------------------------------------------------------------------------------------------------------
  describe('calendar.eventKey', () => {
    it('is the first 16 hex of sha256("wca-event|" + id) and never equals or contains the id', () => {
      const key = eventKeyOf(EVENT_ID);
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(key).not.toBe(EVENT_ID);
      expect(key).not.toContain(EVENT_ID);
      // Property sweep over eventIdFor-shaped (32) and Google-shaped (26 / 64) ids of the base32hex alphabet.
      const alphabet = '0123456789abcdefghijklmnopqrstuv';
      let seed = 42;
      const rand = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
      for (let i = 0; i < 300; i++) {
        const len = [26, 32, 64][i % 3]!;
        const id = Array.from({ length: len }, () => alphabet[Math.floor(rand() * 32)]).join('');
        const k = eventKeyOf(id);
        expect(k).toMatch(/^[0-9a-f]{16}$/);
        expect(k.includes(id) || id.includes(k)).toBe(false);
      }
    });

    it('created / updated / cancelled carry calendar with revision and status; no card ever carries the event id', () => {
      const a = inCalendar({ eventRevision: 3, eventState: 'updated' });
      const card = service.detail(a.id);
      expect(card.ok && card.value.calendar).toEqual({
        eventStartTs: localToEpochMs(FROM.startLocal, TEST_TZ),
        eventKey: eventKeyOf(EVENT_ID),
        revision: 3,
        status: 'confirmed',
      });
      env.repos.items.update(a.id, { eventState: 'cancelled' }, ANCHOR_MS);
      const cancelled = service.detail(a.id);
      expect(cancelled.ok && cancelled.value.calendar?.status).toBe('cancelled');
      const dump = JSON.stringify([service.dashboard(), service.detail(a.id)]);
      expect(dump).not.toContain(EVENT_ID);
    });

    it('a calendar item without an event id still gets a stable id-free 16-hex key', () => {
      const a = inCalendar({ calendarEventId: null });
      const first = service.detail(a.id);
      const second = service.detail(a.id);
      expect(first.ok && first.value.calendar?.eventKey).toMatch(/^[0-9a-f]{16}$/);
      expect(first.ok && second.ok && first.value.calendar?.eventKey === second.value.calendar?.eventKey).toBe(true);
    });

    it('non-calendar states carry calendar null', () => {
      const a = seedItem({ eventState: 'proposed' });
      const d = service.detail(a.id);
      expect(d.ok && d.value.calendar).toBeNull();
    });

    it('the In-calendar list holds one entry per event (newest card wins), distinct events both stay', () => {
      const older = inCalendar();
      env.repos.items.update(older.id, { closedReason: null }, ANCHOR_MS);
      const newer = inCalendar({ eventState: 'updated', eventRevision: 2 });
      env.repos.items.update(newer.id, { eventRevision: 2 }, ANCHOR_MS + 1000);
      const other = inCalendar({ calendarEventId: OTHER_EVENT_ID });
      env.repos.items.update(other.id, { eventRevision: 1 }, ANCHOR_MS + 500);
      const list = service.dashboard().inCalendar;
      expect(list.map((c) => c.itemId)).toEqual([newer.id, other.id]);
      expect(new Set(list.map((c) => c.calendar!.eventKey)).size).toBe(list.length);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // disabledReason (B4 narrow guard)
  // ---------------------------------------------------------------------------------------------------------------
  it('update_event buttons grey out without a verified update surface; creates keep working', () => {
    const a = seedItem({ eventState: 'proposed' });
    env.repos.items.update(a.id, { currentProposalId: 5 }, ANCHOR_MS);
    vi.spyOn(env.repos.actions, 'forItem').mockReturnValue([
      fakeAction(a.id, 5, { kind: 'update_event', id: '66666666-6666-4666-8666-666666666666' }),
      fakeAction(a.id, 5, { kind: 'create_event' }),
    ]);
    const reasons = (): Record<string, string | null> => {
      const d = build().detail(a.id);
      return Object.fromEntries(d.ok ? d.value.actions.map((x) => [x.kind, x.disabledReason]) : []);
    };
    updates = undefined; // absent member => fail closed
    expect(reasons()).toEqual({ update_event: 'calendar_updates_unavailable', create_event: null });
    updates = false;
    expect(reasons()).toEqual({ update_event: 'calendar_updates_unavailable', create_event: null });
    updates = true;
    expect(reasons()).toEqual({ update_event: null, create_event: null });
    calendar = false;
    expect(reasons()).toEqual({ update_event: 'calendar_unavailable', create_event: 'calendar_unavailable' });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // ChangeView + changePending (B20, UX2 3.3)
  // ---------------------------------------------------------------------------------------------------------------
  describe('change card', () => {
    it('a change_proposed item carries the ChangeView from delta_json; the source card says "change pending"', () => {
      const source = inCalendar();
      const delta = seedItem({ eventState: 'change_proposed', linkedItemId: source.id });
      const real = env.repos.proposals.current.bind(env.repos.proposals);
      vi.spyOn(env.repos.proposals, 'current').mockImplementation((id) =>
        id === delta.id ? fakeProposal(delta.id, { delta: { ...DELTA, sourceItemId: source.id } }) : real(id),
      );
      const d = service.detail(delta.id);
      expect(d.ok && d.value.change).toEqual({
        kind: 'reschedule',
        from: FROM,
        to: TO,
        confidence: 'high',
        baseRevision: 1,
      });
      expect(d.ok && d.value.changePending).toBe(false);
      const s = service.detail(source.id);
      expect(s.ok && s.value.changePending).toBe(true);
      expect(s.ok && s.value.change).toBeNull();
      expect(JSON.stringify(d)).not.toContain(EVENT_ID); // targetEventId never crosses IPC
    });

    it('no ChangeView without a delta or outside change_proposed; no changePending when the open item is not linked', () => {
      const source = inCalendar();
      const plain = seedItem({ eventState: 'proposed' });
      vi.spyOn(env.repos.proposals, 'current').mockReturnValue(fakeProposal(plain.id, { delta: DELTA }));
      const p = service.detail(plain.id);
      expect(p.ok && p.value.change).toBeNull();
      const s = service.detail(source.id);
      expect(s.ok && s.value.changePending).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // UndoView (B10, F1, F2)
  // ---------------------------------------------------------------------------------------------------------------
  describe('undo door', () => {
    it('manual: available until min(appliedAt + 7 d, restore-target start); gone afterwards', () => {
      const a = inCalendar({ eventState: 'updated', eventRevision: 2 });
      vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockReturnValue(revision({ itemId: a.id }));
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(null);
      const targetStart = localToEpochMs(FROM.startLocal, TEST_TZ);
      const d = service.detail(a.id);
      expect(d.ok && d.value.undo).toEqual({
        revisionId: 7,
        until: Math.min(ANCHOR_MS + LIMITS.manualUndoWindowMs, targetStart),
        state: 'available',
        automatic: false,
      });
      now = targetStart;
      const later = service.detail(a.id);
      expect(later.ok && later.value.undo).toBeNull();
    });

    it('manual undo of a create is timed to the created event itself', () => {
      const a = inCalendar();
      vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockReturnValue(
        revision({ itemId: a.id, kind: 'create', revision: 1, prev: null, next: TO }),
      );
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(null);
      const d = service.detail(a.id);
      expect(d.ok && d.value.undo?.until).toBe(localToEpochMs(TO.startLocal, TEST_TZ));
    });

    it('no door when the candidate is missing or has no content left (retention)', () => {
      const a = inCalendar();
      const spy = vi.spyOn(env.repos.eventRevisions, 'undoCandidate');
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(null);
      spy.mockReturnValue(null);
      expect(service.detail(a.id).ok && (service.detail(a.id) as { value: { undo: unknown } }).value.undo).toBeNull();
      spy.mockReturnValue(revision({ itemId: a.id, prev: null, next: null }));
      expect((service.detail(a.id) as { value: { undo: unknown } }).value.undo).toBeNull();
      spy.mockReturnValue(revision({ itemId: a.id, prev: { ...FROM, timeZone: 'Not/AZone' } }));
      expect((service.detail(a.id) as { value: { undo: unknown } }).value.undo).toBeNull();
    });

    it('W1-04 change chain: the HOLDER card shows the Undo of an older card revision; the superseded card shows none', () => {
      const older = inCalendar({ eventState: 'updated', eventRevision: 2, closedReason: 'superseded' });
      const holder = inCalendar({ eventState: 'updated', eventRevision: 3 });
      vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockReturnValue(revision({ itemId: older.id }));
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(null);
      const undoOf = (id: number): unknown => (service.detail(id) as { value: { undo: unknown } }).value.undo;
      expect(undoOf(holder.id)).toEqual({
        revisionId: 7,
        until: Math.min(ANCHOR_MS + LIMITS.manualUndoWindowMs, localToEpochMs(FROM.startLocal, TEST_TZ)),
        state: 'available',
        automatic: false,
      });
      expect(undoOf(older.id)).toBeNull();
      // a card of ANOTHER event is never counted against this one
      const unrelated = inCalendar({ calendarEventId: OTHER_EVENT_ID, eventRevision: 9 });
      expect(unrelated.eventRevision).toBe(9);
      expect(undoOf(holder.id)).not.toBeNull();
    });

    it('an equal event_revision (no chain yet) keeps the door on the card itself', () => {
      const a = inCalendar({ eventState: 'updated', eventRevision: 2 });
      inCalendar({ eventState: 'updated', eventRevision: 2, closedReason: 'superseded' });
      vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockReturnValue(revision({ itemId: a.id }));
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(null);
      expect((service.detail(a.id) as { value: { undo: unknown } }).value.undo).not.toBeNull();
    });

    it('automatic: undo_until and the write undo_state; blocked states stay visible, expired / undone / past-window do not', () => {
      const a = inCalendar({ eventState: 'updated', eventRevision: 2 });
      vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockReturnValue(revision({ itemId: a.id }));
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(decision());
      const writes = vi.spyOn(env.repos.autoWrites, 'since');
      const undoOf = (): unknown => (service.detail(a.id) as { value: { undo: unknown } }).value.undo;
      writes.mockReturnValue([autoWrite()]);
      expect(undoOf()).toEqual({ revisionId: 7, until: ANCHOR_MS + 10 * HOUR, state: 'available', automatic: true });
      for (const state of ['blocked_changed', 'blocked_started', 'failed'] as const) {
        writes.mockReturnValue([autoWrite({ undoState: state })]);
        expect(undoOf()).toEqual({ revisionId: 7, until: ANCHOR_MS + 10 * HOUR, state, automatic: true });
      }
      for (const state of ['undone', 'expired'] as const) {
        writes.mockReturnValue([autoWrite({ undoState: state })]);
        expect(undoOf()).toBeNull();
      }
      writes.mockReturnValue([autoWrite()]);
      now = ANCHOR_MS + 10 * HOUR;
      expect(undoOf()).toBeNull();
      expect(writes).toHaveBeenCalledWith(decision().decidedAt);
    });

    it('a shadow / fallback decision is not an automatic write: the manual window applies', () => {
      const a = inCalendar({ eventState: 'updated', eventRevision: 2 });
      vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockReturnValue(revision({ itemId: a.id }));
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(decision({ verdict: 'shadow' }));
      const d = service.detail(a.id);
      expect(d.ok && d.value.undo?.automatic).toBe(false);
    });

    it('non-calendar items never look up revisions', () => {
      const a = seedItem({ eventState: 'proposed' });
      const spy = vi.spyOn(env.repos.eventRevisions, 'undoCandidate');
      service.detail(a.id);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // AutoCardView (B11 door 3, UX2 3.2)
  // ---------------------------------------------------------------------------------------------------------------
  describe('automatic-mode decoration', () => {
    const setup = (actionState: ApprovalAction['state'] = 'pending'): Item => {
      const a = seedItem({ eventState: 'proposed', currentProposalId: 5 });
      vi.spyOn(env.repos.actions, 'forItem').mockReturnValue([
        fakeAction(a.id, 5, { kind: 'send_reply', id: '77777777-7777-4777-8777-777777777777' }),
        fakeAction(a.id, 5, { id: '22222222-2222-4222-8222-222222222222', state: actionState }),
      ]);
      return a;
    };
    const autoOf = (id: number): unknown => (service.detail(id) as { value: { auto: unknown } }).value.auto;

    it('auto verdict => "automatic" chip + the write id; shadow => "auto_shadow"', () => {
      const a = setup('done');
      vi.spyOn(env.repos.autoPolicies, 'live').mockReturnValue(LIVE_POLICY);
      const forAction = vi
        .spyOn(env.repos.autoDecisions, 'forAction')
        .mockImplementation((id) => (id === '22222222-2222-4222-8222-222222222222' ? decision() : null));
      vi.spyOn(env.repos.autoWrites, 'since').mockReturnValue([autoWrite()]);
      expect(autoOf(a.id)).toEqual({ chip: 'automatic', notAutomaticReason: null, autoWriteId: autoWrite().id });
      forAction.mockReturnValue(decision({ verdict: 'shadow' }));
      expect(autoOf(a.id)).toEqual({ chip: 'auto_shadow', notAutomaticReason: null, autoWriteId: null });
      // send_reply actions are never looked up (replies are never automatic)
      expect(forAction).not.toHaveBeenCalledWith('77777777-7777-4777-8777-777777777777');
    });

    it('"Not automatic: {reason}" only for a pending action while a policy is live, never for policy_shadow', () => {
      const a = setup('pending');
      const live = vi.spyOn(env.repos.autoPolicies, 'live').mockReturnValue(LIVE_POLICY);
      const forAction = vi.spyOn(env.repos.autoDecisions, 'forAction');
      for (const reason of AUTO_REASONS.filter((r) => r !== 'ok' && r !== 'policy_shadow')) {
        forAction.mockReturnValue(decision({ verdict: 'fallback', reason }));
        expect(autoOf(a.id), reason).toEqual({ chip: null, notAutomaticReason: reason, autoWriteId: null });
      }
      forAction.mockReturnValue(decision({ verdict: 'fallback', reason: 'policy_shadow' }));
      expect(autoOf(a.id)).toBeNull();
      forAction.mockReturnValue(decision({ verdict: 'fallback', reason: 'badge_red' }));
      live.mockReturnValue(null);
      expect(autoOf(a.id)).toBeNull();
    });

    it('a decided action that is no longer pending shows no reason line; no decision => no decoration', () => {
      const a = setup('rejected');
      vi.spyOn(env.repos.autoPolicies, 'live').mockReturnValue(LIVE_POLICY);
      const forAction = vi.spyOn(env.repos.autoDecisions, 'forAction');
      forAction.mockReturnValue(decision({ verdict: 'fallback', reason: 'conflict' }));
      expect(autoOf(a.id)).toBeNull();
      forAction.mockReturnValue(null);
      expect(autoOf(a.id)).toBeNull();
    });

    it('an auto decision whose write row is not found still shows the chip, with autoWriteId null', () => {
      const a = setup('done');
      vi.spyOn(env.repos.autoDecisions, 'forAction').mockReturnValue(decision());
      vi.spyOn(env.repos.autoWrites, 'since').mockReturnValue([
        autoWrite({ actionId: '99999999-9999-4999-8999-999999999999' }),
      ]);
      expect(autoOf(a.id)).toEqual({ chip: 'automatic', notAutomaticReason: null, autoWriteId: null });
    });

    it('the live policy is read once per dashboard build, not once per card', () => {
      inCalendar();
      seedItem({ eventState: 'proposed' });
      const live = vi.spyOn(env.repos.autoPolicies, 'live').mockReturnValue(null);
      service.dashboard();
      expect(live).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // VoiceView / ImageReadView (B18, B19) - UNTRUSTED text passed on as data
  // ---------------------------------------------------------------------------------------------------------------
  describe('voice and picture bubbles', () => {
    it('a voice trigger carries its transcript row; pending before one exists; text only when done', () => {
      const a = seedItem({ eventState: 'proposed', triggerKind: 'voice' }, 'wamid.VOICE1');
      env.repos.items.snapshotMessages(a.id, [
        { itemId: a.id, waMsgId: 'wamid.VOICE1', fromMe: false, ts: ANCHOR_MS, text: '', textSha256: 'e'.repeat(64) },
      ]);
      const voiceOf = (): unknown => (service.detail(a.id) as { value: { voice: unknown } }).value.voice;
      expect(voiceOf()).toEqual({ seconds: 0, language: null, transcript: null, status: 'pending' });
      const row = {
        chatJid: chat.jid,
        waMsgId: 'wamid.VOICE1',
        status: 'done' as const,
        text: 'SENTINEL_TRANSCRIPT <b>bold</b>',
        language: 'he',
        seconds: 42,
        modelLabel: 'hebrew',
        errorCode: null,
        createdAt: ANCHOR_MS,
      };
      env.repos.transcripts.upsert(row);
      expect(voiceOf()).toEqual({ seconds: 42, language: 'he', transcript: row.text, status: 'done' });
      const d = service.detail(a.id);
      expect(d.ok && d.value.messages[0]!.voice).toEqual({
        seconds: 42,
        language: 'he',
        transcript: row.text,
        status: 'done',
      });
      env.repos.transcripts.upsert({ ...row, status: 'failed', text: 'partial', errorCode: 'VOICE_TIMEOUT' });
      expect(voiceOf()).toEqual({ seconds: 42, language: 'he', transcript: null, status: 'failed' });
    });

    it('an image trigger that was read carries the ImageReadView with the cached 320-px thumbnail', () => {
      const a = seedItem({ eventState: 'proposed', triggerKind: 'image' }, 'wamid.IMG1');
      env.repos.items.snapshotMessages(a.id, [
        { itemId: a.id, waMsgId: 'wamid.IMG1', fromMe: false, ts: ANCHOR_MS, text: '', textSha256: 'e'.repeat(64) },
      ]);
      const current = vi
        .spyOn(env.repos.proposals, 'current')
        .mockReturnValue(fakeProposal(a.id, { imageRead: IMAGE_READ }));
      thumbs.set(a.id, 'data:image/jpeg;base64,THUMB');
      const d = service.detail(a.id);
      expect(d.ok && d.value.image).toEqual({
        thumbDataUrl: 'data:image/jpeg;base64,THUMB',
        readText: IMAGE_READ.readText,
        dateText: '12.10',
        timeText: '19:30',
        location: 'Hall',
        confidence: 'medium',
        kind: 'invitation',
      });
      expect(d.ok && d.value.messages[0]!.image).toEqual({
        thumbDataUrl: 'data:image/jpeg;base64,THUMB',
        readText: IMAGE_READ.readText,
      });
      current.mockReturnValue(fakeProposal(a.id));
      const unread = service.detail(a.id);
      expect(unread.ok && unread.value.image).toBeNull();
      thumbs.clear();
      current.mockReturnValue(fakeProposal(a.id, { imageRead: IMAGE_READ }));
      const noThumb = build({ mediaCache: undefined }).detail(a.id);
      expect(noThumb.ok && noThumb.value.image?.thumbDataUrl).toBeNull();
    });

    it('text items never touch transcripts or the media cache', () => {
      const a = seedItem({ eventState: 'proposed' });
      const t = vi.spyOn(env.repos.transcripts, 'get');
      const thumb = vi.fn(() => null);
      build({ mediaCache: { thumb, dataUrl: () => null } }).detail(a.id);
      expect(t).not.toHaveBeenCalled();
      expect(thumb).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // item:getImage
  // ---------------------------------------------------------------------------------------------------------------
  describe('getImage', () => {
    const cacheRow = (itemId: number): void => {
      vi.spyOn(env.repos.mediaCache, 'forItem').mockImplementation((id) =>
        id === itemId
          ? [
              {
                itemId,
                chatId: chat.id,
                waMsgId: 'wamid.IMG1',
                sha256: 'f'.repeat(64),
                width: 1536,
                height: 1024,
                bytes: 1000,
                createdAt: ANCHOR_MS,
              },
            ]
          : [],
      );
    };

    it('returns the JPEG data URL of an item with a media_cache row', () => {
      const a = seedItem({ eventState: 'proposed', triggerKind: 'image' });
      cacheRow(a.id);
      fullImages.set(a.id, 'data:image/jpeg;base64,FULL');
      expect(service.getImage(a.id)).toEqual({ ok: true, value: { dataUrl: 'data:image/jpeg;base64,FULL' } });
    });

    it('NOT_FOUND for an unknown item or one without a cache row', () => {
      const a = seedItem({ eventState: 'proposed' });
      cacheRow(a.id + 1);
      expect(service.getImage(99_999)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(service.getImage(a.id)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    });

    it('MEDIA_UNAVAILABLE when the file is gone, is not a JPEG data URL, is too large, or no cache is wired', () => {
      const a = seedItem({ eventState: 'proposed', triggerKind: 'image' });
      cacheRow(a.id);
      const code = (s: ItemService = service): unknown => {
        const r = s.getImage(a.id);
        return r.ok ? 'ok' : r.error.code;
      };
      fullImages.set(a.id, null);
      expect(code()).toBe('MEDIA_UNAVAILABLE');
      fullImages.set(a.id, 'data:image/svg+xml;base64,PHN2Zz4=');
      expect(code()).toBe('MEDIA_UNAVAILABLE');
      const prefix = 'data:image/jpeg;base64,';
      fullImages.set(a.id, prefix + 'A'.repeat(LIMITS.imageDataUrlMaxBytes - prefix.length));
      expect(code()).toBe('ok');
      fullImages.set(a.id, prefix + 'A'.repeat(LIMITS.imageDataUrlMaxBytes - prefix.length + 1));
      expect(code()).toBe('MEDIA_UNAVAILABLE');
      expect(env.log.lines.some((l) => l.event === 'item_image_too_large')).toBe(true);
      expect(code(build({ mediaCache: undefined }))).toBe('MEDIA_UNAVAILABLE');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // degradation, completeEvent, chat auto policy
  // ---------------------------------------------------------------------------------------------------------------
  it('a failing decoration degrades only its field, logs the field name only, and never takes the dashboard down', () => {
    const a = inCalendar();
    vi.spyOn(env.repos.eventRevisions, 'undoCandidate').mockImplementation(() => {
      throw new Error(`boom ${EVENT_ID} SENTINEL_MSG_TEXT`);
    });
    vi.spyOn(env.repos.autoPolicies, 'live').mockImplementation(() => {
      throw new Error('policy table gone');
    });
    const data = service.dashboard();
    expect(data.inCalendar.map((c) => c.itemId)).toEqual([a.id]);
    expect(data.inCalendar[0]!.undo).toBeNull();
    const degraded = env.log.lines.filter((l) => l.event === 'item_view_degraded');
    expect(degraded.map((l) => l.meta?.field).sort()).toEqual(['autoPolicy', 'undo']);
    expect(JSON.stringify(env.log.lines)).not.toContain('SENTINEL_MSG_TEXT');
    expect(JSON.stringify(env.log.lines)).not.toContain(EVENT_ID);
  });

  it('completeEvent() is refused once an event exists or a change of one is pending', () => {
    const EVENT = { title: 'x', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' };
    for (const eventState of ['updated', 'cancelled', 'change_proposed'] as const) {
      const a = seedItem({ eventState: 'proposed' });
      env.repos.items.update(a.id, { eventState }, ANCHOR_MS);
      expect(service.completeEvent({ itemId: a.id, event: EVENT }), eventState).toEqual({
        ok: false,
        error: { code: 'ACTION_STALE' },
      });
      env.repos.items.update(a.id, { closedReason: 'dismissed' }, ANCHOR_MS);
    }
  });

  it('chat:setPolicy {autoPolicy} stores "never" / "inherit" and lists the chat', () => {
    const never = service.setChatPolicy({ chatRef: chat.id, autoPolicy: 'never' });
    expect(never.ok && never.value.autoPolicy).toBe('never');
    // C2 8 IpcResMap 'chat:listPolicies': "[V2] or autoPolicy = 'never'" - the filter is repos.chats.withPolicies() (V2-W1-01).
    expect(service.listPolicies().chats.map((c) => c.chatRef)).toContain(chat.id);
    const inherit = service.setChatPolicy({ chatRef: chat.id, autoPolicy: 'inherit' });
    expect(inherit.ok && inherit.value.autoPolicy).toBe('inherit');
    expect(service.setChatPolicy({ chatRef: 99_999, autoPolicy: 'never' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
