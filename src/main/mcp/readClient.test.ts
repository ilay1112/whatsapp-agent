// src/main/mcp/readClient.test.ts - the READ facade and its capability types (owner W1-05).
// TESTS 5.3 row mcp/*: "McpReadClient has no write method (type + runtime)"; "createMcpReadClient(callerFor('write'))
// is a compile error (expectTypeOf)"; args are ALWAYS app-built (pinned calendar ids / zone, clamped window).
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  MAX_WINDOW_DAYS,
  MCP_TOOLS,
  ENABLED_TOOLS_ENV,
  McpCapabilityError,
  createMcpReadClient,
  isPinnedWindowValid,
} from './readClient';
import type { McpResult, McpToolCaller, McpToolName, McpToolNameOf, PinnedWindow } from './readClient';

type Call = { tool: string; args: Record<string, unknown> };

const WINDOW: PinnedWindow = {
  timeMinLocal: '2026-09-24T00:00:00',
  timeMaxLocal: '2026-09-25T00:00:00',
  timeZone: 'Asia/Jerusalem',
  calendarIds: ['primary'],
  account: 'personal',
};

function caller(...replies: Array<McpResult<{ text: string; isError: boolean }>>): {
  call: McpToolCaller<'read'>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...replies];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return queue.shift() ?? { ok: false, error: 'unavailable' };
    },
  };
}
const okText = (text: string): McpResult<{ text: string; isError: boolean }> => ({
  ok: true,
  value: { text, isError: false },
});
const errText = (text: string): McpResult<{ text: string; isError: boolean }> => ({
  ok: true,
  value: { text, isError: true },
});

describe('the frozen tool table', () => {
  it('has exactly the eight enabled tools and matches ENABLED_TOOLS_ENV', () => {
    expect(Object.keys(MCP_TOOLS).sort()).toEqual(ENABLED_TOOLS_ENV.split(',').slice().sort());
    expect(Object.keys(MCP_TOOLS)).toHaveLength(8); // [V2] C2 11: + get-event, update-event
    // Exactly one WRITE tool exists in the whole table.
    expect(
      Object.entries(MCP_TOOLS)
        .filter(([, cls]) => cls === 'write')
        .map(([n]) => n),
    ).toEqual(['create-event', 'update-event']); // [V2] C2 11
  });

  it('narrows tool names by class at the type level', () => {
    expectTypeOf<McpToolNameOf<'read'>>().toEqualTypeOf<
      'get-current-time' | 'get-freebusy' | 'list-events' | 'get-event'
    >(); // [V2]
    expectTypeOf<McpToolNameOf<'write'>>().toEqualTypeOf<'create-event' | 'update-event'>(); // [V2]
    expectTypeOf<McpToolNameOf<'admin'>>().toEqualTypeOf<'list-calendars' | 'manage-accounts'>();
  });

  it('McpCapabilityError carries the class it was narrowed to and no free text', () => {
    const err = new McpCapabilityError('read');
    expect(err.name).toBe('McpCapabilityError');
    expect(err.message).toBe('mcp_capability');
    expect(err.cls).toBe('read');
  });
});

describe('isPinnedWindowValid', () => {
  it('accepts an app-built window', () => {
    expect(isPinnedWindowValid(WINDOW)).toBe(true);
  });

  it('refuses everything an app-built window can never be', () => {
    expect(isPinnedWindowValid(null as unknown as PinnedWindow)).toBe(false);
    expect(isPinnedWindowValid('x' as unknown as PinnedWindow)).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, timeMinLocal: '2026-09-24' })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, timeMaxLocal: 'later' })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, timeMaxLocal: WINDOW.timeMinLocal })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, timeZone: 'Asia/Jerusalem; DROP TABLE' })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, account: 'work' as 'personal' })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, calendarIds: [] })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, calendarIds: Array.from({ length: 11 }, () => 'primary') })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, calendarIds: [7 as unknown as string] })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, calendarIds: ['a b'] })).toBe(false);
    expect(isPinnedWindowValid({ ...WINDOW, calendarIds: ['x'.repeat(257)] })).toBe(false);
  });

  it('refuses a window longer than the 14-day clamp of ARCH 5.3', () => {
    const ok = { ...WINDOW, timeMaxLocal: '2026-10-08T00:00:00' }; // exactly 14 days
    const tooLong = { ...WINDOW, timeMaxLocal: '2026-10-08T00:00:01' };
    expect(MAX_WINDOW_DAYS).toBe(14);
    expect(isPinnedWindowValid(ok)).toBe(true);
    expect(isPinnedWindowValid(tooLong)).toBe(false);
  });
});

describe('createMcpReadClient', () => {
  it('exposes only the three read methods - no write, no admin (runtime key list)', () => {
    const client = createMcpReadClient(caller().call);
    expect(Object.keys(client).sort()).toEqual(['findAppEvent', 'getCurrentTime', 'getEvent', 'getFreeBusy']); // [V2] + getEvent (C2 11)
    for (const forbidden of [
      'createEvent',
      'listEvents',
      'manageAccounts',
      'listCalendars',
      'deleteEvent',
      'updateEvent',
    ]) {
      expect(client).not.toHaveProperty(forbidden);
    }
  });

  it('is typed so that a write or admin caller cannot be passed in (compile-time)', () => {
    expectTypeOf(createMcpReadClient).parameter(0).toEqualTypeOf<McpToolCaller<'read'>>();
    // @ts-expect-error a WRITE-narrowed caller may not construct the read facade (compose.ts wiring guard)
    expectTypeOf(createMcpReadClient).toBeCallableWith({} as McpToolCaller<'write'>);
    // @ts-expect-error nor an ADMIN-narrowed one
    expectTypeOf(createMcpReadClient).toBeCallableWith({} as McpToolCaller<'admin'>);
    // @ts-expect-error and the facade can never ask for a WRITE tool through its own caller
    expectTypeOf<McpToolCaller<'read'>>().toBeCallableWith('create-event', {});
  });

  it('getCurrentTime pins account=personal and projects the answer', async () => {
    const { call, calls } = caller(
      okText(JSON.stringify({ currentTime: '2026-09-24T11:00:00Z', timeZone: 'Asia/Jerusalem' })),
    );
    const res = await createMcpReadClient(call).getCurrentTime();
    expect(res).toEqual({ ok: true, value: { nowIso: '2026-09-24T11:00:00.000Z', timeZone: 'Asia/Jerusalem' } });
    expect(calls[0]).toEqual({ tool: 'get-current-time', args: { account: 'personal' } });
  });

  it('getCurrentTime maps an isError result and a transport failure', async () => {
    await expect(
      createMcpReadClient(caller(errText('No authenticated accounts found.')).call).getCurrentTime(),
    ).resolves.toEqual({
      ok: false,
      error: 'bad_response',
    });
    const down: McpToolCaller<'read'> = async () => ({ ok: false, error: 'auth' });
    await expect(createMcpReadClient(down).getCurrentTime()).resolves.toEqual({ ok: false, error: 'auth' });
  });

  it('getFreeBusy sends the pinned ids/zone/window and projects busy blocks without titles', async () => {
    const text = JSON.stringify({
      calendars: { primary: { busy: [{ start: '2026-09-24T14:00:00Z', end: '2026-09-24T15:00:00Z' }] } },
    });
    const { call, calls } = caller(okText(text));
    const res = await createMcpReadClient(call).getFreeBusy(WINDOW);
    expect(res).toEqual({ ok: true, value: [{ startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00' }] });
    expect(calls[0]).toEqual({
      tool: 'get-freebusy',
      args: {
        calendars: [{ id: 'primary' }],
        timeMin: '2026-09-24T00:00:00',
        timeMax: '2026-09-25T00:00:00',
        timeZone: 'Asia/Jerusalem',
        account: 'personal',
      },
    });
  });

  it('getFreeBusy refuses a window that is not app-built before any tool call happens', async () => {
    const call = vi.fn<McpToolCaller<'read'>>(async () => okText('{}'));
    await expect(createMcpReadClient(call).getFreeBusy({ ...WINDOW, calendarIds: [] })).resolves.toEqual({
      ok: false,
      error: 'invalid_args',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('getFreeBusy maps an isError result and a transport failure', async () => {
    await expect(createMcpReadClient(caller(errText('boom')).call).getFreeBusy(WINDOW)).resolves.toEqual({
      ok: false,
      error: 'bad_response',
    });
    const down: McpToolCaller<'read'> = async () => ({ ok: false, error: 'timeout' });
    await expect(createMcpReadClient(down).getFreeBusy(WINDOW)).resolves.toEqual({ ok: false, error: 'timeout' });
  });

  it('findAppEvent filters by our own waAction tag and returns the app event ref', async () => {
    const text = JSON.stringify({
      events: [
        {
          id: 'ev-1',
          start: { dateTime: '2026-09-24T14:00:00Z' },
          end: { dateTime: '2026-09-24T15:00:00Z' },
          htmlLink: 'https://www.google.com/calendar/event?eid=X',
          extendedProperties: { private: { waAgent: '1', waAction: 'act-root', waItem: '42' } },
        },
      ],
    });
    const { call, calls } = caller(okText(text));
    const res = await createMcpReadClient(call).findAppEvent('act-root', WINDOW);
    expect(res).toEqual({
      ok: true,
      value: {
        eventId: 'ev-1',
        htmlLink: 'https://www.google.com/calendar/event?eid=X',
        startLocal: '2026-09-24T17:00:00',
      },
    });
    expect(calls[0]?.tool).toBe('list-events');
    expect(calls[0]?.args).toEqual({
      calendarId: 'primary',
      timeMin: '2026-09-24T00:00:00',
      timeMax: '2026-09-25T00:00:00',
      timeZone: 'Asia/Jerusalem',
      privateExtendedProperty: ['waAction=act-root'],
      account: 'personal',
    });
  });

  it('findAppEvent sends an array of calendar ids when more than one is pinned', async () => {
    const { call, calls } = caller(okText(JSON.stringify({ events: [] })));
    await createMcpReadClient(call).findAppEvent('act-root', {
      ...WINDOW,
      calendarIds: ['primary', 'work@example.test'],
    });
    expect(calls[0]?.args.calendarId).toEqual(['primary', 'work@example.test']);
  });

  it('findAppEvent refuses a hostile action id without calling the tool', async () => {
    const call = vi.fn<McpToolCaller<'read'>>(async () => okText('{}'));
    const client = createMcpReadClient(call);
    await expect(client.findAppEvent('act-root" OR 1=1 --' as string, WINDOW)).resolves.toEqual({
      ok: false,
      error: 'invalid_args',
    });
    await expect(client.findAppEvent('', WINDOW)).resolves.toEqual({ ok: false, error: 'invalid_args' });
    await expect(client.findAppEvent('act-root', { ...WINDOW, timeZone: '../../etc' })).resolves.toEqual({
      ok: false,
      error: 'invalid_args',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('findAppEvent maps an isError result and a transport failure', async () => {
    await expect(createMcpReadClient(caller(errText('boom')).call).findAppEvent('act-root', WINDOW)).resolves.toEqual({
      ok: false,
      error: 'bad_response',
    });
    const down: McpToolCaller<'read'> = async () => ({ ok: false, error: 'unavailable' });
    await expect(createMcpReadClient(down).findAppEvent('act-root', WINDOW)).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('never asks for a tool outside the READ class', async () => {
    const seen: string[] = [];
    const call: McpToolCaller<'read'> = async (tool) => {
      seen.push(tool);
      return okText('{}');
    };
    const client = createMcpReadClient(call);
    await client.getCurrentTime();
    await client.getFreeBusy(WINDOW);
    await client.findAppEvent('act-root', WINDOW);
    for (const tool of seen) expect(MCP_TOOLS[tool as McpToolName]).toBe('read');
  });
});
