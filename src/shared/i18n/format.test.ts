// TESTS section 9 row "Bidi/format helpers": Intl snapshots for he-IL and en-IL, hourCycle h23, explicit timeZone,
// incl. the 2026-10-25 DST day and a non-default zone. Machine TZ is UTC (vitest project env) and must never leak in.
import { describe, expect, it } from 'vitest';
import { FSI, PDI } from './bidi';
import {
  DEFAULT_TIME_ZONE,
  ageParts,
  changeArrow,
  formatChangeSides,
  formatClockDuration,
  formatDate,
  formatDayLabel,
  formatElapsed,
  formatModelSize,
  formatRelativeAge,
  formatResetTime,
  formatTime,
  formatTimeRange,
  makeFormatters,
} from './format';

const TZ = DEFAULT_TIME_ZONE;
/** 2026-09-24T17:00 Asia/Jerusalem - the instant the i18n-rtl.md 8.1 table was measured with. */
const THU_1700 = Date.parse('2026-09-24T14:00:00Z');

describe('makeFormatters', () => {
  it('resolves he-IL / en-IL with h23 and the explicit zone', () => {
    for (const lng of ['he', 'en'] as const) {
      const f = makeFormatters(lng, TZ);
      const opts = f.time.resolvedOptions();
      expect(opts.locale).toBe(lng === 'he' ? 'he-IL' : 'en-IL');
      expect(opts.timeZone).toBe(TZ);
      expect(opts.hourCycle).toBe('h23');
      expect(f.firstDay).toBe(7); // Sunday
    }
  });
  it('defaults to Asia/Jerusalem but never to the machine zone', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(makeFormatters('he').time.resolvedOptions().timeZone).toBe(TZ);
  });
  it('falls back to a Sunday week when the runtime exposes no weekInfo', () => {
    const proto = Intl.Locale.prototype as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: unknown;
    };
    const original = proto.getWeekInfo;
    delete proto.getWeekInfo;
    try {
      expect(makeFormatters('he', 'Atlantic/Reykjavik').firstDay).toBe(7); // unseen zone => not served from the cache
    } finally {
      if (original !== undefined) proto.getWeekInfo = original;
    }
    expect(makeFormatters('he', 'Indian/Mauritius').firstDay).toBe(7); // restored path still works
  });
  it('memoises per language + zone', () => {
    expect(makeFormatters('he', TZ)).toBe(makeFormatters('he', TZ));
    expect(makeFormatters('he', TZ)).not.toBe(makeFormatters('he', 'Europe/Berlin'));
    expect(makeFormatters('he', TZ)).not.toBe(makeFormatters('en', TZ));
  });
  it('matches the verified i18n-rtl.md 8.1 outputs', () => {
    expect(makeFormatters('he', TZ).full.format(new Date(THU_1700))).toMatchInlineSnapshot(
      `"יום חמישי, 24 בספטמבר 2026 בשעה 17:00"`,
    );
    expect(makeFormatters('en', TZ).full.format(new Date(THU_1700))).toMatchInlineSnapshot(
      `"Thursday, 24 September 2026 at 17:00"`,
    );
    expect(makeFormatters('he', TZ).dayShort.format(new Date(THU_1700))).toMatchInlineSnapshot(`"יום ה׳, 24 בספט׳"`);
    expect(makeFormatters('en', TZ).dayShort.format(new Date(THU_1700))).toMatchInlineSnapshot(`"Thu, 24 Sept"`);
    expect(makeFormatters('he', TZ).list.format(['א', 'ב', 'ג'])).toMatchInlineSnapshot(`"א, ב וג"`);
    expect(makeFormatters('en', TZ).list.format(['a', 'b', 'c'])).toMatchInlineSnapshot(`"a, b, and c"`);
  });
});

describe('formatTime', () => {
  it('is 24-hour in both languages', () => {
    expect(formatTime(THU_1700, 'he', TZ)).toBe('17:00');
    expect(formatTime(THU_1700, 'en', TZ)).toBe('17:00');
    expect(formatTime(THU_1700, 'en', TZ)).not.toMatch(/[AP]M/i);
  });
  it('follows the zone it is given, not the machine', () => {
    expect(formatTime(THU_1700, 'en', 'UTC')).toBe('14:00');
    expect(formatTime(THU_1700, 'en', 'Europe/Berlin')).toBe('16:00');
  });
  it('is correct on both sides of the 2026-10-25 change', () => {
    expect(formatTime(Date.parse('2026-10-24T22:00:00Z'), 'he', TZ)).toBe('01:00'); // still IDT (+3)
    expect(formatTime(Date.parse('2026-10-25T08:00:00Z'), 'he', TZ)).toBe('10:00'); // IST (+2)
  });
});

describe('formatTimeRange', () => {
  it('is an isolated HH:mm-HH:mm with a plain hyphen', () => {
    const range = formatTimeRange(THU_1700, THU_1700 + 3600_000, 'he', TZ);
    expect(range).toBe(`${FSI}17:00-18:00${PDI}`);
    expect(range).not.toContain('–'); // never the ICU en dash
    expect(formatTimeRange(THU_1700, THU_1700 + 3600_000, 'en', TZ)).toBe(`${FSI}17:00-18:00${PDI}`);
  });
  it('shows real wall-clock ends across the DST change', () => {
    // 00:30 IDT + 2 h of wall clock = 02:30 IST; the two instants are three real hours apart.
    expect(formatTimeRange(Date.parse('2026-10-24T21:30:00Z'), Date.parse('2026-10-25T00:30:00Z'), 'he', TZ)).toBe(
      `${FSI}00:30-02:30${PDI}`,
    );
  });
});

describe('formatDayLabel', () => {
  const now = Date.parse('2026-09-21T07:00:00Z'); // Monday 2026-09-21 10:00 Asia/Jerusalem
  const dayAt = (days: number): number => now + days * 86_400_000;

  it('uses relative wording only for yesterday / today / tomorrow', () => {
    expect(formatDayLabel(dayAt(0), now, 'he', TZ)).toBe('היום');
    expect(formatDayLabel(dayAt(1), now, 'he', TZ)).toBe('מחר');
    expect(formatDayLabel(dayAt(-1), now, 'he', TZ)).toBe('אתמול');
    expect(formatDayLabel(dayAt(0), now, 'en', TZ)).toBe('today');
    expect(formatDayLabel(dayAt(1), now, 'en', TZ)).toBe('tomorrow');
    expect(formatDayLabel(dayAt(-1), now, 'en', TZ)).toBe('yesterday');
  });
  it('uses a weekday name inside the coming week', () => {
    expect(formatDayLabel(dayAt(2), now, 'en', TZ)).toBe('Wednesday');
    expect(formatDayLabel(dayAt(6), now, 'en', TZ)).toBe('Sunday');
    expect(formatDayLabel(dayAt(3), now, 'he', TZ)).toMatchInlineSnapshot(`"יום חמישי"`);
  });
  it('falls back to the short date beyond a week and for older days', () => {
    expect(formatDayLabel(dayAt(7), now, 'en', TZ)).toMatchInlineSnapshot(`"Mon, 28 Sept"`);
    expect(formatDayLabel(dayAt(-3), now, 'he', TZ)).toMatchInlineSnapshot(`"יום ו׳, 18 בספט׳"`);
  });
  it('never emits the CLDR dual "(2)" artefact', () => {
    for (let d = -14; d <= 14; d++) {
      for (const lng of ['he', 'en'] as const) {
        expect(formatDayLabel(dayAt(d), now, lng, TZ)).not.toMatch(/\(\d+\)/);
      }
    }
  });
  it('counts calendar days in the given zone, not 24-hour blocks', () => {
    const late = Date.parse('2026-09-21T20:30:00Z'); // 23:30 in Israel, 20:30 in UTC
    const soon = Date.parse('2026-09-21T21:30:00Z'); // 00:30 next day in Israel, same UTC day
    expect(formatDayLabel(soon, late, 'en', TZ)).toBe('tomorrow');
    expect(formatDayLabel(soon, late, 'en', 'UTC')).toBe('today');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] V2-W1-12 - T2 9: the Change arrow line, relative ages, "usage resets HH:MM" (h23, explicit zone), sizes.
// ---------------------------------------------------------------------------------------------------------------------
describe('v2 helpers', () => {
  /** Wed 2026-09-23 15:00 / 17:00 Asia/Jerusalem (UTC+3). */
  const WED_1500 = Date.parse('2026-09-23T12:00:00Z');
  const WED_1700 = Date.parse('2026-09-23T14:00:00Z');
  const strip = (s: string) => s.replaceAll(FSI, '').replaceAll(PDI, '');

  it('changeArrow points in reading direction', () => {
    expect(changeArrow('en')).toBe('→');
    expect(changeArrow('he')).toBe('←');
  });

  it('assembles the Change line of T2 9 in he and en (same day => the time only on the `to` side)', () => {
    const he = formatChangeSides(WED_1500, WED_1700, 'he', TZ);
    expect(strip(`שינוי: ${he.from} ${changeArrow('he')} ${he.to}`)).toBe('שינוי: יום רביעי 15:00 ← 17:00');
    const en = formatChangeSides(WED_1500, WED_1700, 'en', TZ);
    expect(strip(`Change: ${en.from} ${changeArrow('en')} ${en.to}`)).toBe('Change: Wed 15:00 → 17:00');
  });

  it('names the new day when the change moves to another day, in the explicit zone', () => {
    const thu = Date.parse('2026-09-24T13:00:00Z');
    expect(formatChangeSides(WED_1500, thu, 'en', TZ).to).toBe('Thu 16:00');
    // the same instants read in UTC are 12:00 / 13:00
    expect(formatChangeSides(WED_1500, thu, 'en', 'UTC')).toEqual({ from: 'Wed 12:00', to: 'Thu 13:00' });
  });

  it('ageParts picks whole units and clamps the future to 0 s', () => {
    const now = WED_1700;
    expect(ageParts(now + 5_000, now)).toEqual({ value: 0, unit: 'second' });
    expect(ageParts(now - 59_000, now)).toEqual({ value: 59, unit: 'second' });
    expect(ageParts(now - 12 * 60_000, now)).toEqual({ value: 12, unit: 'minute' });
    expect(ageParts(now - 3_600_000, now)).toEqual({ value: 1, unit: 'hour' });
    expect(ageParts(now - 2 * 86_400_000, now)).toEqual({ value: 2, unit: 'day' });
  });

  it('formatRelativeAge: AutoStrip ages in both languages, no CLDR "(n)" artefact in Hebrew', () => {
    const now = WED_1700;
    expect(formatRelativeAge(now - 12 * 60_000, now, 'en')).toBe('12 min. ago');
    expect(formatRelativeAge(now - 3_600_000, now, 'en')).toBe('1 hr. ago');
    expect(formatRelativeAge(now - 10_000, now, 'en')).toBe('now');
    expect(formatRelativeAge(now - 12 * 60_000, now, 'he')).toBe('לפני 12 דקות');
    expect(formatRelativeAge(now - 3_600_000, now, 'he')).toBe('לפני שעה');
    expect(formatRelativeAge(now - 2 * 3_600_000, now, 'he')).toBe('לפני שעתיים');
    expect(formatRelativeAge(now - 2 * 86_400_000, now, 'he')).toBe('לפני יומיים');
    for (const v of [1, 2, 3, 5]) {
      expect(formatRelativeAge(now - v * 60_000, now, 'he')).not.toMatch(/\(\d\)/);
      expect(formatRelativeAge(now - v * 3_600_000, now, 'he')).not.toMatch(/\(\d\)/);
    }
  });

  it('formatElapsed: "Checked {{value}} ago"', () => {
    expect(formatElapsed(40_000, 'en')).toBe('40 secs');
    expect(formatElapsed(3 * 60_000, 'en')).toBe('3 mins');
    expect(formatElapsed(-5, 'en')).toBe('0 secs');
  });

  it('formatResetTime: HH:mm h23 in the explicit zone; another day adds the short day', () => {
    const reset = Date.parse('2026-09-23T12:40:00Z'); // 15:40 in Jerusalem
    const now = Date.parse('2026-09-23T09:00:00Z');
    expect(formatResetTime(reset, now, 'en', TZ)).toBe('15:40');
    expect(formatResetTime(reset, now, 'he', TZ)).toBe('15:40');
    expect(formatResetTime(reset, now, 'en', 'UTC')).toBe('12:40');
    const tomorrow = Date.parse('2026-09-24T01:05:00Z'); // 04:05 Thu in Jerusalem
    expect(formatResetTime(tomorrow, now, 'en', TZ)).toBe('Thu, 24 Sept 04:05');
    expect(formatResetTime(tomorrow, now, 'he', TZ)).toBe('יום ה׳, 24 בספט׳ 04:05');
  });

  it('formatClockDuration: m:ss', () => {
    expect(formatClockDuration(42)).toBe('0:42');
    expect(formatClockDuration(725.4)).toBe('12:05');
    expect(formatClockDuration(Number.NaN)).toBe('0:00');
    expect(formatClockDuration(-3)).toBe('0:00');
  });

  it('formatModelSize: pinned bytes / 2^30, one decimal (UX2 C1)', () => {
    expect(formatModelSize(1_624_555_275, 'en')).toBe('1.5 GB');
    expect(formatModelSize(985_654_080, 'he')).toBe('0.9 GB');
    expect(formatModelSize(175_115_840, 'en')).toBe('0.2 GB');
    expect(formatModelSize(-1, 'en')).toBe('0.0 GB');
  });

  it('formatDate: medium date in the explicit zone', () => {
    expect(formatDate(Date.parse('2026-09-27T22:30:00Z'), 'en', TZ)).toBe('28 Sept 2026');
    expect(formatDate(Date.parse('2026-09-27T22:30:00Z'), 'en', 'UTC')).toBe('27 Sept 2026');
    expect(formatDate(Date.parse('2026-09-28T09:00:00Z'), 'he', TZ)).toBe('28 בספט׳ 2026');
  });
});
