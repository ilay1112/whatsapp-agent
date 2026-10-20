// [v5] T-909 W3 (spec v5-updates-handover 2.3): the shell hosts the update banner in its NON-scrolling top block (next to
// the setup strip, outside `app-scroll`), keeps it out of onboarding, shows the running version in the footer with a
// "Restart to update" link to Settings > Updates once an update is ready, and turns `lastInstall` into ONE toast.
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateState } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { App } from './App';
import { useHealthStore } from './store/health';
import { useDashboardStore } from './store/dashboard';
import { useSettingsStore } from './store/settings';
import { useUpdateStore } from './store/update';
import { DEFAULT_UPDATE_STATE, defaultHealth, emitPush, mockInvoke } from '../../../tests/setup-renderer';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({ ...DEFAULT_UPDATE_STATE, ...over });

const boot = (onboardingStep: 'done' | 'welcome' = 'done') =>
  mockInvoke('app:getBootstrap', () => ({
    ok: true as const,
    value: {
      lang: 'en' as const,
      dir: 'ltr' as const,
      onboardingStep,
      health: { ...defaultHealth, llm: { ...defaultHealth.llm, state: 'model_missing' as const } }, // + one setup row
      settingsPublic: DEFAULT_SETTINGS,
      version: '0.1.0-test',
      trayHintSeen: true,
    },
  }));

beforeEach(() => {
  useHealthStore.setState({ health: null, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: null, saveError: null, savedAt: 0 });
  useDashboardStore.setState({ ignoredCount: 0, toast: null, arrivedItemIds: new Set() });
  useUpdateStore.setState({
    state: null,
    bannerHidden: false,
    busy: null,
    actionError: null,
    installNoticeShown: false,
  });
});

describe('[v5] App - update banner + footer', () => {
  it('the banner sits next to the setup strip, OUTSIDE the one scroller', async () => {
    boot();
    mockInvoke('update:getState', () => ({ ok: true, value: st({ status: 'available', latest: '0.1.9' }) }));
    render(<App />);
    const banner = await screen.findByTestId('update-banner');
    const scroller = screen.getByTestId('app-scroll');
    expect(scroller.contains(banner)).toBe(false);
    expect(screen.getByTestId('setup-strip-ai')).toBeInTheDocument();
    // same parent as the header / strip / scroller: the fixed column of the shell
    expect(banner.parentElement).toBe(scroller.parentElement);
    // document order: header, setup strip, banner, scroller
    const order = [screen.getByRole('banner'), screen.getByTestId('setup-strip-ai'), banner, scroller];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('a push brings the banner; not during onboarding', async () => {
    boot('welcome');
    render(<App />);
    await screen.findByTestId('onboarding');
    act(() => emitPush('update:changed', st({ status: 'available', latest: '0.1.9' })));
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  });

  it('the footer shows the running version; "Restart to update" appears when ready and opens Settings > Updates', async () => {
    boot();
    render(<App />);
    expect(await screen.findByTestId('app-version')).toHaveTextContent('0.1.0-test');
    expect(screen.queryByTestId('app-version-update')).not.toBeInTheDocument();
    act(() => emitPush('update:changed', st({ status: 'ready', latest: '0.1.9' })));
    const link = screen.getByTestId('app-version-update');
    expect(link).toHaveTextContent('Restart to update');
    await userEvent.click(link);
    expect(await screen.findByTestId('settings')).toHaveAttribute('data-group', 'updates');
    expect(screen.getByTestId('settings-group-updates')).toBeInTheDocument();
  });

  it('lastInstall installed -> one toast "Updated to version X"; a later push does not repeat it', async () => {
    boot();
    const installed = st({ current: '0.1.9', lastInstall: { outcome: 'installed', from: '0.1.8', to: '0.1.9' } });
    mockInvoke('update:getState', () => ({ ok: true, value: installed }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('Updated to version 0.1.9'));
    act(() => useDashboardStore.getState().setToast(null));
    act(() => emitPush('update:changed', { ...installed, status: 'checking' }));
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('lastInstall failed -> the "could not be installed" toast', async () => {
    boot();
    mockInvoke('update:getState', () => ({
      ok: true,
      value: st({ lastInstall: { outcome: 'failed', from: null, to: '0.1.9' } }),
    }));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveTextContent(
        'The update could not be installed; the previous version is running',
      ),
    );
  });
});
