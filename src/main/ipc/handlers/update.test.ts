// src/main/ipc/handlers/update.test.ts - [v5] the update:* handlers delegate to the service and fail closed without one.
import { describe, expect, it, vi } from 'vitest';
import { IPC_REQUEST_SCHEMAS, FOCUS_GATED_CHANNELS } from '../../../shared/ipc';
import type { UpdateState } from '../../../shared/types';
import type { UpdateService } from '../../update/updateService';
import { createUpdateHandlers } from './update';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
const STATE: UpdateState = {
  current: '0.1.7',
  latest: '0.1.9',
  status: 'available',
  progress: null,
  errorCode: null,
  ignoredVersion: null,
  lastCheckAt: 1,
  canInstall: false,
  lastInstall: null,
};

function svc(): UpdateService {
  return {
    state: vi.fn(() => STATE),
    check: vi.fn(async () => STATE),
    checkNow: vi.fn(async () => STATE),
    download: vi.fn(async () => ({ ok: true as const, value: { ...STATE, status: 'downloading' as const } })),
    install: vi.fn(async () => ({ ok: false as const, error: { code: 'BAD_REQUEST' as const } })),
    ignore: vi.fn((v: string) => ({ ...STATE, ignoredVersion: v })),
    unignore: vi.fn(() => STATE),
    onChange: vi.fn(() => () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
    settled: vi.fn(async () => undefined),
  };
}

describe('update:* handlers', () => {
  it('delegate to the service', async () => {
    const s = svc();
    const h = createUpdateHandlers(s);
    expect(await h['update:getState'](undefined, CTX)).toEqual({ ok: true, value: STATE });
    expect(await h['update:check'](undefined, CTX)).toEqual({ ok: true, value: STATE });
    expect(s.checkNow).toHaveBeenCalledOnce();
    expect(s.check).not.toHaveBeenCalled(); // the IPC door is the rate-limited one
    expect(await h['update:download'](undefined, CTX)).toMatchObject({ ok: true, value: { status: 'downloading' } });
    expect(await h['update:install'](undefined, CTX)).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await h['update:ignore']({ version: '0.1.9' }, CTX)).toMatchObject({
      ok: true,
      value: { ignoredVersion: '0.1.9' },
    });
    expect(s.ignore).toHaveBeenCalledWith('0.1.9');
    expect(await h['update:unignore'](undefined, CTX)).toEqual({ ok: true, value: STATE });
  });
  it('fail closed with INTERNAL when no service is wired', async () => {
    const h = createUpdateHandlers(undefined);
    for (const c of Object.keys(h) as Array<keyof typeof h>)
      expect(await (h[c] as (r: unknown, c: unknown) => unknown)(undefined, CTX)).toEqual({
        ok: false,
        error: { code: 'INTERNAL' },
      });
  });
  it('the contract: ignore takes a plain version only, install is focus-gated, the rest take no request', () => {
    expect(IPC_REQUEST_SCHEMAS['update:ignore'].safeParse({ version: '0.1.9' }).success).toBe(true);
    for (const bad of [{ version: 'v0.1.9' }, { version: '../x' }, { version: '0.1.9', url: 'x' }, {}])
      expect(IPC_REQUEST_SCHEMAS['update:ignore'].safeParse(bad).success).toBe(false);
    for (const c of [
      'update:getState',
      'update:check',
      'update:download',
      'update:install',
      'update:unignore',
    ] as const)
      expect(IPC_REQUEST_SCHEMAS[c].safeParse({ x: 1 }).success, c).toBe(false);
    expect(FOCUS_GATED_CHANNELS).toContain('update:install');
    expect(FOCUS_GATED_CHANNELS).not.toContain('update:ignore');
  });
});
