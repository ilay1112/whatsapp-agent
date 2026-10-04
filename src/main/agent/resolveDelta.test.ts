// src/main/agent/resolveDelta.test.ts - P2 7.2 rules R1-R13 (+ F32, F40) / C2 15 / T2 5 row `resolveDelta` (owner V2-W1-03-edit-pipeline).
// Safety-critical (T2 13: 100 % lines / 95 % branches / 100 % functions): one table row per rule, first match decides. The ids of an
// EventDelta are pinned from the app rows (I3'); the model contributes only enums, booleans and the v1 date/time/location fields.
import { describe, expect, it } from 'vitest';
import {
  namedWeekdays,
  pickAmbiguousHour,
  resolveDelta,
  resolveDeltaOutcome,
  toResolution,
  type DeltaOutcome,
} from './resolveDelta';
import type { ExistingEventCtx } from './existingEvent';
import type { EventContentWithStatus, Extraction } from '../../shared/schemas';
import type { WhenContext } from '../../shared/when';

const TZ = 'Asia/Jerusalem';
/** 2026-09-21T10:00 Asia/Jerusalem, a Monday (the P2 15 anchor). */
const ANCHOR = Date.parse('2026-09-21T07:00:00.000Z');
const CTX: WhenContext = { nowMs: ANCHOR, timeZone: TZ, defaultDurationMin: 60, ambiguousHour: 'assume' };

/** Wednesday 2026-09-23 15:00-16:00 (the P2 15.3 default). */
const EXISTING: ExistingEventCtx = {
  editableCount: 1,
  originItemId: 7,
  sourceItemId: 7,
  eventId: 'evtsrc0001',
  title: 'meeting',
  location: 'office',
  startLocal: '2026-09-23T15:00:00',
  endLocal: '2026-09-23T16:00:00',
  timeZone: TZ,
  status: 'confirmed',
  revision: 3,
};
const FROM: EventContentWithStatus = {
  title: 'meeting',
  startLocal: '2026-09-23T15:00:00',
  endLocal: '2026-09-23T16:00:00',
  timeZone: TZ,
  location: 'office',
  status: 'confirmed',
};

const X: Extraction = {
  intent: 'reschedule',
  needsReply: true,
  title: 'MODEL TITLE',
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
const x = (over: Partial<Extraction>): Extraction => ({ ...X, ...over });
const run = (
  over: Partial<Extraction>,
  text = '',
  opts: Parameters<typeof resolveDeltaOutcome>[4] = {},
  existing: ExistingEventCtx | null = EXISTING,
  ctx: WhenContext = CTX,
): DeltaOutcome => resolveDeltaOutcome(x(over), existing, ctx, text, opts);
function delta(o: DeltaOutcome): Extract<DeltaOutcome, { path: 'delta' }>['delta'] {
  expect(o.path).toBe('delta');
  return (o as Extract<DeltaOutcome, { path: 'delta' }>).delta;
}

describe('no existing event => the v1 path (P2 7.2 preamble)', () => {
  it('null existing => v1 whatever the four fields say', () => {
    expect(run({ change: 'cancel' }, '', {}, null)).toEqual({ path: 'v1' });
  });
  it('a non-confirmed existing event is never a target => v1', () => {
    expect(run({ change: 'cancel' }, '', {}, { ...EXISTING, status: 'cancelled' })).toEqual({ path: 'v1' });
  });
});

describe('R1 - R5 (classification)', () => {
  it.each([
    ['R1 low + reschedule', { changeConfidence: 'low' as const }, { path: 'unclear', why: 'low_confidence' }],
    [
      'R1 low + move',
      { change: 'move' as const, changeConfidence: 'low' as const },
      { path: 'unclear', why: 'low_confidence' },
    ],
    [
      'R1 low + cancel',
      { change: 'cancel' as const, changeConfidence: 'low' as const },
      { path: 'unclear', why: 'low_confidence' },
    ],
    [
      'R2 cancel word, no_change',
      { intent: 'cancel' as const, change: 'no_change' as const },
      { path: 'unclear', why: 'cancel_word_no_change' },
    ],
    ['R3 new_event', { change: 'new_event' as const, refersToExisting: false }, { path: 'v1' }],
    ['R3 new_event even if refers', { change: 'new_event' as const }, { path: 'v1' }],
    ['R3 not about it, no_change', { change: 'no_change' as const, refersToExisting: false }, { path: 'v1' }],
    ['R4 not about it, reschedule', { refersToExisting: false }, { path: 'unclear', why: 'incoherent' }],
    [
      'R4 not about it, cancel',
      { change: 'cancel' as const, refersToExisting: false },
      { path: 'unclear', why: 'incoherent' },
    ],
    ['R5 about it, no_change', { change: 'no_change' as const, intent: 'smalltalk' as const }, { path: 'no_change' }],
    [
      'R5 low confidence no_change is still no_change (R1 is for changes only)',
      { change: 'no_change' as const, changeConfidence: 'low' as const, intent: 'question' as const },
      { path: 'no_change' },
    ],
  ])('%s', (_n, over, want) => {
    expect(run(over)).toEqual(want);
  });
});

describe('R6 reschedule (+ F40 duration-only)', () => {
  it('only a time: the date is inherited, the duration kept', () => {
    const d = delta(run({ time24h: '17:00' }));
    expect(d).toEqual({
      kind: 'reschedule',
      targetEventId: 'evtsrc0001',
      sourceItemId: 7,
      baseRevision: 3,
      from: FROM,
      to: { ...FROM, startLocal: '2026-09-23T17:00:00', endLocal: '2026-09-23T18:00:00' },
      confidence: 'high',
      assumptions: [],
      problems: [],
    });
  });

  it('only a day (weekday): the time is inherited', () => {
    const d = delta(run({ dateKind: 'weekday', weekday: 4 }, "let's push it to Thursday"));
    expect(d.to.startLocal).toBe('2026-09-24T15:00:00');
    expect(d.to.endLocal).toBe('2026-09-24T16:00:00');
  });

  it('a relative day plus a time', () => {
    const d = delta(run({ dateKind: 'relative_days', daysFromToday: 1, time24h: '19:30' }));
    expect(d.to.startLocal).toBe('2026-09-22T19:30:00');
    expect(d.to.endLocal).toBe('2026-09-22T20:30:00');
  });

  it('a stated duration replaces the existing one', () => {
    const d = delta(run({ time24h: '17:00', durationMin: 30 }));
    expect(d.to.endLocal).toBe('2026-09-23T17:30:00');
  });

  it('F40: duration only ("two hours instead") keeps the start and moves the end', () => {
    const d = delta(run({ durationMin: 120 }));
    expect(d.kind).toBe('reschedule');
    expect(d.to.startLocal).toBe('2026-09-23T15:00:00');
    expect(d.to.endLocal).toBe('2026-09-23T17:00:00');
  });

  it('neither a date nor a time nor a duration => incomplete, missing += time', () => {
    expect(run({})).toEqual({ path: 'incomplete', missing: ['time'] });
  });

  it('neither, and the model named what is missing => its list stands (date)', () => {
    expect(run({ missing: ['date'] })).toEqual({ path: 'incomplete', missing: ['date'] });
    expect(run({ missing: ['time', 'date'] })).toEqual({ path: 'incomplete', missing: ['date', 'time'] });
  });

  it('a new location rides along; an empty one keeps the existing place', () => {
    expect(delta(run({ time24h: '17:00', location: 'Zoom' })).to.location).toBe('Zoom');
    expect(delta(run({ time24h: '17:00' })).to.location).toBe('office');
  });

  it('the title is ALWAYS the approved one (title changes are out of scope, F40)', () => {
    expect(delta(run({ time24h: '17:00', title: 'kickoff' })).to.title).toBe('meeting');
  });

  it('suspicious changes nothing here: still a delta (manual only is S4 / AutoGate)', () => {
    expect(delta(run({ time24h: '17:00', suspicious: true })).to.startLocal).toBe('2026-09-23T17:00:00');
  });

  it('confidence of the delta = changeConfidence', () => {
    expect(delta(run({ time24h: '17:00', changeConfidence: 'medium' })).confidence).toBe('medium');
  });

  it('the picture date / time (P2 7.4) is used only when S1 named none', () => {
    const img = { date: '2026-09-24', time24h: '10:00', timeAmbiguous: false };
    expect(delta(run({}, '', { image: img })).to.startLocal).toBe('2026-09-24T10:00:00');
    expect(delta(run({ time24h: '17:00' }, '', { image: img })).to.startLocal).toBe('2026-09-24T17:00:00');
    expect(delta(run({ dateKind: 'relative_days', daysFromToday: 1 }, '', { image: img })).to.startLocal).toBe(
      '2026-09-22T10:00:00',
    );
    expect(delta(run({}, '', { image: { date: null, time24h: '11:00', timeAmbiguous: false } })).to.startLocal).toBe(
      '2026-09-23T11:00:00',
    );
    expect(run({}, '', { image: null })).toEqual({ path: 'incomplete', missing: ['time'] });
  });

  it('an incoherent S1 date is not a date: unclear/incoherent', () => {
    expect(run({ dateKind: 'absolute', isoDate: '' })).toEqual({ path: 'unclear', why: 'incoherent' });
  });
});

describe('R7 ambiguous hour inside a change', () => {
  it('picks the candidate nearest the existing start (5 near 15:00 => 17:00) and records the assumption', () => {
    const d = delta(run({ time24h: '17:00', timeAmbiguous: true }));
    expect(d.to.startLocal).toBe('2026-09-23T17:00:00');
    expect(d.assumptions).toEqual(['hour_assumed_pm']);
    const d2 = delta(run({ time24h: '05:00', timeAmbiguous: true }));
    expect(d2.to.startLocal).toBe('2026-09-23T17:00:00');
  });

  it('picks the morning when the existing event is in the morning', () => {
    const morning = { ...EXISTING, startLocal: '2026-09-23T09:00:00', endLocal: '2026-09-23T10:00:00' };
    const d = delta(run({ time24h: '22:00', timeAmbiguous: true }, '', {}, morning));
    expect(d.to.startLocal).toBe('2026-09-23T10:00:00');
    expect(d.assumptions).toEqual(['hour_assumed_am']);
  });

  it('the ambiguous picture hour is resolved the same way', () => {
    const d = delta(run({}, '', { image: { date: null, time24h: '04:00', timeAmbiguous: true } }));
    expect(d.to.startLocal).toBe('2026-09-23T16:00:00');
    expect(d.assumptions).toEqual(['hour_assumed_pm']);
  });

  it("settings.agent.ambiguousHour === 'ask' => incomplete with missing += time", () => {
    expect(run({ time24h: '17:00', timeAmbiguous: true }, '', {}, EXISTING, { ...CTX, ambiguousHour: 'ask' })).toEqual({
      path: 'incomplete',
      missing: ['time'],
    });
  });

  it.each([
    // [time24h, existing start, expected, assumption]
    ['06:00', '12:00', '18:00', 'hour_assumed_pm'], // tie (6 h each way) => the v1 rule: 1-7 => PM
    ['09:00', '15:00', '09:00', 'hour_assumed_am'], // tie => the v1 rule: 8-11 => AM
    ['11:30', '23:00', '23:30', 'hour_assumed_pm'],
    ['01:00', '23:30', '01:00', 'hour_assumed_am'], // circular distance: 01:00 is 90 min after 23:30
  ])('pickAmbiguousHour(%s, near %s) = %s', (t, near, want, assumption) => {
    expect(pickAmbiguousHour(t, near)).toEqual({ time: want, assumption });
  });

  it('12 / 00 carry no ambiguity worth resolving', () => {
    expect(pickAmbiguousHour('12:00', '15:00')).toBeNull();
    expect(pickAmbiguousHour('00:30', '15:00')).toBeNull();
    const d = delta(run({ time24h: '12:00', timeAmbiguous: true }));
    expect(d.to.startLocal).toBe('2026-09-23T12:00:00');
    expect(d.assumptions).toEqual([]);
  });
});

describe('R8 cancel', () => {
  it('nothing named => same content, status cancelled', () => {
    const d = delta(run({ intent: 'cancel', change: 'cancel' }, "can't make it, sorry"));
    expect(d.kind).toBe('cancel');
    expect(d.to).toEqual({ ...FROM, status: 'cancelled' });
  });

  it('a day that only names the event itself ("can\'t make it tomorrow") stays a cancel', () => {
    const tomorrow = { ...EXISTING, startLocal: '2026-09-22T18:00:00', endLocal: '2026-09-22T19:00:00' };
    const d = delta(
      run(
        { intent: 'cancel', change: 'cancel', dateKind: 'relative_days', daysFromToday: 1 },
        'לא אוכל להגיע מחר',
        {},
        tomorrow,
      ),
    );
    expect(d.kind).toBe('cancel');
    expect(d.to.status).toBe('cancelled');
    expect(d.to.startLocal).toBe('2026-09-22T18:00:00');
  });

  it("the event's own weekday named in a cancel is consistent (R10 checks the EXISTING day)", () => {
    const d = delta(
      run({ intent: 'cancel', change: 'cancel', dateKind: 'weekday', weekday: 3 }, 'I have to cancel Wednesday'),
    );
    expect(d.kind).toBe('cancel');
  });

  it('a cancel that names a DIFFERENT slot is a reschedule', () => {
    const d = delta(run({ intent: 'cancel', change: 'cancel', time24h: '18:00' }, 'cancel 3, make it 6'));
    expect(d.kind).toBe('reschedule');
    expect(d.to.startLocal).toBe('2026-09-23T18:00:00');
    expect(d.to.status).toBe('confirmed');
  });

  it('a cancel whose named slot is unusable stays a cancel', () => {
    const d = delta(run({ intent: 'cancel', change: 'cancel', dateKind: 'absolute', isoDate: '' }));
    expect(d.kind).toBe('cancel');
    // an ambiguous hour under 'ask' is not a usable slot either
    const d2 = delta(
      run({ intent: 'cancel', change: 'cancel', time24h: '17:00', timeAmbiguous: true }, '', {}, EXISTING, {
        ...CTX,
        ambiguousHour: 'ask',
      }),
    );
    expect(d2.kind).toBe('cancel');
  });

  it('a cancel of an event that already started (within the grace window) is still a cancel - no sanity check on the old slot', () => {
    const started = { ...EXISTING, startLocal: '2026-09-21T09:00:00', endLocal: '2026-09-21T11:00:00' };
    expect(delta(run({ intent: 'cancel', change: 'cancel' }, '', {}, started)).kind).toBe('cancel');
  });
});

const LS = String.fromCharCode(0x2028); // LINE SEPARATOR (a line terminator in source: never written literally)
const NEWLINE_RE = new RegExp('[\n' + LS + ']');

describe('R9 move', () => {
  it('a new place => only the location changes', () => {
    const d = delta(run({ change: 'move', location: 'Zoom' }));
    expect(d.kind).toBe('move');
    expect(d.to).toEqual({ ...FROM, location: 'Zoom' });
  });
  it('no place, or the same place => no_change', () => {
    expect(run({ change: 'move', location: '' })).toEqual({ path: 'no_change' });
    expect(run({ change: 'move', location: ' office ' })).toEqual({ path: 'no_change' });
  });
  it('the place is single-lined and capped', () => {
    const d = delta(run({ change: 'move', location: `Cafe\nLandwer${LS}${'x'.repeat(300)}` }));
    expect(d.to.location).not.toMatch(NEWLINE_RE);
    expect(d.to.location.startsWith('Cafe Landwer ')).toBe(true);
    expect(d.to.location.length).toBeLessThanOrEqual(120);
  });
});

describe('R10 weekday word check', () => {
  it('a weekday word that contradicts the new day => unclear/weekday_mismatch (en + he)', () => {
    expect(run({ dateKind: 'weekday', weekday: 4 }, "let's do Friday")).toEqual({
      path: 'unclear',
      why: 'weekday_mismatch',
    });
    expect(run({ dateKind: 'weekday', weekday: 4 }, 'בוא נעשה ביום שישי')).toEqual({
      path: 'unclear',
      why: 'weekday_mismatch',
    });
  });
  it('the matching word passes (with a proclitic, and "שלישי" contains no "שני")', () => {
    expect(run({ dateKind: 'weekday', weekday: 4 }, 'אפשר להזיז לחמישי?').path).toBe('delta');
    expect(run({ dateKind: 'weekday', weekday: 2 }, 'נזיז לשלישי').path).toBe('delta');
  });
  it("a cancel naming another day than the event's own => weekday_mismatch", () => {
    expect(run({ intent: 'cancel', change: 'cancel' }, "sorry, can't do Tuesday")).toEqual({
      path: 'unclear',
      why: 'weekday_mismatch',
    });
  });
  it('no weekday word => no check', () => {
    expect(run({ time24h: '17:00' }, 'can we do 5 instead of 3?').path).toBe('delta');
  });
});

describe('R11 sanity of the NEW slot', () => {
  it('in the past => unclear/sanity', () => {
    const today = { ...EXISTING, startLocal: '2026-09-21T15:00:00', endLocal: '2026-09-21T16:00:00' };
    expect(run({ time24h: '08:00' }, '', {}, today)).toEqual({ path: 'unclear', why: 'sanity' });
  });
  it('more than 12 months ahead => unclear/sanity', () => {
    expect(run({ dateKind: 'absolute', isoDate: '2027-10-01' })).toEqual({ path: 'unclear', why: 'sanity' });
  });
  it('a duration beyond 12 h or below 5 min => unclear/sanity', () => {
    expect(run({ time24h: '17:00', durationMin: 800 })).toEqual({ path: 'unclear', why: 'sanity' });
    expect(run({ time24h: '17:00', durationMin: 3 })).toEqual({ path: 'unclear', why: 'sanity' });
  });
  it('a wall time that does not exist in the zone (DST gap) => unclear/sanity', () => {
    expect(run({ dateKind: 'absolute', isoDate: '2027-03-26', time24h: '02:30' })).toEqual({
      path: 'unclear',
      why: 'sanity',
    });
  });
});

describe('R12 / R13', () => {
  it('R12: `to` deep-equals `from` => no_change', () => {
    expect(run({ time24h: '15:00' })).toEqual({ path: 'no_change' });
    expect(run({ dateKind: 'weekday', weekday: 3 }, 'Wednesday then')).toEqual({ path: 'no_change' });
  });
  it('R13 (F32): the same `to` as a REJECTED change of this event revision => suppressed', () => {
    const to = { ...FROM, startLocal: '2026-09-23T17:00:00', endLocal: '2026-09-23T18:00:00' };
    expect(run({ time24h: '17:00' }, '', { rejectedTos: [to] })).toEqual({ path: 'suppressed' });
    // a genuinely new slot proposes again
    expect(run({ time24h: '18:00' }, '', { rejectedTos: [to] }).path).toBe('delta');
    // a cancel is suppressed the same way
    expect(
      run({ intent: 'cancel', change: 'cancel' }, '', { rejectedTos: [{ ...FROM, status: 'cancelled' }] }),
    ).toEqual({
      path: 'suppressed',
    });
  });
});

describe('namedWeekdays', () => {
  it.each([
    ['see you Sunday', [0]],
    ['MONDAY or tuesday', [1, 2]],
    ['ביום ראשון', [0]],
    ['ראשון', []], // "first" is an ordinary word without יום
    ['יום שני', [1]],
    ['שני אנשים', []], // "two people"
    ['ברביעי', [3]],
    ['וחמישי', [4]],
    ['בשבת', [6]],
    ['שבתאי', []], // not a weekday word
    ['the 3rd', []],
  ])('%s', (text, want) => {
    expect([...namedWeekdays(text)].sort()).toEqual(want);
  });
});

describe('the frozen C2 15 view (resolveDelta / toResolution)', () => {
  it('maps every outcome', () => {
    expect(toResolution({ path: 'v1' })).toEqual({ kind: 'none' });
    expect(toResolution({ path: 'no_change' })).toEqual({ kind: 'none' });
    expect(toResolution({ path: 'unclear', why: 'sanity' })).toEqual({ kind: 'unclear', badge: 'change_unclear' });
    expect(toResolution({ path: 'incomplete', missing: ['time'] })).toEqual({ kind: 'incomplete', missing: ['time'] });
    expect(toResolution({ path: 'suppressed' })).toEqual({ kind: 'suppressed' });
    const d = delta(run({ time24h: '17:00' }));
    expect(toResolution({ path: 'delta', delta: d })).toEqual({ kind: 'delta', delta: d });
  });
  it('resolveDelta = toResolution(resolveDeltaOutcome(...)) without the app options', () => {
    expect(resolveDelta(x({ time24h: '17:00' }), EXISTING, CTX, '')).toEqual(toResolution(run({ time24h: '17:00' })));
    expect(resolveDelta(x({}), null, CTX, '')).toEqual({ kind: 'none' });
  });
  it('is pure: the same inputs give the same output and the inputs are not mutated', () => {
    const input = x({ time24h: '17:00', missing: ['duration'] });
    const frozen = JSON.stringify(input);
    const existing = JSON.stringify(EXISTING);
    expect(resolveDeltaOutcome(input, EXISTING, CTX, '')).toEqual(resolveDeltaOutcome(input, EXISTING, CTX, ''));
    expect(JSON.stringify(input)).toBe(frozen);
    expect(JSON.stringify(EXISTING)).toBe(existing);
  });
});
