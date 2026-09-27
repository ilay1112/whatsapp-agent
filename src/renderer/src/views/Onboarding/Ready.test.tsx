// Ready - step 4 (UX 8.4, ARCH 12.1; owner W1-16). A LIVE checklist, the two tray sentences with the only graphic in
// onboarding ([R2] the inline tray glyph), autostart default OFF and the two storage notes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { OnboardingState } from '@shared/types';
import { defaultHealth, i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { Ready } from './Ready';

const state = (
  patch: Partial<OnboardingState['checklist']> = {},
  rest: Partial<OnboardingState> = {},
): OnboardingState => ({
  step: 'ready',
  checklist: { ai: 'ready', aiPercent: null, whatsapp: 'ready', calendar: 'ready', ...patch },
  userDataCloudSynced: false,
  ...rest,
});

beforeEach(() => {
  useHealthStore.setState({ health: defaultHealth, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, saveError: null, savedAt: 0 });
});

const paint = async (onDone = vi.fn()) => {
  render(<Ready onDone={onDone} />);
  await waitFor(() => expect(invokeMocks['onboarding:getState']).toHaveBeenCalled());
  return onDone;
};

describe('Ready', () => {
  it('is step 4 and reads the authoritative checklist from main', async () => {
    mockInvoke('onboarding:getState', () => ({ ok: true, value: state() }));
    await paint();
    expect(screen.getByTestId('onboarding-step-4')).toBeInTheDocument();
    for (const row of ['ai', 'whatsapp', 'calendar']) {
      await waitFor(() => expect(screen.getByTestId(`ready-${row}`)).toHaveAttribute('data-ready', '1'));
    }
  });

  it('shows what is still missing, with the download percentage', async () => {
    mockInvoke('onboarding:getState', () => ({
      ok: true,
      value: state({ ai: 'downloading', aiPercent: 42, whatsapp: 'pending', calendar: 'skipped' }),
    }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('ready-ai')).toHaveTextContent('downloading, 42 %'));
    expect(screen.getByTestId('ready-ai')).toHaveAttribute('data-ready', '0');
    expect(screen.getByTestId('ready-whatsapp')).toHaveTextContent('not linked yet');
    expect(screen.getByTestId('ready-calendar')).toHaveTextContent('replies only');
  });

  it('re-reads the checklist whenever health or the download moves', async () => {
    mockInvoke('onboarding:getState', () => ({ ok: true, value: state() }));
    await paint();
    const before = invokeMocks['onboarding:getState'].mock.calls.length;
    // `health:changed` / `model:progress` land in the health store (App subscribes); the view re-reads on every landing.
    act(() => useHealthStore.setState({ health: { ...defaultHealth, overall: 'attention' } }));
    await waitFor(() => expect(invokeMocks['onboarding:getState'].mock.calls.length).toBeGreaterThan(before));
  });

  it('explains the tray in two sentences next to the one inline glyph', async () => {
    await paint();
    const section = screen.getByRole('heading', { name: 'The agent keeps running' }).closest('section')!;
    expect(section.querySelectorAll('svg')).toHaveLength(1); // [R2] the only graphic in onboarding
    expect(section.querySelector('img')).toBeNull();
    expect(section).toHaveTextContent('does not stop the agent');
    expect(section).toHaveTextContent('next to the clock');
  });

  it('autostart is off by default and is written straight to main', async () => {
    await paint();
    const toggle = screen.getByTestId('ready-autostart');
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ general: { autostart: true } }));
  });

  it('points at device encryption through an enum target', async () => {
    await paint();
    expect(screen.getByTestId('ready-bitlocker')).toHaveTextContent('device encryption');
    await userEvent.click(screen.getByTestId('ready-bitlocker').querySelector('button')!);
    expect(invokeMocks['external:open']).toHaveBeenCalledExactlyOnceWith({ target: 'bitlocker_help' });
  });

  it('warns when the app folder looks cloud-synced', async () => {
    mockInvoke('onboarding:getState', () => ({ ok: true, value: state({}, { userDataCloudSynced: true }) }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('ready-cloud-synced')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('ready-cloud-synced').querySelector('button')!);
    expect(invokeMocks['external:open']).toHaveBeenCalledExactlyOnceWith({ target: 'project_readme' });
  });

  it('finishes the wizard', async () => {
    const onDone = await paint();
    await userEvent.click(screen.getByTestId('ready-open'));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    mockInvoke('onboarding:getState', () => ({ ok: true, value: state() }));
    const { container } = render(<Ready onDone={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('ready-ai')).toHaveAttribute('data-ready', '1'));
    expect(container.firstChild).toMatchSnapshot();
  });
});
