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
import type { CliRunner } from './runner';
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
  answer: (spec: JobSpec) => { lines: string[]; exitCode: number | null } | Error,
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
        done: Promise.resolve({ exitCode: a.exitCode, killed: false, timedOut: false, stderrMarkers: [], ms: 1 }),
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
