// T2 5 row `mcp/toolServer.ts` (8.2 group 19 at unit level): the guard runs BEFORE the SDK handler, registered tools == the run's
// specs with readOnlyHint:true, every tools/call -> exactly one gate.invoke with the run's RunCtx, nonce-wrapped results, 127.0.0.1 only,
// NEVER_PORTS, typed EADDRINUSE error, idempotent close. Owner V2-W1-05-wa-toolserver.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createToolGate, type RunCtx, type ToolGate } from '../agent/toolGate';
import { READ_TOOLS, llmToolOf, type ToolSpec } from '../agent/toolDefs';
import { createHandleTable } from '../agent/handles';
import type { LlmToolCall } from '../llm/types';
import type { McpReadClient } from './readClient';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { freePort, FREE_PORT_MAX_ATTEMPTS } from '../proc/freePort';
import {
  setToolServerListenerRegistry,
  startToolServer,
  ToolServerPortError,
  TOOL_SERVER_NAME,
  TOOL_SERVER_PATH,
  type ToolServerHandle,
} from './toolServer';
import { registerListener } from '../../../tests/setup-guards';
import { FakeWaReadClient, fakeWaMessage } from '../../../tests/fakes/fake-wa-read-client';
import { connect, rawProbe, TOOL_SERVER_PROBE_MATRIX, INITIALIZE_BODY } from '../../../tests/fakes/fake-mcp-client';

const NOW = Date.UTC(2026, 8, 21, 6, 0, 0);
const NONCE = 'a1b2c3d4e5f60789';
const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  general: { ...DEFAULT_SETTINGS.general, timeZone: 'Asia/Jerusalem' },
};
const READ: McpReadClient = {
  getCurrentTime: () =>
    Promise.resolve({ ok: true, value: { nowIso: '2026-09-21T09:00:00+03:00', timeZone: 'Asia/Jerusalem' } }),
  getFreeBusy: () => Promise.resolve({ ok: true, value: [] }),
  findAppEvent: () => Promise.resolve({ ok: true, value: null }),
  getEvent: () => Promise.resolve({ ok: false as const, error: 'unavailable' as const }),
};

interface Rig {
  server: ToolServerHandle;
  gate: ToolGate;
  ctx: RunCtx;
  invocations: LlmToolCall[];
}
const open: ToolServerHandle[] = [];
beforeAll(() => setToolServerListenerRegistry(registerListener));
afterAll(() => setToolServerListenerRegistry(null));
afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length) await open.pop()!.close();
});

function ctxFor(): RunCtx {
  return {
    runId: 7,
    itemId: 42,
    chatId: 3,
    nowMs: NOW,
    timeZone: 'Asia/Jerusalem',
    nonce: NONCE,
    calls: {},
    totalCalls: 0,
    blockedCalls: 0,
    signal: new AbortController().signal,
    handles: createHandleTable(3),
    waRowsServed: 0,
    crossChatRows: 0,
    otherChatTexts: [],
  };
}
async function rig(opts: { specs?: readonly ToolSpec[]; freePort?: () => Promise<number> } = {}): Promise<Rig> {
  const base = createToolGate({
    read: READ,
    wa: new FakeWaReadClient({ messages: [fakeWaMessage(10, 'coffee on wednesday?')] }),
    settings: () => SETTINGS,
    calendarConnected: () => true,
    waAvailable: () => true,
    audit: () => undefined,
  });
  const invocations: LlmToolCall[] = [];
  const gate: ToolGate = {
    ...base,
    invoke: (call, ctx) => {
      invocations.push(call);
      return base.invoke(call, ctx);
    },
  };
  const ctx = ctxFor();
  const server = await startToolServer({
    gate,
    ctx,
    specs: opts.specs ?? base.exposedSpecs(),
    randomBytes: (n) => randomBytes(n),
    freePort: opts.freePort ?? (() => freePort()),
    appVersion: '0.0.0-test',
  });
  open.push(server);
  return { server, gate, ctx, invocations };
}
const post = (r: Rig, body: string | object, extraHeaders: Record<string, string> = {}) =>
  rawProbe(r.server.port, r.server.token, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    extraHeaders,
  });

describe('listener basics', () => {
  it('binds 127.0.0.1 on a port that is never 8080; url / token shapes; stats start at zero', async () => {
    const r = await rig();
    expect(r.server.url).toBe(`http://127.0.0.1:${r.server.port}${TOOL_SERVER_PATH}`);
    expect(r.server.port).not.toBe(8080);
    expect(r.server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.server.stats()).toEqual({ accepted: 0, rejected: 0, toolCalls: 0 });
    expect(TOOL_SERVER_NAME).toBe('wca');
  });
  it('close() is idempotent, refuses new connections afterwards and ends the registry entry', async () => {
    const r = await rig();
    const port = r.server.port;
    const a = r.server.close();
    const b = r.server.close();
    expect(a).toBe(b);
    await a;
    expect((await rawProbe(port, r.server.token, {})).status).toBe('refused');
  });
  it('reports itself to the listener registry while it listens (T7 leak guard input)', async () => {
    const seen: Array<{ name: string; readonly listening: boolean }> = [];
    let unregistered = 0;
    setToolServerListenerRegistry((l) => {
      seen.push(l);
      return () => {
        unregistered += 1;
      };
    });
    try {
      const r = await rig();
      expect(seen.map((l) => l.name)).toEqual([`tool-server:${r.server.port}`]);
      expect(seen[0]!.listening).toBe(true);
      await r.server.close();
      expect(seen[0]!.listening).toBe(false);
      expect(unregistered).toBe(1);
    } finally {
      setToolServerListenerRegistry(registerListener);
    }
  });
  it('works without a listener registry (production)', async () => {
    setToolServerListenerRegistry(null);
    try {
      const r = await rig();
      expect((await rawProbe(r.server.port, r.server.token, { contentType: 'application/json' })).status).toBe(200);
    } finally {
      setToolServerListenerRegistry(registerListener);
    }
  });
});

describe('the guard (T2 3.4 matrix) runs BEFORE the SDK handler', () => {
  it('every row answers as specified, never 401/403; rejected rows reach neither the SDK nor the gate', async () => {
    const previous = await rig();
    expect((await rawProbe(previous.server.port, previous.server.token, {})).status).toBe(200);
    await previous.server.close();
    const r = await rig();
    const sdk = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest');
    for (const row of TOOL_SERVER_PROBE_MATRIX) {
      const before = { sdk: sdk.mock.calls.length, gate: r.invocations.length };
      const res = await rawProbe(r.server.port, r.server.token, row.probe);
      expect(res.status, row.id).toBe(row.expect);
      expect([401, 403]).not.toContain(res.status);
      expect(r.invocations.length, row.id).toBe(before.gate); // initialize is not a tool call either
      if (row.expect === 404) {
        expect(res.socketDestroyedByServer, row.id).toBe(true);
        expect(res.body, row.id).toBe('');
      }
      if (row.expect === 405) {
        expect(res.body).toBe('');
        expect(res.headers.allow).toBe('POST');
      }
      expect(sdk.mock.calls.length - before.sdk, row.id).toBe(row.expect === 200 ? 1 : 0);
    }
    expect(r.server.stats()).toMatchObject({ accepted: 3, toolCalls: 0 });
    expect(r.server.stats().rejected).toBe(TOOL_SERVER_PROBE_MATRIX.length - 3);
  }, 30_000);
  it('duplicate Host / Authorization / Origin headers, a chunked body over 64 KiB and a non-JSON body => 404', async () => {
    const r = await rig();
    for (const extraHeaders of <Array<Record<string, string>>>[
      { Host: `127.0.0.1:${r.server.port}` },
      { Authorization: `Bearer ${r.server.token}` },
      { origin: 'x' },
    ]) {
      expect((await rawProbe(r.server.port, r.server.token, { extraHeaders })).status).toBe(404);
    }
    expect((await post(r, 'not json')).status).toBe(404);
    const chunked = await new Promise<string>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: r.server.port }, () => {
        s.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${r.server.port}\r\nAuthorization: Bearer ${r.server.token}\r\n` +
            'Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        const chunk = 'x'.repeat(16 * 1024);
        for (let i = 0; i < 5; i += 1) s.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        s.write('0\r\n\r\n');
      });
      let data = '';
      s.on('data', (d) => (data += d.toString('latin1')));
      s.on('close', () => resolve(data));
      s.on('error', () => undefined);
    });
    expect(chunked.startsWith('HTTP/1.1 404')).toBe(true);
    expect(r.invocations).toEqual([]);
  });
  it('a body far beyond the cap is not drained: declared or streamed past 4 x 64 KiB => reset, never read to the end', async () => {
    const r = await rig();
    const flood = (extraHead: string, chunked: boolean, bytes: number): Promise<string> =>
      new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port: r.server.port }, () => {
          s.write(
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${r.server.port}\r\nAuthorization: Bearer ${r.server.token}\r\n` +
              `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n${extraHead}\r\n`,
          );
          const chunk = Buffer.alloc(32 * 1024, 0x78);
          for (let sent = 0; sent < bytes && !s.destroyed; sent += chunk.length) {
            if (chunked) s.write(`${chunk.length.toString(16)}\r\n`);
            s.write(chunk);
            if (chunked) s.write('\r\n');
          }
        });
        let data = '';
        s.on('data', (d: Buffer) => (data += d.toString('latin1')));
        s.on('close', () => resolve(data));
        s.on('error', () => undefined);
      });
    const before = r.server.stats().rejected;
    expect(await flood('Content-Length: 10000000\r\n', false, 0)).toBe(''); // declared flood: reset before reading
    expect(await flood('Transfer-Encoding: chunked\r\n', true, 400 * 1024)).toBe(''); // streamed flood: reset mid-body
    expect(r.server.stats().rejected).toBeGreaterThanOrEqual(before + 2); // a reset socket may also surface as a clientError
    expect(r.invocations).toEqual([]);
  });
  it('a garbage request line is reset (no 400 page); a peer that disconnects mid-body is dropped quietly', async () => {
    const r = await rig();
    const garbage = await new Promise<string>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: r.server.port }, () => s.write('GARBAGE\r\n\r\n'));
      let data = '';
      s.on('data', (d) => (data += d.toString('latin1')));
      s.on('close', () => resolve(data));
      s.on('error', () => undefined);
    });
    expect(garbage).toBe('');
    await new Promise<void>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: r.server.port }, () => {
        s.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${r.server.port}\r\nAuthorization: Bearer ${r.server.token}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc"',
        );
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 100);
      });
    });
    expect(r.invocations).toEqual([]);
    expect((await rawProbe(r.server.port, r.server.token, {})).status).toBe(200); // still serving
  });
  it('an SDK failure while serving an accepted request resets the socket (fail closed)', async () => {
    const r = await rig();
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(new Error('boom'));
    expect((await rawProbe(r.server.port, r.server.token, {})).status).toBe('reset');
  });
});

describe('MCP over the gate (F22: a new server + transport per request)', () => {
  it('initialize + tools/list + tools/call in one run; tools == the run specs with the gate LCD schemas, all readOnlyHint', async () => {
    const r = await rig();
    const client = await connect({ url: r.server.url, token: r.server.token });
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(r.gate.exposedSpecs().map((s) => s.name));
      for (const t of tools) {
        expect(t.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
        expect(t.inputSchema).toEqual(
          llmToolOf(READ_TOOLS[t.name as keyof typeof READ_TOOLS] as unknown as ToolSpec).inputSchema,
        );
      }
      expect(tools.map((t) => t.name)).not.toContain('wa_list_chats'); // trigger_chat scope
      // byte identity on the wire (the SDK client re-orders keys when it parses; the server sends the gate's LCD bytes, I4')
      const wire = await post(r, { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
      const listed = (JSON.parse(wire.body) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } })
        .result.tools;
      for (const t of listed) {
        expect(JSON.stringify(t.inputSchema)).toBe(
          JSON.stringify(llmToolOf(READ_TOOLS[t.name as keyof typeof READ_TOOLS] as unknown as ToolSpec).inputSchema),
        );
      }
      const out = await client.call('wa_get_chat_messages', { chat: 'chat_1' });
      expect(out.isError).toBe(false);
      const text = (out.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text.startsWith(`<<DATA-${NONCE}>>\n`)).toBe(true);
      expect(text).toContain('"chat":"chat_1"');
      expect(r.invocations).toHaveLength(1);
      expect(r.ctx.totalCalls).toBe(1); // the SAME RunCtx as the in-process path
      expect(client.errors).toEqual([]); // the SDK's optional GET stream got 405 and complained about nothing (F17)
      const bad = await client.call('send_message', { chat: 'chat_1' });
      expect(bad).toEqual({ isError: true, content: [{ type: 'text', text: '{"error":"tool not available"}' }] });
      expect(r.ctx.blockedCalls).toBe(1);
      expect(r.server.stats().toolCalls).toBe(2);
    } finally {
      await client.close();
    }
  });
  it('a tools/call without arguments reaches the gate with {} (and the zod shape decides)', async () => {
    const r = await rig();
    const client = await connect({ url: r.server.url, token: r.server.token });
    try {
      const out = await client.call('get_current_time', undefined as unknown as Record<string, unknown>);
      expect(out.isError).toBe(false);
      expect(r.invocations[0]!.input).toEqual({});
    } finally {
      await client.close();
    }
  });
  it('only specs the gate exposed at start are listed (a spec outside the exposure is dropped, fail closed)', async () => {
    const r = await rig({
      specs: [READ_TOOLS.get_current_time as unknown as ToolSpec, READ_TOOLS.wa_list_chats as unknown as ToolSpec],
    });
    const res = await post(r, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    expect(
      (JSON.parse(res.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name),
    ).toEqual(['get_current_time']);
    expect(JSON.parse(INITIALIZE_BODY)).toMatchObject({ method: 'initialize' });
  });
});

describe('port selection (NEVER_PORTS, typed EADDRINUSE error)', () => {
  it('skips 8080 and junk candidates; retries an occupied port; gives up with ToolServerPortError', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      const good = await freePort();
      const seq = [8080, 0, 70_000, 1.5, busy, good];
      const r = await rig({ freePort: () => Promise.resolve(seq.shift()!) });
      expect(r.server.port).toBe(good);
      await expect(rig({ freePort: () => Promise.resolve(busy) })).rejects.toBeInstanceOf(ToolServerPortError);
      const err = await rig({ freePort: () => Promise.resolve(8080) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolServerPortError);
      expect(err).toMatchObject({ code: 'EADDRINUSE', attempts: FREE_PORT_MAX_ATTEMPTS });
      await expect(rig({ freePort: () => Promise.reject(new Error('no port')) })).rejects.toMatchObject({
        attempts: 1,
      });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
