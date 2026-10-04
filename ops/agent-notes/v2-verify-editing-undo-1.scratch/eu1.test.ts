// Adversarial review "editing-undo" - failing tests that prove findings (scratch, NOT part of npm test).
// Each `it` asserts the CORRECT behaviour; a red result is the finding.
import { afterEach, describe, expect, it } from 'vitest';
import { CTX, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import { reconcileUnknown } from '../../../src/main/exec/reconcile';
import type { McpWriteClient } from '../../../src/main/mcp/writeClient';
import type { ApprovalAction, Item } from '../../../src/shared/types';

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
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;
const pendingOf = (r: Rig, itemId: number, kind: ApprovalAction['kind']): ApprovalAction | undefined =>
  r.repos.actions.forItem(itemId as never).find((a) => a.kind === kind && a.state === 'pending');

/** the n-th call of `tool` reaches the fake (the side effect HAPPENS) but the app is told `timeout` */
function landsThenTimesOut(tool: 'createEvent' | 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) =>
    new Proxy(w, {
      get(target, prop, recv) {
        const orig = Reflect.get(target, prop, recv) as unknown;
        if (prop !== tool || typeof orig !== 'function') return orig;
        return async (args: unknown) => {
          const res = await (orig as (a: unknown) => Promise<unknown>).call(target, args);
          n += 1;
          return n === nth ? { ok: false, error: 'timeout' } : res;
        };
      },
    });
}
/** the n-th call of `tool` never reaches the fake (nothing happens) and the app is told `timeout` */
function dropsThenTimesOut(tool: 'createEvent' | 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) =>
    new Proxy(w, {
      get(target, prop, recv) {
        const orig = Reflect.get(target, prop, recv) as unknown;
        if (prop !== tool || typeof orig !== 'function') return orig;
        return async (args: unknown) => {
          n += 1;
          if (n === nth) return { ok: false, error: 'timeout' };
          return (orig as (a: unknown) => Promise<unknown>).call(target, args);
        };
      },
    });
}

describe('editing-undo-1 (T-401): an EDITED retry of a create whose first attempt landed', () => {
  it('must not leave two events in the calendar', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    const first = await r.click(action.id);
    expect(first).toMatchObject({ ok: true, value: { outcome: 'failed' } }); // unknown_outcome, the event DID land
    expect(r.repos.actions.byId(action.id)!.state).toBe('unknown_outcome');
    const clone = pendingOf(r, item.id, 'create_event')!;
    expect(clone).toBeDefined();
    // the user edits the time on the card and clicks "Add again" (same session, no restart, no reconcile in between)
    const again = await r.click(clone.id, {
      edit: { title: 'Dentist', startLocal: FRI.startLocal, endLocal: FRI.endLocal, location: '' },
    });
    expect(again).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const live = r.cal.storedEvents.filter((e) => e.status === 'confirmed' && e.priv.waAgent === '1');
    // T-401 / research 4.4: the edited retry of a found create must become an update_event of THAT event
    expect(live).toHaveLength(1);
  });
});

describe('verify: the second create is a real write, the card state, and an unedited retry', () => {
  it('logs the event set after an edited retry', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    console.log('item after unknown', JSON.stringify(itemOf(r, item.id)));
    const clone = pendingOf(r, item.id, 'create_event')!;
    const again = await r.click(clone.id, { edit: { title: 'Dentist', startLocal: FRI.startLocal, endLocal: FRI.endLocal, location: '' } });
    console.log('again', JSON.stringify(again).slice(0, 300));
    console.log('events', JSON.stringify(r.cal.storedEvents.map((e) => ({ id: e.id, s: e.start, st: e.status, p: e.priv }))));
  });
  it('unedited retry stays single', async () => {
    const r = await rig({ wrapWrite: landsThenTimesOut('createEvent') });
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    const clone = pendingOf(r, item.id, 'create_event')!;
    const again = await r.click(clone.id);
    expect(again).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.cal.storedEvents.filter((e) => e.status === 'confirmed')).toHaveLength(1);
  });
});
