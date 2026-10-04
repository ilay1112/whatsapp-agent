// CONTRACTS section 18 item 4: EXTRACTION_JSON_SCHEMA keys == ExtractionSchema.shape keys == required; forbidden keys absent.
// Plus canonicalJson / stripInvisible / payload schema behaviour that the safety-critical set relies on (TESTS 13).
import { describe, expect, it } from 'vitest';
import {
  ActionPayloadSchema,
  CreateEventPayloadSchema,
  EXTRACTION_JSON_SCHEMA,
  EventEditSchema,
  ExtractionSchema,
  ProposedEventSchema,
  ReplyEditSchema,
  SendReplyPayloadSchema,
  canonicalJson,
  stripInvisible,
} from './schemas';
import { MISSING_FIELDS } from './types';
import {
  EventDeltaSchema,
  IMAGE_READ_SCHEMA,
  ImageReadSchema,
  StoredExtractionSchema,
  UpdateEventPayloadSchema,
  parseStoredExtraction,
} from './schemas';
import { WHEN_PROBLEMS } from './when';

const FORBIDDEN_KEYS = [
  'recipient',
  'jid',
  'chatJid',
  'attendees',
  'calendarId',
  'eventId',
  'sendUpdates',
  'url',
  'approve',
  'autoApprove',
  'auto',
  'draft',
];

describe('EXTRACTION_JSON_SCHEMA <-> ExtractionSchema', () => {
  const props = Object.keys(EXTRACTION_JSON_SCHEMA.properties);
  it('property keys == zod shape keys == required list', () => {
    expect(props).toEqual(Object.keys(ExtractionSchema.shape));
    expect([...EXTRACTION_JSON_SCHEMA.required]).toEqual(props);
  });
  it('none of the forbidden keys is present', () => {
    for (const k of FORBIDDEN_KEYS) expect(props, k).not.toContain(k);
  });
  it('is flat LCD: no nulls, unions, $ref, min/max, and additionalProperties false', () => {
    const json = JSON.stringify(EXTRACTION_JSON_SCHEMA);
    for (const bad of [
      '"$ref"',
      '"anyOf"',
      '"oneOf"',
      '"nullable"',
      '"minimum"',
      '"maximum"',
      '"minLength"',
      '"maxLength"',
      '"null"',
    ]) {
      expect(json, bad).not.toContain(bad);
    }
    expect(EXTRACTION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...EXTRACTION_JSON_SCHEMA.properties.missing.items.enum]).toEqual([...MISSING_FIELDS]);
  });
  it('accepts a minimal valid extraction and rejects an extra key', () => {
    const ok = {
      intent: 'schedule_request',
      needsReply: true,
      title: 'Coffee',
      dateKind: 'weekday',
      isoDate: '',
      weekday: 4,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '17:00',
      timeAmbiguous: true,
      durationMin: 0,
      location: '',
      missing: [],
      suspicious: false,
      // [V2] C2 5: the four B20 fields are required in model output
      refersToExisting: false,
      change: 'no_change',
      changeConfidence: 'high',
      confidence: 'high',
    };
    expect(ExtractionSchema.safeParse(ok).success).toBe(true);
    expect(ExtractionSchema.safeParse({ ...ok, recipient: '972550000001@s.whatsapp.net' }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...ok, time24h: '25:00' }).success).toBe(false);
    expect(ExtractionSchema.safeParse({ ...ok, isoDate: '2026-13-01' }).success).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level, keeps array order, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1,2]},"b":1}');
  });
  it('rejects non-integers, undefined, class instances', () => {
    expect(() => canonicalJson(1.5)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(null)).toThrow(TypeError);
  });
  it('is stable for a send_reply payload regardless of key order', () => {
    const a = { v: 1, kind: 'send_reply', itemId: 1, chatRef: 2, proposalVersion: 1, text: 'hi' };
    const b = { text: 'hi', proposalVersion: 1, chatRef: 2, itemId: 1, kind: 'send_reply', v: 1 };
    expect(canonicalJson(SendReplyPayloadSchema.parse(a))).toBe(canonicalJson(SendReplyPayloadSchema.parse(b)));
  });
});

describe('stripInvisible', () => {
  it('removes bidi controls, zero-width, TAG block and C0 but keeps newlines and Hebrew', () => {
    const cc = (...codes: number[]) => String.fromCodePoint(...codes);
    const s =
      'a' +
      cc(0x202e) +
      'b' +
      cc(0x200b) +
      'c' +
      cc(0x2066) +
      'd' +
      cc(0x2069) +
      cc(0x07) +
      'e' +
      cc(0x0a) +
      cc(0x5e9, 0x5dc, 0x5d5, 0x5dd) +
      cc(0xe0041) +
      'z';
    expect(stripInvisible(s)).toBe('abcde' + cc(0x0a) + cc(0x5e9, 0x5dc, 0x5d5, 0x5dd) + 'z');
  });
});

describe('action payload schemas', () => {
  it('discriminates on kind and rejects extra keys (no recipient / calendarId / attendees can ride along)', () => {
    const send = { v: 1, kind: 'send_reply', itemId: 1, chatRef: 1, proposalVersion: 1, text: '' };
    expect(ActionPayloadSchema.safeParse(send).success).toBe(true);
    expect(ActionPayloadSchema.safeParse({ ...send, recipient: 'x' }).success).toBe(false);
    const ev = {
      v: 1,
      kind: 'create_event',
      itemId: 1,
      chatRef: 1,
      proposalVersion: 1,
      title: 'Coffee',
      startLocal: '2026-09-24T17:00:00',
      endLocal: '2026-09-24T18:00:00',
      timeZone: 'Asia/Jerusalem',
      location: '',
    };
    expect(CreateEventPayloadSchema.safeParse(ev).success).toBe(true);
    expect(ActionPayloadSchema.safeParse({ ...ev, calendarId: 'primary' }).success).toBe(false);
    expect(ActionPayloadSchema.safeParse({ ...ev, attendees: [] }).success).toBe(false);
  });
  it('EventEditSchema requires end > start, single-line title', () => {
    const base = { title: 'Coffee', startLocal: '2026-09-24T17:00:00', endLocal: '2026-09-24T18:00:00', location: '' };
    expect(EventEditSchema.safeParse(base).success).toBe(true);
    expect(EventEditSchema.safeParse({ ...base, endLocal: base.startLocal }).success).toBe(false);
    expect(EventEditSchema.safeParse({ ...base, title: 'a\nb' }).success).toBe(false);
    expect(EventEditSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
  });
  it('ReplyEditSchema caps at 600 chars and rejects empty', () => {
    expect(ReplyEditSchema.safeParse({ text: '' }).success).toBe(false);
    expect(ReplyEditSchema.safeParse({ text: 'x'.repeat(600) }).success).toBe(true);
    expect(ReplyEditSchema.safeParse({ text: 'x'.repeat(601) }).success).toBe(false);
  });
  it('ProposedEventSchema accepts incomplete events with empty start/end', () => {
    expect(
      ProposedEventSchema.safeParse({
        title: '',
        startLocal: '',
        endLocal: '',
        timeZone: 'Asia/Jerusalem',
        location: '',
        assumptions: [],
        dateHint: '2026-09-24',
      }).success,
    ).toBe(true);
  });
});

// =====================================================================================================================
// [V2] C2 19 items 15, 20, 21, 22 (V2-W0-scaffold)
// =====================================================================================================================
const IMAGE_FORBIDDEN = [
  'recipient',
  'jid',
  'attendees',
  'calendarId',
  'eventId',
  'url',
  'phone',
  'approve',
  'autoApprove',
  'auto',
  'draft',
  'isoDate',
];

describe('C2 19 item 21 - the extraction schema carries exactly the 18 keys', () => {
  it('18 keys, required == properties == zod shape, targetEventId absent', () => {
    expect(Object.keys(EXTRACTION_JSON_SCHEMA.properties)).toHaveLength(18);
    expect(Object.keys(EXTRACTION_JSON_SCHEMA.properties)).not.toContain('targetEventId');
    expect(Object.keys(ExtractionSchema.shape)).not.toContain('targetEventId');
  });
  it('a v1 extraction_json row reads through StoredExtractionSchema with the fail-closed defaults', () => {
    const v1Row = {
      intent: 'schedule_request',
      needsReply: true,
      title: 'Coffee',
      dateKind: 'weekday',
      isoDate: '',
      weekday: 4,
      weekOffset: 0,
      daysFromToday: 0,
      time24h: '17:00',
      timeAmbiguous: false,
      durationMin: 60,
      location: '',
      missing: [],
      suspicious: false,
    };
    expect(ExtractionSchema.safeParse(v1Row).success).toBe(false); // model output stays strict
    expect(parseStoredExtraction(JSON.stringify(v1Row))).toEqual({
      ...v1Row,
      refersToExisting: false,
      change: 'no_change',
      changeConfidence: 'low',
      confidence: 'low',
    });
    expect(StoredExtractionSchema.safeParse({ ...v1Row, recipient: 'x' }).success).toBe(false);
  });
});

describe('C2 19 item 20 - IMAGE_READ_SCHEMA <-> ImageReadSchema', () => {
  const props = Object.keys(IMAGE_READ_SCHEMA.properties);
  it('property keys == zod shape keys == required list; forbidden keys absent', () => {
    expect(props).toEqual(Object.keys(ImageReadSchema.shape));
    expect([...IMAGE_READ_SCHEMA.required]).toEqual(props);
    for (const k of IMAGE_FORBIDDEN) expect(props, k).not.toContain(k);
    expect(IMAGE_READ_SCHEMA.additionalProperties).toBe(false);
  });
});

describe('C2 19 item 22 - EventDeltaSchema problems == WHEN_PROBLEMS', () => {
  it('the literal enum repeats WHEN_PROBLEMS exactly', () => {
    expect([...EventDeltaSchema.shape.problems.element.options]).toEqual([...WHEN_PROBLEMS]);
  });
});

describe('C2 19 item 15 - v1 canonical_json payloads parse with the v2 union and hash the same', () => {
  const sha256 = async (s: string): Promise<string> =>
    Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
  it('send and create payloads written by v1 still parse and re-serialise byte for byte', async () => {
    const v1Send = '{"chatRef":2,"itemId":1,"kind":"send_reply","proposalVersion":1,"text":"See you at five.","v":1}';
    const v1Create =
      '{"chatRef":2,"endLocal":"2026-09-24T18:00:00","itemId":1,"kind":"create_event","location":"","proposalVersion":1,"startLocal":"2026-09-24T17:00:00","timeZone":"Asia/Jerusalem","title":"Coffee","v":1}';
    for (const stored of [v1Send, v1Create]) {
      const parsed = ActionPayloadSchema.parse(JSON.parse(stored));
      expect(canonicalJson(parsed)).toBe(stored);
      expect(await sha256(canonicalJson(parsed))).toBe(await sha256(stored));
    }
  });
  it('update_event: refinements hold through the 3-way union', () => {
    const content = {
      title: 'Coffee',
      startLocal: '2026-09-24T17:00:00',
      endLocal: '2026-09-24T18:00:00',
      timeZone: 'Asia/Jerusalem',
      location: '',
      status: 'confirmed' as const,
    };
    const up = {
      v: 1,
      kind: 'update_event',
      itemId: 3,
      chatRef: 2,
      proposalVersion: 2,
      targetEventId: 'a'.repeat(32),
      targetItemId: 1,
      baseRevision: 1,
      change: 'reschedule',
      from: content,
      to: { ...content, startLocal: '2026-09-24T19:00:00', endLocal: '2026-09-24T20:00:00' },
    };
    expect(ActionPayloadSchema.safeParse(up).success).toBe(true);
    expect(UpdateEventPayloadSchema.safeParse({ ...up, change: 'undo' }).success).toBe(false); // revertOf iff undo
    expect(UpdateEventPayloadSchema.safeParse({ ...up, change: 'cancel' }).success).toBe(false); // cancel => to.status cancelled
    expect(ActionPayloadSchema.safeParse({ ...up, targetEventId: 'NOT_BASE32HEX!' }).success).toBe(false);
    expect(ActionPayloadSchema.safeParse({ ...up, calendarId: 'primary' }).success).toBe(false);
  });
});
