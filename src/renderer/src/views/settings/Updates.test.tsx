// [v5] T-909 W3: Settings > Updates (spec v5-updates-handover 2.3; review focus 3 + 4).
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateState } from '@shared/types';
import { DEFAULT_UPDATE_STATE, i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useUpdateStore } from '../../store/update';
import { useFocusGuardStore } from '../../store/health';
import { Updates } from './Updates';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({ ...DEFAULT_UPDATE_STATE, ...over });
const available = st({ status: 'available', latest: '0.1.9', lastCheckAt: Date.now() - 5 * 60_000, canInstall: true });

/** Seeds main's answer to update:getState (the group hydrates on mount) and paints the group. */
const paint = async (state: UpdateState) => {
  mockInvoke('update:getState', () => ({ ok: true, value: state }));
  render(<Updates />);
  await waitFor(() => expect(useUpdateStore.getState().state).toEqual(state));
};

beforeEach(() => {
  useUpdateStore.setState({ state: null, bannerHidden: false, busy: null, actionError: null });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});

describe('Settings > Updates', () => {
  it('shows the current and latest versions, when it last checked and the privacy sentence', async () => {
    await paint(available);
    expect(screen.getByTestId('settings-group-updates')).toHaveTextContent('Updates');
    expect(screen.getByTestId('settings-update-current')).toHaveTextContent('0.1.0');
    const latest = screen.getByTestId('settings-update-latest');
    expect(latest).toHaveTextContent('0.1.9');
    expect(latest).toHaveTextContent(/Checked 5 min/);
    expect(screen.getByTestId('settings-update-privacy')).toHaveTextContent(
      'Checks github.com every 6 hours; sends only the app version.',
    );
  });

  it('never checked -> "Not checked yet"; up to date -> "You have the latest version"', async () => {
    await paint(st());
    expect(screen.getByTestId('settings-update-latest')).toHaveTextContent('Not checked yet');
    expect(screen.queryByTestId('settings-update-install')).not.toBeInTheDocument();
    useUpdateStore.setState({ state: st({ status: 'up_to_date', latest: '0.1.0', lastCheckAt: Date.now() }) });
    await waitFor(() => expect(screen.getByTestId('settings-update-uptodate')).toBeInTheDocument());
    expect(screen.getByTestId('settings-update-uptodate')).toHaveTextContent('You have the latest version');
  });

  it('Check now sends update:check and applies the answer', async () => {
    await paint(st());
    mockInvoke('update:check', () => ({ ok: true, value: available }));
    await userEvent.click(screen.getByTestId('settings-update-check'));
    expect(invokeMocks['update:check']).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId('settings-update-install')).toHaveTextContent('Download and install'),
    );
  });

  it('available in a dev copy -> "Download and install" disabled with the devOnly line; nothing sent', async () => {
    await paint({ ...available, canInstall: false });
    expect(screen.getByTestId('settings-update-install')).toHaveTextContent('Download and install');
    expect(screen.getByTestId('settings-update-install')).toBeDisabled();
    expect(screen.getByTestId('settings-update-devonly')).toHaveTextContent(
      'Updates install only from a packaged copy.',
    );
    await userEvent.click(screen.getByTestId('settings-update-install'));
    expect(invokeMocks['update:download']).not.toHaveBeenCalled();
  });

  it('available -> "Download and install" sends update:download', async () => {
    await paint(available);
    await userEvent.click(screen.getByTestId('settings-update-install'));
    expect(invokeMocks['update:download']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['update:install']).not.toHaveBeenCalled();
  });

  it('downloading -> the button is busy with the percent; Check now is disabled', async () => {
    await paint(st({ status: 'downloading', latest: '0.1.9', progress: { bytesDone: 1, bytesTotal: 2 } }));
    expect(screen.getByTestId('settings-update-install')).toBeDisabled();
    expect(screen.getByTestId('settings-update-install')).toHaveTextContent('50%');
    expect(screen.getByTestId('settings-update-check')).toBeDisabled();
  });

  it('ready + canInstall -> "Restart to finish" sends update:install', async () => {
    await paint(st({ status: 'ready', latest: '0.1.9', canInstall: true }));
    expect(screen.queryByTestId('settings-update-devonly')).not.toBeInTheDocument();
    const install = screen.getByTestId('settings-update-install');
    expect(install).toHaveTextContent('Restart to finish');
    await userEvent.click(install);
    expect(invokeMocks['update:install']).toHaveBeenCalledTimes(1);
  });

  it('ready in a dev copy -> Install disabled + the devOnly line; nothing sent (review focus 4)', async () => {
    await paint(st({ status: 'ready', latest: '0.1.9', canInstall: false }));
    const install = screen.getByTestId('settings-update-install');
    expect(install).toBeDisabled();
    expect(screen.getByTestId('settings-update-devonly')).toHaveTextContent(
      'Updates install only from a packaged copy.',
    );
    await userEvent.click(install);
    expect(invokeMocks['update:install']).not.toHaveBeenCalled();
  });

  it('an ignored version offers "Show version X again" -> update:unignore (review focus 3)', async () => {
    await paint({ ...available, ignoredVersion: '0.1.9' });
    mockInvoke('update:unignore', () => ({ ok: true, value: available }));
    const unignore = screen.getByTestId('settings-update-unignore');
    expect(unignore).toHaveTextContent('Show version 0.1.9 again');
    await userEvent.click(unignore);
    expect(invokeMocks['update:unignore']).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('settings-update-unignore')).not.toBeInTheDocument());
  });

  it.each([
    ['UPDATE_CHECK_FAILED', 'Could not check for updates'],
    ['UPDATE_VERIFY_FAILED', 'The downloaded update did not verify'],
    ['DOWNLOAD_FAILED', 'The update download stopped. Try again.'],
    ['DISK_FULL', 'Not enough disk space for the update.'],
  ] as const)('status error %s -> an error line in Settings', async (errorCode, text) => {
    await paint(st({ status: 'error', latest: '0.1.9', errorCode }));
    expect(screen.getByTestId('settings-update-error')).toHaveTextContent(text);
  });

  it('a refused action shows a short line (no raw code)', async () => {
    await paint(available);
    mockInvoke('update:download', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await userEvent.click(screen.getByTestId('settings-update-install'));
    await waitFor(() => expect(screen.getByTestId('settings-update-action-error')).toBeInTheDocument());
    expect(screen.getByTestId('settings-update-action-error')).not.toHaveTextContent('BAD_REQUEST');
  });

  it('Hebrew', async () => {
    await i18next.changeLanguage('he');
    await paint({ ...available, ignoredVersion: '0.1.8' });
    expect(screen.getByTestId('settings-group-updates')).toHaveTextContent('עדכונים');
    expect(screen.getByTestId('settings-update-check')).toHaveTextContent('בדיקה עכשיו');
    expect(screen.getByTestId('settings-update-install')).toHaveTextContent('הורדה והתקנה');
    expect(screen.getByTestId('settings-update-unignore')).toHaveTextContent('הצגת גרסה 0.1.8 שוב');
  });
});
