// src/main/mcp/host.fakeCalendar.test.ts - [V2] the fake calendar v2 itself (T2 3.7; owner V2-W1-02).
// The fake is the stand-in every executor / auto-mode / undo test relies on, so its v2 behaviour is pinned here: real get-event /
// update-event handlers, If-Match + the vendored 412 text, every scenario, every global violation, the probe hook and the ledger
// helpers for rules 8 and 9. (Parity of its tools/list with the real server: tests/integration/mcp-real-toolslist.test.ts.)
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FAKE_MCP_TOOLS,
  createFakeCalendar,
  createFakeMcpCalendar,
  neverDeleteProblems,
  neverForeignProblems,
  shiftWall,
  vendoredPreconditionText,
} from '../../../tests/fakes/fake-mcp-calendar';
import type {
  FakeCalendarOptions,
  FakeCalendarV2Scenario,
  FakeEvent,
  FakeMcpCalendar,
} from '../../../tests/fakes/fake-mcp-calendar';
import { MCP_TOOLS } from './readClient';

const ID = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const TZ = 'Asia/Jerusalem';
const APP_TAGS = { waAgent: '1', waItem: '42', waAction: 'root-action-1' };
const open: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const x of open.splice(0)) await x.stop().catch(() => undefined);
});

/** A raw MCP client on a fresh fake (no capability gate in between - the fake's own nets are what is tested). */
async function raw(opts: FakeCalendarOptions = {}, scenarios: FakeCalendarV2Scenario[] = []) {
  const fake = createFakeCalendar({ timeZone: TZ, ...opts, v2Scenarios: scenarios });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(s);
  const client = new Client({ name: 'fake-v2-probe', version: '0.0.0' });
  await client.connect(c);
  open.push({ stop: async () => (await client.close(), await fake.server.close()) });
  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content as Array<{ text?: string }>) ?? [];
    return { text: content.map((b) => b.text ?? '').join('\n'), isError: res.isError === true };
  };
  return { fake, call, client };
}

const create = (eventId = ID): Record<string, unknown> => ({
  calendarId: 'primary',
  account: 'personal',
  summary: 'Dentist',
  start: '2026-10-01T15:00:00',
  end: '2026-10-01T16:00:00',
  timeZone: TZ,
  description: 'template',
  sendUpdates: 'none',
  allowDuplicates: false,
  eventId,
  extendedProperties: { private: { ...APP_TAGS } },
});
const update = (etag: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  calendarId: 'primary',
  account: 'personal',
  eventId: ID,
  summary: 'Dentist',
  start: '2026-10-01T17:00:00',
  end: '2026-10-01T18:00:00',
  timeZone: TZ,
  location: '',
  status: 'confirmed',
  sendUpdates: 'none',
  checkConflicts: false,
  ifMatch: etag,
  extendedProperties: { private: { ...APP_TAGS, waUpdate: 'upd-1', waRev: '2' } },
  ...over,
});
const getArgs = (fields?: string[]) => ({
  calendarId: 'primary',
  eventId: ID,
  account: 'personal',
  ...(fields ? { fields } : {}),
});
const eventOf = (text: string): Record<string, unknown> =>
  (JSON.parse(text) as { event: Record<string, unknown> }).event;

describe('constants and helpers', () => {
  it('FAKE_MCP_TOOLS mirrors MCP_TOOLS; the 412 text is the vendored one', () => {
    expect(FAKE_MCP_TOOLS).toEqual(MCP_TOOLS);
    const patch = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../vendor/calendar-mcp.patch.json', import.meta.url)), 'utf8'),
    ) as { preconditionErrorText: string };
    expect(vendoredPreconditionText()).toBe(patch.preconditionErrorText);
    expect(vendoredPreconditionText()).toBe(patch.preconditionErrorText); // cached
  });

  it('shiftWall moves the wall clock and keeps an offset; anything else is returned unchanged', () => {
    expect(shiftWall('2026-10-01T23:30:00', 60)).toBe('2026-10-02T00:30:00');
    expect(shiftWall('2026-10-01T15:00:00+03:00', -30)).toBe('2026-10-01T14:30:00+03:00');
    expect(shiftWall('tomorrow', 60)).toBe('tomorrow');
  });
});

describe('get-event / update-event handlers (patched default)', () => {
  it('create -> get-event with etag/updated/sequence/creator/organizer/tags; the field mask is honoured', async () => {
    const { fake, call } = await raw();
    expect((await call('create-event', create())).isError).toBe(false);
    const full = eventOf((await call('get-event', getArgs())).text);
    expect(full).toMatchObject({
      id: ID,
      status: 'confirmed',
      sequence: 0,
      creator: { self: true },
      organizer: { self: true },
      extendedProperties: { private: APP_TAGS },
      start: { dateTime: '2026-10-01T15:00:00', timeZone: TZ },
    });
    expect(String(full.etag)).toMatch(/^"\d+"$/);
    const masked = eventOf((await call('get-event', getArgs(['etag']))).text);
    expect(Object.keys(masked)).toContain('etag');
    expect(Object.keys(masked)).not.toContain('extendedProperties');
    const noEtag = eventOf((await call('get-event', getArgs(['updated']))).text);
    expect(noEtag.etag).toBeUndefined();
    expect(fake.appCreated).toEqual([{ eventId: ID, priv: APP_TAGS }]);
  });

  it('update-event applies an absolute patch, bumps etag/updated/sequence, merges the private map, ignores sendUpdates', async () => {
    const { fake, call } = await raw();
    await call('create-event', create());
    const before = fake.storedEvents[0];
    const res = await call('update-event', update(String(before?.etag), { location: 'Clinic' }));
    expect(res.isError).toBe(false);
    const after = fake.storedEvents[0];
    expect(after).toMatchObject({ start: '2026-10-01T17:00:00', location: 'Clinic', sequence: 1, status: 'confirmed' });
    expect(after?.etag).not.toBe(before?.etag);
    expect(after && before && after.updated > before.updated).toBe(true);
    expect(after?.priv).toEqual({ ...APP_TAGS, waUpdate: 'upd-1', waRev: '2' });
    expect(eventOf(res.text).status).toBe('confirmed');
    expect(fake.violations).toEqual([]);
  });

  it('If-Match: a stale etag answers the vendored 412 text and changes nothing', async () => {
    const { fake, call } = await raw();
    await call('create-event', create());
    const res = await call('update-event', update('"stale"'));
    expect(res).toEqual({ text: `MCP error -32600: ${vendoredPreconditionText()}`, isError: true });
    expect(fake.storedEvents[0]?.start).toBe('2026-10-01T15:00:00');
  });

  it('cancel: get-event still returns it (status cancelled); list-events and free/busy no longer see it', async () => {
    const { fake, call } = await raw();
    await call('create-event', create());
    await call('update-event', update(String(fake.storedEvents[0]?.etag), { status: 'cancelled' }));
    expect(eventOf((await call('get-event', getArgs())).text).status).toBe('cancelled');
    const listed = JSON.parse(
      (await call('list-events', { calendarId: 'primary', privateExtendedProperty: ['waAction=root-action-1'] })).text,
    ) as { events: unknown[] };
    expect(listed.events).toEqual([]);
    const fb = JSON.parse(
      (
        await call('get-freebusy', {
          calendars: [{ id: 'primary' }],
          timeMin: '2026-10-01T00:00:00',
          timeMax: '2026-10-02T00:00:00',
        })
      ).text,
    ) as { calendars: { primary: { busy: unknown[] } } };
    expect(fb.calendars.primary.busy).toEqual([]);
    expect(fake.storedEvents[0]?.status).toBe('cancelled');
  });

  it('unknown event / other calendar => the real not-found texts; a tentative status is refused as a violation', async () => {
    const { fake, call } = await raw();
    expect(await call('get-event', getArgs())).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not found/),
    });
    expect(await call('update-event', update('"1"'))).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not found/i),
    });
    await call('create-event', create());
    expect(await call('get-event', { ...getArgs(), calendarId: 'other' })).toMatchObject({ isError: true });
    await call('update-event', update(String(fake.storedEvents[0]?.etag), { status: 'tentative' }));
    expect(fake.violations).toContain('update_event_status:tentative');
    expect(fake.storedEvents[0]?.status).toBe('confirmed');
  });

  it('patched:false mirrors the pinned bundle: fields with etag rejected, no etag ever emitted, no status/ifMatch applied', async () => {
    const { fake, call } = await raw({ patched: false });
    await call('create-event', create());
    const refused = await call('get-event', getArgs(['etag', 'updated']));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/fields/);
    expect(refused.text).not.toMatch(/"etag"/);
    expect(eventOf((await call('get-event', getArgs())).text).etag).toBeUndefined();
    await call('update-event', update('"stale"', { status: 'cancelled' }));
    // No If-Match support and no status: the patch lands (stale etag ignored) but the event is not cancelled.
    expect(fake.storedEvents[0]).toMatchObject({ status: 'confirmed', start: '2026-10-01T17:00:00' });
  });
});

describe('v2 scenarios', () => {
  it('status_field_absent / ifmatch_absent remove the property from tools/list and from the handler', async () => {
    for (const [scenario, gone] of [
      ['status_field_absent', 'status'],
      ['ifmatch_absent', 'ifMatch'],
    ] as const) {
      const { client } = await raw({}, [scenario]);
      const tools = (await client.listTools()).tools;
      const props = (tools.find((t) => t.name === 'update-event')?.inputSchema.properties ?? {}) as Record<
        string,
        unknown
      >;
      expect(Object.keys(props)).not.toContain(gone);
      expect(Object.keys(props)).toContain(gone === 'status' ? 'ifMatch' : 'status');
      // The wrapper applies the same scenario before connect() by re-registering the update-event shape.
      const w = createFakeMcpCalendar({ timeZone: TZ });
      open.push(w);
      w.scenario(scenario);
      const [c, sv] = InMemoryTransport.createLinkedPair();
      await w.fake.server.connect(sv);
      const probe = new Client({ name: 'p', version: '0' });
      await probe.connect(c);
      const listed = (await probe.listTools()).tools;
      const p2 = (listed.find((t) => t.name === 'update-event')?.inputSchema.properties ?? {}) as Record<
        string,
        unknown
      >;
      expect(Object.keys(p2)).not.toContain(gone);
      await probe.close();
    }
    // After connect() a schema scenario is refused (the host verifies once per start()).
    const late = createFakeMcpCalendar({});
    open.push(late);
    await late.connect();
    expect(() => late.scenario('status_field_absent')).toThrow(/before connect/);
  });

  it('status_field_absent: a cancel is silently stripped like the real non-strict zod object', async () => {
    const { fake, call } = await raw({}, ['status_field_absent']);
    await call('create-event', create());
    await call('update-event', update(String(fake.storedEvents[0]?.etag), { status: 'cancelled' }));
    expect(fake.storedEvents[0]?.status).toBe('confirmed');
  });

  it('ifmatch_absent: no precondition check (a stale etag still writes)', async () => {
    const { call } = await raw({}, ['ifmatch_absent']);
    await call('create-event', create());
    expect((await call('update-event', update('"stale"'))).isError).toBe(false);
  });

  it('drift: the first get-event after activation sees the event moved +1 h in Google', async () => {
    const w = createFakeMcpCalendar({ timeZone: TZ });
    open.push(w);
    await w.connect();
    const call = w.callerFor('write');
    await call('create-event', create());
    const read = w.callerFor('read');
    const first = await read('get-event', getArgs());
    expect(first.ok && eventOf(first.value.text).start).toMatchObject({ dateTime: '2026-10-01T15:00:00' });
    w.scenario('drift');
    const drifted = await read('get-event', getArgs());
    expect(drifted.ok && eventOf(drifted.value.text).start).toMatchObject({ dateTime: '2026-10-01T16:00:00' });
    const again = await read('get-event', getArgs());
    expect(again.ok && eventOf(again.value.text).start).toMatchObject({ dateTime: '2026-10-01T16:00:00' });
    expect(w.storedEvents[0]?.sequence).toBe(1);
  });

  it('precondition_412 is one-shot (etag moves), precondition_412_always is sticky', async () => {
    const { fake, call } = await raw({}, ['precondition_412']);
    await call('create-event', create());
    const etag = String(fake.storedEvents[0]?.etag);
    expect((await call('update-event', update(etag))).isError).toBe(true);
    const moved = String(fake.storedEvents[0]?.etag);
    expect(moved).not.toBe(etag);
    expect((await call('update-event', update(moved))).isError).toBe(false);
    const always = await raw({}, ['precondition_412_always']);
    await always.call('create-event', create());
    const e2 = String(always.fake.storedEvents[0]?.etag);
    expect((await always.call('update-event', update(e2))).isError).toBe(true);
    expect((await always.call('update-event', update(e2))).isError).toBe(true);
  });

  it('restore_refused leaves a cancelled event cancelled; readback_mismatch stores the slot 30 min later', async () => {
    const r = await raw({}, ['restore_refused']);
    await r.call('create-event', create());
    await r.call('update-event', update(String(r.fake.storedEvents[0]?.etag), { status: 'cancelled' }));
    await r.call('update-event', update(String(r.fake.storedEvents[0]?.etag), { status: 'confirmed' }));
    expect(r.fake.storedEvents[0]?.status).toBe('cancelled');
    const m = await raw({}, ['readback_mismatch']);
    await m.call('create-event', create());
    await m.call('update-event', update(String(m.fake.storedEvents[0]?.etag)));
    expect(m.fake.storedEvents[0]).toMatchObject({ start: '2026-10-01T17:30:00', end: '2026-10-01T18:30:00' });
  });

  it('private_map_replace stores the map exactly as sent; the default merges', async () => {
    const seed: FakeEvent = {
      id: ID,
      calendarId: 'primary',
      summary: 'x',
      start: '2026-10-01T15:00:00',
      end: '2026-10-01T16:00:00',
      extendedProperties: { private: { ...APP_TAGS, legacy: 'keep' } },
      createdByApp: true,
    };
    const merge = await raw({ seedEvents: [seed] });
    await merge.call('update-event', update(String(merge.fake.storedEvents[0]?.etag)));
    expect(merge.fake.storedEvents[0]?.priv.legacy).toBe('keep');
    const replace = await raw({ seedEvents: [seed] }, ['private_map_replace']);
    await replace.call('update-event', update(String(replace.fake.storedEvents[0]?.etag)));
    expect(replace.fake.storedEvents[0]?.priv).toEqual({ ...APP_TAGS, waUpdate: 'upd-1', waRev: '2' });
    expect(replace.fake.appCreated).toEqual([{ eventId: ID, priv: { ...APP_TAGS, legacy: 'keep' } }]);
  });

  it('attendees / foreign_tags change what get-event shows and make an update a foreign-event violation', async () => {
    for (const [scenario, reason] of [
      ['attendees', 'attendees'],
      ['foreign_tags', 'untagged'],
    ] as const) {
      const { fake, call } = await raw({}, [scenario]);
      await call('create-event', create());
      const ev = eventOf((await call('get-event', getArgs())).text);
      if (scenario === 'attendees') expect(ev.attendees).toHaveLength(1);
      else expect((ev.extendedProperties as { private: Record<string, string> }).private.waAgent).toBeUndefined();
      await call('update-event', update(String(fake.storedEvents[0]?.etag)));
      expect(fake.violations).toContain(`update_on_foreign_event:${reason}`);
      expect(neverForeignProblems(fake)).toContain(`never-foreign: update_on_foreign_event:${reason}`);
      if (scenario === 'attendees') expect(fake.storedEvents[0]?.attendees).toBe(1);
    }
  });

  it('access_role:<x> drives list-calendars (absent omits the field; default owner)', async () => {
    for (const [scenario, role] of [
      [null, 'owner'],
      ['access_role:writer', 'writer'],
      ['access_role:reader', 'reader'],
      ['access_role:absent', undefined],
    ] as const) {
      const { call } = await raw({}, scenario === null ? [] : [scenario]);
      const list = JSON.parse((await call('list-calendars', { account: 'personal' })).text) as {
        calendars: Array<{ accessRole?: string }>;
      };
      expect(list.calendars[0]?.accessRole).toBe(role);
    }
  });

  it('timeout applies the patch and never answers; crash_after_patch applies it and drops the connection', async () => {
    for (const scenario of ['timeout', 'crash_after_patch'] as const) {
      const w = createFakeMcpCalendar({ timeZone: TZ });
      open.push(w);
      await w.connect();
      await w.callerFor('write')('create-event', create());
      w.scenario(scenario);
      const pending = w.callerFor('write')('update-event', update(String(w.storedEvents[0]?.etag)));
      const outcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still-pending'), 150))]);
      if (scenario === 'timeout') expect(outcome).toBe('still-pending');
      else expect(outcome).toEqual({ ok: false, error: 'unavailable' });
      expect(w.storedEvents[0]?.start).toBe('2026-10-01T17:00:00');
    }
  });
});

describe('global violations (T2 3.7) - evaluated on the RAW arguments', () => {
  it('forbidden keys, scope keys, sendUpdates, checkConflicts, missing If-Match, incomplete map, identity change', async () => {
    const { fake, call } = await raw();
    await call('create-event', create());
    const etag = String(fake.storedEvents[0]?.etag);
    await call(
      'update-event',
      update(etag, {
        description: 'model text',
        attendees: [{ email: 'a@example.test' }],
        colorId: '5',
        sendUpdates: 'all',
        checkConflicts: true,
        ifMatch: undefined,
        extendedProperties: { private: { waAgent: '1', waItem: '99', waAction: 'root-action-1', extra: 'x' } },
      }),
    );
    expect(fake.violations).toEqual(
      expect.arrayContaining([
        'update_event_forbidden_key:description',
        'update_event_forbidden_key:attendees',
        'update_event_forbidden_key:colorId',
        'update_event_scope_key',
        'update_event_send_updates:all',
        'update_event_check_conflicts',
        'update_event_without_ifmatch',
        'update_event_private_map:waUpdate,waRev,extra:extra',
        'update_event_identity_changed',
      ]),
    );
  });

  it('a shared map, an absent sendUpdates and every foreign reason are violations too', async () => {
    const seeds: FakeEvent[] = [
      {
        id: 'aaaaaaaaaa',
        calendarId: 'primary',
        summary: 'r',
        start: '2026-10-01T10:00:00',
        end: '2026-10-01T11:00:00',
        extendedProperties: { private: { ...APP_TAGS } },
        recurrence: ['RRULE:FREQ=DAILY'],
      },
      {
        id: 'bbbbbbbbbb',
        calendarId: 'primary',
        summary: 'i',
        start: '2026-10-01T10:00:00',
        end: '2026-10-01T11:00:00',
        extendedProperties: { private: { ...APP_TAGS } },
        recurringEventId: 'parent',
      },
      {
        id: 'cccccccccc',
        calendarId: 'primary',
        summary: 'o',
        start: '2026-10-01T10:00:00',
        end: '2026-10-01T11:00:00',
        extendedProperties: { private: { ...APP_TAGS } },
        creatorSelf: false,
        organizerSelf: false,
      },
      {
        id: 'dddddddddd',
        calendarId: 'primary',
        summary: 'a',
        start: '2026-10-01T10:00:00',
        end: '2026-10-01T11:00:00',
        extendedProperties: { private: { ...APP_TAGS } },
        attendees: [{ email: 'x@example.test' }],
      },
      {
        id: 'eeeeeeeeee',
        calendarId: 'primary',
        summary: 'u',
        start: '2026-10-01T10:00:00',
        end: '2026-10-01T11:00:00',
      },
    ];
    const { fake, call } = await raw({ seedEvents: seeds });
    for (const s of fake.storedEvents) await call('update-event', update(s.etag, { eventId: s.eventId }));
    for (const reason of ['recurrence', 'recurring_instance', 'not_self', 'attendees', 'untagged'])
      expect(fake.violations).toContain(`update_on_foreign_event:${reason}`);
    await call(
      'update-event',
      update(String(fake.storedEvents[0]?.etag), {
        eventId: 'aaaaaaaaaa',
        sendUpdates: undefined,
        extendedProperties: { private: { ...APP_TAGS, waUpdate: 'u', waRev: '2' }, shared: { x: '1' } },
      }),
    );
    expect(fake.violations).toEqual(
      expect.arrayContaining(['update_event_send_updates:undefined', 'update_event_private_map:shared']),
    );
    // Rule 9: none of these was made by an app create-event in this fake.
    expect(neverForeignProblems(fake).filter((p) => p.includes('no app create-event'))).toHaveLength(6);
  });

  it('never-delete: ANY delete-event call is a violation, even though the name is not registered', async () => {
    const { fake, call } = await raw();
    const res = await call('delete-event', { calendarId: 'primary', eventId: ID });
    expect(res.isError).toBe(true);
    expect(fake.violations).toEqual(['write_or_disabled_tool_called:delete-event']);
    expect(fake.calls.map((c) => c.tool)).toEqual(['delete-event']);
    expect(neverDeleteProblems(fake.calls)).toEqual(['never-delete: 1 delete-event call(s) reached the calendar']);
    // An unknown non-real name is recorded but is not a calendar-write violation.
    await call('totally-unknown', {});
    expect(fake.violations).toHaveLength(1);
  });

  it('when every real tool is registered, delete-event goes through the disabled-tool handler (still a violation)', async () => {
    const { fake, call } = await raw({ enabledTools: [...Object.keys(MCP_TOOLS), 'delete-event'] });
    await call('delete-event', {});
    expect(fake.violations).toEqual(['write_or_disabled_tool_called:delete-event']);
  });

  it('rule 9: an update of an app-created event with its creation tags is clean; changed tags are a problem', async () => {
    const { fake, call } = await raw();
    await call('create-event', create());
    await call('update-event', update(String(fake.storedEvents[0]?.etag)));
    expect(neverForeignProblems(fake)).toEqual([]);
    await call(
      'update-event',
      update(String(fake.storedEvents[0]?.etag), {
        extendedProperties: { private: { ...APP_TAGS, waItem: '7', waUpdate: 'u', waRev: '3' } },
      }),
    );
    expect(neverForeignProblems(fake)).toContain(
      'never-foreign: update-event identity tags differ from the creating create-event',
    );
  });
});

describe('probe hook, userEditsInGoogle, storedEvents', () => {
  it('onBeforeCall runs synchronously the moment a call arrives (before validation), and unsubscribes', async () => {
    const w: FakeMcpCalendar = createFakeMcpCalendar({ timeZone: TZ });
    open.push(w);
    await w.connect();
    const seen: string[] = [];
    const off = w.onBeforeCall((tool, args) => seen.push(`${tool}:${String(args.eventId ?? '')}`));
    await w.callerFor('write')('create-event', create());
    await w.callerFor('read')('get-event', getArgs());
    off();
    await w.callerFor('read')('get-event', getArgs());
    expect(seen).toEqual([`create-event:${ID}`, `get-event:${ID}`]);
  });

  it('userEditsInGoogle bumps etag/updated/sequence; an unknown id throws; storedEvents is a copy', async () => {
    const w = createFakeMcpCalendar({ timeZone: TZ, now: () => 1_000 });
    open.push(w);
    await w.connect();
    await w.callerFor('write')('create-event', create());
    const before = w.storedEvents[0];
    w.userEditsInGoogle(ID, { summary: 'Edited', location: 'There', status: 'cancelled' });
    const after = w.storedEvents[0];
    expect(after).toMatchObject({ summary: 'Edited', location: 'There', status: 'cancelled', sequence: 1 });
    expect(after?.etag).not.toBe(before?.etag);
    expect(after && before && after.updated > before.updated).toBe(true); // strictly increasing under a frozen clock
    expect(() => w.userEditsInGoogle('nope', {})).toThrow(/unknown event/);
    (w.storedEvents[0] as { summary: string }).summary = 'mutated';
    expect(w.storedEvents[0]?.summary).toBe('Edited');
    expect(w.appCreated).toEqual([{ eventId: ID, priv: APP_TAGS }]);
  });
});
