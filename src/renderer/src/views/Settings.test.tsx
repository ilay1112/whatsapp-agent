// Settings - the one settings page (UX 9, ARCH 12.2; owner W1-16).
// The page can neither send a message nor write to a calendar: none of its channels can. What it CAN do destructively
// always goes through a confirm dialog first, and it never sees a key, a path, a URL or a JID.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, SettingsPatchSchema, applySettingsPatch } from '@shared/settings';
import { defaultHealth, i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { SETTINGS_GROUPS, Settings } from './Settings';

beforeEach(() => {
  useHealthStore.setState({ health: defaultHealth, progress: null, hiddenSetupTasks: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, saveError: null, savedAt: 0 });
  // Every settings:set answer must be the merged result, exactly as main computes it.
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

const paint = async () => {
  render(<Settings />);
  await waitFor(() => expect(screen.getByTestId('settings')).toBeInTheDocument());
};

/** The last patch the page sent to main. */
const lastPatch = () => invokeMocks['settings:set'].mock.calls.at(-1)![0];

describe('Settings - shape', () => {
  it('shows a loading state until the settings arrive', () => {
    useSettingsStore.setState({ settings: null });
    render(<Settings />);
    expect(screen.getByTestId('settings')).toHaveTextContent('Loading');
  });

  it('renders the groups of ARCH 12.2 + UX2 4 (Automatic mode after Google Calendar) with a nav for each', async () => {
    await paint();
    expect(SETTINGS_GROUPS).toEqual(['general', 'ai', 'whatsapp', 'calendar', 'auto', 'rules', 'replies', 'privacy']);
    await waitFor(() => expect(screen.getByTestId('auto-state-card')).toBeInTheDocument());
    for (const group of SETTINGS_GROUPS) {
      expect(screen.getByTestId(`settings-group-${group}`)).toBeInTheDocument();
      expect(screen.getByTestId(`settings-nav-${group}`)).toBeInTheDocument();
    }
  });

  it('[R2] the time zone is read-only, notifications are Off/On only and there is no share-titles toggle', async () => {
    await paint();
    const zone = screen.getByTestId('settings-timezone');
    expect(zone.tagName).toBe('SPAN');
    expect(zone).toHaveTextContent('taken from Windows');

    const options = within(screen.getByTestId('settings-notifications')).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['off', 'generic']);
    expect(screen.queryByText(/share.*titles/i)).not.toBeInTheDocument();
  });
});

describe('Settings - the form is bound to the patch schema', () => {
  it('every control sends a patch the zod schema accepts, and main answers with the merged settings', async () => {
    await paint();

    await userEvent.click(screen.getByTestId('settings-autostart'));
    await waitFor(() => expect(invokeMocks['settings:set']).toHaveBeenCalled());
    expect(SettingsPatchSchema.safeParse(lastPatch()).success).toBe(true);

    await userEvent.selectOptions(screen.getByTestId('settings-notifications'), 'off');
    await waitFor(() => expect(lastPatch()).toEqual({ general: { notifications: 'off' } }));
    expect(SettingsPatchSchema.safeParse(lastPatch()).success).toBe(true);

    await userEvent.selectOptions(screen.getByTestId('settings-backlog'), '24');
    await waitFor(() => expect(lastPatch()).toEqual({ whatsapp: { backlogHours: 24 } }));

    await userEvent.selectOptions(screen.getByTestId('settings-duration'), '90');
    await waitFor(() => expect(lastPatch()).toEqual({ calendar: { defaultDurationMin: 90 } }));

    await userEvent.selectOptions(screen.getByTestId('settings-retention'), '60');
    await waitFor(() => expect(lastPatch()).toEqual({ privacy: { retentionDays: 60 } }));

    await userEvent.click(screen.getByTestId('settings-gender-f'));
    await waitFor(() => expect(lastPatch()).toEqual({ agent: { userGender: 'f' } }));

    await userEvent.click(screen.getByTestId('settings-ambiguous-ask'));
    await waitFor(() => expect(lastPatch()).toEqual({ agent: { ambiguousHour: 'ask' } }));

    await userEvent.selectOptions(screen.getByTestId('settings-acceleration'), 'off');
    await waitFor(() => expect(lastPatch()).toEqual({ llm: { local: { acceleration: 'off' } } }));

    for (const [, [patch]] of invokeMocks['settings:set'].mock.calls.entries()) {
      expect(SettingsPatchSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(true);
    }
  });

  it('the schema rejects an unknown key and the channels the dedicated handlers own', () => {
    expect(SettingsPatchSchema.safeParse({ general: { autostart: true } }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ general: { nope: true } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ nope: {} }).success).toBe(false);
    // never settable through settings:set - they have their own preconditions
    expect(SettingsPatchSchema.safeParse({ llm: { provider: 'claude' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ agent: { paused: true } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ general: { timeZone: 'Asia/Jerusalem' } }).success).toBe(false);
  });

  it('a round trip through the store leaves valid settings', async () => {
    await paint();
    await userEvent.selectOptions(screen.getByTestId('settings-retention'), '7');
    await waitFor(() => expect(useSettingsStore.getState().settings?.privacy.retentionDays).toBe(7));
    expect(useSettingsStore.getState().saveError).toBeNull();
  });

  it('reports a refused save instead of pretending it worked', async () => {
    mockInvoke('settings:set', () => ({ ok: false, error: { code: 'BAD_REQUEST' } }));
    await paint();
    await userEvent.click(screen.getByTestId('settings-autostart'));
    await waitFor(() => expect(screen.getByTestId('settings-save-error')).toBeInTheDocument());
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('shows "Saved" from the store stamp', async () => {
    await paint();
    expect(screen.queryByTestId('settings-saved')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-autostart'));
    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeInTheDocument());
  });

  it('pause has its own channel, not settings:set', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-pause'));
    await waitFor(() => expect(invokeMocks['agent:setPaused']).toHaveBeenCalledExactlyOnceWith({ paused: true }));
  });

  it('the language choice keeps the endonyms untranslated', async () => {
    await paint();
    expect(screen.getByText('Windows language')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-language-he'));
    await waitFor(() => expect(lastPatch()).toEqual({ general: { language: 'he' } }));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
  });

  it('the cloud budget is only sent when it is a valid number', async () => {
    await paint();
    const field = screen.getByTestId('settings-budget');
    await userEvent.clear(field);
    await userEvent.type(field, '1');
    await userEvent.tab();
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();

    await userEvent.clear(field);
    await userEvent.type(field, '50000');
    await userEvent.tab();
    await waitFor(() => expect(lastPatch()).toEqual({ llm: { cloudDailyTokenBudget: 50_000 } }));
  });
});

describe('Settings - destructive things ask first', () => {
  it.each([
    ['settings-relink', 'pairing:relink'],
    ['settings-wipe', 'pairing:unlinkAndWipe'],
    ['settings-google-disconnect', 'google:disconnect'],
    ['settings-purge', 'data:purgeNow'],
    ['settings-delete-model', 'model:delete'],
  ] as const)('%s only acts after the dialog is confirmed', async (testId, channel) => {
    await paint();
    await userEvent.click(screen.getByTestId(testId));
    expect(screen.getByTestId('settings-confirm')).toHaveAttribute('role', 'alertdialog');
    expect(invokeMocks[channel]).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('settings-confirm-cancel'));
    expect(invokeMocks[channel]).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId(testId));
    await userEvent.click(screen.getByTestId('settings-confirm-confirm'));
    await waitFor(() => expect(invokeMocks[channel]).toHaveBeenCalledOnce());
  });

  it('the dialog opens with the focus on the least destructive button and Escape cancels', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-wipe'));
    expect(document.activeElement).toBe(screen.getByTestId('settings-confirm-cancel'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('settings-confirm')).not.toBeInTheDocument());
    expect(invokeMocks['pairing:unlinkAndWipe']).not.toHaveBeenCalled();
  });

  it('re-linking shows the QR panel, and the code is a data: URL from main', async () => {
    mockInvoke('pairing:relink', () => ({
      ok: true,
      value: { status: 'qr_pending', qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 40_000 },
    }));
    await paint();
    await userEvent.click(screen.getByTestId('settings-relink'));
    await userEvent.click(screen.getByTestId('settings-confirm-confirm'));
    await waitFor(() => expect(screen.getByTestId('settings-relink-panel')).toBeInTheDocument());
    expect(screen.getByTestId('qr-image').getAttribute('src')).toMatch(/^data:/);
  });

  it('purging reports how much was removed', async () => {
    mockInvoke('data:purgeNow', () => ({ ok: true, value: { itemsPurged: 12 } }));
    await paint();
    await userEvent.click(screen.getByTestId('settings-purge'));
    await userEvent.click(screen.getByTestId('settings-confirm-confirm'));
    await waitFor(() => expect(screen.getByTestId('settings-purged')).toHaveTextContent('12'));
  });

  it('the licences dialog only closes', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-licences'));
    expect(screen.getByTestId('settings-licences-dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-licences-dialog-confirm'));
    await waitFor(() => expect(screen.queryByTestId('settings-licences-dialog')).not.toBeInTheDocument());
  });
});

describe('Settings - calendar and per-chat rules', () => {
  it('lists the calendars main returned and never a URL', async () => {
    await paint();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('settings-target-calendar')).getByRole('option', { name: 'Personal' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('settings-conflict-primary')).toBeChecked();
    expect(screen.getByTestId('settings-group-calendar').querySelector('a')).toBeNull();
  });

  it('unchecking the last conflict calendar is a no-op (the schema needs one)', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('settings-conflict-primary')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('settings-conflict-primary'));
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });

  it('has an empty state when no chat carries a rule', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('settings-ignored-empty')).toBeInTheDocument());
  });

  it('[R2] offers exactly the two policies and re-reads the list after a change', async () => {
    mockInvoke('chat:listPolicies', () => ({
      ok: true,
      value: {
        chats: [
          {
            chatRef: 7,
            displayName: '',
            phoneDisplay: '+972 55-000-0001',
            sendable: true,
            isKnown: true,
            policy: 'never',
            autoPolicy: 'inherit', // [V2]
          },
        ],
      },
    }));
    await paint();
    const select = await screen.findByTestId('settings-policy-select-7');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['default', 'never']);

    await userEvent.selectOptions(select, 'default');
    await waitFor(() =>
      expect(invokeMocks['chat:setPolicy']).toHaveBeenCalledExactlyOnceWith({ chatRef: 7, policy: 'default' }),
    );
    await waitFor(() => expect(invokeMocks['chat:listPolicies'].mock.calls.length).toBeGreaterThan(1));
  });

  it('a chat is addressed by chatRef - no JID ever reaches the renderer', async () => {
    mockInvoke('chat:listPolicies', () => ({
      ok: true,
      value: {
        chats: [
          {
            chatRef: 7,
            displayName: '',
            phoneDisplay: '+972 55-000-0001',
            sendable: true,
            isKnown: true,
            policy: 'never',
            autoPolicy: 'inherit', // [V2]
          },
        ],
      },
    }));
    await paint();
    await screen.findByTestId('settings-policy-7');
    // Neither the visible text nor any attribute value may carry a JID.
    const attributes = [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value));
    for (const text of [document.body.textContent ?? '', ...attributes]) {
      expect(text).not.toContain('@s.whatsapp.net');
      expect(text).not.toContain('@lid');
    }
  });
});

describe('Settings - privacy', () => {
  it('has one table row per data recipient', async () => {
    await paint();
    const table = screen.getByTestId('settings-privacy-table');
    expect(within(table).getAllByRole('row')).toHaveLength(9); // head + eight recipients (UX2 4.8)
    expect(table).toHaveTextContent('without names or phone numbers');
    expect(table).toHaveTextContent('The replies you approved');
  });

  it('exports diagnostics through its own channel', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-diagnostics'));
    await waitFor(() => expect(invokeMocks['diagnostics:export']).toHaveBeenCalledOnce());
  });
});

describe('Settings - the AI group reuses the onboarding cards', () => {
  it('embeds ChooseAi and never shows a key', async () => {
    mockInvoke('llm:getConfig', () => ({
      ok: true,
      value: {
        provider: 'claude',
        claudeModel: 'claude-opus-5',
        geminiModel: 'gemini-3.8-flash',
        local: { tier: 'auto', acceleration: 'auto', forceCpu: false },
        keys: { anthropic_api_key: { present: true, last4: '9876' }, gemini_api_key: { present: false, last4: '' } },
        consents: {
          whatsapp_tos: true,
          cloud_claude: true,
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
      },
    }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('onboarding-choose-ai')).toHaveAttribute('data-embedded', '1'));
    await waitFor(() => expect(screen.getByTestId('ai-key-saved')).toHaveTextContent('9876'));
    expect(screen.queryByTestId('ai-key-input')).not.toBeInTheDocument();
  });

  it('reports the measured speed after a self test', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-self-test'));
    await waitFor(() => expect(screen.getByTestId('settings-speed')).toHaveTextContent('Good'));

    mockInvoke('model:selfTest', () => ({ ok: true, value: { ok: true, tokPerSec: 1, usedCpuFallback: true } }));
    await userEvent.click(screen.getByTestId('settings-self-test'));
    await waitFor(() => expect(screen.getByTestId('settings-speed')).toHaveTextContent('Slow'));
  });
});

describe('Settings - RTL', () => {
  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    const { container } = render(<Settings />);
    await waitFor(() => expect(screen.getByTestId('settings')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('settings-ignored-empty')).toBeInTheDocument());
    expect(container.firstChild).toMatchSnapshot();
  });

  it('opens at the requested group', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    render(<Settings initialGroup="privacy" />);
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveAttribute('data-group', 'privacy'));
    expect(spy).toHaveBeenCalled();
  });
});
