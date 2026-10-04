// V2-W1-11: the v2 card (UX2 3.2-3.7, 8, 11, 13, 15; B10, B11, B19, B20; F1, F28, F31, F32; T2 5 "Renderer").
// Approval-first rules are re-proven for every new approval-class button: one click => exactly one IPC carrying the
// rendered shownHash, a second click sends nothing, the focus-steal guard refuses mouse and keyboard activation, and the
// fail-safe buttons (Keep 15:00 / Keep it / Keep Google's / Pause) are never guarded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AUTO_REASONS,
  type ActionView,
  type AutoState,
  type ChangeView,
  type EventContentView,
  type ItemCard as ItemVM,
  type ItemDetail,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { ItemCard, autoChipOf, canRestoreOriginal, eventVmOf, selfTriggered, visibleAutoReason } from './ItemCard';
import { useDashboardStore } from '../store/dashboard';
import { useFocusGuardStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { useAutoStore } from '../store/auto';
import { defaultCard, defaultDetail, i18next, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

// ---------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------
const DAY = ((): string => {
  const d = new Date(Date.now() + 14 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7)); // a Wednesday two weeks out
  return d.toISOString().slice(0, 10);
})();
const SEND_ID = '11111111-1111-4111-8111-111111111111';
const CREATE_ID = '22222222-2222-4222-8222-222222222222';
const UPDATE_ID = '33333333-3333-4333-8333-333333333333';
const CLONE_ID = '44444444-4444-4444-8444-444444444444';
const UPDATE_HASH = 'c'.repeat(64);

const ev = (patch: Partial<EventContentView> = {}): EventContentView => ({
  title: 'Meeting',
  startLocal: `${DAY}T15:00:00`,
  endLocal: `${DAY}T16:00:00`,
  timeZone: 'Asia/Jerusalem',
  location: 'Cafe Noir',
  status: 'confirmed',
  ...patch,
});
const TO = ev({ startLocal: `${DAY}T17:00:00`, endLocal: `${DAY}T18:00:00` });
const action = (patch: Partial<ActionView>): ActionView => ({
  actionId: UPDATE_ID,
  kind: 'update_event',
  shownHash: UPDATE_HASH,
  state: 'pending',
  expiresAt: Date.now() + 86_400_000,
  attempt: 1,
  errorCode: null,
  lastError: null,
  disabledReason: null,
  ...patch,
});
const sendAction = (): ActionView => structuredClone(defaultCard.actions[0]!);
const createAction = (patch: Partial<ActionView> = {}): ActionView => ({
  ...structuredClone(defaultCard.actions[1]!),
  ...patch,
});

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });
const detail = (patch: Partial<ItemDetail> = {}): ItemDetail => ({ ...structuredClone(defaultDetail), ...patch });
const changeOf = (patch: Partial<ChangeView> = {}): ChangeView => ({
  kind: 'reschedule',
  from: ev(),
  to: TO,
  confidence: 'high',
  baseRevision: 1,
  ...patch,
});
/** A delta item (UX2 3.3): a reply draft + a pending update_event. */
const delta = (patch: Partial<ItemVM> = {}, change: Partial<ChangeView> = {}): ItemVM =>
  card({
    eventState: 'change_proposed',
    change: changeOf(change),
    event: { ...changeOf(change).to, assumptions: [], dateHint: '' },
    badges: [],
    actions: [sendAction(), action({})],
    ...patch,
  });
const changeOnly = (change: Partial<ChangeView> = {}): ItemVM =>
  delta({ draft: null, replyState: 'none', actions: [action({})] }, change);
/** The item that landed a change (UX2 3.4). */
const landed = (patch: Partial<ItemVM> = {}): ItemVM =>
  card({
    status: 'in_calendar',
    eventState: 'updated',
    event: { ...TO, assumptions: [], dateHint: '' },
    badges: [],
    actions: [],
    draft: null,
    replyState: 'sent',
    calendar: { eventStartTs: Date.now() + 86_400_000, eventKey: 'k1', revision: 2, status: 'confirmed' },
    undo: { revisionId: 12, until: Date.now() + 3_600_000, state: 'available', automatic: false },
    ...patch,
  });
const autoState = (s: NonNullable<AutoState['policy']>['state'] | null): AutoState => ({
  policy:
    s === null
      ? null
      : {
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
  usedToday: { writes: 0, limit: 5 },
  undoableCount: 0,
});

beforeEach(() => {
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    openItemId: null,
    openItem: null,
    arrivedItemIds: new Set(),
    navRequest: null,
    sectionOpen: { needs_reply: true, in_calendar: true, info_missing: true },
    lists: {
      needs_reply: { items: [], count: 0 },
      in_calendar: { items: [], count: 0 },
      info_missing: { items: [], count: 0 },
    },
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    saveError: null,
    savedAt: 0,
    calendars: [],
    calendarsLoaded: false,
  });
  useAutoStore.setState({ state: null, rows: [], fetchedAt: 0, undoing: new Set(), failed: new Set() });
});

const approveCalls = (): unknown[] => invokeMocks['action:approve'].mock.calls.map((c) => c[0]);

// ---------------------------------------------------------------------------------------------------------------------
// the Change card
// ---------------------------------------------------------------------------------------------------------------------
describe('Change card - reschedule (UX2 3.3.1)', () => {
  it('ChangeLine between the bubble and the EventChip; the chip shows the NEW slot', () => {
    render(<ItemCard item={delta()} mode="compact" />);
    const line = screen.getByTestId('change-line-1');
    expect(line).toHaveAttribute('data-kind', 'reschedule');
    expect(line).toHaveTextContent('Change: Wed 15:00 → 17:00');
    const root = screen.getByTestId('card-1');
    const order = [
      ...root.querySelectorAll(
        '[data-testid="quoted-bubble"], [data-testid="change-line-1"], [data-testid="event-chip"]',
      ),
    ].map((n) => n.getAttribute('data-testid'));
    expect(order).toEqual(['quoted-bubble', 'change-line-1', 'event-chip']);
    expect(screen.getByTestId('event-chip-range')).toHaveTextContent('17:00');
  });

  it('the card\'s accessible name gains "change proposed"', () => {
    render(<ItemCard item={delta()} mode="compact" />);
    expect(screen.getByTestId('card-1')).toHaveAccessibleName(/change proposed$/);
  });

  it('with a draft: Approve & send is the accent; Approve change is outline; Keep 15:00 is quiet', () => {
    render(<ItemCard item={delta()} mode="compact" />);
    expect(screen.getByTestId('approve-send-1')).toHaveClass('btn-primary');
    expect(screen.getByTestId('approve-change-1')).toHaveClass('btn-outline');
    expect(screen.getByTestId('approve-change-1')).not.toHaveClass('btn-primary');
    expect(screen.getByTestId('approve-change-1')).toHaveTextContent('Approve change');
    expect(screen.getByTestId('keep-change-1')).toHaveTextContent('Keep 15:00');
    expect(screen.getByTestId('keep-change-1')).toHaveClass('btn-quiet');
  });

  it('change only (no reply to send): Approve change is the accent', () => {
    render(<ItemCard item={changeOnly()} mode="compact" />);
    expect(screen.getByTestId('approve-change-1')).toHaveClass('btn-primary');
    expect(screen.queryByTestId('approve-send-1')).toBeNull();
  });

  it('Approve change sends exactly one action:approve for the update_event with its shownHash', async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke('action:approve', () => new Promise((r) => (resolve = r)) as never);
    render(<ItemCard item={delta()} mode="compact" />);
    const b = screen.getByTestId('approve-change-1');
    act(() => {
      b.click();
      b.click();
    });
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
    expect(approveCalls()[0]).toEqual({ actionId: UPDATE_ID, kind: 'update_event', shownHash: UPDATE_HASH });
    expect(b).toHaveTextContent('Changing...');
    expect(b).toBeDisabled();
    await act(async () => resolve({ ok: true, value: { outcome: 'done', item: detail() } }));
    expect(screen.getByTestId('result-1')).toHaveTextContent('Changed in calendar');
  });

  it('Approve change is refused while the focus guard is armed (mouse and keyboard) and on a double click', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={delta()} mode="compact" />);
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('approve-change-1'));
    screen.getByTestId('approve-change-1').focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await user.dblClick(screen.getByTestId('approve-change-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
  });

  it('approving the change does not send the reply, and approving the reply does not change the event', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={delta()} mode="compact" />);
    await user.click(screen.getByTestId('approve-send-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(approveCalls()[0]).toMatchObject({ kind: 'send_reply', actionId: SEND_ID });
  });

  it('Keep 15:00 = action:reject of the update_event; no approval; not guarded (fail-safe)', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={delta()} mode="compact" />);
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('keep-change-1'));
    await waitFor(() => expect(invokeMocks['action:reject']).toHaveBeenCalledWith({ actionId: UPDATE_ID }));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
    await waitFor(() => expect(invokeMocks['dashboard:get']).toHaveBeenCalled());
  });

  it('never approves on its own: rendering and waiting send no IPC', () => {
    vi.useFakeTimers();
    try {
      render(<ItemCard item={delta()} mode="compact" />);
      vi.advanceTimersByTime(60_000);
      expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
      expect(invokeMocks['action:reject']).not.toHaveBeenCalled();
      expect(invokeMocks['item:undoChange']).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a calendar that cannot update greys Approve change with the reason (B4)', () => {
    render(
      <ItemCard
        item={delta({ actions: [sendAction(), action({ disabledReason: 'calendar_updates_unavailable' })] })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('approve-change-1')).toBeDisabled();
    expect(screen.getByTestId('approve-change-1-reason')).toHaveTextContent('Changes to events are unavailable');
  });

  it('a calendar that is unavailable greys it too', () => {
    render(<ItemCard item={delta({ actions: [action({ disabledReason: 'calendar_unavailable' })] })} mode="compact" />);
    expect(screen.getByTestId('approve-change-1')).toBeDisabled();
  });
});

describe('Change card - move and cancel', () => {
  it('move: "Place: Cafe Noir -> Office" and "Keep the old place"', () => {
    render(<ItemCard item={delta({}, { kind: 'move', to: ev({ location: 'Office' }) })} mode="compact" />);
    expect(screen.getByTestId('change-line-1')).toHaveAttribute('data-kind', 'move');
    expect(screen.getByTestId('keep-change-1')).toHaveTextContent('Keep the old place');
  });

  it('cancel: "Cancel event" is outline with danger TEXT (never a danger fill); "Keep it"', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={delta({}, { kind: 'cancel', to: ev({ status: 'cancelled' }) })} mode="compact" />);
    const cancel = screen.getByTestId('cancel-event-1');
    expect(cancel).toHaveClass('btn-outline', 'text-danger');
    expect(cancel.className).not.toMatch(/btn-danger|btn-primary/);
    expect(screen.getByTestId('keep-event-1')).toHaveTextContent('Keep it');
    expect(screen.queryByTestId('approve-change-1')).toBeNull();
    await user.click(cancel);
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(approveCalls()[0]).toMatchObject({ kind: 'update_event', actionId: UPDATE_ID });
  });

  it('cancel done says "Cancelled in calendar"', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={changeOnly({ kind: 'cancel' })} mode="compact" />);
    await user.click(screen.getByTestId('cancel-event-1'));
    await waitFor(() => expect(screen.getByTestId('result-1')).toHaveTextContent('Cancelled in calendar'));
  });
});

describe('Change card - change_unclear, declined, change_target_unclear, self trigger', () => {
  it('change_unclear: the amber badge, no ChangeLine and no change buttons', () => {
    render(<ItemCard item={delta({ badges: ['change_unclear'] })} mode="compact" />);
    expect(screen.getByTestId('badge-change_unclear')).toHaveTextContent('Change unclear');
    expect(screen.queryByTestId('change-line-1')).toBeNull();
    expect(screen.queryByTestId('approve-change-1')).toBeNull();
    expect(screen.queryByTestId('keep-change-1')).toBeNull();
    expect(screen.getByTestId('approve-send-1')).toBeInTheDocument();
  });

  it('declined (Keep 15:00 was pressed): a plain reply card again', () => {
    render(<ItemCard item={delta({ eventState: 'declined', actions: [sendAction()] })} mode="compact" />);
    expect(screen.queryByTestId('change-line-1')).toBeNull();
    expect(screen.queryByTestId('event-chip')).toBeNull();
    expect(screen.getByTestId('approve-send-1')).toBeInTheDocument();
  });

  it('change_target_unclear (F31): amber card badge with the long sentence', () => {
    render(<ItemCard item={delta({ badges: ['change_target_unclear'] })} mode="compact" />);
    const b = screen.getByTestId('badge-change_target_unclear');
    expect(b).toHaveClass('bg-warn-soft');
    expect(b).toHaveAttribute('title', expect.stringContaining('the change would apply to the latest'));
  });

  it('a self-triggered delta (F28) shows "You changed this in the chat"', () => {
    const item = { ...changeOnly(), triggerAuthor: 'self' } as ItemVM;
    render(<ItemCard item={item} mode="compact" />);
    expect(screen.getByTestId('badge-self-trigger')).toHaveTextContent('You changed this in the chat');
    expect(selfTriggered(item)).toBe(true);
    expect(selfTriggered(changeOnly())).toBe(false);
  });
});

describe('Change card - update_event results (UX2 3.3.4)', () => {
  it('pre-flight drift: "In Google it is now ... - apply the change anyway?"; Apply anyway re-sends with confirmDrift', async () => {
    const user = userEvent.setup();
    const current = ev({ startLocal: `${DAY}T16:00:00`, endLocal: `${DAY}T17:00:00` });
    mockInvoke('action:approve', (req) =>
      (req as { confirmDrift?: true }).confirmDrift
        ? { ok: true, value: { outcome: 'done', item: detail() } }
        : { ok: true, value: { outcome: 'needs_confirm_drift', current, item: detail({ actions: [action({})] }) } },
    );
    render(<ItemCard item={delta()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    const row = await screen.findByTestId('drift-row-1');
    expect(row).toHaveAttribute('data-tone', 'warn');
    expect(row).toHaveTextContent(/In Google it is now Wed \d+ \S+ 16:00 - apply the change anyway\?/);
    expect(screen.getByTestId('apply-anyway-1')).toHaveClass('btn-outline');
    await user.click(screen.getByTestId('apply-anyway-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(approveCalls()[1]).toEqual({
      actionId: UPDATE_ID,
      kind: 'update_event',
      shownHash: UPDATE_HASH,
      confirmDrift: true,
    });
  });

  it('HTTP 412: "Apply anyway" approves the pending clone, never the failed action', async () => {
    const user = userEvent.setup();
    const current = ev({ startLocal: `${DAY}T16:00:00` });
    const clone = action({ actionId: CLONE_ID, shownHash: 'd'.repeat(64) });
    mockInvoke('action:approve', () => ({
      ok: true,
      value: {
        outcome: 'needs_confirm_drift',
        current,
        item: detail({ actions: [action({ state: 'failed', errorCode: 'CAL_PRECONDITION_FAILED' as never }), clone] }),
      },
    }));
    render(<ItemCard item={delta()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    await user.click(await screen.findByTestId('apply-anyway-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(approveCalls()[1]).toMatchObject({ actionId: CLONE_ID, confirmDrift: true });
  });

  it("Apply anyway is guarded; Keep Google's is not, and rejects the pending update", async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({
      ok: true,
      value: { outcome: 'needs_confirm_drift', current: ev(), item: detail({ actions: [action({})] }) },
    }));
    render(<ItemCard item={delta()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    await screen.findByTestId('drift-row-1');
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('apply-anyway-1'));
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('keep-google-1'));
    await waitFor(() => expect(invokeMocks['action:reject']).toHaveBeenCalledWith({ actionId: UPDATE_ID }));
    expect(screen.queryByTestId('drift-row-1')).toBeNull();
  });

  it('CAL_EVENT_GONE: "The event is no longer in your calendar" + Add as new event (the inserted pending create)', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', (req) =>
      (req as { kind: string }).kind === 'create_event'
        ? { ok: true, value: { outcome: 'done', item: detail() } }
        : {
            ok: true,
            value: {
              outcome: 'failed',
              item: detail({ actions: [action({ state: 'failed', errorCode: 'CAL_EVENT_GONE' }), createAction()] }),
            },
          },
    );
    render(<ItemCard item={changeOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    const row = await screen.findByTestId('result-1');
    expect(row).toHaveTextContent('The event is no longer in your calendar');
    const add = screen.getByTestId('add-new-event-1');
    expect(add).toHaveClass('btn-outline');
    await user.click(add);
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(approveCalls()[1]).toMatchObject({ kind: 'create_event', actionId: CREATE_ID });
  });

  it('CAL_EVENT_FOREIGN: an info row with no action', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({
      ok: true,
      value: {
        outcome: 'failed',
        item: detail({ actions: [action({ state: 'failed', errorCode: 'CAL_EVENT_FOREIGN' })] }),
      },
    }));
    render(<ItemCard item={changeOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    const row = await screen.findByTestId('result-1');
    expect(row).toHaveAttribute('data-tone', 'info');
    expect(row).toHaveTextContent('This event was not added by the agent - Change it in Google Calendar.');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('CAL_UPDATE_FAILED: "Try again" approves the retry clone', async () => {
    const user = userEvent.setup();
    const clone = action({ actionId: CLONE_ID, lastError: 'CAL_UPDATE_FAILED' });
    mockInvoke('action:approve', () => ({
      ok: true,
      value: {
        outcome: 'failed',
        item: detail({ actions: [action({ state: 'failed', errorCode: 'CAL_UPDATE_FAILED' }), clone] }),
      },
    }));
    render(<ItemCard item={changeOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    expect(await screen.findByTestId('result-1')).toHaveTextContent(
      'The change was not saved. Nothing in your calendar changed.',
    );
    await user.click(screen.getByTestId('result-try-again'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(2));
    expect(approveCalls()[1]).toMatchObject({ actionId: CLONE_ID });
  });

  it('unknown outcome: "Apply again" is a new action and a new click', async () => {
    const user = userEvent.setup();
    const clone = action({ actionId: CLONE_ID });
    mockInvoke('action:approve', () => ({
      ok: true,
      value: { outcome: 'failed', item: detail({ actions: [action({ state: 'unknown_outcome' }), clone] }) },
    }));
    render(<ItemCard item={changeOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    const again = await screen.findByTestId('result-send-again');
    expect(again).toHaveTextContent('Apply again');
    expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1);
  });

  it('ACTION_STALE: "This card changed - review again" + Refresh card', async () => {
    const user = userEvent.setup();
    mockInvoke('action:approve', () => ({ ok: false, error: { code: 'ACTION_STALE' } }));
    render(<ItemCard item={changeOnly()} mode="compact" />);
    await user.click(screen.getByTestId('approve-change-1'));
    expect(await screen.findByTestId('result-1')).toHaveTextContent('This card changed');
    expect(screen.getByTestId('result-refresh')).toBeInTheDocument();
  });

  it('after a refresh, an update that ended FOREIGN / GONE keeps saying so', () => {
    const { rerender } = render(
      <ItemCard
        item={card({
          actions: [action({ state: 'failed', errorCode: 'CAL_EVENT_FOREIGN' })],
          eventState: 'none',
          event: null,
        })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('update-ended-1')).toHaveAttribute('data-code', 'CAL_EVENT_FOREIGN');
    rerender(
      <ItemCard
        item={card({ actions: [action({ state: 'failed', errorCode: 'CAL_EVENT_GONE' }), createAction()], badges: [] })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('update-ended-1')).toHaveTextContent('The event is no longer in your calendar');
    expect(screen.getByTestId('add-new-event-1')).toHaveTextContent('Add as new event');
    expect(screen.queryByTestId('approve-event-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// after a change lands (UX2 3.4)
// ---------------------------------------------------------------------------------------------------------------------
describe('Updated / Cancelled + Undo', () => {
  it('updated: "(v) Updated · rev 2", Undo (outline, never accent) and Open in calendar', () => {
    render(<ItemCard item={landed()} mode="compact" />);
    expect(screen.getByTestId('event-chip-updated')).toBeInTheDocument();
    expect(screen.getByTestId('event-chip-rev')).toHaveTextContent('Updated · rev 2');
    expect(screen.getByTestId('undo-1')).toHaveClass('btn-outline');
    expect(screen.getByTestId('undo-1')).not.toHaveClass('btn-primary');
    expect(screen.getByTestId('open-calendar-1')).toBeInTheDocument();
    expect(screen.getAllByText('Open in calendar')).toHaveLength(1);
  });

  it('cancelled: struck title plus the word "Cancelled" (never colour alone)', () => {
    render(
      <ItemCard
        item={landed({
          eventState: 'cancelled',
          event: { ...ev({ status: 'cancelled' }), assumptions: [], dateHint: '' },
        })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('event-chip-cancelled')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('event-chip-title')).toHaveClass('event-cancelled');
  });

  it('Undo = exactly one item:undoChange {itemId, revisionId}; then "Undone"', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={landed()} mode="compact" />);
    await user.dblClick(screen.getByTestId('undo-1'));
    await waitFor(() => expect(screen.getByTestId('undo-state-1')).toHaveAttribute('data-state', 'undone'));
    expect(invokeMocks['item:undoChange']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['item:undoChange']).toHaveBeenCalledWith({ itemId: 1, revisionId: 12 });
  });

  it('Undo is refused while the focus guard is armed', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={landed()} mode="compact" />);
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('undo-1'));
    expect(invokeMocks['item:undoChange']).not.toHaveBeenCalled();
  });

  it('blocked_started: the guarded "Cancel event" calls item:cancelEvent (F32)', async () => {
    const user = userEvent.setup();
    render(
      <ItemCard
        item={landed({ undo: { revisionId: 12, until: 0, state: 'blocked_started', automatic: true } })}
        mode="compact"
      />,
    );
    await user.click(screen.getByTestId('undo-cancel-event-1'));
    await waitFor(() => expect(invokeMocks['item:cancelEvent']).toHaveBeenCalledWith({ itemId: 1 }));
  });

  it('Restore original after two automatic edits (F1): item:restoreOriginal, guarded', async () => {
    const user = userEvent.setup();
    const item = landed({
      calendar: { eventStartTs: Date.now() + 86_400_000, eventKey: 'k1', revision: 3, status: 'confirmed' },
      undo: { revisionId: 12, until: Date.now() + 3_600_000, state: 'available', automatic: true },
    });
    expect(canRestoreOriginal(item)).toBe(true);
    render(<ItemCard item={item} mode="compact" />);
    useFocusGuardStore.setState({ activationBlockedUntil: Date.now() + 60_000 });
    await user.click(screen.getByTestId('restore-original-1'));
    expect(invokeMocks['item:restoreOriginal']).not.toHaveBeenCalled();
    useFocusGuardStore.setState({ activationBlockedUntil: 0 });
    await user.click(screen.getByTestId('restore-original-1'));
    await waitFor(() => expect(invokeMocks['item:restoreOriginal']).toHaveBeenCalledWith({ itemId: 1 }));
  });

  it('no Restore original for a manual change, a single edit, or an undone one', () => {
    expect(canRestoreOriginal(landed())).toBe(false);
    expect(canRestoreOriginal(landed({ undo: { revisionId: 1, until: 0, state: 'available', automatic: true } }))).toBe(
      false,
    );
    expect(
      canRestoreOriginal(
        landed({
          calendar: { eventStartTs: null, eventKey: 'k', revision: 4, status: 'confirmed' },
          undo: { revisionId: 1, until: 0, state: 'undone', automatic: true },
        }),
      ),
    ).toBe(false);
    render(<ItemCard item={landed()} mode="compact" />);
    expect(screen.queryByTestId('restore-original-1')).toBeNull();
  });

  it('restore refused (U-E1): the amber line + "Add it back" approves the pending create_event', async () => {
    const user = userEvent.setup();
    render(
      <ItemCard
        item={landed({
          eventState: 'cancelled',
          calendar: { eventStartTs: null, eventKey: 'k1', revision: 3, status: 'cancelled' },
          actions: [createAction()],
          undo: null,
        })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('restore-refused-1')).toHaveTextContent('Google did not restore the cancelled event.');
    expect(screen.queryByTestId('approve-event-1')).toBeNull();
    const add = screen.getByTestId('add-back-1');
    expect(add).toHaveTextContent('Add it back');
    expect(add).not.toHaveClass('btn-primary');
    await user.click(add);
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(approveCalls()[0]).toMatchObject({ kind: 'create_event', actionId: CREATE_ID });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// automatic mode on the card (UX2 3.2)
// ---------------------------------------------------------------------------------------------------------------------
describe('automatic mode on the card', () => {
  it('automatic chip names the write: added / moved / cancelled automatically', () => {
    const auto = { chip: 'automatic' as const, notAutomaticReason: null, autoWriteId: null };
    const { rerender } = render(<ItemCard item={landed({ eventState: 'created', auto })} mode="compact" />);
    const chip = screen.getByTestId('auto-chip-1');
    expect(chip).toHaveAttribute('data-chip', 'automatic');
    expect(chip).toHaveTextContent('Added automatically');
    expect(chip).toHaveClass('chip-info');
    expect(chip.querySelector('.icon-auto')).not.toBeNull();
    rerender(<ItemCard item={landed({ eventState: 'updated', auto })} mode="compact" />);
    expect(screen.getByTestId('auto-chip-1')).toHaveTextContent('Moved automatically');
    rerender(<ItemCard item={landed({ eventState: 'cancelled', auto })} mode="compact" />);
    expect(screen.getByTestId('auto-chip-1')).toHaveTextContent('Cancelled automatically');
  });

  it('auto_shadow: "Would have been automatic", dashed; the raw badge codes are not drawn twice', () => {
    render(
      <ItemCard
        item={card({
          badges: ['auto_shadow'],
          auto: { chip: 'auto_shadow', notAutomaticReason: null, autoWriteId: null },
        })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('auto-chip-1')).toHaveClass('chip-shadow');
    expect(screen.getByTestId('auto-chip-1')).toHaveTextContent('Would have been automatic');
    expect(screen.queryByTestId('badge-auto_shadow')).toBeNull();
  });

  it('old rows without an auto view still get the chip from the badge', () => {
    expect(autoChipOf(card({ badges: ['automatic'] }))).toBe('automatic');
    expect(autoChipOf(card({ badges: ['auto_shadow'] }))).toBe('auto_shadow');
    expect(autoChipOf(card({ badges: [] }))).toBeNull();
  });

  const reasons = AUTO_REASONS.filter((r) => r !== 'ok' && r !== 'policy_shadow');
  it.each(reasons)('"Not automatic: %s" renders its app sentence while a policy is live', (reason) => {
    useAutoStore.setState({ state: autoState('on') });
    render(
      <ItemCard item={card({ auto: { chip: null, notAutomaticReason: reason, autoWriteId: null } })} mode="compact" />,
    );
    const line = screen.getByTestId('auto-reason-1');
    expect(line).toHaveAttribute('data-reason', reason);
    expect(line.textContent).toBe(`Not automatic: ${i18next.t(`auto.reason.${reason}`)}`);
    expect(screen.getByTestId('approve-event-1').getAttribute('aria-describedby')).toContain('auto-reason-1');
  });

  it('the reason line is gated: no live policy, no pending calendar approval, ok / policy_shadow => nothing', () => {
    const withReason = (reason: (typeof AUTO_REASONS)[number], patch: Partial<ItemVM> = {}): ItemVM =>
      card({ auto: { chip: null, notAutomaticReason: reason, autoWriteId: null }, ...patch });
    for (const s of [null, 'disabled', 'expired'] as const) {
      useAutoStore.setState({ state: s === null ? null : autoState(s) });
      const { unmount } = render(<ItemCard item={withReason('badge_amber')} mode="compact" />);
      expect(screen.queryByTestId('auto-reason-1')).toBeNull();
      unmount();
    }
    for (const s of ['shadow', 'paused'] as const) {
      useAutoStore.setState({ state: autoState(s) });
      const { unmount } = render(<ItemCard item={withReason('badge_amber')} mode="compact" />);
      expect(screen.getByTestId('auto-reason-1')).toBeInTheDocument();
      unmount();
    }
    useAutoStore.setState({ state: autoState('on') });
    const noCalendar = withReason('badge_amber', { actions: [sendAction()] });
    expect(visibleAutoReason(noCalendar, true, false)).toBeNull();
    expect(visibleAutoReason(withReason('ok'), true, true)).toBeNull();
    expect(visibleAutoReason(withReason('policy_shadow'), true, true)).toBeNull();
    expect(visibleAutoReason(card(), true, true)).toBeNull();
  });

  it('the reason line describes the Approve change button too', () => {
    useAutoStore.setState({ state: autoState('on') });
    render(
      <ItemCard
        item={delta({ auto: { chip: null, notAutomaticReason: 'media_derived', autoWriteId: null } })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('approve-change-1').getAttribute('aria-describedby')).toContain('auto-reason-1');
    expect(screen.getByTestId('auto-reason-1')).toHaveTextContent(
      'Not automatic: it came from a voice note or a picture',
    );
  });

  it('overflow "Never automatic for this contact" only once a policy exists; toast Undo restores inherit', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('overflow-1'));
    expect(screen.queryByTestId('never-auto-1')).toBeNull();
    unmount();
    useAutoStore.setState({ state: autoState('disabled') });
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('overflow-1'));
    await user.click(screen.getByTestId('never-auto-1'));
    await waitFor(() =>
      expect(invokeMocks['chat:setPolicy']).toHaveBeenCalledWith({ chatRef: 1, autoPolicy: 'never' }),
    );
    await waitFor(() => expect(useDashboardStore.getState().toast?.key).toBe('auto.neverToast'));
    useDashboardStore.getState().toast?.onUndo?.();
    await waitFor(() =>
      expect(invokeMocks['chat:setPolicy']).toHaveBeenLastCalledWith({ chatRef: 1, autoPolicy: 'inherit' }),
    );
  });

  it('a contact already on "never" reads "Automatic for this contact: never - Allow again"', async () => {
    const user = userEvent.setup();
    useAutoStore.setState({ state: autoState('on') });
    render(<ItemCard item={card({ chat: { ...defaultCard.chat, autoPolicy: 'never' } })} mode="compact" />);
    await user.click(screen.getByTestId('overflow-1'));
    const item = screen.getByTestId('never-auto-1');
    expect(item).toHaveTextContent('Automatic for this contact: never - Allow again');
    await user.click(item);
    await waitFor(() =>
      expect(invokeMocks['chat:setPolicy']).toHaveBeenCalledWith({ chatRef: 1, autoPolicy: 'inherit' }),
    );
    expect(invokeMocks['settings:set']).not.toHaveBeenCalled();
  });

  it("an automatic item's sheet opens with the Automatic block; See all asks the shell for the activity page", async () => {
    const user = userEvent.setup();
    const id = '00000000-0000-4000-8000-000000000001';
    useAutoStore.setState({
      rows: [
        {
          autoWriteId: id,
          itemId: 1,
          kind: 'create',
          event: TO,
          before: null,
          writtenAt: Date.UTC(2026, 8, 23, 9, 0),
          undoState: 'available',
          undoUntil: Date.now() + 1e6,
          revisionId: 12,
        },
      ],
    });
    const onClose = vi.fn();
    render(
      <ItemCard
        item={{
          ...landed({ eventState: 'created', auto: { chip: 'automatic', notAutomaticReason: null, autoWriteId: id } }),
          messages: [],
        }}
        mode="expanded"
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('sheet-auto-block')).toHaveTextContent(/Added automatically on Wed 23 Sep\w* 12:00/);
    await user.click(screen.getByTestId('sheet-auto-activity'));
    expect(useDashboardStore.getState().navRequest).toEqual({ view: 'activity' });
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// source card of a pending change (UX2 3.3.3)
// ---------------------------------------------------------------------------------------------------------------------
describe('"Change proposed - see Needs reply"', () => {
  it('the source card wears the chip; activating it focuses the delta card of the same chat', async () => {
    const user = userEvent.setup();
    const source = landed({ itemId: 5, changePending: true, undo: null });
    const d = delta({ itemId: 9 });
    useDashboardStore.setState({
      lists: {
        needs_reply: { items: [d], count: 1 },
        in_calendar: { items: [source], count: 1 },
        info_missing: { items: [], count: 0 },
      },
    });
    render(
      <>
        <ItemCard item={d} mode="compact" />
        <ItemCard item={source} mode="compact" />
      </>,
    );
    const chip = screen.getByTestId('change-pending-chip-5');
    expect(chip).toHaveTextContent('Change proposed - see Needs reply');
    await user.click(chip);
    expect(document.activeElement).toBe(screen.getByTestId('card-9'));
  });

  it('opens a collapsed Needs reply section first; the sheet says the scope note', async () => {
    const user = userEvent.setup();
    const source = landed({ itemId: 5, changePending: true, undo: null });
    const d = delta({ itemId: 9 });
    useDashboardStore.setState({
      sectionOpen: { needs_reply: false, in_calendar: true, info_missing: true },
      lists: {
        needs_reply: { items: [d], count: 1 },
        in_calendar: { items: [source], count: 1 },
        info_missing: { items: [], count: 0 },
      },
    });
    const onClose = vi.fn();
    render(<ItemCard item={{ ...source, messages: [] }} mode="expanded" onClose={onClose} />);
    expect(screen.getByTestId('change-latest-only')).toHaveTextContent(
      'Changes apply to the latest event of this chat.',
    );
    await user.click(screen.getByTestId('change-pending-chip-5'));
    expect(useDashboardStore.getState().sectionOpen.needs_reply).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });

  it('with no delta card in the lists nothing moves', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={landed({ itemId: 5, changePending: true, undo: null })} mode="compact" />);
    await user.click(screen.getByTestId('change-pending-chip-5'));
    expect(useDashboardStore.getState().sectionOpen.needs_reply).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// voice / picture triggers
// ---------------------------------------------------------------------------------------------------------------------
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const read = {
  thumbDataUrl: JPEG,
  readText: 'Wedding Thursday 19:00',
  dateText: 'Thursday',
  timeText: '19:00',
  location: 'Gan',
  confidence: 'medium' as const,
  kind: 'invitation' as const,
};

describe('voice and picture triggers', () => {
  it('a voice trigger renders the VoiceBubble inside the card', () => {
    render(
      <ItemCard
        item={card({
          triggerKind: 'voice',
          trigger: { ts: Date.now() - 60_000, text: '' },
          voice: { seconds: 42, language: 'he', transcript: 'נזיז ל-5', status: 'done' },
        })}
        mode="compact"
        onOpen={vi.fn()}
      />,
    );
    const wrap = screen.getByTestId('voice-bubble-1');
    expect(within(wrap).getByTestId('voice-transcript')).toHaveTextContent('נזיז ל-5');
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-trigger-kind', 'voice');
    expect(screen.getByTestId('show-more-1')).toBeInTheDocument();
  });

  it('a picture trigger renders the ImageBubble with its inert thumbnail', () => {
    render(
      <ItemCard
        item={card({
          triggerKind: 'image',
          trigger: { ts: Date.now(), text: '' },
          image: read,
          badges: ['from_image'],
        })}
        mode="compact"
      />,
    );
    expect(within(screen.getByTestId('image-bubble-1')).getByTestId('image-thumb')).toHaveAttribute('src', JPEG);
    expect(screen.getByTestId('badge-from_image')).toHaveTextContent('From a picture');
  });

  it('"Hard to read" is a button that opens the sheet (Date field focus)', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <ItemCard
        item={card({ triggerKind: 'image', image: read, badges: ['from_image', 'image_unclear'] })}
        mode="compact"
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByTestId('badge-image_unclear'));
    expect(onOpen).toHaveBeenCalled();
  });

  it('sheet: "The picture" comes from item:getImage (data URL only), "What the AI read" is open when unclear', async () => {
    mockInvoke('item:getImage', () => ({ ok: true, value: { dataUrl: JPEG } }));
    render(
      <ItemCard
        item={detail({ triggerKind: 'image', image: read, badges: ['from_image', 'image_unclear'] })}
        mode="expanded"
      />,
    );
    expect(await screen.findByTestId('sheet-picture-img')).toHaveAttribute('src', JPEG);
    expect(invokeMocks['item:getImage']).toHaveBeenCalledWith({ itemId: 1 });
    const details = screen.getByTestId('sheet-picture-read');
    expect(details).toHaveAttribute('open');
    expect(within(details).getByTestId('sheet-as-written-time')).toHaveTextContent('Time as written: 19:00');
    expect(screen.getByTestId('event-date-note')).toHaveTextContent('Check against the picture');
    expect(screen.getByTestId('event-date')).toHaveAttribute(
      'aria-describedby',
      screen.getByTestId('event-date-note').id,
    );
  });

  it('sheet: an http answer from item:getImage is never displayed', async () => {
    mockInvoke('item:getImage', () => ({ ok: true, value: { dataUrl: 'https://evil.example/x.jpg' } }));
    render(<ItemCard item={detail({ triggerKind: 'image', image: read })} mode="expanded" />);
    await waitFor(() => expect(invokeMocks['item:getImage']).toHaveBeenCalled());
    expect(screen.queryByTestId('sheet-picture-img')).toBeNull();
    expect(screen.getByTestId('sheet-picture-read')).not.toHaveAttribute('open');
  });

  it('sheet conversation: voice rows show the full transcript, picture rows the read text without a thumbnail', () => {
    render(
      <ItemCard
        item={detail({
          messages: [
            {
              seq: 0,
              fromMe: false,
              ts: 1,
              text: null,
              voice: { seconds: 5, language: 'en', transcript: 'hi there', status: 'done' },
            },
            { seq: 1, fromMe: false, ts: 2, text: null, image: { thumbDataUrl: JPEG, readText: 'Poster text' } },
            { seq: 2, fromMe: true, ts: 3, text: 'ok' },
          ],
        })}
        mode="expanded"
      />,
    );
    expect(within(screen.getByTestId('voice-row-0')).getByTestId('voice-transcript').style.webkitLineClamp).toBe('');
    const img = screen.getByTestId('image-row-1');
    expect(within(img).getByTestId('image-readtext')).toHaveTextContent('Poster text');
    expect(img.querySelector('img')).toBeNull();
  });

  it('a picture that was not read carries its one action on a full card too', () => {
    useSettingsStore.setState({
      settings: { ...structuredClone(DEFAULT_SETTINGS), images: { enabled: false, cloud: true } },
    });
    render(<ItemCard item={card({ triggerKind: 'image', image: null, badges: ['image_unread'] })} mode="compact" />);
    expect(screen.getByTestId('image-unread-action-1')).toHaveAttribute('data-cause', 'disabled');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the sheet of a delta item: edits `to` only (I3')
// ---------------------------------------------------------------------------------------------------------------------
describe('delta sheet', () => {
  it('"Now in your calendar" (the from values) above the editor in change mode; title read-only', () => {
    render(<ItemCard item={{ ...delta(), messages: [] }} mode="expanded" />);
    expect(screen.getByTestId('sheet-now-in-calendar')).toHaveTextContent(
      /Now in your calendar: Wed \d+ \S+ 15:00 · Cafe Noir/,
    );
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'change');
    expect(screen.queryByTestId('event-title')).toBeNull();
    expect(screen.getByTestId('event-readonly-title')).toHaveTextContent('Meeting');
    expect(screen.getByTestId('event-title-not-applied')).toBeInTheDocument();
    expect(screen.queryByTestId('event-calendar')).toBeNull();
  });

  it('an edited `to` travels with Approve change and pins the card (dirty rule)', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={{ ...changeOnly(), messages: [] }} mode="expanded" />);
    const start = screen.getByTestId('event-start');
    await user.clear(start);
    await user.type(start, '18:00');
    const end = screen.getByTestId('event-end');
    await user.clear(end);
    await user.type(end, '19:00');
    await waitFor(() => expect(useDashboardStore.getState().dirtyItemIds.has(1)).toBe(true));
    await user.click(screen.getByTestId('approve-change-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(approveCalls()[0]).toMatchObject({
      kind: 'update_event',
      edit: { title: 'Meeting', startLocal: `${DAY}T18:00:00`, endLocal: `${DAY}T19:00:00`, location: 'Cafe Noir' },
    });
  });

  it('an invalid edit greys Approve change with the reason', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={{ ...changeOnly(), messages: [] }} mode="expanded" />);
    const end = screen.getByTestId('event-end');
    await user.clear(end);
    await user.type(end, '10:00');
    await waitFor(() => expect(screen.getByTestId('approve-change-1')).toBeDisabled());
  });

  it('eventVmOf: the new slot while proposed, nothing when declined, item.event otherwise', () => {
    expect(eventVmOf(delta())?.startLocal).toBe(`${DAY}T17:00:00`);
    expect(eventVmOf(delta({ eventState: 'declined' }))).toBeNull();
    expect(eventVmOf(landed())?.state).toBe('updated');
    expect(eventVmOf(landed())?.revision).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// RTL snapshots (UX2 15.8): the Change card in all three kinds, he and en, at a fixed clock
// ---------------------------------------------------------------------------------------------------------------------
describe('Change card snapshots', () => {
  const FIXED = Date.UTC(2026, 8, 20, 9, 0);
  const fixed = (kind: ChangeView['kind']): ItemVM => {
    const from: EventContentView = {
      title: 'Meeting',
      startLocal: '2026-09-30T15:00:00',
      endLocal: '2026-09-30T16:00:00',
      timeZone: 'Asia/Jerusalem',
      location: 'Cafe Noir',
      status: 'confirmed',
    };
    const to =
      kind === 'move'
        ? { ...from, location: 'Office' }
        : kind === 'cancel'
          ? { ...from, status: 'cancelled' as const }
          : { ...from, startLocal: '2026-09-30T17:00:00', endLocal: '2026-09-30T18:00:00' };
    return card({
      trigger: { ts: FIXED - 60_000, text: 'can we do 5 instead of 3?' },
      eventState: 'change_proposed',
      change: { kind, from, to, confidence: 'high', baseRevision: 1 },
      event: { ...to, assumptions: [], dateHint: '' },
      badges: [],
      actions: [sendAction(), action({})],
    });
  };
  for (const kind of ['reschedule', 'move', 'cancel'] as const) {
    for (const lang of ['he', 'en'] as const) {
      it(`${kind} ${lang}`, async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(FIXED);
        try {
          if (lang === 'he') {
            await i18next.changeLanguage('he');
            document.documentElement.dir = 'rtl';
          }
          const { container } = render(<ItemCard item={fixed(kind)} mode="compact" />);
          expect(container.firstChild).toMatchSnapshot();
        } finally {
          vi.useRealTimers();
        }
      });
    }
  }
});
