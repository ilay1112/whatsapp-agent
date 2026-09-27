// src/main/agent/dateTable.ts - renders the 14-day weekday table for the S1 user message (build-plan section 3; owner W1-08).
import type { DayRow } from '../../shared/when';

/** Column widths of the PIPELINE 4.2 sample block. "Wednesday" (9) and "יום שלישי" (9) are the longest names. */
const EN_WIDTH = 11;
const HE_WIDTH = 11;
const INDENT = '  ';

/** One line per day, in the shape of the PIPELINE 4.2 sample:
 *  `  weekday=1 offset=0  2026-09-21  Monday     יום שני     (today, day 0)`.
 *  `offset` = whole weeks between the anchor day's week (week starts Sunday) and the row's week, so the model can read
 *  "next Thursday" off the table instead of computing it. The caller (agent/contextBuilder.ts) adds the `today:` header,
 *  which needs the IANA zone this function is not given. Pure. */
export function renderDayTable(rows: DayRow[]): string {
  const anchor = rows[0];
  if (anchor === undefined) return '';
  const anchorWeekdayIndex = anchor.weekdayIndex;
  return rows
    .map((row, dayIndex) => {
      const offset = Math.floor((dayIndex + anchorWeekdayIndex) / 7);
      const note = dayIndex === 0 ? '(today, day 0)' : `(day ${dayIndex})`;
      const en = row.weekdayEn.padEnd(EN_WIDTH, ' ');
      const he = row.weekdayHe.padEnd(HE_WIDTH, ' ');
      return `${INDENT}weekday=${row.weekdayIndex} offset=${offset}  ${row.date}  ${en}${he}${note}`;
    })
    .join('\n');
}
