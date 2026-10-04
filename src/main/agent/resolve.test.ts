// TESTS 5.3 row `shared/when.ts`, `agent/resolve.ts` - the S2 sub-state half.
// Acceptance (build-plan section 7, W1-08): every golden row's `expect.resolved` of PIPELINE section 11 reproduced by a table test.
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/resolve/pipeline11.json';
import {
  closureFor,
  imageBranchApplies,
  needsCalendarChangeBadge,
  resolveExtraction,
  resolveExtractionWithImage,
  resolveImageDate,
  type SlotState,
} from './resolve';
import { localToEpochMs, type WhenContext } from '../../shared/when';
import { ExtractionSchema, ProposedEventSchema, type Extraction, type ImageRead } from '../../shared/schemas';
import { LIMITS, type Assumption, type ClosedReason, type MissingField } from '../../shared/types';

const TZ = fixture.timeZone;
const ANCHOR = localToEpochMs(fixture.anchorLocal, TZ);

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
  // [V2] C2 5: the four B20 fields S1 v2 always returns (null-event defaults of the S1 v2 few-shots)
  refersToExisting: false,
  change: 'no_change',
  changeConfidence: 'high',
  confidence: 'high',
};
const ex = (patch: Partial<Extraction>): Extraction => ExtractionSchema.parse({ ...BASE, ...patch });
const ctx = (patch: Partial<WhenContext> = {}): WhenContext => ({
  nowMs: ANCHOR,
  timeZone: TZ,
  defaultDurationMin: 60,
  ambiguousHour: 'assume',
  ...patch,
});

interface GoldenExpect {
  state: SlotState;
  startLocal?: string;
  endLocal?: string;
  dateHint?: string;
  title?: string;
  location?: string;
  missing?: MissingField[];
  assumptions?: Assumption[];
  changeInGoogle?: boolean;
  closedReason?: ClosedReason | null;
}
interface GoldenRow {
  id: string;
  extraction: Partial<Extraction>;
  expect: GoldenExpect;
  note?: string;
}

const rows = fixture.rows as unknown as GoldenRow[];

describe('PIPELINE section 11 - expect.resolved for every golden row', () => {
  it('covers all 32 rows with unique ids', () => {
    expect(rows).toHaveLength(32);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it.each(rows.map((r) => [r.id, r] as const))('%s', (_id, row) => {
    const x = ex(row.extraction);
    const slot = resolveExtraction(x, ctx());
    const e = row.expect;

    expect(slot.state).toBe(e.state);
    if (e.startLocal !== undefined) {
      expect(slot.when.startLocal).toBe(e.startLocal);
      expect(slot.event?.startLocal).toBe(e.startLocal);
    }
    if (e.endLocal !== undefined) {
      expect(slot.when.endLocal).toBe(e.endLocal);
      expect(slot.event?.endLocal).toBe(e.endLocal);
    }
    if (e.dateHint !== undefined) expect(slot.event?.dateHint).toBe(e.dateHint);
    if (e.title !== undefined) expect(slot.event?.title).toBe(e.title);
    if (e.location !== undefined) expect(slot.event?.location).toBe(e.location);
    if (e.missing !== undefined) expect(slot.missing).toEqual(expect.arrayContaining(e.missing));
    if (e.assumptions !== undefined) expect([...slot.assumptions].sort()).toEqual([...e.assumptions].sort());
    if (e.changeInGoogle !== undefined) expect(needsCalendarChangeBadge(x)).toBe(e.changeInGoogle);
    if (e.closedReason !== undefined) expect(closureFor(x, slot)).toBe(e.closedReason);

    // Invariants that must hold for every row.
    if (slot.state === 'none') expect(slot.event).toBeNull();
    else expect(ProposedEventSchema.parse(slot.event)).toBeTruthy();
    if (slot.state !== 'complete') {
      expect(slot.event?.startLocal ?? '').toBe('');
      expect(slot.event?.endLocal ?? '').toBe('');
    }
  });

  it('never proposes an event for reschedule or cancel', () => {
    for (const row of rows) {
      const x = ex(row.extraction);
      if (x.intent === 'reschedule' || x.intent === 'cancel') {
        expect(resolveExtraction(x, ctx()).state).not.toBe('complete');
      }
    }
  });
});

describe('resolveExtraction - sub-states (ARCHITECTURE 6.3)', () => {
  const scheduling = { intent: 'schedule_request', needsReply: true, dateKind: 'weekday', weekday: 4 } as const;

  it('a complete slot on a scheduling intent is complete', () => {
    const slot = resolveExtraction(ex({ ...scheduling, time24h: '14:00' }), ctx());
    expect(slot.state).toBe('complete');
    expect(slot.event).toMatchObject({
      startLocal: '2026-09-24T14:00:00',
      endLocal: '2026-09-24T15:00:00',
      dateHint: '',
    });
  });
  it('a missing time downgrades to incomplete and keeps the date as a hint', () => {
    const slot = resolveExtraction(ex(scheduling), ctx());
    expect(slot.state).toBe('incomplete');
    expect(slot.event).toMatchObject({ startLocal: '', endLocal: '', dateHint: '2026-09-24' });
  });
  it('a confirmation can complete a slot as well', () => {
    expect(
      resolveExtraction(ex({ ...scheduling, intent: 'confirmation', needsReply: false, time24h: '14:00' }), ctx())
        .state,
    ).toBe('complete');
  });
  it.each(['question', 'smalltalk', 'other'] as const)('%s never proposes an event', (intent) => {
    const slot = resolveExtraction(ex({ ...scheduling, intent, time24h: '14:00' }), ctx());
    expect(slot.state).toBe('none');
    expect(slot.event).toBeNull();
  });
  it('a sanity problem blocks completion even when start and end exist', () => {
    const slot = resolveExtraction(ex({ ...scheduling, time24h: '14:00', durationMin: 1 }), ctx()); // 1 min => bad_duration
    expect(slot.when.startLocal).not.toBe('');
    expect(slot.when.problems).toContain('bad_duration');
    expect(slot.state).toBe('incomplete');
    expect(slot.event?.startLocal).toBe('');
  });
  it('missing duration / location alone never blocks a proposal (PIPELINE 5.4)', () => {
    const slot = resolveExtraction(
      ex({ ...scheduling, time24h: '14:00', missing: ['duration', 'location', 'who'] }),
      ctx(),
    );
    expect(slot.state).toBe('complete');
    expect(slot.missing).toEqual(['duration', 'location', 'who']);
  });
  it('the ask mode pushes an ambiguous hour to incomplete', () => {
    const x = ex({ ...scheduling, time24h: '05:00', timeAmbiguous: true });
    expect(resolveExtraction(x, ctx()).state).toBe('complete');
    expect(resolveExtraction(x, ctx({ ambiguousHour: 'ask' })).state).toBe('incomplete');
    expect(resolveExtraction(x, ctx({ ambiguousHour: 'ask' })).missing).toContain('time');
  });
  it('a wall time inside a DST spring-forward gap goes to info_missing, never to a proposal', () => {
    // Asia/Jerusalem 2026-03-27: 02:00 IST jumps to 03:00 IDT, so 02:00-02:30 is not a real half hour. Proposing it
    // would produce a create_event that eventSanity rejects on every approval attempt.
    const beforeSpring = ctx({ nowMs: localToEpochMs('2026-03-20T10:00:00', TZ) });
    const slot = resolveExtraction(
      ex({
        intent: 'schedule_request',
        needsReply: true,
        dateKind: 'absolute',
        isoDate: '2026-03-27',
        time24h: '02:00',
        durationMin: 30,
      }),
      beforeSpring,
    );
    expect(slot.state).toBe('incomplete');
    expect(slot.missing).toContain('time');
    expect(slot.event).toMatchObject({ startLocal: '', endLocal: '', dateHint: '2026-03-27' });
  });
});

describe('resolveExtraction - reschedule and cancel (PIPELINE 5.6)', () => {
  it('a reschedule that names a new day stays incomplete, never proposed', () => {
    const slot = resolveExtraction(
      ex({ intent: 'reschedule', dateKind: 'weekday', weekday: 5, time24h: '18:00' }),
      ctx(),
    );
    expect(slot.state).toBe('incomplete');
    expect(slot.event).toMatchObject({ startLocal: '', endLocal: '', dateHint: '2026-09-25' });
    expect(needsCalendarChangeBadge(ex({ intent: 'reschedule' }))).toBe(true);
  });
  it('a reschedule with no date at all resolves to nothing', () => {
    expect(resolveExtraction(ex({ intent: 'reschedule', time24h: '18:00', timeAmbiguous: true }), ctx()).state).toBe(
      'none',
    );
  });
  it('a cancel is always none, even with a full slot', () => {
    const slot = resolveExtraction(
      ex({ intent: 'cancel', dateKind: 'relative_days', daysFromToday: 1, time24h: '18:00' }),
      ctx(),
    );
    expect(slot.state).toBe('none');
    expect(slot.event).toBeNull();
    expect(needsCalendarChangeBadge(ex({ intent: 'cancel' }))).toBe(true);
  });
  it('every other intent leaves the calendar badge off', () => {
    for (const intent of ['schedule_request', 'confirmation', 'question', 'smalltalk', 'other'] as const) {
      expect(needsCalendarChangeBadge(ex({ intent }))).toBe(false);
    }
  });
});

describe('closureFor (PIPELINE 5.6)', () => {
  const none = (patch: Partial<Extraction>) => {
    const x = ex(patch);
    return { x, slot: resolveExtraction(x, ctx()) };
  };
  it('closes an item that wants no reply and has nothing to schedule', () => {
    const { x, slot } = none({ intent: 'smalltalk', needsReply: false });
    expect(closureFor(x, slot)).toBe('not_needed');
  });
  it('keeps an item open when a reply is wanted', () => {
    const { x, slot } = none({ intent: 'other', needsReply: true });
    expect(closureFor(x, slot)).toBeNull();
  });
  it('keeps an item open when there is something to schedule', () => {
    const { x, slot } = none({ intent: 'schedule_request', needsReply: false, dateKind: 'weekday', weekday: 4 });
    expect(slot.state).toBe('incomplete');
    expect(closureFor(x, slot)).toBeNull();
  });
  it('never closes a cancel that carries the calendar badge', () => {
    const { x, slot } = none({ intent: 'cancel', needsReply: false });
    expect(slot.state).toBe('none');
    expect(closureFor(x, slot)).toBeNull();
  });
});

describe('resolveExtraction - untrusted title and location', () => {
  it('flattens newlines and caps the length so ProposedEventSchema always accepts the result', () => {
    const slot = resolveExtraction(
      ex({
        intent: 'schedule_request',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '14:00',
        title: `  coffee\nwith a${String.fromCharCode(0x2028)}break  `,
        location: 'Cafe\r\nLandwer',
      }),
      ctx(),
    );
    expect(slot.event?.title).toBe('coffee with a break');
    expect(slot.event?.location).toBe('Cafe Landwer');
    expect(() => ProposedEventSchema.parse(slot.event)).not.toThrow();
  });
  it('truncates to the contract caps', () => {
    const slot = resolveExtraction(
      ex({
        intent: 'schedule_request',
        dateKind: 'weekday',
        weekday: 4,
        time24h: '14:00',
        title: 'a'.repeat(LIMITS.titleChars),
        location: 'b'.repeat(LIMITS.locationChars),
      }),
      ctx(),
    );
    expect(slot.event?.title).toHaveLength(LIMITS.titleChars);
    expect(slot.event?.location).toHaveLength(LIMITS.locationChars);
    expect(() => ProposedEventSchema.parse(slot.event)).not.toThrow();
  });
  it('takes the time zone from the context, never from the model', () => {
    const slot = resolveExtraction(
      ex({ intent: 'schedule_request', dateKind: 'weekday', weekday: 4, time24h: '14:00' }),
      ctx({ timeZone: 'Europe/Berlin' }),
    );
    expect(slot.event?.timeZone).toBe('Europe/Berlin');
    expect(slot.when.timeZone).toBe('Europe/Berlin');
  });
  it('exposes the same missing / assumptions arrays as the ResolvedWhen it wraps', () => {
    const slot = resolveExtraction(
      ex({
        intent: 'schedule_request',
        dateKind: 'relative_days',
        daysFromToday: 1,
        time24h: '05:00',
        timeAmbiguous: true,
      }),
      ctx(),
    );
    expect(slot.missing).toBe(slot.when.missing);
    expect(slot.assumptions).toBe(slot.when.assumptions);
    expect(slot.event?.assumptions).toBe(slot.when.assumptions);
    expect(slot.assumptions).toContain('hour_assumed_pm');
  });
});

// =====================================================================================================================
// [V2, V2-W1-08-vision] P2 7.4 / B19 - the `image_absolute` branch (T2 5 row: digits -> ISO date in the run zone incl. the
// DST day 2026-10-25, year=0 next occurrence, S1's date wins, disagreement => conflict, weekday word vs digits => image_unclear)
// =====================================================================================================================
describe('resolveImageDate (pure digits -> ISO date)', () => {
  const d = (day: number, month: number, year = 0, weekday = 7) => ({ day, month, year, weekday });

  it('year 0 = the next occurrence on or after today (today counts)', () => {
    expect(resolveImageDate(d(6, 10), '2026-09-21')).toEqual({
      date: '2026-10-06',
      weekdayMismatch: false,
      invalid: false,
    });
    expect(resolveImageDate(d(21, 9), '2026-09-21').date).toBe('2026-09-21');
    expect(resolveImageDate(d(20, 9), '2026-09-21').date).toBe('2027-09-20');
    expect(resolveImageDate(d(29, 2), '2026-09-21').date).toBe('2028-02-29'); // leap day rolls to the next real one
  });

  it('a written year is taken literally (a past one is left to the sanity rules)', () => {
    expect(resolveImageDate(d(24, 9, 2026), '2026-09-21').date).toBe('2026-09-24');
    expect(resolveImageDate(d(24, 9, 2025), '2026-09-21').date).toBe('2025-09-24');
  });

  it('an impossible calendar date is invalid (no date)', () => {
    for (const bad of [d(31, 2), d(31, 2, 2026), d(31, 4, 2026), d(0, 5, 2026), d(5, 13, 2026), d(32, 1)]) {
      expect(resolveImageDate(bad, '2026-09-21')).toEqual({ date: '', weekdayMismatch: false, invalid: true });
    }
  });

  it('a weekday word that is not the weekday of the digits is a mismatch; 7 = not written; the date is kept', () => {
    expect(resolveImageDate(d(6, 10, 0, 2), '2026-09-21')).toEqual({
      date: '2026-10-06',
      weekdayMismatch: false,
      invalid: false,
    });
    expect(resolveImageDate(d(6, 10, 0, 4), '2026-09-21')).toEqual({
      date: '2026-10-06',
      weekdayMismatch: true,
      invalid: false,
    });
    expect(resolveImageDate(d(25, 10, 2026, 0), '2026-09-21').weekdayMismatch).toBe(false); // Sunday = 0
  });

  it('imageBranchApplies needs a readable picture with a written day AND month', () => {
    const r = (p: Partial<ImageRead>): ImageRead => ({ ...READ, ...p });
    expect(imageBranchApplies(null)).toBe(false);
    expect(imageBranchApplies(r({}))).toBe(true);
    expect(imageBranchApplies(r({ readable: false }))).toBe(false);
    expect(imageBranchApplies(r({ day: 0 }))).toBe(false);
    expect(imageBranchApplies(r({ month: 0 }))).toBe(false);
  });
});

const READ: ImageRead = {
  readable: true,
  kind: 'flyer',
  readText: 'Book club\nTuesday Oct 6\n7 pm',
  language: 'en',
  title: 'Book club',
  dateText: 'Tuesday Oct 6',
  day: 6,
  month: 10,
  year: 0,
  weekday: 2,
  timeText: '7 pm',
  hour: 19,
  minute: 0,
  timeAmbiguous: false,
  endHour: 24,
  endMinute: 0,
  location: '',
  confidence: 'high',
  suspicious: false,
};

describe('resolveExtractionWithImage (P2 7.4)', () => {
  const S1_EMPTY = ex({ intent: 'schedule_request', title: 'Book club', missing: ['date', 'time'] });
  const img = (p: Partial<ImageRead>): ImageRead => ({ ...READ, ...p });

  it('no read / no usable date => exactly the v1 resolveExtraction, imageMerge null', () => {
    const x = ex({ dateKind: 'relative_days', daysFromToday: 1, time24h: '10:00' });
    for (const read of [null, img({ readable: false }), img({ day: 0 }), img({ month: 0 })]) {
      const out = resolveExtractionWithImage(x, read, ctx());
      expect(out.imageMerge).toBeNull();
      const { imageMerge: _drop, ...rest } = out;
      expect(rest).toEqual(resolveExtraction(x, ctx()));
    }
  });

  it('S1 said nothing: the digits give date and time => a complete slot, from the picture', () => {
    const out = resolveExtractionWithImage(S1_EMPTY, READ, ctx());
    expect(out.state).toBe('complete');
    expect(out.event).toMatchObject({
      startLocal: '2026-10-06T19:00:00',
      endLocal: '2026-10-06T20:00:00',
      title: 'Book club',
    });
    expect(out.missing).toEqual([]);
    expect(out.imageMerge).toEqual({ used: true, conflict: false, unclear: false });
  });

  it('a written range sets the duration; an end before the start falls back to the default duration', () => {
    const ranged = resolveExtractionWithImage(S1_EMPTY, img({ endHour: 23, endMinute: 30 }), ctx());
    expect(ranged.event).toMatchObject({ startLocal: '2026-10-06T19:00:00', endLocal: '2026-10-06T23:30:00' });
    expect(ranged.assumptions).not.toContain('default_duration');
    const wrapped = resolveExtractionWithImage(S1_EMPTY, img({ endHour: 1, endMinute: 0 }), ctx());
    expect(wrapped.event).toMatchObject({ endLocal: '2026-10-06T20:00:00' });
    expect(wrapped.assumptions).toContain('default_duration');
    // S1's own duration is kept
    const s1Dur = resolveExtractionWithImage(ex({ ...S1_EMPTY, durationMin: 90 }), img({ endHour: 23 }), ctx());
    expect(s1Dur.event).toMatchObject({ endLocal: '2026-10-06T20:30:00' });
  });

  it('a bare ambiguous hour keeps timeAmbiguous => the v1 PM rule and time_assumed', () => {
    const out = resolveExtractionWithImage(S1_EMPTY, img({ hour: 7, timeAmbiguous: true }), ctx());
    expect(out.event).toMatchObject({ startLocal: '2026-10-06T19:00:00' });
    expect(out.assumptions).toContain('hour_assumed_pm');
  });

  it('no clock time written => date only (incomplete, the date is the hint)', () => {
    const out = resolveExtractionWithImage(S1_EMPTY, img({ hour: 24 }), ctx());
    expect(out.state).toBe('incomplete');
    expect(out.missing).toContain('time');
    expect(out.event).toMatchObject({ dateHint: '2026-10-06' });
  });

  it("S1's own date inside the 14-day table wins; a different picture date => conflict", () => {
    const s1 = ex({ ...S1_EMPTY, dateKind: 'absolute', isoDate: '2026-09-24', missing: ['time'] });
    const same = resolveExtractionWithImage(s1, img({ day: 24, month: 9, weekday: 4 }), ctx());
    expect(same.event).toMatchObject({ startLocal: '2026-09-24T19:00:00' });
    expect(same.imageMerge).toEqual({ used: true, conflict: false, unclear: false });
    const other = resolveExtractionWithImage(s1, READ, ctx());
    expect(other.event).toMatchObject({ startLocal: '2026-09-24T19:00:00' }); // S1 kept
    expect(other.imageMerge).toEqual({ used: true, conflict: true, unclear: false });
    const s1Weekday = ex({ ...S1_EMPTY, dateKind: 'weekday', weekday: 4, missing: ['time'] }); // Thursday = 2026-09-24
    expect(resolveExtractionWithImage(s1Weekday, READ, ctx()).imageMerge?.conflict).toBe(true);
    // an invalid picture date against S1's date is unclear, not a conflict
    expect(resolveExtractionWithImage(s1, img({ day: 31, month: 2 }), ctx()).imageMerge).toEqual({
      used: true,
      conflict: false,
      unclear: true,
    });
  });

  it("S1's date outside the table (or in the past) loses to the picture's digits, and the disagreement is a conflict", () => {
    const far = ex({ ...S1_EMPTY, dateKind: 'absolute', isoDate: '2026-11-20', missing: ['time'] });
    const out = resolveExtractionWithImage(far, READ, ctx());
    expect(out.event).toMatchObject({ startLocal: '2026-10-06T19:00:00' });
    expect(out.imageMerge?.conflict).toBe(true);
    const past = ex({ ...S1_EMPTY, dateKind: 'absolute', isoDate: '2026-09-01', missing: ['time'] });
    expect(resolveExtractionWithImage(past, READ, ctx()).imageMerge?.conflict).toBe(true);
    const farSame = ex({ ...S1_EMPTY, dateKind: 'absolute', isoDate: '2026-10-06', missing: ['time'] });
    expect(resolveExtractionWithImage(farSame, READ, ctx()).imageMerge?.conflict).toBe(false);
  });

  it("S1's time wins; a different picture clock time => conflict (except the PM half of an ambiguous bare hour)", () => {
    const s1 = ex({ ...S1_EMPTY, time24h: '19:00', missing: ['date'] });
    expect(resolveExtractionWithImage(s1, READ, ctx()).imageMerge?.conflict).toBe(false);
    const diff = resolveExtractionWithImage(s1, img({ hour: 18 }), ctx());
    expect(diff.event).toMatchObject({ startLocal: '2026-10-06T19:00:00' });
    expect(diff.imageMerge?.conflict).toBe(true);
    expect(resolveExtractionWithImage(s1, img({ hour: 7, timeAmbiguous: true }), ctx()).imageMerge?.conflict).toBe(
      false,
    );
    expect(resolveExtractionWithImage(s1, img({ hour: 7, timeAmbiguous: false }), ctx()).imageMerge?.conflict).toBe(
      true,
    );
    expect(resolveExtractionWithImage(s1, img({ hour: 24 }), ctx()).imageMerge?.conflict).toBe(false); // no picture time
    expect(
      resolveExtractionWithImage(ex({ ...s1, time24h: '19:30' }), img({ hour: 7, timeAmbiguous: true }), ctx())
        .imageMerge?.conflict,
    ).toBe(true);
  });

  it('a weekday word that contradicts the digits => unclear; the digits are kept', () => {
    const out = resolveExtractionWithImage(S1_EMPTY, img({ weekday: 4 }), ctx());
    expect(out.event).toMatchObject({ startLocal: '2026-10-06T19:00:00' });
    expect(out.imageMerge).toEqual({ used: true, conflict: false, unclear: true });
  });

  it('an impossible date => no date, missing date, unclear', () => {
    const out = resolveExtractionWithImage(S1_EMPTY, img({ day: 31, month: 2 }), ctx());
    expect(out.missing).toContain('date');
    expect(out.state).toBe('incomplete');
    expect(out.imageMerge).toEqual({ used: true, conflict: false, unclear: true });
  });

  it('a written year in the past => the v1 sanity rule (in_past => missing date), never a proposal', () => {
    const out = resolveExtractionWithImage(S1_EMPTY, img({ year: 2025 }), ctx());
    expect(out.state).toBe('incomplete');
    expect(out.missing).toContain('date');
  });

  it("title and location stay S1's (the picture contributes only date and time)", () => {
    const x = ex({ ...S1_EMPTY, title: 'S1 title', location: 'S1 place' });
    const out = resolveExtractionWithImage(x, img({ title: 'picture title', location: 'picture place' }), ctx());
    expect(out.event).toMatchObject({ title: 'S1 title', location: 'S1 place' });
  });

  it('DST end day 2026-10-25 in Asia/Jerusalem: "25.10" read at 01:30 local that morning is TODAY; 19:00 is IST (+02:00)', () => {
    const nowMs = Date.parse('2026-10-24T22:30:00Z'); // = 2026-10-25 01:30 IDT, before the 02:00 -> 01:00 fall-back
    const out = resolveExtractionWithImage(S1_EMPTY, img({ day: 25, month: 10, weekday: 0 }), ctx({ nowMs }));
    expect(out.event).toMatchObject({ startLocal: '2026-10-25T19:00:00', endLocal: '2026-10-25T20:00:00' });
    expect(out.imageMerge).toEqual({ used: true, conflict: false, unclear: false });
    expect(localToEpochMs('2026-10-25T19:00:00', 'Asia/Jerusalem')).toBe(Date.parse('2026-10-25T17:00:00Z'));
    // the same digits one UTC day earlier are still the 25th (not "tomorrow" in UTC terms)
    const utcEve = resolveExtractionWithImage(
      S1_EMPTY,
      img({ day: 25, month: 10, weekday: 0 }),
      ctx({ nowMs: Date.parse('2026-10-24T20:00:00Z') }),
    );
    expect(utcEve.event).toMatchObject({ startLocal: '2026-10-25T19:00:00' });
  });
});
