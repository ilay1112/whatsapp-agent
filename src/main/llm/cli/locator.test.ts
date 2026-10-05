// src/main/llm/cli/locator.test.ts - T2 5 row `llm/cli/locator.ts` (owner V2-W1-06-claude-cli).
// S-LOCATE over mkdtemp layouts (never the real profile, T9); where.exe only as the last resort and only through the injected
// runWhere (never executed, T8); e2e seam = no disk probe at all; version parse table (F14); auth status parses ONLY loggedIn;
// the status service probes at most once per cacheMs (virtual clock).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_MIN_VERSION } from '../../../shared/types';
import { AGY_ENV_KEYS, CLAUDE_ENV_KEYS, type JobHandle, type JobRunner, type JobSpec } from '../../proc/jobRunner';
import type { CliRunResult, CliRunner, CliRunnerExt } from './runner';
import {
  cliStateOf,
  compareVersion,
  createCliLocator,
  createCliStatus,
  parseVersion,
  seamArgsPrefix,
  type CliLocation,
  type CliLocator,
} from './locator';

// ---------------------------------------------------------------------------------------------------------------------
describe('version parse table (F14)', () => {
  it.each<[string, string | null]>([
    ['2.1.258 (Claude Code)', '2.1.258'],
    ['2.1.248', '2.1.248'],
    ['  2.1.247 (Claude Code)\n', '2.1.247'],
    ['1.2.11', '1.2.11'],
    ['02.001.0300', '2.1.300'],
    ['Claude Code 2.1.258', null],
    ['garbage', null],
    ['', null],
  ])('parseVersion(%j) = %s', (input, want) => {
    expect(parseVersion(input)).toBe(want);
  });

  it.each<[string, string, -1 | 0 | 1]>([
    ['2.1.258', '2.1.248', 1],
    ['2.1.248', '2.1.248', 0],
    ['2.1.247', '2.1.248', -1],
    ['2.1.221', '2.1.248', -1],
    ['2.10.0', '2.9.99', 1],
    ['3.0.0', '2.1.259', 1],
    ['1.9.9', '2.0.0', -1],
    ['garbage', '2.1.248', -1],
    ['2.1.248', 'garbage', 1],
    ['x', 'y', 0],
  ])('compareVersion(%s, %s) = %i', (a, b, want) => {
    expect(compareVersion(a, b)).toBe(want);
  });

  it('cliStateOf table', () => {
    const loc = (version: string | null): CliLocation => ({
      provider: 'claude_cli',
      exePath: 'C:\\x\\claude.exe',
      version,
    });
    const min = CLI_MIN_VERSION.claude_cli;
    expect(cliStateOf(null, null, min)).toBe('not_installed');
    expect(cliStateOf(loc(null), true, min)).toBe('unknown');
    expect(cliStateOf(loc('2.1.247'), true, min)).toBe('too_old');
    expect(cliStateOf(loc('2.1.221'), true, min)).toBe('too_old');
    expect(cliStateOf(loc('2.1.258'), true, min)).toBe('ready');
    expect(cliStateOf(loc('2.1.248'), false, min)).toBe('not_signed_in');
    expect(cliStateOf(loc('2.1.258'), 'unknown', min)).toBe('unknown');
    expect(cliStateOf(loc('2.1.258'), null, min)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// scripted jobs for the probes
// ---------------------------------------------------------------------------------------------------------------------
function probeJobs(
  answer: (spec: JobSpec) => { lines: string[]; exitCode: number | null; stderrMarkers?: string[] } | Error,
): JobRunner & { specs: JobSpec[] } {
  const specs: JobSpec[] = [];
  return {
    specs,
    async run<T>(spec: JobSpec, use: (j: JobHandle) => Promise<T>): Promise<T> {
      specs.push(spec);
      const a = answer(spec);
      if (a instanceof Error) throw a;
      return use({
        pid: 1,
        lines: () => ({
          [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
              next: async () =>
                i < a.lines.length ? { value: a.lines[i++] as string, done: false } : { value: undefined, done: true },
            };
          },
        }),
        write: () => undefined,
        kill: () => undefined,
        done: Promise.resolve({
          exitCode: a.exitCode,
          killed: false,
          timedOut: false,
          stderrMarkers: a.stderrMarkers ?? [],
          ms: 1,
        }),
      });
    },
    breaker: () => ({ open: false, failures: 0, openedAt: null }),
    resetBreaker: () => undefined,
    killAll: async () => undefined,
    jobPids: () => ({ cli: [], voice: [] }),
  };
}
const versionAnswer =
  (v: string, auth: string | null = '{"loggedIn":true}') =>
  (spec: JobSpec) => {
    const tail = spec.args.slice(-3).join(' ');
    if (spec.args.at(-1) === '--version') return { lines: [`${v} (Claude Code)`], exitCode: 0 };
    if (tail === 'auth status --json') return { lines: auth === null ? [] : auth.split('\n'), exitCode: 1 };
    return { lines: [], exitCode: 0 };
  };

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-fake-home-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
const touch = (...parts: string[]): string => {
  const p = path.join(home, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'MZ');
  return p;
};
const statFile = vi.fn((p: string) => {
  try {
    return { isFile: fs.statSync(p).isFile() };
  } catch {
    return null;
  }
});
const envFor = (): Record<string, string> => ({
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  SystemRoot: 'C:\\Windows',
  TEMP: path.join(home, 'Temp'),
  ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-planted',
});
function mkLocator(
  over: Partial<Parameters<typeof createCliLocator>[0]> = {},
  jobs = probeJobs(versionAnswer('2.1.258')),
) {
  const runWhere = vi.fn(async (): Promise<string[]> => []);
  const locator = createCliLocator({
    statFile,
    env: envFor(),
    runWhere,
    settingsClaudeExePath: () => '',
    seam: null,
    jobs,
    userDataDir: path.join(home, 'wca-userData'),
    ...over,
  });
  return { locator, runWhere, jobs };
}

describe('createCliLocator - disk order (claude_cli)', () => {
  it('%USERPROFILE%\\.local\\bin\\claude.exe first; where.exe not consulted', async () => {
    const local = touch('.local', 'bin', 'claude.exe');
    touch('AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const { locator, runWhere, jobs } = mkLocator();
    expect(await locator.find('claude_cli')).toEqual({ provider: 'claude_cli', exePath: local, version: '2.1.258' });
    expect(runWhere).not.toHaveBeenCalled();
    const spec = jobs.specs[0]!;
    expect(spec.args).toEqual(['--version']);
    expect(spec.exePath).toBe(local);
    expect(spec.cwd).toBe(path.dirname(local));
    expect(Object.keys(spec.env).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(JSON.stringify(spec.env)).not.toContain('TESTONLY');
    expect(spec).toMatchObject({ kind: 'cli', stdin: null, stdout: 'ndjson', belowNormal: false });
  });

  it('the npm layout bin\\claude.exe second (never the claude.cmd next to it)', async () => {
    touch('AppData', 'Roaming', 'npm', 'claude.cmd');
    const npmExe = touch(
      'AppData',
      'Roaming',
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe',
    );
    const { locator, runWhere } = mkLocator();
    expect((await locator.find('claude_cli'))?.exePath).toBe(npmExe);
    expect(runWhere).not.toHaveBeenCalled();
  });

  it('where.exe last: .exe hits first; a .cmd hit maps to the npm exe beside it; nothing usable => null', async () => {
    const other = touch('Tools', 'claude.exe');
    const a = mkLocator();
    a.runWhere.mockResolvedValue([
      ' ' + path.join(home, 'missing', 'claude.exe'),
      'C:\\relative\\..\\claude.exe',
      other,
    ]);
    expect((await a.locator.find('claude_cli'))?.exePath).toBe(other);

    const cmdDir = path.join(home, 'NpmGlobal');
    const mapped = touch('NpmGlobal', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const b = mkLocator({ env: { USERPROFILE: path.join(home, 'nobody'), SystemRoot: 'C:\\Windows' } });
    b.runWhere.mockResolvedValue([path.join(cmdDir, 'claude.cmd'), path.join(home, 'x', 'claude.bat')]);
    expect((await b.locator.find('claude_cli'))?.exePath).toBe(mapped);

    const c = mkLocator({ env: {} });
    c.runWhere.mockResolvedValue([path.join(home, 'none', 'claude.cmd')]);
    expect(await c.locator.find('claude_cli')).toBeNull();
    const d = mkLocator({ env: {} });
    d.runWhere.mockRejectedValue(new Error('where failed'));
    expect(await d.locator.find('claude_cli')).toBeNull();
  });

  it('claudeExePath override: valid + present => used; invalid regex / missing file / .cmd => null (never another exe)', async () => {
    touch('.local', 'bin', 'claude.exe');
    const picked = touch('Picked', 'claude.exe');
    expect((await mkLocator({ settingsClaudeExePath: () => picked }).locator.find('claude_cli'))?.exePath).toBe(picked);
    expect(
      await mkLocator({ settingsClaudeExePath: () => path.join(home, 'gone', 'claude.exe') }).locator.find(
        'claude_cli',
      ),
    ).toBeNull();
    expect(
      await mkLocator({ settingsClaudeExePath: () => 'C:\\R&D\\claude.exe' }).locator.find('claude_cli'),
    ).toBeNull();
    const cmd = touch('Picked', 'claude.cmd');
    expect(await mkLocator({ settingsClaudeExePath: () => cmd }).locator.find('claude_cli')).toBeNull();
  });

  it('a throwing statFile is "not a file"; a version probe failure yields version null', async () => {
    const local = touch('.local', 'bin', 'claude.exe');
    const throwing = mkLocator({
      statFile: () => {
        throw new Error('EPERM');
      },
      env: { USERPROFILE: home },
    });
    expect(await throwing.locator.find('claude_cli')).toBeNull();
    const failing = mkLocator(
      {},
      probeJobs(() => new Error('breaker open')),
    );
    expect(await failing.locator.find('claude_cli')).toEqual({ provider: 'claude_cli', exePath: local, version: null });
  });
});

describe('createCliLocator - antigravity_cli', () => {
  it('%LOCALAPPDATA%\\agy\\bin\\agy.exe, then where agy .exe only; probe env = AGY list', async () => {
    const agy = touch('AppData', 'Local', 'agy', 'bin', 'agy.exe');
    const { locator, jobs } = mkLocator(
      {},
      probeJobs(() => ({ lines: ['1.2.11'], exitCode: 0 })),
    );
    expect(await locator.find('antigravity_cli')).toEqual({
      provider: 'antigravity_cli',
      exePath: agy,
      version: '1.2.11',
    });
    expect(Object.keys(jobs.specs[0]!.env).sort()).toEqual([...AGY_ENV_KEYS].sort());
    const other = touch('Bin', 'agy.exe');
    const w = mkLocator({ env: {} });
    w.runWhere.mockResolvedValue([path.join(home, 'Bin', 'agy.cmd'), other]);
    expect((await w.locator.find('antigravity_cli'))?.exePath).toBe(other);
  });

  it('agy signedIn: exit 0 => true; exit 1 + authentication required => false; else unknown', async () => {
    const answers = [
      { lines: ['{"usage":1}'], exitCode: 0 },
      { lines: ['Error: authentication required'], exitCode: 1 },
      { lines: ['boom'], exitCode: 1 },
      { lines: [], exitCode: 2 },
    ];
    const { locator, jobs } = mkLocator(
      {},
      probeJobs(() => answers.shift()!),
    );
    const sig = new AbortController().signal;
    expect(await locator.signedIn('antigravity_cli', 'C:\\x\\agy.exe', sig)).toBe(true);
    expect(jobs.specs[0]!.args).toEqual(['-p', '/usage', '--output-format', 'json']);
    expect(await locator.signedIn('antigravity_cli', 'C:\\x\\agy.exe', sig)).toBe(false);
    expect(await locator.signedIn('antigravity_cli', 'C:\\x\\agy.exe', sig)).toBe('unknown');
    expect(await locator.signedIn('antigravity_cli', 'C:\\x\\agy.exe', sig)).toBe('unknown');
  });

  it("[cli-sandbox-3, F3/B14/I6'] every agy probe runs under the ISOLATED <userData>\\agy-home profile, cwd = the app workspace, settings.json written first", async () => {
    const agy = touch('AppData', 'Local', 'agy', 'bin', 'agy.exe');
    const userData = path.join(home, 'wca-userData');
    const settingsFile = path.win32.join(userData, 'agy-home', '.gemini', 'antigravity-cli', 'settings.json');
    const workspace = path.win32.join(userData, 'agy-workspace');
    const seenAtSpawn: Array<{ settings: string | null; workspaceExists: boolean }> = [];
    const { locator, jobs } = mkLocator(
      {},
      probeJobs((spec) => {
        seenAtSpawn.push({
          settings: fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null,
          workspaceExists: fs.existsSync(workspace),
        });
        return spec.args.at(-1) === '--version' ? { lines: ['1.2.11'], exitCode: 0 } : { lines: ['{}'], exitCode: 0 };
      }),
    );
    expect((await locator.find('antigravity_cli'))?.version).toBe('1.2.11');
    expect(await locator.signedIn('antigravity_cli', agy, new AbortController().signal)).toBe(true);
    expect(jobs.specs.map((s) => s.args)).toEqual([['--version'], ['-p', '/usage', '--output-format', 'json']]);
    const real = envFor();
    for (const spec of jobs.specs) {
      expect(Object.keys(spec.env).sort()).toEqual([...AGY_ENV_KEYS].sort());
      expect(spec.env).toMatchObject({
        USERPROFILE: path.win32.join(userData, 'agy-home'),
        HOME: path.win32.join(userData, 'agy-home'),
        APPDATA: path.win32.join(userData, 'agy-home', 'AppData', 'Roaming'),
        LOCALAPPDATA: path.win32.join(userData, 'agy-home', 'AppData', 'Local'),
        TEMP: workspace,
        TMP: workspace,
      });
      // never the real profile, never the agy install folder
      for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'] as const)
        expect([real.USERPROFILE, real.APPDATA, real.LOCALAPPDATA]).not.toContain(spec.env[k]);
      expect(spec.cwd).toBe(workspace);
      expect(spec.cwd).not.toBe(path.dirname(agy));
    }
    for (const s of seenAtSpawn) {
      expect(s.workspaceExists).toBe(true);
      expect(JSON.parse(s.settings ?? 'null')).toEqual({ trustedWorkspaces: [workspace] });
    }
  });

  it('[cli-sandbox-3] the isolated profile cannot see a login (U-A7) => not signed in; the auth prompt is read from the stderr MARKER', async () => {
    const { locator } = mkLocator(
      {},
      probeJobs(() => ({ lines: [], exitCode: 1, stderrMarkers: ['auth_required'] })),
    );
    expect(await locator.signedIn('antigravity_cli', 'C:\\x\\agy.exe', new AbortController().signal)).toBe(false);
  });

  it('[cli-sandbox-3] without a userDataDir no agy job is ever spawned (fail closed): version null, signedIn unknown', async () => {
    touch('AppData', 'Local', 'agy', 'bin', 'agy.exe');
    const { locator, jobs } = mkLocator(
      { userDataDir: undefined },
      probeJobs(() => ({ lines: ['1.2.11'], exitCode: 0 })),
    );
    expect((await locator.find('antigravity_cli'))?.version).toBeNull();
    expect(await locator.signedIn('antigravity_cli', 'C:\\x\\agy.exe', new AbortController().signal)).toBe('unknown');
    expect(jobs.specs).toEqual([]);
  });
});

describe('[cli-sandbox-6, B31] the exe path is reported BEFORE the first job of find()', () => {
  it('onExeResolved(provider, exePath) runs before --version spawns, for both CLIs; nothing found => never called', async () => {
    const claude = touch('.local', 'bin', 'claude.exe');
    const agy = touch('AppData', 'Local', 'agy', 'bin', 'agy.exe');
    const order: string[] = [];
    const { locator } = mkLocator(
      { onExeResolved: (provider, exePath) => order.push(`record:${provider}:${exePath}`) },
      probeJobs((spec) => {
        order.push(`spawn:${spec.exePath}`);
        return { lines: ['2.1.258'], exitCode: 0 };
      }),
    );
    await locator.find('claude_cli');
    await locator.find('antigravity_cli');
    expect(order).toEqual([
      `record:claude_cli:${claude}`,
      `spawn:${claude}`,
      `record:antigravity_cli:${agy}`,
      `spawn:${agy}`,
    ]);
    const none = mkLocator({ env: {}, onExeResolved: () => order.push('never') });
    expect(await none.locator.find('claude_cli')).toBeNull();
    expect(order).not.toContain('never');
  });

  it('a throwing recorder fails closed: no job is spawned for that path', async () => {
    touch('.local', 'bin', 'claude.exe');
    const { locator, jobs } = mkLocator({
      onExeResolved: () => {
        throw new Error('db locked');
      },
    });
    await expect(locator.find('claude_cli')).rejects.toThrow('db locked');
    expect(jobs.specs).toEqual([]);
  });
});

describe('createCliLocator - e2e seam (T2 4.1): never probes the disk, never where.exe', () => {
  const seam = {
    claude_cli: {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\app\\tests\\fakes\\fake-claude-cli.mjs', '--fake-journal', 'j', '--fake-state', 's', '--fake-end'],
    },
    antigravity_cli: null,
  };
  it('returns the seam command (node.exe), prefixes the fake argv, and touches neither statFile nor runWhere', async () => {
    touch('.local', 'bin', 'claude.exe'); // the "user's" real exe exists - it must NOT be found
    statFile.mockClear();
    const { locator, runWhere, jobs } = mkLocator({ seam });
    const loc = await locator.find('claude_cli');
    expect(loc).toEqual({ provider: 'claude_cli', exePath: seam.claude_cli.command, version: '2.1.258' });
    expect(loc?.exePath).not.toMatch(/claude\.exe$|agy\.exe$/i);
    expect(statFile).not.toHaveBeenCalled();
    expect(runWhere).not.toHaveBeenCalled();
    expect(jobs.specs[0]!.args).toEqual([...seam.claude_cli.args, '--version']);
    expect(await locator.find('antigravity_cli')).toBeNull();
    expect(await mkLocator({ seam: { claude_cli: null } }).locator.find('claude_cli')).toBeNull();
  });

  it('seamArgsPrefix maps only the exact seam commands; an agy-only seam probes with the agy env', async () => {
    expect(seamArgsPrefix(null, 'x')).toEqual([]);
    expect(seamArgsPrefix(seam, seam.claude_cli.command)).toEqual(seam.claude_cli.args);
    expect(seamArgsPrefix(seam, 'C:\\other\\node.exe')).toEqual([]);
    const agySeam = {
      claude_cli: null,
      antigravity_cli: { command: 'C:\\n\\node.exe', args: ['fake-agy.mjs', '--fake-end'] },
    };
    const { locator, jobs } = mkLocator(
      { seam: agySeam },
      probeJobs(() => ({ lines: ['1.2.11'], exitCode: 0 })),
    );
    expect((await locator.find('antigravity_cli'))?.version).toBe('1.2.11');
    expect(Object.keys(jobs.specs[0]!.env).sort()).toEqual([...AGY_ENV_KEYS].sort());
  });
});

describe('claude signedIn: auth status --json, ONLY loggedIn', () => {
  it.each<[string | null, boolean | 'unknown']>([
    ['{"loggedIn":true,"email":"x@example.test","orgId":"o"}', true],
    ['{"loggedIn":false}', false],
    ['{"loggedIn":"yes"}', 'unknown'],
    ['[true]', 'unknown'],
    ['not json at all', 'unknown'],
    [null, 'unknown'],
  ])('%s => %s (exit code ignored)', async (out, want) => {
    const { locator, jobs } = mkLocator({}, probeJobs(versionAnswer('2.1.258', out)));
    expect(await locator.signedIn('claude_cli', 'C:\\x\\claude.exe', new AbortController().signal)).toBe(want);
    expect(jobs.specs[0]!.args).toEqual(['auth', 'status', '--json']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('createCliStatus - cached status (<= 1 probe per cacheMs)', () => {
  const runner: CliRunner = { run: vi.fn(), breakerOpen: () => false };
  const fakeLocator = (
    loc: CliLocation | null,
    signed: boolean | 'unknown' = true,
  ): CliLocator & { finds: number; auths: number } => {
    const l = {
      finds: 0,
      auths: 0,
      find: vi.fn(async () => {
        l.finds += 1;
        return loc;
      }),
      version: vi.fn(),
      signedIn: vi.fn(async () => {
        l.auths += 1;
        return signed;
      }),
    };
    return l;
  };
  const READY: CliLocation = { provider: 'claude_cli', exePath: 'C:\\x\\claude.exe', version: '2.1.258' };

  it('probes once per 60 s (virtual clock); invalidate() forces a new probe; concurrent gets share one probe', async () => {
    let now = 1_000_000;
    const loc = fakeLocator(READY);
    const svc = createCliStatus({ locator: loc, runner, clock: { now: () => now }, cacheMs: 60_000 });
    const [a, b] = await Promise.all([svc.get('claude_cli'), svc.get('claude_cli')]);
    expect(a).toEqual({
      provider: 'claude_cli',
      state: 'ready',
      version: '2.1.258',
      minVersion: '2.1.248',
      quota: null,
      lastTest: null,
      workspaceTrusted: null,
    });
    expect(b).toEqual(a);
    expect(loc.finds).toBe(1);
    now += 59_999;
    await svc.get('claude_cli');
    expect(loc.auths).toBe(1);
    now += 1;
    await svc.get('claude_cli');
    expect(loc.auths).toBe(2);
    svc.invalidate();
    await svc.get('claude_cli');
    expect(loc.auths).toBe(3);
  });

  it('too old / not installed never run the login probe; a throwing probe is unknown; records decorate the status', async () => {
    const old = fakeLocator({ ...READY, version: '2.1.221' });
    const s1 = createCliStatus({ locator: old, runner, clock: { now: () => 0 }, cacheMs: 60_000 });
    expect((await s1.get('claude_cli')).state).toBe('too_old');
    expect(old.auths).toBe(0);
    const none = fakeLocator(null);
    expect(
      (await createCliStatus({ locator: none, runner, clock: { now: () => 0 }, cacheMs: 1 }).get('claude_cli')).state,
    ).toBe('not_installed');
    const boom: CliLocator = {
      find: vi.fn(async () => READY),
      version: vi.fn(),
      signedIn: vi.fn(async () => Promise.reject(new Error('x'))),
    };
    expect(
      (await createCliStatus({ locator: boom, runner, clock: { now: () => 0 }, cacheMs: 1 }).get('claude_cli')).state,
    ).toBe('unknown');
    const boom2: CliLocator = {
      find: vi.fn(async () => Promise.reject(new Error('x'))),
      version: vi.fn(),
      signedIn: vi.fn(),
    };
    expect(
      (await createCliStatus({ locator: boom2, runner, clock: { now: () => 0 }, cacheMs: 1 }).get('claude_cli')).state,
    ).toBe('not_installed');

    const svc = createCliStatus({
      locator: fakeLocator(READY, false),
      runner,
      clock: { now: () => 5 },
      cacheMs: 60_000,
    });
    expect(svc.peek('claude_cli')).toBeNull();
    svc.recordTest('claude_cli', { ok: true, at: 4, ms: 1200 });
    svc.recordQuota('claude_cli', { resetsAt: 99, usingOverage: false });
    svc.recordWorkspaceTrusted(true);
    const st = await svc.get('claude_cli');
    expect(st).toMatchObject({
      state: 'not_signed_in',
      lastTest: { ok: true, at: 4, ms: 1200 },
      quota: { resetsAt: 99, usingOverage: false },
      workspaceTrusted: null,
    });
    expect(svc.peek('claude_cli')).toEqual(st);
    svc.recordQuota('claude_cli', null);
    expect(svc.peek('claude_cli')?.quota).toBeNull();
    const agy = createCliStatus({
      locator: fakeLocator({ provider: 'antigravity_cli', exePath: 'C:\\a\\agy.exe', version: '1.2.11' }),
      runner,
      clock: { now: () => 0 },
      cacheMs: 1,
    });
    agy.recordWorkspaceTrusted(true);
    expect((await agy.get('antigravity_cli')).workspaceTrusted).toBe(true);
  });
});

// [v2-closeout] e2e cli-connect (9): after cli:test invalidated the cache, the Connect card's follow-up cli:getStatus ran the locator
// probes (`--version`, `auth status`) as NEW CLI jobs while the app was quitting. Once `closed()` is true the service never probes:
// it answers the last known status (stale is fine on a closing window) or 'unknown', and the locator is not called at all.
describe('createCliStatus - closed (the quit sequence began)', () => {
  const runner: CliRunner = { run: vi.fn(), breakerOpen: () => false };
  const READY: CliLocation = { provider: 'claude_cli', exePath: 'C:/x/claude.exe', version: '2.1.258' };
  it('never probes once closed: last known status (even after invalidate) or unknown', async () => {
    let closed = false;
    const loc: CliLocator = { find: vi.fn(async () => READY), version: vi.fn(), signedIn: vi.fn(async () => true) };
    const svc = createCliStatus({
      locator: loc,
      runner,
      clock: { now: () => 0 },
      cacheMs: 60_000,
      closed: () => closed,
    });
    expect((await svc.get('claude_cli')).state).toBe('ready');
    expect(loc.find).toHaveBeenCalledTimes(1);
    closed = true;
    svc.invalidate(); // cli:test / providerFactory.invalidate() on the quit path
    expect((await svc.get('claude_cli')).state).toBe('ready');
    expect(await svc.get('antigravity_cli')).toMatchObject({
      provider: 'antigravity_cli',
      state: 'unknown',
      version: null,
    });
    expect(loc.find).toHaveBeenCalledTimes(1);
    expect(loc.signedIn).toHaveBeenCalledTimes(1);
  });
});

// [D-080] `claude auth status --json` kept saying loggedIn:true while every run failed with "OAuth session expired and could not be
// refreshed": a RUN that ends in not_logged_in is the stronger evidence. The status flips to not_signed_in at once (cache or not) and
// stays so until a run / test proves the sign-in again. The sign-in session state rides on the same status object.
describe('[D-080] createCliStatus - a run that proved "not signed in" wins over the cached probe', () => {
  type Listener = Parameters<CliRunnerExt['onRunEnd']>[0];
  const READY: CliLocation = { provider: 'claude_cli', exePath: 'C:\\x\\claude.exe', version: '2.1.258' };
  const mkRunner = (): { runner: CliRunner & Pick<CliRunnerExt, 'onRunEnd'>; fire: Listener } => {
    const listeners = new Set<Listener>();
    return {
      runner: {
        run: vi.fn(),
        breakerOpen: () => false,
        onRunEnd: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
      },
      fire: (provider, res) => {
        for (const l of listeners) l(provider, res);
      },
    };
  };
  const res = (error: CliRunResult['error'], initOk: boolean): CliRunResult => ({
    sandbox: { initOk, toolsCount: 0, mcpServers: 0, apiKeySource: initOk ? 'none' : 'unknown', mismatch: null },
    structured: null,
    text: null,
    toolCalls: 0,
    blockedCalls: 0,
    stopReason: error === null ? 'end' : 'bad_output',
    error,
    quota: null,
    usage: null,
    ms: 1,
  });

  it('not_logged_in flips a cached "ready" at once; it survives invalidate() and re-probes; a passed run or test clears it', async () => {
    const { runner, fire } = mkRunner();
    const loc: CliLocator = { find: vi.fn(async () => READY), version: vi.fn(), signedIn: vi.fn(async () => true) };
    const svc = createCliStatus({ locator: loc, runner, clock: { now: () => 0 }, cacheMs: 60_000 });
    expect((await svc.get('claude_cli')).state).toBe('ready');
    fire('claude_cli', res('not_logged_in', true));
    expect(svc.peek('claude_cli')?.state).toBe('not_signed_in'); // no new probe needed
    expect((await svc.get('claude_cli')).state).toBe('not_signed_in');
    svc.invalidate();
    expect((await svc.get('claude_cli')).state).toBe('not_signed_in'); // the probe still says loggedIn:true - the run wins
    // the other CLI is untouched
    expect((await svc.get('antigravity_cli')).state).toBe('ready');
    // runs that prove nothing about the sign-in keep it
    for (const e of ['network', 'sandbox', 'model_rejected', 'not_ready', 'aborted'] as const) {
      fire('claude_cli', res(e, false));
      expect(svc.peek('claude_cli')?.state, e).toBe('not_signed_in');
    }
    fire('claude_cli', res('usage_limit', false)); // a budget refusal (no spawn, no proof) proves nothing
    expect(svc.peek('claude_cli')?.state).toBe('not_signed_in');
    fire('claude_cli', res(null, true));
    expect(svc.peek('claude_cli')?.state).toBe('ready');
    fire('claude_cli', res('not_logged_in', false));
    expect(svc.peek('claude_cli')?.state).toBe('not_signed_in');
    svc.recordTest('claude_cli', { ok: true, at: 1, ms: 10 });
    expect(svc.peek('claude_cli')?.state).toBe('ready');
    fire('claude_cli', res('not_logged_in', true));
    fire('claude_cli', res('usage_limit', true)); // the account answered with its usage window: signed in
    expect(svc.peek('claude_cli')?.state).toBe('ready');
  });

  it('only ready / unknown are downgraded: not installed and too old keep their own state', async () => {
    const { runner, fire } = mkRunner();
    const old: CliLocator = {
      find: vi.fn(async () => ({ ...READY, version: '2.1.200' })),
      version: vi.fn(),
      signedIn: vi.fn(async () => true),
    };
    const s1 = createCliStatus({ locator: old, runner, clock: { now: () => 0 }, cacheMs: 60_000 });
    fire('claude_cli', res('not_logged_in', true));
    expect((await s1.get('claude_cli')).state).toBe('too_old');
    const unknown: CliLocator = {
      find: vi.fn(async () => READY),
      version: vi.fn(),
      signedIn: vi.fn(async () => 'unknown' as const),
    };
    const s2 = createCliStatus({ locator: unknown, runner, clock: { now: () => 0 }, cacheMs: 60_000 });
    expect((await s2.get('claude_cli')).state).toBe('unknown');
    fire('claude_cli', res('not_logged_in', true));
    expect((await s2.get('claude_cli')).state).toBe('not_signed_in');
  });

  it('recordSignIn decorates the status (absent while idle - the frozen shape is unchanged)', async () => {
    const { runner } = mkRunner();
    const loc: CliLocator = { find: vi.fn(async () => READY), version: vi.fn(), signedIn: vi.fn(async () => true) };
    const svc = createCliStatus({ locator: loc, runner, clock: { now: () => 0 }, cacheMs: 60_000 });
    expect(await svc.get('claude_cli')).not.toHaveProperty('signIn');
    svc.recordSignIn('claude_cli', { phase: 'open', outcome: null });
    expect(svc.peek('claude_cli')?.signIn).toEqual({ phase: 'open', outcome: null });
    expect(svc.peek('antigravity_cli')).toBeNull();
    svc.recordSignIn('claude_cli', { phase: 'done', outcome: { ok: false, code: 'CLI_NOT_SIGNED_IN', at: 7 } });
    svc.invalidate();
    expect((await svc.get('claude_cli')).signIn).toEqual({
      phase: 'done',
      outcome: { ok: false, code: 'CLI_NOT_SIGNED_IN', at: 7 },
    });
    svc.recordSignIn('claude_cli', null);
    expect(svc.peek('claude_cli')).not.toHaveProperty('signIn');
  });

  it('a runner without onRunEnd (the frozen CliRunner) still builds a working service', async () => {
    const loc: CliLocator = { find: vi.fn(async () => READY), version: vi.fn(), signedIn: vi.fn(async () => true) };
    const svc = createCliStatus({
      locator: loc,
      runner: { run: vi.fn(), breakerOpen: () => false },
      clock: { now: () => 0 },
      cacheMs: 1,
    });
    expect((await svc.get('claude_cli')).state).toBe('ready');
  });
});
