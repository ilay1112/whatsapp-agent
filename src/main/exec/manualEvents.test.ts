// src/main/exec/manualEvents.test.ts - [v4 T6] T-908 handover §2.5 / §3 (I1', I8, I9'): manual (calendar-view) management.
// REAL in-memory app DB (production repos + the v6 triggers), the fake calendar behind the REAL read / write / list clients, the
// REAL CalendarEventsService (so proposals resolve the opaque eventKey exactly like the IPC path), a virtual clock. Every test ends
// with the side-effect ledger (rule 13: each manual call is proven by a click-approved manual action + its snapshot row; rule 8:
// no other delete-event).
// Pinned review items: (1) propose never writes; (2) action:approve is the only executor entry; (3) I9' refused in main even when the
// UI is bypassed; (4) the snapshot is in event_revisions in the write-ahead transaction, before update-event / delete-event;
// (5) undo of a delete recreates from the snapshot (new id, app-tagged), a second undo is refused; (6) never automatic;
// (7) delete-event only for manual actions.
import { afterEach, describe, expect, it } from 'vitest';
import { RIG_TZ, CTX, makeExecRig, type Rig } from '../../../tests/helpers/ledger.execRig';
import { assertLedger } from '../../../tests/helpers/ledger';
import { V4_CALENDARS, V4_EVENT_IDS, v4CalendarSeed } from '../../../tests/fakes/fake-mcp-calendar';
import { createCalendarEventsService, foreignEventKeyOf } from '../mcp/calendarEvents';
import { createMcpCalendarListClient, createMcpReadClient } from '../mcp/readClient';
import { createMcpWriteClient } from '../mcp/writeClient';
import { canonicalJson } from '../../shared/schemas';
import { localToEpochMs } from '../../shared/when';
import { evaluateAutoGate } from './autoGate';
import { sha256Hex } from './actionHash';
import { createManualProposals, manualOwnershipOf, type ManualProposals } from './manualEvents';
import type { EpochMs, ManualProposal } from '../../shared/types';
import type { ManualActionPayload } from '../../shared/schemas';
import type { OwnedEventProjection } from '../mcp/readClient';

const DAY = '2026-10-07'; // RIG_NOW = Mon 2026-10-05 10:00 Jerusalem; the seed sits on Wed + Thu
const NEXT = '2026-10-08';
const ROLES = { primary: 'owner', [V4_CALENDARS.work]: 'writer', [V4_CALENDARS.holidays]: 'reader' } as const;

interface World {
  r: Rig;
  proposals: ManualProposals;
  /** the week read the view does first (fills the cache the eventKeys resolve from) */
  readWeek(): Promise<void>;
  writes(): Array<{ tool: string; args: Record<string, unknown> }>;
  approve(p: ManualProposal): ReturnType<Rig['exec']['approve']>;
  audits(): string[];
}

const rigs: Rig[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});

async function world(): Promise<World> {
  const seed = v4CalendarSeed(DAY, RIG_TZ);
  const r = await makeExecRig({ calendar: { calendars: seed.calendars, seedEvents: seed.events } });
  rigs.push(r);
  r.repos.meta.set('calendar_roles_json', JSON.stringify(ROLES));
  const calendarEvents = createCalendarEventsService({
    list: createMcpCalendarListClient(r.cal.callerFor('read') as never),
    roles: () => ROLES,
    timeZone: () => RIG_TZ,
    lang: () => 'he',
    connected: () => true,
    clock: { now: () => r.clock.now() as EpochMs },
    log: { warn: () => undefined },
  });
  const audit = (kind: never, ref: string | null, detail: Record<string, string | number | boolean | null>): void =>
    r.repos.audit.append(kind, ref, detail, r.clock.now() as EpochMs);
  // NOTE: no write client anywhere in these deps - proposing cannot write (I1')
  const proposals = createManualProposals({
    repos: r.repos,
    read: createMcpReadClient(r.cal.callerFor('read') as never),
    resolve: (c, k) => calendarEvents.resolve(c, k),
    roles: () => ROLES,
    timeZone: () => RIG_TZ,
    calendarConnected: () => true,
    now: () => r.clock.now() as EpochMs,
    audit: audit as never,
  });
  return {
    r,
    proposals,
    readWeek: async () => {
      const res = await calendarEvents.listEvents({
        anchorMs: localToEpochMs(`${DAY}T12:00:00`, RIG_TZ) as EpochMs,
        calendarIds: Object.keys(ROLES),
      });
      expect(res.ok).toBe(true);
    },
    writes: () =>
      r.cal.calls.filter((c) => c.tool === 'create-event' || c.tool === 'update-event' || c.tool === 'delete-event'),
    approve: (p) => r.exec.approve({ actionId: p.actionId, kind: p.kind, shownHash: p.shownHash }, CTX),
    audits: () =>
      r.db
        .prepare<{ kind: string }>(`SELECT kind FROM audit_log ORDER BY id`)
        .all()
        .map((x) => x.kind),
  };
}

const key = (eventId: string): string => foreignEventKeyOf(eventId);
const ok = <T>(res: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.value;
};
const ledger = (w: World): void => {
  assertLedger({
    calendar: { calls: w.r.cal.calls, violations: w.r.cal.violations, appCreated: w.r.cal.appCreated },
    db: w.r.db,
  });
};

// ---------------------------------------------------------------------------------------------------------------------
describe('(1) calendar:propose* never writes - one pending source:manual action with its shownHash', () => {
  it('create / edit / delete proposals: zero write calls, a pending manual row each (the newest supersedes the older)', async () => {
    const w = await world();
    await w.readWeek();
    const c = ok(
      await w.proposals.proposeCreate({
        calendarId: V4_CALENDARS.work,
        title: '  Gym​ ',
        startLocal: `${DAY}T18:00:00`,
        endLocal: `${DAY}T19:00:00`,
        location: '',
      }),
    );
    const e = ok(
      await w.proposals.proposeEdit({
        calendarId: 'primary',
        eventKey: key(V4_EVENT_IDS.plain),
        patch: { startLocal: `${DAY}T12:00:00`, endLocal: `${DAY}T13:00:00` },
      }),
    );
    const d = ok(await w.proposals.proposeDelete({ calendarId: 'primary', eventKey: key(V4_EVENT_IDS.plain) }));
    expect(w.writes()).toEqual([]);
    for (const p of [c, e, d]) {
      const row = w.r.repos.actions.manualById(p.actionId)!;
      expect(row.source).toBe('manual');
      expect(p.shownHash).toBe(sha256Hex(row.canonicalJson));
      expect(w.r.repos.actions.byId(p.actionId)).toBeNull(); // invisible to every chat path
    }
    expect(w.r.repos.actions.manualById(c.actionId)!.state).toBe('superseded');
    expect(w.r.repos.actions.manualById(e.actionId)!.state).toBe('superseded');
    expect(w.r.repos.actions.manualById(d.actionId)!.state).toBe('pending');
    expect(c).toMatchObject({ kind: 'create_event', summary: { op: 'create', calendarId: V4_CALENDARS.work } });
    expect(c.summary.after).toMatchObject({ title: 'Gym', startLocal: `${DAY}T18:00:00` });
    expect(e.summary).toMatchObject({
      op: 'edit',
      before: { title: 'Dentist', startLocal: `${DAY}T10:00:00` },
      after: { title: 'Dentist', startLocal: `${DAY}T12:00:00`, location: 'Clinic' },
    });
    // no Google event id in anything the renderer receives
    expect(JSON.stringify([c, e, d])).not.toContain(V4_EVENT_IDS.plain);
    expect(w.audits().filter((k) => k === 'manual_event_proposed')).toHaveLength(3);
    ledger(w);
  });

  it('an eventKey the week cache does not hold => CAL_EVENT_GONE (the view re-reads); a bad slot => EVENT_INVALID', async () => {
    const w = await world();
    expect(await w.proposals.proposeDelete({ calendarId: 'primary', eventKey: key(V4_EVENT_IDS.plain) })).toEqual({
      ok: false,
      error: { code: 'CAL_EVENT_GONE' },
    });
    await w.readWeek();
    expect(
      await w.proposals.proposeCreate({
        calendarId: 'primary',
        title: 'x',
        startLocal: `${DAY}T10:00:00`,
        endLocal: `${DAY}T10:02:00`,
        location: '',
      }),
    ).toEqual({ ok: false, error: { code: 'EVENT_INVALID' } });
    expect(w.writes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("(3) I9' in main: attendees / recurring / chat-owned / read-only are refused even when the UI is bypassed", () => {
  it('propose refuses with CAL_EVENT_FOREIGN_PROTECTED and audits the reason (no write)', async () => {
    const w = await world();
    await w.readWeek();
    for (const [calendarId, id] of [
      [V4_CALENDARS.work, V4_EVENT_IDS.attendees],
      [V4_CALENDARS.work, V4_EVENT_IDS.recurring],
      ['primary', V4_EVENT_IDS.appOwned],
      [V4_CALENDARS.holidays, V4_EVENT_IDS.allDay],
    ] as const) {
      expect(await w.proposals.proposeDelete({ calendarId, eventKey: key(id) }), id).toEqual({
        ok: false,
        error: { code: 'CAL_EVENT_FOREIGN_PROTECTED' },
      });
    }
    expect(
      await w.proposals.proposeCreate({
        calendarId: V4_CALENDARS.holidays,
        title: 'x',
        startLocal: `${DAY}T10:00:00`,
        endLocal: `${DAY}T11:00:00`,
        location: '',
      }),
    ).toEqual({ ok: false, error: { code: 'CAL_EVENT_FOREIGN_PROTECTED' } });
    expect(w.writes()).toEqual([]);
    const reasons = w.r.db
      .prepare<{ d: string }>(`SELECT detail_json AS d FROM audit_log WHERE kind = 'manual_event_refused'`)
      .all()
      .map((x) => (JSON.parse(x.d) as { reason: string }).reason);
    expect(reasons).toEqual(['attendees', 'recurring', 'from_chat', 'all_day', 'readonly']);
  });

  it('a hand-made pending action on the attendee / recurring event (UI bypassed) is refused by the executor: zero writes', async () => {
    const w = await world();
    const from = {
      title: 'Team sync',
      startLocal: `${NEXT}T09:00:00`,
      endLocal: `${NEXT}T10:00:00`,
      timeZone: RIG_TZ,
      location: '',
      status: 'confirmed' as const,
    };
    for (const eventId of [V4_EVENT_IDS.attendees, V4_EVENT_IDS.recurring]) {
      const payload: ManualActionPayload = {
        v: 1,
        source: 'manual',
        kind: 'update_event',
        calendarId: V4_CALENDARS.work,
        eventId,
        baseEtag: '"x"',
        from,
        to: {
          title: 'Hijacked',
          timeZone: RIG_TZ,
          location: '',
          startLocal: `${NEXT}T11:00:00`,
          endLocal: `${NEXT}T12:00:00`,
        },
      };
      const a = w.r.repos.actions.insertManualPending({ payload, now: w.r.clock.now() as EpochMs });
      const res = await w.r.exec.approve({ actionId: a.id, kind: a.kind, shownHash: a.contentSha256 }, CTX);
      expect(res).toEqual({ ok: false, error: { code: 'CAL_EVENT_FOREIGN_PROTECTED' } });
      expect(w.r.repos.actions.manualById(a.id)!.state).toBe('rejected'); // cannot be clicked again
    }
    expect(w.writes()).toEqual([]);
    expect(w.r.cal.violations).toEqual([]);
  });

  it('manualOwnershipOf (pure): the first refusal wins; the stored role decides writability', () => {
    const pf = (over: Partial<OwnedEventProjection> = {}): OwnedEventProjection => ({
      id: 'abcdefgh01',
      status: 'confirmed',
      startLocal: '2026-10-07T10:00:00',
      endLocal: '2026-10-07T11:00:00',
      timeZone: RIG_TZ,
      summary: 's',
      location: '',
      etag: '"1"',
      updated: null,
      sequence: 0,
      creatorSelf: true,
      organizerSelf: true,
      hasAttendees: false,
      hasRecurrence: false,
      priv: { waAgent: null, waItem: null, waAction: null, waUpdate: null, waRev: null },
      ...over,
    });
    const t = { calendarId: 'primary', eventId: 'abcdefgh01' };
    expect(manualOwnershipOf(pf(), t, { primary: 'owner' })).toBe('ok');
    expect(manualOwnershipOf(pf(), t, { primary: 'writer' })).toBe('ok');
    expect(manualOwnershipOf(pf(), t, { primary: 'reader' })).toBe('readonly');
    expect(manualOwnershipOf(pf(), t, {})).toBe('readonly');
    expect(manualOwnershipOf(pf({ id: 'other00001' }), t, { primary: 'owner' })).toBe('mismatch');
    expect(manualOwnershipOf(pf({ hasAttendees: true, hasRecurrence: true }), t, { primary: 'owner' })).toBe(
      'attendees',
    );
    expect(manualOwnershipOf(pf({ hasRecurrence: true }), t, { primary: 'owner' })).toBe('recurring');
    expect(
      manualOwnershipOf(pf({ priv: { waAgent: '1', waItem: '7', waAction: 'r', waUpdate: null, waRev: null } }), t, {
        primary: 'owner',
      }),
    ).toBe('from_chat');
    expect(manualOwnershipOf(pf({ status: 'cancelled' }), t, { primary: 'owner' })).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('(2)(4) approve: the action:approve click executes; snapshot first, in the write-ahead transaction', () => {
  it("edit: at the moment update-event arrives the action is executing and the snapshot row holds Google's pre-state", async () => {
    const w = await world();
    await w.readWeek();
    const p = ok(
      await w.proposals.proposeEdit({
        calendarId: 'primary',
        eventKey: key(V4_EVENT_IDS.plain),
        patch: { title: 'Dentist (moved)', startLocal: `${DAY}T12:00:00`, endLocal: `${DAY}T13:00:00` },
      }),
    );
    const etagBefore = w.r.stored(V4_EVENT_IDS.plain)!.etag;
    const seen: Array<{ state: string; prev: string | null; kind: string }> = [];
    w.r.cal.onBeforeCall((tool) => {
      if (tool !== 'update-event') return;
      const a = w.r.repos.actions.manualById(p.actionId)!;
      const rev = w.r.db
        .prepare<{ prev_json: string | null; kind: string }>(
          `SELECT prev_json, kind FROM event_revisions WHERE action_id = ?`,
        )
        .get(p.actionId);
      seen.push({ state: a.state, prev: rev?.prev_json ?? null, kind: rev?.kind ?? '' });
    });
    const res = await w.approve(p);
    expect(res).toMatchObject({
      ok: true,
      value: { outcome: 'done', item: null, manual: { op: 'edit', undoable: true } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toBe('executing');
    expect(seen[0]!.kind).toBe('manual_edit');
    expect(JSON.parse(seen[0]!.prev!)).toMatchObject({
      title: 'Dentist',
      startLocal: `${DAY}T10:00:00`,
      location: 'Clinic',
    });
    const [call] = w.writes();
    expect(w.writes()).toHaveLength(1);
    expect(call!.args).toEqual({
      calendarId: 'primary',
      account: 'personal',
      eventId: V4_EVENT_IDS.plain,
      summary: 'Dentist (moved)',
      start: `${DAY}T12:00:00`,
      end: `${DAY}T13:00:00`,
      timeZone: RIG_TZ,
      location: 'Clinic',
      sendUpdates: 'none',
      checkConflicts: false,
      ifMatch: etagBefore, // I7': If-Match = the pre-flight etag
    });
    expect(w.r.stored(V4_EVENT_IDS.plain)).toMatchObject({ summary: 'Dentist (moved)', priv: {} }); // never tagged as ours
    expect(w.r.repos.actions.manualById(p.actionId)).toMatchObject({ state: 'done', approvedBy: 'user' });
    expect(w.audits()).toEqual(expect.arrayContaining(['action_approved', 'action_done', 'manual_event_executed']));
    ledger(w);
  });

  it('delete: snapshot row (manual_delete, prev = Google copy) is committed before delete-event; one delete call', async () => {
    const w = await world();
    await w.readWeek();
    const p = ok(await w.proposals.proposeDelete({ calendarId: 'primary', eventKey: key(V4_EVENT_IDS.plain) }));
    const seen: string[] = [];
    w.r.cal.onBeforeCall((tool) => {
      if (tool !== 'delete-event') return;
      const rev = w.r.repos.eventRevisions.manualForAction(p.actionId);
      seen.push(`${w.r.repos.actions.manualById(p.actionId)!.state}:${rev?.kind}:${rev?.prev?.title}`);
    });
    expect(await w.approve(p)).toMatchObject({ ok: true, value: { outcome: 'done', manual: { op: 'delete' } } });
    expect(seen).toEqual(['executing:manual_delete:Dentist']);
    expect(w.writes().map((c) => c.tool)).toEqual(['delete-event']);
    expect(w.writes()[0]!.args).toEqual({
      calendarId: 'primary',
      eventId: V4_EVENT_IDS.plain,
      account: 'personal',
      sendUpdates: 'none',
    });
    expect(w.r.stored(V4_EVENT_IDS.plain)!.status).toBe('cancelled');
    ledger(w);
  });

  it('create on a second calendar: ONE create-event with that calendarId, tagged waAgent + waManual + waAction (no waItem)', async () => {
    const w = await world();
    const p = ok(
      await w.proposals.proposeCreate({
        calendarId: V4_CALENDARS.work,
        title: 'Gym',
        startLocal: `${DAY}T18:00:00`,
        endLocal: `${DAY}T19:00:00`,
        location: 'Hall',
      }),
    );
    expect(await w.approve(p)).toMatchObject({ ok: true, value: { outcome: 'done', manual: { op: 'create' } } });
    const creates = w.writes().filter((c) => c.tool === 'create-event');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args).toMatchObject({
      calendarId: V4_CALENDARS.work,
      summary: 'Gym',
      location: 'Hall',
      sendUpdates: 'none',
      extendedProperties: { private: { waAgent: '1', waManual: '1', waAction: p.actionId } },
    });
    expect((creates[0]!.args.extendedProperties as { private: object }).private).not.toHaveProperty('waItem');
    ledger(w);
  });

  it('a second approve of the same action, a wrong hash, an edit or a stale Google copy are refused before any write', async () => {
    const w = await world();
    await w.readWeek();
    const p = ok(await w.proposals.proposeDelete({ calendarId: 'primary', eventKey: key(V4_EVENT_IDS.plain) }));
    expect(await w.r.exec.approve({ actionId: p.actionId, kind: p.kind, shownHash: 'f'.repeat(64) }, CTX)).toEqual({
      ok: false,
      error: { code: 'ACTION_STALE' },
    });
    expect(await w.r.exec.approve({ actionId: p.actionId, kind: 'update_event', shownHash: p.shownHash }, CTX)).toEqual(
      {
        ok: false,
        error: { code: 'ACTION_STALE' },
      },
    );
    w.r.cal.userEditsInGoogle(V4_EVENT_IDS.plain, { summary: 'Dentist - moved by someone' });
    expect(await w.approve(p)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(w.writes()).toEqual([]);
    expect(w.r.repos.actions.manualById(p.actionId)!.state).toBe('pending');
  });

  it('tryAuto / AutoGate never act on a manual action (6): none recorded, nothing written; AutoGate answers manual_only', async () => {
    const w = await world();
    w.r.policy('on');
    const p = ok(
      await w.proposals.proposeCreate({
        calendarId: 'primary',
        title: 'Gym',
        startLocal: `${DAY}T18:00:00`,
        endLocal: `${DAY}T19:00:00`,
        location: '',
      }),
    );
    expect(await w.r.exec.tryAuto(p.actionId)).toEqual({ verdict: 'none', reason: 'no_policy' });
    expect(w.r.repos.autoDecisions.forAction(p.actionId)).toBeNull();
    expect(w.writes()).toEqual([]);
    // AutoGate itself, handed a manual action with every other check green
    const { allClearCreate } = await import('./autoGate.fixtures');
    const base = allClearCreate();
    expect(evaluateAutoGate({ ...base, action: { ...base.action, source: 'manual' } })).toMatchObject({
      verdict: 'fallback',
      reason: 'manual_only',
    });
    expect(evaluateAutoGate(base)).toMatchObject({ verdict: 'auto', reason: 'ok' });
    // and the database refuses a non-click approver for a manual row (trg_actions_state)
    const row = w.r.repos.actions.manualById(p.actionId)!;
    expect(
      w.r.repos.actions.markApprovedExecuting(row.id, row.canonicalJson, w.r.clock.now() as EpochMs, 'user_toast'),
    ).toBe('stale');
  });

  it('[review fix] reject (Cancel on cal-confirm) closes a pending manual proposal: no write, no item touched, approve then refused', async () => {
    const w = await world();
    await w.readWeek();
    const p = ok(await w.proposals.proposeDelete({ calendarId: 'primary', eventKey: key(V4_EVENT_IDS.plain) }));
    const changed = w.r.changed.length;
    expect(await w.r.exec.reject(p.actionId)).toEqual({ ok: true, value: null });
    expect(w.r.repos.actions.manualById(p.actionId)!.state).toBe('rejected');
    expect(w.r.changed.length).toBe(changed); // no item to re-render
    expect(w.audits()).toContain('action_rejected');
    expect(await w.approve(p)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(await w.r.exec.reject(p.actionId)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(w.writes()).toEqual([]);
    ledger(w);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('(5) undo', () => {
  it('undo of a delete recreates from the snapshot (NEW id, app-tagged, no attendees); a second undo is refused', async () => {
    const w = await world();
    await w.readWeek();
    const p = ok(await w.proposals.proposeDelete({ calendarId: 'primary', eventKey: key(V4_EVENT_IDS.plain) }));
    ok(await w.approve(p));
    const undo = await w.r.exec.undoManual(p.actionId, CTX);
    expect(undo).toMatchObject({ ok: true, value: { outcome: 'done', manual: { op: 'undo', undoable: false } } });
    const creates = w.writes().filter((c) => c.tool === 'create-event');
    expect(creates).toHaveLength(1);
    const args = creates[0]!.args;
    expect(args.eventId).not.toBe(V4_EVENT_IDS.plain);
    expect(args).toMatchObject({
      calendarId: 'primary',
      summary: 'Dentist',
      start: `${DAY}T10:00:00`,
      end: `${DAY}T11:00:00`,
      location: 'Clinic',
      extendedProperties: { private: { waAgent: '1', waManual: '1' } },
    });
    expect(args).not.toHaveProperty('attendees');
    const recreated = w.r.stored(String(args.eventId))!;
    expect(recreated).toMatchObject({ summary: 'Dentist', attendees: 0, status: 'confirmed' });
    // the delete's snapshot row is reverted by the undo row
    const rev = w.r.repos.eventRevisions.manualForAction(p.actionId)!;
    expect(rev.revertedBy).not.toBeNull();
    expect(w.r.repos.eventRevisions.manualById(rev.revertedBy!)!.kind).toBe('manual_undo');
    // a second undo: refused, nothing written
    const before = w.writes().length;
    expect(await w.r.exec.undoManual(p.actionId, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    expect(w.writes()).toHaveLength(before);
    ledger(w);
  });

  it('undo of an edit PATCHes back to the snapshot; undo of a create deletes it; the popover lookup follows', async () => {
    const w = await world();
    await w.readWeek();
    const e = ok(
      await w.proposals.proposeEdit({
        calendarId: 'primary',
        eventKey: key(V4_EVENT_IDS.plain),
        patch: { location: 'Room 2' },
      }),
    );
    ok(await w.approve(e));
    expect(w.r.exec.manualUndoableFor(V4_EVENT_IDS.plain)).toBe(e.actionId);
    ok(await w.r.exec.undoManual(e.actionId, CTX));
    expect(w.r.stored(V4_EVENT_IDS.plain)).toMatchObject({ location: 'Clinic', summary: 'Dentist' });
    expect(w.r.exec.manualUndoableFor(V4_EVENT_IDS.plain)).toBeNull();

    const c = ok(
      await w.proposals.proposeCreate({
        calendarId: 'primary',
        title: 'Gym',
        startLocal: `${DAY}T18:00:00`,
        endLocal: `${DAY}T19:00:00`,
        location: '',
      }),
    );
    ok(await w.approve(c));
    const createdId = String(w.writes().find((x) => x.tool === 'create-event')!.args.eventId);
    expect(w.r.exec.manualUndoableFor(createdId)).toBe(c.actionId);
    ok(await w.r.exec.undoManual(c.actionId, CTX));
    expect(w.r.stored(createdId)!.status).toBe('cancelled');
    expect(w.writes().map((x) => x.tool)).toEqual(['update-event', 'update-event', 'create-event', 'delete-event']);
    ledger(w);
  });

  it('an undo is refused when Google changed the event since the write, or after the 7-day window', async () => {
    const w = await world();
    await w.readWeek();
    const e = ok(
      await w.proposals.proposeEdit({
        calendarId: 'primary',
        eventKey: key(V4_EVENT_IDS.plain),
        patch: { location: 'Room 2' },
      }),
    );
    ok(await w.approve(e));
    w.r.cal.userEditsInGoogle(V4_EVENT_IDS.plain, { summary: 'Edited in Google' });
    expect(await w.r.exec.undoManual(e.actionId, CTX)).toEqual({ ok: false, error: { code: 'ACTION_STALE' } });
    const w2 = await world();
    await w2.readWeek();
    const e2 = ok(
      await w2.proposals.proposeEdit({
        calendarId: 'primary',
        eventKey: key(V4_EVENT_IDS.plain),
        patch: { location: 'X' },
      }),
    );
    ok(await w2.approve(e2));
    await w2.r.clock.advance(8 * 24 * 3_600_000);
    expect(await w2.r.exec.undoManual(e2.actionId, CTX)).toEqual({ ok: false, error: { code: 'ACTION_EXPIRED' } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('(7) delete-event is reachable only for source:manual', () => {
  it('a chat cancel stays update-event status cancelled: zero delete-event calls', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const source = await r.createByClick({ slot: { startLocal: `${DAY}T15:00:00`, endLocal: `${DAY}T16:00:00` } });
    const { action } = r.seedDelta({ source, change: 'cancel' });
    expect(await r.click(action.id)).toMatchObject({ ok: true, value: { outcome: 'done' } });
    expect(r.cal.calls.filter((c) => c.tool === 'delete-event')).toEqual([]);
    expect(r.updateCalls().map((a) => a.status)).toEqual(['cancelled']);
  });

  it('the write facade and the narrowed caller refuse delete-event without source manual (nothing reaches the server)', async () => {
    const r = await makeExecRig();
    rigs.push(r);
    const write = createMcpWriteClient(r.cal.callerFor('write') as never);
    expect(
      await write.deleteManualEvent({ source: 'chat' as never, calendarId: 'primary', eventId: 'abcdefgh01' }),
    ).toEqual({ ok: false, error: 'invalid_args' });
    expect(
      await (r.cal.callerFor('write') as never as (t: string, a: object) => Promise<unknown>)('delete-event', {}),
    ).toEqual({
      ok: false,
      error: 'invalid_args',
    });
    expect(r.cal.calls).toEqual([]);
  });

  it('the chat payload schema never parses a manual payload and vice versa (the two executor paths cannot cross)', async () => {
    const { ActionPayloadSchema, ManualActionPayloadSchema } = await import('../../shared/schemas');
    const manual = {
      v: 1,
      source: 'manual',
      kind: 'delete_event',
      calendarId: 'primary',
      eventId: 'abcdefgh01',
      baseEtag: '"1"',
      from: {
        title: 't',
        startLocal: `${DAY}T10:00:00`,
        endLocal: `${DAY}T11:00:00`,
        timeZone: RIG_TZ,
        location: '',
        status: 'confirmed',
      },
    };
    expect(ManualActionPayloadSchema.safeParse(manual).success).toBe(true);
    expect(ActionPayloadSchema.safeParse(manual).success).toBe(false);
    expect(canonicalJson(ManualActionPayloadSchema.parse(manual))).toContain('"source":"manual"');
  });
});
