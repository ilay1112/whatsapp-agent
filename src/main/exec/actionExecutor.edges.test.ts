// src/main/exec/actionExecutor.edges.test.ts - T2 5 row exec/actionExecutor.ts v2: the edges of the v2 paths (fail-closed defaults,
// races between a click / a reject and the executor's own awaits, read failures at every read, retention-nulled revisions, the
// dedupe of "Add as new event" / "Add it back", injected AutoGate doubles). Same rig as the other exec suites.
import { afterEach, describe, expect, it } from 'vitest';
import { CTX, RIG_NOW, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import type { ApprovalAction, EpochMs } from '../../shared/types';
import type { McpReadClient } from '../mcp/readClient';
import type { McpWriteClient } from '../mcp/writeClient';
import type { UpdateEventPayload } from '../../shared/schemas';

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const r = await makeExecRig(opts);
  rigs.push(r);
  return r;
}
const MIN = 60_000;
const WED = { startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' };
const THU = { startLocal: '2026-10-08T17:00:00', endLocal: '2026-10-08T18:00:00' };
const actionOf = (r: Rig, id: string): ApprovalAction => r.repos.actions.byId(id as never)!;
const updates = (r: Rig) => r.cal.calls.filter((c) => c.tool === 'update-event');
const AUTO_OK = () => ({ verdict: 'auto' as const, reason: 'ok' as const, checks: {}, pausePolicy: null });

describe('fail-closed defaults: an executor built without the C2 14 v2 deps', () => {
  it('update_event => CAL_UPDATE_UNAVAILABLE; tryAuto => snapshot_changed (the empty snapshot never matches)', async () => {
    const r = await rig({
      exec: {
        updateSurfaceAvailable: undefined,
        snapshotSha: undefined,
        featureGates: undefined,
        notifyAuto: undefined,
        autoGate: undefined,
        randomUuid: undefined,
      },
    });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toEqual({ ok: false, error: { code: 'CAL_UPDATE_UNAVAILABLE' } });
    await r.trackRecord();
    r.policy('on');
    const c = r.seedCreate({ chatN: 2, slot: THU });
    const out = await r.exec.tryAuto(c.action.id);
    expect(out).toMatchObject({ verdict: 'fallback', reason: 'snapshot_changed' });
    if (out.verdict !== 'none') expect(out.decisionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('read failures and races on the click path', () => {
  it('a THROWING get-event is "unavailable" => CAL_UNAVAILABLE', async () => {
    let throwing = false;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: (c, e) => (throwing ? Promise.reject(new Error('socket')) : real.getEvent(c, e)),
      }),
    });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    throwing = true;
    expect(await r.click(d.action.id)).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
  });
  it('a pre-flight whose event id is not the target => CAL_EVENT_FOREIGN; one without waAction => CAL_EVENT_FOREIGN', async () => {
    let mode: 'id' | 'action' | null = null;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: async (c, e) => {
          const res = await real.getEvent(c, e);
          if (!res.ok || mode === null) return res;
          return mode === 'id'
            ? { ok: true, value: { ...res.value, id: 'c'.repeat(32) } }
            : { ok: true, value: { ...res.value, priv: { ...res.value.priv, waAction: null } } };
        },
      }),
    });
    for (const m of ['id', 'action'] as const) {
      mode = null;
      const source = await r.createByClick({ chatN: m === 'id' ? 1 : 2, slot: m === 'id' ? WED : THU });
      const d = r.seedDelta({ source, change: 'move', to: { location: 'Room 1' } });
      mode = m;
      await r.click(d.action.id);
      expect(actionOf(r, d.action.id).errorCode).toBe('CAL_EVENT_FOREIGN');
    }
    expect(updates(r)).toHaveLength(0);
  });
  it('a reject landing while the pre-flight is in flight: GONE / the write-ahead both answer ACTION_STALE (CAS)', async () => {
    let hook: (() => void) | null = null;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: async (c, e) => {
          const res = await real.getEvent(c, e);
          hook?.();
          hook = null;
          return res;
        },
        getFreeBusy: async (w) => {
          const res = await real.getFreeBusy(w);
          hook?.();
          hook = null;
          return res;
        },
      }),
    });
    const source = await r.createByClick({ slot: WED });
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    r.cal.scenario('event_missing');
    hook = () => r.repos.actions.markRejected(d1.action.id as never);
    expect(await r.click(d1.action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    const r2 = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getFreeBusy: async (w) => {
          const res = await real.getFreeBusy(w);
          hook?.();
          hook = null;
          return res;
        },
      }),
    });
    const s2 = await r2.createByClick({ slot: WED });
    const d2 = r2.seedDelta({ source: s2, change: 'reschedule', to: THU });
    hook = () => r2.repos.actions.markRejected(d2.action.id as never);
    expect(await r2.click(d2.action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(updates(r2)).toHaveLength(0);
  });
  it('a change whose `to` already ended => EVENT_INVALID before any read', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({
      source,
      change: 'reschedule',
      to: { startLocal: '2026-10-01T10:00:00', endLocal: '2026-10-01T11:00:00' },
    });
    expect(await r.click(d.action.id)).toEqual({ ok: false, error: { code: 'EVENT_INVALID' } });
  });
  it('a payload that names another item than its action row can never be stored (the repo refuses it)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    const other = r.seedCreate({ chatN: 5, slot: THU });
    const forged: UpdateEventPayload = { ...d.payload, itemId: other.item.id };
    expect(() =>
      r.repos.actions.insertPending({
        itemId: d.item.id,
        proposalId: d.action.proposalId,
        chatId: d.action.chatId,
        payload: forged,
        now: r.clock.now() as EpochMs,
        retryOf: d.action.id as never,
      }),
    ).toThrow(/itemId/);
  });
  it('GONE on a CANCEL change offers nothing (the event is already gone)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'cancel' });
    r.cal.scenario('event_missing');
    await r.click(d.action.id);
    expect(actionOf(r, d.action.id).errorCode).toBe('CAL_EVENT_GONE');
    expect(r.repos.actions.forItem(d.item.id).filter((a) => a.kind === 'create_event')).toEqual([]);
  });
  it('a 412 whose fresh read fails still asks the drift question (about the approved from)', async () => {
    let afterPatch = false;
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        updateEvent: () => {
          afterPatch = true;
          return Promise.resolve({ ok: false, error: 'precondition' });
        },
      }),
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: (c, e) => (afterPatch ? Promise.resolve({ ok: false, error: 'unavailable' }) : real.getEvent(c, e)),
      }),
    });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.click(d.action.id)).toMatchObject({
      ok: true,
      value: { outcome: 'needs_confirm_drift', current: { startLocal: WED.startLocal } },
    });
  });
  it('"Add it back" is offered at most once per proposal version (a refused restore twice)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'cancel' });
    await r.click(d.action.id);
    r.cal.scenario('restore_refused');
    const eventId = source.calendarEventId!;
    await r.exec.undoChange(d.item.id, r.repos.eventRevisions.undoCandidate(eventId)!.id, 'user', CTX);
    const clone = r.repos.actions.forItem(d.item.id).find((a) => a.kind === 'update_event' && a.state === 'pending')!;
    await r.click(clone.id);
    const offers = r.repos.actions.forItem(d.item.id).filter((a) => a.kind === 'create_event');
    expect(offers).toHaveLength(1);
  });
});

describe('tryAuto edges', () => {
  async function onRig(opts: RigOptions = {}): Promise<Rig> {
    const r = await rig(opts);
    await r.trackRecord();
    r.policy('on');
    return r;
  }
  it('an undo payload is never evaluated; a superseded proposal version is not either', async () => {
    const r = await onRig();
    const source = await r.createByClick({ slot: WED });
    // a pending undo payload (a refused undo no longer stays pending - v2-fix editing-undo-4 - so it is inserted directly)
    const cand = r.repos.eventRevisions.undoCandidate(source.calendarEventId!)!;
    const current = r.repos.proposals.current(source.id)!;
    const undo = r.repos.actions.insertPending({
      itemId: source.id,
      proposalId: current.id,
      chatId: source.chatId,
      payload: {
        v: 1,
        kind: 'update_event',
        itemId: source.id,
        chatRef: source.chatId,
        proposalVersion: current.version,
        targetEventId: source.calendarEventId!,
        targetItemId: source.id,
        baseRevision: 1,
        change: 'undo',
        from: cand.next!,
        to: { ...cand.next!, status: 'cancelled' },
        revertOf: cand.id,
      },
      now: r.clock.now() as EpochMs,
    });
    expect(await r.exec.tryAuto(undo.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
    const c = r.seedCreate({ chatN: 4, slot: THU });
    r.repos.proposals.insertNext({
      itemId: c.item.id,
      provider: 'local',
      model: 'm',
      extraction: null,
      draftText: null,
      replyLang: null,
      event: null,
      freeBusy: null,
      suspicious: false,
      createdAt: r.clock.now() as EpochMs,
    });
    expect(await r.exec.tryAuto(c.action.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
  });
  it('a proposal of the "user" provider is provider_unsafe', async () => {
    const r = await onRig();
    const c = r.seedCreate({ chatN: 4, slot: THU, proposal: { provider: 'user' } });
    expect(await r.exec.tryAuto(c.action.id)).toMatchObject({ verdict: 'fallback', reason: 'provider_unsafe' });
  });
  it('a failed free/busy read is a conflict (create and update)', async () => {
    let failFb = false;
    const r = await onRig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getFreeBusy: (w) => (failFb ? Promise.resolve({ ok: false, error: 'unavailable' }) : real.getFreeBusy(w)),
      }),
    });
    const source = await r.createByClick({ slot: WED });
    failFb = true;
    const c = r.seedCreate({ chatN: 4, slot: THU });
    expect(await r.exec.tryAuto(c.action.id)).toMatchObject({ verdict: 'fallback', reason: 'conflict' });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    expect(await r.exec.tryAuto(d.action.id)).toMatchObject({ verdict: 'fallback', reason: 'conflict' });
    // a failed free/busy read never blocks a CLICK
    expect(await r.click(c.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
  });
  it('an injected gate that says auto cannot bypass the executor’s own checks (sanity / pre-flight)', async () => {
    const r = await onRig({ exec: { autoGate: AUTO_OK } });
    const past = r.seedCreate({
      chatN: 4,
      slot: { startLocal: '2026-10-05T08:00:00', endLocal: '2026-10-05T09:00:00' },
    });
    expect(await r.exec.tryAuto(past.action.id)).toMatchObject({ verdict: 'fallback', reason: 'too_soon' });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    r.cal.scenario('event_missing');
    expect(await r.exec.tryAuto(d.action.id)).toMatchObject({ verdict: 'fallback', reason: 'unknown_prev_state' });
    expect(r.cal.calls.filter((x) => x.tool === 'update-event')).toHaveLength(0);
  });
  it('a reject landing during the reads => the write-ahead CAS misses: nothing recorded, verdict none', async () => {
    let hook: (() => void) | null = null;
    const r = await onRig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getFreeBusy: async (w) => {
          const res = await real.getFreeBusy(w);
          hook?.();
          hook = null;
          return res;
        },
      }),
    });
    const c = r.seedCreate({ chatN: 4, slot: THU });
    hook = () => r.repos.actions.markRejected(c.action.id as never);
    expect(await r.exec.tryAuto(c.action.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
    expect(r.repos.autoDecisions.forAction(c.action.id as never)).toBeNull();
  });
  // [v2-fix auto-mode-2] null post_* no longer makes the write un-undoable when Google's copy is provably the app's own, untouched
  // write (its chain tag + the recorded content); the changed-in-Google variant stays blocked_changed (actionExecutor.v2fix.test.ts).
  it('an automatic create without a readback records null post_* (and its untouched event can still be undone)', async () => {
    let failGet = false;
    const r = await onRig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: (c, e) => (failGet ? Promise.resolve({ ok: false, error: 'unavailable' }) : real.getEvent(c, e)),
      }),
    });
    failGet = true;
    const c = r.seedCreate({ chatN: 4, slot: THU });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    expect(r.repos.autoWrites.byId(out.autoWriteId!)).toMatchObject({ postEtag: null, postUpdated: null });
    failGet = false;
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    expect(r.repos.autoWrites.byId(out.autoWriteId!)!.undoState).toBe('undone');
  });
  it('startup recovery of an automatic write with the policy already paused / already gone changes nothing more', async () => {
    let release: () => void = () => undefined;
    const hang = { on: true };
    const r = await onRig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: (args) =>
          hang.on && !args.summary.startsWith('Track')
            ? new Promise((res) => (release = () => res({ ok: false, error: 'timeout' })))
            : real.createEvent(args),
      }),
    });
    const c = r.seedCreate({ chatN: 4, slot: THU });
    const pending = r.exec.tryAuto(c.action.id);
    await new Promise((res) => setImmediate(res));
    const live = r.repos.autoPolicies.live()!;
    r.repos.autoPolicies.setState(live.id, { state: 'paused', reason: 'user' });
    await r.exec.recoverOnStartup();
    expect(r.repos.autoPolicies.live()!.pausedReason).toBe('user');
    r.repos.autoPolicies.setState(live.id, { state: 'disabled', reason: 'user', at: r.clock.now() as EpochMs });
    await r.exec.recoverOnStartup();
    expect(r.repos.autoPolicies.live()).toBeNull();
    release();
    await pending.catch(() => undefined);
  });
});

describe('undo edges', () => {
  it('a pre-check read failure => CAL_RECONNECT / CAL_UNAVAILABLE; a gone event goes on to the approve gates (GONE)', async () => {
    for (const [error, expected] of [
      ['auth', { ok: false, error: { code: 'CAL_RECONNECT' } }],
      ['unavailable', { ok: false, error: { code: 'CAL_UNAVAILABLE' } }],
    ] as const) {
      let failGet = false;
      const r = await rig({
        wrapRead: (real): McpReadClient => ({
          ...real,
          getEvent: (c, e) => (failGet ? Promise.resolve({ ok: false, error }) : real.getEvent(c, e)),
        }),
      });
      await r.trackRecord();
      r.policy('on');
      const c = r.seedCreate({ chatN: 4, slot: THU });
      const out = await r.exec.tryAuto(c.action.id);
      if (out.verdict !== 'auto') throw new Error('not auto');
      failGet = true;
      expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toEqual(expected);
    }
    const r = await rig();
    await r.trackRecord();
    r.policy('on');
    const c = r.seedCreate({ chatN: 4, slot: THU });
    const out = await r.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    r.cal.scenario('event_missing');
    expect(await r.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'failed' },
    });
  });
  // [v2-fix editing-undo-3] the second click no longer answers ACTION_STALE forever: it approves the unknown undo's own retry clone
  // (the same undo chain, attempt 2) - never a second, independent undo of the revision.
  it('an undo that is still unknown is retried through its own clone, never a second undo chain (idempotent)', async () => {
    let timeout = false;
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        updateEvent: (args) => (timeout ? Promise.resolve({ ok: false, error: 'timeout' }) : real.updateEvent(args)),
      }),
    });
    const source = await r.createByClick({ slot: WED });
    const cand = r.repos.eventRevisions.undoCandidate(source.calendarEventId!)!;
    timeout = true;
    await r.exec.undoChange(source.id, cand.id, 'user', CTX);
    expect(await r.exec.undoChange(source.id, cand.id, 'user', CTX)).toMatchObject({
      ok: true,
      value: { outcome: 'failed' }, // the retry timed out as well: unknown again, with its own clone
    });
    const undos = r.repos.actions
      .forItem(source.id)
      .filter((a) => a.kind === 'update_event' && a.state !== 'superseded' && a.state !== 'pending');
    expect(undos.map((a) => a.attempt)).toEqual([1, 2]);
    expect(new Set(undos.map((a) => r.repos.actions.chainRoot(a.id).id)).size).toBe(1);
  });
  it('a retention-nulled revision cannot be undone (nothing to restore from)', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    await r.click(d.action.id);
    const eventId = source.calendarEventId!;
    const cand = r.repos.eventRevisions.undoCandidate(eventId)!;
    r.db.prepare(`UPDATE event_revisions SET prev_json = NULL, next_json = NULL WHERE id = ?`).run(cand.id);
    expect(await r.exec.undoChange(d.item.id, cand.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    const r2 = await rig();
    const s2 = await r2.createByClick({ slot: WED });
    const d2 = r2.seedDelta({ source: s2, change: 'reschedule', to: THU });
    await r2.click(d2.action.id);
    const c2 = r2.repos.eventRevisions.undoCandidate(s2.calendarEventId!)!;
    r2.db.prepare(`UPDATE event_revisions SET next_json = NULL WHERE id = ?`).run(c2.id);
    expect(await r2.exec.undoChange(d2.item.id, c2.id, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
  });
  it('restoreOriginal of a retention-nulled oldest write; undoAuto of a failed write', async () => {
    const r = await rig();
    await r.trackRecord();
    const source = await r.createByClick({ slot: WED });
    r.policy('on');
    const d1 = r.seedDelta({ source, change: 'reschedule', to: THU });
    const o1 = await r.exec.tryAuto(d1.action.id);
    if (o1.verdict !== 'auto') throw new Error('not auto');
    const rev = r.repos.autoWrites.byId(o1.autoWriteId!)!.revisionId!;
    r.db.prepare(`UPDATE event_revisions SET prev_json = NULL, next_json = NULL WHERE id = ?`).run(rev);
    expect(await r.exec.restoreOriginal(d1.item.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    const r2 = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: (args) =>
          args.summary.startsWith('Track') ? real.createEvent(args) : Promise.resolve({ ok: false, error: 'auth' }),
      }),
    });
    await r2.trackRecord();
    r2.policy('on');
    const c = r2.seedCreate({ chatN: 4, slot: THU });
    const out = await r2.exec.tryAuto(c.action.id);
    if (out.verdict !== 'auto') throw new Error('not auto');
    expect(await r2.exec.undoAuto(out.autoWriteId!, 'user', CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
  });
  it('cancelEvent of a v1-created event (no revision row) reads the current content first; gone / unreachable / cancelled', async () => {
    const r = await rig();
    const held = r.seedHeldEvent({ eventId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', withBaseline: false });
    expect(await r.exec.cancelEvent(held.id, CTX)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const r2 = await rig();
    const h2 = r2.seedHeldEvent({ eventId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', withBaseline: false });
    r2.cal.userEditsInGoogle('f0e1d2c3b4a5968778695a4b3c2d1e0f', { status: 'cancelled' });
    expect(await r2.exec.cancelEvent(h2.id, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    r2.cal.scenario('event_missing');
    expect(await r2.exec.cancelEvent(h2.id, CTX)).toEqual({ ok: false, error: { code: 'CAL_EVENT_GONE' } });
    const r3 = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: () => Promise.resolve({ ok: false, error: 'unavailable' }),
      }),
    });
    const h3 = r3.seedHeldEvent({ eventId: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', withBaseline: false });
    expect(await r3.exec.cancelEvent(h3.id, CTX)).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    void (RIG_NOW + MIN);
  });
});

describe('last edges', () => {
  it('the update surface switching off DURING the pre-flight (F12) => CAL_UPDATE_UNAVAILABLE, zero PATCH', async () => {
    let flip: (() => void) | null = null;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: async (c, e) => {
          const res = await real.getEvent(c, e);
          flip?.();
          return res;
        },
      }),
    });
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'reschedule', to: THU });
    flip = () => (r.flags.updateSurface = false);
    expect(await r.click(d.action.id)).toEqual({ ok: false, error: { code: 'CAL_UPDATE_UNAVAILABLE' } });
    expect(updates(r)).toHaveLength(0);
  });
  it('an unknown outcome after the policy was disabled mid-write pauses nothing (no live policy left)', async () => {
    let release: () => void = () => undefined;
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: (args) =>
          args.summary.startsWith('Track')
            ? real.createEvent(args)
            : new Promise((res) => (release = () => res({ ok: false, error: 'timeout' }))),
      }),
    });
    await r.trackRecord();
    const live = r.policy('on');
    const c = r.seedCreate({ chatN: 4, slot: THU });
    const pending = r.exec.tryAuto(c.action.id);
    await new Promise((res) => setImmediate(res));
    r.repos.autoPolicies.setState(live.id, { state: 'disabled', reason: 'user', at: r.clock.now() as EpochMs });
    release();
    expect(await pending).toMatchObject({ verdict: 'auto', result: 'unknown_outcome' });
    expect(r.repos.autoPolicies.live()).toBeNull();
  });
  it('a decision the repository refuses (prose in checks) is an error, never a silent write', async () => {
    const r = await rig({
      exec: {
        autoGate: () => ({
          verdict: 'auto',
          reason: 'ok',
          checks: { note: 'free text is not allowed here!' },
          pausePolicy: null,
        }),
      },
    });
    await r.trackRecord();
    r.policy('on');
    const c = r.seedCreate({ chatN: 4, slot: THU });
    await expect(r.exec.tryAuto(c.action.id)).rejects.toThrow();
    expect(r.repos.actions.byId(c.action.id as never)!.state).toBe('pending');
    expect(r.cal.calls.filter((x) => x.tool === 'create-event')).toHaveLength(3);
  });
});
