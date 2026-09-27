// tests/security/crash-recovery.test.ts - gate item 6 of TESTS 8.2 (invariant I7). Owner: W2-02.
//
// A crash between `executing` and an outcome must never replay a side effect, and the "Send again" / "Add again" clone
// must need its own approval. Driven through the REAL `compose()` (restarted on the same userData directory), the REAL
// `ActionExecutor.recoverOnStartup`, the REAL reconcile and the REAL deterministic `eventId` chain.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { chainKeyOfAction, eventIdFor } from '../../src/main/exec/buildCreateEventArgs.ts';
import type { ApprovedEventContent } from '../../src/main/exec/buildCreateEventArgs.ts';
import type { ActionId, ItemCard } from '../../src/shared/types.ts';

const CHAT = '972550000008@s.whatsapp.net';
const HOUR = 3_600_000;
const FINAL_TEXT = 'Thursday 17:00 works for me';

const RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'coffee',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: FINAL_TEXT, stopReason: 'end' } },
];

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wca-sec-recovery-'));
  dirs.push(d);
  return d;
};

let live: Harness | null = null;
afterEach(async () => {
  await live?.dispose();
  live = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function cards(h: Harness): Promise<ItemCard[]> {
  const dash = await h.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('no dashboard');
  return [...dash.value.needsReply, ...dash.value.infoMissing, ...dash.value.inCalendar];
}

interface Crashed {
  actionId: ActionId;
  itemId: number;
  chatRef: number;
  approvedAt: number;
  rootEventId: string;
  /** The approved event content the deterministic id is derived from (empty for a send_reply crash). */
  eventContent: ApprovedEventContent;
  card: ItemCard;
}

/**
 * Brings a fresh app to the exact state a process kill leaves behind: the write-ahead has already committed
 * `executing` through the REAL compare-and-set, and nothing has recorded an outcome. The side effect itself is NOT
 * performed, so the app genuinely does not know whether it happened.
 */
async function crashMid(userData: string, kind: 'send_reply' | 'create_event'): Promise<Crashed> {
  const h = await createHarness({ userData, rules: RULES });
  try {
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - HOUR) });
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();
    const card = (await cards(h))[0];
    if (card === undefined) throw new Error('no card');
    const action = card.actions.find((a) => a.kind === kind);
    if (action === undefined) throw new Error(`no ${kind} action`);
    const row = h.repos.actions.byId(action.actionId)!;
    // [approval-first] the id is derived from the chain key AND the content the user approved.
    const eventContent: ApprovedEventContent = {
      title: card.event?.title ?? '',
      startLocal: card.event?.startLocal ?? '',
      endLocal: card.event?.endLocal ?? '',
      timeZone: card.event?.timeZone ?? '',
      location: card.event?.location ?? '',
    };
    const rootEventId = eventIdFor(chainKeyOfAction(row), eventContent);

    const payload =
      kind === 'send_reply'
        ? JSON.stringify({
            v: 1,
            kind: 'send_reply',
            itemId: card.itemId,
            chatRef: card.chat.chatRef,
            proposalVersion: 1,
            text: FINAL_TEXT,
          })
        : JSON.stringify({
            v: 1,
            kind: 'create_event',
            itemId: card.itemId,
            chatRef: card.chat.chatRef,
            proposalVersion: 1,
            ...eventContent,
          });
    const approvedAt = h.clock.now();
    expect(h.repos.actions.markApprovedExecuting(action.actionId, payload, approvedAt)).toBe('ok');
    expect(h.bridge.sends).toHaveLength(0);
    expect(h.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);
    return {
      actionId: action.actionId as ActionId,
      itemId: card.itemId,
      chatRef: card.chat.chatRef,
      approvedAt,
      rootEventId,
      eventContent,
      card,
    };
  } finally {
    await h.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. nothing is ever replayed
// ---------------------------------------------------------------------------------------------------------------------
describe('I7 - a crash never replays a side effect', () => {
  it('turns an `executing` send into `unknown_outcome` without touching the bridge', async () => {
    const dir = tmp();
    const { actionId } = await crashMid(dir, 'send_reply');

    live = await createHarness({ userData: dir, rules: RULES });
    expect(live.repos.actions.byId(actionId)?.state).toBe('unknown_outcome');
    expect(live.bridge.sends).toHaveLength(0);
    // Restarting again must be just as inert.
    await live.dispose();
    live = await createHarness({ userData: dir, rules: RULES });
    expect(live.repos.actions.byId(actionId)?.state).toBe('unknown_outcome');
    expect(live.bridge.sends).toHaveLength(0);
  });

  it('turns an `executing` create into `unknown_outcome` without touching the calendar', async () => {
    const dir = tmp();
    const { actionId } = await crashMid(dir, 'create_event');

    live = await createHarness({ userData: dir, rules: RULES });
    expect(live.repos.actions.byId(actionId)?.state).toBe('unknown_outcome');
    expect(live.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);
    expect(live.calendar.events).toHaveLength(0);
  });

  it('the retry clone is a NEW pending action that needs its own approval', async () => {
    const dir = tmp();
    const { actionId, itemId } = await crashMid(dir, 'send_reply');

    live = await createHarness({ userData: dir, rules: RULES });
    const detail = await live.invoke('item:get', { itemId });
    if (!detail.ok) throw new Error('no item');
    const retry = detail.value.actions.find((a) => a.kind === 'send_reply' && a.state === 'pending');
    expect(retry).toBeDefined();
    expect(retry!.actionId).not.toBe(actionId);
    expect(retry!.attempt).toBeGreaterThan(1);
    expect(live.bridge.sends).toHaveLength(0);

    // Approving the OLD id is refused: the unknown-outcome row is not pending any more.
    const stale = await live.invoke('action:approve', {
      actionId,
      kind: 'send_reply',
      shownHash: retry!.shownHash,
    });
    expect(stale.ok).toBe(false);
    expect(live.bridge.sends).toHaveLength(0);

    // Approving the clone sends exactly once, to the source chat.
    const approved = await live.invoke('action:approve', {
      actionId: retry!.actionId,
      kind: 'send_reply',
      shownHash: retry!.shownHash,
      edit: { text: FINAL_TEXT },
    });
    await live.advance(20_000);
    expect(approved.ok).toBe(true);
    expect(live.bridge.sends).toHaveLength(1);
    expect(live.bridge.sends[0]!.recipient).toBe(CHAT);
  });

  it('reconcile only READS: a send that already landed is promoted to done with no second send', async () => {
    const dir = tmp();
    const { actionId, approvedAt } = await crashMid(dir, 'send_reply');

    const seeded = await createHarness({ userData: dir, rules: RULES });
    await seeded.bridge.outboundFromPhone({ chatJid: CHAT, text: FINAL_TEXT, ts: new Date(approvedAt + 1_000) });
    await seeded.dispose();

    live = await createHarness({ userData: dir, rules: RULES });
    expect(live.repos.actions.byId(actionId)?.state).toBe('done');
    expect(live.bridge.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. the deterministic eventId makes a retry idempotent
// ---------------------------------------------------------------------------------------------------------------------
describe('I7 - a retried create-event can never produce a second event', () => {
  it('re-sends the chain-root eventId, and the calendar refuses the duplicate', async () => {
    const dir = tmp();
    const { itemId, rootEventId } = await crashMid(dir, 'create_event');

    // The create DID land before the crash: the event is already in the calendar under the deterministic id.
    live = await createHarness({
      userData: dir,
      rules: RULES,
      events: [
        {
          id: rootEventId,
          calendarId: 'primary',
          summary: 'coffee',
          start: '2026-09-24T17:00:00',
          end: '2026-09-24T18:00:00',
          timeZone: 'Asia/Jerusalem',
          extendedProperties: { private: { waAction: 'seeded' } },
        },
      ],
    });

    const detail = await live.invoke('item:get', { itemId });
    if (!detail.ok) throw new Error('no item');
    const retry = detail.value.actions.find((a) => a.kind === 'create_event' && a.state === 'pending');
    expect(retry).toBeDefined();

    const approved = await live.invoke('action:approve', {
      actionId: retry!.actionId,
      kind: 'create_event',
      shownHash: retry!.shownHash,
      confirmConflict: true,
    });
    expect(approved.ok).toBe(true);

    const creates = live.calendar.calls.filter((c) => c.tool === 'create-event');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args.eventId).toBe(rootEventId);
    // The fake answers `id_exists`; the executor must treat that as success, not as a reason to try a different id.
    expect(live.calendar.events).toHaveLength(1);
    expect(live.repos.actions.byId(retry!.actionId as ActionId)?.state).toBe('done');
  });

  it('[R2] a failing reconcile leaves the action unknown_outcome, and the later "Add again" still uses the SAME eventId', async () => {
    const dir = tmp();
    const { actionId, itemId, rootEventId } = await crashMid(dir, 'create_event');

    live = await createHarness({
      userData: dir,
      rules: RULES,
      events: [
        {
          id: rootEventId,
          calendarId: 'primary',
          summary: 'coffee',
          start: '2026-09-24T17:00:00',
          end: '2026-09-24T18:00:00',
          timeZone: 'Asia/Jerusalem',
        },
      ],
    });
    // Reconcile cannot see the event: the read tool crashes on call.
    live.calendar.failNext('list-events', 'crash_on_call');
    await live.settle();

    expect(live.repos.actions.byId(actionId)?.state).toBe('unknown_outcome');
    const detail = await live.invoke('item:get', { itemId });
    if (!detail.ok) throw new Error('no item');
    const retry = detail.value.actions.find((a) => a.kind === 'create_event' && a.state === 'pending');
    expect(retry, 'a fresh clone must be offered').toBeDefined();
    expect(retry!.actionId).not.toBe(actionId);

    const approved = await live.invoke('action:approve', {
      actionId: retry!.actionId,
      kind: 'create_event',
      shownHash: retry!.shownHash,
      confirmConflict: true,
    });
    expect(approved.ok).toBe(true);

    const creates = live.calendar.calls.filter((c) => c.tool === 'create-event');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args.eventId, 'the clone inherits the chain root eventId').toBe(rootEventId);
    expect(live.calendar.events).toHaveLength(1);
    expect(live.repos.actions.byId(retry!.actionId as ActionId)?.state).toBe('done');
  });

  it('the chain-root eventId is stable across clones and unique per chain', async () => {
    const dir = tmp();
    const { rootEventId, actionId, eventContent } = await crashMid(dir, 'create_event');
    live = await createHarness({ userData: dir, rules: RULES });
    const original = live.repos.actions.byId(actionId)!;
    const clones = live.repos.db
      .prepare(`SELECT id FROM actions WHERE kind='create_event' AND id <> ?`)
      .all(actionId) as Array<{ id: string }>;
    for (const clone of clones) {
      const row = live.repos.actions.byId(clone.id as ActionId)!;
      expect(eventIdFor(chainKeyOfAction(row), eventContent)).toBe(rootEventId);
    }
    // The chain key is the idempotency key without its `:rN` retry suffix, so every clone maps to the same id...
    expect(chainKeyOfAction(original)).toBe(original.idempotencyKey.replace(/:r\d+$/, ''));
    // ...and a DIFFERENT chain (a different idempotency key) never collides with it.
    expect(
      eventIdFor(chainKeyOfAction({ ...original, idempotencyKey: `${original.idempotencyKey}-other` }), eventContent),
    ).not.toBe(rootEventId);
    // ...and so does the SAME chain with a different approved slot (an edited retry never re-uses the old event).
    expect(eventIdFor(chainKeyOfAction(original), { ...eventContent, startLocal: '2030-01-01T09:00:00' })).not.toBe(
      rootEventId,
    );
    expect(rootEventId).toMatch(/^[a-v0-9]{5,1024}$/); // Google's base32hex id alphabet
  });
});
