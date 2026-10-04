// Security gate group 19 (T2 8.2; invariant I2' "a CLI cannot reach non-allow-listed tools"). Owner V2-W1-05-wa-toolserver.
//
// Everything under test is PRODUCTION code on the real read path (tests/helpers/waWorld.ts createWaToolRig): the real
// mcp/toolServer.ts listener on a real loopback port, the real ToolGate, the real McpReadClient over the real host caller and the
// fake MCP calendar, the real WaReadClient over a real messages.db. The only "CLI" is the SDK client of tests/fakes/fake-mcp-client.ts
// and the raw-socket prober. The spawned-fake-CLI chain (fake-claude-cli.mjs in `attacker` mode) is added once V2-W1-06 lands
// (BLOCKED-BY in ops/agent-notes/V2-W1-05-wa-toolserver.md).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  startToolServer,
  setToolServerListenerRegistry,
  ToolServerPortError,
  type ToolServerHandle,
} from '../../src/main/mcp/toolServer.ts';
import { BLOCKED_NAMES, type RunCtx, type ToolGate } from '../../src/main/agent/toolGate.ts';
import { READ_TOOLS, llmToolOf, type ToolSpec } from '../../src/main/agent/toolDefs.ts';
import { freePort } from '../../src/main/proc/freePort.ts';
import type { LlmToolCall } from '../../src/main/llm/types.ts';
import { connect, rawProbe, TOOL_SERVER_PROBE_MATRIX } from '../fakes/fake-mcp-client.ts';
import { createWaToolRig, WA_RIG_NONCE, type WaToolRig } from '../helpers/waWorld.ts';
import { registerListener } from '../setup-guards.ts';

const NOT_AVAILABLE = '{"error":"tool not available"}';
const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

/** The attacker list (T2 3.1 + B17): every write / admin / reference-server name, CLI built-ins, FQNs, case / space / homoglyph variants. */
const ATTACKER_NAMES: readonly string[] = [
  ...BLOCKED_NAMES,
  'Bash',
  'Read',
  'Write',
  'WebFetch',
  'Task',
  'WA_SEARCH_MESSAGES',
  'wa_search_messages ',
  'wa_sеarch_messages', // Cyrillic e
  'Get_Freebusy',
  'mcp__wca__wa_list_chats',
  '../../etc/passwd',
];

interface Run {
  server: ToolServerHandle;
  ctx: RunCtx;
  invocations: LlmToolCall[];
}
let rig: WaToolRig | null = null;
const servers: ToolServerHandle[] = [];
beforeAll(() => setToolServerListenerRegistry(registerListener));
afterAll(() => setToolServerListenerRegistry(null));
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  await rig?.dispose();
  rig = null;
});

async function startRun(r: WaToolRig, opts: { freePort?: () => Promise<number> } = {}): Promise<Run> {
  const invocations: LlmToolCall[] = [];
  const spy: ToolGate = {
    ...r.gate,
    invoke: (call, ctx) => {
      invocations.push(call);
      return r.gate.invoke(call, ctx);
    },
  };
  const ctx = r.ctx();
  const server = await startToolServer({
    gate: spy,
    ctx,
    specs: r.gate.exposedSpecs(),
    randomBytes: (n) => randomBytes(n),
    freePort: opts.freePort ?? (() => freePort()),
    appVersion: '0.0.0-test',
  });
  servers.push(server);
  return { server, ctx, invocations };
}
const textOf = (content: unknown): string => (content as Array<{ text: string }>)[0]!.text;

describe("I2' - the loopback listener answers nobody but the run bearer, and never with a probing signal", () => {
  it('TOOL_SERVER_PROBE_MATRIX: 404 + destroyed / 405 / reset as specified, zero gate calls, never 401 / 403', async () => {
    rig = await createWaToolRig();
    const previous = await startRun(rig);
    expect((await rawProbe(previous.server.port, previous.server.token, {})).status).toBe(200);
    await previous.server.close();
    expect((await rawProbe(previous.server.port, previous.server.token, {})).status).toBe('refused'); // gone with its run
    const run = await startRun(rig);
    expect(run.server.url).toBe(`http://127.0.0.1:${run.server.port}/mcp`);
    expect(run.server.port).not.toBe(8080);
    for (const row of TOOL_SERVER_PROBE_MATRIX) {
      const res = await rawProbe(run.server.port, run.server.token, row.probe);
      expect(res.status, row.id).toBe(row.expect);
      expect([401, 403]).not.toContain(res.status);
      if (row.expect === 404) expect(res.socketDestroyedByServer, row.id).toBe(true);
      if (row.expect === 405) expect(res.body, row.id).toBe('');
    }
    expect(run.invocations).toEqual([]);
    expect(rig.blockedAudit()).toEqual([]);
    expect(rig.waCalls).toEqual([]);
  }, 30_000);
});

describe("I2' - tools/list is exactly this run's exposed READ specs, all readOnlyHint (I4' byte-identical schemas)", () => {
  it('trigger_chat: calendar + three wa_* tools; wa_list_chats, get-event, list-events never listed', async () => {
    rig = await createWaToolRig();
    const run = await startRun(rig);
    const client = await connect({ url: run.server.url, token: run.server.token });
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(rig.gate.exposedSpecs().map((s) => s.name));
      expect(tools.map((t) => t.name)).toEqual([
        'get_current_time',
        'get_freebusy',
        'wa_get_chat_messages',
        'wa_search_messages',
        'wa_get_message_context',
      ]);
      for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(client.errors).toEqual([]); // F17: the optional GET stream got 405, the SDK client raised nothing
    } finally {
      await client.close();
    }
    const wire = await rawProbe(run.server.port, run.server.token, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    const listed = (JSON.parse(wire.body) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } })
      .result.tools;
    for (const t of listed) {
      expect(JSON.stringify(t.inputSchema)).toBe(
        JSON.stringify(llmToolOf(READ_TOOLS[t.name as keyof typeof READ_TOOLS] as unknown as ToolSpec).inputSchema),
      );
    }
  });
  it('all_chats adds wa_list_chats; a disconnected calendar removes the calendar tools', async () => {
    rig = await createWaToolRig({ scope: 'all_chats', calendarConnected: false });
    const run = await startRun(rig);
    const client = await connect({ url: run.server.url, token: run.server.token });
    try {
      expect((await client.listTools()).map((t) => t.name)).toEqual([
        'wa_get_chat_messages',
        'wa_search_messages',
        'wa_get_message_context',
        'wa_list_chats',
      ]);
    } finally {
      await client.close();
    }
  });
});

describe("I2' - every tools/call goes through ToolGate.invoke with the run RunCtx (F22: >= 3 requests in one run)", () => {
  it('initialize + tools/list + tools/call succeed; results are nonce-wrapped and carry handles only', async () => {
    rig = await createWaToolRig();
    const run = await startRun(rig);
    const client = await connect({ url: run.server.url, token: run.server.token });
    try {
      await client.listTools();
      const out = await client.call('wa_search_messages', { query: 'Wednesday' });
      expect(out.isError).toBe(false);
      const text = textOf(out.content);
      expect(text.startsWith(`<<DATA-${WA_RIG_NONCE}>>\n`)).toBe(true);
      expect(text).toContain('"chat":"chat_1"');
      expect(text).not.toMatch(/@s\.whatsapp\.net|\d{9,}/);
      const time = await client.call('get_current_time', {});
      expect(time.isError).toBe(false);
      expect(run.invocations.map((c) => c.name)).toEqual(['wa_search_messages', 'get_current_time']);
      expect(run.ctx.totalCalls).toBe(2);
      expect(run.server.stats().toolCalls).toBe(2);
    } finally {
      await client.close();
    }
  });
  it('the attacker list: synthetic isError, one sha8-only tool_blocked audit per call, strikes, zero side effects', async () => {
    rig = await createWaToolRig();
    const run = await startRun(rig);
    const client = await connect({ url: run.server.url, token: run.server.token });
    try {
      for (const name of ATTACKER_NAMES) {
        const out = await client.call(name, { chat: 'chat_1', summary: 'x', eventId: 'e1', message: 'hi' });
        expect(out.isError, name).toBe(true);
        expect(textOf(out.content), name).toBe(NOT_AVAILABLE);
      }
    } finally {
      await client.close();
    }
    const audit = rig.blockedAudit();
    expect(audit).toHaveLength(ATTACKER_NAMES.length);
    audit.forEach((d, i) => {
      expect(Object.keys(d).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
      expect(d).toMatchObject({
        nameSha8: sha8(ATTACKER_NAMES[i]!),
        verdict: 'blocked_unknown_tool',
        runId: run.ctx.runId,
      });
    });
    expect(run.ctx.blockedCalls).toBe(ATTACKER_NAMES.length);
    expect(rig.nonReadCalendarCalls()).toEqual([]);
    expect(rig.calendar.violations).toEqual([]);
    expect(rig.waCalls).toEqual([]);
    expect(run.ctx.waRowsServed).toBe(0);
  });
  it('wa_list_chats in trigger_chat scope is blocked_not_exposed (a strike); get-event / list-events are never callable', async () => {
    rig = await createWaToolRig();
    const run = await startRun(rig);
    const client = await connect({ url: run.server.url, token: run.server.token });
    try {
      expect((await client.call('wa_list_chats', {})).isError).toBe(true);
      expect((await client.call('get-event', { eventId: 'x' })).isError).toBe(true);
      expect((await client.call('list-events', {})).isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(rig.blockedAudit().map((d) => d.verdict)).toEqual([
      'blocked_not_exposed',
      'blocked_unknown_tool',
      'blocked_unknown_tool',
    ]);
    expect(rig.waCalls).toEqual([]);
  });
});

describe("I5' - runs are isolated: a new token, a new port, a new handle table", () => {
  it("run 2 never resolves run 1 message handles, and run 1's token is refused by run 2's listener", async () => {
    rig = await createWaToolRig();
    const run1 = await startRun(rig);
    const c1 = await connect({ url: run1.server.url, token: run1.server.token });
    const first = await c1.call('wa_get_chat_messages', { chat: 'chat_1', limit: 2 });
    expect(textOf(first.content)).toContain('"id":"m_1"');
    await c1.close();
    await run1.server.close();
    const run2 = await startRun(rig);
    expect(run2.server.token).not.toBe(run1.server.token);
    expect((await rawProbe(run2.server.port, run1.server.token, {})).status).toBe(404);
    const c2 = await connect({ url: run2.server.url, token: run2.server.token });
    try {
      const out = await c2.call('wa_get_message_context', { message: 'm_1' });
      expect(out.isError).toBe(true); // blocked_bad_args: never shown in THIS run
      expect(run2.ctx.blockedCalls).toBe(0);
    } finally {
      await c2.close();
    }
  });
  it('the token appears in no audit row and no log line', async () => {
    rig = await createWaToolRig();
    const run = await startRun(rig);
    const client = await connect({ url: run.server.url, token: run.server.token });
    await client.call('send_message', { text: run.server.token });
    await client.call('wa_search_messages', { query: run.server.token.slice(0, 40) });
    await client.close();
    const auditText = JSON.stringify(rig.db.prepare('SELECT * FROM audit_log').all());
    expect(auditText).not.toContain(run.server.token);
    expect(auditText).not.toContain(run.server.token.slice(0, 16));
    expect(rig.logs.join('\n')).not.toContain(run.server.token.slice(0, 16));
  });
});

describe('start failure', () => {
  it('EADDRINUSE on every attempt => ToolServerPortError (the CLI provider maps it to not_ready; nothing listens)', async () => {
    rig = await createWaToolRig();
    const holder = await startRun(rig);
    const err = await startRun(rig, { freePort: () => Promise.resolve(holder.server.port) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolServerPortError);
    expect((err as ToolServerPortError).code).toBe('EADDRINUSE');
  });
});
