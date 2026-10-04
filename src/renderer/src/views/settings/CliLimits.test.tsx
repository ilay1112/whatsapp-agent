// CliLimits - the shared "Usage limits" disclosure of the subscription cards (UX2 4.1, 13; B13, B23, F11; owner V2-W1-12).
// The overage switch NEVER goes through settings:set (F11: cli:setOverage only, main shows the native confirmation), and
// claude.exe is picked by MAIN's native dialog (cli:pickExe) - the page never renders a path.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, SettingsPatchSchema, applySettingsPatch } from '@shared/settings';
import { IPC_DEFAULTS, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useCliStore } from '../../store/cli';
import { useFocusGuardStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { CliLimits, RUNS_PER_HOUR_MAX } from './CliLimits';

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useCliStore.setState({ status: {}, checkedAt: {}, error: {} });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

const open = async () => {
  render(<CliLimits />);
  expect(screen.getByTestId('settings-cli-limits')).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByTestId('settings-cli-overage')).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId('settings-cli-limits'));
  expect(screen.getByTestId('settings-cli-limits')).toHaveAttribute('aria-expanded', 'true');
};

describe('CliLimits', () => {
  it('runs per hour: a valid number 1..60 is a settings:set patch the schema accepts; anything else is not sent', async () => {
    await open();
    const field = screen.getByTestId('settings-cli-runs-per-hour');
    expect(screen.getByTestId('settings-row-cli-runs')).toHaveTextContent('Up to 20 AI runs per hour');
    await userEvent.clear(field);
    await userEvent.type(field, String(RUNS_PER_HOUR_MAX + 1));
    fireEvent.blur(field);
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, '12');
    fireEvent.blur(field);
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledExactlyOnceWith({ llm: { cli: { maxRunsPerHour: 12 } } }),
    );
    expect(SettingsPatchSchema.safeParse({ llm: { cli: { maxRunsPerHour: 12 } } }).success).toBe(true);
  });

  it('the overage switch calls cli:setOverage - never settings:set - and shows what main stored', async () => {
    mockInvoke('settings:get', () => ({
      ok: true,
      value: {
        ...DEFAULT_SETTINGS,
        llm: { ...DEFAULT_SETTINGS.llm, cli: { ...DEFAULT_SETTINGS.llm.cli, allowOverage: true } },
      },
    }));
    await open();
    const toggle = screen.getByTestId('settings-cli-overage');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await waitFor(() => expect(invokeMocks['cli:setOverage']).toHaveBeenCalledExactlyOnceWith({ allow: true }));
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('settings-cli-overage')).toHaveAttribute('aria-checked', 'true'));
    // the patch schema cannot even carry it (F11)
    expect(SettingsPatchSchema.safeParse({ llm: { cli: { allowOverage: true } } }).success).toBe(false);
  });

  it('turning overage ON is focus-steal guarded; turning it OFF is not (fail-safe direction)', async () => {
    await open();
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('settings-cli-overage'));
    expect(invokeMocks['cli:setOverage']).not.toHaveBeenCalled();
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        llm: { ...DEFAULT_SETTINGS.llm, cli: { ...DEFAULT_SETTINGS.llm.cli, allowOverage: true } },
      },
    });
    await userEvent.click(screen.getByTestId('settings-cli-overage'));
    await waitFor(() => expect(invokeMocks['cli:setOverage']).toHaveBeenCalledExactlyOnceWith({ allow: false }));
  });

  it('the exe location: "Found automatically" / "Chosen by you" (never a path); Change... = cli:pickExe', async () => {
    await open();
    await waitFor(() => expect(invokeMocks['llm:getConfig']).toHaveBeenCalled());
    expect(screen.getByTestId('settings-cli-exe-path')).toHaveTextContent('Found automatically');
    const base = IPC_DEFAULTS['llm:getConfig'];
    mockInvoke('llm:getConfig', () => ({ ok: true, value: { ...base, cli: { ...base.cli, claudeExePathSet: true } } }));
    await userEvent.click(screen.getByTestId('settings-cli-exe-change'));
    await waitFor(() => expect(invokeMocks['cli:pickExe']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' }));
    await waitFor(() => expect(screen.getByTestId('settings-cli-exe-path')).toHaveTextContent('Chosen by you'));
    expect(document.body.textContent).not.toMatch(/claude\.exe|[A-Z]:\\/);
    expect(useCliStore.getState().status.claude_cli).toBeDefined();
  });

  it('renders nothing without settings', () => {
    useSettingsStore.setState({ settings: null });
    const { container } = render(<CliLimits />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CliLimits - edges', () => {
  it('can start open; a refused overage / pick keeps the stored values and re-reads them', async () => {
    mockInvoke('cli:setOverage', () => ({ ok: false, error: { code: 'WINDOW_NOT_FOCUSED' } }));
    mockInvoke('cli:pickExe', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    render(<CliLimits defaultOpen />);
    expect(screen.getByTestId('settings-cli-limits')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByTestId('settings-cli-overage'));
    await waitFor(() => expect(invokeMocks['settings:get']).toHaveBeenCalled());
    expect(screen.getByTestId('settings-cli-overage')).toHaveAttribute('aria-checked', 'false');
    expect(useCliStore.getState().status.claude_cli).toBeUndefined();
    await userEvent.click(screen.getByTestId('settings-cli-exe-change'));
    await waitFor(() => expect(invokeMocks['cli:pickExe']).toHaveBeenCalledOnce());
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('settings-cli-exe-change'));
    expect(invokeMocks['cli:pickExe']).toHaveBeenCalledOnce();
  });

  it('a failed config / settings read changes nothing', async () => {
    mockInvoke('llm:getConfig', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    mockInvoke('settings:get', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    render(<CliLimits defaultOpen />);
    await userEvent.click(screen.getByTestId('settings-cli-overage'));
    await waitFor(() => expect(invokeMocks['settings:get']).toHaveBeenCalled());
    expect(screen.getByTestId('settings-cli-exe-path')).toHaveTextContent('Found automatically');
  });
});
