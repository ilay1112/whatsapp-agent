// store/cli - vendor-CLI status for the Connect cards (UX2 7.1, 12 "Stores"; owner V2-W1-12).
import { beforeEach, describe, expect, it } from 'vitest';
import type { CliStatus } from '@shared/types';
import { IPC_DEFAULTS, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useCliStore } from './cli';

const status = (patch: Partial<CliStatus> = {}): CliStatus => ({ ...IPC_DEFAULTS['cli:getStatus'], ...patch });

beforeEach(() => useCliStore.setState({ status: {}, checkedAt: {}, error: {} }));

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
});
