// src/main/agent/resolve.ts - S2 RESOLVE sub-states over shared/when.ts (build-plan section 3; owner W1-08).
import { resolveWhen, type WhenContext, type ResolvedWhen } from '../../shared/when';
import { LIMITS, type Assumption, type ClosedReason, type MissingField, type ProposedEvent } from '../../shared/types';
import type { Extraction } from '../../shared/schemas';

export type SlotState = 'none' | 'incomplete' | 'complete';
export interface ResolvedSlot {
  state: SlotState; // -> eventState 'none' | 'incomplete' | 'proposed'
  when: ResolvedWhen;
  event: ProposedEvent | null; // complete or incomplete (dateHint filled) ; null when state === 'none'
  missing: MissingField[];
  assumptions: Assumption[];
}

/** Intents that may end in a `create_event` action. `reschedule`/`cancel` are handled separately (no write in v1, ARCHITECTURE A10). */
const EVENT_INTENTS: ReadonlySet<Extraction['intent']> = new Set(['schedule_request', 'confirmation']);
/** Only these two make a slot unusable. `duration`/`location`/`who`/`confirmation` stay in `missing` for the draft to ask about
 *  while the event is still proposable (PIPELINE 5.4 and golden rows he-01 / en-02, which are `needs_reply`, not `info_missing`). */
const BLOCKING_MISSING: readonly MissingField[] = ['date', 'time'];

// LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR - built from code points because the last two are line terminators in source.
const LINE_BREAKS = String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029);
const NEWLINES_RE = new RegExp(`[${LINE_BREAKS}]+`, 'g');

/** ProposedEventSchema requires single-line, length-capped values; model output is only length-capped. */
function singleLine(value: string, cap: number): string {
  return value.replace(NEWLINES_RE, ' ').trim().slice(0, cap);
}

/** Sanity checks of ARCHITECTURE 6.3 (past, > 12 months, duration bounds, weekday mismatch) -> downgrade, never crash. Pure. */
export function resolveExtraction(x: Extraction, ctx: WhenContext): ResolvedSlot {
  const when = resolveWhen(x, ctx);
  const complete =
    when.startLocal !== '' &&
    when.endLocal !== '' &&
    when.problems.length === 0 &&
    !BLOCKING_MISSING.some((f) => when.missing.includes(f));

  let state: SlotState;
  if (x.intent === 'cancel') {
    state = 'none'; // nothing to propose; the card carries `change_in_google`
  } else if (x.intent === 'reschedule') {
    state = when.date === '' ? 'none' : 'incomplete'; // a new day is on the table but v1 never writes the move itself
  } else if (EVENT_INTENTS.has(x.intent)) {
    state = complete ? 'complete' : 'incomplete';
  } else {
    state = 'none'; // question / smalltalk / other: no scheduling intent (ARCHITECTURE 6.3)
  }

  const event: ProposedEvent | null =
    state === 'none'
      ? null
      : {
          title: singleLine(x.title, LIMITS.titleChars),
          startLocal: state === 'complete' ? when.startLocal : '',
          endLocal: state === 'complete' ? when.endLocal : '',
          timeZone: when.timeZone, // from settings, never from the model
          location: singleLine(x.location, LIMITS.locationChars),
          assumptions: when.assumptions,
          dateHint: state === 'complete' ? '' : when.date, // pre-fills the info-missing mini-form
        };

  return { state, when, event, missing: when.missing, assumptions: when.assumptions };
}

/** `[+]` ARCHITECTURE 6.3 / PIPELINE 5.6: reschedule and cancel never call update-event / delete-event in v1 - the card shows
 *  the info badge `change_in_google` instead. Pure; the caller (W1-10 validate.ts) turns `true` into the badge. */
export function needsCalendarChangeBadge(x: Extraction): boolean {
  return x.intent === 'reschedule' || x.intent === 'cancel';
}

/** `[+]` PIPELINE 5.6: no reply wanted, nothing to schedule and no calendar change to announce => the item closes itself. */
export function closureFor(x: Extraction, slot: ResolvedSlot): ClosedReason | null {
  return !x.needsReply && slot.state === 'none' && !needsCalendarChangeBadge(x) ? 'not_needed' : null;
}
