import { describe, expect, it } from 'vitest';
import { localToEpochMs, resolveWhen } from '../../../src/shared/when';
import { validateFields, fieldsOf } from '../../../src/renderer/src/components/EventEditor';
import type { Extraction } from '../../../src/shared/schemas';

const TZ = 'Asia/Jerusalem';

const extraction = (over: Partial<Extraction>): Extraction =>
  ({
    intent: 'schedule_request',
    dateKind: 'absolute',
    isoDate: '2026-03-27',
    weekday: 0,
    weekOffset: 0,
    daysFromToday: 0,
    time24h: '02:00',
    timeAmbiguous: false,
    durationMin: 30,
    title: 'x',
    location: '',
    needsReply: false,
    suspicious: false,
    missing: [],
    ...over,
  }) as unknown as Extraction;

describe('verify correctness-pipeline-8', () => {
  it('resolveWhen really produces the gap slot 02:00-02:30 with no problem flag', () => {
    const when = resolveWhen(extraction({}), {
      nowMs: Date.parse('2026-03-20T10:00:00Z'),
      timeZone: TZ,
      defaultDurationMin: 60,
      ambiguousHour: 'assume',
    });
    expect(when.startLocal).toBe('2026-03-27T02:00:00');
    expect(when.endLocal).toBe('2026-03-27T02:30:00');
    expect(when.problems).toEqual([]);
    expect(when.missing).toEqual([]);
    expect(localToEpochMs(when.startLocal, TZ)).toBe(localToEpochMs(when.endLocal, TZ));
  });

  it('the renderer refuses the same slot before any click: button disabled + duration message', () => {
    const vm = {
      title: 'x',
      startLocal: '2026-03-27T02:00:00',
      endLocal: '2026-03-27T02:30:00',
      timeZone: TZ,
      location: '',
      assumptions: [],
      dateHint: '',
      state: 'proposed' as const,
      hasCalendarLink: false,
    };
    const verdict = validateFields(fieldsOf(vm), TZ, Date.parse('2026-03-20T10:00:00Z'));
    expect(verdict).toEqual({ ok: false, key: 'event.error.duration' });
  });

  it('the user can repair it in the editor: 03:00-03:30 validates', () => {
    const fields = { title: 'x', date: '2026-03-27', start: '03:00', end: '03:30', location: '' };
    expect(validateFields(fields, TZ, Date.parse('2026-03-20T10:00:00Z'))).toEqual({ ok: true });
  });
});
