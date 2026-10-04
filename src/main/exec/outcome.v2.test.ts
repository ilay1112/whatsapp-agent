// src/main/exec/outcome.v2.test.ts - C2 14 outcome transactions (owner V2-W1-04): the rev-1 create row (and its dedupe), and
// applyUpdateSuccess / commitUpdateDone against missing rows (a source or target item purged meanwhile) - they still record the
// revision and never invent an origin.
import { afterEach, describe, expect, it } from 'vitest';
import { applyCreateSuccess, applyUpdateSuccess, commitUpdateDone } from './outcome';
import { makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig } from '../../../tests/helpers/ledger.execRig';
import type { EpochMs, ItemId } from '../../shared/types';
import type { UpdateEventPayload } from '../../shared/schemas';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };

describe('applyCreateSuccess (v2 bookkeeping)', () => {
  it('writes the rev-1 row once per event id (a second confirmation of the same create adds nothing)', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const item = await r.createByClick({ slot: WED });
    const a = r.repos.actions.forItem(item.id).find((x) => x.kind === 'create_event')!;
    const payload = JSON.parse(a.canonicalJson) as Parameters<typeof applyCreateSuccess>[2];
    applyCreateSuccess(
      r.repos,
      a,
      payload,
      { kind: 'create_event', eventId: item.calendarEventId!, htmlLink: null },
      r.clock.now() as EpochMs,
    );
    const rows = r.db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM event_revisions WHERE calendar_event_id = ?`)
      .get(item.calendarEventId!)!.n;
    expect(rows).toBe(1);
  });
});

describe('applyUpdateSuccess / commitUpdateDone with rows gone', () => {
  it('a missing (purged) source keeps the acting item’s own origin and closes nothing', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const content = {
      title: 'Dentist',
      ...THU,
      timeZone: 'Asia/Jerusalem',
      location: '',
      status: 'confirmed' as const,
    };
    const rev = applyUpdateSuccess(
      r.repos,
      {
        actionId: d.action.id,
        itemId: d.item.id,
        sourceItemId: 99_999 as ItemId,
        eventId: source.calendarEventId!,
        revision: 2,
        kind: 'reschedule',
        prev: { ...content, ...WED },
        next: content,
        calendarUpdated: null,
        postEtag: null,
      },
      r.clock.now() as EpochMs,
    );
    expect(rev.revision).toBe(2);
    expect(r.repos.items.byId(d.item.id)).toMatchObject({ eventState: 'updated', eventOriginItemId: null });
  });
  it('commitUpdateDone with the target item purged uses the payload’s baseRevision + 1', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const a = r.repos.actions.byId(d.action.id)!;
    r.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, r.clock.now() as EpochMs, 'user');
    const p: UpdateEventPayload = { ...d.payload, targetItemId: 99_997 };
    const rb = (await r.read.getEvent('primary', source.calendarEventId!)) as {
      ok: true;
      value: Parameters<typeof commitUpdateDone>[3];
    };
    const rev = r.db.transaction(() =>
      commitUpdateDone(
        r.repos,
        r.repos.actions.byId(a.id)!,
        p,
        rb.value,
        { autoWriteId: null, extraReverts: [], auditKind: 'action_done' },
        r.clock.now() as EpochMs,
      ),
    );
    expect(rev.revision).toBe(2);
    expect(r.repos.actions.byId(a.id)!.state).toBe('done');
  });
});
