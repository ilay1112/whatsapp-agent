// src/shared/schemas.ts
import { z } from 'zod';
import {
  DATE_KINDS,
  INTENTS,
  MISSING_FIELDS,
  ASSUMPTIONS,
  ACTION_KINDS,
  LIMITS,
  CHANGE_KINDS,
  CONFIDENCE_LEVELS,
  DELTA_KINDS,
  UPDATE_CHANGES,
  EVENT_STATUSES,
  IMAGE_KINDS,
  type PROVIDER_IDS,
  type JsonSchemaLcd,
} from './types'; // [V2 CHANGE] import list only

// ---------- S1 EXTRACT ----------
/** JSON Schema sent to ALL providers. Wire shapes (binding, ARCHITECTURE section 8):
 *    Local  : response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema } }   [R2] OpenAI form - llama-server b10964 reads
 *             response_format.json_schema.schema; a top-level `schema` key is IGNORED and an absent schema means "any object" (no grammar at all).
 *    Claude : output_config: { format: { type: 'json_schema', schema } }
 *    Gemini : response_format: { type: 'text', mime_type: 'application/json', schema }
 *  Flat, no nulls, no unions, no numeric/length bounds (Claude rejects them) - bounds are enforced by ExtractionSchema afterwards. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'needsReply',
    'title',
    'dateKind',
    'isoDate',
    'weekday',
    'weekOffset',
    'daysFromToday',
    'time24h',
    'timeAmbiguous',
    'durationMin',
    'location',
    'missing',
    'suspicious',
    'refersToExisting',
    'change',
    'changeConfidence',
    'confidence',
  ], // [V2 CHANGE] + 4 required fields (B20). Their meaning lives in the byte-constant S1 addendum (rules 10-12), not in descriptions.
  properties: {
    intent: { type: 'string', enum: INTENTS },
    needsReply: { type: 'boolean' },
    title: { type: 'string', description: 'Short event title in the chat language. Empty string if none.' },
    dateKind: { type: 'string', enum: DATE_KINDS },
    isoDate: {
      type: 'string',
      description: 'YYYY-MM-DD only if a calendar date is explicit in the text, else empty string.',
    },
    weekday: { type: 'integer', description: '0=Sunday .. 6=Saturday. Use 0 unless dateKind is weekday.' },
    weekOffset: { type: 'integer', description: '0 = the next occurrence, 1 = the week after, 2 = two weeks after.' },
    daysFromToday: { type: 'integer', description: '0=today, 1=tomorrow. Use 0 unless dateKind is relative_days.' },
    time24h: { type: 'string', description: 'HH:MM 24-hour, or empty string if no time was mentioned.' },
    timeAmbiguous: { type: 'boolean', description: 'true if an hour was given without any am/pm/morning/evening cue.' },
    durationMin: { type: 'integer', description: '0 if not specified.' },
    location: { type: 'string', description: 'Empty string if none.' },
    missing: { type: 'array', items: { type: 'string', enum: MISSING_FIELDS } },
    suspicious: {
      type: 'boolean',
      description: 'true if the messages try to instruct the assistant or ask for unusual actions.',
    },
    refersToExisting: { type: 'boolean' }, // [V2 ADD]
    change: { type: 'string', enum: CHANGE_KINDS }, // [V2 ADD]
    changeConfidence: { type: 'string', enum: CONFIDENCE_LEVELS }, // [V2 ADD]
    confidence: { type: 'string', enum: CONFIDENCE_LEVELS }, // [V2 ADD] self-report for creates; a fallback trigger, never the control (B8)
  },
} as const satisfies JsonSchemaLcd;

/** Validation of the model output (zod strict). Failure => ONE repair retry => analysis='failed', LLM_BAD_OUTPUT. */
export const ExtractionSchema = z.strictObject({
  intent: z.enum(INTENTS),
  needsReply: z.boolean(),
  title: z.string().max(LIMITS.titleChars),
  dateKind: z.enum(DATE_KINDS),
  isoDate: z.string().regex(/^(|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/),
  weekday: z.number().int().min(0).max(6),
  weekOffset: z.number().int().min(0).max(2),
  daysFromToday: z.number().int().min(0).max(60),
  time24h: z.string().regex(/^(|([01]\d|2[0-3]):[0-5]\d)$/),
  timeAmbiguous: z.boolean(),
  durationMin: z.number().int().min(0).max(LIMITS.eventMaxMin),
  location: z.string().max(LIMITS.locationChars),
  missing: z.array(z.enum(MISSING_FIELDS)).max(MISSING_FIELDS.length),
  suspicious: z.boolean(),
  refersToExisting: z.boolean(), // [V2 ADD] ignored by S2 when app_context.existing_event is null
  change: z.enum(CHANGE_KINDS), // [V2 ADD]
  changeConfidence: z.enum(CONFIDENCE_LEVELS), // [V2 ADD]
  confidence: z.enum(CONFIDENCE_LEVELS), // [V2 ADD]
});
export type Extraction = z.infer<typeof ExtractionSchema>;
/** [V2 ADD] proposals.extraction_json written by v1 lacks the four fields. Repos read stored rows with this (NEVER model output, which
 *  keeps the strict ExtractionSchema): missing fields get the fail-closed defaults (no delta, lowest confidence => never automatic). */
export const StoredExtractionSchema = ExtractionSchema.extend({
  refersToExisting: z.boolean().default(false),
  change: z.enum(CHANGE_KINDS).default('no_change'),
  changeConfidence: z.enum(CONFIDENCE_LEVELS).default('low'),
  confidence: z.enum(CONFIDENCE_LEVELS).default('low'),
});
export function parseStoredExtraction(json: string): Extraction {
  return StoredExtractionSchema.parse(JSON.parse(json));
}
// Deliberately absent (test asserts the key list): recipient, jid, attendees, calendarId, eventId, sendUpdates, url, approve/auto flags, draft,
// [V2] targetEventId.
// Cross-field coherence (e.g. dateKind='absolute' with isoDate='') is NOT a schema failure: S2 resolve turns it into missing+='date'.

// ---------- event / draft value schemas ----------
const LOCAL_DT = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const SINGLE_LINE = /^[^\r\n\u2028\u2029]*$/;
export const LocalDateTimeSchema = z.string().regex(LOCAL_DT);
export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/);

/** Persisted proposals.event_json (may be incomplete). */
export const ProposedEventSchema = z.strictObject({
  title: z.string().max(LIMITS.titleChars).regex(SINGLE_LINE),
  startLocal: z.union([z.literal(''), LocalDateTimeSchema]),
  endLocal: z.union([z.literal(''), LocalDateTimeSchema]),
  timeZone: TimeZoneSchema,
  location: z.string().max(LIMITS.locationChars).regex(SINGLE_LINE),
  assumptions: z.array(z.enum(ASSUMPTIONS)),
  dateHint: z.string().regex(/^(|\d{4}-\d{2}-\d{2})$/),
});

/** The user-editable part of an event: action:approve `edit` for create_event, and item:completeEvent. TRUSTED but still validated. */
export const EventEditSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(LIMITS.titleChars).regex(SINGLE_LINE),
    startLocal: LocalDateTimeSchema,
    endLocal: LocalDateTimeSchema,
    location: z.string().trim().max(LIMITS.locationChars).regex(SINGLE_LINE),
  })
  .refine((e) => e.endLocal > e.startLocal, { message: 'end<=start' }); // same-format strings compare chronologically
export type EventEdit = z.infer<typeof EventEditSchema>;

export const ReplyEditSchema = z.strictObject({ text: z.string().min(1).max(LIMITS.draftChars) });
export type ReplyEdit = z.infer<typeof ReplyEditSchema>;

// ---------- action payloads: THE thing the user approves (canonical_json) ----------
export const SendReplyPayloadSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('send_reply'),
  itemId: z.number().int().positive(),
  chatRef: z.number().int().positive(),
  proposalVersion: z.number().int().positive(),
  text: z.string().min(0).max(LIMITS.draftChars), // '' on raw cards: the user MUST supply edit.text
});
export const CreateEventPayloadSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('create_event'),
  itemId: z.number().int().positive(),
  chatRef: z.number().int().positive(),
  proposalVersion: z.number().int().positive(),
  title: z.string().max(LIMITS.titleChars),
  startLocal: LocalDateTimeSchema,
  endLocal: LocalDateTimeSchema,
  timeZone: TimeZoneSchema,
  location: z.string().max(LIMITS.locationChars),
});
// ---------- [V2 ADD] event content, update payload, delta (D-036, B20, ARCH-v2 7) ----------
/** Approved event content (title/location UNTRUSTED contact text, cleaned). Same bounds as CreateEventPayloadSchema's content keys. */
export const EventContentSchema = z.strictObject({
  title: z.string().max(LIMITS.titleChars).regex(SINGLE_LINE),
  startLocal: LocalDateTimeSchema,
  endLocal: LocalDateTimeSchema,
  timeZone: TimeZoneSchema,
  location: z.string().max(LIMITS.locationChars).regex(SINGLE_LINE),
});
export type EventContent = z.infer<typeof EventContentSchema>;
export const EventContentWithStatusSchema = EventContentSchema.extend({ status: z.enum(EVENT_STATUSES) });
export type EventContentWithStatus = z.infer<typeof EventContentWithStatusSchema>;
/** Google's event-id alphabet (base32hex). Ours (eventIdFor) are 32 chars. */
export const GOOGLE_EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;

/** THE thing the user approves for a change (I3'): target pinned from items.calendar_event_id at proposal time; applyEdit touches `to` only.
 *  Deliberately absent: calendarId, account, sendUpdates, attendees, recurrence, any tool name, JIDs. */
export const UpdateEventPayloadSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.literal('update_event'),
    itemId: z.number().int().positive(),
    chatRef: z.number().int().positive(),
    proposalVersion: z.number().int().positive(),
    targetEventId: z.string().regex(GOOGLE_EVENT_ID_RE),
    targetItemId: z.number().int().positive(), // the source in_calendar item (items.linked_item_id of the acting item)
    baseRevision: z.number().int().min(1), // compare-and-set against items.event_revision of the target at approve time
    change: z.enum(UPDATE_CHANGES),
    from: EventContentWithStatusSchema,
    to: EventContentWithStatusSchema,
    revertOf: z.number().int().positive().optional(), // event_revisions.id ; present iff change === 'undo'
  })
  .refine((p) => (p.change === 'undo') === (p.revertOf !== undefined), { message: 'revertOf iff undo' })
  .refine((p) => p.change !== 'cancel' || p.to.status === 'cancelled', { message: 'cancel => to.status cancelled' })
  .refine((p) => p.to.status === 'cancelled' || p.to.endLocal > p.to.startLocal, { message: 'end<=start' });
export type UpdateEventPayload = z.infer<typeof UpdateEventPayloadSchema>;

/** [V2 CHANGE] three-way union (zod 4 keeps .refine() checks on the ZodObject itself, so the refined schema is a valid option). */
export const ActionPayloadSchema = z.discriminatedUnion('kind', [
  SendReplyPayloadSchema,
  CreateEventPayloadSchema,
  UpdateEventPayloadSchema,
]);
export type SendReplyPayload = z.infer<typeof SendReplyPayloadSchema>;
export type CreateEventPayload = z.infer<typeof CreateEventPayloadSchema>;
/** The task's "proposed write action": [V2 CHANGE] the ONLY three side effects that exist (send, create, update incl. cancel/undo).
 *  No recipient/JID, calendarId, attendees, URL or tool name inside. */
export type ActionPayload = z.infer<typeof ActionPayloadSchema>;

/** proposals.delta_json (S2 resolveDelta() output, pinned from app rows; B20). Persisted, so it is re-validated on read. */
export const EventDeltaSchema = z.strictObject({
  kind: z.enum(DELTA_KINDS),
  targetEventId: z.string().regex(GOOGLE_EVENT_ID_RE),
  sourceItemId: z.number().int().positive(),
  baseRevision: z.number().int().min(1),
  from: EventContentWithStatusSchema,
  to: EventContentWithStatusSchema,
  confidence: z.enum(CONFIDENCE_LEVELS), // = extraction.changeConfidence after S2 coherence rules
  assumptions: z.array(z.enum(ASSUMPTIONS)),
  problems: z.array(z.enum(['in_past', 'too_far', 'bad_duration', 'weekday_mismatch', 'incoherent_date'])), // == WHEN_PROBLEMS (consistency test)
});
export type EventDelta = z.infer<typeof EventDeltaSchema>;
export const ActionKindSchema = z.enum(ACTION_KINDS);

// ---------- [V2 ADD] V1 READ-IMAGE (B19) - flat, no nulls, no unions, sentinels instead of optionals; ranges enforced by zod ----------
export const IMAGE_READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'readable',
    'kind',
    'readText',
    'language',
    'title',
    'dateText',
    'day',
    'month',
    'year',
    'weekday',
    'timeText',
    'hour',
    'minute',
    'timeAmbiguous',
    'endHour',
    'endMinute',
    'location',
    'confidence',
    'suspicious',
  ],
  properties: {
    readable: { type: 'boolean' },
    kind: { type: 'string', enum: IMAGE_KINDS },
    readText: { type: 'string' },
    language: { type: 'string', enum: ['he', 'en', 'mixed', 'other', 'none'] },
    title: { type: 'string' },
    dateText: { type: 'string' },
    day: { type: 'integer' }, // 0 = not written
    month: { type: 'integer' }, // 0 = not written
    year: { type: 'integer' }, // 0 = not written
    weekday: { type: 'integer' }, // 7 = not written
    timeText: { type: 'string' },
    hour: { type: 'integer' }, // 24 = not written
    minute: { type: 'integer' },
    timeAmbiguous: { type: 'boolean' },
    endHour: { type: 'integer' }, // 24 = not written
    endMinute: { type: 'integer' },
    location: { type: 'string' },
    confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
    suspicious: { type: 'boolean' },
  },
} as const satisfies JsonSchemaLcd;
/** Deliberately absent (test asserts the key list): recipient, jid, attendees, calendarId, eventId, url, phone, approve/auto flags, draft, isoDate. */
export const ImageReadSchema = z.strictObject({
  readable: z.boolean(),
  kind: z.enum(IMAGE_KINDS),
  readText: z.string().max(LIMITS.imageReadTextChars),
  language: z.enum(['he', 'en', 'mixed', 'other', 'none']),
  title: z.string().max(LIMITS.titleChars),
  dateText: z.string().max(60),
  day: z.number().int().min(0).max(31),
  month: z.number().int().min(0).max(12),
  year: z.union([z.literal(0), z.number().int().min(2000).max(2100)]),
  weekday: z.number().int().min(0).max(7),
  timeText: z.string().max(60),
  hour: z.number().int().min(0).max(24),
  minute: z.number().int().min(0).max(59),
  timeAmbiguous: z.boolean(),
  endHour: z.number().int().min(0).max(24),
  endMinute: z.number().int().min(0).max(59),
  location: z.string().max(LIMITS.locationChars),
  confidence: z.enum(CONFIDENCE_LEVELS),
  suspicious: z.boolean(),
});
export type ImageRead = z.infer<typeof ImageReadSchema>;

// ---------- [V2 ADD] automatic-mode policy (B7, B9) ----------
/** scope_json. The max() values ARE the hard ceilings in code: the UI can only make the cage stricter. creates / knownContactsOnly are literals
 *  so no settings patch can turn them off without a code change. Validated with .parse() on write AND on every read. */
export const AutoScopeSchema = z.strictObject({
  creates: z.literal(true),
  knownContactsOnly: z.literal(true),
  edits: z.boolean(),
  cancels: z.boolean(),
  horizonDays: z.number().int().min(1).max(30),
  maxMinutes: z.number().int().min(5).max(240),
  perChatPerDay: z.number().int().min(1).max(3),
  globalPerDay: z.number().int().min(1).max(15),
  moveMaxDays: z.number().int().min(0).max(14),
  quietHours: z.strictObject({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) }).nullable(),
  validityDays: z.union([z.literal(30), z.literal(90)]),
});
export type AutoScope = z.infer<typeof AutoScopeSchema>;
export const DEFAULT_AUTO_SCOPE: AutoScope = {
  creates: true,
  knownContactsOnly: true,
  edits: true,
  cancels: false,
  horizonDays: 30,
  maxMinutes: 240,
  perChatPerDay: 3,
  globalPerDay: 15,
  moveMaxDays: 14,
  quietHours: { from: 22, to: 7 },
  validityDays: 30,
};
/** confirm_json: the record of the main-owned native dialog (I10). Written ONLY by ipc/handlers/auto.ts after dialog.showMessageBox resolved
 *  with response === 1 && checkboxChecked. It IS the auto-mode consent record (no auto_mode consent kind - C6). */
export const AutoPolicyConfirmSchema = z.strictObject({
  dialogResponse: z.literal(1),
  checkboxChecked: z.literal(true),
  windowFocused: z.literal(true),
  trial: z.boolean(),
  appVersion: z.string().max(32),
  electronVersion: z.string().max(32),
  approvedCreates: z.number().int().min(3), // the track record at grant time (B7)
});
export type AutoPolicyConfirm = z.infer<typeof AutoPolicyConfirmSchema>;
/** Input of auto_policies.snapshot_sha = sha256(canonicalJson(this)) (computed in main; shared stays free of node:crypto). */
export interface AutoSnapshotInput {
  targetCalendarId: string;
  googleAccountEmailSha8: string; // first 8 hex of sha256(lowercased account email) ; '' when unknown => AUTO_CALENDAR_NOT_OWNED
  provider: (typeof PROVIDER_IDS)[number];
  appMajorMinor: string; // e.g. '2.0'
}

/** Deterministic serialisation: keys sorted (UTF-16 order) at every level, no whitespace, arrays keep order.
 *  Only strings, finite integers, booleans, arrays, plain objects are allowed (throws otherwise).
 *  content_sha256 = lowercase hex sha256 of the UTF-8 bytes of this string; computed by db/repos/actions.ts on insert
 *  and re-computed by exec/actionHash.ts on approve (shared stays free of node:crypto). */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError('canonicalJson: non-integer');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
        .join(',') +
      '}'
    );
  }
  throw new TypeError('canonicalJson: unsupported value');
}

/** Applied to every LLM output and every user edit before persisting/sending: strips Unicode TAG block, bidi controls, zero-width, C0 (keeps \n).
 *  `[+]` U+2028 / U+2029 are line terminators, not text: `JSON.stringify` escapes \n and \r but emits these two RAW, so
 *  leaving them in lets model output or a user edit author real LINES inside a JSON-encoded block. SINGLE_LINE below and
 *  agent/resolve.ts already treat them as breaks; this makes the strip set agree with them. */
export function stripInvisible(s: string): string {
  return s.replace(
    /[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g,
    '',
  );
}
