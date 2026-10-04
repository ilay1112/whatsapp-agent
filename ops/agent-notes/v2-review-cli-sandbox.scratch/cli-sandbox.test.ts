// Scratch proofs for ops/agent-notes/v2-review-cli-sandbox.md. NOT a product test; lives outside tests/ on purpose.
// Run: npx vitest run --config "ops/agent-notes/v2-review-cli-sandbox.scratch/vitest.scratch.config.ts"
// Every test here asserts the CURRENT (defective) behaviour, so a green run = the defect is reproduced.
// No vendor binary is ever started: the "CLI" in the process tests is the system node.exe running an inline script.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '../../../src/shared/types';
import {
  createJobRunner,
  type JobHandle,
  type JobRunner,
  type JobSpec,
  JobAbortedError,
} from '../../../src/main/proc/jobRunner';
import { buildClaudeStdinLine, CLI_SCHEMA_TOOL, type ClaudeRunRequestExt } from '../../../src/main/llm/cli/claudeCli';
import { createCliRunner } from '../../../src/main/llm/cli/runner';
import { createCliLocator } from '../../../src/main/llm/cli/locator';
import { PURGE_NOW_DIRS } from '../../../src/main/db/retention';

const j = (o: unknown): string => JSON.stringify(o);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-cli-sandbox-'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a just-killed grandchild may still hold the dir (Windows); the OS temp sweep removes it */ }
});

/** A scripted JobRunner (same shape as runner.test.ts): yields the given NDJSON lines, records kills. */
function scriptedJobs(lines: string[]): JobRunner & { kills: number } {
  const jobs = {
    kills: 0,
    async run<T>(_spec: JobSpec, use: (job: JobHandle) => Promise<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) throw new JobAbortedError();
      let killed = false;
      let i = 0;
      const handle: JobHandle = {
        pid: 4242,
        lines: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () =>
              killed || i >= lines.length
                ? { value: undefined, done: true as const }
                : { value: lines[i++] as string, done: false as const },
          }),
        }),
        write: () => undefined,
        kill: () => {
          if (!killed) jobs.kills += 1;
          killed = true;
        },
        get done() {
          return Promise.resolve({ exitCode: killed ? null : 0, killed, timedOut: false, stderrMarkers: [], ms: 5 });
        },
      };
      return use(handle);
    },
    breaker: () => ({ open: false, failures: 0, openedAt: null }),
    resetBreaker: () => undefined,
    killAll: async () => undefined,
    jobPids: () => ({ cli: [], voice: [] }),
  };
  return jobs;
}

const FAKE_ENV = {
  SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\wca-fake-home',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\wca-fake-home',
  APPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Local',
};

// =====================================================================================================================
// cli-sandbox-1: an S3 tool_use for a NON-exposed mcp__wca__* name is counted as a successful tool call, never a strike.
// =====================================================================================================================
describe('cli-sandbox-1: unexposed mcp__wca__ names escape the strike', () => {
  it('mcp__wca__send_message (not exposed) => toolCalls 1, blockedCalls 0, no tool_blocked audit', async () => {
    const audits: string[] = [];
    const lines = [
      j({
        type: 'system',
        subtype: 'init',
        apiKeySource: 'none',
        tools: ['mcp__wca__get_freebusy'],
        mcp_servers: [{ name: 'wca', status: 'connected' }],
        mcp_server_errors: [],
        plugins: [],
      }),
      j({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__wca__send_message', input: { text: 'x' } }] },
      }),
      j({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Sure, see you then.',
        stop_reason: 'end_turn',
        permission_denials: [],
      }),
    ];
    const runner = createCliRunner({
      jobs: scriptedJobs(lines),
      userDataDir: tmp,
      now: () => 1_800_000_000_000,
      audit: (kind) => audits.push(kind),
      processEnv: FAKE_ENV,
    });
    let strikes = 0;
    const req: ClaudeRunRequestExt = {
      provider: 'claude_cli',
      stage: 'draft',
      exePath: 'C:\\fakehome\\.local\\bin\\claude.exe',
      model: 'sonnet',
      system: 'S3',
      stdinLine: buildClaudeStdinLine('<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>', null),
      jsonSchema: null,
      maxTurns: 5,
      wallClockMs: LIMITS.cliWallClockDraftMs,
      toolServer: { url: 'http://127.0.0.1:50123/mcp', token: 'T'.repeat(43) },
      observedVersion: '2.1.258',
      exposedNames: ['get_freebusy'],
      runId: 1,
      auditRef: '1',
      onStrike: () => {
        strikes += 1;
        return false;
      },
    };
    const res = await runner.run(req, new AbortController().signal);
    expect(res.sandbox.initOk).toBe(true);
    expect(res.toolCalls).toBe(1); // counted as an executed call
    expect(res.blockedCalls).toBe(0); // ... and NOT as a strike
    expect(strikes).toBe(0); // ctx.blockedCalls never moves => no manipulation badge, AutoGate 'blocked_tool_call' passes
    expect(audits).not.toContain('tool_blocked');
    expect(res.error).toBeNull();
  });

  it('control: the same name in the in-process gate vocabulary would be a strike (any non-prefixed name is)', async () => {
    const lines = [
      j({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [CLI_SCHEMA_TOOL], mcp_servers: [], plugins: [] }),
      j({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'send_message', input: {} }] } }),
      j({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { a: 'x' } }),
    ];
    const runner = createCliRunner({
      jobs: scriptedJobs(lines),
      userDataDir: tmp,
      now: () => 1_800_000_000_000,
      audit: () => undefined,
      processEnv: FAKE_ENV,
    });
    const res = await runner.run(
      {
        provider: 'claude_cli',
        stage: 'extract',
        exePath: 'C:\\fakehome\\.local\\bin\\claude.exe',
        model: 'sonnet',
        system: 'S1',
        stdinLine: buildClaudeStdinLine('x', null),
        jsonSchema: { type: 'object' },
        maxTurns: 1,
        wallClockMs: LIMITS.cliWallClockExtractMs,
        toolServer: null,
        observedVersion: '2.1.258',
      },
      new AbortController().signal,
    );
    expect(res.blockedCalls).toBe(1);
  });
});

// =====================================================================================================================
// cli-sandbox-2: the user line (message text) reaches the CLI's stdin BEFORE the init proof is read; a failed proof
// kills a process that already holds the data.
// =====================================================================================================================
describe('cli-sandbox-2: stdin is delivered before the init proof', () => {
  it('a CLI whose init FAILS the proof has already received the full stdin line', async () => {
    const marker = path.join(tmp, 'stdin-received.txt');
    const script = path.join(tmp, 'fake-cli.cjs');
    // Reads ALL of stdin first (as a CLI that sends the prompt right after init would), records it, THEN prints a bad init.
    fs.writeFileSync(
      script,
      [
        "const fs = require('fs');",
        'const marker = process.argv[2];',
        "let buf = '';",
        "process.stdin.on('data', (c) => { buf += c; });",
        "process.stdin.on('end', () => {",
        '  fs.writeFileSync(marker, String(buf.length));',
        "  process.stdout.write(JSON.stringify({type:'system',subtype:'init',apiKeySource:'none',tools:['Bash'],mcp_servers:[],plugins:[]}) + '\\n');",
        '  setTimeout(() => {}, 20000);',
        '});',
      ].join('\n'),
    );
    const jobs = createJobRunner({ runDir: path.join(tmp, 'run'), now: () => Date.now(), log: () => undefined });
    const runner = createCliRunner({
      jobs,
      userDataDir: path.join(tmp, 'ud'),
      now: () => Date.now(),
      audit: () => undefined,
      processEnv: { ...FAKE_ENV, SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      argsPrefix: () => [script, marker],
    });
    const secret = 'MESSAGE-TEXT-SENTINEL';
    const res = await runner.run(
      {
        provider: 'claude_cli',
        stage: 'extract',
        exePath: process.execPath,
        model: 'sonnet',
        system: 'S1',
        stdinLine: buildClaudeStdinLine(`<<DATA-0123456789abcdef>>\n${secret}\n<<END-DATA-0123456789abcdef>>`, null),
        jsonSchema: { type: 'object' },
        maxTurns: 1,
        wallClockMs: 15_000,
        toolServer: null,
        observedVersion: '2.1.258',
      },
      new AbortController().signal,
    );
    expect(res.sandbox.initOk).toBe(false); // the proof failed (extra tool 'Bash') ...
    expect(res.sandbox.mismatch).toBe('extra_tool');
    expect(fs.existsSync(marker)).toBe(true); // ... but the process had the whole user line before the proof was read
    expect(Number(fs.readFileSync(marker, 'utf8'))).toBeGreaterThan(secret.length);
  });
});

// =====================================================================================================================
// cli-sandbox-3: the agy sign-in probe (`agy -p /usage`) runs under the user's REAL profile, not the isolated agy-home.
// =====================================================================================================================
describe('cli-sandbox-3: agy -p /usage runs in the real profile', () => {
  it('signedIn(antigravity_cli) spawns `-p /usage` with USERPROFILE/HOME/APPDATA = the real profile', async () => {
    const specs: JobSpec[] = [];
    const jobs: JobRunner = {
      async run<T>(spec: JobSpec, use: (job: JobHandle) => Promise<T>): Promise<T> {
        specs.push(spec);
        const handle: JobHandle = {
          pid: 1,
          lines: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true as const }) }) }),
          write: () => undefined,
          kill: () => undefined,
          done: Promise.resolve({ exitCode: 0, killed: false, timedOut: false, stderrMarkers: [], ms: 1 }),
        };
        return use(handle);
      },
      breaker: () => ({ open: false, failures: 0, openedAt: null }),
      resetBreaker: () => undefined,
      killAll: async () => undefined,
      jobPids: () => ({ cli: [], voice: [] }),
    };
    const locator = createCliLocator({
      statFile: () => ({ isFile: true }),
      env: { ...FAKE_ENV, TEMP: 'C:\\Users\\wca-fake-home\\AppData\\Local\\Temp' },
      runWhere: async () => [],
      settingsClaudeExePath: () => '',
      seam: null,
      jobs,
    });
    const exe = 'C:\\Users\\wca-fake-home\\AppData\\Local\\agy\\bin\\agy.exe';
    expect(await locator.signedIn('antigravity_cli', exe, new AbortController().signal)).toBe(true);
    const spec = specs[0]!;
    expect(spec.args).toEqual(['-p', '/usage', '--output-format', 'json']);
    expect(spec.env.USERPROFILE).toBe('C:\\Users\\wca-fake-home'); // NOT <userData>\agy-home
    expect(spec.env.HOME).toBe('C:\\Users\\wca-fake-home');
    expect(spec.env.APPDATA).toBe(FAKE_ENV.APPDATA);
    expect(spec.cwd).toBe('C:\\Users\\wca-fake-home\\AppData\\Local\\agy\\bin'); // not the trusted app workspace either
  });
});

// =====================================================================================================================
// cli-sandbox-4: a descendant of a job that exits normally is never tree-killed and is tracked by no pid file.
// =====================================================================================================================
describe('cli-sandbox-4: descendants of a normally-exiting job survive', () => {
  it('grandchild spawned by the job is still alive after jobs.run() resolved and the pid file is gone', async () => {
    const pidOut = path.join(tmp, 'grandchild.pid');
    const script = path.join(tmp, 'spawner.cjs');
    fs.writeFileSync(
      script,
      [
        "const { spawn } = require('child_process');",
        "const fs = require('fs');",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { detached: true, stdio: 'ignore', cwd: require('os').tmpdir() });",
        'fs.writeFileSync(process.argv[2], String(g.pid));',
        'g.unref();',
        'process.exit(0);',
      ].join('\n'),
    );
    const runDir = path.join(tmp, 'run');
    const jobs = createJobRunner({ runDir, now: () => Date.now(), log: () => undefined });
    const env: Record<string, string> = {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      windir: process.env.SystemRoot ?? 'C:\\Windows',
      TEMP: tmp,
      TMP: tmp,
      NUMBER_OF_PROCESSORS: '1',
    };
    await jobs.run(
      {
        kind: 'voice',
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
    const gpid = Number(fs.readFileSync(pidOut, 'utf8'));
    let alive = false;
    try {
      process.kill(gpid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    try {
      expect(alive).toBe(true);
      expect(fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((f) => f.endsWith('.pid.json')) : []).toEqual([]);
    } finally {
      try {
        process.kill(gpid);
      } catch {
        /* already gone */
      }
    }
  });
});

// =====================================================================================================================
// cli-sandbox-5: data:purgeNow does not reach the isolated agy profile, where agy keeps its conversation transcripts.
// =====================================================================================================================
describe('cli-sandbox-5: purgeNow skips <userData>\\agy-home', () => {
  it('PURGE_NOW_DIRS has no agy-home entry', () => {
    expect(PURGE_NOW_DIRS.some((d) => d.toLowerCase().startsWith('agy-home'))).toBe(false);
  });
});
