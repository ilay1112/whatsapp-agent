// V2-W1-11: app-side slot formatting (UX2 3.1, 3.3, 3.4). Every value here is trusted app text built from structured
// LocalDateTime fields through Intl with an explicit zone - never from model text.
import { describe, expect, it } from 'vitest';
import type { EventContentView } from '@shared/types';
import {
  formatDay,
  formatWeekday,
  formatWhen,
  formatWhenWithDay,
  keepTimeLabel,
  rescheduleSides,
  startMsOf,
} from './ChangeLine.format';

const ev = (startLocal: string, patch: Partial<EventContentView> = {}): EventContentView => ({
  title: 'x',
  startLocal,
  endLocal: startLocal,
  timeZone: 'Asia/Jerusalem',
  location: '',
  status: 'confirmed',
  ...patch,
});
const WED_15 = startMsOf(ev('2026-09-23T15:00:00'));

describe('ChangeLine.format', () => {
  it('startMsOf reads the local time in the event zone', () => {
    expect(new Date(WED_15).toISOString()).toBe('2026-09-23T12:00:00.000Z');
  });

  it('weekday: short in en, long in he', () => {
    expect(formatWeekday(WED_15, 'en', 'Asia/Jerusalem')).toBe('Wed');
    expect(formatWeekday(WED_15, 'he', 'Asia/Jerusalem')).toBe('יום רביעי');
    expect(formatWeekday(WED_15, 'en', 'Asia/Jerusalem', true)).toBe('Wednesday');
  });

  it('day: en "Wed 23 Sep", he "יום רביעי 23 בספט׳"', () => {
    expect(formatDay(WED_15, 'en', 'Asia/Jerusalem')).toMatch(/^Wed 23 Sep\w*$/);
    expect(formatDay(WED_15, 'he', 'Asia/Jerusalem')).toBe('יום רביעי 23 בספט׳');
  });

  it('when / when with day use 24 h times', () => {
    expect(formatWhen(WED_15, 'en', 'Asia/Jerusalem')).toBe('Wed 15:00');
    expect(formatWhenWithDay(WED_15, 'en', 'Asia/Jerusalem')).toMatch(/^Wed 23 Sep\w* 15:00$/);
  });

  it('the zone is explicit: the same instant reads differently in another zone', () => {
    expect(formatWhen(WED_15, 'en', 'UTC')).toBe('Wed 12:00');
  });

  it('rescheduleSides: same day drops the day on the new side', () => {
    const s = rescheduleSides(ev('2026-09-23T15:00:00'), ev('2026-09-23T17:00:00'), 'en');
    expect(s).toEqual({ from: 'Wed 15:00', to: '17:00', fromA11y: 'Wednesday 15:00', toA11y: '17:00' });
  });

  it('rescheduleSides: another day spells both days', () => {
    const s = rescheduleSides(ev('2026-09-23T15:00:00'), ev('2026-09-24T17:00:00'), 'en');
    expect(s.from).toMatch(/^Wed 23 Sep\w* 15:00$/);
    expect(s.to).toMatch(/^Thu 24 Sep\w* 17:00$/);
    expect(s.fromA11y).toBe(s.from);
  });

  it('keepTimeLabel: "15:00" on the same day, "Wed 15:00" across days', () => {
    expect(keepTimeLabel(ev('2026-09-23T15:00:00'), ev('2026-09-23T17:00:00'), 'en')).toBe('15:00');
    expect(keepTimeLabel(ev('2026-09-23T15:00:00'), ev('2026-09-25T17:00:00'), 'en')).toBe('Wed 15:00');
    expect(keepTimeLabel(ev('2026-09-23T15:00:00'), ev('2026-09-25T17:00:00'), 'he')).toBe('יום רביעי 15:00');
  });
});
