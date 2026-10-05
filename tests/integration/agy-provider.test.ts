// tests/integration/agy-provider.test.ts - T2 6 row `agy-provider` (owner V2-W1-09-antigravity, lane L10; W2-01 inherits it).
// The antigravity_cli provider end to end WITHOUT compose() (the harness option `cli.agy` is V2-W2-01's): the production provider
// factory + consent gate + real app.db consents repo, makeAgyFactory, CliRunner, JobRunner and draft.ts, with only the S-JOB spawn seam
// redirected to tests/fakes/fake-agy.mjs (system node.exe, T8; mkdtemp homes, T9). Covers: opt-in only (consent cloud_antigravity_cli
// v1 with the Terms read date; "Show experimental" itself is renderer copy, W1-12), the prefetch loop (one no-tool structured call with
// the app-prefetched WhatsApp block inlined), every mode of T2 3.2, pictures routed to Local, `agy models` fills the model list, and the
// workspace trust through the (mock) native dialog. Release stays gated on M-AGY-1: nothing here runs a real agy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createProviderFactory, type ProviderFactoryDeps } from '../../src/main/llm/factory.ts';
import { ConsentRequiredError, LlmError, type CallOpts, type LlmMessage } from '../../src/main/llm/types.ts';
import { createLogger } from '../../src/main/logger.ts';
import { createRepos, openDb, type Db } from '../../src/main/db/index.ts';
import {
  AGY_MIN_VERSION,
  createAgyWorkspace,
  isAgyProvider,
  listAgyModels,
  makeAgyFactory,
  type AgyProvider,
} from '../../src/main/llm/cli/antigravityCli.ts';
import { runDraft, DRAFT_REPLY_SCHEMA } from '../../src/main/agent/draft.ts';
import type { RunCtx, ToolGate } from '../../src/main/agent/toolGate.ts';
import { routeImage } from '../../src/main/agent/readImage.ts';
import { createCliHandlers, type CliHandlerExtras } from '../../src/main/ipc/handlers/cli.ts';
import type { HandlerDepsV2 } from '../../src/main/ipc/register.ts';
import { createAutoDialog } from '../../src/main/app/autoDialog.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings.ts';
import {
  ANTIGRAVITY_TERMS_READ_ON,
  CONSENT_KIND_FOR,
  CONSENT_VERSIONS,
  type CliStatus,
  type EpochMs,
} from '../../src/shared/types.ts';
import type { IpcContext } from '../../src/shared/ipc.ts';
import { FAKE_AGY_MODES, type FakeAgyMode } from '../fakes/fake-agy.types.ts';
import {
  AGY_S1_SCHEMA,
  AGY_S1_SYSTEM,
  AGY_S1_USER,
  createAgyFakeWorld,
  type AgyFakeWorld,
} from '../fakes/fake-agy.world.ts';

const worlds: AgyFakeWorld[] = [];
const dbs: Db[] = [];
const world = (...a: Parameters<typeof createAgyFakeWorld>): AgyFakeWorld => {
  const w = createAgyFakeWorld(...a);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  const mcp: string[] = [];
  for (const w of worlds.splice(0)) {
    // the app never writes an MCP config anywhere under userData (T2 3.2 / brief acceptance)
    mcp.push(
      ...w.allFiles().filter((f) => f.startsWith(w.userData) && path.basename(f).toLowerCase() === 'mcp_config.json'),
    );
    w.cleanup();
  }
  expect(mcp).toEqual([]);
});

const S1: LlmMessage[] = [
  { role: 'system', content: AGY_S1_SYSTEM },
  { role: 'user', content: AGY_S1_USER },
];
const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
  signal: new AbortController().signal,
  maxOutputTokens: 512,
  purpose: 'extract',
  ...over,
});
const runsOf = (w: AgyFakeWorld) => w.journal().filter((e) => ['extract', 'draft', 'smoke'].includes(e.stage ?? ''));
const T0 = 1_760_000_000_000 as EpochMs;

/** The production provider factory over a real app.db consents repo; makeAgy = the production makeAgyFactory over the fake world. */
function factoryWorld(w: AgyFakeWorld) {
  const db = openDb(':memory:');
  dbs.push(db);
  const repos = createRepos(db);
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  const others = { claude: vi.fn(), gemini: vi.fn(), local: vi.fn() };
  const located: string[] = [];
  const deps: ProviderFactoryDeps = {
    settings: () => settings,
    secrets: { get: vi.fn(async () => null), has: vi.fn(() => ({ present: false, last4: '' })) },
    repos,
    makeClaude: others.claude as never,
    makeGemini: others.gemini as never,
    makeLocal: others.local as never,
    log: createLogger({ logsDir: 'unused', sink: () => undefined }),
    makeAgy: makeAgyFactory({
      locator: w.locator,
      runner: w.runner,
      userDataDir: w.userData,
      onLocated: (exe) => located.push(exe),
    }),
    now: () => T0,
  };
  return { factory: createProviderFactory(deps), repos, settings, others, located };
}

describe('opt-in only: consent cloud_antigravity_cli v1 with the Terms read date, never a default, never a silent fallback', () => {
  it('the default provider is not antigravity_cli and its consent kind is cloud_antigravity_cli (version 1)', () => {
    expect(DEFAULT_SETTINGS.llm.provider).not.toBe('antigravity_cli');
    expect(CONSENT_KIND_FOR.antigravity_cli).toBe('cloud_antigravity_cli');
    expect(CONSENT_VERSIONS.cloud_antigravity_cli).toBe(1);
    expect(AGY_MIN_VERSION).toBe('1.2.11');
  });

  it('without the consent: ConsentRequiredError before anything is located or spawned; no other provider is built', async () => {
    const w = world();
    const f = factoryWorld(w);
    f.settings.llm.provider = 'antigravity_cli';
    const err = await f.factory.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentRequiredError);
    expect((err as ConsentRequiredError).kind).toBe('cloud_antigravity_cli');
    expect(w.spawnedArgs).toEqual([]);
    expect(f.located).toEqual([]);
    expect(f.others.local).not.toHaveBeenCalled();
    expect(f.others.claude).not.toHaveBeenCalled();
    expect(f.others.gemini).not.toHaveBeenCalled();
  });

  it('the consent row needs the Terms read date (repo refuses it without) and stores ANTIGRAVITY_TERMS_READ_ON', () => {
    const w = world();
    const f = factoryWorld(w);
    expect(() =>
      f.repos.consents.accept('cloud_antigravity_cli', CONSENT_VERSIONS.cloud_antigravity_cli, T0),
    ).toThrow();
    expect(f.repos.consents.isCurrent('cloud_antigravity_cli')).toBe(false);
    f.repos.consents.accept(
      'cloud_antigravity_cli',
      CONSENT_VERSIONS.cloud_antigravity_cli,
      T0,
      ANTIGRAVITY_TERMS_READ_ON,
    );
    expect(f.repos.consents.isCurrent('cloud_antigravity_cli')).toBe(true);
    expect(f.repos.consents.latest('cloud_antigravity_cli')).toMatchObject({
      version: CONSENT_VERSIONS.cloud_antigravity_cli,
      termsReadOn: ANTIGRAVITY_TERMS_READ_ON,
    });
  });

  it('with the consent: located -> floor -> provider-start smoke (constant prompt, no user data) -> the prefetch provider', async () => {
    const w = world();
    const f = factoryWorld(w);
    f.settings.llm.provider = 'antigravity_cli';
    f.repos.consents.accept(
      'cloud_antigravity_cli',
      CONSENT_VERSIONS.cloud_antigravity_cli,
      T0,
      ANTIGRAVITY_TERMS_READ_ON,
    );
    const p = await f.factory.get();
    expect(p.id).toBe('antigravity_cli');
    expect(p.loop).toBe('prefetch');
    expect(p.capabilities.images).toBe(false);
    expect(p.runAgentic).toBeUndefined();
    expect(isAgyProvider(p)).toBe(true);
    expect(f.located).toEqual([w.exePath]);
    expect(runsOf(w).map((e) => e.stage)).toEqual(['smoke']);
    expect(runsOf(w)[0]?.stdinSha256).not.toContain('coffee');
    expect(f.others.local).not.toHaveBeenCalled();
  });

  it('below the floor (1.2.10): LlmError version, nothing spawned, no fallback provider', async () => {
    const w = world({ state: { version: '1.2.10' } });
    const f = factoryWorld(w);
    f.settings.llm.provider = 'antigravity_cli';
    f.repos.consents.accept(
      'cloud_antigravity_cli',
      CONSENT_VERSIONS.cloud_antigravity_cli,
      T0,
      ANTIGRAVITY_TERMS_READ_ON,
    );
    const err = await f.factory.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('version');
    expect(w.spawnedArgs).toEqual([]);
    expect(f.others.local).not.toHaveBeenCalled();
  });
});

describe('prefetch loop (B14, P2 13.2): the app prefetches, the model gets ONE no-tool structured call', () => {
  it('S3: gate.prefetchWaContext inlined as its own block of the SAME nonce, stage draft, {reply} schema, one spawn', async () => {
    const nonce = '0123456789abcdef';
    const s3User =
      `<<DATA-${nonce}>>\n{"app_context":{"note":"app-computed, trusted - NOT from the contact","free_busy":"free"},` +
      `"messages":[{"from":"contact","text":"coffee tomorrow 17:00?"}]}\n<<END-DATA-${nonce}>>`;
    const waBlock = `<<DATA-${nonce}>>\n{"wa_context":[{"from":"me","text":"sure"}]}\n<<END-DATA-${nonce}>>`;
    const w = world({
      script: [{ when: { stage: 'draft' }, respond: { structured: { reply: 'Draft: "Tomorrow 17:00 works."' } } }],
    });
    const prefetchWaContext = vi.fn(async () => waBlock);
    const gate = { prefetchWaContext, exposedSpecs: vi.fn(() => []), invoke: vi.fn() } as unknown as ToolGate;
    const ctx = { signal: new AbortController().signal, blockedCalls: 0, nonce } as unknown as RunCtx;
    const out = await runDraft(w.provider(), {
      messages: [
        { role: 'system', content: 'S3 CONSTANT (agy test)' },
        { role: 'user', content: s3User },
      ],
      ctx,
      gate,
      maxOutputTokens: 256,
      wallClockMs: 120_000,
    });
    expect(out).toEqual({
      ok: true,
      text: 'Tomorrow 17:00 works.',
      toolCalls: 0,
      blockedToolCalls: 0,
      manipulation: false,
    });
    expect(prefetchWaContext).toHaveBeenCalledTimes(1);
    expect((gate as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke).not.toHaveBeenCalled();
    expect(w.spawnedArgs).toHaveLength(1);
    const argv = w.spawnedArgs[0] ?? [];
    expect(argv.slice(0, 2)).toEqual(['--agent', 'wca-draft']);
    expect(argv[argv.indexOf('--print-timeout') + 1]).toBe('110s');
    const [j] = runsOf(w);
    expect(j?.stage).toBe('draft');
    expect(j?.stdinNonceBlocks).toBe(2);
    expect(j?.violations).toEqual([]);
    expect(j?.agentFile.bodySha256).toBe(
      crypto.createHash('sha256').update('S3 CONSTANT (agy test)', 'utf8').digest('hex'),
    );
    expect(DRAFT_REPLY_SCHEMA.required).toEqual(['reply']);
  });

  it('a failing WhatsApp prefetch never fails the draft (optional context); still ONE job and no tool', async () => {
    const w = world();
    const gate = { prefetchWaContext: vi.fn(async () => Promise.reject(new Error('wa down'))) } as unknown as ToolGate;
    const ctx = { signal: new AbortController().signal, blockedCalls: 0 } as unknown as RunCtx;
    const out = await runDraft(w.provider(), {
      messages: [
        { role: 'system', content: 'S3 CONSTANT (agy test)' },
        { role: 'user', content: AGY_S1_USER },
      ],
      ctx,
      gate,
      maxOutputTokens: 256,
      wallClockMs: 120_000,
    });
    expect(out.ok).toBe(true);
    expect(w.spawnedArgs).toHaveLength(1);
  });
});

describe('every mode of T2 3.2 through the production runner', () => {
  // Expected provider-level outcome of one S1 structured() call per mode (C2 9.2 binding tables).
  const EXPECT: Record<FakeAgyMode, { ok: true } | { code: string; turnStarted: boolean; spawns?: 0 }> = {
    ok: { ok: true },
    waiting: { code: 'bad_output', turnStarted: true },
    denied: { code: 'bad_output', turnStarted: true },
    no_structured: { code: 'bad_output', turnStarted: true },
    exit3: { code: 'usage_limit', turnStarted: true },
    exit3_auth: { code: 'not_logged_in', turnStarted: true },
    exit3_other: { code: 'network', turnStarted: true },
    // [agy-provider-fix B] agy 1.2.16 lists every available tool in init.tools: an init listing tools is information, not a failure;
    // the proof rests on the deny-all policy (A) + the runtime tool watch (C) + the agent file.
    extra_tools: { ok: true },
    // [agy-provider-fix C] a real tool step => killed at once, the run failed, its answer never used
    forbidden_tool_step: { code: 'sandbox', turnStarted: true },
    forbidden_tool_done_only: { code: 'sandbox', turnStarted: true },
    manage_task_other_action: { code: 'sandbox', turnStarted: true },
    // [agy-provider-fix A] the deny-all policy is missing / altered after the write => refused BEFORE any spawn
    policy_missing: { code: 'sandbox', turnStarted: false, spawns: 0 },
    policy_altered: { code: 'sandbox', turnStarted: false, spawns: 0 },
    // a print timeout returns partial output: never used
    print_timeout_partial: { code: 'network', turnStarted: true },
    agent_mismatch: { code: 'sandbox', turnStarted: false },
    perm_mode: { code: 'sandbox', turnStarted: false },
    not_signed_in: { code: 'not_logged_in', turnStarted: false },
    hang: { code: 'network', turnStarted: false },
    garbage_lines: { ok: true },
    global_mcp_present: { ok: true }, // isolated mode: the planted global server is never seen (fallback mode: agy.sandbox.test.ts)
    // [D-080] an error result INSTEAD of the init: classified by its text (never sandbox), killed before any turn
    result_error_auth: { code: 'not_logged_in', turnStarted: false },
    result_error_quota: { code: 'usage_limit', turnStarted: false },
    result_error_other: { code: 'network', turnStarted: false },
  };
  it('the table covers every frozen mode', () => {
    expect(Object.keys(EXPECT).sort()).toEqual([...FAKE_AGY_MODES].sort());
  });
  it.each([...FAKE_AGY_MODES])(
    'mode %s',
    async (mode) => {
      const w = world({ state: { mode }, graceMs: 200 });
      if (mode === 'global_mcp_present') w.plantGlobalMcpConfig();
      const p = w.provider();
      // hang: a short wall clock through the runner directly (the provider's S1 budget is 60 s)
      const call =
        mode === 'hang'
          ? w.runner
              .run(
                {
                  provider: 'antigravity_cli',
                  stage: 'extract',
                  exePath: w.exePath,
                  model: 'gemini-3.8-flash-high',
                  system: AGY_S1_SYSTEM,
                  stdinLine: JSON.stringify({ event: 'user', message: { content: AGY_S1_USER } }),
                  jsonSchema: AGY_S1_SCHEMA,
                  maxTurns: 1,
                  wallClockMs: 3_000,
                  toolServer: null,
                  observedVersion: '1.2.12',
                },
                new AbortController().signal,
              )
              .then((r) => {
                if (r.error !== null) throw new LlmError(r.error);
                return r.structured;
              })
          : p.structured(S1, AGY_S1_SCHEMA, opts());
      const got = await call.then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      const want = EXPECT[mode];
      if ('ok' in want) {
        expect(got.ok).toBe(true);
        if (got.ok) expect(got.v).toEqual({ intent: 'meeting', confidence: 0 });
      } else {
        expect(got.ok).toBe(false);
        if (!got.ok) {
          expect(got.e).toBeInstanceOf(LlmError);
          expect((got.e as LlmError).code).toBe(want.code);
        }
        const j = runsOf(w)[0];
        if (j !== undefined) expect(j.turnStarted).toBe(want.turnStarted);
        if (j !== undefined) expect(j.toolStepCompleted).toBe(false); // a forbidden step never got further than its first event
      }
      // never a retry, never a second run with other flags (and no run at all without the deny-all policy)
      expect(w.spawnedArgs).toHaveLength('spawns' in want ? 0 : 1);
      for (const argv of w.spawnedArgs) expect(argv).not.toContain('-p');
    },
    20_000,
  );
});

describe('[agy-provider-fix] the agy 1.2.16 stream end to end (60 init tools, manage_task list, nested result without structured_output)', () => {
  it('provider-start smoke passes; S1 answer parsed from result.response; the proof records policy deny_all + runtimeWatch', async () => {
    const w = world({
      script: [{ when: { purpose: 'extract' }, respond: { structured: { intent: 'meeting', confidence: 0.8 } } }],
    });
    const p = w.provider();
    expect(await p.validate(new AbortController().signal)).toEqual({ ok: true, model: 'gemini-3.8-flash-high' });
    const proofs: unknown[] = [];
    const out = await p.structured(S1, AGY_S1_SCHEMA, opts({ onSandbox: (x) => proofs.push(x) }));
    expect(out).toEqual({ intent: 'meeting', confidence: 0.8 });
    expect(proofs).toEqual([
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
    const rows = w.audits.filter((a) => a.kind === 'cli_run');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.detail).toMatchObject({ initOk: true, policy: 'deny_all', runtimeWatch: true });
    expect(w.audits.filter((a) => a.kind === 'tool_blocked')).toEqual([]);
    for (const j of runsOf(w)) {
      expect(j.violations).toEqual([]);
      expect(j.policyDenyAll).toBe(true);
    }
  });

  it('S3 prefetch draft with a forbidden tool step: the draft fails (sandbox), nothing of the run is used, the breaker counts it', async () => {
    const w = world({
      state: { modeByStage: { draft: 'forbidden_tool_step' } },
      script: [{ when: { stage: 'draft' }, respond: { structured: { reply: 'SHOULD NEVER BE USED' } } }],
    });
    const gate = { prefetchWaContext: vi.fn(async () => null) } as unknown as ToolGate;
    const ctx = { signal: new AbortController().signal, blockedCalls: 0 } as unknown as RunCtx;
    const out = await runDraft(w.provider(), {
      messages: [
        { role: 'system', content: 'S3 CONSTANT (agy test)' },
        { role: 'user', content: AGY_S1_USER },
      ],
      ctx,
      gate,
      maxOutputTokens: 256,
      wallClockMs: 120_000,
    });
    expect(out).toMatchObject({ ok: false, reason: 'sandbox' });
    expect(JSON.stringify(out)).not.toContain('SHOULD NEVER BE USED');
    expect(w.spawnedArgs).toHaveLength(1);
    const [j] = runsOf(w);
    expect(j?.toolStepEmitted).toBe('run_command');
    expect(j?.toolStepCompleted).toBe(false);
    expect(j?.exit).toBe(-1);
    expect(w.audits.map((a) => a.kind)).toEqual(['tool_blocked', 'run_aborted', 'cli_run']);
    expect(w.runner.breakerOpen()).toBe(false); // one strike of three
  }, 20_000);
});

describe('pictures never go to agy (U-A2): readImage routes antigravity_cli to Local', () => {
  it('routeImage => local when the projector is ready, none otherwise - even with cloud images on and consent current', () => {
    const w = world();
    const p: AgyProvider = w.provider();
    expect(routeImage(p, true, true, true, () => true)).toBe('local');
    expect(routeImage(p, false, true, true, () => true)).toBe('none');
  });
  it('a V1 call on the agy provider itself is refused before any job (defence in depth)', async () => {
    const w = world();
    const err = await w
      .provider()
      .structured(S1, AGY_S1_SCHEMA, opts({ purpose: 'read_image' }))
      .catch((e: unknown) => e);
    expect((err as LlmError).code).toBe('unsupported');
    const img: LlmMessage[] = [
      { role: 'system', content: AGY_S1_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'image', mime: 'image/jpeg', base64: '/9j/', sha256: 'x'.repeat(64) },
          { type: 'text', text: AGY_S1_USER },
        ],
      } as unknown as LlmMessage,
    ];
    expect(
      (
        (await w
          .provider()
          .structured(img, AGY_S1_SCHEMA, opts())
          .catch((e: unknown) => e)) as LlmError
      ).code,
    ).toBe('unsupported');
    expect(w.spawnedArgs).toEqual([]);
  });
});

describe('`agy models` fills the model list (never a hard-coded list)', () => {
  it('the list is whatever the CLI reports, under the isolated profile env', async () => {
    const w = world({ state: { models: ['gemini-3.8-flash-high', 'gemini-4.0-pro-preview'] } });
    const probe = { jobs: w.jobs, exePath: w.exePath, userDataDir: w.userData, processEnv: w.processEnv };
    expect(await listAgyModels(w.runner, probe)).toEqual(['gemini-3.8-flash-high', 'gemini-4.0-pro-preview']);
    w.setState({ models: ['gemini-5.0-ultra-x'] });
    expect(await listAgyModels(w.runner, probe)).toEqual(['gemini-5.0-ultra-x']);
    expect(w.spawnedArgs).toEqual([['models'], ['models']]);
    expect(w.spawnedEnvs[0]?.USERPROFILE).toBe(path.join(w.userData, 'agy-home'));
    w.setState({ loggedIn: false });
    expect(await listAgyModels(w.runner, probe)).toEqual([]); // not signed in: nothing to offer, never a guess
  });
});

describe('workspace trust (fallback profile mode only) through cli:allowWorkspace and the mock native dialog', () => {
  const FOCUSED: IpcContext = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
  const statusFor = (provider: CliStatus['provider']): CliStatus => ({
    provider,
    state: 'ready',
    version: '1.2.12',
    minVersion: '1.2.11',
    quota: null,
    lastTest: null,
    workspaceTrusted: true,
  });
  function handlers(w: AgyFakeWorld, mode: 'isolated' | 'global_checked', running = false) {
    const showMessageBox = vi.fn(async () => ({ response: 1, checkboxChecked: false })); // "Change one line"
    const autoDialog = createAutoDialog({ showMessageBox, t: () => (k: string) => k });
    const agyWorkspace = createAgyWorkspace({
      home: () => w.home,
      proc: async () => running,
      fs: {
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        writeFileSync: (p, t) => fs.writeFileSync(p, t, 'utf8'),
        existsSync: (p) => fs.existsSync(p),
      },
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      userDataDir: w.userData,
      mode,
    });
    const deps = {
      cliStatus: {
        get: vi.fn(async (p: CliStatus['provider']) => statusFor(p)),
        invalidate: vi.fn(),
        recordWorkspaceTrusted: vi.fn(),
      },
      agyWorkspace,
      autoDialog,
      // A focused, live BrowserWindow double: W1-04 autoDialog fails closed (Cancel, no dialog) on any
      // parent that is not a focused, non-destroyed window, so a bare string would never reach showMessageBox.
      window: () => ({ isFocused: () => true, isDestroyed: () => false }),
      agyRunning: async () => running,
      agySettingsExists: () => fs.existsSync(path.join(w.home, '.gemini', 'antigravity-cli', 'settings.json')),
      clock: { now: () => T0 },
    } as unknown as HandlerDepsV2 & Partial<CliHandlerExtras>;
    return { h: createCliHandlers(deps), showMessageBox };
  }
  const settingsFile = (w: AgyFakeWorld): string => path.join(w.home, '.gemini', 'antigravity-cli', 'settings.json');

  it("isolated mode (default): cli:allowWorkspace answers BAD_REQUEST, no dialog, the user's file is never touched", async () => {
    const w = world();
    const { h, showMessageBox } = handlers(w, 'isolated');
    expect(await h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED)).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST' },
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(fs.existsSync(settingsFile(w))).toBe(false);
  });

  it('global_checked: the dialog shows the one-line diff; allow => backup first, ONLY trustedWorkspaces changes, key order kept', async () => {
    const w = world();
    const file = settingsFile(w);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = `${JSON.stringify({ toolPermission: 'request-review', trustedWorkspaces: ['D:\\proj'], theme: 'dark' }, null, 2)}\n`;
    fs.writeFileSync(file, original);
    const { h, showMessageBox } = handlers(w, 'global_checked');
    const preview = await h['cli:previewWorkspaceChange']({ provider: 'antigravity_cli' }, FOCUSED);
    const ws = path.join(w.userData, 'agy-workspace');
    expect(preview).toEqual({
      ok: true,
      value: { diffLine: `+ "trustedWorkspaces": [ ..., "${ws}" ]`, settingsFileExists: true, agyRunning: false },
    });
    const res = await h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED);
    expect(res.ok).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(showMessageBox.mock.calls[0])).toContain(
      JSON.stringify(`+ "trustedWorkspaces": [ ..., "${ws}" ]`).slice(1, -1),
    );
    expect(fs.readFileSync(`${file}.wca-backup`, 'utf8')).toBe(original);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(['toolPermission', 'trustedWorkspaces', 'theme']);
    expect(after).toEqual({ toolPermission: 'request-review', trustedWorkspaces: ['D:\\proj', ws], theme: 'dark' });
  });

  it('refused while an agy process runs (S-PROC): the file is unchanged, no backup', async () => {
    const w = world();
    const file = settingsFile(w);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"trustedWorkspaces":[]}');
    const { h } = handlers(w, 'global_checked', true);
    const res = await h['cli:allowWorkspace']({ provider: 'antigravity_cli', confirm: true }, FOCUSED);
    expect(res).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"trustedWorkspaces":[]}');
    expect(fs.existsSync(`${file}.wca-backup`)).toBe(false);
  });
});
