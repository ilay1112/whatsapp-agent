// Settings v3 - the Google Calendar row reports what its three buttons did. Before this, Connect after Disconnect failed
// silently (the main side answered CAL_UNAVAILABLE and the row ignored every `!r.ok`), and nothing showed a click was
// in flight. Now: one busy state for Connect / Replace the key file / Disconnect, a "Signing in..." label on Connect,
// and an inline error line (the code's title + its action hint) that clears on the next successful call.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GoogleWizardState, Result } from '@shared/types';
import { DEFAULT_SETTINGS, applySettingsPatch } from '@shared/settings';
import {
  IPC_DEFAULTS,
  defaultChat,
  defaultHealth,
  emitPush,
  invokeMocks,
  mockInvoke,
} from '../../../../tests/setup-renderer';
import { useAutoStore } from '../store/auto';
import { useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { Settings } from './Settings';

beforeEach(() => {
  useHealthStore.setState({ health: defaultHealth, progress: null, hiddenSetupTasks: [], downloads: {} });
  useSettingsStore.setState({
    settings: DEFAULT_SETTINGS,
    saveError: null,
    savedAt: 0,
    calendars: [],
    calendarsLoaded: false,
  });
  useAutoStore.setState({ state: null, rows: [], fetchedAt: 0 });
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

const disconnected: GoogleWizardState = {
  ...(IPC_DEFAULTS['google:getWizardState'] as GoogleWizardState),
  status: 'not_configured',
  accountEmail: null,
};

const paint = async (status: GoogleWizardState = disconnected) => {
  mockInvoke('google:status', () => ({ ok: true, value: status }));
  render(<Settings initialGroup="calendar" />);
  await waitFor(() => expect(screen.getByTestId('settings')).toBeInTheDocument());
  await waitFor(() => expect(invokeMocks['google:status']).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('settings-google-account')).not.toHaveTextContent('Checking'));
};

describe('Settings v3 - Google Calendar row feedback', () => {
  it('a failed Connect shows the error title and its action hint under the row', async () => {
    mockInvoke('google:startSignIn', () => ({ ok: false, error: { code: 'CAL_UNAVAILABLE' } }));
    await paint();
    expect(screen.queryByTestId('settings-google-error')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-google-reconnect'));
    const line = await screen.findByTestId('settings-google-error');
    expect(line).toHaveTextContent('The calendar connection stopped');
    expect(line).toHaveTextContent('Try again');
    expect(line).toHaveAttribute('role', 'alert');
    // The busy state ends with the failure: the buttons are usable again.
    expect(screen.getByTestId('settings-google-reconnect')).toBeEnabled();
    expect(screen.getByTestId('settings-google-reconnect')).toHaveTextContent('Connect');
  });

  it('every sign-in failure code shows its own title', async () => {
    const titles: Array<[string, string]> = [
      ['CAL_PORT_BUSY', 'Google sign-in could not start'],
      ['CAL_TOOLSET_MISMATCH', 'The calendar component is not the expected version'],
      ['GOOGLE_CREDENTIALS_INVALID', 'The key file is not valid'],
      ['GOOGLE_SIGNIN_TIMEOUT', 'Google sign-in timed out'],
      ['CAL_RECONNECT', 'Google connection expired'],
    ];
    await paint();
    for (const [code, title] of titles) {
      mockInvoke('google:startSignIn', () => ({ ok: false, error: { code } }) as Result<GoogleWizardState>);
      await userEvent.click(screen.getByTestId('settings-google-reconnect'));
      await waitFor(() => expect(screen.getByTestId('settings-google-error')).toHaveTextContent(title));
    }
  });

  it('shows "Signing in..." with aria-busy and disables all three buttons while the promise is pending', async () => {
    let resolve: (r: Result<GoogleWizardState>) => void = () => undefined;
    mockInvoke('google:startSignIn', () => new Promise<Result<GoogleWizardState>>((r) => (resolve = r)));
    await paint();
    await userEvent.click(screen.getByTestId('settings-google-reconnect'));
    const connect = screen.getByTestId('settings-google-reconnect');
    await waitFor(() => expect(connect).toHaveTextContent('Signing in…'));
    expect(connect).toHaveAttribute('aria-busy', 'true');
    expect(connect).toBeDisabled();
    expect(screen.getByTestId('settings-google-replace')).toBeDisabled();
    expect(screen.getByTestId('settings-google-disconnect')).toBeDisabled();

    resolve({ ok: true, value: { ...disconnected, status: 'connected', accountEmail: 'user@example.test' } });
    await waitFor(() => expect(connect).toHaveTextContent('Reconnect'));
    expect(connect).not.toHaveAttribute('aria-busy', 'true');
    expect(connect).toBeEnabled();
    expect(screen.getByTestId('settings-google-replace')).toBeEnabled();
    expect(screen.getByTestId('settings-google-disconnect')).toBeEnabled();
  });

  it('a successful Connect applies the new wizard state and shows no error line', async () => {
    mockInvoke('google:startSignIn', () => ({
      ok: true,
      value: { ...disconnected, status: 'connected', accountEmail: 'user@example.test' },
    }));
    await paint();
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('Not connected');
    await userEvent.click(screen.getByTestId('settings-google-reconnect'));
    await waitFor(() => expect(screen.getByTestId('settings-google-account')).toHaveTextContent('user@example.test'));
    expect(screen.queryByTestId('settings-google-error')).not.toBeInTheDocument();
  });

  it('the error line clears on the next successful call', async () => {
    mockInvoke('google:startSignIn', () => ({ ok: false, error: { code: 'CAL_PORT_BUSY' } }));
    await paint();
    await userEvent.click(screen.getByTestId('settings-google-reconnect'));
    await screen.findByTestId('settings-google-error');
    mockInvoke('google:startSignIn', () => ({
      ok: true,
      value: { ...disconnected, status: 'connected', accountEmail: 'user@example.test' },
    }));
    await userEvent.click(screen.getByTestId('settings-google-reconnect'));
    await waitFor(() => expect(screen.queryByTestId('settings-google-error')).not.toBeInTheDocument());
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('user@example.test');
  });

  it('Replace the key file reports its failure on the same line', async () => {
    mockInvoke('google:pickCredentialsFile', () => ({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } }));
    await paint();
    await userEvent.click(screen.getByTestId('settings-google-replace'));
    await waitFor(() =>
      expect(screen.getByTestId('settings-google-error')).toHaveTextContent('The key file is not valid'),
    );
  });
});

// T-906 finding 3: Settings said "Not connected" after every launch although the calendar worked - it read the in-memory
// wizard snapshot (no e-mail after a restart) and never `google:status` (which asks the server's account list).
describe('Settings v3 - the Google account row follows google:status', () => {
  const connected: GoogleWizardState = { ...disconnected, status: 'connected', accountEmail: 'user@example.test' };

  it('connected: the e-mail is shown and the button reads Reconnect, styled quiet (never the primary action)', async () => {
    await paint(connected);
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('user@example.test');
    const button = screen.getByTestId('settings-google-reconnect');
    expect(button).toHaveTextContent('Reconnect');
    expect(button).toHaveClass('btn-quiet');
    expect(button).not.toHaveClass('btn-primary');
    expect(invokeMocks['google:getWizardState']).not.toHaveBeenCalled();
  });

  it('connected without a known e-mail still never says "Not connected"', async () => {
    await paint({ ...connected, accountEmail: null });
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('Connected');
    expect(screen.getByTestId('settings-google-account')).not.toHaveTextContent('Not connected');
    expect(screen.getByTestId('settings-google-reconnect')).toHaveTextContent('Reconnect');
  });

  it('needs_sign_in: "Not connected" and Connect', async () => {
    await paint({ ...disconnected, status: 'needs_sign_in' });
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('Not connected');
    expect(screen.getByTestId('settings-google-reconnect')).toHaveTextContent(/^Connect$/);
    expect(screen.getByTestId('settings-google-reconnect')).not.toHaveClass('btn-quiet');
  });

  it('reconnect_required: the expired line and Reconnect as the row action', async () => {
    await paint({ ...disconnected, status: 'reconnect_required' });
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('Google connection expired');
    const button = screen.getByTestId('settings-google-reconnect');
    expect(button).toHaveTextContent('Reconnect');
    expect(button).not.toHaveClass('btn-quiet');
  });

  it('shows "Checking…" while google:status is in flight', async () => {
    let resolve: (r: Result<GoogleWizardState>) => void = () => undefined;
    mockInvoke('google:status', () => new Promise<Result<GoogleWizardState>>((r) => (resolve = r)));
    render(<Settings initialGroup="calendar" />);
    await waitFor(() => expect(screen.getByTestId('settings-google-account')).toHaveTextContent('Checking…'));
    resolve({ ok: true, value: connected });
    await waitFor(() => expect(screen.getByTestId('settings-google-account')).toHaveTextContent('user@example.test'));
  });

  it('a failing google:status shows the error line and does not crash', async () => {
    mockInvoke('google:status', () => ({ ok: false, error: { code: 'CAL_UNAVAILABLE' } }));
    render(<Settings initialGroup="calendar" />);
    const line = await screen.findByTestId('settings-google-error');
    expect(line).toHaveTextContent('The calendar connection stopped');
    expect(screen.getByTestId('settings-google-account')).toHaveTextContent('Not connected');
    expect(screen.getByTestId('settings-google-reconnect')).toBeEnabled();
  });

  it('a rejected google:status (IPC failure) is reported the same way', async () => {
    mockInvoke('google:status', () => Promise.reject(new Error('ipc gone')));
    render(<Settings initialGroup="calendar" />);
    await screen.findByTestId('settings-google-error');
    expect(screen.getByTestId('settings-google-account')).not.toHaveTextContent('Checking');
  });

  it('a google:changed push without the e-mail re-reads google:status; one carrying it is applied as is', async () => {
    await paint(connected);
    const calls = () => (invokeMocks['google:status'] as { mock: { calls: unknown[] } }).mock.calls.length;
    const before = calls();
    emitPush('google:changed', { ...connected, accountEmail: 'other@example.test' });
    await waitFor(() => expect(screen.getByTestId('settings-google-account')).toHaveTextContent('other@example.test'));
    expect(calls()).toBe(before);
    emitPush('google:changed', { ...connected, accountEmail: null });
    await waitFor(() => expect(calls()).toBe(before + 1));
    await waitFor(() => expect(screen.getByTestId('settings-google-account')).toHaveTextContent('user@example.test'));
  });
});

// T-906 finding 7: unchecking the only conflict calendar was swallowed without a word.
describe('Settings v3 - conflict calendars', () => {
  it('unchecking the last checked calendar keeps it checked and says why', async () => {
    await paint();
    const box = await screen.findByTestId('settings-conflict-primary');
    expect(screen.queryByTestId('settings-conflict-min-one')).not.toBeInTheDocument();
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
    expect(screen.getByTestId('settings-conflict-min-one')).toHaveTextContent('At least one calendar stays checked');
  });
});

// T-906 finding 5: the Settings-embedded Claude card (ChooseAi embedded, full size) showed nothing after "Sign in"
// while main was still re-probing the CLI before it answered.
describe('Settings v3 - AI engine: Claude "Sign in" in the embedded card', () => {
  it('enters "Finish signing in in the window that opened" on the click, before cli:signIn answers', async () => {
    mockInvoke('cli:getStatus', (req) => ({
      ok: true,
      value: {
        provider: (req as { provider: 'claude_cli' | 'antigravity_cli' }).provider,
        state: 'not_signed_in',
        version: '2.1.258',
        minVersion: '2.1.248',
        quota: null,
        lastTest: null,
        workspaceTrusted: null,
      },
    }));
    mockInvoke('cli:signIn', () => new Promise(() => undefined)); // main still busy re-probing
    await paint();
    const signIn = await screen.findByTestId('connect-signin-claude_cli');
    await userEvent.click(signIn);
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).toHaveAttribute('data-size', 'full');
    expect(card).toHaveAttribute('data-state', 'waiting_sign_in');
    expect(card).toHaveTextContent('Finish signing in in the window that opened');
  });
});

// T-906 finding 4: "Remove the rule" sent `{policy:'default'}`, which left force_known / auto_policy set, so a contact
// listed because it was marked as known stayed in the list. Main now takes `{chatRef, removeRule:true}` (sweep-fix-a).
describe('Settings v3 - Working rules: Remove the rule', () => {
  it('sends removeRule:true and the row leaves the refreshed list', async () => {
    const chat = { ...defaultChat, chatRef: 8, policy: 'default' as const, forceKnown: true };
    let listed = [chat];
    mockInvoke('chat:listPolicies', () => ({ ok: true, value: { chats: listed } }));
    mockInvoke('chat:setPolicy', () => {
      listed = [];
      return { ok: true, value: { ...chat, forceKnown: false } };
    });
    await paint();
    await userEvent.click(await screen.findByTestId('settings-policy-remove-8'));
    await waitFor(() => expect(invokeMocks['chat:setPolicy']).toHaveBeenCalledWith({ chatRef: 8, removeRule: true }));
    expect(invokeMocks['chat:setPolicy']).not.toHaveBeenCalledWith({ chatRef: 8, policy: 'default' });
    await waitFor(() => expect(screen.queryByTestId('settings-policy-remove-8')).not.toBeInTheDocument());
  });
});
