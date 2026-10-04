// tests/integration/pipeline-happy.test.ts - TESTS section 6 row 1 (owner W2-01).
// inbound "coffee Thursday at 5?" (en + he) -> doorbell -> scan -> debounce -> S1..S4 -> one needs_reply item with draft +
// proposed event + two pending actions; approve send -> exactly one /api/send to the chat JID with the textarea text;
// approve create -> one create-event with whitelist args -> in_calendar; the reply is sent and the card stays in_calendar
// ([v2-fix editing-undo-9]: an in_calendar card is not "open", so ARCH 7's 'replied' closing never applies to it - B20 editability).
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { CREATE_EVENT_WHITELIST } from '../fakes/fake-mcp-calendar.ts';
import type { ItemCard } from '../../src/shared/types.ts';

const CHAT = '972550000001@s.whatsapp.net';
const CHAT_HE = '972550000002@s.whatsapp.net';

/** 2026-09-21 09:00 UTC = Monday 12:00 in Asia/Jerusalem; "Thursday at 5" resolves to 2026-09-24T17:00. */
const THURSDAY_RULES = (draft: string): StubRule[] => [
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
        timeAmbiguous: true,
        location: '',
        missing: ['duration', 'location'],
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: draft, stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** The user has written in this chat before, so S0 treats it as a known sender (processUnknownSenders stays false). */
async function knownChat(harness: Harness, jid: string): Promise<void> {
  await harness.bridge.outboundFromPhone({ chatJid: jid, text: 'hey', ts: new Date(harness.clock.now() - 3_600_000) });
}

function onlyCard(cards: ItemCard[]): ItemCard {
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

describe('pipeline: the happy path', () => {
  it('turns one inbound message into a card with a draft, a proposed event and two pending actions', async () => {
    h = await createHarness({ rules: THURSDAY_RULES('Thursday 17:00 works for me') });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const dash = await h.invoke('dashboard:get', undefined);
    expect(dash.ok).toBe(true);
    if (!dash.ok) return;
    const card = onlyCard(dash.value.needsReply);
    expect(card.status).toBe('needs_reply');
    expect(card.card).toBe('full');
    expect(card.analysis).toBe('done');
    expect(card.draft?.text).toBe('Thursday 17:00 works for me');
    expect(card.event?.startLocal).toBe('2026-09-24T17:00:00');
    expect(card.event?.endLocal).toBe('2026-09-24T18:00:00');
    expect(card.badges).toContain('time_assumed');
    expect([...card.actions.map((a) => a.kind)].sort()).toEqual(['create_event', 'send_reply']);
    expect(card.actions.every((a) => a.state === 'pending')).toBe(true);

    // Exactly one S1 and one S3 call, and the model never saw another chat (I5).
    expect(h.llm.calls.filter((c) => c.kind === 'structured')).toHaveLength(1);
    expect(h.llm.calls.filter((c) => c.kind === 'chat')).toHaveLength(1);
    // Nothing has left the machine yet: approval-first is structural.
    expect(h.bridge.sends).toHaveLength(0);
    expect(h.calendar.calls.filter((c) => c.tool === 'create-event')).toHaveLength(0);
  });

  it('approving the reply sends exactly one /api/send with the edited text, to the chat JID', async () => {
    h = await createHarness({ rules: THURSDAY_RULES('Thursday 17:00 works for me') });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const card = onlyCard(dash.value.needsReply);
    const send = card.actions.find((a) => a.kind === 'send_reply')!;

    const approved = await h.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
      edit: { text: 'See you Thursday at 17:00' },
    });
    await h.advance(20_000); // the send jitter sleep is on the injected clock
    expect(approved.ok).toBe(true);

    expect(h.bridge.sends).toHaveLength(1);
    expect(h.bridge.sends[0]!.recipient).toBe(CHAT);
    expect(h.bridge.sends[0]!.message).toBe('See you Thursday at 17:00');
    // A16: exactly two keys reach the wire.
    expect(h.bridge.sends[0]!.extraKeys).toEqual([]);
  });

  it('approving the event creates one calendar event with whitelisted args only and moves the card to in_calendar', async () => {
    h = await createHarness({ rules: THURSDAY_RULES('Thursday 17:00 works for me') });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const card = onlyCard(dash.value.needsReply);
    const create = card.actions.find((a) => a.kind === 'create_event')!;
    const send = card.actions.find((a) => a.kind === 'send_reply')!;

    const createRes = await h.invoke('action:approve', {
      actionId: create.actionId,
      kind: 'create_event',
      shownHash: create.shownHash,
    });
    await h.advance(20_000);
    expect(createRes.ok).toBe(true);

    const calls = h.calendar.calls.filter((c) => c.tool === 'create-event');
    expect(calls).toHaveLength(1);
    for (const key of Object.keys(calls[0]!.args)) expect(CREATE_EVENT_WHITELIST).toContain(key);
    expect(h.calendar.events).toHaveLength(1);

    const sendRes = await h.invoke('action:approve', {
      actionId: send.actionId,
      kind: 'send_reply',
      shownHash: send.shownHash,
      edit: { text: 'See you Thursday at 17:00' },
    });
    await h.advance(20_000);
    expect(sendRes.ok).toBe(true);

    const after = await h.invoke('item:get', { itemId: card.itemId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.eventState).toBe('created');
    expect(after.value.replyState).toBe('sent');
    expect(after.value.closedReason).toBeNull();
    expect(after.value.status).toBe('in_calendar');
  });

  it('does the same for a Hebrew chat and drafts in Hebrew', async () => {
    h = await createHarness({ rules: THURSDAY_RULES('נתראה ביום חמישי ב-17:00') });
    await knownChat(h, CHAT_HE);
    await h.bridge.inbound({ chatJid: CHAT_HE, text: 'קפה ביום חמישי ב-5?' });
    await h.settle();

    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const card = onlyCard(dash.value.needsReply);
    expect(card.draft?.lang).toBe('he');
    expect(card.draft?.text).toBe('נתראה ביום חמישי ב-17:00');
  });
});
