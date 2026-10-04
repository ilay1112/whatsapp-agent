// register.handlers.ts: every channel group comes from its factory, the union is exactly IPC_CHANNELS, and the v2 collaborators
// of the v1 handler files are wired from HandlerDepsV2 + the ext (so W2-01 cannot forget one of them).
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { makeFixture } from './register.fixtures';
import type { HandlerDepsV2 } from './register';
import { createIpcHandlers, mergeHandlerGroups, type IpcHandlersExtV2 } from './register.handlers';

const CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };

function depsV2() {
  const f = makeFixture();
  const undo = {
    undoChange: vi.fn(),
    undoAuto: vi.fn(),
    restoreOriginal: vi.fn(),
    cancelEvent: vi.fn(),
  };
  const voiceState = vi.fn(() => ({
    enabled: false,
    tier: 'auto' as const,
    resolvedTier: null,
    model: null,
    vad: { status: 'none' as const },
    secPerAudioSec: null,
    suggestLite: false,
  }));
  const cliGet = vi.fn(async () => ({ state: 'not_installed' }) as never);
  const disable = vi.fn(() => ({ ok: true as const, value: {} as never }));
  const deps = {
    ...f.deps,
    autoPolicy: { disable } as unknown as HandlerDepsV2['autoPolicy'],
    undo: undo as unknown as HandlerDepsV2['undo'],
    cliStatus: { get: cliGet, invalidate: vi.fn() } as unknown as HandlerDepsV2['cliStatus'],
    cliConsole: vi.fn() as unknown as HandlerDepsV2['cliConsole'],
    agyWorkspace: {} as HandlerDepsV2['agyWorkspace'],
    voice: { state: voiceState } as unknown as HandlerDepsV2['voice'],
    mediaCache: {} as HandlerDepsV2['mediaCache'],
    jobs: {} as HandlerDepsV2['jobs'],
  } satisfies HandlerDepsV2;
  const ext: IpcHandlersExtV2 = {
    autoDialog: { confirmSetting: vi.fn(async () => false) },
    dialogParent: () => ({ id: 'win' }),
    listAgyModels: vi.fn(async () => ['gemini-3.8-pro']),
  };
  return { f, deps, ext, voiceState, cliGet };
}

describe('createIpcHandlers', () => {
  it('serves exactly IPC_CHANNELS, each with a function', () => {
    const { deps, ext } = depsV2();
    const handlers = createIpcHandlers(deps, ext);
    expect(Object.keys(handlers).sort()).toEqual([...IPC_CHANNELS].sort());
    for (const c of IPC_CHANNELS) expect(typeof handlers[c], c).toBe('function');
  });

  it('wires the v2 collaborators into the v1 handler files (dialog, voice, CLI status, agy models)', async () => {
    const { f, deps, ext, voiceState, cliGet } = depsV2();
    const h = createIpcHandlers(deps, ext);
    expect(await h['wa:setReadScope']({ scope: 'all_chats' }, CTX)).toEqual({
      ok: true,
      value: { scope: 'trigger_chat' },
    });
    expect(ext.autoDialog.confirmSetting).toHaveBeenCalledWith({ id: 'win' }, 'read_all_chats', null);
    expect(await h['settings:set']({ voice: { enabled: true } }, CTX)).toEqual({
      ok: false,
      error: { code: 'VOICE_MODEL_MISSING' },
    });
    expect(voiceState).toHaveBeenCalled();
    expect(await h['llm:setProvider']({ provider: 'claude_cli' }, CTX)).toEqual({
      ok: false,
      error: { code: 'CLI_NOT_INSTALLED' },
    });
    expect(cliGet).toHaveBeenCalledWith('claude_cli');
    const models = await h['llm:listModels']({ provider: 'antigravity_cli' }, CTX);
    expect(models.ok && models.value.models).toEqual([{ id: 'gemini-3.8-pro', displayName: 'gemini-3.8-pro' }]);
    expect(f.state.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('mergeHandlerGroups', () => {
  const all = () => Object.fromEntries(IPC_CHANNELS.map((c) => [c, () => null]));
  it('accepts a split that covers every channel once', () => {
    const [first, ...rest] = IPC_CHANNELS;
    const tail = Object.fromEntries(rest.map((c) => [c, () => null]));
    expect(Object.keys(mergeHandlerGroups([{ [first!]: () => null }, tail])).length).toBe(IPC_CHANNELS.length);
  });
  it('throws on a channel served twice', () => {
    expect(() => mergeHandlerGroups([all(), { 'health:get': () => null }])).toThrow(/served twice/);
  });
  it('throws on a missing channel and on an unknown extra one', () => {
    const missing = all();
    delete (missing as Record<string, unknown>)['voice:retry'];
    expect(() => mergeHandlerGroups([missing])).toThrow(/exactly IPC_CHANNELS/);
    const renamed = { ...missing, 'voice:rerun': () => null } as unknown as Partial<Record<string, unknown>>;
    expect(() => mergeHandlerGroups([renamed as never])).toThrow(/exactly IPC_CHANNELS/);
  });
});
