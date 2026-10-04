// src/main/ipc/handlers/actions.v2.test.ts - T2 5 row ipc/handlers/actions (v2): action:approve carries update_event approvals and the
// confirmDrift flag UNCHANGED to the executor (which honours it only after a needs_confirm_drift outcome), keeps the window gate, and
// re-reads the card after a needs_confirm_drift outcome too. End to end against the real executor + the fake calendar.
import { afterEach, describe, expect, it } from 'vitest';
import { createActionsHandlers } from './actions';
import { CTX, makeExecRig } from '../../../../tests/helpers/ledger.execRig';
import type { Rig } from '../../../../tests/helpers/ledger.execRig';
import type { HandlerDeps } from '../register';
import type { ItemDetail, Result } from '../../../shared/types';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});

async function setup() {
  const r = await makeExecRig();
  rigs.push(r);
  const deps = {
    repos: r.repos,
    executor: r.exec,
    clock: r.clock,
    audit: () => undefined,
    log: { warn: () => undefined },
    items: {
      detail: (id: number): Result<ItemDetail> => ({
        ok: true,
        value: { itemId: id, fresh: true } as unknown as ItemDetail,
      }),
    },
  } as unknown as HandlerDeps;
  return { r, h: createActionsHandlers(deps) };
}

describe('action:approve for update_event', () => {
  it('drift question, then "Apply anyway" with confirmDrift:true through the handler', async () => {
    const { r, h } = await setup();
    const source = await r.createByClick({
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    const d = r.seedDelta({
      source,
      change: 'reschedule',
      to: { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' },
    });
    r.cal.userEditsInGoogle(source.calendarEventId!, { location: 'Moved room' });
    const a = r.repos.actions.byId(d.action.id)!;
    const req = { actionId: a.id, kind: 'update_event' as const, shownHash: a.contentSha256 };
    expect(await h['action:approve'](req, CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'needs_confirm_drift', current: { location: 'Moved room' }, item: { fresh: true } },
    });
    expect(await h['action:approve']({ ...req, confirmDrift: true }, CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(r.updateCalls()).toHaveLength(1);
  });
  it('an unfocused window never reaches the executor', async () => {
    const { r, h } = await setup();
    const source = await r.createByClick({
      slot: { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
    });
    const d = r.seedDelta({ source, change: 'cancel' });
    const a = r.repos.actions.byId(d.action.id)!;
    const res = await h['action:approve'](
      { actionId: a.id, kind: 'update_event', shownHash: a.contentSha256 },
      { ...CTX, windowFocused: false },
    );
    expect(res).toEqual({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } });
    expect(r.updateCalls()).toHaveLength(0);
  });
});
