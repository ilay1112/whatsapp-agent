// src/main/proc/jobRunner.quit.test.ts - v2-repair-v2-main-defects REQUEST 10: the quit path. `killAll()` runs right before
// app.exit(); it used to resolve on the job's 'exit' event while the pid file was only removed in runOnce's `finally`, AFTER the
// stdio 'close' wait and the tree kill - so a quit during a CLI job (fake CLI hanging after init) left run\job-cli-<id>.pid.json.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { LIMITS } from '../../shared/types';
import {
  CLAUDE_ENV_KEYS,
  JobAbortedError,
  JobRunnerClosedError,
  WHISPER_ENV_KEYS,
  createJobRunner,
  type JobSpec,
} from './jobRunner';

interface HangingChild extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
  exit(): void;
}
/** A child that exits on kill but whose stdio 'close' never comes (a grandchild still holds the pipes - the hang-after-init case). */
function hangingChild(pid: number): HangingChild {
  const e = new EventEmitter() as HangingChild;
  e.pid = pid;
  e.stdin = new Writable({ write: (_c, _e, cb) => cb() });
  e.stdout = new PassThrough();
  e.stderr = new PassThrough();
  let gone = false;
  e.exit = () => {
    if (gone) return;
    gone = true;
    e.emit('exit', null, 'SIGKILL');
  };
  e.kill = () => {
    e.exit();
    return true;
  };
  return e;
}

let tmp: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-jobquit-'));
  runDir = path.join(tmp, 'run');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const envFor = (keys: readonly string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, 'x']));
function spec(): JobSpec {
  return {
    kind: 'cli',
    exePath: path.join(tmp, 'bin', 'claude.exe'),
    args: ['-p'],
    env: envFor(CLAUDE_ENV_KEYS),
    cwd: path.join(tmp, 'cli-runs', 'r1'),
    stdin: new TextEncoder().encode('{"type":"user"}\n'),
    stdout: 'ndjson',
    wallClockMs: 60_000,
    graceMs: LIMITS.cliKillGraceMs,
    belowNormal: false,
  };
}
const pidFiles = (): string[] =>
  fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((f) => /^job-.*\.pid\.json/.test(f)) : [];

describe('killAll() on the quit path', () => {
  it('no job pid file survives killAll(), even when the stdio close of the killed job is still pending', async () => {
    const child = hangingChild(7001);
    // timers that never fire: the 250 ms close wait and the grace timer stay pending, exactly as at app.exit()
    const timers = { setTimeout: vi.fn(() => ({})), clearTimeout: vi.fn() };
    const runner = createJobRunner({
      runDir,
      now: () => 1_800_000_000_000,
      log: () => undefined,
      proc: {
        spawn: (() => child as unknown as ChildProcess) as never,
        killPid: async () => child.exit(),
        setPriority: () => undefined,
      },
      timers: timers as never,
    });
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const job = runner.run(
      spec(),
      async (j) => {
        started();
        for await (const _l of j.lines()) {
          /* the fake CLI printed its init and hangs */
        }
        return 'never';
      },
      new AbortController().signal,
    );
    void job.catch(() => undefined);
    await running;
    expect(pidFiles()).toHaveLength(1);
    await runner.killAll();
    expect(pidFiles()).toEqual([]);
    expect(runner.jobPids()).toEqual({ cli: [], voice: [] });
  });
});

// [v2-closeout] e2e cli-connect (7b)/(7c)/(9): a NEW CLI job was spawned during the quit sequence (after killJobs) and left
// run\job-cli-<id>.pid.json behind, because run() kept accepting jobs after killAll(). The runner now latches on killAll(): every later
// run() - a fresh call, a call made while killAll() is still awaiting the exits, or one already queued behind the per-kind mutex - is
// refused with JobRunnerClosedError and NOTHING is spawned or written.
describe('the shutdown latch', () => {
  function rig(realTimers = false): {
    runner: ReturnType<typeof createJobRunner>;
    spawned: number[];
    child: HangingChild;
  } {
    const child = hangingChild(7101);
    const spawned: number[] = [];
    // never-firing timers mimic app.exit() (the close wait stays pending); real timers let a killed job finish its run and release the mutex
    const timers = realTimers ? undefined : { setTimeout: vi.fn(() => ({})), clearTimeout: vi.fn() };
    const runner = createJobRunner({
      runDir,
      now: () => 1_800_000_000_000,
      log: () => undefined,
      proc: {
        spawn: (() => {
          spawned.push(child.pid);
          return child as unknown as ChildProcess;
        }) as never,
        killPid: async () => child.exit(),
        setPriority: () => undefined,
      },
      ...(timers === undefined ? {} : { timers: timers as never }),
    });
    return { runner, spawned, child };
  }
  const drain = async (j: { lines(): AsyncIterable<string> }): Promise<string> => {
    for await (const _l of j.lines()) {
      /* hangs after init */
    }
    return 'done';
  };

  it('run() after killAll() is refused before any spawn, with no pid file', async () => {
    const { runner, spawned } = rig();
    await runner.killAll();
    await expect(runner.run(spec(), drain, new AbortController().signal)).rejects.toBeInstanceOf(JobRunnerClosedError);
    await expect(
      runner.run(
        { ...spec(), kind: 'voice', env: envFor(WHISPER_ENV_KEYS), stdout: 'ignore', stdin: null },
        drain,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(JobRunnerClosedError);
    expect(spawned).toEqual([]);
    expect(pidFiles()).toEqual([]);
    expect(runner.breaker('cli')).toMatchObject({ open: false, failures: 0 }); // a refusal is not a CLI failure
  });

  it('a run requested WHILE killAll() awaits the exits, and one queued behind the mutex, never spawn', async () => {
    const { runner, spawned } = rig(true);
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const first = runner.run(
      spec(),
      async (j) => {
        started();
        return drain(j);
      },
      new AbortController().signal,
    );
    void first.catch(() => undefined);
    await running;
    const queued = runner.run(spec(), drain, new AbortController().signal); // waits for the cli mutex
    const quitting = runner.killAll();
    const during = runner.run(spec(), drain, new AbortController().signal); // the mid-quit request
    await quitting;
    await expect(during).rejects.toBeInstanceOf(JobRunnerClosedError);
    await expect(queued).rejects.toBeInstanceOf(JobRunnerClosedError);
    expect(spawned).toEqual([7101]); // only the job that ran before the quit
    expect(pidFiles()).toEqual([]);
    expect(runner.jobPids()).toEqual({ cli: [], voice: [] });
  });

  it('JobRunnerClosedError is an abort (callers already treat JobAbortedError as "not run")', () => {
    expect(new JobRunnerClosedError()).toBeInstanceOf(JobAbortedError);
  });
});
