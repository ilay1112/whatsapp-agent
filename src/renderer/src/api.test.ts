// api.ts is the ONLY renderer file that touches window.api (UX 14.3). These tests pin the channel names and payload
// shapes of the wrappers the shell and the views call, and the fact that no wrapper ever sends a JID, path or URL.
import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { api, initialLanguage, invoke, on } from './api';
import { emitPush, invokeMocks } from '../../../tests/setup-renderer';

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
