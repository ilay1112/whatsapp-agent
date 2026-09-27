// tests/integration/pipeline-burst-retriage.test.ts - TESTS section 6 row 2 (owner W2-01).
// A burst of messages collapses into ONE run; a message that arrives after a proposal bumps the version, supersedes the
// old actions and makes the old actionId un-approvable ("this card changed"); the edit lock defers re-triage and keeps
// the shownHash the user is looking at valid.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { ItemCard } from '../../src/shared/types.ts';

const CHAT = '972550000004@s.whatsapp.net';
const HOUR = 3_600_000;

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
  { when: { purpose: 'draft' }, respond: { text: 'Works for me', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function knownChat(harness: Harness, jid: string): Promise<void> {
  await harness.bridge.outboundFromPhone({ chatJid: jid, text: 'hey', ts: new Date(harness.clock.now() - HOUR) });
}

async function openCard(harness: Harness): Promise<ItemCard> {
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('no dashboard');
  const cards = [...dash.value.needsReply, ...dash.value.infoMissing, ...dash.value.inCalendar];
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

describe('burst + re-triage', () => {
  it('five messages within the debounce window produce exactly one run', async () => {
    h = await createHarness({ rules: RULES });
    await knownChat(h, CHAT);
    for (let i = 0; i < 5; i++) {
      await h.bridge.inbound({ chatJid: CHAT, text: `coffee Thursday at 5? (${i})` });
      await h.advance(2_000);
    }
    await h.settle();

    expect(h.llm.calls.filter((c) => c.kind === 'structured')).toHaveLength(1);
    const runs = h.repos.db.prepare<{ n: number }>(`SELECT COUNT(DISTINCT item_id) AS n FROM runs`).get()!.n;
    expect(runs).toBe(1);
    await openCard(h);
  });

  it('a new inbound message after a proposal bumps the version, supersedes the old actions and makes the old actionId stale', async () => {
    h = await createHarness({ rules: RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const before = await openCard(h);
    const staleSend = before.actions.find((a) => a.kind === 'send_reply')!;
    const v1 = h.repos.db.prepare<{ v: number }>(`SELECT MAX(version) AS v FROM proposals`).get()!.v;

    await h.advance(HOUR);
    await h.bridge.inbound({ chatJid: CHAT, text: 'actually make it 18:00' });
    await h.settle();

    const v2 = h.repos.db.prepare<{ v: number }>(`SELECT MAX(version) AS v FROM proposals`).get()!.v;
    expect(v2).toBe(v1 + 1);

    const superseded = h.repos.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM actions WHERE id = ? AND state = 'superseded'`)
      .get(staleSend.actionId)!.n;
    expect(superseded).toBe(1);

    const approved = await h.invoke('action:approve', {
      actionId: staleSend.actionId,
      kind: 'send_reply',
      shownHash: staleSend.shownHash,
      edit: { text: 'stale approval that must not be sent' },
    });
    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.error.code).toBe('ACTION_STALE');
    expect(h.bridge.sends).toHaveLength(0);
  });

  it('the edit lock defers re-triage and keeps the card the user is editing intact', async () => {
    h = await createHarness({ rules: RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const card = await openCard(h);
    const send = card.actions.find((a) => a.kind === 'send_reply')!;
    expect((await h.invoke('item:setEditing', { itemId: card.itemId, editing: true })).ok).toBe(true);

    await h.bridge.inbound({ chatJid: CHAT, text: 'or 18:00 if that is easier' });
    // Bounded advance, not settle(): settle() would burn more than LIMITS.editLockMs of virtual time and expire the lock.
    await h.advance(25_000);

    const locked = await h.invoke('item:get', { itemId: card.itemId });
    if (!locked.ok) throw new Error('no item');
    expect(locked.value.editingLocked).toBe(true);
    // The action the user is looking at is still approvable while the lock holds.
    const stillThere = locked.value.actions.find((a) => a.actionId === send.actionId);
    expect(stillThere?.state).toBe('pending');
    expect(stillThere?.shownHash).toBe(send.shownHash);
  });
});
