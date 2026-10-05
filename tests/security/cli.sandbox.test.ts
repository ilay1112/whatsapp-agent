// tests/security/cli.sandbox.test.ts - T2 8.2 group 18 (Claude half): I11, I4', I6' (owner V2-W1-06-claude-cli).
// Every run goes through the PRODUCTION JobRunner + CliRunner + argv/env builders + init assertion + claude_cli provider against the
// spawned tests/fakes/fake-claude-cli.mjs (system node.exe, T8; fake home, T9). The fake journal is the witness: argv literal per stage,
// env key set literal (secrets planted first), no token on argv/disk/log/audit, init failures killed BEFORE any turn (turnStarted:false),
// no retry with looser flags, run dir and pid files removed, cli_run audit enums/numbers only.
import { afterEach, describe, expect, it } from 'vitest';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_ENV_KEYS, CLAUDE_S3_ENV_KEYS } from '../../src/main/proc/jobRunner.ts';
import {
  CLAUDE_NEVER_ARGS,
  CLI_OAUTH_API_KEY_SOURCE,
  CLI_SMOKE_SCHEMA,
  CLI_SMOKE_SYSTEM,
  CLAUDE_EXTRACT_MAX_TURNS,
  buildClaudeArgs,
  buildClaudeStdinLine,
} from '../../src/main/llm/cli/claudeCli.ts';
import { runDraft } from '../../src/main/agent/draft.ts';
import { LIMITS } from '../../src/shared/types.ts';
import { IMAGE_READ_SCHEMA } from '../../src/shared/schemas.ts';
import { png } from '../fakes/image-fixtures.ts';
import { FAKE_CLAUDE_MODES, readFakeClaudeJournal } from '../fakes/fake-claude-cli.types.ts';
import {
  FAKE_CLAUDE_CLI,
  createClaudeFakeWorld,
  S1_MESSAGES,
  S1_SCHEMA,
  type ClaudeFakeWorld,
} from '../helpers/cli-fakes-hook.world.ts';

const worlds: ClaudeFakeWorld[] = [];
const world = (...a: Parameters<typeof createClaudeFakeWorld>): ClaudeFakeWorld => {
  const w = createClaudeFakeWorld(...a);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
});
const opts = (purpose: 'extract' | 'draft' | 'read_image' = 'extract') => ({
  signal: new AbortController().signal,
  maxOutputTokens: 512,
  purpose,
});
const PLANTED = {
  ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-planted',
  ANTHROPIC_AUTH_TOKEN: 'TESTONLY-auth',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/evil',
  CLAUDE_CODE_OAUTH_TOKEN: 'TESTONLY-oauth',
  CLAUDE_CONFIG_DIR: 'C:\\evil-config',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NODE_OPTIONS: '--require evil',
  WHATSAPP_BRIDGE_TOKEN: 'TESTONLY-bridge',
  WCA_DOORBELL_SECRET: 'TESTONLY-doorbell',
  LLAMA_API_KEY: 'TESTONLY-llama',
};
const noLeftovers = (w: ClaudeFakeWorld): void => {
  expect(
    fs.existsSync(path.join(w.userData, 'cli-runs')) ? fs.readdirSync(path.join(w.userData, 'cli-runs')) : [],
  ).toEqual([]);
  expect(fs.readdirSync(w.runDir).filter((f) => f.startsWith('job-'))).toEqual([]);
};

describe('argv + env literal per stage (production builders, fake witness)', () => {
  it('S1: the fake saw exactly buildClaudeArgs(); env = CLAUDE_ENV_KEYS literally even with secrets planted; run dir fresh + removed', async () => {
    const w = world({
      processEnv: {
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\wca-fake-home',
        HOMEDRIVE: 'C:',
        HOMEPATH: '\\Users\\wca-fake-home',
        APPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Local',
        ...PLANTED,
      },
    });
    const p = w.provider();
    const out = await p.structured(S1_MESSAGES, S1_SCHEMA as never, opts());
    expect(out).toEqual({ intent: 'meeting', confidence: 0 });
    const [e] = w.journal();
    expect(e!.stage).toBe('extract');
    expect(e!.argv).toEqual(
      buildClaudeArgs({
        provider: 'claude_cli',
        stage: 'extract',
        exePath: w.exePath,
        model: p.model,
        system: S1_MESSAGES[0]!.content,
        stdinLine: '',
        jsonSchema: S1_SCHEMA,
        maxTurns: CLAUDE_EXTRACT_MAX_TURNS, // [claude-extract-debug] bounded: one in-run StructuredOutput retry
        wallClockMs: LIMITS.cliWallClockExtractMs,
        toolServer: null,
        observedVersion: '2.1.258',
      }),
    );
    expect(e!.argv.slice(0, 7)).toEqual([
      '-p',
      '--restricted',
      '--strict-mcp-config',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
    ]);
    for (const never of CLAUDE_NEVER_ARGS) expect(e!.argv).not.toContain(never);
    expect(e!.envKeys).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(e!.envChecks).toEqual({ pathIsSystem32: true, tempIsCwd: true, tokenPresent: false, forbiddenKeys: [] });
    expect(e!.cwdEmptyAtStart).toBe(true);
    expect(e!.stdinLines).toBe(1);
    expect(e!.stdinNonceWrapped).toBe(true);
    expect(e!.violations).toEqual([]);
    expect(e!.argv.join('\n')).not.toContain('coffee tomorrow'); // message text never on argv (B26)
    noLeftovers(w);
  });

  it('smoke: haiku, the 1-field schema, --max-turns 1, constant prompt', async () => {
    const w = world();
    expect(await w.provider().validate(new AbortController().signal)).toEqual({ ok: true, model: 'sonnet' });
    const [e] = w.journal();
    expect(e!.stage).toBe('smoke');
    const at = (flag: string): string | undefined => e!.argv[e!.argv.indexOf(flag) + 1];
    expect(at('--model')).toBe('haiku');
    expect(at('--max-turns')).toBe('1');
    expect(at('--system-prompt')).toBe(CLI_SMOKE_SYSTEM);
    expect(JSON.parse(at('--json-schema') as string)).toEqual(CLI_SMOKE_SCHEMA);
    expect(e!.violations).toEqual([]);
  });

  it('V1: image block first on stdin, --tools "" --max-turns 1 --json-schema IMAGE_READ_SCHEMA, no --mcp-config', async () => {
    const w = world();
    const bytes = png(8, 8);
    await w.provider().structured(
      [
        { role: 'system', content: 'V1 CONSTANT (test)' },
        {
          role: 'user',
          content: [
            { type: 'image', mime: 'image/png', base64: Buffer.from(bytes).toString('base64') },
            { type: 'text', text: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
          ],
        },
      ],
      IMAGE_READ_SCHEMA as never,
      opts('read_image'),
    );
    const [e] = w.journal();
    expect(e!.stage).toBe('read_image');
    expect(e!.argv).not.toContain('--mcp-config');
    expect(e!.argv[e!.argv.indexOf('--max-turns') + 1]).toBe('1'); // I12: only S1 got the bounded extra turn
    expect(e!.argv[e!.argv.indexOf('--tools') + 1]).toBe('');
    expect(JSON.parse(e!.argv[e!.argv.indexOf('--json-schema') + 1] as string)).toEqual(IMAGE_READ_SCHEMA);
    expect(e!.violations).toEqual([]);
  });

  it('S3: WCA_MCP_TOKEN only in env (never argv, file, log or audit), the literal ${WCA_MCP_TOKEN} header, tool calls through the gate', async () => {
    const w = world({
      script: [
        { when: { stage: 'draft', turn: 0 }, respond: { toolCalls: [{ name: 'get_current_time', input: {} }] } },
        { when: { stage: 'draft', turn: 1 }, respond: { text: 'Draft reply' } },
      ],
    });
    const { gate, ctx } = w.gate();
    const draft = await runDraft(w.provider(), {
      messages: [
        { role: 'system', content: 'S3 CONSTANT (test)' },
        { role: 'user', content: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
      ],
      ctx,
      gate,
      maxOutputTokens: 400,
      wallClockMs: LIMITS.cliWallClockDraftMs,
    });
    expect(draft).toMatchObject({ ok: true, text: 'Draft reply' });
    const [e] = w.journal();
    expect(e!.stage).toBe('draft');
    expect(e!.envKeys).toEqual([...CLAUDE_S3_ENV_KEYS].sort());
    expect(e!.envChecks.tokenPresent).toBe(true);
    expect(e!.argvHasToken).toBe(false);
    expect(e!.argv[e!.argv.indexOf('--mcp-config') + 1]).toContain('"Authorization":"Bearer ${WCA_MCP_TOKEN}"');
    expect(e!.argv[e!.argv.indexOf('--allowedTools') + 1]).toBe('mcp__wca__*');
    expect(e!.toolCalls).toEqual([{ name: 'get_current_time', allowedByServer: true, isError: false }]);
    expect(e!.violations).toEqual([]);
    const token = w.servers[0]!.token;
    for (const f of w.allFiles()) expect(fs.readFileSync(f, 'utf8')).not.toContain(token);
    expect(JSON.stringify(w.audits)).not.toContain(token);
    expect(fs.readFileSync(w.journalFile, 'utf8')).not.toContain(token);
    noLeftovers(w);
  });

  it('S3 run_file mode (F16): the token lives only in <runDir>\\wca.mcp.json, deleted with the run', async () => {
    const w = world({ mcpConfigMode: 'run_file' });
    const { gate, ctx } = w.gate();
    const out = await runDraft(w.provider(), {
      messages: [
        { role: 'system', content: 'S3' },
        { role: 'user', content: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
      ],
      ctx,
      gate,
      maxOutputTokens: 400,
      wallClockMs: LIMITS.cliWallClockDraftMs,
    });
    expect(out).toMatchObject({ ok: true });
    const [e] = w.journal();
    expect(e!.envChecks.tokenPresent).toBe(false);
    expect(e!.argvHasToken).toBe(false);
    expect(e!.argv[e!.argv.indexOf('--mcp-config') + 1]).toMatch(/wca\.mcp\.json$/);
    expect(e!.violations).toEqual([]);
    noLeftovers(w);
  });
});

describe('init proof: each failure mode killed BEFORE any turn, toolset_mismatch, no retry, sandbox_ok=0', () => {
  it.each([
    ['extra_tool', 'extra_tool'],
    ['extra_server', 'extra_server'],
    ['plugins_present', 'extra_tool'],
    ['mcp_server_error', 'server_error'],
    ['api_key_leak', 'api_key_auth'],
    ['init_not_first', 'no_init'],
    ['no_init', 'no_init'],
  ] as const)(
    '%s',
    async (mode, reason) => {
      const w = world({ state: { modeByStage: { extract: mode } } });
      let sandbox: unknown = null;
      await expect(
        w.provider().structured(S1_MESSAGES, S1_SCHEMA as never, { ...opts(), onSandbox: (s) => (sandbox = s) }),
      ).rejects.toMatchObject({ code: 'sandbox' });
      expect(sandbox).toMatchObject({ initOk: false });
      const entries = w.journal();
      expect(entries).toHaveLength(1); // never a retry with looser flags
      // (without an init, the event the app rejects IS the fake's first assistant line - nothing after it is read)
      if (mode !== 'init_not_first' && mode !== 'no_init') expect(entries[0]!.turnStarted).toBe(false);
      expect(w.audits.filter((a) => a.kind === 'toolset_mismatch').map((a) => a.detail.reason)).toEqual([reason]);
      expect(w.audits.find((a) => a.kind === 'cli_run')?.detail).toMatchObject({ initOk: false, stopReason: 'killed' });
      noLeftovers(w);
    },
    20_000,
  );

  it('StructuredOutput in init.tools of a schema run passes and its tool_use is no strike (F13)', async () => {
    const w = world();
    await w.provider().structured(S1_MESSAGES, S1_SCHEMA as never, opts());
    expect(w.audits.some((a) => a.kind === 'tool_blocked')).toBe(false);
    expect(w.audits.find((a) => a.kind === 'cli_run')?.detail).toMatchObject({ initOk: true, blockedCalls: 0 });
  });

  it('apiKeySource: until M-CLI-1 pins the OAuth literal the constant is null and API-key sources fail (asserted, no skip)', () => {
    expect(CLI_OAUTH_API_KEY_SOURCE).toBeNull();
  });
});

describe('result checks and strikes', () => {
  it('is_error_success (issue #79500) is a failure', async () => {
    const w = world({ state: { modeByStage: { extract: 'is_error_success' } } });
    await expect(w.provider().structured(S1_MESSAGES, S1_SCHEMA as never, opts())).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('attacker on S3: non-mcp__wca__ tool_use / permission_denials are strikes -> aborted_manipulation; names never audited', async () => {
    const w = world({ state: { modeByStage: { draft: 'attacker' } }, registerJournal: true });
    const { gate, ctx } = w.gate();
    const out = await runDraft(w.provider(), {
      messages: [
        { role: 'system', content: 'S3' },
        { role: 'user', content: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
      ],
      ctx,
      gate,
      maxOutputTokens: 400,
      wallClockMs: LIMITS.cliWallClockDraftMs,
    });
    expect(out).toMatchObject({ ok: false, reason: 'aborted_manipulation' });
    expect(ctx.blockedCalls).toBeGreaterThanOrEqual(LIMITS.blockedCallsAbort);
    const blocked = w.audits.filter((a) => a.kind === 'tool_blocked');
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    for (const b of blocked) expect(Object.keys(b.detail).sort()).toEqual(['nameLen', 'nameSha8', 'runId', 'verdict']);
    expect(JSON.stringify(w.audits)).not.toMatch(/Bash|WebFetch|gmail|SENTINEL/);
    noLeftovers(w);
  }, 20_000);
});

describe('kill path', () => {
  it('hang: the wall clock tree-kills by PID (taskkill /PID /T /F, never /IM), pid file and run dir removed', async () => {
    const w = world({ state: { modeByStage: { extract: 'hang' } } });
    const res = await w.runner.run(
      {
        provider: 'claude_cli',
        stage: 'extract',
        exePath: w.exePath,
        model: 'sonnet',
        system: 'S1',
        stdinLine: buildClaudeStdinLine('<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>', null),
        jsonSchema: S1_SCHEMA,
        maxTurns: 1,
        wallClockMs: 1_500,
        toolServer: null,
        observedVersion: '2.1.258',
      },
      new AbortController().signal,
    );
    expect(res).toMatchObject({ error: 'network', stopReason: 'killed' });
    expect(w.taskkills.length).toBeGreaterThanOrEqual(1);
    expect(w.taskkills[0]!.tree).toBe(true);
    noLeftovers(w);
  }, 20_000);

  it('kill_me: the grandchild dies with the tree', async () => {
    const w = world({ state: { modeByStage: { extract: 'kill_me' } } });
    await w.runner.run(
      {
        provider: 'claude_cli',
        stage: 'extract',
        exePath: w.exePath,
        model: 'sonnet',
        system: 'S1',
        stdinLine: buildClaudeStdinLine('<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>', null),
        jsonSchema: S1_SCHEMA,
        maxTurns: 1,
        wallClockMs: 2_000,
        toolServer: null,
        observedVersion: '2.1.258',
      },
      new AbortController().signal,
    );
    const g = w.journal().find((e) => typeof e.grandchildPid === 'number')?.grandchildPid;
    expect(typeof g).toBe('number');
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(g as number, 0)).toThrow();
    noLeftovers(w);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The fake itself must be strict enough that a wrong flag, env key, message on argv or stdin shape FAILS a test (T2 3.1).
// These self-tests spawn it directly with an UNREGISTERED journal (their violations are intended).
// ---------------------------------------------------------------------------------------------------------------------
describe('fake-claude-cli.mjs self-test (T2 3.1)', () => {
  const runFake = (
    app: string[],
    o: { state?: Record<string, unknown>; stdin?: string; env?: Record<string, string>; cwd?: string } = {},
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-fakeself-'));
    const journal = path.join(dir, 'j.jsonl');
    const state = path.join(dir, 's.json');
    fs.writeFileSync(state, JSON.stringify({ version: '2.1.258', loggedIn: true, mode: 'ok', ...o.state }));
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const cwd = o.cwd ?? dir;
    const env = o.env ?? {
      SystemRoot: sysRoot,
      PATH: `${sysRoot}\\System32`,
      TEMP: cwd,
      TMP: cwd,
      USERPROFILE: dir,
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\x',
      APPDATA: dir,
      LOCALAPPDATA: dir,
      MCP_TIMEOUT: '10000',
      MCP_TOOL_TIMEOUT: '25000',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_BUG_COMMAND: '1',
      CI: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    };
    const r = cp.spawnSync(
      process.execPath,
      [FAKE_CLAUDE_CLI, '--fake-journal', journal, '--fake-state', state, '--fake-end', ...app],
      { cwd, env, input: o.stdin ?? '', encoding: 'utf8', windowsHide: true },
    );
    const entries = fs.existsSync(journal) ? readFakeClaudeJournal(fs.readFileSync(journal, 'utf8')) : [];
    const stateAfter = JSON.parse(fs.readFileSync(state, 'utf8')) as Record<string, unknown>;
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, entries, stateAfter };
  };
  const s1Args = (extra: string[] = [], version = '2.1.258'): string[] =>
    buildClaudeArgs({
      provider: 'claude_cli',
      stage: 'extract',
      exePath: 'C:\\x\\claude.exe',
      model: 'sonnet',
      system: 'S1',
      stdinLine: '',
      jsonSchema: S1_SCHEMA,
      maxTurns: 1,
      wallClockMs: 1,
      toolServer: null,
      observedVersion: version,
    }).concat(extra);
  const stdin = `${buildClaudeStdinLine('<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>', null)}\n`;
  const violationsOf = (r: ReturnType<typeof runFake>): string[] => r.entries.at(-1)?.violations ?? [];

  it('the env the fake expects is exactly CLAUDE_ENV_KEYS; stage detection pins IMAGE_READ_SCHEMA and the smoke schema', async () => {
    const fake = (await import('../fakes/fake-claude-cli.mjs')) as unknown as {
      EXPECTED_ENV_KEYS: string[];
      detectStage(o: Record<string, unknown>): string;
      FAKE_CLAUDE_MODES: string[];
    };
    expect(fake.EXPECTED_ENV_KEYS).toEqual([...CLAUDE_ENV_KEYS]);
    expect(fake.detectStage({ '--json-schema': JSON.stringify(IMAGE_READ_SCHEMA) })).toBe('read_image');
    expect(fake.detectStage({ '--json-schema': JSON.stringify(CLI_SMOKE_SCHEMA) })).toBe('smoke');
    expect(fake.detectStage({ '--json-schema': JSON.stringify(S1_SCHEMA) })).toBe('extract');
    expect(fake.detectStage({ '--mcp-config': '{}' })).toBe('draft');
    expect(fake.FAKE_CLAUDE_MODES).toEqual([...FAKE_CLAUDE_MODES]);
  });

  it('a clean S1 run has no violations; --version and auth status answer like the CLI; auth login sets loggedIn', () => {
    const ok = runFake(s1Args(), { stdin });
    expect(ok.status).toBe(0);
    expect(ok.entries.at(-1)).toMatchObject({ phase: 'final', stage: 'extract', exit: 0, violations: [] });
    expect(runFake(['--version']).stdout.trim()).toBe('2.1.258 (Claude Code)');
    expect((JSON.parse(runFake(['auth', 'status', '--json']).stdout) as { loggedIn: boolean }).loggedIn).toBe(true);
    expect(runFake(['auth', 'status', '--json'], { state: { loggedIn: 'garbage' } }).stdout).not.toMatch(/^\{/);
    expect(runFake(['auth', 'login', '--claudeai'], { state: { loggedIn: false } }).stateAfter.loggedIn).toBe(true);
  });

  it('an unknown option => exit 1 like the real CLI; --permission-prompts is unknown below 2.1.259', () => {
    const typo = runFake([...s1Args(), '--restriced'], { stdin });
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain('unknown option');
    expect(runFake(['-p', '--permission-prompts', 'none'], { state: { version: '2.1.258' }, stdin }).status).toBe(1);
    expect(runFake(s1Args([], '2.1.259'), { state: { version: '2.1.259' }, stdin }).status).toBe(0);
  });

  it.each(['--bare', '--dangerously-skip-permissions', '--continue'])(
    'forbidden-but-known flag %s is accepted AND journaled',
    (flag) => {
      expect(violationsOf(runFake([...s1Args(), flag], { stdin }))).toContain(`forbidden_flag:${flag}`);
    },
  );

  it('bypassPermissions, a positional prompt, two stdin lines, a missing nonce block, poisoned env: all violations', () => {
    const bypass = s1Args();
    bypass[bypass.indexOf('dontAsk')] = 'bypassPermissions';
    expect(violationsOf(runFake(bypass, { stdin }))).toContain('forbidden_flag:bypassPermissions');
    expect(violationsOf(runFake([...s1Args(), 'hello from the message'], { stdin }))).toContain(
      'forbidden_flag:positional',
    );
    expect(violationsOf(runFake(s1Args(), { stdin: stdin + stdin }))).toContain('stdin_shape:lines_2');
    const noNonce = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"no nonce"}]}}\n';
    expect(violationsOf(runFake(s1Args(), { stdin: noNonce }))).toContain('stdin_shape:nonce_blocks_0');
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const poisoned = runFake(s1Args(), {
      stdin,
      env: {
        SystemRoot: sysRoot,
        PATH: 'C:\\evil',
        ANTHROPIC_API_KEY: 'sk-ant-TESTONLY',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '0',
      },
    });
    expect(violationsOf(poisoned)).toEqual(
      expect.arrayContaining([
        'env_forbidden:ANTHROPIC_API_KEY',
        'env_memory_switch:CLAUDE_CODE_DISABLE_CLAUDE_MDS',
        'env_path_not_system32',
        'env_temp_not_run_dir',
      ]),
    );
  });

  it('a non-loopback --mcp-config URL => exit 97 and a journaled violation (T10)', () => {
    const args = buildClaudeArgs({
      provider: 'claude_cli',
      stage: 'draft',
      exePath: 'C:\\x\\claude.exe',
      model: 'sonnet',
      system: 'S3',
      stdinLine: '',
      jsonSchema: null,
      maxTurns: 5,
      wallClockMs: 1,
      toolServer: { url: 'http://evil.example:80/mcp', token: 't' },
      observedVersion: '2.1.258',
    });
    const r = runFake(args, { stdin });
    expect(r.status).toBe(97);
    expect(violationsOf(r)).toContain('non_loopback_url');
  });
});
