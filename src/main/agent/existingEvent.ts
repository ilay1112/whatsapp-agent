// src/main/agent/existingEvent.ts   ADD (B20) - pure over repos; called by the orchestrator before S1 and re-evaluated on every re-triage.
// Owner V2-W1-03-edit-pipeline. READ-ONLY: this module never writes a row (the orchestrator sets items.linked_item_id from its result).
// Everything returned is an app row (TRUSTED) except title / location, which are the contact-derived text the user once approved:
// they travel only inside the nonce data block (existingEventBlock) and never reach a system prompt, a log line or an argv.
import type { ItemId, ChatRef, EpochMs, LocalDateTime, EventStatus } from '../../shared/types';
import { LIMITS, type ApprovalAction, type Item } from '../../shared/types';
import { ActionPayloadSchema, GOOGLE_EVENT_ID_RE, type ActionPayload } from '../../shared/schemas';
import { WEEKDAYS_EN, WEEKDAYS_HE } from '../../shared/when';
import type { Repos } from '../db/index';

/** TRUSTED app rows, except title/location (contact-derived text, quoted inside the nonce block only). eventId / item ids never reach a model. */
export interface ExistingEventCtx {
  editableCount: number; // [F31] editable events of the chat (same filter); > 1 => badge change_target_unclear on any delta + AutoGate multiple_events
  originItemId: ItemId; // [F27] items.event_origin_item_id of the source item (= the Google waItem tag)
  sourceItemId: ItemId; // newest in_calendar item of the chat with calendar_event_id, event_state in EDITABLE_EVENT_STATES,
  eventId: string; //   event_start_ts >= now - LIMITS.eventEditGraceMs ; null => a plain v1 run
  title: string;
  location: string; // from the approved_final_json of the DONE create/update action of that event (never the proposal's model text)
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  timeZone: string;
  status: EventStatus;
  revision: number; // items.event_revision (>= 1)
}

/** The approved content of one done calendar action for THIS event (create payload, or `to` of an update), else null. */
interface ApprovedContent {
  title: string;
  location: string;
  startLocal: LocalDateTime;
  endLocal: LocalDateTime;
  timeZone: string;
  status: EventStatus;
}

/** `approved_final_json` of a done action, re-validated (the same rule as exec/outcome.ts parseFinalPayload; agent/** may not import exec/**).
 *  A row whose JSON was nulled by retention or does not parse is simply not a source of content (fail closed: no existing event). */
function approvedPayload(a: ApprovalAction): ActionPayload | null {
  const raw = a.approvedFinalJson ?? '';
  if (raw === '') return null;
  try {
    const parsed = ActionPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function contentOf(a: ApprovalAction, eventId: string): ApprovedContent | null {
  const p = approvedPayload(a);
  if (p === null) return null;
  if (p.kind === 'create_event') {
    return {
      title: p.title,
      location: p.location,
      startLocal: p.startLocal,
      endLocal: p.endLocal,
      timeZone: p.timeZone,
      status: 'confirmed',
    };
  }
  if (p.kind === 'update_event' && p.targetEventId === eventId) {
    return {
      title: p.to.title,
      location: p.to.location,
      startLocal: p.to.startLocal,
      endLocal: p.to.endLocal,
      timeZone: p.to.timeZone,
      status: p.to.status,
    };
  }
  return null;
}

/** Order of "newest done write": executed_at, then approved_at, then created_at, then id (all app-written numbers). */
function doneAt(a: ApprovalAction): number {
  return a.executedAt ?? a.approvedAt ?? a.createdAt;
}

/**
 * The newest DONE create/update of the event, over every item that holds it (the source item and the items of earlier applied changes:
 * applyUpdateSuccess moves the event id forward, so the content of the last change lives on the acting item of that change).
 */
function latestApprovedContent(
  repos: Pick<Repos, 'items' | 'actions'>,
  source: Item,
  eventId: string,
): ApprovedContent | null {
  const holders = new Map<ItemId, Item>([[source.id, source]]);
  for (const it of repos.items.byCalendarEventId(eventId)) holders.set(it.id, it);
  let best: { at: number; id: string; content: ApprovedContent } | null = null;
  for (const holder of holders.values()) {
    for (const a of repos.actions.forItem(holder.id)) {
      if (a.state !== 'done' || (a.kind !== 'create_event' && a.kind !== 'update_event')) continue;
      // a create of ANOTHER item cannot describe this event; only the holder's own create (its event id is the chain's) or an update
      // that targeted exactly this event id may.
      const content = contentOf(a, eventId);
      if (content === null) continue;
      const at = doneAt(a);
      if (best === null || at > best.at || (at === best.at && a.id > best.id)) best = { at, id: a.id, content };
    }
  }
  return best?.content ?? null;
}

/** [W0] C2's `repos: unknown` is materialised as `Pick<Repos, 'items' | 'actions'>` (C2 15 note under the block). */
export function findExistingEvent(
  repos: Pick<Repos, 'items' | 'actions'>,
  chatId: ChatRef,
  nowMs: EpochMs,
): ExistingEventCtx | null {
  const since = nowMs - LIMITS.eventEditGraceMs;
  const source = repos.items.newestEditableEvent(chatId, since);
  if (source === null || source.calendarEventId === null) return null;
  const eventId = source.calendarEventId;
  // Only an id of Google's own alphabet can be pinned into an update payload (UpdateEventPayloadSchema); anything else is not ours.
  if (!GOOGLE_EVENT_ID_RE.test(eventId)) return null;
  const content = latestApprovedContent(repos, source, eventId);
  // No approved content (retention nulled it, or the row does not parse) => no delta can be pinned: the plain v1 run (fail closed).
  // A cancelled event is never an editable target (undo restores it through its own path).
  if (content === null || content.status !== 'confirmed') return null;
  return {
    editableCount: Math.max(1, repos.items.countEditableEvents(chatId, since)),
    originItemId: source.eventOriginItemId ?? source.id,
    sourceItemId: source.id,
    eventId,
    title: content.title,
    location: content.location,
    startLocal: content.startLocal,
    endLocal: content.endLocal,
    timeZone: content.timeZone,
    status: 'confirmed',
    revision: Math.max(1, source.eventRevision),
  };
}

/** The data-block projection (S1 and S3 user message, INSIDE the nonce block): app_context.existing_event is ALWAYS present (null when none). */
export interface ExistingEventBlock {
  title: string;
  date: string;
  weekday: number;
  weekday_en: string;
  weekday_he: string;
  start_local: LocalDateTime;
  end_local: LocalDateTime;
  time_zone: string;
  location: string;
  status: EventStatus;
}

/** 0 = Sunday; calendar-day arithmetic on the date part only (no zone involved). */
function weekdayOf(isoDate: string): number {
  const d = new Date(0);
  d.setUTCFullYear(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  return d.getUTCDay();
}

/** No event id, item id, revision or JID in here - by construction (the block is built key by key). */
export function existingEventBlock(e: ExistingEventCtx | null): ExistingEventBlock | null {
  if (e === null) return null;
  const date = e.startLocal.slice(0, 10);
  const weekday = weekdayOf(date);
  return {
    title: e.title,
    date,
    weekday,
    weekday_en: WEEKDAYS_EN[weekday] ?? '',
    weekday_he: WEEKDAYS_HE[weekday] ?? '',
    start_local: e.startLocal,
    end_local: e.endLocal,
    time_zone: e.timeZone,
    location: e.location,
    status: e.status,
  };
}
