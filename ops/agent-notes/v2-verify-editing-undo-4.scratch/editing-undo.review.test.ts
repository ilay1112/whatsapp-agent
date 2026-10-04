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

describe('verify editing-undo-4', () => {
  it('refused undo (calendar disconnected) moves the card proposal to the restore target', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const holder = itemOf(r, d.item.id);
    const before = r.repos.proposals.current(holder.id)?.event?.startLocal ?? null;
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    r.flags.calendarConnected = false;
    const u = await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    const after = itemOf(r, d.item.id);
    const shown = r.repos.proposals.current(after.id)!.event!.startLocal;
    const pend = pendingOf(r, after.id, 'update_event');
    console.log('VERIFY1', JSON.stringify({ u, before, shown, google: r.stored(eventId), eventState: after.eventState, state: after.state, pendingUndo: pend?.state, candSame: r.repos.eventRevisions.undoCandidate(eventId)?.id === cand.id }));
    r.flags.calendarConnected = true;
    const u2 = await r.exec.undoChange(d.item.id, cand.id, 'user', CTX);
    console.log('VERIFY2', JSON.stringify({ u2ok: u2.ok, outcome: u2.ok ? u2.value.outcome : u2.error, google: r.stored(eventId), shown2: r.repos.proposals.current(after.id)!.event!.startLocal }));
    expect(shown).toBe(THU.startLocal);
  });
});
