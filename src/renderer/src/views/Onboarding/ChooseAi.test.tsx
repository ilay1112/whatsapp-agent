// ChooseAi - step 1 and the "AI engine" group of Settings (UX 8.1, UX 9, ARCH 12.1, A20; owner W1-16).
// The rules under test are structural, not cosmetic: no cloud provider without a current-version consent record, and
// the key is never readable again after it was handed to main.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONSENT_VERSIONS, type LlmConfig } from '@shared/types';
import { i18next, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import {
  ChooseAi,
  KEY_RE,
  consentKindOf,
  keyErrorKeyOf,
  keyHelpTargetOf,
  orderedModels,
  secretNameOf,
} from './ChooseAi';

const baseConfig: LlmConfig = {
  provider: 'local',
  claudeModel: 'claude-opus-5',
  geminiModel: 'gemini-3.8-flash',
  local: { tier: 'auto', acceleration: 'auto', forceCpu: false },
  keys: { anthropic_api_key: { present: false, last4: '' }, gemini_api_key: { present: false, last4: '' } },
  consents: {
    whatsapp_tos: true,
    cloud_claude: false,
    cloud_gemini: false,
    cloud_claude_cli: false,
    cloud_antigravity_cli: false,
  },
  usageToday: { inputTokens: 0, outputTokens: 0, budget: 200_000 },
  cli: {
    claudeModel: 'sonnet',
    agyModel: 'gemini-3.8-flash-high',
    maxRunsPerHour: 20,
    allowOverage: false,
    claudeExePathSet: false,
  }, // [V2]
  quota: null, // [V2]
};
/**
 * `llm:setProvider` answers with the WHOLE config in production, so a test whose config differs from the default has to
 * teach both channels - otherwise switching provider would hand the view a stale consent map.
 */
const withConfig = (patch: Partial<LlmConfig> = {}) => {
  const value = { ...baseConfig, ...patch };
  mockInvoke('llm:getConfig', () => ({ ok: true, value }));
  mockInvoke('llm:setProvider', (req) => ({
    ok: true,
    value: { ...value, provider: (req as { provider: LlmConfig['provider'] }).provider },
  }));
};

const KEY = 'sk-ant-TESTONLY-0000000000000000';

const paint = async (props: Partial<Parameters<typeof ChooseAi>[0]> = {}) => {
  const onDone = props.onDone ?? vi.fn();
  render(<ChooseAi onDone={onDone} onBack={props.onBack ?? (() => {})} embedded={props.embedded} />);
  await waitFor(() => expect(screen.getByTestId('onboarding-choose-ai')).toBeInTheDocument());
  await waitFor(() => expect(invokeMocks['model:getPlan']).toHaveBeenCalled());
  return onDone;
};

/** [V2] the API-key cards live under 'Advanced: use an API key' (UX2 4.1): open it first when it is still collapsed. */
const pick = async (provider: 'claude' | 'gemini') => {
  if (!screen.queryByTestId(`choose-ai-${provider}`)) await userEvent.click(screen.getByTestId('ai-advanced'));
  await userEvent.click(screen.getByTestId(`choose-ai-${provider}`));
};

describe('pure helpers', () => {
  it('maps a cloud provider to its consent kind, secret name and help target', () => {
    expect(consentKindOf('claude')).toBe('cloud_claude');
    expect(consentKindOf('gemini')).toBe('cloud_gemini');
    expect(secretNameOf('claude')).toBe('anthropic_api_key');
    expect(secretNameOf('gemini')).toBe('gemini_api_key');
    expect(keyHelpTargetOf('claude')).toBe('anthropic_api_keys');
    expect(keyHelpTargetOf('gemini')).toBe('gemini_api_keys');
  });

  it('KEY_RE accepts printable ASCII of a plausible length only', () => {
    expect(KEY_RE.test(KEY)).toBe(true);
    expect(KEY_RE.test('short')).toBe(false);
    expect(KEY_RE.test('has space in it here')).toBe(false);
    expect(KEY_RE.test('מפתחמפתחמפתח')).toBe(false);
  });

  it.each([
    ['KEY_INVALID', 'auth'],
    ['CLOUD_QUOTA', 'billing'],
    ['CLOUD_UNAVAILABLE', 'network'],
    ['MODEL_NOT_FOUND', 'model_not_found'],
    ['BAD_REQUEST', 'other'],
  ] as const)('%s -> the %s row', (code, row) => {
    expect(keyErrorKeyOf(code)).toBe(row);
  });

  it('orderedModels puts the live presets first and keeps the current id', () => {
    const list = {
      models: [
        { id: 'other-1', displayName: 'Other 1' },
        { id: 'claude-opus-5', displayName: 'Opus 5' },
      ],
      presets: ['claude-opus-5', 'not-available'],
    };
    expect(orderedModels(list, 'claude-opus-5').map((m) => m.id)).toEqual(['claude-opus-5', 'other-1']);
    expect(orderedModels(list, 'gone').map((m) => m.id)).toEqual(['gone', 'claude-opus-5', 'other-1']);
    expect(orderedModels(null, undefined)).toEqual([]);
  });
});

describe('ChooseAi - local', () => {
  it('is step 1, offers the cards in the B12 order and recommends the local one', async () => {
    await paint();
    expect(screen.getByTestId('onboarding-step-1')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'AI engine' })).toBeInTheDocument();
    // [V2] UX2 4.1 / 6: local + Claude subscription visible; the experimental and API-key cards sit behind disclosures
    expect(screen.queryByTestId('choose-ai-antigravity_cli')).not.toBeInTheDocument();
    expect(screen.queryByTestId('choose-ai-claude')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-show-experimental')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('ai-advanced')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByTestId('ai-show-experimental'));
    await userEvent.click(screen.getByTestId('ai-advanced'));
    const order = [...document.querySelectorAll('[data-testid^="choose-ai-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual([
      'choose-ai-local',
      'choose-ai-claude_cli',
      'choose-ai-antigravity_cli',
      'choose-ai-claude',
      'choose-ai-gemini',
    ]);
    expect(screen.getByTestId('choose-ai-local')).toBeChecked();
  });

  it('describes the hardware in plain words', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('ai-local-body')).toHaveTextContent('16 GB of memory'));
    expect(screen.getByTestId('ai-local-body')).toHaveTextContent('no dedicated graphics card');
    expect(screen.getByTestId('ai-local-body')).toHaveTextContent('100 GB free');
  });

  it('starts the download and moves on at once - it keeps running in the background', async () => {
    mockInvoke('model:getPlan', () => ({
      ok: true,
      value: {
        recommendedTier: 'small',
        selectedTier: 'small',
        tiers: [
          {
            tier: 'tiny',
            modelLabel: 't',
            sizeBytes: 3_106_738_272,
            status: 'none',
            bytesDone: 0,
            fitsDisk: true,
            tokPerSec: null,
          },
          {
            tier: 'small',
            modelLabel: 's',
            sizeBytes: 4_977_171_584,
            status: 'none',
            bytesDone: 0,
            fitsDisk: true,
            tokPerSec: null,
          },
          {
            tier: 'mid',
            modelLabel: 'm',
            sizeBytes: 6_716_356_800,
            status: 'none',
            bytesDone: 0,
            fitsDisk: true,
            tokPerSec: null,
          },
        ],
        suggestSmaller: false,
        mmproj: null, // [V2]
      },
    }));
    const onDone = await paint();
    await userEvent.click(await screen.findByTestId('ai-download'));
    await waitFor(() => expect(invokeMocks['model:startDownload']).toHaveBeenCalledWith({ tier: 'small' }));
    // [V2] UX2 6: the voice opt-in (checked by default on this 16 GB / 100 GB machine) queues BEHIND the AI model
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(invokeMocks['model:startDownload'].mock.calls.map((c) => c[0])).toEqual([
      { tier: 'small' },
      { tier: 'voice-hebrew' },
    ]);
    expect(screen.getByTestId('ai-local-downloading')).toBeInTheDocument();
  });

  it('refuses to start a download that does not fit the disk, and can re-probe', async () => {
    mockInvoke('model:getPlan', () => ({
      ok: true,
      value: {
        recommendedTier: 'small',
        selectedTier: 'small',
        tiers: [
          {
            tier: 'small',
            modelLabel: 's',
            sizeBytes: 4_977_171_584,
            status: 'none',
            bytesDone: 0,
            fitsDisk: false,
            tokPerSec: null,
          },
        ],
        suggestSmaller: true,
        mmproj: null, // [V2]
      },
    }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('ai-disk-warning')).toBeInTheDocument());
    expect(screen.getByTestId('ai-download')).toBeDisabled();

    const before = invokeMocks['model:getPlan'].mock.calls.length;
    await userEvent.click(screen.getByTestId('ai-check-again'));
    await waitFor(() => expect(invokeMocks['model:getPlan'].mock.calls.length).toBeGreaterThan(before));
  });

  it('a ready model needs no download at all', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('ai-local-ready')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-download')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-continue')).toBeEnabled();
  });

  it('a different size can be chosen and its note explains the trade-off', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('ai-size-toggle'));
    const select = screen.getByTestId('ai-size-select');
    expect(within(select).getAllByRole('option')).toHaveLength(4); // auto + three tiers
    await userEvent.selectOptions(select, 'mid');
    expect(screen.getByTestId('ai-size-note')).toHaveTextContent('without a graphics card');
  });
});

describe('ChooseAi - the cloud consent gate', () => {
  it('choosing a cloud provider opens the blocking consent first and sets nothing', async () => {
    await paint();
    await pick('claude');
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude');
    expect(invokeMocks['consent:accept']).not.toHaveBeenCalled();
    expect(invokeMocks['llm:setProvider']).not.toHaveBeenCalledWith({ provider: 'claude' });
  });

  it('declining leaves Local selected and changes nothing in main', async () => {
    await paint();
    await pick('claude');
    await userEvent.click(screen.getByTestId('consent-cancel'));

    expect(screen.queryByTestId('consent-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('choose-ai-local')).toBeChecked();
    expect(invokeMocks['consent:accept']).not.toHaveBeenCalled();
    expect(invokeMocks['llm:setProvider']).not.toHaveBeenCalledWith({ provider: 'claude' });
  });

  it('accepting records the versioned consent before the provider is switched', async () => {
    await paint();
    await pick('gemini');
    await userEvent.click(screen.getByTestId('consent-accept'));

    await waitFor(() =>
      expect(invokeMocks['consent:accept']).toHaveBeenCalledExactlyOnceWith({
        kind: 'cloud_gemini',
        version: CONSENT_VERSIONS.cloud_gemini,
      }),
    );
    await waitFor(() => expect(invokeMocks['llm:setProvider']).toHaveBeenCalledWith({ provider: 'gemini' }));
    const order = invokeMocks['consent:accept'].mock.invocationCallOrder[0]!;
    expect(invokeMocks['llm:setProvider'].mock.invocationCallOrder.at(-1)!).toBeGreaterThan(order);
  });

  it('a refused consent falls back to Local and shows the reason', async () => {
    mockInvoke('consent:accept', () => ({ ok: false, error: { code: 'CONSENT_REQUIRED' } }));
    await paint();
    await pick('claude');
    await userEvent.click(screen.getByTestId('consent-accept'));

    await waitFor(() => expect(screen.getByTestId('ai-provider-error')).toBeInTheDocument());
    expect(screen.getByTestId('choose-ai-local')).toBeChecked();
  });

  it('a refused llm:setProvider never silently falls back', async () => {
    withConfig({
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
    });
    mockInvoke('llm:setProvider', () => ({ ok: false, error: { code: 'CONSENT_REQUIRED' } }));
    await paint();
    await pick('claude');
    await waitFor(() => expect(screen.getByTestId('ai-provider-error')).toBeInTheDocument());
    expect(screen.getByTestId('ai-provider-error')).toHaveAttribute('role', 'alert');
  });
});

describe('ChooseAi - the key never comes back', () => {
  it('rejects a paste that cannot be a key without calling main', async () => {
    withConfig({
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
    });
    await paint();
    await pick('claude');
    await userEvent.type(await screen.findByTestId('ai-key-input'), 'nope');
    await userEvent.click(screen.getByTestId('ai-key-check'));

    expect(screen.getByTestId('ai-key-error')).toHaveTextContent('does not look like a key');
    expect(invokeMocks['secrets:set']).not.toHaveBeenCalled();
  });

  it('hands the key to main, validates it, and then shows only the last four characters', async () => {
    // main is stateful: the key exists only after `secrets:set`, and `llm:setProvider` answers with the whole config.
    const store = { anthropic_api_key: { present: false, last4: '' }, gemini_api_key: { present: false, last4: '' } };
    const config = () => ({
      ...baseConfig,
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
      keys: { ...store },
    });
    withConfig({
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
    });
    mockInvoke('llm:getConfig', () => ({ ok: true, value: config() }));
    mockInvoke('llm:setProvider', () => ({ ok: true, value: { ...config(), provider: 'claude' } }));
    mockInvoke('secrets:set', () => {
      store.anthropic_api_key = { present: true, last4: '0000' };
      return { ok: true, value: store.anthropic_api_key };
    });
    await paint();
    await pick('claude');
    const field = await screen.findByTestId('ai-key-input');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('dir', 'ltr');

    await userEvent.type(field, KEY);
    await userEvent.click(screen.getByTestId('ai-key-check'));

    await waitFor(() =>
      expect(invokeMocks['secrets:set']).toHaveBeenCalledExactlyOnceWith({ name: 'anthropic_api_key', value: KEY }),
    );
    await waitFor(() => expect(screen.getByTestId('ai-key-saved')).toBeInTheDocument());
    expect(invokeMocks['llm:validateKey']).toHaveBeenCalledWith({ provider: 'claude' });

    // Nothing on the screen contains the key any more - only its last four characters.
    expect(document.body.textContent).not.toContain(KEY);
    expect(screen.getByTestId('ai-key-saved')).toHaveTextContent('0000');
    expect(screen.queryByTestId('ai-key-input')).not.toBeInTheDocument();
  });

  it('a rejected key names the provider in the failure row', async () => {
    withConfig({
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
    });
    mockInvoke('llm:validateKey', () => ({ ok: false, error: { code: 'KEY_INVALID' } }));
    await paint();
    await pick('claude');
    await userEvent.type(await screen.findByTestId('ai-key-input'), KEY);
    await userEvent.click(screen.getByTestId('ai-key-check'));
    await waitFor(() =>
      expect(screen.getByTestId('ai-key-error')).toHaveTextContent('Anthropic did not accept this key'),
    );
  });

  it('a saved key can be replaced or removed, and removing it clears the secret in main', async () => {
    withConfig({
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
      keys: { anthropic_api_key: { present: true, last4: '1234' }, gemini_api_key: { present: false, last4: '' } },
    });
    await paint();
    await pick('claude');
    await waitFor(() => expect(screen.getByTestId('ai-key-saved')).toHaveTextContent('1234'));

    await userEvent.click(screen.getByTestId('ai-key-remove'));
    await waitFor(() =>
      expect(invokeMocks['secrets:clear']).toHaveBeenCalledExactlyOnceWith({ name: 'anthropic_api_key' }),
    );
    await waitFor(() => expect(screen.getByTestId('ai-key-input')).toBeInTheDocument());
  });

  it('the help button opens an enum target, never a URL', async () => {
    withConfig({
      consents: {
        whatsapp_tos: true,
        cloud_claude: true,
        cloud_gemini: false,
        cloud_claude_cli: false,
        cloud_antigravity_cli: false,
      },
    });
    await paint();
    await pick('claude');
    await userEvent.click(await screen.findByTestId('ai-key-help'));
    expect(invokeMocks['external:open']).toHaveBeenCalledExactlyOnceWith({ target: 'anthropic_api_keys' });
  });
});

describe('ChooseAi - embedded in Settings', () => {
  it('drops the wizard chrome but keeps the same cards', async () => {
    await paint({ embedded: true });
    expect(screen.getByTestId('onboarding-choose-ai')).toHaveAttribute('data-embedded', '1');
    expect(screen.queryByTestId('onboarding-step-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-continue')).not.toBeInTheDocument();
    expect(screen.getByTestId('choose-ai-local')).toBeInTheDocument();
  });

  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    const { container } = render(<ChooseAi onDone={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('ai-local-body')).toBeInTheDocument());
    expect(container.firstChild).toMatchSnapshot();
  });
});
