// SCRATCH - adversarial review "approval-first", finding approval-first-1.
//
// Claim: the deterministic Google eventId is derived from the retry CHAIN key only
// (`${itemId}:create_event:${proposalVersion}`), NOT from the content the user approved. A retry clone therefore re-sends
// the SAME eventId even when the user EDITED the event on the retry card. Google answers 409 ('id_exists'), which
// exec/actionExecutor.ts `runCreate` treats as SUCCESS, and `applyCreateSuccess` then stamps the NEW (edited) start time
// on the item row. Result: the calendar still holds the OLD event, the app reports "Added" and shows the new time.
//
// This test models a calendar that stores events by client-supplied id and 409s on a duplicate id (exactly what
// McpErrorKind 'id_exists' means, see src/main/mcp/readClient.ts). It asserts the only thing the product promises:
// when the executor reports `done` for an approved create_event, the calendar holds what the user approved.
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
const JID = '972550000001@s.whatsapp.net'; // synthetic, never a real number
const CTX: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

describe('[scratch] retry clone re-uses the chain eventId after the user edited the event', () => {
  it('reports done while the calendar still holds the OLD slot', async () => {
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

    // A tiny Google: client-supplied ids are unique, a repeat is 409 'id_exists'.
    const calendar = new Map<string, { start: string; end: string }>();
    let firstCallTimedOut = false;
    const creates: CreateEventArgs[] = [];

    const deps: ActionExecutorDeps = {
      repos,
      send: { sendText: () => Promise.reject(new Error('not used')) },
      write: {
        async createEvent(args) {
          creates.push(args);
          if (!firstCallTimedOut) {
            // The write REACHED Google and the event was created, but our side never saw the answer.
            calendar.set(args.eventId, { start: args.start, end: args.end });
            firstCallTimedOut = true;
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
        findAppEvent: () => Promise.resolve({ ok: true, value: null }),
      },
      bridgeOnline: () => true,
      calendarConnected: () => true,
      settings: () => structuredClone(DEFAULT_SETTINGS) as Settings,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      notifyChanged: () => undefined,
    };
    const exec = createActionExecutor(deps);

    const first = repos.actions.insertPending({
      itemId: item.id,
      proposalId: proposal.id,
      chatId: chat.id,
      payload: {
        v: 1,
        kind: 'create_event',
        itemId: item.id,
        chatRef: chat.id,
        proposalVersion: proposal.version,
        title: 'Coffee',
        startLocal: '2026-09-24T17:00:00',
        endLocal: '2026-09-24T18:00:00',
        timeZone: 'Asia/Jerusalem',
        location: '',
      },
      now: NOW,
    });

    // 1. first approval: the create times out -> unknown_outcome + a fresh PENDING retry clone.
    const r1 = await exec.approve(
      { actionId: first.id, kind: 'create_event', shownHash: sha256Hex(first.canonicalJson) },
      CTX,
    );
    expect(r1.ok).toBe(true);
    const clone = repos.actions.forItem(item.id as ItemId).find((a) => a.retryOf === first.id)!;
    expect(clone.state).toBe('pending');

    // 2. the user fixes the time on the retry card and approves again.
    const r2 = await exec.approve(
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
    expect(r2.ok).toBe(true);
    const outcome = r2.ok ? r2.value.outcome : 'gate-failure';

    // Both attempts carried the SAME client-supplied event id, so the second one could only ever 409.
    expect(creates[1]!.eventId).toBe(creates[0]!.eventId);

    // What the app now believes:
    const row = repos.items.byId(item.id)!;
    const stored = calendar.get(creates[1]!.eventId)!;

    // THE ASSERTION UNDER TEST: if the executor reports `done`, the calendar must hold the approved slot.
    // Today it reports 'done' with the calendar still on 17:00 while the item row says 19:00.
    if (outcome === 'done') {
      expect({ outcome, calendarStart: stored.start, itemState: row.eventState }).toEqual({
        outcome: 'done',
        calendarStart: '2026-09-24T19:00:00',
        itemState: 'created',
      });
    }
    db.close();
  });
});
