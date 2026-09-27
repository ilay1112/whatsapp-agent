// tests/security/backlog-gate.test.ts - gate item 11 of TESTS 8.2 (assumption A14). Owner: W2-02.
//
// The backlog gate is what stops the agent from waking up and answering a week of old messages. Everything here runs
// through the REAL `compose()` -> REAL ingest -> REAL Stage 0; the only doubles are the fake bridge DB and the stub LLM,
// and the assertion is always "no item, no LLM call, no side effect".
import { afterEach, describe, expect, it } from 'vitest';

import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { releaseHeldItems } from '../../src/main/agent/stage0.ts';
import type { ItemCard } from '../../src/shared/types.ts';

const CHAT = '972550000003@s.whatsapp.net';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
        durationMin: 60,
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'Thursday 17:00 works', stopReason: 'end' } },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

async function allCards(harness: Harness): Promise<ItemCard[]> {
  const dash = await harness.invoke('dashboard:get', undefined);
  if (!dash.ok) throw new Error('no dashboard');
  return [...dash.value.needsReply, ...dash.value.infoMissing, ...dash.value.inCalendar];
}

/** The user has written in this chat before, so S0 treats the sender as known. */
async function knownChat(harness: Harness, jid = CHAT): Promise<void> {
  await harness.bridge.outboundFromPhone({ chatJid: jid, text: 'hey', ts: new Date(harness.clock.now() - 2 * HOUR) });
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. rows from before live_from_ts are context, never triggers
// ---------------------------------------------------------------------------------------------------------------------
describe('A14 - history older than the pairing window never triggers the agent', () => {
  it('a 300-row history sync from 40 days ago produces no item, no run and no LLM call', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    const base = h.clock.now() - 40 * DAY;
    await h.bridge.historySync(
      Array.from({ length: 300 }, (_, i) => ({
        chatJid: CHAT,
        text: i % 7 === 0 ? 'coffee Thursday at 5?' : `backlog message ${i}`,
        ts: new Date(base + i * 60_000),
        fromMe: i % 5 === 0,
      })),
    );
    await h.settle();

    expect(h.llm.calls).toHaveLength(0);
    expect(await allCards(h)).toHaveLength(0);
    expect(h.repos.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM runs').get()!.n).toBe(0);
    expect(h.bridge.sends).toHaveLength(0);
  });

  it('a row that lands exactly one millisecond before live_from_ts is context only', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    const liveFrom = Number(h.repos.meta.get('live_from_ts'));
    expect(Number.isFinite(liveFrom)).toBe(true);
    await knownChat(h);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?', ts: new Date(liveFrom - 1) });
    await h.settle();
    expect(h.llm.calls).toHaveLength(0);
    expect(await allCards(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. hostile / broken timestamps
// ---------------------------------------------------------------------------------------------------------------------
describe('A14 - a timestamp the app cannot trust is treated as backlog', () => {
  it('an unparseable timestamp never becomes a trigger', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    await knownChat(h);
    // The row lands in messages.db with a timestamp the parser cannot read.
    h.bridgeDb.addMessage({
      id: 'BAD-TS-0001',
      chatJid: CHAT,
      sender: '972550000003',
      content: 'coffee Thursday at 5?',
      timestamp: 'not-a-timestamp',
      fromMe: false,
    });
    await h.settle();

    expect(h.llm.calls).toHaveLength(0);
    expect(await allCards(h)).toHaveLength(0);
    expect(h.bridge.sends).toHaveLength(0);
  });

  it('a clock-skewed row from the future stays inside the live window and is never treated as ancient', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    await knownChat(h);
    await h.bridge.inbound({
      chatJid: CHAT,
      text: 'coffee Thursday at 5?',
      ts: new Date(h.clock.now() + 3 * DAY), // a phone with a badly set clock
    });
    await h.settle();

    const cards = await allCards(h);
    // Whatever the pipeline decides, the row must not be silently classified as a 10-day-old backlog message.
    for (const card of cards) expect(card.badges).not.toContain('older_message');
    expect(h.bridge.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. backlogHours is clamped to 0..72
// ---------------------------------------------------------------------------------------------------------------------
describe('A14 - backlogHours is clamped to 0-72', () => {
  it.each([
    ['negative', -1],
    ['absurd', 10_000],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('the renderer cannot set a %s backlogHours', async (_label, hours) => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    const before = h.repos.settings.get().whatsapp.backlogHours;
    const res = await h.invoke('settings:set', { whatsapp: { backlogHours: hours } } as never);
    expect(res.ok).toBe(false);
    expect(h.repos.settings.get().whatsapp.backlogHours).toBe(before);
    expect(before).toBeLessThanOrEqual(72);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('a hand-edited settings row with an out-of-range backlogHours falls back to the defaults', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    const raw = h.repos.db.prepare(`SELECT value_json FROM settings WHERE key='settings'`).get() as
      { value_json: string } | undefined;
    expect(raw).toBeDefined();
    const poisoned = JSON.parse(raw!.value_json) as { whatsapp: { backlogHours: number } };
    poisoned.whatsapp.backlogHours = 10_000;
    h.repos.db.prepare(`UPDATE settings SET value_json = ? WHERE key='settings'`).run(JSON.stringify(poisoned));

    // The repo re-validates on EVERY read, so a widened window never reaches the gate.
    const effective = h.repos.settings.get().whatsapp.backlogHours;
    expect(effective).toBeLessThanOrEqual(72);
    expect(effective).toBeGreaterThanOrEqual(0);
  });

  it('a 4-day-old message is backlog even when live_from_ts has to be recomputed from paired_at', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    const pairedAt = Number(h.repos.meta.get('paired_at'));
    h.repos.meta.set('live_from_ts', ''); // force the paired_at - clamp(backlogHours) path
    await knownChat(h);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?', ts: new Date(pairedAt - 4 * DAY) });
    await h.settle();
    expect(h.llm.calls).toHaveLength(0);
    expect(await allCards(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. [R2] re-pairing resets the window
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] A14 - re-pairing after an unlink resets paired_at / live_from_ts', () => {
  it('history-sync rows younger than 24 h but from the OLD session stay context only', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    await knownChat(h);

    const oldSessionAt = h.clock.now() - 6 * HOUR; // < 24 h old, but from before the re-pair
    // The user unlinked and paired again: both meta keys move forward (compose writes them on the QR -> connected edge).
    const rePairedAt = h.clock.now();
    h.repos.meta.set('paired_at', String(rePairedAt));
    h.repos.meta.set('live_from_ts', String(rePairedAt));
    h.repos.meta.set('bridge_rowid_watermark', '0');

    await h.bridge.historySync([
      { chatJid: CHAT, text: 'coffee Thursday at 5?', ts: new Date(oldSessionAt), fromMe: false },
      { chatJid: CHAT, text: 'and another one', ts: new Date(oldSessionAt + 60_000), fromMe: false },
    ]);
    await h.settle();

    expect(h.llm.calls, 'rows from the previous session are backlog, however recent').toHaveLength(0);
    expect(await allCards(h)).toHaveLength(0);
    expect(h.bridge.sends).toHaveLength(0);

    // A message that arrives AFTER the re-pair is live again.
    await h.advance(60_000);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await h.settle();
    expect((await allCards(h)).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. [R2] held items are not released to a cloud provider after the window
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] A14 - the 24 h release window for held items', () => {
  async function heldWaitingLlm(provider: 'claude' | 'local'): Promise<Harness> {
    const harness = await createHarness({
      rules: SCHEDULE_RULES,
      provider: provider === 'claude' ? 'claude' : 'local',
      profile: { cloudConsent: false },
    });
    h = harness;
    await knownChat(harness);
    await harness.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?' });
    await harness.settle();
    return harness;
  }

  it('a waiting_llm item older than 24 h is NOT released to a cloud provider: raw card, zero cloud calls', async () => {
    const harness = await heldWaitingLlm('claude');
    const before = await allCards(harness);
    expect(before[0]?.holdReason).toBe('waiting_llm');
    expect(harness.llm.calls).toHaveLength(0);

    // The consent is granted, but only after the release window has passed.
    await harness.advance(LIMITS.heldReleaseWindowMs + HOUR);
    const accepted = await harness.invoke('consent:accept', {
      kind: 'cloud_claude',
      version: (await import('../../src/shared/types.ts')).CONSENT_VERSIONS.cloud_claude,
    });
    expect(accepted.ok).toBe(true);
    await harness.settle();

    expect(harness.llm.calls, 'a week-old chat is never sent to a cloud model by itself').toHaveLength(0);
    const after = await allCards(harness);
    expect(after[0]?.card).toBe('raw');
    expect(harness.bridge.sends).toHaveLength(0);
  });

  it('the same item IS released to the local provider, because nothing leaves the machine', async () => {
    const harness = await heldWaitingLlm('claude');
    expect((await allCards(harness))[0]?.holdReason).toBe('waiting_llm');
    expect(harness.llm.calls).toHaveLength(0);

    await harness.advance(LIMITS.heldReleaseWindowMs + HOUR);
    // The user switches to the local model: the chat never leaves the machine, so the age cap does not apply.
    harness.repos.settings.setInternal((s) => {
      s.llm.provider = 'local';
    });
    const released = releaseHeldItems(harness.repos, { provider: 'local', now: harness.clock.now() });
    expect(released.length, 'every held item is released to Local, however old').toBe(1);
    await harness.settle();

    expect(harness.llm.calls.length, 'the local model may analyse an old held chat').toBeGreaterThan(0);
    expect(harness.bridge.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. the live window once the bridge has been online
// ---------------------------------------------------------------------------------------------------------------------
describe('A14 - the live window after the bridge has been online', () => {
  it('a 3-day-old message becomes an item, a 10-day-old one only an `older_message` raw card', async () => {
    h = await createHarness({ rules: SCHEDULE_RULES });
    // The bridge was online yesterday, so the 7-day live window of LIMITS.ingestMaxAgeMs applies.
    h.repos.meta.set('last_online_ts', String(h.clock.now() - DAY));
    h.repos.meta.set('live_from_ts', String(h.clock.now() - 30 * DAY));
    h.repos.meta.set('paired_at', String(h.clock.now() - 30 * DAY));
    // Leave the 120 s post-spawn history-sync window (ARCH 4.6), where the stricter 24 h cap applies instead.
    await h.advance(121_000);

    await knownChat(h);
    await h.bridge.inbound({ chatJid: CHAT, text: 'coffee Thursday at 5?', ts: new Date(h.clock.now() - 3 * DAY) });
    await h.settle();
    const threeDays = await allCards(h);
    expect(threeDays.length).toBeGreaterThan(0);
    expect(threeDays[0]!.badges).not.toContain('older_message');
    expect(LIMITS.ingestMaxAgeMs).toBe(7 * DAY);

    const other = '972550000004@s.whatsapp.net';
    await h.bridge.outboundFromPhone({ chatJid: other, text: 'hey', ts: new Date(h.clock.now() - 2 * HOUR) });
    await h.bridge.inbound({ chatJid: other, text: 'coffee Thursday at 5?', ts: new Date(h.clock.now() - 10 * DAY) });
    await h.settle();

    const olderCard = (await allCards(h)).find((c) => c.chat.chatRef !== threeDays[0]!.chat.chatRef);
    expect(olderCard, 'a 10-day-old message still surfaces, but only as a raw card').toBeDefined();
    expect(olderCard!.card).toBe('raw');
    expect(olderCard!.badges).toContain('older_message');
    // No model run for the ancient one.
    expect(h.bridge.sends).toHaveLength(0);
  });
});
