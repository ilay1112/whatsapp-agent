// Verify editing-undo-10: after a reconciled (done) create, is the timeout's pending create clone still offered?
import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig } from '../../../tests/helpers/ledger.execRig';
import { reconcileUnknown } from '../../../src/main/exec/reconcile';
import type { McpWriteClient } from '../../../src/main/mcp/writeClient';

const OUT = 'C:/dev/whatsapp agent/ops/agent-notes/v2-verify-editing-undo-10.scratch/out.txt';
const log = (...a: string[]): void => appendFileSync(OUT, a.join(' ') + '\n');
const rigs: Rig[] = [];
afterEach(async () => { while (rigs.length) await rigs.pop()!.stop(); });
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
function landsThenTimesOut(): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) => new Proxy(w, { get(t, prop, recv) {
    const orig = Reflect.get(t, prop, recv) as unknown;
    if (prop !== 'createEvent' || typeof orig !== 'function') return orig;
    return async (args: unknown) => { const res = await (orig as (a: unknown) => Promise<unknown>).call(t, args); n += 1; return n === 1 ? { ok: false, error: 'timeout' } : res; };
  } });
}

describe('eu10', () => {
  it('unedited create, reconciled done: pending clone survives', async () => {
    const r = await makeExecRig({ wrapWrite: landsThenTimesOut() });
    rigs.push(r);
    const { item, action } = r.seedCreate({ slot: WED });
    const res = await r.click(action.id);
    log('click', JSON.stringify(res).slice(0, 200));
    await reconcileUnknown({ repos: r.repos, bridgeDb: null, read: r.read, now: () => r.clock.now() as never, timeZone: () => 'Asia/Jerusalem' });
    const rows = r.repos.actions.forItem(item.id as never).map((a) => ({ kind: a.kind, state: a.state, attempt: a.attempt }));
    log('actions', JSON.stringify(rows));
    const it2 = r.repos.items.byId(item.id as never)!;
    log('item', JSON.stringify({ state: it2.state, eventState: it2.eventState, hasCal: it2.calendarEventId !== null }));
    const { createItemService } = await import('../../../src/main/agent/items');
    const noop = (): void => undefined;
    const svc = createItemService({ repos: r.repos, settings: () => r.settings, clock: { now: () => r.clock.now() as never, setTimeout: () => 0, clearTimeout: noop }, log: { info: noop, warn: noop, error: noop, debug: noop } as never, bridgeOnline: () => true, bridgeOutdated: () => false, calendarConnected: () => true, notifyChanged: noop, enqueueRetriage: noop, updatesAvailable: () => true });
    const d = svc.detail(item.id as never);
    if (!d.ok) throw new Error('detail');
    log('detail', JSON.stringify({ status: (d.value as unknown as { status: string }).status, eventState: d.value.eventState, actions: d.value.actions.map((a) => ({ kind: a.kind, state: a.state, attempt: a.attempt, dis: a.disabledReason })) }));
    const clone = r.repos.actions.forItem(item.id as never).find((a) => a.kind === 'create_event' && a.state === 'pending');
    if (clone) {
      const before = r.cal.storedEvents.length;
      const res2 = await r.click(clone.id);
      log('clone click', JSON.stringify(res2).slice(0, 300));
      log('events before/after', String(before), String(r.cal.storedEvents.length));
      const res3 = await r.click(clone.id, { confirmConflict: true } as never);
      log('clone confirm', JSON.stringify(res3).slice(0, 120));
      log('events after confirm', String(r.cal.storedEvents.length), JSON.stringify(r.repos.actions.forItem(item.id as never).map((a) => ({ kind: a.kind, state: a.state, attempt: a.attempt }))));
    }
    expect(true).toBe(true);
  });
});
