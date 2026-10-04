// GoogleWizard - step 3 (UX 8.3, ARCH 12.1, docs/research/calendar-mcp.md 6.3; owner W1-16).
// The invariants under test: the renderer never sees a URL or a path, the unverified-app and firewall explainers come
// BEFORE the browser opens, and there are no screenshots or illustrations ([R2]).
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EXTERNAL_TARGETS } from '@shared/ipc';
import { LIMITS, type GoogleWizardState } from '@shared/types';
import { emitPush, i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { GoogleWizard, OAUTH_CLIENT_NAME, SUB_STEP_LINKS, repairStepOf } from './GoogleWizard';

const notConfigured: GoogleWizardState = {
  status: 'not_configured',
  hasCredentials: false,
  accountEmail: null,
  targetCalendarId: 'primary',
  code: null,
  credentialsProblem: null,
};
const withState = (patch: Partial<GoogleWizardState> = {}) =>
  mockInvoke('google:getWizardState', () => ({ ok: true, value: { ...notConfigured, ...patch } }));

const paint = async (props: Partial<Parameters<typeof GoogleWizard>[0]> = {}) => {
  const onDone = props.onDone ?? vi.fn();
  const onSkip = props.onSkip ?? vi.fn();
  const onBack = props.onBack ?? vi.fn();
  render(<GoogleWizard onDone={onDone} onSkip={onSkip} onBack={onBack} startAt={props.startAt} />);
  await waitFor(() => expect(screen.getByTestId('onboarding-google')).toBeInTheDocument());
  return { onDone, onSkip, onBack };
};

describe('repairStepOf', () => {
  it.each([
    [null, 'not_installed_type', 3],
    [null, 'bad_endpoint', 4],
    ['GOOGLE_CREDENTIALS_INVALID', null, 4],
    ['CAL_RECONNECT', null, 5],
    ['GOOGLE_SIGNIN_TIMEOUT', null, 5],
    ['CAL_UNAVAILABLE', null, 1],
    ['BAD_REQUEST', null, null],
    [null, null, null],
  ] as const)('%s / %s -> %s', (code, problem, expected) => {
    expect(repairStepOf(code, problem)).toBe(expected);
  });
});

describe('SUB_STEP_LINKS', () => {
  it('only ever names EXTERNAL_TARGETS enum values, never a URL', () => {
    const all = Object.values(SUB_STEP_LINKS).flat();
    expect(all.length).toBeGreaterThan(0);
    for (const target of all) {
      expect(EXTERNAL_TARGETS).toContain(target);
      expect(target).not.toMatch(/https?:/);
    }
  });
});

describe('GoogleWizard - intro', () => {
  it('is step 3 of the rail and can be postponed', async () => {
    const { onSkip } = await paint();
    expect(screen.getByTestId('onboarding-step-3')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-rail-3')).toHaveAttribute('data-state', 'current');
    await userEvent.click(screen.getByTestId('google-later'));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('Start opens the first sub-step', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('google-start'));
    expect(screen.getByTestId('google-substep')).toHaveTextContent('Step 1 of 5');
  });

  it('adds the Hebrew note only in Hebrew', async () => {
    await paint();
    expect(screen.queryByText(/may open in English/)).not.toBeInTheDocument();
    await i18next.changeLanguage('he');
    await waitFor(() => expect(screen.getByText(/עשויים להיפתח באנגלית/)).toBeInTheDocument());
  });
});

describe('GoogleWizard - the five sub-steps', () => {
  it('resumes where the user left off', async () => {
    await paint({ startAt: 4 });
    expect(screen.getByTestId('google-substep')).toHaveTextContent('Step 4 of 5');
    expect(screen.getByTestId('google-drop-zone')).toBeInTheDocument();
  });

  it('every instruction is text and every deep link is an enum target', async () => {
    await paint({ startAt: 1 });
    const instructions = screen
      .getAllByRole('list')
      .find((el) => el.tagName === 'OL' && !el.hasAttribute('aria-label'))!;
    expect(instructions.querySelectorAll('li').length).toBeGreaterThan(0);
    expect(screen.getByTestId('onboarding-google').querySelector('img')).toBeNull();

    await userEvent.click(screen.getByTestId('google-open-gcp_new_project'));
    expect(invokeMocks['external:open']).toHaveBeenCalledExactlyOnceWith({ target: 'gcp_new_project' });
  });

  it('the consent-screen step explains what Testing mode costs', async () => {
    await paint({ startAt: 2 });
    expect(screen.getByTestId('google-testing-note')).toHaveTextContent('seven days');
    await userEvent.click(screen.getByTestId('google-open-gcp_publish_app'));
    expect(invokeMocks['external:open']).toHaveBeenCalledWith({ target: 'gcp_publish_app' });
  });

  it('the client name is copied through main, never through navigator.clipboard', async () => {
    await paint({ startAt: 3 });
    expect(screen.getByTestId('google-name-chip')).toHaveTextContent(OAUTH_CLIENT_NAME);
    await userEvent.click(screen.getByTestId('google-copy-name'));
    await waitFor(() =>
      expect(invokeMocks['clipboard:writeText']).toHaveBeenCalledExactlyOnceWith({ text: OAUTH_CLIENT_NAME }),
    );
    expect(screen.getByTestId('google-copy-name')).toHaveTextContent('Copied');
  });

  it('Back walks the sub-steps backwards', async () => {
    await paint({ startAt: 2 });
    await userEvent.click(screen.getByTestId('onboarding-back'));
    expect(screen.getByTestId('google-substep')).toHaveTextContent('Step 1 of 5');
  });
});

describe('GoogleWizard - the credentials file', () => {
  it('sends the file CONTENT, never a path', async () => {
    await paint({ startAt: 4 });
    const json = '{"installed":{"client_id":"x"}}';
    const file = new File([json], 'client_secret.json', { type: 'application/json' });
    fireEvent.drop(screen.getByTestId('google-drop-zone'), { dataTransfer: { files: [file] } });

    await waitFor(() =>
      expect(invokeMocks['google:importCredentials']).toHaveBeenCalledExactlyOnceWith({ jsonText: json }),
    );
    const sent = invokeMocks['google:importCredentials'].mock.calls.at(0)?.[0];
    expect(JSON.stringify(sent)).not.toContain('client_secret.json');
  });

  it('refuses an oversized file locally and names the problem', async () => {
    await paint({ startAt: 4 });
    const big = new File(['x'], 'big.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: LIMITS.credentialsJsonBytes + 1 });
    fireEvent.drop(screen.getByTestId('google-drop-zone'), { dataTransfer: { files: [big] } });

    await waitFor(() => expect(screen.getByTestId('google-error')).toHaveTextContent('The file is too large'));
    expect(invokeMocks['google:importCredentials']).not.toHaveBeenCalled();
  });

  it('shows the bad_endpoint row and offers the sub-step that fixes it', async () => {
    withState({ credentialsProblem: 'bad_endpoint', hasCredentials: true });
    await paint({ startAt: 5 });
    await waitFor(() => expect(screen.getByTestId('google-error')).toHaveTextContent('non-Google server'));
    await userEvent.click(screen.getByTestId('google-goto-step'));
    expect(screen.getByTestId('google-substep')).toHaveTextContent('Step 4 of 5');
  });

  it('Browse asks MAIN to open the native dialog', async () => {
    await paint({ startAt: 4 });
    await userEvent.click(screen.getByTestId('google-drop-zone'));
    await waitFor(() => expect(invokeMocks['google:pickCredentialsFile']).toHaveBeenCalledOnce());
  });

  it('cannot go on until a key file was accepted', async () => {
    withState();
    await paint({ startAt: 4 });
    expect(screen.getByTestId('google-next')).toBeDisabled();

    emitPush('google:changed', { ...notConfigured, hasCredentials: true });
    await waitFor(() => expect(screen.getByTestId('google-credentials-ok')).toBeInTheDocument());
    expect(screen.getByTestId('google-next')).toBeEnabled();
  });
});

describe('GoogleWizard - sign-in', () => {
  it('explains the unverified-app notice and the Windows firewall BEFORE the browser opens', async () => {
    withState({ hasCredentials: true });
    await paint({ startAt: 5 });
    const unverified = await screen.findByTestId('google-unverified');
    const firewall = screen.getByTestId('google-firewall');
    expect(unverified).toHaveTextContent('has not verified this app');
    expect(firewall).toHaveTextContent('Cancel or Allow both work');

    const signIn = screen.getByTestId('google-signin');
    expect(unverified.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firewall.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(invokeMocks['google:startSignIn']).not.toHaveBeenCalled();
  });

  it('the help link is an enum target too', async () => {
    withState({ hasCredentials: true });
    await paint({ startAt: 5 });
    await userEvent.click(await screen.findByTestId('google-unverified-help'));
    expect(invokeMocks['external:open']).toHaveBeenCalledExactlyOnceWith({ target: 'google_unverified_app_help' });
  });

  it('signs in, then offers the calendar list and Continue', async () => {
    withState({ hasCredentials: true });
    mockInvoke('google:startSignIn', () => ({
      ok: true,
      value: { ...notConfigured, status: 'connected', hasCredentials: true, accountEmail: null },
    }));
    const { onDone } = await paint({ startAt: 5 });
    await userEvent.click(await screen.findByTestId('google-signin'));

    await waitFor(() => expect(screen.getByTestId('google-connected')).toBeInTheDocument());
    // [V2] UX2 6 step 3: one closing sentence; automatic mode itself is never offered in onboarding
    expect(screen.getByTestId('google-auto-later')).toHaveTextContent('Later, in Settings, you can let the agent');
    expect(document.querySelector('[data-testid^="auto-"]')).toBeNull();
    const select = await screen.findByTestId('google-calendar-select');
    await userEvent.selectOptions(select, 'primary');
    await userEvent.click(screen.getByTestId('google-continue'));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('while main is still signing in it offers to open the browser again', async () => {
    withState({ hasCredentials: true, status: 'signing_in' });
    await paint({ startAt: 5 });
    await waitFor(() => expect(screen.getByTestId('google-waiting')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('google-open-again'));
    await waitFor(() => expect(invokeMocks['google:startSignIn']).toHaveBeenCalledOnce());
  });

  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    withState({ hasCredentials: true });
    const { container } = render(<GoogleWizard onDone={() => {}} onSkip={() => {}} onBack={() => {}} startAt={5} />);
    await waitFor(() => expect(screen.getByTestId('google-unverified')).toBeInTheDocument());
    expect(container.firstChild).toMatchSnapshot();
  });
});
