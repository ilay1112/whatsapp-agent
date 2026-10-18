// [V3] T-904 Task 4 (handover §2.3): the week calendar.
//   - 7 day columns (Sunday first in he), today marked, 24 hour rows;
//   - one block per entry, placed with logical inline styles, time range + the UNTRUSTED title inside bdi.msg-text;
//   - click / Enter open the item; prev / today / next move the anchor; empty week and the one-time scope note.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { localToEpochMs } from '@shared/when';
import { formatTimeRange } from '@shared/i18n/format';
import type { CalendarEntry, CalendarEntryState } from '../store/calendarEntries';
import { CalendarWeek, type CalendarWeekProps } from './CalendarWeek';
import { defaultCard, i18next } from '../../../../tests/setup-renderer';

const TZ = 'Asia/Jerusalem';
const at = (local: string): number => localToEpochMs(local, TZ);
/** Wednesday 2026-10-14, mid-day: the week shown is Sun 11 - Sat 17 Oct 2026. */
const ANCHOR = at('2026-10-14T12:00:00');
const NOW = at('2026-10-15T09:30:00');

const entry = (
  itemId: number,
  startLocal: string,
  endLocal: string,
  state: CalendarEntryState = 'proposed',
  title = 'Coffee',
): CalendarEntry => ({
  itemId,
  startMs: at(startLocal),
  endMs: at(endLocal),
  title,
  state,
  eventKey: null,
  card: { ...defaultCard, itemId },
});

function setup(patch: Partial<CalendarWeekProps> = {}) {
  const props: CalendarWeekProps = {
    entries: [entry(1, '2026-10-13T22:30:00', '2026-10-14T01:00:00')],
    anchorMs: ANCHOR,
    onAnchorChange: vi.fn(),
    nowMs: NOW,
    lang: 'en',
    timeZone: TZ,
    onOpenItem: vi.fn(),
    noteSeen: true,
    onNoteSeen: vi.fn(),
    ...patch,
  };
  const user = userEvent.setup();
  render(<CalendarWeek {...props} />);
  return { props, user };
}

const dayIds = (): string[] =>
  screen.getAllByTestId(/^cal-day-/).map((el) => el.getAttribute('data-testid')!.replace('cal-day-', ''));

describe('CalendarWeek - grid', () => {
  it('he: 7 day columns starting on Sunday', async () => {
    await i18next.changeLanguage('he');
    setup({ lang: 'he' });
    expect(dayIds()).toEqual([
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
    ]);
  });

  // fix pass 7a: weekday and day number on two lines; the short weekday gives way to the narrow one in a thin column
  // (a CSS container query on .cal-day - jsdom does not evaluate it, so both spans are present here).
  it('day header: short + narrow weekday spans and the day number on its own line', () => {
    setup();
    const head = screen.getByTestId('cal-day-2026-10-14');
    expect(head).toHaveClass('cal-day');
    expect(head.querySelector('.cal-wd-short')?.textContent).toBe('Wed');
    expect(head.querySelector('.cal-wd-narrow')?.textContent).toBe('W');
    expect(head.querySelector('.cal-daynum')?.textContent).toBe('14');
  });

  it('en: 7 day columns, today marked with data-today', () => {
    setup();
    expect(dayIds()).toHaveLength(7);
    expect(screen.getByTestId('cal-day-2026-10-15')).toHaveAttribute('data-today', 'true');
    expect(screen.getByTestId('cal-day-2026-10-14')).not.toHaveAttribute('data-today');
  });

  it('renders 24 hour rows', () => {
    setup();
    for (let h = 0; h < 24; h += 1) expect(screen.getByTestId(`cal-hour-${h}`)).toBeInTheDocument();
    expect(screen.queryByTestId('cal-hour-24')).toBeNull();
  });

  it('shows the week range in the toolbar', () => {
    setup();
    const range = screen.getByTestId('cal-range').textContent ?? '';
    expect(range).toMatch(/11/);
    expect(range).toMatch(/17/);
    expect(range).toMatch(/Oct/);
    expect(range).toMatch(/2026/);
  });
});

describe('CalendarWeek - blocks', () => {
  it('places a 22:30 block at 1080 px: start time on line 1, the full range in its title, the title in bdi.msg-text', () => {
    setup();
    const block = screen.getByTestId('cal-block-1');
    expect(block.style.insetBlockStart).toBe('1080px');
    expect(block.style.blockSize).toBe('72px');
    // fix pass 7b/7c: line 1 is the start time only (one line, ellipsis); the range comes from formatTimeRange (trusted)
    const time = screen.getByTestId('cal-block-time-1');
    expect(time.textContent).toBe('22:30');
    expect(time).toHaveClass('truncate');
    expect(block.textContent).not.toContain('01:00');
    expect(block).toHaveAttribute(
      'title',
      formatTimeRange(at('2026-10-13T22:30:00'), at('2026-10-14T01:00:00'), 'en', TZ),
    );
    const title = within(block).getByText('Coffee');
    expect(title).toHaveClass('truncate');
    expect(title.tagName).toBe('BDI');
    expect(title).toHaveClass('msg-text');
    expect(title).toHaveAttribute('dir', 'auto');
    // The block sits in the column of its start day only (no second block after midnight).
    expect(within(screen.getByTestId('cal-col-2026-10-13')).getByTestId('cal-block-1')).toBe(block);
    expect(screen.getAllByTestId('cal-block-1')).toHaveLength(1);
  });

  it('keeps an untrusted title literal (no markup interpretation)', () => {
    setup({ entries: [entry(2, '2026-10-12T09:00:00', '2026-10-12T10:00:00', 'proposed', '<b>x</b>')] });
    const block = screen.getByTestId('cal-block-2');
    expect(within(block).getByText('<b>x</b>').tagName).toBe('BDI');
    expect(block.querySelector('b')).toBeNull();
  });

  // fix pass (review should-fix 5, ux.md 16.5): the untrusted chat name never goes into an attribute; it is a visually
  // hidden <bdi> inside the block, so a screen reader still hears whose meeting it is.
  it('names the chat in a visually hidden bdi.msg-text, never in the title attribute', () => {
    setup();
    const block = screen.getByTestId('cal-block-1');
    const name = defaultCard.chat.displayName !== '' ? defaultCard.chat.displayName : defaultCard.chat.phoneDisplay;
    expect(block.getAttribute('title') ?? '').not.toContain(name);
    const hidden = within(block).getByText(name);
    expect(hidden.tagName).toBe('BDI');
    expect(hidden).toHaveClass('msg-text', 'sr-only');
    expect(hidden).toHaveAttribute('dir', 'auto');
  });

  it('he: the start time is two-digit 24 h ("05:00", never "5:00")', async () => {
    await i18next.changeLanguage('he');
    setup({ lang: 'he', entries: [entry(6, '2026-10-12T05:00:00', '2026-10-12T06:00:00')] });
    expect(screen.getByTestId('cal-block-time-6').textContent).toBe('05:00');
  });

  // fix pass (review should-fix 2): overlapping entries share the column instead of covering each other.
  it('two overlapping entries are both visible side by side and both clickable', async () => {
    const { props, user } = setup({
      entries: [
        entry(7, '2026-10-12T15:00:00', '2026-10-12T16:00:00'),
        entry(8, '2026-10-12T15:30:00', '2026-10-12T16:30:00'),
      ],
    });
    const a = screen.getByTestId('cal-block-7');
    const b = screen.getByTestId('cal-block-8');
    expect(a.style.insetInlineStart).not.toBe(b.style.insetInlineStart);
    expect(a.style.inlineSize).toContain('50%');
    expect(b.style.inlineSize).toContain('50%');
    expect(a.getAttribute('data-lane')).toBe('0');
    expect(b.getAttribute('data-lane')).toBe('1');
    await user.click(a);
    await user.click(b);
    expect(props.onOpenItem).toHaveBeenNthCalledWith(1, 7);
    expect(props.onOpenItem).toHaveBeenNthCalledWith(2, 8);
  });

  it('a lone entry spans the whole column', () => {
    setup();
    const block = screen.getByTestId('cal-block-1');
    expect(block.getAttribute('data-lane')).toBe('0');
    expect(block.style.inlineSize).toContain('100%');
  });

  it.each([
    ['proposed', 'proposed'],
    ['change_proposed', 'proposed'],
    ['in_calendar', 'in_calendar'],
    ['cancelled', 'cancelled'],
  ] as const)('entry state %s renders data-state=%s', (state, dataState) => {
    setup({ entries: [entry(3, '2026-10-12T09:00:00', '2026-10-12T10:00:00', state)] });
    expect(screen.getByTestId('cal-block-3')).toHaveAttribute('data-state', dataState);
  });

  it('a cancelled block is struck through; a proposed one is dashed', () => {
    setup({
      entries: [
        entry(4, '2026-10-12T09:00:00', '2026-10-12T10:00:00', 'cancelled'),
        entry(5, '2026-10-12T11:00:00', '2026-10-12T12:00:00', 'proposed'),
      ],
    });
    expect(screen.getByTestId('cal-block-4').className).toContain('line-through');
    expect(screen.getByTestId('cal-block-5').className).toContain('border-dashed');
  });

  it('click opens the item', async () => {
    const { props, user } = setup();
    await user.click(screen.getByTestId('cal-block-1'));
    expect(props.onOpenItem).toHaveBeenCalledWith(1);
  });

  it('Enter on a focused block opens the item', async () => {
    const { props, user } = setup();
    screen.getByTestId('cal-block-1').focus();
    await user.keyboard('{Enter}');
    expect(props.onOpenItem).toHaveBeenCalledWith(1);
  });

  it('entries outside the shown week draw no block and the week shows cal-empty', () => {
    setup({ entries: [entry(6, '2026-10-20T09:00:00', '2026-10-20T10:00:00')] });
    expect(screen.queryByTestId('cal-block-6')).toBeNull();
    expect(screen.getByTestId('cal-empty')).toHaveTextContent('Nothing this week');
  });

  it('no entries -> cal-empty', () => {
    setup({ entries: [] });
    expect(screen.getByTestId('cal-empty')).toBeInTheDocument();
  });

  it('a week with a block has no cal-empty', () => {
    setup();
    expect(screen.queryByTestId('cal-empty')).toBeNull();
  });
});

describe('CalendarWeek - toolbar', () => {
  it('cal-next moves the anchor one week on', async () => {
    const { props, user } = setup();
    await user.click(screen.getByTestId('cal-next'));
    expect(props.onAnchorChange).toHaveBeenCalledWith(ANCHOR + 7 * 86_400_000);
  });

  it('cal-prev moves the anchor one week back', async () => {
    const { props, user } = setup();
    await user.click(screen.getByTestId('cal-prev'));
    expect(props.onAnchorChange).toHaveBeenCalledWith(ANCHOR - 7 * 86_400_000);
  });

  it('cal-today moves the anchor to now', async () => {
    const { props, user } = setup();
    await user.click(screen.getByTestId('cal-today'));
    expect(props.onAnchorChange).toHaveBeenCalledWith(NOW);
  });

  it('prev / next carry their accessible names and mirrored (icon-dir) glyphs', () => {
    setup();
    expect(screen.getByTestId('cal-prev')).toHaveAccessibleName('Previous week');
    expect(screen.getByTestId('cal-next')).toHaveAccessibleName('Next week');
    expect(screen.getByTestId('cal-today')).toHaveTextContent('Today');
    for (const id of ['cal-prev', 'cal-next']) {
      const svg = screen.getByTestId(id).querySelector('svg')!;
      expect(svg.getAttribute('class')).toContain('icon-dir');
      expect(svg.getAttribute('style') ?? '').not.toMatch(/rotate/);
    }
  });

  it('he: the toolbar labels are Hebrew', async () => {
    await i18next.changeLanguage('he');
    setup({ lang: 'he' });
    expect(screen.getByTestId('cal-prev')).toHaveAccessibleName('שבוע קודם');
    expect(screen.getByTestId('cal-next')).toHaveAccessibleName('שבוע הבא');
    expect(screen.getByTestId('cal-today')).toHaveTextContent('היום');
  });
});

describe('CalendarWeek - scope note', () => {
  it('noteSeen false -> the note is shown; Got it calls onNoteSeen', async () => {
    const { props, user } = setup({ noteSeen: false });
    expect(screen.getByTestId('cal-note')).toHaveTextContent(
      'Shows the chats this app analysed, not your whole Google calendar.',
    );
    await user.click(screen.getByTestId('cal-note-dismiss'));
    expect(props.onNoteSeen).toHaveBeenCalledTimes(1);
  });

  it('noteSeen true -> no note', () => {
    setup({ noteSeen: true });
    expect(screen.queryByTestId('cal-note')).toBeNull();
  });
});
