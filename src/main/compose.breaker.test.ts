// src/main/compose.breaker.test.ts - process-lifecycle-6: the composition root's breaker-retry policy.
//
// ARCHITECTURE 4.3 ("`Try again` resets the breaker") and CONTRACTS 13 ("`resetBreaker(name)` - only from a user
// click") describe the ONLY way out of a latched breaker: `Supervisor.stop()` preserves the latch deliberately and no
// amount of elapsed time clears it (proved by supervisor.test.ts). Until this file existed, `resetBreaker` had no
// production caller at all - a repo-wide grep over `src/**` minus tests found it only inside `proc/supervisor.ts` and
// as `bridge/launcher.ts`'s own private, unrelated `resetBreaker()` - so a supervised child that crash-looped once
// stayed refused for the rest of the session and only an app restart brought it back.
//
// Everything here runs against the REAL `createSupervisor` and the REAL `clearLatchedBreaker` of compose.ts. The child
// handles are scripted objects: no process is spawned, nothing is downloaded and no exe is named (rules T1/T2).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSupervisor } from './proc/supervisor';
import type { ChildHandle, ChildName, ChildSpec, Supervisor } from './proc/supervisor';
import { clearLatchedBreaker, supervisedCalendarHost } from './compose';
import type { McpStatus } from '../shared/health';
import { createVirtualClock, type VirtualClock } from '../../tests/helpers/virtualClock';

const COMPOSE_SRC = fileURLToPath(new URL('./compose.ts', import.meta.url));

interface ScriptedChild {
  handle: ChildHandle;
  exit(code?: number): void;
}

function scriptedChild(pid: number, exePath: string): ScriptedChild {
  const listeners: Array<(i: { code: number | null; signal: string | null }) => void> = [];
  let exited = false;
  return {
    handle: {
      pid,
      exePath,
      kill: () => {
        if (exited) return;
        exited = true;
        for (const cb of [...listeners]) cb({ code: null, signal: 'SIGTERM' });
      },
      onExit: (cb) => {
        listeners.push(cb);
      },
    },
    exit: (code = 1) => {
      if (exited) return;
      exited = true;
      for (const cb of [...listeners]) cb({ code, signal: null });
    },
  };
}

let tmpDir: string;
let clock: VirtualClock;
let logs: Array<{ event: string; meta: Record<string, string | number> }>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-brk-'));
  clock = createVirtualClock();
  logs = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A supervised 'bridge' whose children exit on command; `maxExits` crashes inside the window latch the breaker. */
async function rig(maxExits = 3): Promise<{
  sup: Supervisor;
  crash: () => void;
  stop: () => Promise<void>;
}> {
  const children: ScriptedChild[] = [];
  const sup = createSupervisor({
    runDir: path.join(tmpDir, 'run'),
    now: () => clock.now(),
    log: (event, meta) => logs.push({ event, meta }),
    clock,
    processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
    killSync: () => undefined,
    random: { bytes: (n) => new Uint8Array(n), int: (min) => min, float: () => 0 },
  });
  const spec: ChildSpec = {
    name: 'bridge',
    start: (attempt) => {
      const c = scriptedChild(500 + attempt, path.join(tmpDir, 'bridge.exe'));
      children.push(c);
      return Promise.resolve(c.handle);
    },
    backoffMs: [1_000],
    breaker: { maxExits, windowMs: 600_000 },
    stableAfterMs: 60_000,
  };
  sup.register(spec);
  await sup.start('bridge');
  return {
    sup,
    crash: () => children[children.length - 1]?.exit(1),
    stop: () => sup.stop('bridge'),
  };
}

describe('clearLatchedBreaker (compose.ts) - ARCHITECTURE 4.3 / CONTRACTS 13', () => {
  it('lets a user retry start a child whose breaker latched, which a plain start() cannot', async () => {
    const { sup, crash, stop } = await rig(3);

    crash();
    await clock.advance(1_000);
    crash();
    await clock.advance(1_000);
    expect(sup.state('bridge')).toBe('running');

    crash(); // third exit inside the window: the breaker latches
    expect(sup.state('bridge')).toBe('failed');
    expect(logs.some((l) => l.event === 'proc_breaker_open')).toBe(true);

    // The defect: every later start is refused, and waiting does not help - the latch outlives the whole session.
    await sup.start('bridge');
    expect(sup.state('bridge')).toBe('failed');
    expect(logs.some((l) => l.event === 'proc_start_refused')).toBe(true);
    await clock.advance(600_000);
    await sup.start('bridge');
    expect(sup.state('bridge')).toBe('failed');

    // The user's retry (Settings -> Re-link / Show new code / Forget and wipe, all of which reach startBridge()).
    expect(clearLatchedBreaker(sup, 'bridge')).toBe(true);
    expect(sup.state('bridge')).toBe('stopped');
    expect(logs.some((l) => l.event === 'proc_breaker_reset')).toBe(true);

    await sup.start('bridge');
    expect(sup.state('bridge')).toBe('running');
    await stop();
  });

  it('is a no-op for a child that is not latched, so a retry cannot launder a crash loop in progress', async () => {
    const { sup, crash, stop } = await rig(3);

    expect(clearLatchedBreaker(sup, 'bridge')).toBe(false); // running

    crash();
    expect(sup.state('bridge')).toBe('backoff');
    expect(clearLatchedBreaker(sup, 'bridge')).toBe(false); // backing off: the exit history is kept
    await clock.advance(1_000);
    crash();
    await clock.advance(1_000);

    // Two exits are still on the clock, so the third one inside the window latches exactly as it would have.
    crash();
    expect(sup.state('bridge')).toBe('failed');
    expect(logs.filter((l) => l.event === 'proc_breaker_reset')).toHaveLength(0);
    await stop();
  });

  it('never resets a breaker the caller did not name', async () => {
    const { sup, crash, stop } = await rig(1);
    crash();
    expect(sup.state('bridge')).toBe('failed');
    for (const other of ['calendar-mcp', 'llama'] as ChildName[]) {
      expect(() => clearLatchedBreaker(sup, other)).toThrow(); // unregistered: the Supervisor refuses to guess
    }
    expect(clearLatchedBreaker(sup, 'bridge')).toBe(true);
    await stop();
  });
});

describe('the production call site (process-lifecycle-6 regression guard)', () => {
  // The defect was "no production caller", so the behavioural test above cannot stand alone: it would still pass if
  // compose() stopped calling the policy. `startBridge()` is the single place every bridge start goes through.
  const src = fs.readFileSync(COMPOSE_SRC, 'utf8');

  it('startBridge() clears a latched bridge breaker before asking the Supervisor to start', () => {
    const body = src.slice(src.indexOf('async function startBridge('));
    const cut = body.indexOf('async function stopBridge(');
    const startBridge = cut === -1 ? body : body.slice(0, cut);

    expect(startBridge).toContain("clearLatchedBreaker(supervisor, 'bridge')");
    expect(startBridge.indexOf("clearLatchedBreaker(supervisor, 'bridge')")).toBeLessThan(
      startBridge.indexOf("supervisor.start('bridge')"),
    );
  });
});

// =====================================================================================================================
// calendar-mcp: the OTHER half of process-lifecycle-6.
//
// `startBridge()` above closes the latch for the bridge, but `calendar-mcp` had no user-reachable supervised start at
// all: `supervisor.start('calendar-mcp')` runs exactly once per session (compose's `start()`), and the wizard's own
// retries - Import credentials / Replace key, i.e. `googleAuth.importCredentials()` -> `host.start()` - reached PAST
// the Supervisor into the raw host. So a latched calendar breaker was not merely un-cleared: the only way back was an
// unsupervised spawn with no pid file (invisible to `killAllSync()` and the reaper, ARCH 3).
// `supervisedCalendarHost()` is the facade compose hands to `createGoogleAuth`: every wizard start now goes through
// the Supervisor, and because each of those calls IS a user action it first clears a latched breaker.
// =====================================================================================================================

type ExitCb = (i: { code: number | null; signal: string | null }) => void;

interface ScriptedHost {
  host: {
    start(): Promise<McpStatus>;
    stop(): Promise<void>;
    status(): McpStatus;
    onStatus(cb: (s: McpStatus) => void): () => void;
  };
  starts: number;
  stops: number;
  /** The ChildSpec hands its exit callback here, mirroring `mcp/host.ts`'s own `exitCbs`. */
  attach(cb: ExitCb): void;
  /** Kills the connected server the way the MCP client's `onclose` does: the Supervisor observes a child exit. */
  die(): void;
}

function scriptedHost(): ScriptedHost {
  let status: McpStatus = 'not_configured';
  let exitCbs: ExitCb[] = [];
  const drain = (info: { code: number | null; signal: string | null }): void => {
    const cbs = exitCbs;
    exitCbs = [];
    for (const cb of cbs) cb(info);
  };
  const rec: ScriptedHost = {
    starts: 0,
    stops: 0,
    host: {
      start: () => {
        rec.starts += 1;
        status = 'connected';
        return Promise.resolve(status);
      },
      stop: () => {
        rec.stops += 1;
        status = 'not_configured';
        drain({ code: null, signal: null });
        return Promise.resolve();
      },
      status: () => status,
      onStatus: () => () => undefined,
    },
    attach: (cb) => {
      exitCbs.push(cb);
    },
    die: () => {
      status = 'unavailable';
      drain({ code: 1, signal: null });
    },
  };
  return rec;
}

async function calendarRig(): Promise<{
  sup: Supervisor;
  scripted: ScriptedHost;
  facade: ReturnType<typeof supervisedCalendarHost>;
  registrations: () => number;
}> {
  const scripted = scriptedHost();
  const sup = createSupervisor({
    runDir: path.join(tmpDir, 'run'),
    now: () => clock.now(),
    log: (event, meta) => logs.push({ event, meta }),
    clock,
    processQuery: { query: () => Promise.resolve(null), kill: () => Promise.resolve() },
    killSync: () => undefined,
    random: { bytes: (n) => new Uint8Array(n), int: (min) => min, float: () => 0 },
  });
  const spec: ChildSpec = {
    name: 'calendar-mcp',
    start: async (): Promise<ChildHandle> => {
      const s = await scripted.host.start();
      if (s === 'unavailable' || s === 'not_configured') throw new Error('mcp_start_unavailable');
      return {
        pid: 0,
        exePath: path.join(tmpDir, 'node.exe'),
        kill: () => void scripted.host.stop(),
        onExit: scripted.attach,
      };
    },
    backoffMs: [1_000],
    breaker: { maxExits: 3, windowMs: 600_000 },
    stableAfterMs: 60_000,
  };
  let count = 0;
  const facade = supervisedCalendarHost({
    supervisor: sup,
    host: scripted.host,
    ensureRegistered: () => {
      if (count > 0) return;
      count += 1;
      sup.register(spec);
    },
  });
  return { sup, scripted, facade, registrations: () => count };
}

describe('supervisedCalendarHost (compose.ts) - the calendar half of process-lifecycle-6', () => {
  it('revives a calendar-mcp whose breaker latched, which the wizard could not do before', async () => {
    const { sup, scripted, facade } = await calendarRig();

    expect(await facade.start()).toBe('connected');
    expect(sup.state('calendar-mcp')).toBe('running');
    expect(scripted.starts).toBe(1);

    // Three exits inside the 10 min window - a transient EADDRINUSE on the OAuth callback port looks exactly like this.
    scripted.die();
    await clock.advance(1_000);
    scripted.die();
    await clock.advance(1_000);
    scripted.die();
    expect(sup.state('calendar-mcp')).toBe('failed');
    expect(logs.some((l) => l.event === 'proc_breaker_open')).toBe(true);

    // The defect: the Supervisor refuses every later start, for the rest of the session.
    const startsWhenLatched = scripted.starts;
    await sup.start('calendar-mcp');
    expect(sup.state('calendar-mcp')).toBe('failed');
    expect(scripted.starts).toBe(startsWhenLatched);

    // The user's retry (the wizard's Import credentials / Settings -> Replace key) goes through the facade.
    expect(await facade.start()).toBe('connected');
    expect(logs.some((l) => l.event === 'proc_breaker_reset')).toBe(true);
    expect(sup.state('calendar-mcp')).toBe('running');
    expect(scripted.starts).toBe(startsWhenLatched + 1);

    await sup.stop('calendar-mcp');
  });

  it('starts the child THROUGH the Supervisor, so the retry is never an unsupervised spawn', async () => {
    const { sup, scripted, facade, registrations } = await calendarRig();

    // A wizard retry that lands before compose.start() registered the children must still be supervised, not raw.
    expect(registrations()).toBe(0);
    await facade.start();
    expect(registrations()).toBe(1);
    expect(sup.state('calendar-mcp')).toBe('running');

    // Idempotent: a second import does not register a second entry (that would wipe the live child's bookkeeping).
    await facade.start();
    expect(registrations()).toBe(1);
    expect(scripted.starts).toBe(1); // supervisor.start() on a running child is a no-op

    await facade.stop();
    expect(sup.state('calendar-mcp')).toBe('stopped'); // disconnect() stops the SUPERVISED child, not a stray host
    expect(scripted.stops).toBeGreaterThan(0);
  });

  it('does not launder a crash loop that is still in progress', async () => {
    const { sup, scripted, facade } = await calendarRig();

    await facade.start();
    scripted.die();
    expect(sup.state('calendar-mcp')).toBe('backoff');
    // Backing off is not 'failed', so the exit history survives a retry: the breaker can still latch.
    await facade.start();
    expect(logs.filter((l) => l.event === 'proc_breaker_reset')).toHaveLength(0);

    await clock.advance(1_000);
    scripted.die();
    await clock.advance(1_000);
    scripted.die();
    expect(sup.state('calendar-mcp')).toBe('failed');

    await sup.stop('calendar-mcp');
  });
});

describe('the calendar production call site (process-lifecycle-6 regression guard)', () => {
  const src = fs.readFileSync(COMPOSE_SRC, 'utf8');

  it('createGoogleAuth receives the supervised host, never the raw mcpHost', () => {
    const call = src.slice(src.indexOf('createGoogleAuth({'), src.indexOf('googleAuth.onChange'));
    // The wizard's own `host` dep - the first key of the literal - must be the facade, not the raw host. (`mcpHost`
    // still appears INSIDE the facade's input, which is exactly where it belongs.)
    const hostArg = /createGoogleAuth\(\{\s*host:\s*([^\n]*)/.exec(call)?.[1] ?? '';
    expect(hostArg).toMatch(/^supervisedCalendarHost\(\{/);
    expect(hostArg).toContain('supervisor');
  });
});
