// The app shell (UX 3, 5, 10, 11.1, 12.2, 13, 14.1 + TESTS section 9 "dir switch" row).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { AppHealth } from '@shared/health';
import { App, announceNameOf, announceWhenOf, setupTasksOf, toPillProgress } from './App';
import { api } from './api';
import { FSI, PDI } from './i18n';
import { useHealthStore } from './store/health';
import { useDashboardStore } from './store/dashboard';
import { useSettingsStore } from './store/settings';
import { defaultDetail, defaultHealth, emitPush, invokeMocks, mockInvoke } from '../../../tests/setup-renderer';

const bootstrap = (patch: Record<string, unknown> = {}) => ({
  ok: true as const,
  value: {
    lang: 'en' as const,
    dir: 'ltr' as const,
    onboardingStep: 'done' as const,
    health: defaultHealth,
    settingsPublic: DEFAULT_SETTINGS,
    version: '0.1.0-test',
    trayHintSeen: true,
    ...patch,
  },
});

beforeEach(() => {
  useHealthStore.setState({ health: null, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: null, saveError: null, savedAt: 0 });
  useDashboardStore.setState({ ignoredCount: 0, toast: null, arrivedItemIds: new Set() });
});

describe('App - bootstrap and routing', () => {
  it('calls app:getBootstrap exactly once and paints the dashboard', async () => {
    render(<App />);
    expect(screen.getByTestId('app-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(invokeMocks['app:getBootstrap']).toHaveBeenCalledOnce();
    expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard');
    expect(screen.getByTestId('list-needs_reply')).toBeInTheDocument();
    await waitFor(() => expect(invokeMocks['dashboard:get']).toHaveBeenCalled());
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('starts in onboarding when the bootstrap step is not done and walks the steps', async () => {
    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ onboardingStep: 'welcome' }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('onboarding-welcome')).toBeInTheDocument());
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument(); // no footer during onboarding
    expect(screen.queryByTestId('health-pill')).not.toBeInTheDocument();
    // Step 0 is a consent gate (W1-16): "Get started" stays disabled until the ban-risk box is ticked, and it
    // records `consent:accept` before the shell is allowed to move on.
    expect(screen.getByTestId('welcome-start')).toBeDisabled();
    await userEvent.click(screen.getByTestId('welcome-accept'));
    await userEvent.click(screen.getByTestId('welcome-start'));
    await waitFor(() => expect(screen.getByTestId('onboarding-choose-ai')).toBeInTheDocument());
    expect(invokeMocks['onboarding:setStep']).toHaveBeenCalledExactlyOnceWith({ step: 'choose_ai' });
  });

  it('ui:navigate switches the view and ui:languageChanged flips <html dir> without reload', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());

    emitPush('ui:languageChanged', { lang: 'he', dir: 'rtl' });
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(document.documentElement.lang).toBe('he');
    expect(screen.getByTestId('health-pill')).toHaveTextContent('הכול פועל');

    emitPush('ui:languageChanged', { lang: 'en', dir: 'ltr' });
    await waitFor(() => expect(document.documentElement.dir).toBe('ltr'));

    emitPush('ui:navigate', { view: 'settings' });
    await waitFor(() => expect(screen.getByTestId('settings')).toBeInTheDocument());
  });

  it('the gear opens Settings and turns into "Back to dashboard"', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('settings-toggle'));
    expect(screen.getByTestId('settings')).toBeInTheDocument();
    expect(screen.getByTestId('settings-toggle')).toHaveAttribute('aria-label', 'Back to dashboard');
    await userEvent.click(screen.getByTestId('settings-toggle'));
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('shows the blocking DB_RECOVERY dialog and nothing else', async () => {
    mockInvoke('app:getBootstrap', () => ({ ok: false, error: { code: 'DB_RECOVERY' } }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('db-recovery')).toBeInTheDocument());
    expect(screen.getByTestId('db-recovery')).toHaveAttribute('role', 'alertdialog');
    expect(screen.queryByTestId('app')).not.toBeInTheDocument();
    expect(screen.getByTestId('db-recovery-restore')).toBeInTheDocument();
    expect(screen.getByTestId('db-recovery-fresh')).toBeInTheDocument();
  });

  it('keeps the loading frame with the ErrorCode title when the bootstrap fails otherwise', async () => {
    mockInvoke('app:getBootstrap', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app-loading')).toHaveTextContent('Something went wrong'));
  });

  // [repair ux-i18n-4] UX 11.4: every ErrorCode is shown as title + body + one action, and UX 11 makes DB_RECOVERY the
  // ONLY full-window blocking state. The branch used to render the title alone, with no body and no control, while the
  // bootstrap effect (deps `[announce]`, a stable useCallback) could never fire again - and the window has no menu, no
  // Ctrl+R and no DevTools when packaged, so quitting from the tray was the user's only move.
  it('a failed bootstrap shows the body and a Try again that re-runs the bootstrap', async () => {
    let attempts = 0;
    mockInvoke('app:getBootstrap', () => {
      attempts += 1;
      return attempts === 1 ? { ok: false as const, error: { code: 'INTERNAL' as const } } : bootstrap();
    });
    render(<App />);

    const frame = await screen.findByTestId('app-loading');
    expect(frame).toHaveTextContent('Something went wrong');
    expect(frame).toHaveTextContent('An unexpected error happened.');

    await userEvent.click(screen.getByTestId('boot-retry'));
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });

  // The adjacent half of the same dead end: `invoke` REJECTING (rather than answering !ok) left the app on
  // "Loading..." for ever, with no error text at all and nothing to click.
  it('a rejected bootstrap invoke lands on the same recoverable error frame', async () => {
    let attempts = 0;
    mockInvoke('app:getBootstrap', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return bootstrap();
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app-loading')).toHaveTextContent('Something went wrong'));
    await userEvent.click(screen.getByTestId('boot-retry'));
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
  });
});

describe('App - header and footer', () => {
  it('renders the landmarks, the version and one pill of each kind', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('Version 0.1.0-test');
    expect(screen.getAllByTestId('health-pill')).toHaveLength(1);
    expect(screen.queryByTestId('download-pill')).not.toBeInTheDocument();
  });

  it('the pause toggle reports aria-pressed and sends agent:setPaused once', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    const toggle = screen.getByTestId('pause-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent('Pause');
    mockInvoke('agent:setPaused', () => ({ ok: true, value: { ...defaultHealth, paused: true } }));
    await userEvent.click(toggle);
    expect(invokeMocks['agent:setPaused']).toHaveBeenCalledExactlyOnceWith({ paused: true });
    await waitFor(() => expect(screen.getByTestId('pause-toggle')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('pause-toggle')).toHaveTextContent('Resume');
  });

  it('the language toggle asks main to persist the choice', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText('עברית'));
    expect(invokeMocks['settings:set']).toHaveBeenCalledExactlyOnceWith({ general: { language: 'he' } });
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
  });

  it('offers "Undo dismiss" only when something was dismissed', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.queryByTestId('undo-dismiss')).not.toBeInTheDocument();
    useDashboardStore.setState({ ignoredCount: 3 });
    await waitFor(() => expect(screen.getByTestId('undo-dismiss')).toBeInTheDocument());
  });

  it('shows the download pill while a model is downloading', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    emitPush('model:progress', {
      tier: 'small',
      status: 'downloading',
      bytesDone: 50,
      bytesTotal: 100,
      bytesPerSec: 1,
      etaSec: 60,
      errorCode: null,
    });
    await waitFor(() => expect(screen.getByTestId('download-pill')).toBeInTheDocument());
  });
});

describe('App - health actions', () => {
  it('a WhatsApp row action opens the linking step, a calendar row action opens the Google step', async () => {
    const health: AppHealth = {
      ...defaultHealth,
      overall: 'working',
      whatsapp: { state: 'needs_pairing', since: 0 },
      calendar: { state: 'not_configured', since: 0, updatesAvailable: true },
    };
    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ health }));
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('health-pill'));
    await userEvent.click(screen.getByTestId('health-action-calendar'));
    await waitFor(() => expect(screen.getByTestId('onboarding-google')).toBeInTheDocument());
    unmount();

    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ health }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('health-pill'));
    await userEvent.click(screen.getByTestId('health-action-whatsapp'));
    await waitFor(() => expect(screen.getByTestId('onboarding-link-whatsapp')).toBeInTheDocument());
  });

  it('an "export diagnostics" ErrorCode exports instead of navigating', async () => {
    const health: AppHealth = {
      ...defaultHealth,
      overall: 'attention',
      calendar: { state: 'toolset_mismatch', since: 0, code: 'CAL_TOOLSET_MISMATCH', updatesAvailable: true },
    };
    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ health }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('health-pill'));
    await userEvent.click(screen.getByTestId('health-action-calendar'));
    expect(invokeMocks['diagnostics:export']).toHaveBeenCalledOnce();
    expect(screen.getByTestId('app')).toHaveAttribute('data-view', 'dashboard');
  });

  it('any other ErrorCode action opens Settings', async () => {
    const health: AppHealth = {
      ...defaultHealth,
      overall: 'attention',
      llm: {
        state: 'key_invalid',
        since: 0,
        provider: 'claude',
        model: 'claude-opus-5',
        code: 'KEY_INVALID',
        quota: null,
      },
    };
    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ health }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('health-pill'));
    await userEvent.click(screen.getByTestId('health-action-llm'));
    await waitFor(() => expect(screen.getByTestId('settings')).toBeInTheDocument());
  });
});

describe('App - download controls', () => {
  it('wires the pill buttons to the model:* channels', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    emitPush('model:progress', {
      tier: 'small',
      status: 'downloading',
      bytesDone: 50,
      bytesTotal: 100,
      bytesPerSec: 1,
      etaSec: 60,
      errorCode: null,
    });
    await waitFor(() => expect(screen.getByTestId('download-pill')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('download-pill'));
    await userEvent.click(screen.getByTestId('download-pause'));
    expect(invokeMocks['model:pause']).toHaveBeenCalledOnce();

    // the popover stays open while the state changes under it
    emitPush('model:progress', {
      tier: 'small',
      status: 'paused',
      bytesDone: 50,
      bytesTotal: 100,
      bytesPerSec: 0,
      etaSec: null,
      errorCode: null,
    });
    await waitFor(() => expect(screen.getByTestId('download-resume')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('download-resume'));
    expect(invokeMocks['model:resume']).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId('download-cancel'));
    expect(invokeMocks['model:cancel']).toHaveBeenCalledOnce();

    emitPush('model:progress', {
      tier: 'small',
      status: 'failed',
      bytesDone: 50,
      bytesTotal: 100,
      bytesPerSec: 0,
      etaSec: null,
      errorCode: 'DOWNLOAD_FAILED',
    });
    await waitFor(() => expect(screen.getByTestId('download-retry')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('download-retry'));
    expect(invokeMocks['model:startDownload']).toHaveBeenCalledOnce();
  });

  it('announces a finished download once', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    emitPush('model:progress', {
      tier: 'small',
      status: 'ready',
      bytesDone: 100,
      bytesTotal: 100,
      bytesPerSec: 0,
      etaSec: null,
      errorCode: null,
    });
    await waitFor(() =>
      expect(screen.getByTestId('live-polite')).toHaveTextContent('Download finished - the AI is ready.'),
    );
    expect(screen.queryByTestId('download-pill')).not.toBeInTheDocument();
  });
});

describe('App - setup strip', () => {
  it('shows a row per unfinished task and hides the calendar row on request', async () => {
    const health: AppHealth = {
      ...defaultHealth,
      overall: 'working',
      whatsapp: { state: 'needs_pairing', since: 0 },
      calendar: { state: 'not_configured', since: 0, updatesAvailable: true },
    };
    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ health }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('setup-strip-whatsapp')).toBeInTheDocument());
    expect(screen.getByTestId('setup-strip-calendar')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('setup-hide-calendar'));
    expect(screen.queryByTestId('setup-strip-calendar')).not.toBeInTheDocument();
  });

  it('a setup action opens the matching onboarding step', async () => {
    const health: AppHealth = { ...defaultHealth, overall: 'working', whatsapp: { state: 'needs_pairing', since: 0 } };
    invokeMocks['app:getBootstrap'].mockResolvedValueOnce(bootstrap({ health }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('setup-action-whatsapp')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('setup-action-whatsapp'));
    await waitFor(() => expect(screen.getByTestId('onboarding-link-whatsapp')).toBeInTheDocument());
  });
});

describe('App - coach mark, toast and live regions', () => {
  it('shows the coach mark on ui:navigate tray_hint, focuses its button and acknowledges it', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.queryByTestId('coach-mark')).not.toBeInTheDocument();
    emitPush('ui:navigate', { view: 'tray_hint' });
    await waitFor(() => expect(screen.getByTestId('coach-mark')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('coach-mark-ack')).toHaveFocus());
    await userEvent.click(screen.getByTestId('coach-mark-ack'));
    expect(invokeMocks['app:ackTrayHint']).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId('coach-mark')).not.toBeInTheDocument());
  });

  it('Escape dismisses the coach mark the same way', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    emitPush('ui:navigate', { view: 'tray_hint' });
    await waitFor(() => expect(screen.getByTestId('coach-mark')).toBeInTheDocument());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('coach-mark')).not.toBeInTheDocument());
    expect(invokeMocks['app:ackTrayHint']).toHaveBeenCalledOnce();
  });

  it('has one polite and one assertive live region and announces the health state', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    expect(screen.getByTestId('live-polite')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('live-assertive')).toHaveAttribute('aria-live', 'assertive');
    await waitFor(() => expect(screen.getByTestId('live-polite')).toHaveTextContent('All running'));
  });

  it('announces approval success in the APP-LEVEL polite region, every time (UX 13.4 row 1)', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());

    const send = {
      actionId: '11111111-1111-4111-8111-111111111111',
      kind: 'send_reply' as const,
      shownHash: 'a'.repeat(64),
    };
    await act(async () => {
      await api.approve(send);
    });
    // defaultDetail's displayName is '', so the phone text main formatted is used - inside the bdi isolate.
    await waitFor(() =>
      expect(screen.getByTestId('live-polite')).toHaveTextContent(`Sent to ${FSI}+972 55-000-0001${PDI}.`),
    );

    // A second, identical success within the 10 s window must still be announced (only "new cards" and the health
    // overall are throttled), so the node's text has to change.
    const first = screen.getByTestId('live-polite').textContent;
    await act(async () => {
      await api.approve(send);
    });
    await waitFor(() => expect(screen.getByTestId('live-polite').textContent).not.toBe(first));
    expect(screen.getByTestId('live-polite')).toHaveTextContent(`Sent to ${FSI}+972 55-000-0001${PDI}.`);
  });

  it('announces the calendar time after a create_event approval and stays silent on a failure', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    const create = {
      actionId: '22222222-2222-4222-8222-222222222222',
      kind: 'create_event' as const,
      shownHash: 'b'.repeat(64),
    };

    mockInvoke('action:approve', () => ({ ok: true, value: { outcome: 'failed', item: defaultDetail } }));
    await act(async () => {
      await api.approve(create);
    });
    expect(screen.getByTestId('live-polite')).not.toHaveTextContent('Added to calendar');

    mockInvoke('action:approve', () => ({
      ok: true,
      value: {
        outcome: 'done',
        item: {
          ...defaultDetail,
          eventState: 'created',
          calendar: { eventStartTs: Date.UTC(2026, 8, 24, 14, 0, 0), eventKey: 'k1', revision: 1, status: 'confirmed' },
        },
      },
    }));
    await act(async () => {
      await api.approve(create);
    });
    await waitFor(() => expect(screen.getByTestId('live-polite')).toHaveTextContent(/^Added to calendar: .*Thursday/));
  });

  it('renders one toast at a time with an Undo that restores the item', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());
    useDashboardStore.setState({ toast: { key: 'action.dismissed', itemId: 4 } });
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Dismissed'));
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    await userEvent.click(screen.getByTestId('toast-undo'));
    expect(invokeMocks['item:restore']).toHaveBeenCalledExactlyOnceWith({ itemId: 4 });
    await waitFor(() => expect(screen.queryByTestId('toast')).not.toBeInTheDocument());
  });
});

describe('App - pure helpers', () => {
  it('toPillProgress keeps the four pill statuses and drops the rest', () => {
    const base = { tier: 'small' as const, bytesDone: 1, bytesTotal: 2, bytesPerSec: 3, etaSec: 4, errorCode: null };
    expect(toPillProgress(null)).toBeNull();
    expect(toPillProgress({ ...base, status: 'ready' })).toBeNull();
    expect(toPillProgress({ ...base, status: 'none' })).toBeNull();
    expect(toPillProgress({ ...base, status: 'downloading' })).toMatchObject({
      status: 'downloading',
      etaSec: 4,
      errorCode: undefined,
    });
  });

  it('setupTasksOf follows the UX 5.4 conditions and respects hidden rows', () => {
    expect(setupTasksOf(null, [])).toEqual([]);
    expect(setupTasksOf(defaultHealth, [])).toEqual([]);
    const health: AppHealth = {
      ...defaultHealth,
      whatsapp: { state: 'needs_pairing', since: 0 },
      llm: { state: 'key_missing', since: 0, provider: 'claude', model: '', quota: null },
      calendar: { state: 'not_configured', since: 0, updatesAvailable: true },
    };
    expect(setupTasksOf(health, [])).toEqual(['whatsapp', 'ai', 'calendar']);
    expect(setupTasksOf(health, ['calendar'])).toEqual(['whatsapp', 'ai']);
  });

  it('announceNameOf prefers the display name and falls back to the phone text', () => {
    expect(announceNameOf({ ...defaultDetail.chat, displayName: 'Dana' })).toBe('Dana');
    expect(announceNameOf(defaultDetail.chat)).toBe('+972 55-000-0001');
    expect(announceNameOf({ ...defaultDetail.chat, displayName: '', phoneDisplay: '' })).toBe('');
  });

  it('announceWhenOf prefers the calendar start, falls back to the proposal and survives a bad zone', () => {
    const at = Date.UTC(2026, 8, 24, 14, 0, 0);
    expect(
      announceWhenOf(
        { ...defaultDetail, calendar: { eventStartTs: at, eventKey: 'k1', revision: 1, status: 'confirmed' } },
        'en',
      ),
    ).toContain('Thursday');
    // No calendar row yet: the proposal's local time in its own zone says the same thing.
    expect(announceWhenOf(defaultDetail, 'en')).toContain('Thursday');
    expect(announceWhenOf({ ...defaultDetail, event: null, calendar: null }, 'en')).toBe('');
    expect(
      announceWhenOf(
        {
          ...defaultDetail,
          calendar: { eventStartTs: at, eventKey: 'k1', revision: 1, status: 'confirmed' },
          event: { ...defaultDetail.event!, timeZone: 'Not/AZone' },
        },
        'en',
      ),
    ).not.toBe('');
  });
});

// [repair ux-i18n-9] UX 2.4: the itemIds of `dashboard:changed` drove only the throttled polite announcement and were
// then discarded, so the 3 px arrival edge (defined in styles.css, applied nowhere) could never be shown.
describe('App - arrival edge (UX 2.4)', () => {
  it('keeps the changed ids so the cards can wear the arrival edge', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());

    act(() => emitPush('dashboard:changed', { itemIds: [11, 12] }));
    await waitFor(() => expect([...useDashboardStore.getState().arrivedItemIds].sort()).toEqual([11, 12]));
  });

  it('marks nothing while the window is hidden - the edge is for a change the user could SEE', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('app')).toBeInTheDocument());

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => emitPush('dashboard:changed', { itemIds: [13] }));
    await waitFor(() => expect(invokeMocks['dashboard:get']).toHaveBeenCalled());
    expect(useDashboardStore.getState().arrivedItemIds.size).toBe(0);
    spy.mockRestore();
  });
});
