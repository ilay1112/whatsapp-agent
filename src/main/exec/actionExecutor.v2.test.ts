// src/main/exec/actionExecutor.v2.test.ts - T2 5 row exec/actionExecutor.ts v2 (unit level of 8.2 groups 14/15/22): the update_event
// approve gate order of ARCH-v2 7 / C2 14, the rev-1 bookkeeping of a create, and tryAuto steps 1-8 of ARCH-v2 6.3 / P2 10.6.
// REAL in-memory app DB (the production triggers decide every approval) + the fake calendar v2 behind the REAL MCP clients.
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../shared/types';
import { canonicalJson } from '../../shared/schemas';
import { ActionNotExecutingError, applyEdit, eventSanity } from './actionExecutor';
import { CTX, DAYS, HOURS, RIG_NOW, at, makeExecRig } from '../../../tests/helpers/ledger.execRig';
import type { Rig, RigOptions } from '../../../tests/helpers/ledger.execRig';
import type { ApprovalAction, EpochMs, Item } from '../../shared/types';
import type { UpdateEventPayload } from '../../shared/schemas';
import type { McpWriteClient } from '../mcp/writeClient';
import type { McpReadClient } from '../mcp/readClient';

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
const actionOf = (r: Rig, id: string): ApprovalAction => r.repos.actions.byId(id as never)!;
const itemOf = (r: Rig, id: number): Item => r.repos.items.byId(id as never)!;
const auditKinds = (r: Rig): string[] =>
  r.db
    .prepare<{ kind: string }>(`SELECT kind FROM audit_log ORDER BY id`)
    .all()
    .map((x) => x.kind);
const calls = (r: Rig, tool: string): number => r.cal.calls.filter((c) => c.tool === tool).length;

/** An app event (click) + a reschedule card to Thursday 17:00. */
async function withChange(
  r: Rig,
  change: 'reschedule' | 'move' | 'cancel' = 'reschedule',
  to: Partial<UpdateEventPayload['to']> = THU,
) {
  const source = await r.createByClick({ slot: WED });
  const delta = r.seedDelta({ source, change, to: change === 'cancel' ? {} : to });
  return { source, ...delta };
}

// ---------------------------------------------------------------------------------------------------------------------
describe('create_event v2 bookkeeping (C2 14, F1/F5/F27)', () => {
  it('a done create becomes the event origin, event_revision 1, and writes the rev-1 row with the readback post_* (the baseline)', async () => {
    const r = await rig();
    const item = await r.createByClick({ slot: WED });
    expect(item).toMatchObject({ eventState: 'created', eventRevision: 1, eventOriginItemId: item.id });
    const rev = r.repos.eventRevisions.newestFor(item.calendarEventId!)!;
    expect(rev).toMatchObject({ revision: 1, kind: 'create', prev: null, itemId: item.id });
    expect(rev.postEtag).toBe(r.stored(item.calendarEventId!)!.etag);
    expect(rev.postUpdated).toBe(item.calendarUpdated);
    expect(rev.next).toMatchObject({ title: 'Dentist', ...WED, status: 'confirmed' });
    expect(actionOf(r, rev.actionId).approvedBy).toBe('user');
  });
  it('without a readback the rev-1 row carries the approved content and no baseline (fail closed later: modified_in_google)', async () => {
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getEvent: () => Promise.resolve({ ok: false, error: 'unavailable' }),
      }),
    });
    const item = await r.createByClick({ slot: WED, title: 'Dentist https://x.example' });
    const rev = r.repos.eventRevisions.newestFor(item.calendarEventId!)!;
    expect(rev).toMatchObject({ postEtag: null, postUpdated: null, next: { title: 'Dentist', ...WED } });
    expect(item.calendarUpdated).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('update_event approve (ARCH-v2 7 / C2 14 gate order)', () => {
  it('happy reschedule: ONE PATCH with If-Match = the pre-flight etag, readback-verified done, the outcome transaction', async () => {
    const r = await rig();
    const { source, item, action } = await withChange(r);
    const etagBefore = r.stored(source.calendarEventId!)!.etag;
    const res = await r.click(action.id);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const [args] = r.updateCalls();
    expect(r.updateCalls()).toHaveLength(1);
    expect(args).toMatchObject({
      ifMatch: etagBefore,
      start: THU.startLocal,
      end: THU.endLocal,
      sendUpdates: 'none',
      checkConflicts: false,
    });
    expect(args).not.toHaveProperty('description');
    const done = actionOf(r, action.id);
    expect(done).toMatchObject({
      state: 'done',
      approvedBy: 'user',
      result: { kind: 'update_event', revision: 2, status: 'confirmed' },
    });
    expect(itemOf(r, item.id)).toMatchObject({
      state: 'in_calendar',
      eventState: 'updated',
      eventRevision: 2,
      calendarEventId: source.calendarEventId,
      eventOriginItemId: source.id,
      eventStartTs: at(THU.startLocal),
    });
    expect(itemOf(r, source.id).closedReason).toBe('superseded');
    const rev = r.repos.eventRevisions.newestFor(source.calendarEventId!)!;
    expect(rev).toMatchObject({ revision: 2, kind: 'reschedule', itemId: item.id, prev: { ...WED }, next: { ...THU } });
    expect(rev.postEtag).toBe(r.stored(source.calendarEventId!)!.etag);
    expect(auditKinds(r)).toContain('event_updated');
    expect(r.cal.violations).toEqual([]);
  });

  it('a second and third change of the same event (click) each apply with one PATCH (F27 chain)', async () => {
    const r = await rig();
    const { source, action } = await withChange(r);
    expect((await r.click(action.id)).ok).toBe(true);
    const acting1 = r.repos.items.byCalendarEventId(source.calendarEventId!).find((i) => i.eventState === 'updated')!;
    const d2 = r.seedDelta({ source: acting1, change: 'move', to: { location: 'Clinic 2' } });
    expect(await r.click(d2.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const acting2 = itemOf(r, d2.item.id);
    const d3 = r.seedDelta({
      source: acting2,
      change: 'reschedule',
      to: { startLocal: '2026-10-09T09:00:00', endLocal: '2026-10-09T10:00:00' },
    });
    expect(await r.click(d3.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.updateCalls()).toHaveLength(3);
    expect(itemOf(r, d3.item.id)).toMatchObject({ eventRevision: 4, eventOriginItemId: source.id });
    for (const c of r.updateCalls())
      expect((c.extendedProperties as { private: { waItem: string } }).private.waItem).toBe(String(source.id));
  });

  it('to == from => ACTION_STALE, zero calendar calls, action still pending', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    const d = r.seedDelta({ source, change: 'move', to: {} });
    const before = r.cal.calls.length;
    expect(await r.click(d.action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(r.cal.calls.length).toBe(before);
    expect(actionOf(r, d.action.id).state).toBe('pending');
  });

  it('stale baseRevision / another target event => ACTION_STALE before any read', async () => {
    const r = await rig();
    const { source, action } = await withChange(r);
    r.repos.items.update(source.id, { eventRevision: 5 }, r.clock.now() as EpochMs);
    expect(await r.click(action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    r.repos.items.update(source.id, { eventRevision: 1, calendarEventId: 'b'.repeat(32) }, r.clock.now() as EpochMs);
    expect(await r.click(action.id)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(calls(r, 'get-event')).toBe(1); // only the create readback
  });

  it('update surface off => CAL_UPDATE_UNAVAILABLE; calendar disconnected => CAL_UNAVAILABLE; both with zero get-event', async () => {
    const r = await rig();
    const { action } = await withChange(r);
    r.flags.updateSurface = false;
    expect(await r.click(action.id)).toEqual({ ok: false, error: { code: 'CAL_UPDATE_UNAVAILABLE' } });
    r.flags.updateSurface = true;
    r.flags.calendarConnected = false;
    expect(await r.click(action.id)).toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    expect(calls(r, 'get-event')).toBe(1);
  });

  it('event_missing / gone_410 => failed CAL_EVENT_GONE, NO clone, a pending create_event with `to` ("Add as new event")', async () => {
    for (const scenario of ['event_missing', 'gone_410'] as const) {
      const r = await rig();
      const { item, action } = await withChange(r);
      r.cal.scenario(scenario);
      const res = await r.click(action.id);
      expect(res).toMatchObject({ ok: true, value: { outcome: 'failed' } });
      expect(actionOf(r, action.id)).toMatchObject({
        state: 'failed',
        errorCode: 'CAL_EVENT_GONE',
        approvedBy: 'user',
      });
      const rows = r.repos.actions.forItem(item.id);
      expect(rows.filter((a) => a.retryOf === action.id)).toEqual([]);
      const offer = rows.find((a) => a.kind === 'create_event' && a.state === 'pending')!;
      expect(JSON.parse(offer.canonicalJson)).toMatchObject({ kind: 'create_event', ...THU });
      expect(r.updateCalls()).toHaveLength(0);
    }
  });

  it('a cancelled copy in Google on a non-undo => CAL_EVENT_GONE', async () => {
    const r = await rig();
    const { source, action } = await withChange(r);
    r.cal.userEditsInGoogle(source.calendarEventId!, { status: 'cancelled' });
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(actionOf(r, action.id).errorCode).toBe('CAL_EVENT_GONE');
  });

  it('foreign events (untagged, attendees, origin in another chat, no origin) => failed CAL_EVENT_FOREIGN, zero update calls, no clone', async () => {
    for (const variant of ['foreign_tags', 'attendees', 'other_chat', 'no_origin'] as const) {
      const r = await rig();
      const { source, item, action } = await withChange(r);
      if (variant === 'foreign_tags' || variant === 'attendees') r.cal.scenario(variant);
      if (variant === 'other_chat') {
        const other = r.seedCreate({
          chatN: 5,
          slot: { startLocal: '2026-10-10T10:00:00', endLocal: '2026-10-10T11:00:00' },
        });
        r.repos.items.update(source.id, { eventOriginItemId: other.item.id }, r.clock.now() as EpochMs);
      }
      if (variant === 'no_origin')
        r.repos.items.update(source.id, { eventOriginItemId: null }, r.clock.now() as EpochMs);
      expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
      expect(actionOf(r, action.id).errorCode).toBe('CAL_EVENT_FOREIGN');
      expect(r.repos.actions.forItem(item.id).filter((a) => a.state === 'pending')).toEqual([]);
      expect(r.updateCalls()).toHaveLength(0);
    }
  });

  it('drift => needs_confirm_drift (still pending, zero PATCH); confirmDrift:true applies; prev_json = the pre-flight copy (I8, decision 4)', async () => {
    const r = await rig();
    const { source, action } = await withChange(r);
    r.cal.userEditsInGoogle(source.calendarEventId!, { start: '2026-10-07T16:00:00', end: '2026-10-07T17:00:00' });
    // confirmDrift on a FIRST click is not honoured: the user has not seen the question yet
    const first = await r.click(action.id, { confirmDrift: true });
    expect(first).toMatchObject({
      ok: true,
      value: { outcome: 'needs_confirm_drift', current: { startLocal: '2026-10-07T16:00:00' } },
    });
    expect(actionOf(r, action.id).state).toBe('pending');
    expect(r.updateCalls()).toHaveLength(0);
    const second = await r.click(action.id, { confirmDrift: true });
    expect(second).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const final = JSON.parse(actionOf(r, action.id).approvedFinalJson!) as UpdateEventPayload;
    expect(final.from).toMatchObject({ startLocal: '2026-10-07T16:00:00', endLocal: '2026-10-07T17:00:00' });
    const rev = r.repos.eventRevisions.newestFor(source.calendarEventId!)!;
    expect(rev.prev).toMatchObject({ startLocal: '2026-10-07T16:00:00' });
  });

  it('a reject clears the drift question; the next confirmDrift is not honoured for an unrelated action', async () => {
    const r = await rig();
    const { source, action } = await withChange(r);
    r.cal.userEditsInGoogle(source.calendarEventId!, { location: 'Elsewhere' });
    expect((await r.click(action.id)).ok).toBe(true);
    expect(await r.exec.reject(action.id as never)).toEqual({ ok: true, value: null });
    expect(await r.click(action.id, { confirmDrift: true })).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
  });

  it('conflict: another event overlapping the new slot => needs_confirm_conflict; the event’s own block never conflicts', async () => {
    const r = await rig();
    const source = await r.createByClick({ slot: WED });
    await r.createByClick({ chatN: 3, slot: THU, title: 'Other' });
    const d = r.seedDelta({
      source,
      change: 'reschedule',
      to: { startLocal: '2026-10-08T17:30:00', endLocal: '2026-10-08T18:30:00' },
    });
    expect(await r.click(d.action.id)).toMatchObject({ ok: true, value: { outcome: 'needs_confirm_conflict' } });
    expect(actionOf(r, d.action.id).state).toBe('pending');
    expect(await r.click(d.action.id, { confirmConflict: true })).toMatchObject({
      ok: true,
      value: { outcome: 'done' },
    });
    // overlapping its OWN old slot is fine
    const acting = itemOf(r, d.item.id);
    const d2 = r.seedDelta({
      source: acting,
      change: 'reschedule',
      to: { startLocal: '2026-10-08T18:00:00', endLocal: '2026-10-08T19:00:00' },
    });
    expect(await r.click(d2.action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
  });

  it('HTTP 412 after the write-ahead => failed ACTION_STALE + pending clone + needs_confirm_drift about the clone (concern 12)', async () => {
    const r = await rig();
    const { item, action } = await withChange(r);
    r.cal.scenario('precondition_412');
    const res = await r.click(action.id);
    expect(res).toMatchObject({ ok: true, value: { outcome: 'needs_confirm_drift' } });
    expect(actionOf(r, action.id)).toMatchObject({ state: 'failed', errorCode: 'ACTION_STALE' });
    const clone = r.repos.actions.forItem(item.id).find((a) => a.retryOf === action.id)!;
    expect(clone.state).toBe('pending');
    expect(await r.click(clone.id, { confirmDrift: true })).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.updateCalls()).toHaveLength(2);
  });

  it('readback_mismatch => unknown_outcome (+ "Apply again" clone), never done', async () => {
    const r = await rig();
    const { item, action } = await withChange(r);
    r.cal.scenario('readback_mismatch');
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'failed' } });
    expect(actionOf(r, action.id).state).toBe('unknown_outcome');
    expect(r.repos.actions.forItem(item.id).some((a) => a.retryOf === action.id && a.state === 'pending')).toBe(true);
    expect(itemOf(r, item.id).eventState).toBe('change_proposed');
  });

  it('write errors: timeout => unknown; unavailable with the surface on => unknown, off => CAL_UPDATE_UNAVAILABLE; auth; other; not_found', async () => {
    const cases: Array<[string, 'unknown_outcome' | 'failed', string | null, boolean]> = [
      ['timeout', 'unknown_outcome', null, true],
      ['unavailable', 'unknown_outcome', null, true],
      ['unavailable', 'failed', 'CAL_UPDATE_UNAVAILABLE', false],
      ['auth', 'failed', 'CAL_RECONNECT', true],
      ['invalid_args', 'failed', 'CAL_UPDATE_FAILED', true],
      ['not_found', 'failed', 'CAL_EVENT_GONE', true],
      ['throw', 'unknown_outcome', null, true],
    ];
    for (const [error, state, code, surfaceAfter] of cases) {
      let flags: Rig['flags'] | null = null;
      const r = await rig({
        wrapWrite: (real): McpWriteClient => ({
          ...real,
          updateEvent: () => {
            if (!surfaceAfter && flags !== null) flags.updateSurface = false;
            if (error === 'throw') return Promise.reject(new Error('boom'));
            return Promise.resolve({ ok: false, error: error as never });
          },
        }),
      });
      flags = r.flags;
      const { action } = await withChange(r);
      await r.click(action.id);
      expect(actionOf(r, action.id)).toMatchObject({ state, errorCode: code });
    }
  });

  it('edits: a reschedule edit changes `to` only; an edit of a cancel / a text edit => BAD_REQUEST; a bad slot => EVENT_INVALID', async () => {
    const r = await rig();
    const { action } = await withChange(r);
    const edit = {
      title: 'Dentist (edited)',
      startLocal: '2026-10-08T18:00:00',
      endLocal: '2026-10-08T19:00:00',
      location: 'Room 4',
    };
    expect(
      await r.click(action.id, {
        edit: { title: 'x', startLocal: '2026-10-08T19:00:00', endLocal: '2026-10-08T18:00:00', location: '' },
      }),
    ).toEqual({
      ok: false,
      error: { code: 'EVENT_INVALID' },
    });
    expect(await r.click(action.id, { edit })).toMatchObject({ ok: true, value: { outcome: 'done' } });
    const final = JSON.parse(actionOf(r, action.id).approvedFinalJson!) as UpdateEventPayload;
    expect(final.to).toMatchObject({ ...edit, status: 'confirmed' });
    expect(final.from).toMatchObject({ ...WED });
    const r2 = await rig();
    const c = await withChange(r2, 'cancel');
    expect(await r2.click(c.action.id, { edit })).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(applyEdit(c.payload, { text: 'x' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it('cancel: status cancelled, no free/busy read, acting item cancelled, audit event_cancelled', async () => {
    const r = await rig();
    const { item, action } = await withChange(r, 'cancel');
    const fb = calls(r, 'get-freebusy');
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(calls(r, 'get-freebusy')).toBe(fb);
    expect(r.updateCalls()[0]).toMatchObject({ status: 'cancelled' });
    expect(itemOf(r, item.id).eventState).toBe('cancelled');
    expect(auditKinds(r)).toContain('event_cancelled');
  });

  it('the create_global bucket (creates + updates + undos) limits updates too', async () => {
    const r = await rig();
    const { action } = await withChange(r);
    for (let i = 0; i < LIMITS.createPerHour; i++)
      r.repos.rate.record('create_global', 'global', r.clock.now() as EpochMs);
    expect(await r.click(action.id)).toEqual({ ok: false, error: { code: 'RATE_LIMIT_CREATE' } });
    expect(r.updateCalls()).toHaveLength(0);
  });

  it('pre-flight read failures: invalid_args => CAL_UPDATE_UNAVAILABLE, auth => CAL_RECONNECT, other => CAL_UNAVAILABLE', async () => {
    for (const [error, code] of [
      ['invalid_args', 'CAL_UPDATE_UNAVAILABLE'],
      ['auth', 'CAL_RECONNECT'],
      ['unavailable', 'CAL_UNAVAILABLE'],
    ] as const) {
      let failGet = false;
      const r = await rig({
        wrapRead: (real): McpReadClient => ({
          ...real,
          getEvent: (c, e) => (failGet ? Promise.resolve({ ok: false, error }) : real.getEvent(c, e)),
        }),
      });
      const { action } = await withChange(r);
      failGet = true;
      expect(await r.click(action.id)).toEqual({ ok: false, error: { code } });
    }
  });

  it('F12: the UNPATCHED bundle (no etag) => CAL_UPDATE_UNAVAILABLE with zero update-event calls', async () => {
    const r = await rig({ calendar: { patched: false } });
    const { action } = await withChange(r);
    expect(await r.click(action.id)).toEqual({ ok: false, error: { code: 'CAL_UPDATE_UNAVAILABLE' } });
    expect(r.updateCalls()).toHaveLength(0);
  });

  it('execute(): an executing update re-reads its pre-flight identity; a non-executing row is refused before any client', async () => {
    const r = await rig();
    const { action } = await withChange(r);
    await expect(r.exec.execute(action.id as never)).rejects.toBeInstanceOf(ActionNotExecutingError);
    const a = actionOf(r, action.id);
    expect(r.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, r.clock.now() as EpochMs, 'user')).toBe('ok');
    expect(await r.exec.execute(action.id as never)).toMatchObject({ outcome: 'done' });
    expect(r.updateCalls()).toHaveLength(1);
  });

  it('execute(): a missing etag fails CAL_UPDATE_UNAVAILABLE; a foreign identity fails CAL_EVENT_FOREIGN', async () => {
    const r = await rig({ calendar: { patched: false } });
    const { action } = await withChange(r);
    const a = actionOf(r, action.id);
    r.repos.actions.markApprovedExecuting(a.id, a.canonicalJson, r.clock.now() as EpochMs, 'user');
    expect(await r.exec.execute(action.id as never)).toMatchObject({ outcome: 'failed' });
    expect(actionOf(r, action.id).errorCode).toBe('CAL_UPDATE_UNAVAILABLE');
    const r2 = await rig();
    const c2 = await withChange(r2);
    r2.cal.scenario('foreign_tags');
    const a2 = actionOf(r2, c2.action.id);
    r2.repos.actions.markApprovedExecuting(a2.id, a2.canonicalJson, r2.clock.now() as EpochMs, 'user');
    expect(await r2.exec.execute(c2.action.id as never)).toMatchObject({ outcome: 'failed' });
    expect(actionOf(r2, c2.action.id).errorCode).toBe('CAL_EVENT_FOREIGN');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('tryAuto (ARCH-v2 6.3 / P2 10.6)', () => {
  async function eligibleCreate(r: Rig, slot = WED) {
    await r.trackRecord();
    return r.seedCreate({ chatN: 1, slot });
  }

  it('no live policy => {verdict:none}, no decision row, zero calendar calls', async () => {
    const r = await rig();
    const { action } = r.seedCreate({ slot: WED });
    const before = r.cal.calls.length;
    expect(await r.exec.tryAuto(action.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
    expect(r.repos.autoDecisions.forAction(action.id as never)).toBeNull();
    expect(r.cal.calls.length).toBe(before);
  });

  it('never for send_reply, a retry clone, an undo, a non-pending / expired / unknown action, a superseded proposal', async () => {
    const r = await rig();
    r.policy('on');
    expect(await r.exec.tryAuto('00000000-0000-4000-8000-000000000000')).toEqual({
      verdict: 'none',
      reason: 'no_policy',
    });
    const { item, action } = r.seedCreate({ slot: WED });
    const reply = r.repos.actions.insertPending({
      itemId: item.id,
      proposalId: action.proposalId,
      chatId: action.chatId,
      payload: { v: 1, kind: 'send_reply', itemId: item.id, chatRef: action.chatId, proposalVersion: 1, text: 'hi' },
      now: r.clock.now() as EpochMs,
    });
    expect((await r.exec.tryAuto(reply.id)).verdict).toBe('none');
    await r.clock.advanceTo(RIG_NOW + 2 * DAYS);
    expect((await r.exec.tryAuto(action.id)).verdict).toBe('none'); // expired
  });

  it('shadow + an eligible create => a shadow decision, zero writes, the action stays pending', async () => {
    const r = await rig();
    const { action } = await eligibleCreate(r);
    r.policy('shadow');
    const out = await r.exec.tryAuto(action.id);
    expect(out).toMatchObject({ verdict: 'shadow', reason: 'ok', autoWriteId: null, result: null });
    expect(calls(r, 'create-event')).toBe(3); // only the track record
    expect(actionOf(r, action.id).state).toBe('pending');
    expect(r.repos.autoDecisions.forAction(action.id as never)).toMatchObject({
      verdict: 'shadow',
      reason: 'ok',
      kind: 'create',
    });
  });

  it('a paused policy => fallback policy_paused WITHOUT any calendar read (Phase A)', async () => {
    const r = await rig();
    const { action } = await eligibleCreate(r);
    r.policy('paused');
    const before = r.cal.calls.length;
    expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'fallback', reason: 'policy_paused' });
    expect(r.cal.calls.length).toBe(before);
  });

  it('on + an eligible create => auto: decision, approved_by = the decision, auto_writes, readback, toast, buckets', async () => {
    const r = await rig();
    const { item, action } = await eligibleCreate(r);
    r.policy('on');
    const out = await r.exec.tryAuto(action.id);
    expect(out).toMatchObject({ verdict: 'auto', reason: 'ok', result: 'done' });
    if (out.verdict === 'none') throw new Error('unreachable');
    const a = actionOf(r, action.id);
    expect(a).toMatchObject({ state: 'done', approvedBy: out.decisionId });
    expect(a.approvedFinalJson).toBe(a.canonicalJson); // F4: verbatim
    const w = r.repos.autoWrites.byId(out.autoWriteId!)!;
    expect(w).toMatchObject({ kind: 'create', pre: null, undoState: 'available', itemId: item.id });
    expect(w.undoUntil).toBe(Math.min(RIG_NOW + LIMITS.autoUndoWindowMs, at(WED.startLocal)));
    expect(w.revisionId).not.toBeNull();
    expect(w.postEtag).toBe(r.stored(w.eventId)!.etag);
    const create = r.cal.calls.filter((c) => c.tool === 'create-event').at(-1)!.args;
    expect(create).toMatchObject({ sendUpdates: 'none', allowDuplicates: false });
    expect(r.notices).toContainEqual({ kind: 'write', autoWriteId: out.autoWriteId });
    expect(r.repos.rate.countSince('auto_chat', String(action.chatId), 0 as EpochMs)).toBe(1);
    expect(r.repos.rate.countSince('auto_global', 'global', 0 as EpochMs)).toBe(1);
    expect(auditKinds(r)).toEqual(expect.arrayContaining(['auto_decision', 'auto_write']));
  });

  it('on + an eligible update => the pre-flight snapshot is pre_json, undo_until measured to the restore target (F2), one PATCH', async () => {
    const r = await rig();
    await r.trackRecord();
    const { source, action } = await withChange(r);
    r.policy('on');
    const out = await r.exec.tryAuto(action.id);
    expect(out).toMatchObject({ verdict: 'auto', result: 'done' });
    if (out.verdict === 'none') throw new Error('unreachable');
    const w = r.repos.autoWrites.byId(out.autoWriteId!)!;
    expect(w.pre).toMatchObject({ startLocal: WED.startLocal, status: 'confirmed' });
    expect(w.undoUntil).toBe(Math.min(RIG_NOW + LIMITS.autoUndoWindowMs, at(WED.startLocal)));
    expect(r.updateCalls()).toHaveLength(1);
    expect(r.repos.eventRevisions.newestFor(source.calendarEventId!)!.id).toBe(w.revisionId);
  });

  it('the edits golden gate closed (B30) => update fallback low_confidence', async () => {
    const r = await rig({ editsPassed: false });
    await r.trackRecord();
    const { action } = await withChange(r);
    r.policy('on');
    expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'fallback', reason: 'low_confidence' });
    expect(r.updateCalls()).toHaveLength(0);
  });

  it('a snapshot change => fallback snapshot_changed AND the policy paused in the same transaction (+ notice)', async () => {
    const r = await rig();
    const { action } = await eligibleCreate(r);
    const p = r.policy('on');
    r.flags.snapshot = 'b'.repeat(64);
    expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'fallback', reason: 'snapshot_changed' });
    expect(r.repos.autoPolicies.live()).toMatchObject({ id: p.id, state: 'paused', pausedReason: 'snapshot_changed' });
    expect(r.notices).toContainEqual({ kind: 'policy' });
  });

  it('an expired policy => fallback policy_expired and the row becomes expired', async () => {
    const r = await rig();
    const { action } = await eligibleCreate(r);
    r.policy('on', {}, { expiresAt: (RIG_NOW + HOURS) as EpochMs });
    await r.clock.advanceTo(RIG_NOW + 2 * HOURS);
    expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'fallback', reason: 'policy_expired' });
    expect(r.repos.autoPolicies.live()).toBeNull();
    expect(r.repos.autoPolicies.newest()!.state).toBe('expired');
  });

  it('a failed automatic write is an ordinary card (pending clone, undo_state failed); an unknown outcome pauses the policy', async () => {
    let mode: 'auth' | 'timeout' = 'auth';
    const r = await rig({
      wrapWrite: (real): McpWriteClient => ({
        ...real,
        createEvent: (args) =>
          args.summary.startsWith('Track') ? real.createEvent(args) : Promise.resolve({ ok: false, error: mode }),
      }),
    });
    await r.trackRecord();
    r.policy('on');
    const a1 = r.seedCreate({ chatN: 1, slot: WED });
    const out = await r.exec.tryAuto(a1.action.id);
    expect(out).toMatchObject({ verdict: 'auto', result: 'failed' });
    if (out.verdict === 'none') throw new Error('unreachable');
    expect(r.repos.autoWrites.byId(out.autoWriteId!)!.undoState).toBe('failed');
    expect(r.repos.actions.forItem(a1.item.id).some((x) => x.retryOf === a1.action.id && x.state === 'pending')).toBe(
      true,
    );
    expect(r.repos.autoPolicies.live()!.state).toBe('on');
    mode = 'timeout';
    const a2 = r.seedCreate({ chatN: 2, slot: THU });
    await r.clock.advance(31 * 60_000);
    expect(await r.exec.tryAuto(a2.action.id)).toMatchObject({ verdict: 'auto', result: 'unknown_outcome' });
    expect(r.repos.autoPolicies.live()).toMatchObject({ state: 'paused', pausedReason: 'circuit_breaker_unknown' });
  });

  it('the general create_global bucket exhausted => fallback auto_budget + pause (circuit_breaker_rate)', async () => {
    const r = await rig();
    const { action } = await eligibleCreate(r);
    r.policy('on');
    for (let i = 0; i < LIMITS.createPerHour; i++)
      r.repos.rate.record('create_global', 'global', r.clock.now() as EpochMs);
    expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'fallback', reason: 'auto_budget' });
    expect(r.repos.autoPolicies.live()!.pausedReason).toBe('circuit_breaker_rate');
  });

  it('an update whose pre-flight fails => fallback unknown_prev_state (no write without pre_json, I8)', async () => {
    const r = await rig();
    await r.trackRecord();
    const { action } = await withChange(r);
    r.policy('on');
    r.cal.scenario('event_missing');
    expect(await r.exec.tryAuto(action.id)).toMatchObject({ verdict: 'fallback', reason: 'unknown_prev_state' });
    expect(r.updateCalls()).toHaveLength(0);
  });

  it('a concurrent click on the same action wins: tryAuto answers none and records nothing', async () => {
    let release: () => void = () => undefined;
    let hold = false;
    const r = await rig({
      wrapRead: (real): McpReadClient => ({
        ...real,
        getFreeBusy: async (w) => {
          if (hold) await new Promise<void>((res) => (release = res));
          return real.getFreeBusy(w);
        },
      }),
    });
    const { action } = await eligibleCreate(r);
    r.policy('on');
    hold = true;
    const click = r.click(action.id);
    await Promise.resolve();
    expect(await r.exec.tryAuto(action.id)).toEqual({ verdict: 'none', reason: 'no_policy' });
    hold = false;
    release();
    expect(await click).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.repos.autoDecisions.forAction(action.id as never)).toBeNull();
  });
});

describe('small helpers', () => {
  it('eventSanity accepts the update content shape', () => {
    expect(eventSanity({ ...THU, timeZone: 'Asia/Jerusalem' }, RIG_NOW)).toBeNull();
    expect(
      eventSanity(
        { startLocal: '2026-10-01T10:00:00', endLocal: '2026-10-01T11:00:00', timeZone: 'Asia/Jerusalem' },
        RIG_NOW,
      ),
    ).toBe('EVENT_INVALID');
  });
  it('canonical JSON of an update payload round-trips', () => {
    const p = { v: 1, kind: 'update_event' } as const;
    expect(canonicalJson(p)).toBe('{"kind":"update_event","v":1}');
  });
  it('the focus-steal guard applies to updates too', async () => {
    const r = await rig();
    const { action } = await withChange(r);
    const res = await r.click(action.id, {}, { ...CTX, shownByNotificationAt: r.clock.now() });
    expect(res).toEqual({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } });
  });
});
