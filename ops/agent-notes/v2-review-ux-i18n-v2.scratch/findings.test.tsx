// Scratch proofs for the v2 ux-i18n adversarial review (ops/agent-notes/v2-review-ux-i18n-v2.md).
// NOT part of the product test run. Every test asserts the BEHAVIOUR THE SPEC ASKS FOR, so a red test = a confirmed finding.
// Run: npx vitest run --config "ops/agent-notes/v2-review-ux-i18n-v2.scratch/vitest.scratch.config.ts"
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState, VoiceState } from '@shared/types';
import { DEFAULT_AUTO_SCOPE } from '@shared/schemas';
import { DEFAULT_SETTINGS, applySettingsPatch, type Settings } from '@shared/settings';
import { defaultHealth, i18next, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';
import { App } from '../../../src/renderer/src/App';
import { useAutoStore } from '../../../src/renderer/src/store/auto';
import { useDashboardStore } from '../../../src/renderer/src/store/dashboard';
import { useFocusGuardStore, useHealthStore } from '../../../src/renderer/src/store/health';
import { useSettingsStore } from '../../../src/renderer/src/store/settings';
import { AutomaticMode } from '../../../src/renderer/src/views/settings/AutomaticMode';
import { VoiceNotes } from '../../../src/renderer/src/views/settings/VoiceNotes';
import { ReadTools } from '../../../src/renderer/src/views/settings/ReadTools';
import { UndoControl } from '../../../src/renderer/src/components/UndoControl';

const DAY = 86_400_000;
const NOW = Date.now();
const base: AutoState = {
  policy: null,
  preconditions: {
    calendarConnected: true,
    calendarOwned: true,
    approvedCreates: 3,
    approvedCreatesNeeded: 3,
    providerAllowsAuto: true,
    updatesAvailable: true,
  },
  shadowTally: null,
  usedToday: { writes: 0, limit: 15 },
  undoableCount: 0,
};
const policy = (
  state: NonNullable<AutoState['policy']>['state'],
  patch: Partial<NonNullable<AutoState['policy']>> = {},
): NonNullable<AutoState['policy']> => ({
  id: 'p1',
  state,
  enabledAt: NOW - DAY,
  expiresAt: NOW + 23 * DAY,
  shadowUntil: NOW - DAY,
  pausedReason: null,
  scope: DEFAULT_AUTO_SCOPE,
  ...patch,
});

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, calendars: [], calendarsLoaded: false });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useAutoStore.setState({ state: null, rows: [], fetchedAt: 0 });
  useHealthStore.setState({ downloads: {} });
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

// ---- ux-i18n-v2-1: nobody consumes `navRequest` ------------------------------------------------------------------------
describe('ux-i18n-v2-1 navRequest is never consumed by the shell', () => {
  it('AutoStrip "Show all in Automatic activity" (requestNavigation {view:"activity"}) opens the activity page', async () => {
    useDashboardStore.setState({ toast: null, arrivedItemIds: new Set(), navRequest: null });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard'));
    act(() => useDashboardStore.getState().requestNavigation({ view: 'activity' }));
    // Expected: the shell switches to Settings > Automatic activity. Actual: the request sits in the store forever.
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'settings'), { timeout: 500 });
  });

  it('a picture card "Turn on in Settings" (requestNavigation {view:"settings", section:"pictures"}) opens Settings', async () => {
    useDashboardStore.setState({ toast: null, arrivedItemIds: new Set(), navRequest: null });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard'));
    act(() => useDashboardStore.getState().requestNavigation({ view: 'settings', section: 'pictures' }));
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'settings'), { timeout: 500 });
  });
});

// ---- ux-i18n-v2-2: BAD_REQUEST conflated with the rate limit / hidden -------------------------------------------------
describe('ux-i18n-v2-2 AutomaticMode treats every BAD_REQUEST as "rate limited" or hides it', () => {
  it('with Antigravity active, main refuses requestEnable (BAD_REQUEST) - the page must not say "Try again in an hour."', async () => {
    mockInvoke('auto:requestEnable', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    const state = { ...base, preconditions: { ...base.preconditions, providerAllowsAuto: false } };
    render(<AutomaticMode state={state} />);
    await userEvent.click(screen.getByTestId('auto-enable-now'));
    await waitFor(() => expect(invokeMocks['auto:requestEnable']).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText('Try again in an hour.')).toBeNull());
  });

  it('paused because the snapshot changed: Resume answers BAD_REQUEST - the user must be told why', async () => {
    mockInvoke('auto:resume', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    render(<AutomaticMode state={{ ...base, policy: policy('paused', { pausedReason: 'snapshot_changed' }) }} />);
    await userEvent.click(screen.getByTestId('auto-resume'));
    await waitFor(() => expect(invokeMocks['auto:resume']).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull(), { timeout: 500 });
  });
});

// ---- ux-i18n-v2-3: states without an action in the Automatic mode group -------------------------------------------
describe('ux-i18n-v2-3 Automatic mode states with no action', () => {
  it('expired + calendar not connected: the page offers neither Renew nor the reason', () => {
    const state = {
      ...base,
      policy: policy('expired', { expiresAt: NOW - DAY }),
      preconditions: { ...base.preconditions, calendarConnected: false },
    };
    render(<AutomaticMode state={state} />);
    const renew = screen.queryByTestId('auto-renew');
    const why = screen.queryByTestId('auto-precondition');
    expect(renew ?? why).not.toBeNull();
  });

  it('on + ends in 2 days (SetupStrip row 7 says "Renew" and navigates here): a Renew button exists', () => {
    render(<AutomaticMode state={{ ...base, policy: policy('on', { expiresAt: NOW + 2 * DAY }) }} />);
    expect(screen.getByTestId('auto-expiring')).toBeInTheDocument();
    expect(screen.queryByTestId('auto-renew')).not.toBeNull();
  });
});

// ---- ux-i18n-v2-4: VoiceNotes shows a tier as chosen while voice stays off -------------------------------------------
describe('ux-i18n-v2-4 VoiceNotes after a requested download', () => {
  it('the checked radio and voice.enabled agree once the chosen model is ready', async () => {
    let status: 'none' | 'ready' = 'none';
    const voice = (): VoiceState => ({
      enabled: false,
      tier: 'auto',
      resolvedTier: 'voice-hebrew',
      model: { id: 'voice-hebrew', sizeBytes: 1_624_555_275, status, bytesDone: 0 },
      vad: { status },
      secPerAudioSec: null,
      suggestLite: false,
    });
    mockInvoke('voice:getState', () => ({ ok: true, value: voice() }));
    // main refuses voice.enabled=true until the model is ready (C2 4), exactly as settings.ts does
    mockInvoke('settings:set', (patch) => {
      const p = patch as Partial<Settings>;
      if (p.voice?.enabled === true && status !== 'ready')
        return { ok: false, error: { code: 'VOICE_MODEL_MISSING' } } as never;
      return { ok: true, value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, p as never) };
    });
    render(<VoiceNotes />);
    await waitFor(() => expect(invokeMocks['voice:getState']).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId('settings-voice-voice-hebrew'));
    await userEvent.click(await screen.findByTestId('settings-voice-confirm-download'));
    // the download runs and finishes (the queue entry appears, then leaves)
    act(() =>
      useHealthStore.setState({
        downloads: { 'voice-hebrew': { tier: 'voice-hebrew', status: 'downloading', bytesDone: 1, bytesTotal: 2 } as never },
      }),
    );
    status = 'ready';
    act(() => useHealthStore.setState({ downloads: {} }));
    await waitFor(() =>
      expect(screen.getByTestId('settings-voice-status-voice-hebrew')).toHaveAttribute('data-status', 'ready'),
    );
    expect(screen.getByTestId('settings-voice-voice-hebrew')).toBeChecked(); // the page says "Hebrew is on"...
    expect(useSettingsStore.getState().settings!.voice.enabled).toBe(true); // ...but voice notes are still OFF
  });
});

// ---- ux-i18n-v2-5: ReadTools "Not changed" while it did change; all-chats re-enabled without main's confirmation ------
describe('ux-i18n-v2-5 ReadTools', () => {
  const rt = (patch: Partial<Settings['whatsapp']['readTools']>): Settings => ({
    ...DEFAULT_SETTINGS,
    whatsapp: { ...DEFAULT_SETTINGS.whatsapp, readTools: { ...DEFAULT_SETTINGS.whatsapp.readTools, ...patch } },
  });

  it('Off -> "Of all my chats" without the current consent says "Not changed" - so nothing may be written', async () => {
    useSettingsStore.setState({ settings: rt({ enabled: false }) });
    useHealthStore.setState({ health: { ...defaultHealth, llm: { ...defaultHealth.llm, provider: 'claude' } } });
    mockInvoke('consent:get', () => ({
      ok: true,
      value: { kind: 'cloud_claude', currentVersion: 2, acceptedVersion: 1, acceptedAt: NOW - DAY },
    }));
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    expect(await screen.findByTestId('settings-readtools-refused')).toHaveTextContent('Not changed');
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });

  it('Off -> "Of all my chats" (stored scope all_chats) goes through wa:setReadScope (main\'s native confirmation)', async () => {
    useSettingsStore.setState({ settings: rt({ enabled: false, scope: 'all_chats' }) });
    useHealthStore.setState({ health: { ...defaultHealth, llm: { ...defaultHealth.llm, provider: 'local' } } });
    mockInvoke('wa:setReadScope', () => ({ ok: true, value: { scope: 'all_chats' } }) as never);
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    await waitFor(() => expect(invokeMocks['settings:set']).toHaveBeenCalled());
    expect(invokeMocks['wa:setReadScope']).toHaveBeenCalled();
  });
});

// ---- ux-i18n-v2-6: GuardedButton swallows main's refusal ---------------------------------------------------------------
describe('ux-i18n-v2-6 "Cancel event" after blocked_started', () => {
  it('a refused item:cancelEvent is shown to the user', async () => {
    mockInvoke('item:cancelEvent', () => ({ ok: false, error: { code: 'CAL_UNAVAILABLE' } }) as never);
    render(
      <UndoControl
        undo={{ revisionId: 2, until: NOW + DAY, state: 'blocked_started', automatic: true }}
        itemId={7}
        door="card"
        onUndo={async () => ({ ok: true, value: {} })}
      />,
    );
    await userEvent.click(screen.getByTestId('undo-cancel-event-7'));
    await waitFor(() => expect(invokeMocks['item:cancelEvent']).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull(), { timeout: 500 });
  });
});

// ---- ux-i18n-v2-7: count interpolated without plural forms --------------------------------------------------------------
describe('ux-i18n-v2-7 "ends in 1 days"', () => {
  it.each(['health.sub.auto.on', 'setup.auto.expiring'])('%s has a singular for count 1 (en and he)', (key) => {
    expect(i18next.t(key, { count: 1, lng: 'en' })).not.toMatch(/\b1 days\b/);
    expect(i18next.t(key, { count: 1, lng: 'he' })).not.toMatch(/1 ימים/);
  });
});
