// V2-W1-11: EventEditor `mode:'change'` (edits `to` only, I3'; title changes not applied, F40) and the EventChip states
// `updated` / `cancelled` (UX2 3.4), plus the "Check against the picture" date hint (UX2 3.6).
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventChip, EventEditor, type EventVM } from './EventEditor';

const DAY = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
const vm = (patch: Partial<EventVM> = {}): EventVM => ({
  title: 'Meeting',
  startLocal: `${DAY}T17:00:00`,
  endLocal: `${DAY}T18:00:00`,
  timeZone: 'Asia/Jerusalem',
  location: 'Cafe Noir',
  assumptions: [],
  dateHint: '',
  state: 'change_proposed',
  hasCalendarLink: false,
  ...patch,
});

describe('EventEditor mode "change"', () => {
  it('title read-only with the F40 note; time and place editable; no calendar line', () => {
    render(
      <EventEditor
        value={vm()}
        missing={[]}
        mode="change"
        calendarName="Home"
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('event-editor')).toHaveAttribute('data-mode', 'change');
    expect(screen.queryByTestId('event-title')).toBeNull();
    expect(screen.queryByTestId('event-change-title')).toBeNull();
    expect(screen.getByTestId('event-readonly-title')).toHaveTextContent('Meeting');
    expect(screen.getByTestId('event-title-not-applied')).toHaveTextContent(
      'Changes to the event name are not applied - edit it in Google Calendar.',
    );
    expect(screen.getByTestId('event-start')).toBeInTheDocument();
    expect(screen.getByTestId('event-location')).toBeInTheDocument();
    expect(screen.queryByTestId('event-calendar')).toBeNull();
  });

  it('the date note is linked to the date field', () => {
    render(
      <EventEditor
        value={vm()}
        missing={[]}
        mode="edit"
        calendarName="Home"
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
        dateNote="Check against the picture"
      />,
    );
    const note = screen.getByTestId('event-date-note');
    expect(note).toHaveTextContent('Check against the picture');
    expect(screen.getByTestId('event-date')).toHaveAttribute('aria-describedby', note.id);
  });

  it('no note, no aria-describedby', () => {
    render(
      <EventEditor
        value={vm()}
        missing={[]}
        mode="edit"
        calendarName="Home"
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('event-date')).not.toHaveAttribute('aria-describedby');
  });
});

describe('EventChip v2 states', () => {
  it('updated: ok header + "Updated · rev 3"', () => {
    render(
      <EventChip event={vm({ state: 'updated', revision: 3, hasCalendarLink: true })} badges={[]} onOpen={vi.fn()} />,
    );
    expect(screen.getByTestId('event-chip-rev')).toHaveTextContent('Updated · rev 3');
    expect(screen.getByTestId('event-chip').querySelector('.bg-ok')).not.toBeNull();
  });

  it('updated without a revision reads rev 1', () => {
    render(<EventChip event={vm({ state: 'updated' })} badges={[]} onOpen={vi.fn()} />);
    expect(screen.getByTestId('event-chip-rev')).toHaveTextContent('Updated · rev 1');
  });

  it('cancelled: strong-line header, struck title AND the word', () => {
    render(<EventChip event={vm({ state: 'cancelled' })} badges={[]} onOpen={vi.fn()} />);
    expect(screen.getByTestId('event-chip-cancelled')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('event-chip-title')).toHaveClass('event-cancelled');
    expect(screen.getByTestId('event-chip').querySelector('.bg-line-strong')).not.toBeNull();
  });

  it('change_proposed wears the accent header like a proposal', () => {
    render(<EventChip event={vm()} badges={[]} onOpen={vi.fn()} />);
    expect(screen.getByTestId('event-chip').querySelector('.bg-accent')).not.toBeNull();
  });
});
