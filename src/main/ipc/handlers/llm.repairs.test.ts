// src/main/ipc/handlers/llm.repairs.test.ts - v2-repair-v2-main-defects REQUEST 13: "Use" (llm:setProvider) on a CLI provider that has
// no passed test within 24 h (typically: never tested yet) runs the provider-start smoke (UX2 7.1 "Checking...") and answers with ITS
// outcome, instead of claiming CLI_UNSTABLE ("keeps stopping"). Status + consent are still checked first; a fresh passed test runs nothing.
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_MIN_VERSION,
  CONSENT_VERSIONS,
  type CliProviderId,
  type CliStatus,
  type Result,
} from '../../../shared/types';
import { makeFixture, NOW_0 } from '../register.fixtures';
import type { LlmHandlersV2 } from '../register';
import { CLI_TEST_FRESH_MS, createLlmHandlers } from './llm';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function setup(lastTest: CliStatus['lastTest'], run: (p: CliProviderId) => Promise<Result<unknown>>, consent = true) {
  const f = makeFixture();
  if (consent) f.state.consents.set('cloud_claude_cli', CONSENT_VERSIONS.cloud_claude_cli);
  f.deps.providerFactory.invalidate = vi.fn(async () => {});
  const runCliTest = vi.fn(run);
  const v2: LlmHandlersV2 = {
    cliStatus: {
      get: async (provider) => ({
        provider,
        state: 'ready',
        version: '2.1.258',
        minVersion: CLI_MIN_VERSION[provider],
        quota: null,
        lastTest,
        workspaceTrusted: null,
      }),
    },
    listAgyModels: async () => [],
    runCliTest,
  };
  return { f, h: createLlmHandlers(f.deps, v2), runCliTest };
}

describe('llm:setProvider runs the smoke when no passed test is fresh', () => {
  it('never tested: the smoke runs once and its pass selects the provider', async () => {
    const { f, h, runCliTest } = setup(null, async () => ({ ok: true, value: { ok: true, ms: 900 } }));
    const res = await h['llm:setProvider']({ provider: 'claude_cli' }, CTX);
    expect(res.ok).toBe(true);
    expect(runCliTest).toHaveBeenCalledTimes(1);
    expect(runCliTest).toHaveBeenCalledWith('claude_cli');
    expect(f.state.settings.llm.provider).toBe('claude_cli');
  });

  it('a failed / stale test re-runs the smoke; its failure code is the answer and nothing is switched', async () => {
    for (const lastTest of [
      null,
      { ok: false, at: NOW_0, ms: null },
      { ok: true, at: NOW_0 - CLI_TEST_FRESH_MS - 1, ms: 800 },
    ]) {
      const { f, h, runCliTest } = setup(lastTest, async () => ({ ok: false, error: { code: 'CLI_NOT_SIGNED_IN' } }));
      expect(await h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
        ok: false,
        error: { code: 'CLI_NOT_SIGNED_IN' },
      });
      expect(runCliTest).toHaveBeenCalledTimes(1);
      expect(f.state.settings.llm.provider).toBe('local');
    }
  });

  it('a fresh passed test runs nothing; a missing consent runs nothing', async () => {
    const fresh = setup({ ok: true, at: NOW_0 - 1000, ms: 900 }, async () => ({ ok: true, value: null }));
    expect((await fresh.h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).ok).toBe(true);
    expect(fresh.runCliTest).not.toHaveBeenCalled();
    const noConsent = setup(null, async () => ({ ok: true, value: null }), false);
    expect(await noConsent.h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CONSENT_REQUIRED' },
    });
    expect(noConsent.runCliTest).not.toHaveBeenCalled();
  });
});
