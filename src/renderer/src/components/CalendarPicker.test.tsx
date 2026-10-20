// [V4] T-908 group C (handover §2.4): the calendar picker (checkboxes, default all, persisted in localStorage
// `wca.calendar.visible`) and the colour legend. Calendar names are UNTRUSTED: bdi.msg-text only, never an attribute.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarInfo } from '@shared/types';
import { CalendarLegend, CalendarPicker } from './CalendarPicker';
import { calendarHueOf, hash8 } from '../store/calendarEntries';
import {
  VISIBLE_CALENDARS_KEY,
  effectiveVisible,
  readVisibleCalendars,
  useVisibleCalendars,
} from '../store/calendarView';

const cal = (id: string, name: string, accessRole: CalendarInfo['accessRole'] = 'owner'): CalendarInfo => ({
  id,
  name,
  primary: id === 'primary',
  timeZone: 'Asia/Jerusalem',
  writable: accessRole === 'owner' || accessRole === 'writer',
  accessRole,
});
const HOSTILE = '<img src=x onerror=alert(1)> ‮Work';
const CALS = [
  cal('primary', 'Personal'),
  cal('work@x.test', HOSTILE, 'writer'),
  cal('hol@x.test', 'Holidays', 'reader'),
];

function Harness({ calendars = CALS }: { calendars?: CalendarInfo[] }) {
  const { visible, setVisible } = useVisibleCalendars(calendars);
  return (
    <>
      <CalendarPicker calendars={calendars} visible={visible} onChange={setVisible} />
      <CalendarLegend calendars={calendars} visible={visible} />
    </>
  );
}

const box = (id: string): HTMLInputElement => screen.getByTestId(`cal-picker-${hash8(id)}`);

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('CalendarPicker', () => {
  it('one checkbox per calendar, all checked by default (nothing stored)', () => {
    render(<Harness />);
    expect(screen.getByTestId('cal-picker')).toBeInTheDocument();
    for (const c of CALS) expect(box(c.id)).toBeChecked();
    expect(within(screen.getByTestId('cal-legend')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('unchecking hides the calendar from the legend and persists the selection', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('cal-picker').querySelector('summary')!);
    await user.click(box('work@x.test'));
    expect(box('work@x.test')).not.toBeChecked();
    expect(within(screen.getByTestId('cal-legend')).getAllByRole('listitem')).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(VISIBLE_CALENDARS_KEY)!)).toEqual(['primary', 'hol@x.test']);
  });

  it('a remembered selection is restored on the next mount; ids no longer in the account are ignored', () => {
    window.localStorage.setItem(VISIBLE_CALENDARS_KEY, JSON.stringify(['hol@x.test', 'gone@x.test']));
    render(<Harness />);
    expect(box('primary')).not.toBeChecked();
    expect(box('work@x.test')).not.toBeChecked();
    expect(box('hol@x.test')).toBeChecked();
  });

  it('unreadable storage falls back to all', () => {
    window.localStorage.setItem(VISIBLE_CALENDARS_KEY, '{not json');
    expect(readVisibleCalendars()).toBeNull();
    window.localStorage.setItem(VISIBLE_CALENDARS_KEY, JSON.stringify([1, 2]));
    expect(readVisibleCalendars()).toBeNull();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readVisibleCalendars()).toBeNull();
    get.mockRestore();
    expect([...effectiveVisible(CALS, null)]).toEqual(['primary', 'work@x.test', 'hol@x.test']);
  });

  it('a write failure does not break the toggle', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('cal-picker').querySelector('summary')!);
    await user.click(box('primary'));
    expect(box('primary')).not.toBeChecked();
    set.mockRestore();
  });

  it('untrusted names: inside bdi.msg-text dir=auto, as text (never parsed, never an attribute)', () => {
    const { container } = render(<Harness />);
    const names = [...container.querySelectorAll('bdi.msg-text')].map((b) => b.textContent);
    expect(names).toContain(HOSTILE);
    for (const b of container.querySelectorAll('bdi.msg-text')) expect(b.getAttribute('dir')).toBe('auto');
    expect(container.querySelector('img')).toBeNull();
    for (const el of container.querySelectorAll('*'))
      for (const a of el.attributes) expect(a.value, a.name).not.toContain('onerror');
  });

  it('no calendars (Google not connected) -> neither picker nor legend', () => {
    render(<Harness calendars={[]} />);
    expect(screen.queryByTestId('cal-picker')).toBeNull();
    expect(screen.queryByTestId('cal-legend')).toBeNull();
  });

  it('the legend swatch carries the calendar hue (0..7)', () => {
    render(<Harness />);
    const items = within(screen.getByTestId('cal-legend')).getAllByRole('listitem');
    expect(items.map((li) => Number(li.getAttribute('data-cal-hue')))).toEqual(CALS.map((c) => calendarHueOf(c.id)));
  });
});
