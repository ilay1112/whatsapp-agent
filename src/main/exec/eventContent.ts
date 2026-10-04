// src/main/exec/eventContent.ts - pure helpers over event CONTENT (owner V2-W1-04-exec-auto; new file in the exec/ directory it owns).
// Shared by exec/autoGate.ts (drift = `modified_in_google`), exec/actionExecutor.ts (pre-flight drift, readback checks, pre_json) and
// exec/reconcile.ts. PURE: no I/O, no clock, no node:* import - exec/autoGate.ts may import it (import-graph part C).
// Titles / locations are UNTRUSTED contact text; they are compared and copied, never logged, audited or shown by this module.
import { stripInvisible } from '../../shared/schemas';
import type { EventContentWithStatus } from '../../shared/schemas';
import type { BusyBlock, EventContentView, EventSnapshot } from '../../shared/types';
import type { OwnedEventProjection } from '../mcp/readClient';
import { LIMITS } from '../../shared/types';

/** Same cleaning rule as buildCreateEventArgs.cleanField (URLs stripped, whitespace collapsed, capped) so an app-written title and
 *  Google's readback of it compare equal even when the proposal still carried the raw text. */
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;
export function normaliseField(raw: string, max: number): string {
  return stripInvisible(raw).replace(URL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The approved-content view of a get-event projection. `tentative` is not an app status: it maps to 'confirmed' only for display /
 *  storage; drift comparison uses {@link sameContent}, which treats `tentative` as different from both app states. */
export function contentOfProjection(p: OwnedEventProjection): EventContentWithStatus {
  return {
    title: normaliseField(p.summary, LIMITS.titleChars),
    startLocal: p.startLocal,
    endLocal: p.endLocal,
    timeZone: p.timeZone,
    location: normaliseField(p.location, LIMITS.locationChars),
    status: p.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
}

/** auto_writes.pre_json (I8): the pre-flight projection, stored BEFORE the write. */
export function snapshotOfProjection(p: OwnedEventProjection): EventSnapshot {
  return {
    title: normaliseField(p.summary, LIMITS.titleChars),
    startLocal: p.startLocal,
    endLocal: p.endLocal,
    timeZone: p.timeZone,
    location: normaliseField(p.location, LIMITS.locationChars),
    status: p.status,
    etag: p.etag,
    updated: p.updated,
    sequence: p.sequence,
  };
}

/** The restorable content of a snapshot (status tentative => confirmed: the app never writes tentative). */
export function contentOfSnapshot(s: EventSnapshot): EventContentWithStatus {
  return {
    title: s.title,
    startLocal: s.startLocal,
    endLocal: s.endLocal,
    timeZone: s.timeZone,
    location: s.location,
    status: s.status === 'cancelled' ? 'cancelled' : 'confirmed',
  };
}

export function viewOf(c: EventContentWithStatus): EventContentView {
  return {
    title: c.title,
    startLocal: c.startLocal,
    endLocal: c.endLocal,
    timeZone: c.timeZone,
    location: c.location,
    status: c.status,
  };
}

/** Google's copy (a projection) still equals `c`: title, slot, location and status. The zone is not compared (Google may echo the
 *  calendar's zone for the same wall-clock slot); `tentative` never equals an app status. */
export function sameContent(p: OwnedEventProjection, c: EventContentWithStatus): boolean {
  if (p.status !== c.status) return false;
  if (p.startLocal !== c.startLocal || p.endLocal !== c.endLocal) return false;
  if (normaliseField(p.summary, LIMITS.titleChars) !== normaliseField(c.title, LIMITS.titleChars)) return false;
  return normaliseField(p.location, LIMITS.locationChars) === normaliseField(c.location, LIMITS.locationChars);
}

/** Deep equality of two approved contents (`to == from` => ACTION_STALE). */
export function equalContent(a: EventContentWithStatus, b: EventContentWithStatus): boolean {
  return (
    a.title === b.title &&
    a.startLocal === b.startLocal &&
    a.endLocal === b.endLocal &&
    a.timeZone === b.timeZone &&
    a.location === b.location &&
    a.status === b.status
  );
}

/**
 * Busy blocks overlapping `slot`, after removing the event's OWN block `own` (reschedule: the event being moved must not conflict
 * with itself). Interval subtraction over same-format local strings (they compare chronologically, CONTRACTS 5): a merged busy
 * block that also covers another event keeps the part outside `own`.
 */
export function busyOverlapping(
  busy: readonly BusyBlock[],
  slot: { startLocal: string; endLocal: string },
  own: { startLocal: string; endLocal: string } | null,
): BusyBlock[] {
  const pieces: BusyBlock[] = [];
  for (const b of busy) {
    if (own === null || b.endLocal <= own.startLocal || b.startLocal >= own.endLocal) {
      pieces.push(b);
      continue;
    }
    if (b.startLocal < own.startLocal) pieces.push({ ...b, endLocal: own.startLocal });
    if (b.endLocal > own.endLocal) pieces.push({ ...b, startLocal: own.endLocal });
  }
  return pieces.filter((b) => b.startLocal < slot.endLocal && b.endLocal > slot.startLocal);
}
