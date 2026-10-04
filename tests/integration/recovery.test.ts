// tests/integration/recovery.test.ts - TESTS section 6 row 7 (owner W2-01).
// The app dies between `executing` and `done`. On the next start the action must become `unknown_outcome` (NEVER
// re-executed), reconcile must promote it to `done` when the side effect is visible in the bridge store, and a still
// unknown action must offer "Send again" as a NEW pending action that needs its own approval. Also: `running` -> `queued`.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { ActionId, ItemCard } from '../../src/shared/types.ts';
import { chainKeyOfAction, eventIdFor } from '../../src/main/exec/buildCreateEventArgs.ts';

const CHAT = '972550000007@s.whatsapp.net';
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
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: FINAL_TEXT, stopReason: 'end' } },
];

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wca-l3-recovery-'));
  dirs.push(d);
  return d;
};

let live: Harness | null = null;
afterEach(async () => {
  await live?.dispose();
  live = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function cards(harness: Harness): Promise<ItemCard[]> {
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('no dashboard');
  return [...dash.value.needsReply, ...dash.value.infoMissing, ...dash.value.inCalendar];
}

/**
 * Brings a fresh app to the moment a send is half-done: the write-ahead has flipped the action to `executing`
 * (through the REAL compare-and-set repo call), but nothing has recorded an outcome yet - exactly the state a
 * process kill leaves behind.
 */
async function crashMidSend(userData: string): Promise<{ actionId: ActionId; itemId: number; approvedAt: number }> {
  const h = await createHarness({ userData, rules: RULES });
  try {
    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - HOUR) });
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();
    const card = (await cards(h))[0]!;
    const send = card.actions.find((a) => a.kind === 'send_reply')!;
    const payload = JSON.stringify({
      v: 1,
      kind: 'send_reply',
      itemId: card.itemId,
      chatRef: card.chat.chatRef,
      proposalVersion: 1,
      text: FINAL_TEXT,
    });
    const approvedAt = h.clock.now();
    expect(h.repos.actions.markApprovedExecuting(send.actionId, payload, approvedAt, 'user')).toBe('ok');
    return { actionId: send.actionId, itemId: card.itemId, approvedAt };
  } finally {
    await h.dispose();
  }
}

describe('crash recovery', () => {
  it('seeds a profile once and re-opens the same database on restart', async () => {
    const dir = tmp();
    const first = await createHarness({ userData: dir });
    const itemsBefore = first.repos.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM consents').get()!.n;
    await first.dispose();

    live = await createHarness({ userData: dir });
    expect(live.repos.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM consents').get()!.n).toBe(itemsBefore);
    expect(live.app.recovery.recovered).toBe('none');
  });

  it('an action left `executing` becomes `unknown_outcome` and is NEVER re-executed', async () => {
    const dir = tmp();
    const { actionId } = await crashMidSend(dir);

    live = await createHarness({ userData: dir, rules: RULES });
    const state = live.repos.db.prepare<{ state: string }>('SELECT state FROM actions WHERE id = ?').get(actionId);
    expect(state?.state).toBe('unknown_outcome');
    // The whole point: no side effect was replayed on the way back up.
    expect(live.bridge.sends).toHaveLength(0);
  });

  it('reconcile promotes the action to `done` when the outbound row is already in the bridge store', async () => {
    const dir = tmp();
    const { actionId, approvedAt } = await crashMidSend(dir);

    // The send DID land before the crash: the row is in messages.db, the app just never saw the answer. Its timestamp
    // has to fall inside LIMITS.reconcileSendWindowMs after the write-ahead, which is what reconcile matches on.
    const seeded = await createHarness({ userData: dir, rules: RULES });
    await seeded.bridge.outboundFromPhone({ chatJid: CHAT, text: FINAL_TEXT, ts: new Date(approvedAt + 1_000) });
    await seeded.dispose();

    live = await createHarness({ userData: dir, rules: RULES });
    const state = live.repos.db.prepare<{ state: string }>('SELECT state FROM actions WHERE id = ?').get(actionId);
    expect(state?.state).toBe('done');
    expect(live.bridge.sends).toHaveLength(0); // reconcile only READS; it never re-sends
  });

  it('a still-unknown send offers "Send again" as a NEW pending action that needs its own approval', async () => {
    const dir = tmp();
    const { actionId, itemId } = await crashMidSend(dir);

    live = await createHarness({ userData: dir, rules: RULES });
    const detail = await live.invoke('item:get', { itemId });
    if (!detail.ok) throw new Error('no item');

    const retry = detail.value.actions.find((a) => a.kind === 'send_reply' && a.state === 'pending');
    expect(retry).toBeDefined();
    expect(retry!.actionId).not.toBe(actionId);
    expect(retry!.attempt).toBeGreaterThan(1);
    expect(live.bridge.sends).toHaveLength(0);

    const approved = await live.invoke('action:approve', {
      actionId: retry!.actionId,
      kind: 'send_reply',
      shownHash: retry!.shownHash,
      edit: { text: FINAL_TEXT },
    });
    expect(approved.ok).toBe(true);
    expect(live.bridge.sends).toHaveLength(1);
    expect(live.bridge.sends[0]!.message).toBe(FINAL_TEXT);
  });

  it('[R2] "Add again" after an unknown create_event re-uses the chain root eventId, so only ONE event ever exists', async () => {
    const dir = tmp();
    let rootEventId: string;
    let itemId: number;
    {
      const h = await createHarness({ userData: dir, rules: RULES });
      await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - HOUR) });
      await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
      await h.settle();
      const card = (await cards(h))[0]!;
      itemId = card.itemId;
      const create = card.actions.find((a) => a.kind === 'create_event')!;
      const action = h.repos.actions.byId(create.actionId)!;
      const eventContent = {
        title: card.event!.title,
        startLocal: card.event!.startLocal,
        endLocal: card.event!.endLocal,
        timeZone: card.event!.timeZone,
        location: card.event!.location,
      };
      // The id is derived from the chain key AND the approved content: an UNEDITED retry keeps both, so it keeps the id.
      rootEventId = eventIdFor(chainKeyOfAction(action), eventContent);
      const payload = JSON.stringify({
        v: 1,
        kind: 'create_event',
        itemId: card.itemId,
        chatRef: card.chat.chatRef,
        proposalVersion: 1,
        ...eventContent,
      });
      expect(h.repos.actions.markApprovedExecuting(create.actionId, payload, h.clock.now(), 'user')).toBe('ok');
      await h.dispose();
    }

    live = await createHarness({ userData: dir, rules: RULES });
    const detail = await live.invoke('item:get', { itemId });
    if (!detail.ok) throw new Error('no item');
    const retry = detail.value.actions.find((a) => a.kind === 'create_event' && a.state === 'pending');
    expect(retry).toBeDefined();
    expect(live.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);

    const approved = await live.invoke('action:approve', {
      actionId: retry!.actionId,
      kind: 'create_event',
      shownHash: retry!.shownHash,
    });
    expect(approved.ok).toBe(true);

    const creates = live.calendar.calls.filter((c) => c.tool === 'create-event');
    expect(creates).toHaveLength(1);
    // The retry clone shares the chain root, so it re-sends the SAME deterministic id: Google answers 409, never a duplicate.
    expect(creates[0]!.args.eventId).toBe(rootEventId);
    expect(live.calendar.events).toHaveLength(1);
  });

  it('an item left `running` is put back to `queued` on the next start', async () => {
    const dir = tmp();
    {
      const h = await createHarness({ userData: dir, rules: RULES });
      await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(h.clock.now() - HOUR) });
      await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
      await h.settle();
      const card = (await cards(h))[0]!;
      h.repos.db.prepare(`UPDATE items SET analysis = 'running' WHERE id = ?`).run(card.itemId);
      await h.dispose();
    }

    live = await createHarness({ userData: dir, rules: RULES });
    const analysis = live.repos.db.prepare<{ analysis: string }>('SELECT analysis FROM items LIMIT 1').get();
    expect(['queued', 'done']).toContain(analysis!.analysis);
  });
});
