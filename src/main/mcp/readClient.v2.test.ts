// src/main/mcp/readClient.v2.test.ts - [V2] McpReadClient.getEvent (owner V2-W1-02).
// T2 5 row mcp/*: "McpReadClient has getEvent and no write method (type + runtime)"; C2 11: account pinned inside, the fixed field list,
// 'not_found' for 404/410, raw server text never leaves projection.ts.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVENT_ID_RE, createMcpReadClient } from './readClient';
import { GET_EVENT_FIELDS } from './projection';
import type { McpReadClient, McpResult, McpToolCaller } from './readClient';

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
const ID = 'abcdef0123456789abcdef0123456789';
const EVENT = JSON.stringify({
  event: {
    id: ID,
    status: 'confirmed',
    summary: 'Dentist',
    start: { dateTime: '2026-10-01T15:00:00+03:00', timeZone: 'Asia/Jerusalem' },
    end: { dateTime: '2026-10-01T16:00:00+03:00', timeZone: 'Asia/Jerusalem' },
    etag: '"1"',
    extendedProperties: { private: { waAgent: '1', waItem: '42', waAction: 'root-1' } },
  },
});

describe('McpReadClient.getEvent', () => {
  it('calls get-event with the pinned account and the fixed C2 11 field list, and projects the answer', async () => {
    const { call, calls } = caller({ ok: true, value: { text: EVENT, isError: false } });
    const res = await createMcpReadClient(call).getEvent('primary', ID);
    expect(calls).toEqual([
      {
        tool: 'get-event',
        args: { calendarId: 'primary', eventId: ID, account: 'personal', fields: [...GET_EVENT_FIELDS] },
      },
    ]);
    expect(res.ok && res.value).toMatchObject({
      id: ID,
      status: 'confirmed',
      startLocal: '2026-10-01T15:00:00',
      etag: '"1"',
      priv: { waAgent: '1', waItem: '42', waAction: 'root-1', waUpdate: null, waRev: null },
    });
  });

  it('refuses ids that are not app-shaped before anything goes on the wire', async () => {
    for (const [calendarId, eventId] of [
      ['primary', 'UPPER-CASE'],
      ['primary', 'abcd'],
      ['primary', 'w'.repeat(10)],
      ['primary', 7],
      ['bad calendar', ID],
      [null, ID],
    ] as const) {
      const { call, calls } = caller({ ok: true, value: { text: EVENT, isError: false } });
      await expect(createMcpReadClient(call).getEvent(calendarId as string, eventId as string)).resolves.toEqual({
        ok: false,
        error: 'invalid_args',
      });
      expect(calls).toHaveLength(0);
    }
    expect(EVENT_ID_RE.test(ID)).toBe(true);
    expect(EVENT_ID_RE.test('a'.repeat(1025))).toBe(false);
  });

  it('maps error texts (not_found / invalid_args / bad_response) and passes transport failures through', async () => {
    const err = (text: string): Reply => ({ ok: true, value: { text, isError: true } });
    const cases: Array<[Reply, unknown]> = [
      [err(`MCP error -32603: Internal error: Event with ID '${ID}' not found in calendar 'primary'.`), 'not_found'],
      [err('MCP error -32600: Google API error: Resource has been deleted'), 'not_found'],
      [err('MCP error -32602: Input validation error: Invalid arguments for tool get-event: etag'), 'invalid_args'],
      [err('something odd'), 'bad_response'],
      [{ ok: false, error: 'timeout' }, 'timeout'],
      [{ ok: false, error: 'auth' }, 'auth'],
    ];
    for (const [reply, error] of cases) {
      await expect(createMcpReadClient(caller(reply).call).getEvent('primary', ID)).resolves.toEqual({
        ok: false,
        error,
      });
    }
    await expect(
      createMcpReadClient(caller({ ok: true, value: { text: 'garbage', isError: false } }).call).getEvent(
        'primary',
        ID,
      ),
    ).resolves.toEqual({ ok: false, error: 'bad_response' });
  });

  it('has no write method at the type level and at run time', () => {
    const client = createMcpReadClient(caller({ ok: false, error: 'unavailable' }).call);
    expect(Object.keys(client).sort()).toEqual(['findAppEvent', 'getCurrentTime', 'getEvent', 'getFreeBusy']);
    for (const forbidden of ['updateEvent', 'createEvent', 'deleteEvent', 'cancelEvent', 'patch'])
      expect(client).not.toHaveProperty(forbidden);
    expectTypeOf<keyof McpReadClient>().toEqualTypeOf<'getCurrentTime' | 'getFreeBusy' | 'findAppEvent' | 'getEvent'>();
  });
});
