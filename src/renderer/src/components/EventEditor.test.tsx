// UX 6.4 / 7.2 / 7.3: the date tab and the event form. Every piece of chrome (weekday, day, month, time range) is
// produced by the APP through Intl from structured fields, so only the title and the location are untrusted.
// Validation mirrors the S2 sanity rules inline, so the user never approves an event main would reject.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LIMITS } from '@shared/types';
import { EventChip, EventEditor, fieldsOf, validateFields, type EventVM } from './EventEditor';

const TZ = 'Asia/Jerusalem';
/** Far enough ahead that "already passed" never fires, close enough that "more than a year away" never fires. */
const DAY = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

const event = (patch: Partial<EventVM> = {}): EventVM => ({
  title: 'Coffee',
  startLocal: `${DAY}T17:00:00`,
  endLocal: `${DAY}T18:00:00`,
  timeZone: TZ,
  location: 'Cafe Noir',
  assumptions: [],
  dateHint: '',
  state: 'proposed',
  hasCalendarLink: false,
  ...patch,
});

const editorProps = {
  missing: [],
  mode: 'edit' as const,
  calendarName: 'Personal',
  onChange: () => {},
  onValidityChange: () => {},
};

describe('validateFields - the S2 sanity rules mirrored inline (UX 7.2)', () => {
  const now = Date.parse(`${DAY}T00:00:00Z`);
  const fields = (patch: Partial<ReturnType<typeof fieldsOf>> = {}) => ({ ...fieldsOf(event()), ...patch });

  it('accepts a well-formed event', () => {
    expect(validateFields(fields(), TZ, now).ok).toBe(true);
  });

  it('rejects a start in the past', () => {
    const late = Date.parse(`${DAY}T23:00:00Z`) + 400 * 86_400_000;
    expect(validateFields(fields(), TZ, late)).toMatchObject({ ok: false });
  });

  it('rejects an end at or before the start', () => {
    expect(validateFields(fields({ end: '17:00' }), TZ, now)).toMatchObject({
      ok: false,
      key: 'event.error.endBeforeStart',
    });
    expect(validateFields(fields({ end: '16:00' }), TZ, now)).toMatchObject({
      ok: false,
      key: 'event.error.endBeforeStart',
    });
  });

  it('rejects a duration outside the allowed window', () => {
    expect(validateFields(fields({ end: '17:02' }), TZ, now)).toMatchObject({ ok: false, key: 'event.error.duration' });
    expect(validateFields(fields({ start: '10:00', end: '23:00' }), TZ, now)).toMatchObject({
      ok: false,
      key: 'event.error.duration',
    });
    expect(LIMITS.eventMinMin).toBeGreaterThan(0);
  });

  it('rejects an incomplete form without pretending to know why', () => {
    expect(validateFields(fields({ date: '' }), TZ, now).ok).toBe(false);
    expect(validateFields(fields({ start: '' }), TZ, now).ok).toBe(false);
  });

  it('fieldsOf splits a ProposedEvent into form fields and falls back to the date hint', () => {
    expect(fieldsOf(event())).toMatchObject({
      title: 'Coffee',
      date: DAY,
      start: '17:00',
      end: '18:00',
      location: 'Cafe Noir',
    });
    expect(fieldsOf(event({ startLocal: '', endLocal: '', dateHint: '2026-09-24' })).date).toBe('2026-09-24');
  });
});

describe('EventEditor - the form (UX 7.2)', () => {
  it('uses native date and time inputs and reports every edit as an EventEdit', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventEditor {...editorProps} value={event()} onChange={onChange} />);
    expect(screen.getByTestId('event-date')).toHaveAttribute('type', 'date');
    expect(screen.getByTestId('event-start')).toHaveAttribute('type', 'time');
    await user.type(screen.getByTestId('event-title'), '!');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Coffee!', location: 'Cafe Noir' }));
  });

  it('gives the untrusted title and location dir="auto" and a length cap', () => {
    render(<EventEditor {...editorProps} value={event()} />);
    expect(screen.getByTestId('event-title')).toHaveAttribute('dir', 'auto');
    expect(screen.getByTestId('event-title')).toHaveAttribute('maxlength', String(LIMITS.titleChars));
    expect(screen.getByTestId('event-location')).toHaveAttribute('maxlength', String(LIMITS.locationChars));
  });

  it('renders an untrusted title as text, never as markup', () => {
    const { container } = render(
      <EventEditor {...editorProps} value={event({ title: '<img src=x onerror=alert(1)>' })} />,
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByTestId('event-title')).toHaveValue('<img src=x onerror=alert(1)>');
  });

  it('reports invalidity with the sentence the card shows next to the disabled button', async () => {
    const user = userEvent.setup();
    const onValidityChange = vi.fn();
    render(<EventEditor {...editorProps} value={event()} onValidityChange={onValidityChange} />);
    await waitFor(() => expect(onValidityChange).toHaveBeenCalledWith(true, undefined));

    await user.clear(screen.getByTestId('event-end'));
    await user.type(screen.getByTestId('event-end'), '16:00');
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false, 'End time must be after the start.'));
    expect(screen.getByTestId('event-error')).toHaveAttribute('role', 'alert');
  });

  it('names the target calendar and repeats the fixed reassurance', () => {
    render(<EventEditor {...editorProps} value={event()} />);
    expect(screen.getByTestId('event-editor')).toHaveTextContent('Personal');
    expect(screen.getByTestId('event-editor').textContent?.toLowerCase()).toContain('no invitations are sent');
  });

  it('is read-only after the event was created', () => {
    render(<EventEditor {...editorProps} mode="readonly" value={event({ state: 'created', hasCalendarLink: true })} />);
    expect(screen.queryByTestId('event-title')).toBeNull();
    expect(screen.getByTestId('event-readonly-title')).toHaveTextContent('Coffee');
    expect(screen.queryByTestId('event-change-title')).toBeNull();
  });

  it('focuses the field the card asks for (the time_assumed badge)', async () => {
    render(<EventEditor {...editorProps} value={event()} focusField="start" />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('event-start')));
  });
});

describe('EventEditor - the information-missing variant (UX 7.3)', () => {
  it('opens only the missing fields, marks them "Needed" and keeps the rest as read-only text with a Change link', async () => {
    const user = userEvent.setup();
    render(
      <EventEditor
        {...editorProps}
        mode="fill"
        missing={['time']}
        value={event({ startLocal: '', endLocal: '', dateHint: DAY })}
      />,
    );
    expect(screen.getByTestId('event-start')).toBeInTheDocument();
    expect(screen.getByTestId('event-needed-start')).toBeInTheDocument();
    expect(screen.getByTestId('event-readonly-title')).toHaveTextContent('Coffee');

    await user.click(screen.getByTestId('event-change-title'));
    expect(screen.getByTestId('event-title')).toBeInTheDocument();
  });

  it('summarises what is missing from the enum codes', () => {
    render(
      <EventEditor
        {...editorProps}
        mode="fill"
        missing={['date', 'time']}
        value={event({ startLocal: '', endLocal: '' })}
      />,
    );
    const summary = screen.getByTestId('event-missing');
    expect(summary.textContent).not.toContain('missing.');
    expect(summary.textContent?.length).toBeGreaterThan(0);
  });
});

describe('EventChip - the signature date tab (UX 6.4)', () => {
  it('builds weekday / day / month from Intl, not from the model', () => {
    render(<EventChip event={event()} badges={[]} onOpen={() => {}} />);
    const day = new Date(`${DAY}T12:00:00Z`);
    expect(screen.getByTestId('event-chip-day')).toHaveTextContent(String(day.getUTCDate()));
    expect(screen.getByTestId('event-chip-weekday').textContent?.trim()).not.toBe('');
    expect(screen.getByTestId('event-chip-month').textContent?.trim()).not.toBe('');
  });

  it('opens the sheet rather than approving anything', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<EventChip event={event()} badges={[]} onOpen={onOpen} />);
    await user.click(screen.getByTestId('event-chip'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says the time is unknown instead of inventing one', () => {
    render(
      <EventChip
        event={event({ startLocal: '', endLocal: '', dateHint: DAY, state: 'incomplete' })}
        badges={[]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByTestId('event-chip')).toHaveAttribute('data-state', 'incomplete');
    expect(screen.getByTestId('event-chip').textContent).not.toContain('17:00');
  });

  it('renders an untrusted title as text', () => {
    const { container } = render(<EventChip event={event({ title: '<b>x</b>' })} badges={[]} onOpen={() => {}} />);
    expect(container.querySelectorAll('b')).toHaveLength(0);
    expect(screen.getByTestId('event-chip-title')).toHaveTextContent('<b>x</b>');
  });

  it('renders nothing for a declined event', () => {
    const { container } = render(<EventChip event={event({ state: 'declined' })} badges={[]} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
