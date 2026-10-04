// src/main/exec/actionExecutor.repairs.test.ts - v2-repair-v2-main-defects (phase 3 repair round), on the shared exec rig.
// REQUEST 2: auto:changed (notifyAuto) after a click-approved create completes (the B7 track record moved) and after EVERY decision
//            tryAuto records (the shadow tally moved) - not only when the policy itself changed.
// REQUEST 3: after Undo of a manual reschedule the reverted state becomes the card's state (UX2 3.4): the new proposal version the
//            undo inserts carries the RESTORED slot, not the slot it undid.
import { afterEach, describe, expect, it } from 'vitest';
import { CTX, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';

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

describe('REQUEST 2 - notifyAuto (=> auto:changed) whenever AutoState can have moved', () => {
  it('a click-approved create that completes notifies (track record), a refused click does not', async () => {
    const r = await rig();
    const c = r.seedCreate({ chatN: 3, slot: THU });
    expect(r.notices).toHaveLength(0);
    const res = await r.click(c.action.id);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.notices).toEqual([{ kind: 'policy' }]);
    // a stale click (already done) changes nothing => no notice
    await r.click(c.action.id);
    expect(r.notices).toHaveLength(1);
  });

  it('a click-approved reply never notifies (it is not part of the track record)', async () => {
    const r = await rig();
    const c = r.seedCreate({ chatN: 3, slot: THU });
    const reply = r.repos.actions.insertPending({
      itemId: c.item.id,
      proposalId: c.action.proposalId,
      chatId: c.item.chatId,
      payload: {
        v: 1,
        kind: 'send_reply',
        itemId: c.item.id,
        chatRef: c.item.chatId,
        proposalVersion: c.payload.proposalVersion,
        text: 'See you then',
      },
      now: r.clock.now() as never,
    });
    const before = r.notices.length;
    const p = r.click(reply.id);
    await r.clock.advance(60_000);
    await p;
    expect(r.notices).toHaveLength(before);
  });

  it('every decision tryAuto records notifies - a shadow decision (tally) and a fallback decision', async () => {
    const r = await rig();
    await r.trackRecord();
    r.policy('shadow');
    r.notices.length = 0;
    const c = r.seedCreate({ chatN: 4, slot: THU });
    const out = await r.exec.tryAuto(c.action.id);
    expect(out).toMatchObject({ verdict: 'shadow' });
    expect(r.notices).toEqual([{ kind: 'policy' }]);
    const u = r.seedCreate({ chatN: 5, slot: THU, proposal: { provider: 'user' } });
    expect(await r.exec.tryAuto(u.action.id)).toMatchObject({ verdict: 'fallback', reason: 'provider_unsafe' });
    expect(r.notices).toEqual([{ kind: 'policy' }, { kind: 'policy' }]);
  });

  it('no policy => no decision recorded => no notice', async () => {
    const r = await rig();
    const c = r.seedCreate({ chatN: 4, slot: THU });
    expect(await r.exec.tryAuto(c.action.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
    expect(r.notices).toHaveLength(0);
  });
});

describe('REQUEST 3 - Undo of a manual reschedule: the reverted state becomes the card state', () => {
  it('the undo proposal carries the restored slot; the calendar and the item agree', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const holder = r.repos.items.byId(d.item.id)!;
    const cand = r.repos.eventRevisions.undoCandidate(holder.calendarEventId!)!;
    const res = await r.exec.undoChange(holder.id, cand.id, 'user', CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const after = r.repos.items.byId(holder.id)!;
    const proposal = r.repos.proposals.current(after.id)!;
    expect(proposal.provider).toBe('user');
    expect(proposal.event).toMatchObject({ startLocal: WED.startLocal, endLocal: WED.endLocal, title: 'Dentist' });
    expect(r.stored(after.calendarEventId!)).toBeDefined();
  });

  it('Cancel event keeps the current content on the card (only the status changes)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const before = r.repos.proposals.current(source.id)!.event;
    const res = await r.exec.cancelEvent(source.id, CTX);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.repos.proposals.current(source.id)!.event).toEqual(before);
  });
});
