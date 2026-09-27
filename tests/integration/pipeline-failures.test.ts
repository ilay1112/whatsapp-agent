// tests/integration/pipeline-failures.test.ts - TESTS section 6 row 5 (owner W2-01).
// Failure handling with the real orchestrator + queue: schema-invalid output twice -> LLM_BAD_OUTPUT raw card that can be
// re-triaged; provider `auth` -> KEY_INVALID with no retry and no fallback to another provider; `rate_limited` -> the
// queue backs off instead of hammering; a disconnected calendar -> drafts continue, no create_event, no tools offered.
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { ItemCard } from '../../src/shared/types.ts';

const CHAT = '972550000006@s.whatsapp.net';
const HOUR = 3_600_000;

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

describe('pipeline failures', () => {
  it('schema-invalid output (twice) produces an LLM_BAD_OUTPUT raw card, and "Analyse again" re-runs it', async () => {
    const badThenGood: StubRule[] = [
      // First run: two schema-invalid answers (the orchestrator gets exactly one repair turn).
      { when: { purpose: 'extract' }, respond: { structured: { intent: 'not-an-intent' } }, times: 2 },
      {
        when: { purpose: 'extract' },
        respond: { structured: extraction({ intent: 'question', needsReply: true }) },
      },
      { when: { purpose: 'draft' }, respond: { text: 'Sure.', stopReason: 'end' } },
    ];
    h = await createHarness({ rules: badThenGood });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'are you around later?' });
    await h.settle();

    let card = (await cards(h))[0]!;
    expect(card.analysis).toBe('failed');
    expect(card.card).toBe('raw');
    expect(card.errorCode).toBe('LLM_BAD_OUTPUT');
    expect(h.llm.calls.filter((c) => c.kind === 'structured')).toHaveLength(2);
    expect(h.bridge.sends).toHaveLength(0);

    expect((await h.invoke('item:retriage', { itemId: card.itemId })).ok).toBe(true);
    await h.settle();
    card = (await cards(h)).find((c) => c.itemId === card.itemId)!;
    expect(card.analysis).toBe('done');
    expect(card.errorCode).toBeNull();
  });

  it('a provider `auth` failure surfaces KEY_INVALID, is not retried and never falls back to another provider', async () => {
    // A cloud provider: `auth` against the LOCAL runtime means "llama-server is broken", not "the key is wrong".
    h = await createHarness({
      provider: 'claude',
      rules: [{ when: { purpose: 'extract' }, respond: { error: 'auth' } }],
    });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const card = (await cards(h))[0]!;
    expect(card.analysis).toBe('failed');
    expect(card.errorCode).toBe('KEY_INVALID');
    // One attempt only: `auth` is terminal for the run (PIPELINE section 7).
    expect(h.llm.calls.filter((c) => c.kind === 'structured')).toHaveLength(1);
    // The scripted provider is the only one that was ever asked for.
    expect(h.llm.calls.every((c) => c.opts.purpose !== undefined)).toBe(true);
  });

  it('a `rate_limited` provider defers the chat instead of hammering it', async () => {
    h = await createHarness({
      rules: [{ when: { purpose: 'extract' }, respond: { error: 'rate_limited' } }],
    });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    // The first backoff step is a minute; settle() never burns enough virtual time for a second and third attempt.
    expect(h.llm.calls.filter((c) => c.kind === 'structured').length).toBeLessThanOrEqual(3);
    const due = h.repos.db.prepare<{ due_at: number }>(`SELECT due_at FROM triage_queue LIMIT 1`).get();
    expect(due).toBeDefined();
    expect(due!.due_at).toBeGreaterThan(h.clock.now());
  });

  it('with the calendar not configured, drafting continues but no tool is offered and no create_event is proposed', async () => {
    h = await createHarness({
      calendar: 'not_configured',
      rules: [
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
        { when: { purpose: 'draft' }, respond: { text: 'Thursday 17:00 works', stopReason: 'end' } },
      ],
    });
    await knownChat(h, CHAT);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();

    const card = (await cards(h))[0]!;
    expect(card.draft?.text).toBe('Thursday 17:00 works');
    expect(card.actions.map((a) => a.kind)).toEqual(['send_reply']);
    // I2: with no calendar there is nothing to offer, so the model is handed an empty tool list.
    for (const call of h.llm.calls) expect(call.tools).toEqual([]);
    expect(h.calendar.calls).toHaveLength(0);
    expect(h.health().calendar.state).toBe('not_configured');
  });
});
