// src/main/exec/reconcile.v2.test.ts - C2 14 reconcile v2 (owner V2-W1-04): get-event only for updates; a failed / throwing read keeps
// unknown_outcome; a non-update or non-unknown action is not reconciled as an update; B24 for a location-only edit (a `move`), and
// an offer that cannot be stored is audited, never thrown.
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileUnknown, reconcileUpdate } from './reconcile';
import { makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig } from '../../../tests/helpers/ledger.execRig';
import type { ReconcileDeps } from './reconcile';
import type { EpochMs } from '../../shared/types';
import type { McpWriteClient } from '../mcp/writeClient';
import type { Repos } from '../db/index';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const unansweredCreate = (real: McpWriteClient): McpWriteClient => ({
  ...real,
  createEvent: async (args) => {
    await real.createEvent(args);
    return { ok: false, error: 'timeout' };
  },
});
const depsOf = (r: Rig, over: Partial<ReconcileDeps> = {}): ReconcileDeps => ({
  repos: r.repos,
  bridgeDb: null,
  read: r.read,
  now: () => r.clock.now() as EpochMs,
  timeZone: () => 'Asia/Jerusalem',
  ...over,
});

describe('reconcileUpdate', () => {
  async function unknownUpdate(r: Rig) {
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const a = r.repos.actions.byId(d.action.id)!;
    r.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, r.clock.now() as EpochMs, 'user');
    r.repos.actions.markUnknownOutcome(a.id, r.clock.now() as EpochMs);
    return a.id;
  }
  it('a failed or throwing get-event (or none at all) keeps the action unknown', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const id = await unknownUpdate(r);
    expect(
      await reconcileUpdate(
        id,
        depsOf(r, { read: { ...r.read, getEvent: () => Promise.resolve({ ok: false, error: 'unavailable' }) } }),
      ),
    ).toBe('unknown_outcome');
    expect(
      await reconcileUpdate(id, depsOf(r, { read: { ...r.read, getEvent: () => Promise.reject(new Error('x')) } })),
    ).toBe('unknown_outcome');
    expect(await reconcileUpdate(id, depsOf(r, { read: { findAppEvent: r.read.findAppEvent } }))).toBe(
      'unknown_outcome',
    );
    expect(await reconcileUpdate(id, depsOf(r, { read: null }))).toBe('unknown_outcome');
    expect(r.repos.actions.byId(id)!.state).toBe('unknown_outcome');
  });
  it('a create action or a done update is not reconciled as an update', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const item = await r.createByClick({ slot: WED });
    const create = r.repos.actions.forItem(item.id).find((a) => a.kind === 'create_event')!;
    expect(await reconcileUpdate(create.id, depsOf(r))).toBe('unknown_outcome');
    const d = r.seedDelta({ source: item, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    expect(await reconcileUpdate(d.action.id, depsOf(r))).toBe('unknown_outcome');
  });
});

describe('B24: a found create edited in Google', () => {
  it('a location-only edit offers a `move`', async () => {
    const r = await makeExecRig({ wrapWrite: unansweredCreate });
    rigs.push(r);
    const { item, action } = r.seedCreate({ slot: WED, location: 'Room 1' });
    await r.click(action.id);
    const eventId = r.cal.storedEvents[0]!.eventId;
    r.cal.userEditsInGoogle(eventId, { location: 'Room 2' });
    await reconcileUnknown(depsOf(r));
    const upd = r.repos.actions.forItem(item.id).find((a) => a.kind === 'update_event')!;
    expect(JSON.parse(upd.canonicalJson)).toMatchObject({
      change: 'move',
      from: { location: 'Room 2' },
      to: { location: 'Room 1' },
    });
  });
  it('an offer that cannot be stored is audited (db_recovery), never thrown; the create is still done', async () => {
    const r = await makeExecRig({ wrapWrite: unansweredCreate });
    rigs.push(r);
    const { action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    r.cal.userEditsInGoogle(r.cal.storedEvents[0]!.eventId, {
      start: '2026-10-07T16:00:00',
      end: '2026-10-07T17:00:00',
    });
    const repos: Repos = {
      ...r.repos,
      actions: {
        ...r.repos.actions,
        insertPending: () => {
          throw new Error('unique');
        },
      },
    };
    await reconcileUnknown(depsOf(r, { repos }));
    expect(r.repos.actions.byId(action.id)!.state).toBe('done');
    const audits = r.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'db_recovery'`).get()!
      .n;
    expect(audits).toBe(1);
  });
  it('a found create whose readback fails is still done (v1 rule), with no baseline and no offer', async () => {
    const r = await makeExecRig({ wrapWrite: unansweredCreate });
    rigs.push(r);
    const { item, action } = r.seedCreate({ slot: WED });
    await r.click(action.id);
    await reconcileUnknown(
      depsOf(r, {
        read: {
          findAppEvent: r.read.findAppEvent,
          getEvent: () => Promise.resolve({ ok: false, error: 'unavailable' }),
        },
      }),
    );
    expect(r.repos.actions.byId(action.id)!.state).toBe('done');
    expect(r.repos.actions.forItem(item.id).filter((a) => a.kind === 'update_event')).toEqual([]);
    expect(r.repos.eventRevisions.newestFor(r.repos.items.byId(item.id)!.calendarEventId!)!.postEtag).toBeNull();
  });
});
