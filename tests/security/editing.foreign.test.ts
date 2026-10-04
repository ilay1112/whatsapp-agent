// tests/security/editing.foreign.test.ts - T2 8.2 group 22 (I9 "never touch foreign events"), the CLICK path: every foreign variant
// (missing tag, a waItem other than the chain root, an origin item of another chat, the acting item's own id, an unlinked change card,
// neither creator nor organizer self, attendees, recurrence, a recurring instance) ends the approval CAL_EVENT_FOREIGN with ZERO
// update-event calls and no retry clone; a cancelled copy is CAL_EVENT_GONE; an `updated` drift is the drift question. The ledger's
// rule 9 (never foreign) and the fake's `update_on_foreign_event` net run after every test.
import { afterEach, describe, expect, it } from 'vitest';
import { makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';

const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const EVENT = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';
async function rig(): Promise<Rig> {
  const r = await makeExecRig();
  rigs.push(r);
  r.attachLedger();
  return r;
}
const updates = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');

type Variant = {
  name: string;
  arrange: (r: Rig) => { itemId: number; actionId: string };
  code: 'CAL_EVENT_FOREIGN' | 'CAL_EVENT_GONE';
};
const heldDelta = (r: Rig, held: Parameters<Rig['seedHeldEvent']>[0]) => {
  const source = r.seedHeldEvent(held);
  const d = r.seedDelta({ source, change: 'reschedule', to: THU });
  return { itemId: d.item.id, actionId: d.action.id };
};

const VARIANTS: Variant[] = [
  { name: 'missing app tags', arrange: (r) => heldDelta(r, { eventId: EVENT, tags: null }), code: 'CAL_EVENT_FOREIGN' },
  {
    name: 'waItem of another item than the chain root',
    arrange: (r) => heldDelta(r, { eventId: EVENT, tags: { waAgent: '1', waItem: '424242', waAction: 'root-x' } }),
    code: 'CAL_EVENT_FOREIGN',
  },
  {
    name: 'an origin item of another chat',
    arrange: (r) => {
      const other = r.seedHeldEvent({ chatN: 9, eventId: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' });
      const source = r.seedHeldEvent({
        eventId: EVENT,
        tags: { waAgent: '1', waItem: String(other.id), waAction: 'root-y' },
      });
      r.repos.items.update(source.id, { eventOriginItemId: other.id }, r.clock.now() as never);
      const d = r.seedDelta({ source, change: 'reschedule', to: THU });
      return { itemId: d.item.id, actionId: d.action.id };
    },
    code: 'CAL_EVENT_FOREIGN',
  },
  {
    name: "the acting item's own id as waItem",
    arrange: (r) => {
      const source = r.seedHeldEvent({ eventId: EVENT });
      const d = r.seedDelta({ source, change: 'reschedule', to: THU });
      const ev = r.cal.fake.events.find((e) => e.id === EVENT)!;
      ev.extendedProperties = { private: { ...ev.extendedProperties!.private!, waItem: String(d.item.id) } };
      return { itemId: d.item.id, actionId: d.action.id };
    },
    code: 'CAL_EVENT_FOREIGN',
  },
  {
    name: 'an unlinked change card (linked_item_id NULL)',
    arrange: (r) => {
      const source = r.seedHeldEvent({ eventId: EVENT });
      const d = r.seedDelta({ source, change: 'reschedule', to: THU });
      r.repos.items.update(d.item.id, { linkedItemId: null }, r.clock.now() as never);
      return { itemId: d.item.id, actionId: d.action.id };
    },
    code: 'CAL_EVENT_FOREIGN',
  },
  {
    name: 'creatorSelf = false && organizerSelf = false',
    arrange: (r) => heldDelta(r, { eventId: EVENT, creatorSelf: false, organizerSelf: false }),
    code: 'CAL_EVENT_FOREIGN',
  },
  { name: 'attendees', arrange: (r) => heldDelta(r, { eventId: EVENT, attendees: true }), code: 'CAL_EVENT_FOREIGN' },
  { name: 'recurrence', arrange: (r) => heldDelta(r, { eventId: EVENT, recurrence: true }), code: 'CAL_EVENT_FOREIGN' },
  {
    name: 'a recurring instance (recurringEventId)',
    arrange: (r) => heldDelta(r, { eventId: EVENT, recurringEventId: true }),
    code: 'CAL_EVENT_FOREIGN',
  },
  {
    name: "status 'cancelled'",
    arrange: (r) => heldDelta(r, { eventId: EVENT, status: 'cancelled' }),
    code: 'CAL_EVENT_GONE',
  },
];

describe('foreign variants on the click path => zero update-event calls, no clone', () => {
  for (const v of VARIANTS) {
    it(`${v.name} => ${v.code}`, async () => {
      const r = await rig();
      const { itemId, actionId } = v.arrange(r);
      const res = await r.click(actionId);
      expect(res).toMatchObject({ ok: true, value: { outcome: 'failed' } });
      expect(r.repos.actions.byId(actionId as never)).toMatchObject({ state: 'failed', errorCode: v.code });
      expect(r.repos.actions.forItem(itemId as never).filter((a) => a.retryOf === actionId)).toEqual([]);
      expect(updates(r)).toHaveLength(0);
    });
  }
  it('an `updated` drift in Google => the drift question (pending), never a silent overwrite', async () => {
    const r = await rig();
    const source = r.seedHeldEvent({ eventId: EVENT });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    r.cal.userEditsInGoogle(EVENT, { start: '2026-10-07T15:30:00', end: '2026-10-07T16:30:00' });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'needs_confirm_drift' } });
    expect(r.repos.actions.byId(d.action.id)!.state).toBe('pending');
    expect(updates(r)).toHaveLength(0);
  });
  it('control: the same seeded event with our own tags IS editable (the variants above are the only difference)', async () => {
    const r = await rig();
    const source = r.seedHeldEvent({ eventId: EVENT });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const a = r.repos.actions.byId(d.action.id)!;
    // stop short of the PATCH: the pre-flight passes every ownership check and the action reaches the conflict / rate stage
    r.repos.rate.record('create_global', 'global', r.clock.now() as never);
    for (let i = 0; i < 20; i++) r.repos.rate.record('create_global', 'global', r.clock.now() as never);
    expect(await r.click(a.id)).toEqual({ ok: false, error: { code: 'RATE_LIMIT_CREATE' } });
    expect(updates(r)).toHaveLength(0);
  });
});
