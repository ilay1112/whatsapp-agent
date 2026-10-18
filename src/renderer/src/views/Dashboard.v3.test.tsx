// [V3] T-904 Task 6 (handover §2.2 / §2.3, §4 Task 6): the dashboard's schedule-only filter, the cards / calendar view
// switch, the week calendar with its "No date yet" side list, and the F6 regions of the calendar view. The calendar is
// drawn from the dashboard's own lists only (no Google read); a block or a side-list card opens the existing sheet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import type { ItemCard as ItemVM } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { todayIn } from '@shared/when';
import { Dashboard } from './Dashboard';
import { useDashboardStore } from '../store/dashboard';
import { useAutoStore } from '../store/auto';
import { useFocusGuardStore, useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { defaultCard, defaultDetail, defaultHealth, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });
const sendOnly = (): ItemVM['actions'] => [structuredClone(defaultCard.actions[0]!)];

/** A finished analysis that is not about a meeting: the filter hides it. */
const smalltalk = (itemId = 5): ItemVM =>
  card({
    itemId,
    intent: 'smalltalk',
    event: null,
    eventState: 'none',
    badges: [],
    actions: sendOnly(),
  });

/** An information-missing card: no slot yet, so the calendar lists it under "No date yet". */
const infoMissing = (itemId = 9): ItemVM =>
  card({
    itemId,
    status: 'info_missing',
    eventState: 'incomplete',
    missing: ['date', 'time'],
    event: { ...structuredClone(defaultCard.event!), startLocal: '', endLocal: '' },
    badges: [],
    actions: sendOnly(),
  });

/** A proposed event TODAY (10:00-11:00 in the profile zone), so it is on the current week's grid. */
const TODAY = todayIn('Asia/Jerusalem', Date.now());
const proposedToday = (itemId = 3): ItemVM =>
  card({
    itemId,
    event: {
      ...structuredClone(defaultCard.event!),
      startLocal: `${TODAY}T10:00:00`,
      endLocal: `${TODAY}T11:00:00`,
    },
  });

function seed(lists: Partial<Record<'needs_reply' | 'in_calendar' | 'info_missing', ItemVM[]>> = {}): void {
  useDashboardStore.setState({
    hydrated: true,
    loadError: null,
    lists: {
      needs_reply: { items: lists.needs_reply ?? [], count: (lists.needs_reply ?? []).length },
      in_calendar: { items: lists.in_calendar ?? [], count: (lists.in_calendar ?? []).length },
      info_missing: { items: lists.info_missing ?? [], count: (lists.info_missing ?? []).length },
    },
  });
}

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
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------------------------------------------------
// §2.2 schedule-only filter
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard v3 - schedule-only filter', () => {
  it('filter on + the only card is smalltalk: the column shows its empty state and the toggle says "Show all (1 hidden)"', () => {
    seed({ needs_reply: [smalltalk()] });
    render(<Dashboard />);
    expect(screen.queryByTestId('card-5')).toBeNull();
    expect(screen.getByTestId('empty-needs_reply')).toBeInTheDocument();
    expect(screen.getByTestId('count-needs_reply')).toHaveTextContent('0');
    expect(screen.getByTestId('schedule-filter-toggle')).toHaveTextContent('Show all (1 hidden)');
  });

  it('clicking the toggle shows the hidden card, reads "Only schedules" and is remembered', async () => {
    const user = userEvent.setup();
    seed({ needs_reply: [card(), smalltalk()] });
    render(<Dashboard />);
    expect(screen.getByTestId('count-needs_reply')).toHaveTextContent('1');
    await user.click(screen.getByTestId('schedule-filter-toggle'));
    expect(screen.getByTestId('card-5')).toBeInTheDocument();
    expect(screen.getByTestId('card-1')).toBeInTheDocument();
    expect(screen.getByTestId('count-needs_reply')).toHaveTextContent('2');
    expect(screen.getByTestId('schedule-filter-toggle')).toHaveTextContent('Only schedules');
    expect(useDashboardStore.getState().scheduleOnly).toBe(false);
    expect(window.localStorage.getItem('wca.dashboard.scheduleOnly')).toBe('false');
    // and back
    await user.click(screen.getByTestId('schedule-filter-toggle'));
    expect(screen.queryByTestId('card-5')).toBeNull();
  });

  it('filter on with nothing hidden: no toggle; filter off with nothing hidden: the toggle stays to switch back', () => {
    seed({ needs_reply: [card()] });
    const { unmount } = render(<Dashboard />);
    expect(screen.queryByTestId('schedule-filter-toggle')).toBeNull();
    unmount();
    useDashboardStore.setState({ scheduleOnly: false });
    render(<Dashboard />);
    expect(screen.getByTestId('schedule-filter-toggle')).toHaveTextContent('Only schedules');
  });

  it('counts hidden cards across all three lists; count-<key> is visible, "latest 20 of N" names the server count', () => {
    const many = Array.from({ length: 20 }, (_, i) => card({ itemId: 100 + i }));
    useDashboardStore.setState({
      hydrated: true,
      lists: {
        needs_reply: { items: [...many.slice(0, 19), smalltalk(5)], count: 30 },
        in_calendar: { items: [], count: 0 },
        info_missing: { items: [smalltalk(6)], count: 1 },
      },
    });
    render(<Dashboard />);
    expect(screen.getByTestId('schedule-filter-toggle')).toHaveTextContent('Show all (2 hidden)');
    expect(screen.getByTestId('count-needs_reply')).toHaveTextContent('29');
    expect(screen.getByTestId('more-needs_reply')).toHaveTextContent('Showing the latest 20 of 30');
  });

  it('the sheet is never filtered: opening a hidden card by id still opens it', async () => {
    const hidden = smalltalk();
    seed({ needs_reply: [hidden] });
    mockInvoke('item:get', () => ({ ok: true, value: { ...defaultDetail, ...hidden } }));
    render(<Dashboard />);
    await useDashboardStore.getState().openItemById(5);
    const sheet = await screen.findByTestId('item-sheet');
    await waitFor(() => expect(within(sheet).getByTestId('sheet-card-5')).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// §2.3 view switch + week calendar
// ---------------------------------------------------------------------------------------------------------------------
describe('Dashboard v3 - view switch and week calendar', () => {
  it('starts on the cards view with an aria-pressed switch', () => {
    seed({ needs_reply: [card()] });
    render(<Dashboard />);
    const sw = screen.getByTestId('view-switch');
    expect(within(sw).getByTestId('view-cards')).toHaveAttribute('aria-pressed', 'true');
    expect(within(sw).getByTestId('view-calendar')).toHaveAttribute('aria-pressed', 'false');
    expect(within(sw).getByTestId('view-cards')).toHaveTextContent('Cards');
    expect(screen.queryByTestId('calendar-week')).toBeNull();
  });

  it('view-calendar: the week calendar replaces the three lists; undated cards go to the "No date yet" side list', async () => {
    const user = userEvent.setup();
    seed({ needs_reply: [proposedToday()], info_missing: [infoMissing()] });
    render(<Dashboard />);
    await user.click(screen.getByTestId('view-calendar'));

    expect(screen.getByTestId('cal-range')).toBeInTheDocument();
    expect(screen.getByTestId('view-cards')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('view-calendar')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('list-needs_reply')).toBeNull();
    expect(screen.queryByTestId('list-in_calendar')).toBeNull();
    expect(useDashboardStore.getState().view).toBe('calendar');
    expect(window.localStorage.getItem('wca.dashboard.view')).toBe('calendar');

    // the proposed card is a block in today's column; the info-missing card is in the side list, not on the grid
    expect(within(screen.getByTestId(`cal-col-${TODAY}`)).getByTestId('cal-block-3')).toHaveAttribute(
      'data-state',
      'proposed',
    );
    const side = screen.getByTestId('cal-undated');
    expect(within(side).getByText('No date yet')).toBeInTheDocument();
    expect(within(side).getByTestId('card-9')).toBeInTheDocument();
    expect(within(side).getByTestId('dismiss-x-9')).toBeInTheDocument();
    expect(screen.queryByTestId('cal-block-9')).toBeNull();
    expect(within(side).queryByTestId('card-3')).toBeNull();
  });

  it('the calendar applies the schedule filter too (hidden cards are neither blocks nor side-list cards)', () => {
    useDashboardStore.setState({ view: 'calendar' });
    seed({ needs_reply: [smalltalk()], info_missing: [infoMissing()] });
    render(<Dashboard />);
    expect(screen.queryByTestId('card-5')).toBeNull();
    expect(screen.getByTestId('schedule-filter-toggle')).toHaveTextContent('Show all (1 hidden)');
    expect(within(screen.getByTestId('cal-undated')).getByTestId('card-9')).toBeInTheDocument();
  });

  it('a remembered calendar view is the first paint', () => {
    useDashboardStore.setState({ view: 'calendar' });
    seed({ needs_reply: [card()] });
    render(<Dashboard />);
    expect(screen.getByTestId('calendar-week')).toBeInTheDocument();
    expect(screen.queryByTestId('list-needs_reply')).toBeNull();
  });

  it('a block click opens the existing sheet for that item', async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ view: 'calendar' });
    seed({ needs_reply: [proposedToday()] });
    mockInvoke('item:get', () => ({ ok: true, value: { ...defaultDetail, ...proposedToday() } }));
    render(<Dashboard />);
    await user.click(screen.getByTestId('cal-block-3'));
    expect(await screen.findByTestId('item-sheet')).toBeInTheDocument();
    expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 3 });
  });

  it('prev / next / today move the week shown', async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ view: 'calendar' });
    seed({ needs_reply: [proposedToday()] });
    render(<Dashboard />);
    const first = screen.getByTestId('cal-range').textContent;
    await user.click(screen.getByTestId('cal-next'));
    expect(screen.getByTestId('cal-range').textContent).not.toBe(first);
    expect(screen.queryByTestId('cal-block-3')).toBeNull();
    await user.click(screen.getByTestId('cal-today'));
    expect(screen.getByTestId('cal-range').textContent).toBe(first);
    expect(screen.getByTestId('cal-block-3')).toBeInTheDocument();
  });

  it('the scope note shows until "Got it", which is remembered', async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ view: 'calendar' });
    render(<Dashboard />);
    await user.click(screen.getByTestId('cal-note-dismiss'));
    expect(screen.queryByTestId('cal-note')).toBeNull();
    expect(useDashboardStore.getState().calNoteSeen).toBe(true);
    expect(window.localStorage.getItem('wca.dashboard.calNoteSeen')).toBe('true');
  });

  it('uses the profile time zone and the UI language (Hebrew week starts on Sunday)', async () => {
    await i18next.changeLanguage('he');
    useDashboardStore.setState({ view: 'calendar' });
    render(<Dashboard />);
    const days = screen.getAllByTestId(/^cal-day-/);
    expect(days).toHaveLength(7);
    const first = days[0]!.getAttribute('data-testid')!.slice('cal-day-'.length);
    expect(new Date(`${first}T12:00:00Z`).getUTCDay()).toBe(0);
    expect(screen.getByTestId('view-cards')).toHaveTextContent('כרטיסים');
  });

  it('F6 cycles toolbar -> calendar -> side list in the calendar view', async () => {
    const user = userEvent.setup();
    useDashboardStore.setState({ view: 'calendar' });
    seed({ info_missing: [infoMissing()] });
    render(
      <>
        <button type="button" data-testid="pause-toggle">
          pause
        </button>
        <Dashboard />
        <button type="button" data-testid="app-version">
          v
        </button>
      </>,
    );
    screen.getByTestId('view-calendar').focus();
    await user.keyboard('{F6}');
    expect(screen.getByTestId('calendar-week').contains(document.activeElement)).toBe(true);
    await user.keyboard('{F6}');
    expect(screen.getByTestId('cal-undated').contains(document.activeElement)).toBe(true);
    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(screen.getByTestId('calendar-week').contains(document.activeElement)).toBe(true);
    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(screen.getByTestId('dash-toolbar').contains(document.activeElement)).toBe(true);
  });

  it('F6 in the cards view still visits the toolbar before the columns', async () => {
    const user = userEvent.setup();
    seed({ needs_reply: [card()] });
    render(<Dashboard />);
    screen.getByTestId('view-cards').focus();
    await user.keyboard('{F6}');
    expect(screen.getByTestId('list-needs_reply').contains(document.activeElement)).toBe(true);
    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(screen.getByTestId('dash-toolbar').contains(document.activeElement)).toBe(true);
  });

  // fix pass, review should-fix 6: an app left open since last week must not open the calendar on last week.
  it('switching to the calendar re-reads "now": a cards view mounted 8 days ago opens on the current week', async () => {
    const user = userEvent.setup();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(start);
      seed({ needs_reply: [card()] });
      const { unmount } = render(<Dashboard />);
      vi.setSystemTime(start + 8 * 86_400_000);
      await user.click(screen.getByTestId('view-calendar'));
      const shown = screen.getByTestId('cal-range').textContent;
      const today = todayIn('Asia/Jerusalem', Date.now());
      expect(screen.getByTestId(`cal-day-${today}`)).toHaveAttribute('data-today', 'true');
      unmount();
      // a fresh mount at the new "now" is the reference for the current week
      render(<Dashboard />);
      expect(screen.getByTestId('cal-range').textContent).toBe(shown);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing in the toolbar or the calendar calls settings:set', async () => {
    const user = userEvent.setup();
    seed({ needs_reply: [smalltalk()] });
    render(<Dashboard />);
    await user.click(screen.getByTestId('schedule-filter-toggle'));
    await user.click(screen.getByTestId('view-calendar'));
    await user.click(screen.getByTestId('view-cards'));
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });
});
