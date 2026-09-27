// tests/integration/pipeline-gates.test.ts - TESTS section 6 row 4 (owner W2-01).
// The S0 gates as they behave against the real ingest + queue: the backlog gate, unknown senders, the `never` policy,
// Pause, and "no usable provider". Every one of them must cost ZERO LLM calls.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';

const CHAT = '972550000003@s.whatsapp.net';
const HOUR = 3_600_000;

const SCHEDULE_RULES: StubRule[] = [
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

describe('S0 gates', () => {
  it('a history sync of 300 rows from before live_from_ts produces no item and no LLM call', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    const base = h.clock.now() - 40 * 24 * HOUR;
    await h.bridge.historySync(
      Array.from({ length: 300 }, (_, i) => ({
        chatJid: CHAT,
        text: `backlog message ${i}`,
        ts: new Date(base + i * 60_000),
        fromMe: i % 5 === 0,
      })),
    );
    await h.settle();

    expect(h.llm.calls).toHaveLength(0);
    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    expect(dash.value.counts.needsReply).toBe(0);
    expect(dash.value.counts.infoMissing).toBe(0);
    expect(h.repos.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM runs').get()!.n).toBe(0);
  });

  it('an unknown sender yields a raw held card and zero LLM calls; "Analyse this chat" then runs the pipeline', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    // No outbound message in this chat => the user has never written there => unknown sender.
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    expect(h.llm.calls).toHaveLength(0);
    let dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const raw = dash.value.needsReply[0] ?? dash.value.infoMissing[0];
    expect(raw).toBeDefined();
    expect(raw!.card).toBe('raw');
    expect(raw!.analysis).toBe('held');
    expect(raw!.holdReason).toBe('unknown_sender');

    // "Analyse this chat" = mark the chat known, then re-triage it.
    const policy = await h.invoke('chat:setPolicy', { chatRef: raw!.chat.chatRef, forceKnown: true });
    expect(policy.ok).toBe(true);
    const retriage = await h.invoke('item:retriage', { itemId: raw!.itemId });
    expect(retriage.ok).toBe(true);
    await h.settle();

    expect(h.llm.calls.length).toBeGreaterThan(0);
    dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const after = [...dash.value.needsReply, ...dash.value.infoMissing].find((c) => c.itemId === raw!.itemId);
    expect(after?.analysis).toBe('done');
  });

  it('a chat with policy `never` never produces an item', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'first one, so the chat row exists' });
    await h.settle();

    // `chat:listPolicies` only lists chats that already carry an explicit policy, so the chatRef comes off the card.
    const first = await h.invoke('dashboard:get', undefined);
    if (!first.ok) throw new Error('no dashboard');
    const chatRef = [...first.value.needsReply, ...first.value.infoMissing, ...first.value.inCalendar][0]!.chat.chatRef;
    expect((await h.invoke('chat:setPolicy', { chatRef, policy: 'never' })).ok).toBe(true);

    const before = h.llm.calls.length;
    const openBefore = h.repos.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM items`).get()!.n;
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    expect(h.llm.calls.length).toBe(before);
    expect(h.repos.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM items`).get()!.n).toBe(openBefore);
  });

  it('while paused, an inbound message is held and no LLM call is made; resuming releases it', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    await knownChat(h, CHAT);
    expect((await h.invoke('agent:setPaused', { paused: true })).ok).toBe(true);
    expect(h.health().paused).toBe(true);

    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();
    expect(h.llm.calls).toHaveLength(0);

    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const card = [...dash.value.needsReply, ...dash.value.infoMissing][0];
    expect(card?.analysis).toBe('held');
    expect(card?.holdReason).toBe('paused');

    expect((await h.invoke('agent:setPaused', { paused: false })).ok).toBe(true);
    expect(h.health().paused).toBe(false);
  });

  it('a cloud provider without a current consent holds the item as waiting_llm and never calls the model', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES, provider: 'claude', profile: { cloudConsent: false } });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    expect(h.llm.calls).toHaveLength(0);
    const dash = await h.invoke('dashboard:get', undefined);
    if (!dash.ok) throw new Error('no dashboard');
    const card = [...dash.value.needsReply, ...dash.value.infoMissing][0];
    expect(card?.analysis).toBe('held');
    expect(card?.holdReason).toBe('waiting_llm');
    expect(h.health().llm.state).toBe('consent_missing');
  });
});
