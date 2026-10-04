// src/main/mcp/adminClient.v2.test.ts - [V2] list-calendars accessRole (C2 11, B7; owner V2-W1-02) + the googleAuth persistence hook.
// B7: automatic mode needs accessRole === 'owner' for the target calendar, cached from the last list-calendars in meta.calendar_roles_json;
// absent = not owned. Nothing about a role the server does not state may ever grant anything.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import {
  accessRoleOf,
  calendarRolesOf,
  createMcpAdminClient,
  parseCalendarRolesJson,
  projectCalendars,
} from './adminClient';
import { createGoogleAuth } from './googleAuth';
import { createMcpReadClient } from './readClient';
import type { FakeMcpCalendar, FakeCalendarV2Scenario } from '../../../tests/fakes/fake-mcp-calendar';
import type { CalendarAccessRole, CalendarInfo, EpochMs } from '../../shared/types';
import type { McpAdminClient } from './adminClient';
import type { Clock, ClockTimer, Logger } from '../deps';

const open: FakeMcpCalendar[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.stop();
});

describe('accessRole projection', () => {
  it('maps the four Google roles; anything else or absent is unknown and NOT writable', () => {
    for (const role of ['owner', 'writer', 'reader', 'freeBusyReader'] as const) expect(accessRoleOf(role)).toBe(role);
    for (const odd of [undefined, null, 'OWNER', 'unknown', 'none', 7, {}]) expect(accessRoleOf(odd)).toBe('unknown');
    const res = projectCalendars(
      JSON.stringify({
        calendars: [
          { id: 'a', accessRole: 'owner' },
          { id: 'b', accessRole: 'writer' },
          { id: 'c', accessRole: 'reader' },
          { id: 'd', accessRole: 'freeBusyReader' },
          { id: 'e' },
          { id: 'f', accessRole: 'root' },
        ],
      }),
    );
    expect(res.ok && res.value.map((c) => [c.id, c.accessRole, c.writable])).toEqual([
      ['a', 'owner', true],
      ['b', 'writer', true],
      ['c', 'reader', false],
      ['d', 'freeBusyReader', false],
      ['e', 'unknown', false],
      ['f', 'unknown', false],
    ]);
  });

  for (const [scenario, role] of [
    ['access_role:owner', 'owner'],
    ['access_role:writer', 'writer'],
    ['access_role:reader', 'reader'],
    ['access_role:absent', 'unknown'],
    ['access_role:unknown', 'unknown'],
  ] as const) {
    it(`fake ${scenario} -> ${role}`, async () => {
      const fake = createFakeMcpCalendar({});
      open.push(fake);
      fake.scenario(scenario as FakeCalendarV2Scenario);
      await fake.connect();
      const res = await createMcpAdminClient(fake.callerFor('admin')).listCalendars();
      expect(res.ok && res.value[0]?.accessRole).toBe(role);
    });
  }
});

describe('meta.calendar_roles_json (B7)', () => {
  const cal = (id: string, accessRole: CalendarAccessRole): CalendarInfo => ({
    id,
    name: id,
    primary: false,
    timeZone: '',
    writable: accessRole === 'owner' || accessRole === 'writer',
    accessRole,
  });

  it('calendarRolesOf -> JSON -> parseCalendarRolesJson round-trips the known roles; unknown ones read as absent', () => {
    const roles = calendarRolesOf([cal('primary', 'owner'), cal('shared@example.test', 'reader'), cal('x', 'unknown')]);
    expect(roles).toEqual({ primary: 'owner', 'shared@example.test': 'reader', x: 'unknown' });
    expect(parseCalendarRolesJson(JSON.stringify(roles))).toEqual({
      primary: 'owner',
      'shared@example.test': 'reader',
    });
  });

  it('a hostile calendar id cannot touch the prototype', () => {
    const roles = calendarRolesOf([cal('__proto__', 'owner')]);
    expect(Object.getPrototypeOf(roles)).toBe(Object.prototype);
    expect(Object.keys(roles)).toEqual(['__proto__']);
    expect(parseCalendarRolesJson('{"__proto__":"owner","primary":"owner"}')).toEqual({ primary: 'owner' });
  });

  it('absent, garbage, arrays, oversized text and odd values grant nothing', () => {
    for (const t of [null, '', 'not json', '[]', '"owner"', 'x'.repeat(64 * 1024 + 1)])
      expect(parseCalendarRolesJson(t)).toEqual({});
    expect(
      parseCalendarRolesJson(JSON.stringify({ a: 'OWNER', b: 1, '': 'owner', [`${'l'.repeat(257)}`]: 'owner' })),
    ).toEqual({});
  });
});

describe('googleAuth persists the roles of every successful list-calendars (GoogleAuthExtras)', () => {
  const clock: Clock = {
    now: () => 1_000 as EpochMs,
    setTimeout: (fn) => {
      queueMicrotask(fn);
      return 0 as ClockTimer;
    },
    clearTimeout: () => undefined,
  };
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  const auth = (admin: McpAdminClient, persist?: (r: Readonly<Record<string, CalendarAccessRole>>) => void) =>
    createGoogleAuth({
      host: {
        start: async () => 'connected',
        stop: async () => undefined,
        status: () => 'connected',
        onStatus: () => () => undefined,
      },
      admin,
      read: createMcpReadClient(async () => ({
        ok: true,
        value: {
          text: JSON.stringify({ currentTime: '2026-09-28T10:00:00Z', timeZone: 'Asia/Jerusalem' }),
          isError: false,
        },
      })),
      paths: { googleDir: 'C:\\g', googleCredentials: 'C:\\g\\c.json', googleTokens: 'C:\\g\\t.json' },
      openExternal: async () => undefined,
      clock,
      log,
      audit: () => undefined,
      targetCalendarId: () => 'primary',
      fs: { writeFile: async () => undefined, unlink: async () => undefined, exists: () => true },
      ...(persist === undefined ? {} : { persistCalendarRoles: persist }),
    });

  it('listCalendars() and the sign-in flow both persist {id: role}; a failed list persists nothing', async () => {
    const fake = createFakeMcpCalendar({});
    open.push(fake);
    fake.scenario('access_role:writer');
    await fake.connect();
    const persisted: Array<Readonly<Record<string, CalendarAccessRole>>> = [];
    const a = auth(createMcpAdminClient(fake.callerFor('admin')), (r) => persisted.push(r));
    await expect(a.listCalendars()).resolves.toMatchObject({ ok: true });
    await expect(a.startSignIn()).resolves.toMatchObject({ ok: true });
    expect(persisted).toEqual([{ primary: 'writer' }, { primary: 'writer' }]);

    const down: McpAdminClient = {
      manageAccounts: async () => ({ ok: false, error: 'unavailable' }),
      listCalendars: async () => ({ ok: false, error: 'unavailable' }),
    };
    const none: unknown[] = [];
    await expect(auth(down, (r) => none.push(r)).listCalendars()).resolves.toMatchObject({ ok: false });
    expect(none).toEqual([]);
  });

  it('a throwing persistence hook never breaks the wizard, and no hook at all is fine', async () => {
    const fake = createFakeMcpCalendar({});
    open.push(fake);
    await fake.connect();
    const admin = createMcpAdminClient(fake.callerFor('admin'));
    await expect(
      auth(admin, () => {
        throw new Error('disk full');
      }).listCalendars(),
    ).resolves.toMatchObject({ ok: true });
    expect(log.warn).toHaveBeenCalledWith('google.calendar_roles_persist_failed', {});
    await expect(auth(admin).listCalendars()).resolves.toMatchObject({ ok: true });
  });
});
