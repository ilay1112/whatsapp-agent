// ChooseAi - the "Use" / "Continue" error card under a subscription card ALWAYS carries its one action (D-080, T-900).
// Live screenshots showed "Claude Code is not signed in" and "Antigravity changed in a way the app does not recognise"
// with nothing but "Still using: On this computer". Now: CLI_NOT_SIGNED_IN -> Sign in (cli:signIn for that provider),
// CLI_MODEL_REJECTED -> Choose another model (focus the model control), every other code -> its existing action.
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CliStatus } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { IPC_DEFAULTS, invokeMocks, mockInvoke, setLlmState } from '../../../../../tests/setup-renderer';
import { useCliStore } from '../../store/cli';
import { useFocusGuardStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { ChooseAi } from './ChooseAi';

const ready = (provider: CliStatus['provider'] = 'claude_cli'): CliStatus => ({
  provider,
  state: 'ready',
  version: provider === 'claude_cli' ? '2.1.258' : '1.2.16',
  minVersion: provider === 'claude_cli' ? '2.1.248' : '1.2.11',
  quota: null,
  lastTest: { ok: true, at: Date.now(), ms: 1200 },
  workspaceTrusted: provider === 'claude_cli' ? null : true,
});
/** The ready line ("Ready - Claude Code 2.1.258, signed in."); "... installed but not signed in." must not match. */
const SAYS_SIGNED_IN = /Ready - |, signed in\./;
const statusBy = (s: CliStatus) =>
  mockInvoke('cli:getStatus', (req) => {
    const provider = (req as { provider: CliStatus['provider'] }).provider;
    return { ok: true, value: provider === s.provider ? s : { ...IPC_DEFAULTS['cli:getStatus'], provider } };
  });

beforeEach(() => {
  useSettingsStore.setState({ voiceIntent: null });
  useCliStore.setState({ status: {}, checkedAt: {}, error: {}, signInError: {}, signInStartedAt: {} });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  setLlmState({
    consents: { ...IPC_DEFAULTS['llm:getConfig'].consents, cloud_claude_cli: true, cloud_antigravity_cli: true },
  });
});

/** Settings > AI ("Use ...") with main refusing the switch with `code`. */
const refuseUse = async (provider: CliStatus['provider'], code: ErrorCode) => {
  statusBy(ready(provider));
  mockInvoke('llm:setProvider', () => ({ ok: false, error: { code } }));
  render(<ChooseAi onDone={() => {}} onBack={() => {}} embedded />);
  if (provider === 'antigravity_cli') await userEvent.click(await screen.findByTestId('ai-show-experimental'));
  await userEvent.click(await screen.findByTestId(`ai-use-${provider}`));
  return waitFor(() => screen.getByTestId(`ai-use-error-${provider}`));
};

describe('ChooseAi - the CLI error card always carries its one action', () => {
  it('CLI_NOT_SIGNED_IN -> "Sign in" asks main for that provider\'s visible sign-in console', async () => {
    const box = await refuseUse('claude_cli', 'CLI_NOT_SIGNED_IN');
    expect(box).toHaveTextContent('Claude Code is not signed in');
    expect(screen.getByTestId('ai-still-using-claude_cli')).toHaveTextContent('Still using: On this computer');
    const action = screen.getByTestId('ai-use-error-action-claude_cli');
    expect(action).toHaveTextContent('Sign in');
    await userEvent.click(action);
    await waitFor(() => expect(invokeMocks['cli:signIn']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' }));
  });

  it('CLI_NOT_SIGNED_IN: the Connect card above stops saying "signed in" (stale cached probe)', async () => {
    await refuseUse('claude_cli', 'CLI_NOT_SIGNED_IN');
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in');
    expect(screen.getByTestId('connect-claude_cli')).not.toHaveTextContent(SAYS_SIGNED_IN);
  });

  it('CLI_MODEL_REJECTED -> "Choose another model" focuses the model control of that card', async () => {
    mockInvoke('llm:listModels', () => ({
      ok: true,
      value: { models: [{ id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (high)' }], presets: [] },
    }));
    await refuseUse('antigravity_cli', 'CLI_MODEL_REJECTED' as ErrorCode);
    const action = screen.getByTestId('ai-use-error-action-antigravity_cli');
    expect(action).toHaveTextContent('Choose another model');
    await userEvent.click(action);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('connect-model-antigravity_cli')));
  });

  it('CLI_MODEL_REJECTED in onboarding (compact card) still has a model control to focus', async () => {
    statusBy(ready('antigravity_cli'));
    mockInvoke('llm:setProvider', () => ({ ok: false, error: { code: 'CLI_MODEL_REJECTED' as ErrorCode } }));
    render(<ChooseAi onDone={() => {}} onBack={() => {}} />);
    await userEvent.click(await screen.findByTestId('ai-show-experimental'));
    await userEvent.click(screen.getByTestId('choose-ai-antigravity_cli'));
    await waitFor(() => expect(screen.getByTestId('ai-continue')).toBeEnabled());
    await userEvent.click(screen.getByTestId('ai-continue'));
    await userEvent.click(await screen.findByTestId('ai-use-error-action-antigravity_cli'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('connect-model-antigravity_cli')));
  });

  it.each([
    ['CLI_TOOLSET_MISMATCH', 'Export diagnostics', 'diagnostics:export'],
    ['CLI_UNSTABLE', 'Test again', 'cli:test'],
    ['CLOUD_AUTH', 'Sign in again', 'cli:signIn'],
  ] as const)('%s -> its existing action "%s"', async (code, label, channel) => {
    await refuseUse('antigravity_cli', code);
    const action = screen.getByTestId('ai-use-error-action-antigravity_cli');
    expect(action).toHaveTextContent(label);
    await userEvent.click(action);
    await waitFor(() => expect(invokeMocks[channel]).toHaveBeenCalled());
  });

  it('a successful sign-in session clears the stale "not signed in" card', async () => {
    await refuseUse('claude_cli', 'CLI_NOT_SIGNED_IN');
    act(() =>
      useCliStore.getState().setStatus({ ...ready(), signIn: { phase: 'done', outcome: { ok: true } } } as CliStatus),
    );
    await waitFor(() => expect(screen.queryByTestId('ai-use-error-claude_cli')).not.toBeInTheDocument());
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'ready');
  });

  it("while the sign-in window is open the card's Sign in is disabled (one console at a time)", async () => {
    await refuseUse('claude_cli', 'CLI_NOT_SIGNED_IN');
    act(() =>
      useCliStore
        .getState()
        .setStatus({ ...ready(), state: 'not_signed_in', signIn: { phase: 'open', outcome: null } } as CliStatus),
    );
    await waitFor(() => expect(screen.getByTestId('ai-use-error-action-claude_cli')).toBeDisabled());
  });
});
