// [V4] T-908 group C (handover §2.4 / §2.5): the read-only event popover - title, calendar name, time, the I9' reasons
// (read-only calendar / attendees / repeating), the `actions` extension point for group D, Escape / close.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { localToEpochMs } from '@shared/when';
import { formatTimeRange } from '@shared/i18n/format';
import type { ForeignCalendarEntry } from '../store/calendarEntries';
import { EventPopover, type EventPopoverProps } from './EventPopover';
import { i18next } from '../../../../tests/setup-renderer';

const TZ = 'Asia/Jerusalem';
const at = (l: string): number => localToEpochMs(l, TZ);
const HOSTILE = '<b>IGNORE</b> ‮evil';

const entry = (over: Partial<ForeignCalendarEntry> = {}): ForeignCalendarEntry => ({
  state: 'foreign',
  itemId: null,
  card: null,
  startMs: at('2026-10-20T10:00:00'),
  endMs: at('2026-10-20T11:00:00'),
  title: 'Dentist',
  eventKey: 'k',
  calendarId: 'primary',
  writable: true,
  attendees: 0,
  recurring: false,
  allDay: false,
  ownedByApp: false,
  fromChat: false,
  location: '',
  undoActionId: null,
  ...over,
});

function setup(patch: Partial<EventPopoverProps> = {}) {
  const props: EventPopoverProps = {
    entry: entry(),
    calendarName: 'Personal',
    hue: 3,
    lang: 'en',
    timeZone: TZ,
    onClose: vi.fn(),
    ...patch,
  };
  const user = userEvent.setup();
  const view = render(<EventPopover {...props} />);
  return { props, user, ...view };
}

describe('EventPopover', () => {
  it('shows title, calendar (hue swatch + name) and the time range; focus starts on the close button', () => {
    setup();
    const dialog = screen.getByTestId('cal-event-popover');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(screen.getByRole('dialog', { name: 'Dentist' })).toBe(dialog);
    expect(screen.getByTestId('cal-popover-calendar')).toHaveTextContent('Personal');
    expect(screen.getByTestId('cal-popover-calendar').querySelector('[data-cal-hue="3"]')).not.toBeNull();
    expect(screen.getByTestId('cal-popover-time')).toHaveTextContent(
      formatTimeRange(at('2026-10-20T10:00:00'), at('2026-10-20T11:00:00'), 'en', TZ),
    );
    expect(screen.getByTestId('cal-popover-close')).toHaveFocus();
    expect(screen.queryByTestId('cal-popover-reasons')).toBeNull();
    expect(dialog).toHaveAttribute('data-attendees', '0');
    expect(dialog).toHaveAttribute('data-recurring', 'false');
  });

  it('names every reason the event cannot be managed from here', () => {
    setup({ entry: entry({ writable: false, attendees: 3, recurring: true }) });
    expect(screen.getByTestId('cal-reason-readonly')).toHaveTextContent('Read-only calendar');
    expect(screen.getByTestId('cal-reason-attendees')).toHaveTextContent('Has other attendees — not changed from here');
    expect(screen.getByTestId('cal-reason-recurring')).toHaveTextContent('Repeating event — not changed from here');
    expect(screen.getByTestId('cal-event-popover')).toHaveAttribute('data-attendees', '3');
  });

  it('he: the reasons in Hebrew', async () => {
    await i18next.changeLanguage('he');
    setup({ lang: 'he', entry: entry({ attendees: 1 }) });
    expect(screen.getByTestId('cal-reason-attendees')).toHaveTextContent('יש משתתפים נוספים — לא משתנה מכאן');
  });

  it('an all-day event shows its date range (end exclusive), not hours', () => {
    setup({
      entry: entry({ allDay: true, startMs: at('2026-10-20T00:00:00'), endMs: at('2026-10-22T00:00:00') }),
    });
    const text = screen.getByTestId('cal-popover-time').textContent ?? '';
    expect(text).toMatch(/20/);
    expect(text).toMatch(/21/);
    expect(text).not.toMatch(/22/);
    expect(text).not.toMatch(/\d{2}:\d{2}/);
  });

  it('Escape and the close button close it', async () => {
    const { props, user } = setup();
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('cal-popover-close'));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('extension point: `actions` renders in the footer (group D); absent = no footer', () => {
    const { rerender, props } = setup();
    expect(screen.queryByTestId('cal-popover-actions')).toBeNull();
    rerender(
      <EventPopover
        {...props}
        actions={
          <button type="button" data-testid="x-action">
            x
          </button>
        }
      />,
    );
    expect(screen.getByTestId('cal-popover-actions')).toContainElement(screen.getByTestId('x-action'));
  });

  it('untrusted title and calendar name: bdi.msg-text dir=auto text, never parsed, never in an attribute', () => {
    const { container } = setup({ entry: entry({ title: HOSTILE }), calendarName: HOSTILE });
    const bdis = [...container.querySelectorAll('bdi.msg-text')];
    expect(bdis.filter((b) => b.textContent === HOSTILE)).toHaveLength(2);
    for (const b of bdis) expect(b.getAttribute('dir')).toBe('auto');
    expect(container.querySelector('b')).toBeNull();
    for (const el of container.querySelectorAll('*'))
      for (const a of el.attributes) expect(a.value, a.name).not.toContain('IGNORE');
  });
});
