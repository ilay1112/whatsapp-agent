// tests/security/bridge-invariants.test.ts - gate item 8 of TESTS 8.2 (invariant I6) + the [R2] hostile pid-file cases
// of the reaper. Owner: W2-02.
//
// Everything runs against the REAL `bridge/invariants.ts`, the REAL `bridge/launcher.ts` and the REAL `proc/reaper.ts`.
// The exe is always a DUMMY fixture file written into a temp dir - never `whatsapp-bridge.exe` (rules T1 / T2), and the
// S-SPAWN seam is a spy that records instead of starting anything.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BRIDGE_ENV_KEYS,
  BRIDGE_EXE,
  FORBIDDEN_BRIDGE_ARGS,
  OS_ENV_PASSTHROUGH,
  SPAWN_VIOLATIONS,
  SpawnInvariantError,
  assertBridgeSpawnInvariants,
  errorCodeForViolations,
  isPathInside,
  sha256OfFile,
  type BridgeSpawnPlan,
  type SpawnInvariantFs,
  type SpawnViolation,
} from '../../src/main/bridge/invariants.ts';
import { BRIDGE_ENV_ALLOW_LIST, createBridgeLauncher } from '../../src/main/bridge/launcher.ts';
import {
  AGY_ENV_KEYS,
  CLAUDE_ENV_KEYS,
  CLAUDE_S3_ENV_KEYS,
  JOB_ENV_FORBIDDEN,
  WHISPER_ENV_KEYS,
  createJobRunner,
  envKeysAllowed,
  type JobSpec,
} from '../../src/main/proc/jobRunner.ts';
import { NEVER_PORTS, freePort } from '../../src/main/proc/freePort.ts';
import { buildWhisperEnv } from '../../src/main/voice/whisperCli.ts';
import { buildClaudeEnv } from '../../src/main/llm/cli/claudeCli.env.ts';
import { buildAgyEnv } from '../../src/main/llm/cli/antigravityCli.ts';
import { LLAMA_ENV_PASSTHROUGH, buildLlamaEnv } from '../../src/main/llm/local/llamaServer.ts';
import { parsePidFile, taskkillArgs } from '../../src/main/proc/supervisor.ts';
import { PS_QUERY_ARGS, reapOrphans } from '../../src/main/proc/reaper.ts';
import { createPaths } from '../../src/main/paths.ts';
import type { AuditKind, EpochMs } from '../../src/shared/types.ts';
import type { Logger, ProcessQuery, SpawnFn } from '../../src/main/deps.ts';
import { createSeededRandom, createVirtualClock } from '../helpers/virtualClock.ts';

// ---------------------------------------------------------------------------------------------------------------------
// shared scaffolding
// ---------------------------------------------------------------------------------------------------------------------
const tmpRoots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wca-inv-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

const VALID_TOKEN = 'a'.repeat(64);
const VALID_SECRET = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFC'; // 32 base64url chars

const fsAllGood: SpawnInvariantFs = { existsDir: () => true, isEmptyDir: () => true };

function basePlan(over: Partial<BridgeSpawnPlan> = {}): BridgeSpawnPlan {
  const userDataDir = 'C:\\Users\\tester\\AppData\\Roaming\\WhatsApp Calendar Agent';
  return {
    exePath: 'C:\\Program Files\\WCA\\resources\\bridge\\whatsapp-bridge.exe',
    args: [] as readonly [],
    cwd: join(userDataDir, 'bridge'),
    env: {
      WHATSAPP_BRIDGE_PORT: '39217',
      WHATSAPP_BRIDGE_TOKEN: VALID_TOKEN,
      WEBHOOK_URL: `http://127.0.0.1:41000/hook/${VALID_SECRET}`,
      FORWARD_SELF: 'true',
      WHATSAPP_MEDIA_ROOTS: join(userDataDir, 'bridge', 'outbox-empty'),
    } as BridgeSpawnPlan['env'],
    userDataDir,
    outboxDir: join(userDataDir, 'bridge', 'outbox-empty'),
    doorbellPort: 41_000,
    exeSha256: BRIDGE_EXE.sha256,
    tosAccepted: true,
    ...over,
  };
}

function violationsOf(plan: BridgeSpawnPlan, fs: SpawnInvariantFs = fsAllGood): SpawnViolation[] {
  try {
    assertBridgeSpawnInvariants(plan, fs, { resourcesDir: 'C:\\Program Files\\WCA\\resources' });
    return [];
  } catch (err) {
    if (err instanceof SpawnInvariantError) return err.violations;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. the invariant table (TESTS 5.3) - one mutation per violation
// ---------------------------------------------------------------------------------------------------------------------
describe('I6 - the spawn invariant table', () => {
  it('accepts the legitimate plan (the table is not refusing everything)', () => {
    expect(violationsOf(basePlan())).toEqual([]);
  });

  const CASES: Array<{ violation: SpawnViolation; plan: () => BridgeSpawnPlan; fs?: SpawnInvariantFs }> = [
    { violation: 'tos_not_accepted', plan: () => basePlan({ tosAccepted: false }) },
    { violation: 'cwd_outside_userdata', plan: () => basePlan({ cwd: 'C:\\Windows\\Temp\\bridge' }) },
    {
      violation: 'cwd_outside_userdata',
      plan: () => basePlan({ cwd: join(basePlan().userDataDir, '..', '..', 'bridge') }),
    },
    {
      violation: 'cwd_missing',
      plan: () => basePlan(),
      fs: { existsDir: (p) => !p.endsWith('bridge'), isEmptyDir: () => true },
    },
    {
      violation: 'env_missing',
      plan: () => {
        const p = basePlan();
        delete (p.env as unknown as Record<string, unknown>).FORWARD_SELF;
        return p;
      },
    },
    {
      violation: 'env_extra',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).PATH = 'C:\\evil';
        return p;
      },
    },
    {
      violation: 'port_8080',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WHATSAPP_BRIDGE_PORT = '8080';
        return p;
      },
    },
    {
      violation: 'port_invalid',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WHATSAPP_BRIDGE_PORT = '70000';
        return p;
      },
    },
    {
      violation: 'port_invalid',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WHATSAPP_BRIDGE_PORT = '4 1000';
        return p;
      },
    },
    {
      violation: 'token_weak',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WHATSAPP_BRIDGE_TOKEN = 'short';
        return p;
      },
    },
    {
      violation: 'token_weak',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WHATSAPP_BRIDGE_TOKEN = 'A'.repeat(64); // uppercase = not the hex of ARCH 4.2
        return p;
      },
    },
    {
      violation: 'webhook_not_loopback',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WEBHOOK_URL = `http://evil.example:41000/hook/${VALID_SECRET}`;
        return p;
      },
    },
    {
      violation: 'webhook_not_loopback',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WEBHOOK_URL = `http://localhost:41000/hook/${VALID_SECRET}`;
        return p;
      },
    },
    {
      violation: 'webhook_wrong_port',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WEBHOOK_URL = `http://127.0.0.1:41001/hook/${VALID_SECRET}`;
        return p;
      },
    },
    {
      violation: 'webhook_no_secret',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WEBHOOK_URL = 'http://127.0.0.1:41000/hook/short';
        return p;
      },
    },
    {
      violation: 'forward_self_not_true',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).FORWARD_SELF = 'TRUE';
        return p;
      },
    },
    {
      violation: 'outbox_missing',
      plan: () => basePlan(),
      fs: { existsDir: (p) => !p.includes('outbox'), isEmptyDir: () => true },
    },
    { violation: 'outbox_not_empty', plan: () => basePlan(), fs: { existsDir: () => true, isEmptyDir: () => false } },
    {
      violation: 'outbox_outside_userdata',
      plan: () => basePlan({ outboxDir: 'C:\\Users\\tester\\Pictures' }),
    },
    {
      violation: 'outbox_outside_userdata',
      plan: () => {
        const p = basePlan();
        (p.env as unknown as Record<string, string>).WHATSAPP_MEDIA_ROOTS = 'C:\\Users\\tester\\Documents';
        return p;
      },
    },
    { violation: 'exe_hash_mismatch', plan: () => basePlan({ exeSha256: 'f'.repeat(64) }) },
    { violation: 'exe_hash_mismatch', plan: () => basePlan({ exeSha256: '' }) },
    {
      violation: 'exe_outside_resources',
      plan: () => basePlan({ exePath: 'C:\\Users\\tester\\Downloads\\whatsapp-bridge.exe' }),
    },
    { violation: 'args_not_empty', plan: () => basePlan({ args: ['--debug'] as unknown as readonly [] }) },
    {
      violation: 'args_not_empty',
      plan: () => basePlan({ args: [...FORBIDDEN_BRIDGE_ARGS] as unknown as readonly [] }),
    },
  ];

  it.each(CASES.map((c, i) => [`${i}:${c.violation}`, c] as const))('%s is refused', (_label, testCase) => {
    const found = violationsOf(testCase.plan(), testCase.fs ?? fsAllGood);
    expect(found).toContain(testCase.violation);
  });

  it('covers every declared violation at least once', () => {
    const covered = new Set(CASES.map((c) => c.violation));
    expect([...SPAWN_VIOLATIONS].filter((v) => !covered.has(v))).toEqual([]);
  });

  it('reports every violation at once, in declaration order', () => {
    const plan = basePlan({ tosAccepted: false, exeSha256: 'f'.repeat(64), args: ['--x'] as unknown as readonly [] });
    const found = violationsOf(plan);
    expect(found).toEqual(['tos_not_accepted', 'exe_hash_mismatch', 'args_not_empty']);
  });

  it('maps a hash mismatch to BRIDGE_BINARY_BLOCKED and everything else to BRIDGE_SPAWN_REFUSED', () => {
    expect(errorCodeForViolations(['exe_hash_mismatch'])).toBe('BRIDGE_BINARY_BLOCKED');
    expect(errorCodeForViolations(['tos_not_accepted', 'exe_hash_mismatch'])).toBe('BRIDGE_BINARY_BLOCKED');
    expect(errorCodeForViolations(['port_8080'])).toBe('BRIDGE_SPAWN_REFUSED');
    expect(errorCodeForViolations([])).toBe('BRIDGE_SPAWN_REFUSED');
  });

  it('pins the exe identity of ARCH 4.1', () => {
    expect(BRIDGE_EXE).toEqual({
      fileName: 'whatsapp-bridge.exe',
      size: 43_540_541,
      sha256: 'ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5',
    });
  });

  it('treats a traversal segment as an escape even when it resolves back inside', () => {
    expect(isPathInside('C:\\a\\b', 'C:\\a')).toBe(true);
    expect(isPathInside('C:\\a', 'C:\\a')).toBe(true);
    expect(isPathInside('C:\\ab', 'C:\\a')).toBe(false);
    expect(violationsOf(basePlan({ cwd: `${basePlan().userDataDir}\\bridge\\..\\bridge` }))).toContain(
      'cwd_outside_userdata',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. end-to-end through the launcher with an S-SPAWN spy
// ---------------------------------------------------------------------------------------------------------------------
interface LauncherRig {
  spawns: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>;
  audits: Array<{ kind: AuditKind; detail: Record<string, unknown> }>;
  launcher: ReturnType<typeof createBridgeLauncher>;
  dispose: () => Promise<void>;
}

/** A dummy "bridge" file with a known hash - NEVER the real exe (T1). */
function writeDummyExe(dir: string, bytes: string): { path: string; sha256: string } {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'whatsapp-bridge.exe');
  writeFileSync(p, bytes, 'utf8');
  return { path: p, sha256: createHash('sha256').update(bytes, 'utf8').digest('hex') };
}

function makeLauncher(opts: {
  tosAccepted?: boolean;
  exeBytes?: string;
  /** Pin the launcher expects; default = the dummy's real hash (so the happy path passes). */
  expectedSha256?: string;
  /** Put the exe outside <resources> to trigger exe_outside_resources. */
  exeOutsideResources?: boolean;
  /** Leave a file in outbox-empty to trigger outbox_not_empty. */
  dirtyOutbox?: boolean;
  /** Do not create the bridge cwd, to trigger cwd_missing. */
  skipCwd?: boolean;
}): LauncherRig {
  const root = tempRoot();
  const userData = join(root, 'userData');
  const resourcesDir = join(root, 'resources');
  mkdirSync(userData, { recursive: true });
  const paths = createPaths({ userData, resourcesPath: resourcesDir, appRoot: root, isPackaged: true });
  mkdirSync(paths.runDir, { recursive: true });
  if (!opts.skipCwd) mkdirSync(paths.bridgeCwd, { recursive: true });
  mkdirSync(paths.bridgeOutboxDir, { recursive: true });
  if (opts.dirtyOutbox) writeFileSync(join(paths.bridgeOutboxDir, 'leftover.bin'), 'x', 'utf8');

  const exeDir = opts.exeOutsideResources ? join(userData, 'downloads') : join(resourcesDir, 'bridge');
  const exe = writeDummyExe(exeDir, opts.exeBytes ?? 'dummy-bridge-bytes');

  const spawns: LauncherRig['spawns'] = [];
  const spawn: SpawnFn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    spawns.push({ command, args: [...args], options });
    throw new Error('spy spawn: the launcher must not reach this point in a refusal test');
  }) as unknown as SpawnFn;

  const audits: LauncherRig['audits'] = [];
  const clock = createVirtualClock(Date.UTC(2026, 8, 23, 8, 0, 0));

  const launcher = createBridgeLauncher({
    paths,
    exePath: exe.path,
    expectedSha256: opts.expectedSha256 ?? exe.sha256,
    tosAccepted: () => opts.tosAccepted ?? true,
    doorbell: {
      port: () => 41_000,
      rotateSecret: () => `http://127.0.0.1:41000/hook/${VALID_SECRET}`,
    },
    spawn,
    fetch: (() => Promise.reject(new Error('no network in a refusal test'))) as never,
    clock,
    random: createSeededRandom(),
    log: silentLog,
    audit: (kind, _ref, detail) => {
      audits.push({ kind, detail: detail as Record<string, unknown> });
    },
    onMarker: () => undefined,
  });

  return {
    spawns,
    audits,
    launcher,
    dispose: async () => {
      await launcher.stop();
    },
  };
}

describe('I6 - a violating plan never reaches spawn()', () => {
  it.each([
    ['tos_not_accepted', { tosAccepted: false }, null],
    ['exe_hash_mismatch', { expectedSha256: 'f'.repeat(64) }, 'BRIDGE_BINARY_BLOCKED'],
    ['exe_outside_resources', { exeOutsideResources: true }, 'BRIDGE_SPAWN_REFUSED'],
    ['outbox_not_empty', { dirtyOutbox: true }, 'BRIDGE_SPAWN_REFUSED'],
    // `cwd_missing` is unreachable through the launcher on purpose: spawnOnce() creates `<userData>\bridge` itself
    // before the invariants run, so the violation can only be produced at the invariant level (covered above).
  ] as const)('%s: spawn is not called', async (label, opts, expectedCode) => {
    const rig = makeLauncher(opts as Parameters<typeof makeLauncher>[0]);
    try {
      await rig.launcher.start();
      expect(rig.spawns, `${label} must not spawn anything`).toEqual([]);
      if (expectedCode === null) {
        // The ToS gate short-circuits before the invariants even run: no refusal code, status stays not_started.
        expect(rig.launcher.status()).toBe('not_started');
        expect(rig.launcher.lastRefusalCode()).toBeNull();
        expect(rig.audits.filter((a) => a.kind === 'spawn_refused')).toEqual([]);
      } else {
        expect(rig.launcher.status()).toBe('refused');
        expect(rig.launcher.lastRefusalCode()).toBe(expectedCode);
        const refusals = rig.audits.filter((a) => a.kind === 'spawn_refused');
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.detail.code).toBe(expectedCode);
        expect(String(refusals[0]!.detail.violations).length).toBeGreaterThan(0);
      }
    } finally {
      await rig.dispose();
    }
  });

  it('never leaks the token or the webhook secret into an audit row', async () => {
    const rig = makeLauncher({ expectedSha256: 'f'.repeat(64) });
    try {
      await rig.launcher.start();
      const text = JSON.stringify(rig.audits);
      expect(text).not.toContain(VALID_SECRET);
      expect(text).not.toMatch(/[0-9a-f]{64}/); // no 32-byte hex token, no raw sha
    } finally {
      await rig.dispose();
    }
  });
});

describe('I6 - the successful spawn call itself', () => {
  it('passes shell:false, windowsHide:true, empty args and exactly the allowed env keys', async () => {
    const root = tempRoot();
    const userData = join(root, 'userData');
    const resourcesDir = join(root, 'resources');
    mkdirSync(userData, { recursive: true });
    const paths = createPaths({ userData, resourcesPath: resourcesDir, appRoot: root, isPackaged: true });
    mkdirSync(paths.bridgeCwd, { recursive: true });
    mkdirSync(paths.bridgeOutboxDir, { recursive: true });
    const exe = writeDummyExe(join(resourcesDir, 'bridge'), 'dummy-bridge-bytes');

    const spawns: LauncherRig['spawns'] = [];
    const clock = createVirtualClock(Date.UTC(2026, 8, 23, 8, 0, 0));
    /** A child that prints nothing and exits only when it is killed - enough for readiness and for a clean stop(). */
    const fakeChild = (): Record<string, unknown> => {
      const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
      const child: Record<string, unknown> = {
        pid: 4242,
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        exitCode: null,
        signalCode: null,
        once: (event: string, fn: (...a: unknown[]) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), fn]);
          return child;
        },
        off: (event: string, fn: (...a: unknown[]) => void) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((f) => f !== fn),
          );
          return child;
        },
        kill: () => {
          child.exitCode = 0;
          for (const fn of listeners.get('exit') ?? []) fn(0, null);
          listeners.delete('exit');
          return true;
        },
      };
      return child;
    };
    const spawn: SpawnFn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      spawns.push({ command, args: [...args], options });
      return fakeChild() as never;
    }) as unknown as SpawnFn;

    const launcher = createBridgeLauncher({
      paths,
      exePath: exe.path,
      expectedSha256: exe.sha256,
      tosAccepted: () => true,
      doorbell: { port: () => 41_000, rotateSecret: () => `http://127.0.0.1:41000/hook/${VALID_SECRET}` },
      spawn,
      fetch: (() => Promise.resolve(new Response('{"status":"connected"}', { status: 200 }))) as unknown as Parameters<
        typeof createBridgeLauncher
      >[0]['fetch'],
      clock,
      random: createSeededRandom(),
      log: silentLog,
      audit: () => undefined,
      onMarker: () => undefined,
    });

    try {
      await launcher.start();
      expect(spawns).toHaveLength(1);
      const call = spawns[0]!;
      expect(call.command).toBe(exe.path);
      expect(call.args).toEqual([]);
      expect(call.options.shell).toBe(false);
      expect(call.options.windowsHide).toBe(true);
      expect(call.options.cwd).toBe(paths.bridgeCwd);

      const env = call.options.env as Record<string, string>;
      const keys = Object.keys(env);
      // The 5 required keys are always present; the OS pass-through keys are optional but nothing else may appear.
      for (const required of BRIDGE_ENV_KEYS) expect(keys, required).toContain(required);
      expect(keys.filter((k) => !BRIDGE_ENV_ALLOW_LIST.includes(k))).toEqual([]);
      expect(keys.length).toBeLessThanOrEqual(BRIDGE_ENV_KEYS.length + OS_ENV_PASSTHROUGH.length);
      expect(env.FORWARD_SELF).toBe('true');
      expect(env.WEBHOOK_URL).toBe(`http://127.0.0.1:41000/hook/${VALID_SECRET}`);
      expect(env.WHATSAPP_BRIDGE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(Number(env.WHATSAPP_BRIDGE_PORT)).not.toBe(8080);
      expect(env.PATH).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      await launcher.stop();
    }
  });

  it('hashes the exe by streaming it (the 43 MB file is never read whole)', async () => {
    const root = tempRoot();
    const exe = writeDummyExe(join(root, 'bridge'), 'dummy-bridge-bytes');
    await expect(sha256OfFile(exe.path)).resolves.toBe(exe.sha256);
    await expect(sha256OfFile(join(root, 'bridge', 'missing.exe'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. [R2] the reaper's hostile pid files
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] reaper - a hostile pid file spawns nothing and kills nothing', () => {
  const OWN_RESOURCES = 'C:\\Program Files\\WCA\\resources';
  const EXEC_PATH = 'C:\\Program Files\\WCA\\WhatsApp Calendar Agent.exe';

  const HOSTILE: Array<[string, unknown]> = [
    ['string pid', { pid: '1 OR 1=1', exePath: `${OWN_RESOURCES}\\bridge\\whatsapp-bridge.exe`, startedAt: 1 }],
    ['injected pid', { pid: '4; taskkill /IM explorer.exe', exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1 }],
    ['negative pid', { pid: -1, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1 }],
    ['zero pid', { pid: 0, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1 }],
    ['pid above DWORD', { pid: 2 ** 31, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1 }],
    ['float pid', { pid: 4.5, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1 }],
    ['exe outside resources', { pid: 4242, exePath: 'C:\\Windows\\System32\\lsass.exe', startedAt: 1 }],
    [
      'exe in the reference tree',
      { pid: 4242, exePath: 'C:\\Users\\x\\whatsapp-mcp\\whatsapp-bridge.exe', startedAt: 1 },
    ],
    ['relative exe path', { pid: 4242, exePath: '..\\..\\Windows\\System32\\lsass.exe', startedAt: 1 }],
    ['NUL in exe path', { pid: 4242, exePath: `${OWN_RESOURCES}\\bridge\\x.exe\0.txt`, startedAt: 1 }],
    [
      'traversal out of resources',
      { pid: 4242, exePath: `${OWN_RESOURCES}\\..\\..\\Windows\\System32\\lsass.exe`, startedAt: 1 },
    ],
    ['missing startedAt', { pid: 4242, exePath: `${OWN_RESOURCES}\\bridge\\x.exe` }],
    ['startedAt zero', { pid: 4242, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 0 }],
    ['array payload', [{ pid: 4242, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1 }]],
    ['null payload', null],
  ];

  it.each(HOSTILE)('parsePidFile rejects %s', (_label, payload) => {
    expect(parsePidFile(JSON.stringify(payload), OWN_RESOURCES, EXEC_PATH)).toBeNull();
  });

  it('parsePidFile rejects malformed JSON', () => {
    expect(parsePidFile('{not json', OWN_RESOURCES, EXEC_PATH)).toBeNull();
    expect(parsePidFile('', OWN_RESOURCES, EXEC_PATH)).toBeNull();
  });

  it('parsePidFile accepts a legitimate file and the app exe itself', () => {
    const good = { pid: 4242, exePath: `${OWN_RESOURCES}\\bridge\\whatsapp-bridge.exe`, startedAt: 1_700_000_000_000 };
    expect(parsePidFile(JSON.stringify(good), OWN_RESOURCES, EXEC_PATH)).toEqual({
      pid: 4242,
      exePath: `${OWN_RESOURCES}\\bridge\\whatsapp-bridge.exe`,
      startedAt: 1_700_000_000_000,
    });
    const mcp = { pid: 77, exePath: EXEC_PATH, startedAt: 1_700_000_000_000 };
    expect(parsePidFile(JSON.stringify(mcp), OWN_RESOURCES, EXEC_PATH)?.pid).toBe(77);
  });

  it('reapOrphans neither queries nor kills for a rejected pid file', async () => {
    const root = tempRoot();
    const runDir = join(root, 'run');
    mkdirSync(runDir, { recursive: true });
    for (const [label, payload] of HOSTILE) {
      writeFileSync(join(runDir, `bridge.pid.json`), JSON.stringify(payload), 'utf8');
      const queried: number[] = [];
      const kills: number[] = [];
      const query: ProcessQuery = {
        query: (pid) => {
          queried.push(pid);
          return Promise.resolve(null);
        },
        kill: (pid) => {
          kills.push(pid);
          return Promise.resolve();
        },
      };
      const spawns: string[] = [];
      const result = await reapOrphans(runDir, OWN_RESOURCES, {
        processQuery: query,
        spawn: ((command: string) => {
          spawns.push(command);
          throw new Error('nothing may be spawned for a rejected pid file');
        }) as unknown as SpawnFn,
        execPath: EXEC_PATH,
      });
      expect(queried, label).toEqual([]);
      expect(kills, label).toEqual([]);
      expect(spawns, label).toEqual([]);
      expect(result.killed, label).toEqual([]);
      expect(result.stalePidFiles, label).toBe(1);
    }
  });

  it('reapOrphans ignores a pid file whose name is not a known child', async () => {
    const root = tempRoot();
    const runDir = join(root, 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'explorer.pid.json'),
      JSON.stringify({ pid: 4242, exePath: `${OWN_RESOURCES}\\bridge\\x.exe`, startedAt: 1_700_000_000_000 }),
      'utf8',
    );
    const queried: number[] = [];
    const result = await reapOrphans(runDir, OWN_RESOURCES, {
      processQuery: {
        query: (pid) => {
          queried.push(pid);
          return Promise.resolve(null);
        },
        kill: () => Promise.resolve(),
      },
      execPath: EXEC_PATH,
    });
    expect(queried).toEqual([]);
    expect(result.killed).toEqual([]);
  });

  it('kills only when the live process matches exe path AND creation date', async () => {
    const root = tempRoot();
    const runDir = join(root, 'run');
    mkdirSync(runDir, { recursive: true });
    const exePath = `${OWN_RESOURCES}\\bridge\\whatsapp-bridge.exe`;
    const startedAt = 1_700_000_000_000 as EpochMs;
    writeFileSync(join(runDir, 'bridge.pid.json'), JSON.stringify({ pid: 4242, exePath, startedAt }), 'utf8');

    const mismatched = await reapOrphans(runDir, OWN_RESOURCES, {
      processQuery: {
        query: () =>
          Promise.resolve({ pid: 4242, executablePath: 'C:\\Windows\\System32\\lsass.exe', creationDate: startedAt }),
        kill: () => Promise.reject(new Error('must not kill a foreign image')),
      },
      execPath: EXEC_PATH,
    });
    expect(mismatched.killed).toEqual([]);
    expect(mismatched.stalePidFiles).toBe(1);

    writeFileSync(join(runDir, 'bridge.pid.json'), JSON.stringify({ pid: 4242, exePath, startedAt }), 'utf8');
    const skewed = await reapOrphans(runDir, OWN_RESOURCES, {
      processQuery: {
        query: () =>
          Promise.resolve({ pid: 4242, executablePath: exePath, creationDate: (startedAt + 60_000) as EpochMs }),
        kill: () => Promise.reject(new Error('must not kill a re-used pid')),
      },
      execPath: EXEC_PATH,
    });
    expect(skewed.killed).toEqual([]);

    writeFileSync(join(runDir, 'bridge.pid.json'), JSON.stringify({ pid: 4242, exePath, startedAt }), 'utf8');
    const kills: Array<{ pid: number; tree: boolean }> = [];
    const matched = await reapOrphans(runDir, OWN_RESOURCES, {
      processQuery: {
        query: () =>
          Promise.resolve({ pid: 4242, executablePath: exePath, creationDate: (startedAt + 1_000) as EpochMs }),
        kill: (pid, tree) => {
          kills.push({ pid, tree });
          return Promise.resolve();
        },
      },
      execPath: EXEC_PATH,
    });
    expect(matched.killed).toEqual(['bridge']);
    expect(kills).toEqual([{ pid: 4242, tree: true }]);
  });

  it('never kills by image name and never interpolates a pid into a command string', () => {
    expect(taskkillArgs(4242, true)).toEqual(['/PID', '4242', '/T', '/F']);
    expect(taskkillArgs(4242, false)).toEqual(['/PID', '4242', '/F']);
    expect(taskkillArgs(4242, true).join(' ')).not.toMatch(/\/IM/);
    const command = PS_QUERY_ARGS.join(' ');
    expect(command).toContain('[int]$args[0]');
    expect(command).not.toMatch(/ProcessId=\d/); // the pid is never baked into the WQL filter
    expect(PS_QUERY_ARGS).toContain('-NoProfile');
    expect(PS_QUERY_ARGS).toContain('-NonInteractive');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] (owner V2-W2-02) T2 8.2 group 8 extensions: the job env allow-lists (B26; whisper = the llama list) asserted LITERALLY, the
// real env builders under a poisoned main-process env, the JobRunner refusing any other key set BEFORE spawn, and NEVER_PORTS for
// the tool server's port picker.
// ---------------------------------------------------------------------------------------------------------------------

/** A main-process env carrying every secret / redirect a job must never inherit (synthetic values, T5). */
const POISONED_ENV: Record<string, string> = {
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  TEMP: 'C:\\Temp',
  TMP: 'C:\\Temp',
  NUMBER_OF_PROCESSORS: '8',
  USERPROFILE: 'C:\\Users\\wca-fake-home',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\wca-fake-home',
  APPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Local',
  PATH: 'C:\\evil\\bin;C:\\Windows\\System32',
  ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-poison-0001',
  ANTHROPIC_AUTH_TOKEN: 'TESTONLY-poison-0002',
  ANTHROPIC_BASE_URL: 'https://evil.example.invalid',
  CLAUDE_CODE_OAUTH_TOKEN: 'TESTONLY-poison-0003',
  CLAUDE_CONFIG_DIR: 'C:\\evil\\claude',
  GEMINI_API_KEY: 'AIzaTESTONLY-poison-0004',
  GOOGLE_API_KEY: 'AIzaTESTONLY-poison-0005',
  HTTPS_PROXY: 'http://evil.example.invalid:3128',
  HTTP_PROXY: 'http://evil.example.invalid:3128',
  NODE_OPTIONS: '--require C:\\evil\\hook.js',
  ELECTRON_RUN_AS_NODE: 'TESTONLY-poison-run-as-node',
  WHATSAPP_BRIDGE_TOKEN: 'TESTONLY-poison-bridge-token',
  WHATSAPP_WEBHOOK_SECRET: 'TESTONLY-poison-doorbell',
  LLAMA_API_KEY: 'TESTONLY-poison-llama',
};
const POISON_VALUES = Object.entries(POISONED_ENV)
  .filter(([k]) => /KEY|TOKEN|URL|PROXY|SECRET|OPTIONS|CONFIG|RUN_AS/.test(k))
  .map(([, v]) => v);

describe('[V2] I6 / B26 - the job env allow-lists are literal and never inherit the main process env', () => {
  it('pins the four key sets literally (whisper = the llama list)', () => {
    expect([...CLAUDE_ENV_KEYS]).toEqual([
      'SystemRoot',
      'PATH',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'APPDATA',
      'LOCALAPPDATA',
      'MCP_TIMEOUT',
      'MCP_TOOL_TIMEOUT',
      'ENABLE_TOOL_SEARCH',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_TELEMETRY',
      'DISABLE_ERROR_REPORTING',
      'DISABLE_AUTOUPDATER',
      'DISABLE_BUG_COMMAND',
      'CI',
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'ENABLE_CLAUDEAI_MCP_SERVERS',
    ]);
    expect([...CLAUDE_S3_ENV_KEYS]).toEqual([...CLAUDE_ENV_KEYS, 'WCA_MCP_TOKEN']);
    expect([...AGY_ENV_KEYS]).toEqual([
      'SystemRoot',
      'PATH',
      'USERPROFILE',
      'HOME',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'AGY_CLI_DISABLE_AUTO_UPDATE',
    ]);
    expect([...WHISPER_ENV_KEYS]).toEqual(['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS']);
    expect([...WHISPER_ENV_KEYS]).toEqual([...LLAMA_ENV_PASSTHROUGH]);
    // no allow-list names a forbidden key, in any casing
    const forbidden = new Set(JOB_ENV_FORBIDDEN.map((k) => k.toLowerCase()));
    for (const k of [...CLAUDE_S3_ENV_KEYS, ...AGY_ENV_KEYS, ...WHISPER_ENV_KEYS])
      expect(forbidden.has(k.toLowerCase()), k).toBe(false);
    for (const k of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'HTTPS_PROXY',
      'NODE_OPTIONS',
    ])
      expect(JOB_ENV_FORBIDDEN).toContain(k);
  });

  it('the REAL builders produce exactly their key set from a poisoned env, and no poisoned value survives', () => {
    const whisper = buildWhisperEnv(POISONED_ENV);
    expect(Object.keys(whisper).sort()).toEqual([...WHISPER_ENV_KEYS].sort());
    const claude = buildClaudeEnv({ processEnv: POISONED_ENV, tempDir: 'C:\\run\\x', token: null });
    expect(Object.keys(claude).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    const claudeS3 = buildClaudeEnv({ processEnv: POISONED_ENV, tempDir: 'C:\\run\\x', token: 'TESTONLY-run-token' });
    expect(Object.keys(claudeS3).sort()).toEqual([...CLAUDE_S3_ENV_KEYS].sort());
    const agy = buildAgyEnv({ processEnv: POISONED_ENV, tempDir: 'C:\\run\\y', home: {} });
    expect(Object.keys(agy).sort()).toEqual([...AGY_ENV_KEYS].sort());
    for (const env of [whisper, claude, claudeS3, agy]) {
      const values = Object.values(env).join('\n');
      for (const v of POISON_VALUES) expect(values).not.toContain(v);
      // PATH is never inherited: it is System32 only (the poisoned PATH carries an attacker dir first)
      if ('PATH' in env) expect(env.PATH).toBe('C:\\Windows\\System32');
      expect(envKeysAllowed(env === whisper ? 'voice' : 'cli', env)).toBe('ok');
    }
    // the llama child gets the same pass-through list (+ its own key, which no job list may carry)
    const llama = buildLlamaEnv('TESTONLY-llama-key', POISONED_ENV);
    expect(Object.keys(llama).sort()).toEqual(['LLAMA_API_KEY', ...WHISPER_ENV_KEYS].sort());
    expect(
      Object.keys(llama)
        .filter((k) => k !== 'LLAMA_API_KEY')
        .sort(),
    ).toEqual(Object.keys(whisper).sort());
  });

  it("envKeysAllowed: one key more, one key less, another kind's list, or a forbidden key in any casing => refused", () => {
    const whisper = buildWhisperEnv(POISONED_ENV);
    expect(envKeysAllowed('voice', { ...whisper, PATH: 'x' })).toBe('env_keys');
    const { NUMBER_OF_PROCESSORS: _drop, ...less } = whisper;
    expect(envKeysAllowed('voice', less)).toBe('env_keys');
    const claude = buildClaudeEnv({ processEnv: POISONED_ENV, tempDir: 'C:\\run\\x', token: null });
    expect(envKeysAllowed('voice', claude)).toBe('env_keys');
    expect(envKeysAllowed('cli', whisper)).toBe('env_keys');
    for (const k of [
      'ANTHROPIC_API_KEY',
      'anthropic_base_url',
      'Claude_Config_Dir',
      'https_proxy',
      'Node_Options',
      'GEMINI_API_KEY',
    ]) {
      expect(envKeysAllowed('cli', { ...claude, [k]: 'x' }), k).toBe('env_forbidden');
      expect(envKeysAllowed('voice', { ...whisper, [k]: 'x' }), k).toBe('env_forbidden');
    }
  });

  it('the JobRunner refuses a spec with a non-allow-listed env BEFORE any spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wca-jobenv-'));
    try {
      const spawned: unknown[] = [];
      const runner = createJobRunner({
        runDir: dir,
        now: () => 0 as EpochMs,
        log: () => undefined,
        proc: {
          spawn: ((...a: unknown[]) => {
            spawned.push(a);
            throw new Error('must not spawn');
          }) as unknown as SpawnFn,
          killPid: async () => undefined,
          setPriority: () => undefined,
        },
      });
      const base = {
        exePath: join(dir, 'tool.exe'),
        args: [] as string[],
        cwd: dir,
        stdin: null,
        stdout: 'ignore' as const,
        wallClockMs: 1000,
        graceMs: 10,
        belowNormal: true,
      };
      const whisper = buildWhisperEnv(POISONED_ENV);
      const bad: Array<[JobSpec['kind'], Record<string, string>, string]> = [
        ['voice', { ...whisper, ANTHROPIC_API_KEY: 'x' }, 'env_forbidden'],
        ['voice', { ...POISONED_ENV }, 'env_forbidden'],
        ['voice', { ...whisper, PATH: 'C:\\evil' }, 'env_keys'],
        [
          'cli',
          { ...buildClaudeEnv({ processEnv: POISONED_ENV, tempDir: dir, token: null }), WHATSAPP_BRIDGE_TOKEN: 'x' },
          'env_forbidden',
        ],
        ['cli', { ...buildClaudeEnv({ processEnv: POISONED_ENV, tempDir: dir, token: null }), EXTRA: 'x' }, 'env_keys'],
      ];
      for (const [kind, env, reason] of bad) {
        await expect(
          runner.run({ ...base, kind, env }, async () => 'ran', new AbortController().signal),
          `${kind} ${reason}`,
        ).rejects.toMatchObject({ name: 'JobSpecError', reason });
      }
      expect(spawned).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[V2] NEVER_PORTS - the tool server never listens on the user's other bridge port", () => {
  it("NEVER_PORTS holds 8080 (the port of the user's own reference bridge)", () => {
    expect(NEVER_PORTS).toContain(8080);
  });

  it('freePort skips 8080 even when the OS hands it out repeatedly, and gives up instead of returning it', async () => {
    const seq = [8080, 8080, 8080, 41234];
    expect(await freePort({ listen: async () => seq.shift()! })).toBe(41234);
    await expect(freePort({ listen: async () => 8080, maxAttempts: 5 })).rejects.toThrow(/no usable loopback port/);
    const excluded = [8080, 50000, 50001];
    expect(await freePort({ exclude: [50000], listen: async () => excluded.shift()! })).toBe(50001);
  });

  it('the real ephemeral bind is loopback and never 8080 (50 binds)', async () => {
    for (let i = 0; i < 50; i += 1) {
      const p = await freePort();
      expect(p).not.toBe(8080);
      expect(p).toBeGreaterThan(0);
    }
  });
});
