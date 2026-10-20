// src/main/mcp/calendarEvents.fakeCalendar.test.ts - [V4] T-908 group C: CalendarEventsService end to end over the fake MCP
// calendar (tests/fakes/fake-mcp-calendar.ts v4CalendarSeed): three calendars with their roles from list-calendars, Google-shaped
// samples (attendees, recurring instance, all-day, app-owned), and the `calendar_403` scenario (review focus 5).
import { afterEach, describe, expect, it } from 'vitest';
import {
  V4_CALENDARS,
  V4_EVENT_IDS,
  createFakeMcpCalendar,
  v4CalendarSeed,
  type FakeCalendarV2Scenario,
  type FakeMcpCalendar,
} from '../../../tests/fakes/fake-mcp-calendar';
import { localToEpochMs } from '../../shared/when';
import { calendarRolesOf, createMcpAdminClient, parseCalendarRolesJson } from './adminClient';
import { createCalendarEventsService, foreignEventKeyOf } from './calendarEvents';
import { createMcpCalendarListClient } from './readClient';

const TZ = 'Asia/Jerusalem';
/** Tuesday 2026-10-20: the he week is Sun 18 .. Sat 24 Oct. */
const DAY = '2026-10-20';
const ANCHOR = localToEpochMs(`${DAY}T12:00:00`, TZ);
const ALL = [V4_CALENDARS.primary, V4_CALENDARS.work, V4_CALENDARS.holidays];

const open: FakeMcpCalendar[] = [];
afterEach(() => {
  open.length = 0;
});

async function setup(v2Scenarios: FakeCalendarV2Scenario[] = []) {
  const seed = v4CalendarSeed(DAY, TZ);
  const fake = createFakeMcpCalendar({ calendars: seed.calendars, seedEvents: seed.events, v2Scenarios, timeZone: TZ });
  open.push(fake);
  await fake.connect();
  const cals = await createMcpAdminClient(fake.callerFor('admin')).listCalendars();
  if (!cals.ok) throw new Error('list-calendars failed');
  const rolesJson = JSON.stringify(calendarRolesOf(cals.value));
  const svc = createCalendarEventsService({
    list: createMcpCalendarListClient(fake.callerFor('read')),
    roles: () => parseCalendarRolesJson(rolesJson),
    timeZone: () => TZ,
    lang: () => 'he',
    connected: () => true,
    clock: { now: () => ANCHOR },
    log: { warn: () => undefined },
  });
  return { fake, svc, cals: cals.value };
}

describe('CalendarEventsService over the fake calendar (v4CalendarSeed)', () => {
  it('list-calendars carries each calendar its own role', async () => {
    const { cals } = await setup();
    expect(cals.map((c) => [c.id, c.accessRole, c.writable])).toEqual([
      [V4_CALENDARS.primary, 'owner', true],
      [V4_CALENDARS.work, 'writer', true],
      [V4_CALENDARS.holidays, 'reader', false],
    ]);
  });

  it('reads every calendar for the week: one list-events per calendar, Google-shaped samples projected', async () => {
    const { fake, svc } = await setup();
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ALL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.failed).toEqual([]);
    // [v4 T6] no Google id crosses IPC: events are keyed by their opaque eventKey
    const byKey = Object.fromEntries(res.value.events.map((e) => [e.eventKey, e]));
    const byId = new Proxy({} as Record<string, (typeof res.value.events)[number] | undefined>, {
      get: (_t, id: string) => byKey[foreignEventKeyOf(id)],
    });
    expect(byId[V4_EVENT_IDS.plain]).toMatchObject({
      calendarId: V4_CALENDARS.primary,
      title: 'Dentist',
      startLocal: `${DAY}T10:00:00`,
      attendees: 0,
      recurring: false,
      ownedByApp: false,
      writable: true,
      allDay: false,
    });
    expect(byId[V4_EVENT_IDS.appOwned]).toMatchObject({ ownedByApp: true, writable: true });
    expect(byId[V4_EVENT_IDS.attendees]).toMatchObject({ calendarId: V4_CALENDARS.work, attendees: 2, writable: true });
    expect(byId[V4_EVENT_IDS.recurring]).toMatchObject({ recurring: true });
    expect(byId[V4_EVENT_IDS.allDay]).toMatchObject({
      calendarId: V4_CALENDARS.holidays,
      allDay: true,
      startLocal: `${DAY}T00:00:00`,
      endLocal: '2026-10-22T00:00:00',
      writable: false,
    });
    const lists = fake.calls.filter((c) => c.tool === 'list-events');
    expect(lists.map((c) => c.args.calendarId)).toEqual(ALL);
    expect(lists[0]!.args).toMatchObject({
      timeMin: '2026-10-18T00:00:00',
      timeMax: '2026-10-25T00:00:00',
      timeZone: TZ,
    });
    expect(fake.violations).toEqual([]);
    // read-only: nothing but list-calendars / list-events reached the server
    expect(new Set(fake.calls.map((c) => c.tool))).toEqual(new Set(['list-calendars', 'list-events']));
  });

  it('review focus 5: calendar_403 fails the holidays calendar once; the other calendars stay visible', async () => {
    const { svc } = await setup(['calendar_403']);
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ALL });
    expect(res.ok && res.value.failed).toEqual([V4_CALENDARS.holidays]);
    expect(res.ok && res.value.events.map((e) => e.calendarId).sort()).toEqual(
      [V4_CALENDARS.primary, V4_CALENDARS.primary, V4_CALENDARS.work, V4_CALENDARS.work].sort(),
    );
  });

  it('calendar_403:<id> targets one calendar', async () => {
    const { svc } = await setup([`calendar_403:${V4_CALENDARS.work}`]);
    const res = await svc.listEvents({ anchorMs: ANCHOR, calendarIds: ALL });
    expect(res.ok && res.value.failed).toEqual([V4_CALENDARS.work]);
  });

  it('another week holds none of the samples', async () => {
    const { svc } = await setup();
    const res = await svc.listEvents({ anchorMs: localToEpochMs('2026-11-03T12:00:00', TZ), calendarIds: ALL });
    expect(res.ok && res.value.events).toEqual([]);
  });
});
