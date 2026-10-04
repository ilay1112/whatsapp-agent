// src/main/llm/cli/runner.test.ts - T2 5 row `llm/cli/runner.ts` (owner V2-W1-06-claude-cli). Safety-critical (T2 13: 100/95/100).
// The JobRunner is scripted here (the real process path is covered by jobRunner.test.ts and the fake-claude-cli security tests):
// init proof asserted on the FIRST event and the job killed before any later line is read; is_error FIRST; strikes; budget before spawn;
// overage pause; usage window; breaker 3 / 10 min; run dir fresh, empty and removed; cli_run audit enums/numbers only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS } from '../../../shared/types';
import {
  CLAUDE_ENV_KEYS,
  CLAUDE_S3_ENV_KEYS,
  JobAbortedError,
  JobBreakerOpenError,
  JobSpawnError,
  JobSpecError,
  type JobHandle,
  type JobRunner,
  type JobSpec,
} from '../../proc/jobRunner';
import { CLI_SCHEMA_TOOL, buildClaudeStdinLine, nameSha8, type ClaudeRunRequestExt } from './claudeCli';
import {
  NO_PROOF,
  createCliRunner,
  mapAgyError,
  mapApiRetryError,
  mapResultText,
  type CliRunBudget,
  type CliRunRequest,
} from './runner';

vi.mock('./antigravityCli', async (importOriginal) => {
  // the PURE result / exit classifiers are W1-09's real bodies (the runner must read agy's bytes exactly as they define them)
  const real = await importOriginal<typeof import('./antigravityCli')>();
  return {
    agyEventResult: real.agyEventResult,
    classifyAgyResult: real.classifyAgyResult,
    classifyAgyExit: real.classifyAgyExit,
    planAgyHome: (userDataDir: string) => ({
      homeDir: `${userDataDir}\\agy-home`,
      files: [{ path: path.join(userDataDir, 'agy-home', '.gemini', 'antigravity-cli', 'settings.json'), text: '{}' }],
      env: {},
    }),
    buildAgentFile: (stage: string, c: string) => `---\nname: wca-${stage}\n---\n${c}`,
    buildAgyArgs: (req: { stage: string }, schemaPath: string | null) => [
      '--agent',
      `wca-${req.stage}`,
      ...(schemaPath === null ? [] : ['--json-schema', schemaPath]),
    ],
    checkAgyInit: (init: unknown) => {
      const ok = typeof init === 'object' && init !== null && (init as { agent?: unknown }).agent === 'wca-extract';
      return {
        initOk: ok,
        toolsCount: 0,
        mcpServers: 0,
        apiKeySource: 'unknown',
        mismatch: ok ? null : 'agent_mismatch',
      };
    },
  };
});

// ---------------------------------------------------------------------------------------------------------------------
// scripted JobRunner
// ---------------------------------------------------------------------------------------------------------------------
interface Script {
  lines: string[];
  exitCode?: number | null;
  timedOut?: boolean;
  /** the JobRunner's marker-only stderr view (JOB_STDERR_MARKERS names) */
  stderrMarkers?: string[];
  throwOnRun?: Error;
  /** a hook run when the runner pulls line index i (0-based) */
  onPull?: (i: number) => void;
}
interface ScriptedJobs extends JobRunner {
  specs: JobSpec[];
  pulled: number[];
  kills: number;
  runDirsSeen: Array<{ cwd: string; exists: boolean; empty: boolean }>;
}
function scriptedJobs(next: () => Script): ScriptedJobs {
  const jobs: ScriptedJobs = {
    specs: [],
    pulled: [],
    kills: 0,
    runDirsSeen: [],
    async run<T>(spec: JobSpec, use: (job: JobHandle) => Promise<T>, signal: AbortSignal): Promise<T> {
      const script = next();
      if (script.throwOnRun) throw script.throwOnRun;
      if (signal.aborted) throw new JobAbortedError();
      jobs.specs.push(spec);
      jobs.runDirsSeen.push({
        cwd: spec.cwd,
        exists: fs.existsSync(spec.cwd),
        empty: fs.existsSync(spec.cwd)
          ? fs.readdirSync(spec.cwd).filter((f) => f !== 'wca.mcp.json').length === 0
          : false,
      });
      let killed = false;
      let pulled = 0;
      const handle: JobHandle = {
        pid: 4242,
        lines: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (killed || pulled >= script.lines.length) return { value: undefined, done: true as const };
              script.onPull?.(pulled);
              const value = script.lines[pulled] as string;
              pulled += 1;
              return { value, done: false as const };
            },
          }),
        }),
        write: () => undefined,
        kill: () => {
          if (!killed) jobs.kills += 1;
          killed = true;
        },
        get done() {
          return Promise.resolve({
            exitCode: killed ? null : (script.exitCode ?? 0),
            killed,
            timedOut: script.timedOut ?? false,
            stderrMarkers: script.stderrMarkers ?? [],
            ms: 7,
          });
        },
      };
      try {
        return await use(handle);
      } finally {
        jobs.pulled.push(pulled);
      }
    },
    breaker: () => ({ open: false, failures: 0, openedAt: null }),
    resetBreaker: () => undefined,
    killAll: async () => undefined,
    jobPids: () => ({ cli: [], voice: [] }),
  };
  return jobs;
}

// ---------------------------------------------------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------------------------------------------------
const j = (o: unknown): string => JSON.stringify(o);
const init = (over: Record<string, unknown> = {}): string =>
  j({
    type: 'system',
    subtype: 'init',
    session_id: 'fake-1',
    apiKeySource: 'none',
    tools: [CLI_SCHEMA_TOOL],
    mcp_servers: [],
    mcp_server_errors: [],
    plugins: [],
    slash_commands: [],
    ...over,
  });
const s3init = (over: Record<string, unknown> = {}): string =>
  init({
    tools: ['mcp__wca__get_current_time', 'mcp__wca__get_freebusy'],
    mcp_servers: [{ name: 'wca', status: 'connected' }],
    ...over,
  });
const toolUse = (name: string): string =>
  j({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 't', name, input: {} },
      ],
    },
  });
const result = (over: Record<string, unknown> = {}): string =>
  j({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    session_id: 'fake-1',
    stop_reason: 'end_turn',
    num_turns: 1,
    duration_ms: 1000,
    usage: { input_tokens: 11, output_tokens: 22 },
    permission_denials: [],
    uuid: 'fake-u',
    ...over,
  });

let userData: string;
let clockNow: number;
let audits: Array<{ kind: string; ref: string | null; detail: Record<string, unknown> }>;
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-runner-'));
  clockNow = 1_800_000_000_000;
  audits = [];
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

function req(over: Partial<ClaudeRunRequestExt> = {}): ClaudeRunRequestExt {
  return {
    provider: 'claude_cli',
    stage: 'extract',
    exePath: 'C:\\fakehome\\.local\\bin\\claude.exe',
    model: 'sonnet',
    system: 'SYSTEM CONSTANT',
    stdinLine: buildClaudeStdinLine('<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>', null),
    jsonSchema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] },
    maxTurns: 1,
    wallClockMs: LIMITS.cliWallClockExtractMs,
    toolServer: null,
    observedVersion: '2.1.258',
    ...over,
  };
}
const s3req = (over: Partial<ClaudeRunRequestExt> = {}): ClaudeRunRequestExt =>
  req({
    stage: 'draft',
    jsonSchema: null,
    maxTurns: 5,
    wallClockMs: LIMITS.cliWallClockDraftMs,
    toolServer: { url: 'http://127.0.0.1:50123/mcp', token: 'TOKEN-abcdefghijklmnopqrstuvwxyz0123456789' },
    exposedNames: ['get_current_time', 'get_freebusy'],
    runId: 7,
    auditRef: '42',
    ...over,
  });

function mk(scripts: Script[] | (() => Script), extra: Partial<Parameters<typeof createCliRunner>[0]> = {}) {
  const queue = Array.isArray(scripts) ? [...scripts] : null;
  const jobs = scriptedJobs(() => (queue ? (queue.shift() ?? { lines: [] }) : (scripts as () => Script)()));
  const runner = createCliRunner({
    jobs,
    userDataDir: userData,
    now: () => clockNow,
    audit: (kind, ref, detail) => audits.push({ kind, ref, detail }),
    processEnv: {
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\wca-fake-home',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\wca-fake-home',
      APPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Local',
      ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-planted',
      CLAUDE_CONFIG_DIR: 'C:\\evil',
      HTTPS_PROXY: 'http://evil.example',
    },
    ...extra,
  });
  return { runner, jobs };
}
const signal = (): AbortSignal => new AbortController().signal;

// ---------------------------------------------------------------------------------------------------------------------
describe('pure mappers', () => {
  it('mapApiRetryError', () => {
    expect(mapApiRetryError('authentication_failed')).toBe('auth');
    expect(mapApiRetryError('oauth_org_not_allowed')).toBe('auth');
    expect(mapApiRetryError('account_on_hold')).toBe('account_hold');
    expect(mapApiRetryError('rate_limit')).toBe('rate_limited');
    expect(mapApiRetryError('overloaded')).toBe('rate_limited');
    expect(mapApiRetryError('model_not_found')).toBe('model_not_found');
    expect(mapApiRetryError('billing_error')).toBe('billing');
    expect(mapApiRetryError('server_error')).toBeNull();
    expect(mapApiRetryError(undefined)).toBeNull();
  });
  it('mapResultText', () => {
    expect(mapResultText("You've hit your session limit")).toBe('usage_limit');
    expect(mapResultText('Credit balance is too low')).toBe('usage_limit');
    expect(mapResultText('Not logged in · Please run /login')).toBe('not_logged_in');
    expect(mapResultText('Your account is on hold')).toBe('account_hold');
    expect(mapResultText('claude-x is not a recognized model id')).toBe('model_not_found');
    expect(mapResultText('API Error: Rate limit reached')).toBe('rate_limited');
    expect(mapResultText('API Error: Repeated 529 Overloaded errors')).toBe('overloaded');
    expect(mapResultText('something else')).toBe('bad_output');
  });
  it('mapAgyError', () => {
    expect(mapAgyError('AGY_ERROR: RESOURCE_EXHAUSTED')).toBe('usage_limit');
    expect(mapAgyError('AGY_ERROR: 429 too many')).toBe('usage_limit');
    expect(mapAgyError('AGY_ERROR: authentication needed')).toBe('not_logged_in');
    expect(mapAgyError('AGY_ERROR: boom')).toBe('network');
  });
});

describe('spawn spec: argv, env, stdin, run dir (claude)', () => {
  it('S1: literal env key set (no token, no planted secrets), stdin = one line + newline, fresh empty run dir removed after', async () => {
    const { runner, jobs } = mk([{ lines: [init(), result({ structured_output: { a: 'x' } })] }]);
    const res = await runner.run(req(), signal());
    expect(res.error).toBeNull();
    expect(res.structured).toEqual({ a: 'x' });
    const spec = jobs.specs[0]!;
    expect(Object.keys(spec.env).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(spec.env.PATH).toBe('C:\\Windows\\System32');
    expect(spec.env.TEMP).toBe(spec.cwd);
    expect(spec.env.TMP).toBe(spec.cwd);
    expect(JSON.stringify(spec.env)).not.toMatch(/TESTONLY|evil/);
    expect(spec.cwd.startsWith(path.join(userData, 'cli-runs') + path.sep)).toBe(true);
    expect(jobs.runDirsSeen[0]).toEqual({ cwd: spec.cwd, exists: true, empty: true });
    expect(fs.existsSync(spec.cwd)).toBe(false);
    expect(new TextDecoder().decode(spec.stdin as Uint8Array)).toBe(`${req().stdinLine}\n`);
    expect(spec).toMatchObject({ kind: 'cli', stdout: 'ndjson', belowNormal: false, graceMs: LIMITS.cliKillGraceMs });
    expect(spec.args).not.toContain('--mcp-config');
    expect(spec.args.join(' ')).not.toMatch(/DATA-/);
  });

  it('S3 inline_env: WCA_MCP_TOKEN only in env, never in argv; the argv carries the literal ${WCA_MCP_TOKEN}', async () => {
    const r = s3req();
    const { runner, jobs } = mk([{ lines: [s3init(), result({ result: 'Sure, 17:00 works.' })] }]);
    const res = await runner.run(r, signal());
    expect(res).toMatchObject({ error: null, text: 'Sure, 17:00 works.', stopReason: 'end' });
    const spec = jobs.specs[0]!;
    expect(Object.keys(spec.env).sort()).toEqual([...CLAUDE_S3_ENV_KEYS].sort());
    expect(spec.env.WCA_MCP_TOKEN).toBe(r.toolServer!.token);
    expect(spec.args.join('\u0000')).not.toContain(r.toolServer!.token);
    expect(spec.args.join(' ')).toContain('Bearer ${WCA_MCP_TOKEN}');
    expect(JSON.stringify(audits)).not.toContain(r.toolServer!.token);
  });

  it('S3 run_file (F16): the token is in <runDir>\\wca.mcp.json only, argv names that file, env has no token, file removed', async () => {
    const r = s3req();
    let fileText: string | null = null;
    const { runner, jobs } = mk(
      [
        {
          lines: [s3init(), result({ result: 'ok' })],
          onPull: (i) => {
            if (i === 0) fileText = fs.readFileSync(path.join(jobs.specs[0]!.cwd, 'wca.mcp.json'), 'utf8');
          },
        },
      ],
      { mcpConfigMode: 'run_file' },
    );
    await runner.run(r, signal());
    const spec = jobs.specs[0]!;
    const i = spec.args.indexOf('--mcp-config');
    expect(spec.args[i + 1]).toBe(path.join(spec.cwd, 'wca.mcp.json'));
    expect(spec.args.join('\u0000')).not.toContain(r.toolServer!.token);
    expect(Object.keys(spec.env).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(fileText).toContain(`Bearer ${r.toolServer!.token}`);
    expect(fs.existsSync(spec.cwd)).toBe(false);
  });

  it('the e2e argv prefix goes before the production argv; graceMs seam applies', async () => {
    const { runner, jobs } = mk([{ lines: [init(), result({ structured_output: { a: '1' } })] }], {
      argsPrefix: (exe) => (exe === 'C:\\node.exe' ? ['C:\\app\\tests\\fakes\\fake-claude-cli.mjs', '--fake-end'] : []),
      graceMs: 5,
    });
    await runner.run(req({ exePath: 'C:\\node.exe' }), signal());
    expect(jobs.specs[0]!.args.slice(0, 3)).toEqual(['C:\\app\\tests\\fakes\\fake-claude-cli.mjs', '--fake-end', '-p']);
    expect(jobs.specs[0]!.graceMs).toBe(5);
  });

  it('a run dir that is not empty is refused (no job); a failing rm never throws', async () => {
    const writes: string[] = [];
    const { runner, jobs } = mk([{ lines: [init(), result({ structured_output: {} })] }], {
      randomId: () => 'fixed',
      fs: {
        mkdirSync: () => undefined,
        readdirSync: () => ['leftover'],
        writeFileSync: (p) => writes.push(p),
        rmSync: () => {
          throw new Error('locked');
        },
      },
    });
    const res = await runner.run(req(), signal());
    expect(res.error).toBe('not_ready');
    expect(jobs.specs).toHaveLength(0);
  });
});

describe('init proof (I11): fail closed on the FIRST event, killed before any turn', () => {
  it.each<[string, string, string]>([
    ['extra tool', init({ tools: [CLI_SCHEMA_TOOL, 'Bash'] }), 'extra_tool'],
    [
      'extra server (claude.ai connector)',
      init({ mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }] }),
      'extra_server',
    ],
    ['plugins', init({ plugins: [{ name: 'x' }] }), 'extra_tool'],
    ['server errors', init({ mcp_server_errors: [{ server: 'x' }] }), 'server_error'],
    ['api key source', init({ apiKeySource: 'ANTHROPIC_API_KEY' }), 'api_key_auth'],
  ])('%s => toolset_mismatch audit, kill, sandbox error, only ONE line read', async (_n, first, mismatch) => {
    const { runner, jobs } = mk([{ lines: [first, toolUse('Bash'), result({ structured_output: { a: 'x' } })] }]);
    const res = await runner.run(req(), signal());
    expect(res.sandbox.initOk).toBe(false);
    expect(res.sandbox.mismatch).toBe(mismatch);
    expect(res).toMatchObject({ error: 'sandbox', stopReason: 'killed', structured: null, text: null });
    expect(jobs.kills).toBe(1);
    expect(jobs.pulled).toEqual([1]);
    expect(audits.find((a) => a.kind === 'toolset_mismatch')?.detail).toEqual({
      provider: 'claude_cli',
      stage: 'extract',
      reason: mismatch,
    });
    expect(audits.find((a) => a.kind === 'cli_run')?.detail).toMatchObject({ initOk: false, stopReason: 'killed' });
  });

  it('init_not_first / no_init => fail closed (reason no_init), NO_PROOF when nothing arrived', async () => {
    const a = mk([{ lines: [toolUse('mcp__wca__x'), init()] }]);
    const r1 = await a.runner.run(req(), signal());
    expect(r1).toMatchObject({ error: 'sandbox', stopReason: 'killed' });
    expect(audits.find((x) => x.kind === 'toolset_mismatch')?.detail.reason).toBe('no_init');
    const b = mk([{ lines: ['not json', '{"broken":'] }]);
    const r2 = await b.runner.run(req(), signal());
    expect(r2.sandbox).toEqual(NO_PROOF);
    expect(r2.error).toBe('sandbox');
  });

  it('StructuredOutput is accepted on schema runs and its tool_use is never a strike (F13); on S3 it is a mismatch', async () => {
    const { runner } = mk([
      { lines: [init(), toolUse(CLI_SCHEMA_TOOL), result({ structured_output: { a: 'x' } })] },
      { lines: [s3init({ tools: [CLI_SCHEMA_TOOL] }), result({ result: 'x' })] },
    ]);
    const ok = await runner.run(req(), signal());
    expect(ok).toMatchObject({ error: null, blockedCalls: 0 });
    expect(audits.some((a) => a.kind === 'tool_blocked')).toBe(false);
    const bad = await runner.run(s3req(), signal());
    expect(bad.sandbox).toMatchObject({ initOk: false, mismatch: 'extra_tool' });
  });

  it('S3 no_tools (init.tools empty with the wca server) is not a breach: runs tool-less, sandbox ok', async () => {
    const { runner } = mk([{ lines: [s3init({ tools: [] }), result({ result: 'draft' })] }]);
    const res = await runner.run(s3req(), signal());
    expect(res).toMatchObject({ error: null, toolCalls: 0, text: 'draft' });
    expect(res.sandbox.initOk).toBe(true);
  });

  it('three init failures in 10 minutes open the breaker (CLI_UNSTABLE): the 4th run spawns nothing; resetBreaker closes it', async () => {
    const { runner, jobs } = mk(() => ({ lines: [init({ tools: ['Bash'] })] }));
    for (let i = 0; i < LIMITS.cliBreakerFailures; i++) await runner.run(req(), signal());
    expect(runner.breakerOpen()).toBe(true);
    expect(runner.health()).toEqual({ code: 'CLI_UNSTABLE', retryAtMs: null });
    const spawns = jobs.specs.length;
    const r = await runner.run(req(), signal());
    expect(r.error).toBe('not_ready');
    expect(jobs.specs.length).toBe(spawns);
    runner.resetBreaker();
    expect(runner.breakerOpen()).toBe(false);
    expect(runner.health()).toBeNull();
  });

  it('failures older than the window do not count', async () => {
    const { runner } = mk(() => ({ lines: [init({ tools: ['Bash'] })] }));
    await runner.run(req(), signal());
    await runner.run(req(), signal());
    clockNow += LIMITS.cliBreakerWindowMs + 1;
    await runner.run(req(), signal());
    expect(runner.breakerOpen()).toBe(false);
  });
});

describe('strikes (non-mcp__wca__ tool_use, permission_denials)', () => {
  it('each unknown tool_use is audited by sha8 + length only; the 2nd strike kills the run (onStrike from the RunCtx)', async () => {
    let ctxStrikes = 0;
    const r = s3req({
      onStrike: () => {
        ctxStrikes += 1;
        return ctxStrikes >= LIMITS.blockedCallsAbort;
      },
    });
    const { runner, jobs } = mk([
      {
        lines: [
          s3init(),
          toolUse('mcp__wca__get_current_time'),
          toolUse('Bash'),
          toolUse('mcp__gmail__send_message'),
          toolUse('Read'),
          result({ result: 'x' }),
        ],
      },
    ]);
    const res = await runner.run(r, signal());
    expect(res).toMatchObject({ stopReason: 'killed', error: null, toolCalls: 1, blockedCalls: 2 });
    expect(jobs.kills).toBe(1);
    const blocked = audits.filter((a) => a.kind === 'tool_blocked').map((a) => a.detail);
    expect(blocked).toEqual([
      { nameSha8: nameSha8('Bash'), nameLen: 4, verdict: 'blocked_unknown_tool', runId: 7 },
      { nameSha8: nameSha8('mcp__gmail__send_message'), nameLen: 24, verdict: 'blocked_unknown_tool', runId: 7 },
    ]);
    expect(JSON.stringify(audits)).not.toContain('gmail');
    expect(audits.find((a) => a.kind === 'run_aborted')?.detail).toEqual({
      provider: 'claude_cli',
      stage: 'draft',
      blockedCalls: 2,
    });
  });

  it('permission_denials entries are strikes; without onStrike the runner counts itself; a missing name hashes ""', async () => {
    const { runner } = mk([
      { lines: [s3init(), result({ result: 'x', permission_denials: [{ tool_name: 'WebFetch' }] })] },
      { lines: [s3init(), result({ result: 'x', permission_denials: [{}, 'weird'] })] },
    ]);
    const one = await runner.run(s3req({ onStrike: undefined }), signal());
    expect(one).toMatchObject({ blockedCalls: 1, stopReason: 'end', text: 'x' });
    const two = await runner.run(s3req({ onStrike: undefined, runId: undefined }), signal());
    expect(two).toMatchObject({ blockedCalls: 2, stopReason: 'killed' });
    expect(audits.filter((a) => a.kind === 'tool_blocked').at(-1)?.detail).toEqual({
      nameSha8: nameSha8(''),
      nameLen: 0,
      verdict: 'blocked_unknown_tool',
      runId: null,
    });
  });

  it('on a schema run an mcp__wca__ tool_use is a strike (no MCP server exists there); malformed blocks are ignored', async () => {
    const weird = j({
      type: 'assistant',
      message: { content: ['x', { type: 'tool_use', name: 5 }, { type: 'text' }] },
    });
    const { runner } = mk([
      {
        lines: [
          init(),
          weird,
          j({ type: 'assistant', message: {} }),
          toolUse('mcp__wca__get_freebusy'),
          result({ structured_output: { a: 'x' } }),
        ],
      },
    ]);
    const res = await runner.run(req(), signal());
    expect(res.blockedCalls).toBe(1);
    expect(res.toolCalls).toBe(0);
  });
});

describe('result classification (is_error FIRST)', () => {
  const run1 = async (
    lines: string[],
    r: ClaudeRunRequestExt = req(),
    extra: Partial<Parameters<typeof createCliRunner>[0]> = {},
  ) => {
    const { runner } = mk([{ lines }], extra);
    return runner.run(r, signal());
  };

  it('is_error with subtype success (issue #79500) is a failure mapped from the text', async () => {
    const res = await run1([
      init(),
      result({ is_error: true, result: 'API Error: Rate limit reached', structured_output: { a: 'x' } }),
    ]);
    expect(res).toMatchObject({ error: 'rate_limited', structured: null });
  });

  it('api_retry errors decide the code (auth / account hold / model / rate limit), garbage lines tolerated', async () => {
    const retry = (e: string): string => j({ type: 'system', subtype: 'api_retry', attempt: 1, error: e });
    expect(
      (
        await run1([
          init(),
          'garbage',
          '\ud800',
          retry('authentication_failed'),
          result({ is_error: true, result: 'x' }),
        ])
      ).error,
    ).toBe('auth');
    expect((await run1([init(), retry('account_on_hold'), result({ is_error: true, result: 'x' })])).error).toBe(
      'account_hold',
    );
    expect((await run1([init(), retry('model_not_found'), result({ is_error: true, result: 'x' })])).error).toBe(
      'model_not_found',
    );
    expect(
      (
        await run1([
          init(),
          retry('rate_limit'),
          retry('rate_limit'),
          retry('unknown'),
          result({ is_error: true, result: 'Something' }),
        ])
      ).error,
    ).toBe('rate_limited');
    expect((await run1([init(), result({ is_error: true, result: 'Not logged in' })])).error).toBe('not_logged_in');
    expect((await run1([init(), retry('overloaded'), result({ is_error: true, result: '' })])).error).toBe(
      'rate_limited',
    );
    expect((await run1([init(), result({ is_error: true })])).error).toBe('bad_output');
  });

  it('usage limit: rate_limit_event rejected + is_error => usage_limit with resetsAt; next runs refused until resetsAt', async () => {
    const reset = Math.floor(clockNow / 1000) + 3600;
    const rle = j({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour', isUsingOverage: false },
    });
    const { runner, jobs } = mk([
      { lines: [init(), rle, result({ is_error: true, result: "You've hit your session limit" })] },
      { lines: [] },
    ]);
    const res = await runner.run(req(), signal());
    expect(res).toMatchObject({ error: 'usage_limit', quota: { resetsAt: reset * 1000, usingOverage: false } });
    expect(audits.find((a) => a.kind === 'cli_run')?.detail.usageWindowHit).toBe(true);
    expect(runner.health()).toEqual({ code: 'CLOUD_QUOTA', retryAtMs: reset * 1000 });
    expect((await runner.run(req(), signal())).error).toBe('usage_limit');
    expect(jobs.specs).toHaveLength(1);
    clockNow = reset * 1000;
    expect(runner.health()).toBeNull();
    expect(runner.lastQuota()).toEqual({ resetsAt: reset * 1000, usingOverage: false });
  });

  it('an is_error usage text without a resetsAt does not pause', async () => {
    const { runner } = mk([{ lines: [init(), result({ is_error: true, result: 'Credit balance is too low' })] }]);
    expect((await runner.run(req(), signal())).error).toBe('usage_limit');
    expect(runner.health()).toBeNull();
  });

  it('overage (isUsingOverage) kills at once and pauses the provider unless allowOverage; no further run starts while paused', async () => {
    const rle = j({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 'x', isUsingOverage: true },
    });
    let allow = false;
    const { runner, jobs } = mk(
      [
        { lines: [init(), rle, result({ structured_output: { a: 'x' } })] },
        { lines: [init(), rle, result({ structured_output: { a: 'y' } })] },
      ],
      {
        allowOverage: () => allow,
      },
    );
    const res = await runner.run(req(), signal());
    expect(res).toMatchObject({
      error: 'overage',
      stopReason: 'killed',
      quota: { resetsAt: null, usingOverage: true },
    });
    expect(runner.health()).toEqual({ code: 'CLOUD_OVERAGE', retryAtMs: null });
    expect((await runner.run(req(), signal())).error).toBe('overage');
    expect(jobs.specs).toHaveLength(1);
    allow = true; // cli:setOverage {allow:true}
    expect(runner.health()).toBeNull();
    const ok = await runner.run(req(), signal());
    expect(ok).toMatchObject({ error: null, structured: { a: 'y' } });
  });

  it('an overage pause with a resetsAt ends at resetsAt', async () => {
    const reset = Math.floor(clockNow / 1000) + 60;
    const rle = j({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: reset, isUsingOverage: true },
    });
    const { runner } = mk([{ lines: [init(), rle] }]);
    await runner.run(req(), signal());
    expect(runner.health()?.code).toBe('CLOUD_OVERAGE');
    clockNow = reset * 1000;
    expect(runner.health()).toBeNull();
  });

  it('non-success subtypes, refusal, missing structured_output', async () => {
    expect(await run1([init(), result({ subtype: 'error_max_turns' })])).toMatchObject({
      error: 'bad_output',
      stopReason: 'max_turns',
    });
    expect(await run1([init(), result({ subtype: 'error_max_structured_output_retries' })])).toMatchObject({
      error: 'bad_output',
      stopReason: 'bad_output',
    });
    expect(await run1([init(), result({ stop_reason: 'refusal', structured_output: { a: 'x' } })])).toMatchObject({
      error: 'bad_output',
    });
    expect(await run1([init(), result({ result: '' })])).toMatchObject({ error: 'bad_output' });
    const fenced = await run1([init(), result({ result: '```json\n{"a":"x"}\n```' })]);
    expect(fenced).toMatchObject({ error: null, structured: null, text: '```json\n{"a":"x"}\n```' });
  });

  it('S3: empty text => bad_output; usage mapped; malformed usage => zeros', async () => {
    expect(await run1([s3init(), result({ result: '   ' })], s3req())).toMatchObject({ error: 'bad_output' });
    expect(await run1([s3init(), result({ result: 5 })], s3req())).toMatchObject({ error: 'bad_output' });
    const u = await run1([s3init(), result({ result: 'x', usage: { input_tokens: 'a' } })], s3req());
    expect(u.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const n = await run1([s3init(), result({ result: 'x', usage: null })], s3req());
    expect(n.usage).toBeNull();
    const ok = await run1([s3init(), result({ result: 'hello' })], s3req());
    expect(ok.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it('crash mid-stream (no result) => network + breaker strike; api_retry code wins when present', async () => {
    const { runner } = mk([
      { lines: [init(), '{"type":"result","subtype":"succ'], exitCode: 1 },
      { lines: [init(), j({ type: 'system', subtype: 'api_retry', error: 'rate_limit' })], exitCode: 1 },
    ]);
    expect((await runner.run(req(), signal())).error).toBe('network');
    expect((await runner.run(req(), signal())).error).toBe('rate_limited');
  });

  it('hang => wall clock (timedOut) => network, killed, breaker strike', async () => {
    const { runner } = mk(() => ({ lines: [init()], timedOut: true, exitCode: null }));
    for (let i = 0; i < LIMITS.cliBreakerFailures; i++)
      expect(await runner.run(req(), signal())).toMatchObject({ error: 'network', stopReason: 'killed' });
    expect(runner.breakerOpen()).toBe(true);
  });

  it('abort (Pause): before start => aborted without a job; during the run => aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const a = mk([{ lines: [] }]);
    expect(await a.runner.run(req(), ac.signal)).toMatchObject({ error: 'aborted', sandbox: NO_PROOF });
    expect(a.jobs.specs).toHaveLength(0);
    const ac2 = new AbortController();
    const b = mk([
      { lines: [init(), result({ structured_output: { a: 'x' } })], onPull: (i) => i === 1 && ac2.abort() },
    ]);
    expect((await b.runner.run(req(), ac2.signal)).error).toBe('aborted');
    const ac3 = new AbortController();
    const c = mk([{ lines: [], onPull: () => undefined }]);
    const p = c.runner.run(req(), ac3.signal);
    ac3.abort();
    expect((await p).error).toBe('aborted');
  });

  it('JobRunner refusals map to provider codes', async () => {
    const cases: Array<[Error, string]> = [
      [new JobBreakerOpenError('CLI_UNSTABLE'), 'not_ready'],
      [new JobAbortedError(), 'aborted'],
      [new JobSpawnError('ENOENT'), 'not_installed'],
      [new JobSpawnError('EACCES'), 'not_ready'],
      [new JobSpecError('env_keys'), 'not_ready'],
      [new Error('other'), 'not_ready'],
    ];
    for (const [err, code] of cases) {
      const { runner } = mk([{ lines: [], throwOnRun: err }]);
      expect((await runner.run(req(), signal())).error).toBe(code);
    }
  });
});

describe('edge branches', () => {
  it('non-object JSON lines are ignored; a missing isUsingOverage is null; a result without denials; is_error without text', async () => {
    const rle = j({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1 } });
    const { runner } = mk([
      { lines: [init(), '[1,2]', '42', rle, result({ structured_output: { a: 'x' }, permission_denials: null })] },
      { lines: [init(), result({ is_error: true, result: 5 })] },
    ]);
    const a = await runner.run(req(), signal());
    expect(a).toMatchObject({ error: null, quota: { resetsAt: 1000, usingOverage: null }, blockedCalls: 0 });
    expect((await runner.run(req(), signal())).error).toBe('bad_output');
  });

  it('a strike abort without an audit ref audits run_aborted with ref null', async () => {
    const { runner } = mk([{ lines: [s3init(), toolUse('Bash'), toolUse('Read')] }]);
    await runner.run(s3req({ auditRef: undefined, onStrike: undefined }), signal());
    expect(audits.find((a) => a.kind === 'run_aborted')?.ref).toBeNull();
  });

  it('aborted before any init arrived => aborted, no breaker strike', async () => {
    const ac = new AbortController();
    const { runner } = mk([{ lines: ['garbage'], onPull: () => ac.abort() }]);
    const res = await runner.run(req(), ac.signal);
    expect(res.error).toBe('aborted');
    expect(runner.breakerOpen()).toBe(false);
  });

  it('a throwing budget rejects that run only; the chain keeps serving', async () => {
    let boom = true;
    const { runner } = mk(() => ({ lines: [init(), result({ structured_output: {} })] }), {
      budget: {
        maxRunsPerHour: () => 20,
        countSince: () => {
          if (boom) throw new Error('db locked');
          return 0;
        },
        record: () => undefined,
      },
    });
    await expect(runner.run(req(), signal())).rejects.toThrow('db locked');
    boom = false;
    expect((await runner.run(req(), signal())).error).toBeNull();
  });

  it('production defaults: process.env, node:fs run dir, random ids', async () => {
    const jobs = scriptedJobs(() => ({ lines: [init(), result({ structured_output: { a: 'x' } })] }));
    const runner = createCliRunner({ jobs, userDataDir: userData, now: () => clockNow, audit: () => undefined });
    expect((await runner.run(req(), signal())).error).toBeNull();
    expect(Object.keys(jobs.specs[0]!.env).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(fs.readdirSync(path.join(userData, 'cli-runs'))).toEqual([]);
  });
});

describe('budget, concurrency, audit row', () => {
  it('maxRunsPerHour: the 21st run in an hour is refused WITHOUT a spawn (bucket cli_global); the hour rolls', async () => {
    const hits: number[] = [];
    const budget: CliRunBudget = {
      maxRunsPerHour: () => 20,
      countSince: (since) => hits.filter((t) => t >= since).length,
      record: (at) => hits.push(at),
    };
    const { runner, jobs } = mk(() => ({ lines: [init(), result({ structured_output: { a: 'x' } })] }), { budget });
    for (let i = 0; i < 20; i++) expect((await runner.run(req(), signal())).error).toBeNull();
    const refused = await runner.run(req(), signal());
    expect(refused.error).toBe('usage_limit');
    expect(jobs.specs).toHaveLength(20);
    clockNow += 3_600_001;
    expect((await runner.run(req(), signal())).error).toBeNull();
  });

  it('the setting cannot exceed the LIMITS ceiling; the default in-memory bucket is 20/h', async () => {
    const hits: number[] = [];
    const { runner } = mk(() => ({ lines: [init(), result({ structured_output: {} })] }), {
      budget: { maxRunsPerHour: () => 10_000, countSince: () => hits.length, record: (t) => hits.push(t) },
    });
    for (let i = 0; i < LIMITS.cliRunsPerHourMax; i++) await runner.run(req(), signal());
    expect((await runner.run(req(), signal())).error).toBe('usage_limit');
    const d = mk(() => ({ lines: [init(), result({ structured_output: {} })] }));
    for (let i = 0; i < 20; i++) await d.runner.run(req(), signal());
    expect((await d.runner.run(req(), signal())).error).toBe('usage_limit');
  });

  it('two concurrent runs serialise (concurrency 1 across both CLIs)', async () => {
    const order: string[] = [];
    let n = 0;
    const { runner } = mk(() => {
      const me = ++n;
      return {
        lines: [init(), result({ structured_output: { a: String(me) } })],
        onPull: (i) => order.push(`${me}:${i}`),
      };
    });
    const [a, b] = await Promise.all([runner.run(req(), signal()), runner.run(req(), signal())]);
    expect(order).toEqual(['1:0', '1:1', '2:0', '2:1']);
    expect([a.structured, b.structured]).toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('cli_run audit detail is exactly the enum/number/boolean key set, never text', async () => {
    const { runner } = mk([
      { lines: [s3init(), toolUse('mcp__wca__get_freebusy'), result({ result: 'SENTINEL_CLI_STDOUT draft' })] },
    ]);
    await runner.run(s3req(), signal());
    const row = audits.find((a) => a.kind === 'cli_run')!;
    expect(row.ref).toBe('42');
    expect(Object.keys(row.detail).sort()).toEqual(
      [
        'blockedCalls',
        'extraServers',
        'initOk',
        'ms',
        'provider',
        'stage',
        'stopReason',
        'toolCalls',
        'toolsCount',
        'usageWindowHit',
      ].sort(),
    );
    expect(row.detail).toMatchObject({
      provider: 'claude_cli',
      stage: 'draft',
      initOk: true,
      toolsCount: 2,
      extraServers: 0,
      toolCalls: 1,
    });
    for (const v of Object.values(row.detail)) expect(['string', 'number', 'boolean']).toContain(typeof v);
    expect(JSON.stringify(audits)).not.toContain('SENTINEL');
  });
});

describe('antigravity_cli branch (lane L10 builders mocked; W1-09 owns their bodies)', () => {
  const agyReq = (over: Partial<CliRunRequest> = {}): CliRunRequest =>
    req({
      provider: 'antigravity_cli',
      exePath: 'C:\\fakehome\\AppData\\Local\\agy\\bin\\agy.exe',
      model: 'gemini-3.8-flash-high',
      ...over,
    });

  it('writes the agent file + schema.json into <userData>\\agy-workspace\\runs\\<id>, never an mcp_config.json; env = AGY list', async () => {
    let seen: string[] = [];
    const { runner, jobs } = mk([
      {
        lines: [
          j({ agent: 'wca-extract', tools: [] }),
          j({ event: 'progress' }),
          j({ event: 'result', result: { status: 'SUCCESS', structured_output: { a: 'x' }, denied_actions: [] } }),
        ],
        onPull: (i) => {
          if (i === 0) {
            const cwd = jobs.specs[0]!.cwd;
            seen = fs.readdirSync(cwd, { recursive: true }).map(String).sort();
          }
        },
      },
    ]);
    const res = await runner.run(agyReq(), signal());
    expect(res).toMatchObject({ error: null, structured: { a: 'x' } });
    const spec = jobs.specs[0]!;
    expect(spec.cwd.startsWith(path.join(userData, 'agy-workspace', 'runs') + path.sep)).toBe(true);
    expect(seen).toEqual([
      '.agents',
      path.join('.agents', 'agents'),
      path.join('.agents', 'agents', 'wca-extract.md'),
      'schema.json',
    ]);
    expect(seen.join()).not.toContain('mcp_config');
    expect(Object.keys(spec.env).sort()).toEqual(
      [
        'AGY_CLI_DISABLE_AUTO_UPDATE',
        'APPDATA',
        'HOME',
        'LOCALAPPDATA',
        'PATH',
        'SystemRoot',
        'TEMP',
        'TMP',
        'USERPROFILE',
      ].sort(),
    );
    expect(spec.env.USERPROFILE).toBe(`${userData}\\agy-home`);
    expect(spec.args).toEqual(['--agent', 'wca-extract', '--json-schema', path.join(spec.cwd, 'schema.json')]);
    expect(fs.existsSync(spec.cwd)).toBe(false);
  });

  it('agy result table and error lines', async () => {
    const ok0 = j({ agent: 'wca-extract', tools: [] });
    const res = (r: Record<string, unknown>): string => j({ event: 'result', result: r });
    const cases: Array<[Script, string | null]> = [
      [{ lines: [ok0, res({ status: 'SUCCESS', structured_output: { a: 1 }, denied_actions: [] })] }, null],
      [{ lines: [ok0, res({ status: 'SUCCESS', structured_output: { a: 1 } })] }, null],
      [{ lines: [ok0, res({ status: 'WAITING', structured_output: {} })] }, 'bad_output'],
      [{ lines: [ok0, res({ status: 'SUCCESS', structured_output: {}, denied_actions: ['x'] })] }, 'bad_output'],
      [{ lines: [ok0, res({ status: 'SUCCESS', structured_output: {}, denied_actions: 'x' })] }, 'bad_output'],
      [{ lines: [ok0, res({ status: 'SUCCESS' })] }, 'bad_output'],
      [{ lines: [ok0, res({ status: 'SUCCESS', structured_output: null })] }, 'bad_output'],
      // a top-level status object is NOT the agy result envelope (research 5.3): no result => a failed run
      [{ lines: [ok0, j({ status: 'SUCCESS', structured_output: { a: 1 } })] }, 'network'],
      // error exits from the marker-only STDERR view (agy prints AGY_ERROR / auth prompts on stderr, research 5.6)
      [{ lines: [ok0], exitCode: 3, stderrMarkers: ['agy_error', 'quota'] }, 'usage_limit'],
      [{ lines: [ok0], exitCode: 3, stderrMarkers: ['agy_error', 'http_429'] }, 'usage_limit'],
      [{ lines: [ok0], exitCode: 3, stderrMarkers: ['agy_error', 'auth_required'] }, 'not_logged_in'],
      [{ lines: [ok0], exitCode: 3, stderrMarkers: ['agy_error'] }, 'network'],
      [{ lines: [ok0], exitCode: 1, stderrMarkers: ['auth_required'] }, 'not_logged_in'],
      [{ lines: [ok0], exitCode: 1, stderrMarkers: ['malformed_input'] }, 'not_ready'],
      // the non-JSON stdout fallback (format UNVERIFIED, U-A3)
      [{ lines: [ok0, 'AGY_ERROR: RESOURCE_EXHAUSTED'], exitCode: 3 }, 'usage_limit'],
      [{ lines: [ok0, 'Error: authentication required'], exitCode: 1 }, 'not_logged_in'],
      [{ lines: [ok0], exitCode: 2 }, 'network'],
      [{ lines: [j({ agent: 'someone-else' })] }, 'sandbox'],
    ];
    for (const [script, code] of cases) {
      const { runner } = mk([script]);
      expect((await runner.run(agyReq(), signal())).error).toBe(code);
    }
  });

  it('agy refusals BEFORE any init come from the stderr markers: not signed in / refused stdin / AGY_ERROR; no proof, no breaker strike', async () => {
    const cases: Array<[Script, string]> = [
      [{ lines: [], exitCode: 1, stderrMarkers: ['auth_required'] }, 'not_logged_in'],
      [{ lines: [], exitCode: 1, stderrMarkers: ['malformed_input'] }, 'not_ready'],
      [{ lines: [], exitCode: 2, stderrMarkers: ['malformed_input'] }, 'not_ready'],
      [{ lines: ['not json'], exitCode: 3, stderrMarkers: ['agy_error', 'quota'] }, 'usage_limit'],
    ];
    for (const [script, code] of cases) {
      const { runner } = mk(Array.from({ length: 6 }, () => script));
      for (let i = 0; i < 6; i += 1) {
        const r = await runner.run(agyReq(), signal());
        expect(r).toMatchObject({ error: code, structured: null, stopReason: 'bad_output', sandbox: NO_PROOF });
      }
      expect(runner.breakerOpen()).toBe(false);
    }
    // a pre-init exit WITHOUT a known marker stays a failed proof (sandbox) and counts for the breaker
    const { runner } = mk([{ lines: [], exitCode: 1, stderrMarkers: [] }]);
    expect((await runner.run(agyReq(), signal())).error).toBe('sandbox');
    // the same markers on a CLAUDE run are never read as agy states
    const c = mk([{ lines: [], exitCode: 1, stderrMarkers: ['malformed_input'] }]);
    expect((await c.runner.run(req(), signal())).error).toBe('sandbox');
  });

  it('read_image is never sent to agy (capabilities.images:false) and a schema-less run writes no schema.json', async () => {
    const a = mk([{ lines: [] }]);
    expect((await a.runner.run(agyReq({ stage: 'read_image' }), signal())).error).toBe('unsupported');
    expect(a.jobs.specs).toHaveLength(0);
    const b = mk(
      [
        {
          lines: [
            j({ agent: 'wca-extract', tools: [] }),
            j({ event: 'result', result: { status: 'SUCCESS', structured_output: { reply: 'x' } } }),
          ],
        },
      ],
      {
        processEnv: {},
      },
    );
    await b.runner.run(agyReq({ jsonSchema: null }), signal());
    expect(b.jobs.specs[0]!.args).toEqual(['--agent', 'wca-extract']);
    expect(b.jobs.specs[0]!.env.SystemRoot).toBe('C:\\Windows');
  });
});
