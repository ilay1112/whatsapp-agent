// src/main/mcp/writeClient.v2.test.ts - [V2] McpWriteClient.updateEvent (owner V2-W1-02).
// T2 5 row mcp/*: "McpWriteClient.updateEvent body key set == UPDATE_EVENT_KEYS filtered by presence, extra properties on the input object
// never reach the wire, sendUpdates:'none', checkConflicts:false, ifMatch always, full private map with identity values copied from the
// pre-flight projection (A19); 412 text => McpErrorKind 'precondition'". TESTS 13: writeClient.ts is safety-critical (100/95/100).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UPDATE_EVENT_KEYS, createMcpWriteClient } from './writeClient';
import type { UpdateEventArgs } from './writeClient';
import type { McpResult, McpToolCaller } from './readClient';
import { FAKE_UPDATE_EVENT_KEYS } from '../../../tests/fakes/fake-mcp-calendar';

type Call = { tool: string; args: Record<string, unknown> };
type Reply = McpResult<{ text: string; isError: boolean }>;

function caller(reply: Reply): { call: McpToolCaller<'write'>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
  };
}
const okText = (text: string): Reply => ({ ok: true, value: { text, isError: false } });
const errText = (text: string): Reply => ({ ok: true, value: { text, isError: true } });

const ID = 'abcdef0123456789abcdef0123456789';
const ARGS: UpdateEventArgs = {
  calendarId: 'primary',
  account: 'personal',
  eventId: ID,
  summary: 'Dentist',
  start: '2026-10-01T17:00:00',
  end: '2026-10-01T18:00:00',
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
  sendUpdates: 'none',
  checkConflicts: false,
  ifMatch: '"3181000000000001"',
  extendedProperties: {
    private: { waAgent: '1', waItem: '42', waAction: 'root-action-1', waUpdate: 'upd-root-7', waRev: '2' },
  },
};
const UPDATED = JSON.stringify({
  event: {
    id: ID,
    status: 'confirmed',
    summary: 'Dentist',
    start: { dateTime: '2026-10-01T17:00:00+03:00', timeZone: 'Asia/Jerusalem' },
    end: { dateTime: '2026-10-01T18:00:00+03:00', timeZone: 'Asia/Jerusalem' },
  },
  warnings: ['conflict with SOMEONE-ELSE'],
});

const patchText = (): string =>
  (
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../vendor/calendar-mcp.patch.json', import.meta.url)), 'utf8'),
    ) as { preconditionErrorText: string }
  ).preconditionErrorText;

describe('UPDATE_EVENT_KEYS', () => {
  it('is the exhaustive C2 11 whitelist, equal to the fake calendar copy, with no description (F5)', () => {
    expect([...UPDATE_EVENT_KEYS]).toEqual([...FAKE_UPDATE_EVENT_KEYS]);
    expect(UPDATE_EVENT_KEYS).not.toContain('description');
    for (const k of [
      'attendees',
      'recurrence',
      'modificationScope',
      'originalStartTime',
      'futureStartDate',
      'calendarsToCheck',
    ])
      expect(UPDATE_EVENT_KEYS as readonly string[]).not.toContain(k);
  });
});

describe('createMcpWriteClient.updateEvent', () => {
  it('sends exactly UPDATE_EVENT_KEYS in order, the pinned invariants and the complete private map', async () => {
    const { call, calls } = caller(okText(UPDATED));
    const res = await createMcpWriteClient(call).updateEvent(ARGS);
    expect(res).toEqual({
      ok: true,
      value: { eventId: ID, status: 'confirmed', startLocal: '2026-10-01T17:00:00', endLocal: '2026-10-01T18:00:00' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe('update-event');
    const sent = calls[0]?.args ?? {};
    expect(Object.keys(sent)).toEqual([...UPDATE_EVENT_KEYS]);
    expect(sent).toMatchObject({
      account: 'personal',
      sendUpdates: 'none',
      checkConflicts: false,
      ifMatch: ARGS.ifMatch,
      location: '',
    });
    expect(sent.extendedProperties).toEqual({
      private: { waAgent: '1', waItem: '42', waAction: 'root-action-1', waUpdate: 'upd-root-7', waRev: '2' },
    });
    expect(Object.keys((sent.extendedProperties as { private: object }).private)).toEqual([
      'waAgent',
      'waItem',
      'waAction',
      'waUpdate',
      'waRev',
    ]);
  });

  it('extra properties on the input object (a cast, a JSON round-trip) never reach the wire', async () => {
    const { call, calls } = caller(okText(UPDATED));
    const hostile = {
      ...ARGS,
      description: 'model text',
      attendees: [{ email: 'x@example.test' }],
      recurrence: ['RRULE:FREQ=DAILY'],
      modificationScope: 'all',
      calendarsToCheck: ['other'],
      conferenceData: {},
      extendedProperties: {
        private: { ...ARGS.extendedProperties.private, waExtra: '1' },
        shared: { leak: '1' },
      },
    } as unknown as UpdateEventArgs;
    await createMcpWriteClient(call).updateEvent(hostile);
    const sent = calls[0]?.args ?? {};
    expect(Object.keys(sent)).toEqual([...UPDATE_EVENT_KEYS]);
    expect(JSON.stringify(sent)).not.toMatch(
      /model text|attendees|RRULE|modificationScope|other|conferenceData|waExtra|shared|leak/,
    );
  });

  it('a cancel is status "cancelled"; the waAgent tag is always the literal "1"', async () => {
    const { call, calls } = caller(okText(UPDATED.replace('"status":"confirmed"', '"status":"cancelled"')));
    const res = await createMcpWriteClient(call).updateEvent({ ...ARGS, status: 'cancelled' });
    expect(res.ok && res.value.status).toBe('cancelled');
    expect(calls[0]?.args.status).toBe('cancelled');
  });

  it('never sends an update that is not exactly what C2 11 allows (invalid_args, zero calls) - incl. no If-Match', async () => {
    const bad: Array<Partial<Record<keyof UpdateEventArgs, unknown>> | null> = [
      { ifMatch: '' },
      { ifMatch: undefined },
      { ifMatch: 'x'.repeat(257) },
      { calendarId: 'bad id with spaces' },
      { calendarId: 7 },
      { account: 'work' },
      { eventId: 'NOT-BASE32HEX' },
      { eventId: 'abc' },
      { summary: 5 },
      { location: undefined },
      { start: '2026-10-01 17:00' },
      { end: 3 },
      { start: '2026-10-01T19:00:00' }, // end before start
      { timeZone: 'Not a zone!' },
      { timeZone: 1 },
      { status: 'tentative' },
      { sendUpdates: 'all' },
      { checkConflicts: true },
      { extendedProperties: undefined },
      { extendedProperties: { private: null } },
      { extendedProperties: { private: { ...ARGS.extendedProperties.private, waAgent: '0' } } },
      { extendedProperties: { private: { ...ARGS.extendedProperties.private, waItem: '' } } },
      { extendedProperties: { private: { ...ARGS.extendedProperties.private, waRev: 3 } } },
      { extendedProperties: { private: { ...ARGS.extendedProperties.private, waUpdate: 'a b' } } },
      null,
    ];
    for (const over of bad) {
      const { call, calls } = caller(okText(UPDATED));
      const args = (over === null ? null : { ...ARGS, ...over }) as unknown as UpdateEventArgs;
      await expect(createMcpWriteClient(call).updateEvent(args), JSON.stringify(over)).resolves.toEqual({
        ok: false,
        error: 'invalid_args',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('maps the vendored 412 text to precondition, 404/410 to not_found, a 400 to invalid_args, other errors to bad_response', async () => {
    const cases: Array<[string, string]> = [
      [`MCP error -32600: ${patchText()}`, 'precondition'],
      ['MCP error -32600: Resource not found: Not Found', 'not_found'],
      ['MCP error -32600: Google API error: Resource has been deleted', 'not_found'],
      ['MCP error -32600: Bad Request: Invalid start time', 'invalid_args'],
      ['MCP error -32603: Internal error: boom', 'bad_response'],
    ];
    for (const [text, kind] of cases) {
      const { call } = caller(errText(text));
      await expect(createMcpWriteClient(call).updateEvent(ARGS)).resolves.toEqual({ ok: false, error: kind });
    }
  });

  it('passes transport failures through (timeout => unknown_outcome is the executor s call) and fails closed on garbage', async () => {
    for (const error of ['timeout', 'unavailable', 'auth'] as const) {
      const { call } = caller({ ok: false, error });
      await expect(createMcpWriteClient(call).updateEvent(ARGS)).resolves.toEqual({ ok: false, error });
    }
    await expect(createMcpWriteClient(caller(okText('<html/>')).call).updateEvent(ARGS)).resolves.toEqual({
      ok: false,
      error: 'bad_response',
    });
    // An answer about ANOTHER event is not an answer about ours.
    await expect(
      createMcpWriteClient(caller(okText(UPDATED.replace(ID, 'bbbbbbbbbbbb'))).call).updateEvent(ARGS),
    ).resolves.toEqual({ ok: false, error: 'bad_response' });
  });

  it('the write facade still has no delete, no read and no admin method', () => {
    const client = createMcpWriteClient(caller(okText('{}')).call);
    expect(Object.keys(client)).toEqual(['createEvent', 'updateEvent']);
    for (const forbidden of ['deleteEvent', 'getEvent', 'listCalendars', 'call', 'caller'])
      expect(client).not.toHaveProperty(forbidden);
  });
});
