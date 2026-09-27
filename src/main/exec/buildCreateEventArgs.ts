// src/main/exec/buildCreateEventArgs.ts
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-11). Safety-critical: ARCH 5.4 / A10 / I7.
// The whitelist below is EXHAUSTIVE: nothing is ever spread from model output, and the description is an app template
// (locale key `calendar.eventDescription`) - never model text and never a contact name.
import { createHash } from 'node:crypto';
import { LIMITS } from '../../shared/types';
import type { ActionId, ApprovalAction } from '../../shared/types';
import { stripInvisible } from '../../shared/schemas';
import type { CreateEventPayload } from '../../shared/schemas';
import type { Settings } from '../../shared/settings';
import type { Repos } from '../db/index';
import type { CreateEventArgs } from '../mcp/writeClient';

/** RFC 4648 base32hex ("extended hex") alphabet, lowercase - exactly the character set Google accepts for a client-supplied event id. */
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

/** Number of digest bytes encoded: 20 bytes = 160 bits = EXACTLY 32 base32 characters, so the encoder never has leftover bits.
 *  (The first 32 characters of base32hex(sha256) depend only on the first 160 bits, so this is the same id as encoding all 32 bytes.) */
const EVENT_ID_BYTES = 20;

/** Encodes a byte count that is a multiple of 5 bits per character with no remainder (see EVENT_ID_BYTES). */
function base32hex(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** URLs are stripped from the summary (ARCH 5.4): the event title is UNTRUSTED text that ends up in the user's calendar. */
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;

/** Single line, invisible characters removed, URLs stripped, whitespace collapsed, capped. */
function cleanField(raw: string, max: number): string {
  return stripInvisible(raw).replace(URL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildCreateEventArgs(
  p: CreateEventPayload,
  chain: { rootActionId: ActionId; chainKey: string },
  settings: Settings,
  opts: { allowDuplicates: boolean; descriptionTemplate: string },
): CreateEventArgs {
  const location = cleanField(p.location, LIMITS.locationChars);
  const args: CreateEventArgs = {
    calendarId: settings.calendar.targetCalendarId,
    account: 'personal',
    summary: cleanField(p.title, LIMITS.titleChars),
    start: p.startLocal,
    end: p.endLocal,
    // The zone the user approved (pinned from settings at proposal time; the model never supplies it - CONTRACTS 1 ProposedEvent).
    timeZone: p.timeZone,
    description: opts.descriptionTemplate,
    sendUpdates: 'none',
    allowDuplicates: opts.allowDuplicates,
    eventId: eventIdFor(chain.chainKey, p),
    extendedProperties: { private: { waAgent: '1', waItem: String(p.itemId), waAction: chain.rootActionId } },
  };
  if (location !== '') args.location = location;
  return args;
}

/** The part of a `CreateEventPayload` that decides WHAT the user approved (the fields `EventEditSchema` lets them change,
 *  plus the pinned zone). The description is an app template and is deliberately NOT part of it: changing the UI language
 *  must not create a second event. */
export type ApprovedEventContent = Pick<
  CreateEventPayload,
  'title' | 'startLocal' | 'endLocal' | 'timeZone' | 'location'
>;

/**
 * [R2] chainKey = idempotency_key without the `:rN` suffix = `${itemId}:create_event:${version}`; identical for the first
 * action and every retry clone, so a retry of the SAME approved content re-sends the SAME eventId and Google answers 409
 * (McpErrorKind 'id_exists') instead of creating a second event.
 *
 * [approval-first fix, W1-11] The APPROVED CONTENT is hashed together with the chain key. A retry card is editable
 * (`applyEdit` accepts a new slot for any pending create_event), so with a chain-only id an EDITED retry re-sent the id of
 * the event the earlier attempt had already created: Google answered 409, `runCreate` mapped that to `done`, and the card
 * claimed "added" while the calendar still held the OLD slot. Binding the id to the content keeps the retry idempotent
 * (same content -> same id -> exactly one event) and makes a second, different approval reach the calendar as its own event.
 */
export function eventIdFor(chainKey: string, content: ApprovedEventContent): string {
  // One JSON array: unambiguous framing, so no field value can be confused with the chain key or with another field.
  const input = JSON.stringify([
    chainKey,
    content.title,
    content.startLocal,
    content.endLocal,
    content.timeZone,
    content.location,
  ]);
  return base32hex(createHash('sha256').update(input, 'utf8').digest().subarray(0, EVENT_ID_BYTES));
}

/** Strips the `:rN` retry suffix of an idempotency key (CONTRACTS 1 `ApprovalAction.idempotencyKey`). */
export function chainKeyOfAction(a: ApprovalAction): string {
  return a.idempotencyKey.replace(/:r\d+$/, '');
}

/** [R2] Follows retry_of to the first action of the chain (its id is stamped as waAction, its key prefix is the chainKey). */
export function chainRootOf(a: ApprovalAction, repos: Repos): { rootActionId: ActionId; chainKey: string } {
  const root = repos.actions.chainRoot(a.id);
  return { rootActionId: root.id, chainKey: chainKeyOfAction(root) };
}
