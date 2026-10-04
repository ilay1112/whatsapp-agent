// api.ts is the ONLY renderer file that touches window.api (UX 14.3). These tests pin the channel names and payload
// shapes of the wrappers the shell and the views call, and the fact that no wrapper ever sends a JID, path or URL.
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, IPC_REQUEST_SCHEMAS } from '@shared/ipc';
import { DEFAULT_AUTO_SCOPE } from '@shared/schemas';
import { api, events, initialLanguage, invoke, on, onUndoSuccess } from './api';
import { IPC_DEFAULTS, emitPush, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

describe('api.ts', () => {
  it("invokes the requested channel and returns main's Result unchanged", async () => {
    const r = await invoke('health:get');
    expect(invokeMocks['health:get']).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });

  it('every wrapper targets a real IPC channel', async () => {
    const event = { title: 'x', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' };
    await Promise.all([
      api.getBootstrap(),
      api.ackTrayHint(),
      api.getHealth(),
      api.getDashboard(),
      api.getIgnored(),
      api.getItem(1),
      api.dismiss(1),
      api.restore(1),
      api.retriage(1),
      api.setEditing(1, true),
      api.completeEvent({ itemId: 1, event }),
      api.approve({ actionId: '11111111-1111-4111-8111-111111111111', kind: 'send_reply', shownHash: 'a'.repeat(64) }),
      api.reject('11111111-1111-4111-8111-111111111111'),
      api.setPaused(true),
      api.setChatPolicy({ chatRef: 1, policy: 'never' }),
      api.listPolicies(),
      api.copyText('hello'),
      api.getOnboarding(),
      api.setOnboardingStep('choose_ai'),
      api.getConsent('cloud_claude'),
      api.acceptConsent('cloud_claude', 1),
      api.getPairing(),
      api.newPairingCode(),
      api.getHardware(),
      api.getLlmConfig(),
      api.setProvider('local'),
      api.validateKey('claude'),
      api.listModels('gemini'),
      api.setSecret({ name: 'anthropic_api_key', value: 'sk-ant-TESTONLY-key' }),
      api.hasSecret('gemini_api_key'),
      api.clearSecret('gemini_api_key'),
      api.getModelPlan(),
      api.pauseDownload('small'),
      api.resumeDownload(),
      api.cancelDownload(),
      api.deleteModel('tiny'),
      api.selfTest(),
      api.getGoogleWizard(),
      api.pickCredentialsFile(),
      api.importCredentials('{"installed":{}}'),
      api.startGoogleSignIn(),
      api.getGoogleStatus(),
      api.listCalendars(),
      api.getSettings(),
      api.setSettings({ general: { language: 'he' } }),
      api.exportDiagnostics(),
    ]);
    const used = Object.entries(invokeMocks).filter(([, m]) => m.mock.calls.length > 0);
    for (const [channel] of used) expect(IPC_CHANNELS).toContain(channel);
    expect(used.length).toBeGreaterThanOrEqual(40);
    expect(invokeMocks['item:dismiss']).toHaveBeenCalledExactlyOnceWith({ itemId: 1 });
    expect(invokeMocks['item:setEditing']).toHaveBeenCalledExactlyOnceWith({ itemId: 1, editing: true });
    expect(invokeMocks['agent:setPaused']).toHaveBeenCalledExactlyOnceWith({ paused: true });
    expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledExactlyOnceWith({ text: 'hello' });
    expect(invokeMocks['onboarding:setStep']).toHaveBeenCalledExactlyOnceWith({ step: 'choose_ai' });
  });

  it('the destructive channels always carry confirm:true', async () => {
    await api.relink();
    await api.unlinkAndWipe();
    await api.disconnectGoogle();
    await api.purgeNow();
    expect(invokeMocks['pairing:relink']).toHaveBeenCalledExactlyOnceWith({ confirm: true });
    expect(invokeMocks['pairing:unlinkAndWipe']).toHaveBeenCalledExactlyOnceWith({ confirm: true });
    expect(invokeMocks['google:disconnect']).toHaveBeenCalledExactlyOnceWith({ confirm: true });
    expect(invokeMocks['data:purgeNow']).toHaveBeenCalledExactlyOnceWith({ confirm: true });
  });

  it('model wrappers send a tier enum or nothing at all - never a URL', async () => {
    await api.startDownload();
    await api.startDownload('mid');
    expect(invokeMocks['model:startDownload'].mock.calls).toEqual([[{}], [{ tier: 'mid' }]]);
  });

  it('external:open forwards only enum targets / itemId', async () => {
    await api.openExternal({ target: 'anthropic_api_keys' });
    await api.openExternal({ itemId: 7, target: 'calendarEvent' });
    expect(invokeMocks['external:open'].mock.calls).toEqual([
      [{ target: 'anthropic_api_keys' }],
      [{ itemId: 7, target: 'calendarEvent' }],
    ]);
  });

  it('on() subscribes to push events and unsubscribes', () => {
    const seen: unknown[] = [];
    const off = on('health:changed', (h) => seen.push(h));
    emitPush('health:changed', { overall: 'ok' } as never);
    off();
    emitPush('health:changed', { overall: 'attention' } as never);
    expect(seen).toHaveLength(1);
  });

  it('exposes the language main resolved before the window existed', () => {
    expect(initialLanguage()).toEqual({ lang: 'en', dir: 'ltr' });
  });
});

// [V2] V2-W1-12: a wrapper for every new channel of C2 8, with the literal payloads main's schemas accept.
describe('api.ts - v2 wrappers (C2 8)', () => {
  const V2_CHANNELS = [
    'item:undoChange',
    'item:getImage',
    'item:restoreOriginal',
    'item:cancelEvent',
    'wa:setReadScope',
    'auto:getState',
    'auto:requestEnable',
    'auto:disable',
    'auto:pause',
    'auto:resume',
    'auto:endShadow',
    'auto:undo',
    'auto:listWrites',
    'auto:export',
    'cli:getStatus',
    'cli:signIn',
    'cli:setOverage',
    'cli:test',
    'cli:pickExe',
    'cli:previewWorkspaceChange',
    'cli:allowWorkspace',
    'voice:getState',
    'voice:selfTest',
    'voice:retry',
  ] as const;
  const AUTO_WRITE_ID = '33333333-3333-4333-8333-333333333333';

  it('every v2 channel has a wrapper that sends a schema-valid payload', async () => {
    await Promise.all([
      api.undoChange(4, 9),
      api.getImage(4),
      api.restoreOriginal(4),
      api.cancelEvent(4),
      api.setReadScope('all_chats'),
      api.getAutoState(),
      api.requestAutoEnable({ scope: DEFAULT_AUTO_SCOPE, trial: true }),
      api.disableAuto(),
      api.pauseAuto(),
      api.resumeAuto(),
      api.endAutoShadow(),
      api.undoAuto(AUTO_WRITE_ID),
      api.listAutoWrites(1_700_000_000_000.7),
      api.exportAuto(),
      api.getCliStatus('antigravity_cli'),
      api.cliSignIn('claude_cli'),
      api.setCliOverage(false),
      api.testCli('claude_cli'),
      api.pickCliExe(),
      api.previewAgyWorkspace(),
      api.allowAgyWorkspace(),
      api.getVoiceState(),
      api.voiceSelfTest(),
      api.retryVoice(4),
    ]);
    for (const channel of V2_CHANNELS) {
      expect(invokeMocks[channel], channel).toHaveBeenCalledOnce();
      const req = invokeMocks[channel].mock.calls[0]![0];
      expect(IPC_REQUEST_SCHEMAS[channel].safeParse(req).success, channel).toBe(true);
    }
    expect(invokeMocks['item:undoChange']).toHaveBeenCalledWith({ itemId: 4, revisionId: 9 });
    expect(invokeMocks['auto:disable']).toHaveBeenCalledWith({ reason: 'user' });
    expect(invokeMocks['auto:pause']).toHaveBeenCalledWith({ reason: 'user' });
    expect(invokeMocks['auto:resume']).toHaveBeenCalledWith({ confirm: true });
    expect(invokeMocks['auto:endShadow']).toHaveBeenCalledWith({ confirm: true });
    expect(invokeMocks['auto:listWrites']).toHaveBeenCalledWith({ sinceTs: 1_700_000_000_000 });
    expect(invokeMocks['cli:pickExe']).toHaveBeenCalledWith({ provider: 'claude_cli' });
    expect(invokeMocks['cli:allowWorkspace']).toHaveBeenCalledWith({ provider: 'antigravity_cli', confirm: true });
    expect(invokeMocks['wa:setReadScope']).toHaveBeenCalledWith({ scope: 'all_chats' });
    expect(invokeMocks['cli:setOverage']).toHaveBeenCalledWith({ allow: false });
  });

  it('no v2 wrapper writes through settings:set (F11, B7)', async () => {
    await Promise.all([
      api.setReadScope('trigger_chat'),
      api.setCliOverage(true),
      api.requestAutoEnable({ scope: DEFAULT_AUTO_SCOPE, trial: false }),
      api.pauseAuto(),
      api.disableAuto(),
    ]);
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });

  it('listModels accepts the CLI providers', async () => {
    await api.listModels('antigravity_cli');
    expect(invokeMocks['llm:listModels']).toHaveBeenCalledWith({ provider: 'antigravity_cli' });
  });

  it('onUndoSuccess observes both undo doors, only on outcome done, and unsubscribes', async () => {
    const seen: string[] = [];
    const off = onUndoSuccess(({ door }) => seen.push(door));
    await api.undoChange(1, 2);
    await api.undoAuto(AUTO_WRITE_ID);
    mockInvoke('item:undoChange', () => ({ ok: false, error: { code: 'ACTION_STALE' } }));
    await api.undoChange(1, 2);
    off();
    await api.undoAuto(AUTO_WRITE_ID);
    expect(seen).toEqual(['item', 'auto']);
  });

  it('events.* subscribe to the four v2 push events', () => {
    const seen: string[] = [];
    const offs = [
      events.onAutoChanged(() => seen.push('auto')),
      events.onCliChanged(() => seen.push('cli')),
      events.onQueueChanged(() => seen.push('queue')),
      events.onVoiceProgress(() => seen.push('voice')),
    ];
    emitPush('auto:changed', IPC_DEFAULTS['auto:getState']);
    emitPush('cli:changed', IPC_DEFAULTS['cli:getStatus']);
    emitPush('queue:changed', { pending: 1, running: 1, transcribing: { seconds: 42 } });
    emitPush('voice:progress', { itemId: 1, phase: 'decode', audioSeconds: 3 });
    for (const off of offs) off();
    emitPush('auto:changed', IPC_DEFAULTS['auto:getState']);
    expect(seen).toEqual(['auto', 'cli', 'queue', 'voice']);
  });
});
