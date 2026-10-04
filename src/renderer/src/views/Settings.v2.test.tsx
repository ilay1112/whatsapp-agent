// Settings v2 - group order, the Automatic mode group and its activity sub-page, the Google Calendar role line, the
// per-contact "Automatic" column, the voice / pictures / read-older-messages rows and the v2 privacy table
// (UX2 4, 13, 15; owner V2-W1-12). No automatic-mode control is bound to settings:set.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState, ChatView } from '@shared/types';
import { DEFAULT_SETTINGS, applySettingsPatch } from '@shared/settings';
import { DEFAULT_AUTO_SCOPE } from '@shared/schemas';
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
import { PRIVACY_ROWS, Settings } from './Settings';

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

const paint = async (initialGroup?: Parameters<typeof Settings>[0]['initialGroup']) => {
  render(<Settings initialGroup={initialGroup} />);
  await waitFor(() =>
    expect(screen.getByTestId(initialGroup === 'activity' ? 'auto-activity' : 'settings')).toBeInTheDocument(),
  );
};

describe('Settings v2 - shape', () => {
  it('group order: ... Google Calendar - Automatic mode - Working rules ...; the AI group carries Voice notes and Pictures', async () => {
    await paint();
    await waitFor(() => expect(screen.getByTestId('auto-state-card')).toBeInTheDocument());
    const ids = [...document.querySelectorAll('section[data-testid^="settings-group-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'settings-group-general',
      'settings-group-ai',
      'settings-group-whatsapp',
      'settings-group-calendar',
      'settings-group-auto',
      'settings-group-rules',
      'settings-group-replies',
      'settings-group-privacy',
    ]);
    const ai = screen.getByTestId('settings-group-ai');
    expect(within(ai).getByTestId('settings-voice')).toBeInTheDocument();
    expect(within(ai).getByTestId('settings-images')).toBeInTheDocument();
    expect(within(ai).getByTestId('settings-cli-limits')).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-auto')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-nav-activity')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-row-budget')).toHaveTextContent('(API keys only)');
    expect(screen.getByTestId('settings-row-notifications')).toHaveTextContent(
      'Automatic calendar changes always show a notification, even when this is off.',
    );
  });

  it('hydrates AutoState when the store is empty (a READ, never an enable)', async () => {
    await paint();
    await waitFor(() => expect(invokeMocks['auto:getState']).toHaveBeenCalled());
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
  });

  it('opens at the Automatic mode group, and "See automatic activity" -> the sub-page -> back to the group', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    await paint('auto');
    await waitFor(() => expect(screen.getByTestId('auto-open-activity')).toBeInTheDocument());
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId('auto-open-activity'));
    expect(screen.getByTestId('auto-activity')).toBeInTheDocument();
    expect(screen.queryByTestId('settings')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('auto-activity-back'));
    await waitFor(() => expect(screen.getByTestId('settings-group-auto')).toBeInTheDocument());
  });

  it('initialGroup "activity" opens the sub-page directly', async () => {
    await paint('activity');
    expect(screen.getByTestId('auto-activity')).toBeInTheDocument();
  });

  it('shows a loading placeholder for the auto group until AutoState arrives', async () => {
    mockInvoke('auto:getState', () => new Promise(() => {}) as never);
    await paint();
    expect(screen.getByTestId('settings-group-auto')).toHaveTextContent('Loading');
  });
});

describe('Settings v2 - Google Calendar role line (UX2 4.4)', () => {
  it.each([
    ['owner', 'You own this calendar'],
    ['writer', 'shared with you - automatic mode is not available'],
  ] as const)('%s -> "%s"', async (role, text) => {
    mockInvoke('google:listCalendars', () => ({
      ok: true,
      value: {
        calendars: [
          {
            id: 'primary',
            name: 'Family',
            primary: true,
            timeZone: 'Asia/Jerusalem',
            writable: true,
            accessRole: role,
          },
        ],
      },
    }));
    await paint();
    await waitFor(() => expect(screen.getByTestId('settings-calendar-role')).toHaveAttribute('data-role', role));
    expect(screen.getByTestId('settings-calendar-role')).toHaveTextContent(text);
  });
});

describe('Settings v2 - per-contact "Automatic" column (UX2 4.5)', () => {
  it('"Never" sends chat:setPolicy {chatRef, autoPolicy} and re-reads the list', async () => {
    const chat: ChatView = { ...defaultChat, chatRef: 7, displayName: 'Dana', policy: 'never', autoPolicy: 'inherit' };
    mockInvoke('chat:listPolicies', () => ({ ok: true, value: { chats: [chat] } }));
    await paint();
    const select = await screen.findByTestId('settings-policy-auto-7');
    expect(select).toHaveValue('inherit');
    const before = invokeMocks['chat:listPolicies'].mock.calls.length;
    await userEvent.selectOptions(select, 'never');
    await waitFor(() =>
      expect(invokeMocks['chat:setPolicy']).toHaveBeenCalledExactlyOnceWith({ chatRef: 7, autoPolicy: 'never' }),
    );
    await waitFor(() => expect(invokeMocks['chat:listPolicies'].mock.calls.length).toBeGreaterThan(before));
  });
});

describe('Settings v2 - privacy table (UX2 4.8)', () => {
  it('lists every recipient, providers never selected included', async () => {
    await paint();
    const table = screen.getByTestId('settings-privacy-table');
    expect(PRIVACY_ROWS).toHaveLength(8);
    expect(within(table).getAllByRole('row')).toHaveLength(PRIVACY_ROWS.length + 1);
    expect(table).toHaveTextContent('Claude - your subscription');
    expect(table).toHaveTextContent('never pictures');
    expect(table).toHaveTextContent('Nothing - transcribed on this computer');
    expect(table).toHaveTextContent('automatic mode made');
  });

  it('the purge dialog says pictures and voice transcripts go too', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-purge'));
    expect(screen.getByTestId('settings-confirm')).toHaveTextContent('Pictures and voice transcripts are deleted too.');
  });
});

describe('Settings v2 - no automatic-mode control is bound to settings:set (UX2 15.2)', () => {
  it('every click in the Automatic mode group leaves settings:set untouched', async () => {
    const state: AutoState = IPC_DEFAULTS['auto:getState'];
    mockInvoke('auto:getState', () => ({
      ok: true,
      value: { ...state, preconditions: { ...state.preconditions, approvedCreates: 3 } },
    }));
    await paint();
    const group = await screen.findByTestId('settings-group-auto');
    await waitFor(() => expect(within(group).getByTestId('auto-enable-trial')).toBeInTheDocument());
    for (const id of ['auto-scope-edits', 'auto-scope-cancels', 'auto-scope-quiet'])
      await userEvent.click(within(group).getByTestId(id));
    await userEvent.selectOptions(within(group).getByTestId('auto-scope-validity'), '90');
    await userEvent.click(within(group).getByTestId('auto-enable-trial'));
    await waitFor(() => expect(invokeMocks['auto:requestEnable']).toHaveBeenCalledOnce());
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });
});

describe('Settings v2 - the remaining controls address their own channels', () => {
  it('nav, Google reconnect / replace key, target calendar, unknown senders, remove rule, pushes', async () => {
    const chat: ChatView = { ...defaultChat, chatRef: 8, policy: 'never', autoPolicy: 'never' };
    mockInvoke('chat:listPolicies', () => ({ ok: true, value: { chats: [chat] } }));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await paint();
    await userEvent.click(screen.getByTestId('settings-nav-privacy'));
    expect(scroll).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-google-reconnect'));
    await waitFor(() => expect(invokeMocks['google:startSignIn']).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByTestId('settings-google-replace'));
    await waitFor(() => expect(invokeMocks['google:pickCredentialsFile']).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('settings-target-calendar')).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId('settings-target-calendar'), 'primary');
    await userEvent.click(screen.getByTestId('settings-unknown-senders'));
    await waitFor(() =>
      expect(invokeMocks['settings:set']).toHaveBeenCalledWith({ whatsapp: { processUnknownSenders: true } }),
    );
    await userEvent.click(await screen.findByTestId('settings-policy-remove-8'));
    await waitFor(() => expect(invokeMocks['chat:setPolicy']).toHaveBeenCalledWith({ chatRef: 8, policy: 'default' }));
    emitPush('google:changed', { ...IPC_DEFAULTS['google:getWizardState'], accountEmail: 'user@example.test' });
    await waitFor(() => expect(screen.getByTestId('settings-google-account')).toHaveTextContent('user@example.test'));
    emitPush('pairing:changed', { status: 'connected' });
  });

  it('the licences dialog cancels; "Saved" clears itself after 2 s', async () => {
    await paint();
    await userEvent.click(screen.getByTestId('settings-licences'));
    await userEvent.click(screen.getByTestId('settings-licences-dialog-cancel'));
    expect(screen.queryByTestId('settings-licences-dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-autostart'));
    await waitFor(() => expect(screen.getByTestId('settings-saved')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('settings-saved')).not.toBeInTheDocument(), { timeout: 3000 });
  });
});

// REPAIR v2-renderer-defects (V2-W2-03 REQUEST 2): Settings > Automatic mode never shows a stale AutoState. The store
// is re-read (a READ, never an enable) when Settings opens even if it already holds a state, when the Automatic mode
// group is opened again, and while Settings is open on every push that can change it (auto:changed, dashboard:changed).
describe('Settings v2 - Automatic mode is never stale (REQUEST 2)', () => {
  const base: AutoState = IPC_DEFAULTS['auto:getState'];
  const withCreates = (approvedCreates: number): AutoState => ({
    ...base,
    preconditions: { ...base.preconditions, approvedCreates },
  });
  const reason = () => screen.queryByTestId('auto-precondition')?.getAttribute('data-reason') ?? null;

  it('re-reads on open although the store already holds a (stale) state', async () => {
    useAutoStore.setState({ state: withCreates(2) });
    mockInvoke('auto:getState', () => ({ ok: true, value: withCreates(3) }));
    await paint('auto');
    await waitFor(() => expect(screen.getByTestId('auto-enable-trial')).toBeInTheDocument());
    expect(reason()).toBeNull();
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
  });

  it('auto:changed while open replaces the group state (shadow -> "End trial")', async () => {
    const off = useAutoStore.getState().subscribe(); // App holds this subscription for the whole window
    await paint('auto');
    await waitFor(() => expect(reason()).toBe('trackRecord'));
    emitPush('auto:changed', {
      ...withCreates(3),
      policy: {
        id: 'p1',
        state: 'shadow',
        enabledAt: Date.now(),
        expiresAt: Date.now() + 30 * 86_400_000,
        shadowUntil: Date.now() + 86_400_000,
        pausedReason: null,
        scope: DEFAULT_AUTO_SCOPE,
      },
      shadowTally: { decisions: 3, wouldAuto: 3, approvedUnchanged: 3, edited: 0, dismissed: 0 },
    });
    await waitFor(() => expect(screen.getByTestId('auto-end-shadow')).toBeInTheDocument());
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
    off();
  });

  it('dashboard:changed while open re-reads AutoState (a click-approved create can complete the track record)', async () => {
    let creates = 2;
    mockInvoke('auto:getState', () => ({ ok: true, value: withCreates(creates) }));
    await paint('auto');
    await waitFor(() => expect(reason()).toBe('trackRecord'));
    creates = 3;
    emitPush('dashboard:changed', { itemIds: [1] });
    await waitFor(() => expect(screen.getByTestId('auto-enable-trial')).toBeInTheDocument());
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });

  it('opening the group again (nav button, back from Automatic activity) re-reads AutoState', async () => {
    let creates = 2;
    mockInvoke('auto:getState', () => ({ ok: true, value: withCreates(creates) }));
    await paint('auto');
    await waitFor(() => expect(reason()).toBe('trackRecord'));
    creates = 3;
    await userEvent.click(screen.getByTestId('settings-nav-auto'));
    await waitFor(() => expect(screen.getByTestId('auto-enable-trial')).toBeInTheDocument());

    creates = 1;
    await userEvent.click(screen.getByTestId('auto-open-activity'));
    await userEvent.click(screen.getByTestId('auto-activity-back'));
    await waitFor(() => expect(reason()).toBe('trackRecord'));
  });

  it('after unmount a push re-reads nothing more from Settings', async () => {
    const { unmount } = render(<Settings initialGroup="auto" />);
    await waitFor(() => expect(invokeMocks['auto:getState']).toHaveBeenCalled());
    unmount();
    const calls = invokeMocks['auto:getState'].mock.calls.length;
    emitPush('dashboard:changed', { itemIds: [1] });
    await new Promise((r) => setTimeout(r, 10));
    expect(invokeMocks['auto:getState'].mock.calls.length).toBe(calls);
  });
});
