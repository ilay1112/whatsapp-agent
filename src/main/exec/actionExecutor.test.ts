// src/main/exec/actionExecutor.test.ts - TESTS 5.3 row `exec/*` + TESTS 8.2 items 5, 6, 12c.
// THE approval-binding suite: every gate of ARCH 6.6 / PIPELINE 9 in order, over a REAL in-memory app DB (so the write-ahead
// compare-and-set and the frozen action triggers are the production ones) and recording send / write / read doubles that count
// their calls. Nothing here reaches a network, a bridge or an LLM: exec/** may not import llm/** or agent/** at all.
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_DB, createRepos, openDb } from '../db/index';
import { LIMITS } from '../../shared/types';
import { canonicalJson } from '../../shared/schemas';
import { localToEpochMs } from '../../shared/when';
import { FLAT_LOCALES } from '../../shared/i18n/resources';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { sha256Hex } from './actionHash';
import { eventIdFor } from './buildCreateEventArgs';
import { ActionNotExecutingError, applyEdit, createActionExecutor, eventSanity } from './actionExecutor';
import type { ActionExecutor, ActionExecutorDeps, ActionExecutorHandle } from './actionExecutor';
import type { Db, Repos } from '../db/index';
import type { ActionId, ApprovalAction, BusyBlock, EpochMs, ItemDetail, ItemId } from '../../shared/types';
import type { ApproveReq, IpcContext } from '../../shared/ipc';
import type { ActionPayload, CreateEventPayload, SendReplyPayload } from '../../shared/schemas';
import type { Settings } from '../../shared/settings';
import type { BridgeSendRequest, BridgeSendResult } from '../bridge/sendClient';
import type { CreateEventArgs, CreateEventResult } from '../mcp/writeClient';
import type { McpResult } from '../mcp/readClient';

// ---------------------------------------------------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------------------------------------------------

const NOW_0 = Date.UTC(2026, 8, 21, 9, 0, 0) as EpochMs;
const JID = '972550000001@s.whatsapp.net'; // TESTS T5: synthetic JID, never a real number
const LID_JID = '15551234567890@lid';
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const START = '2026-09-24T17:00:00';
const END = '2026-09-24T18:00:00';
const FAKE_ACTION_ID = '00000000-0000-4000-8000-000000000000';

type Rig = ReturnType<typeof makeRig>;

const openDbs: Db[] = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()?.close();
});

/** One in-memory app DB, one seeded chat/item/proposal and an executor whose collaborators are recording doubles. */
function makeRig(opts: { jid?: string; sendable?: boolean; wireDetail?: boolean } = {}) {
  const db = openDb(MEMORY_DB);
  openDbs.push(db);
  const repos = createRepos(db);
  const clock = createVirtualClock(NOW_0);
  const chat = repos.chats.upsertFromBridge(opts.jid ?? JID, 'Contact', true, NOW_0);
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
  if (opts.sendable === false) db.prepare(`UPDATE chats SET sendable = 0 WHERE id = ?`).run(chat.id);

  let releaseFreeBusy: () => void = () => {};
  const state = {
    db,
    repos,
    clock,
    chatId: chat.id,
    itemId: item.id as ItemId,
    proposalId: proposal.id,
    sends: [] as BridgeSendRequest[],
    creates: [] as CreateEventArgs[],
    freeBusyCalls: 0,
    sleeps: [] as Array<{ ms: number; states: string[] }>,
    changed: [] as number[][],
    sendResult: (() => ({ ok: true })) as (req: BridgeSendRequest) => BridgeSendResult | Promise<BridgeSendResult>,
    createResult: ((args: CreateEventArgs) => ({ ok: true, value: { eventId: args.eventId, htmlLink: null } })) as (
      args: CreateEventArgs,
    ) => McpResult<CreateEventResult> | Promise<McpResult<CreateEventResult>>,
    freeBusyResult: (() => ({ ok: true, value: [] })) as () => McpResult<BusyBlock[]>,
    slowFreeBusy: false,
    releaseFreeBusy: () => releaseFreeBusy(),
    bridgeOnline: true,
    calendarConnected: true,
    settings: structuredClone(DEFAULT_SETTINGS) as Settings,
    detail: null as ((itemId: ItemId) => ItemDetail | null) | null,
    randomValue: 0.5,
    exec: null as unknown as ActionExecutorHandle,
  };

  const deps: ActionExecutorDeps = {
    repos,
    send: {
      async sendText(req) {
        state.sends.push(req);
        return state.sendResult(req);
      },
    },
    write: {
      async createEvent(args) {
        state.creates.push(args);
        return state.createResult(args);
      },
      updateEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
    },
    read: {
      getCurrentTime: () => Promise.reject(new Error('exec never reads the clock through MCP')),
      async getFreeBusy() {
        state.freeBusyCalls += 1;
        if (state.slowFreeBusy)
          await new Promise<void>((r) => {
            releaseFreeBusy = r;
          });
        return state.freeBusyResult();
      },
      findAppEvent: () => Promise.resolve({ ok: true, value: null }),
      getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
    },
    bridgeOnline: () => state.bridgeOnline,
    calendarConnected: () => state.calendarConnected,
    settings: () => state.settings,
    now: () => clock.now() as EpochMs,
    sleep: async (ms) => {
      state.sleeps.push({ ms, states: repos.actions.forItem(state.itemId).map((r) => r.state) });
      await clock.advance(ms); // the injected sleep IS the virtual clock (S-CLOCK): no real timer anywhere
    },
    random: () => state.randomValue,
    notifyChanged: (ids) => state.changed.push(ids),
    ...(opts.wireDetail === false ? {} : { detail: (id: ItemId) => state.detail?.(id) ?? null }),
  };
  state.exec = createActionExecutor(deps);
  return state;
}

const replyPayload = (rig: Rig, text = 'See you at five.'): SendReplyPayload => ({
  v: 1,
  kind: 'send_reply',
  itemId: rig.itemId,
  chatRef: rig.chatId,
  proposalVersion: 1,
  text,
});
const eventPayload = (rig: Rig, over: Partial<CreateEventPayload> = {}): CreateEventPayload => ({
  v: 1,
  kind: 'create_event',
  itemId: rig.itemId,
  chatRef: rig.chatId,
  proposalVersion: 1,
  title: 'Coffee',
  startLocal: START,
  endLocal: END,
  timeZone: 'Asia/Jerusalem',
  location: '',
  ...over,
});

function seedAction(rig: Rig, payload: ActionPayload, retryOf?: ActionId): ApprovalAction {
  return rig.repos.actions.insertPending({
    itemId: rig.itemId,
    proposalId: rig.proposalId,
    chatId: rig.chatId,
    payload,
    now: rig.clock.now() as EpochMs,
    retryOf,
  });
}

const req = (a: ApprovalAction, over: Partial<ApproveReq> = {}): ApproveReq =>
  ({ actionId: a.id, kind: a.kind, shownHash: sha256Hex(a.canonicalJson), ...over }) as ApproveReq;

/** A fresh proposal version, so a second action of the same kind gets its own idempotency key. */
function nextProposal(rig: Rig): number {
  const p = rig.repos.proposals.insertNext({
    itemId: rig.itemId,
    provider: 'user',
    model: 'test',
    extraction: null,
    draftText: null,
    replyLang: 'en',
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: rig.clock.now() as EpochMs,
  });
  rig.proposalId = p.id;
  return p.version;
}

/** Lets every already-queued microtask run, so a started-but-awaiting approve reaches its client call. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const actionsOf = (rig: Rig): ApprovalAction[] => rig.repos.actions.forItem(rig.itemId);
const auditKinds = (rig: Rig, ref: string): string[] =>
  rig.db
    .prepare<{ kind: string }>(`SELECT kind FROM audit_log WHERE ref = ? ORDER BY id`)
    .all(ref)
    .map((r) => r.kind);

// ---------------------------------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------------------------------

describe('applyEdit', () => {
  const base: SendReplyPayload = { v: 1, kind: 'send_reply', itemId: 1, chatRef: 1, proposalVersion: 1, text: 'orig' };

  it('takes the user edit for a reply and strips invisible characters', () => {
    expect(applyEdit(base, { text: 'he​llo⁦' })).toEqual({ ok: true, payload: { ...base, text: 'hello' } });
  });

  it('keeps the stored text when no edit is supplied', () => {
    expect(applyEdit(base, undefined)).toEqual({ ok: true, payload: base });
  });

  it('rejects an empty or over-long reply with BAD_REQUEST', () => {
    expect(applyEdit(base, { text: '​' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    expect(applyEdit(base, { text: 'x'.repeat(LIMITS.draftChars + 1) })).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  const ev: CreateEventPayload = {
    v: 1,
    kind: 'create_event',
    itemId: 1,
    chatRef: 1,
    proposalVersion: 1,
    title: 'Coffee',
    startLocal: START,
    endLocal: END,
    timeZone: 'Asia/Jerusalem',
    location: 'Cafe',
  };

  it('merges an event edit field by field and keeps the pinned time zone', () => {
    expect(applyEdit(ev, { title: ' Tea​ ', startLocal: START, endLocal: END, location: ' Home ' })).toEqual({
      ok: true,
      payload: { ...ev, title: 'Tea', location: 'Home' },
    });
  });

  it('keeps the stored event fields when the edit is omitted', () => {
    expect(applyEdit(ev, undefined)).toEqual({ ok: true, payload: ev });
  });

  it('rejects an event edit that fails the schema with EVENT_INVALID', () => {
    expect(applyEdit(ev, { title: '', startLocal: START, endLocal: END, location: '' })).toEqual({
      ok: false,
      code: 'EVENT_INVALID',
    });
    expect(applyEdit(ev, { title: 'x', startLocal: END, endLocal: START, location: '' })).toEqual({
      ok: false,
      code: 'EVENT_INVALID',
    });
  });

  it('ignores a reply-shaped edit sent with an event payload (kind is the discriminator)', () => {
    expect(applyEdit(ev, { text: 'nope' })).toEqual({ ok: true, payload: ev });
  });
});

describe('eventSanity', () => {
  const p = (over: Partial<CreateEventPayload> = {}): CreateEventPayload => ({
    v: 1,
    kind: 'create_event',
    itemId: 1,
    chatRef: 1,
    proposalVersion: 1,
    title: 'x',
    startLocal: START,
    endLocal: END,
    timeZone: 'UTC',
    location: '',
    ...over,
  });

  it('accepts a normal future slot', () => {
    expect(eventSanity(p(), NOW_0)).toBeNull();
  });

  it('rejects a slot shorter than the minimum', () => {
    expect(eventSanity(p({ endLocal: '2026-09-24T17:01:00' }), NOW_0)).toBe('EVENT_INVALID');
  });

  it('rejects a slot longer than the maximum', () => {
    expect(eventSanity(p({ startLocal: '2026-09-24T05:00:00', endLocal: '2026-09-24T23:00:00' }), NOW_0)).toBe(
      'EVENT_INVALID',
    );
  });

  it('rejects a slot that already ended', () => {
    expect(eventSanity(p({ startLocal: '2026-09-20T17:00:00', endLocal: '2026-09-20T18:00:00' }), NOW_0)).toBe(
      'EVENT_INVALID',
    );
  });

  it('rejects a slot beyond the horizon', () => {
    expect(eventSanity(p({ startLocal: '2028-09-24T17:00:00', endLocal: '2028-09-24T18:00:00' }), NOW_0)).toBe(
      'EVENT_INVALID',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// gate order (ARCH 6.6) - every case leaves the action pending and the clients untouched
// ---------------------------------------------------------------------------------------------------------------------

describe('approve gate: approval binding', () => {
  it('refuses a forged action id without touching a client', async () => {
    const rig = makeRig();
    const res = await rig.exec.approve(
      { actionId: FAKE_ACTION_ID, kind: 'send_reply', shownHash: 'a'.repeat(64) },
      CTX,
    );
    expect(res).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(rig.sends).toHaveLength(0);
  });

  it('refuses a kind that does not match the stored row', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.approve(req(a, { kind: 'create_event' }), CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(rig.sends).toHaveLength(0);
  });

  it('refuses a wrong shownHash (the card the user saw is not this row)', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.approve(req(a, { shownHash: 'b'.repeat(64) }), CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(rig.sends).toHaveLength(0);
    expect(actionsOf(rig)[0]!.state).toBe('pending');
  });

  it('refuses a hash that matches a DIFFERENT action of the same item', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig, 'one'));
    const other = seedAction(rig, eventPayload(rig));
    expect(await rig.exec.approve(req(a, { shownHash: sha256Hex(other.canonicalJson) }), CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
  });

  it('refuses an already expired row with ACTION_EXPIRED', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.repos.actions.expireOverdue((a.expiresAt + 1) as EpochMs);
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'ACTION_EXPIRED' } });
  });

  it('expires an overdue pending row at click time and reports ACTION_EXPIRED', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    await rig.clock.advanceTo(a.expiresAt + 1);
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'ACTION_EXPIRED' } });
    expect(actionsOf(rig)[0]!.state).toBe('expired');
    expect(rig.changed).toEqual([[rig.itemId]]);
    expect(rig.sends).toHaveLength(0);
  });

  it('refuses a superseded row', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.repos.actions.supersedePending(rig.itemId, rig.clock.now() as EpochMs);
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(rig.sends).toHaveLength(0);
  });

  it('refuses a stored payload that no longer parses as its kind (a corrupted row)', async () => {
    // The frozen `trg_actions_frozen` trigger makes this unreachable through the repos, so the row is injected through a
    // one-method repos double: the branch still has to hold, because a corrupt row must never reach a client.
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const corrupt = canonicalJson({
      v: 1,
      kind: 'send_reply',
      itemId: rig.itemId,
      chatRef: rig.chatId,
      proposalVersion: 1,
      text: 'x',
      extra: 1,
    });
    const sends: BridgeSendRequest[] = [];
    const exec = createActionExecutor({
      repos: {
        ...rig.repos,
        actions: { ...rig.repos.actions, byId: () => ({ ...a, canonicalJson: corrupt }) },
      } as Repos,
      send: {
        sendText: async (r) => {
          sends.push(r);
          return { ok: true };
        },
      },
      write: {
        createEvent: () => Promise.reject(new Error('unused')),
        updateEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }),
      },
      read: {
        getCurrentTime: () => Promise.reject(new Error('unused')),
        getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
        findAppEvent: () => Promise.resolve({ ok: true, value: null }),
        getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
      },
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => rig.settings,
      now: () => rig.clock.now() as EpochMs,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      notifyChanged: () => {},
    });
    expect(await exec.approve({ actionId: a.id, kind: 'send_reply', shownHash: sha256Hex(corrupt) }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(sends).toHaveLength(0);
  });

  it('applies the focus-steal guard right after a notification click', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const ctx: IpcContext = {
      ...CTX,
      shownByNotificationAt: (rig.clock.now() - LIMITS.focusGuardMainMs + 1) as EpochMs,
    };
    expect(await rig.exec.approve(req(a), ctx)).toEqual({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } });
    expect(rig.sends).toHaveLength(0);
  });

  it('lets an approve through once the focus guard window has passed', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const ctx: IpcContext = { ...CTX, shownByNotificationAt: (rig.clock.now() - LIMITS.focusGuardMainMs) as EpochMs };
    expect((await rig.exec.approve(req(a), ctx)).ok).toBe(true);
    expect(rig.sends).toHaveLength(1);
  });

  it('refuses a direct execute() of a pending action before any client call', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    await expect(rig.exec.execute(a.id)).rejects.toBeInstanceOf(ActionNotExecutingError);
    expect(rig.sends).toHaveLength(0);
    expect(rig.creates).toHaveLength(0);
  });

  it('refuses a direct execute() of an unknown action', async () => {
    const rig = makeRig();
    await expect(rig.exec.execute(FAKE_ACTION_ID)).rejects.toBeInstanceOf(ActionNotExecutingError);
  });

  it('refuses a direct execute() of an executing row with no approved payload', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.repos.actions.markApprovedExecuting(a.id, '', rig.clock.now() as EpochMs, 'user');
    await expect(rig.exec.execute(a.id)).rejects.toBeInstanceOf(ActionNotExecutingError);
    expect(rig.sends).toHaveLength(0);
  });

  it('executes an already-executing row through execute()', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, rig.clock.now() as EpochMs, 'user');
    expect((await rig.exec.execute(a.id)).outcome).toBe('done');
    expect(rig.sends).toEqual([{ recipient: JID, message: 'See you at five.' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// preconditions
// ---------------------------------------------------------------------------------------------------------------------

describe('approve gate: preconditions', () => {
  it('refuses a reply to a non-sendable chat', async () => {
    const rig = makeRig({ sendable: false });
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'SEND_NOT_SENDABLE' } });
    expect(rig.sends).toHaveLength(0);
  });

  it('[repair] refuses a reply whose item was already answered from the phone', async () => {
    // Defence in depth for the duplicate-reply defect: ingest supersedes the draft, and the executor refuses a racing approve.
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.repos.items.update(rig.itemId, { replyState: 'answered_elsewhere' }, NOW_0);
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(rig.sends).toHaveLength(0);
    expect(actionsOf(rig)[0]!.state).toBe('pending'); // untouched: no write-ahead, no clone
  });

  it('refuses a reply while the bridge is offline (approvals never queue)', async () => {
    const rig = makeRig();
    rig.bridgeOnline = false;
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'SEND_NOT_CONNECTED' } });
    expect(actionsOf(rig)[0]!.state).toBe('pending');
  });

  it('maps a builder rejection (an @lid chat) to SEND_NOT_SENDABLE before the write-ahead', async () => {
    const rig = makeRig({ jid: LID_JID });
    rig.db.prepare(`UPDATE chats SET sendable = 1 WHERE id = ?`).run(rig.chatId);
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'SEND_NOT_SENDABLE' } });
    expect(rig.sends).toHaveLength(0);
    expect(actionsOf(rig)[0]!.state).toBe('pending');
  });

  it('refuses an event while the calendar is not connected', async () => {
    const rig = makeRig();
    rig.calendarConnected = false;
    const a = seedAction(rig, eventPayload(rig));
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    expect(rig.freeBusyCalls).toBe(0);
  });

  it('re-runs the event sanity checks at click time', async () => {
    const rig = makeRig();
    const a = seedAction(
      rig,
      eventPayload(rig, { startLocal: '2026-09-19T17:00:00', endLocal: '2026-09-19T18:00:00' }),
    );
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'EVENT_INVALID' } });
    expect(rig.creates).toHaveLength(0);
    expect(rig.freeBusyCalls).toBe(0);
  });

  it('returns needs_confirm_conflict and leaves the action pending when the fresh free/busy overlaps', async () => {
    const rig = makeRig();
    const busy: BusyBlock[] = [{ startLocal: '2026-09-24T17:30:00', endLocal: '2026-09-24T19:00:00' }];
    rig.freeBusyResult = () => ({ ok: true, value: busy });
    const a = seedAction(rig, eventPayload(rig));
    const res = await rig.exec.approve(req(a), CTX);
    expect(res.ok && res.value.outcome === 'needs_confirm_conflict' && res.value.busy).toEqual(busy);
    expect(actionsOf(rig)[0]!.state).toBe('pending');
    expect(rig.creates).toHaveLength(0);
  });

  it('executes on the second click with confirmConflict', async () => {
    const rig = makeRig();
    rig.freeBusyResult = () => ({
      ok: true,
      value: [{ startLocal: '2026-09-24T17:30:00', endLocal: '2026-09-24T19:00:00' }],
    });
    const a = seedAction(rig, eventPayload(rig));
    await rig.exec.approve(req(a), CTX);
    const res = await rig.exec.approve(req(a, { confirmConflict: true }), CTX);
    expect(res.ok && res.value.outcome).toBe('done');
    expect(rig.creates).toHaveLength(1);
  });

  it('ignores a busy block that does not overlap the slot', async () => {
    const rig = makeRig();
    rig.freeBusyResult = () => ({
      ok: true,
      value: [{ startLocal: '2026-09-24T18:00:00', endLocal: '2026-09-24T19:00:00' }],
    });
    const a = seedAction(rig, eventPayload(rig));
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    expect(rig.creates).toHaveLength(1);
  });

  it('treats a failed free/busy read as "no conflict", never as a block', async () => {
    const rig = makeRig();
    rig.freeBusyResult = () => ({ ok: false, error: 'unavailable' });
    const a = seedAction(rig, eventPayload(rig));
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    expect(rig.creates).toHaveLength(1);
  });

  it('treats a THROWING free/busy read as "no conflict" as well', async () => {
    const rig = makeRig();
    rig.freeBusyResult = () => {
      throw new Error('transport');
    };
    const a = seedAction(rig, eventPayload(rig));
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
  });

  it('refuses an approve whose edit fails validation', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.approve(req(a, { edit: { text: '​​' } }), CTX)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(rig.sends).toHaveLength(0);
  });

  it('sends the EDITED text byte for byte and records it as approved_final_json', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig, ''));
    await rig.exec.approve(req(a, { edit: { text: 'I will be there at 5.' } }), CTX);
    expect(rig.sends).toEqual([{ recipient: JID, message: 'I will be there at 5.' }]);
    expect(JSON.parse(rig.repos.actions.byId(a.id)?.approvedFinalJson ?? '{}')).toMatchObject({
      text: 'I will be there at 5.',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// write-ahead ordering
// ---------------------------------------------------------------------------------------------------------------------

describe('write-ahead', () => {
  it('commits pending -> approved -> executing BEFORE the side effect and audits action_approved', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    let stateAtSend: string | null = null;
    rig.sendResult = () => {
      stateAtSend = rig.repos.actions.byId(a.id)?.state ?? null;
      return { ok: true };
    };
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    expect(stateAtSend).toBe('executing');
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'action_done']);
  });

  it('sleeps the send jitter only AFTER the write-ahead, inside the 3-8 s band', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    await rig.exec.approve(req(a), CTX);
    expect(rig.sleeps).toHaveLength(1);
    expect(rig.sleeps[0]!.states).toEqual(['executing']);
    expect(rig.sleeps[0]!.ms).toBeGreaterThanOrEqual(LIMITS.sendJitterMinMs);
    expect(rig.sleeps[0]!.ms).toBeLessThanOrEqual(LIMITS.sendJitterMaxMs);
  });

  it('never sleeps the send jitter for a create_event', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    await rig.exec.approve(req(a), CTX);
    expect(rig.sleeps).toHaveLength(0);
  });

  it('a compare-and-set miss is a gate failure: ACTION_STALE, no failed row, no clone, no audit', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, rig.clock.now() as EpochMs, 'user');
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(actionsOf(rig)).toHaveLength(1);
    expect(auditKinds(rig, a.id)).toEqual([]);
    expect(rig.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TESTS 8.2 item 5: double click => exactly ONE side effect, for BOTH kinds
// ---------------------------------------------------------------------------------------------------------------------

/** A SECOND executor over the same database (its own `inFlight` set), so a race reaches the DB compare-and-set itself. */
function secondExecutor(base: Rig): { exec: ActionExecutor; creates: CreateEventArgs[]; release: () => void } {
  const creates: CreateEventArgs[] = [];
  let release: () => void = () => {};
  const exec = createActionExecutor({
    repos: base.repos,
    send: { sendText: () => Promise.resolve({ ok: true }) },
    write: {
      createEvent: async (args) => {
        creates.push(args);
        return { ok: true, value: { eventId: args.eventId, htmlLink: null } };
      },
      updateEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
    },
    read: {
      getCurrentTime: () => Promise.reject(new Error('unused')),
      getFreeBusy: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { ok: true, value: [] };
      },
      findAppEvent: () => Promise.resolve({ ok: true, value: null }),
      getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
    },
    bridgeOnline: () => true,
    calendarConnected: () => true,
    settings: () => base.settings,
    now: () => base.clock.now() as EpochMs,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    notifyChanged: () => {},
  });
  return { exec, creates, release: () => release() };
}

describe('double click', () => {
  it('send_reply: two concurrent approves produce exactly one send; the loser gets ACTION_STALE and no clone', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    rig.sendResult = async () => {
      await held;
      return { ok: true };
    };
    const first = rig.exec.approve(req(a), CTX);
    await tick();
    const second = await rig.exec.approve(req(a), CTX); // arrives while the first is awaiting the bridge
    release();
    const winner = await first;

    expect(second).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(winner.ok && winner.value.outcome).toBe('done');
    expect(rig.sends).toHaveLength(1);
    expect(actionsOf(rig)).toHaveLength(1); // no retry clone
  });

  it('create_event: two executors racing with a SLOW free/busy produce exactly one event', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    const other = secondExecutor(rig);
    rig.slowFreeBusy = true;

    const first = rig.exec.approve(req(a), CTX);
    await tick();
    const second = other.exec.approve(req(a), CTX);
    await tick();
    rig.releaseFreeBusy();
    other.release();
    const results = await Promise.all([first, second]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'ACTION_STALE')).toHaveLength(1);
    expect(rig.creates.length + other.creates.length).toBe(1);
    expect(actionsOf(rig)).toHaveLength(1); // the loser created no clone
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'action_done']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// rate limits at the gate (the windows themselves live in rateLimiter.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

describe('rate limits at the gate', () => {
  it('refuses a second send to the same chat inside the minimum gap, before the write-ahead', async () => {
    const rig = makeRig();
    rig.randomValue = 0; // shortest jitter: the virtual clock stays inside the 5 s per-chat gap
    await rig.exec.approve(req(seedAction(rig, replyPayload(rig, 'one'))), CTX);
    const version = nextProposal(rig);
    const second = seedAction(rig, { ...replyPayload(rig, 'two'), proposalVersion: version });
    expect(await rig.exec.approve(req(second), CTX)).toEqual({ ok: false, error: { code: 'RATE_LIMIT_SEND' } });
    expect(rig.sends).toHaveLength(1);
    expect(rig.repos.actions.byId(second.id)?.state).toBe('pending');
  });

  it('refuses a create over the hourly cap', async () => {
    const rig = makeRig();
    for (let i = 0; i < LIMITS.createPerHour; i++)
      rig.repos.rate.record('create_global', 'global', rig.clock.now() as EpochMs);
    const a = seedAction(rig, eventPayload(rig));
    expect(await rig.exec.approve(req(a), CTX)).toEqual({ ok: false, error: { code: 'RATE_LIMIT_CREATE' } });
    expect(rig.creates).toHaveLength(0);
  });

  it('records the persisted send counters only after a successful write-ahead', async () => {
    const rig = makeRig();
    await rig.exec.approve(req(seedAction(rig, replyPayload(rig))), CTX);
    expect(rig.repos.rate.countSince('send_chat', String(rig.chatId), 0 as EpochMs)).toBe(1);
    expect(rig.repos.rate.countSince('send_global', 'global', 0 as EpochMs)).toBe(1);
  });

  it('records the persisted create counter', async () => {
    const rig = makeRig();
    await rig.exec.approve(req(seedAction(rig, eventPayload(rig))), CTX);
    expect(rig.repos.rate.countSince('create_global', 'global', 0 as EpochMs)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------------------------------------------------

describe('send outcomes', () => {
  it('done: marks the action done, the reply sent and closes the item as replied', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    expect(rig.repos.actions.byId(a.id)?.state).toBe('done');
    const item = rig.repos.items.byId(rig.itemId)!;
    expect(item.replyState).toBe('sent');
    expect(item.closedReason).toBe('replied');
    expect(rig.changed).toEqual([[rig.itemId]]);
  });

  it('done: keeps the item open while an event proposal is still waiting for a click', async () => {
    const rig = makeRig();
    rig.repos.items.update(rig.itemId, { eventState: 'proposed' }, rig.clock.now() as EpochMs);
    await rig.exec.approve(req(seedAction(rig, replyPayload(rig))), CTX);
    const item = rig.repos.items.byId(rig.itemId)!;
    expect(item.replyState).toBe('sent');
    expect(item.closedReason).toBeNull();
  });

  it('timeout: unknown_outcome, never failed, and a fresh pending clone is offered', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.sendResult = () => ({ ok: false, reason: 'timeout', httpStatus: null });
    const res = await rig.exec.approve(req(a), CTX);
    expect(res.ok && res.value.outcome).toBe('failed');
    expect(rig.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
    expect(rig.repos.items.byId(rig.itemId)?.errorCode).toBe('ACTION_UNKNOWN_OUTCOME');
    const clone = actionsOf(rig).find((r) => r.retryOf === a.id)!;
    expect(clone.state).toBe('pending');
    expect(clone.attempt).toBe(2);
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'action_unknown_outcome']);
  });

  it('not_connected: failed with SEND_NOT_CONNECTED and a clone', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.sendResult = () => ({ ok: false, reason: 'not_connected', httpStatus: 500 });
    const res = await rig.exec.approve(req(a), CTX);
    expect(res.ok && res.value.outcome).toBe('failed');
    expect(rig.repos.actions.byId(a.id)?.errorCode).toBe('SEND_NOT_CONNECTED');
    expect(rig.repos.items.byId(rig.itemId)?.errorCode).toBe('SEND_NOT_CONNECTED');
    expect(actionsOf(rig).some((r) => r.retryOf === a.id)).toBe(true);
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'action_failed']);
  });

  it('a throwing send client is an unreachable bridge, mapped to SEND_FAILED', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    rig.sendResult = () => {
      throw new Error('socket');
    };
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    expect(rig.repos.actions.byId(a.id)?.errorCode).toBe('SEND_FAILED');
  });

  it.each([['rejected'], ['bad_request'], ['auth'], ['unreachable']] as const)(
    'maps bridge reason %s to SEND_FAILED',
    async (reason) => {
      const rig = makeRig();
      const a = seedAction(rig, replyPayload(rig));
      rig.sendResult = () => ({ ok: false, reason, httpStatus: 400 });
      await rig.exec.approve(req(a), CTX);
      expect(rig.repos.actions.byId(a.id)?.errorCode).toBe('SEND_FAILED');
    },
  );
});

describe('create outcomes', () => {
  it('done: whitelisted args, the deterministic eventId and an item moved to in_calendar', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    const args = rig.creates[0]!;
    expect(rig.creates).toHaveLength(1);
    expect(args.eventId).toBe(eventIdFor(`${rig.itemId}:create_event:1`, eventPayload(rig)));
    expect(args.sendUpdates).toBe('none');
    expect(args.allowDuplicates).toBe(false);
    expect(args.description).toBe(FLAT_LOCALES.en['calendar.eventDescription']);
    expect(args.extendedProperties.private.waAction).toBe(a.id);
    const item = rig.repos.items.byId(rig.itemId)!;
    expect(item.eventState).toBe('created');
    expect(item.calendarEventId).toBe(args.eventId);
  });

  it('uses the Hebrew description template when the UI language is Hebrew and never a contact name', async () => {
    const rig = makeRig();
    rig.settings = { ...rig.settings, general: { ...rig.settings.general, language: 'he' } };
    await rig.exec.approve(req(seedAction(rig, eventPayload(rig))), CTX);
    expect(rig.creates[0]!.description).toBe(FLAT_LOCALES.he['calendar.eventDescription']);
    expect(rig.creates[0]!.description).not.toContain('Contact');
  });

  it('passes allowDuplicates only after an explicit confirmDuplicate click', async () => {
    const rig = makeRig();
    await rig.exec.approve(req(seedAction(rig, eventPayload(rig)), { confirmDuplicate: true }), CTX);
    expect(rig.creates[0]!.allowDuplicates).toBe(true);
  });

  it('id_exists on OUR deterministic id is a success, not a duplicate', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    rig.createResult = () => ({ ok: false, error: 'id_exists' });
    const res = await rig.exec.approve(req(a), CTX);
    expect(res.ok && res.value.outcome).toBe('done');
    expect(rig.repos.items.byId(rig.itemId)?.calendarEventId).toBe(
      eventIdFor(`${rig.itemId}:create_event:1`, eventPayload(rig)),
    );
  });

  it('timeout is an unknown outcome', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    rig.createResult = () => ({ ok: false, error: 'timeout' });
    await rig.exec.approve(req(a), CTX);
    expect(rig.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
  });

  it.each([
    ['unavailable', 'CAL_UNAVAILABLE'],
    ['auth', 'CAL_RECONNECT'],
    ['port_busy', 'CAL_PORT_BUSY'],
    ['duplicate', 'CAL_DUPLICATE'],
    ['bad_response', 'CAL_CREATE_FAILED'],
    ['invalid_args', 'CAL_CREATE_FAILED'],
  ] as const)('maps MCP error %s to %s', async (error, code) => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    rig.createResult = () => ({ ok: false, error });
    await rig.exec.approve(req(a), CTX);
    expect(rig.repos.actions.byId(a.id)?.errorCode).toBe(code);
  });

  it('a throwing write client is an unavailable calendar', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    rig.createResult = () => {
      throw new Error('transport');
    };
    await rig.exec.approve(req(a), CTX);
    expect(rig.repos.actions.byId(a.id)?.errorCode).toBe('CAL_UNAVAILABLE');
  });

  it('[R2] unknown outcome + failed reconcile + "Add again" re-sends the SAME eventId, so exactly one event can exist', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    rig.createResult = () => ({ ok: false, error: 'timeout' });
    await rig.exec.approve(req(a), CTX);
    expect(rig.repos.actions.byId(a.id)?.state).toBe('unknown_outcome'); // reconcile found nothing (findAppEvent -> null)

    const clone = actionsOf(rig).find((r) => r.retryOf === a.id)!;
    const seen: string[] = [];
    rig.createResult = (args) => {
      seen.push(args.eventId); // "Add again": the calendar already holds the event from the unconfirmed first attempt -> 409
      return { ok: false, error: 'id_exists' };
    };
    const res = await rig.exec.approve(req(clone), CTX);

    expect(res.ok && res.value.outcome).toBe('done');
    const expected = eventIdFor(`${rig.itemId}:create_event:1`, eventPayload(rig));
    expect(rig.creates.map((c) => c.eventId)).toEqual([expected, expected]);
    expect(new Set(seen)).toEqual(new Set([expected]));
    expect(rig.creates.map((c) => c.extendedProperties.private.waAction)).toEqual([a.id, a.id]);
    expect(rig.repos.items.byId(rig.itemId)?.eventState).toBe('created');
  });

  it('an EDITED retry clone gets its OWN eventId, so the slot the user approved the second time really reaches the calendar', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));
    // Fake calendar keyed by the client-supplied id: a repeat id is Google's 409 (McpErrorKind 'id_exists').
    const calendar = new Map<string, { start: string; end: string }>();
    let firstAnswer = true;
    rig.createResult = (args) => {
      if (calendar.has(args.eventId)) return { ok: false, error: 'id_exists' };
      calendar.set(args.eventId, { start: args.start, end: args.end }); // Google DID create it...
      if (firstAnswer) {
        firstAnswer = false;
        return { ok: false, error: 'timeout' }; // ...but our side never saw the answer
      }
      return { ok: true, value: { eventId: args.eventId, htmlLink: null } };
    };
    await rig.exec.approve(req(a), CTX);
    expect(rig.repos.actions.byId(a.id)?.state).toBe('unknown_outcome'); // reconcile found nothing

    // The user moves the slot on the retry card and clicks "Add to calendar" again: that is a NEW approval.
    const clone = actionsOf(rig).find((r) => r.retryOf === a.id)!;
    const newStart = '2026-09-24T19:00:00';
    const newEnd = '2026-09-24T20:00:00';
    const res = await rig.exec.approve(
      req(clone, { edit: { title: 'Coffee', startLocal: newStart, endLocal: newEnd, location: '' } }),
      CTX,
    );

    expect(res.ok && res.value.outcome).toBe('done');
    const sent = rig.creates[1]!;
    expect(sent.start).toBe(newStart);
    // The edited content may NOT reuse the id of the already-created 17:00 event: a 409 there would report "added"
    // while the calendar still held the old slot (approval-first: a `done` create means the approved slot exists).
    expect(sent.eventId).not.toBe(rig.creates[0]!.eventId);
    expect(calendar.get(sent.eventId)).toEqual({ start: newStart, end: newEnd });
    const item = rig.repos.items.byId(rig.itemId)!;
    expect(item.calendarEventId).toBe(sent.eventId);
    expect(item.eventStartTs).toBe(localToEpochMs(newStart, 'Asia/Jerusalem'));
    // The chain identity itself is unchanged: waAction still names the chain root.
    expect(rig.creates.map((c) => c.extendedProperties.private.waAction)).toEqual([a.id, a.id]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// reject / recover / drain / detail
// ---------------------------------------------------------------------------------------------------------------------

describe('reject', () => {
  it('rejects a pending action and audits it', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    expect(await rig.exec.reject(a.id)).toEqual({ ok: true, value: null });
    expect(rig.repos.actions.byId(a.id)?.state).toBe('rejected');
    expect(auditKinds(rig, a.id)).toEqual(['action_rejected']);
    expect(rig.changed).toEqual([[rig.itemId]]);
  });

  it('refuses an unknown or non-pending action', async () => {
    const rig = makeRig();
    expect(await rig.exec.reject(FAKE_ACTION_ID)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    const a = seedAction(rig, replyPayload(rig));
    await rig.exec.reject(a.id);
    expect(await rig.exec.reject(a.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
  });
});

describe('recoverOnStartup', () => {
  it('turns every executing row into unknown_outcome WITHOUT re-executing it, and expires overdue rows', async () => {
    const rig = makeRig();
    const executing = seedAction(rig, replyPayload(rig));
    rig.repos.actions.markApprovedExecuting(executing.id, executing.canonicalJson, rig.clock.now() as EpochMs, 'user');
    const overdue = seedAction(rig, eventPayload(rig));
    await rig.clock.advanceTo(overdue.expiresAt + 1);

    await rig.exec.recoverOnStartup();

    expect(rig.repos.actions.byId(executing.id)?.state).toBe('unknown_outcome');
    expect(rig.repos.actions.byId(overdue.id)?.state).toBe('expired');
    expect(rig.sends).toHaveLength(0);
    expect(rig.creates).toHaveLength(0);
    expect(rig.changed).toEqual([[rig.itemId]]);
    expect(auditKinds(rig, executing.id)).toEqual(['action_unknown_outcome']);
  });

  it('notifies nothing when there was nothing to recover', async () => {
    const rig = makeRig();
    await rig.exec.recoverOnStartup();
    expect(rig.changed).toEqual([]);
  });

  it('runs the read-only calendar reconcile for a recovered create_event, in the settings time zone', async () => {
    const rig = makeRig();
    rig.settings = { ...rig.settings, general: { ...rig.settings.general, timeZone: 'Europe/Berlin' } };
    const a = seedAction(rig, eventPayload(rig));
    rig.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, rig.clock.now() as EpochMs, 'user');

    await rig.exec.recoverOnStartup();

    expect(rig.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
    expect(rig.creates).toHaveLength(0); // read-only: never re-executed
  });
});

describe('defensive paths', () => {
  it('audits db_recovery and rethrows when a final-state transition loses its compare-and-set', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const repos = {
      ...rig.repos,
      actions: {
        ...rig.repos.actions,
        markDone: () => {
          throw new Error('state moved under us');
        },
      },
    } as Repos;
    const exec = createActionExecutor({
      repos,
      send: { sendText: () => Promise.resolve({ ok: true }) },
      write: {
        createEvent: () => Promise.reject(new Error('unused')),
        updateEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }),
      },
      read: {
        getCurrentTime: () => Promise.reject(new Error('unused')),
        getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
        findAppEvent: () => Promise.resolve({ ok: true, value: null }),
        getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
      },
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => rig.settings,
      now: () => rig.clock.now() as EpochMs,
      sleep: () => Promise.resolve(),
      random: () => 0,
      notifyChanged: () => {},
    });

    await expect(exec.approve(req(a), CTX)).rejects.toThrow('state moved under us');
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'db_recovery']);
  });

  it('builds a safe fallback detail when the item row vanished under the executor', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const repos = { ...rig.repos, items: { ...rig.repos.items, byId: () => null } } as Repos;
    const exec = createActionExecutor({
      repos,
      send: { sendText: () => Promise.resolve({ ok: true }) },
      write: {
        createEvent: () => Promise.reject(new Error('unused')),
        updateEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }),
      },
      read: {
        getCurrentTime: () => Promise.reject(new Error('unused')),
        getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
        findAppEvent: () => Promise.resolve({ ok: true, value: null }),
        getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
      },
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => rig.settings,
      now: () => rig.clock.now() as EpochMs,
      sleep: () => Promise.resolve(),
      random: () => 0,
      notifyChanged: () => {},
    });

    const res = await exec.approve(req(a), CTX);
    expect(res.ok).toBe(true);
    const item = res.ok ? res.value.item : null;
    expect(item).toMatchObject({
      itemId: rig.itemId,
      analysis: 'failed',
      status: 'ignored',
      replyState: 'none',
      eventState: 'none',
      missing: [],
      badges: [],
      actions: [],
      messages: [],
      calendar: null,
      holdReason: null,
      errorCode: null,
      closedReason: null,
      draft: null,
      event: null,
      editingLocked: false,
      updatedAt: 0,
    });
    expect(item?.trigger).toEqual({ ts: 0, text: null });
    expect(JSON.stringify(item)).not.toContain(JID);
  });
});

describe('drain', () => {
  it('returns at once when nothing is in flight', async () => {
    const rig = makeRig();
    await rig.exec.drain(1_000);
    expect(rig.sleeps).toHaveLength(0);
  });

  it('polls through the injected sleep while an approve is in flight and gives up at the deadline', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    let release: () => void = () => {};
    rig.sendResult = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { ok: true };
    };
    const inflight = rig.exec.approve(req(a), CTX);
    await tick();
    await rig.exec.drain(100); // each poll advances the virtual clock by 25 ms -> 4 polls, then the deadline
    expect(rig.sleeps.filter((s) => s.ms === 25)).toHaveLength(4);
    release();
    await inflight;
    expect(rig.sends).toHaveLength(1);
  });
});

describe('ItemDetail wiring', () => {
  it('uses the injected detail builder when compose wired one', async () => {
    const rig = makeRig();
    const marker = { itemId: rig.itemId, marker: true } as unknown as ItemDetail;
    rig.detail = () => marker;
    const res = await rig.exec.approve(req(seedAction(rig, replyPayload(rig))), CTX);
    expect(res.ok && res.value.item).toBe(marker);
  });

  it('falls back to a row-only detail that carries no JID and no message text', async () => {
    const rig = makeRig({ wireDetail: false });
    const res = await rig.exec.approve(req(seedAction(rig, replyPayload(rig))), CTX);
    expect(res.ok).toBe(true);
    const item = res.ok ? res.value.item : null;
    expect(item?.itemId).toBe(rig.itemId);
    expect(JSON.stringify(item)).not.toContain(JID);
    expect(JSON.stringify(item)).not.toContain('See you at five.');
    expect(item?.messages).toEqual([]);
    expect(item?.draft).toBeNull();
    expect(item?.calendar).toBeNull();
  });

  it('reports the calendar coordinates in the fallback detail once the event exists', async () => {
    const rig = makeRig({ wireDetail: false });
    const res = await rig.exec.approve(req(seedAction(rig, eventPayload(rig))), CTX);
    expect(res.ok && res.value.item.calendar).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// offerRetryForUnknown - W2-01 integration addition (see the type doc in actionExecutor.ts)
// ---------------------------------------------------------------------------------------------------------------------
describe('offerRetryForUnknown', () => {
  /** Puts one action into `unknown_outcome` exactly the way a crash + recoverOnStartup would. */
  async function recovered(rig: Rig, payload: ActionPayload): Promise<ApprovalAction> {
    const a = seedAction(rig, payload);
    rig.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, rig.clock.now() as EpochMs, 'user');
    await rig.exec.recoverOnStartup();
    expect(rig.repos.actions.byId(a.id)?.state).toBe('unknown_outcome');
    return a;
  }

  it('clones a still-unknown action into a fresh PENDING attempt that shares the chain root', async () => {
    const rig = makeRig();
    const a = await recovered(rig, eventPayload(rig));
    rig.changed.length = 0;

    expect(rig.exec.offerRetryForUnknown()).toBe(1);

    const clone = actionsOf(rig).find((x) => x.retryOf === a.id);
    expect(clone).toBeDefined();
    expect(clone!.state).toBe('pending');
    expect(clone!.attempt).toBe(a.attempt + 1);
    expect(rig.repos.actions.chainRoot(clone!.id).id).toBe(a.id);
    expect(rig.changed).toEqual([[rig.itemId]]);
    // A clone is an OFFER, never a replay: nothing was sent or created by making it.
    expect(rig.sends).toHaveLength(0);
    expect(rig.creates).toHaveLength(0);
  });

  it('is idempotent: a second call does not stack another clone on the same action', async () => {
    const rig = makeRig();
    await recovered(rig, replyPayload(rig));
    expect(rig.exec.offerRetryForUnknown()).toBe(1);
    expect(rig.exec.offerRetryForUnknown()).toBe(0);
    expect(actionsOf(rig).filter((x) => x.state === 'pending')).toHaveLength(1);
  });

  it('skips an action whose approved payload retention has already nulled, and notifies nothing then', async () => {
    const rig = makeRig();
    const a = await recovered(rig, replyPayload(rig));
    // Exactly what db/retention.ts does to a terminal row: the approved payload is gone, so there is nothing to re-offer.
    rig.repos.db.prepare('UPDATE actions SET approved_final_json = NULL WHERE id = ?').run(a.id);
    rig.changed.length = 0;

    expect(rig.exec.offerRetryForUnknown()).toBe(0);
    expect(actionsOf(rig).some((x) => x.retryOf === a.id)).toBe(false);
    expect(rig.changed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// torn success (data-integrity-6): markDone + the item consequence + the `action_done` audit are ONE transaction
// ---------------------------------------------------------------------------------------------------------------------

describe('success atomicity', () => {
  /** An executor over a doctored `Repos`, with every collaborator succeeding: only the DB write under test can fail. */
  const execOver = (rig: Rig, repos: Repos): ActionExecutorHandle =>
    createActionExecutor({
      repos,
      send: { sendText: () => Promise.resolve({ ok: true }) },
      write: {
        createEvent: (args) => Promise.resolve({ ok: true, value: { eventId: args.eventId, htmlLink: null } }),
        updateEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }),
      },
      read: {
        getCurrentTime: () => Promise.reject(new Error('unused')),
        getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
        findAppEvent: () => Promise.resolve({ ok: true, value: null }),
        getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }), // [V2] C2 11 (unused by v1)
      },
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => rig.settings,
      now: () => rig.clock.now() as EpochMs,
      sleep: () => Promise.resolve(),
      random: () => 0,
      notifyChanged: () => {},
    });

  /** `items.update` is the one statement of the success path that lives outside `actions`; everything else is real. */
  const reposWithBrokenItemUpdate = (rig: Rig): Repos =>
    ({
      ...rig.repos,
      items: {
        ...rig.repos.items,
        update: () => {
          throw new Error('items.update exploded');
        },
      },
    }) as Repos;

  it('send_reply: a failed item consequence rolls markDone back, so recovery can still see the action', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const before = rig.repos.items.byId(rig.itemId)!.replyState;

    await expect(execOver(rig, reposWithBrokenItemUpdate(rig)).approve(req(a), CTX)).rejects.toThrow(
      'items.update exploded',
    );

    // A 'done' action whose item never learned about it is invisible to BOTH recovery passes (they scan
    // 'executing' / 'unknown_outcome'), and the next triage would draft - and offer to send - the same reply again.
    expect(rig.repos.actions.byId(a.id)?.state).toBe('executing');
    expect(rig.repos.actions.executing().map((x) => x.id)).toEqual([a.id]);
    expect(rig.repos.items.byId(rig.itemId)?.replyState).toBe(before);
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'db_recovery']);
  });

  it('create_event: a failed item consequence rolls markDone back the same way', async () => {
    const rig = makeRig();
    const a = seedAction(rig, eventPayload(rig));

    await expect(execOver(rig, reposWithBrokenItemUpdate(rig)).approve(req(a), CTX)).rejects.toThrow(
      'items.update exploded',
    );

    expect(rig.repos.actions.byId(a.id)?.state).toBe('executing');
    expect(rig.repos.items.byId(rig.itemId)?.eventState).not.toBe('created');
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'db_recovery']);
  });

  it('a failing action_done audit append rolls the whole success back too', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    const repos = {
      ...rig.repos,
      audit: {
        ...rig.repos.audit,
        append: (kind: string, ref: string, data: unknown, now: EpochMs) => {
          if (kind === 'action_done') throw new Error('audit append exploded');
          return rig.repos.audit.append(kind as never, ref, data as never, now);
        },
      },
    } as unknown as Repos;

    await expect(execOver(rig, repos).approve(req(a), CTX)).rejects.toThrow('audit append exploded');

    expect(rig.repos.actions.byId(a.id)?.state).toBe('executing');
    expect(rig.repos.items.byId(rig.itemId)?.replyState).not.toBe('sent');
  });

  it('the happy path still commits all three writes', async () => {
    const rig = makeRig();
    const a = seedAction(rig, replyPayload(rig));
    expect((await rig.exec.approve(req(a), CTX)).ok).toBe(true);
    expect(rig.repos.actions.byId(a.id)?.state).toBe('done');
    expect(rig.repos.items.byId(rig.itemId)?.replyState).toBe('sent');
    expect(auditKinds(rig, a.id)).toEqual(['action_approved', 'action_done']);
  });
});
