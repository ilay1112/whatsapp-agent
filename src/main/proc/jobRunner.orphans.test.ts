// src/main/proc/jobRunner.orphans.test.ts - v2 review finding cli-sandbox-4: a descendant of a job that EXITS NORMALLY used to
// survive the run (the tree kill only ran on the kill paths, and the pid file only names the direct child). After every job exit
// the JobRunner now sweeps the Win32_Process table for processes whose ParentProcessId is the dead job's pid AND whose creation
// time lies inside the job's lifetime (the pid-reuse guard), and tree-kills them BY PID (never by image name).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { LIMITS } from '../../shared/types';
import {
  CLAUDE_ENV_KEYS,
  CLAUDE_S3_ENV_KEYS,
  JOB_SWEEP_KINDS,
  JOB_SWEEP_PS_ARGS,
  JOB_SWEEP_QUERY_TIMEOUT_MS,
  WHISPER_ENV_KEYS,
  createJobRunner,
  createWindowsProcessTable,
  parseProcessTableJson,
  selectJobOrphans,
  type JobProcRow,
  type JobSpec,
} from './jobRunner';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
  exit(code: number | null): void;
}
function makeChild(pid: number): FakeChild {
  const e = new EventEmitter() as FakeChild;
  e.pid = pid;
  e.stdin = new Writable({ write: (_c, _e, cb) => cb() });
  e.stdout = new PassThrough();
  e.stderr = new PassThrough();
  let gone = false;
  e.exit = (code) => {
    if (gone) return;
    gone = true;
    e.emit('exit', code, null);
    e.stdout.end();
    e.stderr.end();
    setImmediate(() => e.emit('close', code));
  };
  e.kill = () => {
    e.exit(null);
    return true;
  };
  return e;
}

let tmp: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-joborphans-'));
  runDir = path.join(tmp, 'run');
});
afterEach(() => {
  vi.useRealTimers();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a just-killed grandchild may still hold the dir for a moment (Windows) */
  }
});

const envFor = (keys: readonly string[]): Record<string, string> => Object.fromEntries(keys.map((k) => [k, 'x']));
function spec(): JobSpec {
  return {
    kind: 'cli',
    exePath: path.join(tmp, 'bin', 'agy.exe'),
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

const JOB_PID = 6100;

// ---------------------------------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------------------------------
describe('selectJobOrphans (pid-reuse guard)', () => {
  const since = 1_800_000_000_000;
  const until = since + 5_000;
  const rows: JobProcRow[] = [
    { pid: 7001, ppid: JOB_PID, createdAt: since + 100 }, // the helper the job started: an orphan
    { pid: 7002, ppid: JOB_PID, createdAt: since }, // boundary: created in the same ms the job was spawned
    { pid: 7003, ppid: JOB_PID, createdAt: until }, // boundary: created in the ms the exit was seen
    { pid: 7004, ppid: JOB_PID, createdAt: since - 1 }, // stale ParentProcessId: a child of an EARLIER holder of the pid
    { pid: 7005, ppid: JOB_PID, createdAt: until + 1 }, // a child of a process that REUSED the pid after the job died
    { pid: 7006, ppid: 4, createdAt: since + 100 }, // somebody else's child
    { pid: JOB_PID, ppid: 1234, createdAt: until + 2 }, // the job pid itself, reused by an unrelated process
    { pid: 7001, ppid: JOB_PID, createdAt: since + 100 }, // duplicate row
  ];

  it('returns only children of the job pid created inside [startedAt, exitedAt], sorted and unique', () => {
    expect(selectJobOrphans(rows, JOB_PID, since, until, 99_999)).toEqual([7001, 7002, 7003]);
  });

  it('never selects the app itself or the job pid', () => {
    const self: JobProcRow[] = [
      { pid: 99_999, ppid: JOB_PID, createdAt: since + 1 },
      { pid: JOB_PID, ppid: JOB_PID, createdAt: since + 1 },
    ];
    expect(selectJobOrphans(self, JOB_PID, since, until, 99_999)).toEqual([]);
  });

  it('an empty or inverted window selects nothing', () => {
    expect(selectJobOrphans(rows, JOB_PID, until, since, 99_999)).toEqual([]);
    expect(selectJobOrphans([], JOB_PID, since, until, 99_999)).toEqual([]);
  });
});

describe('parseProcessTableJson', () => {
  it('parses the Windows PowerShell 5.1 array shape (/Date(ms)/) and the PowerShell 7 ISO shape', () => {
    const ps51 =
      '[{"ProcessId":4,"ParentProcessId":0,"CreationDate":"\\/Date(1789992421705)\\/"},{"ProcessId":10,"ParentProcessId":4,"CreationDate":"/Date(1789992421800)/"}]';
    expect(parseProcessTableJson(ps51)).toEqual([
      { pid: 4, ppid: 0, createdAt: 1789992421705 },
      { pid: 10, ppid: 4, createdAt: 1789992421800 },
    ]);
    const ps7 = '{"ProcessId":12,"ParentProcessId":10,"CreationDate":"2026-10-04T10:00:00.000Z"}';
    expect(parseProcessTableJson(ps7)).toEqual([
      { pid: 12, ppid: 10, createdAt: Date.parse('2026-10-04T10:00:00.000Z') },
    ]);
  });

  it('skips malformed rows; returns null for output that is not a process table (the sweep then kills nothing)', () => {
    const mixed =
      '[{"ProcessId":"5","ParentProcessId":4,"CreationDate":"/Date(1)/"},{"ProcessId":6,"ParentProcessId":4,"CreationDate":null},' +
      '{"ProcessId":7,"ParentProcessId":-1,"CreationDate":"/Date(1)/"},null,{"ProcessId":8,"ParentProcessId":4,"CreationDate":"/Date(2)/"}]';
    expect(parseProcessTableJson(mixed)).toEqual([{ pid: 8, ppid: 4, createdAt: 2 }]);
    expect(parseProcessTableJson('')).toBeNull();
    expect(parseProcessTableJson('   ')).toBeNull();
    expect(parseProcessTableJson('not json')).toBeNull();
    expect(parseProcessTableJson('42')).toBeNull();
  });
});

describe('createWindowsProcessTable (powershell, shell:false, constant argv - no pid is ever interpolated)', () => {
  function recordingSpawn(stdout: string | null, opts: { error?: boolean; hang?: boolean } = {}) {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const children: FakeChild[] = [];
    const fn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      calls.push({ command, args, options });
      const c = makeChild(555);
      children.push(c);
      setImmediate(() => {
        if (opts.error) {
          c.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
          return;
        }
        if (opts.hang) return;
        if (stdout !== null) c.stdout.write(stdout);
        c.exit(0);
      });
      return c as unknown as ChildProcess;
    };
    return { fn, calls, children };
  }

  it('runs one constant powershell query and parses it', async () => {
    const rec = recordingSpawn('[{"ProcessId":10,"ParentProcessId":4,"CreationDate":"/Date(5)/"}]');
    const table = createWindowsProcessTable({ spawn: rec.fn });
    await expect(table()).resolves.toEqual([{ pid: 10, ppid: 4, createdAt: 5 }]);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    expect(call.command).toBe('powershell.exe');
    expect(call.args).toEqual([...JOB_SWEEP_PS_ARGS]);
    expect(call.options).toMatchObject({ shell: false, windowsHide: true });
    expect(JOB_SWEEP_PS_ARGS.join(' ')).not.toMatch(/\$args|--/);
  });

  it('rejects when powershell cannot start or answers garbage', async () => {
    await expect(createWindowsProcessTable({ spawn: recordingSpawn(null, { error: true }).fn })()).rejects.toThrow();
    await expect(createWindowsProcessTable({ spawn: recordingSpawn('garbage').fn })()).rejects.toThrow();
  });

  it('a hung query is killed and rejected after JOB_SWEEP_QUERY_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const rec = recordingSpawn(null, { hang: true });
    const p = createWindowsProcessTable({ spawn: rec.fn })();
    const settled = vi.fn();
    void p.then(settled, settled);
    await vi.advanceTimersByTimeAsync(JOB_SWEEP_QUERY_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the runner
// ---------------------------------------------------------------------------------------------------------------------
function setup(processTable: (() => Promise<readonly JobProcRow[]>) | null | undefined) {
  const child = makeChild(JOB_PID);
  const killPid = vi.fn(async (_pid: number, _tree: boolean): Promise<void> => undefined);
  const log = vi.fn();
  const runner = createJobRunner({
    runDir,
    now: () => Date.now(),
    log,
    proc: { spawn: (() => child as unknown as ChildProcess) as never, killPid, setPriority: () => undefined },
    ...(processTable === undefined ? {} : { processTable }),
  });
  return { runner, child, killPid, log };
}

describe('JobRunner: descendants of a NORMALLY exiting job are swept (cli-sandbox-4)', () => {
  it('after exit 0, the helper the job left behind is tree-killed by PID; stale/late/foreign rows are not', async () => {
    let helperCreatedAt = 0;
    const table = vi.fn(async (): Promise<JobProcRow[]> => [
      { pid: 7001, ppid: JOB_PID, createdAt: helperCreatedAt },
      { pid: 7004, ppid: JOB_PID, createdAt: helperCreatedAt - 3_600_000 },
      { pid: 7005, ppid: JOB_PID, createdAt: Date.now() + 3_600_000 },
      { pid: 7006, ppid: 4, createdAt: helperCreatedAt },
    ]);
    const { runner, child, killPid, log } = setup(table);
    const d = await runner.run(
      spec(),
      async (job) => {
        helperCreatedAt = Date.now();
        child.exit(0);
        return job.done;
      },
      new AbortController().signal,
    );
    expect(d).toMatchObject({ exitCode: 0, killed: false });
    await runner.killAll(); // also waits for the in-flight sweep
    expect(table).toHaveBeenCalledTimes(1);
    expect(killPid.mock.calls).toEqual([[7001, true]]);
    expect(log).toHaveBeenCalledWith('job_orphans_killed', { kind: 'cli', count: 1 });
    expect(fs.existsSync(runDir) ? fs.readdirSync(runDir) : []).toEqual([]);
  });

  it('job.done (and so run()) resolves only after the sweep: no orphan outlives the run', async () => {
    let release!: (rows: JobProcRow[]) => void;
    const table = vi.fn(() => new Promise<JobProcRow[]>((r) => (release = r)));
    const { runner, child, killPid } = setup(table);
    let helperCreatedAt = 0;
    const finished = vi.fn();
    const p = runner
      .run(
        spec(),
        async (job) => {
          helperCreatedAt = Date.now();
          child.exit(0);
          return job.done;
        },
        new AbortController().signal,
      )
      .then(finished);
    await new Promise((r) => setTimeout(r, 400)); // past the 250 ms stdio close wait
    expect(table).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
    release([{ pid: 7001, ppid: JOB_PID, createdAt: helperCreatedAt }]);
    await p;
    expect(killPid.mock.calls).toEqual([[7001, true]]);
  });

  it('killAll() (the quit path) kills the job, then waits for the sweep its exit started', async () => {
    let release!: (rows: JobProcRow[]) => void;
    const table = vi.fn(() => new Promise<JobProcRow[]>((r) => (release = r)));
    const { runner, child, killPid } = setup(table);
    killPid.mockImplementation(async (p: number) => {
      if (p === JOB_PID) child.exit(null);
    });
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let helperCreatedAt = 0;
    const job = runner.run(
      spec(),
      async (j) => {
        helperCreatedAt = Date.now();
        started();
        return j.done;
      },
      new AbortController().signal,
    );
    await running;
    const quit = vi.fn();
    const killAll = runner.killAll().then(quit);
    await new Promise((r) => setImmediate(r));
    expect(killPid).toHaveBeenCalledWith(JOB_PID, true);
    expect(table).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    release([{ pid: 7001, ppid: JOB_PID, createdAt: helperCreatedAt }]);
    await killAll;
    expect(killPid).toHaveBeenCalledWith(7001, true);
    await expect(job).resolves.toMatchObject({ killed: true });
  });

  it('a failed process-table query kills nothing, is logged, and never fails the job', async () => {
    const { runner, child, killPid, log } = setup(async () => {
      throw new Error('powershell gone');
    });
    await expect(
      runner.run(
        spec(),
        async (job) => {
          child.exit(0);
          return (await job.done).exitCode;
        },
        new AbortController().signal,
      ),
    ).resolves.toBe(0);
    await runner.killAll();
    expect(killPid).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('job_orphan_sweep_failed', { kind: 'cli' });
  });

  it('a rejecting taskkill of an orphan is swallowed', async () => {
    let helperCreatedAt = 0;
    const { runner, child, killPid } = setup(async () => [{ pid: 7001, ppid: JOB_PID, createdAt: helperCreatedAt }]);
    killPid.mockRejectedValue(new Error('taskkill failed'));
    await runner.run(
      spec(),
      async (job) => {
        helperCreatedAt = Date.now();
        child.exit(0);
        return job.done;
      },
      new AbortController().signal,
    );
    await expect(runner.killAll()).resolves.toBeUndefined();
    expect(killPid).toHaveBeenCalledWith(7001, true);
  });

  it('a fake spawn without an explicit process table never sweeps the REAL table (fake pids could match real processes)', async () => {
    const { runner, child, killPid } = setup(undefined);
    await runner.run(
      spec(),
      async (job) => {
        child.exit(0);
        return job.done;
      },
      new AbortController().signal,
    );
    await runner.killAll();
    expect(killPid).not.toHaveBeenCalled();
  });

  it('only vendor-CLI jobs are swept: a whisper (voice) exit never queries the table', async () => {
    expect([...JOB_SWEEP_KINDS]).toEqual(['cli']);
    const table = vi.fn(async (): Promise<JobProcRow[]> => [{ pid: 7001, ppid: JOB_PID, createdAt: Date.now() }]);
    const { runner, child, killPid } = setup(table);
    await runner.run(
      {
        ...spec(),
        kind: 'voice',
        exePath: path.join(tmp, 'bin', 'whisper-cli.exe'),
        env: envFor(WHISPER_ENV_KEYS),
        stdin: null,
        stdout: 'ignore',
      },
      async (job) => {
        child.exit(0);
        return job.done;
      },
      new AbortController().signal,
    );
    await runner.killAll();
    expect(table).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
  });

  it('processTable: null disables the sweep', async () => {
    const { runner, child, killPid } = setup(null);
    await runner.run(
      spec(),
      async (job) => {
        child.exit(0);
        return job.done;
      },
      new AbortController().signal,
    );
    await runner.killAll();
    expect(killPid).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// production defaults: the reviewer's scenario with real processes (system node.exe only - never a vendor binary)
// ---------------------------------------------------------------------------------------------------------------------
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe.runIf(process.platform === 'win32')(
  'production defaults: a detached grandchild of a job that exited 0',
  () => {
    it('is killed after the run; an unrelated process started by the app is left alone', async () => {
      const pidOut = path.join(tmp, 'grandchild.pid');
      const script = path.join(tmp, 'spawner.cjs');
      fs.writeFileSync(
        script,
        [
          "const { spawn } = require('child_process');",
          "const fs = require('fs');",
          "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { detached: true, stdio: 'ignore', cwd: require('os').tmpdir() });",
          'fs.writeFileSync(process.argv[2], String(g.pid));',
          'g.unref();',
          'process.exit(0);',
        ].join('\n'),
      );
      // an unrelated sleeper (child of the test process, not of the job): the sweep must never touch it
      const bystander = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const log = vi.fn();
      const runner = createJobRunner({ runDir, now: () => Date.now(), log });
      // the S3 Claude env: the scenario where a surviving helper would hold WCA_MCP_TOKEN
      const env: Record<string, string> = Object.fromEntries(CLAUDE_S3_ENV_KEYS.map((k) => [k, '1']));
      env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      env.PATH = path.join(env.SystemRoot, 'System32');
      env.TEMP = tmp;
      env.TMP = tmp;
      let gpid = 0;
      try {
        const d = await runner.run(
          {
            kind: 'cli',
            exePath: process.execPath,
            args: [script, pidOut],
            env,
            cwd: tmp,
            stdin: null,
            stdout: 'ignore',
            wallClockMs: 15_000,
            graceMs: 500,
            belowNormal: false,
          },
          async (job) => job.done,
          new AbortController().signal,
        );
        expect(d).toMatchObject({ exitCode: 0, killed: false });
        gpid = Number(fs.readFileSync(pidOut, 'utf8'));
        expect(gpid).toBeGreaterThan(0);
        // run() resolved only after the sweep's taskkill returned; allow the OS a moment to tear the process down
        expect(await waitUntil(() => !alive(gpid), 2_000)).toBe(true);
        expect(log).toHaveBeenCalledWith('job_orphans_killed', { kind: 'cli', count: 1 });
        expect(alive(bystander.pid!)).toBe(true);
        expect(fs.readdirSync(runDir).filter((f) => f.endsWith('.pid.json'))).toEqual([]);
      } finally {
        const gone = new Promise((r) => bystander.once('exit', r));
        bystander.kill();
        await gone;
        if (gpid > 0 && alive(gpid)) {
          try {
            process.kill(gpid);
          } catch {
            /* already gone */
          }
        }
      }
    }, 30_000);
  },
);
