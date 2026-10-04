// V2-W1-11: the v2 dashboard (UX2 0, 2.5, 3.1, 11.1, 15.2/15.4). Three lists stay the only lists; the AutoStrip is a
// strip above them that leaves the DOM when idle; automatic mode is never flipped from here; the queue line follows
// `queue:changed`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutoState, AutoWriteView, ItemCard as ItemVM } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { Dashboard } from './Dashboard';
import { useDashboardStore } from '../store/dashboard';
import { useAutoStore } from '../store/auto';
import { useFocusGuardStore, useHealthStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { defaultCard, defaultHealth, emitPush, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const W = '00000000-0000-4000-8000-000000000077';
const write = (patch: Partial<AutoWriteView> = {}): AutoWriteView => ({
  autoWriteId: W,
  itemId: 7,
  kind: 'create',
  event: {
    title: 'Coffee',
    startLocal: '2030-10-05T09:00:00',
    endLocal: '2030-10-05T09:30:00',
    timeZone: 'Asia/Jerusalem',
    location: '',
    status: 'confirmed',
  },
  before: null,
  writtenAt: Date.now() - 60_000,
  undoState: 'available',
  undoUntil: Date.now() + 3_600_000,
  revisionId: 3,
  ...patch,
});
const autoState = (s: NonNullable<AutoState['policy']>['state']): AutoState => ({
  policy: {
    id: 'p',
    state: s,
    enabledAt: 0,
    expiresAt: Date.now() + 1e9,
    shadowUntil: 0,
    pausedReason: null,
    scope: {} as never,
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
  usedToday: { writes: 1, limit: 5 },
  undoableCount: 1,
});
const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });

beforeEach(() => {
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
});

describe('Dashboard v2 - AutoStrip', () => {
  it('hydrates automatic mode on mount; with nothing undoable the strip is absent', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(invokeMocks['auto:getState']).toHaveBeenCalled());
    expect(invokeMocks['auto:listWrites']).toHaveBeenCalled();
    expect(screen.queryByTestId('autostrip')).toBeNull();
  });

  it('shows the strip ABOVE the three lists when a write can be undone; exactly three list sections', async () => {
    mockInvoke('auto:getState', () => ({ ok: true, value: autoState('on') }));
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [write()] } }));
    render(<Dashboard />);
    const strip = await screen.findByTestId('autostrip');
    const main = screen.getByTestId('dashboard');
    const lists = main.querySelectorAll('[data-testid^="list-"]:not([data-testid="list-skeletons"])');
    expect(lists).toHaveLength(3);
    expect(strip.compareDocumentPosition(lists[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the strip is not a list and has no approval button
    expect(strip.querySelector('.btn-primary, [data-primary-approve]')).toBeNull();
  });

  it('Undo in the strip -> exactly one auto:undo {autoWriteId}', async () => {
    const user = userEvent.setup();
    mockInvoke('auto:getState', () => ({ ok: true, value: autoState('on') }));
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [write()] } }));
    render(<Dashboard />);
    await user.dblClick(await screen.findByTestId(`autostrip-undo-${W}`));
    await waitFor(() => expect(invokeMocks['auto:undo']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['auto:undo']).toHaveBeenCalledWith({ autoWriteId: W });
  });

  it('Pause -> auto:pause {reason:"user"}; Show opens the item sheet', async () => {
    const user = userEvent.setup();
    mockInvoke('auto:getState', () => ({ ok: true, value: autoState('on') }));
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [write()] } }));
    render(<Dashboard />);
    await user.click(await screen.findByTestId('autostrip-pause'));
    await waitFor(() => expect(invokeMocks['auto:pause']).toHaveBeenCalledWith({ reason: 'user' }));
    await user.click(screen.getByTestId(`autostrip-show-${W}`));
    await waitFor(() => expect(invokeMocks['item:get']).toHaveBeenCalledWith({ itemId: 7 }));
    expect(screen.getByTestId('item-sheet')).toBeInTheDocument();
  });

  it('auto:changed re-reads the rows: the strip appears without a reload', async () => {
    render(<Dashboard />);
    await waitFor(() => expect(invokeMocks['auto:listWrites']).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('autostrip')).toBeNull();
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [write()] } }));
    emitPush('auto:changed', autoState('on'));
    expect(await screen.findByTestId('autostrip')).toBeInTheDocument();
  });

  it('F6 visits the AutoStrip between the header and the columns', async () => {
    const user = userEvent.setup();
    mockInvoke('auto:getState', () => ({ ok: true, value: autoState('on') }));
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [write()] } }));
    render(
      <>
        <button type="button" data-testid="pause-toggle">
          pause
        </button>
        <Dashboard />
      </>,
    );
    await screen.findByTestId('autostrip');
    // F6 is handled by <main>, so the cycle is driven from a focus inside it: strip -> first column -> back.
    screen.getByTestId('autostrip-toggle').focus();
    await user.keyboard('{F6}');
    expect(document.activeElement?.closest('[data-testid="list-needs_reply"]')).not.toBeNull();
    await user.keyboard('{Shift>}{F6}{/Shift}');
    expect(document.activeElement).toBe(screen.getByTestId('autostrip-toggle'));
  });

  it('nothing on the dashboard writes an `auto` settings key or enables automatic mode', async () => {
    const user = userEvent.setup();
    mockInvoke('auto:getState', () => ({ ok: true, value: autoState('on') }));
    mockInvoke('auto:listWrites', () => ({ ok: true, value: { writes: [write()] } }));
    render(<Dashboard />);
    await user.click(await screen.findByTestId('autostrip-toggle'));
    await user.click(screen.getByTestId('autostrip-toggle'));
    for (const c of ['settings:set', 'auto:requestEnable', 'auto:resume', 'auto:endShadow'] as const)
      expect(invokeMocks[c]).not.toHaveBeenCalled();
  });
});

describe('Dashboard v2 - queue line and lists', () => {
  it('queue:changed with a whisper job shows "Transcribing a voice note (0:42)..." on Needs reply', async () => {
    render(<Dashboard />);
    emitPush('queue:changed', { pending: 1, running: 1, transcribing: { seconds: 42 } });
    expect(await screen.findByTestId('queue-transcribing')).toHaveTextContent('Transcribing a voice note (0:42)...');
    expect(within(screen.getByTestId('list-needs_reply')).getByTestId('queue-transcribing')).toBeInTheDocument();
    emitPush('queue:changed', { pending: 0, running: 0, transcribing: null });
    await waitFor(() => expect(screen.queryByTestId('queue-transcribing')).toBeNull());
  });

  it('falls back to the health store queue until the dashboard has its own', () => {
    useHealthStore.setState({ queue: { pending: 0, running: 1, transcribing: { seconds: 5 } } });
    render(<Dashboard />);
    expect(screen.getByTestId('queue-transcribing')).toHaveTextContent('(0:05)');
  });

  it('a pending change: the event is in "In calendar" once, and its source card wears the chip', () => {
    const source = card({
      itemId: 5,
      status: 'in_calendar',
      eventState: 'created',
      actions: [],
      changePending: true,
      calendar: { eventStartTs: null, eventKey: 'ev1', revision: 1, status: 'confirmed' },
    });
    const twin = { ...source, itemId: 6, changePending: false };
    useDashboardStore.setState({
      sectionOpen: { needs_reply: true, in_calendar: true, info_missing: true },
      lists: {
        needs_reply: { items: [], count: 0 },
        in_calendar: { items: [source, twin], count: 2 },
        info_missing: { items: [], count: 0 },
      },
    });
    render(<Dashboard />);
    const list = screen.getByTestId('list-in_calendar');
    expect(list.querySelectorAll('[role="list"] > [role="listitem"]')).toHaveLength(1);
    expect(within(list).getByTestId('change-pending-chip-5')).toBeInTheDocument();
  });

  // v2-acceptance e2e #5 (undo.spec:87): the event moves from the source item (1) to the delta item (2) and back on
  // Undo. A card keyed by event made React hand item 1's ItemCard - and its local draft - to item 2, so item 2 went
  // dirty with no user edit, was pinned by refresh() and kept the pre-undo 17:00 behind "This card changed".
  it('an event moving to another item never inherits the first card: Undo shows the restored time at once', async () => {
    const user = userEvent.setup();
    const day = defaultCard.event!.startLocal.slice(0, 10);
    const ev = (start: string, end: string) => ({
      ...structuredClone(defaultCard.event!),
      startLocal: `${day}T${start}:00`,
      endLocal: `${day}T${end}:00`,
    });
    const source = card({
      itemId: 1,
      status: 'in_calendar',
      eventState: 'created',
      replyState: 'sent',
      draft: { text: 'Great, see you at 15:00.', lang: 'en', proposalVersion: 1 },
      event: ev('15:00', '16:00'),
      badges: [],
      actions: [],
      calendar: { eventStartTs: null, eventKey: 'ev1', revision: 1, status: 'confirmed' },
      updatedAt: 1_000,
    });
    const moved = card({
      ...source,
      itemId: 2,
      eventState: 'updated',
      draft: { text: 'Sure, 17:00 then.', lang: 'en', proposalVersion: 2 },
      event: ev('17:00', '18:00'),
      calendar: { eventStartTs: null, eventKey: 'ev1', revision: 2, status: 'confirmed' },
      undo: { revisionId: 2, until: Date.now() + 86_400_000, state: 'available', automatic: false },
      updatedAt: 2_000,
    });
    const undone = card({
      ...moved,
      event: ev('15:00', '16:00'),
      draft: { text: 'Sure, 17:00 then.', lang: 'en', proposalVersion: 3 },
      calendar: { eventStartTs: null, eventKey: 'ev1', revision: 3, status: 'confirmed' },
      undo: null,
      updatedAt: 3_000,
    });
    let served: ItemVM = source;
    mockInvoke('dashboard:get', () => ({
      ok: true,
      value: {
        needsReply: [],
        inCalendar: [served],
        infoMissing: [],
        counts: { needsReply: 0, inCalendar: 1, infoMissing: 0, ignored: 0 },
        analysing: 0,
      },
    }));
    mockInvoke('item:undoChange', () => {
      served = undone;
      return { ok: true, value: { outcome: 'done', item: { ...undone, messages: [] } } };
    });
    useDashboardStore.setState({ sectionOpen: { needs_reply: true, in_calendar: true, info_missing: true } });
    render(<Dashboard />);
    await act(() => useDashboardStore.getState().refresh());
    expect(await screen.findByTestId('card-1')).toBeInTheDocument();

    // the manual reschedule landed: item 1 is superseded, item 2 now holds the event
    served = moved;
    await act(() => useDashboardStore.getState().refresh());
    const card2 = await screen.findByTestId('card-2');
    expect(within(card2).getByTestId('event-chip-range')).toHaveTextContent('17:00');
    expect(useDashboardStore.getState().dirtyItemIds.has(2)).toBe(false);

    await user.click(within(card2).getByTestId('undo-2'));
    await waitFor(() => expect(invokeMocks['item:undoChange']).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(screen.getByTestId('card-2')).getByTestId('event-chip-range')).toHaveTextContent('15:00'),
    );
    expect(screen.queryByTestId('stale-2')).toBeNull();
    expect(useDashboardStore.getState().staleItemIds.has(2)).toBe(false);
  });

  it('unsubscribes from push events on unmount', async () => {
    const { unmount } = render(<Dashboard />);
    unmount();
    emitPush('queue:changed', { pending: 0, running: 0, transcribing: { seconds: 9 } });
    expect(useDashboardStore.getState().queue).toBeNull();
  });
});
