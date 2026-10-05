// src/main/llm/cli/antigravityCli.test.ts - T2 5 row `llm/cli/antigravityCli.ts` (owner V2-W1-09-antigravity, lane L10).
// argv literal (B14, never -p <text>, --print-timeout = wall - 10 s); env literal; agent file bytes (+ type test: no untrusted parameter);
// no mcp_config.json ever planned; stdin line shape (F20); init proof table; result table; AGY_ERROR classification; floor 1.2.11;
// capabilities.images === false; `agy models` parsing (never a hard-coded list); workspace trust (diff shown == diff written, one key,
// key order, backup, refused while agy runs / without confirm / in isolated mode); isolated profile (F3) + the fallback preflight.
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { CLI_MIN_VERSION, LIMITS, type JsonSchemaLcd } from '../../../shared/types';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { AGY_ENV_KEYS, type JobHandle, type JobRunner, type JobSpec } from '../../proc/jobRunner';
import { LlmError, type CallOpts } from '../types';
import type { CliRunRequest, CliRunResult, CliRunner } from './runner';
import type { CliLocator } from './locator';
import { CLI_SMOKE_SCHEMA, CLI_SMOKE_SYSTEM, CLI_SMOKE_USER } from './claudeCli';
import {
  AGY_ENV_KEY_SET,
  AGY_MIN_VERSION,
  AGY_PROFILE_MODE,
  agyEventResult,
  agyModelEffort,
  agyPrintTimeout,
  buildAgentFile,
  buildAgyArgs,
  buildAgyEnv,
  buildAgyStdinLine,
  checkAgyInit,
  classifyAgyErrorText,
  classifyAgyExit,
  classifyAgyResult,
  createAgyProvider,
  createAgyWorkspace,
  isAgyProvider,
  isSafeAgyModel,
  listAgyModels,
  makeAgyFactory,
  parseAgyModels,
  planAgyHome,
  planWorkspaceTrust,
  preflightAgyGlobalConfig,
} from './antigravityCli';

const USERDATA = 'C:\\Users\\wca-fake-home\\AppData\\Roaming\\WhatsAppCalendarAgent';
const RUNDIR = `${USERDATA}\\agy-workspace\\runs\\r1`;
const SCHEMA_PATH = `${RUNDIR}\\schema.json`;
const SYS = 'S1 CONSTANT\nReturn the JSON object only, on one line, no markdown.';
const USER =
  '<<DATA-0123456789abcdef>>\n{"messages":[{"from":"contact","text":"coffee?"}]}\n<<END-DATA-0123456789abcdef>>';
const OBJ: JsonSchemaLcd = { type: 'object', properties: {}, required: [], additionalProperties: false };

function req(over: Partial<CliRunRequest> = {}): CliRunRequest & { stage: 'extract' | 'draft' | 'smoke' } {
  return {
    provider: 'antigravity_cli',
    stage: 'extract',
    exePath: 'C:\\Users\\wca-fake-home\\AppData\\Local\\agy\\bin\\agy.exe',
    model: 'gemini-3.8-flash-high',
    system: SYS,
    stdinLine: buildAgyStdinLine(USER),
    jsonSchema: { type: 'object' },
    maxTurns: 1,
    wallClockMs: LIMITS.cliWallClockExtractMs,
    toolServer: null,
    observedVersion: '1.2.12',
    ...over,
  } as CliRunRequest & { stage: 'extract' | 'draft' | 'smoke' };
}

describe('constants', () => {
  it('floor 1.2.11 equals the shared CLI_MIN_VERSION; isolated profile by default (F3)', () => {
    expect(AGY_MIN_VERSION).toBe('1.2.11');
    expect(CLI_MIN_VERSION.antigravity_cli).toBe(AGY_MIN_VERSION);
    expect(AGY_PROFILE_MODE).toBe('isolated');
    expect([...AGY_ENV_KEY_SET]).toEqual([...AGY_ENV_KEYS]);
  });
});

describe('buildAgyArgs (B14 argv literal, never -p <text>)', () => {
  it('S1 extract: the literal argv with --json-schema <runDir>\\schema.json and --print-timeout wall-10 s', () => {
    // [D-080] the default slug carries its effort ('-high'): agy 1.2.16 refuses `--effort` next to it, so none is passed
    expect(buildAgyArgs(req(), SCHEMA_PATH)).toEqual([
      '--agent',
      'wca-extract',
      '--model',
      'gemini-3.8-flash-high',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--print-timeout',
      '50s',
      '--disable-slash-commands',
      '--json-schema',
      SCHEMA_PATH,
    ]);
  });
  it('[D-080] --effort low only for a slug WITHOUT an effort suffix (agy 1.2.16: "--model X-high conflicts with --effort=low")', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro', 'gemini-3.8-highland']) {
      const a = buildAgyArgs(req({ model }), SCHEMA_PATH);
      expect(a.slice(2, 6), model).toEqual(['--model', model, '--effort', 'low']);
      expect(
        a.filter((x) => x === '--effort'),
        model,
      ).toHaveLength(1);
      expect(agyModelEffort(model), model).toBeNull();
    }
    for (const [model, effort] of [
      ['gemini-3.8-flash-high', 'high'],
      ['gemini-3.1-pro-low', 'low'],
      ['gemini-3.1-pro-medium', 'medium'],
      ['gemini-3.8-flash-minimal', 'minimal'],
      ['gemini-3.8-flash-xhigh', 'xhigh'],
      ['Gemini-3.8-Flash-HIGH', 'high'],
    ] as const) {
      const a = buildAgyArgs(req({ model }), SCHEMA_PATH);
      expect(a, model).not.toContain('--effort');
      expect(a.slice(2, 5), model).toEqual(['--model', model, '--output-format']);
      expect(agyModelEffort(model), model).toBe(effort);
    }
    // the default setting is a suffixed slug: a run of the default configuration never carries --effort
    expect(agyModelEffort(DEFAULT_SETTINGS.llm.cli.agyModel)).not.toBeNull();
  });
  it('S3 draft (prefetch loop, {reply} schema) and the smoke run', () => {
    const d = buildAgyArgs(req({ stage: 'draft', wallClockMs: LIMITS.cliWallClockDraftMs }), SCHEMA_PATH);
    expect(d.slice(0, 2)).toEqual(['--agent', 'wca-draft']);
    expect(d[d.indexOf('--print-timeout') + 1]).toBe('110s');
    const s = buildAgyArgs(req({ stage: 'smoke', wallClockMs: LIMITS.cliTestWallClockMs }), SCHEMA_PATH);
    expect(s.slice(0, 2)).toEqual(['--agent', 'wca-smoke']);
    expect(s[s.indexOf('--print-timeout') + 1]).toBe('20s');
  });
  it('without a schema: no --json-schema at all', () => {
    const a = buildAgyArgs(req(), null);
    expect(a).not.toContain('--json-schema');
    expect(a[a.length - 1]).toBe('--disable-slash-commands');
  });
  it('never -p / --print / --prompt, never a positional, never the message text, never an MCP config', () => {
    for (const stage of ['extract', 'draft', 'smoke'] as const) {
      const a = buildAgyArgs(req({ stage }), SCHEMA_PATH);
      for (const bad of ['-p', '--print', '--prompt', '--dangerously-skip-permissions', '--sandbox', '--mcp-config'])
        expect(a).not.toContain(bad);
      expect(a.join(' ')).not.toContain('<<DATA-');
      expect(a.join(' ')).not.toContain('coffee');
    }
  });
  it('refuses an option-like or malformed model slug, a V1 stage and a foreign schema file name', () => {
    for (const model of ['-p', '--sandbox', 'a b', 'x;y', '', 'a'.repeat(101)])
      expect(() => buildAgyArgs(req({ model }), SCHEMA_PATH)).toThrow('agy_bad_model');
    expect(() => buildAgyArgs(req({ stage: 'read_image' as never }), SCHEMA_PATH)).toThrow('agy_bad_stage');
    expect(() => buildAgyArgs(req(), `${RUNDIR}\\mcp_config.json`)).toThrow('agy_bad_schema_path');
    expect(() => buildAgyArgs(req(), '')).toThrow('agy_bad_schema_path');
  });
  it('agyPrintTimeout clamps to >= 1 s and is whole seconds', () => {
    expect(agyPrintTimeout(60_000)).toBe('50s');
    expect(agyPrintTimeout(10_500)).toBe('1s');
    expect(agyPrintTimeout(0)).toBe('1s');
    expect(agyPrintTimeout(Number.NaN)).toBe('1s');
    expect(agyPrintTimeout(125_999)).toBe('115s');
  });
  it('isSafeAgyModel', () => {
    expect(isSafeAgyModel('gemini-3.1-pro-high')).toBe(true);
    expect(isSafeAgyModel('-x')).toBe(false);
    expect(isSafeAgyModel(3)).toBe(false);
  });
});

describe('buildAgyStdinLine (F20: agy envelope, text only, one line)', () => {
  it('is exactly {"event":"user","message":{"content":"<text>"}}', () => {
    expect(buildAgyStdinLine('hi')).toBe('{"event":"user","message":{"content":"hi"}}');
  });
  it('stays one line for newlines / CR / U+2028 / lone surrogates and round-trips the text', () => {
    const text = `${USER}\r\nline2\u2028x\ud800y`;
    const line = buildAgyStdinLine(text);
    expect(line.split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line) as { event: string; message: { content: string }; type?: string };
    expect(parsed.event).toBe('user');
    expect(parsed.type).toBeUndefined(); // never the Claude envelope
    expect(parsed.message.content).toBe(text);
  });
});

describe('planAgyHome (F3 isolated profile)', () => {
  it('only settings.json with trustedWorkspaces, env overrides under <userData>\\agy-home', () => {
    const ws = `${USERDATA}\\agy-workspace`;
    const p = planAgyHome(USERDATA, ws);
    const home = `${USERDATA}\\agy-home`;
    expect(p.homeDir).toBe(home);
    expect(p.files).toEqual([
      {
        path: `${home}\\.gemini\\antigravity-cli\\settings.json`,
        text: `${JSON.stringify({ trustedWorkspaces: [ws] }, null, 2)}\n`,
      },
    ]);
    expect(p.env).toEqual({
      USERPROFILE: home,
      HOME: home,
      APPDATA: `${home}\\AppData\\Roaming`,
      LOCALAPPDATA: `${home}\\AppData\\Local`,
    });
    // nothing under .gemini\config (the user's mcp_config.json / hooks.json never exist in the app profile), no mcp_config anywhere
    expect(p.files.some((f) => /mcp_config|hooks\.json|[\\/]config[\\/]/i.test(f.path))).toBe(false);
    expect(planAgyHome(USERDATA, ws)).toEqual(p); // idempotent, pure
  });
});

describe('preflightAgyGlobalConfig (fallback mode only, fail closed)', () => {
  const cases: Array<[string, string | null, string | null, 'safe' | 'unsafe']> = [
    ['both files absent', null, null, 'safe'],
    ['empty object', '{}', '{}', 'safe'],
    ['no servers', '{"mcpServers":{}}', null, 'safe'],
    ['every server disabled', '{"mcpServers":{"a":{"command":"x","disabled":true}}}', null, 'safe'],
    ['BOM + $schema', '\uFEFF{"$schema":"x","mcpServers":{}}', null, 'safe'],
    ['empty hooks lists', null, '{"hooks":{"PreToolUse":[]}}', 'safe'],
    ['an enabled server', '{"mcpServers":{"whatsapp":{"command":"uv"}}}', null, 'unsafe'],
    ['disabled:false', '{"mcpServers":{"whatsapp":{"command":"uv","disabled":false}}}', null, 'unsafe'],
    ['server not an object', '{"mcpServers":{"x":"cmd"}}', null, 'unsafe'],
    ['mcpServers not an object', '{"mcpServers":[1]}', null, 'unsafe'],
    ['unknown top-level key', '{"servers":{}}', null, 'unsafe'],
    ['unparsable mcp', '{"mcpServers":', null, 'unsafe'],
    ['array mcp', '[]', null, 'unsafe'],
    ['a hook', null, '{"hooks":{"PreToolUse":[{"command":"x"}]}}', 'unsafe'],
    ['a disabled hook still counts', null, '{"hooks":{"Stop":[{"command":"x","enabled":false}]}}', 'unsafe'],
    ['unparsable hooks', null, 'nope', 'unsafe'],
    ['very deep hooks', null, '{"a":{"b":{"c":{"d":{"e":{"f":{}}}}}}}', 'unsafe'],
  ];
  it.each(cases)('%s', (_n, mcp, hooks, want) => {
    expect(preflightAgyGlobalConfig(mcp, hooks)).toBe(want);
  });
});

describe('buildAgentFile (agent file bytes; no untrusted parameter)', () => {
  it('frontmatter exactly as B14 + body = the verbatim constant', () => {
    expect(buildAgentFile('extract', SYS)).toBe(
      [
        '---',
        'name: wca-extract',
        'description: WhatsApp Calendar Agent extract stage. Returns JSON only.',
        'tools: []',
        'commandExecutionPolicy: off',
        'excludeDefaultComponents: true',
        'mainAgent: true',
        'subagent: false',
        'model: inherit',
        '---',
        SYS,
      ].join('\n'),
    );
    const d = buildAgentFile('draft', 'S3 BODY');
    expect(d.startsWith('---\nname: wca-draft\n')).toBe(true);
    expect(d.endsWith('---\nS3 BODY')).toBe(true);
    expect(buildAgentFile('smoke', CLI_SMOKE_SYSTEM).endsWith(`---\n${CLI_SMOKE_SYSTEM}`)).toBe(true);
    expect(d).not.toMatch(/mcpServers|skills|plugins/);
  });
  it('type test: exactly (stage literal, constant) - nothing else can be passed in', () => {
    expectTypeOf(buildAgentFile).parameters.toEqualTypeOf<['extract' | 'draft' | 'smoke', string]>();
    expectTypeOf(buildAgentFile).returns.toEqualTypeOf<string>();
  });
  it('refuses an empty constant and a foreign stage', () => {
    expect(() => buildAgentFile('extract', '')).toThrow('agy_empty_system');
    expect(() => buildAgentFile('read_image' as never, SYS)).toThrow('agy_bad_stage');
  });
});

describe('checkAgyInit (I11 init proof table)', () => {
  const init = (over: Record<string, unknown> = {}, stage = 'extract'): unknown => ({
    event: 'init',
    conversation_id: 'fake-1',
    init: { cwd: RUNDIR, tools: [], permission_mode: 'request-review', agent: `wca-${stage}`, ...over },
  });
  it('agent wca-<stage> + no tools + request-review => proven', () => {
    for (const s of ['extract', 'draft', 'smoke'] as const)
      expect(checkAgyInit(init({}, s), s)).toEqual({
        initOk: true,
        toolsCount: 0,
        mcpServers: 0,
        apiKeySource: 'unknown',
        mismatch: null,
      });
    expect(checkAgyInit(init({ mcp_servers: [] }), 'extract').initOk).toBe(true);
  });
  const bad: Array<[string, unknown, 'extract' | 'draft' | 'smoke', string | null, number]> = [
    ['a tool', init({ tools: ['run_command'] }), 'extract', 'extra_tool', 1],
    ['tools missing', init({ tools: undefined }), 'extract', 'extra_tool', 0],
    ['tools not an array', init({ tools: 'none' }), 'extract', 'extra_tool', 0],
    ['an MCP server', init({ mcp_servers: [{ name: 'whatsapp' }] }), 'extract', 'extra_server', 0],
    ['mcp_servers not an array', init({ mcp_servers: {} }), 'extract', 'extra_server', 0],
    ['default agent', init({ agent: 'default' }), 'extract', 'agent_mismatch', 0],
    ['another stage agent', init({}, 'draft'), 'extract', 'agent_mismatch', 0],
    ['agent missing', init({ agent: undefined }), 'extract', 'agent_mismatch', 0],
    ['always-proceed', init({ permission_mode: 'always-proceed' }), 'extract', 'permission_mode', 0],
    ['permission missing', init({ permission_mode: undefined }), 'extract', 'permission_mode', 0],
    ['not the init event', { event: 'step_update', step_update: {} }, 'extract', null, 0],
    [
      'a bare init without the envelope',
      { tools: [], agent: 'wca-extract', permission_mode: 'request-review' },
      'extract',
      null,
      0,
    ],
    ['init not an object', { event: 'init', init: [] }, 'extract', null, 0],
    ['null', null, 'extract', null, 0],
    ['a V1 stage', init({ agent: 'wca-read_image' }), 'read_image' as never, 'agent_mismatch', 0],
  ];
  it.each(bad)('%s => initOk false', (_n, value, stage, mismatch, tools) => {
    const p = checkAgyInit(value, stage);
    expect(p.initOk).toBe(false);
    expect(p.mismatch).toBe(mismatch);
    expect(p.toolsCount).toBe(tools);
  });
});

describe('planWorkspaceTrust (one key, key order, diff shown == diff written)', () => {
  const WS = `${USERDATA}\\agy-workspace`;
  it('missing file => a new file with only trustedWorkspaces', () => {
    const p = planWorkspaceTrust(null, WS);
    expect(p).toEqual({
      diffLine: `+ "trustedWorkspaces": [ "${WS}" ]`,
      nextJsonText: `${JSON.stringify({ trustedWorkspaces: [WS] }, null, 2)}\n`,
    });
  });
  it('appends to an existing list; every other key deep-equal and in the same order', () => {
    const cur = {
      toolPermission: 'request-review',
      trustedWorkspaces: ['D:\\proj'],
      nested: { a: 1, b: [true, null, 'x'] },
      zeta: 'last',
    };
    const p = planWorkspaceTrust(JSON.stringify(cur, null, 4), WS);
    if ('error' in p) throw new Error('unexpected');
    const next = JSON.parse(p.nextJsonText) as Record<string, unknown>;
    expect(Object.keys(next)).toEqual(Object.keys(cur));
    expect(next).toEqual({ ...cur, trustedWorkspaces: ['D:\\proj', WS] });
    expect(p.diffLine).toBe(`+ "trustedWorkspaces": [ ..., "${WS}" ]`);
  });
  it('adds the key at the end when absent', () => {
    const p = planWorkspaceTrust('{"a":1,"b":{"c":2}}', WS);
    if ('error' in p) throw new Error('unexpected');
    expect(Object.keys(JSON.parse(p.nextJsonText) as object)).toEqual(['a', 'b', 'trustedWorkspaces']);
  });
  it('already trusted => the unchanged text and a no-change line', () => {
    const text = JSON.stringify({ trustedWorkspaces: [WS] });
    const p = planWorkspaceTrust(`\uFEFF${text}`, WS);
    if ('error' in p) throw new Error('unexpected');
    expect(p.nextJsonText).toBe(text);
    expect(p.diffLine).toMatch(/already contains/);
  });
  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['trustedWorkspaces not an array', '{"trustedWorkspaces":"x"}'],
    ['trustedWorkspaces with a non-string', '{"trustedWorkspaces":[1]}'],
    ['duplicate keys (a rewrite would drop one)', '{"a":1,"a":2}'],
    ['integer-like keys (JS would re-order them)', '{"b":1,"1":2}'],
    ['non-canonical number', '{"a":1.0}'],
    ['non-canonical escape', '{"a":"\\u0041"}'],
  ])('%s => unparsable (never rewritten)', (_n, text) => {
    expect(planWorkspaceTrust(text, WS)).toEqual({ error: 'unparsable' });
  });
  it('an empty workspace dir is refused', () => {
    expect(planWorkspaceTrust(null, '')).toEqual({ error: 'unparsable' });
  });
});

describe('createAgyWorkspace (fallback mode only; S-HOME, S-PROC)', () => {
  const HOME = 'C:\\Users\\wca-fake-home';
  const FILE = `${HOME}\\.gemini\\antigravity-cli\\settings.json`;
  const WS = `${USERDATA}\\agy-workspace`;
  function memFs(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial));
    const writes: string[] = [];
    return {
      files,
      writes,
      fs: {
        readFileSync: (p: string) => {
          const v = files.get(p);
          if (v === undefined) throw new Error('ENOENT');
          return v;
        },
        writeFileSync: (p: string, t: string) => {
          writes.push(p);
          files.set(p, t);
        },
        existsSync: (p: string) => files.has(p),
      },
    };
  }
  const original =
    '{\n  "toolPermission": "request-review",\n  "trustedWorkspaces": ["D:\\\\proj"],\n  "theme": "dark"\n}\n';

  it('isolated mode (default): preview => error, allow => BAD_REQUEST, nothing read or written', async () => {
    const m = memFs({ [FILE]: original });
    const read = vi.spyOn(m.fs, 'readFileSync');
    const w = createAgyWorkspace({ home: () => HOME, proc: async () => false, fs: m.fs, userDataDir: USERDATA });
    expect(await w.preview()).toEqual({ error: 'isolated_profile' });
    expect(await w.allow(true)).toEqual({
      ok: false,
      error: { code: 'BAD_REQUEST', params: { reason: 'isolated_profile' } },
    });
    expect(read).not.toHaveBeenCalled();
    expect(m.writes).toEqual([]);
  });
  it('global_checked: backup first (exact bytes), then ONLY trustedWorkspaces changes; the dialog line == the written diff', async () => {
    const m = memFs({ [FILE]: original });
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    const shown = await w.preview();
    expect(shown).toEqual({ diffLine: `+ "trustedWorkspaces": [ ..., "${WS}" ]` });
    expect(await w.allow(true)).toEqual({ ok: true, value: undefined });
    expect(m.writes).toEqual([`${FILE}.wca-backup`, FILE]);
    expect(m.files.get(`${FILE}.wca-backup`)).toBe(original);
    const before = JSON.parse(original) as Record<string, unknown>;
    const after = JSON.parse(m.files.get(FILE) ?? '') as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after).toEqual({ ...before, trustedWorkspaces: ['D:\\proj', WS] });
    // what was written is exactly what planWorkspaceTrust said for the shown line
    const plan = planWorkspaceTrust(original, WS);
    if ('error' in plan) throw new Error('unexpected');
    expect(plan.diffLine).toBe((shown as { diffLine: string }).diffLine);
    expect(m.files.get(FILE)).toBe(plan.nextJsonText);
  });
  it('an earlier backup is never overwritten', async () => {
    const m = memFs({ [FILE]: original, [`${FILE}.wca-backup`]: 'old', [`${FILE}.wca-backup-2`]: 'older' });
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    await w.preview();
    expect((await w.allow(true)).ok).toBe(true);
    expect(m.files.get(`${FILE}.wca-backup`)).toBe('old');
    expect(m.files.get(`${FILE}.wca-backup-3`)).toBe(original);
  });
  it('refused without confirm:true, without a preview, while agy runs, when S-PROC fails, when the file changed after the dialog', async () => {
    const m = memFs({ [FILE]: original });
    let running = false;
    let procThrows = false;
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => {
        if (procThrows) throw new Error('wmi');
        return running;
      },
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    expect(await w.allow(false as never)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', params: { reason: 'not_confirmed' } },
    });
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { params: { reason: 'diff_changed' } } });
    await w.preview();
    running = true;
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { params: { reason: 'agy_running' } } });
    running = false;
    procThrows = true;
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { params: { reason: 'agy_running' } } });
    procThrows = false;
    await w.preview();
    m.files.set(FILE, JSON.stringify({ trustedWorkspaces: [], other: 1 })); // changed after the dialog showed its line
    const shownBefore = await w.preview(); // preview #2 reflects the new file ...
    m.files.set(FILE, original); // ... and it changes again before allow
    expect(shownBefore).toEqual({ diffLine: `+ "trustedWorkspaces": [ "${WS}" ]` });
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { params: { reason: 'diff_changed' } } });
    // the SAME one-line diff but another key changed after the dialog => still refused (the file must be byte-identical)
    await w.preview();
    m.files.set(FILE, original.replace('"dark"', '"light"'));
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { params: { reason: 'diff_changed' } } });
    expect(m.writes).toEqual([]);
  });
  it('already trusted => ok, nothing written, no backup', async () => {
    const m = memFs({ [FILE]: JSON.stringify({ trustedWorkspaces: [WS] }) });
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    await w.preview();
    expect(await w.allow(true)).toEqual({ ok: true, value: undefined });
    expect(m.writes).toEqual([]);
  });
  it('missing settings file => folder created, file written, no backup', async () => {
    const m = memFs({});
    const mkdirs: string[] = [];
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
      mkdirSync: (p) => mkdirs.push(p),
    });
    await w.preview();
    expect((await w.allow(true)).ok).toBe(true);
    expect(mkdirs).toEqual([path.win32.dirname(FILE)]);
    expect(m.writes).toEqual([FILE]);
  });
  it('unparsable / unreadable file, a non-absolute or `..` home => error, nothing written', async () => {
    for (const home of ['relative\\home', 'C:\\Users\\x\\..\\y']) {
      const w = createAgyWorkspace({
        home: () => home,
        proc: async () => false,
        fs: memFs({}).fs,
        userDataDir: USERDATA,
        mode: 'global_checked',
      });
      expect(await w.preview()).toEqual({ error: 'no_home' });
    }
    const bad = memFs({ [FILE]: '{"a":1,"a":2}' });
    const w1 = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: bad.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    expect(await w1.preview()).toEqual({ error: 'unparsable' });
    expect(await w1.allow(true)).toMatchObject({ ok: false, error: { params: { reason: 'unparsable' } } });
    const unreadable = memFs({ [FILE]: original });
    unreadable.fs.readFileSync = () => {
      throw new Error('EACCES');
    };
    const w2 = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: unreadable.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    expect(await w2.preview()).toEqual({ error: 'unreadable' });
    expect(bad.writes).toEqual([]);
  });
  it('a failing or unverifiable write => INTERNAL', async () => {
    const m = memFs({ [FILE]: original });
    m.fs.writeFileSync = () => {
      throw new Error('EPERM');
    };
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    await w.preview();
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { code: 'INTERNAL', params: { reason: 'write' } } });
    const v = memFs({ [FILE]: original });
    const realWrite = v.fs.writeFileSync;
    v.fs.writeFileSync = (p: string, t: string) => realWrite(p, p === FILE ? `${t} ` : t);
    const w2 = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: v.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    await w2.preview();
    expect(await w2.allow(true)).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', params: { reason: 'verify' } },
    });
  });
  it('all backup slots taken => INTERNAL, the settings file untouched', async () => {
    const init: Record<string, string> = { [FILE]: original, [`${FILE}.wca-backup`]: 'x' };
    for (let n = 2; n < 100; n += 1) init[`${FILE}.wca-backup-${n}`] = 'x';
    const m = memFs(init);
    const w = createAgyWorkspace({
      home: () => HOME,
      proc: async () => false,
      fs: m.fs,
      userDataDir: USERDATA,
      mode: 'global_checked',
    });
    await w.preview();
    expect(await w.allow(true)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(m.files.get(FILE)).toBe(original);
  });
});

describe('result / error classification (B14, C2 9.2)', () => {
  it('agyEventResult reads only the documented {"event":"result","result":{...}} envelope', () => {
    expect(agyEventResult({ event: 'result', result: { status: 'SUCCESS' } })).toEqual({ status: 'SUCCESS' });
    expect(agyEventResult({ status: 'SUCCESS' })).toBeNull();
    expect(agyEventResult({ event: 'init', init: {} })).toBeNull();
    expect(agyEventResult({ event: 'result', result: [] })).toBeNull();
    expect(agyEventResult('x')).toBeNull();
  });
  it('classifyAgyResult: SUCCESS + structured_output + empty denied_actions only', () => {
    expect(classifyAgyResult({ status: 'SUCCESS', structured_output: { a: 1 }, denied_actions: [] })).toEqual({
      ok: true,
      structured: { a: 1 },
    });
    expect(classifyAgyResult({ status: 'SUCCESS', structured_output: { a: 1 } })).toEqual({
      ok: true,
      structured: { a: 1 },
    });
    for (const r of [
      { status: 'WAITING', structured_output: { a: 1 }, denied_actions: [] },
      { status: 'SUCCESS', structured_output: { a: 1 }, denied_actions: [{ tool: 'run_command' }] },
      { status: 'SUCCESS', structured_output: { a: 1 }, denied_actions: 'x' },
      { status: 'SUCCESS', denied_actions: [] },
      { status: 'SUCCESS', structured_output: null, denied_actions: [] },
      { status: 'ERROR', structured_output: { a: 1 } },
    ])
      expect(classifyAgyResult(r)).toEqual({ ok: false, error: 'bad_output' });
    expect(classifyAgyResult(null)).toEqual({ ok: false, error: 'bad_output' });
  });
  it('classifyAgyErrorText: RESOURCE_EXHAUSTED|429|quota => usage_limit, authentication => not_logged_in, else network', () => {
    expect(classifyAgyErrorText('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429}')).toBe('usage_limit');
    expect(classifyAgyErrorText('AGY_ERROR: {"code":429}')).toBe('usage_limit');
    expect(classifyAgyErrorText('AGY_ERROR: {"message":"Quota exceeded"}')).toBe('usage_limit');
    expect(classifyAgyErrorText('AGY_ERROR: {"message":"authentication required"}')).toBe('not_logged_in');
    expect(classifyAgyErrorText('AGY_ERROR: {"status":"UNAUTHENTICATED"}')).toBe('not_logged_in');
    expect(classifyAgyErrorText('AGY_ERROR: {"status":"INTERNAL","code":500}')).toBe('network');
  });
  it('classifyAgyExit from the marker-only stderr view', () => {
    expect(classifyAgyExit(3, ['agy_error', 'quota'])).toBe('usage_limit');
    expect(classifyAgyExit(3, ['agy_error', 'http_429'])).toBe('usage_limit');
    expect(classifyAgyExit(3, ['agy_error', 'auth_required'])).toBe('not_logged_in');
    expect(classifyAgyExit(3, ['agy_error', 'authentication_failed'])).toBe('not_logged_in');
    expect(classifyAgyExit(3, ['agy_error'])).toBe('network');
    expect(classifyAgyExit(1, ['auth_required'])).toBe('not_logged_in');
    expect(classifyAgyExit(1, [])).toBeNull();
    // U-A6: a rejected stdin line (exit 1 'malformed input') => not_ready, never an argv fallback
    expect(classifyAgyExit(1, ['malformed_input'])).toBe('not_ready');
    expect(classifyAgyExit(2, ['malformed_input'])).toBe('not_ready');
    expect(classifyAgyExit(3, [])).toBeNull();
    expect(classifyAgyExit(0, ['agy_error'])).toBeNull();
    expect(classifyAgyExit(null, [])).toBeNull();
  });
});

describe('`agy models` (never a hard-coded list)', () => {
  it('parses the line format: header skipped, bullets / descriptions tolerated, only slug-shaped tokens', () => {
    expect(
      parseAgyModels([
        'Available models:',
        '  gemini-3.8-flash-high   Gemini 3.8 Flash (High)',
        '* gemini-3.1-pro-low',
        '- claude-sonnet-4-6',
        '',
        'Gemini',
        '--help',
        'gemini-3.8-flash-high',
        'weird_Upper-1',
      ]),
    ).toEqual(['gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'claude-sonnet-4-6']);
  });
  it('parses a JSON array or {models:[...]} payload; bad JSON falls back to lines; caps at 50', () => {
    expect(parseAgyModels(['["gemini-3.8-flash-high","x"]'])).toEqual(['gemini-3.8-flash-high']);
    expect(parseAgyModels(['{"models":[{"slug":"a-1"},{"id":"b-2"},{"name":"c-3"},"d-4",7]}'])).toEqual([
      'a-1',
      'b-2',
      'c-3',
      'd-4',
    ]);
    expect(parseAgyModels(['{"other":1}'])).toEqual([]);
    expect(parseAgyModels(['[not json', 'gemini-a-b'])).toEqual(['gemini-a-b']);
    expect(parseAgyModels(Array.from({ length: 80 }, (_, i) => `m-${i}`))).toHaveLength(50);
  });
  function jobsReturning(lines: string[], exitCode: number, onSpec?: (s: JobSpec) => void): JobRunner {
    return {
      run: async <T>(spec: JobSpec, use: (job: JobHandle) => Promise<T>): Promise<T> => {
        onSpec?.(spec);
        return use({
          pid: 1,
          lines: async function* () {
            for (const l of lines) yield l;
          },
          write: () => undefined,
          kill: () => undefined,
          done: Promise.resolve({ exitCode, killed: false, timedOut: false, stderrMarkers: [], ms: 1 }),
        });
      },
      breaker: () => ({ open: false, failures: 0, openedAt: null }),
      resetBreaker: () => undefined,
      killAll: async () => undefined,
      jobPids: () => ({ cli: [], voice: [] }),
    };
  }
  const runner = { run: vi.fn(), breakerOpen: () => false } as unknown as CliRunner;
  it('listAgyModels without the probe asks nothing and offers nothing', async () => {
    await expect(listAgyModels(runner)).resolves.toEqual([]);
  });
  const memWrites = () => {
    const dirs: string[] = [];
    const files: Array<[string, string]> = [];
    return {
      dirs,
      files,
      fs: {
        mkdirSync: (d: string) => void dirs.push(d),
        writeFileSync: (f: string, t: string) => void files.push([f, t]),
      },
    };
  };
  it('listAgyModels runs `agy models` under the isolated profile env (F3), in the app-owned workspace folder, and parses it', async () => {
    let spec: JobSpec | null = null;
    const exe = 'C:\\Users\\wca-fake-home\\AppData\\Local\\agy\\bin\\agy.exe';
    const ws = `${USERDATA}\\agy-workspace`;
    const agyHome = `${USERDATA}\\agy-home`;
    const m = memWrites();
    const got = await listAgyModels(runner, {
      jobs: jobsReturning(
        ['Available models:', '  gemini-3.8-flash-high', '  gemini-3.1-pro-high'],
        0,
        (s) => (spec = s),
      ),
      exePath: exe,
      userDataDir: USERDATA,
      processEnv: {
        SystemRoot: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\wca-fake-home',
        GEMINI_API_KEY: 'AIzaTESTONLY',
      },
      argsPrefix: ['fake.mjs', '--fake-end'],
      fs: m.fs,
    });
    expect(got).toEqual(['gemini-3.8-flash-high', 'gemini-3.1-pro-high']);
    const s = spec as unknown as JobSpec;
    expect(s.kind).toBe('cli');
    expect(s.args).toEqual(['fake.mjs', '--fake-end', 'models']);
    expect(s.stdin).toBeNull();
    expect(s.cwd).toBe(ws);
    expect(s.env.TEMP).toBe(s.cwd);
    expect(Object.keys(s.env).sort()).toEqual([...AGY_ENV_KEYS].sort());
    expect(s.env.USERPROFILE).toBe(agyHome);
    expect(s.env.HOME).toBe(agyHome);
    expect(s.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
    expect(JSON.stringify(s.env)).not.toContain('AIza');
    // only the app-written isolated settings.json (planAgyHome) is written before the job
    expect(m.files).toEqual(planAgyHome(USERDATA, ws).files.map((f) => [f.path, f.text]));
    expect(m.dirs[0]).toBe(ws);
  });
  it('listAgyModels: a failing exit, a refused job, an unwritable profile => [] (never a guessed list)', async () => {
    const base = { exePath: 'C:\\x\\agy.exe', userDataDir: USERDATA, processEnv: {}, fs: memWrites().fs };
    await expect(listAgyModels(runner, { ...base, jobs: jobsReturning(['gemini-a-b'], 1) })).resolves.toEqual([]);
    const throwing = {
      ...jobsReturning([], 0),
      run: () => Promise.reject(new Error('breaker')),
    } as unknown as JobRunner;
    await expect(listAgyModels(runner, { ...base, jobs: throwing })).resolves.toEqual([]);
    let ran = false;
    const failingFs = {
      mkdirSync: () => {
        throw new Error('EACCES');
      },
      writeFileSync: () => undefined,
    };
    await expect(
      listAgyModels(runner, { ...base, fs: failingFs, jobs: jobsReturning(['gemini-a-b'], 0, () => (ran = true)) }),
    ).resolves.toEqual([]);
    expect(ran).toBe(false);
  });
});

describe('buildAgyEnv (B26 allow-list, literal)', () => {
  it('exactly AGY_ENV_KEYS; PATH = System32; TEMP/TMP = the run dir; the profile vars from the plan; never an API key', () => {
    const home = planAgyHome(USERDATA, `${USERDATA}\\agy-workspace`).env;
    const env = buildAgyEnv({
      processEnv: {
        SYSTEMROOT: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\real',
        APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
        GEMINI_API_KEY: 'AIzaTESTONLY-1',
        GOOGLE_API_KEY: 'AIzaTESTONLY-2',
        NODE_OPTIONS: '--inspect',
        HTTPS_PROXY: 'http://127.0.0.1:1',
      },
      tempDir: RUNDIR,
      home,
    });
    expect(env).toEqual({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: `${USERDATA}\\agy-home`,
      HOME: `${USERDATA}\\agy-home`,
      APPDATA: `${USERDATA}\\agy-home\\AppData\\Roaming`,
      LOCALAPPDATA: `${USERDATA}\\agy-home\\AppData\\Local`,
      TEMP: RUNDIR,
      TMP: RUNDIR,
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    });
  });
  it('without a profile plan: the real profile vars by name; SystemRoot defaults; an extra profile key is a drift error', () => {
    const env = buildAgyEnv({ processEnv: {}, tempDir: RUNDIR, home: {} });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.USERPROFILE).toBe('');
    expect(() => buildAgyEnv({ processEnv: {}, tempDir: RUNDIR, home: { GEMINI_API_KEY: 'x' } })).toThrow(
      'agy_env_keyset_drift',
    );
  });
});

// ---------------------------------------------------------------- provider
function result(over: Partial<CliRunResult> = {}): CliRunResult {
  return {
    sandbox: { initOk: true, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
    structured: { intent: 'meeting', confidence: 0.9 },
    text: null,
    toolCalls: 0,
    blockedCalls: 0,
    stopReason: 'end',
    error: null,
    quota: null,
    usage: { inputTokens: 10, outputTokens: 5 },
    ms: 5,
    ...over,
  };
}
function mockRunner(res: CliRunResult | ((r: CliRunRequest) => CliRunResult), extra: Record<string, unknown> = {}) {
  const calls: Array<{ req: CliRunRequest; signal: AbortSignal }> = [];
  const runner = {
    run: vi.fn(async (r: CliRunRequest, signal: AbortSignal) => {
      calls.push({ req: r, signal });
      return typeof res === 'function' ? res(r) : res;
    }),
    breakerOpen: vi.fn(() => false),
    ...extra,
  };
  return { runner: runner as unknown as CliRunner & typeof runner, calls };
}
const locator = (version: string | null = '1.2.12'): CliLocator => ({
  find: vi.fn(async () => ({ provider: 'antigravity_cli' as const, exePath: 'C:\\agy\\agy.exe', version })),
  version: vi.fn(async () => version),
  signedIn: vi.fn(async () => true as const),
});
const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
  signal: new AbortController().signal,
  maxOutputTokens: 1024,
  purpose: 'extract',
  ...over,
});
const messages = [
  { role: 'system' as const, content: SYS },
  { role: 'user' as const, content: USER },
];

describe('createAgyProvider (loop prefetch, images false, no tools, no silent fallback)', () => {
  it('identity: antigravity_cli, loop prefetch, capabilities.images false, no runAgentic, chat() unsupported', async () => {
    const { runner } = mockRunner(result());
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'gemini-3.8-flash-high',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.12',
    });
    expect(p.id).toBe('antigravity_cli');
    expect(p.loop).toBe('prefetch');
    expect(p.capabilities).toEqual({ images: false });
    expect(p.runAgentic).toBeUndefined();
    expect(p.exePath).toBe('C:\\agy\\agy.exe');
    expect(p.observedVersion).toBe('1.2.12');
    await expect(p.chat([], [], opts())).rejects.toMatchObject({ code: 'unsupported' });
    expect(isAgyProvider(p)).toBe(true);
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('S1: ONE runner job - stage extract, the verbatim system, agy stdin envelope, the schema, 60 s, no tool server', async () => {
    const { runner, calls } = mockRunner(result());
    const onSandbox = vi.fn();
    const onUsage = vi.fn();
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'gemini-3.1-pro-high',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.12',
    });
    const out = await p.structured(messages, OBJ, opts({ onSandbox, onUsage }));
    expect(out).toEqual({ intent: 'meeting', confidence: 0.9 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.req).toEqual({
      provider: 'antigravity_cli',
      stage: 'extract',
      exePath: 'C:\\agy\\agy.exe',
      model: 'gemini-3.1-pro-high',
      system: SYS,
      stdinLine: buildAgyStdinLine(USER),
      jsonSchema: OBJ,
      maxTurns: 1,
      wallClockMs: LIMITS.cliWallClockExtractMs,
      toolServer: null,
      observedVersion: '1.2.12',
    });
    expect(onSandbox).toHaveBeenCalledWith(result().sandbox);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });
  });
  it('S3 (prefetch loop): stage draft, 120 s, user parts joined into the ONE text envelope', async () => {
    const { runner, calls } = mockRunner(result({ structured: { reply: 'ok' } }));
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
    });
    await p.structured(
      [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: [{ type: 'text', text: USER }] },
        { role: 'assistant', content: 'ignored' },
        { role: 'user', content: 'tail' },
      ],
      OBJ,
      opts({ purpose: 'draft' }),
    );
    expect(calls[0]?.req.stage).toBe('draft');
    expect(calls[0]?.req.wallClockMs).toBe(LIMITS.cliWallClockDraftMs);
    expect(calls[0]?.req.system).toBe('A\n\nB');
    expect(calls[0]?.req.stdinLine).toBe(buildAgyStdinLine(`${USER}\ntail`));
    expect(calls[0]?.req.observedVersion).toBe('');
  });
  it('pictures never reach agy: purpose read_image or an image part => unsupported, no job', async () => {
    const { runner } = mockRunner(result());
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
    });
    await expect(p.structured(messages, OBJ, opts({ purpose: 'read_image' }))).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(
      p.structured(
        [
          {
            role: 'user',
            content: [
              { type: 'image', mime: 'image/png', base64: 'AA==' },
              { type: 'text', text: USER },
            ],
          },
        ],
        OBJ,
        opts(),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('failed init proof / errors / missing structured_output => LlmError, never a retry', async () => {
    const bad: Array<[CliRunResult, string]> = [
      [
        result({
          sandbox: { initOk: false, toolsCount: 1, mcpServers: 0, apiKeySource: 'unknown', mismatch: 'extra_tool' },
          error: 'sandbox',
        }),
        'sandbox',
      ],
      [
        result({
          sandbox: { initOk: false, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
          error: null,
        }),
        'sandbox',
      ],
      [
        result({
          sandbox: { initOk: false, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
          error: 'usage_limit',
        }),
        'usage_limit',
      ],
      [result({ error: 'not_logged_in', structured: null }), 'not_logged_in'],
      [result({ error: 'bad_output', structured: null }), 'bad_output'],
      [result({ structured: null }), 'bad_output'],
    ];
    for (const [res, code] of bad) {
      const { runner } = mockRunner(res);
      const p = createAgyProvider({
        runner,
        locator: locator(),
        model: 'm-1',
        exePath: 'C:\\agy\\agy.exe',
        userDataDir: USERDATA,
      });
      const err = await p.structured(messages, OBJ, opts()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe(code);
      expect(runner.run).toHaveBeenCalledTimes(1);
    }
  });
  it('quota is reported to the call and to the provider sink', async () => {
    const q = { resetsAt: 123, usingOverage: null };
    const { runner } = mockRunner(result({ quota: q, usage: null }));
    const onQuota = vi.fn();
    const sink = vi.fn();
    const onUsage = vi.fn();
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      onQuota: sink,
    });
    await p.structured(messages, OBJ, opts({ onQuota, onUsage }));
    expect(onQuota).toHaveBeenCalledWith(q);
    expect(sink).toHaveBeenCalledWith(q);
    expect(onUsage).not.toHaveBeenCalled();
  });
  it('below the floor (1.2.10): version error BEFORE any job', async () => {
    const { runner } = mockRunner(result());
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.10',
    });
    await expect(p.structured(messages, OBJ, opts())).rejects.toMatchObject({ code: 'version' });
    expect(await p.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'version' });
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('fallback mode: the preflight runs before EVERY job; unsafe / unreadable / missing reader => refused with no spawn', async () => {
    let cfg = {
      mcpConfigText: '{"mcpServers":{"whatsapp":{"command":"uv"}}}' as string | null,
      hooksText: null as string | null,
    };
    const { runner } = mockRunner(result());
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.12',
      profileMode: 'global_checked',
      readGlobalConfig: () => cfg,
    });
    await expect(p.structured(messages, OBJ, opts())).rejects.toMatchObject({ code: 'sandbox' });
    expect(await p.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'sandbox' });
    expect(runner.run).not.toHaveBeenCalled();
    cfg = { mcpConfigText: null, hooksText: null };
    await expect(p.structured(messages, OBJ, opts())).resolves.toBeDefined();
    expect(runner.run).toHaveBeenCalledTimes(1);
    const throwing = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      profileMode: 'global_checked',
      readGlobalConfig: () => {
        throw new Error('EACCES');
      },
    });
    await expect(throwing.structured(messages, OBJ, opts())).rejects.toMatchObject({ code: 'sandbox' });
    const noReader = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      profileMode: 'global_checked',
    });
    await expect(noReader.structured(messages, OBJ, opts())).rejects.toMatchObject({ code: 'sandbox' });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

describe('createAgyProvider.validate (provider-start smoke, no user data)', () => {
  it('version from the locator when not supplied; then the constant smoke job', async () => {
    const { runner, calls } = mockRunner(result({ structured: { ok: true } }));
    const loc = locator('1.2.11');
    const onSmoke = vi.fn();
    let t = 1000;
    const p = createAgyProvider({
      runner,
      locator: loc,
      model: 'gemini-3.8-flash-high',
      exePath: 'C:\\agy\\agy.exe',
      userDataDir: USERDATA,
      onSmoke,
      now: () => (t += 10),
    });
    expect(await p.validate(new AbortController().signal)).toEqual({ ok: true, model: 'gemini-3.8-flash-high' });
    expect(loc.version).toHaveBeenCalledTimes(1);
    expect(calls[0]?.req).toEqual({
      provider: 'antigravity_cli',
      stage: 'smoke',
      exePath: 'C:\\agy\\agy.exe',
      model: 'gemini-3.8-flash-high',
      system: CLI_SMOKE_SYSTEM,
      stdinLine: buildAgyStdinLine(CLI_SMOKE_USER),
      jsonSchema: CLI_SMOKE_SCHEMA,
      maxTurns: 1,
      wallClockMs: LIMITS.cliTestWallClockMs,
      toolServer: null,
      observedVersion: '1.2.11',
    });
    expect(p.observedVersion).toBe('1.2.11');
    expect(p.lastSmokeOkAt()).not.toBeNull();
    expect(onSmoke).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });
  it('unreadable version / below floor => version; failed smokes => the right reason; smokeOkAt cleared', async () => {
    const p0 = createAgyProvider({
      runner: mockRunner(result()).runner,
      locator: locator(null),
      model: 'm-1',
      exePath: 'C:\\a\\agy.exe',
      userDataDir: USERDATA,
    });
    expect(await p0.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'version' });
    const failing = {
      ...locator(),
      version: vi.fn(async () => Promise.reject(new Error('x'))),
    } as unknown as CliLocator;
    const p1 = createAgyProvider({
      runner: mockRunner(result()).runner,
      locator: failing,
      model: 'm-1',
      exePath: 'C:\\a\\agy.exe',
      userDataDir: USERDATA,
    });
    expect(await p1.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'version' });
    const cases: Array<[CliRunResult, string]> = [
      [
        result({
          sandbox: { initOk: false, toolsCount: 1, mcpServers: 0, apiKeySource: 'unknown', mismatch: 'extra_tool' },
          error: null,
        }),
        'sandbox',
      ],
      [
        result({
          sandbox: { initOk: false, toolsCount: 0, mcpServers: 0, apiKeySource: 'unknown', mismatch: null },
          error: 'usage_limit',
        }),
        'usage_limit',
      ],
      [result({ error: 'not_logged_in' }), 'not_logged_in'],
      [result({ structured: { ok: 'yes' } }), 'bad_output'],
      [result({ structured: null }), 'bad_output'],
    ];
    for (const [res, reason] of cases) {
      const onSmoke = vi.fn();
      const p = createAgyProvider({
        runner: mockRunner(res).runner,
        locator: locator(),
        model: 'm-1',
        exePath: 'C:\\a\\agy.exe',
        userDataDir: USERDATA,
        observedVersion: '1.2.12',
        onSmoke,
      });
      expect(await p.validate(new AbortController().signal)).toEqual({ ok: false, reason });
      expect(p.lastSmokeOkAt()).toBeNull();
      expect(onSmoke).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    }
  });
  it('a throwing runner => not_ready, or aborted when the signal was aborted; quota from the smoke is reported', async () => {
    const throwing = {
      run: vi.fn(async () => Promise.reject(new Error('boom'))),
      breakerOpen: () => false,
    } as unknown as CliRunner;
    const p = createAgyProvider({
      runner: throwing,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\a\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.12',
    });
    expect(await p.validate(new AbortController().signal)).toEqual({ ok: false, reason: 'not_ready' });
    const ac = new AbortController();
    ac.abort();
    expect(await p.validate(ac.signal)).toEqual({ ok: false, reason: 'aborted' });
    const sink = vi.fn();
    const q = { resetsAt: 5, usingOverage: null };
    const pq = createAgyProvider({
      runner: mockRunner(result({ structured: { ok: true }, quota: q })).runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\a\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.12',
      onQuota: sink,
    });
    await pq.validate(new AbortController().signal);
    expect(sink).toHaveBeenCalledWith(q);
  });
  it('dispose() aborts the in-flight job signal and clears the smoke time; cliHealth mirrors the runner', async () => {
    let seen: AbortSignal | null = null;
    const runner = {
      run: vi.fn((_r: CliRunRequest, s: AbortSignal) => {
        seen = s;
        return new Promise<CliRunResult>((resolve) =>
          s.addEventListener('abort', () => resolve(result({ error: 'aborted', structured: null }))),
        );
      }),
      breakerOpen: vi.fn(() => true),
    } as unknown as CliRunner;
    const p = createAgyProvider({
      runner,
      locator: locator(),
      model: 'm-1',
      exePath: 'C:\\a\\agy.exe',
      userDataDir: USERDATA,
      observedVersion: '1.2.12',
    });
    const pending = p.structured(messages, OBJ, opts());
    await Promise.resolve();
    await p.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    expect(p.lastSmokeOkAt()).toBeNull();
    expect(p.cliHealth()).toEqual({ code: 'CLI_UNSTABLE', retryAtMs: null });
    const withHealth = {
      run: vi.fn(),
      breakerOpen: () => false,
      health: () => ({ code: 'CLOUD_QUOTA', retryAtMs: 9 }),
    } as unknown as CliRunner;
    expect(
      createAgyProvider({
        runner: withHealth,
        locator: locator(),
        model: 'm-1',
        exePath: 'C:\\a\\agy.exe',
        userDataDir: USERDATA,
      }).cliHealth(),
    ).toEqual({ code: 'CLOUD_QUOTA', retryAtMs: 9 });
    const quiet = { run: vi.fn(), breakerOpen: () => false } as unknown as CliRunner;
    expect(
      createAgyProvider({
        runner: quiet,
        locator: locator(),
        model: 'm-1',
        exePath: 'C:\\a\\agy.exe',
        userDataDir: USERDATA,
      }).cliHealth(),
    ).toBeNull();
  });
});

describe('makeAgyFactory (factory makeAgy)', () => {
  const runner = { run: vi.fn(), breakerOpen: () => false } as unknown as CliRunner;
  it('not found => not_installed; no / low version => version; never another provider', async () => {
    const none = { ...locator(), find: vi.fn(async () => null) } as unknown as CliLocator;
    await expect(
      makeAgyFactory({ locator: none, runner, userDataDir: USERDATA })({ model: 'm-1' }),
    ).rejects.toMatchObject({ code: 'not_installed' });
    await expect(
      makeAgyFactory({ locator: locator(null), runner, userDataDir: USERDATA })({ model: 'm-1' }),
    ).rejects.toMatchObject({ code: 'version' });
    await expect(
      makeAgyFactory({ locator: locator('1.2.10'), runner, userDataDir: USERDATA })({ model: 'm-1' }),
    ).rejects.toMatchObject({ code: 'version' });
  });
  it('builds the agy provider with the located exe + version; onLocated first; an unsafe model slug falls back to the default setting', async () => {
    const onLocated = vi.fn();
    const make = makeAgyFactory({
      locator: locator('1.2.11'),
      runner,
      userDataDir: USERDATA,
      onLocated,
      now: () => 1,
      onSmoke: vi.fn(),
      onQuota: vi.fn(),
    });
    const p = await make({ model: 'gemini-3.1-pro-high' });
    expect(onLocated).toHaveBeenCalledWith('C:\\agy\\agy.exe');
    expect(p.id).toBe('antigravity_cli');
    expect(p.model).toBe('gemini-3.1-pro-high');
    expect(p.observedVersion).toBe('1.2.11');
    expect((await make({ model: '-p' })).model).toBe(DEFAULT_SETTINGS.llm.cli.agyModel);
  });
  it('isAgyProvider rejects other providers', () => {
    expect(isAgyProvider({ id: 'claude_cli', exePath: 'x', cliHealth: () => null } as never)).toBe(false);
    expect(isAgyProvider({ id: 'antigravity_cli' } as never)).toBe(false);
  });
});
