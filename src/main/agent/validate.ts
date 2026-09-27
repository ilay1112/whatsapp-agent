// src/main/agent/validate.ts - S4 VALIDATE (deterministic): badges, draft caps, proposal + pending actions (owner W1-10). Safety-critical.
// The hash of the action payload is computed inside repos.actions.insertPending (agent/** never imports exec/**).
// NOTHING here sends a message or writes to a calendar: it only records what the user MAY approve later (approval-first).
import { stripInvisible } from '../../shared/schemas';
import type { Repos } from '../db/index';
import type { Extraction } from '../../shared/schemas';
import { needsCalendarChangeBadge, closureFor, type ResolvedSlot } from './resolve';
import {
  BADGES,
  LIMITS,
  type Badge,
  type BusyBlock,
  type ChatRef,
  type EpochMs,
  type EventState,
  type Item,
  type ItemId,
  type Lang,
  type ProposedEvent,
  type ProviderId,
  type ReplyState,
} from '../../shared/types';

export interface ValidateInput {
  item: Item;
  chat: { id: ChatRef; sendable: boolean; lang: Lang | null };
  extraction: Extraction;
  slot: ResolvedSlot;
  draftText: string | null; // null when no S3 run
  replyLang: Lang;
  busy: BusyBlock[] | null;
  provider: ProviderId;
  model: string;
  contextBadges: Badge[]; // from contextBuilder (link_removed, personal_details)
  manipulation: boolean; // from S3 (blocked-call abort) or extraction.suspicious
  now: EpochMs;
}
export interface ValidateOutcome {
  badges: Badge[];
  draft: { text: string; lang: Lang } | null; // capped to LIMITS.draftChars, invisible stripped, URLs removed
  event: ProposedEvent | null;
  proposalVersion: number;
  actionsCreated: Array<'send_reply' | 'create_event'>;
}
/**
 * `[+]` The frozen `ValidateInput` of `docs/specs/wave0-seams.md` carries no calendar-connectivity flag, but ARCHITECTURE 6.5
 * requires `create_event` to be proposed ONLY when the calendar is connected. It arrives as an optional trailing argument
 * so the frozen shape is untouched; the default is **false**, i.e. fail closed (no create action).
 */
export interface ValidateOptions {
  calendarConnected?: boolean;
}

/** ARCHITECTURE 6.5, advisory only: a draft that parrots an instruction back gets the red badge, never a silent drop. */
const INJECTION_HEURISTIC_RE = /ignore (all|previous)|system prompt|התעלם מ(ה)?הוראות|you are now|<\/?system>/i;
/** `[+]` Label separators IDNA and WhatsApp both treat as a real `.`, kept in step with agent/sanitize.ts DOT. Unlike
 *  `sanitizeForModel`, `scrubDraft` never NFKC-normalises, so ALL FOUR are listed here, not only U+3002: otherwise a
 *  link the model invented reaches the wire as a working one and RULE 6 of the draft prompt ("do not include links")
 *  is the only control left - which the project's "enforce in code, not prompts" rule forbids (ARCHITECTURE 6.5). */
const DOT = '[.\\u3002\\uFF61\\uFF0E\\u2024]';
/** Same shape as agent/sanitize.ts: a bare domain needs a path, a scheme or a `www.` to count as a link. */
const URL_RE = new RegExp(
  `\\b(?:https?:\\/\\/|www${DOT})[^\\s<>"'\\u0590-\\u05FF]{1,512}` +
    `|\\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:${DOT}[a-z]{2,24}){1,4}\\/[^\\s<>"']{0,512}`,
  'gi',
);
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/;
/** A run of 6+ digits is never a clock time or a date: it is an id, a card number or a phone number.
 *  `[+]` `\p{Nd}`, not `\d`: I5 says no phone number leaves this machine in ANY script, and Arabic-Indic / Persian
 *  digits are ordinary in this product's own locale (NFKC folds only the FULLWIDTH forms, which is what made `\d`
 *  look safe). The leading `+` stays MANDATORY in PHONE_RE: optional, it would match a bare date like 2026-09-24. */
const LONG_DIGITS_RE = /\p{Nd}{6,}/u;
const PHONE_RE = /\+\p{Nd}[\p{Nd}\u00a0 ()\-.]{5,}\p{Nd}/u;

/** Badge order is the order of `BADGES` so a card never re-renders because two runs disagreed about the order. */
function orderBadges(found: Iterable<Badge>): Badge[] {
  const set = new Set(found);
  return BADGES.filter((b) => set.has(b));
}

/** `[start, end)` overlap over same-zone, same-format local strings (they compare chronologically as text). */
function overlaps(busy: BusyBlock[], startLocal: string, endLocal: string): boolean {
  return busy.some((b) => b.startLocal < endLocal && b.endLocal > startLocal);
}

export interface DraftScrub {
  text: string;
  linkRemoved: boolean;
  personalDetails: boolean;
  manipulation: boolean;
}
/**
 * `[+]` ARCHITECTURE 6.5 applied to the DRAFT (model output, UNTRUSTED): a URL survives only when the user wrote it in this
 * chat themselves; everything else is cut. Because the model only ever saw `sanitizeForModel()`ed text (URLs already replaced
 * by `[link]`), `ownTexts` practically never contains one - the effective rule is "the app never sends a link the model invented".
 */
export function scrubDraft(raw: string, ownTexts: readonly string[]): DraftScrub {
  let linkRemoved = false;
  const text = stripInvisible(raw)
    .replace(URL_RE, (m) => {
      if (ownTexts.some((t) => t.includes(m))) return m;
      linkRemoved = true;
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, LIMITS.draftChars);
  return {
    text,
    linkRemoved,
    personalDetails: EMAIL_RE.test(text) || LONG_DIGITS_RE.test(text) || PHONE_RE.test(text),
    manipulation: INJECTION_HEURISTIC_RE.test(text),
  };
}

/** Pure badge derivation (time_assumed, conflict, lang_mismatch, manipulation, ...). */
export function deriveBadges(
  input: Pick<ValidateInput, 'slot' | 'busy' | 'replyLang' | 'chat' | 'contextBadges' | 'manipulation'>,
): Badge[] {
  const found = new Set<Badge>(input.contextBadges);
  const { slot } = input;
  if (slot.assumptions.includes('hour_assumed_pm') || slot.assumptions.includes('hour_assumed_am'))
    found.add('time_assumed');
  if (input.manipulation) found.add('manipulation');
  if (input.chat.lang !== null && input.chat.lang !== input.replyLang) found.add('lang_mismatch');
  const event = slot.event;
  if (
    input.busy !== null &&
    slot.state === 'complete' &&
    event !== null &&
    event.startLocal !== '' &&
    event.endLocal !== '' &&
    overlaps(input.busy, event.startLocal, event.endLocal)
  ) {
    found.add('conflict');
  }
  return orderBadges(found);
}

const EVENT_STATE_OF: Record<ResolvedSlot['state'], EventState> = {
  none: 'none',
  incomplete: 'incomplete',
  complete: 'proposed',
};
/** A reply state the user or the phone already decided; S4 never overwrites it with a fresh draft state. */
const STICKY_REPLY_STATES: ReadonlySet<ReplyState> = new Set<ReplyState>(['sent', 'answered_elsewhere']);

/** Writes proposal + item update + pending actions in ONE repos.db.transaction. Never sends anything. */
export function validateAndPersist(repos: Repos, input: ValidateInput, opts: ValidateOptions = {}): ValidateOutcome {
  const { item, chat, extraction, slot, replyLang, busy, now } = input;
  const calendarConnected = opts.calendarConnected === true;

  // ---- draft hygiene (model output) ----
  const ownTexts = repos.items
    .messages(item.id)
    .filter((m) => m.fromMe && m.text !== null)
    .map((m) => m.text!);
  const scrub = input.draftText === null ? null : scrubDraft(input.draftText, ownTexts);
  const draft = scrub !== null && scrub.text !== '' ? { text: scrub.text, lang: replyLang } : null;

  // ---- badges ----
  const manipulation = input.manipulation || extraction.suspicious || (scrub?.manipulation ?? false);
  const contextBadges: Badge[] = [...input.contextBadges];
  if (scrub?.linkRemoved === true) contextBadges.push('link_removed');
  if (scrub?.personalDetails === true) contextBadges.push('personal_details');
  const derived = deriveBadges({ slot, busy, replyLang, chat, contextBadges, manipulation });
  const event = slot.event;

  const actionsCreated: Array<'send_reply' | 'create_event'> = [];
  const persisted = repos.db.transaction(() => {
    /**
     * `[+]` `input.item` is the snapshot the orchestrator read BEFORE the provider calls - up to
     * `LIMITS.draftWallClockLocalMs` (240 s) old. In that window the user can Dismiss the card, an executor can land a
     * send/create outcome (exec/outcome.ts) and ingest can re-arm the chat. Deriving the sub-states from the SNAPSHOT
     * silently reverted all three: a dismissed card came back with an approvable draft, an `in_calendar` card regressed
     * to `needs_reply` with a duplicate `create_event`, and a mid-run re-arm was stamped `done` and lost. So the row is
     * re-read INSIDE this transaction and the live values win - the same convention exec/outcome.ts already follows.
     * Nothing here sends or writes: a closure only WITHHOLDS pending actions, it never approves one (approval-first).
     */
    const live = repos.items.byId(item.id) ?? item;

    // `older_message` is stamped by ingest and describes the trigger row, not this run: it survives every re-triage.
    const extra: Badge[] = live.badges.filter((b) => b === 'older_message');
    // v1 never edits or deletes a Google event (ARCHITECTURE A10): a reschedule/cancel only tells the user to change it there.
    if (needsCalendarChangeBadge(extraction)) extra.push('change_in_google');
    const badges = orderBadges([...derived, ...extra]);

    // ---- sub-states (PIPELINE 5.6 / section 7) ----
    const eventState: EventState = live.eventState === 'created' ? 'created' : EVENT_STATE_OF[slot.state];
    const closedReason = live.closedReason ?? closureFor(extraction, slot);
    const replyState: ReplyState = STICKY_REPLY_STATES.has(live.replyState)
      ? live.replyState
      : draft !== null
        ? 'draft'
        : 'none';
    // A chat re-armed mid-run (ingest.handleInbound / ItemService.retriage set `queued`) must stay queued, or the
    // newer trigger is analysed by nobody and the card shows its preview above a draft that answers the older one.
    const analysis = live.analysis === 'queued' ? 'queued' : 'done';

    // `send_reply` only for a sendable chat (an `@lid` chat is copy-only in v1) and only while the item is still open.
    const sendText =
      draft !== null && chat.sendable && replyState === 'draft' && closedReason === null ? draft.text : null;
    // `create_event` only for a COMPLETE slot and only while the calendar is connected (ARCHITECTURE 6.5).
    const eventToPropose =
      eventState === 'proposed' &&
      calendarConnected &&
      closedReason === null &&
      event !== null &&
      event.startLocal !== '' &&
      event.endLocal !== ''
        ? event
        : null;

    const proposal = repos.proposals.insertNext({
      itemId: item.id,
      provider: input.provider,
      model: input.model,
      extraction,
      draftText: draft?.text ?? null,
      replyLang: draft !== null ? replyLang : null,
      event,
      freeBusy: busy,
      suspicious: manipulation,
      createdAt: now,
    });
    // A card the user can still see must never stay approvable once a newer version exists (ARCHITECTURE 8.1).
    repos.actions.supersedePending(item.id, now);
    repos.items.update(
      item.id,
      {
        analysis,
        holdReason: null,
        errorCode: null,
        replyState,
        eventState,
        missing: slot.missing,
        badges,
        currentProposalId: proposal.id,
        closedReason,
      },
      now,
    );
    if (sendText !== null) {
      repos.actions.insertPending({
        itemId: item.id,
        proposalId: proposal.id,
        chatId: chat.id,
        payload: {
          v: 1,
          kind: 'send_reply',
          itemId: item.id,
          chatRef: chat.id,
          proposalVersion: proposal.version,
          text: sendText,
        },
        now,
      });
      actionsCreated.push('send_reply');
    }
    if (eventToPropose !== null) {
      repos.actions.insertPending({
        itemId: item.id,
        proposalId: proposal.id,
        chatId: chat.id,
        payload: {
          v: 1,
          kind: 'create_event',
          itemId: item.id,
          chatRef: chat.id,
          proposalVersion: proposal.version,
          title: eventToPropose.title,
          startLocal: eventToPropose.startLocal,
          endLocal: eventToPropose.endLocal,
          timeZone: eventToPropose.timeZone,
          location: eventToPropose.location,
        },
        now,
      });
      actionsCreated.push('create_event');
    }
    return { version: proposal.version, badges };
  });

  return {
    badges: persisted.badges,
    draft,
    event,
    proposalVersion: persisted.version,
    actionsCreated,
  };
}
export type { ItemId };
