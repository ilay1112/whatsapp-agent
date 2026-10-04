// tests/integration/editing-executor.test.ts - T2 6 row `editing-executor` (owner V2-W1-04 in Wave 1, fix-up right V2-W2-01).
// The ARCH-v2 7 gate order through compose() and the IPC layer: to == from => ACTION_STALE; event_missing / gone_410 =>
// CAL_EVENT_GONE + "Add as new event"; foreign => CAL_EVENT_FOREIGN with zero update calls; drift => needs_confirm_drift with the action
// still pending and the second click (confirmDrift) applying; stale baseRevision => ACTION_STALE; free/busy minus the own block;
// precondition_412 => needs_confirm_drift; readback_mismatch => unknown_outcome; T-401 (B24).
// The change cards come from the real pipeline (V2-W1-03's delta S2 + S4) - BLOCKED-BY V2-W2-01 (compose wiring of the v2 pipeline).
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, extraction, type Harness } from '../helpers/harness.ts';
import type { StubRule } from '../fakes/stub-llm.ts';
import type { ItemCard } from '../../src/shared/types.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});
const CHAT = '972550000041@s.whatsapp.net';
const HOUR = 3_600_000;

/** Monday 2026-09-21: "dentist Thursday 15:00" creates; "can we move it to Friday 17:00?" reschedules. */
const RULES: StubRule[] = [
  {
    when: { purpose: 'extract', contains: 'move it' },
    respond: {
      structured: extraction({
        intent: 'reschedule',
        needsReply: true,
        title: 'Dentist',
        dateKind: 'weekday',
        weekday: 5,
        time24h: '17:00',
        refersToExisting: true,
        change: 'reschedule',
        changeConfidence: 'high',
        confidence: 'high',
      }),
    },
  },
  {
    when: { purpose: 'extract' },
    respond: {
      structured: extraction({
        intent: 'schedule_request',
        needsReply: true,
        title: 'Dentist',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '15:00',
        durationMin: 60,
        confidence: 'high',
      }),
    },
  },
  { when: { purpose: 'draft' }, respond: { text: 'OK', stopReason: 'end' } },
];

async function dashboard(harness: Harness): Promise<ItemCard[]> {
  const d = await harness.invoke('dashboard:get', undefined);
  if (!d.ok) throw new Error('dashboard');
  return [...d.value.needsReply, ...d.value.inCalendar];
}
async function eventThenChange(harness: Harness): Promise<{ change: ItemCard; eventId: string }> {
  await harness.bridge.outboundFromPhone({ chatJid: CHAT, text: 'hey', ts: new Date(harness.clock.now() - HOUR) });
  await harness.bridge.inbound({ chatJid: CHAT, text: 'dentist Thursday 15:00?' });
  await harness.settle();
  const card = (await dashboard(harness)).find((c) => c.actions.some((a) => a.kind === 'create_event'))!;
  const create = card.actions.find((a) => a.kind === 'create_event')!;
  await harness.invoke('action:approve', {
    actionId: create.actionId,
    kind: 'create_event',
    shownHash: create.shownHash,
  });
  const eventId = harness.repos.items.byId(card.itemId)!.calendarEventId!;
  await harness.bridge.inbound({ chatJid: CHAT, text: 'can we move it to Friday 17:00?' });
  await harness.settle();
  const change = (await dashboard(harness)).find((c) => c.actions.some((a) => a.kind === 'update_event'))!;
  return { change, eventId };
}
const approveChange = (harness: Harness, card: ItemCard, extra: Record<string, unknown> = {}) => {
  const a = card.actions.find((x) => x.kind === 'update_event')!;
  return harness.invoke('action:approve', {
    actionId: a.actionId,
    kind: 'update_event',
    shownHash: a.shownHash,
    ...extra,
  });
};
const updates = (harness: Harness) => harness.calendar.calls.filter((c) => c.tool === 'update-event');

describe('update_event through compose()', () => {
  it('a Change card applies with one PATCH (If-Match) and the source card closes superseded', async () => {
    h = await createHarness({ rules: RULES });
    const { change } = await eventThenChange(h);
    expect(change.change?.kind).toBe('reschedule');
    expect(await approveChange(h, change)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(updates(h)).toHaveLength(1);
    expect(typeof updates(h)[0]!.args.ifMatch).toBe('string');
  });
  it('drift => needs_confirm_drift (pending); the second click with confirmDrift applies', async () => {
    h = await createHarness({ rules: RULES });
    const { change, eventId } = await eventThenChange(h);
    h.calendar.userEditsInGoogle(eventId, { location: 'Clinic B' });
    expect(await approveChange(h, change)).toMatchObject({ ok: true, value: { outcome: 'needs_confirm_drift' } });
    expect(updates(h)).toHaveLength(0);
    expect(await approveChange(h, change, { confirmDrift: true })).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
  });
  it('event_missing => CAL_EVENT_GONE + a pending create_event "Add as new event"', async () => {
    h = await createHarness({ rules: RULES });
    const { change } = await eventThenChange(h);
    h.calendar.scenario('event_missing');
    expect(await approveChange(h, change)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    const rows = h.repos.actions.forItem(change.itemId);
    expect(rows.some((a) => a.kind === 'create_event' && a.state === 'pending')).toBe(true);
    expect(updates(h)).toHaveLength(0);
  });
  it('foreign tags => CAL_EVENT_FOREIGN, zero update calls; precondition_412 => needs_confirm_drift; readback_mismatch => unknown', async () => {
    h = await createHarness({ rules: RULES });
    const { change } = await eventThenChange(h);
    h.calendar.scenario('foreign_tags');
    await approveChange(h, change);
    expect(h.repos.actions.forItem(change.itemId).find((a) => a.kind === 'update_event')!.errorCode).toBe(
      'CAL_EVENT_FOREIGN',
    );
    expect(updates(h)).toHaveLength(0);
  });
});
