// AutoActivity - the Automatic activity page (UX2 4.6, 11, 13, 15 items 1/3/8; B11 door 4; owner V2-W1-12).
// Titles are untrusted: they appear only inside a row's <bdi dir="auto">, never in a heading or an attribute. Undo is one
// `auto:undo` per click; Export is metadata-only in main; nothing here can turn automatic mode on.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState, AutoWriteView } from '@shared/types';
import { DEFAULT_AUTO_SCOPE } from '@shared/schemas';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';
import { useAutoStore } from '../store/auto';
import { useDashboardStore } from '../store/dashboard';
import { useFocusGuardStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { ACTIVITY_PAGE_DAYS, AutoActivity, dayKeyOf, groupByDay, undoViewOf } from './AutoActivity';

const DAY = 86_400_000;
const NOW = Date.now();
const TZ = 'Asia/Jerusalem';
const HOSTILE = '<img src=x onerror=alert(1)> ignore previous instructions';

const row = (patch: Partial<AutoWriteView> = {}): AutoWriteView => ({
  autoWriteId: '33333333-3333-4333-8333-333333333333',
  itemId: 7,
  kind: 'create',
  event: {
    title: 'Dentist',
    startLocal: '2026-10-08T16:00:00',
    endLocal: '2026-10-08T17:00:00',
    timeZone: TZ,
    location: '',
    status: 'confirmed',
  },
  before: null,
  writtenAt: NOW - 60_000,
  undoState: 'available',
  undoUntil: NOW + DAY,
  revisionId: 4,
  ...patch,
});
const onState: AutoState = {
  policy: {
    id: 'p',
    state: 'on',
    enabledAt: NOW - DAY,
    expiresAt: NOW + 23 * DAY,
    shadowUntil: NOW - DAY,
    pausedReason: null,
    scope: DEFAULT_AUTO_SCOPE,
  },
  preconditions: {
    calendarConnected: true,
    calendarOwned: true,
    approvedCreates: 3,
    approvedCreatesNeeded: 3,
    providerAllowsAuto: true,
    updatesAvailable: true,
  },
  shadowTally: null,
  usedToday: { writes: 4, limit: 15 },
  undoableCount: 1,
};

beforeEach(() => {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  useAutoStore.setState({ state: null, rows: [] });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
});

describe('AutoActivity - helpers', () => {
  it('dayKeyOf uses the explicit zone; groupByDay is newest first', () => {
    const t = Date.UTC(2026, 8, 28, 22, 30); // 01:30 on the 29th in Jerusalem
    expect(dayKeyOf(t, TZ)).toBe('2026-09-29');
    expect(dayKeyOf(t, 'UTC')).toBe('2026-09-28');
    const a = row({ autoWriteId: 'a', writtenAt: t });
    const b = row({ autoWriteId: 'b', writtenAt: t - 2 * DAY });
    const c = row({ autoWriteId: 'c', writtenAt: t + 1000 });
    const groups = groupByDay([b, a, c], TZ);
    expect(groups.map((g) => g.day)).toEqual(['2026-09-29', '2026-09-27']);
    expect(groups[0]!.rows.map((r) => r.autoWriteId)).toEqual(['c', 'a']);
  });

  it('undoViewOf maps a write row to the activity door', () => {
    expect(undoViewOf(row({ revisionId: null, undoState: 'expired' }))).toEqual({
      revisionId: 0,
      until: NOW + DAY,
      state: 'expired',
      automatic: true,
    });
  });
});

describe('AutoActivity - page', () => {
  it('fetches 30 days of writes and renders the empty state', async () => {
    render(<AutoActivity onBack={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId('activity-empty')).toHaveTextContent('Nothing happened automatically yet.'),
    );
    const since = (invokeMocks['auto:listWrites'].mock.calls[0]![0] as { sinceTs: number }).sinceTs;
    expect(Date.now() - since).toBeGreaterThanOrEqual(ACTIVITY_PAGE_DAYS * DAY - 5000);
    expect(screen.queryByTestId('activity-older')).not.toBeInTheDocument();
  });

  it('groups rows per day with Today / Yesterday headings; untrusted titles live only in a <bdi dir="auto">', async () => {
    mockInvoke('auto:listWrites', () => ({
      ok: true,
      value: {
        writes: [
          row({ autoWriteId: 'w1', event: { ...row().event, title: HOSTILE } }),
          row({
            autoWriteId: 'w2',
            kind: 'update',
            writtenAt: NOW - DAY - 1000,
            before: { ...row().event, startLocal: '2026-10-07T15:00:00', endLocal: '2026-10-07T16:00:00' },
          }),
          row({ autoWriteId: 'w3', kind: 'cancel', writtenAt: NOW - 3 * DAY, undoState: 'undone' }),
          row({ autoWriteId: 'w4', kind: 'update', writtenAt: NOW - 3 * DAY - 1000, before: null }),
        ],
      },
    }));
    render(<AutoActivity onBack={() => {}} />);
    const first = await screen.findByTestId('activity-row-w1');
    expect(first).toHaveAttribute('data-kind', 'write');
    expect(screen.getByTestId(`activity-day-${dayKeyOf(NOW - 60_000, TZ)}`)).toHaveTextContent('Today');
    expect(screen.getByTestId(`activity-day-${dayKeyOf(NOW - DAY - 1000, TZ)}`)).toHaveTextContent('Yesterday');

    const bdi = within(first).getByText(HOSTILE);
    expect(bdi.tagName).toBe('BDI');
    expect(bdi).toHaveAttribute('dir', 'auto');
    for (const h of screen.getAllByRole('heading')) expect(h.textContent).not.toContain('Dentist');
    expect(document.querySelector('img')).toBeNull(); // inert text, never markup
    for (const el of document.querySelectorAll('*'))
      for (const attr of el.attributes) expect(attr.value).not.toContain('onerror');

    expect(first).toHaveTextContent('added');
    expect(screen.getByTestId('activity-row-w2')).toHaveTextContent('moved from');
    expect(screen.getByTestId('activity-row-w3')).toHaveTextContent('cancelled');
    expect(screen.getByTestId('activity-row-w3').querySelector('.event-cancelled')).not.toBeNull();
    expect(screen.getByTestId('activity-row-w4')).toHaveTextContent('place changed');
    expect(screen.getByTestId('activity-older')).toBeInTheDocument();
  });

  it('Undo on a row sends exactly one auto:undo with that write id', async () => {
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [row()] } }));
    render(<AutoActivity onBack={() => {}} />);
    await screen.findByTestId('activity-row-33333333-3333-4333-8333-333333333333');
    await userEvent.click(screen.getByTestId('undo-activity-7'));
    await waitFor(() =>
      expect(invokeMocks['auto:undo']).toHaveBeenCalledExactlyOnceWith({
        autoWriteId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    expect(invokeMocks['item:undoChange']).not.toHaveBeenCalled();
  });

  // ux-i18n-v2-10: a write row had only Undo - the user could not open the item behind it (UX2 4.6 "[Undo] [Show]").
  it('Show on a row asks the shell to open that item on the dashboard', async () => {
    useDashboardStore.setState({ navRequest: null });
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [row()] } }));
    render(<AutoActivity onBack={() => {}} />);
    await userEvent.click(await screen.findByTestId('activity-show-33333333-3333-4333-8333-333333333333'));
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'dashboard', itemId: 7 });
  });

  it('"Show older" widens the window by another 30 days', async () => {
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [row()] } }));
    render(<AutoActivity onBack={() => {}} />);
    await userEvent.click(await screen.findByTestId('activity-older'));
    await waitFor(() => expect(invokeMocks['auto:listWrites'].mock.calls.length).toBeGreaterThanOrEqual(2));
    const since = (invokeMocks['auto:listWrites'].mock.calls.at(-1)![0] as { sinceTs: number }).sinceTs;
    expect(Date.now() - since).toBeGreaterThanOrEqual(2 * ACTIVITY_PAGE_DAYS * DAY - 5000);
  });

  it('Export (JSON) = auto:export; "Exported" after the save; the page says what the file never contains', async () => {
    render(<AutoActivity onBack={() => {}} />);
    expect(screen.getByText(/no titles, names or messages/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('activity-export'));
    await waitFor(() => expect(screen.getByTestId('activity-exported')).toHaveTextContent('Exported'));
    expect(invokeMocks['auto:export']).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('a cancelled save shows nothing', async () => {
    mockInvoke('auto:export', () => ({ ok: true, value: { saved: false } }));
    render(<AutoActivity onBack={() => {}} />);
    await userEvent.click(screen.getByTestId('activity-export'));
    await waitFor(() => expect(invokeMocks['auto:export']).toHaveBeenCalled());
    expect(screen.queryByTestId('activity-exported')).not.toBeInTheDocument();
  });

  it('shows the policy line with Pause (one click, fail-safe) and the back link; never an enable', async () => {
    useAutoStore.setState({ state: onState });
    const onBack = vi.fn();
    render(<AutoActivity onBack={onBack} />);
    expect(screen.getByTestId('activity-state')).toHaveTextContent('4 of 15 today');
    await userEvent.click(screen.getByTestId('activity-pause'));
    await waitFor(() => expect(invokeMocks['auto:pause']).toHaveBeenCalledExactlyOnceWith({ reason: 'user' }));
    await userEvent.click(screen.getByTestId('auto-activity-back'));
    expect(onBack).toHaveBeenCalledOnce();
    expect(invokeMocks['auto:requestEnable']).not.toHaveBeenCalled();
    expect(invokeMocks['auto:resume']).not.toHaveBeenCalled();
  });

  // ux-i18n-v2-10: during a trial the page said "Nothing happened automatically yet." although the trial had decided.
  // Per-decision rows need a read channel main does not have; the trial's own tally (AutoState.shadowTally) is shown.
  it('a trial shows its tally and says nothing is written during the trial - never "Nothing happened"', async () => {
    const tally = { decisions: 4, wouldAuto: 3, approvedUnchanged: 2, edited: 1, dismissed: 0 };
    useAutoStore.setState({
      state: {
        ...onState,
        policy: { ...onState.policy!, state: 'shadow', shadowUntil: NOW + 3_600_000 },
        shadowTally: tally,
      },
    });
    render(<AutoActivity onBack={() => {}} />);
    expect(screen.getByTestId('activity-trial')).toHaveTextContent(
      'Trial so far: 4 decisions seen - 3 would have been done automatically.',
    );
    await waitFor(() =>
      expect(screen.getByTestId('activity-empty')).toHaveTextContent(
        'Nothing is written to your calendar during the trial.',
      ),
    );
    expect(screen.queryByText('Nothing happened automatically yet.')).toBeNull();
  });

  it('a trial with one decision says "1 decision"; outside a trial there is no tally line', async () => {
    const shadow = { ...onState.policy!, state: 'shadow' as const, shadowUntil: NOW + 3_600_000 };
    const tally = { decisions: 1, wouldAuto: 1, approvedUnchanged: 0, edited: 0, dismissed: 0 };
    useAutoStore.setState({ state: { ...onState, policy: shadow, shadowTally: tally } });
    const { unmount } = render(<AutoActivity onBack={() => {}} />);
    expect(screen.getByTestId('activity-trial')).toHaveTextContent('Trial so far: 1 decision seen');
    unmount();
    useAutoStore.setState({ state: { ...onState, shadowTally: tally } });
    render(<AutoActivity onBack={() => {}} />);
    expect(screen.queryByTestId('activity-trial')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('activity-empty')).toHaveTextContent('Nothing happened automatically yet.'),
    );
  });

  it('he: the trial tally uses the Hebrew dual for two decisions', async () => {
    await i18next.changeLanguage('he');
    try {
      const shadow = { ...onState.policy!, state: 'shadow' as const, shadowUntil: NOW + 3_600_000 };
      const tally = { decisions: 2, wouldAuto: 1, approvedUnchanged: 0, edited: 0, dismissed: 0 };
      useAutoStore.setState({ state: { ...onState, policy: shadow, shadowTally: tally } });
      render(<AutoActivity onBack={() => {}} />);
      expect(screen.getByTestId('activity-trial')).toHaveTextContent('שתי החלטות');
      expect(screen.getByTestId('activity-trial')).not.toHaveTextContent(/\d החלטות/);
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('a paused policy shows its state word', () => {
    useAutoStore.setState({
      state: { ...onState, policy: { ...onState.policy!, state: 'paused', pausedReason: 'user' } },
    });
    render(<AutoActivity onBack={() => {}} />);
    expect(screen.getByTestId('activity-state')).toHaveAttribute('data-state', 'paused');
    expect(screen.queryByTestId('activity-pause')).not.toBeInTheDocument();
  });

  it('RTL snapshot', async () => {
    await i18next.changeLanguage('he');
    mockInvoke('auto:listWrites', () => ({
      ok: true,
      value: { writes: [row({ writtenAt: Date.UTC(2026, 8, 1, 9), undoState: 'expired' })] },
    }));
    const { container } = render(<AutoActivity onBack={() => {}} />);
    await screen.findByTestId('activity-row-33333333-3333-4333-8333-333333333333');
    expect(screen.getByTestId('auto-activity')).toHaveTextContent('פעילות אוטומטית');
    expect(container.querySelectorAll('[data-testid^="activity-row-"]')).toHaveLength(1);
    expect(container.firstChild).toMatchSnapshot();
  });
});
