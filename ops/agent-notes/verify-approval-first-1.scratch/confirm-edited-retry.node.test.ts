// SCRATCH ONLY - independent verification of review finding approval-first-1 (skeptic pass).
// Goal: try to REFUTE the claim that an EDITED create_event retry clone re-sends the chain's deterministic eventId,
// gets 409 id_exists, and is reported as `done` with the NEW time stamped on the item while the calendar keeps the OLD slot.
// Fake calendar = a Map keyed by the client-supplied eventId; a repeat id is 409 ('id_exists'), exactly McpErrorKind semantics.
import { describe, expect, it } from 'vitest';
import { MEMORY_DB, createRepos, openDb } from '../../../src/main/db/index';
import { DEFAULT_SETTINGS } from '../../../src/shared/settings';
import { sha256Hex } from '../../../src/main/exec/actionHash';
import { createActionExecutor } from '../../../src/main/exec/actionExecutor';
import type { ActionExecutorDeps } from '../../../src/main/exec/actionExecutor';
import type { CreateEventArgs } from '../../../src/main/mcp/writeClient';
import type { EpochMs, ItemId } from '../../../src/shared/types';
import type { IpcContext } from '../../../src/shared/ipc';
import type { Settings } from '../../../src/shared/settings';

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0) as EpochMs;
const JID = '972550000001@s.whatsapp.net'; // synthetic
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function rig() {
  const db = openDb(MEMORY_DB);
  const repos = createRepos(db);
  const chat = repos.chats.upsertFromBridge(JID, 'Contact', true, NOW);
  const item = repos.items.createOpen({
    chatId: chat.id,
    triggerMsgId: 'm1',
    triggerTs: NOW,
    analysis: 'done',
    holdReason: null,
    now: NOW,
  });
  const proposal = repos.proposals.insertNext({
    itemId: item.id,
    provider: 'user',
    model: 'test',
    extraction: null,
    draftText: null,
    replyLang: 'en',
    event: null,
    freeBusy: null,
    suspicious: false,
    createdAt: NOW,
  });
  const calendar = new Map<string, { start: string; end: string }>();
  const creates: CreateEventArgs[] = [];
  let timedOutOnce = false;

  const deps: ActionExecutorDeps = {
    repos,
    send: { sendText: () => Promise.reject(new Error('unused')) },
    write: {
      async createEvent(args) {
        creates.push(args);
        if (!timedOutOnce) {
          // Google DID create it; our side never saw the answer.
          calendar.set(args.eventId, { start: args.start, end: args.end });
          timedOutOnce = true;
          return { ok: false, error: 'timeout' };
        }
        if (calendar.has(args.eventId)) return { ok: false, error: 'id_exists' };
        calendar.set(args.eventId, { start: args.start, end: args.end });
        return { ok: true, value: { eventId: args.eventId, htmlLink: null } };
      },
    },
    read: {
      getCurrentTime: () => Promise.reject(new Error('unused')),
      getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
      findAppEvent: () => Promise.resolve({ ok: true, value: null }), // reconcile finds nothing -> clone is offered
    },
    bridgeOnline: () => true,
    calendarConnected: () => true,
    settings: () => structuredClone(DEFAULT_SETTINGS) as Settings,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    notifyChanged: () => undefined,
  };
  return { db, repos, chat, item, proposal, calendar, creates, exec: createActionExecutor(deps) };
}

describe('[verify] approval-first-1: edited create_event retry clone', () => {
  it('re-sends the same eventId, 409 is reported done, calendar keeps the OLD slot', async () => {
    const r = rig();
    const first = r.repos.actions.insertPending({
      itemId: r.item.id,
      proposalId: r.proposal.id,
      chatId: r.chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: r.item.id,
        chatRef: r.chat.id,
        proposalVersion: r.proposal.version,
        title: 'Coffee',
        startLocal: '2026-09-24T17:00:00',
        endLocal: '2026-09-24T18:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: NOW,
    });

    const r1 = await r.exec.approve(
      { actionId: first.id, kind: 'create_event', shownHash: sha256Hex(first.canonicalJson) },
      CTX,
    );
    expect(r1.ok && r1.value.outcome).toBe('failed'); // unknown_outcome is surfaced as 'failed'
    expect(r.repos.actions.byId(first.id)?.state).toBe('unknown_outcome');

    const clone = r.repos.actions.forItem(r.item.id as ItemId).find((a) => a.retryOf === first.id)!;
    expect(clone.state).toBe('pending');

    // The user moves the slot on the retry card and clicks "Add again".
    const r2 = await r.exec.approve(
      {
        actionId: clone.id,
        kind: 'create_event',
        shownHash: sha256Hex(clone.canonicalJson),
        edit: {
          title: 'Coffee',
          startLocal: '2026-09-24T19:00:00',
          endLocal: '2026-09-24T20:00:00',
          location: '',
        },
      },
      CTX,
    );

    const outcome = r2.ok ? r2.value.outcome : `gate:${r2.ok ? '' : r2.error.code}`;
    const sentId = r.creates[1]!.eventId;
    const row = r.repos.items.byId(r.item.id)!;
    const stored = r.calendar.get(sentId)!;

    // Facts, printed so the verdict rests on observed values:
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          outcome,
          sameEventId: r.creates[0]!.eventId === sentId,
          sentStart: r.creates[1]!.start,
          calendarStart: stored.start,
          calendarEnd: stored.end,
          itemEventState: row.eventState,
          itemEventStartTs: new Date(row.eventStartTs ?? 0).toISOString(),
          approvedStartTs: new Date(Date.UTC(2026, 8, 24, 16, 0, 0)).toISOString(), // 19:00 Asia/Jerusalem = 16:00Z
          cloneState: r.repos.actions.byId(clone.id)?.state,
          createCalls: r.creates.length,
        },
        null,
        2,
      ),
    );

    expect(r.creates[0]!.eventId).toBe(sentId); // same deterministic id despite the edit
    expect(r.creates[1]!.start).toBe('2026-09-24T19:00:00'); // we DID send the new slot
    expect(outcome).toBe('done'); // ...and the 409 was reported as success
    expect(stored.start).toBe('2026-09-24T17:00:00'); // ...while the calendar still holds the old slot
    expect(row.eventState).toBe('created');
    expect(row.eventStartTs).toBe(Date.UTC(2026, 8, 24, 16, 0, 0)); // item stamped with the NEW 19:00 local
    r.db.close();
  });

  it('control: an UNEDITED retry clone is legitimately done (the calendar already holds what was approved)', async () => {
    const r = rig();
    const first = r.repos.actions.insertPending({
      itemId: r.item.id,
      proposalId: r.proposal.id,
      chatId: r.chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: r.item.id,
        chatRef: r.chat.id,
        proposalVersion: r.proposal.version,
        title: 'Coffee',
        startLocal: '2026-09-24T17:00:00',
        endLocal: '2026-09-24T18:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: NOW,
    });
    await r.exec.approve(
      { actionId: first.id, kind: 'create_event', shownHash: sha256Hex(first.canonicalJson) },
      CTX,
    );
    const clone = r.repos.actions.forItem(r.item.id as ItemId).find((a) => a.retryOf === first.id)!;
    const res = await r.exec.approve(
      { actionId: clone.id, kind: 'create_event', shownHash: sha256Hex(clone.canonicalJson) },
      CTX,
    );
    expect(res.ok && res.value.outcome).toBe('done');
    expect(r.calendar.get(r.creates[1]!.eventId)!.start).toBe('2026-09-24T17:00:00');
    r.db.close();
  });
});
