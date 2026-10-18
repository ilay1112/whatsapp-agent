// T-904 v3 Task 5 (docs/specs/v3-dashboard-handover.md 2.1, 2.4): the compact card's dismiss X, "Edit time" on a
// proposed / change card, and "Save time" under the information-missing fill form.
// Approval-first: "Edit time" only changes what the existing `action:approve` click carries; "Save time" writes a
// PROPOSAL through `item:completeEvent`, never a calendar event, and never fires `action:approve`.
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ActionView, ChangeView, EventContentView, ItemCard as ItemVM, ItemDetail } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { ItemCard } from './ItemCard';
import { useDashboardStore } from '../store/dashboard';
import { useFocusGuardStore } from '../store/health';
import { useSettingsStore } from '../store/settings';
import { defaultCard, defaultDetail, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

// ---------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------
const EVENT_DAY = defaultCard.event!.startLocal.slice(0, 10);
/** A Wednesday two weeks out (always in the future, always inside the horizon). */
const DAY = ((): string => {
  const d = new Date(Date.now() + 14 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
})();
/** More than `LIMITS.eventHorizonMonths` (12) ahead. */
const TOO_FAR = ((): string => {
  const d = new Date(Date.now() + 400 * 86_400_000);
  return d.toISOString().slice(0, 10);
})();

const card = (patch: Partial<ItemVM> = {}): ItemVM => ({ ...structuredClone(defaultCard), ...patch });
const detail = (patch: Partial<ItemDetail> = {}): ItemDetail => ({ ...structuredClone(defaultDetail), ...patch });
const sendAction = (): ActionView => structuredClone(defaultCard.actions[0]!);

const ev = (patch: Partial<EventContentView> = {}): EventContentView => ({
  title: 'Meeting',
  startLocal: `${DAY}T15:00:00`,
  endLocal: `${DAY}T16:00:00`,
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
  ...patch,
});
const changeOf = (patch: Partial<ChangeView> = {}): ChangeView => ({
  kind: 'reschedule',
  from: ev(),
  to: ev({ startLocal: `${DAY}T17:00:00`, endLocal: `${DAY}T18:00:00` }),
  confidence: 'high',
  baseRevision: 1,
  ...patch,
});
const updateAction = (): ActionView => ({
  actionId: '33333333-3333-4333-8333-333333333333',
  kind: 'update_event',
  shownHash: 'c'.repeat(64),
  state: 'pending',
  expiresAt: Date.now() + 86_400_000,
  attempt: 1,
  errorCode: null,
  lastError: null,
  disabledReason: null,
});
const delta = (): ItemVM =>
  card({
    eventState: 'change_proposed',
    change: changeOf(),
    event: { ...changeOf().to, assumptions: [], dateHint: '' },
    badges: [],
    draft: null,
    replyState: 'none',
    actions: [updateAction()],
  });

/** An information-missing card: the title is known, the day and the time are not; only "Ask for details" is pending. */
const infoMissing = (patch: Partial<ItemVM> = {}): ItemVM =>
  card({
    status: 'info_missing',
    eventState: 'incomplete',
    event: {
      title: 'Coffee',
      startLocal: '',
      endLocal: '',
      timeZone: 'Asia/Jerusalem',
      location: '',
      assumptions: [],
      dateHint: '',
    },
    missing: ['date', 'time'],
    badges: [],
    actions: [sendAction()],
    ...patch,
  });

beforeEach(() => {
  useDashboardStore.setState({
    dirtyItemIds: new Set(),
    staleItemIds: new Set(),
    toast: null,
    openItemId: null,
    openItem: null,
    arrivedItemIds: new Set(),
  });
  useFocusGuardStore.setState({ activationBlockedUntil: 0 });
  useSettingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    saveError: null,
    savedAt: 0,
    calendars: [],
    calendarsLoaded: false,
  });
});

async function fillTime(user: ReturnType<typeof userEvent.setup>, date: string, start: string, end: string) {
  await user.type(screen.getByTestId('event-date'), date);
  await user.type(screen.getByTestId('event-start'), start);
  await user.type(screen.getByTestId('event-end'), end);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2.1 the dismiss X
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard v3 - dismiss X (2.1)', () => {
  it('a compact card shows the X, labelled "Dismiss", in the header before the overflow menu', () => {
    render(<ItemCard item={card()} mode="compact" />);
    const x = screen.getByTestId('dismiss-x-1');
    expect(x.tagName).toBe('BUTTON');
    expect(x).toHaveAttribute('type', 'button');
    expect(x).toHaveAccessibleName('Dismiss');
    const order = [
      ...screen.getByTestId('card-1').querySelectorAll('[data-testid="dismiss-x-1"], [data-testid="overflow-1"]'),
    ].map((n) => n.getAttribute('data-testid'));
    expect(order).toEqual(['dismiss-x-1', 'overflow-1']);
  });

  it('click -> exactly one item:dismiss and the Dismissed toast with Undo; nothing is approved', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('dismiss-x-1'));
    expect(invokeMocks['item:dismiss']).toHaveBeenCalledTimes(1);
    expect(invokeMocks['item:dismiss']).toHaveBeenCalledWith({ itemId: 1 });
    expect(useDashboardStore.getState().toast).toEqual({ key: 'action.dismissed', itemId: 1 });
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('the X is keyboard reachable and Enter activates it', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    screen.getByTestId('dismiss-x-1').focus();
    await user.keyboard('{Enter}');
    expect(invokeMocks['item:dismiss']).toHaveBeenCalledTimes(1);
  });

  it('every compact list shows it (in calendar, information missing, raw)', () => {
    const { unmount } = render(
      <ItemCard
        item={card({
          status: 'in_calendar',
          eventState: 'created',
          actions: [],
          calendar: { eventStartTs: Date.now() + 86_400_000, eventKey: 'k', revision: 1, status: 'confirmed' },
        })}
        mode="compact"
      />,
    );
    expect(screen.getByTestId('dismiss-x-1')).toBeInTheDocument();
    unmount();
    render(<ItemCard item={infoMissing()} mode="compact" />);
    expect(screen.getByTestId('dismiss-x-1')).toBeInTheDocument();
  });

  it('the expanded card has no X - the sheet keeps its own Dismiss', () => {
    render(<ItemCard item={detail()} mode="expanded" />);
    expect(screen.queryByTestId('dismiss-x-1')).toBeNull();
    expect(screen.getByTestId('sheet-dismiss-1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2.4a "Edit time" on a proposed / change card
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard v3 - Edit time (2.4a)', () => {
  it('a proposed compact card offers "Edit time"; it toggles an inline edit-mode EventEditor', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    const btn = screen.getByTestId('edit-event-1');
    expect(btn).toHaveTextContent('Edit time');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('event-editor')).toBeNull();
    await user.click(btn);
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'edit');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    await user.click(btn);
    expect(screen.queryByTestId('event-editor')).toBeNull();
  });

  it('opening / closing the editor calls item:setEditing true / false (a refresh never overwrites the edit)', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('edit-event-1'));
    expect(invokeMocks['item:setEditing']).toHaveBeenLastCalledWith({ itemId: 1, editing: true });
    await user.click(screen.getByTestId('edit-event-1'));
    expect(invokeMocks['item:setEditing']).toHaveBeenLastCalledWith({ itemId: 1, editing: false });
  });

  it('the edited start rides in the ONE action:approve of "Add to calendar"', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('edit-event-1'));
    await user.clear(screen.getByTestId('event-start'));
    await user.type(screen.getByTestId('event-start'), '16:00');
    expect(screen.getByTestId('approve-event-1')).toBeEnabled();
    await user.click(screen.getByTestId('approve-event-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve'].mock.calls[0]![0]).toEqual({
      actionId: '22222222-2222-4222-8222-222222222222',
      kind: 'create_event',
      shownHash: 'b'.repeat(64),
      edit: { title: 'Coffee', startLocal: `${EVENT_DAY}T16:00:00`, endLocal: `${EVENT_DAY}T18:00:00`, location: '' },
    });
  });

  it('an invalid edit (end before start) disables "Add to calendar" and sends nothing', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('edit-event-1'));
    await user.clear(screen.getByTestId('event-end'));
    await user.type(screen.getByTestId('event-end'), '16:00');
    expect(screen.getByTestId('approve-event-1')).toBeDisabled();
    await user.click(screen.getByTestId('approve-event-1'));
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('closing the editor discards the edit: the approval carries what the card shows', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('edit-event-1'));
    await user.clear(screen.getByTestId('event-start'));
    await user.type(screen.getByTestId('event-start'), '16:00');
    await user.click(screen.getByTestId('edit-event-1'));
    await user.click(screen.getByTestId('approve-event-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve'].mock.calls[0]![0]).not.toHaveProperty('edit');
  });

  it('a change card opens the editor in change mode, and the edit rides in "Approve change"', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={delta()} mode="compact" />);
    await user.click(screen.getByTestId('edit-event-1'));
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'change');
    await user.clear(screen.getByTestId('event-start'));
    await user.type(screen.getByTestId('event-start'), '16:30');
    await user.click(screen.getByTestId('approve-change-1'));
    await waitFor(() => expect(invokeMocks['action:approve']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['action:approve'].mock.calls[0]![0]).toMatchObject({
      kind: 'update_event',
      edit: { startLocal: `${DAY}T16:30:00`, endLocal: `${DAY}T18:00:00` },
    });
  });

  it('no "Edit time" in the sheet, on an in-calendar card, on a cancel change, or without a pending action', () => {
    const { unmount: u1 } = render(<ItemCard item={detail()} mode="expanded" />);
    expect(screen.queryByTestId('edit-event-1')).toBeNull();
    u1();
    const { unmount: u2 } = render(
      <ItemCard
        item={card({
          status: 'in_calendar',
          eventState: 'created',
          actions: [],
          calendar: { eventStartTs: Date.now() + 86_400_000, eventKey: 'k', revision: 1, status: 'confirmed' },
        })}
        mode="compact"
      />,
    );
    expect(screen.queryByTestId('edit-event-1')).toBeNull();
    u2();
    const { unmount: u3 } = render(
      <ItemCard item={{ ...delta(), change: changeOf({ kind: 'cancel' }) }} mode="compact" />,
    );
    expect(screen.queryByTestId('edit-event-1')).toBeNull();
    u3();
    render(<ItemCard item={card({ actions: [sendAction()] })} mode="compact" />);
    expect(screen.queryByTestId('edit-event-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2.4b "Save time" under the information-missing fill form
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard v3 - Save time (2.4b)', () => {
  it('the compact info-missing card shows the fill form with a disabled "Save time" until day + start + end', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={infoMissing()} mode="compact" />);
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'fill');
    const save = screen.getByTestId('save-event-1');
    expect(save).toHaveTextContent('Save time');
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('event-date'), DAY);
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('event-start'), '17:00');
    expect(save).toBeDisabled();
    await user.type(screen.getByTestId('event-end'), '18:00');
    expect(save).toBeEnabled();
  });

  it('click -> item:completeEvent with the filled event, applyItem with the answer, toast "time saved"', async () => {
    const user = userEvent.setup();
    const answer = detail({ itemId: 1, status: 'needs_reply', eventState: 'proposed' });
    mockInvoke('item:completeEvent', () => ({ ok: true, value: answer }));
    useDashboardStore.setState({ openItemId: 1 });
    render(<ItemCard item={infoMissing()} mode="compact" />);
    await fillTime(user, DAY, '17:00', '18:00');
    await user.click(screen.getByTestId('save-event-1'));
    await waitFor(() => expect(invokeMocks['item:completeEvent']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['item:completeEvent']).toHaveBeenCalledWith({
      itemId: 1,
      event: { title: 'Coffee', startLocal: `${DAY}T17:00:00`, endLocal: `${DAY}T18:00:00`, location: '' },
    });
    await waitFor(() => expect(useDashboardStore.getState().toast).toEqual({ key: 'action.timeSaved' }));
    expect(useDashboardStore.getState().openItem).toEqual(answer);
    expect(invokeMocks['dashboard:get']).toHaveBeenCalled();
    // A proposal, never a calendar write: nothing was approved.
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
  });

  it('a second synchronous click sends nothing (single flight)', async () => {
    let resolve!: (v: unknown) => void;
    mockInvoke('item:completeEvent', () => new Promise((r) => (resolve = r)) as never);
    const user = userEvent.setup();
    render(<ItemCard item={infoMissing()} mode="compact" />);
    await fillTime(user, DAY, '17:00', '18:00');
    const save = screen.getByTestId('save-event-1');
    await user.click(save);
    await user.click(save);
    expect(invokeMocks['item:completeEvent']).toHaveBeenCalledTimes(1);
    resolve({ ok: true, value: detail() });
    await waitFor(() => expect(useDashboardStore.getState().toast).toEqual({ key: 'action.timeSaved' }));
  });

  it('end <= start keeps "Save time" disabled and sends nothing (review focus 4)', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={infoMissing()} mode="compact" />);
    await fillTime(user, DAY, '18:00', '17:00');
    expect(screen.getByTestId('save-event-1')).toBeDisabled();
    await user.click(screen.getByTestId('save-event-1'));
    expect(invokeMocks['item:completeEvent']).not.toHaveBeenCalled();
  });

  it('a day beyond the event horizon keeps "Save time" disabled and sends nothing (review focus 4)', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={infoMissing()} mode="compact" />);
    await fillTime(user, TOO_FAR, '17:00', '18:00');
    expect(screen.getByTestId('save-event-1')).toBeDisabled();
    await user.click(screen.getByTestId('save-event-1'));
    expect(invokeMocks['item:completeEvent']).not.toHaveBeenCalled();
  });

  it('CAL_UNAVAILABLE -> the calendar error toast; the card and its fields are unchanged', async () => {
    const user = userEvent.setup();
    mockInvoke('item:completeEvent', () => ({ ok: false, error: { code: 'CAL_UNAVAILABLE' } }));
    useDashboardStore.setState({ openItemId: 1 });
    render(<ItemCard item={infoMissing()} mode="compact" />);
    await fillTime(user, DAY, '17:00', '18:00');
    await user.click(screen.getByTestId('save-event-1'));
    await waitFor(() => expect(useDashboardStore.getState().toast).toEqual({ key: 'errors.CAL_UNAVAILABLE.title' }));
    expect(useDashboardStore.getState().openItem).toBeNull();
    expect(screen.getByTestId('card-1')).toHaveAttribute('data-list', 'info_missing');
    expect(screen.getByTestId('event-start')).toHaveValue('17:00');
    expect(screen.getByTestId('save-event-1')).toBeEnabled();
  });

  it('EVENT_INVALID -> the event-invalid toast', async () => {
    const user = userEvent.setup();
    mockInvoke('item:completeEvent', () => ({ ok: false, error: { code: 'EVENT_INVALID' } }));
    render(<ItemCard item={infoMissing()} mode="compact" />);
    await fillTime(user, DAY, '17:00', '18:00');
    await user.click(screen.getByTestId('save-event-1'));
    await waitFor(() => expect(useDashboardStore.getState().toast).toEqual({ key: 'errors.EVENT_INVALID.title' }));
  });

  it('the sheet of an info-missing item has the same "Save time" row under its fill form', async () => {
    const user = userEvent.setup();
    const { eventState, event, missing, status } = infoMissing();
    render(<ItemCard item={detail({ eventState, event, missing, status, actions: [sendAction()] })} mode="expanded" />);
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'fill');
    expect(screen.getByTestId('save-event-1')).toBeDisabled();
    await fillTime(user, DAY, '17:00', '18:00');
    await user.click(screen.getByTestId('save-event-1'));
    await waitFor(() => expect(invokeMocks['item:completeEvent']).toHaveBeenCalledTimes(1));
  });

  it('no "Save time" on a proposed card (there is nothing to fill)', () => {
    render(<ItemCard item={detail()} mode="expanded" />);
    expect(screen.queryByTestId('save-event-1')).toBeNull();
  });

  it('an info-missing card with no event at all gets an empty, fully editable form', async () => {
    const user = userEvent.setup();
    render(<ItemCard item={infoMissing({ event: null })} mode="compact" />);
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'edit');
    await user.type(screen.getByTestId('event-title'), 'Coffee');
    await fillTime(user, DAY, '17:00', '18:00');
    await user.click(screen.getByTestId('save-event-1'));
    await waitFor(() => expect(invokeMocks['item:completeEvent']).toHaveBeenCalledTimes(1));
    expect(invokeMocks['item:completeEvent']).toHaveBeenCalledWith({
      itemId: 1,
      event: { title: 'Coffee', startLocal: `${DAY}T17:00:00`, endLocal: `${DAY}T18:00:00`, location: '' },
    });
  });

  // fix pass, review should-fix 1: a reschedule with no usable time must never offer "Save time" (a second event).
  it('a change card never shows the fill form or "Save time", compact or expanded', () => {
    const change = { ...delta(), status: 'info_missing' as const, eventState: 'incomplete' as const };
    const { unmount } = render(<ItemCard item={change} mode="compact" />);
    expect(screen.queryByTestId('fill-form-1')).toBeNull();
    expect(screen.queryByTestId('save-event-1')).toBeNull();
    unmount();
    render(<ItemCard item={detail({ ...change })} mode="expanded" />);
    expect(screen.queryByTestId('save-event-1')).toBeNull();
  });

  it('a reschedule / cancel with no new day or time (no event) gets no blank form and no "Save time"', () => {
    for (const intent of ['reschedule', 'cancel'] as const) {
      const vm = infoMissing({ event: null, intent, missing: ['time'] });
      const { unmount } = render(<ItemCard item={vm} mode="compact" />);
      expect(screen.queryByTestId('fill-form-1')).toBeNull();
      expect(screen.queryByTestId('save-event-1')).toBeNull();
      expect(screen.queryByTestId('event-editor')).toBeNull();
      unmount();
      render(<ItemCard item={detail({ ...vm })} mode="expanded" />);
      expect(screen.queryByTestId('sheet-event')).toBeNull();
      expect(screen.queryByTestId('save-event-1')).toBeNull();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// fix pass, review should-fix 3: a card that unmounts while dirty releases the dirty flag and the edit lock
// ---------------------------------------------------------------------------------------------------------------------
describe('ItemCard v3 - unmount while dirty', () => {
  it('unmounting a card with a typed draft clears dirtyItemIds and calls item:setEditing false', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ItemCard item={card()} mode="compact" />);
    await user.type(screen.getByTestId('draft-1'), ' extra');
    await waitFor(() => expect(useDashboardStore.getState().dirtyItemIds.has(1)).toBe(true));
    invokeMocks['item:setEditing'].mockClear();
    unmount();
    expect(useDashboardStore.getState().dirtyItemIds.has(1)).toBe(false);
    expect(invokeMocks['item:setEditing']).toHaveBeenCalledWith({ itemId: 1, editing: false });
  });

  it('unmounting with the inline editor open releases the edit lock too', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ItemCard item={card()} mode="compact" />);
    await user.click(screen.getByTestId('edit-event-1'));
    invokeMocks['item:setEditing'].mockClear();
    unmount();
    expect(invokeMocks['item:setEditing']).toHaveBeenCalledWith({ itemId: 1, editing: false });
  });

  it('unmounting a clean card calls nothing', () => {
    const { unmount } = render(<ItemCard item={card()} mode="compact" />);
    invokeMocks['item:setEditing'].mockClear();
    unmount();
    expect(invokeMocks['item:setEditing']).not.toHaveBeenCalled();
  });
});
