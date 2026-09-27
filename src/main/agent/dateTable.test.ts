// TESTS 5.3 row `agent/dateTable.ts`: 14 rows, correct weekday names in both scripts, snapshot for a fixed now, other IANA zone.
import { describe, expect, it } from 'vitest';
import { renderDayTable } from './dateTable';
import { WEEKDAYS_EN, WEEKDAYS_HE, buildDayTable, type DayRow } from '../../shared/when';

const TZ = 'Asia/Jerusalem';
/** 2026-09-21T10:00 Asia/Jerusalem - the anchor of the PIPELINE 4.2 sample block. */
const ANCHOR = Date.parse('2026-09-21T07:00:00Z');

describe('renderDayTable', () => {
  const rendered = renderDayTable(buildDayTable(ANCHOR, TZ));
  const lines = rendered.split('\n');

  it('renders one line per day', () => {
    expect(lines).toHaveLength(14);
  });

  it('matches the PIPELINE 4.2 sample block', () => {
    expect(rendered).toMatchInlineSnapshot(`
      "  weekday=1 offset=0  2026-09-21  Monday     יום שני    (today, day 0)
        weekday=2 offset=0  2026-09-22  Tuesday    יום שלישי  (day 1)
        weekday=3 offset=0  2026-09-23  Wednesday  יום רביעי  (day 2)
        weekday=4 offset=0  2026-09-24  Thursday   יום חמישי  (day 3)
        weekday=5 offset=0  2026-09-25  Friday     יום שישי   (day 4)
        weekday=6 offset=0  2026-09-26  Saturday   שבת        (day 5)
        weekday=0 offset=1  2026-09-27  Sunday     יום ראשון  (day 6)
        weekday=1 offset=1  2026-09-28  Monday     יום שני    (day 7)
        weekday=2 offset=1  2026-09-29  Tuesday    יום שלישי  (day 8)
        weekday=3 offset=1  2026-09-30  Wednesday  יום רביעי  (day 9)
        weekday=4 offset=1  2026-10-01  Thursday   יום חמישי  (day 10)
        weekday=5 offset=1  2026-10-02  Friday     יום שישי   (day 11)
        weekday=6 offset=1  2026-10-03  Saturday   שבת        (day 12)
        weekday=0 offset=2  2026-10-04  Sunday     יום ראשון  (day 13)"
    `);
  });

  it('carries every weekday name in both scripts', () => {
    for (const name of [...WEEKDAYS_EN, ...WEEKDAYS_HE]) expect(rendered).toContain(name);
    expect(lines[0]).toContain('Monday');
    expect(lines[0]).toContain(WEEKDAYS_HE[1]);
    expect(lines[6]).toContain(WEEKDAYS_HE[0]);
  });

  it('counts week offsets from the anchor week, with the week starting Sunday', () => {
    const offsets = lines.map((l) => Number(/offset=(\d+)/.exec(l)?.[1]));
    expect(offsets).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2]);
  });

  it('marks only the first row as today', () => {
    expect(lines.filter((l) => l.includes('today'))).toHaveLength(1);
    expect(lines[0]).toContain('(today, day 0)');
    expect(lines[13]).toContain('(day 13)');
  });

  it('starts a Sunday anchor at offset 0 and flips a week later', () => {
    const sunday = Date.parse('2026-09-27T07:00:00Z');
    const offsets = renderDayTable(buildDayTable(sunday, TZ))
      .split('\n')
      .map((l) => Number(/offset=(\d+)/.exec(l)?.[1]));
    expect(offsets).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('follows the zone it was built for', () => {
    // 2026-09-21T22:30Z is already the 22nd in Israel and still the 21st in UTC.
    const late = Date.parse('2026-09-21T22:30:00Z');
    expect(renderDayTable(buildDayTable(late, TZ, 1))).toContain('2026-09-22');
    expect(renderDayTable(buildDayTable(late, 'UTC', 1))).toContain('2026-09-21');
    expect(renderDayTable(buildDayTable(ANCHOR, 'Pacific/Kiritimati', 1))).toContain('2026-09-21');
  });

  it('is empty for an empty table', () => {
    expect(renderDayTable([])).toBe('');
  });

  it('never leaks a bidi control or a tab into the prompt', () => {
    expect(rendered).not.toMatch(/[\t]/);
    expect(
      [...rendered].some((c) => {
        const cp = c.codePointAt(0) ?? 0;
        return cp >= 0x2066 && cp <= 0x2069;
      }),
    ).toBe(false);
  });

  it('tolerates a row set shorter than a week', () => {
    const rows: DayRow[] = buildDayTable(ANCHOR, TZ, 2);
    expect(renderDayTable(rows).split('\n')).toHaveLength(2);
  });
});
