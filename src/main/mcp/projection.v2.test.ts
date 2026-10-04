// src/main/mcp/projection.v2.test.ts - [V2] get-event / update-event projections (owner V2-W1-02).
// T2 5 row mcp/*: "412 text => McpErrorKind 'precondition'; OwnedEventProjection never leaks raw server text". TESTS 13: projection.ts
// is safety-critical (100 % lines / 95 % branches / 100 % functions).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GET_EVENT_FIELDS,
  LOCATION_MAX,
  NOT_FOUND_RE,
  PRECONDITION_RE,
  RESULT_TEXT_MAX,
  SUMMARY_MAX,
  classifyEventErrorText,
  eventTextHasEtag,
  isEtagFieldRejection,
  projectOwnedEvent,
  projectUpdatedEvent,
} from './projection';

const BAD = { ok: false, error: 'bad_response' } as const;
const ID = 'abcdef0123456789abcdef0123456789';
const TZ = 'Asia/Jerusalem';

/** A get-event answer of the PATCHED 2.6.3 server (convertGoogleEventToStructured shape), fully populated. */
function eventJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    summary: 'Dentist',
    description: 'SECRET-DESCRIPTION the user wrote',
    location: 'Clinic',
    start: { dateTime: '2026-10-01T15:00:00+03:00', timeZone: TZ },
    end: { dateTime: '2026-10-01T16:00:00+03:00', timeZone: TZ },
    status: 'confirmed',
    htmlLink: 'https://www.google.com/calendar/event?eid=X',
    updated: '2026-09-28T10:00:00.000Z',
    creator: { email: 'user@example.test', self: true },
    organizer: { email: 'user@example.test', self: true },
    sequence: 2,
    etag: '"3181000000000001"',
    extendedProperties: {
      private: { waAgent: '1', waItem: '42', waAction: 'root-action-1', waUpdate: 'upd-1', waRev: '2' },
    },
    calendarId: 'primary',
    accountId: 'personal',
    ...over,
  };
}
const wrap = (event: Record<string, unknown>): string => JSON.stringify({ event });

describe('the vendored 412 text (vendor/calendar-mcp.patch.json) and the error classifier', () => {
  const patch = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../vendor/calendar-mcp.patch.json', import.meta.url)), 'utf8'),
  ) as { preconditionErrorText: string; preconditionErrorPattern: string };

  it('the patch text matches the C2 11 regex and the pattern recorded next to it', () => {
    expect(PRECONDITION_RE.test(patch.preconditionErrorText)).toBe(true);
    expect(patch.preconditionErrorPattern).toBe(String(PRECONDITION_RE));
    // As the server wraps it (McpError message).
    expect(classifyEventErrorText(`MCP error -32600: ${patch.preconditionErrorText}`)).toBe('precondition');
  });

  it('maps 404 / 410 / deleted to not_found, validation / 400 to invalid_args, anything else to bad_response', () => {
    expect(
      classifyEventErrorText(
        `MCP error -32603: Internal error: Event with ID '${ID}' not found in calendar 'primary'.`,
      ),
    ).toBe('not_found');
    expect(classifyEventErrorText('MCP error -32600: Resource not found: Not Found')).toBe('not_found');
    expect(classifyEventErrorText('MCP error -32600: Google API error: Resource has been deleted')).toBe('not_found');
    expect(classifyEventErrorText('Google API error: 410')).toBe('not_found');
    expect(classifyEventErrorText('status 404')).toBe('not_found');
    expect(
      classifyEventErrorText('MCP error -32602: Input validation error: Invalid arguments for tool get-event'),
    ).toBe('invalid_args');
    expect(classifyEventErrorText('MCP error -32600: Bad Request: Invalid start time')).toBe('invalid_args');
    expect(classifyEventErrorText('HTTP 400')).toBe('invalid_args');
    expect(classifyEventErrorText('MCP error -32603: Internal error: socket hang up')).toBe('bad_response');
    expect(classifyEventErrorText('Precondition Failed')).toBe('precondition');
    expect(classifyEventErrorText('Google API error: 412')).toBe('precondition');
  });

  it('412 wins over not-found wording; oversized or non-string text is bad_response', () => {
    expect(classifyEventErrorText('Precondition failed (HTTP 412): not found')).toBe('precondition');
    expect(classifyEventErrorText('x'.repeat(RESULT_TEXT_MAX + 1))).toBe('bad_response');
    expect(classifyEventErrorText(42 as unknown as string)).toBe('bad_response');
  });

  it('an id that merely contains the digits 412 / 404 is not a status (word boundaries)', () => {
    expect(PRECONDITION_RE.test('abc412def')).toBe(false);
    expect(NOT_FOUND_RE.test('ab404cd')).toBe(false);
  });
});

describe('F12 etag signals', () => {
  it('isEtagFieldRejection recognises the unpatched enum refusing "etag" and nothing else', () => {
    expect(isEtagFieldRejection('Invalid fields requested: etag. Allowed fields: id, summary')).toBe(true);
    // The exact text of the unpatched enum (zod 4 names the allowed options only) and the patched one (etag allowed).
    const unpatched =
      'MCP error -32602: Input validation error: Invalid arguments for tool get-event: Invalid option: expected one of "id"|"summary"|"eventType" at fields[0]';
    expect(isEtagFieldRejection(unpatched)).toBe(true);
    expect(isEtagFieldRejection(unpatched.replace('"eventType"', '"eventType"|"etag"'))).toBe(false);
    expect(isEtagFieldRejection('Resource not found: etag')).toBe(false);
    expect(isEtagFieldRejection('Invalid option, allowed: "etag"')).toBe(false);
    expect(isEtagFieldRejection('Input validation error: calendarId')).toBe(false);
    expect(isEtagFieldRejection('x'.repeat(RESULT_TEXT_MAX + 1))).toBe(false);
    expect(isEtagFieldRejection(null as unknown as string)).toBe(false);
  });

  it('eventTextHasEtag: true / false for a parsable event, null when there is no event to judge', () => {
    expect(eventTextHasEtag(wrap(eventJson()))).toBe(true);
    const { etag: _drop, ...noEtag } = eventJson();
    void _drop;
    expect(eventTextHasEtag(wrap(noEtag))).toBe(false);
    expect(eventTextHasEtag(JSON.stringify(eventJson()))).toBe(true); // bare event, no wrapper
    expect(eventTextHasEtag(wrap(eventJson({ etag: '' })))).toBe(false);
    expect(eventTextHasEtag(wrap(eventJson({ etag: 'bad\netag' })))).toBe(false);
    expect(eventTextHasEtag(wrap(eventJson({ id: 7 })))).toBeNull();
    expect(eventTextHasEtag('[]')).toBeNull();
    expect(eventTextHasEtag('<html/>')).toBeNull();
  });

  it('the get-event field list is the fixed C2 11 list, etag first', () => {
    expect([...GET_EVENT_FIELDS]).toEqual([
      'etag',
      'updated',
      'sequence',
      'status',
      'creator',
      'organizer',
      'attendees',
      'recurrence',
      'recurringEventId',
      'extendedProperties',
    ]);
  });
});

describe('projectOwnedEvent', () => {
  it('projects exactly the C2 11 fields; description, e-mails, links and account ids never leave', () => {
    const res = projectOwnedEvent(wrap(eventJson()), ID);
    expect(res).toEqual({
      ok: true,
      value: {
        id: ID,
        status: 'confirmed',
        startLocal: '2026-10-01T15:00:00',
        endLocal: '2026-10-01T16:00:00',
        timeZone: TZ,
        summary: 'Dentist',
        location: 'Clinic',
        etag: '"3181000000000001"',
        updated: '2026-09-28T10:00:00.000Z',
        sequence: 2,
        creatorSelf: true,
        organizerSelf: true,
        hasAttendees: false,
        hasRecurrence: false,
        priv: { waAgent: '1', waItem: '42', waAction: 'root-action-1', waUpdate: 'upd-1', waRev: '2' },
      },
    });
    const flat = JSON.stringify(res);
    for (const leak of ['SECRET-DESCRIPTION', 'user@example.test', 'htmlLink', 'google.com', 'accountId', 'personal']) {
      expect(flat).not.toContain(leak);
    }
  });

  it('cleans and caps the UNTRUSTED summary (80) and location (120); missing ones become empty strings', () => {
    const hostile = `\u202Eevil\u200B title\n${'x'.repeat(200)}`;
    const res = projectOwnedEvent(wrap(eventJson({ summary: hostile, location: `  ${'y'.repeat(300)}  ` })), ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.summary.length).toBe(SUMMARY_MAX);
    expect(res.value.summary.startsWith('evil title x')).toBe(true);
    expect(res.value.summary).not.toMatch(/[\u202E\u200B\n]/);
    expect(res.value.location).toBe('y'.repeat(LOCATION_MAX));
    const bare = projectOwnedEvent(wrap(eventJson({ summary: undefined, location: 42 })), ID);
    expect(bare.ok && [bare.value.summary, bare.value.location]).toEqual(['', '']);
  });

  it('reads a cancelled event (get always returns them) and a tentative one', () => {
    for (const status of ['cancelled', 'tentative'] as const) {
      const res = projectOwnedEvent(wrap(eventJson({ status })), ID);
      expect(res.ok && res.value.status).toBe(status);
    }
  });

  it('local wall-clock times (no offset) and all-day dates are taken in the event zone; the end zone is a fallback', () => {
    const res = projectOwnedEvent(
      wrap(
        eventJson({
          start: { dateTime: '2026-10-01T15:00:00' },
          end: { dateTime: '2026-10-01T16:00:00', timeZone: TZ },
        }),
      ),
      ID,
    );
    expect(res.ok && [res.value.startLocal, res.value.endLocal, res.value.timeZone]).toEqual([
      '2026-10-01T15:00:00',
      '2026-10-01T16:00:00',
      TZ,
    ]);
    const allDay = projectOwnedEvent(
      wrap(eventJson({ start: { date: '2026-10-01', timeZone: TZ }, end: { date: '2026-10-02', dateTime: null } })),
      ID,
    );
    expect(allDay.ok && [allDay.value.startLocal, allDay.value.endLocal]).toEqual([
      '2026-10-01T00:00:00',
      '2026-10-02T00:00:00',
    ]);
    const bareStrings = projectOwnedEvent(
      wrap(eventJson({ start: '2026-10-01T15:00:00', end: { dateTime: '2026-10-01T16:00:00', timeZone: TZ } })),
      ID,
    );
    expect(bareStrings.ok && bareStrings.value.startLocal).toBe('2026-10-01T15:00:00');
  });

  it('attendees / recurrence / a recurring instance / foreign creator are reported, fail closed on odd shapes', () => {
    const w = (over: Record<string, unknown>) => {
      const r = projectOwnedEvent(wrap(eventJson(over)), ID);
      if (!r.ok) throw new Error('projection failed');
      return r.value;
    };
    expect(w({ attendees: [{ email: 'a@example.test' }] }).hasAttendees).toBe(true);
    expect(w({ attendees: [] }).hasAttendees).toBe(false);
    expect(w({ attendees: null }).hasAttendees).toBe(false);
    expect(w({ attendees: { weird: true } }).hasAttendees).toBe(true);
    expect(w({ recurrence: ['RRULE:FREQ=WEEKLY'] }).hasRecurrence).toBe(true);
    expect(w({ recurrence: [] }).hasRecurrence).toBe(false);
    expect(w({ recurrence: 'RRULE' }).hasRecurrence).toBe(true);
    expect(w({ recurringEventId: 'parent123' }).hasRecurrence).toBe(true);
    expect(w({ recurringEventId: '' }).hasRecurrence).toBe(false);
    const foreign = w({ creator: { self: false }, organizer: 'me' });
    expect([foreign.creatorSelf, foreign.organizerSelf]).toEqual([false, false]);
    expect(w({ creator: undefined, organizer: { self: 'true' } }).organizerSelf).toBe(false);
  });

  it('etag / updated / sequence / tags that are not the expected shapes become null', () => {
    const r = projectOwnedEvent(
      wrap(
        eventJson({
          etag: 7,
          updated: 'yesterday',
          sequence: -1,
          extendedProperties: {
            private: { waAgent: 1, waItem: 'has space', waAction: 'x'.repeat(129), waUpdate: '', waRev: 'ש' },
          },
        }),
      ),
      ID,
    );
    expect(r.ok && r.value).toMatchObject({
      etag: null,
      updated: null,
      sequence: null,
      priv: { waAgent: null, waItem: null, waAction: null, waUpdate: null, waRev: null },
    });
    for (const over of [
      { sequence: 1.5 },
      { sequence: '3' },
      { extendedProperties: { private: 'x' } },
      { extendedProperties: 3 },
    ]) {
      const x = projectOwnedEvent(wrap(eventJson(over)), ID);
      expect(x.ok).toBe(true);
    }
    const noExt = projectOwnedEvent(wrap(eventJson({ extendedProperties: undefined })), ID);
    expect(noExt.ok && noExt.value.priv).toEqual({
      waAgent: null,
      waItem: null,
      waAction: null,
      waUpdate: null,
      waRev: null,
    });
    expect(projectOwnedEvent(wrap(eventJson({ sequence: 1.5 })), ID)).toMatchObject({
      ok: true,
      value: { sequence: null },
    });
  });

  it('fails closed: another id, garbage, arrays, unknown status, no zone, a bad zone, bad or reversed times', () => {
    expect(projectOwnedEvent(wrap(eventJson()), 'someotherid0')).toEqual(BAD);
    expect(projectOwnedEvent(wrap(eventJson({ id: undefined })), ID)).toEqual(BAD);
    expect(projectOwnedEvent('<html/>', ID)).toEqual(BAD);
    expect(projectOwnedEvent('[]', ID)).toEqual(BAD);
    expect(projectOwnedEvent(wrap(eventJson({ status: 'deleted' })), ID)).toEqual(BAD);
    expect(
      projectOwnedEvent(
        wrap(eventJson({ start: { dateTime: '2026-10-01T15:00:00' }, end: { dateTime: '2026-10-01T16:00:00' } })),
        ID,
      ),
    ).toEqual(BAD);
    expect(projectOwnedEvent(wrap(eventJson({ start: 'x', end: 7 })), ID)).toEqual(BAD);
    expect(
      projectOwnedEvent(wrap(eventJson({ start: { dateTime: '2026-10-01T15:00:00Z', timeZone: 'Not a zone!' } })), ID),
    ).toEqual(BAD);
    // A zone the regex admits but Intl does not know: never throws.
    expect(
      projectOwnedEvent(
        wrap(
          eventJson({
            start: { dateTime: '2026-10-01T15:00:00Z', timeZone: 'Mars/Olympus' },
            end: { dateTime: '2026-10-01T16:00:00Z' },
          }),
        ),
        ID,
      ),
    ).toEqual(BAD);
    expect(
      projectOwnedEvent(
        wrap(
          eventJson({
            start: { dateTime: '2026-10-01T17:00:00', timeZone: TZ },
            end: { dateTime: '2026-10-01T16:00:00' },
          }),
        ),
        ID,
      ),
    ).toEqual(BAD);
    expect(projectOwnedEvent(wrap(eventJson({ start: { timeZone: TZ } })), ID)).toEqual(BAD);
    expect(projectOwnedEvent(wrap(eventJson({ end: 42 })), ID)).toEqual(BAD);
  });
});

describe('projectUpdatedEvent', () => {
  it('projects id, status and the slot in the zone the app wrote; conflict / warning free text is dropped', () => {
    const text = JSON.stringify({
      event: eventJson({ status: 'cancelled' }),
      conflicts: [{ summary: 'SOMEONE ELSE' }],
      warnings: ['WARN-TEXT'],
    });
    const res = projectUpdatedEvent(text, ID, TZ);
    expect(res).toEqual({
      ok: true,
      value: { eventId: ID, status: 'cancelled', startLocal: '2026-10-01T15:00:00', endLocal: '2026-10-01T16:00:00' },
    });
    expect(JSON.stringify(res)).not.toMatch(/SOMEONE ELSE|WARN-TEXT|Dentist/);
    expect(projectUpdatedEvent(JSON.stringify(eventJson()), ID, TZ).ok).toBe(true);
  });

  it('fails closed on another id, bad status, bad zone, garbage, bad or reversed times', () => {
    expect(projectUpdatedEvent(wrap(eventJson()), 'otherid00', TZ)).toEqual(BAD);
    expect(projectUpdatedEvent(wrap(eventJson({ id: 1 })), ID, TZ)).toEqual(BAD);
    expect(projectUpdatedEvent(wrap(eventJson({ status: 'gone' })), ID, TZ)).toEqual(BAD);
    expect(projectUpdatedEvent(wrap(eventJson()), ID, 'Not a zone!')).toEqual(BAD);
    expect(projectUpdatedEvent('garbage', ID, TZ)).toEqual(BAD);
    expect(projectUpdatedEvent('[1]', ID, TZ)).toEqual(BAD);
    expect(projectUpdatedEvent(wrap(eventJson({ start: null })), ID, TZ)).toEqual(BAD);
    expect(projectUpdatedEvent(wrap(eventJson({ end: { dateTime: '2026-10-01T14:00:00+03:00' } })), ID, TZ)).toEqual(
      BAD,
    );
  });
});
