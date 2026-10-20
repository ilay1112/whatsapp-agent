// [v4 T3] v4-calendar-handover 2.1: the dashboard toolbar's Refresh button. One click = one `dashboard:refreshNow`; the button
// is disabled with a spinner while the call is pending; the result is announced with the counts; a press inside main's 30 s
// cooldown answers `cooldown: true` and the cooldown text is shown instead. Refresh never approves or sends anything.
import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RefreshReport, Result } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { Dashboard } from './Dashboard';
import { useDashboardStore } from '../store/dashboard';
import { useAutoStore } from '../store/auto';
import { useFocusGuardStore, useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { defaultHealth, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const REPORT: RefreshReport = {
  newRows: 3,
  queued: 2,
  skippedRateLimited: 1,
  skippedInCalendar: 1,
  skippedNothingToAnalyse: 4,
  calendarRefreshed: true,
  cooldown: false,
};

beforeEach(() => {
  window.localStorage.clear();
  useDashboardStore.setState({
    hydrated: true,
    loadError: null,
    analysing: 0,
    openItemId: null,
    openItem: null,
    undoDrawerOpen: false,
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    queue: null,
    navRequest: null,
    sectionOpen: { needs_reply: true, in_calendar: false, info_missing: true },
    scheduleOnly: true,
    view: 'cards',
    calNoteSeen: false,
    lists: {
      needs_reply: { items: [], count: 0 },
      in_calendar: { items: [], count: 0 },
      info_missing: { items: [], count: 0 },
    },
  });
  useHealthStore.setState({
    health: structuredClone(defaultHealth),
    progress: null,
    hiddenSetupTasks: [],
    queue: null,
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS), saveError: null, savedAt: 0 });
  useAutoStore.setState({ state: null, rows: [], fetchedAt: 0, undoing: new Set(), failed: new Set() });
});

describe('Dashboard v4 - Refresh', () => {
  it('sits in the toolbar; one click = one refreshNow call, a spinner + disabled while pending, then the counts', async () => {
    const user = userEvent.setup();
    let resolve: (r: Result<RefreshReport>) => void = () => undefined;
    mockInvoke('dashboard:refreshNow', () => new Promise<Result<RefreshReport>>((r) => (resolve = r)));
    render(<Dashboard />);
    const toolbar = screen.getByTestId('dash-toolbar');
    const button = screen.getByTestId('refresh-now');
    expect(toolbar).toContainElement(button);
    expect(button).toHaveTextContent('Refresh');

    await user.click(button);
    expect(invokeMocks['dashboard:refreshNow']).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Refreshing…');
    expect(screen.getByTestId('refresh-spinner')).toBeInTheDocument();
    // a second click while pending does nothing (the button is disabled)
    await user.click(button);
    expect(invokeMocks['dashboard:refreshNow']).toHaveBeenCalledTimes(1);

    await act(async () => resolve({ ok: true, value: REPORT }));
    expect(await screen.findByTestId('refresh-toast')).toHaveTextContent(
      '3 new messages, 2 chats queued, 2 skipped, 4 unchanged',
    );
    expect(button).toBeEnabled();
    expect(screen.queryByTestId('refresh-spinner')).toBeNull();
  });

  it('a press inside the cooldown shows the cooldown text', async () => {
    const user = userEvent.setup();
    mockInvoke('dashboard:refreshNow', () => ({ ok: true, value: REPORT }));
    render(<Dashboard />);
    await user.click(screen.getByTestId('refresh-now'));
    expect(await screen.findByTestId('refresh-toast')).toHaveTextContent('3 new messages');

    mockInvoke('dashboard:refreshNow', () => ({ ok: true, value: { ...REPORT, cooldown: true } }));
    await user.click(screen.getByTestId('refresh-now'));
    await waitFor(() =>
      expect(screen.getByTestId('refresh-toast')).toHaveTextContent('Just refreshed — try again in a moment'),
    );
    expect(invokeMocks['dashboard:refreshNow']).toHaveBeenCalledTimes(2);
  });

  it('a refused call shows the error title and re-enables the button', async () => {
    const user = userEvent.setup();
    mockInvoke('dashboard:refreshNow', () => ({ ok: false, error: { code: 'INTERNAL' } }));
    render(<Dashboard />);
    await user.click(screen.getByTestId('refresh-now'));
    expect(await screen.findByTestId('refresh-toast')).toHaveTextContent('Something went wrong');
    expect(screen.getByTestId('refresh-now')).toBeEnabled();
  });

  it('never calls an approve / send / calendar-write channel', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await user.click(screen.getByTestId('refresh-now'));
    await screen.findByTestId('refresh-toast');
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
    expect(invokeMocks['item:completeEvent']).not.toHaveBeenCalled();
  });
});
