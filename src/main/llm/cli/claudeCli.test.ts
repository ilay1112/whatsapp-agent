// src/main/llm/cli/claudeCli.test.ts - T2 5 row `llm/cli/claudeCli.ts` (owner V2-W1-06-claude-cli).
// argv literal per stage (S1, S3, V1, smoke) = ARCH2 4.3 incl. the empty element after --tools and the literal ${WCA_MCP_TOKEN};
// env literal key sets; stdin envelope (F20); init proof table (F13 StructuredOutput, U-C7 connectors, U-C2 apiKeySource); provider.
import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../../shared/types';
import { AGY_ENV_KEYS, CLAUDE_ENV_KEYS, CLAUDE_S3_ENV_KEYS } from '../../proc/jobRunner';
import { LlmError, type AgenticRunInput, type CallOpts } from '../types';
import type { CliRunRequest, CliRunResult } from './runner';
import type { CliLocator } from './locator';
import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_ENV_FIXED,
  CLAUDE_MCP_CONFIG_MODE,
  CLAUDE_MIN_VERSION,
  CLAUDE_NEVER_ARGS,
  CLAUDE_PERMISSION_PROMPTS_MIN,
  CLI_NEUTRAL_INTERNALS,
  CLI_OAUTH_API_KEY_SOURCE,
  CLI_SCHEMA_TOOL,
  CLI_SMOKE_SCHEMA,
  CLI_SMOKE_SYSTEM,
  CLI_SMOKE_USER,
  buildAgyProbeEnv,
  buildClaudeArgs,
  buildClaudeEnv,
  buildClaudeStdinLine,
  buildClaudeStdinLineParts,
  buildInlineMcpConfig,
  buildRunFileMcpConfig,
  checkClaudeInit,
  createClaudeCliProvider,
  isClaudeCliProvider,
  makeClaudeCliFactory,
  mapApiKeySource,
  nameSha8,
  stripOneCodeFence,
  type ClaudeRunRequestExt,
} from './claudeCli';

const SYS = 'S1 CONSTANT\nReturn the JSON object only, on one line, no markdown.';
const SCHEMA = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['a'] };
const base = (over: Partial<CliRunRequest> = {}): CliRunRequest => ({
  provider: 'claude_cli',
  stage: 'extract',
  exePath: 'C:\\h\\.local\\bin\\claude.exe',
  model: 'sonnet',
  system: SYS,
  stdinLine: '{}',
  jsonSchema: SCHEMA,
  maxTurns: 1,
  wallClockMs: 60_000,
  toolServer: null,
  observedVersion: '2.1.258',
  ...over,
});
const FIXED_HEAD = ['-p', '--restricted', '--strict-mcp-config', '--tools', '', '--permission-mode', 'dontAsk'];
const MID = (system: string, turns: number, model: string): string[] => [
  '--disallowedTools',
  CLAUDE_DISALLOWED_TOOLS,
  '--disable-slash-commands',
  '--no-session-persistence',
  '--system-prompt',
  system,
  '--max-turns',
  String(turns),
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  '--model',
  model,
];

describe('frozen constants', () => {
  it('match C2 9.2 / ARCH2 4.3 literally', () => {
    expect(CLAUDE_DISALLOWED_TOOLS).toBe(
      'Bash,PowerShell,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Skill,Monitor,Workflow,SendMessage,Artifact,SendUserFile,PushNotification,RemoteTrigger,EnterWorktree,ExitWorktree,TaskCreate,TaskUpdate,CronCreate',
    );
    expect([...CLAUDE_NEVER_ARGS]).toEqual([
      '--bare',
      '--dangerously-skip-permissions',
      'bypassPermissions',
      '--add-dir',
      '--settings',
      '--continue',
      '--resume',
      '--append-system-prompt',
      '--append-system-prompt-file',
      '--system-prompt-file',
    ]);
    expect(CLAUDE_MIN_VERSION).toBe('2.1.248');
    expect(CLAUDE_PERMISSION_PROMPTS_MIN).toBe('2.1.259');
    expect(CLI_SCHEMA_TOOL).toBe('StructuredOutput');
    expect(CLAUDE_MCP_CONFIG_MODE).toBe('inline_env');
    // T2 8.2 group 18: until M-CLI-1 pins it the OAuth literal is null (ACCEPTANCE lists M-CLI-1 open) - no skip.
    expect(CLI_OAUTH_API_KEY_SOURCE).toBeNull();
    expect(CLI_NEUTRAL_INTERNALS).toEqual([]);
    expect(CLI_SMOKE_SCHEMA).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    });
    expect(CLI_SMOKE_USER).toMatch(/^<<DATA-[0-9a-f]{16}>>\n[\s\S]*\n<<END-DATA-[0-9a-f]{16}>>$/);
  });
});

describe('buildClaudeArgs - literal per stage', () => {
  it('S1 on 2.1.258: no --permission-prompts; --effort low; --json-schema one line; no MCP', () => {
    expect(buildClaudeArgs(base())).toEqual([
      ...FIXED_HEAD,
      ...MID(SYS, 1, 'sonnet'),
      '--fallback-model',
      'haiku',
      '--effort',
      'low',
      '--json-schema',
      JSON.stringify(SCHEMA),
    ]);
  });

  it('--permission-prompts none iff >= 2.1.259 (2.1.258 / garbage => absent)', () => {
    expect(buildClaudeArgs(base({ observedVersion: '2.1.259' })).slice(0, 9)).toEqual([
      ...FIXED_HEAD,
      '--permission-prompts',
      'none',
    ]);
    expect(buildClaudeArgs(base({ observedVersion: '3.0.0' }))).toContain('--permission-prompts');
    expect(buildClaudeArgs(base({ observedVersion: 'garbage' }))).not.toContain('--permission-prompts');
  });

  it('S3 inline_env: --effort medium, --mcp-config with the literal ${WCA_MCP_TOKEN}, --allowedTools mcp__wca__*, no --json-schema', () => {
    const url = 'http://127.0.0.1:50123/mcp';
    const args = buildClaudeArgs(
      base({
        stage: 'draft',
        system: 'S3',
        jsonSchema: null,
        maxTurns: 5,
        toolServer: { url, token: 'SECRET-TOKEN-XYZ' },
      }),
    );
    expect(args).toEqual([
      ...FIXED_HEAD,
      ...MID('S3', 5, 'sonnet'),
      '--fallback-model',
      'haiku',
      '--effort',
      'medium',
      '--mcp-config',
      '{"mcpServers":{"wca":{"type":"http","url":"http://127.0.0.1:50123/mcp","headers":{"Authorization":"Bearer ${WCA_MCP_TOKEN}"}}}}',
      '--allowedTools',
      'mcp__wca__*',
    ]);
    expect(args.join('\u0000')).not.toContain('SECRET-TOKEN-XYZ');
    expect(buildInlineMcpConfig(url)).toBe(args[args.indexOf('--mcp-config') + 1]);
  });

  it('S3 run_file (F16): --mcp-config <path>; the body holds the literal token; a missing path throws', () => {
    const r = base({ stage: 'draft', jsonSchema: null, toolServer: { url: 'http://127.0.0.1:1/mcp', token: 'T0K' } });
    const args = buildClaudeArgs(r, { mode: 'run_file', mcpConfigPath: 'C:\\ud\\cli-runs\\r\\wca.mcp.json' });
    expect(args.slice(-4)).toEqual([
      '--mcp-config',
      'C:\\ud\\cli-runs\\r\\wca.mcp.json',
      '--allowedTools',
      'mcp__wca__*',
    ]);
    expect(args.join()).not.toContain('T0K');
    expect(() => buildClaudeArgs(r, { mode: 'run_file' })).toThrow('claude_mcp_config_path_missing');
    expect(JSON.parse(buildRunFileMcpConfig('http://127.0.0.1:1/mcp', 'T0K'))).toEqual({
      mcpServers: { wca: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer T0K' } } },
    });
  });

  it('V1 read_image: --tools "" --max-turns 1 --json-schema <IMAGE_READ_SCHEMA>, never --mcp-config', () => {
    const args = buildClaudeArgs(base({ stage: 'read_image', system: 'V1' }));
    expect(args.slice(0, 5)).toEqual(['-p', '--restricted', '--strict-mcp-config', '--tools', '']);
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--allowedTools');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('smoke: haiku without --fallback-model haiku (equal fallback refused by the CLI)', () => {
    const args = buildClaudeArgs(
      base({ stage: 'smoke', model: 'haiku', system: CLI_SMOKE_SYSTEM, jsonSchema: CLI_SMOKE_SCHEMA }),
    );
    expect(args).toEqual([
      ...FIXED_HEAD,
      ...MID(CLI_SMOKE_SYSTEM, 1, 'haiku'),
      '--effort',
      'low',
      '--json-schema',
      JSON.stringify(CLI_SMOKE_SCHEMA),
    ]);
  });

  it('a draft without a tool server (defensive) carries no MCP flags', () => {
    expect(buildClaudeArgs(base({ stage: 'draft', jsonSchema: null }))).not.toContain('--mcp-config');
  });

  it.each(['extract', 'draft', 'read_image', 'smoke'] as const)(
    'never a CLAUDE_NEVER_ARGS entry, never a positional prompt (%s)',
    (stage) => {
      const args = buildClaudeArgs(
        base({
          stage,
          toolServer: stage === 'draft' ? { url: 'http://127.0.0.1:2/mcp', token: 't' } : null,
          jsonSchema: stage === 'draft' ? null : SCHEMA,
        }),
      );
      for (const never of CLAUDE_NEVER_ARGS) expect(args).not.toContain(never);
      // every value follows its flag: no bare word stands alone
      const valued = new Set([
        '--tools',
        '--permission-mode',
        '--permission-prompts',
        '--disallowedTools',
        '--system-prompt',
        '--max-turns',
        '--output-format',
        '--input-format',
        '--model',
        '--fallback-model',
        '--effort',
        '--json-schema',
        '--mcp-config',
        '--allowedTools',
      ]);
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string;
        if (valued.has(a)) i += 1;
        else expect(a.startsWith('-')).toBe(true);
      }
    },
  );
});

describe('env builders', () => {
  const planted = {
    SYSTEMROOT: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\wca-fake-home',
    HomeDrive: 'C:',
    HOMEPATH: '\\Users\\wca-fake-home',
    APPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\wca-fake-home\\AppData\\Local',
    ANTHROPIC_API_KEY: 'sk-ant-TESTONLY-x',
    ANTHROPIC_BASE_URL: 'http://evil',
    CLAUDE_CONFIG_DIR: 'C:\\evil',
    HTTPS_PROXY: 'http://evil',
    NODE_OPTIONS: '--require evil',
    WHATSAPP_BRIDGE_TOKEN: 'b',
    GEMINI_API_KEY: 'AIzaTESTONLY',
  };
  it('Claude env = CLAUDE_ENV_KEYS literally (S1/V1/smoke), + WCA_MCP_TOKEN on S3; fixed values; PATH System32; TEMP = run dir', () => {
    const env = buildClaudeEnv({ processEnv: planted, tempDir: 'C:\\ud\\cli-runs\\r1', token: null });
    expect(Object.keys(env).sort()).toEqual([...CLAUDE_ENV_KEYS].sort());
    expect(env).toMatchObject({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      TEMP: 'C:\\ud\\cli-runs\\r1',
      TMP: 'C:\\ud\\cli-runs\\r1',
      HOMEDRIVE: 'C:',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      MCP_TIMEOUT: '10000',
      MCP_TOOL_TIMEOUT: '25000',
      ENABLE_TOOL_SEARCH: 'false',
      CI: '1',
    });
    expect(JSON.stringify(env)).not.toMatch(/TESTONLY|evil/);
    const s3 = buildClaudeEnv({ processEnv: planted, tempDir: 'C:\\r', token: 'TOK' });
    expect(Object.keys(s3).sort()).toEqual([...CLAUDE_S3_ENV_KEYS].sort());
    expect(s3.WCA_MCP_TOKEN).toBe('TOK');
    expect(Object.keys(CLAUDE_ENV_FIXED)).toHaveLength(12);
  });

  it('missing values become empty strings; SystemRoot defaults to C:\\Windows', () => {
    const env = buildClaudeEnv({ processEnv: {}, tempDir: 'C:\\r', token: null });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.USERPROFILE).toBe('');
  });

  it('agy probe env = AGY_ENV_KEYS literally, AGY_CLI_DISABLE_AUTO_UPDATE=true, never GEMINI_API_KEY', () => {
    const env = buildAgyProbeEnv(planted, 'C:\\t');
    expect(Object.keys(env).sort()).toEqual([...AGY_ENV_KEYS].sort());
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
    expect(env.HOME).toBe(planted.USERPROFILE);
    expect(JSON.stringify(env)).not.toMatch(/TESTONLY|evil/);
  });
});

describe('stdin envelope (F20)', () => {
  it('one line; text block; image block FIRST; several text blocks for the repair retry', () => {
    const text = '<<DATA-0123456789abcdef>>\n{"m":"line1\\nline2"}\n<<END-DATA-0123456789abcdef>>';
    const line = buildClaudeStdinLine(text, null);
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    const withImage = JSON.parse(buildClaudeStdinLine(text, { mime: 'image/png', base64: 'AAAA' }));
    expect(withImage.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(withImage.message.content[1]).toEqual({ type: 'text', text });
    const two = JSON.parse(buildClaudeStdinLineParts(['a', 'b'], null));
    expect(two.message.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    // agy's own envelope is {"event":"user",...} (F20) - the Claude envelope never uses that key
    expect(Object.keys(JSON.parse(line))).toEqual(['type', 'message']);
  });
});

describe('mapApiKeySource (U-C2, deny list while unpinned)', () => {
  it.each<[unknown, string]>([
    ['none', 'none'],
    ['oauth', 'oauth'],
    ['claude.ai', 'oauth'],
    ['ANTHROPIC_API_KEY', 'other'],
    ['apiKeyHelper', 'other'],
    ['user', 'other'],
    ['project', 'other'],
    ['org', 'other'],
    ['temporary', 'other'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'other'],
    ['something-new', 'other'],
    [undefined, 'unknown'],
    ['', 'unknown'],
    [5, 'unknown'],
  ])('%s => %s', (v, want) => {
    expect(mapApiKeySource(v)).toBe(want);
  });
});

describe('checkClaudeInit - one row per init field and mode', () => {
  const init = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    tools: [CLI_SCHEMA_TOOL],
    mcp_servers: [],
    mcp_server_errors: [],
    plugins: [],
    ...over,
  });
  const s1 = { stage: 'extract' as const, toolServer: null };
  const s3 = { stage: 'draft' as const, toolServer: { url: 'u', token: 't' } };
  const S3_OK = { tools: ['mcp__wca__get_current_time'], mcp_servers: [{ name: 'wca', status: 'connected' }] };

  it('schema runs: [] or [StructuredOutput] pass (F13)', () => {
    expect(checkClaudeInit(init(), s1, [])).toEqual({
      initOk: true,
      toolsCount: 1,
      mcpServers: 0,
      apiKeySource: 'none',
      mismatch: null,
    });
    expect(checkClaudeInit(init({ tools: [] }), { stage: 'read_image', toolServer: null }, []).initOk).toBe(true);
    expect(
      checkClaudeInit(init({ mcp_server_errors: undefined, plugins: null }), { stage: 'smoke', toolServer: null }, [])
        .initOk,
    ).toBe(true);
  });
  it('S3: a subset of mcp__wca__<exposed> with exactly the wca server (connected|pending) passes; tools may be empty', () => {
    expect(checkClaudeInit(init(S3_OK), s3, ['get_current_time', 'get_freebusy']).initOk).toBe(true);
    expect(
      checkClaudeInit(init({ ...S3_OK, mcp_servers: [{ name: 'wca', status: 'pending' }] }), s3, ['get_current_time'])
        .initOk,
    ).toBe(true);
    expect(checkClaudeInit(init({ ...S3_OK, tools: [] }), s3, []).initOk).toBe(true);
  });
  it.each<[string, Record<string, unknown>, 'schema' | 's3', string | null]>([
    ['not an init event', { type: 'assistant' }, 'schema', null],
    ['tools not an array', { tools: 'Bash' }, 'schema', 'extra_tool'],
    ['tools with a non-string', { tools: [1] }, 'schema', 'extra_tool'],
    ['mcp_servers not an array', { mcp_servers: null }, 'schema', 'missing_server'],
    ['extra built-in tool', { tools: [CLI_SCHEMA_TOOL, 'Bash'] }, 'schema', 'extra_tool'],
    ['Read on a schema run', { tools: ['Read'] }, 'schema', 'extra_tool'],
    ['any server on a schema run', { mcp_servers: [{ name: 'wca', status: 'connected' }] }, 'schema', 'extra_server'],
    [
      'claude.ai connector on S3',
      {
        tools: [],
        mcp_servers: [
          { name: 'wca', status: 'connected' },
          { name: 'claude.ai Gmail', status: 'connected' },
        ],
      },
      's3',
      'extra_server',
    ],
    ['S3 without the wca server', { tools: [], mcp_servers: [] }, 's3', 'missing_server'],
    [
      'S3 server with another name',
      { tools: [], mcp_servers: [{ name: 'claude.ai Calendar', status: 'connected' }] },
      's3',
      'extra_server',
    ],
    ['S3 server not a record', { tools: [], mcp_servers: ['wca'] }, 's3', 'extra_server'],
    ['S3 server failed', { tools: [], mcp_servers: [{ name: 'wca', status: 'failed' }] }, 's3', 'server_error'],
    ['mcp_server_errors present', { mcp_server_errors: [{ name: 'x' }] }, 'schema', 'server_error'],
    ['mcp_server_errors not an array', { mcp_server_errors: 'boom' }, 'schema', 'server_error'],
    ['plugins present', { plugins: [{ name: 'x' }] }, 'schema', 'extra_tool'],
    [
      'StructuredOutput on S3 (F13)',
      { tools: [CLI_SCHEMA_TOOL], mcp_servers: [{ name: 'wca', status: 'connected' }] },
      's3',
      'extra_tool',
    ],
    [
      'unexposed wca tool on S3',
      { tools: ['mcp__wca__wa_list_chats'], mcp_servers: [{ name: 'wca', status: 'connected' }] },
      's3',
      'extra_tool',
    ],
    ['a neutral internal while none is pinned', { tools: [CLI_SCHEMA_TOOL, 'TodoWrite'] }, 'schema', 'extra_tool'],
    ['API-key auth', { apiKeySource: 'ANTHROPIC_API_KEY' }, 'schema', 'api_key_auth'],
  ])('%s => initOk false, mismatch %s', (_n, over, kind, mismatch) => {
    const proof = checkClaudeInit(init(over), kind === 's3' ? s3 : s1, ['get_current_time']);
    expect(proof.initOk).toBe(false);
    expect(proof.mismatch).toBe(mismatch);
  });
  it('a non-object init fails closed', () => {
    expect(checkClaudeInit(null, s1, []).initOk).toBe(false);
    expect(checkClaudeInit([1], s1, []).initOk).toBe(false);
  });
});

describe('stripOneCodeFence', () => {
  it('strips exactly one fence', () => {
    expect(stripOneCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripOneCodeFence('```\n{"a":1}```')).toBe('{"a":1}');
    expect(stripOneCodeFence('  {"a":1}  ')).toBe('{"a":1}');
    expect(() => JSON.parse(stripOneCodeFence('```json\n```json\n{"a":1}\n```\n```'))).toThrow();
  });
  it('nameSha8', () => {
    expect(nameSha8('Bash')).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------------------------------------------------
const okProof = { initOk: true, toolsCount: 1, mcpServers: 0, apiKeySource: 'none' as const, mismatch: null };
const res = (over: Partial<CliRunResult> = {}): CliRunResult => ({
  sandbox: okProof,
  structured: null,
  text: null,
  toolCalls: 0,
  blockedCalls: 0,
  stopReason: 'end',
  error: null,
  quota: null,
  usage: null,
  ms: 5,
  ...over,
});
function mockRunner(
  answers: Array<CliRunResult | Error | ((r: ClaudeRunRequestExt) => CliRunResult)>,
  extras: { health?: () => unknown } = {},
) {
  const calls: Array<{ req: ClaudeRunRequestExt; signal: AbortSignal }> = [];
  const runner = {
    run: vi.fn(async (req: CliRunRequest, signal: AbortSignal) => {
      calls.push({ req: req as ClaudeRunRequestExt, signal });
      const a = answers.shift() ?? res();
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(req as ClaudeRunRequestExt) : a;
    }),
    breakerOpen: vi.fn(() => false),
    ...extras,
  };
  return { runner, calls };
}
const locator: CliLocator = { find: vi.fn(), version: vi.fn(), signedIn: vi.fn() };
const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
  signal: new AbortController().signal,
  maxOutputTokens: 512,
  purpose: 'extract',
  ...over,
});
function mkProvider(
  runner: ReturnType<typeof mockRunner>['runner'],
  over: Partial<Parameters<typeof createClaudeCliProvider>[0]> = {},
) {
  let t = 1_000;
  const server = { url: 'http://127.0.0.1:50000/mcp', token: 'PER-RUN-TOKEN', close: vi.fn(async () => undefined) };
  const startToolServer = vi.fn(async () => server);
  const provider = createClaudeCliProvider({
    runner,
    locator,
    model: 'sonnet',
    exePath: 'C:\\h\\.local\\bin\\claude.exe',
    observedVersion: '2.1.258',
    startToolServer,
    now: () => (t += 10),
    ...over,
  });
  return { provider, server, startToolServer };
}
const ctx = () => ({
  runId: 9,
  itemId: 3,
  chatId: 1,
  nowMs: 0,
  timeZone: 'Asia/Jerusalem',
  nonce: '0123456789abcdef',
  calls: {},
  totalCalls: 0,
  blockedCalls: 0,
  signal: new AbortController().signal,
  handles: {} as never,
  waRowsServed: 0,
  crossChatRows: 0,
  otherChatTexts: [],
});
const agenticInput = (c = ctx()): AgenticRunInput => ({
  system: 'S3 CONSTANT',
  user: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>',
  specs: [{ name: 'get_current_time' }, { name: 'wa_get_chat_messages' }] as unknown as AgenticRunInput['specs'],
  ctx: c as unknown as AgenticRunInput['ctx'],
  gate: {} as AgenticRunInput['gate'],
  maxTurns: LIMITS.draftTurnsWithTools + 1,
});

describe('createClaudeCliProvider', () => {
  it('shape: id, loop agentic, images true, info members', () => {
    const { runner } = mockRunner([]);
    const { provider } = mkProvider(runner);
    expect(provider).toMatchObject({
      id: 'claude_cli',
      model: 'sonnet',
      loop: 'agentic',
      capabilities: { images: true },
    });
    expect(isClaudeCliProvider(provider)).toBe(true);
    expect(isClaudeCliProvider({ ...provider, id: 'claude' } as never)).toBe(false);
    expect(provider.lastSmokeOkAt()).toBeNull();
  });

  it('structured S1: one job, verbatim system, stdin nonce block, S1 wall clock, returns structured_output; reports sandbox/usage/quota', async () => {
    const quota = { resetsAt: 5, usingOverage: false };
    const { runner, calls } = mockRunner([
      res({ structured: { a: 'x' }, usage: { inputTokens: 1, outputTokens: 2 }, quota }),
    ]);
    const onQuota = vi.fn();
    const { provider } = mkProvider(runner, { onQuota });
    const o = opts({ onSandbox: vi.fn(), onUsage: vi.fn(), onQuota: vi.fn() });
    const out = await provider.structured(
      [
        { role: 'system', content: SYS },
        { role: 'user', content: 'DATA' },
        { role: 'assistant', content: 'ignored' },
        { role: 'user', content: 'REPAIR' },
      ],
      SCHEMA as never,
      o,
    );
    expect(out).toEqual({ a: 'x' });
    const r = calls[0]!.req;
    expect(r).toMatchObject({
      provider: 'claude_cli',
      stage: 'extract',
      system: SYS,
      jsonSchema: SCHEMA,
      maxTurns: 1,
      toolServer: null,
      wallClockMs: LIMITS.cliWallClockExtractMs,
    });
    expect(JSON.parse(r.stdinLine).message.content).toEqual([
      { type: 'text', text: 'DATA' },
      { type: 'text', text: 'REPAIR' },
    ]);
    expect(o.onSandbox).toHaveBeenCalledWith(okProof);
    expect(o.onUsage).toHaveBeenCalledWith({ inputTokens: 1, outputTokens: 2 });
    expect(o.onQuota).toHaveBeenCalledWith(quota);
    expect(onQuota).toHaveBeenCalledWith(quota);
  });

  it('structured V1: image block first on stdin, read_image stage + wall clock; two system messages are joined', async () => {
    const { runner, calls } = mockRunner([res({ structured: { readable: true } })]);
    const { provider } = mkProvider(runner);
    await provider.structured(
      [
        { role: 'system', content: 'V1' },
        { role: 'system', content: 'FACTS' },
        {
          role: 'user',
          content: [
            { type: 'image', mime: 'image/jpeg', base64: 'QUJD' },
            { type: 'image', mime: 'image/png', base64: 'second-ignored' },
            { type: 'text', text: 'DATA' },
          ],
        },
      ],
      SCHEMA as never,
      opts({ purpose: 'read_image' }),
    );
    const r = calls[0]!.req;
    expect(r.stage).toBe('read_image');
    expect(r.system).toBe('V1\n\nFACTS');
    expect(r.wallClockMs).toBe(LIMITS.readImageWallClockCliMs);
    expect(JSON.parse(r.stdinLine).message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: 'DATA' },
    ]);
  });

  it('structured refusals and error mapping', async () => {
    const { runner } = mockRunner([
      res({ sandbox: { ...okProof, initOk: false, mismatch: 'extra_tool' } }),
      res({ error: 'usage_limit' }),
      res({ text: '```json\n{"a":"fenced"}\n```' }),
      res({ text: 'not json' }),
      res({}),
    ]);
    const { provider } = mkProvider(runner);
    const m = [{ role: 'user' as const, content: 'x' }];
    await expect(provider.structured(m, SCHEMA as never, opts())).rejects.toMatchObject({ code: 'sandbox' });
    await expect(provider.structured(m, SCHEMA as never, opts())).rejects.toMatchObject({ code: 'usage_limit' });
    await expect(provider.structured(m, SCHEMA as never, opts())).resolves.toEqual({ a: 'fenced' });
    await expect(provider.structured(m, SCHEMA as never, opts())).rejects.toMatchObject({ code: 'bad_output' });
    await expect(provider.structured(m, SCHEMA as never, opts())).rejects.toMatchObject({ code: 'bad_output' });
    await expect(provider.structured(m, SCHEMA as never, opts({ purpose: 'draft' }))).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(
      provider.structured(
        [{ role: 'user', content: [{ type: 'image', mime: 'image/png', base64: 'x' }] }],
        SCHEMA as never,
        opts(),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(provider.chat([], [], opts())).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('below the version floor nothing runs (version)', async () => {
    const { runner } = mockRunner([]);
    const { provider } = mkProvider(runner, { observedVersion: '2.1.247' });
    await expect(provider.structured([], SCHEMA as never, opts())).rejects.toMatchObject({ code: 'version' });
    await expect(provider.runAgentic!(agenticInput(), opts({ purpose: 'draft' }))).rejects.toMatchObject({
      code: 'version',
    });
    expect(await provider.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'version' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('runAgentic: tool server started first, request carries url/token/exposed names/runId, closed in finally', async () => {
    const { runner, calls } = mockRunner([
      res({
        text: 'Draft text',
        toolCalls: 2,
        usage: { inputTokens: 3, outputTokens: 4 },
        quota: { resetsAt: 9, usingOverage: false },
      }),
    ]);
    const { provider, server, startToolServer } = mkProvider(runner);
    const c = ctx();
    const out = await provider.runAgentic!(agenticInput(c), opts({ purpose: 'draft' }));
    expect(startToolServer).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      text: 'Draft text',
      toolCalls: 2,
      blockedCalls: 0,
      sandboxOk: true,
      stopReason: 'end',
      usage: { inputTokens: 3, outputTokens: 4 },
      rateLimit: { resetsAt: 9, usingOverage: false },
    });
    const r = calls[0]!.req;
    expect(r).toMatchObject({
      stage: 'draft',
      system: 'S3 CONSTANT',
      jsonSchema: null,
      maxTurns: LIMITS.draftTurnsWithTools + 1,
      wallClockMs: LIMITS.cliWallClockDraftMs,
      toolServer: { url: server.url, token: server.token },
      exposedNames: ['get_current_time', 'wa_get_chat_messages'],
      runId: 9,
      auditRef: '3',
    });
    expect(r.onStrike!()).toBe(false);
    expect(r.onStrike!()).toBe(true);
    expect(c.blockedCalls).toBe(2);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('runAgentic outcomes: sandbox false, strike abort, errors thrown (server still closed), max_turns kept', async () => {
    const strikeCtx = ctx();
    const { runner } = mockRunner([
      res({ sandbox: { ...okProof, initOk: false, mismatch: 'extra_server' }, stopReason: 'killed', error: 'sandbox' }),
      (r) => {
        r.onStrike!();
        r.onStrike!();
        return res({ stopReason: 'killed', blockedCalls: 2 });
      },
      res({ error: 'overage', stopReason: 'killed' }),
      res({ error: 'bad_output', stopReason: 'bad_output' }),
      res({ error: 'bad_output', stopReason: 'max_turns', structured: { x: 1 } }),
      new Error('runner bug'),
    ]);
    const { provider, server } = mkProvider(runner);
    expect(await provider.runAgentic!(agenticInput(), opts())).toMatchObject({ sandboxOk: false, text: '' });
    expect(await provider.runAgentic!(agenticInput(strikeCtx), opts())).toMatchObject({
      sandboxOk: true,
      stopReason: 'killed',
      blockedCalls: 2,
    });
    await expect(provider.runAgentic!(agenticInput(), opts())).rejects.toMatchObject({ code: 'overage' });
    await expect(provider.runAgentic!(agenticInput(), opts())).rejects.toMatchObject({ code: 'bad_output' });
    expect(await provider.runAgentic!(agenticInput(), opts())).toMatchObject({
      stopReason: 'max_turns',
      text: '',
      structured: { x: 1 },
    });
    await expect(provider.runAgentic!(agenticInput(), opts())).rejects.toThrow('runner bug');
    expect(server.close).toHaveBeenCalledTimes(6);
  });

  it('runAgentic: a failing tool-server start => not_ready, no job; a throwing close() is swallowed', async () => {
    const { runner } = mockRunner([res({ text: 'x' })]);
    const { provider } = mkProvider(runner, {
      startToolServer: vi.fn(async () => {
        throw Object.assign(new Error('listen'), { code: 'EADDRINUSE' });
      }),
    });
    await expect(provider.runAgentic!(agenticInput(), opts())).rejects.toMatchObject({ code: 'not_ready' });
    expect(runner.run).not.toHaveBeenCalled();
    const b = mockRunner([res({ text: 'x' })]);
    const p2 = mkProvider(b.runner, {
      startToolServer: vi.fn(async () => ({ url: 'u', token: 't', close: () => Promise.reject(new Error('x')) })),
    });
    await expect(p2.provider.runAgentic!(agenticInput(), opts())).resolves.toMatchObject({ text: 'x' });
  });

  it('validate(): the smoke run is constant (haiku, 1-field schema, max-turns 1, no user data) and records its outcome', async () => {
    const onSmoke = vi.fn();
    const { runner, calls } = mockRunner([
      res({ structured: { ok: true } }),
      res({ sandbox: { ...okProof, initOk: false } }),
      res({ error: 'not_logged_in' }),
      res({ structured: { ok: 'yes' } }),
      new LlmError('aborted'),
      new Error('x'),
    ]);
    const { provider } = mkProvider(runner, { onSmoke });
    const sig = new AbortController().signal;
    expect(await provider.validate(sig)).toEqual({ ok: true, model: 'sonnet' });
    expect(provider.lastSmokeOkAt()).not.toBeNull();
    const r = calls[0]!.req;
    expect(r).toMatchObject({
      stage: 'smoke',
      model: 'haiku',
      system: CLI_SMOKE_SYSTEM,
      jsonSchema: CLI_SMOKE_SCHEMA,
      maxTurns: 1,
      toolServer: null,
      wallClockMs: LIMITS.cliTestWallClockMs,
    });
    expect(JSON.parse(r.stdinLine).message.content).toEqual([{ type: 'text', text: CLI_SMOKE_USER }]);
    expect(onSmoke).toHaveBeenLastCalledWith({ ok: true, at: expect.any(Number), ms: expect.any(Number) });
    expect(await provider.validate(sig)).toEqual({ ok: false, reason: 'sandbox' });
    expect(provider.lastSmokeOkAt()).toBeNull();
    expect(await provider.validate(sig)).toEqual({ ok: false, reason: 'not_logged_in' });
    expect(await provider.validate(sig)).toEqual({ ok: false, reason: 'bad_output' });
    expect(await provider.validate(sig)).toEqual({ ok: false, reason: 'aborted' });
    expect(await provider.validate(sig)).toEqual({ ok: false, reason: 'not_ready' });
    const ac = new AbortController();
    ac.abort();
    const c = mockRunner([new Error('y')]);
    expect(await mkProvider(c.runner).provider.validate(ac.signal)).toEqual({ ok: false, reason: 'aborted' });
  });

  it('dispose() aborts the in-flight job signal and resets the smoke; later runs get a fresh signal', async () => {
    let seen: AbortSignal | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner = {
      run: vi.fn(async (_r: CliRunRequest, s: AbortSignal) => {
        seen = s;
        await gate;
        return res({ structured: { ok: true } });
      }),
      breakerOpen: () => false,
    };
    const { provider } = mkProvider(runner as never);
    const p = provider.validate(new AbortController().signal);
    await Promise.resolve();
    await provider.dispose();
    expect((seen as unknown as AbortSignal).aborted).toBe(true);
    release();
    await p;
    await provider.validate(new AbortController().signal);
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
  });

  it('cliHealth(): the runner health when present, else the breaker', () => {
    const a = mockRunner([], { health: () => ({ code: 'CLOUD_OVERAGE', retryAtMs: null }) } as never);
    expect(mkProvider(a.runner).provider.cliHealth()).toEqual({ code: 'CLOUD_OVERAGE', retryAtMs: null });
    const b = mockRunner([]);
    expect(mkProvider(b.runner).provider.cliHealth()).toBeNull();
    b.runner.breakerOpen.mockReturnValue(true);
    expect(mkProvider(b.runner).provider.cliHealth()).toEqual({ code: 'CLI_UNSTABLE', retryAtMs: null });
    const d = createClaudeCliProvider({
      runner: b.runner,
      locator,
      model: 'm',
      exePath: 'C:\\x\\claude.exe',
      observedVersion: '2.1.258',
      startToolServer: vi.fn(),
    });
    expect(d.lastSmokeOkAt()).toBeNull();
  });
});

describe('a runner refusal before any spawn keeps its own code (never a sandbox verdict)', () => {
  it('structured / runAgentic / validate surface overage, usage_limit, aborted as such', async () => {
    const refused = (error: 'overage' | 'usage_limit' | 'aborted'): CliRunResult =>
      res({
        sandbox: { initOk: false, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
        error,
        stopReason: 'aborted',
      });
    const { runner } = mockRunner([refused('overage'), refused('usage_limit'), refused('aborted')]);
    const { provider, server } = mkProvider(runner);
    await expect(provider.structured([{ role: 'user', content: 'x' }], SCHEMA as never, opts())).rejects.toMatchObject({
      code: 'overage',
    });
    await expect(provider.runAgentic!(agenticInput(), opts())).rejects.toMatchObject({ code: 'usage_limit' });
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(await provider.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('makeClaudeCliFactory', () => {
  const mkLoc = (loc: Awaited<ReturnType<CliLocator['find']>>): CliLocator => ({
    find: vi.fn(async () => loc),
    version: vi.fn(),
    signedIn: vi.fn(),
  });
  it('not installed / unreadable or too old version => LlmError; ok => provider with the located path, onLocated first', async () => {
    const { runner } = mockRunner([]);
    const deps = { runner, startToolServer: vi.fn() };
    await expect(makeClaudeCliFactory({ ...deps, locator: mkLoc(null) })({ model: 'sonnet' })).rejects.toMatchObject({
      code: 'not_installed',
    });
    await expect(
      makeClaudeCliFactory({
        ...deps,
        locator: mkLoc({ provider: 'claude_cli', exePath: 'C:\\x\\claude.exe', version: null }),
      })({ model: 'sonnet' }),
    ).rejects.toMatchObject({ code: 'version' });
    await expect(
      makeClaudeCliFactory({
        ...deps,
        locator: mkLoc({ provider: 'claude_cli', exePath: 'C:\\x\\claude.exe', version: '2.1.221' }),
      })({ model: 's' }),
    ).rejects.toMatchObject({ code: 'version' });
    const onLocated = vi.fn();
    const p = await makeClaudeCliFactory({
      ...deps,
      locator: mkLoc({ provider: 'claude_cli', exePath: 'C:\\x\\claude.exe', version: '2.1.258' }),
      onLocated,
      now: () => 1,
      onSmoke: vi.fn(),
      onQuota: vi.fn(),
    })({ model: 'opus' });
    expect(onLocated).toHaveBeenCalledWith('C:\\x\\claude.exe');
    expect(p).toMatchObject({ exePath: 'C:\\x\\claude.exe', observedVersion: '2.1.258', model: 'opus' });
  });
});
