// [v4 T7] T-908 handover §2.5 (I1', I9'): the calendar view's manual management, driven through CalendarWeek.
//  - New event -> form -> calendar:proposeCreate (pending only) -> cal-confirm shows main's summary -> Confirm = action:approve with the
//    PROPOSAL's {actionId, kind, shownHash}; nothing is approved before that click; the done toast carries Undo = action:undo;
//  - the popover's Edit / Move / Delete name the event by (calendarId, eventKey) only - never an event id;
//  - an attendee / recurring / read-only / chat event: the buttons are disabled and the reason is shown;
//  - "Undo last change" (undoActionId) -> action:undo; CAL_EVENT_GONE from a propose re-reads the week.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { localToEpochMs } from '@shared/when';
import type { CalendarInfo, ForeignEventView, ManualProposal } from '@shared/types';
import { CalendarWeek, type CalendarWeekProps } from './CalendarWeek';
import { useDashboardStore } from '../store/dashboard';
import { invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const TZ = 'Asia/Jerusalem';
const at = (local: string): number => localToEpochMs(local, TZ);
const ANCHOR = at('2026-10-14T12:00:00');
const keyOf = (name: string): string => name.padEnd(16, '0').slice(0, 16);
const ACTION = '33333333-3333-4333-8333-333333333333';
const HASH = 'c'.repeat(64);

const cal = (id: string, name: string, accessRole: CalendarInfo['accessRole']): CalendarInfo => ({
  id,
  name,
  primary: id === 'primary',
  timeZone: TZ,
  writable: accessRole === 'owner' || accessRole === 'writer',
  accessRole,
});
const CALS = [
  cal('primary', 'Personal', 'owner'),
  cal('work@x.test', 'Work', 'writer'),
  cal('hol@x.test', 'Holidays', 'reader'),
];
const ev = (name: string, calendarId: string, over: Partial<ForeignEventView> = {}): ForeignEventView => ({
  calendarId,
  title: `T ${name}`,
  startLocal: '2026-10-13T10:00:00',
  endLocal: '2026-10-13T11:00:00',
  allDay: false,
  attendees: 0,
  recurring: false,
  ownedByApp: false,
  fromChat: false,
  location: '',
  writable: calendarId !== 'hol@x.test',
  eventKey: keyOf(name),
  undoActionId: null,
  ...over,
});
const EVENTS = [
  ev('plain0001', 'primary', { location: 'Clinic' }),
  ev('attend001', 'work@x.test', { attendees: 2, startLocal: '2026-10-15T09:00:00', endLocal: '2026-10-15T10:00:00' }),
  ev('chat00001', 'primary', {
    ownedByApp: true,
    fromChat: true,
    startLocal: '2026-10-16T09:00:00',
    endLocal: '2026-10-16T10:00:00',
  }),
  ev('mine00001', 'primary', {
    ownedByApp: true,
    undoActionId: ACTION,
    startLocal: '2026-10-12T09:00:00',
    endLocal: '2026-10-12T10:00:00',
  }),
];
const proposal = (kind: ManualProposal['kind'], op: ManualProposal['summary']['op']): ManualProposal => ({
  actionId: ACTION,
  kind,
  shownHash: HASH,
  summary: {
    op,
    calendarId: op === 'create' ? 'work@x.test' : 'primary',
    before:
      op === 'create'
        ? null
        : {
            title: 'T plain0001',
            startLocal: '2026-10-13T10:00:00',
            endLocal: '2026-10-13T11:00:00',
            timeZone: TZ,
            location: 'Clinic',
            status: 'confirmed',
          },
    after:
      op === 'delete'
        ? null
        : {
            title: 'Gym',
            startLocal: '2026-10-13T18:00:00',
            endLocal: '2026-10-13T19:00:00',
            timeZone: TZ,
            location: '',
            status: 'confirmed',
          },
  },
});
const manualDone = (op: 'create' | 'edit' | 'delete' | 'undo', undoable = true) => ({
  ok: true as const,
  value: {
    outcome: 'done' as const,
    item: null,
    manual: { actionId: ACTION, op, calendarId: 'primary', undoable, errorCode: null },
  },
});

function setup() {
  mockInvoke('google:listCalendars', () => ({ ok: true, value: { calendars: CALS } }));
  mockInvoke('calendar:listEvents', (req) => {
    const ids = (req as { calendarIds: string[] }).calendarIds;
    return {
      ok: true,
      value: {
        weekStartMs: at('2026-10-11T00:00:00'),
        events: EVENTS.filter((e) => ids.includes(e.calendarId)),
        fetchedAt: ANCHOR,
        failed: [],
      },
    };
  });
  const props: CalendarWeekProps = {
    entries: [],
    anchorMs: ANCHOR,
    onAnchorChange: vi.fn(),
    nowMs: ANCHOR,
    lang: 'en',
    timeZone: TZ,
    onOpenItem: vi.fn(),
    noteSeen: true,
    onNoteSeen: vi.fn(),
  };
  const user = userEvent.setup();
  render(<CalendarWeek {...props} />);
  return { user };
}
const block = (name: string): HTMLElement => screen.getByTestId(`cal-block-f-${keyOf(name).slice(0, 8)}`);
const openPopover = async (user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> => {
  await waitFor(() => expect(block(name)).toBeInTheDocument());
  await user.click(block(name));
  return screen.getByTestId('cal-event-popover');
};

beforeEach(() => {
  window.localStorage.clear();
  useDashboardStore.setState({ toast: null });
});

describe('[v4 T7] manual management in the calendar view', () => {
  it('New event: form -> proposeCreate (pending) -> confirm shows the summary -> Confirm approves with the proposal hash -> toast with Undo', async () => {
    mockInvoke('calendar:proposeCreate', () => ({ ok: true, value: proposal('create_event', 'create') }));
    mockInvoke('action:approve', () => manualDone('create'));
    mockInvoke('action:undo', () => manualDone('undo', false));
    const { user } = setup();
    await waitFor(() => expect(screen.getByTestId('cal-new-event')).toBeInTheDocument());
    await user.click(screen.getByTestId('cal-new-event'));
    const select = screen.getByTestId('cal-dialog-calendar');
    // a read-only calendar is never offered
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['primary', 'work@x.test']);
    await user.selectOptions(select, 'work@x.test');
    await user.type(screen.getByTestId('cal-dialog-title'), 'Gym');
    await user.click(screen.getByTestId('cal-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('cal-confirm')).toBeInTheDocument());
    expect(invokeMocks['calendar:proposeCreate']).toHaveBeenCalledWith({
      calendarId: 'work@x.test',
      title: 'Gym',
      startLocal: '2026-10-14T09:00:00',
      endLocal: '2026-10-14T10:00:00',
      location: '',
    });
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled(); // nothing executes on propose
    const confirm = screen.getByTestId('cal-confirm');
    expect(within(confirm).getByTestId('cal-confirm-question')).toHaveTextContent('Add to Work?');
    expect(within(confirm).getByTestId('cal-confirm-question').querySelector('bdi.msg-text')).toHaveTextContent('Work');
    expect(within(confirm).getByTestId('cal-confirm-after')).toHaveTextContent('Gym');
    await user.click(within(confirm).getByTestId('cal-confirm-ok'));
    await waitFor(() => expect(screen.queryByTestId('cal-confirm')).toBeNull());
    expect(invokeMocks['action:approve']).toHaveBeenCalledWith({
      actionId: ACTION,
      kind: 'create_event',
      shownHash: HASH,
    });
    const toast = useDashboardStore.getState().toast!;
    expect(toast.key).toBe('cal.doneCreate');
    expect(invokeMocks['calendar:invalidate']).toHaveBeenCalled(); // the week is read again
    toast.onUndo!();
    await waitFor(() => expect(invokeMocks['action:undo']).toHaveBeenCalledWith({ actionId: ACTION }));
    await waitFor(() => expect(useDashboardStore.getState().toast?.key).toBe('cal.doneUndo'));
  });

  it('Cancel on the confirm step approves nothing and rejects the pending proposal (action:reject)', async () => {
    mockInvoke('calendar:proposeDelete', () => ({ ok: true, value: proposal('delete_event', 'delete') }));
    mockInvoke('action:reject', () => ({ ok: true, value: null }));
    const { user } = setup();
    const pop = await openPopover(user, 'plain0001');
    await user.click(within(pop).getByTestId('cal-action-delete'));
    await waitFor(() => expect(screen.getByTestId('cal-confirm')).toHaveAttribute('data-op', 'delete'));
    expect(screen.getByTestId('cal-confirm-question')).toHaveTextContent('Delete this event?');
    expect(screen.getByTestId('cal-confirm-before')).toHaveTextContent('T plain0001');
    await user.click(screen.getByTestId('cal-confirm-cancel'));
    expect(screen.queryByTestId('cal-confirm')).toBeNull();
    expect(invokeMocks['action:approve']).not.toHaveBeenCalled();
    await waitFor(() => expect(invokeMocks['action:reject']).toHaveBeenCalledWith({ actionId: ACTION }));
    expect(invokeMocks['action:reject']).toHaveBeenCalledTimes(1);
  });

  it('[review fix] the edit form starts with the current location of the event (it can be seen and cleared)', async () => {
    mockInvoke('calendar:proposeEdit', () => ({ ok: true, value: proposal('update_event', 'edit') }));
    const { user } = setup();
    const pop = await openPopover(user, 'plain0001');
    await user.click(within(pop).getByTestId('cal-action-edit'));
    const location = screen.getByTestId('cal-dialog-location') as HTMLInputElement;
    expect(location.value).toBe('Clinic');
    await user.clear(location);
    await user.click(screen.getByTestId('cal-dialog-submit'));
    await waitFor(() =>
      expect(invokeMocks['calendar:proposeEdit']).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventKey: keyOf('plain0001'),
        patch: { location: '' },
      }),
    );
  });

  it('[review fix] a propose-edit answered CAL_EVENT_GONE re-reads the week and shows the retry hint in the form', async () => {
    mockInvoke('calendar:proposeEdit', () => ({ ok: false, error: { code: 'CAL_EVENT_GONE' } }));
    const { user } = setup();
    const pop = await openPopover(user, 'plain0001');
    await user.click(within(pop).getByTestId('cal-action-edit'));
    const reads = invokeMocks['calendar:listEvents'].mock.calls.length;
    await user.type(screen.getByTestId('cal-dialog-title'), '!');
    await user.click(screen.getByTestId('cal-dialog-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('cal-dialog-error')).toHaveTextContent('The event is no longer in your calendar'),
    );
    await waitFor(() => expect(invokeMocks['calendar:listEvents'].mock.calls.length).toBe(reads + 1));
    expect(invokeMocks['calendar:invalidate']).toHaveBeenCalled();
  });

  it('Edit / Move / Delete name the event by (calendarId, eventKey) only; Delete approves the delete_event proposal', async () => {
    mockInvoke('calendar:proposeEdit', () => ({ ok: true, value: proposal('update_event', 'edit') }));
    mockInvoke('calendar:proposeDelete', () => ({ ok: true, value: proposal('delete_event', 'delete') }));
    mockInvoke('action:approve', () => manualDone('delete'));
    const { user } = setup();
    let pop = await openPopover(user, 'plain0001');
    await user.click(within(pop).getByTestId('cal-action-edit'));
    const title = screen.getByTestId('cal-dialog-title') as HTMLInputElement;
    expect(title.value).toBe('T plain0001');
    await user.clear(title);
    await user.type(title, 'Renamed');
    await user.click(screen.getByTestId('cal-dialog-submit'));
    await waitFor(() => expect(screen.getByTestId('cal-confirm')).toHaveAttribute('data-op', 'edit'));
    expect(invokeMocks['calendar:proposeEdit']).toHaveBeenCalledWith({
      calendarId: 'primary',
      eventKey: keyOf('plain0001'),
      patch: { title: 'Renamed' },
    });
    expect(screen.getByTestId('cal-confirm-before')).toHaveTextContent('T plain0001');
    expect(screen.getByTestId('cal-confirm-after')).toHaveTextContent('Gym');
    await user.click(screen.getByTestId('cal-confirm-cancel'));

    pop = await openPopover(user, 'plain0001');
    await user.click(within(pop).getByTestId('cal-action-move'));
    expect(screen.getByTestId('cal-dialog-start')).toHaveFocus();
    const start = screen.getByTestId('cal-dialog-start');
    const end = screen.getByTestId('cal-dialog-end');
    await user.clear(start);
    await user.type(start, '12:00');
    await user.clear(end);
    await user.type(end, '13:00');
    await user.click(screen.getByTestId('cal-dialog-submit'));
    await waitFor(() =>
      expect(invokeMocks['calendar:proposeEdit']).toHaveBeenLastCalledWith({
        calendarId: 'primary',
        eventKey: keyOf('plain0001'),
        patch: { startLocal: '2026-10-13T12:00:00', endLocal: '2026-10-13T13:00:00' },
      }),
    );
    await user.click(screen.getByTestId('cal-confirm-cancel'));

    pop = await openPopover(user, 'plain0001');
    await user.click(within(pop).getByTestId('cal-action-delete'));
    await waitFor(() => expect(screen.getByTestId('cal-confirm')).toBeInTheDocument());
    await user.click(screen.getByTestId('cal-confirm-ok'));
    await waitFor(() =>
      expect(invokeMocks['action:approve']).toHaveBeenCalledWith({
        actionId: ACTION,
        kind: 'delete_event',
        shownHash: HASH,
      }),
    );
    expect(useDashboardStore.getState().toast?.key).toBe('cal.doneDelete');
    // no renderer request ever carried an event id
    for (const ch of ['calendar:proposeEdit', 'calendar:proposeDelete'] as const)
      for (const call of invokeMocks[ch].mock.calls) expect(JSON.stringify(call)).not.toMatch(/eventId/);
  });

  it('attendee / chat events: every button disabled with its reason; propose is never called', async () => {
    const { user } = setup();
    let pop = await openPopover(user, 'attend001');
    for (const id of ['cal-action-edit', 'cal-action-move', 'cal-action-delete'])
      expect(within(pop).getByTestId(id)).toBeDisabled();
    expect(within(pop).getByTestId('cal-reason-attendees')).toHaveTextContent('Has other attendees');
    await user.click(within(pop).getByTestId('cal-popover-close'));
    pop = await openPopover(user, 'chat00001');
    expect(within(pop).getByTestId('cal-action-delete')).toBeDisabled();
    expect(within(pop).getByTestId('cal-reason-fromchat')).toHaveTextContent('Added from a chat');
    expect(invokeMocks['calendar:proposeDelete']).not.toHaveBeenCalled();
    expect(invokeMocks['calendar:proposeEdit']).not.toHaveBeenCalled();
  });

  it('"Undo last change" while main offers it -> action:undo; a gone event re-reads the week', async () => {
    mockInvoke('action:undo', () => manualDone('undo', false));
    mockInvoke('calendar:proposeDelete', () => ({ ok: false, error: { code: 'CAL_EVENT_GONE' } }));
    const { user } = setup();
    let pop = await openPopover(user, 'mine00001');
    expect(within(pop).queryByTestId('cal-action-undo')).toBeInTheDocument();
    await user.click(within(pop).getByTestId('cal-action-undo'));
    await waitFor(() => expect(invokeMocks['action:undo']).toHaveBeenCalledWith({ actionId: ACTION }));
    await waitFor(() => expect(useDashboardStore.getState().toast?.key).toBe('cal.doneUndo'));
    pop = await openPopover(user, 'plain0001');
    expect(within(pop).queryByTestId('cal-action-undo')).toBeNull();
    const before = invokeMocks['calendar:invalidate'].mock.calls.length;
    await user.click(within(pop).getByTestId('cal-action-delete'));
    await waitFor(() => expect(useDashboardStore.getState().toast?.key).toBe('errors.CAL_EVENT_GONE.title'));
    expect(invokeMocks['calendar:invalidate'].mock.calls.length).toBeGreaterThan(before);
    expect(screen.queryByTestId('cal-confirm')).toBeNull();
  });
});
