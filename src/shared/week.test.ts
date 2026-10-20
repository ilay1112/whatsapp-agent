// [V4] T-908 group C: the pure week helpers moved from src/renderer/src/store/calendarEntries.ts (tests moved unchanged)
// plus weekWindowOf (the wall-clock window CalendarEventsService asks list-events for) and the store re-export.
import { describe, expect, it } from 'vitest';
import { epochMsToLocal, localToEpochMs } from './when';
import { firstDayFor, shiftWeek, weekOf, weekWindowOf } from './week';

const TZ = 'Asia/Jerusalem';
const at = (local: string): number => localToEpochMs(local, TZ);

describe('weekOf', () => {
  const local = (ms: number): string => epochMsToLocal(ms, TZ);

  it('firstDay 0 on a Wednesday starts on the previous Sunday at local midnight', () => {
    const w = weekOf(at('2026-10-14T12:00:00'), 0, TZ);
    expect(local(w.startMs)).toBe('2026-10-11T00:00:00');
    expect(w.days).toHaveLength(7);
    expect(w.days[0]).toBe(w.startMs);
    expect(w.days.map(local)).toEqual([
      '2026-10-11T00:00:00',
      '2026-10-12T00:00:00',
      '2026-10-13T00:00:00',
      '2026-10-14T00:00:00',
      '2026-10-15T00:00:00',
      '2026-10-16T00:00:00',
      '2026-10-17T00:00:00',
    ]);
  });

  it('firstDay 1 starts on Monday; a Sunday anchor belongs to the week that began six days earlier', () => {
    expect(local(weekOf(at('2026-10-14T12:00:00'), 1, TZ).startMs)).toBe('2026-10-12T00:00:00');
    expect(local(weekOf(at('2026-10-18T09:00:00'), 1, TZ).startMs)).toBe('2026-10-12T00:00:00');
  });

  it('an anchor at local midnight of the first day is in that week', () => {
    expect(local(weekOf(at('2026-10-18T00:00:00'), 0, TZ).startMs)).toBe('2026-10-18T00:00:00');
  });

  it('the DST week (Israel falls back on Sunday 2026-10-25) has 7 local midnights, the first day 25 h long', () => {
    const w = weekOf(at('2026-10-28T12:00:00'), 0, TZ);
    expect(w.days.map((d) => local(d).slice(11))).toEqual(Array(7).fill('00:00:00'));
    expect(local(w.days[0]!).slice(0, 10)).toBe('2026-10-25');
    expect(local(w.days[6]!).slice(0, 10)).toBe('2026-10-31');
    expect(w.days[1]! - w.days[0]!).toBe(25 * 3_600_000);
  });
});

describe('shiftWeek', () => {
  it('moves the anchor by whole local weeks, also across the DST change', () => {
    expect(shiftWeek(at('2026-10-14T12:00:00'), 1, TZ)).toBe(at('2026-10-14T12:00:00') + 7 * 86_400_000);
    expect(epochMsToLocal(shiftWeek(at('2026-10-21T00:30:00'), 1, TZ), TZ)).toBe('2026-10-28T00:30:00');
    expect(epochMsToLocal(shiftWeek(at('2026-11-01T00:30:00'), -1, TZ), TZ)).toBe('2026-10-25T00:30:00');
  });
});

describe('firstDayFor', () => {
  type Proto = Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: unknown };
  const proto = Intl.Locale.prototype as Proto;
  const withWeekInfo = (firstDay: number | null, run: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo');
    const originalInfo = Object.getOwnPropertyDescriptor(proto, 'weekInfo');
    if (firstDay === null) {
      delete proto.getWeekInfo;
      Object.defineProperty(proto, 'weekInfo', { configurable: true, get: () => undefined });
    } else Object.defineProperty(proto, 'getWeekInfo', { configurable: true, value: () => ({ firstDay }) });
    try {
      run();
    } finally {
      if (original) Object.defineProperty(proto, 'getWeekInfo', original);
      else delete proto.getWeekInfo;
      if (originalInfo) Object.defineProperty(proto, 'weekInfo', originalInfo);
      else delete proto.weekInfo;
    }
  };

  it('Hebrew always starts on Sunday', () => {
    withWeekInfo(1, () => expect(firstDayFor('he')).toBe(0));
  });

  it('English follows the locale week: Monday when weekInfo says 1, else Sunday', () => {
    withWeekInfo(1, () => expect(firstDayFor('en')).toBe(1));
    withWeekInfo(7, () => expect(firstDayFor('en')).toBe(0));
  });

  it('English falls back to Sunday when the runtime has no weekInfo', () => {
    withWeekInfo(null, () => expect(firstDayFor('en')).toBe(0));
  });
});

describe('weekWindowOf', () => {
  it('is the 7 local days of the week: first midnight .. the midnight after the last day', () => {
    const w = weekWindowOf(at('2026-10-14T12:00:00'), 0, TZ);
    expect(w).toEqual({
      startMs: at('2026-10-11T00:00:00'),
      timeMinLocal: '2026-10-11T00:00:00',
      timeMaxLocal: '2026-10-18T00:00:00',
    });
    expect(weekWindowOf(at('2026-10-14T12:00:00'), 1, TZ).timeMinLocal).toBe('2026-10-12T00:00:00');
  });

  it('the DST week keeps wall-clock bounds and the same startMs as weekOf', () => {
    const w = weekWindowOf(at('2026-10-28T12:00:00'), 0, TZ);
    expect(w.timeMinLocal).toBe('2026-10-25T00:00:00');
    expect(w.timeMaxLocal).toBe('2026-11-01T00:00:00');
    expect(w.startMs).toBe(weekOf(at('2026-10-28T12:00:00'), 0, TZ).startMs);
  });
});
