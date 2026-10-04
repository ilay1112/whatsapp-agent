// src/main/mcp/host.v2.test.ts - [V2] B3/B4 startup contract and the UPDATE surface (owner V2-W1-02).
// T2 5 row mcp/*: "startup contract: exactly 8 tools, destructiveHint on update-event, status enum contains cancelled, ifMatch present;
// status_field_absent / ifmatch_absent => update surface only disabled (CAL_UPDATE_UNAVAILABLE, health sub-line), create-event still
// succeeds in the same test; callerFor('read') rejects update-event; callerFor('write') rejects get-event". F12: a pre-flight projection
// without etag marks the update surface unavailable.
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFakeMcpCalendar,
  neverDeleteProblems,
  neverForeignProblems,
} from '../../../tests/fakes/fake-mcp-calendar';
import { ENABLED_TOOLS_ENV, MCP_TOOLS, McpCapabilityError, createMcpReadClient } from './readClient';
import { createMcpWriteClient } from './writeClient';
import {
  DESTRUCTIVE_HINT_TOOLS,
  READ_ONLY_HINT_TOOLS,
  REQUIRED_INPUT_FIELDS,
  createMcpHost,
  verifyToolset,
  verifyUpdateSurface,
} from './host';
import type { McpClientLike, McpHostDeps, McpHostExtras, ToolListEntry, UpdateSurface } from './host';
import type { FakeCalendarOptions, FakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import type { McpToolCaller, PinnedWindow } from './readClient';
import type { CreateEventArgs, UpdateEventArgs } from './writeClient';
import type { AuditEntry, AuditKind } from '../../shared/types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const DEPS: McpHostDeps = {
  execPath: 'C:\\Program Files\\WhatsApp Calendar Agent\\WhatsApp Calendar Agent.exe',
  mcpRoot: 'C:\\Program Files\\WhatsApp Calendar Agent\\resources\\calendar-mcp',
  credentialsPath: 'C:\\Users\\tester\\AppData\\Roaming\\WCA\\google\\gcp-oauth.keys.json',
  tokenPath: 'C:\\Users\\tester\\AppData\\Roaming\\WCA\\google\\tokens.json',
  onStderrMarker: () => undefined,
};
type Audit = { kind: AuditKind; ref: string | null; detail: AuditEntry['detail'] };

const PATCHED_PROPS = {
  status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'] },
  ifMatch: { type: 'string' },
};
function listed(
  updateProps: Record<string, unknown> | null = PATCHED_PROPS,
): Array<ToolListEntry & { inputSchema: NonNullable<ToolListEntry['inputSchema']> }> {
  return Object.keys(MCP_TOOLS).map((name) => ({
    name,
    annotations: {
      readOnlyHint: READ_ONLY_HINT_TOOLS.includes(name as never),
      destructiveHint: DESTRUCTIVE_HINT_TOOLS.includes(name as never),
    },
    inputSchema: {
      required: [...(REQUIRED_INPUT_FIELDS[name] ?? [])],
      ...(name === 'update-event' && updateProps !== null ? { properties: updateProps } : {}),
    },
  }));
}

const open: FakeMcpCalendar[] = [];
afterEach(async () => {
  for (const fake of open.splice(0)) await fake.stop().catch(() => undefined);
});

async function withFake(
  opts: FakeCalendarOptions = {},
  scenarios: Parameters<FakeMcpCalendar['scenario']>[0][] = [],
  extras: McpHostExtras = {},
): Promise<{
  fake: FakeMcpCalendar;
  host: ReturnType<typeof createMcpHost>;
  audits: Audit[];
  surfaces: UpdateSurface[];
}> {
  const fake = createFakeMcpCalendar({ timeZone: 'Asia/Jerusalem', ...opts });
  for (const s of scenarios) fake.scenario(s);
  open.push(fake);
  const transport = fake.clientTransport();
  await fake.connect();
  const audits: Audit[] = [];
  const surfaces: UpdateSurface[] = [];
  const host = createMcpHost({
    ...DEPS,
    transportFactory: () => transport,
    audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
    onUpdateSurface: (s) => surfaces.push(s),
    ...extras,
  });
  return { fake, host, audits, surfaces };
}

const EVENT_ID = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const CREATE: CreateEventArgs = {
  calendarId: 'primary',
  account: 'personal',
  summary: 'Dentist',
  start: '2026-10-01T15:00:00',
  end: '2026-10-01T16:00:00',
  timeZone: 'Asia/Jerusalem',
  description: 'Created by WhatsApp Calendar Agent.',
  sendUpdates: 'none',
  allowDuplicates: false,
  eventId: EVENT_ID,
  extendedProperties: { private: { waAgent: '1', waItem: '42', waAction: 'root-action-1' } },
};
const updateFrom = (etag: string, over: Partial<UpdateEventArgs> = {}): UpdateEventArgs => ({
  calendarId: 'primary',
  account: 'personal',
  eventId: EVENT_ID,
  summary: 'Dentist',
  start: '2026-10-01T17:00:00',
  end: '2026-10-01T18:00:00',
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
  sendUpdates: 'none',
  checkConflicts: false,
  ifMatch: etag,
  extendedProperties: {
    private: { waAgent: '1', waItem: '42', waAction: 'root-action-1', waUpdate: 'upd-root-1', waRev: '2' },
  },
  ...over,
});
const WINDOW: PinnedWindow = {
  timeMinLocal: '2026-09-30T00:00:00',
  timeMaxLocal: '2026-10-05T00:00:00',
  timeZone: 'Asia/Jerusalem',
  calendarIds: ['primary'],
  account: 'personal',
};

describe('verifyUpdateSurface (B4 narrow guard, pure)', () => {
  it('available only with a status enum containing cancelled AND an ifMatch property', () => {
    expect(verifyUpdateSurface(listed())).toEqual({ available: true });
    expect(verifyUpdateSurface(listed(null))).toEqual({ available: false, problem: 'status_missing' });
    expect(verifyUpdateSurface(listed({ ifMatch: { type: 'string' } }))).toEqual({
      available: false,
      problem: 'status_missing',
    });
    expect(verifyUpdateSurface(listed({ status: { type: 'string' }, ifMatch: {} }))).toEqual({
      available: false,
      problem: 'status_missing',
    });
    expect(
      verifyUpdateSurface(listed({ status: { type: 'string', enum: ['confirmed', 'tentative'] }, ifMatch: {} })),
    ).toEqual({ available: false, problem: 'status_missing' });
    expect(verifyUpdateSurface(listed({ status: PATCHED_PROPS.status }))).toEqual({
      available: false,
      problem: 'ifmatch_missing',
    });
    expect(verifyUpdateSurface(listed({ status: PATCHED_PROPS.status, ifMatch: true }))).toEqual({
      available: false,
      problem: 'ifmatch_missing',
    });
    expect(verifyUpdateSurface(listed({ status: null, ifMatch: {} }))).toEqual({
      available: false,
      problem: 'status_missing',
    });
  });

  it('fails closed on shapes that are not a tools/list at all', () => {
    expect(verifyUpdateSurface([])).toEqual({ available: false, problem: 'status_missing' });
    expect(verifyUpdateSurface(null as never)).toEqual({ available: false, problem: 'status_missing' });
    expect(verifyUpdateSurface([null, { name: 'update-event', inputSchema: null }] as never)).toEqual({
      available: false,
      problem: 'status_missing',
    });
    expect(verifyUpdateSurface([{ name: 'update-event', inputSchema: { properties: 'x' } }])).toEqual({
      available: false,
      problem: 'status_missing',
    });
  });
});

describe('C2 19 item 18', () => {
  it('MCP_TOOLS == ENABLED_TOOLS_ENV (8 names); every readOnlyHint tool is class read; update-event is the one destructive write', () => {
    expect(Object.keys(MCP_TOOLS).sort()).toEqual(ENABLED_TOOLS_ENV.split(',').sort());
    expect(Object.keys(MCP_TOOLS)).toHaveLength(8);
    for (const name of READ_ONLY_HINT_TOOLS) expect(MCP_TOOLS[name]).toBe('read');
    expect([...DESTRUCTIVE_HINT_TOOLS]).toEqual(['update-event']);
    expect(MCP_TOOLS['update-event']).toBe('write');
  });
});

describe('verifyToolset v2 (B3)', () => {
  it('requires destructiveHint on update-event and calendarId/eventId on get-event and update-event', () => {
    expect(verifyToolset(listed())).toBeNull();
    const noDestructive = listed().map((t) =>
      t.name === 'update-event' ? { ...t, annotations: { readOnlyHint: false } } : t,
    );
    expect(verifyToolset(noDestructive)).toBe('destructive_hint');
    for (const name of ['get-event', 'update-event']) {
      const drift = listed().map((t) => (t.name === name ? { ...t, inputSchema: { required: ['calendarId'] } } : t));
      expect(verifyToolset(drift), name).toBe('schema');
    }
    const noReadOnly = listed().map((t) =>
      t.name === 'get-event' ? { ...t, annotations: { destructiveHint: false } } : t,
    );
    expect(verifyToolset(noReadOnly)).toBe('readonly_hint');
    expect(verifyToolset(listed().filter((t) => t.name !== 'get-event'))).toBe('names');
    expect(verifyToolset([...listed(), { name: 'delete-event' }])).toBe('names');
  });
});

describe('McpHost.updateSurface over the fake calendar', () => {
  it('fails closed before the first verified tools/list, then opens for the patched server', async () => {
    const { host, surfaces } = await withFake();
    expect(host.updateSurface()).toEqual({ available: false, problem: 'status_missing' });
    await expect(host.start()).resolves.toBe('connected');
    expect(host.updateSurface()).toEqual({ available: true });
    expect(surfaces).toEqual([{ available: true }]);
  });

  it('capability classes: read rejects update-event, write rejects get-event - before the fake sees a call', async () => {
    const { host, fake, audits } = await withFake();
    await host.start();
    const before = fake.calls.length;
    await expect((host.callerFor('read') as unknown as McpToolCaller)('update-event', {})).rejects.toBeInstanceOf(
      McpCapabilityError,
    );
    await expect((host.callerFor('write') as unknown as McpToolCaller)('get-event', {})).rejects.toBeInstanceOf(
      McpCapabilityError,
    );
    await expect(
      (host.callerFor('admin') as unknown as McpToolCaller)('delete-event' as never, {}),
    ).rejects.toBeInstanceOf(McpCapabilityError);
    expect(fake.calls).toHaveLength(before);
    expect(audits.filter((a) => a.kind === 'tool_blocked')).toHaveLength(3);
  });

  for (const [scenario, problem] of [
    ['status_field_absent', 'status_missing'],
    ['ifmatch_absent', 'ifmatch_missing'],
  ] as const) {
    it(`${scenario}: the UPDATE surface only is disabled - update-event never leaves, create-event succeeds in the same test`, async () => {
      const { host, fake, audits, surfaces } = await withFake({}, [scenario]);
      await expect(host.start()).resolves.toBe('connected'); // not toolset_mismatch: the whole surface is NOT disabled
      expect(host.updateSurface()).toEqual({ available: false, problem });
      expect(surfaces.every((x) => !x.available)).toBe(true); // it never became available
      expect(audits).toContainEqual({ kind: 'toolset_mismatch', ref: null, detail: { reason: problem, count: 8 } });

      const write = createMcpWriteClient(host.callerFor('write'));
      await expect(write.createEvent(CREATE)).resolves.toMatchObject({ ok: true, value: { eventId: EVENT_ID } });
      const read = createMcpReadClient(host.callerFor('read'));
      const pre = await read.getEvent('primary', EVENT_ID);
      expect(pre.ok).toBe(true);
      await expect(write.updateEvent(updateFrom(pre.ok ? String(pre.value.etag) : 'x'))).resolves.toEqual({
        ok: false,
        error: 'unavailable',
      });
      expect(fake.calls.filter((c) => c.tool === 'update-event')).toHaveLength(0);
      expect(fake.storedEvents.map((e) => e.eventId)).toEqual([EVENT_ID]);
      expect(audits.filter((a) => a.kind === 'toolset_mismatch' && a.detail.reason === problem)).toHaveLength(2);
      expect(fake.violations).toEqual([]);
    });
  }

  it('patched:false (the pinned unpatched bundle): update surface off, get-event with etag refused, creates still work (F12)', async () => {
    const { host, fake, audits } = await withFake({ patched: false });
    await expect(host.start()).resolves.toBe('connected');
    expect(host.updateSurface()).toEqual({ available: false, problem: 'status_missing' });
    const write = createMcpWriteClient(host.callerFor('write'));
    await expect(write.createEvent(CREATE)).resolves.toMatchObject({ ok: true });
    const read = createMcpReadClient(host.callerFor('read'));
    await expect(read.getEvent('primary', EVENT_ID)).resolves.toEqual({ ok: false, error: 'invalid_args' });
    expect(audits).toContainEqual({
      kind: 'toolset_mismatch',
      ref: null,
      detail: { reason: 'etag_missing', count: 0 },
    });
    // The list-derived problem stays the reported one; the etag observation cannot re-open anything.
    expect(host.updateSurface()).toEqual({ available: false, problem: 'status_missing' });
    await expect(write.updateEvent(updateFrom('"x"'))).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(fake.calls.filter((c) => c.tool === 'update-event')).toHaveLength(0);
  });

  it('F12: a pre-flight projection WITHOUT etag (insertions 6/7 missing at run time) marks the update surface unavailable', async () => {
    const calls: string[] = [];
    const eventNoEtag = JSON.stringify({
      event: {
        id: EVENT_ID,
        status: 'confirmed',
        start: { dateTime: '2026-10-01T15:00:00', timeZone: 'Asia/Jerusalem' },
        end: { dateTime: '2026-10-01T16:00:00', timeZone: 'Asia/Jerusalem' },
      },
    });
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({ tools: listed() }),
      callTool: async (params) => {
        calls.push(params.name);
        if (params.name === 'manage-accounts')
          return {
            content: [
              { type: 'text', text: JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }) },
            ],
          };
        if (params.name === 'get-event') return { content: [{ type: 'text', text: eventNoEtag }] };
        return { content: [{ type: 'text', text: '{}' }] };
      },
    };
    const audits: Audit[] = [];
    const surfaces: UpdateSurface[] = [];
    const stub: Transport = { start: async () => undefined, send: async () => undefined, close: async () => undefined };
    const host = createMcpHost({
      ...DEPS,
      transportFactory: () => stub,
      clientFactory: () => double,
      audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
      onUpdateSurface: (s) => surfaces.push(s),
    });
    await expect(host.start()).resolves.toBe('connected');
    expect(host.updateSurface()).toEqual({ available: true });

    const read = createMcpReadClient(host.callerFor('read'));
    const pre = await read.getEvent('primary', EVENT_ID);
    expect(pre.ok && pre.value.etag).toBeNull();
    expect(host.updateSurface()).toEqual({ available: false, problem: 'ifmatch_missing' });
    expect(surfaces).toEqual([{ available: true }, { available: false, problem: 'ifmatch_missing' }]);
    expect(audits).toContainEqual({
      kind: 'toolset_mismatch',
      ref: null,
      detail: { reason: 'etag_missing', count: 0 },
    });

    // Sticky, reported once, and no If-Match-less PATCH ever leaves.
    await read.getEvent('primary', EVENT_ID);
    expect(audits.filter((a) => a.detail.reason === 'etag_missing')).toHaveLength(1);
    const write = createMcpWriteClient(host.callerFor('write'));
    await expect(write.updateEvent(updateFrom('"1"'))).resolves.toEqual({ ok: false, error: 'unavailable' });
    expect(calls).not.toContain('update-event');
    // A get-event error that is not about etag, or a garbage answer, decides nothing.
    await host.stop();
  });

  it('a get-event error unrelated to etag or an unparsable answer does not touch the surface', async () => {
    let reply: { text: string; isError?: boolean } = { text: 'garbage' };
    const double: McpClientLike = {
      connect: async () => undefined,
      close: async () => undefined,
      listTools: async () => ({ tools: listed() }),
      callTool: async (params) =>
        params.name === 'manage-accounts'
          ? {
              content: [
                { type: 'text', text: JSON.stringify({ accounts: [{ account_id: 'personal', status: 'active' }] }) },
              ],
            }
          : { content: [{ type: 'text', text: reply.text }], isError: reply.isError },
    };
    const stub: Transport = { start: async () => undefined, send: async () => undefined, close: async () => undefined };
    const host = createMcpHost({ ...DEPS, transportFactory: () => stub, clientFactory: () => double });
    await host.start();
    const read = createMcpReadClient(host.callerFor('read'));
    await expect(read.getEvent('primary', EVENT_ID)).resolves.toEqual({ ok: false, error: 'bad_response' });
    reply = { text: 'MCP error -32603: Internal error: Event with ID x not found', isError: true };
    await expect(read.getEvent('primary', EVENT_ID)).resolves.toEqual({ ok: false, error: 'not_found' });
    expect(host.updateSurface()).toEqual({ available: true });
    reply = {
      text: 'MCP error -32602: Input validation error: Invalid arguments for tool get-event: Invalid option: expected one of "id"|"eventType" at fields[0]',
      isError: true,
    };
    await expect(read.getEvent('primary', EVENT_ID)).resolves.toEqual({ ok: false, error: 'invalid_args' });
    expect(host.updateSurface()).toEqual({ available: false, problem: 'ifmatch_missing' });
  });
});

describe('the edit round trip over the host + the fake calendar (patched)', () => {
  it('create -> pre-flight -> update with If-Match -> stale etag is a 412 -> cancel -> invisible to list-events', async () => {
    const { host, fake } = await withFake();
    await host.start();
    const read = createMcpReadClient(host.callerFor('read'));
    const write = createMcpWriteClient(host.callerFor('write'));
    await expect(write.createEvent(CREATE)).resolves.toMatchObject({ ok: true });

    const pre = await read.getEvent('primary', EVENT_ID);
    if (!pre.ok) throw new Error('pre-flight failed');
    expect(pre.value).toMatchObject({
      status: 'confirmed',
      startLocal: '2026-10-01T15:00:00',
      creatorSelf: true,
      organizerSelf: true,
      hasAttendees: false,
      hasRecurrence: false,
      priv: { waAgent: '1', waItem: '42', waAction: 'root-action-1', waUpdate: null, waRev: null },
    });
    expect(pre.value.etag).toMatch(/^".+"$/);
    expect(pre.value.sequence).toBe(0);

    const moved = await write.updateEvent(updateFrom(String(pre.value.etag)));
    expect(moved).toEqual({
      ok: true,
      value: {
        eventId: EVENT_ID,
        status: 'confirmed',
        startLocal: '2026-10-01T17:00:00',
        endLocal: '2026-10-01T18:00:00',
      },
    });
    const after = await read.getEvent('primary', EVENT_ID);
    expect(after.ok && after.value).toMatchObject({
      startLocal: '2026-10-01T17:00:00',
      sequence: 1,
      priv: { waRev: '2' },
    });
    expect(after.ok && after.value.etag).not.toBe(pre.value.etag);

    // The same (now stale) etag again: HTTP 412 through the vendored text.
    await expect(write.updateEvent(updateFrom(String(pre.value.etag)))).resolves.toEqual({
      ok: false,
      error: 'precondition',
    });

    // Cancel, with the fresh etag.
    const fresh = after.ok ? String(after.value.etag) : '';
    const cancelled = await write.updateEvent(updateFrom(fresh, { status: 'cancelled' }));
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    const readback = await read.getEvent('primary', EVENT_ID);
    expect(readback.ok && readback.value.status).toBe('cancelled');
    // Cancelled events are invisible to list-events (research 1.4): reconcile of an update must use get-event.
    await expect(read.findAppEvent('root-action-1' as never, WINDOW)).resolves.toEqual({ ok: true, value: null });

    expect(fake.violations).toEqual([]);
    expect(neverDeleteProblems(fake.calls)).toEqual([]);
    expect(neverForeignProblems(fake)).toEqual([]);
  });

  it('userEditsInGoogle moves the etag, so an update built from an older pre-flight is refused with 412', async () => {
    const { host, fake } = await withFake();
    await host.start();
    const read = createMcpReadClient(host.callerFor('read'));
    const write = createMcpWriteClient(host.callerFor('write'));
    await write.createEvent(CREATE);
    const pre = await read.getEvent('primary', EVENT_ID);
    fake.userEditsInGoogle(EVENT_ID, { start: '2026-10-01T15:30:00', end: '2026-10-01T16:30:00' });
    await expect(write.updateEvent(updateFrom(pre.ok ? String(pre.value.etag) : ''))).resolves.toEqual({
      ok: false,
      error: 'precondition',
    });
    expect(fake.storedEvents[0]).toMatchObject({ start: '2026-10-01T15:30:00', sequence: 1 });
  });

  it('event_missing / gone_410 surface as not_found on both get-event and update-event', async () => {
    for (const scenario of ['event_missing', 'gone_410'] as const) {
      const { host } = await withFake({}, [scenario]);
      await host.start();
      const read = createMcpReadClient(host.callerFor('read'));
      const write = createMcpWriteClient(host.callerFor('write'));
      await expect(read.getEvent('primary', EVENT_ID)).resolves.toEqual({ ok: false, error: 'not_found' });
      await expect(write.updateEvent(updateFrom('"1"'))).resolves.toEqual({ ok: false, error: 'not_found' });
    }
  });

  it('a hanging update-event (timeout scenario) is a timeout for the executor; the patch did land (readback decides)', async () => {
    const { host, fake } = await withFake({}, [], { callTimeoutMs: 200 });
    await host.start();
    const read = createMcpReadClient(host.callerFor('read'));
    const write = createMcpWriteClient(host.callerFor('write'));
    await write.createEvent(CREATE);
    const pre = await read.getEvent('primary', EVENT_ID);
    fake.scenario('timeout');
    await expect(write.updateEvent(updateFrom(pre.ok ? String(pre.value.etag) : ''))).resolves.toEqual({
      ok: false,
      error: 'timeout',
    });
    const readback = await read.getEvent('primary', EVENT_ID);
    expect(readback.ok && readback.value.startLocal).toBe('2026-10-01T17:00:00');
  });
});
