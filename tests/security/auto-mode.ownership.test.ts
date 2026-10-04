// tests/security/auto-mode.ownership.test.ts - T2 8.2 group 22 (I9), the AUTOMATIC path: with a live `on` policy and an otherwise
// eligible change, every foreign variant falls back with its reason (not_app_event, wrong_item, not_own_copy, event_has_attendees,
// event_cancelled, modified_in_google) and ZERO update-event calls; an automatic write to a calendar the user does not own is
// calendar_not_owned; the control (our own untouched event) IS written. Rule 9 of the ledger runs after every test.
import { afterEach, describe, expect, it } from 'vitest';
import { makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';
import type { AutoReason } from '../../src/shared/types.ts';

const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const EVENT = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

async function onRig(role: 'owner' | 'writer' | 'reader' | null = 'owner'): Promise<Rig> {
  const r = await makeExecRig({ role });
  rigs.push(r);
  await r.trackRecord();
  r.policy('on');
  r.attachLedger();
  return r;
}
const updates = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');
async function autoOn(
  r: Rig,
  held: Parameters<Rig['seedHeldEvent']>[0],
  mutate?: (r: Rig, itemId: number) => void,
): Promise<AutoReason | 'none'> {
  const source = r.seedHeldEvent(held);
  const d = r.seedDelta({ source, change: 'reschedule', to: THU });
  mutate?.(r, d.item.id);
  return (await r.exec.tryAuto(d.action.id)).reason;
}

describe('foreign variants => fallback, zero update-event calls', () => {
  const cases: Array<[string, Parameters<Rig['seedHeldEvent']>[0], AutoReason, ((r: Rig, itemId: number) => void)?]> = [
    ['missing app tag', { eventId: EVENT, tags: null }, 'not_app_event'],
    [
      'waItem of another item',
      { eventId: EVENT, tags: { waAgent: '1', waItem: '424242', waAction: 'root-x' } },
      'wrong_item',
    ],
    [
      'the acting item’s own id as waItem',
      { eventId: EVENT },
      'wrong_item',
      (r, itemId) => {
        const ev = r.cal.fake.events.find((e) => e.id === EVENT)!;
        ev.extendedProperties = { private: { ...ev.extendedProperties!.private!, waItem: String(itemId) } };
      },
    ],
    [
      'an unlinked change card',
      { eventId: EVENT },
      'wrong_item',
      (r, itemId) => void r.repos.items.update(itemId as never, { linkedItemId: null }, r.clock.now() as never),
    ],
    [
      'creatorSelf=false && organizerSelf=false',
      { eventId: EVENT, creatorSelf: false, organizerSelf: false },
      'not_own_copy',
    ],
    ['attendees', { eventId: EVENT, attendees: true }, 'event_has_attendees'],
    ['recurrence', { eventId: EVENT, recurrence: true }, 'event_has_attendees'],
    ['recurringEventId', { eventId: EVENT, recurringEventId: true }, 'event_has_attendees'],
    ["status 'cancelled'", { eventId: EVENT, status: 'cancelled' }, 'event_cancelled'],
    ['no recorded baseline (F5)', { eventId: EVENT, withBaseline: false }, 'modified_in_google'],
    [
      '`updated` drift',
      { eventId: EVENT },
      'modified_in_google',
      (r) => r.cal.userEditsInGoogle(EVENT, { location: 'Changed in Google' }),
    ],
  ];
  for (const [name, held, reason, mutate] of cases) {
    it(`${name} => ${reason}`, async () => {
      const r = await onRig();
      expect(await autoOn(r, held, mutate)).toBe(reason);
      expect(updates(r)).toHaveLength(0);
    });
  }
  it('an origin item of another chat => wrong_item', async () => {
    const r = await onRig();
    const other = r.seedHeldEvent({ chatN: 9, eventId: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' });
    const source = r.seedHeldEvent({
      eventId: EVENT,
      tags: { waAgent: '1', waItem: String(other.id), waAction: 'root-y' },
    });
    r.repos.items.update(source.id, { eventOriginItemId: other.id }, r.clock.now() as never);
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect((await r.exec.tryAuto(d.action.id)).reason).toBe('wrong_item');
    expect(updates(r)).toHaveLength(0);
  });
});

describe('the calendar must be owned for an automatic write', () => {
  for (const role of ['writer', 'reader', null] as const) {
    it(`accessRole ${String(role)} => calendar_not_owned, zero writes`, async () => {
      const r = await onRig(role);
      const c = r.seedCreate({ chatN: 1, slot: WED });
      expect((await r.exec.tryAuto(c.action.id)).reason).toBe('calendar_not_owned');
      expect(r.cal.calls.filter((x) => x.tool === 'create-event')).toHaveLength(3); // the track record only
    });
  }
});

describe('control', () => {
  it('our own untouched app event IS changed automatically (one PATCH, the full private map, If-Match)', async () => {
    const r = await onRig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.exec.tryAuto(d.action.id)).toMatchObject({ verdict: 'auto', result: 'done' });
    expect(updates(r)).toHaveLength(1);
    expect(updates(r)[0]!.args).toMatchObject({ sendUpdates: 'none', checkConflicts: false });
  });
});
