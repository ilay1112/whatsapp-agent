// ChooseAi v2 - the subscription cards, the two disclosures and the onboarding media opt-ins (UX2 4.1, 6, 7, 13, 15;
// B12-B14; owner V2-W1-12). A subscription card never switches the provider by itself: "Use ..." (Settings) or
// "Continue" (onboarding) runs consent at the exact version -> llm:setProvider, and a failure keeps the previous provider.
// Automatic mode is never offered in onboarding.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONSENT_VERSIONS, type CliStatus, type LlmConfig } from '@shared/types';
import { IPC_DEFAULTS, invokeMocks, mockInvoke, setLlmState } from '../../../../../tests/setup-renderer';
import { useCliStore } from '../../store/cli';
import { useFocusGuardStore } from '../../store/health';
import { ChooseAi, VOICE_OPTIN_MIN_DISK_GIB, isCliProvider, voiceOptInBlocker } from './ChooseAi';

const ready = (provider: CliStatus['provider'] = 'claude_cli'): CliStatus => ({
  provider,
  state: 'ready',
  version: provider === 'claude_cli' ? '2.1.258' : '1.2.11',
  minVersion: provider === 'claude_cli' ? '2.1.248' : '1.2.11',
  quota: null,
  lastTest: { ok: true, at: Date.now(), ms: 1200 },
  workspaceTrusted: provider === 'claude_cli' ? null : true,
});
const statusBy = (s: CliStatus) =>
  mockInvoke('cli:getStatus', (req) => {
    const provider = (req as { provider: CliStatus['provider'] }).provider;
    return { ok: true, value: provider === s.provider ? s : { ...IPC_DEFAULTS['cli:getStatus'], provider } };
  });

const paint = async (props: { embedded?: boolean; onDone?: () => void } = {}) => {
  const onDone = props.onDone ?? vi.fn();
  render(<ChooseAi onDone={onDone} onBack={() => {}} embedded={props.embedded} />);
  await waitFor(() => expect(screen.getByTestId('onboarding-choose-ai')).toBeInTheDocument());
  await waitFor(() => expect(invokeMocks['cli:getStatus']).toHaveBeenCalled());
  return onDone;
};

beforeEach(() => {
  useCliStore.setState({ status: {}, checkedAt: {}, error: {} });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});

describe('ChooseAi v2 - helpers', () => {
  it('isCliProvider / voiceOptInBlocker', () => {
    expect(isCliProvider('claude_cli')).toBe(true);
    expect(isCliProvider('antigravity_cli')).toBe(true);
    expect(isCliProvider('claude')).toBe(false);
    const hw = { ramGiB: 16, gpus: [], freeDiskGiB: 100, recommendedTier: 'small' as const };
    expect(voiceOptInBlocker(null)).toBeNull();
    expect(voiceOptInBlocker(hw)).toBeNull();
    expect(voiceOptInBlocker({ ...hw, freeDiskGiB: VOICE_OPTIN_MIN_DISK_GIB - 1 })).toBe('disk');
    expect(voiceOptInBlocker({ ...hw, ramGiB: 4 })).toBe('ram');
  });
});

describe('ChooseAi v2 - cards and disclosures', () => {
  it('runs CLI detection silently on entry and shows the compact Connect card under the Claude subscription card', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-size', 'compact'));
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'claude_cli' });
    expect(invokeMocks['cli:getStatus']).toHaveBeenCalledWith({ provider: 'antigravity_cli' });
    expect(screen.getByTestId('ai-card-claude_cli')).toHaveTextContent('Claude - your subscription');
    expect(screen.getByTestId('ai-card-claude_cli')).toHaveTextContent('through your own sign-in');
    expect(invokeMocks['cli:signIn']).not.toHaveBeenCalled();
  });

  it('"Show experimental" reveals the Antigravity card with its Experimental chip and the Gemini CLI note', async () => {
    await paint();
    expect(screen.queryByTestId('ai-card-antigravity_cli')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('ai-show-experimental'));
    expect(screen.getByTestId('ai-card-antigravity_cli')).toHaveTextContent('Experimental');
    expect(screen.getByTestId('gemini-cli-note')).toHaveTextContent('Looking for the Gemini CLI?');
    await userEvent.click(screen.getByTestId('ai-show-experimental'));
    expect(screen.queryByTestId('ai-card-antigravity_cli')).not.toBeInTheDocument();
  });

  it.each([
    ['antigravity_cli', 'ai-show-experimental'],
    ['gemini', 'ai-advanced'],
  ] as const)('the disclosure opens by itself when the active provider (%s) is inside it', async (provider, id) => {
    setLlmState({ provider });
    await paint({ embedded: true });
    await waitFor(() => expect(screen.getByTestId(id)).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByTestId(`ai-card-${provider}`)).toHaveAttribute('data-selected', '1');
  });

  it('selecting a subscription card switches NOTHING by itself', async () => {
    statusBy(ready());
    await paint({ embedded: true });
    await userEvent.click(screen.getByTestId('choose-ai-claude_cli'));
    expect(screen.getByTestId('ai-card-claude_cli')).toHaveAttribute('data-selected', '1');
    expect(invokeMocks['llm:setProvider']).not.toHaveBeenCalled();
    expect(invokeMocks['consent:accept']).not.toHaveBeenCalled();
  });
});

describe('ChooseAi v2 - Settings: "Use Claude - your subscription"', () => {
  it('opens the CLI consent (exact version) first; accepting records it, then llm:setProvider runs', async () => {
    statusBy(ready());
    await paint({ embedded: true });
    await userEvent.click(await screen.findByTestId('ai-use-claude_cli'));
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude_cli');
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute(
      'data-version',
      String(CONSENT_VERSIONS.cloud_claude_cli),
    );
    expect(invokeMocks['llm:setProvider']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('consent-accept'));
    await waitFor(() =>
      expect(invokeMocks['llm:setProvider']).toHaveBeenCalledExactlyOnceWith({ provider: 'claude_cli' }),
    );
    const accepted = invokeMocks['consent:accept'].mock.invocationCallOrder[0]!;
    expect(invokeMocks['llm:setProvider'].mock.invocationCallOrder[0]!).toBeGreaterThan(accepted);
    await waitFor(() => expect(screen.getByTestId('ai-card-claude_cli')).toHaveAttribute('data-active', '1'));
  });

  it('declining the CLI consent changes nothing: the active provider stays active', async () => {
    statusBy(ready());
    await paint({ embedded: true });
    await userEvent.click(await screen.findByTestId('ai-use-claude_cli'));
    await userEvent.click(screen.getByTestId('consent-cancel'));
    expect(invokeMocks['consent:accept']).not.toHaveBeenCalled();
    expect(invokeMocks['llm:setProvider']).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-card-local')).toHaveAttribute('data-selected', '1');
  });

  it('with the consent already current, "Use" shows "Checking Claude Code..." and a refusal keeps the previous provider', async () => {
    statusBy(ready());
    setLlmState({ consents: { ...IPC_DEFAULTS['llm:getConfig'].consents, cloud_claude_cli: true } });
    let answer: (v: unknown) => void = () => {};
    mockInvoke('llm:setProvider', () => new Promise((r) => (answer = r as (v: unknown) => void)) as never);
    await paint({ embedded: true });
    await userEvent.click(await screen.findByTestId('ai-use-claude_cli'));
    expect(await screen.findByTestId('ai-switching-claude_cli')).toHaveTextContent('Checking Claude Code...');
    answer({ ok: false, error: { code: 'CLI_UNSTABLE' } });
    await waitFor(() =>
      expect(screen.getByTestId('ai-use-error-claude_cli')).toHaveTextContent('Claude Code keeps stopping'),
    );
    expect(screen.getByTestId('ai-still-using-claude_cli')).toHaveTextContent('Still using: On this computer');
    expect(screen.getByTestId('ai-card-local')).toHaveAttribute('data-selected', '1');
  });

  it('the full Connect card is used in Settings', async () => {
    statusBy(ready());
    await paint({ embedded: true });
    await waitFor(() => expect(screen.getByTestId('connect-claude_cli')).toHaveAttribute('data-size', 'full'));
    expect(screen.queryByTestId('onboarding-voice-optin')).not.toBeInTheDocument();
  });
});

describe('ChooseAi v2 - onboarding', () => {
  it('Continue on a Ready subscription card runs consent -> llm:setProvider and then moves on', async () => {
    statusBy(ready());
    const onDone = await paint();
    await userEvent.click(screen.getByTestId('choose-ai-claude_cli'));
    await waitFor(() => expect(screen.getByTestId('ai-continue')).toBeEnabled());
    await userEvent.click(screen.getByTestId('ai-continue'));
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude_cli');
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('consent-accept'));
    await waitFor(() => expect(invokeMocks['llm:setProvider']).toHaveBeenCalledWith({ provider: 'claude_cli' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it('Continue stays disabled while the subscription card is not Ready', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('choose-ai-claude_cli'));
    expect(screen.getByTestId('ai-continue')).toBeDisabled();
  });

  it('Continue is focus-steal guarded for the provider switch', async () => {
    statusBy(ready());
    await paint();
    await userEvent.click(screen.getByTestId('choose-ai-claude_cli'));
    await waitFor(() => expect(screen.getByTestId('ai-continue')).toBeEnabled());
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await userEvent.click(screen.getByTestId('ai-continue'));
    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument();
  });

  it('a failed switch in onboarding does not move on', async () => {
    statusBy(ready());
    setLlmState({ consents: { ...IPC_DEFAULTS['llm:getConfig'].consents, cloud_claude_cli: true } });
    mockInvoke('llm:setProvider', () => ({ ok: false, error: { code: 'CLI_NOT_SIGNED_IN' } }));
    const onDone = await paint();
    await userEvent.click(screen.getByTestId('choose-ai-claude_cli'));
    await waitFor(() => expect(screen.getByTestId('ai-continue')).toBeEnabled());
    await userEvent.click(screen.getByTestId('ai-continue'));
    await waitFor(() => expect(screen.getByTestId('ai-use-error-claude_cli')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('the voice opt-in is checked by default on a capable machine and names its size when known', async () => {
    mockInvoke('voice:getState', () => ({
      ok: true,
      value: {
        ...IPC_DEFAULTS['voice:getState'],
        resolvedTier: 'voice-hebrew',
        model: { id: 'voice-hebrew', sizeBytes: 1_624_555_275, status: 'none', bytesDone: 0 },
      },
    }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('onboarding-voice-optin')).toBeChecked());
    expect(screen.getByTestId('onboarding-choose-ai')).toHaveTextContent(
      'Also understand voice notes (1.5 GB, Hebrew-optimised)',
    );
    expect(screen.getByTestId('onboarding-pictures-note')).toHaveTextContent('downloads only when you ask');
    // nothing is downloaded by the checkbox itself
    expect(invokeMocks['model:startDownload']).not.toHaveBeenCalled();
  });

  it('unchecked by default without enough disk (with the reason); unchecked => no voice download on Continue', async () => {
    mockInvoke('llm:getHardware', () => ({
      ok: true,
      value: { ramGiB: 16, gpus: [], freeDiskGiB: 2, recommendedTier: 'small' },
    }));
    const onDone = await paint();
    await waitFor(() => expect(screen.getByTestId('onboarding-voice-blocker')).toHaveAttribute('data-reason', 'disk'));
    expect(screen.getByTestId('onboarding-voice-optin')).not.toBeChecked();
    await waitFor(() => expect(screen.getByTestId('ai-continue')).toBeEnabled()); // the local model is ready in the fake plan
    await userEvent.click(screen.getByTestId('ai-continue'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(invokeMocks['model:startDownload']).not.toHaveBeenCalled();
  });

  it('too little memory is its own reason', async () => {
    mockInvoke('llm:getHardware', () => ({
      ok: true,
      value: { ramGiB: 4, gpus: [], freeDiskGiB: 100, recommendedTier: 'tiny' },
    }));
    await paint();
    await waitFor(() =>
      expect(screen.getByTestId('onboarding-voice-blocker')).toHaveTextContent('Needs 8 GB of memory'),
    );
  });

  it('checked => Continue stores the Hebrew tier and queues its download; a refused enabled=true falls back to the tier only', async () => {
    mockInvoke('settings:set', (patch) =>
      JSON.stringify(patch).includes('"enabled":true')
        ? { ok: false, error: { code: 'VOICE_MODEL_MISSING' } }
        : { ok: true, value: IPC_DEFAULTS['settings:get'] },
    );
    const onDone = await paint();
    await waitFor(() => expect(screen.getByTestId('onboarding-voice-optin')).toBeChecked());
    await waitFor(() => expect(screen.getByTestId('ai-continue')).toBeEnabled());
    await userEvent.click(screen.getByTestId('ai-continue'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(invokeMocks['settings:set'].mock.calls.map((c) => c[0])).toEqual([
      { voice: { enabled: true, tier: 'voice-hebrew' } },
      { voice: { tier: 'voice-hebrew' } },
    ]);
    expect(invokeMocks['model:startDownload']).toHaveBeenCalledExactlyOnceWith({ tier: 'voice-hebrew' });
  });

  it('the pictures sentence names the projector size of the current tier when the plan carries it', async () => {
    mockInvoke('model:getPlan', () => ({
      ok: true,
      value: {
        ...IPC_DEFAULTS['model:getPlan'],
        mmproj: { id: 'mmproj-small', sizeBytes: 985_654_080, status: 'none', bytesDone: 0 },
      },
    }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('onboarding-pictures-note')).toHaveTextContent('(0.9 GB)'));
  });

  it('onboarding never offers automatic mode', async () => {
    await paint();
    expect(document.querySelector('[data-testid^="auto-"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/automatic mode/i);
    const cfg: LlmConfig = IPC_DEFAULTS['llm:getConfig'];
    expect(cfg.provider).toBe('local');
  });
});

describe('ChooseAi v2 - the API-key card controls (under Advanced)', () => {
  it('show / paste / replace the key, pick a Gemini model, type a model id', async () => {
    setLlmState({
      provider: 'gemini',
      consents: { ...IPC_DEFAULTS['llm:getConfig'].consents, cloud_gemini: true },
      keys: { anthropic_api_key: { present: false, last4: '' }, gemini_api_key: { present: true, last4: '9999' } },
    });
    mockInvoke('llm:listModels', () => ({
      ok: true,
      value: {
        models: [
          { id: 'gemini-3.8-flash', displayName: 'Flash' },
          { id: 'gemini-3.8-pro', displayName: 'Pro' },
        ],
        presets: ['gemini-3.8-flash'],
      },
    }));
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve('  AIzaTESTONLY0000000000  ') },
      configurable: true,
    });
    await paint({ embedded: true });
    await waitFor(() => expect(screen.getByTestId('ai-key-saved')).toHaveTextContent('9999'));
    await userEvent.selectOptions(await screen.findByTestId('ai-model-select'), 'gemini-3.8-pro');
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ llm: { geminiModel: 'gemini-3.8-pro' } }),
    );
    const custom = screen.getByTestId('ai-model-id');
    await userEvent.clear(custom);
    await userEvent.type(custom, 'gemini-3.9-flash');
    custom.blur();
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ llm: { geminiModel: 'gemini-3.9-flash' } }),
    );
    await userEvent.click(screen.getByTestId('ai-key-replace'));
    await userEvent.click(screen.getByTestId('ai-key-show'));
    expect(screen.getByTestId('ai-key-input')).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByTestId('ai-key-paste'));
    await waitFor(() => expect(screen.getByTestId('ai-key-input')).toHaveValue('AIzaTESTONLY0000000000'));
    expect(screen.getByTestId('gemini-cli-note-key')).toBeInTheDocument();
  });

  it('"Read what is sent" reopens the consent for an API-key card without a consent', async () => {
    setLlmState({ provider: 'claude' });
    await paint({ embedded: true });
    await userEvent.click(await screen.findByTestId('ai-open-consent'));
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude');
  });

  it('the voice opt-in can be unticked', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('onboarding-voice-optin')).toBeChecked());
    await userEvent.click(screen.getByTestId('onboarding-voice-optin'));
    expect(screen.getByTestId('onboarding-voice-optin')).not.toBeChecked();
  });
});
