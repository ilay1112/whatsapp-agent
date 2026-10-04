// TESTS 5.3 `ipc/*`: the llm channels. `llm:setProvider` refuses a half-configured provider with CONSENT_REQUIRED |
// KEY_MISSING | MODEL_MISSING *before* the switch; no plaintext key is ever part of a response; a provider error becomes
// an ErrorCode and never the provider's message (which can echo prompt text).
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL_PRESETS, GEMINI_MODEL_PRESETS } from '../../../shared/settings';
import { CONSENT_VERSIONS, type HardwareInfo, type ModelPlan, type TierInfo } from '../../../shared/types';
import { LlmError } from '../../llm/types';
import { makeFixture, NOW_0 } from '../register.fixtures';
import {
  createLlmHandlers,
  CONSENT_FOR,
  LLM_METADATA_TIMEOUT_MS,
  PRESETS_FOR,
  SECRET_FOR,
  USAGE_WINDOW_MS,
} from './llm';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const KEY = 'sk-ant-TESTONLY-abcdef0123456789';

const HARDWARE: HardwareInfo = { ramGiB: 16, gpus: [], freeDiskGiB: 120, recommendedTier: 'small' };

function tier(over: Partial<TierInfo> & { tier: TierInfo['tier'] }): TierInfo {
  return {
    modelLabel: 'fixture',
    sizeBytes: 1,
    status: 'none',
    bytesDone: 0,
    fitsDisk: true,
    tokPerSec: null,
    ...over,
  };
}
function plan(selected: ModelPlan['selectedTier'], tiers: TierInfo[]): ModelPlan {
  return { recommendedTier: selected, selectedTier: selected, tiers, suggestSmaller: false, mmproj: null }; // [V2] + mmproj
}

describe('llm:getHardware / llm:getConfig', () => {
  it('getHardware delegates to the injected probe', async () => {
    const f = makeFixture();
    f.deps.llm.hardware = async () => HARDWARE;
    expect(await createLlmHandlers(f.deps)['llm:getHardware'](undefined, CTX)).toEqual({ ok: true, value: HARDWARE });
  });

  it('getConfig reports key PRESENCE (last4 only), consent per kind and the rolling 24 h cloud usage', async () => {
    const f = makeFixture();
    f.state.consents.set('cloud_claude', CONSENT_VERSIONS.cloud_claude); // [V2] v2 text
    f.state.cloudTokens = { inputTokens: 1200, outputTokens: 340 };
    f.deps.secrets.has = (name) =>
      name === 'anthropic_api_key' ? { present: true, last4: '6789' } : { present: false, last4: '' };

    let windowStart = 0;
    f.deps.repos.runs.cloudTokensSince = (since: number) => {
      windowStart = since;
      return f.state.cloudTokens;
    };

    const res = await createLlmHandlers(f.deps)['llm:getConfig'](undefined, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.provider).toBe('local');
    expect(res.value.keys).toEqual({
      anthropic_api_key: { present: true, last4: '6789' },
      gemini_api_key: { present: false, last4: '' },
    });
    expect(res.value.consents).toEqual({
      whatsapp_tos: false,
      cloud_claude: true,
      cloud_gemini: false,
      cloud_claude_cli: false, // [V2] C2 1.1
      cloud_antigravity_cli: false,
    });
    expect(res.value.usageToday).toEqual({ inputTokens: 1200, outputTokens: 340, budget: 200_000 });
    // A rolling window, not a calendar day: a time-zone change cannot reset the budget.
    expect(windowStart).toBe(NOW_0 - USAGE_WINDOW_MS);
    expect(JSON.stringify(res)).not.toContain('sk-ant');
  });
});

describe('llm:setProvider', () => {
  it('local needs a READY model file for the selected tier', async () => {
    const f = makeFixture();
    f.deps.modelManager.plan = async () => plan('small', [tier({ tier: 'small', status: 'none' })]);
    expect(await createLlmHandlers(f.deps)['llm:setProvider']({ provider: 'local' }, CTX)).toEqual({
      ok: false,
      error: { code: 'MODEL_MISSING' },
    });
    expect(f.state.settings.llm.provider).toBe('local');
    expect(f.rec.audits).toEqual([]);
  });

  it('local with no plan entry for the selected tier is MODEL_MISSING too', async () => {
    const f = makeFixture();
    f.deps.modelManager.plan = async () => plan('mid', [tier({ tier: 'tiny', status: 'ready' })]);
    expect(await createLlmHandlers(f.deps)['llm:setProvider']({ provider: 'local' }, CTX)).toEqual({
      ok: false,
      error: { code: 'MODEL_MISSING' },
    });
  });

  it('a cloud provider without the CURRENT consent is CONSENT_REQUIRED and nothing is written', async () => {
    const f = makeFixture();
    f.deps.secrets.has = () => ({ present: true, last4: '6789' });
    expect(await createLlmHandlers(f.deps)['llm:setProvider']({ provider: 'claude' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    expect(f.state.settings.llm.provider).toBe('local');
  });

  it('consent without a stored key is KEY_MISSING', async () => {
    const f = makeFixture();
    f.state.consents.set('cloud_gemini', CONSENT_VERSIONS.cloud_gemini); // [V2]
    expect(await createLlmHandlers(f.deps)['llm:setProvider']({ provider: 'gemini' }, CTX)).toEqual({
      ok: false,
      error: { code: 'KEY_MISSING' },
    });
  });

  it('consent + key but an empty model id is MODEL_MISSING, for each cloud provider in its own field', async () => {
    for (const [provider, kind, field] of [
      ['claude', 'cloud_claude', 'claudeModel'],
      ['gemini', 'cloud_gemini', 'geminiModel'],
    ] as const) {
      const f = makeFixture();
      f.state.consents.set(kind, CONSENT_VERSIONS[kind]); // [V2]
      f.state.settings.llm[field] = '';
      f.deps.secrets.has = () => ({ present: true, last4: '6789' });
      expect(await createLlmHandlers(f.deps)['llm:setProvider']({ provider }, CTX), provider).toEqual({
        ok: false,
        error: { code: 'MODEL_MISSING' },
      });
      // The OTHER provider's model id is irrelevant to this decision.
      expect(f.state.settings.llm.provider).toBe('local');
    }
  });

  it('a fully configured cloud provider is written, the cached provider dropped and the switch audited', async () => {
    let invalidated = 0;
    const f = makeFixture();
    f.state.consents.set('cloud_claude', CONSENT_VERSIONS.cloud_claude); // [V2]
    f.deps.secrets.has = () => ({ present: true, last4: '6789' });
    f.deps.providerFactory.invalidate = async () => {
      invalidated += 1;
    };

    const res = await createLlmHandlers(f.deps)['llm:setProvider']({ provider: 'claude' }, CTX);
    expect(res.ok && res.value.provider).toBe('claude');
    expect(f.state.settings.llm.provider).toBe('claude');
    expect(invalidated).toBe(1);
    expect(f.rec.audits).toEqual([{ kind: 'provider_changed', ref: 'claude', detail: {}, now: NOW_0 }]);
  });

  it('local with a ready file is written too', async () => {
    const f = makeFixture();
    f.state.settings.llm.provider = 'claude';
    f.deps.modelManager.plan = async () => plan('tiny', [tier({ tier: 'tiny', status: 'ready' })]);
    const res = await createLlmHandlers(f.deps)['llm:setProvider']({ provider: 'local' }, CTX);
    expect(res.ok && res.value.provider).toBe('local');
    expect(f.rec.audits.map((a) => a.ref)).toEqual(['local']);
  });
});

describe('llm:validateKey / llm:listModels', () => {
  it('KEY_MISSING when nothing is stored, without calling the provider', async () => {
    const f = makeFixture();
    const h = createLlmHandlers(f.deps); // fixture secrets.get() resolves null; validateKey/listModels stay unimplemented
    expect(await h['llm:validateKey']({ provider: 'claude' }, CTX)).toEqual({
      ok: false,
      error: { code: 'KEY_MISSING' },
    });
    expect(await h['llm:listModels']({ provider: 'gemini' }, CTX)).toEqual({
      ok: false,
      error: { code: 'KEY_MISSING' },
    });
  });

  it('validateKey returns the resolved model id and hands the key straight to the injected helper', async () => {
    const seen: Array<{ provider: string; key: string; aborted: boolean }> = [];
    const f = makeFixture();
    f.deps.secrets.get = async () => KEY;
    f.deps.llm.validateKey = async (provider, apiKey, signal) => {
      seen.push({ provider, key: apiKey, aborted: signal.aborted });
      return { model: 'claude-opus-5' };
    };
    const res = await createLlmHandlers(f.deps)['llm:validateKey']({ provider: 'claude' }, CTX);
    expect(res).toEqual({ ok: true, value: { model: 'claude-opus-5' } });
    expect(seen).toEqual([{ provider: 'claude', key: KEY, aborted: false }]);
    expect(JSON.stringify(res)).not.toContain('sk-ant');
  });

  it('the metadata call is abortable through the INJECTED clock (no real timer)', async () => {
    const f = makeFixture();
    f.deps.secrets.get = async () => KEY;
    let seenSignal: AbortSignal | null = null;
    f.deps.llm.validateKey = async (_p, _k, signal) => {
      seenSignal = signal;
      return { model: 'x' };
    };
    await createLlmHandlers(f.deps)['llm:validateKey']({ provider: 'claude' }, CTX);
    expect(f.rec.timers).toHaveLength(1); // registered through deps.clock, so a virtual clock controls it
    f.fireTimers();
    expect((seenSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(LLM_METADATA_TIMEOUT_MS).toBe(20_000);
  });

  it('a provider error becomes an ErrorCode and the thrown message never reaches the renderer', async () => {
    const f = makeFixture();
    f.deps.secrets.get = async () => KEY;
    const cases: Array<[ConstructorParameters<typeof LlmError>[0], string]> = [
      ['auth', 'KEY_INVALID'],
      ['billing', 'CLOUD_QUOTA'],
      ['quota_daily', 'CLOUD_QUOTA'],
      ['model_not_found', 'MODEL_NOT_FOUND'],
      ['network', 'CLOUD_UNAVAILABLE'],
      ['overloaded', 'CLOUD_UNAVAILABLE'],
    ];
    for (const [providerCode, expected] of cases) {
      f.deps.llm.validateKey = async () => {
        throw new LlmError(providerCode);
      };
      expect(await createLlmHandlers(f.deps)['llm:validateKey']({ provider: 'claude' }, CTX), providerCode).toEqual({
        ok: false,
        error: { code: expected },
      });
    }
  });

  it('a NON-LlmError (an SDK object that may carry a prompt echo) collapses to CLOUD_UNAVAILABLE', async () => {
    const f = makeFixture();
    f.deps.secrets.get = async () => KEY;
    f.deps.llm.listModels = async () => {
      throw new Error('400 {"error":{"message":"invalid text: <echo of a message body>"}}');
    };
    const res = await createLlmHandlers(f.deps)['llm:listModels']({ provider: 'gemini' }, CTX);
    expect(res).toEqual({ ok: false, error: { code: 'CLOUD_UNAVAILABLE' } });
    expect(JSON.stringify(res)).not.toContain('echo of a message body');
  });

  it('[R2] listModels returns the live list plus the presets as ORDERING HINTS', async () => {
    const f = makeFixture();
    f.deps.secrets.get = async () => KEY;
    f.deps.llm.listModels = async () => [{ id: 'claude-sonnet-5', displayName: 'Sonnet 5' }];
    const res = await createLlmHandlers(f.deps)['llm:listModels']({ provider: 'claude' }, CTX);
    expect(res).toEqual({
      ok: true,
      value: { models: [{ id: 'claude-sonnet-5', displayName: 'Sonnet 5' }], presets: [...CLAUDE_MODEL_PRESETS] },
    });
    // The presets are a copy: a renderer-bound array can never mutate the module constant.
    if (res.ok) res.value.presets.push('injected');
    expect(CLAUDE_MODEL_PRESETS).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});

describe('the per-provider maps are complete and point at the right rows', () => {
  it('secret name, consent kind and presets exist for both cloud providers', () => {
    expect(SECRET_FOR).toEqual({ claude: 'anthropic_api_key', gemini: 'gemini_api_key' });
    // [V2] C2 1.1 CONSENT_KIND_FOR covers every CloudProviderId (the two CLI ids too)
    expect(CONSENT_FOR).toEqual({
      claude: 'cloud_claude',
      gemini: 'cloud_gemini',
      claude_cli: 'cloud_claude_cli',
      antigravity_cli: 'cloud_antigravity_cli',
    });
    expect(PRESETS_FOR.claude).toEqual(CLAUDE_MODEL_PRESETS);
    expect(PRESETS_FOR.gemini).toEqual(GEMINI_MODEL_PRESETS);
  });
});
