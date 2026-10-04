// store/settings.ts (UX 14.3): settings are not side effects, so the local value is optimistic and rolls back with an
// inline error when main rejects the patch.
import { beforeEach, describe, expect, it } from 'vitest';
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
