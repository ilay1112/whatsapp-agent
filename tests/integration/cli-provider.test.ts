// tests/integration/cli-provider.test.ts - T2 6 row `cli-provider` (owner V2-W1-06-claude-cli; inherited by V2-W2-01 in Wave 2).
// Part A runs the PRODUCTION factory + claude_cli provider + CliRunner + JobRunner + loopback tool server against the spawned
// fake-claude-cli.mjs (S-JOB spawn seam only). Part B is the same scenario through compose() via the harness: it needs V2-W2-01's
// wiring (harness option `cli` / provider 'claude_cli' throw until then) and is listed as BLOCKED-BY V2-W2-01 in the notes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { providerErrorToErrorCode, type ErrorCode } from '../../src/shared/errors.ts';
import { CONSENT_VERSIONS, LIMITS, type ConsentKind } from '../../src/shared/types.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';
import { createProviderFactory } from '../../src/main/llm/factory.ts';
import { ConsentRequiredError, LlmError, type LlmProvider } from '../../src/main/llm/types.ts';
import { createLogger } from '../../src/main/logger.ts';
import { runDraft } from '../../src/main/agent/draft.ts';
import { startToolServer } from '../../src/main/mcp/toolServer.ts';
import { freePort } from '../../src/main/proc/freePort.ts';
import { IMAGE_READ_SCHEMA } from '../../src/shared/schemas.ts';
import { png } from '../fakes/image-fixtures.ts';
import type { FakeClaudeMode } from '../fakes/fake-claude-cli.types.ts';
import { createHarness } from '../helpers/harness.ts';
import {
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
const extractOpts = () => ({ signal: new AbortController().signal, maxOutputTokens: 512, purpose: 'extract' as const });
const S3_MESSAGES = [
  { role: 'system' as const, content: 'S3 CONSTANT (test)' },
  { role: 'user' as const, content: '<<DATA-0123456789abcdef>>\n{"messages":[]}\n<<END-DATA-0123456789abcdef>>' },
];
const isListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
const cliRunsEmpty = (w: ClaudeFakeWorld): boolean => {
  const d = path.join(w.userData, 'cli-runs');
  return !fs.existsSync(d) || fs.readdirSync(d).length === 0;
};

function factoryFor(
  w: ClaudeFakeWorld,
  accepted: Partial<Record<ConsentKind, number>> = { cloud_claude_cli: CONSENT_VERSIONS.cloud_claude_cli },
) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.provider = 'claude_cli';
  const others = { claude: vi.fn(), gemini: vi.fn(), local: vi.fn() };
  const factory = createProviderFactory({
    settings: () => settings,
    secrets: { get: async () => null, has: () => ({ present: false, last4: '' }) },
    repos: {
      consents: {
        accept: vi.fn(),
        latest: vi.fn(() => null),
        isCurrent: (k: ConsentKind) => accepted[k] === CONSENT_VERSIONS[k],
      } as never,
    },
    makeClaude: others.claude as never,
    makeGemini: others.gemini as never,
    makeLocal: others.local as never,
    makeClaudeCli: async ({ model }) => w.provider({ model }),
    log: createLogger({ logsDir: 'unused', sink: () => undefined }),
  });
  return { factory, others, settings };
}

describe('A. claude_cli end to end over the spawned fake (production modules)', () => {
  it('consent cloud_claude_cli v1 is required: without it nothing is spawned', async () => {
    const w = world();
    const { factory } = factoryFor(w, {});
    await expect(factory.get()).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(w.journal()).toEqual([]);
  });

  it('the provider-start smoke passes BEFORE any user data is sent (journal order), then S1 is tool-less', async () => {
    const w = world();
    const { factory } = factoryFor(w);
    const p = await factory.get();
    expect(w.journal().map((e) => e.stage)).toEqual(['smoke']);
    const out = await p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts());
    expect(out).toMatchObject({ intent: 'meeting' });
    const stages = w.journal().map((e) => e.stage);
    expect(stages).toEqual(['smoke', 'extract']);
    const s1 = w.journal()[1]!;
    expect(s1.argv).not.toContain('--mcp-config');
    expect(s1.argv[s1.argv.indexOf('--tools') + 1]).toBe('');
    expect(factory.usable()).toEqual({ ok: true });
  });

  it('S3 agentic through a REAL per-run listener; the listener is closed and the run dir removed afterwards', async () => {
    const w = world({
      script: [
        {
          when: { stage: 'draft', turn: 0 },
          respond: {
            toolCalls: [{ name: 'get_freebusy', input: { start: '2026-09-22T09:00', end: '2026-09-22T12:00' } }],
          },
        },
        { when: { stage: 'draft', turn: 1 }, respond: { text: 'Tomorrow 10:00 works for me.' } },
      ],
    });
    const { gate, ctx } = w.gate();
    const out = await runDraft(w.provider(), {
      messages: S3_MESSAGES,
      ctx,
      gate,
      maxOutputTokens: 400,
      wallClockMs: LIMITS.cliWallClockDraftMs,
    });
    expect(out).toMatchObject({ ok: true, text: 'Tomorrow 10:00 works for me.' });
    expect(w.journal()[0]!.toolCalls.map((t) => t.name)).toEqual(['get_freebusy']);
    expect(w.servers).toHaveLength(1);
    expect(await isListening(w.servers[0]!.port)).toBe(false);
    expect(cliRunsEmpty(w)).toBe(true);
  });

  it('V1: the picture block reaches the CLI first on stdin; read_image stage', async () => {
    const w = world();
    await w.provider().structured(
      [
        { role: 'system', content: 'V1 (test)' },
        {
          role: 'user',
          content: [
            { type: 'image', mime: 'image/png', base64: Buffer.from(png(4, 4)).toString('base64') },
            { type: 'text', text: '<<DATA-0123456789abcdef>>\n{}\n<<END-DATA-0123456789abcdef>>' },
          ],
        },
      ],
      IMAGE_READ_SCHEMA as never,
      { ...extractOpts(), purpose: 'read_image' },
    );
    expect(w.journal()[0]).toMatchObject({ stage: 'read_image', violations: [] });
  });

  it.each<[FakeClaudeMode, ErrorCode]>([
    ['rate_limit', 'CLOUD_UNAVAILABLE'],
    ['auth_failed', 'CLOUD_AUTH'],
    ['account_on_hold', 'CLOUD_AUTH'],
    ['model_not_found', 'MODEL_NOT_FOUND'],
    ['is_error_success', 'CLOUD_UNAVAILABLE'],
    ['refusal', 'LLM_BAD_OUTPUT'],
    ['no_structured', 'LLM_BAD_OUTPUT'],
    ['max_turns', 'LLM_BAD_OUTPUT'],
    ['max_structured_retries', 'LLM_BAD_OUTPUT'],
    ['crash_mid_stream', 'CLOUD_UNAVAILABLE'],
    ['extra_tool', 'CLI_TOOLSET_MISMATCH'],
    ['usage_limit', 'CLOUD_QUOTA'],
    ['overage', 'CLOUD_OVERAGE'],
    // [D-080] the live expired-OAuth stream (init first) and error events INSTEAD of the init: never CLI_TOOLSET_MISMATCH
    ['oauth_expired', 'CLI_NOT_SIGNED_IN'],
    ['auth_error_before_init', 'CLI_NOT_SIGNED_IN'],
    ['model_error_before_init', 'CLI_MODEL_REJECTED'],
  ])(
    'mode %s => %s',
    async (mode, code) => {
      const w = world({ state: { modeByStage: { extract: mode } } });
      const err = await w
        .provider()
        .structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      expect(providerErrorToErrorCode('claude_cli', (err as LlmError).code)).toBe(code);
      expect(cliRunsEmpty(w)).toBe(true);
    },
    20_000,
  );

  // [claude-extract-debug] the live 2.1.258 S1 failure (6 of 8 runs LLM_BAD_OUTPUT): StructuredOutput called with ONE `$PARAMETER_NAME`
  // key wrapping the whole answer, rejected by the CLI, run ends error_max_turns + is_error. The answer is recovered and the CLI gets
  // one in-run retry (--max-turns 2); a split answer still fails closed.
  it.each(['placeholder_keys', 'tool_name_wrapper', 'placeholder_then_heal'] as const)(
    'mode %s => the S1 answer is recovered (bounded --max-turns 2, tool-less, no strike)',
    async (mode) => {
      const w = world({ state: { modeByStage: { extract: mode } } });
      const out = await w.provider().structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts());
      expect(out).toMatchObject({ intent: 'meeting' });
      const [e] = w.journal();
      expect(e!.stage).toBe('extract');
      expect(e!.argv[e!.argv.indexOf('--max-turns') + 1]).toBe('2');
      expect(e!.argv[e!.argv.indexOf('--tools') + 1]).toBe('');
      expect(e!.violations).toEqual([]);
      expect(w.audits.filter((a) => a.kind === 'tool_blocked')).toEqual([]);
      expect(cliRunsEmpty(w)).toBe(true);
    },
    20_000,
  );

  it('mode placeholder_split => LLM_BAD_OUTPUT (never a partial answer)', async () => {
    const w = world({ state: { modeByStage: { extract: 'placeholder_split' } } });
    const err = await w
      .provider()
      .structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(providerErrorToErrorCode('claude_cli', (err as LlmError).code)).toBe('LLM_BAD_OUTPUT');
  }, 20_000);

  it('garbage_lines and stderr_flood are tolerated; nothing of stdout/stderr reaches an audit row', async () => {
    for (const mode of ['garbage_lines', 'stderr_flood'] as const) {
      const w = world({ state: { modeByStage: { extract: mode } } });
      await expect(w.provider().structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).resolves.toMatchObject({
        intent: 'meeting',
      });
      expect(JSON.stringify(w.audits)).not.toMatch(/SENTINEL|FAKEBANNER|not json/);
    }
  }, 30_000);

  it('usage_limit holds until resetsAt: no further spawn before it', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const w = world({
      state: {
        modeByStage: { extract: 'usage_limit' },
        rateLimit: { status: 'rejected', resetsAt, isUsingOverage: false },
      },
    });
    const p = w.provider();
    await expect(p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).rejects.toMatchObject({
      code: 'usage_limit',
    });
    expect(p.cliHealth()).toEqual({ code: 'CLOUD_QUOTA', retryAtMs: resetsAt * 1000 });
    await expect(p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).rejects.toMatchObject({
      code: 'usage_limit',
    });
    expect(w.journal()).toHaveLength(1);
  }, 20_000);

  it('overage pauses the provider (no further run starts); allowOverage:true does not pause', async () => {
    const paused = world({ state: { modeByStage: { extract: 'overage' } } });
    const p = paused.provider();
    await expect(p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).rejects.toMatchObject({
      code: 'overage',
    });
    await expect(p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).rejects.toMatchObject({
      code: 'overage',
    });
    expect(paused.journal()).toHaveLength(1);
    expect(p.cliHealth()?.code).toBe('CLOUD_OVERAGE');
    const allowed = world({ state: { modeByStage: { extract: 'overage' } }, allowOverage: () => true });
    await expect(allowed.provider().structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).resolves.toMatchObject({
      intent: 'meeting',
    });
    expect(allowed.provider().cliHealth()).toBeNull();
  }, 20_000);

  it('three crashes in 10 minutes => CLI_UNSTABLE (no spawn until "Test again")', async () => {
    const w = world({ state: { modeByStage: { extract: 'crash_mid_stream' } } });
    const p = w.provider();
    for (let i = 0; i < LIMITS.cliBreakerFailures; i++)
      await p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts()).catch(() => undefined);
    expect(p.cliHealth()).toEqual({ code: 'CLI_UNSTABLE', retryAtMs: null });
    await expect(p.structured(S1_MESSAGES, S1_SCHEMA as never, extractOpts())).rejects.toMatchObject({
      code: 'not_ready',
    });
    expect(w.journal()).toHaveLength(LIMITS.cliBreakerFailures);
    w.runner.resetBreaker();
    expect(p.cliHealth()).toBeNull();
  }, 30_000);

  it('Pause (abort) mid-run kills the job: listener closed, run dir removed, pid files removed', async () => {
    const w = world({ state: { modeByStage: { draft: 'hang' } } });
    const { gate } = w.gate();
    const ac = new AbortController();
    const { ctx } = w.gate();
    const ctx2 = { ...ctx, signal: ac.signal };
    const p = runDraft(w.provider(), {
      messages: S3_MESSAGES,
      ctx: ctx2,
      gate,
      maxOutputTokens: 400,
      wallClockMs: LIMITS.cliWallClockDraftMs,
    });
    await new Promise((r) => setTimeout(r, 1500));
    ac.abort();
    expect(await p).toMatchObject({ ok: false });
    expect(await isListening(w.servers[0]!.port)).toBe(false);
    expect(cliRunsEmpty(w)).toBe(true);
    expect(fs.readdirSync(w.runDir).filter((f) => f.startsWith('job-'))).toEqual([]);
  }, 30_000);

  it('EADDRINUSE on the listener => the CLI provider is not_ready, nothing spawned, no crash (Local unaffected)', async () => {
    const w = world();
    const { gate, ctx } = w.gate();
    const provider = w.provider({
      startToolServer: (input) =>
        startToolServer({
          gate: input.gate,
          ctx: input.ctx,
          specs: input.specs,
          randomBytes: (n) => new Uint8Array(n).fill(7),
          freePort: () => freePort({ listen: async () => 8080, maxAttempts: 3 }), // S-PORT: 8080 every time
          appVersion: 'test',
        }),
    });
    expect(
      await runDraft(provider, { messages: S3_MESSAGES, ctx, gate, maxOutputTokens: 400, wallClockMs: 1000 }),
    ).toMatchObject({
      ok: false,
      reason: 'not_ready',
    });
    expect(w.journal()).toEqual([]);
  });

  it('NEVER a silent fallback: a failing claude_cli smoke constructs no other provider (constructor spies)', async () => {
    const w = world({ state: { modeByStage: { smoke: 'auth_failed' } } });
    const { factory, others } = factoryFor(w);
    for (let i = 0; i < 2; i++) await expect(factory.get()).rejects.toBeInstanceOf(LlmError);
    expect(factory.usable()).toEqual({ ok: false, code: 'CLOUD_AUTH' });
    expect(others.claude).not.toHaveBeenCalled();
    expect(others.gemini).not.toHaveBeenCalled();
    expect(others.local).not.toHaveBeenCalled();
  }, 20_000);
});

describe('B. through compose() (harness) - BLOCKED-BY V2-W2-01 until the CLI wiring lands', () => {
  it('claude_cli pipeline: inbound message -> smoke -> S1 -> S3 (agentic) -> a card; journal order proves smoke-before-data', async () => {
    const chat = '972550000001@s.whatsapp.net';
    const h = await createHarness({ provider: 'claude_cli', cli: { claude: {} } });
    try {
      await h.bridge.outboundFromPhone({ chatJid: chat, text: 'hey', ts: new Date(h.clock.now() - 3_600_000) });
      await h.bridge.inbound({ chatJid: chat, text: 'coffee Thursday at 5?' });
      await h.settle();
      // [V2-W2-01] the locator's `--version` / `auth status` probes (constant argv, no stdin, no user data) come first in the real
      // wiring; among the invocations that carry a prompt, the constant provider-start smoke must precede every data stage.
      const stages = (h.cliJournal() as Array<{ stage: string }>)
        .map((e) => e.stage)
        .filter((s) => s !== 'version' && s !== 'auth_status');
      expect(stages[0]).toBe('smoke');
      expect(stages).toContain('extract');
      expect(h.jobs()).toEqual({ cli: [], voice: [] });
    } finally {
      await h.dispose();
    }
  });
});

export type { LlmProvider };
