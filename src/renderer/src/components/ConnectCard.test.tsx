// ConnectCard - provider setup for the two vendor CLIs (UX2 7, 11.7, 13, 15 items 1/3/8/11; B12-B14, B32; owner V2-W1-12).
// The app never installs, signs in or reads a credential itself: the card shows the vendor's command as copyable text,
// asks MAIN for a visible sign-in console, and reports "Use ..." to its parent behind the focus-steal guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CliStatus } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultHealth, i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useCliStore } from '../store/cli';
import { useFocusGuardStore, useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { ConnectCard, SIGN_IN_POLL_MS, agyOptions, commandKeyOf } from './ConnectCard';

const status = (patch: Partial<CliStatus> = {}): CliStatus => ({
  provider: 'claude_cli',
  state: 'not_installed',
  version: null,
  minVersion: '2.1.248',
  quota: null,
  lastTest: null,
  workspaceTrusted: null,
  ...patch,
});
const agy = (patch: Partial<CliStatus> = {}): CliStatus =>
  status({ provider: 'antigravity_cli', minVersion: '1.2.11', workspaceTrusted: false, ...patch });

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useHealthStore.setState({ health: defaultHealth });
  useCliStore.setState({ status: {}, checkedAt: {}, error: {} });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const paint = (s: CliStatus, props: Partial<Parameters<typeof ConnectCard>[0]> = {}) =>
  render(
    <ConnectCard
      provider={s.provider}
      size={props.size ?? 'full'}
      status={s}
      selected={props.selected ?? false}
      onUse={props.onUse ?? (() => {})}
    />,
  );

describe('ConnectCard - helpers', () => {
  it('commandKeyOf: install / update commands are app constants; agy has no separate update command', () => {
    expect(commandKeyOf('claude_cli', 'not_installed')).toBe('cli.command.claudeInstall');
    expect(commandKeyOf('claude_cli', 'too_old')).toBe('cli.command.claudeUpdate');
    expect(commandKeyOf('antigravity_cli', 'not_installed')).toBe('cli.command.agyInstall');
    expect(commandKeyOf('antigravity_cli', 'too_old')).toBe('cli.command.agyInstall');
    expect(commandKeyOf('claude_cli', 'ready')).toBeNull();
  });

  it('agyOptions keeps the current id so the select is never empty', () => {
    expect(agyOptions(null, 'x').map((m) => m.id)).toEqual(['x']);
    expect(agyOptions([{ id: 'a', displayName: 'A' }], 'a').map((m) => m.id)).toEqual(['a']);
    expect(agyOptions([], undefined)).toEqual([]);
  });
});

describe('ConnectCard - full size, the five states', () => {
  it('not_installed: the install command as a read-only LTR field, Copy, Open install page, Check again', async () => {
    paint(status());
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).toHaveAttribute('data-state', 'not_installed');
    expect(card).toHaveTextContent('Claude Code is not installed on this computer.');
    expect(card).toHaveTextContent('The app never installs anything itself.');
    const field = screen.getByTestId('connect-command-claude_cli') as HTMLInputElement;
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveAttribute('dir', 'ltr');
    expect(field.value).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(field).toHaveAccessibleName();
    fireEvent.focus(field);

    await userEvent.click(screen.getByTestId('connect-copy-claude_cli'));
    await waitFor(() =>
      expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledExactlyOnceWith({
        text: 'irm https://claude.ai/install.ps1 | iex',
      }),
    );
    expect(screen.getByTestId('connect-copy-claude_cli')).toHaveTextContent('Copied');

    await userEvent.click(screen.getByTestId('connect-open-install-claude_cli'));
    expect(invokeMocks['external:open']).toHaveBeenCalledExactlyOnceWith({ target: 'claude_install' });

    await userEvent.click(screen.getByTestId('connect-check-claude_cli'));
    await waitFor(() => expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'claude_cli' }));
    await waitFor(() => expect(screen.getByTestId('connect-checked-claude_cli')).toHaveTextContent('Checked just now'));
    // never an in-app installer, a sign-in or a test while not installed
    expect(invokeMocks['cli:signIn']).not.toHaveBeenCalled();
    expect(screen.queryByTestId('connect-test-claude_cli')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-use-claude_cli')).toBeDisabled();
  });

  it('too_old: versions, the update command and the WinGet hint (claude only)', () => {
    paint(status({ state: 'too_old', version: '2.1.150' }));
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).toHaveTextContent('Claude Code 2.1.150 is too old - version 2.1.248 or newer is needed.');
    expect((screen.getByTestId('connect-command-claude_cli') as HTMLInputElement).value).toBe('claude update');
    expect(card).toHaveTextContent('winget upgrade Anthropic.ClaudeCode');
  });

  it("not_signed_in: Sign in opens MAIN's visible console, then polls every 10 s and gives up after 5 minutes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    paint(status({ state: 'not_signed_in', version: '2.1.258' }));
    expect(screen.getByTestId('connect-claude_cli')).toHaveTextContent('2.1.258 is installed but not signed in');
    expect(screen.getByTestId('connect-claude_cli')).toHaveTextContent("Anthropic's own window");
    fireEvent.click(screen.getByTestId('connect-signin-claude_cli'));
    await waitFor(() => expect(invokeMocks['cli:signIn']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' }));
    await waitFor(() =>
      expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'waiting_sign_in'),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Finish signing in');
    const before = invokeMocks['cli:getStatus'].mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS * 3);
    });
    expect(invokeMocks['cli:getStatus'].mock.calls.length - before).toBeGreaterThanOrEqual(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in');
  });

  // ux-i18n-v2-11: a refused cli:signIn (CLI removed / downgraded since the cached status) used to show nothing.
  it.each(['full', 'compact'] as const)(
    'a refused Sign in (%s card) says why with role=alert and re-reads the status',
    async (size) => {
      mockInvoke('cli:signIn', () => ({ ok: false, error: { code: 'CLI_NOT_INSTALLED' } }));
      paint(status({ state: 'not_signed_in', version: '2.1.258' }), { size });
      const before = invokeMocks['cli:getStatus'].mock.calls.length;
      await userEvent.click(screen.getByTestId('connect-signin-claude_cli'));
      const alert = await screen.findByTestId('connect-signin-error-claude_cli');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveAttribute('data-code', 'CLI_NOT_INSTALLED');
      expect(alert.textContent).not.toBe('');
      expect(alert.textContent).not.toMatch(/errors\./);
      await waitFor(() => expect(invokeMocks['cli:getStatus'].mock.calls.length).toBeGreaterThan(before));
      expect(screen.getByTestId('connect-claude_cli')).not.toHaveAttribute('data-state', 'waiting_sign_in');
    },
  );

  it('unknown: Sign in and Check again', () => {
    paint(status({ state: 'unknown', version: '2.1.258' }));
    expect(screen.getByTestId('connect-claude_cli')).toHaveTextContent('Could not tell whether you are signed in.');
    expect(screen.getByTestId('connect-signin-claude_cli')).toBeInTheDocument();
    expect(screen.getByTestId('connect-check-claude_cli')).toBeInTheDocument();
  });

  it('ready: version, usage reset time, model combobox, Run a test, the consent date and "Use"', async () => {
    mockInvoke('consent:get', () => ({
      ok: true,
      value: { kind: 'cloud_claude_cli', currentVersion: 1, acceptedVersion: 1, acceptedAt: Date.UTC(2026, 8, 28, 9) },
    }));
    const onUse = vi.fn();
    paint(
      status({ state: 'ready', version: '2.1.258', quota: { resetsAt: Date.now() + 3_600_000, usingOverage: false } }),
      {
        onUse,
      },
    );
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).toHaveTextContent('Ready - Claude Code 2.1.258, signed in.');
    expect(screen.getByTestId('connect-resets-claude_cli')).toHaveTextContent('usage resets');
    expect(card).toHaveTextContent('as available on your plan');
    await waitFor(() =>
      expect(screen.getByTestId('connect-consent-claude_cli')).toHaveTextContent('Agreed to send chats on'),
    );

    // model: regex-validated, saved on blur through settings:set (llm.cli.claudeModel)
    const model = screen.getByTestId('connect-model-claude_cli');
    await userEvent.clear(model);
    await userEvent.type(model, 'bad model!');
    expect(model).toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(model);
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
    await userEvent.clear(model);
    await userEvent.type(model, 'haiku');
    fireEvent.blur(model);
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ llm: { cli: { claudeModel: 'haiku' } } }),
    );

    await userEvent.click(screen.getByTestId('connect-test-claude_cli'));
    await waitFor(() => expect(screen.getByTestId('connect-test-result-claude_cli')).toHaveTextContent('about 1 s'));
    expect(invokeMocks['cli:test']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' });

    await userEvent.click(screen.getByTestId('ai-use-claude_cli'));
    expect(onUse).toHaveBeenCalledOnce();
  });

  it('a failed test shows the ErrorCode title', async () => {
    mockInvoke('cli:test', () => ({ ok: false, error: { code: 'CLOUD_AUTH' } }));
    paint(status({ state: 'ready', version: '2.1.258' }));
    await userEvent.click(screen.getByTestId('connect-test-claude_cli'));
    await waitFor(() => expect(screen.getByTestId('connect-test-result-claude_cli')).toHaveAttribute('data-ok', '0'));
    expect(screen.getByTestId('connect-test-result-claude_cli')).toHaveTextContent(
      'Anthropic did not accept your sign-in',
    );
  });

  it('"Use" is behind the focus-steal guard and ignores a double click; it is gone while this provider is active', async () => {
    const onUse = vi.fn();
    const { rerender } = paint(status({ state: 'ready', version: '2.1.258' }), { onUse });
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('ai-use-claude_cli'));
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    fireEvent.click(screen.getByTestId('ai-use-claude_cli'), { detail: 2 });
    expect(onUse).not.toHaveBeenCalled();
    rerender(
      <ConnectCard provider="claude_cli" size="full" status={status({ state: 'ready' })} selected onUse={onUse} />,
    );
    expect(screen.queryByTestId('ai-use-claude_cli')).not.toBeInTheDocument();
  });

  it('overage used and not allowed: the CLOUD_OVERAGE row replaces ready and "Use" is disabled', () => {
    paint(status({ state: 'ready', version: '2.1.258', quota: { resetsAt: null, usingOverage: true } }));
    expect(screen.getByTestId('connect-error-claude_cli')).toHaveAttribute('data-code', 'CLOUD_OVERAGE');
    expect(screen.getByTestId('ai-use-claude_cli')).toBeDisabled();
  });

  it.each([
    ['CLI_TOOLSET_MISMATCH', 'diagnostics:export'],
    ['CLI_UNSTABLE', 'cli:test'],
    ['CLOUD_AUTH', 'cli:signIn'],
    ['CLOUD_QUOTA', 'external:open'],
  ] as const)("the active provider's %s row offers its one action (%s)", async (code, channel) => {
    useHealthStore.setState({
      health: { ...defaultHealth, llm: { ...defaultHealth.llm, provider: 'claude_cli', state: 'failed', code } },
    });
    paint(
      status({ state: 'ready', version: '2.1.258', quota: { resetsAt: Date.now() + 60_000, usingOverage: false } }),
      {
        selected: true,
      },
    );
    const row = screen.getByTestId('connect-error-claude_cli');
    expect(row).toHaveAttribute('data-code', code);
    await userEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(invokeMocks[channel]).toHaveBeenCalled());
    if (code === 'CLOUD_QUOTA') expect(invokeMocks['external:open']).toHaveBeenCalledWith({ target: 'claude_usage' });
  });

  it('never renders a path, a token or CLI output beyond the parsed version', () => {
    paint(status({ state: 'ready', version: '2.1.258' }));
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\.claude|\\Users\\|sk-ant|token/i);
  });
});

describe('ConnectCard - compact size (onboarding): one state line + ONE action', () => {
  it.each([
    ['not_installed', 'Copy install command'],
    ['too_old', 'Copy update command'],
    ['not_signed_in', 'Sign in'],
    ['unknown', 'Sign in'],
  ] as const)('%s -> "%s"', (state, label) => {
    paint(status({ state, version: '2.1.150' }), { size: 'compact' });
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).toHaveAttribute('data-size', 'compact');
    expect(card.querySelectorAll('button')).toHaveLength(1);
    expect(card.querySelector('button')).toHaveTextContent(label);
    expect(screen.queryByTestId('connect-command-claude_cli')).not.toBeInTheDocument();
  });

  it('ready -> no action at all (the radio + Continue do the rest)', () => {
    paint(status({ state: 'ready', version: '2.1.258' }), { size: 'compact' });
    expect(screen.getByTestId('connect-claude_cli').querySelectorAll('button')).toHaveLength(0);
  });

  it('compact copy puts the command on the clipboard; compact sign-in waits with "Check again"', async () => {
    const { unmount } = paint(status(), { size: 'compact' });
    await userEvent.click(screen.getByTestId('connect-copy-claude_cli'));
    await waitFor(() => expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledOnce());
    unmount();
    paint(status({ state: 'not_signed_in', version: '2.1.258' }), { size: 'compact' });
    await userEvent.click(screen.getByTestId('connect-signin-claude_cli'));
    await waitFor(() => expect(screen.getByTestId('connect-check-claude_cli')).toBeInTheDocument());
  });
});

describe('ConnectCard - Antigravity (experimental)', () => {
  it('always shows the risk disclosure with the Terms read date and the three capability lines', () => {
    paint(agy());
    const disclosure = screen.getByTestId('agy-disclosure');
    expect(disclosure).toHaveTextContent('Experimental');
    expect(disclosure).toHaveTextContent('third-party software');
    expect(disclosure.querySelector('bdi')).not.toBeNull();
    expect(screen.getByTestId('agy-capabilities').querySelectorAll('li')).toHaveLength(3);
    expect((screen.getByTestId('connect-command-antigravity_cli') as HTMLInputElement).value).toBe(
      'irm https://antigravity.google/cli/install.ps1 | iex',
    );
  });

  it('ready but untrusted: the workspace diff (app-built, LTR) and "Allow the app\'s folder..." (guarded)', async () => {
    mockInvoke('cli:previewWorkspaceChange', () => ({
      ok: true,
      value: {
        diffLine: '+ "trustedWorkspaces": [ ..., "C:\\\\x\\\\agy-workspace" ]',
        settingsFileExists: true,
        agyRunning: false,
      },
    }));
    mockInvoke('cli:allowWorkspace', () => ({ ok: true, value: agy({ state: 'ready', workspaceTrusted: true }) }));
    mockInvoke('llm:listModels', () => ({
      ok: true,
      value: { models: [{ id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash High' }], presets: [] },
    }));
    paint(agy({ state: 'ready', version: '1.2.11' }));
    const diff = await screen.findByTestId('agy-workspace-diff');
    expect(diff).toHaveAttribute('dir', 'ltr');
    expect(screen.getByTestId('ai-use-antigravity_cli')).toBeDisabled();
    await waitFor(() => expect(invokeMocks['llm:listModels']).toHaveBeenCalledWith({ provider: 'antigravity_cli' }));

    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('agy-workspace-allow'));
    expect(invokeMocks['cli:allowWorkspace']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await userEvent.click(screen.getByTestId('agy-workspace-allow'));
    await waitFor(() =>
      expect(invokeMocks['cli:allowWorkspace']).toHaveBeenCalledExactlyOnceWith({
        provider: 'antigravity_cli',
        confirm: true,
      }),
    );
  });

  it('refused while agy runs: "Close Antigravity first"', async () => {
    mockInvoke('cli:previewWorkspaceChange', () => ({
      ok: true,
      value: { diffLine: '+ x', settingsFileExists: true, agyRunning: true },
    }));
    paint(agy({ state: 'ready', version: '1.2.11' }));
    await waitFor(() => expect(screen.getByTestId('agy-workspace-busy')).toHaveTextContent('Close Antigravity first'));
    expect(screen.getByTestId('agy-workspace-allow')).toBeDisabled();
  });

  it('a failed allow shows the ErrorCode title', async () => {
    mockInvoke('cli:previewWorkspaceChange', () => ({
      ok: true,
      value: { diffLine: '+ x', settingsFileExists: true, agyRunning: false },
    }));
    mockInvoke('cli:allowWorkspace', () => ({ ok: false, error: { code: 'CLI_NOT_SIGNED_IN' } }));
    paint(agy({ state: 'ready', version: '1.2.11' }));
    await userEvent.click(await screen.findByTestId('agy-workspace-allow'));
    await waitFor(() => expect(screen.getByTestId('agy-workspace-error')).toBeInTheDocument());
  });

  it('agy model select saves llm.cli.agyModel; CLOUD_QUOTA for agy offers "Open AI settings"', async () => {
    useHealthStore.setState({
      health: {
        ...defaultHealth,
        llm: { ...defaultHealth.llm, provider: 'antigravity_cli', state: 'failed', code: 'CLOUD_QUOTA' },
      },
    });
    mockInvoke('llm:listModels', () => ({
      ok: true,
      value: {
        models: [
          { id: 'gemini-3.8-flash-high', displayName: 'Flash High' },
          { id: 'gemini-3.8-pro', displayName: 'Pro' },
        ],
        presets: [],
      },
    }));
    paint(agy({ state: 'ready', version: '1.2.11', workspaceTrusted: true }), { selected: true });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    await userEvent.selectOptions(screen.getByTestId('connect-model-antigravity_cli'), 'gemini-3.8-pro');
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ llm: { cli: { agyModel: 'gemini-3.8-pro' } } }),
    );
    expect(screen.getByTestId('connect-error-antigravity_cli').querySelector('button')).toHaveTextContent(
      'Open AI settings',
    );
  });
});

describe('ConnectCard - RTL', () => {
  it.each(['not_installed', 'too_old', 'not_signed_in', 'unknown', 'ready'] as const)(
    'RTL snapshot: %s (the command field stays LTR)',
    async (state) => {
      await i18next.changeLanguage('he');
      const { container } = paint(status({ state, version: '2.1.258' }));
      const field = screen.queryByTestId('connect-command-claude_cli');
      if (field) expect(field).toHaveAttribute('dir', 'ltr');
      expect(container.firstChild).toMatchSnapshot();
    },
  );
});
