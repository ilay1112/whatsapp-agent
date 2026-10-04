// src/main/proc/jobRunner.test.ts - T2 5 row `proc/jobRunner.ts` (owner V2-W1-06-claude-cli). Safety-critical (T2 13: 100/95/100).
// Per-kind mutex, breaker 5 / 10 min per kind, grace then tree kill by PID (never /IM), pid file written before the first await after
// spawn and removed in finally, literal env allow-list per kind, shell:false + windowsHide, jobPids(), killAll().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { LIMITS } from '../../shared/types';
import {
  AGY_ENV_KEYS,
  CLAUDE_ENV_KEYS,
  CLAUDE_S3_ENV_KEYS,
  JOB_BREAKER_CODE,
  JOB_ENV_FORBIDDEN,
  JOB_LINE_CAP_BYTES,
  JOB_STDOUT_CAP_BYTES,
  JobAbortedError,
  JobBreakerOpenError,
  JobSpawnError,
  JobSpecError,
  WHISPER_ENV_KEYS,
  createJobRunner,
  createLineSplitter,
  createStderrScanner,
  envKeysAllowed,
  jobKindOfPidFile,
  type JobHandle,
  type JobKind,
  type JobSpec,
} from './jobRunner';

// ---------------------------------------------------------------------------------------------------------------------
// fake child process
// ---------------------------------------------------------------------------------------------------------------------
interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  stdinText: () => string;
  stdinEnded: () => boolean;
  exit(code: number | null): void;
}
function makeChild(pid: number | undefined): FakeChild {
  const e = new EventEmitter() as FakeChild;
  const chunks: Buffer[] = [];
  let ended = false;
  e.pid = pid;
  e.stdin = new Writable({
    write(c: Buffer, _enc, cb) {
      chunks.push(Buffer.from(c));
      cb();
    },
    final(cb) {
      ended = true;
      cb();
    },
  });
  e.stdout = new PassThrough();
  e.stderr = new PassThrough();
  e.kill = vi.fn(() => {
    e.exit(null);
    return true;
  });
  e.stdinText = () => Buffer.concat(chunks).toString('utf8');
  e.stdinEnded = () => ended;
  let gone = false;
  e.exit = (code) => {
    if (gone) return;
    gone = true;
    e.emit('exit', code, code === null ? 'SIGKILL' : null);
    e.stdout.end();
    e.stderr.end();
    setImmediate(() => e.emit('close', code));
  };
  return e;
}

const envFor = (keys: readonly string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, 'x']));

let tmp: string;
let runDir: string;
let clockNow: number;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-job-'));
  runDir = path.join(tmp, 'run');
  clockNow = 1_800_000_000_000;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

function spec(over: Partial<JobSpec> = {}): JobSpec {
  return {
    kind: 'cli',
    exePath: path.join(tmp, 'bin', 'claude.exe'),
    args: ['-p', '--restricted'],
    env: envFor(CLAUDE_ENV_KEYS),
    cwd: path.join(tmp, 'cli-runs', 'r1'),
    stdin: new TextEncoder().encode('{"type":"user"}\n'),
    stdout: 'ndjson',
    wallClockMs: 60_000,
    graceMs: LIMITS.cliKillGraceMs,
    belowNormal: false,
    ...over,
  };
}

function setup(opts: { children?: FakeChild[]; spawnImpl?: () => ChildProcess } = {}) {
  const children = opts.children ?? [];
  let next = 0;
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
    spawnCalls.push({ command, args, options });
    if (opts.spawnImpl) return opts.spawnImpl();
    const c = children[next++] ?? makeChild(4000 + next);
    return c as unknown as ChildProcess;
  });
  const killPid = vi.fn(async (_pid: number, _tree: boolean): Promise<void> => undefined);
  const setPriority = vi.fn();
  const log = vi.fn();
  const runner = createJobRunner({
    runDir,
    now: () => clockNow,
    log,
    proc: { spawn, killPid, setPriority },
    randomId: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    })(),
  });
  return { runner, spawn, spawnCalls, killPid, setPriority, log };
}

const collect = async (job: JobHandle): Promise<string[]> => {
  const out: string[] = [];
  for await (const l of job.lines()) out.push(l);
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
describe('constants and pure helpers', () => {
  it('env allow-lists are the literal C2 13 / ARCH2 4.3 key sets', () => {
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
    expect([...WHISPER_ENV_KEYS]).toEqual(['SystemRoot', 'windir', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS']);
    expect(JOB_BREAKER_CODE).toEqual({ cli: 'CLI_UNSTABLE', voice: 'VOICE_LOCAL_FAILED' });
  });

  it('envKeysAllowed accepts exactly the allow-lists per kind and refuses forbidden keys case-insensitively', () => {
    expect(envKeysAllowed('cli', envFor(CLAUDE_ENV_KEYS))).toBe('ok');
    expect(envKeysAllowed('cli', envFor(CLAUDE_S3_ENV_KEYS))).toBe('ok');
    expect(envKeysAllowed('cli', envFor(AGY_ENV_KEYS))).toBe('ok');
    expect(envKeysAllowed('voice', envFor(WHISPER_ENV_KEYS))).toBe('ok');
    expect(envKeysAllowed('voice', envFor(CLAUDE_ENV_KEYS))).toBe('env_keys');
    expect(envKeysAllowed('cli', envFor(WHISPER_ENV_KEYS))).toBe('env_keys');
    expect(envKeysAllowed('cli', envFor([...CLAUDE_ENV_KEYS, 'EXTRA']))).toBe('env_keys');
    expect(envKeysAllowed('cli', envFor(CLAUDE_ENV_KEYS.slice(1)))).toBe('env_keys');
    for (const f of JOB_ENV_FORBIDDEN) {
      expect(envKeysAllowed('cli', envFor([...CLAUDE_ENV_KEYS, f]))).toBe('env_forbidden');
      expect(envKeysAllowed('cli', envFor([...CLAUDE_ENV_KEYS, f.toLowerCase()]))).toBe('env_forbidden');
    }
  });

  it('jobKindOfPidFile recognises only job-<kind>-<id>.pid.json', () => {
    expect(jobKindOfPidFile('job-cli-00000000-0000-4000-8000-000000000001.pid.json')).toBe('cli');
    expect(jobKindOfPidFile('JOB-VOICE-abc.pid.json')).toBe('voice');
    expect(jobKindOfPidFile('bridge.pid.json')).toBeNull();
    expect(jobKindOfPidFile('job-other-1.pid.json')).toBeNull();
    expect(jobKindOfPidFile('job-cli-..\\x.pid.json')).toBeNull();
  });

  it('createLineSplitter: chunk boundaries, CRLF, blank lines, over-long lines dropped, total cap fires once', () => {
    const lines: string[] = [];
    const overflow = vi.fn();
    const feed = createLineSplitter((l) => lines.push(l), overflow);
    feed(Buffer.from('{"a":1}\r\n{"b"'));
    feed(Buffer.from(':2}\n\n   \n'));
    feed(Buffer.from('x'.repeat(JOB_LINE_CAP_BYTES) + 'y'));
    feed(Buffer.from('zz\n{"c":3}\n'));
    feed(Buffer.from('{"tail":'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(overflow).not.toHaveBeenCalled();
    const big = createLineSplitter(() => undefined, overflow);
    for (let i = 0; i < 9; i++) big(Buffer.alloc(1024 * 1024, 0x61));
    big(Buffer.from('more\n'));
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(JOB_STDOUT_CAP_BYTES).toBe(8 * 1024 * 1024);
  });

  it('createStderrScanner returns marker names only, also across chunk boundaries', () => {
    const s = createStderrScanner();
    s.feed(Buffer.from('SENTINEL_CLI_STDOUT token=sk-ant-TESTONLY-abc authentication_fa'));
    s.feed(Buffer.from('iled; rate limit; AGY_ERROR: x'));
    expect(s.markers()).toEqual(['agy_error', 'authentication_failed', 'rate_limit']);
    expect(JSON.stringify(s.markers())).not.toContain('SENTINEL');
  });
});

describe('run(): spawn rules, pid file, stdin, stdout', () => {
  it('spawns shell:false + windowsHide with the literal env and args; pid file exists during use and is removed after', async () => {
    const child = makeChild(4242);
    const { runner, spawnCalls } = setup({ children: [child] });
    const s = spec();
    let pidFileSeen: unknown = null;
    const result = await runner.run(
      s,
      async (job) => {
        const files = fs.readdirSync(runDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^job-cli-[0-9a-f-]+\.pid\.json$/);
        pidFileSeen = JSON.parse(fs.readFileSync(path.join(runDir, files[0] as string), 'utf8'));
        expect(runner.jobPids()).toEqual({ cli: [4242], voice: [] });
        child.stdout.write('{"type":"system"}\n{"type":"result"}\n');
        child.exit(0);
        return collect(job);
      },
      new AbortController().signal,
    );
    expect(result).toEqual(['{"type":"system"}', '{"type":"result"}']);
    expect(pidFileSeen).toEqual({ pid: 4242, exePath: s.exePath, startedAt: clockNow });
    expect(fs.readdirSync(runDir)).toEqual([]);
    expect(runner.jobPids()).toEqual({ cli: [], voice: [] });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.command).toBe(s.exePath);
    expect(call.args).toEqual(['-p', '--restricted']);
    expect(call.options).toEqual({
      cwd: s.cwd,
      env: s.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    expect(call.options.env).not.toBe(s.env); // a copy, never the caller's object
    expect(child.stdinText()).toBe('{"type":"user"}\n');
    expect(child.stdinEnded()).toBe(true);
  });

  it('pid file is on disk synchronously right after spawn returns (before the first await)', async () => {
    const child = makeChild(77);
    let sawFileAtSpawnReturn = false;
    const { runner } = setup({
      spawnImpl: () => {
        // queue a microtask check: it runs before any await inside run() could yield to the event loop
        queueMicrotask(() => {
          sawFileAtSpawnReturn = fs.existsSync(runDir) && fs.readdirSync(runDir).some((f) => f.endsWith('.pid.json'));
        });
        return child as unknown as ChildProcess;
      },
    });
    await runner.run(
      spec(),
      async () => {
        child.exit(0);
      },
      new AbortController().signal,
    );
    expect(sawFileAtSpawnReturn).toBe(true);
  });

  it('whisper-style spec: stdin ignored, stdout ignored, below-normal priority (a failing setPriority is ignored)', async () => {
    const child = makeChild(9);
    const { runner, spawnCalls, setPriority } = setup({ children: [child] });
    setPriority.mockImplementation(() => {
      throw new Error('denied');
    });
    const done = await runner.run(
      spec({
        kind: 'voice',
        env: envFor(WHISPER_ENV_KEYS),
        stdin: null,
        stdout: 'ignore',
        belowNormal: true,
        graceMs: 3_000,
      }),
      async (job) => {
        child.stderr.write('whisper: model_not_found SENTINEL_WHISPER_STDERR');
        child.exit(3);
        return job.done;
      },
      new AbortController().signal,
    );
    expect(spawnCalls[0]!.options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(setPriority).toHaveBeenCalledWith(9, 'below_normal');
    expect(done).toMatchObject({ exitCode: 3, killed: false, timedOut: false, stderrMarkers: ['model_not_found'] });
    expect(runner.breaker('voice').failures).toBe(0);
  });

  it('write() after the single stdin line throws (stdin stays closed)', async () => {
    const child = makeChild(10);
    const { runner } = setup({ children: [child] });
    await runner.run(
      spec(),
      async (job) => {
        expect(() => job.write('x')).toThrow('job_stdin_closed');
        child.exit(0);
      },
      new AbortController().signal,
    );
  });

  it('a late child error after spawn resolves done with a null exit code', async () => {
    const child = makeChild(11);
    const { runner } = setup({ children: [child] });
    const d = await runner.run(
      spec(),
      async (job) => {
        child.emit('error', new Error('EPIPE'));
        child.emit('close', null);
        return job.done;
      },
      new AbortController().signal,
    );
    expect(d.exitCode).toBeNull();
  });

  it('done completes after the close-wait even when the host never emits close', async () => {
    const child = makeChild(12);
    const { runner } = setup({ children: [child] });
    const d = await runner.run(
      spec(),
      async (job) => {
        child.emit('exit', 0, null);
        return job.done;
      },
      new AbortController().signal,
    );
    expect(d.exitCode).toBe(0);
  });
});

describe('run(): refusals before any spawn (fail closed)', () => {
  it.each<[string, Partial<JobSpec>, string]>([
    ['extra env key', { env: envFor([...CLAUDE_ENV_KEYS, 'HOME']) }, 'env_keys'],
    ['forbidden env key', { env: envFor([...CLAUDE_ENV_KEYS, 'ANTHROPIC_API_KEY']) }, 'env_forbidden'],
    ['forbidden env key lower-case', { env: envFor([...CLAUDE_ENV_KEYS, 'claude_config_dir']) }, 'env_forbidden'],
    ['whisper list on a cli job', { env: envFor(WHISPER_ENV_KEYS) }, 'env_keys'],
    ['relative exe', { exePath: 'claude.exe' }, 'exe_path'],
    ['NUL in exe', { exePath: path.join(tmp ?? os.tmpdir(), 'a\0b.exe') }, 'exe_path'],
    ['relative cwd', { cwd: 'cli-runs' }, 'cwd'],
  ])('%s => JobSpecError(%s), zero spawns, no pid file', async (_n, over, reason) => {
    const { runner, spawn } = setup();
    const err = await runner.run(spec(over), async () => 1, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobSpecError);
    expect((err as JobSpecError).reason).toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it('an already-aborted signal => JobAbortedError, zero spawns', async () => {
    const { runner, spawn } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(runner.run(spec(), async () => 1, ac.signal)).rejects.toBeInstanceOf(JobAbortedError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a synchronous spawn throw => JobSpawnError(code), a failure is recorded, no pid file', async () => {
    const { runner } = setup({
      spawnImpl: () => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      },
    });
    const err = await runner.run(spec(), async () => 1, new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobSpawnError);
    expect((err as JobSpawnError).errno).toBe('EACCES');
    expect(runner.breaker('cli').failures).toBe(1);
    const err2 = await setup({
      spawnImpl: () => {
        throw 'weird';
      },
    })
      .runner.run(spec(), async () => 1, new AbortController().signal)
      .catch((e: unknown) => e);
    expect((err2 as JobSpawnError).errno).toBe('spawn');
  });

  it('ENOENT (no pid, async error) => JobSpawnError("ENOENT"), no pid file; an exit without error maps to "spawn"', async () => {
    const noPid = makeChild(undefined);
    const { runner } = setup({ children: [noPid] });
    const p = runner.run(spec(), async () => 1, new AbortController().signal);
    setImmediate(() => noPid.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })));
    await expect(p).rejects.toMatchObject({ errno: 'ENOENT' });
    expect(fs.existsSync(runDir)).toBe(false);

    const noPid2 = makeChild(undefined);
    const s2 = setup({ children: [noPid2] });
    const p2 = s2.runner.run(spec(), async () => 1, new AbortController().signal);
    setImmediate(() => noPid2.emit('exit', 1));
    await expect(p2).rejects.toMatchObject({ errno: 'spawn' });

    const noPid3 = makeChild(undefined);
    const s3 = setup({ children: [noPid3] });
    const p3 = s3.runner.run(spec(), async () => 1, new AbortController().signal);
    setImmediate(() => noPid3.emit('error', new Error('no code')));
    await expect(p3).rejects.toMatchObject({ errno: 'spawn' });
  });

  it('a pid file that cannot be written => the job is tree-killed and run() rejects', async () => {
    const child = makeChild(55);
    const killPid = vi.fn(async () => undefined);
    const runner = createJobRunner({
      runDir,
      now: () => clockNow,
      log: vi.fn(),
      proc: { spawn: () => child as unknown as ChildProcess, killPid, setPriority: vi.fn() },
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => {
          throw new Error('disk full');
        },
        renameSync: () => undefined,
        rmSync: () => undefined,
      },
    });
    await expect(runner.run(spec(), async () => 1, new AbortController().signal)).rejects.toThrow('disk full');
    expect(killPid).toHaveBeenCalledWith(55, true);
    killPid.mockRejectedValueOnce(new Error('taskkill failed'));
    await expect(runner.run(spec(), async () => 1, new AbortController().signal)).rejects.toThrow('disk full');
  });

  it('stdin EPIPE is swallowed; lines arriving after close are dropped', async () => {
    const child = makeChild(58);
    const { runner } = setup({ children: [child] });
    const lines = await runner.run(
      spec(),
      async (job) => {
        child.stdin.emit('error', new Error('EPIPE'));
        child.emit('exit', 0, null);
        child.emit('close', 0);
        child.stdout.write('{"late":1}\n');
        await job.done;
        return collect(job);
      },
      new AbortController().signal,
    );
    expect(lines).toEqual([]);
  });

  it('a failing pid-file removal is logged by name only, never thrown', async () => {
    const child = makeChild(56);
    const log = vi.fn();
    const runner = createJobRunner({
      runDir,
      now: () => clockNow,
      log,
      proc: {
        spawn: () => child as unknown as ChildProcess,
        killPid: vi.fn(async () => undefined),
        setPriority: vi.fn(),
      },
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        renameSync: () => undefined,
        rmSync: () => {
          throw new TypeError('locked');
        },
      },
    });
    await runner.run(
      spec(),
      async () => {
        child.exit(0);
      },
      new AbortController().signal,
    );
    expect(log).toHaveBeenCalledWith('job_pidfile_remove_failed', { reason: 'TypeError' });
    const runner2 = createJobRunner({
      runDir,
      now: () => clockNow,
      log,
      proc: {
        spawn: () => makeChild(57) as unknown as ChildProcess,
        killPid: vi.fn(async () => undefined),
        setPriority: vi.fn(),
      },
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        renameSync: () => undefined,
        rmSync: () => {
          throw 'x';
        },
      },
    });
    await runner2.run(
      spec(),
      async (job) => {
        job.kill();
        return job.done;
      },
      new AbortController().signal,
    );
    expect(log).toHaveBeenCalledWith('job_pidfile_remove_failed', { reason: 'unknown' });
  });
});

describe('kill path: tree kill by PID first, child.kill() after the grace period, never /IM', () => {
  it('wall clock => taskkill /PID <pid> /T (tree) at once, child.kill() only after graceMs, done.timedOut, failure recorded', async () => {
    vi.useFakeTimers();
    const child = makeChild(3131);
    child.kill.mockImplementation(() => {
      child.exit(null);
      return true;
    });
    const { runner, killPid } = setup({ children: [child] });
    const p = runner.run(spec({ wallClockMs: 60_000 }), async (job) => job.done, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(killPid).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(killPid).toHaveBeenCalledWith(3131, true);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.cliKillGraceMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const d = await p;
    expect(d).toMatchObject({ killed: true, timedOut: true, exitCode: null });
    expect(runner.breaker('cli').failures).toBe(1);
    expect(fs.existsSync(runDir) ? fs.readdirSync(runDir) : []).toEqual([]);
  });

  it('when the tree kill ends the job within the grace period, child.kill() is never called', async () => {
    const child = makeChild(3232);
    const { runner, killPid } = setup({ children: [child] });
    killPid.mockImplementation(async () => {
      child.exit(1);
    });
    const d = await runner.run(
      spec(),
      async (job) => {
        job.kill();
        job.kill(); // idempotent
        return job.done;
      },
      new AbortController().signal,
    );
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(d.killed).toBe(true);
    expect(d.timedOut).toBe(false);
  });

  it('a throwing child.kill() fallback and a rejecting taskkill are swallowed', async () => {
    vi.useFakeTimers();
    const child = makeChild(3333);
    child.kill.mockImplementation(() => {
      child.exit(null);
      throw new Error('gone');
    });
    const { runner, killPid } = setup({ children: [child] });
    killPid.mockRejectedValue(new Error('taskkill failed'));
    const p = runner.run(
      spec(),
      async (job) => {
        job.kill();
        return job.done;
      },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(LIMITS.cliKillGraceMs + 1_000);
    await expect(p).resolves.toMatchObject({ killed: true });
  });

  it('abort signal => kill; stdout total cap => kill', async () => {
    const child = makeChild(3434);
    const { runner, killPid } = setup({ children: [child] });
    killPid.mockImplementation(async () => child.exit(null));
    const ac = new AbortController();
    const d = await runner.run(
      spec(),
      async (job) => {
        ac.abort();
        return job.done;
      },
      ac.signal,
    );
    expect(d.killed).toBe(true);

    const child2 = makeChild(3535);
    const s2 = setup({ children: [child2] });
    s2.killPid.mockImplementation(async () => child2.exit(null));
    const d2 = await s2.runner.run(
      spec(),
      async (job) => {
        child2.stdout.write(Buffer.alloc(JOB_STDOUT_CAP_BYTES + 1, 0x61));
        return job.done;
      },
      new AbortController().signal,
    );
    expect(d2.killed).toBe(true);
    expect(s2.killPid).toHaveBeenCalledWith(3535, true);
  });

  it('kill after exit is a no-op (never a taskkill on a pid that may be recycled)', async () => {
    const child = makeChild(3636);
    const { runner, killPid } = setup({ children: [child] });
    await runner.run(
      spec(),
      async (job) => {
        child.exit(0);
        await job.done;
        job.kill();
      },
      new AbortController().signal,
    );
    expect(killPid).not.toHaveBeenCalled();
  });

  it('use() throwing kills the job, records a failure and rethrows; the pid file is removed', async () => {
    const child = makeChild(3737);
    const { runner, killPid } = setup({ children: [child] });
    killPid.mockImplementation(async () => child.exit(null));
    await expect(
      runner.run(
        spec(),
        async () => {
          throw new Error('parser bug');
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('parser bug');
    expect(killPid).toHaveBeenCalledWith(3737, true);
    expect(runner.breaker('cli').failures).toBe(1);
    expect(fs.readdirSync(runDir)).toEqual([]);
  });
});

describe('per-kind mutex, breaker, killAll, jobPids', () => {
  it('two concurrent runs of one kind serialise; another kind is not blocked', async () => {
    const c1 = makeChild(1);
    const c2 = makeChild(2);
    const c3 = makeChild(3);
    const { runner, spawn } = setup({ children: [c1, c3, c2] });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const a = runner.run(
      spec(),
      async () => {
        order.push('a-start');
        await gate;
        c1.exit(0);
        order.push('a-end');
      },
      new AbortController().signal,
    );
    const b = runner.run(
      spec(),
      async () => {
        order.push('b-start');
        c2.exit(0);
      },
      new AbortController().signal,
    );
    const v = runner.run(
      spec({ kind: 'voice', env: envFor(WHISPER_ENV_KEYS), stdin: null, stdout: 'ignore' }),
      async () => {
        order.push('voice');
        c3.exit(0);
      },
      new AbortController().signal,
    );
    await v;
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledTimes(2); // a + voice; b waits
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'voice', 'a-end', 'b-start']);
  });

  it.each<[JobKind]>([['cli'], ['voice']])(
    'breaker (%s): 5 failures in 10 min => open => JobBreakerOpenError(code) without spawning; reset; window',
    async (kind) => {
      const { runner, spawn } = setup();
      const s =
        kind === 'cli' ? spec() : spec({ kind: 'voice', env: envFor(WHISPER_ENV_KEYS), stdin: null, stdout: 'ignore' });
      const fail = async (): Promise<void> => {
        await runner
          .run(
            s,
            async (job) => {
              job.kill();
              throw new Error('bad');
            },
            new AbortController().signal,
          )
          .catch(() => undefined);
      };
      // killPid is a no-op spy: the fake child exits through child.kill() after the grace period (real timers, 500 ms / 3 s).
      // Use a tiny grace to keep the test fast.
      s.graceMs = 1;
      for (let i = 0; i < LIMITS.jobBreakerFailures - 1; i++) await fail();
      expect(runner.breaker(kind)).toEqual({ open: false, failures: 4, openedAt: null });
      clockNow += LIMITS.jobBreakerWindowMs + 1; // the first four age out of the window
      expect(runner.breaker(kind).failures).toBe(0);
      for (let i = 0; i < LIMITS.jobBreakerFailures; i++) await fail();
      expect(runner.breaker(kind)).toMatchObject({ open: true, failures: 5, openedAt: clockNow });
      const spawnsBefore = spawn.mock.calls.length;
      const err = await runner.run(s, async () => 1, new AbortController().signal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobBreakerOpenError);
      expect((err as JobBreakerOpenError).code).toBe(JOB_BREAKER_CODE[kind]);
      expect(spawn.mock.calls.length).toBe(spawnsBefore);
      runner.resetBreaker(kind);
      expect(runner.breaker(kind)).toEqual({ open: false, failures: 0, openedAt: null });
    },
  );

  it('a run queued behind the mutex is refused when the breaker opened meanwhile (no spawn)', async () => {
    const { runner, spawn } = setup();
    const s = spec({ graceMs: 1 });
    const failing = Array.from({ length: LIMITS.jobBreakerFailures }, () =>
      runner
        .run(
          s,
          async () => {
            throw new Error('y');
          },
          new AbortController().signal,
        )
        .catch(() => undefined),
    );
    const queued = runner.run(s, async () => 1, new AbortController().signal).catch((e: unknown) => e);
    await Promise.all(failing);
    expect(await queued).toBeInstanceOf(JobBreakerOpenError);
    expect(spawn).toHaveBeenCalledTimes(LIMITS.jobBreakerFailures);
  });

  it('killAll() kills every running job and waits for their exit; jobPids() empties', async () => {
    const c1 = makeChild(501);
    const c2 = makeChild(502);
    const { runner, killPid } = setup({ children: [c1, c2] });
    killPid.mockImplementation(async (pid: number) => (pid === 501 ? c1 : c2).exit(null));
    let started = 0;
    const both = new Promise<void>((resolve) => {
      const hit = (): void => {
        started += 1;
        if (started === 2) resolve();
      };
      void runner.run(
        spec(),
        async (job) => {
          hit();
          return job.done;
        },
        new AbortController().signal,
      );
      void runner.run(
        spec({ kind: 'voice', env: envFor(WHISPER_ENV_KEYS), stdin: null, stdout: 'ignore' }),
        async (job) => {
          hit();
          return job.done;
        },
        new AbortController().signal,
      );
    });
    await both;
    expect(runner.jobPids()).toEqual({ cli: [501], voice: [502] });
    await runner.killAll();
    expect(killPid).toHaveBeenCalledWith(501, true);
    expect(killPid).toHaveBeenCalledWith(502, true);
    await new Promise((r) => setImmediate(r));
    expect(runner.jobPids()).toEqual({ cli: [], voice: [] });
  });
});

describe('production defaults (real node child, real taskkill by PID)', () => {
  it('spawns the system node with the allow-listed env, reads NDJSON, writes/removes the pid file, kills a hung job', async () => {
    const runner = createJobRunner({ runDir, now: () => Date.now(), log: () => undefined });
    const env: Record<string, string> = Object.fromEntries(CLAUDE_ENV_KEYS.map((k) => [k, '1']));
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.PATH = path.join(env.SystemRoot, 'System32');
    env.TEMP = tmp;
    env.TMP = tmp;
    const script = [
      "process.stdin.setEncoding('utf8');",
      "let s='';process.stdin.on('data',d=>s+=d);",
      "process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({got:s.trim()})+'\\n');",
      "if(s.includes('hang'))setInterval(()=>{},1000);else process.exit(0);});",
    ].join('');
    const out = await runner.run(
      {
        kind: 'cli',
        exePath: process.execPath,
        args: ['-e', script],
        env,
        cwd: tmp,
        stdin: new TextEncoder().encode('{"x":1}\n'),
        stdout: 'ndjson',
        wallClockMs: 20_000,
        graceMs: 500,
        belowNormal: true,
      },
      async (job) => ({ lines: await collect(job), done: await job.done }),
      new AbortController().signal,
    );
    expect(out.lines).toEqual(['{"got":"{\\"x\\":1}"}']);
    expect(out.done.exitCode).toBe(0);
    expect(fs.readdirSync(runDir)).toEqual([]);

    const hung = await runner.run(
      {
        kind: 'cli',
        exePath: process.execPath,
        args: ['-e', script],
        env,
        cwd: tmp,
        stdin: new TextEncoder().encode('hang\n'),
        stdout: 'ndjson',
        wallClockMs: 1_500,
        graceMs: 500,
        belowNormal: false,
      },
      async (job) => job.done,
      new AbortController().signal,
    );
    expect(hung).toMatchObject({ killed: true, timedOut: true });
    expect(fs.readdirSync(runDir)).toEqual([]);
  }, 30_000);
});
