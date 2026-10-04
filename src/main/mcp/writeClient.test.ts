// src/main/mcp/writeClient.test.ts - the ONLY path from app code to a calendar write (owner W1-05).
// TESTS 13: writeClient.ts is safety-critical => 100 % lines. TESTS 5.3 row mcp/*: "create-event with an existing
// eventId => 'id_exists'"; the ARCH 5.4 whitelist is enforced by construction, not by filtering.
import { describe, expect, it, vi } from 'vitest';
import { CREATE_EVENT_KEYS, createMcpWriteClient } from './writeClient';
import type { CreateEventArgs } from './writeClient';
import type { McpResult, McpToolCaller } from './readClient';

type Call = { tool: string; args: Record<string, unknown> };

function caller(reply: McpResult<{ text: string; isError: boolean }>): { call: McpToolCaller<'write'>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    call: async (tool, args) => {
      calls.push({ tool, args });
      return reply;
    },
  };
}

const okText = (text: string): McpResult<{ text: string; isError: boolean }> => ({
  ok: true,
  value: { text, isError: false },
});

const ARGS: CreateEventArgs = {
  calendarId: 'primary',
  account: 'personal',
  summary: 'Appointment',
  start: '2026-09-24T17:00:00',
  end: '2026-09-24T18:00:00',
  timeZone: 'Asia/Jerusalem',
  description: 'Created by WhatsApp Calendar Agent.',
  sendUpdates: 'none',
  allowDuplicates: false,
  eventId: 'abcdef0123456789abcdef0123456789',
  extendedProperties: { private: { waAgent: '1', waItem: '42', waAction: 'act-root' } },
};

describe('createMcpWriteClient', () => {
  it('sends exactly the ARCH 5.4 whitelist and projects the created event', async () => {
    const { call, calls } = caller(
      okText(JSON.stringify({ id: 'ev-1', htmlLink: 'https://www.google.com/calendar/event?eid=X' })),
    );
    const client = createMcpWriteClient(call);
    const res = await client.createEvent(ARGS);

    expect(res).toEqual({
      ok: true,
      value: { eventId: 'ev-1', htmlLink: 'https://www.google.com/calendar/event?eid=X' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe('create-event');
    // `location` is absent here, so the outbound key set is the whitelist minus `location` - and nothing else.
    expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(
      CREATE_EVENT_KEYS.filter((k) => k !== 'location')
        .slice()
        .sort(),
    );
    expect(calls[0]?.args).toMatchObject({ account: 'personal', sendUpdates: 'none', allowDuplicates: false });
  });

  it('includes location only when it is a non-empty string', async () => {
    const withLocation = caller(okText(JSON.stringify({ id: 'ev-1' })));
    await createMcpWriteClient(withLocation.call).createEvent({ ...ARGS, location: 'Rothschild 1' });
    expect(withLocation.calls[0]?.args.location).toBe('Rothschild 1');

    const empty = caller(okText(JSON.stringify({ id: 'ev-1' })));
    await createMcpWriteClient(empty.call).createEvent({ ...ARGS, location: '' });
    expect(Object.keys(empty.calls[0]?.args ?? {})).not.toContain('location');

    const wrongType = caller(okText(JSON.stringify({ id: 'ev-1' })));
    await createMcpWriteClient(wrongType.call).createEvent({ ...ARGS, location: 7 as unknown as string });
    expect(Object.keys(wrongType.calls[0]?.args ?? {})).not.toContain('location');
  });

  it('cannot smuggle an extra key: the outbound object is built key by key, never spread', async () => {
    const { call, calls } = caller(okText(JSON.stringify({ id: 'ev-1' })));
    const hostile = {
      ...ARGS,
      attendees: [{ email: 'attacker@example.test' }],
      recurrence: ['RRULE:FREQ=DAILY;COUNT=365'],
      conferenceData: { createRequest: {} },
      calendarsToCheck: ['primary'],
      sendUpdates: 'all',
      allowDuplicates: 'yes',
      extendedProperties: { private: { waAgent: '0', waItem: '42', waAction: 'act-root', extra: 'x' } },
    } as unknown as CreateEventArgs;

    await createMcpWriteClient(call).createEvent(hostile);
    const sent = calls[0]?.args ?? {};
    for (const key of [
      'attendees',
      'recurrence',
      'conferenceData',
      'calendarsToCheck',
      'attachments',
      'reminders',
      'colorId',
    ]) {
      expect(sent).not.toHaveProperty(key);
    }
    // The three pinned constants are re-asserted by the facade, never taken from the argument object.
    expect(sent.sendUpdates).toBe('none');
    expect(sent.allowDuplicates).toBe(false);
    expect(sent.extendedProperties).toEqual({ private: { waAgent: '1', waItem: '42', waAction: 'act-root' } });
  });

  it('passes allowDuplicates:true through only when it is exactly true (the confirmDuplicate click)', async () => {
    const yes = caller(okText(JSON.stringify({ id: 'ev-1' })));
    await createMcpWriteClient(yes.call).createEvent({ ...ARGS, allowDuplicates: true });
    expect(yes.calls[0]?.args.allowDuplicates).toBe(true);

    const truthy = caller(okText(JSON.stringify({ id: 'ev-1' })));
    await createMcpWriteClient(truthy.call).createEvent({ ...ARGS, allowDuplicates: 1 as unknown as boolean });
    expect(truthy.calls[0]?.args.allowDuplicates).toBe(false);
  });

  it('maps a duplicate-warning response to CAL_DUPLICATE', async () => {
    const { call } = caller(
      okText(JSON.stringify({ message: 'Similar event(s) already exist.', duplicates: [{ id: 'dup-1' }] })),
    );
    await expect(createMcpWriteClient(call).createEvent(ARGS)).resolves.toEqual({ ok: false, error: 'duplicate' });
  });

  it('maps a 409 on our own deterministic eventId to id_exists', async () => {
    const { call } = caller({
      ok: true,
      value: { text: 'The requested identifier already exists. (409)', isError: true },
    });
    await expect(createMcpWriteClient(call).createEvent(ARGS)).resolves.toEqual({ ok: false, error: 'id_exists' });
  });

  it('fails closed on an unparseable response', async () => {
    const { call } = caller(okText('<html>not json</html>'));
    await expect(createMcpWriteClient(call).createEvent(ARGS)).resolves.toEqual({ ok: false, error: 'bad_response' });
  });

  it('passes a transport-level failure straight through', async () => {
    const call = vi.fn<McpToolCaller<'write'>>(async () => ({ ok: false, error: 'unavailable' }));
    await expect(createMcpWriteClient(call).createEvent(ARGS)).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(call).toHaveBeenCalledOnce();
  });

  it('exposes exactly one method - there is no read, no admin and no delete on the write facade', () => {
    const { call } = caller(okText('{}'));
    const client = createMcpWriteClient(call);
    expect(Object.keys(client)).toEqual(['createEvent', 'updateEvent']); // [V2] C2 11 (still no delete, no read, no admin)
  });
});
