// src/main/agent/items.test.ts - ItemService view models + user item actions (TESTS 5.3 row `agent/...items`; owner W1-10).
// Every assertion is about what crosses IPC: renderer-visible ids only, no JIDs, `[R2]` no calendarHtmlLink anywhere.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createItemService, formatPhoneDisplay, type ItemService } from './items';
import { validateAndPersist } from './validate';
import { resolveExtraction } from './resolve';
import type { Extraction } from '../../shared/schemas';
import { LIMITS, type Chat, type EpochMs, type Item, type ItemId } from '../../shared/types';
import { ANCHOR_MS, TEST_TZ, createTestEnv, seedChat, seedOpenItem, type TestEnv } from '../../../tests/golden/testDb';

const EXTRACTION: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: 'coffee',
  dateKind: 'relative_days',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 1,
  time24h: '17:00',
  timeAmbiguous: false,
  durationMin: 60,
  location: '',
  missing: [],
  suspicious: false,
  // [V2] C2 5: the four B20 fields S1 v2 always returns (null-event defaults of the S1 v2 few-shots)
  refersToExisting: false,
  change: 'no_change',
  changeConfidence: 'high',
  confidence: 'high',
};

describe('formatPhoneDisplay', () => {
  it('formats a 12-digit Israeli mobile number', () => {
    expect(formatPhoneDisplay('972550000001@s.whatsapp.net')).toBe('+972 55-000-0001');
  });
  it('formats an 11-digit Israeli number', () => {
    expect(formatPhoneDisplay('97235550001@s.whatsapp.net')).toBe('+972 3-555-0001');
  });
  it('groups any other country code by threes', () => {
    expect(formatPhoneDisplay('14155550123@s.whatsapp.net')).toBe('+1 415 555 012 3');
  });
  it('returns an empty string for an @lid JID and for anything that is not a DM JID', () => {
    expect(formatPhoneDisplay('112233445566778@lid')).toBe('');
    expect(formatPhoneDisplay('120363000000000000@g.us')).toBe('');
    expect(formatPhoneDisplay('nonsense')).toBe('');
  });
});

describe('createItemService', () => {
  let env: TestEnv;
  let chat: Chat;
  let item: Item;
  let service: ItemService;
  let notified: number[][];
  let retriaged: number[];
  let now: EpochMs;
  let online: boolean;
  let outdated: boolean;
  let calendar: boolean;

  /** Runs the deterministic S4 step so the item has a proposal, a draft and both pending actions. */
  const triage = (target: Item = item, over: Partial<Parameters<typeof validateAndPersist>[1]> = {}): void => {
    const extraction = over.extraction ?? EXTRACTION;
    const targetChat = env.repos.chats.byId(target.chatId)!;
    // A test that seeded its own snapshot keeps it; otherwise the default trigger row stands in for what the model saw.
    if (env.repos.items.messages(target.id).length === 0) {
      env.repos.items.snapshotMessages(target.id, [
        {
          itemId: target.id,
          waMsgId: target.triggerMsgId,
          fromMe: false,
          ts: target.triggerTs,
          text: 'coffee tomorrow at 17:00?',
          textSha256: 'a'.repeat(64),
        },
      ]);
    }
    // The orchestrator claims the item (`analysis='running'`) before the model calls; S4 reads the CURRENT row back.
    env.repos.items.update(target.id, { analysis: 'running' }, ANCHOR_MS);
    validateAndPersist(
      env.repos,
      {
        item: env.repos.items.byId(target.id)!,
        chat: { id: targetChat.id, sendable: targetChat.sendable, lang: targetChat.lang },
        extraction,
        slot: resolveExtraction(extraction, {
          nowMs: ANCHOR_MS,
          timeZone: TEST_TZ,
          defaultDurationMin: 60,
          ambiguousHour: 'assume',
        }),
        draftText: 'Tomorrow at 17:00 works for me',
        replyLang: 'en',
        busy: null,
        provider: 'local',
        model: 'stub-model',
        contextBadges: [],
        manipulation: false,
        now: ANCHOR_MS,
        ...over,
      },
      { calendarConnected: true },
    );
  };

  beforeEach(() => {
    env = createTestEnv();
    notified = [];
    retriaged = [];
    now = ANCHOR_MS;
    online = true;
    outdated = false;
    calendar = true;
    chat = seedChat(env.repos);
    item = seedOpenItem(env.repos, chat);
    service = createItemService({
      repos: env.repos,
      settings: () => env.settings,
      clock: { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined },
      log: env.log,
      bridgeOnline: () => online,
      bridgeOutdated: () => outdated,
      calendarConnected: () => calendar,
      notifyChanged: (ids) => void notified.push(ids),
      enqueueRetriage: (ref) => void retriaged.push(ref),
    });
  });
  afterEach(() => env.dispose());

  // ---------------------------------------------------------------------------------------------------------------
  // view models
  // ---------------------------------------------------------------------------------------------------------------
  it('builds a full card with the chat view, the draft, the event and both action controls', () => {
    triage();
    const card = service.dashboard().needsReply[0]!;
    expect(card.itemId).toBe(item.id);
    expect(card.card).toBe('full');
    expect(card.status).toBe('needs_reply');
    expect(card.chat).toEqual({
      chatRef: chat.id,
      displayName: 'Test Contact',
      phoneDisplay: '+972 55-000-0001',
      sendable: true,
      isKnown: true,
      policy: 'default',
      autoPolicy: 'inherit', // [V2] C2 1.5
    });
    expect(card.draft).toMatchObject({ text: 'Tomorrow at 17:00 works for me', lang: 'en', proposalVersion: 1 });
    expect(card.event).toMatchObject({ startLocal: '2026-09-22T17:00:00' });
    expect(card.actions.map((a) => a.kind)).toEqual(['create_event', 'send_reply']);
    expect(card.editingLocked).toBe(false);
  });

  it('never puts a JID or a calendar link into a view model ([R2])', () => {
    triage();
    env.repos.items.update(
      item.id,
      { calendarHtmlLink: 'https://calendar.google.com/evil', eventState: 'created', eventStartTs: ANCHOR_MS },
      now,
    );
    const dump = JSON.stringify([service.dashboard(), service.detail(item.id), service.listPolicies()]);
    expect(dump).not.toContain('@s.whatsapp.net');
    expect(dump).not.toContain('calendarHtmlLink');
    expect(dump).not.toContain('calendar.google.com');
  });

  it('cuts the trigger preview to LIMITS.triggerPreviewChars', () => {
    env.repos.items.snapshotMessages(item.id, [
      {
        itemId: item.id,
        waMsgId: item.triggerMsgId,
        fromMe: false,
        ts: item.triggerTs,
        text: 'x'.repeat(LIMITS.triggerPreviewChars + 100),
        textSha256: 'a'.repeat(64),
      },
    ]);
    triage();
    expect(service.dashboard().needsReply[0]!.trigger.text).toHaveLength(LIMITS.triggerPreviewChars);
  });

  it('falls back to the newest snapshot row when the trigger row is missing, and to null with no snapshot', () => {
    env.repos.items.snapshotMessages(item.id, [
      {
        itemId: item.id,
        waMsgId: 'wamid.OTHER',
        fromMe: false,
        ts: item.triggerTs,
        text: 'fallback text',
        textSha256: 'a'.repeat(64),
      },
    ]);
    env.repos.items.update(item.id, { analysis: 'held', holdReason: 'paused' }, now);
    expect(service.dashboard().needsReply[0]!.trigger.text).toBe('fallback text');

    const bare = seedChat(env.repos, { jid: '972550000002@s.whatsapp.net' });
    const bareItem = seedOpenItem(env.repos, bare);
    env.repos.items.update(bareItem.id, { analysis: 'failed', errorCode: 'LLM_BAD_OUTPUT' }, now);
    const card = service.dashboard().needsReply.find((c) => c.itemId === bareItem.id)!;
    expect(card.trigger.text).toBeNull();
    expect(card.card).toBe('raw');
    expect(card.errorCode).toBe('LLM_BAD_OUTPUT');
  });

  it('counts queued and running items as "analysing" but never lists them', () => {
    const data = service.dashboard();
    expect(data.analysing).toBe(1);
    expect(data.needsReply).toHaveLength(0);
  });

  it('greys the Send control while the bridge is offline or outdated, and the calendar control while it is gone', () => {
    triage();
    online = false;
    let actions = service.dashboard().needsReply[0]!.actions;
    expect(actions.find((a) => a.kind === 'send_reply')!.disabledReason).toBe('wa_offline');
    outdated = true;
    actions = service.dashboard().needsReply[0]!.actions;
    expect(actions.find((a) => a.kind === 'send_reply')!.disabledReason).toBe('bridge_outdated');
    calendar = false;
    actions = service.dashboard().needsReply[0]!.actions;
    expect(actions.find((a) => a.kind === 'create_event')!.disabledReason).toBe('calendar_unavailable');
  });

  it('shows at most one control per kind and carries the previous attempt error as lastError', () => {
    triage();
    const send = env.repos.actions.forItem(item.id).find((a) => a.kind === 'send_reply')!;
    env.repos.actions.markApprovedExecuting(send.id, send.canonicalJson, now, 'user');
    env.repos.actions.markFailed(send.id, 'SEND_FAILED', now);
    const clone = env.repos.actions.insertPending({
      itemId: item.id,
      proposalId: send.proposalId,
      chatId: chat.id,
      payload: JSON.parse(send.canonicalJson) as never,
      now,
      retryOf: send.id,
    });
    const views = service.detail(item.id).ok
      ? (
          service.detail(item.id) as {
            value: { actions: Array<{ kind: string; actionId: string; lastError: string | null; attempt: number }> };
          }
        ).value.actions
      : [];
    const view = views.find((a) => a.kind === 'send_reply')!;
    expect(view.actionId).toBe(clone.id);
    expect(view.attempt).toBe(2);
    expect(view.lastError).toBe('SEND_FAILED');
  });

  it('hides actions of a superseded proposal', () => {
    triage();
    triage(env.repos.items.byId(item.id)!);
    const card = service.dashboard().needsReply[0]!;
    expect(card.actions).toHaveLength(2);
    expect(card.draft!.proposalVersion).toBe(2);
  });

  it('detail() adds the message snapshot oldest first and reports NOT_FOUND for an unknown id', () => {
    env.repos.items.snapshotMessages(item.id, [
      {
        itemId: item.id,
        waMsgId: 'wamid.A',
        fromMe: false,
        ts: ANCHOR_MS - 120_000,
        text: 'first',
        textSha256: 'a'.repeat(64),
      },
      {
        itemId: item.id,
        waMsgId: 'wamid.B',
        fromMe: true,
        ts: ANCHOR_MS - 60_000,
        text: 'second',
        textSha256: 'b'.repeat(64),
      },
    ]);
    triage();
    const res = service.detail(item.id);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.messages.map((m) => m.text)).toEqual(['first', 'second']);
      expect(res.value.messages.map((m) => m.seq)).toEqual([0, 1]);
    }
    expect(service.detail(99_999 as ItemId)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('reports NOT_FOUND when the item outlived its chat row', () => {
    triage();
    env.db.prepare('PRAGMA foreign_keys=OFF').run();
    env.db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
    expect(service.detail(item.id)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(service.dashboard().needsReply).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // ignored()
  // ---------------------------------------------------------------------------------------------------------------
  it('[R2] ignored() returns dismissed cards only, never auto-closed ones', () => {
    triage();
    service.dismiss(item.id);
    const other = seedChat(env.repos, { jid: '972550000003@s.whatsapp.net' });
    const autoClosed = seedOpenItem(env.repos, other);
    env.repos.items.update(autoClosed.id, { analysis: 'done', closedReason: 'not_needed' }, now);
    const ignored = service.ignored();
    expect(ignored.items.map((c) => c.itemId)).toEqual([item.id]);
    expect(ignored.items[0]!.status).toBe('dismissed');
  });

  it('ignored() caps at LIMITS.listSize', () => {
    for (let i = 0; i < LIMITS.listSize + 3; i++) {
      const c = seedChat(env.repos, { jid: `9725500001${String(i).padStart(2, '0')}@s.whatsapp.net` });
      const it = seedOpenItem(env.repos, c);
      env.repos.items.update(it.id, { analysis: 'done', closedReason: 'dismissed' }, now + i);
    }
    expect(service.ignored().items).toHaveLength(LIMITS.listSize);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // user actions
  // ---------------------------------------------------------------------------------------------------------------
  it('dismiss() supersedes the pending actions in one transaction and notifies', () => {
    triage();
    const before = env.repos.actions.forItem(item.id).map((a) => a.id);
    const res = service.dismiss(item.id);
    expect(res.ok).toBe(true);
    for (const id of before) expect(env.repos.actions.byId(id)!.state).toBe('superseded');
    expect(env.repos.items.byId(item.id)!.state).toBe('ignored');
    expect(notified).toContainEqual([item.id]);
    expect(service.dismiss(99_999 as ItemId)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('restore() reopens a dismissed item and refuses when a newer item owns the chat slot', () => {
    triage();
    service.dismiss(item.id);
    expect(service.restore(item.id).ok).toBe(true);
    expect(env.repos.items.byId(item.id)!.closedReason).toBeNull();

    // An already-open item is returned untouched.
    expect(service.restore(item.id).ok).toBe(true);

    service.dismiss(item.id);
    seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.NEWER' });
    expect(service.restore(item.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(service.restore(99_999 as ItemId)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('retriage() re-queues the item, writes the queue row and pokes the worker', () => {
    triage();
    env.repos.items.update(item.id, { errorCode: 'LLM_BAD_OUTPUT', analysis: 'failed' }, now);
    const res = service.retriage(item.id);
    expect(res.ok).toBe(true);
    const fresh = env.repos.items.byId(item.id)!;
    expect(fresh.analysis).toBe('queued');
    expect(fresh.errorCode).toBeNull();
    expect(env.repos.queue.size()).toBe(1);
    expect(retriaged).toEqual([chat.id]);
  });

  it('retriage() refuses over the per-chat hourly budget and for an unknown item', () => {
    for (let i = 0; i < LIMITS.llmRunsPerChatPerHour; i++) env.repos.rate.record('llm_chat', String(chat.id), now);
    expect(service.retriage(item.id)).toEqual({ ok: false, error: { code: 'RATE_LIMIT_RETRIAGE' } });
    expect(service.retriage(99_999 as ItemId)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('retriage() of a closed item refuses when the chat already has a newer open item', () => {
    triage();
    service.dismiss(item.id);
    seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.NEWER' });
    expect(service.retriage(item.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
  });

  it('retriage() refuses for an `ignored` item that closed itself WITHOUT a closed_reason', () => {
    // `ux_items_open` keys on state, not on closed_reason: an item can rest in `ignored` with closed_reason NULL
    // (here: intent cancel -> closureFor() returns null, no draft, no slot), while a newer message opens item B.
    // Re-opening A must be refused, not raise a raw `UNIQUE constraint failed: items.chat_id` out of the IPC layer.
    triage(item, { extraction: { ...EXTRACTION, intent: 'cancel', needsReply: false }, draftText: null });
    const closed = env.repos.items.byId(item.id)!;
    expect(closed.state).toBe('ignored');
    expect(closed.closedReason).toBeNull();

    const newer = seedOpenItem(env.repos, chat, { triggerMsgId: 'wamid.NEWER' });
    expect(service.retriage(item.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    // ...and nothing was written on the way out
    expect(env.repos.items.byId(item.id)!.state).toBe('ignored');
    expect(env.repos.items.byId(newer.id)!.state).toBe('needs_reply');
    expect(env.repos.queue.size()).toBe(0);
  });

  it('setEditing() arms and clears the edit lock', () => {
    expect(service.setEditing(item.id, true)).toEqual({ ok: true, value: null });
    expect(env.repos.items.byId(item.id)!.editingUntil).toBe(now + LIMITS.editLockMs);
    service.setEditing(item.id, false);
    expect(env.repos.items.byId(item.id)!.editingUntil).toBe(0);
    expect(service.setEditing(99_999 as ItemId, true)).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // completeEvent
  // ---------------------------------------------------------------------------------------------------------------
  const EVENT = {
    title: 'Coffee',
    startLocal: '2026-09-22T17:00:00',
    endLocal: '2026-09-22T18:00:00',
    location: 'Cafe',
  };

  it('completeEvent() writes a "user" proposal plus ONE pending create_event and supersedes the old actions', () => {
    triage(item, { extraction: { ...EXTRACTION, time24h: '', missing: ['time'] } });
    const before = env.repos.actions.forItem(item.id).map((a) => a.id);
    const res = service.completeEvent({ itemId: item.id, event: EVENT });
    expect(res.ok).toBe(true);
    const proposal = env.repos.proposals.current(item.id)!;
    expect(proposal.provider).toBe('user');
    expect(proposal.event).toMatchObject({ ...EVENT, timeZone: TEST_TZ, assumptions: [], dateHint: '' });
    for (const id of before) expect(env.repos.actions.byId(id)!.state).toBe('superseded');
    const pending = env.repos.actions.forItem(item.id).filter((a) => a.state === 'pending');
    expect(pending.map((a) => a.kind)).toEqual(['create_event']);
    expect(env.repos.items.byId(item.id)!.eventState).toBe('proposed');
    expect(env.repos.items.byId(item.id)!.missing).toEqual([]);
  });

  it('completeEvent() carries the previous proposal content forward when there is one, and works without one', () => {
    triage(item, { extraction: { ...EXTRACTION, time24h: '', missing: ['time'] } });
    service.completeEvent({ itemId: item.id, event: EVENT });
    expect(env.repos.proposals.current(item.id)!.draftText).toBe('Tomorrow at 17:00 works for me');

    const other = seedChat(env.repos, { jid: '972550000004@s.whatsapp.net' });
    const bare = seedOpenItem(env.repos, other);
    expect(service.completeEvent({ itemId: bare.id, event: EVENT }).ok).toBe(true);
    const proposal = env.repos.proposals.current(bare.id)!;
    expect(proposal.extraction).toBeNull();
    expect(proposal.draftText).toBeNull();
    expect(proposal.suspicious).toBe(false);
  });

  it('completeEvent() refuses for an unknown item, a closed item, a created event, no calendar and a bad edit', () => {
    expect(service.completeEvent({ itemId: 99_999, event: EVENT })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });

    calendar = false;
    expect(service.completeEvent({ itemId: item.id, event: EVENT })).toEqual({
      ok: false,
      error: { code: 'CAL_UNAVAILABLE' },
    });
    calendar = true;

    expect(service.completeEvent({ itemId: item.id, event: { ...EVENT, endLocal: '2026-09-22T16:00:00' } })).toEqual({
      ok: false,
      error: { code: 'EVENT_INVALID' },
    });

    env.repos.items.update(item.id, { eventState: 'created', eventStartTs: ANCHOR_MS }, now);
    expect(service.completeEvent({ itemId: item.id, event: EVENT })).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });

    env.repos.items.update(item.id, { eventState: 'none', closedReason: 'dismissed' }, now);
    expect(service.completeEvent({ itemId: item.id, event: EVENT })).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // policies
  // ---------------------------------------------------------------------------------------------------------------
  it('setChatPolicy() stores "never" and lists it', () => {
    const res = service.setChatPolicy({ chatRef: chat.id, policy: 'never' });
    expect(res).toMatchObject({ ok: true, value: { policy: 'never', chatRef: chat.id } });
    expect(service.listPolicies().chats.map((c) => c.chatRef)).toContain(chat.id);
    expect(service.setChatPolicy({ chatRef: 99_999, policy: 'never' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('"Analyse this chat" releases the held raw card of that chat immediately', () => {
    const stranger = seedChat(env.repos, { jid: '972550000005@s.whatsapp.net', isKnown: false });
    const held = seedOpenItem(env.repos, stranger);
    env.repos.items.update(held.id, { analysis: 'held', holdReason: 'unknown_sender' }, now);
    const res = service.setChatPolicy({ chatRef: stranger.id, forceKnown: true });
    expect(res).toMatchObject({ ok: true, value: { isKnown: true } });
    const fresh = env.repos.items.byId(held.id)!;
    expect(fresh.analysis).toBe('queued');
    expect(fresh.holdReason).toBeNull();
    expect(env.repos.queue.size()).toBe(1);
    expect(retriaged).toEqual([stranger.id]);
  });

  it('"Analyse this chat" on a chat whose item is held for another reason does not re-queue it', () => {
    const stranger = seedChat(env.repos, { jid: '972550000006@s.whatsapp.net', isKnown: false });
    const held = seedOpenItem(env.repos, stranger);
    env.repos.items.update(held.id, { analysis: 'held', holdReason: 'paused' }, now);
    service.setChatPolicy({ chatRef: stranger.id, forceKnown: true });
    expect(env.repos.items.byId(held.id)!.analysis).toBe('held');
    expect(retriaged).toEqual([]);
  });

  it('"Analyse this chat" on a chat with no open item is a no-op beyond the flag', () => {
    const stranger = seedChat(env.repos, { jid: '972550000007@s.whatsapp.net', isKnown: false });
    expect(service.setChatPolicy({ chatRef: stranger.id, forceKnown: true }).ok).toBe(true);
    expect(retriaged).toEqual([]);
  });

  it('a card with no display name falls back to an empty string', () => {
    const anon = seedChat(env.repos, { jid: '972550000008@s.whatsapp.net', name: null });
    expect(service.setChatPolicy({ chatRef: anon.id, policy: 'never' })).toMatchObject({
      ok: true,
      value: { displayName: '' },
    });
  });

  it('reports the editing lock on the card', () => {
    triage();
    service.setEditing(item.id, true);
    expect(service.dashboard().needsReply[0]!.editingLocked).toBe(true);
  });

  it('reports the in_calendar bucket with its event start', () => {
    triage();
    env.repos.items.update(item.id, { eventState: 'created', eventStartTs: (ANCHOR_MS + 86_400_000) as EpochMs }, now);
    const data = service.dashboard();
    expect(data.inCalendar.map((c) => c.itemId)).toEqual([item.id]);
    // [V2] C2 1.5: + the opaque eventKey (16 hex), the event revision and status
    expect(data.inCalendar[0]!.calendar).toEqual({
      eventStartTs: ANCHOR_MS + 86_400_000,
      eventKey: expect.stringMatching(/^[0-9a-f]{16}$/),
      revision: expect.any(Number),
      status: 'confirmed',
    });
    expect(data.counts.inCalendar).toBe(1);
  });

  it('reports the info_missing bucket', () => {
    triage(item, { extraction: { ...EXTRACTION, time24h: '', missing: ['time'] } });
    const data = service.dashboard();
    expect(data.infoMissing.map((c) => c.itemId)).toEqual([item.id]);
    expect(data.infoMissing[0]!.missing).toContain('time');
  });
});
