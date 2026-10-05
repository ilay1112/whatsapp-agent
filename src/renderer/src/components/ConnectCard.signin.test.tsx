// ConnectCard - the guided sign-in session and the "one action per CLI error" rule (D-080, T-900; owner renderer).
// The live diagnostic showed two renderer faults: (1) after a CLI_NOT_SIGNED_IN result the card kept saying "signed in"
// (main's cached probe still said `ready`), and (2) the CLI error rows offered no way forward. Main now pushes a sign-in
// session state on CliStatus (`signIn`: idle | open | retesting | done + the last test outcome); the card renders it.
// The app never sees a credential: Sign in only asks MAIN (`cli:signIn`) to open the vendor's own login console.
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CliStatus } from '@shared/types';
import type { ErrorCode } from '@shared/errors';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { defaultHealth, i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useCliStore } from '../store/cli';
import { useFocusGuardStore, useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { ConnectCard } from './ConnectCard';
import { signInSessionOf } from './cliSignIn';

const status = (patch: Partial<CliStatus> = {}): CliStatus => ({
  provider: 'claude_cli',
  state: 'ready',
  version: '2.1.258',
  minVersion: '2.1.248',
  quota: null,
  lastTest: null,
  workspaceTrusted: null,
  ...patch,
});
const agy = (patch: Partial<CliStatus> = {}): CliStatus =>
  status({ provider: 'antigravity_cli', version: '1.2.16', minVersion: '1.2.11', workspaceTrusted: true, ...patch });

type Session = {
  phase: 'open' | 'retesting' | 'done';
  outcome: { ok: boolean; code?: ErrorCode | null; at?: number } | null;
};
/** CliStatus + main's sign-in session field (backward compatible: absent on an older main). */
const withSession = (s: CliStatus, signIn: Session): CliStatus => ({ ...s, signIn }) as CliStatus;

const MODEL_REJECTED = 'CLI_MODEL_REJECTED' as ErrorCode;
/** The ready line ("Ready - Claude Code 2.1.258, signed in."); "... installed but not signed in." must not match. */
const SAYS_SIGNED_IN = /Ready - |, signed in\./;

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useHealthStore.setState({ health: defaultHealth });
  useCliStore.setState({ status: {}, checkedAt: {}, error: {}, signInError: {}, signInStartedAt: {} });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});

const paint = (
  s: CliStatus,
  props: { size?: 'full' | 'compact'; selected?: boolean; lastError?: ErrorCode | null } = {},
) =>
  render(
    <ConnectCard
      provider={s.provider}
      size={props.size ?? 'full'}
      status={s}
      selected={props.selected ?? false}
      lastError={props.lastError ?? null}
      onUse={() => {}}
    />,
  );

const activeError = (provider: CliStatus['provider'], code: ErrorCode) =>
  useHealthStore.setState({
    health: { ...defaultHealth, llm: { ...defaultHealth.llm, provider, state: 'failed', code } },
  });

describe("signInSessionOf - reading main's session field", () => {
  it('is null for an older main that sends no session, and reads the phase + outcome otherwise', () => {
    expect(signInSessionOf(status())).toBeNull();
    expect(signInSessionOf(withSession(status(), { phase: 'open', outcome: null }))).toEqual({
      phase: 'open',
      outcome: null,
    });
    expect(
      signInSessionOf(withSession(status(), { phase: 'done', outcome: { ok: false, code: 'CLI_NOT_SIGNED_IN' } })),
    ).toEqual({ phase: 'done', outcome: { ok: false, code: 'CLI_NOT_SIGNED_IN' } });
    expect(signInSessionOf(withSession(status(), { phase: 'done', outcome: { ok: true } }))).toEqual({
      phase: 'done',
      outcome: { ok: true },
    });
  });

  it('ignores an unknown phase or an unknown error code instead of guessing', () => {
    expect(
      signInSessionOf({ ...status(), signIn: { phase: 'weird', outcome: null } } as unknown as CliStatus),
    ).toBeNull();
    expect(
      signInSessionOf(withSession(status(), { phase: 'done', outcome: { ok: false, code: 'NOPE' as ErrorCode } })),
    ).toEqual({ phase: 'done', outcome: { ok: false, code: null } });
  });
});

describe('ConnectCard - guided sign-in session (D-080)', () => {
  it.each(['full', 'compact'] as const)(
    'open (%s): says a window opened and the app tests again when it closes',
    (size) => {
      paint(withSession(status({ state: 'not_signed_in' }), { phase: 'open', outcome: null }), { size });
      const card = screen.getByTestId('connect-claude_cli');
      expect(card).toHaveAttribute('data-state', 'sign_in_open');
      expect(screen.getByRole('status')).toHaveTextContent(
        'A sign-in window opened. Finish signing in there - the app will test again when it closes.',
      );
      expect(screen.queryByTestId('connect-signin-claude_cli')).not.toBeInTheDocument();
      expect(card).not.toHaveTextContent(SAYS_SIGNED_IN);
    },
  );

  it('retesting: "Testing..." while main re-tests after the window closed', () => {
    paint(withSession(status({ state: 'not_signed_in' }), { phase: 'retesting', outcome: null }));
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'sign_in_retesting');
    expect(screen.getByRole('status')).toHaveTextContent('Testing Claude Code...');
  });

  it('done + ok: the outcome line and the normal ready line', () => {
    paint(withSession(status(), { phase: 'done', outcome: { ok: true } }));
    expect(screen.getByTestId('connect-session-ok-claude_cli')).toHaveTextContent('Signed in - Claude Code works.');
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'ready');
  });

  it('done + still not signed in: never "signed in", and Sign in is offered again', async () => {
    paint(withSession(status(), { phase: 'done', outcome: { ok: false, code: 'CLI_NOT_SIGNED_IN' } }));
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).toHaveAttribute('data-state', 'not_signed_in');
    expect(screen.getByTestId('connect-state-claude_cli')).not.toHaveTextContent(SAYS_SIGNED_IN);
    expect(screen.getByTestId('connect-state-claude_cli')).toHaveTextContent('not signed in');
    await userEvent.click(screen.getByTestId('connect-signin-claude_cli'));
    await waitFor(() => expect(invokeMocks['cli:signIn']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' }));
  });

  it("done + another failure: that code's row with its one action", async () => {
    paint(withSession(status(), { phase: 'done', outcome: { ok: false, code: 'CLI_TOOLSET_MISMATCH' } }));
    const row = screen.getByTestId('connect-error-claude_cli');
    expect(row).toHaveAttribute('data-code', 'CLI_TOOLSET_MISMATCH');
    await userEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(invokeMocks['diagnostics:export']).toHaveBeenCalledOnce());
  });

  it('done + a failure without a known code: a plain "did not pass" line and Sign in again', () => {
    paint(withSession(status({ state: 'not_signed_in' }), { phase: 'done', outcome: { ok: false } }));
    expect(screen.getByTestId('connect-session-failed-claude_cli')).toHaveTextContent(
      'The test after signing in did not pass.',
    );
    expect(screen.getByTestId('connect-signin-claude_cli')).toBeInTheDocument();
  });

  it("main's exact outcome shape ({ ok, code: null, at }) reads as a pass; 'idle' reads as no session", () => {
    expect(signInSessionOf(withSession(status(), { phase: 'done', outcome: { ok: true, code: null, at: 5 } }))).toEqual(
      {
        phase: 'done',
        outcome: { ok: true },
      },
    );
    expect(signInSessionOf({ ...status(), signIn: { phase: 'idle', outcome: null } })).toBeNull();
  });

  it('once main pushed a session, the old 10 s poll fallback never comes back when the session goes idle', async () => {
    const { rerender } = paint(status({ state: 'not_signed_in' }));
    await userEvent.click(screen.getByTestId('connect-signin-claude_cli'));
    await waitFor(() =>
      expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'waiting_sign_in'),
    );
    const again = (s: CliStatus) =>
      rerender(<ConnectCard provider="claude_cli" size="full" status={s} selected={false} onUse={() => {}} />);
    again(withSession(status({ state: 'not_signed_in' }), { phase: 'open', outcome: null }));
    await waitFor(() => expect(useCliStore.getState().signInStartedAt).toEqual({}));
    again(status({ state: 'not_signed_in' }));
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in');
  });

  it('follows the pushed session live: Sign in -> open -> retesting -> done', async () => {
    const { rerender } = paint(status({ state: 'not_signed_in' }));
    await userEvent.click(screen.getByTestId('connect-signin-claude_cli'));
    await waitFor(() => expect(invokeMocks['cli:signIn']).toHaveBeenCalledOnce());
    const again = (s: CliStatus) =>
      rerender(<ConnectCard provider="claude_cli" size="full" status={s} selected={false} onUse={() => {}} />);
    again(withSession(status({ state: 'not_signed_in' }), { phase: 'open', outcome: null }));
    expect(screen.getByRole('status')).toHaveTextContent('A sign-in window opened.');
    again(withSession(status({ state: 'not_signed_in' }), { phase: 'retesting', outcome: null }));
    expect(screen.getByRole('status')).toHaveTextContent('Testing Claude Code...');
    again(withSession(status(), { phase: 'done', outcome: { ok: true } }));
    expect(screen.getByTestId('connect-session-ok-claude_cli')).toBeInTheDocument();
  });

  it('Hebrew: every session line is translated', async () => {
    await i18next.changeLanguage('he');
    try {
      const { unmount } = paint(withSession(status({ state: 'not_signed_in' }), { phase: 'open', outcome: null }));
      expect(screen.getByRole('status').textContent).toMatch(/[֐-׿]/);
      unmount();
      paint(withSession(status(), { phase: 'done', outcome: { ok: true } }));
      expect(screen.getByTestId('connect-session-ok-claude_cli').textContent).toMatch(/[֐-׿]/);
    } finally {
      await i18next.changeLanguage('en');
    }
  });
});

describe('ConnectCard - a CLI_NOT_SIGNED_IN result beats a stale "ready" probe', () => {
  it('from the parent (the last failed "Use"): the state line says not signed in and offers Sign in', () => {
    paint(status(), { lastError: 'CLI_NOT_SIGNED_IN' });
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in');
    expect(screen.getByTestId('connect-state-claude_cli')).not.toHaveTextContent(SAYS_SIGNED_IN);
    expect(screen.getByTestId('connect-signin-claude_cli')).toBeInTheDocument();
    expect(screen.getByTestId('ai-use-claude_cli')).toBeDisabled();
  });

  it('compact (onboarding) too: the screenshot case', () => {
    paint(status(), { size: 'compact', lastError: 'CLI_NOT_SIGNED_IN' });
    const card = screen.getByTestId('connect-claude_cli');
    expect(card).not.toHaveTextContent('Ready - Claude Code 2.1.258, signed in.');
    expect(card.querySelector('button')).toHaveTextContent('Sign in');
  });

  it("from the active provider's health code", () => {
    activeError('claude_cli', 'CLI_NOT_SIGNED_IN');
    paint(status(), { selected: true });
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in');
    expect(screen.getByTestId('connect-signin-claude_cli')).toBeInTheDocument();
  });

  it('from a failed "Run a test"', async () => {
    mockInvoke('cli:test', () => ({ ok: false, error: { code: 'CLI_NOT_SIGNED_IN' } }));
    paint(status());
    await userEvent.click(screen.getByTestId('connect-test-claude_cli'));
    await waitFor(() =>
      expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'not_signed_in'),
    );
    expect(screen.getByTestId('connect-state-claude_cli')).not.toHaveTextContent(SAYS_SIGNED_IN);
  });

  it('a later successful session wins over the stale failure', () => {
    paint(withSession(status(), { phase: 'done', outcome: { ok: true } }), { lastError: 'CLI_NOT_SIGNED_IN' });
    expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-state', 'ready');
  });
});

describe('ConnectCard - CLI_MODEL_REJECTED: "Choose another model" focuses the model control', () => {
  it('Antigravity (active provider): the row offers the action and focuses the model select', async () => {
    mockInvoke('llm:listModels', () => ({
      ok: true,
      value: { models: [{ id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (high)' }], presets: [] },
    }));
    activeError('antigravity_cli', MODEL_REJECTED);
    paint(agy(), { selected: true });
    const row = screen.getByTestId('connect-error-antigravity_cli');
    expect(row).toHaveAttribute('data-code', 'CLI_MODEL_REJECTED');
    const button = row.querySelector('button')!;
    expect(button).toHaveTextContent('Choose another model');
    await userEvent.click(button);
    expect(document.activeElement).toBe(screen.getByTestId('connect-model-antigravity_cli'));
  });

  it('compact (onboarding) shows the model control when the last "Use" was refused for the model', async () => {
    paint(agy(), { size: 'compact', lastError: MODEL_REJECTED });
    expect(await screen.findByTestId('connect-model-antigravity_cli')).toBeInTheDocument();
  });
});
