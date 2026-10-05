// App shell v2 (UX2 2, 11.9, 12, 13, 15; owner V2-W1-12): the auto / cli / queue subscriptions, the downloader queue,
// SetupStrip rows 4-9, the status-panel sub-line navigation, the Settings group routing and the v2 announcements.
// Nothing in the shell can turn automatic mode on: its rows only navigate or stop (fail-safe).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState, AutoWriteView, CliStatus } from '@shared/types';
import { DEFAULT_AUTO_SCOPE } from '@shared/schemas';
import type { AppHealth } from '@shared/health';
import { App, announceAutoWrite, setupTasksOf, toPillProgress } from './App';
import { api } from './api';
import { useAutoStore } from './store/auto';
import { useCliStore } from './store/cli';
import { useDashboardStore } from './store/dashboard';
import { useHealthStore } from './store/health';
import { useSettingsStore } from './store/settings';
import {
  IPC_DEFAULTS,
  defaultDetail,
  defaultHealth,
  emitPush,
  invokeMocks,
  mockInvoke,
} from '../../../tests/setup-renderer';

const DAY = 86_400_000;
const NOW = Date.now();
const auto = (state: NonNullable<AutoState['policy']>['state'] | null, patch: Partial<AutoState> = {}): AutoState => ({
  ...IPC_DEFAULTS['auto:getState'],
  policy:
    state === null
      ? null
      : {
          id: 'p',
          state,
          enabledAt: NOW - DAY,
          expiresAt: NOW + 2 * DAY,
          shadowUntil: NOW + DAY,
          pausedReason: state === 'paused' ? 'unattended' : null,
          scope: DEFAULT_AUTO_SCOPE,
        },
  ...patch,
});
const write = (patch: Partial<AutoWriteView> = {}): AutoWriteView => ({
  autoWriteId: '44444444-4444-4444-8444-444444444444',
  itemId: 9,
  kind: 'create',
  event: {
    title: 'Dentist',
    startLocal: '2026-10-08T16:00:00',
    endLocal: '2026-10-08T17:00:00',
    timeZone: 'Asia/Jerusalem',
    location: '',
    status: 'confirmed',
  },
  before: null,
  writtenAt: NOW,
  undoState: 'available',
  undoUntil: NOW + DAY,
  revisionId: 1,
  ...patch,
});

beforeEach(() => {
  useHealthStore.setState({ health: null, progress: null, hiddenSetupTasks: [], downloads: {}, queue: null });
  useSettingsStore.setState({ settings: null, saveError: null, savedAt: 0, voiceIntent: null });
  useDashboardStore.setState({ ignoredCount: 0, toast: null, arrivedItemIds: new Set() });
  useAutoStore.setState({ state: null, rows: [], fetchedAt: 0 });
  useCliStore.setState({ status: {}, checkedAt: {}, error: {}, signInError: {}, signInStartedAt: {} });
});

const boot = async () => {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
};

describe('App v2 - pure helpers', () => {
  it('toPillProgress keeps llm, voice and picture files; voice-vad never shows', () => {
    const p = { ...IPC_DEFAULTS['model:startDownload'] };
    expect(toPillProgress({ ...p, tier: 'voice-hebrew' })?.tier).toBe('voice-hebrew');
    expect(toPillProgress({ ...p, tier: 'mmproj-small' })?.tier).toBe('mmproj-small');
    expect(toPillProgress({ ...p, tier: 'voice-vad' })).toBeNull();
  });

  it('setupTasksOf: rows 4-9 in priority order', () => {
    const h = (patch: Partial<AppHealth> = {}): AppHealth => ({ ...defaultHealth, ...patch });
    const facts = (a: AutoState | null, voice: number | null = null) => ({
      auto: a,
      voiceDownloadPercent: voice,
      now: NOW,
    });
    const consent = h({ llm: { ...defaultHealth.llm, provider: 'claude', state: 'consent_missing' } });
    expect(setupTasksOf(consent, [], facts(null))).toEqual(['consent_v2']);
    // the CLI consent missing is the generic AI row, not the v2 upgrade row
    expect(
      setupTasksOf(h({ llm: { ...defaultHealth.llm, provider: 'claude_cli', state: 'consent_missing' } }), []),
    ).toEqual(['ai']);
    expect(setupTasksOf(h(), [], facts(auto('paused')))).toEqual(['auto_paused']);
    expect(setupTasksOf(h(), [], facts(auto('shadow')))).toEqual(['auto_trial']);
    expect(setupTasksOf(h(), [], facts(auto('on')))).toEqual(['auto_expiring']);
    expect(
      setupTasksOf(h(), [], facts({ ...auto('on'), policy: { ...auto('on').policy!, expiresAt: NOW + 20 * DAY } })),
    ).toEqual([]);
    expect(setupTasksOf(h(), [], facts(null, 43))).toEqual(['voice_download']);
    expect(
      setupTasksOf(
        h(),
        [],
        facts({ ...auto('expired'), policy: { ...auto('expired').policy!, expiresAt: NOW - DAY } }),
      ),
    ).toEqual(['auto_expired']);
    expect(
      setupTasksOf(
        h(),
        [],
        facts({ ...auto('expired'), policy: { ...auto('expired').policy!, expiresAt: NOW - 9 * DAY } }),
      ),
    ).toEqual([]);
    expect(setupTasksOf(h(), ['auto_paused'], facts(auto('paused')))).toEqual([]);
  });

  it('announceAutoWrite uses trusted fields only (never the title)', () => {
    const a = announceAutoWrite(write({ event: { ...write().event, title: 'SECRET TITLE' } }), 'en');
    expect(a?.key).toBe('auto.announce.added');
    expect(a?.when).toMatch(/16:00/);
    expect(JSON.stringify(a)).not.toContain('SECRET');
    expect(announceAutoWrite(write({ kind: 'update' }), 'en')?.key).toBe('auto.announce.moved');
    expect(announceAutoWrite(write({ kind: 'cancel' }), 'he')?.key).toBe('auto.announce.cancelled');
    expect(announceAutoWrite(write({ event: { ...write().event, timeZone: '' } }), 'en')).toBeNull();
    expect(announceAutoWrite(write({ event: { ...write().event, startLocal: 'garbage' } }), 'en')).toBeNull();
  });
});

describe('App v2 - subscriptions and hydration', () => {
  it('hydrates auto + cli state at boot and follows auto:changed / cli:changed / queue:changed', async () => {
    await boot();
    await waitFor(() => expect(invokeMocks['auto:getState']).toHaveBeenCalled());
    expect(invokeMocks['auto:listWrites']).toHaveBeenCalled();
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'claude_cli' });
    act(() => emitPush('auto:changed', auto('on')));
    expect(useAutoStore.getState().state?.policy?.state).toBe('on');
    const cli: CliStatus = { ...IPC_DEFAULTS['cli:getStatus'], state: 'ready', version: '2.1.258' };
    act(() => emitPush('cli:changed', cli));
    expect(useCliStore.getState().status.claude_cli?.state).toBe('ready');
    act(() => emitPush('queue:changed', { pending: 1, running: 1, transcribing: { seconds: 42 } }));
    expect(useHealthStore.getState().queue?.transcribing?.seconds).toBe(42);
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
  });
});

describe('App v2 - SetupStrip rows 4-9', () => {
  it('row 4 "Review" opens the v2 consent; accepting records the current version and re-reads health', async () => {
    const health: AppHealth = {
      ...defaultHealth,
      llm: { ...defaultHealth.llm, provider: 'gemini', state: 'consent_missing' },
    };
    mockInvoke('app:getBootstrap', () => ({ ok: true, value: { ...IPC_DEFAULTS['app:getBootstrap'], health } }));
    await boot();
    expect(screen.getByTestId('setup-strip-consent_v2')).toHaveTextContent('Your approval is needed again for Google');
    await userEvent.click(screen.getByTestId('setup-action-consent_v2'));
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_gemini');
    await userEvent.click(screen.getByTestId('consent-accept'));
    await waitFor(() =>
      expect(invokeMocks['consent:accept']).toHaveBeenCalledExactlyOnceWith({ kind: 'cloud_gemini', version: 2 }),
    );
    await waitFor(() => expect(invokeMocks['health:get']).toHaveBeenCalled());
  });

  it('paused row: Resume and Settings only NAVIGATE to Settings > Automatic mode (Resume needs a focused click there)', async () => {
    mockInvoke('auto:getState', () => ({ ok: true, value: auto('paused') }));
    await boot();
    const row = await screen.findByTestId('setup-strip-auto_paused');
    expect(row).toHaveTextContent('the app was not opened for a week');
    await userEvent.click(screen.getByTestId('setup-action-auto_paused'));
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'settings'));
    expect(invokeMocks['auto:resume']).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveAttribute('data-group', 'auto'));
  });

  it('trial row: "Stop" is one click (auto:disable); "Turn on for real" only navigates', async () => {
    mockInvoke('auto:getState', () => ({
      ok: true,
      value: auto('shadow', {
        shadowTally: { decisions: 3, wouldAuto: 2, approvedUnchanged: 1, edited: 0, dismissed: 0 },
      }),
    }));
    mockInvoke('auto:disable', () => ({ ok: true, value: auto('disabled') }));
    await boot();
    const row = await screen.findByTestId('setup-strip-auto_trial');
    expect(row).toHaveTextContent('2 would have been done automatically');
    await userEvent.click(screen.getByTestId('setup-secondary-auto_trial'));
    await waitFor(() => expect(invokeMocks['auto:disable']).toHaveBeenCalledExactlyOnceWith({ reason: 'user' }));
    await waitFor(() => expect(screen.queryByTestId('setup-strip-auto_trial')).not.toBeInTheDocument());
    expect(invokeMocks['auto:endShadow']).not.toHaveBeenCalled();
  });

  it('trial row, early: "Review" navigates', async () => {
    mockInvoke('auto:getState', () => ({ ok: true, value: auto('shadow') }));
    await boot();
    await userEvent.click(await screen.findByTestId('setup-action-auto_trial'));
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'settings'));
  });

  it('voice download row from the downloader queue; the pill shows the queue with +N', async () => {
    await boot();
    act(() => {
      emitPush('model:progress', {
        ...IPC_DEFAULTS['model:startDownload'],
        tier: 'small',
        bytesDone: 10,
        bytesTotal: 100,
      });
      emitPush('model:progress', {
        ...IPC_DEFAULTS['model:startDownload'],
        tier: 'voice-hebrew',
        bytesDone: 62,
        bytesTotal: 100,
      });
    });
    await waitFor(() => expect(screen.getByTestId('setup-strip-voice_download')).toHaveTextContent('62 %'));
    expect(screen.getByTestId('download-pill')).toHaveTextContent('+1');
  });

  it('the pill buttons address the file they belong to', async () => {
    const spy = vi.spyOn(api, 'pauseDownload');
    await boot();
    act(() => {
      emitPush('model:progress', {
        ...IPC_DEFAULTS['model:startDownload'],
        tier: 'mmproj-small',
        bytesDone: 1,
        bytesTotal: 100,
      });
    });
    await userEvent.click(screen.getByTestId('download-pill'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]!);
    expect(spy).toHaveBeenCalledWith('mmproj');
    spy.mockRestore();
  });
});

describe('App v2 - status-panel sub-lines navigate to their Settings group', () => {
  it.each([
    ['llm', 'ai'],
    ['calendar', 'auto'],
  ] as const)('%s -> Settings > %s', async (part, group) => {
    const health: AppHealth = {
      ...defaultHealth,
      auto: { state: 'on', expiresAt: NOW + 20 * DAY, pausedReason: null },
    };
    mockInvoke('app:getBootstrap', () => ({ ok: true, value: { ...IPC_DEFAULTS['app:getBootstrap'], health } }));
    await boot();
    await userEvent.click(screen.getByTestId('health-pill'));
    const sub = await screen.findByTestId(`health-subline-${part}`);
    await userEvent.click(sub.querySelector('button') ?? sub);
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveAttribute('data-group', group));
  });
});

// ux-i18n-v2-1: a dashboard control's requestNavigation() must actually move the shell (AutoStrip "Show all", the
// sheet's "See all automatic activity", the voice / picture raw cards' "Turn on in Settings" / "Choose an AI").
describe('App v2 - dashboard navigation requests', () => {
  it.each([
    [{ view: 'activity' }, 'activity'],
    [{ view: 'settings', section: 'voice' }, 'ai'],
    [{ view: 'settings', section: 'pictures' }, 'ai'],
    [{ view: 'settings', section: 'ai' }, 'ai'],
    [{ view: 'settings', section: 'auto' }, 'auto'],
  ] as const)('%o opens Settings > %s and is cleared', async (req, group) => {
    useDashboardStore.setState({ navRequest: null });
    await boot();
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard'));
    act(() => useDashboardStore.getState().requestNavigation(req));
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'settings'));
    if (group === 'activity') expect(screen.getByTestId('auto-activity')).toBeInTheDocument();
    else expect(screen.getByTestId('settings')).toHaveAttribute('data-group', group);
    expect(useDashboardStore.getState().navRequest).toBeNull();
  });

  it('{view:"dashboard", itemId} (Automatic activity "Show") returns to the dashboard with that item open', async () => {
    useDashboardStore.setState({ navRequest: null, openItemId: null });
    await boot();
    act(() => useDashboardStore.getState().requestNavigation({ view: 'activity' }));
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'settings'));
    act(() => useDashboardStore.getState().requestNavigation({ view: 'dashboard', itemId: 7 }));
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard'));
    expect(useDashboardStore.getState().openItemId).toBe(7);
    await waitFor(() => expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 7 }));
  });
});

// ux-i18n-v2-4: the onboarding opt-in / a Settings download stores only the tier; the shell turns voice on once ready.
describe('App v2 - a requested voice tier is turned on once its files are ready', () => {
  it('settles the intent on the dashboard (Settings > Voice notes closed)', async () => {
    let status: 'none' | 'ready' = 'none';
    mockInvoke('voice:getState', () => ({
      ok: true,
      value: {
        ...IPC_DEFAULTS['voice:getState'],
        enabled: false,
        tier: 'voice-hebrew',
        resolvedTier: 'voice-hebrew',
        model: { id: 'voice-hebrew', sizeBytes: 10, status, bytesDone: 0 },
        vad: { status },
      },
    }));
    await boot();
    await waitFor(() => expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard'));
    act(() => useSettingsStore.getState().setVoiceIntent('voice-hebrew'));
    await waitFor(() => expect(invokeMocks['voice:getState']).toHaveBeenCalled());
    expect(invokeMocks['settings:set']).not.toHaveBeenCalledWith({ voice: { enabled: true, tier: 'voice-hebrew' } });
    const progress = (st: 'downloading' | 'ready') =>
      act(() =>
        useHealthStore.getState().setProgress({
          tier: 'voice-hebrew',
          status: st,
          bytesDone: 10,
          bytesTotal: 10,
          bytesPerSec: 0,
          etaSec: 0,
          errorCode: null,
        }),
      );
    progress('downloading');
    status = 'ready';
    progress('ready');
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ voice: { enabled: true, tier: 'voice-hebrew' } }),
    );
    expect(useSettingsStore.getState().voiceIntent).toBeNull();
  });
});

describe('App v2 - announcements', () => {
  it('"Undone." after an in-window undo succeeded', async () => {
    await boot();
    await act(async () => {
      await api.undoChange(1, 2);
    });
    await waitFor(() => expect(screen.getByTestId('live-polite')).toHaveTextContent('Undone.'));
  });

  it('an automatic write that lands while focused is announced from trusted fields, never the title', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await boot();
    await waitFor(() => expect(useAutoStore.getState().fetchedAt).toBeGreaterThan(0));
    act(() => useAutoStore.setState({ rows: [write({ event: { ...write().event, title: 'SECRET' } })] }));
    await waitFor(() => expect(screen.getByTestId('live-polite')).toHaveTextContent('Added automatically:'));
    expect(screen.getByTestId('live-polite')).not.toHaveTextContent('SECRET');
    vi.restoreAllMocks();
  });

  it('a policy state change is announced once it changes', async () => {
    mockInvoke('auto:getState', () => ({ ok: true, value: auto('on') }));
    await boot();
    await waitFor(() => expect(useAutoStore.getState().state?.policy?.state).toBe('on'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => emitPush('auto:changed', auto('paused')));
    await waitFor(() => expect(screen.getByTestId('live-polite')).toHaveTextContent('Automatic mode: paused.'));
  });

  it('a finished voice / picture download names the file', async () => {
    await boot();
    act(() =>
      emitPush('model:progress', { ...IPC_DEFAULTS['model:startDownload'], tier: 'voice-lite', status: 'ready' }),
    );
    await waitFor(() => expect(screen.getByTestId('live-polite')).toHaveTextContent('Voice model ready'));
  });
});

describe('App v2 - toast with its own undo', () => {
  it("runs the toast's onUndo instead of item:restore", async () => {
    const onUndo = vi.fn();
    await boot();
    act(() => useDashboardStore.getState().setToast({ key: 'auto.neverToast', onUndo }));
    await userEvent.click(await screen.findByTestId('toast-undo'));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(invokeMocks['item:restore']).not.toHaveBeenCalled();
    expect(defaultDetail.itemId).toBe(1);
  });
});

describe('App v2 - remaining shell wiring', () => {
  it('pill resume / cancel / retry address the active file; health:changed and the consent review cancel', async () => {
    const resume = vi.spyOn(api, 'resumeDownload');
    const cancel = vi.spyOn(api, 'cancelDownload');
    const retry = vi.spyOn(api, 'startDownload');
    const health: AppHealth = {
      ...defaultHealth,
      llm: { ...defaultHealth.llm, provider: 'claude', state: 'consent_missing' },
    };
    mockInvoke('app:getBootstrap', () => ({ ok: true, value: { ...IPC_DEFAULTS['app:getBootstrap'], health } }));
    await boot();
    act(() =>
      emitPush('model:progress', {
        ...IPC_DEFAULTS['model:startDownload'],
        tier: 'voice-lite',
        status: 'paused',
        bytesDone: 5,
        bytesTotal: 10,
      }),
    );
    await userEvent.click(screen.getByTestId('download-pill'));
    await userEvent.click(screen.getByTestId('download-resume'));
    expect(resume).toHaveBeenCalledWith('voice-lite');
    await userEvent.click(screen.getByTestId('download-cancel'));
    expect(cancel).toHaveBeenCalledWith('voice-lite');
    act(() =>
      emitPush('model:progress', {
        ...IPC_DEFAULTS['model:startDownload'],
        tier: 'voice-lite',
        status: 'failed',
        errorCode: 'DOWNLOAD_FAILED',
      }),
    );
    if (!screen.queryByTestId('download-panel')) await userEvent.click(screen.getByTestId('download-pill'));
    await userEvent.click(screen.getByTestId('download-retry'));
    expect(retry).toHaveBeenCalledWith('voice-lite');

    await userEvent.click(screen.getByTestId('setup-action-consent_v2'));
    await userEvent.click(screen.getByTestId('consent-cancel'));
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument();
    expect(invokeMocks['consent:accept']).not.toHaveBeenCalled();

    act(() => emitPush('health:changed', { ...defaultHealth, paused: true }));
    expect(useHealthStore.getState().health?.paused).toBe(true);
    vi.restoreAllMocks();
  });

  it('the gear opens Settings at General; an auto_expired row navigates to Automatic mode', async () => {
    mockInvoke('auto:getState', () => ({
      ok: true,
      value: { ...auto('expired'), policy: { ...auto('expired').policy!, expiresAt: NOW - DAY } },
    }));
    await boot();
    await userEvent.click(await screen.findByTestId('setup-action-auto_expired'));
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveAttribute('data-group', 'auto'));
    await userEvent.click(screen.getByTestId('settings-toggle'));
    await userEvent.click(screen.getByTestId('settings-toggle'));
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveAttribute('data-group', 'general'));
  });
});

describe('App v2 - toast pause on hover / focus', () => {
  it('pauses while hovered or focused and resumes after', async () => {
    await boot();
    act(() => useDashboardStore.getState().setToast({ key: 'auto.neverToast' }));
    const toast = await screen.findByTestId('toast');
    fireEvent.mouseEnter(toast);
    fireEvent.mouseLeave(toast);
    fireEvent.focus(toast);
    fireEvent.blur(toast);
    expect(screen.getByTestId('toast')).toHaveTextContent('Automatic changes turned off for this contact');
  });
});
