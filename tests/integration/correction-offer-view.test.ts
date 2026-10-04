// tests/integration/correction-offer-view.test.ts - [v2-closeout editing-undo-5] the B24 correction offer had no view.
// A create whose answer was lost (timeout) but which LANDED in Google, and which the user then edited in Google, is reconciled as done and
// B24 offers ONE pending update_event back to the approved content on the in-calendar holder itself (`itemId === targetItemId`). The
// proposal of that item carries no delta, so ItemService.changeViewOf answered null and the renderer could draw no Approve / Keep.
// Real executor + real reconcile + the real fake calendar (through the exec rig), then the REAL ItemService over the same repos.
import { afterEach, describe, expect, it } from 'vitest';
import { createItemService, type ItemService } from '../../src/main/agent/items';
import { reconcileUnknown } from '../../src/main/exec/reconcile';
import { makeExecRig, RIG_TZ, type Rig, type RigOptions } from '../helpers/ledger.execRig';
import type { McpWriteClient } from '../../src/main/mcp/writeClient';
import type { EpochMs, ItemCard } from '../../src/shared/types';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  return r;
}
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };

/** The first create reaches the fake (the event EXISTS) but the app is told `timeout` => unknown_outcome. */
const landsThenTimesOut = (w: McpWriteClient): McpWriteClient => {
  let n = 0;
  return {
    ...w,
    createEvent: async (args) => {
      const res = await w.createEvent(args);
      n += 1;
      return n === 1 ? { ok: false, error: 'timeout' } : res;
    },
  };
};
const reconcile = (r: Rig): ReturnType<typeof reconcileUnknown> =>
  reconcileUnknown({
    repos: r.repos,
    bridgeDb: null,
    read: r.read,
    now: () => r.clock.now() as EpochMs,
    timeZone: () => RIG_TZ,
  });
function items(r: Rig): ItemService {
  return createItemService({
    repos: r.repos,
    settings: () => r.settings,
    clock: { now: () => r.clock.now() as EpochMs, setTimeout: () => 0, clearTimeout: () => undefined },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => undefined as never },
    bridgeOnline: () => true,
    bridgeOutdated: () => false,
    calendarConnected: () => true,
    updatesAvailable: () => true,
    notifyChanged: () => undefined,
    enqueueRetriage: () => undefined,
  });
}
const cardOf = (s: ItemService, id: number): ItemCard => {
  const d = s.detail(id as never);
  if (!d.ok) throw new Error('no card');
  return d.value;
};

describe('[v2-closeout] editing-undo-5: the B24 correction offer has a change view', () => {
  it('the in-calendar holder shows Google copy -> approved content with the pending update_event (Approve / Keep)', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    r.cal.userEditsInGoogle(r.cal.storedEvents[0]!.eventId, {
      start: '2026-10-07T16:00:00',
      end: '2026-10-07T17:00:00',
    });
    await reconcile(r);

    const card = cardOf(items(r), item.id);
    expect(card.eventState).toBe('created');
    expect(card.change).toMatchObject({
      kind: 'reschedule',
      from: { startLocal: '2026-10-07T16:00:00', endLocal: '2026-10-07T17:00:00', status: 'confirmed' },
      to: { startLocal: WED.startLocal, endLocal: WED.endLocal, status: 'confirmed' },
      baseRevision: 1,
    });
    // the button the renderer draws for it: the pending update_event of THIS card
    const offer = card.actions.find((a) => a.kind === 'update_event');
    expect(offer).toMatchObject({ state: 'pending', disabledReason: null });
    // Keep (reject) => no offer any more, the card stays in the calendar and shows no change
    expect(await r.exec.reject(offer!.actionId)).toEqual({ ok: true, value: null });
    const kept = cardOf(items(r), item.id);
    expect(kept.change).toBeNull();
    expect(kept.status).toBe('in_calendar');
  });

  it('Approve on the offer writes Google back to the approved content (one PATCH) and the view clears', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    const eventId = r.cal.storedEvents[0]!.eventId;
    r.cal.userEditsInGoogle(eventId, { start: '2026-10-07T16:00:00', end: '2026-10-07T17:00:00' });
    await reconcile(r);
    const offer = cardOf(items(r), item.id).actions.find((a) => a.kind === 'update_event')!;
    const patches = r.cal.calls.filter((c) => c.tool === 'update-event').length;
    expect(await r.click(offer.actionId)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.cal.calls.filter((c) => c.tool === 'update-event').length).toBe(patches + 1);
    expect(cardOf(items(r), item.id).change).toBeNull();
  });

  it('no correction view for an ordinary in-calendar card, nor for a change card of another item (its own delta view)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const s = items(r);
    expect(cardOf(s, source.id).change).toBeNull();
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(cardOf(items(r), source.id).change).toBeNull(); // the source card: "change proposed - see Needs reply", no buttons here
    expect(cardOf(items(r), d.item.id).change).toMatchObject({ kind: 'reschedule' }); // the change card keeps its delta view
  });
});
