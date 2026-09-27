// TESTS 5.3 row `shared/when.ts`, `agent/resolve.ts` - the S2 sub-state half.
// Acceptance (build-plan section 7, W1-08): every golden row's `expect.resolved` of PIPELINE section 11 reproduced by a table test.
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/resolve/pipeline11.json';
import { closureFor, needsCalendarChangeBadge, resolveExtraction, type SlotState } from './resolve';
import { localToEpochMs, type WhenContext } from '../../shared/when';
import { ExtractionSchema, ProposedEventSchema, type Extraction } from '../../shared/schemas';
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
