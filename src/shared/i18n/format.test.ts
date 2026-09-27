// TESTS section 9 row "Bidi/format helpers": Intl snapshots for he-IL and en-IL, hourCycle h23, explicit timeZone,
// incl. the 2026-10-25 DST day and a non-default zone. Machine TZ is UTC (vitest project env) and must never leak in.
import { describe, expect, it } from 'vitest';
import { FSI, PDI } from './bidi';
import { DEFAULT_TIME_ZONE, formatDayLabel, formatTime, formatTimeRange, makeFormatters } from './format';

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
