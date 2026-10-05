// T2 5 / C2 8: llm:setProvider for the five ids with the exact consent versions of B21 (a CLI provider is selectable only with
// status ready + consent current + a passed cli:test within 24 h), llm:listModels for the CLI ids, llm:getConfig quota.
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_CLI_MODEL_PRESETS, DEFAULT_SETTINGS } from '../../../shared/settings';
import { CLI_MIN_VERSION, CONSENT_VERSIONS, type CliProviderId, type CliStatus } from '../../../shared/types';
import { LlmError } from '../../llm/types';
import { makeFixture, NOW_0 } from '../register.fixtures';
import type { LlmHandlersV2 } from '../register';
import { AGY_MODELS_MAX, CLI_STATE_CODE, CLI_TEST_FRESH_MS, createLlmHandlers } from './llm';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function status(provider: CliProviderId, over: Partial<CliStatus> = {}): CliStatus {
  return {
    provider,
    state: 'ready',
    version: '2.1.258',
    minVersion: CLI_MIN_VERSION[provider],
    quota: null,
    lastTest: { ok: true, at: NOW_0 - 1000, ms: 900 },
    workspaceTrusted: provider === 'antigravity_cli' ? true : null,
    ...over,
  };
}

function setup(
  opts: { status?: Partial<CliStatus>; consent?: boolean; agy?: () => Promise<string[]>; wired?: boolean } = {},
) {
  const f = makeFixture();
  const get = vi.fn(async (p: CliProviderId) => status(p, opts.status));
  if (opts.consent !== false) {
    f.state.consents.set('cloud_claude_cli', CONSENT_VERSIONS.cloud_claude_cli);
    f.state.consents.set('cloud_antigravity_cli', CONSENT_VERSIONS.cloud_antigravity_cli);
  }
  const invalidate = vi.fn(async () => {});
  f.deps.providerFactory.invalidate = invalidate;
  const v2: LlmHandlersV2 = { cliStatus: { get }, listAgyModels: opts.agy ?? (async () => ['gemini-3.8-flash-high']) };
  return { f, h: createLlmHandlers(f.deps, opts.wired === false ? undefined : v2), get, invalidate };
}

describe('llm:setProvider - CLI ids', () => {
  it('ready + consent current + fresh passed test => switched, factory invalidated, audited', async () => {
    for (const provider of ['claude_cli', 'antigravity_cli'] as const) {
      const { f, h, get, invalidate } = setup();
      const res = await h['llm:setProvider']({ provider }, CTX);
      expect(res.ok && res.value.provider).toBe(provider);
      expect(get).toHaveBeenCalledWith(provider);
      expect(f.state.settings.llm.provider).toBe(provider);
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(f.rec.audits).toEqual([{ kind: 'provider_changed', ref: provider, detail: {}, now: NOW_0 }]);
    }
  });

  it('each non-ready CLI state maps to its own code and nothing is switched', async () => {
    for (const [state, code] of Object.entries(CLI_STATE_CODE)) {
      const { f, h, invalidate } = setup({ status: { state: state as CliStatus['state'] } });
      expect(await h['llm:setProvider']({ provider: 'claude_cli' }, CTX), state).toEqual({
        ok: false,
        error: { code },
      });
      expect(f.state.settings.llm.provider).toBe('local');
      expect(invalidate).not.toHaveBeenCalled();
    }
    // [D-080] 'unknown' is not in the table: "could not tell" is never reported as "not signed in" (B13)
    expect(CLI_STATE_CODE).toEqual({
      not_installed: 'CLI_NOT_INSTALLED',
      too_old: 'CLI_VERSION',
      not_signed_in: 'CLI_NOT_SIGNED_IN',
    });
  });

  it('[D-080] unknown ("could not tell whether you are signed in"): the smoke decides, after the consent - never a stale test', async () => {
    const f1 = setup({ status: { state: 'unknown' } });
    const runCliTest = vi.fn(async () => ({ ok: true as const, value: { ok: true, ms: 900 } }));
    const h1 = createLlmHandlers(f1.f.deps, { cliStatus: { get: f1.get }, listAgyModels: async () => [], runCliTest });
    const r1 = await h1['llm:setProvider']({ provider: 'claude_cli' }, CTX);
    expect(r1.ok && r1.value.provider).toBe('claude_cli');
    expect(runCliTest).toHaveBeenCalledTimes(1); // even with a fresh passed lastTest: the status cannot tell NOW
    // the smoke says not signed in => THAT is reported (now it is known)
    const f2 = setup({ status: { state: 'unknown' } });
    const failing = vi.fn(async () => ({ ok: false as const, error: { code: 'CLI_NOT_SIGNED_IN' as const } }));
    const h2 = createLlmHandlers(f2.f.deps, {
      cliStatus: { get: f2.get },
      listAgyModels: async () => [],
      runCliTest: failing,
    });
    expect(await h2['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CLI_NOT_SIGNED_IN' },
    });
    expect(f2.f.state.settings.llm.provider).toBe('local');
    // no consent => CONSENT_REQUIRED before any smoke
    const f3 = setup({ status: { state: 'unknown' }, consent: false });
    const never = vi.fn();
    const h3 = createLlmHandlers(f3.f.deps, {
      cliStatus: { get: f3.get },
      listAgyModels: async () => [],
      runCliTest: never,
    });
    expect(await h3['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    expect(never).not.toHaveBeenCalled();
    // without a smoke runner nothing is claimed: CLI_NOT_SIGNED_IN carries params.state 'unknown' (renderer: "Could not tell ...")
    const f4 = setup({ status: { state: 'unknown' } });
    expect(await f4.h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CLI_NOT_SIGNED_IN', params: { state: 'unknown' } },
    });
  });

  it('without the CURRENT consent version it is CONSENT_REQUIRED - the consent dialog is the only way in (B21)', async () => {
    const { f, h } = setup({ consent: false });
    expect(await h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    f.state.consents.set('cloud_claude_cli', CONSENT_VERSIONS.cloud_claude_cli + 1); // a future, unread text is not current
    expect(await h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    expect(f.state.settings.llm.provider).toBe('local');
  });

  it('no test, a failed test, or a test older than 24 h => CLI_UNSTABLE', async () => {
    for (const lastTest of [
      null,
      { ok: false, at: NOW_0, ms: null },
      { ok: true, at: NOW_0 - CLI_TEST_FRESH_MS - 1, ms: 800 },
    ]) {
      const { h } = setup({ status: { lastTest } });
      expect(await h['llm:setProvider']({ provider: 'antigravity_cli' }, CTX), JSON.stringify(lastTest)).toEqual({
        ok: false,
        error: { code: 'CLI_UNSTABLE' },
      });
    }
    const edge = setup({ status: { lastTest: { ok: true, at: NOW_0 - CLI_TEST_FRESH_MS, ms: 1 } } });
    expect((await edge.h['llm:setProvider']({ provider: 'antigravity_cli' }, CTX)).ok).toBe(true);
  });

  it('without the CLI status service it fails closed (INTERNAL)', async () => {
    const { f, h } = setup({ wired: false });
    expect(await h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'INTERNAL' },
    });
    expect(f.state.settings.llm.provider).toBe('local');
  });

  it('the API-key ids now need the v2 consent text (an old v1 acceptance is not current)', async () => {
    const { f, h } = setup();
    f.state.consents.set('cloud_claude', 1);
    f.deps.secrets.has = () => ({ present: true, last4: '1234' });
    expect(await h['llm:setProvider']({ provider: 'claude' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    f.state.consents.set('cloud_claude', CONSENT_VERSIONS.cloud_claude);
    expect((await h['llm:setProvider']({ provider: 'claude' }, CTX)).ok).toBe(true);
  });
});

describe('llm:listModels - CLI ids', () => {
  it('claude_cli: the alias presets (the CLI has no listing), no key needed', async () => {
    const { h } = setup();
    expect(await h['llm:listModels']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: true,
      value: {
        models: CLAUDE_CLI_MODEL_PRESETS.map((id) => ({ id, displayName: id })),
        presets: [...CLAUDE_CLI_MODEL_PRESETS],
      },
    });
  });

  it('antigravity_cli: the injected agy listing, filtered to schema-valid unique ids and capped', async () => {
    const hostile = [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-high',
      'gemini 3 pro <script>',
      '',
      'x'.repeat(101),
      '../../evil',
      'gemini-3.8-pro',
      ...Array.from({ length: AGY_MODELS_MAX + 10 }, (_, i) => `model-${i}`),
    ];
    const { h } = setup({ agy: async () => hostile });
    const res = await h['llm:listModels']({ provider: 'antigravity_cli' }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.models).toHaveLength(AGY_MODELS_MAX);
    expect(res.value.models.slice(0, 3).map((m) => m.id)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-pro',
      'model-0',
    ]);
    expect(JSON.stringify(res.value)).not.toMatch(/script|evil|\s/);
    expect(res.value.presets).toEqual([DEFAULT_SETTINGS.llm.cli.agyModel]);
  });

  it('an agy failure becomes an ErrorCode, never the CLI text; unwired => not ready', async () => {
    const { h } = setup({
      agy: async () => {
        throw new LlmError('not_logged_in');
      },
    });
    expect(await h['llm:listModels']({ provider: 'antigravity_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CLI_NOT_SIGNED_IN' },
    });
    const raw = setup({
      agy: async () => {
        throw new Error('SENTINEL_CLI_STDOUT');
      },
    });
    const res = await raw.h['llm:listModels']({ provider: 'antigravity_cli' }, CTX);
    expect(res).toEqual({ ok: false, error: { code: 'CLOUD_UNAVAILABLE' } });
    const unwired = setup({ wired: false });
    expect(await unwired.h['llm:listModels']({ provider: 'antigravity_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'LLM_NOT_READY' },
    });
  });
});

describe('llm:getConfig [V2]', () => {
  it('carries llm.cli minus the path (claudeExePathSet only) and the quota only for a CLI provider', async () => {
    const { f, h } = setup();
    f.state.settings.llm.cli.claudeExePath = 'C:\\Users\\x\\.local\\bin\\claude.exe';
    f.deps.healthHub.setLlmQuota({ resetsAt: NOW_0 + 3_600_000, usingOverage: false });
    const local = await h['llm:getConfig'](undefined, CTX);
    expect(local.ok && local.value.quota).toBeNull();
    expect(local.ok && local.value.cli.claudeExePathSet).toBe(true);
    expect(JSON.stringify(local)).not.toContain('claude.exe');
    f.state.settings.llm.provider = 'claude_cli';
    const cli = await h['llm:getConfig'](undefined, CTX);
    expect(cli.ok && cli.value.quota).toEqual({ resetsAt: NOW_0 + 3_600_000, usingOverage: false });
  });
});
