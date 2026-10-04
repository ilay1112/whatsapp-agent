// Verify editing-undo-8 (scratch, NOT part of npm test).
import { afterEach, describe, expect, it } from 'vitest';
import { makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig } from '../../../tests/helpers/ledger.execRig';
import { reconcileUnknown } from '../../../src/main/exec/reconcile';
import type { McpWriteClient } from '../../../src/main/mcp/writeClient';
import type { ApprovalAction } from '../../../src/shared/types';

const rigs: Rig[] = [];
afterEach(async () => { while (rigs.length) await rigs.pop()!.stop(); });
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const FRI = { startLocal: '2026-10-09T10:00:00', endLocal: '2026-10-09T11:00:00' };
const pendingOf = (r: Rig, itemId: number, kind: ApprovalAction['kind']) =>
  r.repos.actions.forItem(itemId as never).find((a) => a.kind === kind && a.state === 'pending');
function dropsThenTimesOut(tool: 'updateEvent', nth = 1): (w: McpWriteClient) => McpWriteClient {
  let n = 0;
  return (w) => new Proxy(w, { get(t, prop, recv) {
    const orig = Reflect.get(t, prop, recv) as unknown;
    if (prop !== tool || typeof orig !== 'function') return orig;
    return async (args: unknown) => { n += 1; if (n === nth) return { ok: false, error: 'timeout' };
      return (orig as (a: unknown) => Promise<unknown>).call(t, args); };
  } });
}

describe('editing-undo-8 verify', () => {
  it('trace', async () => {
    const r = await makeExecRig({ wrapWrite: dropsThenTimesOut('updateEvent', 1) }); rigs.push(r);
    const source = await r.createByClick({ slot: WED });
    const eventId = source.calendarEventId!;
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o1 = await r.click(d.action.id);
    console.log('first click', JSON.stringify(o1).slice(0, 120), r.repos.actions.byId(d.action.id)!.state);
    const clone = pendingOf(r, d.item.id, 'update_event')!;
    console.log('clone', clone.id, clone.retryOf, clone.itemId === d.item.id);
    const o2 = await r.click(clone.id);
    console.log('clone click', JSON.stringify(o2).slice(0, 120));
    console.log('newest rev', r.repos.eventRevisions.newestFor(eventId)!.revision,
      'source rev', r.repos.items.byId(source.id)!.eventRevision, 'delta rev', r.repos.items.byId(d.item.id)!.eventRevision);
    // 1) the executor's own startup pass (not wrapped in a catch in compose.ts)
    let t1: unknown = null;
    try { await r.exec.recoverOnStartup(); } catch (e) { t1 = e; }
    console.log('recoverOnStartup threw:', t1 instanceof Error ? t1.message : t1);
    // 2) a plain pass
    let t2: unknown = null;
    try { await reconcileUnknown({ repos: r.repos, bridgeDb: null, read: r.read, now: () => r.clock.now() as never, timeZone: () => 'Asia/Jerusalem' }); }
    catch (e) { t2 = e; }
    console.log('reconcileUnknown threw:', t2 instanceof Error ? t2.message : t2);
    console.log('original state', r.repos.actions.byId(d.action.id)!.state);
    // 3) later unknown rows are skipped: add another unknown update after it
    expect(t1 ?? t2).toBeNull();
  });
});
