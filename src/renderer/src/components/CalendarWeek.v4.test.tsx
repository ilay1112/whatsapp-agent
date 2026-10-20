// [V4] T-908 group C (handover §2.4): the week calendar shows every calendar of the account.
//   - calendars from google:listCalendars, events from calendar:listEvents (visible calendars only, the anchor of the week);
//   - foreign blocks `cal-block-f-<eventKey[0:8]>` ([v4 T6]: no Google event id in the renderer) with data-cal-hue, the legend, the all-day row;
//   - click -> EventPopover with the calendar name and the I9' reasons; close returns focus to the block;
//   - a failed calendar is named once (review focus 5); cal-refresh = calendar:invalidate then a fresh read;
//   - the picker hides a calendar (and its events) and reads only the visible ones; an app-owned event with a card is drawn once.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { localToEpochMs } from '@shared/when';
import type { CalendarInfo, ForeignEventView } from '@shared/types';
import { calendarHueOf, hash8, type CalendarEntry } from '../store/calendarEntries';
import { CalendarWeek, type CalendarWeekProps } from './CalendarWeek';
import { defaultCard, invokeMocks, mockInvoke } from '../../../../tests/setup-renderer';

const TZ = 'Asia/Jerusalem';
const at = (local: string): number => localToEpochMs(local, TZ);
/** Wednesday 2026-10-14: the en/he week shown contains Tue 13 and Thu 15. */
const ANCHOR = at('2026-10-14T12:00:00');

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

/** [v4 T6] the renderer only ever has the opaque key; tests derive a unique one from a readable name */
const keyOf = (name: string): string => name.padEnd(16, '0').slice(0, 16);
const ev = (eventId: string, calendarId: string, over: Partial<ForeignEventView> = {}): ForeignEventView => ({
  calendarId,
  title: `T ${eventId}`,
  startLocal: '2026-10-13T10:00:00',
  endLocal: '2026-10-13T11:00:00',
  allDay: false,
  attendees: 0,
  recurring: false,
  ownedByApp: false,
  fromChat: false,
  location: '',
  writable: calendarId !== 'hol@x.test',
  eventKey: keyOf(eventId),
  undoActionId: null,
  ...over,
});
const EVENTS = [
  ev('plain0001', 'primary'),
  ev('attend001', 'work@x.test', { attendees: 2, startLocal: '2026-10-15T09:00:00', endLocal: '2026-10-15T10:00:00' }),
  ev('allday001', 'hol@x.test', { allDay: true, startLocal: '2026-10-13T00:00:00', endLocal: '2026-10-15T00:00:00' }),
];

function setup(
  opts: {
    events?: ForeignEventView[];
    failed?: string[];
    entries?: CalendarEntry[];
    patch?: Partial<CalendarWeekProps>;
  } = {},
) {
  mockInvoke('google:listCalendars', () => ({ ok: true, value: { calendars: CALS } }));
  mockInvoke('calendar:listEvents', (req) => {
    const ids = (req as { calendarIds: string[] }).calendarIds;
    return {
      ok: true,
      value: {
        weekStartMs: at('2026-10-11T00:00:00'),
        events: (opts.events ?? EVENTS).filter((e) => ids.includes(e.calendarId)),
        fetchedAt: ANCHOR,
        failed: (opts.failed ?? []).filter((id) => ids.includes(id)),
      },
    };
  });
  const props: CalendarWeekProps = {
    entries: opts.entries ?? [],
    anchorMs: ANCHOR,
    onAnchorChange: vi.fn(),
    nowMs: ANCHOR,
    lang: 'en',
    timeZone: TZ,
    onOpenItem: vi.fn(),
    noteSeen: true,
    onNoteSeen: vi.fn(),
    ...opts.patch,
  };
  const user = userEvent.setup();
  const view = render(<CalendarWeek {...props} />);
  return { props, user, ...view };
}
const block = (eventId: string): HTMLElement => screen.getByTestId(`cal-block-f-${keyOf(eventId).slice(0, 8)}`);
const listCalls = (): Array<{ anchorMs: number; calendarIds: string[] }> =>
  invokeMocks['calendar:listEvents'].mock.calls.map((c) => c[0] as { anchorMs: number; calendarIds: string[] });

describe('CalendarWeek [V4] - every calendar', () => {
  it('reads the visible week of every calendar and draws foreign blocks in each calendar hue', async () => {
    window.localStorage.clear();
    setup();
    await waitFor(() => expect(block('plain0001')).toBeInTheDocument());
    expect(listCalls().at(-1)).toEqual({ anchorMs: ANCHOR, calendarIds: ['primary', 'work@x.test', 'hol@x.test'] });
    const plain = block('plain0001');
    expect(plain).toHaveAttribute('data-state', 'foreign');
    expect(plain).toHaveAttribute('data-cal-hue', String(calendarHueOf('primary')));
    expect(screen.getByTestId('cal-col-2026-10-13')).toContainElement(plain);
    expect(within(plain).getByText('T plain0001').tagName).toBe('BDI');
    expect(block('attend001')).toHaveAttribute('data-cal-hue', String(calendarHueOf('work@x.test')));
    expect(within(screen.getByTestId('cal-legend')).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByTestId('cal-empty')).toBeNull();
  });

  it('an all-day event sits in the all-day row, once, spanning the days it covers (end exclusive)', async () => {
    window.localStorage.clear();
    setup();
    await waitFor(() => expect(block('allday001')).toBeInTheDocument());
    const row = screen.getByTestId('cal-allday');
    expect(row).toContainElement(block('allday001'));
    // en week starts Sun 11 (or Mon 12): Tue 13 + Wed 14 = 2 columns
    expect(block('allday001').style.gridColumn).toMatch(/span 2$/);
    expect(screen.getByTestId('cal-grid')).not.toContainElement(block('allday001'));
  });

  it('click opens the popover with the calendar name and the reasons; close returns focus to the block', async () => {
    window.localStorage.clear();
    const { user } = setup();
    await waitFor(() => expect(block('attend001')).toBeInTheDocument());
    await user.click(block('attend001'));
    const pop = screen.getByTestId('cal-event-popover');
    expect(within(pop).getByTestId('cal-popover-calendar')).toHaveTextContent('Work');
    expect(within(pop).getByTestId('cal-reason-attendees')).toBeInTheDocument();
    expect(within(pop).queryByTestId('cal-reason-readonly')).toBeNull();
    expect(block('attend001')).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(pop).getByTestId('cal-popover-close'));
    expect(screen.queryByTestId('cal-event-popover')).toBeNull();
    expect(block('attend001')).toHaveFocus();
    // a read-only calendar's event names it
    await user.click(block('allday001'));
    expect(screen.getByTestId('cal-reason-readonly')).toBeInTheDocument();
  });

  it('renderEventActions: group D extension point receives the open entry', async () => {
    window.localStorage.clear();
    const renderEventActions = vi.fn(() => <span data-testid="d-actions">d</span>);
    const { user } = setup({ patch: { renderEventActions } });
    await waitFor(() => expect(block('plain0001')).toBeInTheDocument());
    await user.click(block('plain0001'));
    expect(screen.getByTestId('cal-popover-actions')).toContainElement(screen.getByTestId('d-actions'));
    expect(renderEventActions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'foreign',
        eventKey: keyOf('plain0001'),
        calendarId: 'primary',
        writable: true,
      }),
    );
  });

  it('review focus 5: a calendar that failed is named once; the others stay visible', async () => {
    window.localStorage.clear();
    setup({ failed: ['hol@x.test'], events: EVENTS.filter((e) => e.calendarId !== 'hol@x.test') });
    await waitFor(() => expect(screen.getByTestId('cal-failed')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^cal-failed-/)).toHaveLength(1);
    expect(screen.getByTestId(`cal-failed-${hash8('hol@x.test')}`)).toHaveTextContent('Could not load Holidays');
    expect(screen.getByTestId(`cal-failed-${hash8('hol@x.test')}`).querySelector('bdi.msg-text')).toHaveTextContent(
      'Holidays',
    );
    expect(block('plain0001')).toBeInTheDocument();
    expect(block('attend001')).toBeInTheDocument();
  });

  it('cal-refresh: calendar:invalidate, then the week is read again', async () => {
    window.localStorage.clear();
    const { user } = setup();
    await waitFor(() => expect(block('plain0001')).toBeInTheDocument());
    const before = listCalls().length;
    await user.click(screen.getByTestId('cal-refresh'));
    await waitFor(() => expect(listCalls().length).toBe(before + 1));
    expect(invokeMocks['calendar:invalidate']).toHaveBeenCalledTimes(1);
    const order = (fn: { mock: { invocationCallOrder: number[] } }): number => fn.mock.invocationCallOrder.at(-1)!;
    expect(order(invokeMocks['calendar:invalidate'])).toBeLessThan(order(invokeMocks['calendar:listEvents']));
  });

  it('the picker hides a calendar: its events go, only the visible ids are read, the choice is remembered', async () => {
    window.localStorage.clear();
    const { user } = setup();
    await waitFor(() => expect(block('attend001')).toBeInTheDocument());
    await user.click(screen.getByTestId('cal-picker').querySelector('summary')!);
    await user.click(screen.getByTestId(`cal-picker-${hash8('work@x.test')}`));
    await waitFor(() => expect(screen.queryByTestId(`cal-block-f-${keyOf('attend001').slice(0, 8)}`)).toBeNull());
    expect(listCalls().at(-1)!.calendarIds).toEqual(['primary', 'hol@x.test']);
    expect(JSON.parse(window.localStorage.getItem('wca.calendar.visible')!)).toEqual(['primary', 'hol@x.test']);
    window.localStorage.clear();
  });

  it('another week is read when the anchor moves', async () => {
    window.localStorage.clear();
    const { rerender, props } = setup();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    const next = at('2026-10-21T12:00:00');
    rerender(<CalendarWeek {...props} anchorMs={next} />);
    await waitFor(() => expect(listCalls().at(-1)!.anchorMs).toBe(next));
  });

  it('an app-owned event that a card already shows is drawn once (as the card)', async () => {
    window.localStorage.clear();
    const cardEntry: CalendarEntry = {
      itemId: 9,
      startMs: at('2026-10-13T15:00:00'),
      endMs: at('2026-10-13T16:00:00'),
      title: 'Coffee',
      state: 'in_calendar',
      eventKey: keyOf('owned0001'),
      card: { ...defaultCard, itemId: 9 },
    };
    setup({
      entries: [cardEntry],
      events: [
        ev('owned0001', 'primary', {
          ownedByApp: true,
          startLocal: '2026-10-13T15:00:00',
          endLocal: '2026-10-13T16:00:00',
        }),
        ev('plain0001', 'primary'),
      ],
    });
    await waitFor(() => expect(block('plain0001')).toBeInTheDocument());
    expect(screen.getByTestId('cal-block-9')).toBeInTheDocument();
    expect(screen.queryByTestId(`cal-block-f-${keyOf('owned0001').slice(0, 8)}`)).toBeNull();
  });

  it('Google not connected: no picker, no refresh, no read; the card blocks still draw', async () => {
    window.localStorage.clear();
    mockInvoke('google:listCalendars', () => ({ ok: false, error: { code: 'CAL_UNAVAILABLE' } }));
    render(
      <CalendarWeek
        entries={[]}
        anchorMs={ANCHOR}
        onAnchorChange={vi.fn()}
        nowMs={ANCHOR}
        lang="en"
        timeZone={TZ}
        onOpenItem={vi.fn()}
        noteSeen
        onNoteSeen={vi.fn()}
      />,
    );
    await waitFor(() => expect(invokeMocks['google:listCalendars']).toHaveBeenCalled());
    expect(screen.queryByTestId('cal-picker')).toBeNull();
    expect(screen.queryByTestId('cal-refresh')).toBeNull();
    expect(invokeMocks['calendar:listEvents']).not.toHaveBeenCalled();
    expect(screen.getByTestId('cal-empty')).toBeInTheDocument();
  });
});
