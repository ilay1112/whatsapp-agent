// Scratch proof for process-lifecycle-4: compose()'s bridgeControl.restartForNewCode / relink / unlinkAndWipe run
// launcher.launchLoop() AND supervisor.start('bridge'), so two bridge children end up alive at once and the first one
// is orphaned (no pid file, no handle, no reaper record).
// Run: npx vitest run --config "ops/agent-notes/review-process-lifecycle.scratch/vitest.scratch.config.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import { createPaths } from '../../../src/main/paths';
import { createBridgeLauncher, type BridgeLauncherDeps } from '../../../src/main/bridge/launcher';
import { createSupervisor } from '../../../src/main/proc/supervisor';
import type { Logger, RandomSource } from '../../../src/main/deps';

const ports = vi.hoisted(() => ({ asked: 0 }));
vi.mock('../../../src/main/proc/freePort', () => ({
  NEVER_PORTS: [8080],
  freePort: (): Promise<number> => Promise.resolve(50_000 + ports.asked++),
}));

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
};

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    if (this.exitCode !== null) return false;
    setImmediate(() => this.exit(0));
    return true;
  }
  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

let root: string;
let children: FakeChild[];
let clock: VirtualClock;

const noopLog: Logger = (() => {
  const l = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => l,
  } as unknown as Logger;
  return l;
})();

function build(): { launcher: ReturnType<typeof createBridgeLauncher>; supervisor: ReturnType<typeof createSupervisor> } {
  root = mkdtempSync(join(tmpdir(), 'wca-dbl-'));
  const userData = join(root, 'userData');
  const resources = join(root, 'resources');
  mkdirSync(join(resources, 'bridge'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  const paths = createPaths({ userData, resourcesPath: resources, appRoot: join(root, 'app'), isPackaged: true });
  writeFileSync(paths.bridgeExe, 'dummy-bridge-exe');
  const expectedSha256 = createHash('sha256').update('dummy-bridge-exe').digest('hex');

  clock = createVirtualClock(NOW);
  children = [];
  let counter = 0;
  const random: RandomSource = { bytes: (n) => new Uint8Array(n).fill(++counter), int: () => 0, float: () => 0 };

  const fetchFn = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.pathname === '/api/pairing/status') {
      return new Response(JSON.stringify({ status: 'connected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', connected: true, timestamp: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nope', { status: 404 });
  }) as BridgeLauncherDeps['fetch'];

  let secret = 0;
  const deps: BridgeLauncherDeps = {
    paths,
    exePath: paths.bridgeExe,
    expectedSha256,
    tosAccepted: () => true,
    doorbell: { port: () => 51_234, rotateSecret: () => `http://127.0.0.1:51234/hook/${'S'.repeat(40)}${++secret}` },
    spawn: (() => {
      const c = new FakeChild(2000 + children.length);
      children.push(c);
      return c.asChild();
    }) as BridgeLauncherDeps['spawn'],
    fetch: fetchFn,
    clock,
    random,
    log: noopLog,
    audit: () => undefined,
    onMarker: () => undefined,
  };

  const launcher = createBridgeLauncher(deps);
  const supervisor = createSupervisor({
    runDir: paths.runDir,
    now: () => clock.now(),
    log: () => undefined,
    clock,
    processQuery: { query: async () => null, kill: async () => undefined },
    killSync: () => undefined,
    random,
  });
  supervisor.register(launcher.childSpec());
  return { launcher, supervisor };
}

async function settle(p: Promise<unknown>, rounds = 60): Promise<void> {
  let done = false;
  const watched = p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await flush();
  for (let i = 0; i < rounds && !done; i++) {
    await clock.advance(500);
    await tick();
    if (i % 5 === 4) await flush();
  }
  await watched;
  await p;
}

beforeEach(() => {
  ports.asked = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('process-lifecycle-4: restartForNewCode spawns a second bridge and orphans the first', () => {
  it('leaves two live bridge children after the compose() sequence', async () => {
    const { launcher, supervisor } = build();

    // compose().start() -> startBridge() -> supervisor.start('bridge')
    await settle(supervisor.start('bridge'));
    expect(children).toHaveLength(1);
    expect(children[0]?.exitCode).toBeNull();

    // ---- compose()'s bridgeControl.restartForNewCode(), verbatim ----
    // 1) stopBridge()
    await settle(supervisor.stop('bridge'));
    await settle(launcher.stop());
    expect(children[0]?.exitCode).toBe(0);

    // 2) launcher.restartForNewCode()  -> stopInternal + resetBreaker + launchLoop()  == an UNSUPERVISED spawn
    await settle(launcher.restartForNewCode());
    expect(children).toHaveLength(2);
    expect(children[1]?.exitCode).toBeNull(); // child #2 is live and belongs to nobody

    // 3) startBridge() -> supervisor.start('bridge') -> childSpec().start() -> spawnOnce() again
    await settle(supervisor.start('bridge'));

    expect(children).toHaveLength(3); // <-- a THIRD process was spawned
    const live = children.filter((c) => c.exitCode === null).map((c) => c.pid);
    expect(live).toEqual([2001, 2002]); // <-- TWO bridges alive at once; 2001 is an untracked orphan

    // The supervisor's pid file names only the last one, so neither killAllSync() nor the reaper can ever reach 2001.
    expect(supervisor.state('bridge')).toBe('running');
  });
});
