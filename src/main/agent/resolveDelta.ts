// src/main/agent/resolveDelta.ts   ADD (B20) - pure S2 branch; the model never does date arithmetic (A8).
// Owner V2-W1-03-edit-pipeline. Rules R1-R13 of docs/specs/v2-pipeline.md 7.2, applied in order (first match decides). Everything that
// identifies the event (targetEventId, sourceItemId, baseRevision, `from`) is pinned from the app rows of ExistingEventCtx (I3'); the model
// contributes only the four enum/boolean fields and the date/time/location fields of the v1 schema. A delta never takes the model's title.
import type { Extraction, EventDelta, EventContentWithStatus } from '../../shared/schemas';
import type { ExistingEventCtx } from './existingEvent';
import { addMinutes, localToEpochMs, epochMsToLocal, resolveWhen, type WhenContext } from '../../shared/when';
import {
  LIMITS,
  MISSING_FIELDS,
  type Assumption,
  type Badge,
  type IsoDate,
  type MissingField,
} from '../../shared/types';
import { sanitizeForModel } from './sanitize';

export type DeltaResolution =
  | { kind: 'none' } // existing_event null, or change no_change / new_event => the v1 path
  | { kind: 'unclear'; badge: Extract<Badge, 'change_unclear'> } // changeConfidence low, cancel+no_change, weekday mismatch => no delta, the draft asks
  | { kind: 'suppressed' } // [F32] `to` deep-equals a REJECTED update_event of the same event + baseRevision => no action, no badge
  | { kind: 'incomplete'; missing: MissingField[] } // reschedule with neither a day nor a time => missing += 'time'
  | { kind: 'delta'; delta: EventDelta };

/** [V2-W1-03 ADD, P2 7.2] The full outcome. `DeltaResolution` (frozen, C2 15) folds `v1` and `no_change` into `none`; S4 needs the
 *  difference (R5: a `no_change` about the existing event suppresses the v1 slot proposal), so the orchestrator uses this one. */
export type DeltaOutcome =
  | { path: 'v1' } // new_event / not about the event: run resolveWhen() exactly as v1 (a second event)
  | { path: 'no_change' } // about the event, nothing to change: NO event proposal at all
  | { path: 'unclear'; why: 'low_confidence' | 'incoherent' | 'weekday_mismatch' | 'sanity' | 'cancel_word_no_change' }
  | { path: 'incomplete'; missing: MissingField[] } // a reschedule without a usable new date or time
  | { path: 'suppressed' } // [F32] R13
  | { path: 'delta'; delta: EventDelta };

/** Optional inputs that are app facts, never model output. */
export interface DeltaOptions {
  /** [F32] `repos.actions.rejectedDeltaTo(existing.eventId, existing.revision)` - the `to` payloads the user already turned down. */
  rejectedTos?: readonly EventContentWithStatus[];
  /** P2 7.4 "merged when": the picture's date/time (image_absolute branch, agent/resolve.ts) - used only when S1 named no date / time. */
  image?: { date: IsoDate | null; time24h: string; timeAmbiguous: boolean } | null;
}

const DELTA_CHANGES: ReadonlySet<Extraction['change']> = new Set(['reschedule', 'move', 'cancel']);

// LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR - built from code points (the last two are line terminators in source).
const NEWLINES_RE = new RegExp(`[${String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029)}]+`, 'g');
function singleLine(value: string, cap: number): string {
  return value.replace(NEWLINES_RE, ' ').trim().slice(0, cap);
}

// ---------------------------------------------------------------------------------------------------------------------
// R10 weekday words (he + en). Hebrew letters are not `\w`, so word edges are explicit non-Hebrew-letter look-arounds.
// "ראשון" (first) and "שני" (second / two) are ordinary words: they count only after "יום" (ביום / ליום / יום). The other
// four Hebrew weekday words may carry one proclitic (ב / ל / ו / ה / מ): "ברביעי", "לחמישי", "של שלישי".
// ---------------------------------------------------------------------------------------------------------------------
const EN_WEEKDAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bsunday/i, 0],
  [/\bmonday/i, 1],
  [/\btuesday/i, 2],
  [/\bwednesday/i, 3],
  [/\bthursday/i, 4],
  [/\bfriday/i, 5],
  [/\bsaturday/i, 6],
];
const HE_EDGE_L = '(?:^|[^\\u05D0-\\u05EA])';
const HE_EDGE_R = '(?=$|[^\\u05D0-\\u05EA])';
const HE_YOM = '(?:[\\u05D1\\u05DC\\u05D5\\u05DE]?\\u05D9\\u05D5\\u05DD\\s+)'; // [ב|ל|ו|מ]?יום + space
const HE_PREFIX = '[\\u05D1\\u05DC\\u05D5\\u05D4\\u05DE]?'; // ב | ל | ו | ה | מ
const heWeekday = (word: string, needsYom: boolean): RegExp =>
  new RegExp(`${HE_EDGE_L}${needsYom ? HE_YOM : `(?:${HE_YOM}|${HE_PREFIX})`}${word}${HE_EDGE_R}`, 'u');
const HE_WEEKDAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [heWeekday('ראשון', true), 0], // ראשון
  [heWeekday('שני', true), 1], // שני
  [heWeekday('שלישי', false), 2], // שלישי
  [heWeekday('רביעי', false), 3], // רביעי
  [heWeekday('חמישי', false), 4], // חמישי
  [heWeekday('שישי', false), 5], // שישי
  [heWeekday('שבת', false), 6], // שבת
];

/** [fix editing-undo-6] The Friday greeting "שבת שלום" (optionally "ושבת שלום") names no day; it is blanked before the weekday scan.
 *  "בשבת" / "מוצאי שבת" etc. stay weekday words (they can name the day a change lands on). */
const HE_SHABBAT_GREETING_RE = new RegExp(
  `(^|[^\\u05D0-\\u05EA])\\u05D5?\\u05E9\\u05D1\\u05EA\\s+\\u05E9\\u05DC\\u05D5\\u05DD${HE_EDGE_R}`, // [ו]שבת שלום
  'gu',
);
/** Weekday indices (0 = Sunday) named by a he/en weekday word in the text. Exported for the unit table. */
export function namedWeekdays(text: string): Set<number> {
  const clean = sanitizeForModel(text).text.normalize('NFKC').replace(HE_SHABBAT_GREETING_RE, '$1 ');
  const out = new Set<number>();
  for (const [re, day] of [...EN_WEEKDAYS, ...HE_WEEKDAYS]) if (re.test(clean)) out.add(day);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// small pure date helpers (wall clock; the zone is only used for the "does this instant exist / is it in the past" checks)
// ---------------------------------------------------------------------------------------------------------------------
function weekdayOfDate(date: string): number {
  const d = new Date(0);
  d.setUTCFullYear(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return d.getUTCDay();
}
/** Minutes between two LocalDateTime values as wall-clock fields (the same arithmetic as addMinutes). */
function wallMinutes(from: string, to: string): number {
  return Math.round((Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 60_000);
}
function minutesOfDay(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function existsInZone(local: string, timeZone: string): boolean {
  return epochMsToLocal(localToEpochMs(local, timeZone), timeZone) === local;
}
/** Circular distance of two times of day, in minutes (23:00 and 01:00 are 2 h apart). */
function dayDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/** R7: an ambiguous hour inside a change. The model may already have normalised it to 24 h (17:00 for a bare "5"), so the candidates are
 *  derived from the hour modulo 12: `h` and `h + 12`. The one nearest the existing start wins; a tie falls back to the v1 rule
 *  (1-7 PM, 8-11 AM). ASSUMPTIONS has no `hour_assumed_near_existing` value (C2 is the source of truth for the closed set), so the pick is
 *  recorded as `hour_assumed_pm` / `hour_assumed_am` - same amber `time_assumed` badge, same AutoGate `assumed_hour` fallback. */
export function pickAmbiguousHour(
  time24h: string,
  existingStartHHMM: string,
): { time: string; assumption: Assumption } | null {
  const hour = Number(time24h.slice(0, 2));
  const minute = time24h.slice(3, 5);
  const base = hour % 12;
  if (base === 0) return null; // 12 / 00 carry no am/pm ambiguity worth resolving here
  const candidates = [base, base + 12];
  const target = minutesOfDay(existingStartHHMM);
  const dist = candidates.map((h) => dayDistance(h * 60 + Number(minute), target));
  let chosen: number;
  if (dist[0] === dist[1])
    chosen = base <= 7 ? base + 12 : base; // tie => the v1 rule
  else chosen = dist[0]! < dist[1]! ? candidates[0]! : candidates[1]!;
  return { time: `${pad2(chosen)}:${minute}`, assumption: chosen >= 12 ? 'hour_assumed_pm' : 'hour_assumed_am' };
}

function sameContent(a: EventContentWithStatus, b: EventContentWithStatus): boolean {
  return (
    a.title === b.title &&
    a.startLocal === b.startLocal &&
    a.endLocal === b.endLocal &&
    a.timeZone === b.timeZone &&
    a.location === b.location &&
    a.status === b.status
  );
}

/** The date the text names (R6): the resolved S1 date when dateKind !== 'none', else the picture's date, else null (= inherit). */
function namedDate(
  x: Extraction,
  ctx: WhenContext,
  image: DeltaOptions['image'],
): { date: string | null; bad: boolean } {
  if (x.dateKind !== 'none') {
    const w = resolveWhen(x, ctx);
    if (w.date === '' || w.problems.includes('incoherent_date') || w.problems.includes('weekday_mismatch')) {
      return { date: null, bad: true };
    }
    return { date: w.date, bad: false };
  }
  if (image?.date) return { date: image.date, bad: false };
  return { date: null, bad: false };
}

type SlotResult =
  | {
      ok: true;
      startLocal: string;
      endLocal: string;
      assumptions: Assumption[];
      dateStated: boolean;
      timeStated: boolean;
    }
  | { ok: false; outcome: DeltaOutcome };

/** R6 + R7 + F40: the new start/end of a reschedule (or of the slot a cancel names). Never throws. */
function newSlot(
  x: Extraction,
  existing: ExistingEventCtx,
  ctx: WhenContext,
  image: DeltaOptions['image'],
): SlotResult {
  const assumptions: Assumption[] = [];
  const nd = namedDate(x, ctx, image);
  if (nd.bad) return { ok: false, outcome: { path: 'unclear', why: 'incoherent' } };
  const existingDate = existing.startLocal.slice(0, 10);
  const existingTime = existing.startLocal.slice(11, 16);

  let time: string | null = null;
  let ambiguous = false;
  if (x.time24h !== '') {
    time = x.time24h;
    ambiguous = x.timeAmbiguous;
  } else if (image && image.time24h !== '') {
    time = image.time24h;
    ambiguous = image.timeAmbiguous;
  }
  if (time !== null && ambiguous) {
    if (ctx.ambiguousHour === 'ask') {
      const missing = new Set<MissingField>(x.missing);
      missing.add('time');
      return { ok: false, outcome: { path: 'incomplete', missing: MISSING_FIELDS.filter((f) => missing.has(f)) } };
    }
    const pick = pickAmbiguousHour(time, existingTime);
    if (pick !== null) {
      time = pick.time;
      assumptions.push(pick.assumption);
    }
  }

  const dateStated = nd.date !== null;
  const timeStated = time !== null;
  const existingDuration = wallMinutes(existing.startLocal, existing.endLocal);
  if (!dateStated && !timeStated) {
    // [F40] a duration-only change ("let's make it two hours") keeps the start and moves the end.
    if (x.durationMin > 0) {
      return {
        ok: true,
        startLocal: existing.startLocal,
        endLocal: addMinutes(existing.startLocal, x.durationMin),
        assumptions,
        dateStated,
        timeStated,
      };
    }
    const missing = new Set<MissingField>(x.missing);
    if (!missing.has('date') && !missing.has('time')) missing.add('time');
    return { ok: false, outcome: { path: 'incomplete', missing: MISSING_FIELDS.filter((f) => missing.has(f)) } };
  }
  const date = nd.date ?? existingDate;
  const startLocal = `${date}T${time ?? existingTime}:00`;
  const duration = x.durationMin > 0 ? x.durationMin : existingDuration;
  return { ok: true, startLocal, endLocal: addMinutes(startLocal, duration), assumptions, dateStated, timeStated };
}

/** R11: new start >= the anchor, <= 12 months ahead, 5 min .. 12 h, a wall time that exists in the zone (DST gap). */
function saneSlot(startLocal: string, endLocal: string, timeZone: string, ctx: WhenContext): boolean {
  if (!existsInZone(startLocal, timeZone) || !existsInZone(endLocal, timeZone)) return false;
  const duration = wallMinutes(startLocal, endLocal);
  if (duration < LIMITS.eventMinMin || duration > LIMITS.eventMaxMin) return false;
  const startMs = localToEpochMs(startLocal, timeZone);
  if (startMs < ctx.nowMs) return false;
  const horizon = new Date(ctx.nowMs);
  horizon.setUTCMonth(horizon.getUTCMonth() + LIMITS.eventHorizonMonths);
  return startMs <= horizon.getTime();
}

/** P2 7.2 R1-R13 (first match decides). Pure: every input is a value; no clock, no repo. */
export function resolveDeltaOutcome(
  x: Extraction,
  existing: ExistingEventCtx | null,
  ctx: WhenContext,
  rawTriggerText: string,
  opts: DeltaOptions = {},
): DeltaOutcome {
  // existing_event === null => the four fields are ignored; S2 is v1.
  if (existing === null || existing.status !== 'confirmed') return { path: 'v1' };
  const isDelta = DELTA_CHANGES.has(x.change);
  if (x.changeConfidence === 'low' && isDelta) return { path: 'unclear', why: 'low_confidence' }; // R1
  if (x.intent === 'cancel' && x.change === 'no_change') return { path: 'unclear', why: 'cancel_word_no_change' }; // R2
  if (x.change === 'new_event' || (!x.refersToExisting && x.change === 'no_change')) return { path: 'v1' }; // R3
  if (!x.refersToExisting && isDelta) return { path: 'unclear', why: 'incoherent' }; // R4
  if (x.change === 'no_change') return { path: 'no_change' }; // R5

  const from: EventContentWithStatus = {
    title: existing.title,
    startLocal: existing.startLocal,
    endLocal: existing.endLocal,
    timeZone: existing.timeZone,
    location: existing.location,
    status: 'confirmed',
  };
  const wctx: WhenContext = { ...ctx, timeZone: existing.timeZone };
  let kind: EventDelta['kind'] = x.change as EventDelta['kind'];
  let to: EventContentWithStatus;
  let assumptions: Assumption[] = [];

  if (kind === 'move') {
    // R9: only the location changes; no usable new place => no_change (R5 semantics).
    const location = singleLine(x.location, LIMITS.locationChars);
    if (location === '' || location === from.location) return { path: 'no_change' };
    to = { ...from, location };
  } else {
    let slot: SlotResult | null = null;
    if (kind === 'cancel') {
      // R8: a cancel that names a DIFFERENT slot is a reschedule ("the model said cancel, the text says move"); a slot equal to the
      // event's own start (or none) only names the event being called off ("can't make it tomorrow").
      // [fix editing-undo-7] the bare weekday of the event itself ("cancel Wednesday", weekOffset 0) names the event wherever it is:
      // resolveWhen's "the coming one, today counts" would land on THIS week's day and turn a cancel of an event a week or more ahead
      // into a reschedule. Its date is the event's own date; only a different time can still make it a new slot.
      const namesEventDay =
        x.dateKind === 'weekday' && x.weekOffset === 0 && x.weekday === weekdayOfDate(from.startLocal.slice(0, 10));
      const xr: Extraction = namesEventDay ? { ...x, dateKind: 'none' } : x;
      const named = xr.dateKind !== 'none' || xr.time24h !== '' ? newSlot(xr, existing, wctx, opts.image) : null;
      if (named !== null && named.ok && named.startLocal !== from.startLocal) {
        kind = 'reschedule';
        slot = named;
      }
    } else {
      slot = newSlot(x, existing, wctx, opts.image); // R6 / R7 / F40
      if (!slot.ok) return slot.outcome;
    }
    if (kind === 'cancel') {
      to = { ...from, status: 'cancelled' };
    } else {
      const s = slot as Extract<SlotResult, { ok: true }>;
      const location = singleLine(x.location, LIMITS.locationChars);
      to = {
        title: from.title, // a delta never takes the model's title (title changes are out of scope in v2.0, F40)
        startLocal: s.startLocal,
        endLocal: s.endLocal,
        timeZone: from.timeZone,
        location: location === '' ? from.location : location,
        status: 'confirmed',
      };
      assumptions = s.assumptions;
    }
  }

  // R10: a weekday word that contradicts the day the change lands on (reschedule) or the event's own day (cancel).
  // [fix editing-undo-6] in a reschedule the event's CURRENT day ("move Wednesday's meeting to tomorrow") identifies the event and
  // contradicts nothing: only the other named days are checked against the new day.
  if (kind === 'reschedule' || kind === 'cancel') {
    const named = namedWeekdays(rawTriggerText);
    const target = weekdayOfDate((kind === 'cancel' ? from : to).startLocal.slice(0, 10));
    if (kind === 'reschedule') named.delete(weekdayOfDate(from.startLocal.slice(0, 10)));
    if (named.size > 0 && !named.has(target)) return { path: 'unclear', why: 'weekday_mismatch' };
  }
  // R11: sanity of the NEW slot (a cancel / move keeps the event's own slot, which may already have started within the grace window).
  if (kind === 'reschedule' && !saneSlot(to.startLocal, to.endLocal, to.timeZone, wctx)) {
    return { path: 'unclear', why: 'sanity' };
  }
  if (sameContent(to, from)) return { path: 'no_change' }; // R12
  if ((opts.rejectedTos ?? []).some((r) => sameContent(r, to))) return { path: 'suppressed' }; // R13 (F32)

  return {
    path: 'delta',
    delta: {
      kind,
      targetEventId: existing.eventId,
      sourceItemId: existing.sourceItemId,
      baseRevision: existing.revision,
      from,
      to,
      confidence: x.changeConfidence,
      assumptions,
      problems: [],
    },
  };
}

/** Rules of ARCH-v2 B20 / v2-event-editing 2.5: reschedule inherits the date (only a time said) or the time (only a day said); ambiguous hour
 *  picks the candidate nearest the existing start (still amber time_assumed); move changes only location; cancel = same content + status
 *  cancelled; cancel with a named new slot => reschedule; to deep-equal from => none; suspicious => still a delta (manual only, red badge);
 *  [F40] an end-only / duration-only change (durationMin > 0, no new date or time) => reschedule with the start kept and end = start + durationMin;
 *  title changes are out of scope (to.title = from.title always). */
export function resolveDelta(
  x: Extraction,
  existing: ExistingEventCtx | null,
  ctx: WhenContext,
  rawTriggerText: string,
): DeltaResolution {
  return toResolution(resolveDeltaOutcome(x, existing, ctx, rawTriggerText));
}

/** The frozen C2 15 view of an outcome (`v1` and `no_change` both become `none`). */
export function toResolution(o: DeltaOutcome): DeltaResolution {
  switch (o.path) {
    case 'v1':
    case 'no_change':
      return { kind: 'none' };
    case 'unclear':
      return { kind: 'unclear', badge: 'change_unclear' };
    case 'incomplete':
      return { kind: 'incomplete', missing: o.missing };
    case 'suppressed':
      return { kind: 'suppressed' };
    case 'delta':
      return { kind: 'delta', delta: o.delta };
  }
}
