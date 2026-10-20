// [v5] T-909 W3: the update banner (spec v5-updates-handover 2.3; review focus 3 + 4).
// available -> "Version X is ready" + Update + X (= update:ignore {version}, persisted in main);
// downloading -> progress; ready -> "Restart to finish updating" + Restart now (disabled with the devOnly line when this copy
// cannot install); the X during downloading / ready hides the banner for this run only (no IPC).
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateState } from '@shared/types';
import { DEFAULT_UPDATE_STATE, i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useUpdateStore } from '../store/update';
import { useFocusGuardStore } from '../store/health';
import { UpdateBanner } from './UpdateBanner';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({ ...DEFAULT_UPDATE_STATE, ...over });
const available = st({ status: 'available', latest: '0.1.9', canInstall: true });
const setState = (state: UpdateState | null) =>
  useUpdateStore.setState({ state, bannerHidden: false, busy: null, actionError: null });

beforeEach(() => {
  setState(null);
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});

describe('UpdateBanner', () => {
  it('renders nothing without a newer release, for errors and for an ignored version', () => {
    const { container, rerender } = render(<UpdateBanner />);
    expect(container).toBeEmptyDOMElement();
    act(() => setState(st({ status: 'error', latest: '0.1.9', errorCode: 'UPDATE_CHECK_FAILED' })));
    rerender(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    act(() => setState({ ...available, ignoredVersion: '0.1.9' }));
    rerender(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  });

  it('available: the sentence names the version; Update starts the download', async () => {
    setState(available);
    mockInvoke('update:download', () => ({ ok: true, value: { ...available, status: 'downloading' } }));
    render(<UpdateBanner />);
    const banner = screen.getByTestId('update-banner');
    expect(banner).toHaveAttribute('data-state', 'available');
    expect(banner).toHaveTextContent('Version 0.1.9 is ready');
    await userEvent.click(screen.getByTestId('update-banner-install'));
    expect(invokeMocks['update:download']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['update:install']).not.toHaveBeenCalled();
  });

  it('available in a dev / unpackaged copy: Update is disabled with the devOnly line; nothing is sent', async () => {
    setState({ ...available, canInstall: false });
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Version 0.1.9 is ready');
    expect(screen.getByTestId('update-banner-install')).toBeDisabled();
    expect(screen.getByTestId('update-banner-devonly')).toHaveTextContent('Updates install only from a packaged copy.');
    await userEvent.click(screen.getByTestId('update-banner-install'));
    expect(invokeMocks['update:download']).not.toHaveBeenCalled();
    expect(screen.getByTestId('update-banner-ignore')).toBeEnabled(); // ignoring still works
  });

  it('available: the X is "Ignore this version" and sends update:ignore {version}; the banner goes', async () => {
    setState(available);
    mockInvoke('update:ignore', () => ({ ok: true, value: { ...available, ignoredVersion: '0.1.9' } }));
    render(<UpdateBanner />);
    const x = screen.getByTestId('update-banner-ignore');
    expect(x).toHaveAccessibleName('Ignore this version');
    await userEvent.click(x);
    expect(invokeMocks['update:ignore']).toHaveBeenCalledWith({ version: '0.1.9' });
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
  });

  it('ignored 0.1.9, then 0.1.10 appears -> the banner is back (review focus 3)', () => {
    setState({ ...available, latest: '0.1.10', ignoredVersion: '0.1.9' });
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Version 0.1.10 is ready');
  });

  it('downloading: a progressbar with the percent; the X hides for this run without any IPC', async () => {
    setState(st({ status: 'downloading', latest: '0.1.9', progress: { bytesDone: 30, bytesTotal: 120 } }));
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Downloading update… 25%');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.queryByTestId('update-banner-ignore')).not.toBeInTheDocument();
    const hide = screen.getByTestId('update-banner-hide');
    expect(hide).toHaveAccessibleName('Hide until the app restarts');
    await userEvent.click(hide);
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    expect(invokeMocks['update:ignore']).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().bannerHidden).toBe(true);
  });

  it('ready + canInstall: Restart now sends update:install', async () => {
    setState(st({ status: 'ready', latest: '0.1.9', canInstall: true }));
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Restart to finish updating');
    expect(screen.queryByTestId('update-banner-devonly')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('update-banner-restart'));
    expect(invokeMocks['update:install']).toHaveBeenCalledTimes(1);
  });

  it('ready in a dev / unpackaged copy: Restart is disabled with the devOnly line; nothing is sent (review focus 4)', async () => {
    setState(st({ status: 'ready', latest: '0.1.9', canInstall: false }));
    render(<UpdateBanner />);
    const restart = screen.getByTestId('update-banner-restart');
    expect(restart).toBeDisabled();
    expect(screen.getByTestId('update-banner-devonly')).toHaveTextContent('Updates install only from a packaged copy.');
    await userEvent.click(restart);
    expect(invokeMocks['update:install']).not.toHaveBeenCalled();
  });

  it('the focus-steal guard swallows a Restart click right after the window was activated', async () => {
    setState(st({ status: 'ready', latest: '0.1.9', canInstall: true }));
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    render(<UpdateBanner />);
    await userEvent.click(screen.getByTestId('update-banner-restart'));
    expect(invokeMocks['update:install']).not.toHaveBeenCalled();
  });

  it('Hebrew', async () => {
    await i18next.changeLanguage('he');
    setState(available);
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('גרסה 0.1.9 מוכנה');
    expect(screen.getByTestId('update-banner-ignore')).toHaveAccessibleName('התעלמות מגרסה זו');
  });
});
