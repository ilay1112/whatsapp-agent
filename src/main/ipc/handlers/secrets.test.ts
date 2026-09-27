// TESTS 5.3 `ipc/*`: `secrets:*` has no `get` channel and never returns the value - only KeyStatus {present, last4}.
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { KeyStatus, Result, SecretName } from '../../../shared/types';
import { makeFixture } from '../register.fixtures';
import { createSecretsHandlers } from './secrets';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const KEY = 'sk-ant-TESTONLY-abcdef0123456789';

describe('secrets handlers', () => {
  it('there is no secrets:get channel anywhere in the contract', () => {
    expect(IPC_CHANNELS.filter((c) => c.startsWith('secrets:'))).toEqual([
      'secrets:set',
      'secrets:has',
      'secrets:clear',
    ]);
  });

  it('secrets:set stores through SecretStore, returns last4 only and drops the cached provider', async () => {
    const stored: Array<[SecretName, string]> = [];
    let invalidated = 0;
    const f = makeFixture();
    f.deps.secrets.set = async (name, value): Promise<Result<KeyStatus>> => {
      stored.push([name, value]);
      return { ok: true, value: { present: true, last4: value.slice(-4) } };
    };
    f.deps.providerFactory.invalidate = async () => {
      invalidated += 1;
    };

    const res = await createSecretsHandlers(f.deps)['secrets:set']({ name: 'anthropic_api_key', value: KEY }, CTX);
    expect(res).toEqual({ ok: true, value: { present: true, last4: '6789' } });
    expect(stored).toEqual([['anthropic_api_key', KEY]]);
    expect(invalidated).toBe(1);
    // The plaintext never appears in the response.
    expect(JSON.stringify(res)).not.toContain('sk-ant');
  });

  it('a failed secrets:set is returned unchanged and leaves the cached provider alone', async () => {
    let invalidated = 0;
    const f = makeFixture();
    f.deps.secrets.set = async () => ({ ok: false, error: { code: 'KEY_MISSING' } });
    f.deps.providerFactory.invalidate = async () => {
      invalidated += 1;
    };
    expect(await createSecretsHandlers(f.deps)['secrets:set']({ name: 'gemini_api_key', value: KEY }, CTX)).toEqual({
      ok: false,
      error: { code: 'KEY_MISSING' },
    });
    expect(invalidated).toBe(0);
  });

  it('secrets:has reports presence + last4 without touching the provider factory', async () => {
    const f = makeFixture();
    f.deps.secrets.has = (name) =>
      name === 'gemini_api_key' ? { present: true, last4: '9876' } : { present: false, last4: '' };
    const h = createSecretsHandlers(f.deps);
    expect(await h['secrets:has']({ name: 'gemini_api_key' }, CTX)).toEqual({
      ok: true,
      value: { present: true, last4: '9876' },
    });
    expect(await h['secrets:has']({ name: 'anthropic_api_key' }, CTX)).toEqual({
      ok: true,
      value: { present: false, last4: '' },
    });
  });

  it('secrets:clear wipes the row and drops the cached provider', async () => {
    const cleared: SecretName[] = [];
    let invalidated = 0;
    const f = makeFixture();
    f.deps.secrets.clear = (name) => {
      cleared.push(name);
      return { present: false, last4: '' };
    };
    f.deps.providerFactory.invalidate = async () => {
      invalidated += 1;
    };
    expect(await createSecretsHandlers(f.deps)['secrets:clear']({ name: 'anthropic_api_key' }, CTX)).toEqual({
      ok: true,
      value: { present: false, last4: '' },
    });
    expect(cleared).toEqual(['anthropic_api_key']);
    expect(invalidated).toBe(1);
  });
});
