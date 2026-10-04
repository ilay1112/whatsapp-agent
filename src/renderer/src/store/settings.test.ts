// store/settings.ts (UX 14.3): settings are not side effects, so the local value is optimistic and rolls back with an
// inline error when main rejects the patch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { calendarNameOf, useSettingsStore } from './settings';
import { invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

beforeEach(() => {
  useSettingsStore.setState({ settings: null, saveError: null, savedAt: 0 });
});

describe('useSettingsStore', () => {
  it('hydrates from the bootstrap payload', () => {
    useSettingsStore.getState().hydrate(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a patch optimistically and keeps main's answer", async () => {
    useSettingsStore.getState().hydrate(DEFAULT_SETTINGS);
    const answer = { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, language: 'he' as const } };
    mockInvoke('settings:set', () => ({ ok: true, value: answer }));
    const pending = useSettingsStore.getState().set({ general: { language: 'he' } });
    expect(useSettingsStore.getState().settings?.general.language).toBe('he'); // optimistic, before main answered
    await pending;
    expect(useSettingsStore.getState().settings).toEqual(answer);
    expect(useSettingsStore.getState().savedAt).toBeGreaterThan(0);
    expect(invokeMocks['settings:set']).toHaveBeenCalledExactlyOnceWith({ general: { language: 'he' } });
  });

  it('rolls back and records the ErrorCode when main rejects the patch', async () => {
    useSettingsStore.getState().hydrate(DEFAULT_SETTINGS);
    mockInvoke('settings:set', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await useSettingsStore.getState().set({ general: { autostart: true } });
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().saveError).toBe('BAD_REQUEST');
    expect(useSettingsStore.getState().savedAt).toBe(0);
    useSettingsStore.getState().clearSaveError();
    expect(useSettingsStore.getState().saveError).toBeNull();
  });

  it('never invents settings before the first hydrate', async () => {
    mockInvoke('settings:set', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    await useSettingsStore.getState().set({ privacy: { retentionDays: 7 } });
    expect(useSettingsStore.getState().settings).toBeNull();
    expect(useSettingsStore.getState().saveError).toBe('INTERNAL');
  });
});

// [V2] V2-W1-12: the cached calendar list (UX2 4.4 / 4.5 name the target calendar and its role).
describe('useSettingsStore - calendars', () => {
  it('loadCalendars fetches once; setCalendars / clearSaveError; calendarNameOf falls back sensibly', async () => {
    useSettingsStore.setState({ calendars: [], calendarsLoaded: false, saveError: 'BAD_REQUEST' });
    await useSettingsStore.getState().loadCalendars();
    await useSettingsStore.getState().loadCalendars();
    expect(invokeMocks['google:listCalendars']).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().calendars[0]?.name).toBe('Personal');
    useSettingsStore.getState().clearSaveError();
    expect(useSettingsStore.getState().saveError).toBeNull();
    const cals = useSettingsStore.getState().calendars;
    expect(calendarNameOf('primary', cals, 'fallback')).toBe('Personal');
    expect(calendarNameOf('primary', [], 'fallback')).toBe('fallback');
    expect(calendarNameOf('x@group', [], 'fallback')).toBe('x@group');
    // 'primary' is an alias: the calendar flagged primary answers for it even when its real id differs
    expect(calendarNameOf('primary', [{ ...cals[0]!, id: 'me@example.test' }], 'fallback')).toBe('Personal');
  });
});

// ux-i18n-v2-4 (restart): the voice tier the user asked for while its files were downloading lived in window memory
// only, so an app restart mid-download forgot the onboarding opt-in and voice notes never came on. The intent (a tier
// id and a timestamp - nothing personal) now survives a reload of the renderer.
describe('useSettingsStore - voice intent survives a restart', () => {
  const KEY = 'wca.voiceIntent';
  const readyVoice = (tier: 'voice-hebrew' | 'voice-lite') => ({
    enabled: false,
    tier,
    resolvedTier: tier,
    model: { id: tier, sizeBytes: 1, status: 'ready' as const, bytesDone: 1 },
    vad: { status: 'ready' as const },
    secPerAudioSec: null,
    suggestLite: false,
  });
  /** A "restart": a fresh renderer module graph reading the same storage. */
  const restart = async () => {
    vi.resetModules();
    return (await import('./settings')).useSettingsStore;
  };
  beforeEach(() => {
    window.localStorage.clear();
    useSettingsStore.setState({ voiceIntent: null });
  });

  it('an intent set before the restart is there after it; clearing it clears it for the next start too', async () => {
    useSettingsStore.getState().setVoiceIntent('voice-hebrew');
    expect((await restart()).getState().voiceIntent).toBe('voice-hebrew');
    useSettingsStore.getState().setVoiceIntent(null);
    expect((await restart()).getState().voiceIntent).toBeNull();
  });

  it('after the restart the intent is settled once the files are ready, and then forgotten', async () => {
    useSettingsStore.getState().setVoiceIntent('voice-lite');
    const fresh = await restart();
    fresh.getState().hydrate(DEFAULT_SETTINGS);
    await fresh.getState().settleVoiceIntent(readyVoice('voice-lite') as never);
    expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ voice: { enabled: true, tier: 'voice-lite' } });
    expect((await restart()).getState().voiceIntent).toBeNull();
  });

  it('a stale (older than 7 days), unknown or unreadable stored intent is ignored', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ tier: 'voice-hebrew', at: Date.now() - 8 * 86_400_000 }));
    expect((await restart()).getState().voiceIntent).toBeNull();
    window.localStorage.setItem(KEY, JSON.stringify({ tier: 'voice-evil', at: Date.now() }));
    expect((await restart()).getState().voiceIntent).toBeNull();
    window.localStorage.setItem(KEY, '{not json');
    expect((await restart()).getState().voiceIntent).toBeNull();
  });

  it('storage that throws never breaks the store (window memory still works)', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const fresh = await restart();
      expect(fresh.getState().voiceIntent).toBeNull();
      fresh.getState().setVoiceIntent('voice-hebrew');
      expect(fresh.getState().voiceIntent).toBe('voice-hebrew');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
