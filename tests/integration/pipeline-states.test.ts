// tests/integration/pipeline-states.test.ts - TESTS section 6 row 3 (owner W2-01).
// The item state machine end to end: info_missing + the "Add to calendar" mini-form (no second LLM call), a confirmation
// with a busy calendar (conflict badge without S3), needsReply=false closing `not_needed`, answered from the phone,
// dismiss/restore, and the 7-day expiry.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { ItemCard } from '../../src/shared/types.ts';

const CHAT = '972550000005@s.whatsapp.net';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MISSING_TIME_RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'call',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '',
        missing: ['time'],
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Thursday works. What time?', stopReason: 'end' } },
];

const CONFIRMATION_RULES: StubRule[] = [
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'confirmation',
        needsReply: false,
        title: 'coffee',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '17:00',
        durationMin: 60,
      }),
    },
  },
];

/** A question with no date at all: needs a reply, proposes no event (eventState 'none'). */
const QUESTION_RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: extraction({ intent: 'question', needsReply: true }) } },
  { when: { purpose: 'draft' }, respond: { text: 'Yes, I am around after 18:00.', stopReason: 'end' } },
];

const NOTHING_RULES: StubRule[] = [
  { when: { purpose: 'extract' }, respond: { structured: extraction({ intent: 'other', needsReply: false }) } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function knownChat(harness: Harness, jid: string): Promise<void> {
  await harness.bridge.outboundFromPhone({ chatJid: jid, text: 'hey', ts: new Date(harness.clock.now() - HOUR) });
}

async function cards(harness: Harness): Promise<ItemCard[]> {
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('no dashboard');
  return [...dash.value.needsReply, ...dash.value.infoMissing, ...dash.value.inCalendar];
}

describe('item states', () => {
  it('a missing time lands in info_missing, and "Add to calendar" completes it WITHOUT another LLM call', async () => {
    h = await createHarness({ rules: MISSING_TIME_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'Thursday works for the call, morning ideally' });
    await h.settle();

    const card = (await cards(h))[0]!;
    expect(card.status).toBe('info_missing');
    expect(card.missing).toContain('time');
    expect(card.event?.startLocal).toBe('');
    expect(card.actions.map((a) => a.kind)).toEqual(['send_reply']);

    const callsBefore = h.llm.calls.length;
    const completed = await h.invoke('item:completeEvent', {
      itemId: card.itemId,
      event: { title: 'call', startLocal: '2026-09-24T10:00:00', endLocal: '2026-09-24T11:00:00', location: '' },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(h.llm.calls.length).toBe(callsBefore); // the mini-form is deterministic: no model involved
    expect(completed.value.event?.startLocal).toBe('2026-09-24T10:00:00');
    // The mini-form writes a NEW proposal version (provider 'user'), so the old pending send_reply is superseded and
    // the only approvable action on the fresh version is the create_event the user just completed.
    expect(completed.value.actions.map((a) => a.kind)).toEqual(['create_event']);
  });

  it('a confirmation with a busy calendar gets the conflict badge and never runs S3', async () => {
    h = await createHarness({
      rules: CONFIRMATION_RULES,
      busy: [{ start: '2026-09-24T16:30:00+03:00', end: '2026-09-24T18:00:00+03:00' }],
    });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'see you Thursday at 17:00' });
    await h.settle();

    const card = (await cards(h))[0]!;
    expect(card.badges).toContain('conflict');
    expect(card.draft).toBeNull();
    expect(h.llm.calls.filter((c) => c.kind === 'chat')).toHaveLength(0);
  });

  it('needsReply=false with nothing to schedule closes the item as not_needed', async () => {
    h = await createHarness({ rules: NOTHING_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'thanks!' });
    await h.settle();

    expect(await cards(h)).toHaveLength(0);
    const row = h.repos.db.prepare<{ closed_reason: string | null }>(`SELECT closed_reason FROM items LIMIT 1`).get();
    expect(row?.closed_reason).toBe('not_needed');
  });

  it('answering from the phone closes a reply-only item as answered_elsewhere', async () => {
    h = await createHarness({ rules: QUESTION_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'are you around later?' });
    await h.settle();
    const card = (await cards(h))[0]!;
    expect(card.eventState).toBe('none');

    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'answered from my phone' });
    await h.settle();

    const after = await h.invoke('item:get', { itemId: card.itemId });
    if (!after.ok) throw new Error('no item');
    expect(after.value.replyState).toBe('answered_elsewhere');
    expect(after.value.closedReason).toBe('answered_elsewhere');
    expect(h.bridge.sends).toHaveLength(0);
  });

  it('answering from the phone keeps an item with a pending event OPEN, but marks the reply answered elsewhere', async () => {
    h = await createHarness({ rules: MISSING_TIME_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'Thursday works for the call, morning ideally' });
    await h.settle();
    const card = (await cards(h))[0]!;

    await h.bridge.outboundFromPhone({ chatJid: CHAT, text: 'answered from my phone' });
    await h.settle();

    const after = await h.invoke('item:get', { itemId: card.itemId });
    if (!after.ok) throw new Error('no item');
    expect(after.value.replyState).toBe('answered_elsewhere');
    expect(after.value.closedReason).toBeNull(); // the event slot still needs the user
    expect(h.bridge.sends).toHaveLength(0);
  });

  it('dismiss moves the card to the ignored list and restore brings it back', async () => {
    h = await createHarness({ rules: MISSING_TIME_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'Thursday works for the call, morning ideally' });
    await h.settle();
    const card = (await cards(h))[0]!;

    expect((await h.invoke('item:dismiss', { itemId: card.itemId })).ok).toBe(true);
    const ignored = await h.invoke('dashboard:getIgnored', undefined);
    if (!ignored.ok) throw new Error('no ignored list');
    expect(ignored.value.items.map((i) => i.itemId)).toContain(card.itemId);
    expect(await cards(h)).toHaveLength(0);

    expect((await h.invoke('item:restore', { itemId: card.itemId })).ok).toBe(true);
    expect((await cards(h)).map((c) => c.itemId)).toContain(card.itemId);
  });

  it('an open item older than seven days expires', async () => {
    h = await createHarness({ rules: MISSING_TIME_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'Thursday works for the call, morning ideally' });
    await h.settle();
    const card = (await cards(h))[0]!;

    await h.advance(8 * DAY);
    expect(h.repos.items.expireOld(h.clock.now())).toBeGreaterThan(0);

    const after = await h.invoke('item:get', { itemId: card.itemId });
    if (!after.ok) throw new Error('no item');
    expect(after.value.closedReason).toBe('expired');
  }, 60_000); // [V2-W2-01] 8 virtual days drive ~23k timer ticks through the real compose(): allow for a loaded parallel run
});
