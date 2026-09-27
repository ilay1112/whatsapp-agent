// Independent verification of review finding process-lifecycle-4.
// Drives the REAL createBridgeLauncher + REAL createSupervisor through the exact call sequence of
// compose.ts bridgeControl.restartForNewCode / relink (compose.ts:975-995), with a fake spawn whose children
// register themselves as loopback listeners keyed by the port+token the launcher actually put in their env.
// Run:
//   npx vitest run --config "ops/agent-notes/verify-process-lifecycle-4.scratch/vitest.scratch.config.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import { createPaths } from '../../../src/main/paths';
import { createBridgeLauncher, type BridgeLauncherDeps } from '../../../src/main/bridge/launcher';
import { createSupervisor } from '../../../src/main/proc/supervisor';
import type { Logger, RandomSource } from '../../../src/main/deps';

const portState = vi.hoisted(() => ({ next: 0 }));
vi.mock('../../../src/main/proc/freePort', () => ({
  NEVER_PORTS: [8080],
  freePort: (): Promise<number> => Promise.resolve(50_100 + portState.next++),
}));

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
};

/** A fake bridge child that "listens" on the port the launcher gave it, until it is killed. */
class FakeBridge extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killCalls = 0;
  constructor(
    readonly pid: number,
    readonly port: string,
    readonly token: string,
  ) {
    super();
  }
  kill(): boolean {
    this.killCalls += 1;
    if (this.exitCode !== null) return false;
    setImmediate(() => {
      if (this.exitCode !== null) return;
      this.exitCode = 0;
      this.emit('exit', 0, null);
    });
    return true;
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

const noopLog: Logger = (() => {
  const l = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => l,
  } as unknown as Logger;
  return l;
})();

let root = '';
let spawned: FakeBridge[] = [];
let clock: VirtualClock;

const liveOnPort = (port: string): FakeBridge | undefined =>
  spawned.find((c) => c.port === port && c.exitCode === null);

function build(): {
  launcher: ReturnType<typeof createBridgeLauncher>;
  supervisor: ReturnType<typeof createSupervisor>;
  paths: ReturnType<typeof createPaths>;
  killedPids: number[];
  secrets: string[];
} {
  root = mkdtempSync(join(tmpdir(), 'wca-pl4-'));
  const userData = join(root, 'userData');
  const resources = join(root, 'resources');
  mkdirSync(join(resources, 'bridge'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  const paths = createPaths({ userData, resourcesPath: resources, appRoot: join(root, 'app'), isPackaged: true });
  writeFileSync(paths.bridgeExe, 'dummy-bridge-exe');
  const expectedSha256 = createHash('sha256').update('dummy-bridge-exe').digest('hex');
  mkdirSync(paths.bridgeStoreDir, { recursive: true });
  writeFileSync(paths.bridgeWhatsappDb, 'session');

  clock = createVirtualClock();
  spawned = [];
  const killedPids: number[] = [];
  const secrets: string[] = [];
  let seed = 0;
  const random: RandomSource = { bytes: (n) => new Uint8Array(n).fill(++seed), int: () => 0, float: () => 0 };

  const fetchFn = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const child = liveOnPort(url.port);
    if (child === undefined) return new Response('closed', { status: 502 }); // nobody listening
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

  let secretN = 0;
  const deps: BridgeLauncherDeps = {
    paths,
    exePath: paths.bridgeExe,
    expectedSha256,
    tosAccepted: () => true,
    doorbell: {
      port: () => 51_999,
      rotateSecret: (): string => {
        const s = `http://127.0.0.1:51999/hook/${'a'.repeat(39)}${++secretN}`;
        secrets.push(s);
        return s;
      },
    },
    spawn: ((_cmd: string, _args: readonly string[], opts: { env: Record<string, string> }) => {
      const c = new FakeBridge(
        3000 + spawned.length,
        String(opts.env.WHATSAPP_BRIDGE_PORT),
        String(opts.env.WHATSAPP_BRIDGE_TOKEN),
      );
      spawned.push(c);
      return c.asChild();
    }) as unknown as BridgeLauncherDeps['spawn'],
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
    processQuery: {
      query: async () => null,
      kill: async (pid) => {
        killedPids.push(pid);
        const c = spawned.find((x) => x.pid === pid);
        c?.kill();
      },
    },
    killSync: (pid) => {
      killedPids.push(pid);
      const c = spawned.find((x) => x.pid === pid);
      c?.kill();
    },
    random,
  });
  supervisor.register(launcher.childSpec());
  return { launcher, supervisor, paths, killedPids, secrets };
}

/** Awaits `p` while pushing the virtual clock forward so the readiness poll can run. */
async function settle(p: Promise<unknown>, rounds = 80): Promise<void> {
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
    if (i % 4 === 3) await flush();
  }
  await watched;
  await p;
}

const livePids = (): number[] => spawned.filter((c) => c.exitCode === null).map((c) => c.pid);

beforeEach(() => {
  portState.next = 0;
});
afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('process-lifecycle-4', () => {
  it('control: a supervised restart keeps exactly one live bridge', async () => {
    const { supervisor } = build();
    await settle(supervisor.start('bridge'));
    expect(livePids()).toHaveLength(1);
    await settle(supervisor.restart('bridge'));
    expect(livePids()).toHaveLength(1);
    expect(spawned).toHaveLength(2);
  });

  it('compose bridgeControl.restartForNewCode leaves TWO live bridges, one untracked', async () => {
    const { launcher, supervisor, paths, secrets } = build();

    // compose().start() -> startBridge() -> supervisor.start('bridge')
    await settle(supervisor.start('bridge'));
    expect(livePids()).toEqual([3000]);
    const pidFile1 = JSON.parse(readFileSync(join(paths.runDir, 'bridge.pid.json'), 'utf8')) as { pid: number };
    expect(pidFile1.pid).toBe(3000);

    // ---- compose.ts:977-981, verbatim ----
    // 1) await stopBridge()
    await settle(supervisor.stop('bridge'));
    await settle(launcher.stop());
    expect(livePids()).toEqual([]);

    // 2) await launcher.restartForNewCode()
    await settle(launcher.restartForNewCode());
    expect(livePids()).toEqual([3001]); // an UNSUPERVISED child is now live

    // 3) await startBridge() -> supervisor.start('bridge')
    await settle(supervisor.start('bridge'));

    // ---- the finding ----
    expect(spawned).toHaveLength(3);
    expect(livePids()).toEqual([3001, 3002]); // two bridge processes alive at once

    // 3001 is unreachable: the pid file names only 3002 ...
    const pidFile2 = JSON.parse(readFileSync(join(paths.runDir, 'bridge.pid.json'), 'utf8')) as { pid: number };
    expect(pidFile2.pid).toBe(3002);
    // ... and the launcher's own `child` reference was overwritten, so launcher.stop() cannot reach it either.
    await settle(launcher.stop());
    expect(livePids()).toEqual([3001]);

    // and 3001 still answers on its own port with its own token: a second live whatsmeow client.
    expect(liveOnPort(spawned[1]!.port)).toBe(spawned[1]);
    // the doorbell secret was rotated for 3002, so 3001's webhooks no longer match the live secret
    expect(secrets[secrets.length - 1]).not.toBe(secrets[1]);
  });

  it('killAllSync / stopAll cannot reach the orphan', async () => {
    const { launcher, supervisor, killedPids } = build();
    await settle(supervisor.start('bridge'));
    await settle(supervisor.stop('bridge'));
    await settle(launcher.stop());
    await settle(launcher.restartForNewCode());
    await settle(supervisor.start('bridge'));
    expect(livePids()).toEqual([3001, 3002]);

    supervisor.killAllSync();
    await flush();
    expect(killedPids).toEqual([3002]); // the orphan 3001 is never named
    expect(livePids()).toEqual([3001]);
  });

  it('the same happens for relink (and the store file really is deleted first)', async () => {
    const { launcher, supervisor, paths } = build();
    await settle(supervisor.start('bridge'));
    await settle(supervisor.stop('bridge'));
    await settle(launcher.stop());
    await settle(launcher.relink());
    expect(existsSync(paths.bridgeWhatsappDb)).toBe(false);
    await settle(supervisor.start('bridge'));
    expect(livePids()).toEqual([3001, 3002]);
  });
});
