// TESTS 5.3 row `shared/when.ts`: every dateKind; weekday + weekOffset with week starting Sunday; today-is-that-weekday edge;
// ambiguous hour 1-7 PM / 8-11 AM / `ask` mode; default duration; past start, > 12 months, duration bounds; weekday contradiction;
// Asia/Jerusalem DST change (2026-10-25) and the spring gap; machine TZ = UTC must not matter (vitest sets TZ=UTC).
import { describe, expect, it } from 'vitest';
import {
  WEEKDAYS_EN,
  WEEKDAYS_HE,
  WHEN_PROBLEMS,
  addMinutes,
  buildDayTable,
  epochMsToLocal,
  localToEpochMs,
  resolveWhen,
  todayIn,
  type WhenContext,
} from './when';
import { LIMITS } from './types';
import type { Extraction } from './schemas';

const TZ = 'Asia/Jerusalem';
/** 2026-09-21T10:00 Asia/Jerusalem (a Monday, IDT = UTC+3) - the anchor of every PIPELINE section 11 row. */
const ANCHOR = Date.parse('2026-09-21T07:00:00Z');

const BASE: Extraction = {
  intent: 'schedule_request',
  needsReply: true,
  title: '',
  dateKind: 'none',
  isoDate: '',
  weekday: 0,
  weekOffset: 0,
  daysFromToday: 0,
  time24h: '',
  timeAmbiguous: false,
  durationMin: 0,
  location: '',
  missing: [],
  suspicious: false,
};
const ex = (patch: Partial<Extraction>): Extraction => ({ ...BASE, ...patch });
const ctx = (patch: Partial<WhenContext> = {}): WhenContext => ({
  nowMs: ANCHOR,
  timeZone: TZ,
  defaultDurationMin: 60,
  ambiguousHour: 'assume',
  ...patch,
});

describe('machine time zone independence', () => {
  it('runs under TZ=UTC (vitest project env) and still resolves Asia/Jerusalem wall clock', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(epochMsToLocal(ANCHOR, TZ)).toBe('2026-09-21T10:00:00');
    expect(epochMsToLocal(ANCHOR, 'UTC')).toBe('2026-09-21T07:00:00');
    expect(todayIn(TZ, Date.parse('2026-09-21T22:30:00Z'))).toBe('2026-09-22'); // already tomorrow in Israel
    expect(todayIn('UTC', Date.parse('2026-09-21T22:30:00Z'))).toBe('2026-09-21');
  });
});

describe('epochMsToLocal / localToEpochMs', () => {
  it('round-trips an ordinary instant in several zones', () => {
    for (const zone of [TZ, 'UTC', 'America/New_York', 'Asia/Kolkata']) {
      const local = epochMsToLocal(ANCHOR, zone);
      expect(localToEpochMs(local, zone)).toBe(ANCHOR);
    }
  });
  it('accepts a LocalDateTime without seconds', () => {
    expect(localToEpochMs('2026-09-21T10:00', TZ)).toBe(ANCHOR);
  });
  it('rejects anything that is not a LocalDateTime', () => {
    expect(() => localToEpochMs('2026-09-21', TZ)).toThrow(RangeError);
    expect(() => localToEpochMs('yesterday at five', TZ)).toThrow(RangeError);
    expect(() => addMinutes('not-a-date', 10)).toThrow(RangeError);
  });
  it('handles a year below 100 without the Date.UTC 1900 shift', () => {
    expect(epochMsToLocal(localToEpochMs('0099-01-02T03:04:05', 'UTC'), 'UTC')).toBe('0099-01-02T03:04:05');
  });
});

describe('Asia/Jerusalem DST', () => {
  it('autumn fall-back 2026-10-25: the ambiguous wall time resolves to its FIRST occurrence', () => {
    // 02:00 IDT (UTC+3) becomes 01:00 IST (UTC+2), so 01:30 happens twice.
    expect(localToEpochMs('2026-10-25T01:30:00', TZ)).toBe(Date.parse('2026-10-24T22:30:00Z'));
    expect(epochMsToLocal(Date.parse('2026-10-24T22:30:00Z'), TZ)).toBe('2026-10-25T01:30:00');
    expect(epochMsToLocal(Date.parse('2026-10-24T23:30:00Z'), TZ)).toBe('2026-10-25T01:30:00');
    // unambiguous times on the same day still resolve exactly
    expect(localToEpochMs('2026-10-25T03:00:00', TZ)).toBe(Date.parse('2026-10-25T01:00:00Z'));
    expect(localToEpochMs('2026-10-24T23:00:00', TZ)).toBe(Date.parse('2026-10-24T20:00:00Z'));
  });
  it('spring gap 2026-03-27: a non-existent wall time becomes the first valid instant AFTER the gap', () => {
    // 02:00 IST jumps to 03:00 IDT; 02:00..02:59 do not exist.
    const transition = Date.parse('2026-03-27T00:00:00Z');
    expect(epochMsToLocal(transition, TZ)).toBe('2026-03-27T03:00:00');
    for (const gap of ['2026-03-27T02:00:00', '2026-03-27T02:30:00', '2026-03-27T02:59:00']) {
      expect(localToEpochMs(gap, TZ)).toBe(transition);
    }
    expect(localToEpochMs('2026-03-27T01:59:00', TZ)).toBe(Date.parse('2026-03-26T23:59:00Z'));
    expect(localToEpochMs('2026-03-27T03:00:00', TZ)).toBe(transition);
  });
  it('an event that spans the autumn change keeps its wall-clock duration, not its elapsed duration', () => {
    const start = '2026-10-25T00:30:00';
    const end = addMinutes(start, 120);
    expect(end).toBe('2026-10-25T02:30:00'); // wall clock: no DST in addMinutes by design
    expect(localToEpochMs(end, TZ) - localToEpochMs(start, TZ)).toBe(3 * 3600_000); // instants: three real hours
  });
});

describe('addMinutes', () => {
  it('adds, subtracts and rolls over months and years on the wall clock', () => {
    expect(addMinutes('2026-09-21T10:00:00', 45)).toBe('2026-09-21T10:45:00');
    expect(addMinutes('2026-09-21T10:00:00', -90)).toBe('2026-09-21T08:30:00');
    expect(addMinutes('2026-09-30T23:30:00', 45)).toBe('2026-10-01T00:15:00');
    expect(addMinutes('2026-12-31T23:59:00', 1)).toBe('2027-01-01T00:00:00');
    expect(addMinutes('2028-02-28T23:00:00', 120)).toBe('2028-02-29T01:00:00'); // leap year
    expect(addMinutes('2026-09-21T10:00:30', 0)).toBe('2026-09-21T10:00:30');
    expect(addMinutes('2026-09-21T10:00:00', 30.9)).toBe('2026-09-21T10:30:00'); // truncated
  });
  it('rejects a non-finite amount', () => {
    expect(() => addMinutes('2026-09-21T10:00:00', Number.NaN)).toThrow(RangeError);
    expect(() => addMinutes('2026-09-21T10:00:00', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('buildDayTable', () => {
  it('produces 14 Sunday-indexed rows starting today, in both scripts', () => {
    const rows = buildDayTable(ANCHOR, TZ);
    expect(rows).toHaveLength(14);
    expect(rows[0]).toEqual({ date: '2026-09-21', weekdayIndex: 1, weekdayEn: 'Monday', weekdayHe: WEEKDAYS_HE[1] });
    expect(rows[6]).toEqual({ date: '2026-09-27', weekdayIndex: 0, weekdayEn: 'Sunday', weekdayHe: WEEKDAYS_HE[0] });
    expect(rows[13]?.date).toBe('2026-10-04');
    expect(rows.map((r) => r.weekdayIndex)).toEqual([1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0]);
    expect(WEEKDAYS_EN[6]).toBe('Saturday');
  });
  it('honours the day count, an explicit zone and degenerate inputs', () => {
    expect(buildDayTable(ANCHOR, TZ, 3).map((r) => r.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect(buildDayTable(ANCHOR, TZ, 0)).toEqual([]);
    expect(buildDayTable(ANCHOR, TZ, -5)).toEqual([]);
    expect(buildDayTable(ANCHOR, TZ, Number.NaN)).toEqual([]);
    // 2026-09-21T22:30Z is still the 21st in UTC but already the 22nd in Israel
    const late = Date.parse('2026-09-21T22:30:00Z');
    expect(buildDayTable(late, TZ, 1)[0]?.date).toBe('2026-09-22');
    expect(buildDayTable(late, 'UTC', 1)[0]?.date).toBe('2026-09-21');
  });
  it('crosses the autumn DST boundary without losing or repeating a day', () => {
    const rows = buildDayTable(Date.parse('2026-10-22T09:00:00Z'), TZ, 5);
    expect(rows.map((r) => r.date)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
  });
});

describe('resolveWhen - dateKind', () => {
  it('none: no date, missing gains date and time', () => {
    const r = resolveWhen(ex({ dateKind: 'none' }), ctx());
    expect(r).toMatchObject({ date: '', startLocal: '', endLocal: '', timeZone: TZ, problems: [] });
    expect(r.missing).toEqual(['date', 'time']);
  });
  it('absolute: uses isoDate as given', () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2026-09-24', time24h: '13:00' }), ctx());
    expect(r.date).toBe('2026-09-24');
    expect(r.startLocal).toBe('2026-09-24T13:00:00');
    expect(r.endLocal).toBe('2026-09-24T14:00:00');
    expect(r.problems).toEqual([]);
  });
  it('absolute with an empty or impossible isoDate => incoherent_date + missing date', () => {
    for (const isoDate of ['', '2026-02-30', '2026-13-01']) {
      const r = resolveWhen(ex({ dateKind: 'absolute', isoDate, time24h: '13:00' }), ctx());
      expect(r.problems).toContain('incoherent_date');
      expect(r.missing).toContain('date');
      expect(r.date).toBe('');
    }
  });
  it('weekday: next occurrence on/after today, then + weekOffset weeks (week starts Sunday)', () => {
    const at = (weekday: number, weekOffset = 0): string =>
      resolveWhen(ex({ dateKind: 'weekday', weekday, weekOffset, time24h: '09:00' }), ctx()).date;
    expect(at(1)).toBe('2026-09-21'); // today IS Monday -> today
    expect(at(2)).toBe('2026-09-22');
    expect(at(4)).toBe('2026-09-24');
    expect(at(6)).toBe('2026-09-26');
    expect(at(0)).toBe('2026-09-27'); // Sunday is the START of the next week
    expect(at(1, 1)).toBe('2026-09-28');
    expect(at(0, 1)).toBe('2026-10-04');
    expect(at(4, 2)).toBe('2026-10-08');
  });
  it('relative_days: today / tomorrow / day after tomorrow', () => {
    const at = (daysFromToday: number): string =>
      resolveWhen(ex({ dateKind: 'relative_days', daysFromToday, time24h: '14:00' }), ctx()).date;
    expect(at(0)).toBe('2026-09-21');
    expect(at(1)).toBe('2026-09-22');
    expect(at(2)).toBe('2026-09-23');
    expect(at(10)).toBe('2026-10-01');
  });
});

describe('resolveWhen - ambiguous hour (PIPELINE 5.3)', () => {
  const resolveAt = (time24h: string, timeAmbiguous = true, ambiguousHour: 'assume' | 'ask' = 'assume') =>
    resolveWhen(ex({ dateKind: 'relative_days', daysFromToday: 1, time24h, timeAmbiguous }), ctx({ ambiguousHour }));

  it('1-7 become PM and record hour_assumed_pm', () => {
    for (const [given, expected] of [
      ['01:00', '13:00'],
      ['05:00', '17:00'],
      ['07:30', '19:30'],
    ] as const) {
      const r = resolveAt(given);
      expect(r.startLocal).toBe(`2026-09-22T${expected}:00`);
      expect(r.assumptions).toContain('hour_assumed_pm');
    }
  });
  it('8-11 stay AM and record hour_assumed_am', () => {
    for (const given of ['08:00', '09:15', '11:00']) {
      const r = resolveAt(given);
      expect(r.startLocal).toBe(`2026-09-22T${given}:00`);
      expect(r.assumptions).toContain('hour_assumed_am');
    }
  });
  it('an hour the model already normalised to PM still records the assumption (golden he-01 / en-02)', () => {
    const r = resolveAt('17:00');
    expect(r.startLocal).toBe('2026-09-22T17:00:00');
    expect(r.assumptions).toContain('hour_assumed_pm');
  });
  it('12 is noon and 00 is midnight; neither is shifted', () => {
    expect(resolveAt('12:00').startLocal).toBe('2026-09-22T12:00:00');
    expect(resolveAt('12:00').assumptions).toContain('hour_assumed_pm');
    expect(resolveAt('00:30').startLocal).toBe('2026-09-22T00:30:00');
    expect(resolveAt('00:30').assumptions).toContain('hour_assumed_am');
  });
  it('an unambiguous hour is never shifted and records no assumption', () => {
    const r = resolveAt('05:00', false);
    expect(r.startLocal).toBe('2026-09-22T05:00:00');
    expect(r.assumptions).not.toContain('hour_assumed_pm');
    expect(r.assumptions).not.toContain('hour_assumed_am');
  });
  it("ask mode does not guess: missing += 'time' and no start", () => {
    const r = resolveAt('05:00', true, 'ask');
    expect(r.startLocal).toBe('');
    expect(r.missing).toContain('time');
    expect(r.assumptions).not.toContain('hour_assumed_pm');
  });
  it('ask mode leaves an UNAMBIGUOUS time alone', () => {
    const r = resolveAt('17:00', false, 'ask');
    expect(r.startLocal).toBe('2026-09-22T17:00:00');
    expect(r.missing).not.toContain('time');
  });
});

describe('resolveWhen - duration (PIPELINE 5.4)', () => {
  const withDuration = (durationMin: number, defaultDurationMin = 60) =>
    resolveWhen(
      ex({ dateKind: 'relative_days', daysFromToday: 1, time24h: '09:00', durationMin }),
      ctx({ defaultDurationMin }),
    );

  it('0 means "use the setting" and records default_duration', () => {
    const r = withDuration(0, 90);
    expect(r.endLocal).toBe('2026-09-22T10:30:00');
    expect(r.assumptions).toContain('default_duration');
    expect(r.problems).toEqual([]);
  });
  it('an explicit duration is used verbatim and records no assumption', () => {
    const r = withDuration(45);
    expect(r.endLocal).toBe('2026-09-22T09:45:00');
    expect(r.assumptions).not.toContain('default_duration');
  });
  it('accepts both bounds of 5 min .. 12 h', () => {
    expect(withDuration(LIMITS.eventMinMin).endLocal).toBe('2026-09-22T09:05:00');
    expect(withDuration(LIMITS.eventMaxMin).endLocal).toBe('2026-09-22T21:00:00');
    expect(withDuration(LIMITS.eventMaxMin).problems).toEqual([]);
  });
  it('out-of-bounds durations downgrade to bad_duration + missing duration and fall back to the setting', () => {
    for (const bad of [1, 4, LIMITS.eventMaxMin + 1, 5000]) {
      const r = withDuration(bad);
      expect(r.problems).toContain('bad_duration');
      expect(r.missing).toContain('duration');
      expect(r.endLocal).toBe('2026-09-22T10:00:00');
    }
  });
  it('an unusable defaultDurationMin is clamped rather than propagated', () => {
    expect(withDuration(0, 1).endLocal).toBe(`2026-09-22T09:0${LIMITS.eventMinMin}:00`);
    expect(withDuration(0, 99_999).endLocal).toBe('2026-09-22T21:00:00');
    expect(withDuration(0, Number.NaN).endLocal).toBe('2026-09-22T10:00:00');
    expect(withDuration(0, 61.9).endLocal).toBe('2026-09-22T10:01:00');
  });
});

describe('resolveWhen - sanity checks (PIPELINE 5.5)', () => {
  it('a start before the anchor => in_past + missing date', () => {
    const r = resolveWhen(ex({ dateKind: 'relative_days', daysFromToday: 0, time24h: '09:00' }), ctx());
    expect(r.problems).toContain('in_past');
    expect(r.missing).toContain('date');
  });
  it('a start after the anchor on the same day is fine', () => {
    const r = resolveWhen(ex({ dateKind: 'relative_days', daysFromToday: 0, time24h: '15:00' }), ctx());
    expect(r.problems).toEqual([]);
    expect(r.startLocal).toBe('2026-09-21T15:00:00');
  });
  it('a date-only slot in the past is caught too', () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2026-09-20' }), ctx());
    expect(r.problems).toContain('in_past');
  });
  it('a date-only slot today is not in the past', () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2026-09-21' }), ctx());
    expect(r.problems).toEqual([]);
  });
  it(`more than ${LIMITS.eventHorizonMonths} months ahead => too_far + missing date`, () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2027-09-22', time24h: '09:00' }), ctx());
    expect(r.problems).toContain('too_far');
    expect(r.missing).toContain('date');
  });
  it('exactly 12 months ahead is still inside the horizon', () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2027-09-21', time24h: '09:00' }), ctx());
    expect(r.problems).toEqual([]);
  });
  it('the horizon clamps to the last day of a shorter month', () => {
    const onLeapDay = ctx({ nowMs: Date.parse('2028-02-29T07:00:00Z') });
    expect(
      resolveWhen(ex({ dateKind: 'absolute', isoDate: '2029-02-28', time24h: '09:00' }), onLeapDay).problems,
    ).toEqual([]);
    expect(
      resolveWhen(ex({ dateKind: 'absolute', isoDate: '2029-03-01', time24h: '09:00' }), onLeapDay).problems,
    ).toContain('too_far');
  });
  it('a weekday word contradicting an explicit date => weekday_mismatch + missing date', () => {
    // 2026-09-24 is a Thursday (4); the model also claimed Tuesday (2).
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2026-09-24', weekday: 2, time24h: '13:00' }), ctx());
    expect(r.problems).toContain('weekday_mismatch');
    expect(r.missing).toContain('date');
  });
  it('a matching weekday on an explicit date raises nothing', () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2026-09-24', weekday: 4, time24h: '13:00' }), ctx());
    expect(r.problems).toEqual([]);
  });
  it('weekday 0 on an explicit date is the schema default and is never treated as a contradiction', () => {
    const r = resolveWhen(ex({ dateKind: 'absolute', isoDate: '2026-09-24', weekday: 0, time24h: '13:00' }), ctx());
    expect(r.problems).toEqual([]);
  });
  it('the cross-check does not fire for a weekday-derived date', () => {
    const r = resolveWhen(ex({ dateKind: 'weekday', weekday: 4, time24h: '13:00' }), ctx());
    expect(r.problems).toEqual([]);
    expect(r.date).toBe('2026-09-24');
  });
});

describe('resolveWhen - wall times swallowed by a DST spring-forward gap', () => {
  // Israel 2026-03-27: 02:00 IST jumps straight to 03:00 IDT, so the wall times 02:00..02:59 never happen that night.
  // localToEpochMs deliberately collapses every one of them onto the transition instant, so a slot proposed inside the
  // gap would resolve to a zero-minute (or shortened) event that eventSanity rejects on every approval attempt.
  const beforeSpring = ctx({ nowMs: Date.parse('2026-03-20T08:00:00Z') });

  it('a start inside the gap degrades to missing time instead of an un-approvable slot', () => {
    const r = resolveWhen(
      ex({ dateKind: 'absolute', isoDate: '2026-03-27', time24h: '02:00', durationMin: 30 }),
      beforeSpring,
    );
    expect(r.date).toBe('2026-03-27'); // the day is fine; only the hour is not real
    expect(r.startLocal).toBe('');
    expect(r.endLocal).toBe('');
    expect(r.missing).toContain('time');
    expect(r.missing).not.toContain('date');
  });

  it('an end inside the gap degrades too (the start exists, the end does not)', () => {
    const r = resolveWhen(
      ex({ dateKind: 'absolute', isoDate: '2026-03-27', time24h: '01:30', durationMin: 60 }),
      beforeSpring,
    );
    expect(localToEpochMs('2026-03-27T01:30:00', TZ)).toBe(Date.parse('2026-03-26T23:30:00Z')); // start is real
    expect(r.startLocal).toBe(''); // but 02:30 is not, so the pair is unusable
    expect(r.endLocal).toBe('');
    expect(r.missing).toContain('time');
  });

  it('real wall times on the same night, and the ambiguous autumn ones, are untouched', () => {
    const spring = resolveWhen(
      ex({ dateKind: 'absolute', isoDate: '2026-03-27', time24h: '03:00', durationMin: 30 }),
      beforeSpring,
    );
    expect(spring.startLocal).toBe('2026-03-27T03:00:00');
    expect(spring.endLocal).toBe('2026-03-27T03:30:00');
    expect(spring.problems).toEqual([]);
    expect(spring.missing).toEqual([]);
    // 2026-10-25T01:30 happens twice - ambiguous, but it does exist, so it must still resolve.
    const autumn = resolveWhen(
      ex({ dateKind: 'absolute', isoDate: '2026-10-25', time24h: '01:30', durationMin: 30 }),
      ctx({ nowMs: Date.parse('2026-10-20T08:00:00Z') }),
    );
    expect(autumn.startLocal).toBe('2026-10-25T01:30:00');
    expect(autumn.endLocal).toBe('2026-10-25T02:00:00');
    expect(autumn.missing).toEqual([]);
  });
});

describe('resolveWhen - missing and problems bookkeeping', () => {
  it('keeps the extraction-supplied entries, dedupes and uses MISSING_FIELDS order', () => {
    const r = resolveWhen(ex({ dateKind: 'none', missing: ['location', 'date', 'who', 'date'] }), ctx());
    expect(r.missing).toEqual(['date', 'time', 'location', 'who']);
  });
  it('reports problems in WHEN_PROBLEMS order', () => {
    const r = resolveWhen(ex({ dateKind: 'relative_days', daysFromToday: 0, time24h: '09:00', durationMin: 2 }), ctx());
    expect(r.problems).toEqual(['in_past', 'bad_duration']);
    expect(WHEN_PROBLEMS.indexOf('in_past')).toBeLessThan(WHEN_PROBLEMS.indexOf('bad_duration'));
  });
  it('carries the context time zone through unchanged', () => {
    expect(resolveWhen(ex({}), ctx({ timeZone: 'Europe/Berlin' })).timeZone).toBe('Europe/Berlin');
  });
  it('resolves relative days against the anchor zone, not UTC', () => {
    const lateNight = ctx({ nowMs: Date.parse('2026-09-21T22:30:00Z') }); // 2026-09-22 01:30 in Israel
    expect(resolveWhen(ex({ dateKind: 'relative_days', daysFromToday: 1, time24h: '14:00' }), lateNight).date).toBe(
      '2026-09-23',
    );
    expect(
      resolveWhen(ex({ dateKind: 'relative_days', daysFromToday: 1, time24h: '14:00' }), {
        ...lateNight,
        timeZone: 'UTC',
      }).date,
    ).toBe('2026-09-22');
  });
});
