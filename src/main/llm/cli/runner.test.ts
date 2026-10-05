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
  classifyErrorBeforeInit,
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
    // [agy-provider-fix] the policy checker and the runtime tool watch are W1-09's real bodies as well
    checkAgyPolicy: real.checkAgyPolicy,
    agyStepVerdict: real.agyStepVerdict,
    planAgyHome: (userDataDir: string, workspaceDir: string) => ({
      homeDir: `${userDataDir}\\agy-home`,
      files: [
        {
          path: path.join(userDataDir, 'agy-home', '.gemini', 'antigravity-cli', 'settings.json'),
          text: real.planAgyHome(userDataDir, workspaceDir).files[0]!.text,
        },
      ],
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

  it.each<[string, string]>([
    ['api_key_auth', init({ apiKeySource: 'ANTHROPIC_API_KEY' })],
    ['extra_server', init({ mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }] })],
  ])(
    '[cli-sandbox-2] %s pauses THAT provider on the FIRST failure (stdin already went out at spawn): no further spawn until resetBreaker',
    async (_m, bad) => {
      const { runner, jobs } = mk(() => ({ lines: [bad] }));
      const first = await runner.run(req(), signal());
      expect(first).toMatchObject({ error: 'sandbox' });
      expect(jobs.specs.length).toBe(1);
      // the next run (and a repair retry) carries no user data to the CLI: refused without a spawn, still 'sandbox'
      const second = await runner.run(req(), signal());
      expect(second).toMatchObject({ error: 'sandbox', sandbox: NO_PROOF, structured: null, text: null });
      expect(jobs.specs.length).toBe(1);
      // the other CLI is not paused by claude's identity change (it still spawns; its own proof decides its run)
      await runner.run(req({ provider: 'antigravity_cli', exePath: 'C:\\x\\agy.exe' }), signal());
      expect(jobs.specs.length).toBe(2);
      // only the user's "Test again" (resetBreaker) lets claude spawn again
      runner.resetBreaker();
      await runner.run(req(), signal());
      expect(jobs.specs.length).toBe(3);
    },
  );

  it('[cli-sandbox-2] a possibly transient mismatch (server_error / no_init) keeps the 3-strike rule: the 2nd run spawns', async () => {
    const { runner, jobs } = mk(() => ({ lines: [init({ mcp_server_errors: [{ server: 'x' }] })] }));
    await runner.run(req(), signal());
    await runner.run(req(), signal());
    expect(jobs.specs.length).toBe(2);
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

  it('[cli-sandbox-1 / injection-v2-2, B17] S3: an mcp__wca__ name OUTSIDE exposedNames is a strike (the CLI answers it locally, the gate never sees it); only exposed names count as tool calls', async () => {
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
          toolUse('mcp__wca__get_freebusy'),
          toolUse('mcp__wca__send_message'), // never a wca tool at all
          toolUse('mcp__wca__GET_FREEBUSY'), // case-sensitive like the ToolGate
          result({ result: 'x' }),
        ],
      },
    ]);
    const res = await runner.run(r, signal());
    expect(res).toMatchObject({ toolCalls: 1, blockedCalls: 2, stopReason: 'killed', error: null });
    expect(ctxStrikes).toBe(2);
    expect(jobs.kills).toBe(1);
    expect(audits.filter((a) => a.kind === 'tool_blocked').map((a) => a.detail)).toEqual([
      { nameSha8: nameSha8('mcp__wca__send_message'), nameLen: 22, verdict: 'blocked_unknown_tool', runId: 7 },
      { nameSha8: nameSha8('mcp__wca__GET_FREEBUSY'), nameLen: 22, verdict: 'blocked_unknown_tool', runId: 7 },
    ]);
    expect(JSON.stringify(audits)).not.toContain('send_message');

    // trigger_chat scope: wa_list_chats is a real wca tool but NOT exposed in this run => one strike, the run continues.
    const one = mk([
      {
        lines: [
          s3init(),
          toolUse('mcp__wca__wa_list_chats'),
          toolUse('mcp__wca__get_current_time'),
          result({ result: 'ok' }),
        ],
      },
    ]);
    const res2 = await one.runner.run(s3req({ onStrike: undefined }), signal());
    expect(res2).toMatchObject({ toolCalls: 1, blockedCalls: 1, stopReason: 'end', text: 'ok' });
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

// [claude-extract-debug] Live 2.1.258 (synthetic S1 capture): the model wraps the whole answer in ONE `$PARAMETER_NAME` key of the
// StructuredOutput call; the CLI rejects it with an is_error tool_result and, once --max-turns is used, ends with subtype
// error_max_turns + is_error true and NO structured_output. The run's answer is the wrapped object (callers still zod-validate it).
describe('[claude-extract-debug] StructuredOutput $PARAMETER_NAME wrapper', () => {
  const soCall = (input: unknown, id = 't'): string =>
    j({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: CLI_SCHEMA_TOOL, input }] } });
  const soReject = (id = 't'): string =>
    j({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: id, is_error: true, content: 'Output does not match required schema' },
        ],
      },
    });
  const maxTurnsEnd = (n: number): string =>
    result({
      subtype: 'error_max_turns',
      is_error: true,
      result: undefined,
      stop_reason: 'tool_use',
      num_turns: n + 1,
      errors: [`Reached maximum number of turns (${n})`],
    });
  const run1 = async (lines: string[], r: ClaudeRunRequestExt = req()) => {
    const { runner } = mk([{ lines }]);
    return runner.run(r, signal());
  };

  it('error_max_turns + is_error after a single-key wrapper => the wrapped object, no error, no strike', async () => {
    const res = await run1([init(), soCall({ $PARAMETER_NAME: { a: 'x' } }), soReject(), maxTurnsEnd(1)]);
    expect(res).toMatchObject({ error: null, stopReason: 'end', structured: { a: 'x' }, blockedCalls: 0 });
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it('the tool-name wrapper {"StructuredOutput": {...}} (live variant) is unwrapped the same way', async () => {
    const res = await run1([init(), soCall({ StructuredOutput: { a: 'x' } }), soReject(), maxTurnsEnd(1)]);
    expect(res).toMatchObject({ error: null, structured: { a: 'x' } });
  });

  it('a partial answer (one declared field) is never a wrapper', async () => {
    const res = await run1([init(), soCall({ a: 'x' }), soReject(), maxTurnsEnd(1)]);
    expect(res).toMatchObject({ error: 'bad_output', structured: null });
  });

  it('two attempts: the LAST unwrappable attempt wins', async () => {
    const res = await run1(
      [
        init(),
        soCall({ $PARAMETER_NAME: { a: 'first' } }, 't1'),
        soReject('t1'),
        soCall({ $PARAMETER_NAME: { a: 'second' } }, 't2'),
        soReject('t2'),
        maxTurnsEnd(2),
      ],
      req({ maxTurns: 2 }),
    );
    expect(res).toMatchObject({ error: null, structured: { a: 'second' } });
  });

  it('a split answer over two placeholder keys is NOT salvaged (bad_output, as before)', async () => {
    const res = await run1([
      init(),
      soCall({ $PARAMETER_NAME: { a: 'x' }, $PARAMETER_NAME2: { b: 1 } }),
      soReject(),
      maxTurnsEnd(1),
    ]);
    expect(res).toMatchObject({ error: 'bad_output', structured: null });
  });

  it('structured_output always wins over a wrapper of an earlier attempt', async () => {
    const res = await run1([
      init(),
      soCall({ $PARAMETER_NAME: { a: 'wrapped' } }, 't1'),
      soReject('t1'),
      soCall({ a: 'clean' }, 't2'),
      result({ structured_output: { a: 'clean' }, stop_reason: 'tool_use', num_turns: 3 }),
    ]);
    expect(res).toMatchObject({ error: null, structured: { a: 'clean' } });
  });

  it('success without structured_output falls back to the wrapper before the text path', async () => {
    const res = await run1([init(), soCall({ $PARAMETER_NAME: { a: 'x' } }), soReject(), result({ result: 'prose' })]);
    expect(res).toMatchObject({ error: null, structured: { a: 'x' }, text: null });
  });

  it('never salvages a real error: is_error with another subtype, a usage-window hit, or an S3 draft', async () => {
    const wrapped = soCall({ $PARAMETER_NAME: { a: 'x' } });
    expect(
      await run1([init(), wrapped, result({ is_error: true, result: 'API Error: Rate limit reached' })]),
    ).toMatchObject({
      error: 'rate_limited',
      structured: null,
    });
    const rejected = j({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: null } });
    expect(await run1([init(), wrapped, rejected, maxTurnsEnd(1)])).toMatchObject({
      error: 'usage_limit',
      structured: null,
    });
    // S3 (jsonSchema null): StructuredOutput is not an allowed tool there - a strike, never an answer
    const s3 = await run1([s3init(), wrapped, maxTurnsEnd(1)], s3req());
    expect(s3.structured).toBeNull();
    expect(s3.blockedCalls).toBe(1);
  });

  it('a tool other than StructuredOutput on a schema run is still a strike (multi-turn changes nothing)', async () => {
    const res = await run1(
      [init(), soCall({ $PARAMETER_NAME: { a: 'x' } }), toolUse('Bash'), toolUse('Read'), maxTurnsEnd(2)],
      req({ maxTurns: 2 }),
    );
    expect(res.blockedCalls).toBe(2);
    expect(res.stopReason).toBe('killed');
    expect(res.structured).toBeNull();
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

  it('writes the agent file (schema in its body, no schema.json) into <userData>\\agy-workspace\\runs\\<id>, never an mcp_config.json; env = AGY list', async () => {
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
    expect(seen).toEqual(['.agents', path.join('.agents', 'agents'), path.join('.agents', 'agents', 'wca-extract.md')]); // [agy-schema-loop] no schema.json and no --json-schema
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
    expect(spec.args).toEqual(['--agent', 'wca-extract']);
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

// ---------------------------------------------------------------------------------------------------------------------
// [agy-provider-fix] agy 1.2.16 lists all 60 tools in init.tools, so the I11 proof of an agy run rests on (A) the deny-all permissions
// policy re-read before every spawn, (C) the runtime tool watch on every step_update, and the agent file's tools: [].
// ---------------------------------------------------------------------------------------------------------------------
describe('[agy-provider-fix] deny-all policy (A), runtime tool watch (C), nested 1.2.16 result (D), print timeout', () => {
  const agyReq = (over: Partial<CliRunRequest> = {}): CliRunRequest =>
    req({
      provider: 'antigravity_cli',
      exePath: 'C:\\fakehome\\AppData\\Local\\agy\\bin\\agy.exe',
      model: 'gemini-3.8-flash-high',
      ...over,
    });
  const ok0 = j({ agent: 'wca-extract', tools: [] });
  const step = (s: Record<string, unknown>): string =>
    j({ event: 'step_update', step_update: { conversation_id: 'c', step_index: 1, ...s } });
  const toolStep = (name: string, parameters: unknown, state = 'ACTIVE'): string =>
    step({ state, step_type: 'tool', tool_name: name, tool_info: { name, parameters, output: 'o' } });
  const listStep = (state: string): string => toolStep('manage_task', { Action: 'list' }, state);
  const answer = (response: string): string =>
    j({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response, num_turns: 2, usage: {} } });
  const settingsPath = (): string => path.join(userData, 'agy-home', '.gemini', 'antigravity-cli', 'settings.json');
  /** node:fs with one tamper hook on the isolated settings.json (simulates a failed / altered write). */
  const tamperFs = (tamper: (text: string) => string | null) => ({
    mkdirSync: (p: string, o: { recursive: true }) => {
      fs.mkdirSync(p, o);
    },
    readdirSync: (p: string) => fs.readdirSync(p),
    writeFileSync: (p: string, t: string) => {
      if (p === settingsPath()) {
        const next = tamper(t);
        if (next !== null) fs.writeFileSync(p, next);
        return;
      }
      fs.writeFileSync(p, t);
    },
    readFileSync: (p: string) => fs.readFileSync(p, 'utf8'),
    rmSync: (p: string, o: { recursive: true; force: true }) => fs.rmSync(p, o),
  });

  it('(A) the isolated settings.json carries the deny-all policy; a success proof records policy deny_all + runtimeWatch', async () => {
    const { runner, jobs } = mk([{ lines: [ok0, listStep('ACTIVE'), listStep('DONE'), answer('{"a":"x"}')] }]);
    const res = await runner.run(agyReq(), signal());
    expect(res).toMatchObject({ error: null, structured: { a: 'x' }, stopReason: 'end' });
    expect(res.sandbox).toEqual({
      initOk: true,
      toolsCount: 0,
      mcpServers: 0,
      apiKeySource: 'unknown',
      mismatch: null,
      policy: 'deny_all',
      runtimeWatch: true,
    });
    expect(jobs.specs).toHaveLength(1);
    const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual([
      'read_file(*)',
      'write_file(*)',
      'read_url(*)',
      'execute_url(*)',
      'command(*)',
      'unsandboxed(*)',
      'mcp(*)',
    ]);
    const row = audits.find((a) => a.kind === 'cli_run')!;
    expect(row.detail).toMatchObject({ provider: 'antigravity_cli', policy: 'deny_all', runtimeWatch: true });
    expect(audits.filter((a) => a.kind === 'tool_blocked')).toEqual([]);
  });

  it.each<[string, (t: string) => string | null, 'missing' | 'altered']>([
    ['the write is lost', () => null, 'missing'],
    ['no permissions block', () => JSON.stringify({ trustedWorkspaces: [] }), 'missing'],
    [
      'one deny wildcard dropped',
      (t) => {
        const o = JSON.parse(t) as { permissions: { deny: string[] } };
        o.permissions.deny = o.permissions.deny.filter((d) => d !== 'command(*)');
        return JSON.stringify(o);
      },
      'altered',
    ],
    [
      'an allow entry added',
      (t) => {
        const o = JSON.parse(t) as { permissions: { allow: string[] } };
        o.permissions.allow = ['command(*)'];
        return JSON.stringify(o);
      },
      'altered',
    ],
  ])(
    '(A) %s => refused BEFORE any spawn, error sandbox, audited toolset_mismatch policy_%s',
    async (_n, tamper, why) => {
      const { runner, jobs } = mk([{ lines: [ok0, answer('{"a":"x"}')] }], { fs: tamperFs(tamper) });
      const res = await runner.run(agyReq(), signal());
      expect(res).toMatchObject({ error: 'sandbox', structured: null, sandbox: NO_PROOF });
      expect(jobs.specs).toHaveLength(0); // nothing spawned: the stdin line (message text) never left the app
      expect(audits.filter((a) => a.kind === 'toolset_mismatch')).toEqual([
        {
          kind: 'toolset_mismatch',
          ref: null,
          detail: { provider: 'antigravity_cli', stage: 'extract', reason: `policy_${why}` },
        },
      ]);
      expect(audits.find((a) => a.kind === 'cli_run')?.detail).toMatchObject({ policy: why, initOk: false });
      expect(fs.existsSync(path.join(userData, 'agy-workspace', 'runs'))).toBe(true);
      expect(fs.readdirSync(path.join(userData, 'agy-workspace', 'runs'))).toEqual([]); // run dir removed
    },
  );

  it('(A) a CliRunFs seam without readFileSync cannot verify the policy => agy refused (fail closed); claude unaffected', async () => {
    const { readFileSync: _drop, ...noRead } = tamperFs((t) => t);
    void _drop;
    // the refused agy run never reaches the JobRunner, so the ONE script below is the Claude run's
    const { runner, jobs } = mk([{ lines: [init(), result({ structured_output: { a: 'x' } })] }], { fs: noRead });
    expect((await runner.run(agyReq(), signal())).error).toBe('sandbox');
    expect(jobs.specs).toHaveLength(0);
    expect((await runner.run(req(), signal())).error).toBeNull();
    expect(jobs.specs).toHaveLength(1);
  });

  it.each<[string, string[]]>([
    ['run_command ACTIVE', [toolStep('run_command', { CommandLine: 'echo hi' }), toolStep('run_command', {}, 'DONE')]],
    ['run_command DONE only (ACTIVE missed)', [toolStep('run_command', { CommandLine: 'echo hi' }, 'DONE')]],
    ['manage_task with another action', [toolStep('manage_task', { Action: 'create', Command: 'x' })]],
    ['an invented tool in ERROR', [toolStep('bash', { cmd: 'x' }, 'ERROR')]],
    ['an unknown step kind', [step({ state: 'ACTIVE', step_type: 'subagent' })]],
  ])('(C) %s => killed at once, run failed (sandbox), answer never used, tool_blocked hashed', async (_n, steps) => {
    const lines = [ok0, listStep('ACTIVE'), listStep('DONE'), ...steps, answer('{"a":"x"}')];
    const { runner, jobs } = mk([{ lines }]);
    const res = await runner.run(agyReq({ runId: 9, auditRef: '77' } as Partial<CliRunRequest>), signal());
    expect(res.structured).toBeNull();
    expect(res.text).toBeNull();
    expect(res.error).toBe('sandbox');
    expect(res.stopReason).toBe('killed');
    expect(res.blockedCalls).toBe(1);
    expect(res.sandbox).toMatchObject({
      initOk: false,
      mismatch: 'extra_tool',
      policy: 'deny_all',
      runtimeWatch: true,
    });
    expect(jobs.kills).toBe(1);
    expect(jobs.pulled).toEqual([4]); // nothing after the first forbidden step was read
    const blocked = audits.filter((a) => a.kind === 'tool_blocked');
    expect(blocked).toHaveLength(1);
    const name = (JSON.parse(steps[0]!) as { step_update: { tool_name?: string; step_type?: string } }).step_update;
    const raw = name.tool_name ?? `step:${name.step_type}`;
    expect(blocked[0]!.detail).toEqual({
      nameSha8: nameSha8(raw),
      nameLen: raw.length,
      verdict: 'blocked_unknown_tool',
      runId: 9,
    });
    expect(blocked[0]!.ref).toBe('77');
    expect(JSON.stringify(audits)).not.toContain(raw); // only the hash, never the tool name (B26)
    expect(audits.filter((a) => a.kind === 'run_aborted')).toEqual([
      { kind: 'run_aborted', ref: '77', detail: { provider: 'antigravity_cli', stage: 'extract', blockedCalls: 1 } },
    ]);
    expect(audits.filter((a) => a.kind === 'toolset_mismatch')).toEqual([]);
  });

  it('(C) a forbidden step AFTER the result still fails the run (the result is never used)', async () => {
    const { runner } = mk([{ lines: [ok0, answer('{"a":"x"}'), toolStep('write_to_file', {}, 'DONE')] }]);
    const res = await runner.run(agyReq(), signal());
    expect(res).toMatchObject({ error: 'sandbox', structured: null, stopReason: 'killed' });
  });

  it('(C) every blocked run counts for the breaker: the 3rd opens it (CLI_UNSTABLE), no 4th spawn', async () => {
    const bad = { lines: [ok0, toolStep('run_command', { CommandLine: 'x' })] };
    const { runner, jobs } = mk([bad, bad, bad, bad]);
    for (let i = 0; i < 3; i += 1) expect((await runner.run(agyReq(), signal())).error).toBe('sandbox');
    expect(runner.breakerOpen()).toBe(true);
    expect(runner.health()).toEqual({ code: 'CLI_UNSTABLE', retryAtMs: null });
    expect((await runner.run(agyReq(), signal())).error).toBe('not_ready');
    expect(jobs.specs).toHaveLength(3);
  });

  it('(C) manage_task {"Action":"list"} alone (agy calls it by itself) is tolerated; agent_response steps are not tools', async () => {
    const { runner } = mk([
      {
        lines: [
          ok0,
          listStep('ACTIVE'),
          listStep('DONE'),
          step({ state: 'ACTIVE', step_type: 'agent_response' }),
          step({ state: 'DONE', step_type: 'agent_response' }),
          answer('```json\n{"a":"x"}\n```'),
        ],
      },
    ]);
    const res = await runner.run(agyReq(), signal());
    expect(res).toMatchObject({ error: null, structured: { a: 'x' }, blockedCalls: 0 });
    expect(runner.breakerOpen()).toBe(false);
  });

  it('(D) 1.2.16 nested result without structured_output: response parsed; unparsable / truncated => bad_output', async () => {
    const cases: Array<[string, string | null, unknown]> = [
      ['{"a":"x"}', null, { a: 'x' }],
      ['{"a":"x"', 'bad_output', null],
      ['sorry', 'bad_output', null],
      ['', 'bad_output', null],
    ];
    for (const [response, code, structured] of cases) {
      const { runner } = mk([{ lines: [ok0, answer(response)] }]);
      const r = await runner.run(agyReq(), signal());
      expect(r.error, response).toBe(code);
      expect(r.structured, response).toEqual(structured);
    }
  });

  it('print timeout ("[agy] print timeout ... returning partial output") => never the partial answer; network + breaker strike', async () => {
    const { runner } = mk(() => ({ lines: [ok0, answer('{"a":"x"}')], stderrMarkers: ['print_timeout'] }));
    const r = await runner.run(agyReq(), signal());
    expect(r).toMatchObject({ error: 'network', structured: null, stopReason: 'killed' });
    await runner.run(agyReq(), signal());
    await runner.run(agyReq(), signal());
    expect(runner.breakerOpen()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [D-080] An ERROR event that arrives instead of the init (live diagnostic, agy 1.2.16 + Claude Code): classified by its text and the
// marker-only stderr view - never a toolset mismatch, never proven, never a retry with looser flags, no breaker strike.
// ---------------------------------------------------------------------------------------------------------------------
describe('[D-080] error event before init: classified failure, never a pass, never CLI_TOOLSET_MISMATCH', () => {
  const agyReq = (over: Partial<CliRunRequest> = {}): CliRunRequest =>
    req({
      provider: 'antigravity_cli',
      exePath: 'C:\\fakehome\\AppData\\Local\\agy\\bin\\agy.exe',
      model: 'gemini-3.8-flash-high',
      ...over,
    });
  /** The FIRST stdout event agy 1.2.16 printed for the refused flag combination (keys from the live capture, D-080). */
  const agyFirstResult = (error: string): string =>
    j({
      event: 'result',
      conversation_id: 'c-1',
      status: 'ERROR',
      response: '',
      error,
      duration_seconds: 0.1,
      num_turns: 0,
      usage: {},
    });
  const CONFLICT =
    'invalid model selection (--model "gemini-3.8-flash-high" --effort "low"): --model gemini-3.8-flash-high conflicts with --effort=low';

  it.each<[string, string, string]>([
    ['agy model / flag conflict', CONFLICT, 'model_rejected'],
    ['agy unknown model', 'unknown model "gemini-9"', 'model_rejected'],
    ['agy auth', 'authentication required. Run agy once in a terminal to sign in.', 'not_logged_in'],
    ['agy UNAUTHENTICATED', '{"status":"UNAUTHENTICATED","code":401}', 'not_logged_in'],
    ['agy quota', '{"status":"RESOURCE_EXHAUSTED","code":429}', 'usage_limit'],
    ['agy other', 'internal error', 'network'],
    ['agy empty error', '', 'network'],
  ])('%s => %s, NO_PROOF, bad_output, one line read, no toolset_mismatch audit', async (_n, text, code) => {
    const { runner, jobs } = mk([
      { lines: [agyFirstResult(text), j({ agent: 'wca-extract', tools: [] })], exitCode: 1 },
    ]);
    const res = await runner.run(agyReq(), signal());
    expect(res).toMatchObject({ error: code, stopReason: 'bad_output', structured: null, text: null });
    expect(res.sandbox).toEqual(NO_PROOF);
    expect(jobs.pulled).toEqual([1]); // nothing after the first event is ever looked at (I11)
    expect(audits.some((a) => a.kind === 'toolset_mismatch')).toBe(false);
    const row = audits.find((a) => a.kind === 'cli_run')?.detail;
    expect(row).toMatchObject({ initOk: false, errorBeforeInit: code });
    expect(JSON.stringify(audits)).not.toMatch(/gemini|conflicts|authentication|RESOURCE|internal error/);
  });

  it('the nested {"event":"result","result":{...}} envelope and an {"event":"error"} event are read the same way', async () => {
    const { runner } = mk([
      { lines: [j({ event: 'result', result: { status: 'ERROR', error: CONFLICT } })], exitCode: 1 },
      { lines: [j({ event: 'error', error: { message: 'authentication required' } })], exitCode: 1 },
      { lines: [j({ event: 'result', result: { status: 'SUCCESS', structured_output: { a: 1 } } })], exitCode: 0 },
    ]);
    expect((await runner.run(agyReq(), signal())).error).toBe('model_rejected');
    expect((await runner.run(agyReq(), signal())).error).toBe('not_logged_in');
    // a "successful" result BEFORE any init is still unproven: nothing of it is used (fail closed), classified as an error event
    const r3 = await runner.run(agyReq(), signal());
    expect(r3).toMatchObject({ structured: null, sandbox: NO_PROOF });
    expect(r3.error).not.toBeNull();
    expect(r3.error).not.toBe('sandbox');
  });

  it('the stderr markers decide when the event carries no recognisable text', async () => {
    const { runner } = mk([
      { lines: [agyFirstResult('')], exitCode: 1, stderrMarkers: ['model_rejected'] },
      { lines: [agyFirstResult('')], exitCode: 1, stderrMarkers: ['auth_required'] },
      { lines: [agyFirstResult('')], exitCode: 1, stderrMarkers: ['quota'] },
      { lines: [agyFirstResult('')], exitCode: 1, stderrMarkers: ['http_429'] },
      { lines: [agyFirstResult('')], exitCode: 1, stderrMarkers: ['rate_limit'] },
    ]);
    for (const code of ['model_rejected', 'not_logged_in', 'usage_limit', 'usage_limit', 'rate_limited'])
      expect((await runner.run(agyReq(), signal())).error).toBe(code);
  });

  it('never a breaker strike, never the identity pause, never a retry: six rejected runs, six spawns, breaker closed', async () => {
    const { runner, jobs } = mk(() => ({ lines: [agyFirstResult(CONFLICT)], exitCode: 1 }));
    for (let i = 0; i < 6; i += 1) expect((await runner.run(agyReq(), signal())).error).toBe('model_rejected');
    expect(jobs.specs).toHaveLength(6);
    expect(runner.breakerOpen()).toBe(false);
    expect(runner.health()).toBeNull();
  });

  it('claude: a result / assistant error BEFORE system/init is classified the same way (never a toolset mismatch)', async () => {
    const { runner, jobs } = mk([
      {
        lines: [
          result({
            is_error: true,
            result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
          }),
          init(),
        ],
        exitCode: 1,
      },
      {
        lines: [
          j({
            type: 'assistant',
            error: 'authentication_failed',
            message: { content: [{ type: 'text', text: 'Failed to authenticate' }] },
          }),
        ],
        exitCode: 1,
      },
      { lines: [result({ is_error: true, result: 'claude-x is not a recognized model id' })], exitCode: 1 },
      { lines: [result({ is_error: true, result: "You've hit your session limit" })], exitCode: 1 },
      { lines: [result({ is_error: true, result: 'boom' })], exitCode: 1 },
    ]);
    for (const code of ['not_logged_in', 'not_logged_in', 'model_rejected', 'usage_limit', 'network']) {
      const r = await runner.run(req(), signal());
      expect(r).toMatchObject({ error: code, sandbox: NO_PROOF, structured: null, stopReason: 'bad_output' });
    }
    expect(jobs.pulled).toEqual([1, 1, 1, 1, 1]);
    expect(audits.some((a) => a.kind === 'toolset_mismatch')).toBe(false);
    expect(runner.breakerOpen()).toBe(false);
  });

  it('the D-080 Claude stream (init FIRST, then an assistant auth error, then an is_error result) stays not_logged_in', async () => {
    const { runner } = mk([
      {
        lines: [
          init(),
          j({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }),
          result({
            is_error: true,
            result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
          }),
        ],
        exitCode: 1,
      },
    ]);
    const r = await runner.run(req(), signal());
    expect(r.error).toBe('not_logged_in');
    expect(r.sandbox.initOk).toBe(true);
  });

  it('a stream with NO recognisable event keeps reason no_init (fail closed, toolset mismatch)', async () => {
    const { runner } = mk([
      { lines: [j({ agent: 'someone-else' })] },
      { lines: [j({ event: 'progress' })] },
      { lines: [j({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })] },
    ]);
    expect((await runner.run(agyReq(), signal())).error).toBe('sandbox');
    expect((await runner.run(agyReq(), signal())).error).toBe('sandbox');
    expect((await runner.run(req(), signal())).error).toBe('sandbox');
    expect(audits.filter((a) => a.kind === 'toolset_mismatch')).toHaveLength(3);
  });

  it('classifyErrorBeforeInit (pure): text first, then markers, else network', () => {
    expect(classifyErrorBeforeInit(CONFLICT, [])).toBe('model_rejected');
    expect(classifyErrorBeforeInit('error: unknown option --effort', [])).toBe('model_rejected');
    expect(classifyErrorBeforeInit('Not logged in · Please run /login', [])).toBe('not_logged_in');
    expect(classifyErrorBeforeInit('OAuth session expired', [])).toBe('not_logged_in');
    expect(classifyErrorBeforeInit('Quota exceeded', [])).toBe('usage_limit');
    expect(classifyErrorBeforeInit('', ['authentication_failed'])).toBe('not_logged_in');
    expect(classifyErrorBeforeInit('', ['usage_limit'])).toBe('usage_limit');
    expect(classifyErrorBeforeInit('', ['model_not_found'])).toBe('model_rejected');
    expect(classifyErrorBeforeInit('', ['overloaded'])).toBe('overloaded');
    expect(classifyErrorBeforeInit('', [])).toBe('network');
    // an auth word inside a model rejection is still the model rejection (the user has to pick another model)
    expect(classifyErrorBeforeInit('invalid model selection: login model "x" conflicts with --effort=low', [])).toBe(
      'model_rejected',
    );
  });
});

describe('[D-080] onRunEnd: every finished run is reported to subscribers (the status service flips "signed in")', () => {
  it('reports provider + error + initOk; unsubscribe stops it', async () => {
    const { runner } = mk([
      { lines: [init(), result({ is_error: true, result: 'Not logged in · Please run /login' })], exitCode: 1 },
      { lines: [init(), result({ structured_output: { a: 'x' } })] },
      { lines: [init(), result({ structured_output: { a: 'x' } })] },
    ]);
    const seen: Array<[string, string | null, boolean]> = [];
    const off = runner.onRunEnd((provider, r) => seen.push([provider, r.error, r.sandbox.initOk]));
    await runner.run(req(), signal());
    await runner.run(req(), signal());
    off();
    await runner.run(req(), signal());
    expect(seen).toEqual([
      ['claude_cli', 'not_logged_in', true],
      ['claude_cli', null, true],
    ]);
  });
  it('a throwing subscriber never breaks the run', async () => {
    const { runner } = mk([{ lines: [init(), result({ structured_output: { a: 'x' } })] }]);
    runner.onRunEnd(() => {
      throw new Error('boom');
    });
    expect((await runner.run(req(), signal())).error).toBeNull();
  });
});
