// tests/security/retention-event-origin.test.ts - I9 / F27 x the 90-day closed-item retention rule ([v2-fix-src-main-db],
// data-integrity-v4-3). An event the app created and then rescheduled is held by the change card; the source card is closed
// 'superseded' and is the event's ORIGIN (its id is the event's waItem tag). The daily purge used to delete that origin 90 days
// later while the event was still live (the horizon is 12 months): FK ON DELETE SET NULL nulled the holder's event_origin_item_id,
// so Cancel event / reschedule / undo of the app's OWN event ended CAL_EVENT_FOREIGN forever. The full click path through the real
// executor, the fake calendar and the ledger (rule 9 "never foreign") proves the event stays editable after the purge.
// Synthetic data only: fake JIDs and event ids from the rig, no message text.
import { afterEach, describe, expect, it } from 'vitest';
import { CTX, makeExecRig, stopRigsChecked } from '../helpers/ledger.execRig.ts';
import type { Rig } from '../helpers/ledger.execRig.ts';

const DAY = 24 * 3600_000;
const rigs: Rig[] = [];
afterEach(() => stopRigsChecked(rigs));
async function rig(): Promise<Rig> {
  const r = await makeExecRig();
  rigs.push(r);
  r.attachLedger();
  return r;
}
// far enough ahead that the event is still live after the 90-day closed-item horizon
const FAR_A = { startLocal: '2027-03-10T15:00:00', endLocal: '2027-03-10T16:00:00' };
const FAR_B = { startLocal: '2027-03-11T17:00:00', endLocal: '2027-03-11T18:00:00' };

describe('I9 x retention: a superseded origin card that ages out does not make the live event foreign', () => {
  it('Cancel event still works on the holder after the daily purge ran 91 days later', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: FAR_A });
    const d = r.seedDelta({ source, change: 'reschedule', to: FAR_B });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.repos.items.byId(source.id)!.closedReason).toBe('superseded');
    expect(r.repos.items.byId(d.item.id)!.eventOriginItemId).toBe(source.id);

    await r.clock.advance(91 * DAY);
    const now = r.clock.now();
    r.repos.retention.purge({ before: now - 30 * DAY, closedBefore: now - 90 * DAY });

    expect(r.repos.items.byId(source.id)).not.toBeNull(); // the origin is kept while the holder needs it
    const holder = r.repos.items.byId(d.item.id)!;
    expect(holder.state).toBe('in_calendar');
    expect(holder.eventOriginItemId).toBe(source.id);

    const res = await r.exec.cancelEvent(holder.id, CTX);
    expect(res.ok ? res.value.outcome : res.error.code).toBe('done');
    expect(r.repos.items.byId(holder.id)!.errorCode).toBeNull();
    expect(r.stored(holder.calendarEventId!)!.status).not.toBe('confirmed');
  });
});
