// src/main/mcp/readClient.v4.test.ts - [V4] T-908 group C (handover §2.4): the calendar view's read facade.
// listEventsInWindow: list-events of ONE calendar, singleEvents, account pinned, window <= 14 days (PinnedWindow rules); nothing
// goes on the wire for a bad id / window; a separate facade, so McpReadClient (ToolGate's) gains nothing (I2').
import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_DAYS, createMcpCalendarListClient, createMcpReadClient } from './readClient';
import type { McpResult, McpToolCaller } from './readClient';

type Call = { tool: string; args: Record<string, unknown> };
type Reply = McpResult<{ text: string; isError: boolean }>;
function caller(reply: Reply): { call: McpToolCaller<'read'>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
  };
}
const W = { timeMinLocal: '2026-10-18T00:00:00', timeMaxLocal: '2026-10-25T00:00:00', timeZone: 'Asia/Jerusalem' };
const ONE = JSON.stringify({
  events: [
    {
      id: 'evt0001abc',
      summary: 'Dentist',
      start: { dateTime: '2026-10-20T10:00:00+03:00', timeZone: 'Asia/Jerusalem' },
      end: { dateTime: '2026-10-20T11:00:00+03:00', timeZone: 'Asia/Jerusalem' },
      status: 'confirmed',
    },
  ],
  totalCount: 1,
});

describe('McpCalendarListClient.listEventsInWindow', () => {
  it('calls list-events for exactly one pinned calendar with timeMin/timeMax/timeZone, singleEvents and the pinned account', async () => {
    const { call, calls } = caller({ ok: true, value: { text: ONE, isError: false } });
    const res = await createMcpCalendarListClient(call).listEventsInWindow('work@group.calendar.google.com', W);
    expect(calls).toEqual([
      {
        tool: 'list-events',
        args: {
          calendarId: 'work@group.calendar.google.com',
          timeMin: '2026-10-18T00:00:00',
          timeMax: '2026-10-25T00:00:00',
          timeZone: 'Asia/Jerusalem',
          singleEvents: true,
          account: 'personal',
        },
      },
    ]);
    expect(res).toEqual({
      ok: true,
      value: [
        {
          eventId: 'evt0001abc',
          startLocal: '2026-10-20T10:00:00',
          endLocal: '2026-10-20T11:00:00',
          allDay: false,
          title: 'Dentist',
          attendees: 0,
          recurring: false,
          ownedByApp: false,
          fromChat: false,
          location: '',
        },
      ],
    });
  });

  it('refuses a window over 14 days, an inverted window, a bad zone or a bad calendar id before the wire', async () => {
    const { call, calls } = caller({ ok: true, value: { text: ONE, isError: false } });
    const client = createMcpCalendarListClient(call);
    const day15 = { ...W, timeMaxLocal: '2026-11-02T00:00:01' };
    expect(MAX_WINDOW_DAYS).toBe(14);
    for (const [id, w] of [
      ['primary', day15],
      ['primary', { ...W, timeMaxLocal: W.timeMinLocal }],
      ['primary', { ...W, timeZone: 'Asia/Jerusalem; drop' }],
      ['primary', { ...W, timeMinLocal: 'monday' }],
      ['bad calendar id', W],
      ['', W],
      [42, W],
      ['primary', null],
    ] as const) {
      expect(await client.listEventsInWindow(id as string, w as typeof W)).toEqual({
        ok: false,
        error: 'invalid_args',
      });
    }
    expect(calls).toEqual([]);
  });

  it('exactly 14 days is allowed', async () => {
    const { call, calls } = caller({ ok: true, value: { text: ONE, isError: false } });
    await createMcpCalendarListClient(call).listEventsInWindow('primary', {
      ...W,
      timeMaxLocal: '2026-11-01T00:00:00',
    });
    expect(calls).toHaveLength(1);
  });

  it('maps a tool error: auth text -> auth, a 403 / anything else -> bad_response; transport errors pass through', async () => {
    const forbidden = caller({
      ok: true,
      value: { text: 'MCP error -32600: Google API error: Forbidden (403) calendar x', isError: true },
    });
    expect(await createMcpCalendarListClient(forbidden.call).listEventsInWindow('primary', W)).toEqual({
      ok: false,
      error: 'bad_response',
    });
    const auth = caller({ ok: true, value: { text: 'tokens are no longer valid (invalid_grant)', isError: true } });
    expect(await createMcpCalendarListClient(auth.call).listEventsInWindow('primary', W)).toEqual({
      ok: false,
      error: 'auth',
    });
    const down = caller({ ok: false, error: 'unavailable' });
    expect(await createMcpCalendarListClient(down.call).listEventsInWindow('primary', W)).toEqual({
      ok: false,
      error: 'unavailable',
    });
    const garbage = caller({ ok: true, value: { text: '<html>', isError: false } });
    expect(await createMcpCalendarListClient(garbage.call).listEventsInWindow('primary', W)).toEqual({
      ok: false,
      error: 'bad_response',
    });
  });

  it("I2': the model's read facade (McpReadClient) does not gain the method", () => {
    const { call } = caller({ ok: true, value: { text: ONE, isError: false } });
    const read = createMcpReadClient(call) as unknown as Record<string, unknown>;
    expect(Object.keys(read).sort()).toEqual(['findAppEvent', 'getCurrentTime', 'getEvent', 'getFreeBusy']);
    expect(Object.keys(createMcpCalendarListClient(call))).toEqual(['listEventsInWindow']);
  });
});
