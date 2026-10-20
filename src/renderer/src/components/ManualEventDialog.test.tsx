// [v4 T7] T-908 handover §2.5: the manual event form (`cal-dialog`) - validation in the form (main validates again), the calendar
// choice (only the calendars the caller hands in: the writable ones), the field format handed to the caller, Move focuses the time.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CalendarInfo } from '@shared/types';
import { ManualEventDialog, validateManualFields, type ManualEventDialogProps } from './ManualEventDialog';

const TZ = 'Asia/Jerusalem';
const cal = (id: string, name: string): CalendarInfo => ({
  id,
  name,
  primary: id === 'primary',
  timeZone: TZ,
  writable: true,
  accessRole: 'owner',
});

function setup(patch: Partial<ManualEventDialogProps> = {}) {
  const props: ManualEventDialogProps = {
    mode: 'create',
    calendars: [cal('primary', 'Personal'), cal('work@x.test', 'Work')],
    initial: {
      calendarId: 'primary',
      title: '',
      startLocal: '2026-10-14T09:00:00',
      endLocal: '2026-10-14T10:00:00',
      location: '',
    },
    timeZone: TZ,
    busy: false,
    error: null,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...patch,
  };
  const user = userEvent.setup();
  render(<ManualEventDialog {...props} />);
  return { props, user };
}

describe('validateManualFields', () => {
  it('title required; a real date; end after start; 5 minutes .. 12 hours', () => {
    const ok = { title: 'Gym', date: '2026-10-14', start: '09:00', end: '10:00' };
    expect(validateManualFields(ok, TZ)).toBeNull();
    expect(validateManualFields({ ...ok, title: '   ' }, TZ)).toBe('title');
    expect(validateManualFields({ ...ok, end: '09:00' }, TZ)).toBe('time');
    expect(validateManualFields({ ...ok, end: '08:00' }, TZ)).toBe('time');
    expect(validateManualFields({ ...ok, end: '09:04' }, TZ)).toBe('time');
    expect(validateManualFields({ ...ok, end: '09:05' }, TZ)).toBeNull();
    expect(validateManualFields({ ...ok, start: '08:00', end: '20:01' }, TZ)).toBe('time');
    expect(validateManualFields({ ...ok, date: '' }, TZ)).toBe('time');
    expect(validateManualFields({ ...ok, start: '25:00' }, TZ)).toBe('time');
  });
});

describe('ManualEventDialog', () => {
  it('create: offers exactly the calendars handed in; Continue hands back trimmed fields in wall-clock form', async () => {
    const { props, user } = setup();
    const select = screen.getByTestId('cal-dialog-calendar');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Personal', 'Work']);
    await user.selectOptions(select, 'work@x.test');
    await user.type(screen.getByTestId('cal-dialog-title'), '  Gym  ');
    await user.type(screen.getByTestId('cal-dialog-location'), 'Hall');
    await user.click(screen.getByTestId('cal-dialog-submit'));
    expect(props.onSubmit).toHaveBeenCalledWith({
      calendarId: 'work@x.test',
      title: 'Gym',
      startLocal: '2026-10-14T09:00:00',
      endLocal: '2026-10-14T10:00:00',
      location: 'Hall',
    });
  });

  it('an empty title or a bad time is refused in the form (nothing is handed on)', async () => {
    const { props, user } = setup();
    await user.click(screen.getByTestId('cal-dialog-submit'));
    expect(screen.getByTestId('cal-dialog-error')).toHaveTextContent('Enter a title.');
    await user.type(screen.getByTestId('cal-dialog-title'), 'Gym');
    const end = screen.getByTestId('cal-dialog-end');
    await user.clear(end);
    await user.type(end, '08:30');
    await user.click(screen.getByTestId('cal-dialog-submit'));
    expect(screen.getByTestId('cal-dialog-error')).toHaveTextContent('The end must be after the start');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('edit has no calendar choice; move focuses the start time; Escape / Cancel close; a main refusal is shown', async () => {
    const initial = {
      calendarId: 'primary',
      title: 'Dentist',
      startLocal: '2026-10-14T10:00:00',
      endLocal: '2026-10-14T11:00:00',
      location: '',
    };
    const { props, user } = setup({ mode: 'move', initial, error: 'CAL_EVENT_FOREIGN_PROTECTED' });
    expect(screen.queryByTestId('cal-dialog-calendar')).toBeNull();
    expect(screen.getByTestId('cal-dialog-start')).toHaveFocus();
    expect(screen.getByTestId('cal-dialog')).toHaveAttribute('data-mode', 'move');
    expect(screen.getByTestId('cal-dialog-error')).toHaveTextContent('This event is protected');
    expect((screen.getByTestId('cal-dialog-title') as HTMLInputElement).value).toBe('Dentist');
    await user.keyboard('{Escape}');
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('cal-dialog-cancel'));
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });
});
