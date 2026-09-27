// src/main/exec/outcome.test.ts - TESTS 5.3 row `exec/*`: the item-row consequences of a CONFIRMED side effect.
// These helpers are shared by the executor (answer arrived) and by reconcile (answer found after a crash), so a reconciled
// action must leave EXACTLY the same item row as a directly executed one. They never execute anything themselves.
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_DB, createRepos, openDb } from '../db/index';
import { localToEpochMs } from '../../shared/when';
import { applyCreateSuccess, applyFailure, applySendSuccess, parseFinalPayload } from './outcome';
import type { Db } from '../db/index';
import type { ApprovalAction, EpochMs, ItemId } from '../../shared/types';
import type { CreateEventPayload, SendReplyPayload } from '../../shared/schemas';

const NOW_0 = Date.UTC(2026, 8, 21, 9, 0, 0) as EpochMs;
const LATER = (NOW_0 + 60_000) as EpochMs;
const JID = '972550000003@s.whatsapp.net'; // TESTS T5: synthetic JID
const START = '2026-09-24T17:00:00';
const END = '2026-09-24T18:00:00';

const open: Db[] = [];
afterEach(() => {
  while (open.length) open.pop()?.close();
});

function rig() {
  const db = openDb(MEMORY_DB);
  open.push(db);
  const repos = createRepos(db);
  const chat = repos.chats.upsertFromBridge(JID, 'Contact', true, NOW_0);
  const item = repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: 'm1',
    triggerTs: NOW_0,
    analysis: 'done',
    holdReason: null,
    now: NOW_0,
  });
  const proposal = repos.proposals.insertNext({
    itemId: item.id,
    provider: 'user',
    model: 'test',
    extraction: null,
    draftText: 'hi',
    replyLang: 'en',
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: NOW_0,
  });
  return { db, repos, chatId: chat.id, itemId: item.id as ItemId, proposalId: proposal.id };
}
type Rig = ReturnType<typeof rig>;

const reply = (r: Rig): SendReplyPayload => ({
  v: 1,
  kind: 'send_reply',
  itemId: r.itemId,
  chatRef: r.chatId,
  proposalVersion: 1,
  text: 'ok',
});
const event = (r: Rig): CreateEventPayload => ({
  v: 1,
  kind: 'create_event',
  itemId: r.itemId,
  chatRef: r.chatId,
  proposalVersion: 1,
  title: 'Coffee',
  startLocal: START,
  endLocal: END,
  timeZone: 'Asia/Jerusalem',
  location: '',
});

function seed(r: Rig, payload: SendReplyPayload | CreateEventPayload): ApprovalAction {
  return r.repos.actions.insertPending({
    itemId: r.itemId,
    proposalId: r.proposalId,
    chatId: r.chatId,
    payload,
    now: NOW_0,
  });
}

/** An action row pointing at an item id that does not exist: the "row vanished under us" guard. */
const orphan = (a: ApprovalAction): ApprovalAction => ({ ...a, itemId: 999_999 as ItemId });

describe('parseFinalPayload', () => {
  it('returns the approved payload', () => {
    const r = rig();
    const a = seed(r, reply(r));
    expect(parseFinalPayload({ ...a, approvedFinalJson: a.canonicalJson })).toEqual(reply(r));
  });

  it('returns null for a retention-nulled or empty payload', () => {
    const r = rig();
    const a = seed(r, reply(r));
    expect(parseFinalPayload({ ...a, approvedFinalJson: null })).toBeNull();
    expect(parseFinalPayload({ ...a, approvedFinalJson: '' })).toBeNull();
  });

  it('returns null for malformed JSON and for a payload that fails the schema', () => {
    const r = rig();
    const a = seed(r, reply(r));
    expect(parseFinalPayload({ ...a, approvedFinalJson: '{nope' })).toBeNull();
    expect(parseFinalPayload({ ...a, approvedFinalJson: '{"v":1,"kind":"send_reply"}' })).toBeNull();
    expect(parseFinalPayload({ ...a, approvedFinalJson: '{"v":1,"kind":"other"}' })).toBeNull();
  });
});

describe('applySendSuccess', () => {
  it('marks the reply sent, clears the inline error and closes the item as replied', () => {
    const r = rig();
    const a = seed(r, reply(r));
    r.repos.items.update(r.itemId, { errorCode: 'SEND_FAILED' }, NOW_0);
    applySendSuccess(r.repos, a, reply(r), LATER);
    const item = r.repos.items.byId(r.itemId)!;
    expect(item.replyState).toBe('sent');
    expect(item.errorCode).toBeNull();
    expect(item.closedReason).toBe('replied');
    expect(item.updatedAt).toBe(LATER);
  });

  it.each([['proposed'], ['incomplete']] as const)('keeps the item open while the event is %s', (eventState) => {
    const r = rig();
    const a = seed(r, reply(r));
    r.repos.items.update(r.itemId, { eventState }, NOW_0);
    applySendSuccess(r.repos, a, reply(r), LATER);
    const item = r.repos.items.byId(r.itemId)!;
    expect(item.replyState).toBe('sent');
    expect(item.closedReason).toBeNull();
  });

  it('never overwrites a closed reason the item already carries', () => {
    const r = rig();
    const a = seed(r, reply(r));
    r.repos.items.update(r.itemId, { closedReason: 'dismissed', closedAt: NOW_0 }, NOW_0);
    applySendSuccess(r.repos, a, reply(r), LATER);
    expect(r.repos.items.byId(r.itemId)?.closedReason).toBe('dismissed');
  });

  it('is a no-op when the item row is gone', () => {
    const r = rig();
    const a = seed(r, reply(r));
    expect(() => applySendSuccess(r.repos, orphan(a), reply(r), LATER)).not.toThrow();
    expect(r.repos.items.byId(r.itemId)?.replyState).toBe('none');
  });
});

describe('applyCreateSuccess', () => {
  const result = { kind: 'create_event' as const, eventId: 'ev-9', htmlLink: 'https://calendar.example/ev-9' };

  it('moves the item to in_calendar and records the event coordinates', () => {
    const r = rig();
    const a = seed(r, event(r));
    r.repos.items.update(r.itemId, { errorCode: 'CAL_UNAVAILABLE' }, NOW_0);
    applyCreateSuccess(r.repos, a, event(r), result, LATER);
    const item = r.repos.items.byId(r.itemId)!;
    expect(item.eventState).toBe('created');
    expect(item.errorCode).toBeNull();
    expect(item.calendarEventId).toBe('ev-9');
    expect(item.calendarHtmlLink).toBe(result.htmlLink);
    expect(item.eventStartTs).toBe(localToEpochMs(START, 'Asia/Jerusalem'));
  });

  it('accepts a result without an html link', () => {
    const r = rig();
    const a = seed(r, event(r));
    applyCreateSuccess(r.repos, a, event(r), { ...result, htmlLink: null }, LATER);
    expect(r.repos.items.byId(r.itemId)?.calendarHtmlLink).toBeNull();
  });

  it('is a no-op when the item row is gone', () => {
    const r = rig();
    const a = seed(r, event(r));
    expect(() => applyCreateSuccess(r.repos, orphan(a), event(r), result, LATER)).not.toThrow();
    expect(r.repos.items.byId(r.itemId)?.eventState).toBe('none');
  });
});

describe('applyFailure', () => {
  it('records the inline error code on the item', () => {
    const r = rig();
    const a = seed(r, reply(r));
    applyFailure(r.repos, a, 'SEND_FAILED', LATER);
    expect(r.repos.items.byId(r.itemId)?.errorCode).toBe('SEND_FAILED');
  });

  it('is a no-op when the item row is gone', () => {
    const r = rig();
    const a = seed(r, reply(r));
    expect(() => applyFailure(r.repos, orphan(a), 'SEND_FAILED', LATER)).not.toThrow();
    expect(r.repos.items.byId(r.itemId)?.errorCode).toBeNull();
  });
});
