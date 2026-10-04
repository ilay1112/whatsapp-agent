// ReadTools - Working rules > "Let the AI read older messages" (UX2 4.7, 13; B17, B21, F11; owner V2-W1-12).
// The two scope radios call wa:setReadScope - never settings:set; "all chats" with a cloud provider needs its current
// consent first and is refused until then.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProviderId } from '@shared/types';
import { DEFAULT_SETTINGS, SettingsPatchSchema, applySettingsPatch, type Settings } from '@shared/settings';
import { defaultHealth, invokeMocks, mockInvoke } from '../../../../../tests/setup-renderer';
import { useHealthStore } from '../../store/health';
import { useSettingsStore } from '../../store/settings';
import { ReadTools } from './ReadTools';

const withReadTools = (patch: Partial<Settings['whatsapp']['readTools']>): Settings => ({
  ...DEFAULT_SETTINGS,
  whatsapp: { ...DEFAULT_SETTINGS.whatsapp, readTools: { ...DEFAULT_SETTINGS.whatsapp.readTools, ...patch } },
});
const withProvider = (provider: ProviderId) =>
  useHealthStore.setState({ health: { ...defaultHealth, llm: { ...defaultHealth.llm, provider } } });

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  withProvider('local');
  mockInvoke('settings:set', (patch) => ({
    ok: true,
    value: applySettingsPatch(useSettingsStore.getState().settings ?? DEFAULT_SETTINGS, patch as never),
  }));
});

describe('ReadTools', () => {
  it('shows the current scope; "this chat only" is recommended', () => {
    render(<ReadTools />);
    expect(screen.getByTestId('settings-readtools-trigger_chat')).toBeChecked();
    expect(screen.getByTestId('settings-row-readtools')).toHaveTextContent('recommended');
  });

  it('Off is settings:set readTools.enabled=false; the scope is never in a settings:set patch', async () => {
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-off'));
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledExactlyOnceWith({
        whatsapp: { readTools: { enabled: false } },
      }),
    );
    expect(SettingsPatchSchema.safeParse({ whatsapp: { readTools: { scope: 'all_chats' } } }).success).toBe(false);
  });

  it('local AI: "all my chats" goes straight to wa:setReadScope (main shows its native confirmation)', async () => {
    mockInvoke('wa:setReadScope', () => ({ ok: true, value: { scope: 'all_chats' } }));
    mockInvoke('settings:get', () => ({ ok: true, value: withReadTools({ scope: 'all_chats' }) }));
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    await waitFor(() => expect(invokeMocks['wa:setReadScope']).toHaveBeenCalledExactlyOnceWith({ scope: 'all_chats' }));
    for (const call of invokeMocks['settings:set'].mock.calls) expect(JSON.stringify(call[0])).not.toContain('scope');
    await waitFor(() => expect(screen.getByTestId('settings-readtools-all_chats')).toBeChecked());
  });

  it('a cancelled native confirmation leaves the scope where main says it is', async () => {
    mockInvoke('wa:setReadScope', () => ({ ok: true, value: { scope: 'trigger_chat' } }));
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    await waitFor(() => expect(invokeMocks['wa:setReadScope']).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('settings-readtools-trigger_chat')).toBeChecked());
  });

  it('with a cloud provider and no current consent: the consent dialog opens and the change is REFUSED', async () => {
    withProvider('claude');
    render(<ReadTools />);
    expect(screen.getByTestId('settings-row-readtools')).toHaveTextContent('sends parts of other chats to Anthropic');
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    await waitFor(() => expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_claude'));
    expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-version', '2');
    expect(screen.getByTestId('settings-readtools-refused')).toHaveTextContent('Not changed');
    expect(invokeMocks['wa:setReadScope']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('consent-cancel'));
    expect(invokeMocks['wa:setReadScope']).not.toHaveBeenCalled();
  });

  it('accepting the consent records the exact version, then asks main for the scope', async () => {
    withProvider('claude_cli');
    mockInvoke('wa:setReadScope', () => ({ ok: true, value: { scope: 'all_chats' } }));
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    await userEvent.click(await screen.findByTestId('consent-accept'));
    await waitFor(() =>
      expect(invokeMocks['consent:accept']).toHaveBeenCalledExactlyOnceWith({ kind: 'cloud_claude_cli', version: 1 }),
    );
    await waitFor(() => expect(invokeMocks['wa:setReadScope']).toHaveBeenCalledExactlyOnceWith({ scope: 'all_chats' }));
    expect(screen.queryByTestId('settings-readtools-refused')).not.toBeInTheDocument();
  });

  it('a current consent skips the dialog; CONSENT_REQUIRED from main still refuses and opens it', async () => {
    withProvider('gemini');
    mockInvoke('consent:get', () => ({
      ok: true,
      value: { kind: 'cloud_gemini', currentVersion: 2, acceptedVersion: 2, acceptedAt: 1 },
    }));
    mockInvoke('wa:setReadScope', () => ({ ok: false, error: { code: 'CONSENT_REQUIRED' } }));
    render(<ReadTools />);
    await userEvent.click(screen.getByTestId('settings-readtools-all_chats'));
    await waitFor(() => expect(invokeMocks['wa:setReadScope']).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('consent-dialog')).toHaveAttribute('data-kind', 'cloud_gemini'));
    expect(screen.getByTestId('settings-readtools-refused')).toBeInTheDocument();
  });

  it('turning it back on from Off enables first (settings:set), then sets the scope (wa:setReadScope)', async () => {
    useSettingsStore.setState({ settings: withReadTools({ enabled: false, scope: 'all_chats' }) });
    render(<ReadTools />);
    expect(screen.getByTestId('settings-readtools-off')).toBeChecked();
    expect(screen.getByTestId('settings-readtools-days')).toBeDisabled();
    await userEvent.click(screen.getByTestId('settings-readtools-trigger_chat'));
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ whatsapp: { readTools: { enabled: true } } }),
    );
    await waitFor(() => expect(invokeMocks['wa:setReadScope']).toHaveBeenCalledWith({ scope: 'trigger_chat' }));
  });

  it('the days slider: 1..90, aria-valuetext in words, committed on release', async () => {
    render(<ReadTools />);
    const slider = screen.getByTestId('settings-readtools-days');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '90');
    expect(slider).toHaveAttribute('aria-valuetext', '30 days');
    fireEvent.change(slider, { target: { value: '45' } });
    expect(slider).toHaveAttribute('aria-valuetext', '45 days');
    fireEvent.pointerUp(slider, { target: { value: '45' } });
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledExactlyOnceWith({
        whatsapp: { readTools: { windowDays: 45 } },
      }),
    );
    fireEvent.change(slider, { target: { value: '1' } });
    expect(slider).toHaveAttribute('aria-valuetext', '1 day');
    fireEvent.keyUp(slider, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenLastCalledWith({ whatsapp: { readTools: { windowDays: 1 } } }),
    );
    fireEvent.blur(slider);
  });

  it('antigravity_cli: the prefetch note', () => {
    withProvider('antigravity_cli');
    render(<ReadTools />);
    expect(screen.getByTestId('settings-readtools-agy')).toHaveTextContent('the last 30 days of this chat');
  });

  it('renders nothing without settings', () => {
    useSettingsStore.setState({ settings: null });
    const { container } = render(<ReadTools />);
    expect(container).toBeEmptyDOMElement();
  });
});
