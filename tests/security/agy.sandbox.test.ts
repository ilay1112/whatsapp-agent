// tests/security/agy.sandbox.test.ts - T2 8.2 group 18 (Antigravity half): I11, I4', I6' (owner V2-W1-09-antigravity, lane L10).
// Every run goes through the PRODUCTION JobRunner + CliRunner + agy argv / env / agent-file builders + init assertion + antigravity_cli
// provider against the spawned tests/fakes/fake-agy.mjs (system node.exe, T8; mkdtemp fake home + userData, T9). The fake journal is
// the witness: argv literal (never -p <text>), env key set literal with secrets planted first, the isolated profile (F3), no
// mcp_config.json ever, the agent file bytes, stdin in agy's own envelope (F20), init failures killed BEFORE any turn, no retry with
// looser flags, run dir and pid files removed, every agy proposal cli_unproven (T2 concern 1). Release stays gated on M-AGY-1.
import { afterEach, describe, expect, it } from 'vitest';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGY_ENV_KEYS } from '../../src/main/proc/jobRunner.ts';
import {
  AGY_DENY_ALL,
  AGY_PROFILE_MODE,
  agyEventResult,
  agyStepVerdict,
  buildAgentFile,
  buildAgyArgs,
  buildAgyEnv,
  buildAgyStdinLine,
  checkAgyInit,
  classifyAgyErrorText,
  classifyAgyResult,
  planAgyHome,
} from '../../src/main/llm/cli/antigravityCli.ts';
import { buildClaudeStdinLine, CLI_SMOKE_SYSTEM } from '../../src/main/llm/cli/claudeCli.ts';
import { providerClassOf } from '../../src/main/agent/validate.ts';
import { LlmError, type CallOpts, type LlmMessage } from '../../src/main/llm/types.ts';
import type { CliSandboxProof } from '../../src/shared/types.ts';
import { LIMITS } from '../../src/shared/types.ts';
import {
  FAKE_AGY_MODES,
  readFakeAgyJournal,
  type FakeAgyJournalEntry,
  type FakeAgyMode,
} from '../fakes/fake-agy.types.ts';
import {
  AGY_S1_SCHEMA,
  AGY_S1_SYSTEM,
  AGY_S1_USER,
  FAKE_AGY,
  createAgyFakeWorld,
  type AgyFakeWorld,
} from '../fakes/fake-agy.world.ts';

const worlds: AgyFakeWorld[] = [];
const world = (...a: Parameters<typeof createAgyFakeWorld>): AgyFakeWorld => {
  const w = createAgyFakeWorld(...a);
  worlds.push(w);
  return w;
};
/** The app never writes an MCP config (T2 3.2): no mcp_config.json under userData in ANY test (the fake USER home may carry a planted one). */
const appMcpConfigs = (w: AgyFakeWorld): string[] =>
  w.allFiles().filter((f) => f.startsWith(w.userData) && path.basename(f).toLowerCase() === 'mcp_config.json');
afterEach(() => {
  const found: string[] = [];
  for (const w of worlds.splice(0)) {
    found.push(...appMcpConfigs(w));
    w.cleanup();
  }
  expect(found).toEqual([]);
});

const S1: LlmMessage[] = [
  { role: 'system', content: AGY_S1_SYSTEM },
  { role: 'user', content: AGY_S1_USER },
];
const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
  signal: new AbortController().signal,
  maxOutputTokens: 512,
  purpose: 'extract',
  ...over,
});
/** Secrets a poisoned parent env could carry (synthetic, T5). None may reach an agy job. */
const PLANTED = {
  GEMINI_API_KEY: 'AIzaTESTONLY-planted',
  GOOGLE_API_KEY: 'AIzaTESTONLY-planted-2',
  GOOGLE_APPLICATION_CREDENTIALS: 'C:\\evil\\creds.json',
  GOOGLE_CLOUD_PROJECT: 'evil-project',
  ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-planted',
  CLAUDE_CODE_OAUTH_TOKEN: 'TESTONLY-oauth',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NODE_OPTIONS: '--require evil',
  WHATSAPP_BRIDGE_TOKEN: 'TESTONLY-bridge',
  WCA_DOORBELL_SECRET: 'TESTONLY-doorbell',
  LLAMA_API_KEY: 'TESTONLY-llama',
  AGY_CLI_DISABLE_AUTO_UPDATE: 'false',
};
const poisonedEnv = (w: { home: string }): Record<string, string> => ({
  SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  USERPROFILE: w.home,
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\wca-fake-home',
  APPDATA: path.join(w.home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(w.home, 'AppData', 'Local'),
  PATH: 'C:\\evil\\bin;C:\\Windows\\System32',
  ...PLANTED,
});
const runs = (w: AgyFakeWorld): FakeAgyJournalEntry[] =>
  w.journal().filter((e) => e.stage === 'extract' || e.stage === 'draft' || e.stage === 'smoke');
const leftovers = (w: AgyFakeWorld): string[] => {
  const runsDir = path.join(w.userData, 'agy-workspace', 'runs');
  const inRuns = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
  const pidFiles = fs.readdirSync(w.runDir).filter((f) => /^job-.*\.pid\.json$/.test(f));
  return [...inRuns, ...pidFiles];
};
const sandboxSink = (): { proofs: CliSandboxProof[]; onSandbox: (p: CliSandboxProof) => void } => {
  const proofs: CliSandboxProof[] = [];
  return { proofs, onSandbox: (p) => proofs.push(p) };
};

describe('argv + env literal (production builders, fake witness)', () => {
  it('S1: argv == buildAgyArgs() with NO --json-schema (schema in the agent body), never -p / a positional / message text; env == AGY_ENV_KEYS with secrets planted', async () => {
    const wp = world({ state: { expectedPromptSha256: { extract: sha256(AGY_S1_SYSTEM) } } });
    // the runner reads the SAME processEnv object: poison the app's parent env before the run
    Object.assign(wp.processEnv, poisonedEnv(wp));
    const p = wp.provider();
    await p.structured(S1, AGY_S1_SCHEMA, opts()).catch((e: unknown) => e);
    expect(wp.spawnedArgs).toHaveLength(1);
    const argv = wp.spawnedArgs[0] ?? [];
    const runDir = runs(wp)[0]?.cwd ?? '';
    expect(path.dirname(runDir)).toBe(path.join(wp.userData, 'agy-workspace', 'runs'));
    expect(argv).toEqual(
      buildAgyArgs(
        {
          provider: 'antigravity_cli',
          stage: 'extract',
          exePath: wp.exePath,
          model: 'gemini-3.8-flash-high',
          system: AGY_S1_SYSTEM,
          stdinLine: buildAgyStdinLine(AGY_S1_USER),
          jsonSchema: AGY_S1_SCHEMA,
          maxTurns: 1,
          wallClockMs: LIMITS.cliWallClockExtractMs,
          toolServer: null,
          observedVersion: '1.2.12',
        },
        null,
      ),
    );
    expect(argv).toEqual([
      '--agent',
      'wca-extract',
      '--model',
      'gemini-3.8-flash-high', // [D-080] a suffixed slug: no --effort (agy 1.2.16 refuses the pair)
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--print-timeout',
      '50s',
      '--disable-slash-commands',
    ]); // [agy-schema-loop] never --json-schema: agy 1.2.16 / 1.2.17 then loops until its print timeout
    for (const bad of ['-p', '--print', '--prompt', '--dangerously-skip-permissions', '--sandbox', '--mcp-config'])
      expect(argv).not.toContain(bad);
    expect(argv.join('\u0000')).not.toContain('<<DATA-');
    expect(argv.join('\u0000')).not.toContain('coffee');
    expect(argv.join('\u0000')).not.toContain(AGY_S1_SYSTEM); // the constant lives in the agent file, not on argv

    // env: the literal key set, secrets planted in the parent env never cross
    const env = wp.spawnedEnvs[0] ?? {};
    expect(Object.keys(env).sort()).toEqual([...AGY_ENV_KEYS].sort());
    for (const k of Object.keys(PLANTED).filter((x) => x !== 'AGY_CLI_DISABLE_AUTO_UPDATE'))
      expect(Object.keys(env).map((x) => x.toUpperCase())).not.toContain(k.toUpperCase());
    for (const v of Object.values(PLANTED).filter((x) => x !== 'false')) expect(Object.values(env)).not.toContain(v);
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
    expect(env.PATH).toBe(`${env.SystemRoot}\\System32`);
    expect(env.TEMP).toBe(runDir);
    expect(env.TMP).toBe(runDir);
    // F3 isolated profile: USERPROFILE = HOME = <userData>\agy-home ; APPDATA / LOCALAPPDATA under it (U-A7)
    const agyHome = path.join(wp.userData, 'agy-home');
    expect(env.USERPROFILE).toBe(agyHome);
    expect(env.HOME).toBe(agyHome);
    expect(env.APPDATA?.startsWith(`${agyHome}\\`)).toBe(true);
    expect(env.LOCALAPPDATA?.startsWith(`${agyHome}\\`)).toBe(true);

    // the fake's own view (journal) agrees and saw no violation
    const [j] = runs(wp);
    expect(j?.violations).toEqual([]);
    expect(j?.home).toEqual({ userProfile: agyHome, home: agyHome });
    expect(j?.envChecks).toEqual({ pathIsSystem32: true, tempIsCwd: true, autoUpdateOff: true, forbiddenKeys: [] });
    expect(j?.stdinEnvelope).toBe('agy');
    expect(j?.stdinLines).toBe(1);
    expect(j?.stdinNonceBlocks).toBe(1);
    expect(j?.stdinSha256).toBe(sha256(`${buildAgyStdinLine(AGY_S1_USER)}\n`));
    expect(j?.agentFile).toEqual({ exists: true, frontmatterOk: true, bodySha256: sha256(AGY_S1_SYSTEM) });
    expect(j?.mcpConfigPresent).toBe(false);
    expect(j?.schemaFilePresent).toBe(false);
    expect(j?.bodySchemaSha256).toBe(sha256(JSON.stringify(AGY_S1_SCHEMA))); // the schema rides in the agent body
    expect(j?.workspaceTrusted).toBe(true);
    expect(j?.globalMcpVisible).toBe(false);
    // the run dir (agent file) and the pid file are gone
    expect(leftovers(wp)).toEqual([]);
    // only the app-written isolated settings.json exists in the agy profile - nothing of the user's profile was copied
    const profileFiles = wp.allFiles().filter((f) => f.startsWith(agyHome));
    expect(profileFiles).toEqual([path.join(agyHome, '.gemini', 'antigravity-cli', 'settings.json')]);
    // [agy-provider-fix A] trustedWorkspaces + the deny-all permissions policy, byte for byte what planAgyHome() plans
    expect(fs.readFileSync(profileFiles[0] ?? '', 'utf8')).toBe(
      planAgyHome(wp.userData, path.join(wp.userData, 'agy-workspace')).files[0]?.text,
    );
    expect(JSON.parse(fs.readFileSync(profileFiles[0] ?? '', 'utf8'))).toEqual({
      trustedWorkspaces: [path.join(wp.userData, 'agy-workspace')],
      permissions: { allow: [], ask: [], deny: [...AGY_DENY_ALL] },
    });
    expect(j?.policyDenyAll).toBe(true);
  });

  it('smoke (provider start): the constant prompt, wca-smoke agent, --print-timeout 20s, the 1-field schema', async () => {
    const w = world({ state: { expectedPromptSha256: {} } });
    const p = w.provider();
    await p.validate(new AbortController().signal).catch(() => undefined);
    expect(w.spawnedArgs).toHaveLength(1);
    const argv = w.spawnedArgs[0] ?? [];
    expect(argv.slice(0, 11)).toEqual([
      '--agent',
      'wca-smoke',
      '--model',
      'gemini-3.8-flash-high', // [D-080] a suffixed slug: no --effort (agy 1.2.16 refuses the pair)
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--print-timeout',
      '20s',
      '--disable-slash-commands',
    ]);
    expect(argv).toHaveLength(11); // [agy-schema-loop] no --json-schema
    expect(runs(w)[0]?.bodySchemaSha256).not.toBeNull();
    const [j] = runs(w);
    expect(j?.stage).toBe('smoke');
    expect(j?.agentFile.bodySha256).toBe(sha256(CLI_SMOKE_SYSTEM));
    expect(j?.violations).toEqual([]);
    expect(leftovers(w)).toEqual([]);
  });

  it('the agent file on disk is exactly buildAgentFile(stage, constant): tools [], commandExecutionPolicy off, no MCP servers', () => {
    const text = buildAgentFile('extract', AGY_S1_SYSTEM);
    const [, fm] = text.split('---\n');
    expect(fm).toContain('tools: []\n');
    expect(fm).toContain('commandExecutionPolicy: off\n');
    expect(fm).toContain('excludeDefaultComponents: true\n');
    expect(fm).toContain('mainAgent: true\n');
    expect(fm).not.toMatch(/mcpServers|skills|plugins/);
    expect(text.endsWith(AGY_S1_SYSTEM)).toBe(true);
  });
});

describe("F3 isolated profile vs the user's global Antigravity config (mode global_mcp_present)", () => {
  it('isolated mode (default): a globally registered MCP server in the fake USER home is never loaded - the run is normal', async () => {
    expect(AGY_PROFILE_MODE).toBe('isolated');
    const w = world({ state: { mode: 'global_mcp_present' } });
    const planted = w.plantGlobalMcpConfig();
    await w
      .provider()
      .structured(S1, AGY_S1_SCHEMA, opts())
      .catch((e: unknown) => e);
    expect(w.spawnedArgs).toHaveLength(1);
    const [j] = runs(w);
    expect(j?.globalMcpVisible).toBe(false);
    expect(j?.home.userProfile).toBe(path.join(w.userData, 'agy-home'));
    expect(j?.violations).toEqual([]);
    // the planted file is untouched and the app wrote no copy of it
    expect(fs.existsSync(planted)).toBe(true);
    expect(appMcpConfigs(w)).toEqual([]);
  });

  it('fallback mode (global_checked): an enabled global server => refused BEFORE any spawn (CLI_UNSAFE_CONFIG path, no retry)', async () => {
    const w = world({ state: { mode: 'global_mcp_present', expectIsolatedHome: false } });
    const planted = w.plantGlobalMcpConfig();
    const p = w.provider({
      profileMode: 'global_checked',
      readGlobalConfig: () => ({ mcpConfigText: fs.readFileSync(planted, 'utf8'), hooksText: null }),
    });
    const err = await p.structured(S1, AGY_S1_SCHEMA, opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('sandbox');
    expect((await p.validate(new AbortController().signal)).ok).toBe(false);
    expect(w.spawnedArgs).toHaveLength(0);
    expect(w.journal()).toEqual([]);
  });
});

describe('init proof: each failure mode killed BEFORE any turn, toolset_mismatch, no retry', () => {
  it.each([
    ['agent_mismatch', 'agent_mismatch'],
    ['perm_mode', 'permission_mode'],
  ] as const)(
    '%s => kill before the first turn, toolset_mismatch (%s), LlmError sandbox, ONE spawn',
    async (mode, mismatch) => {
      const w = world({ state: { mode } });
      const sink = sandboxSink();
      const err = await w
        .provider()
        .structured(S1, AGY_S1_SCHEMA, opts({ onSandbox: sink.onSandbox }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe('sandbox');
      expect(sink.proofs).toHaveLength(1);
      expect(sink.proofs[0]).toMatchObject({ initOk: false, mismatch });
      expect(w.spawnedArgs).toHaveLength(1); // never a retry with looser flags
      const [j] = runs(w);
      expect(j?.turnStarted).toBe(false); // killed while the fake waited after its init line
      expect(j?.exit).toBe(-1);
      expect(w.audits.filter((a) => a.kind === 'toolset_mismatch')).toEqual([
        {
          kind: 'toolset_mismatch',
          ref: null,
          detail: { provider: 'antigravity_cli', stage: 'extract', reason: mismatch },
        },
      ]);
      expect(w.taskkills.length).toBeGreaterThanOrEqual(1);
      expect(w.taskkills.every((k) => k.tree)).toBe(true);
      expect(leftovers(w)).toEqual([]);
    },
  );

  it('a passing init proof on agy is STILL cli_unproven (B14/C4, T2 concern 1) - W1-03 providerClassOf', async () => {
    const w = world();
    const sink = sandboxSink();
    await w
      .provider()
      .structured(S1, AGY_S1_SCHEMA, opts({ onSandbox: sink.onSandbox }))
      .catch((e: unknown) => e);
    // [agy-provider-fix B] agy 1.2.16 lists its 60 tools: recorded as information; the proof says it rests on the policy + the watch
    expect(sink.proofs).toEqual([
      {
        initOk: true,
        toolsCount: 60,
        mcpServers: 0,
        apiKeySource: 'unknown',
        mismatch: null,
        policy: 'deny_all',
        runtimeWatch: true,
      },
    ]);
    const okRuns = sink.proofs.map((p) => p.initOk);
    expect(providerClassOf('antigravity_cli', [...okRuns, ...okRuns])).toBe('cli_unproven');
    expect(providerClassOf('antigravity_cli', [true, true, true])).toBe('cli_unproven');
    expect(providerClassOf('claude_cli', [true, true])).toBe('cli_proven'); // the contrast: only claude_cli can be proven
  });
});

describe('result table: never a permissions retry, never a result without the proof', () => {
  it('ok: SUCCESS + structured_output + empty denied_actions => the structured value', async () => {
    const w = world({
      script: [{ when: { purpose: 'extract' }, respond: { structured: { intent: 'meeting', confidence: 0.9 } } }],
    });
    const out = await w.provider().structured(S1, AGY_S1_SCHEMA, opts());
    expect(out).toEqual({ intent: 'meeting', confidence: 0.9 });
    expect(w.spawnedArgs).toHaveLength(1);
  });
  it.each(['waiting', 'denied', 'no_structured'] as const)(
    '%s => LlmError bad_output, ONE spawn (bug #794 shape included)',
    async (mode) => {
      const w = world({ state: { mode } });
      const err = await w
        .provider()
        .structured(S1, AGY_S1_SCHEMA, opts())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe('bad_output');
      expect(w.spawnedArgs).toHaveLength(1);
      expect(runs(w)[0]?.turnStarted).toBe(true);
      expect(leftovers(w)).toEqual([]);
    },
  );
});

describe('stdin (F20, U-A6): agy envelope only; a rejected stdin is not_ready, never an argv fallback', () => {
  it('the Claude envelope is refused by the fake (exit 1, malformed input): not_ready, ONE spawn, no -p ever', async () => {
    const w = world({ registerJournal: false }); // this test PROVOKES the fake's stdin_claude_envelope violation
    const res = await w.runner.run(
      {
        provider: 'antigravity_cli',
        stage: 'extract',
        exePath: w.exePath,
        model: 'gemini-3.8-flash-high',
        system: AGY_S1_SYSTEM,
        stdinLine: buildClaudeStdinLine(AGY_S1_USER, null),
        jsonSchema: AGY_S1_SCHEMA,
        maxTurns: 1,
        wallClockMs: LIMITS.cliWallClockExtractMs,
        toolServer: null,
        observedVersion: '1.2.12',
      },
      new AbortController().signal,
    );
    expect(res.structured).toBeNull();
    expect(res.error).toBe('not_ready');
    expect(w.spawnedArgs).toHaveLength(1);
    expect(w.spawnedArgs.flat()).not.toContain('-p');
    const [j] = runs(w);
    expect(j?.stdinEnvelope).toBe('claude');
    expect(j?.violations).toContain('stdin_claude_envelope');
    expect(j?.exit).toBe(1);
    expect(leftovers(w)).toEqual([]);
  });
});

describe('kill path', () => {
  it('hang: the wall clock tree-kills by PID (taskkill /PID /T /F), no result used, pid file and run dir removed', async () => {
    const w = world({ state: { mode: 'hang' }, graceMs: 200 });
    const res = await w.runner.run(
      {
        provider: 'antigravity_cli',
        stage: 'extract',
        exePath: w.exePath,
        model: 'gemini-3.8-flash-high',
        system: AGY_S1_SYSTEM,
        stdinLine: buildAgyStdinLine(AGY_S1_USER),
        jsonSchema: AGY_S1_SCHEMA,
        maxTurns: 1,
        wallClockMs: 3_000,
        toolServer: null,
        observedVersion: '1.2.12',
      },
      new AbortController().signal,
    );
    expect(res.structured).toBeNull();
    expect(res.error).not.toBeNull();
    expect(res.stopReason).toBe('killed');
    expect(w.taskkills.some((k) => k.tree)).toBe(true);
    const [j] = runs(w);
    expect(j?.exit).toBe(-1);
    expect(leftovers(w)).toEqual([]);
  });
});

describe('cli_run audit: enums / numbers / booleans only, never a path, text or model output', () => {
  it('every detail value is a primitive with no path, nonce block or prompt text', async () => {
    const w = world();
    await w
      .provider()
      .structured(S1, AGY_S1_SCHEMA, opts())
      .catch((e: unknown) => e);
    const cliRuns = w.audits.filter((a) => a.kind === 'cli_run');
    expect(cliRuns).toHaveLength(1);
    for (const v of Object.values(cliRuns[0]?.detail ?? {})) {
      expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
      if (typeof v === 'string') {
        expect(v).not.toMatch(/[\\/]|<<DATA-|coffee|S1 CONSTANT/);
        expect(v.length).toBeLessThan(40);
      }
    }
  });
});

describe('fake-agy.mjs self-test (T2 3.2)', () => {
  const run = (
    w: AgyFakeWorld,
    args: string[],
    o: { cwd?: string; env?: Record<string, string>; input?: string } = {},
  ): { status: number | null; stdout: string; stderr: string } => {
    const r = cp.spawnSync(
      process.execPath,
      [FAKE_AGY, '--fake-journal', w.journalFile, '--fake-state', w.stateFile, '--fake-end', ...args],
      { encoding: 'utf8', cwd: o.cwd ?? w.root, env: o.env ?? {}, input: o.input ?? '', windowsHide: true },
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("the fake's expected env set is exactly AGY_ENV_KEYS and its mode list equals the frozen FakeAgyMode list", async () => {
    const fake = (await import('../fakes/fake-agy.mjs')) as unknown as {
      EXPECTED_ENV_KEYS: string[];
      FAKE_AGY_MODES: string[];
    };
    expect([...fake.EXPECTED_ENV_KEYS].sort()).toEqual([...AGY_ENV_KEYS].sort());
    expect(fake.FAKE_AGY_MODES).toEqual([...FAKE_AGY_MODES]);
  });

  it('--version and `models` answer like the CLI; not signed in => exit 1 authentication required', () => {
    const w = world({
      registerJournal: false,
      state: { version: '1.2.13', models: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'] },
    });
    expect(run(w, ['--version'])).toMatchObject({ status: 0, stdout: '1.2.13\n' });
    const m = run(w, ['models']);
    expect(m.status).toBe(0);
    expect(m.stdout.split('\n').map((l) => l.trim())).toEqual(
      expect.arrayContaining(['gemini-3.8-flash-high', 'gemini-3.1-pro-high']),
    );
    w.setState({ loggedIn: false });
    const n = run(w, ['models']);
    expect(n.status).toBe(1);
    expect(n.stderr).toMatch(/authentication required/);
  });

  it('an unknown option => exit 1; -p <text>, --dangerously-skip-permissions, --sandbox, a positional prompt => accepted + violations', () => {
    const w = world({ registerJournal: false });
    expect(run(w, ['--resume', 'x']).status).toBe(1);
    const res = run(
      w,
      ['--agent', 'wca-extract', '-p', 'hello', '--dangerously-skip-permissions', '--sandbox', 'positional'],
      {
        input: buildAgyStdinLine(AGY_S1_USER),
      },
    );
    expect(res.status).toBe(0); // T2 3.2: accepted (like the real CLI would) + journaled as violations
    const all = readFakeAgyJournal(fs.readFileSync(w.journalFile, 'utf8')).flatMap((e) => e.violations);
    expect(all).toEqual(
      expect.arrayContaining([
        'forbidden_flag:-p',
        'forbidden_flag:--dangerously-skip-permissions',
        'forbidden_flag:--sandbox',
        'forbidden_flag:positional_prompt',
      ]),
    );
  });

  it('a workspace .agents\\mcp_config.json, message text on argv, two stdin lines, a missing nonce block => violations', () => {
    const w = world({ registerJournal: false });
    const runDir = path.join(w.userData, 'agy-workspace', 'runs', 'selftest');
    fs.mkdirSync(path.join(runDir, '.agents', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, '.agents', 'agents', 'wca-extract.md'),
      buildAgentFile('extract', AGY_S1_SYSTEM),
    );
    fs.writeFileSync(path.join(runDir, '.agents', 'mcp_config.json'), '{"mcpServers":{}}');
    try {
      run(
        w,
        [
          '--agent',
          'wca-extract',
          '--model',
          'x-y',
          '--effort',
          'low',
          '--output-format',
          'stream-json',
          '--input-format',
          'stream-json',
          '--print-timeout',
          '5s',
          '--disable-slash-commands',
          '--model',
          '<<DATA-0123456789abcdef>>',
        ],
        { cwd: runDir, input: `${buildAgyStdinLine('no block')}\n${buildAgyStdinLine('second')}\n` },
      );
      const v = readFakeAgyJournal(fs.readFileSync(w.journalFile, 'utf8')).flatMap((e) => e.violations);
      expect(v).toEqual(
        expect.arrayContaining([
          'mcp_config_present',
          'argv_message_text',
          'stdin_shape:lines_2',
          'env_auto_update_not_disabled',
        ]),
      );
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('the Claude stdin envelope => exit 1 malformed input + violation stdin_claude_envelope', () => {
    const w = world({ registerJournal: false });
    const r = run(w, ['--agent', 'wca-extract'], { input: `${buildClaudeStdinLine(AGY_S1_USER, null)}\n` });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/malformed input/);
    const v = readFakeAgyJournal(fs.readFileSync(w.journalFile, 'utf8')).flatMap((e) => e.violations);
    expect(v).toContain('stdin_claude_envelope');
  });
});

describe('the fake speaks the documented stream-json; the W1-09 classifiers read it (runner-independent cross-check)', () => {
  // Prepares a run dir EXACTLY like the CliRunner's agy branch (planAgyHome files, agent file with the schema in its body, buildAgyEnv) and runs the
  // fake directly. This pins the fake's output against agyEventResult / classifyAgyResult / checkAgyInit / classifyAgyErrorText, so the
  // same bytes that the production runner reads are proven classifiable (C2 9.2 result + error tables).
  const runDirect = (w: AgyFakeWorld, mode: FakeAgyMode) => {
    w.setState({ mode });
    const ws = path.join(w.userData, 'agy-workspace');
    const runDir = path.join(ws, 'runs', `direct-${mode}`);
    const home = planAgyHome(w.userData, ws);
    for (const f of home.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.text);
    }
    fs.mkdirSync(path.join(runDir, '.agents', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, '.agents', 'agents', 'wca-extract.md'),
      buildAgentFile('extract', AGY_S1_SYSTEM, AGY_S1_SCHEMA),
    );
    const env = buildAgyEnv({ processEnv: w.processEnv, tempDir: runDir, home: home.env });
    const args = buildAgyArgs(
      {
        provider: 'antigravity_cli',
        stage: 'extract',
        exePath: w.exePath,
        model: 'gemini-3.8-flash-high',
        system: AGY_S1_SYSTEM,
        stdinLine: buildAgyStdinLine(AGY_S1_USER),
        jsonSchema: AGY_S1_SCHEMA,
        maxTurns: 1,
        wallClockMs: LIMITS.cliWallClockExtractMs,
        toolServer: null,
        observedVersion: '1.2.12',
      },
      null,
    );
    const r = cp.spawnSync(
      process.execPath,
      [FAKE_AGY, '--fake-journal', w.journalFile, '--fake-state', w.stateFile, '--fake-end', ...args],
      {
        encoding: 'utf8',
        cwd: runDir,
        env,
        input: `${buildAgyStdinLine(AGY_S1_USER)}\n`,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    fs.rmSync(runDir, { recursive: true, force: true });
    const events = r.stdout
      .split('\n')
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e));
    const result =
      events
        .map(agyEventResult)
        .filter((x) => x !== null)
        .at(-1) ?? null;
    return { status: r.status, stderr: r.stderr, first: events[0], result, events };
  };
  const RESULT_MODES: Record<string, 'ok' | 'bad_output'> = {
    ok: 'ok',
    extra_tools: 'ok', // [agy-provider-fix B] an init listing tools passes; the watch + policy carry the proof
    garbage_lines: 'ok',
    global_mcp_present: 'ok',
    waiting: 'bad_output',
    denied: 'bad_output',
    no_structured: 'bad_output',
  };
  it.each(Object.entries(RESULT_MODES))('mode %s => exit 0, init proven, result table says %s', (mode, want) => {
    const w = world();
    if (mode === 'global_mcp_present') w.plantGlobalMcpConfig();
    const r = runDirect(w, mode as FakeAgyMode);
    expect(r.status).toBe(0);
    expect(checkAgyInit(r.first, 'extract')).toMatchObject({ initOk: true });
    const c = classifyAgyResult(r.result);
    expect(c.ok ? 'ok' : c.error).toBe(want);
    if (c.ok) expect(c.structured).toEqual({ intent: 'meeting', confidence: 0 });
    expect(runs(w)[0]?.violations).toEqual([]);
  });
  it.each([
    ['exit3', 'usage_limit'],
    ['exit3_auth', 'not_logged_in'],
    ['exit3_other', 'network'],
  ] as const)('mode %s => exit 3 + one AGY_ERROR stderr line classified %s', (mode, code) => {
    const w = world();
    const r = runDirect(w, mode);
    expect(r.status).toBe(3);
    const line = r.stderr.split('\n').find((l) => l.startsWith('AGY_ERROR:')) ?? '';
    expect(classifyAgyErrorText(line)).toBe(code);
  });
  it.each([
    ['agent_mismatch', 'agent_mismatch'],
    ['perm_mode', 'permission_mode'],
  ] as const)('mode %s => the first event fails checkAgyInit (%s)', (mode, mismatch) => {
    const w = world();
    const r = runDirect(w, mode);
    expect(checkAgyInit(r.first, 'extract')).toMatchObject({ initOk: false, mismatch });
  });
  it('[agy-provider-fix E] the default stream is the captured agy 1.2.16 shape', () => {
    const w = world();
    const r = runDirect(w, 'ok');
    expect(r.status).toBe(0);
    type Ev = { event?: unknown; init?: Record<string, unknown>; step_update?: Record<string, unknown> };
    const [init, ...rest] = r.events as Ev[];
    // init: no top-level conversation_id; agent loaded; ALL 60 tools listed; request-review; no json_schema (the app never passes --json-schema)
    expect(Object.keys(init ?? {}).sort()).toEqual(['event', 'init']);
    expect(Object.keys(init?.init ?? {}).sort()).toEqual(['agent', 'cwd', 'model', 'permission_mode', 'tools'].sort());
    expect(init?.init).toMatchObject({ agent: 'wca-extract', permission_mode: 'request-review' });
    expect(init?.init?.tools).toHaveLength(60);
    expect(init?.init?.tools).toEqual(expect.arrayContaining(['run_command', 'manage_task', 'read_url_content']));
    // agy calls manage_task {"Action":"list"} by itself: ACTIVE then DONE, both tolerated by the watch
    const steps = rest.filter((e) => e.event === 'step_update' && e.step_update?.step_type === 'tool');
    expect(steps.map((s) => [s.step_update?.state, s.step_update?.tool_name])).toEqual([
      ['ACTIVE', 'manage_task'],
      ['DONE', 'manage_task'],
    ]);
    expect(steps[1]?.step_update?.tool_info).toEqual({
      name: 'manage_task',
      parameters: { Action: 'list' },
      output: 'No background tasks are currently running.',
    });
    for (const e of rest) expect(agyStepVerdict(e).kind).not.toBe('blocked');
    // the nested result: the answer is a STRING in result.response, there is NO structured_output
    expect(Object.keys(r.result ?? {}).sort()).toEqual(
      ['conversation_id', 'duration_seconds', 'num_turns', 'response', 'status', 'usage'].sort(),
    );
    expect(r.result?.structured_output).toBeUndefined();
    expect(typeof r.result?.response).toBe('string');
    expect(classifyAgyResult(r.result)).toEqual({ ok: true, structured: { intent: 'meeting', confidence: 0 } });
  });

  it.each([
    ['forbidden_tool_step', 'run_command'],
    ['forbidden_tool_done_only', 'run_command'],
    ['manage_task_other_action', 'manage_task'],
  ] as const)('mode %s => the stream carries a step the watch blocks (%s)', (mode, name) => {
    const w = world();
    const r = runDirect(w, mode);
    const blocked = r.events.map(agyStepVerdict).filter((v) => v.kind === 'blocked');
    expect(blocked[0]).toEqual({ kind: 'blocked', name });
  });

  it('mode print_timeout_partial => the "[agy] print timeout" stderr line and a truncated answer the parser refuses', () => {
    const w = world();
    const r = runDirect(w, 'print_timeout_partial');
    expect(r.stderr).toMatch(/^\[agy\] print timeout after/m);
    expect(classifyAgyResult(r.result)).toEqual({ ok: false, error: 'bad_output' });
  });

  it('mode not_signed_in => exit 1 before any event, stderr "authentication required"', () => {
    const w = world();
    const r = runDirect(w, 'not_signed_in');
    expect(r.status).toBe(1);
    expect(r.first).toBeUndefined();
    expect(r.stderr).toMatch(/authentication required/);
  });
});

// [D-080] Live diagnostic (user-approved, agy 1.2.16): `--model gemini-3.8-flash-high --effort low` is refused with one stderr line, exit 1
// and a {"event":"result",...,"error":...} as the FIRST stdout event (no init). The fake now does exactly that, so a regression of the argv
// builder (passing --effort next to a suffixed slug) fails here; and an error event before init is a classified failure - never
// CLI_TOOLSET_MISMATCH, never proven, never retried with other flags.
describe('[D-080] model / effort conflict and error events before init (fake = agy 1.2.16 behaviour)', () => {
  const runWithArgs = (w: AgyFakeWorld, model: string, extra: string[]) => {
    const ws = path.join(w.userData, 'agy-workspace');
    const runDir = path.join(ws, 'runs', `direct-${crypto.randomBytes(3).toString('hex')}`);
    const home = planAgyHome(w.userData, ws);
    for (const f of home.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.text);
    }
    fs.mkdirSync(path.join(runDir, '.agents', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, '.agents', 'agents', 'wca-extract.md'),
      buildAgentFile('extract', AGY_S1_SYSTEM, AGY_S1_SCHEMA),
    );
    const args = [
      ...buildAgyArgs(
        {
          provider: 'antigravity_cli',
          stage: 'extract',
          exePath: w.exePath,
          model,
          system: AGY_S1_SYSTEM,
          stdinLine: buildAgyStdinLine(AGY_S1_USER),
          jsonSchema: AGY_S1_SCHEMA,
          maxTurns: 1,
          wallClockMs: LIMITS.cliWallClockExtractMs,
          toolServer: null,
          observedVersion: '1.2.16',
        },
        null,
      ),
      ...extra,
    ];
    const r = cp.spawnSync(
      process.execPath,
      [FAKE_AGY, '--fake-journal', w.journalFile, '--fake-state', w.stateFile, '--fake-end', ...args],
      {
        encoding: 'utf8',
        cwd: runDir,
        env: buildAgyEnv({ processEnv: w.processEnv, tempDir: runDir, home: home.env }),
        input: `${buildAgyStdinLine(AGY_S1_USER)}\n`,
        windowsHide: true,
        timeout: 10_000,
      },
    );
    fs.rmSync(runDir, { recursive: true, force: true });
    const first = r.stdout.split('\n').find((l) => l.trim().length > 0);
    return {
      status: r.status,
      stderr: r.stderr,
      args,
      first: first === undefined ? undefined : (JSON.parse(first) as unknown),
    };
  };

  it('the fake refuses --effort next to a suffixed slug exactly like 1.2.16: stderr line, exit 1, a result event FIRST, no init', () => {
    const w = world({ registerJournal: false }); // this test PROVOKES the effort_with_suffixed_model violation
    const r = runWithArgs(w, 'gemini-3.8-flash-high', ['--effort', 'low']);
    expect(r.status).toBe(1);
    expect(r.stderr.trim()).toBe(
      'error: invalid model selection (--model "gemini-3.8-flash-high" --effort "low"): --model gemini-3.8-flash-high conflicts with --effort=low',
    );
    expect(Object.keys(r.first as object).sort()).toEqual(
      ['conversation_id', 'duration_seconds', 'error', 'event', 'num_turns', 'response', 'status', 'usage'].sort(),
    );
    expect(r.first).toMatchObject({ event: 'result', error: expect.stringMatching(/conflicts with --effort=low/) });
    expect(checkAgyInit(r.first, 'extract')).toMatchObject({ initOk: false });
    expect(runs(w)[0]?.violations).toContain('effort_with_suffixed_model');
  });

  it('the production argv never provokes it: suffixed slug => no --effort; plain slug => --effort low (both clean in the journal)', () => {
    const w = world();
    const a = runWithArgs(w, 'gemini-3.8-flash-high', []);
    expect(a.args).not.toContain('--effort');
    expect(a.status).toBe(0);
    expect(checkAgyInit(a.first, 'extract')).toMatchObject({ initOk: true });
    const b = runWithArgs(w, 'gemini-3.8-flash', []);
    expect(b.args.slice(2, 6)).toEqual(['--model', 'gemini-3.8-flash', '--effort', 'low']);
    expect(b.status).toBe(0);
    for (const j of runs(w)) expect(j.violations).toEqual([]);
  });

  it.each([
    ['result_error_auth', 'not_logged_in'],
    ['result_error_quota', 'usage_limit'],
    ['result_error_other', 'network'],
  ] as const)(
    'mode %s through the production runner + provider => LlmError %s, NO proof, no toolset_mismatch, ONE spawn',
    async (mode, code) => {
      const w = world({ state: { mode } });
      const sink = sandboxSink();
      const err = await w
        .provider()
        .structured(S1, AGY_S1_SCHEMA, opts({ onSandbox: sink.onSandbox }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe(code);
      expect(sink.proofs).toEqual([
        { initOk: false, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
      ]);
      expect(w.spawnedArgs).toHaveLength(1);
      expect(w.audits.filter((a) => a.kind === 'toolset_mismatch')).toEqual([]);
      const row = w.audits.find((a) => a.kind === 'cli_run');
      expect(row?.detail).toMatchObject({ initOk: false, errorBeforeInit: code });
      expect(runs(w)[0]?.turnStarted).toBe(false);
      expect(leftovers(w)).toEqual([]);
    },
  );

  it('the provider-start smoke reports the classified reason (a model rejection is CLI_MODEL_REJECTED, not a toolset change)', async () => {
    const w = world({ state: { mode: 'result_error_auth' } });
    expect(await w.provider().validate(new AbortController().signal)).toEqual({ ok: false, reason: 'not_logged_in' });
    expect(w.audits.filter((a) => a.kind === 'toolset_mismatch')).toEqual([]);
  });
});

// [agy-provider-fix] agy 1.2.16 lists all 60 available tools in init.tools, so an agy run's I11 proof rests on: (A) the app-owned isolated
// settings.json carries the deny-all permissions policy and is RE-READ before every spawn (fail closed: no spawn without it); (C) the
// runner's runtime tool watch kills the job on the first step_update that is a tool other than manage_task {"Action":"list"}; and the
// agent file's tools: []. A run killed by the watch is a failed run: its answer is never used, the strike is audited (hashed name only)
// and counted for the breaker. Every proposal stays cli_unproven (B14/C4).
describe('[agy-provider-fix C] runtime tool watch: a forbidden tool step kills the run, nothing of it is used', () => {
  it.each([
    ['forbidden_tool_step', 'run_command'],
    ['forbidden_tool_done_only', 'run_command'],
    ['manage_task_other_action', 'manage_task'],
  ] as const)(
    '%s => killed at once (tree), LlmError sandbox, no answer, tool_blocked {nameSha8} + run_aborted, ONE spawn',
    async (mode, toolName) => {
      const w = world({
        state: { mode },
        script: [{ when: { purpose: 'extract' }, respond: { structured: { intent: 'meeting', confidence: 0.99 } } }],
      });
      const sink = sandboxSink();
      const got = await w
        .provider()
        .structured(S1, AGY_S1_SCHEMA, opts({ onSandbox: sink.onSandbox }))
        .then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );
      expect(got.ok).toBe(false); // the scripted answer {intent:'meeting'} must never come back
      if (!got.ok) {
        expect(got.e).toBeInstanceOf(LlmError);
        expect((got.e as LlmError).code).toBe('sandbox');
      }
      // the recorded proof is a FAILED proof (runs.sandbox_ok = 0), saying what carried it
      expect(sink.proofs).toEqual([
        {
          initOk: false,
          toolsCount: 60,
          mcpServers: 0,
          apiKeySource: 'unknown',
          mismatch: 'extra_tool',
          policy: 'deny_all',
          runtimeWatch: true,
        },
      ]);
      expect(w.spawnedArgs).toHaveLength(1); // never a retry
      const [j] = runs(w);
      expect(j?.toolStepEmitted).toBe(toolName);
      expect(j?.toolStepCompleted).toBe(false); // killed while the fake waited after the forbidden step
      expect(j?.exit).toBe(-1);
      expect(w.taskkills.length).toBeGreaterThanOrEqual(1);
      expect(w.taskkills.every((k) => k.tree)).toBe(true);
      // B26: the tool name reaches the audit only as sha8 + length
      const blocked = w.audits.filter((a) => a.kind === 'tool_blocked');
      expect(blocked).toEqual([
        {
          kind: 'tool_blocked',
          ref: null,
          detail: {
            nameSha8: crypto.createHash('sha256').update(toolName, 'utf8').digest('hex').slice(0, 8),
            nameLen: toolName.length,
            verdict: 'blocked_unknown_tool',
            runId: null,
          },
        },
      ]);
      expect(JSON.stringify(w.audits)).not.toContain(toolName);
      expect(w.audits.filter((a) => a.kind === 'run_aborted')).toHaveLength(1);
      expect(w.audits.find((a) => a.kind === 'cli_run')?.detail).toMatchObject({
        initOk: false,
        blockedCalls: 1,
        stopReason: 'killed',
      });
      expect(leftovers(w)).toEqual([]);
    },
    20_000,
  );

  it('three blocked runs open the breaker (CLI_UNSTABLE): the 4th job is never spawned', async () => {
    const w = world({ state: { mode: 'forbidden_tool_done_only' } });
    const p = w.provider();
    for (let i = 0; i < 3; i += 1) {
      const e = await p.structured(S1, AGY_S1_SCHEMA, opts()).catch((x: unknown) => x);
      expect((e as LlmError).code).toBe('sandbox');
    }
    expect(w.runner.breakerOpen()).toBe(true);
    const e4 = await p.structured(S1, AGY_S1_SCHEMA, opts()).catch((x: unknown) => x);
    expect(e4).toBeInstanceOf(LlmError);
    expect(w.spawnedArgs).toHaveLength(3);
  }, 30_000);

  it('the provider-start smoke with a forbidden step fails (sandbox) - a provider that runs tools never becomes ready', async () => {
    const w = world({ state: { mode: 'forbidden_tool_step' } });
    expect(await w.provider().validate(new AbortController().signal)).toEqual({ ok: false, reason: 'sandbox' });
  }, 20_000);
});

describe('[agy-provider-fix A] the deny-all permissions policy is re-read before every spawn (fail closed)', () => {
  it.each([
    ['policy_missing', 'policy_missing'],
    ['policy_altered', 'policy_altered'],
  ] as const)(
    '%s => refused BEFORE any spawn: LlmError sandbox, no process, no journal, audited %s',
    async (mode, reason) => {
      const w = world({ state: { mode } });
      const sink = sandboxSink();
      const err = await w
        .provider()
        .structured(S1, AGY_S1_SCHEMA, opts({ onSandbox: sink.onSandbox }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe('sandbox');
      expect(sink.proofs).toEqual([
        { initOk: false, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
      ]);
      expect(w.spawnedArgs).toEqual([]); // the stdin line (message text) never left the app
      expect(w.journal()).toEqual([]);
      expect(w.audits.filter((a) => a.kind === 'toolset_mismatch')).toEqual([
        { kind: 'toolset_mismatch', ref: null, detail: { provider: 'antigravity_cli', stage: 'extract', reason } },
      ]);
      // the smoke is refused the same way; nothing spawned either
      expect(await w.provider().validate(new AbortController().signal)).toEqual({ ok: false, reason: 'sandbox' });
      expect(w.spawnedArgs).toEqual([]);
      expect(leftovers(w)).toEqual([]);
    },
  );

  it('a tampered policy left on disk is rewritten and re-verified on the next job (no stale file is trusted or blocks forever)', async () => {
    const w = world({ state: { mode: 'policy_altered' } });
    const p = w.provider();
    expect(((await p.structured(S1, AGY_S1_SCHEMA, opts()).catch((e: unknown) => e)) as LlmError).code).toBe('sandbox');
    w.setState({ mode: 'ok' });
    expect(await p.structured(S1, AGY_S1_SCHEMA, opts())).toEqual({ intent: 'meeting', confidence: 0 });
    expect(w.spawnedArgs).toHaveLength(1);
    expect(runs(w)[0]?.policyDenyAll).toBe(true);
  });
});

describe('[agy-provider-fix] print timeout: partial output is never used', () => {
  it('print_timeout_partial => LlmError network, no answer, ONE spawn', async () => {
    const w = world({ state: { mode: 'print_timeout_partial' } });
    const err = await w
      .provider()
      .structured(S1, AGY_S1_SCHEMA, opts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('network');
    expect(w.spawnedArgs).toHaveLength(1);
  });
});
