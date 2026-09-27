// Verification of review finding process-lifecycle-3 against the REAL createMcpHost + REAL createSupervisor
// (the reviewer's own scratch used a hand-written copy of the host). Scratch only; not part of `npm test`.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVirtualClock } from '../../../tests/helpers/virtualClock';
import { createFakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import { createSupervisor, DEFAULT_GRACE_MS } from '../../../src/main/proc/supervisor';
import { createMcpHost } from '../../../src/main/mcp/host';
import type { FakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import type { McpHostDeps } from '../../../src/main/mcp/host';
import type { ProcessQuery } from '../../../src/main/deps';

const DEPS: McpHostDeps = {
  execPath: 'C:\\Program Files\\WCA\\WCA.exe',
  mcpRoot: 'C:\\Program Files\\WCA\\resources\\calendar-mcp',
  credentialsPath: 'C:\\Users\\t\\AppData\\Roaming\\WCA\\google\\keys.json',
  tokenPath: 'C:\\Users\\t\\AppData\\Roaming\\WCA\\google\\tokens.json',
  onStderrMarker: () => undefined,
};

const open: FakeMcpCalendar[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.stop();
});

const tmpRun = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wca-plc3-'));

async function wire(pid: number | null) {
  const fake = createFakeMcpCalendar({});
  open.push(fake);
  const transport = fake.clientTransport();
  // Give the client half a `pid`, exactly like StdioClientTransport does in production.
  if (pid !== null) Object.defineProperty(transport, 'pid', { value: pid, configurable: true });
  await fake.connect();
  const host = createMcpHost({ ...DEPS, transportFactory: () => transport });
  return { fake, host };
}

describe('process-lifecycle-3 against the real host', () => {
  it('supervisor.stop(calendar-mcp) escalates to taskkill even though the child exited cleanly', async () => {
    const clock = createVirtualClock();
    const runDir = tmpRun();
    const taskkilled: Array<{ pid: number; tree: boolean }> = [];
    const processQuery: ProcessQuery = {
      query: () => Promise.resolve(null),
      kill: (p, tree) => {
        taskkilled.push({ pid: p, tree });
        return Promise.resolve();
      },
    };
    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery,
      killSync: () => undefined,
      random: { bytes: () => new Uint8Array(0), int: () => 0, float: () => 0 },
    });

    const { fake, host } = await wire(9001);
    sup.register(host.childSpec());
    await sup.start('calendar-mcp');
    expect(sup.state('calendar-mcp')).toBe('running');
    expect(host.pid()).toBe(9001);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'calendar-mcp.pid.json'), 'utf8')).pid).toBe(9001);

    const stopped = sup.stop('calendar-mcp', { graceMs: DEFAULT_GRACE_MS });
    // let host.stop()'s teardown/close settle before the grace timer fires
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(host.status()).toBe('not_configured'); // the transport is already torn down: the child is GONE
    await clock.advance(DEFAULT_GRACE_MS + 1);
    await stopped;

    // eslint-disable-next-line no-console
    console.log('taskkilled =', JSON.stringify(taskkilled), 'fakeCalls =', fake.calls.length);
    expect(taskkilled).toEqual([{ pid: 9001, tree: true }]);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('a transport without a pid makes the supervisor taskkill PID 0', async () => {
    const clock = createVirtualClock();
    const runDir = tmpRun();
    const taskkilled: Array<{ pid: number; tree: boolean }> = [];
    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery: {
        query: () => Promise.resolve(null),
        kill: (p, tree) => {
          taskkilled.push({ pid: p, tree });
          return Promise.resolve();
        },
      },
      killSync: () => undefined,
      random: { bytes: () => new Uint8Array(0), int: () => 0, float: () => 0 },
    });
    const { host } = await wire(null);
    sup.register(host.childSpec());
    await sup.start('calendar-mcp');
    const stopped = sup.stop('calendar-mcp', { graceMs: DEFAULT_GRACE_MS });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await clock.advance(DEFAULT_GRACE_MS + 1);
    await stopped;
    // eslint-disable-next-line no-console
    console.log('pid0 taskkilled =', JSON.stringify(taskkilled));
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('a REAL crash (transport close from the server side) does reach the supervisor', async () => {
    const clock = createVirtualClock();
    const runDir = tmpRun();
    const taskkilled: Array<{ pid: number; tree: boolean }> = [];
    const sup = createSupervisor({
      runDir,
      now: () => clock.now(),
      log: () => undefined,
      clock,
      processQuery: {
        query: () => Promise.resolve(null),
        kill: (p, tree) => {
          taskkilled.push({ pid: p, tree });
          return Promise.resolve();
        },
      },
      killSync: () => undefined,
      random: { bytes: () => new Uint8Array(0), int: () => 0, float: () => 0 },
    });
    const { fake, host } = await wire(9002);
    sup.register(host.childSpec());
    await sup.start('calendar-mcp');
    await fake.stop(); // server half closes => client onclose => exitCbs fire
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // eslint-disable-next-line no-console
    console.log('crash path: host=', host.status(), 'supState=', sup.state('calendar-mcp'), JSON.stringify(taskkilled));
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
