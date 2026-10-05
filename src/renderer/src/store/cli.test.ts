// store/cli - vendor-CLI status for the Connect cards (UX2 7.1, 12 "Stores"; owner V2-W1-12).
import { beforeEach, describe, expect, it } from 'vitest';
import type { CliStatus } from '@shared/types';
import { IPC_DEFAULTS, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useCliStore } from './cli';

const status = (patch: Partial<CliStatus> = {}): CliStatus => ({ ...IPC_DEFAULTS['cli:getStatus'], ...patch });

beforeEach(() => useCliStore.setState({ status: {}, checkedAt: {}, error: {}, signInError: {}, signInStartedAt: {} }));

describe('useCliStore', () => {
  it("setStatus keeps the status per provider, stamps checkedAt and clears that provider's error only", () => {
    useCliStore.setState({ error: { claude_cli: 'CLOUD_AUTH', antigravity_cli: 'CLI_UNSTABLE' } });
    const before = Date.now();
    useCliStore.getState().setStatus(status({ state: 'ready' }));
    const s = useCliStore.getState();
    expect(s.status.claude_cli?.state).toBe('ready');
    expect(s.checkedAt.claude_cli).toBeGreaterThanOrEqual(before);
    expect(s.error).toEqual({ antigravity_cli: 'CLI_UNSTABLE' });
  });

  it('refresh() asks for both providers; refresh(p) for one', async () => {
    await useCliStore.getState().refresh();
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'claude_cli' });
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'antigravity_cli' });
    invokeMocks['cli:getStatus'].mockClear();
    await useCliStore.getState().refresh('antigravity_cli');
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledExactlyOnceWith({ provider: 'antigravity_cli' });
  });

  it('a failed read never throws: the ErrorCode lands in `error` for that provider', async () => {
    mockInvoke('cli:getStatus', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    await expect(useCliStore.getState().refresh('claude_cli')).resolves.toBeUndefined();
    expect(useCliStore.getState().error.claude_cli).toBe('INTERNAL');
    expect(useCliStore.getState().status.claude_cli).toBeUndefined();
  });

  it('[D-080] signIn asks main for the console, stamps the poll fallback and clears an older refusal', async () => {
    useCliStore.setState({ signInError: { claude_cli: 'CLI_VERSION' } });
    await expect(useCliStore.getState().signIn('claude_cli')).resolves.toBe(true);
    expect(invokeMocks['cli:signIn']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' });
    expect(useCliStore.getState().signInError).toEqual({});
    expect(useCliStore.getState().signInStartedAt.claude_cli).toBeTypeOf('number');
    useCliStore.getState().clearSignInWait('claude_cli');
    useCliStore.getState().clearSignInWait('claude_cli'); // idempotent
    expect(useCliStore.getState().signInStartedAt).toEqual({});
  });

  it("[D-080] a refused signIn records the code and re-reads that provider's status", async () => {
    mockInvoke('cli:signIn', () => ({ ok: false, error: { code: 'CLI_NOT_INSTALLED' } }));
    await expect(useCliStore.getState().signIn('antigravity_cli')).resolves.toBe(false);
    expect(useCliStore.getState().signInError).toEqual({ antigravity_cli: 'CLI_NOT_INSTALLED' });
    expect(useCliStore.getState().signInStartedAt).toEqual({});
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'antigravity_cli' });
  });
});
