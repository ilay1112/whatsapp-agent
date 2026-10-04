// Adversarial review "editing-undo" - resolveDelta probes (scratch, NOT part of npm test). Each `it` asserts the CORRECT behaviour.
import { describe, expect, it } from 'vitest';
import { resolveDeltaOutcome } from '../../../src/main/agent/resolveDelta';
import type { ExistingEventCtx } from '../../../src/main/agent/existingEvent';
import type { Extraction } from '../../../src/shared/schemas';
import type { WhenContext } from '../../../src/shared/when';

const TZ = 'Asia/Jerusalem';
const ctxAt = (iso: string): WhenContext => ({
  nowMs: Date.parse(iso),
  timeZone: TZ,
  defaultDurationMin: 60,
  ambiguousHour: 'assume',
});
const existingAt = (start: string, end: string): ExistingEventCtx => ({
  editableCount: 1,
  originItemId: 7,
  sourceItemId: 7,
  eventId: 'evtsrc0001',
  title: 'meeting',
  location: 'office',
  startLocal: start,
  endLocal: end,
  timeZone: TZ,
  status: 'confirmed',
  revision: 1,
});
const X: Extraction = {
  intent: 'reschedule',
  needsReply: true,
  title: 'meeting',
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
  refersToExisting: true,
  change: 'reschedule',
  changeConfidence: 'high',
  confidence: 'high',
};

describe('editing-undo-6: R10 treats the OLD day named in the text as a contradiction of the NEW day', () => {
  // Monday 2026-09-21 10:00 Jerusalem; the event is Wednesday 2026-09-23 15:00
  const ctx = ctxAt('2026-09-21T07:00:00.000Z');
  const existing = existingAt('2026-09-23T15:00:00', '2026-09-23T16:00:00');
  const tomorrow: Partial<Extraction> = { dateKind: 'relative_days', daysFromToday: 1 };
  it('en: "can we move Wednesday’s meeting to tomorrow?" is a clean reschedule to Tuesday 15:00', () => {
    const o = resolveDeltaOutcome({ ...X, ...tomorrow }, existing, ctx, "can we move Wednesday's meeting to tomorrow?");
    expect(o.path).toBe('delta');
  });
  it('he: "אפשר להזיז את הפגישה של רביעי למחר?" is a clean reschedule to Tuesday 15:00', () => {
    const o = resolveDeltaOutcome({ ...X, ...tomorrow }, existing, ctx, 'אפשר להזיז את הפגישה של רביעי למחר?');
    expect(o.path).toBe('delta');
  });
  it('he: a time-only change signed "שבת שלום" (Friday greeting) on a Sunday event', () => {
    // Friday 2026-09-25 10:00; the event is Sunday 2026-09-27 15:00; "can we move to 17:00? shabbat shalom"
    const o = resolveDeltaOutcome(
      { ...X, time24h: '17:00' },
      existingAt('2026-09-27T15:00:00', '2026-09-27T16:00:00'),
      ctxAt('2026-09-25T07:00:00.000Z'),
      'אפשר להזיז ל-17:00? שבת שלום',
    );
    expect(o.path).toBe('delta');
  });
});

describe('editing-undo-7: R8 turns a cancel of next week’s Wednesday event into a reschedule to TODAY', () => {
  it('"I have to cancel Wednesday", sent on a Wednesday, event next Wednesday => cancel, not a move to today', () => {
    // Wednesday 2026-09-23 09:00 Jerusalem; the event is Wednesday 2026-09-30 15:00
    const o = resolveDeltaOutcome(
      { ...X, intent: 'cancel', change: 'cancel', dateKind: 'weekday', weekday: 3, weekOffset: 0 },
      existingAt('2026-09-30T15:00:00', '2026-09-30T16:00:00'),
      ctxAt('2026-09-23T06:00:00.000Z'),
      'sorry, I have to cancel Wednesday',
    );
    expect(o.path).toBe('delta');
    if (o.path === 'delta') expect(o.delta.kind).toBe('cancel'); // observed: 'reschedule' to 2026-09-23T15:00
  });
});
