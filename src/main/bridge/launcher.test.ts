// TESTS 5.3 row `bridge/launcher.ts, stdoutMarkers.ts, pairing.ts` + the launcher half of the W1-02 acceptance list:
// readiness contract, fresh port/token/secret per launch, the ARCHITECTURE 4.3 host state machine, the spawn-invariant refusal
// path (no spawn) and the `stdout_marker` security property (no marker ever changes state).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock.ts';
import { createPaths, type AppPaths } from '../paths';
import type { LogMeta, Logger, RandomSource } from '../deps';
import type { AuditKind } from '../../shared/types';
import { BRIDGE_STATUSES, type BridgeStatus, type PairingState } from '../../shared/health';
import type { ErrorCode } from '../../shared/errors';
import { BRIDGE_MARKERS, type BridgeMarker } from './stdoutMarkers';
import { BRIDGE_EXE } from './invariants';
import {
  BRIDGE_BACKOFF_MS,
  BRIDGE_BREAKER,
  BRIDGE_ENV_ALLOW_LIST,
  HEALTH_MISSES_BEFORE_RESPAWN,
  READINESS_POLL_MS,
  bridgeSpawnFs,
  DISCONNECTED_RESPAWN_MS,
  HEALTH_POLL_MS,
  MAX_LAUNCH_ATTEMPTS,
  READINESS_BUDGET_MS,
  bridgeStatusToErrorCode,
  createBridgeLauncher,
  resolveBridgeExe,
  type BridgeLauncherDeps,
} from './launcher';

const ports = vi.hoisted(() => ({ queue: [] as number[], asked: 0, exclude: [] as number[][] }));
vi.mock('../proc/freePort', () => ({
  NEVER_PORTS: [8080],
  freePort: (opts?: { exclude?: number[] }): Promise<number> => {
    ports.exclude.push(opts?.exclude ?? []);
    const next = ports.queue.shift() ?? 50_000 + ports.asked;
    ports.asked += 1;
    return Promise.resolve(next);
  },
}));

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
const DOORBELL_PORT = 51_234;
/** Lets every pending microtask AND the real I/O of the streamed exe hash settle before the next assertion. */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
/** setImmediate alone does not always deliver the fs completion of the streamed exe hash, so a real loop turn is mixed in. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await tick();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// fake child (S-SPAWN): an EventEmitter with pipe-able stdio, never a real process
// ---------------------------------------------------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(): boolean {
    if (this.exitCode !== null) return false;
    this.killed = true;
    setImmediate(() => this.exit(0));
    return true;
  }
  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }
  say(line: string): void {
    this.stdout.write(Buffer.from(`${line}\n`, 'utf8'));
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

interface FetchScript {
  fetch: BridgeLauncherDeps['fetch'];
  calls: Array<{ path: string; auth: string | null }>;
  pairingStatus: number;
  pairingBody: Record<string, unknown>;
  healthStatus: 200 | 503 | 401;
  networkDown: boolean;
}
function makeFetch(): FetchScript {
  const script: FetchScript = {
    calls: [],
    pairingStatus: 200,
    pairingBody: { status: 'connected' },
    healthStatus: 200,
    networkDown: false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      script.calls.push({ path: url.pathname, auth: headers.Authorization ?? null });
      if (script.networkDown) throw new TypeError('fetch failed');
      if (url.pathname === '/api/pairing/status') {
        if (script.pairingStatus !== 200) return new Response('Unauthorized\n', { status: script.pairingStatus });
        return new Response(JSON.stringify(script.pairingBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/api/health') {
        if (script.healthStatus === 401) return new Response('Unauthorized', { status: 401 });
        const body =
          script.healthStatus === 200
            ? { status: 'ok', connected: true, timestamp: 1 }
            : { status: 'disconnected', connected: false, timestamp: 1 };
        return new Response(JSON.stringify(body), {
          status: script.healthStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('no QR code available\n', { status: 404 });
    }) as BridgeLauncherDeps['fetch'],
  };
  return script;
}

interface Harness {
  deps: BridgeLauncherDeps;
  clock: VirtualClock;
  fetchScript: FetchScript;
  spawned: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>;
  children: FakeChild[];
  audits: Array<{ kind: AuditKind; detail: Record<string, unknown> }>;
  logs: Array<{ level: string; event: string; meta: LogMeta }>;
  paths: AppPaths;
  secrets: string[];
  root: string;
}

let harness: Harness;

function makeHarness(over: Partial<BridgeLauncherDeps> = {}, opts: { tokenBytes?: number } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'wca-launcher-'));
  const userData = join(root, 'userData');
  const resources = join(root, 'resources');
  mkdirSync(join(resources, 'bridge'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  const paths = createPaths({ userData, resourcesPath: resources, appRoot: join(root, 'app'), isPackaged: true });
  writeFileSync(paths.bridgeExe, 'dummy-bridge-exe');
  const expectedSha256 = createHash('sha256').update('dummy-bridge-exe').digest('hex');

  const clock = createVirtualClock(NOW);
  const fetchScript = makeFetch();
  const spawned: Harness['spawned'] = [];
  const children: FakeChild[] = [];
  const audits: Harness['audits'] = [];
  const logs: Harness['logs'] = [];
  const secrets: string[] = [];
  let secretCounter = 0;

  const record = (level: string) => (event: string, meta?: LogMeta) => {
    logs.push({ level, event, meta: meta ?? {} });
  };
  const log: Logger = { info: record('info'), warn: record('warn'), error: record('error'), child: () => log };

  let randCounter = 0;
  const random: RandomSource = {
    bytes: (n) => {
      randCounter += 1;
      return new Uint8Array(opts.tokenBytes ?? n).fill(randCounter);
    },
    int: () => 0,
    float: () => 0,
  };

  const deps: BridgeLauncherDeps = {
    paths,
    exePath: paths.bridgeExe,
    expectedSha256,
    tosAccepted: () => true,
    doorbell: {
      port: () => DOORBELL_PORT,
      rotateSecret: () => {
        secretCounter += 1;
        const secret = `${'S'.repeat(40)}${secretCounter}`;
        const url = `http://127.0.0.1:${DOORBELL_PORT}/hook/${secret}`;
        secrets.push(url);
        return url;
      },
    },
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options });
      const child = new FakeChild(2000 + children.length);
      children.push(child);
      return child.asChild();
    }) as BridgeLauncherDeps['spawn'],
    fetch: fetchScript.fetch,
    clock,
    random,
    log,
    audit: (kind, _ref, detail) => {
      audits.push({ kind, detail });
    },
    onMarker: vi.fn(),
    ...over,
  };
  return { deps, clock, fetchScript, spawned, children, audits, logs, paths, secrets, root };
}

beforeEach(() => {
  ports.queue = [];
  ports.asked = 0;
  ports.exclude = [];
  harness = makeHarness();
});
afterEach(() => {
  rmSync(harness.root, { recursive: true, force: true });
});

/** Drives the virtual clock (500 ms steps, the readiness poll interval) until the promise settles. */
async function runUntilSettled(h: Harness, p: Promise<void>, maxRounds = 300): Promise<void> {
  let settled = false;
  const watched = p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flush();
  for (let i = 0; i < maxRounds && !settled; i++) {
    await h.clock.advance(500);
    await tick();
    if (i % 10 === 9) await flush();
  }
  await watched;
  await p;
}

async function startOnline(h: Harness = harness): Promise<ReturnType<typeof createBridgeLauncher>> {
  const launcher = createBridgeLauncher(h.deps);
  await launcher.start();
  await flush();
  return launcher;
}

/**
 * Turns the event loop until `read()` returns `want`, then returns it; otherwise returns whatever it saw last so the
 * caller's `expect` reports the real value. Used where a stdout chunk (PassThrough) plus a child `exit` have to be
 * delivered before the assertion - under `--coverage` those take more than the two `flush()`es they take bare.
 * This waits for a settled state, it never makes an assertion pass that would otherwise fail.
 */
async function settleUntil<T>(read: () => T, want: T, rounds = 40): Promise<T> {
  for (let i = 0; i < rounds; i++) {
    if (read() === want) return want;
    await flush();
  }
  return read();
}

/**
 * The launcher awaits a REAL streamed SHA-256 of the exe before it spawns, so the child does not always exist by the
 * time the first `flush()` after `start()` returns. `h.children[0]?.say(...)` then silently does nothing and the test
 * asserts against a launcher that never saw the line. Wait for the child and assert it exists instead.
 */
async function firstChild(h: Harness, rounds = 40): Promise<FakeChild> {
  for (let i = 0; i < rounds && h.children.length === 0; i++) await flush();
  const child = h.children[0];
  expect(child, 'the launcher never spawned a child').toBeDefined();
  return child as FakeChild;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the spawn contract (ARCHITECTURE 4.2)', () => {
  it('spawns the pinned exe with NO args, cwd <userData>\\bridge, shell:false, windowsHide and piped stdio', async () => {
    const launcher = await startOnline();
    expect(harness.spawned).toHaveLength(1);
    const call = harness.spawned[0];
    expect(call?.command).toBe(harness.paths.bridgeExe);
    expect(call?.args).toEqual([]);
    expect(call?.options.cwd).toBe(harness.paths.bridgeCwd);
    expect(call?.options.shell).toBe(false);
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    await launcher.stop();
    await flush();
  });

  it('the env object has EXACTLY the allowed keys and never process.env wholesale', async () => {
    const launcher = await startOnline();
    const env = harness.spawned[0]?.options.env as Record<string, string>;
    for (const key of Object.keys(env)) expect(BRIDGE_ENV_ALLOW_LIST).toContain(key);
    expect(env.FORWARD_SELF).toBe('true');
    expect(env.WHATSAPP_MEDIA_ROOTS).toBe(harness.paths.bridgeOutboxDir);
    expect(env.WHATSAPP_BRIDGE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.WEBHOOK_URL).toBe(harness.secrets[0]);
    expect(Object.keys(env)).not.toContain('PATH');
    expect(Object.keys(env)).not.toContain('ANTHROPIC_API_KEY');
    await launcher.stop();
    await flush();
  });

  it('allocates a fresh port, token and doorbell secret on EVERY launch, and never the doorbell port', async () => {
    const launcher = await startOnline();
    const first = launcher.endpoint();
    await launcher.restartForNewCode();
    await flush();
    const second = launcher.endpoint();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.port).not.toBe(first?.port);
    expect(second?.token).not.toBe(first?.token);
    expect(harness.secrets[1]).not.toBe(harness.secrets[0]);
    for (const exclude of ports.exclude) expect(exclude).toContain(DOORBELL_PORT);
    await launcher.stop();
    await flush();
  });

  it('does nothing at all until the ToS disclosure is accepted', async () => {
    const h = makeHarness({ tosAccepted: () => false });
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    expect(h.spawned).toHaveLength(0);
    expect(launcher.status()).toBe('not_started');
    expect(launcher.endpoint()).toBeNull();
    rmSync(h.root, { recursive: true, force: true });
  });
});

describe('readiness (ARCHITECTURE 4.2 [R2])', () => {
  it('readiness is pairing/status answering 200 to OUR token', async () => {
    const launcher = await startOnline();
    const probe = harness.fetchScript.calls[0];
    expect(probe?.path).toBe('/api/pairing/status');
    expect(probe?.auth).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(launcher.endpoint()).not.toBeNull();
    expect(launcher.isOnline()).toBe(true);
    await launcher.stop();
    await flush();
  });

  it('the rest_starting stdout hint only starts the poll early - it is not the readiness signal', async () => {
    harness.fetchScript.networkDown = true;
    const launcher = createBridgeLauncher(harness.deps);
    const started = launcher.start();
    await flush();
    const before = harness.fetchScript.calls.length;
    harness.children[0]?.say('Starting REST API server on 127.0.0.1:50000...');
    await flush();
    expect(harness.fetchScript.calls.length).toBeGreaterThan(before);
    expect(launcher.status()).toBe('starting'); // a hint never makes the bridge ready
    harness.fetchScript.networkDown = false;
    for (let i = 0; i < 4; i++) {
      await harness.clock.advance(500);
      await flush();
    }
    await started;
    expect(launcher.isOnline()).toBe(true);
    await launcher.stop();
    await flush();
  });

  it('a listener that answers 401 never receives the token again: kill + new port, max 3 attempts', async () => {
    harness.fetchScript.pairingStatus = 401;
    ports.queue = [50_101, 50_102, 50_103];
    const launcher = createBridgeLauncher(harness.deps);
    await launcher.start();
    await flush();
    expect(harness.spawned).toHaveLength(MAX_LAUNCH_ATTEMPTS);
    // exactly ONE tokened request per port: after the 401 the port is abandoned
    expect(harness.fetchScript.calls.filter((c) => c.path === '/api/pairing/status')).toHaveLength(MAX_LAUNCH_ATTEMPTS);
    for (const child of harness.children) expect(child.killed).toBe(true);
    expect(launcher.status()).toBe('failed');
    expect(launcher.endpoint()).toBeNull();
  });

  it('no readiness inside the 10 s budget => kill + fresh port, max 3, then terminal', async () => {
    harness.fetchScript.networkDown = true;
    const launcher = createBridgeLauncher(harness.deps);
    await runUntilSettled(harness, launcher.start());
    expect(READINESS_BUDGET_MS).toBe(10_000);
    expect(harness.spawned).toHaveLength(MAX_LAUNCH_ATTEMPTS);
    expect(launcher.status()).toBe('failed');
  }, 30_000);

  it('a child that exits during readiness ends that attempt at once', async () => {
    harness.fetchScript.networkDown = true;
    const launcher = createBridgeLauncher(harness.deps);
    const started = launcher.start();
    await flush();
    for (let i = 0; i < 3 && harness.children.length <= MAX_LAUNCH_ATTEMPTS; i++) {
      harness.children[harness.children.length - 1]?.exit(0);
      await flush();
    }
    await runUntilSettled(harness, started);
    expect(harness.spawned).toHaveLength(MAX_LAUNCH_ATTEMPTS);
    expect(launcher.status()).toBe('failed');
  }, 30_000);
});

describe('spawn invariants: a violation means NO spawn', () => {
  interface Case {
    name: string;
    build(): Harness;
  }
  const cases: Case[] = [
    { name: 'cwd_outside_userdata', build: () => withPaths((p) => ({ ...p, userData: join(p.userData, 'other') })) },
    {
      name: 'outbox_outside_userdata',
      build: () => withPaths((p) => ({ ...p, bridgeOutboxDir: join(p.resourcesDir, 'outbox') })),
    },
    {
      name: 'exe_outside_resources',
      build: () => withPaths((p) => ({ ...p, resourcesDir: join(p.resourcesDir, 'deeper') })),
    },
    { name: 'exe_hash_mismatch', build: () => makeHarness({ expectedSha256: 'ab'.repeat(32) }) },
    { name: 'token_weak', build: () => makeHarness({}, { tokenBytes: 4 }) },
    {
      name: 'webhook_not_loopback',
      build: () =>
        makeHarness({
          doorbell: { port: () => DOORBELL_PORT, rotateSecret: () => `http://evil.example/hook/${'S'.repeat(40)}` },
        }),
    },
    {
      name: 'webhook_wrong_port',
      build: () =>
        makeHarness({
          doorbell: { port: () => DOORBELL_PORT, rotateSecret: () => `http://127.0.0.1:9/hook/${'S'.repeat(40)}` },
        }),
    },
    {
      name: 'webhook_no_secret',
      build: () =>
        makeHarness({
          doorbell: { port: () => DOORBELL_PORT, rotateSecret: () => `http://127.0.0.1:${DOORBELL_PORT}/hook/` },
        }),
    },
    {
      name: 'env_missing',
      build: () => makeHarness({ doorbell: { port: () => DOORBELL_PORT, rotateSecret: () => '' } }),
    },
  ];

  function withPaths(mutate: (p: AppPaths) => AppPaths): Harness {
    const base = makeHarness();
    base.deps = { ...base.deps, paths: mutate(base.paths) };
    return base;
  }

  for (const testCase of cases) {
    it(`${testCase.name}: refuses, audits spawn_refused and never calls spawn`, async () => {
      const h = testCase.build();
      const launcher = createBridgeLauncher(h.deps);
      await launcher.start();
      await flush();
      expect(h.spawned).toHaveLength(0);
      expect(launcher.status()).toBe('refused');
      const refusal = h.audits.find((a) => a.kind === 'spawn_refused');
      expect(refusal).toBeDefined();
      expect(String(refusal?.detail.violations)).toContain(testCase.name);
      rmSync(h.root, { recursive: true, force: true });
    });
  }

  it('port_8080 and port_invalid are refused before any spawn', async () => {
    for (const badPort of [8080, 0]) {
      ports.queue = [badPort];
      const h = makeHarness();
      const launcher = createBridgeLauncher(h.deps);
      await launcher.start();
      await flush();
      expect(h.spawned).toHaveLength(0);
      expect(launcher.status()).toBe('refused');
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('outbox_not_empty is refused before any spawn', async () => {
    const h = makeHarness();
    mkdirSync(h.paths.bridgeOutboxDir, { recursive: true });
    writeFileSync(join(h.paths.bridgeOutboxDir, 'leftover.bin'), 'x');
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    await flush();
    expect(h.spawned).toHaveLength(0);
    expect(String(h.audits[0]?.detail.violations)).toContain('outbox_not_empty');
    rmSync(h.root, { recursive: true, force: true });
  });

  it('a missing exe is a hash mismatch => BRIDGE_BINARY_BLOCKED, no spawn', async () => {
    const h = makeHarness();
    rmSync(h.paths.bridgeExe, { force: true });
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    await flush();
    expect(h.spawned).toHaveLength(0);
    expect(h.audits[0]?.detail.code).toBe('BRIDGE_BINARY_BLOCKED');
    rmSync(h.root, { recursive: true, force: true });
  });
  // env_extra, forward_self_not_true, outbox_missing, cwd_missing and args_not_empty cannot be reached through the
  // launcher's deps (it builds those fields itself); each has its own test in invariants.test.ts.
});

describe('the host state machine (ARCHITECTURE 4.3)', () => {
  it('qr_pending => needs_pairing, and connected-after-QR audits `paired`', async () => {
    harness.fetchScript.pairingBody = { status: 'qr_pending', qr_present: true };
    const launcher = createBridgeLauncher(harness.deps);
    const seen: BridgeStatus[] = [];
    launcher.onStatus((s) => seen.push(s));
    const pairings: PairingState[] = [];
    launcher.onPairing((p) => pairings.push(p));
    await launcher.start();
    await flush();
    expect(launcher.status()).toBe('needs_pairing');
    expect(launcher.pairing().status).toBe('qr_pending');

    harness.fetchScript.pairingBody = { status: 'connected' };
    await harness.clock.advance(2_000);
    await flush();
    expect(launcher.status()).toBe('online');
    expect(harness.audits.filter((a) => a.kind === 'pairing' && a.detail.event === 'paired')).toHaveLength(1);
    expect(seen).toContain('needs_pairing');
    expect(pairings.map((p) => p.status)).toEqual(['qr_pending', 'connected']);
    await launcher.stop();
    await flush();
  });

  it('logged_out comes ONLY from pairing/status and stops the bridge', async () => {
    const launcher = await startOnline();
    harness.fetchScript.pairingBody = {
      status: 'error',
      message: 'Device was logged out -- restart the bridge to pair again',
    };
    await harness.clock.advance(20_000);
    await flush();
    await flush();
    expect(launcher.status()).toBe('logged_out');
    expect(harness.children[0]?.killed).toBe(true);
    expect(harness.audits.some((a) => a.kind === 'pairing' && a.detail.event === 'logged_out')).toBe(true);
  });

  it('503 => reconnecting, and 10 minutes of 503 => respawn', async () => {
    const launcher = await startOnline();
    harness.fetchScript.healthStatus = 503;
    await harness.clock.advance(HEALTH_POLL_MS);
    await flush();
    expect(launcher.status()).toBe('reconnecting');
    expect(harness.spawned).toHaveLength(1); // the bridge self-heals first

    for (let i = 0; i < DISCONNECTED_RESPAWN_MS / HEALTH_POLL_MS + 1; i++) {
      await harness.clock.advance(HEALTH_POLL_MS);
      await flush();
    }
    expect(harness.spawned.length).toBeGreaterThan(1);
    await launcher.stop();
    await flush();
  });

  it('health coming back 200 returns the bridge to online', async () => {
    const launcher = await startOnline();
    harness.fetchScript.healthStatus = 503;
    await harness.clock.advance(HEALTH_POLL_MS);
    await flush();
    expect(launcher.status()).toBe('reconnecting');
    harness.fetchScript.healthStatus = 200;
    await harness.clock.advance(HEALTH_POLL_MS);
    await flush();
    expect(launcher.status()).toBe('online');
    await launcher.stop();
    await flush();
  });

  it('any exit while not stopping is a crash: backoff respawn with a fresh port and token', async () => {
    const launcher = await startOnline();
    const before = launcher.endpoint();
    harness.children[0]?.exit(0); // the bridge ALWAYS exits with code 0
    await flush();
    expect(launcher.status()).toBe('backoff');
    await harness.clock.advance((BRIDGE_BACKOFF_MS[0] ?? 2_000) * 2);
    await flush();
    expect(harness.spawned).toHaveLength(2);
    expect(launcher.endpoint()?.port).not.toBe(before?.port);
    await launcher.stop();
    await flush();
  });

  it('the breaker opens after 5 exits in 10 minutes => failed, BRIDGE_CRASH_LOOP territory', async () => {
    const launcher = await startOnline();
    for (let i = 0; i < BRIDGE_BREAKER.maxExits; i++) {
      harness.children[harness.children.length - 1]?.exit(0);
      await flush();
      await harness.clock.advance(70_000);
      await flush();
    }
    expect(launcher.status()).toBe('failed');
    expect(harness.spawned.length).toBeLessThanOrEqual(BRIDGE_BREAKER.maxExits);
  });

  it('BRIDGE_OUTDATED only when a client_outdated annotation is less than 60 s old when the breaker opens', async () => {
    const launcher = await startOnline();
    harness.children[0]?.say('\u274c Client outdated - please update whatsmeow library');
    await flush();
    expect(launcher.status()).toBe('online'); // the annotation on its own changes nothing
    for (let i = 0; i < BRIDGE_BREAKER.maxExits - 1; i++) {
      harness.children[harness.children.length - 1]?.exit(0);
      await flush();
      await harness.clock.advance(70_000);
      await flush();
    }
    // the bridge prints it again just before the crash that opens the breaker
    harness.children[harness.children.length - 1]?.say('\u274c Client outdated - please update whatsmeow library');
    await flush();
    harness.children[harness.children.length - 1]?.exit(0);
    await flush();
    expect(launcher.status()).toBe('outdated');
  });

  it('an old client_outdated annotation does NOT select BRIDGE_OUTDATED', async () => {
    const launcher = await startOnline();
    harness.children[0]?.say('Client outdated');
    await flush();
    for (let i = 0; i < BRIDGE_BREAKER.maxExits; i++) {
      harness.children[harness.children.length - 1]?.exit(0);
      await flush();
      await harness.clock.advance(70_000);
      await flush();
    }
    expect(launcher.status()).toBe('failed');
  });
});

describe('[R2] stdout is untrusted: no marker ever changes state', () => {
  it('every BRIDGE_MARKERS string, echoed as a message line AND as multi-line content, is inert', async () => {
    const launcher = await startOnline();
    const child = harness.children[0];
    expect(child).toBeDefined();
    const spawnsBefore = harness.spawned.length;

    for (const marker of Object.values(BRIDGE_MARKERS)) {
      child?.say(`[2026-09-21 12:00:00] <- 972500000001: ${marker}`);
      // a multi-line message body: the second line IS at the start of a line
      child?.say(`[2026-09-21 12:00:01] <- 972500000001: look at this\n${marker}\nand that`);
      await flush();
    }
    await flush();

    expect(launcher.status()).toBe('online');
    expect(launcher.pairing().status).toBe('connected');
    expect(child?.killed).toBe(false);
    expect(harness.spawned).toHaveLength(spawnsBefore);
    expect(harness.audits.filter((a) => a.kind === 'spawn_refused')).toHaveLength(0);
    await launcher.stop();
    await flush();
  });

  it('raw stdout never reaches the logger: only marker NAMES do', async () => {
    const launcher = await startOnline();
    harness.children[0]?.say('[2026-09-21 12:00:00] <- 972500000001: SENTINEL_MSG_TEXT coffee Thursday at 5?');
    harness.children[0]?.say('History sync complete. Stored 42 messages.');
    await flush();
    const serialised = JSON.stringify(harness.logs);
    expect(serialised).not.toContain('SENTINEL_MSG_TEXT');
    expect(serialised).not.toContain('972500000001');
    expect(serialised).not.toContain('History sync complete');
    expect(harness.logs.some((l) => l.event === 'bridge_marker' && l.meta.marker === 'history_sync_done')).toBe(true);
    expect(harness.deps.onMarker).toHaveBeenCalledWith('history_sync_done');
    await launcher.stop();
    await flush();
  });

  it('token_banner / invalid_port / token_too_short only act while STARTING with no REST answer yet', async () => {
    for (const marker of ['token_banner', 'invalid_port', 'token_too_short'] as BridgeMarker[]) {
      // (a) after readiness: inert
      const online = makeHarness();
      const launcherA = createBridgeLauncher(online.deps);
      await launcherA.start();
      await flush();
      online.children[0]?.say(BRIDGE_MARKERS[marker]);
      await flush();
      expect(launcherA.status()).toBe('online');
      expect(online.audits.filter((a) => a.kind === 'spawn_refused')).toHaveLength(0);
      await launcherA.stop();
      await flush();
      rmSync(online.root, { recursive: true, force: true });

      // (b) before readiness: audit + stop
      const h = makeHarness();
      h.fetchScript.networkDown = true;
      const launcherB = createBridgeLauncher(h.deps);
      const started = launcherB.start();
      await flush();
      (await firstChild(h)).say(BRIDGE_MARKERS[marker]);
      expect(await settleUntil(() => launcherB.status(), 'refused')).toBe('refused');
      expect(h.audits.some((a) => a.kind === 'spawn_refused' && a.detail.marker === marker)).toBe(true);
      for (let i = 0; i < 4; i++) {
        await h.clock.advance(5_000);
        await flush();
      }
      await started;
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it('a stdout chunk split mid-UTF-8 and mid-line is reassembled before matching', async () => {
    const launcher = await startOnline();
    const child = harness.children[0];
    const line = Buffer.from('History sync complete. Stored 3 messages. \u05e9\u05dc\u05d5\u05dd\n', 'utf8');
    child?.stdout.write(line.subarray(0, 10));
    await flush();
    expect(harness.deps.onMarker).not.toHaveBeenCalledWith('history_sync_done');
    child?.stdout.write(line.subarray(10, line.length - 3));
    await flush();
    child?.stdout.write(line.subarray(line.length - 3));
    await flush();
    expect(harness.deps.onMarker).toHaveBeenCalledWith('history_sync_done');
    await launcher.stop();
    await flush();
  });
});

describe('store maintenance', () => {
  it('relink deletes ONLY store\\whatsapp.db and restarts', async () => {
    const launcher = await startOnline();
    mkdirSync(harness.paths.bridgeStoreDir, { recursive: true });
    writeFileSync(harness.paths.bridgeWhatsappDb, 'session');
    writeFileSync(harness.paths.bridgeMessagesDb, 'messages');
    mkdirSync(join(harness.paths.bridgeStoreDir, '972550000001@s.whatsapp.net'), { recursive: true });

    await launcher.relink();
    await flush();
    expect(existsSync(harness.paths.bridgeWhatsappDb)).toBe(false);
    expect(existsSync(harness.paths.bridgeMessagesDb)).toBe(true);
    expect(existsSync(join(harness.paths.bridgeStoreDir, '972550000001@s.whatsapp.net'))).toBe(true);
    expect(harness.audits.some((a) => a.kind === 'relink')).toBe(true);
    expect(harness.spawned).toHaveLength(2);
    await launcher.stop();
    await flush();
  });

  it('unlinkAndWipe removes the whole store and refuses a path outside userData', async () => {
    const launcher = await startOnline();
    mkdirSync(harness.paths.bridgeStoreDir, { recursive: true });
    writeFileSync(harness.paths.bridgeMessagesDb, 'messages');
    await launcher.unlinkAndWipe();
    await flush();
    expect(existsSync(harness.paths.bridgeStoreDir)).toBe(false);
    expect(harness.audits.some((a) => a.kind === 'wipe')).toBe(true);
    await launcher.stop();
    await flush();

    const rogue = makeHarness({ storeDir: join(tmpdir(), 'not-under-userdata-store') });
    const rogueLauncher = createBridgeLauncher(rogue.deps);
    await rogueLauncher.start();
    await flush();
    await expect(rogueLauncher.unlinkAndWipe()).rejects.toThrow(/outside userData/);
    rmSync(rogue.root, { recursive: true, force: true });
  });

  it('relink honours an injected storeDir and still touches only whatsapp.db inside it', async () => {
    const h = makeHarness();
    const custom = join(h.root, 'custom-store');
    h.deps = { ...h.deps, storeDir: custom };
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, 'whatsapp.db'), 'session');
    writeFileSync(join(custom, 'messages.db'), 'messages');
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    await flush();
    await launcher.relink();
    await flush();
    expect(existsSync(join(custom, 'whatsapp.db'))).toBe(false);
    expect(existsSync(join(custom, 'messages.db'))).toBe(true);
    await launcher.stop();
    await flush();
    rmSync(h.root, { recursive: true, force: true });
  });
});

describe('the supervisor seam', () => {
  it('childSpec() carries the CONTRACTS 13 numbers and a live terminal() flag', async () => {
    const launcher = createBridgeLauncher(harness.deps);
    const spec = launcher.childSpec();
    expect(spec.name).toBe('bridge');
    expect(spec.backoffMs).toEqual(BRIDGE_BACKOFF_MS);
    expect(spec.breaker).toEqual({ maxExits: 5, windowMs: 10 * 60_000 });
    expect(spec.stableAfterMs).toBe(60_000);
    expect(spec.probeIntervalMs).toBe(HEALTH_POLL_MS);
    expect(spec.probeMisses).toBe(3);
    expect(spec.terminal?.()).toBe(false);

    const handle = await spec.start(1);
    expect(handle.exePath).toBe(harness.paths.bridgeExe);
    expect(handle.pid).toBe(harness.children[0]?.pid);
    await expect(spec.probe?.()).resolves.toBe(true);
    harness.fetchScript.networkDown = true;
    await expect(spec.probe?.()).resolves.toBe(false);
    harness.fetchScript.networkDown = false;

    const exits: unknown[] = [];
    handle.onExit((info) => exits.push(info));
    handle.kill();
    await flush();
    expect(exits).toEqual([{ code: 0, signal: null }]);
    // once supervised, the launcher does NOT respawn on its own
    await harness.clock.advance(120_000);
    await flush();
    expect(harness.spawned).toHaveLength(1);
    expect(launcher.status()).toBe('backoff');
  });

  it('[repair] the compose restart sequence leaves exactly ONE live child, never an untracked orphan', async () => {
    // compose.ts bridgeControl: stopBridge() -> launcher.restartForNewCode() -> startBridge() (supervisor.start).
    // restartForNewCode used to call launchLoop() itself, so the supervisor's spawn was the SECOND process and the
    // first one lost its only reference: no pid file, unreachable by killAllSync() and by the reaper.
    const launcher = createBridgeLauncher(harness.deps);
    const spec = launcher.childSpec();
    await spec.start(1); // the supervisor owns this launcher from here on
    await flush();
    expect(harness.spawned).toHaveLength(1);

    await launcher.stop(); // compose's stopBridge()
    await flush();
    await launcher.restartForNewCode(); // must mutate state only
    await flush();
    expect(harness.spawned).toHaveLength(1);

    await spec.start(1); // compose's startBridge()
    await flush();
    expect(harness.spawned).toHaveLength(2);
    expect(harness.children.filter((c) => c.exitCode === null)).toHaveLength(1);
    expect(harness.audits.some((a) => a.kind === 'pairing' && a.detail.event === 'new_code')).toBe(true);
    await launcher.stop();
    await flush();
  });

  it('[repair] relink and unlinkAndWipe do their store work and still leave the restart to the supervisor', async () => {
    const launcher = createBridgeLauncher(harness.deps);
    const spec = launcher.childSpec();
    await spec.start(1);
    await flush();
    const sessionDb = join(harness.paths.userData, 'bridge', 'store', 'whatsapp.db');
    mkdirSync(join(harness.paths.userData, 'bridge', 'store'), { recursive: true });
    writeFileSync(sessionDb, 'session');

    await launcher.relink();
    await flush();
    expect(existsSync(sessionDb)).toBe(false); // the device session really is gone
    expect(harness.spawned).toHaveLength(1);

    await launcher.unlinkAndWipe();
    await flush();
    expect(existsSync(join(harness.paths.userData, 'bridge', 'store'))).toBe(false);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.children.filter((c) => c.exitCode === null)).toHaveLength(0);
  });
});

describe('resolveBridgeExe', () => {
  it('production resolves the pinned exe with no args', () => {
    expect(resolveBridgeExe({ bridgeExe: 'c:/res/bridge/whatsapp-bridge.exe', e2e: false })).toEqual({
      exePath: 'c:/res/bridge/whatsapp-bridge.exe',
      exeArgs: [],
      expectedSha256: BRIDGE_EXE.sha256,
    });
  });

  it('e2e mode NEVER resolves a path ending in whatsapp-bridge.exe, whatever the env says', () => {
    expect(resolveBridgeExe({ bridgeExe: 'c:/res/bridge/whatsapp-bridge.exe', e2e: true })).toBeNull();
    const seam = resolveBridgeExe({
      bridgeExe: 'c:/res/bridge/whatsapp-bridge.exe',
      e2e: true,
      seamBridgeCmd: {
        command: 'c:/node/node.exe',
        args: ['c:/repo/tests/fakes/fake-bridge.ts'],
        sha256: 'AB'.repeat(32),
      },
    });
    expect(seam?.exePath).toBe('c:/node/node.exe');
    expect(seam?.exePath.endsWith('whatsapp-bridge.exe')).toBe(false);
    expect(seam?.expectedSha256).toBe('ab'.repeat(32));
    const noPin = resolveBridgeExe({
      bridgeExe: 'x',
      e2e: true,
      seamBridgeCmd: { command: 'c:/node/node.exe', args: [] },
    });
    expect(noPin?.expectedSha256).toBe('');
  });
});

describe('edge cases the failure paths depend on', () => {
  it('the S-FS probes answer false for anything that is not a real, readable directory', () => {
    expect(bridgeSpawnFs.existsDir(join(harness.root, 'nope'))).toBe(false);
    expect(bridgeSpawnFs.existsDir(harness.paths.bridgeExe)).toBe(false);
    expect(bridgeSpawnFs.isEmptyDir(join(harness.root, 'nope'))).toBe(false);
    expect(bridgeSpawnFs.isEmptyDir(harness.root)).toBe(false);
  });

  it('a health probe that answers 401 means a foreign listener: respawn, never keep talking to it', async () => {
    const launcher = await startOnline();
    harness.fetchScript.pairingStatus = 401; // the whole listener is now foreign
    harness.fetchScript.healthStatus = 401;
    await harness.clock.advance(HEALTH_POLL_MS);
    await flush();
    expect(harness.logs.some((l) => l.event === 'bridge_respawn' && l.meta.reason === 'foreign_listener')).toBe(true);
    await launcher.stop();
    await flush();
  });

  it('three consecutive unanswered probes respawn the child', async () => {
    const launcher = await startOnline();
    harness.fetchScript.networkDown = true;
    for (let i = 0; i < HEALTH_MISSES_BEFORE_RESPAWN; i++) {
      await harness.clock.advance(HEALTH_POLL_MS);
      await flush();
    }
    expect(harness.logs.some((l) => l.event === 'bridge_respawn' && l.meta.reason === 'probe_dead')).toBe(true);
    expect(launcher.status()).not.toBe('online');
    harness.fetchScript.networkDown = false;
    await launcher.stop();
    await flush();
  });

  it('a stdout chunk without a newline is buffered, and an absurd one is dropped rather than grown', async () => {
    const launcher = await startOnline();
    const child = harness.children[0];
    child?.stdout.write(Buffer.from('History sync comp', 'utf8'));
    await flush();
    expect(harness.deps.onMarker).not.toHaveBeenCalledWith('history_sync_done');
    child?.stdout.write(Buffer.from(`${'x'.repeat(70_000)}`, 'utf8')); // over MAX_STDOUT_TAIL: the tail is dropped
    await flush();
    child?.stdout.write(Buffer.from('lete. Stored 1 messages.\n', 'utf8'));
    await flush();
    expect(harness.deps.onMarker).not.toHaveBeenCalledWith('history_sync_done');
    child?.say('History sync complete. Stored 1 messages.');
    await flush();
    expect(harness.deps.onMarker).toHaveBeenCalledWith('history_sync_done');
    await launcher.stop();
    await flush();
  });

  it('stderr is scanned for markers exactly like stdout', async () => {
    const launcher = await startOnline();
    harness.children[0]?.stderr.write(Buffer.from('Scan this QR code with your WhatsApp app:\n', 'utf8'));
    await flush();
    expect(harness.deps.onMarker).toHaveBeenCalledWith('qr_phase');
    await launcher.stop();
    await flush();
  });

  it('a child that ignores kill() is abandoned after the grace period', async () => {
    const launcher = await startOnline();
    const child = harness.children[0];
    if (child) child.kill = (): boolean => true; // pretends to accept the signal and never exits
    const stopped = launcher.stop();
    await flush();
    await harness.clock.advance(5_000);
    await flush();
    await stopped;
    expect(launcher.status()).toBe('stopped');
  });

  it('a spawn that throws is treated as a failed attempt, not a crash', async () => {
    const h = makeHarness({
      spawn: (() => {
        throw new Error('EPERM');
      }) as BridgeLauncherDeps['spawn'],
    });
    const launcher = createBridgeLauncher(h.deps);
    await runUntilSettled(h, launcher.start());
    expect(launcher.status()).toBe('failed');
    rmSync(h.root, { recursive: true, force: true });
  });

  it('a readiness probe that answers something other than 200/401/403 keeps polling', async () => {
    harness.fetchScript.pairingStatus = 502;
    const launcher = createBridgeLauncher(harness.deps);
    const started = launcher.start();
    await flush();
    await harness.clock.advance(READINESS_POLL_MS);
    await flush();
    const probes = harness.fetchScript.calls.filter((c) => c.path === '/api/pairing/status').length;
    expect(probes).toBeGreaterThan(1);
    harness.fetchScript.pairingStatus = 200;
    await runUntilSettled(harness, started);
    expect(launcher.isOnline()).toBe(true);
    await launcher.stop();
    await flush();
  });

  it('start() while the bridge is already running is a no-op', async () => {
    const launcher = await startOnline();
    await launcher.start();
    await flush();
    expect(harness.spawned).toHaveLength(1);
    await launcher.stop();
    await flush();
  });

  it('a stale child from an abandoned attempt cannot drive the state machine', async () => {
    harness.fetchScript.pairingStatus = 401;
    const launcher = createBridgeLauncher(harness.deps);
    await launcher.start();
    await flush();
    const spawnsAfterFailure = harness.spawned.length;
    harness.children[0]?.emit('exit', 0, null); // the first, long-abandoned child reports in late
    await flush();
    expect(harness.spawned).toHaveLength(spawnsAfterFailure);
    expect(launcher.status()).toBe('failed');
  });

  it('the exit window forgets crashes older than 10 minutes, so the breaker never opens on a slow drip', async () => {
    const launcher = await startOnline();
    for (let i = 0; i < 7; i++) {
      harness.children[harness.children.length - 1]?.exit(0);
      await flush();
      await harness.clock.advance(BRIDGE_BREAKER.windowMs + 5_000);
      await flush();
    }
    expect(launcher.status()).not.toBe('failed');
    expect(launcher.status()).not.toBe('outdated');
    await launcher.stop();
    await flush();
  });

  it('restartForNewCode audits the pairing event and takes a fresh secret', async () => {
    const launcher = await startOnline();
    await launcher.restartForNewCode();
    await flush();
    expect(harness.audits.some((a) => a.kind === 'pairing' && a.detail.event === 'new_code')).toBe(true);
    expect(harness.secrets).toHaveLength(2);
    await launcher.stop();
    await flush();
  });
});

describe('stop / listeners', () => {
  /**
   * Regression, data-integrity-2: `setStatus` / `onPairingState` fanned out with a bare `for (const cb of [...cbs]) cb(next)`,
   * so ONE throwing subscriber skipped every subscriber registered after it and tore the exception out through whatever
   * triggered the transition. compose registers `healthHub.setBridge` / `healthHub.setPairing` and the renderer emit LAST, so a
   * throw upstream (e.g. the `resolveLidChats` subscriber hitting a SQLite abort) left the health model and the UI stale while
   * the health tick mislabelled the bridge 'reconnecting' and the pairing poll logged `pairing_poll_failed{reason:'other'}`.
   * A subscriber is an observer: its failure is its own, and it may not decide what the other observers get to see.
   */
  it('one throwing status subscriber never skips the others, and the throw does not escape the transition', async () => {
    const launcher = await startOnline();
    const later: BridgeStatus[] = [];
    launcher.onStatus(() => {
      throw new Error('subscriber blew up');
    });
    launcher.onStatus((s) => later.push(s));
    await launcher.stop();
    await flush();
    expect(launcher.status()).toBe('stopped');
    expect(later).toContain('stopped');
    expect(harness.logs.some((l) => l.event === 'bridge_status_listener_failed' && l.meta.reason === 'Error')).toBe(
      true,
    );
    // the guard logs the error NAME only - a subscriber message can carry attacker-influenced text ([R2])
    expect(JSON.stringify(harness.logs)).not.toContain('subscriber blew up');
  });

  it('one throwing pairing subscriber never skips the others', async () => {
    harness.fetchScript.pairingBody = { status: 'qr_pending', qr_present: true };
    const launcher = createBridgeLauncher(harness.deps);
    const later: PairingState[] = [];
    launcher.onPairing(() => {
      throw new Error('pairing subscriber blew up');
    });
    launcher.onPairing((p) => later.push(p));
    await launcher.start();
    await flush();
    expect(later.map((p) => p.status)).toContain('qr_pending');
    expect(launcher.pairing().status).toBe('qr_pending');
    expect(harness.logs.some((l) => l.event === 'bridge_pairing_listener_failed' && l.meta.reason === 'Error')).toBe(
      true,
    );
    await launcher.stop();
    await flush();
  });

  it('stop() is idempotent, clears the endpoint and unsubscribes cleanly', async () => {
    const launcher = await startOnline();
    const seen: BridgeStatus[] = [];
    const off = launcher.onStatus((s) => seen.push(s));
    const offPairing = launcher.onPairing(() => undefined);
    off();
    offPairing();
    await launcher.stop();
    await flush();
    await launcher.stop();
    await flush();
    expect(launcher.status()).toBe('stopped');
    expect(launcher.endpoint()).toBeNull();
    expect(launcher.isOnline()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('start() after a terminal failure resets the breaker (the user\'s "Try again")', async () => {
    harness.fetchScript.pairingStatus = 401;
    const launcher = createBridgeLauncher(harness.deps);
    await launcher.start();
    await flush();
    expect(launcher.status()).toBe('failed');
    harness.fetchScript.pairingStatus = 200;
    await launcher.start();
    await flush();
    expect(launcher.isOnline()).toBe(true);
    await launcher.stop();
    await flush();
  });
});

describe('[FIX] the BridgeStatus -> ErrorCode surface W2-01 composes against', () => {
  it('maps every BridgeStatus exactly once, and only the error states produce a code', () => {
    const table: Record<BridgeStatus, ErrorCode | null> = {
      not_started: 'WA_TOS_REQUIRED',
      stopped: null,
      starting: null,
      needs_pairing: null,
      online: null,
      reconnecting: 'WA_OFFLINE',
      backoff: 'WA_OFFLINE',
      logged_out: 'WA_LOGGED_OUT',
      outdated: 'BRIDGE_OUTDATED',
      refused: 'BRIDGE_SPAWN_REFUSED',
      failed: 'BRIDGE_CRASH_LOOP',
    };
    // BRIDGE_STATUSES is the frozen list; a new status added to CONTRACTS fails this test rather than mapping to null.
    for (const status of BRIDGE_STATUSES) {
      expect(bridgeStatusToErrorCode(status)).toBe(table[status]);
    }
    expect(Object.keys(table).sort()).toEqual([...BRIDGE_STATUSES].sort());
  });

  it('refused carries the recorded refusal code, defaulting to BRIDGE_SPAWN_REFUSED', () => {
    expect(bridgeStatusToErrorCode('refused', 'BRIDGE_BINARY_BLOCKED')).toBe('BRIDGE_BINARY_BLOCKED');
    expect(bridgeStatusToErrorCode('refused', null)).toBe('BRIDGE_SPAWN_REFUSED');
    // A refusal code recorded earlier never leaks onto a non-refused status.
    expect(bridgeStatusToErrorCode('online', 'BRIDGE_BINARY_BLOCKED')).toBeNull();
    expect(bridgeStatusToErrorCode('failed', 'BRIDGE_BINARY_BLOCKED')).toBe('BRIDGE_CRASH_LOOP');
  });

  it('a hash mismatch is BRIDGE_BINARY_BLOCKED on the launcher, without reading audit rows', async () => {
    const h = makeHarness({ expectedSha256: 'ab'.repeat(32) });
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    await flush();
    expect(launcher.status()).toBe('refused');
    expect(launcher.lastRefusalCode()).toBe('BRIDGE_BINARY_BLOCKED');
    expect(launcher.errorCode()).toBe('BRIDGE_BINARY_BLOCKED');
    // and it agrees with the audit row compose would otherwise have had to dig up
    expect(h.audits.find((a) => a.kind === 'spawn_refused')?.detail.code).toBe('BRIDGE_BINARY_BLOCKED');
    rmSync(h.root, { recursive: true, force: true });
  });

  it('any other invariant violation is BRIDGE_SPAWN_REFUSED', async () => {
    const h = makeHarness({}, { tokenBytes: 4 }); // token_weak
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    await flush();
    expect(launcher.status()).toBe('refused');
    expect(launcher.errorCode()).toBe('BRIDGE_SPAWN_REFUSED');
    rmSync(h.root, { recursive: true, force: true });
  });

  it('a startup-refusal marker before readiness is BRIDGE_SPAWN_REFUSED and audits the code', async () => {
    const h = makeHarness();
    h.fetchScript.networkDown = true; // no REST answer yet => the marker window is open
    const launcher = createBridgeLauncher(h.deps);
    const started = launcher.start();
    await flush();
    (await firstChild(h)).say(BRIDGE_MARKERS.token_too_short);
    expect(await settleUntil(() => launcher.status(), 'refused')).toBe('refused');
    expect(launcher.lastRefusalCode()).toBe('BRIDGE_SPAWN_REFUSED');
    expect(launcher.errorCode()).toBe('BRIDGE_SPAWN_REFUSED');
    const row = h.audits.find((a) => a.kind === 'spawn_refused' && a.detail.marker === 'token_too_short');
    expect(row?.detail.code).toBe('BRIDGE_SPAWN_REFUSED');
    for (let i = 0; i < 4; i++) {
      await h.clock.advance(5_000);
      await flush();
    }
    await started;
    rmSync(h.root, { recursive: true, force: true });
  });

  it('an online launcher has no error code, and a fresh start() clears an earlier refusal', async () => {
    const h = makeHarness({ expectedSha256: 'ab'.repeat(32) });
    const launcher = createBridgeLauncher(h.deps);
    await launcher.start();
    await flush();
    expect(launcher.lastRefusalCode()).toBe('BRIDGE_BINARY_BLOCKED');

    // the user fixes the install and presses "Try again"
    h.deps = { ...h.deps, expectedSha256: createHash('sha256').update('dummy-bridge-exe').digest('hex') };
    const fixed = createBridgeLauncher(h.deps);
    await fixed.start();
    await flush();
    expect(fixed.status()).toBe('online');
    expect(fixed.lastRefusalCode()).toBeNull();
    expect(fixed.errorCode()).toBeNull();
    await fixed.stop();
    await flush();
    expect(fixed.errorCode()).toBeNull(); // 'stopped' is user-driven, not an error
    rmSync(h.root, { recursive: true, force: true });
  });

  it('the breaker opening with a fresh client_outdated annotation reports BRIDGE_OUTDATED', async () => {
    const launcher = await startOnline();
    for (let i = 0; i < BRIDGE_BREAKER.maxExits - 1; i++) {
      harness.children[harness.children.length - 1]?.exit(0);
      await flush();
      await harness.clock.advance(70_000);
      await flush();
    }
    harness.children[harness.children.length - 1]?.say('\u274c Client outdated - please update whatsmeow library');
    await flush();
    harness.children[harness.children.length - 1]?.exit(0);
    await flush();
    expect(launcher.errorCode()).toBe('BRIDGE_OUTDATED');
  });
});
