// src/main/agent/validate.ts - S4 VALIDATE (deterministic): badges, draft caps, proposal + pending actions (v1 owner W1-10; v2
// V2-W1-03-edit-pipeline). Safety-critical.
// The hash of the action payload is computed inside repos.actions.insertPending (agent/** never imports exec/**).
// NOTHING here sends a message or writes to a calendar: it only records what the user MAY approve later (approval-first).
// [V2] P2 9: the `update_event` insertion rule (all five B20 conditions, mutually exclusive with `create_event`, the only action of a self
// run), the badges change_unclear / from_image / image_unclear / image_unread / change_target_unclear, the cross-chat leak guard (I5'),
// the provenance columns (B25) and the chat taint (B28) - one transaction. AutoGate later READS these facts; it never recomputes them.
import { stripInvisible } from '../../shared/schemas';
import type { Repos } from '../db/index';
import type { Extraction, ImageRead } from '../../shared/schemas';
import { closureFor, type ResolvedSlot } from './resolve';
import type { ExistingEventCtx } from './existingEvent';
import type { DeltaOutcome } from './resolveDelta';
import {
  BADGES,
  LIMITS,
  type ActionId,
  type Badge,
  type BusyBlock,
  type ChatRef,
  type ClosedReason,
  type EpochMs,
  type EventState,
  type Item,
  type ItemId,
  type Lang,
  type MissingField,
  type ProposedEvent,
  type ProviderClass,
  type ProviderId,
  type ReplyState,
  type TriggerAuthor,
  type TriggerKind,
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
  // ---- [V2 ADD] (optional so a v1-shaped caller keeps compiling; every default is the fail-closed / v1 value) ----
  /** findExistingEvent() of this run (null = the chat has no editable event: the v1 path). */
  existing?: ExistingEventCtx | null;
  /** resolveDeltaOutcome() of this run (null = no existing event). */
  deltaOutcome?: DeltaOutcome | null;
  /** [F28] 'self' = the run was triggered by the user's own message: only an update_event may result. */
  triggerAuthor?: TriggerAuthor;
  /** P2 2: rewritten per proposal version from the S1 window. */
  triggerKind?: TriggerKind;
  /** V1's read (proposals.image_json) - null when no picture was read. */
  imageRead?: ImageRead | null;
  /** from_image / image_unclear / image_unread decided by the orchestrator from V1 (P2 4.5, 9.2). */
  imageBadges?: Array<Extract<Badge, 'from_image' | 'image_unclear' | 'image_unread'>>;
  /** B25 provenance (providerClassOf over the runs of this version). Default = the W0 fail-closed default for the provider. */
  providerClass?: ProviderClass;
  blockedCalls?: number;
  contextFromMeRecent?: boolean;
  crossChatRows?: number;
  /** Sanitised texts of WhatsApp rows served from OTHER chats in S3 (memory only) - input of the leak guard. */
  otherChatTexts?: readonly string[];
  /** Sanitised transcripts / picture texts the model saw (the injection heuristic runs over them too, P2 9.2). */
  mediaTexts?: readonly string[];
}
export interface ValidateOutcome {
  badges: Badge[];
  draft: { text: string; lang: Lang } | null; // capped to LIMITS.draftChars, invisible stripped, URLs removed
  event: ProposedEvent | null;
  proposalVersion: number;
  actionsCreated: Array<'send_reply' | 'create_event' | 'update_event'>;
  /** [V2] ids of the pending create_event / update_event of this version, in insertion order: the S5a inputs (P2 9.6 step 2). */
  calendarActionIds: ActionId[];
  /** [V2] the draft was rejected by the cross-chat leak guard (I5'). */
  crossChatLeak: boolean;
}
/**
 * `[+]` The frozen `ValidateInput` of `docs/specs/wave0-seams.md` carries no calendar-connectivity flag, but ARCHITECTURE 6.5
 * requires `create_event` to be proposed ONLY when the calendar is connected. It arrives as an optional trailing argument
 * so the frozen shape is untouched; the default is **false**, i.e. fail closed (no create action).
 * [V2] `updateSurfaceAvailable` (B4): default false - no update_event without a proven update surface (`change_in_google` instead).
 */
export interface ValidateOptions {
  calendarConnected?: boolean;
  updateSurfaceAvailable?: boolean;
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
/** P2 7.2 R5: a `no_change` / unclear outcome proposes no event, so the event-related `missing` entries are dropped. */
const EVENT_MISSING: ReadonlySet<MissingField> = new Set<MissingField>(['date', 'time', 'duration', 'location']);
/** Event states the user or the executor already decided: S4 of a later run never regresses them (v1 rule for `created`). */
const STICKY_EVENT_STATES: ReadonlySet<EventState> = new Set<EventState>(['created', 'updated', 'cancelled']);

/** The W0 fail-closed provenance default (repos/proposals.ts) for a caller that passes no class. */
function defaultProviderClass(p: ProviderId): ProviderClass {
  if (p === 'claude' || p === 'gemini') return 'api_key';
  if (p === 'claude_cli' || p === 'antigravity_cli') return 'cli_unproven';
  return 'local';
}

/** Writes proposal + item update + pending actions in ONE repos.db.transaction. Never sends anything. */
export function validateAndPersist(repos: Repos, input: ValidateInput, opts: ValidateOptions = {}): ValidateOutcome {
  const { item, chat, extraction, slot, replyLang, busy, now } = input;
  const calendarConnected = opts.calendarConnected === true;
  const updateSurfaceAvailable = opts.updateSurfaceAvailable === true;
  const existing = input.existing ?? null;
  const outcome: DeltaOutcome = existing === null ? { path: 'v1' } : (input.deltaOutcome ?? { path: 'v1' });
  const selfRun = input.triggerAuthor === 'self';
  const delta = outcome.path === 'delta' ? outcome.delta : null;

  // ---- draft hygiene (model output) ----
  const ownTexts = repos.items
    .messages(item.id)
    .filter((m) => m.fromMe && m.text !== null)
    .map((m) => m.text!);
  const scrub = input.draftText === null || selfRun ? null : scrubDraft(input.draftText, ownTexts);
  // [V2] I5' cross-chat leak guard: a draft quoting another chat's row is rejected outright (no send_reply, red badge).
  const leaked =
    scrub !== null &&
    scrub.text !== '' &&
    crossChatLeak(scrub.text, input.otherChatTexts ?? [], LIMITS.crossChatLeakWindow);
  const draft = scrub !== null && scrub.text !== '' && !leaked ? { text: scrub.text, lang: replyLang } : null;

  // ---- badges ----
  const mediaInjection = (input.mediaTexts ?? []).some((t) => INJECTION_HEURISTIC_RE.test(t));
  const manipulation =
    input.manipulation ||
    extraction.suspicious ||
    (scrub?.manipulation ?? false) ||
    leaked ||
    mediaInjection ||
    input.imageRead?.suspicious === true;
  const contextBadges: Badge[] = [...input.contextBadges];
  if (scrub?.linkRemoved === true && !leaked) contextBadges.push('link_removed');
  if (scrub?.personalDetails === true && !leaked) contextBadges.push('personal_details');
  // The v1 slot badges (time_assumed / conflict) belong to the v1 path only; a delta carries its own (below).
  const v1Slot = outcome.path === 'v1';
  const derived = deriveBadges({
    slot: v1Slot ? slot : { ...slot, assumptions: [], event: null },
    busy,
    replyLang,
    chat,
    contextBadges,
    manipulation,
  });
  const v2Badges: Badge[] = [...(input.imageBadges ?? [])];
  if (outcome.path === 'unclear') v2Badges.push('change_unclear');
  if (delta !== null) {
    if (delta.assumptions.includes('hour_assumed_pm') || delta.assumptions.includes('hour_assumed_am'))
      v2Badges.push('time_assumed');
    if (existing !== null && existing.editableCount > 1) v2Badges.push('change_target_unclear'); // [F31]
    // free/busy of the NEW slot, minus the event's own block (the orchestrator passes excludeSelf to the prefetch, P2 7.3)
    if (delta.kind === 'reschedule' && busy !== null && overlaps(busy, delta.to.startLocal, delta.to.endLocal))
      v2Badges.push('conflict');
  }
  // The update surface is missing (B4): the delta degrades to the v1 info card - the ONLY case change_in_google is still set (B20).
  const deltaDegraded = delta !== null && (!calendarConnected || !updateSurfaceAvailable);
  if (deltaDegraded && calendarConnected) v2Badges.push('change_in_google');

  // ---- the event this proposal shows (P2 9.1: event_json holds the NEW content of a delta so the card editor works unchanged) ----
  const event: ProposedEvent | null =
    delta !== null
      ? {
          title: delta.to.title,
          startLocal: delta.to.startLocal,
          endLocal: delta.to.endLocal,
          timeZone: delta.to.timeZone,
          location: delta.to.location,
          assumptions: delta.assumptions,
          dateHint: '',
        }
      : v1Slot
        ? slot.event
        : null;

  const actionsCreated: ValidateOutcome['actionsCreated'] = [];
  const calendarActionIds: ActionId[] = [];
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
    // [V2] change_in_google is RETIRED (B20): v1 reschedule / cancel words without an app event only get a draft.
    const badges = orderBadges([...derived, ...extra, ...v2Badges]);

    // ---- sub-states (PIPELINE 5.6 / section 7; P2 7.2 outcome table) ----
    let fresh: EventState;
    let missing: MissingField[];
    switch (outcome.path) {
      case 'delta':
        fresh = deltaDegraded ? 'none' : 'change_proposed';
        missing = [];
        break;
      case 'incomplete':
        fresh = 'incomplete';
        missing = outcome.missing;
        break;
      case 'suppressed':
        // [F32] the rejected change stays rejected: the delta item keeps `declined`
        fresh = live.eventState === 'declined' ? 'declined' : 'none';
        missing = slot.missing.filter((m) => !EVENT_MISSING.has(m));
        break;
      case 'unclear':
      case 'no_change':
        fresh = 'none';
        missing = slot.missing.filter((m) => !EVENT_MISSING.has(m));
        break;
      case 'v1':
        fresh = EVENT_STATE_OF[slot.state];
        missing = slot.missing;
        break;
    }
    if (selfRun && delta === null) missing = [];
    const eventState: EventState = STICKY_EVENT_STATES.has(live.eventState) ? live.eventState : fresh;
    const closedReason: ClosedReason | null = live.closedReason ?? closureOf(input, outcome, selfRun, deltaDegraded);
    const replyState: ReplyState = STICKY_REPLY_STATES.has(live.replyState)
      ? live.replyState
      : draft !== null
        ? 'draft'
        : 'none';
    // A chat re-armed mid-run (ingest.handleInbound / ItemService.retriage set `queued`) must stay queued, or the
    // newer trigger is analysed by nobody and the card shows its preview above a draft that answers the older one.
    const analysis = live.analysis === 'queued' ? 'queued' : 'done';

    // `send_reply` only for a sendable chat (an `@lid` chat is copy-only in v1) and only while the item is still open.
    // [F28] a self run never drafts a reply to the user's own message.
    const sendText =
      !selfRun && draft !== null && chat.sendable && replyState === 'draft' && closedReason === null
        ? draft.text
        : null;
    // `create_event` only for a COMPLETE slot, only while the calendar is connected (ARCHITECTURE 6.5), only on the v1 path
    // (mutually exclusive with update_event, P2 9.1) and never from the user's own message (F28).
    const eventToPropose =
      !selfRun &&
      v1Slot &&
      eventState === 'proposed' &&
      calendarConnected &&
      closedReason === null &&
      event !== null &&
      event.startLocal !== '' &&
      event.endLocal !== ''
        ? event
        : null;
    // `update_event`: B20's five conditions (+ the item is still open).
    const deltaToPropose =
      delta !== null &&
      existing !== null &&
      !deltaDegraded &&
      delta.confidence !== 'low' &&
      existing.status === 'confirmed' &&
      closedReason === null
        ? delta
        : null;

    const blockedCalls = Math.max(0, Math.trunc(input.blockedCalls ?? 0));
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
      // ---- [V2] B25 provenance: written ONCE here; AutoGate reads, never recomputes ----
      delta,
      imageRead: input.imageRead ?? null,
      blockedCalls,
      providerClass: input.providerClass ?? defaultProviderClass(input.provider),
      contextFromMeRecent: input.contextFromMeRecent === true,
      crossChatRows: Math.max(0, Math.trunc(input.crossChatRows ?? 0)),
      triggerAuthor: selfRun ? 'self' : 'contact',
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
        missing,
        badges,
        currentProposalId: proposal.id,
        closedReason,
        // [V2] P2 7.1 / 2: the source event (set or cleared on every run) and the media kind of THIS version's window
        linkedItemId: existing?.sourceItemId ?? null,
        ...(input.triggerKind !== undefined ? { triggerKind: input.triggerKind } : {}),
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
      const a = repos.actions.insertPending({
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
      calendarActionIds.push(a.id);
    }
    if (deltaToPropose !== null) {
      // THE thing the user approves (I3'): target, source item, base revision and `from` are pinned from app rows.
      const a = repos.actions.insertPending({
        itemId: item.id,
        proposalId: proposal.id,
        chatId: chat.id,
        payload: {
          v: 1,
          kind: 'update_event',
          itemId: item.id,
          chatRef: chat.id,
          proposalVersion: proposal.version,
          targetEventId: deltaToPropose.targetEventId,
          targetItemId: deltaToPropose.sourceItemId,
          baseRevision: deltaToPropose.baseRevision,
          change: deltaToPropose.kind,
          from: deltaToPropose.from,
          to: deltaToPropose.to,
        },
        now,
      });
      actionsCreated.push('update_event');
      calendarActionIds.push(a.id);
    }
    // [V2] B28 taint: a manipulation badge or a blocked tool call keeps this chat out of automatic mode for 7 days.
    if (badges.includes('manipulation') || blockedCalls > 0) repos.chats.taint(chat.id, now + LIMITS.autoTaintMs);
    return { version: proposal.version, badges };
  });

  return {
    badges: persisted.badges,
    draft,
    event,
    proposalVersion: persisted.version,
    actionsCreated,
    calendarActionIds,
    crossChatLeak: leaked,
  };
}
export type { ItemId };

/**
 * `[+]` The closure rule of S4 (PIPELINE 5.6 extended by P2 7.2 / F28). A closure only WITHHOLDS pending actions.
 *  - self run: anything but a proposable update closes the item `not_needed` (no create and no reply from the user's own message);
 *  - delta: never closed (the change card is the point of the run);
 *  - incomplete: never closed (the draft asks for the missing piece);
 *  - unclear / no_change / suppressed: closed `not_needed` when no reply is wanted and no draft asks;
 *  - v1: exactly the v1 rule (resolve.ts closureFor); only the badge it once announced (`change_in_google`) is retired (B20).
 */
function closureOf(
  input: ValidateInput,
  outcome: DeltaOutcome,
  selfRun: boolean,
  degraded: boolean,
): ClosedReason | null {
  const x = input.extraction;
  if (selfRun) {
    return outcome.path === 'delta' && !degraded && outcome.delta.confidence !== 'low' ? null : 'not_needed';
  }
  switch (outcome.path) {
    case 'delta':
      return degraded && !x.needsReply ? 'not_needed' : null;
    case 'incomplete':
      return null;
    case 'unclear':
      return !x.needsReply && input.draftText === null ? 'not_needed' : null;
    case 'no_change':
    case 'suppressed':
      return x.needsReply ? null : 'not_needed';
    case 'v1':
      return closureFor(x, input.slot);
  }
}

// ======================= [V2 ADD] C2 15 (exports added to the S4 module) =======================

/**
 * [fix injection-v2-1] Lower-case Cyrillic / Greek letters that render like a Latin letter (the UTS-39 confusables a model can be
 * told to "write in Cyrillic"), folded to that Latin letter. NFKC does not fold them. Applied AFTER the case fold, so the capitals
 * are covered too. A deliberately small, closed table: Hebrew and every other script pass through unchanged.
 */
// prettier-ignore
const CONFUSABLE_TO_LATIN: Readonly<Record<string, string>> = {
  // Cyrillic
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i',
  'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ѵ': 'v', 'ԛ': 'q', 'ԝ': 'w',
  'в': 'b', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'ї': 'i', 'ё': 'e',
  // Greek
  'α': 'a', 'ο': 'o', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't',
  'υ': 'u', 'χ': 'x', 'η': 'n', 'β': 'b', 'ω': 'w', 'γ': 'y',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLE_TO_LATIN).join('')}]`, 'g');
/** NFKC, invisible/bidi strip, whitespace collapse, case fold, [fix injection-v2-1] confusable fold - the normal form both sides of the
 *  leak guard are compared in. */
function leakNormal(s: string): string {
  return stripInvisible(s.normalize('NFKC'))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(CONFUSABLE_RE, (c) => CONFUSABLE_TO_LATIN[c] ?? c);
}
/** [fix injection-v2-1] A whole other-chat row shorter than the window is matched as one string once it has at least this many
 *  normalised characters ("gate code 4242#"); shorter rows ("ok", "see you", "thanks!") are too common to prove anything. */
const LEAK_WHOLE_ROW_MIN = 12;
/** [fix injection-v2-1] Digit runs: any 4-digit window of a digit run of an other-chat row found inside a digit run of the draft is a
 *  leak (a door code, a card's last four, a PIN quoted out of a longer row). A year (19xx / 20xx) is not treated as a secret. */
const LEAK_DIGITS = 4;
const YEAR_RE = /^(?:19|20)\d\d$/;
function digitRuns(s: string): string[] {
  return s.match(/\d+/g) ?? [];
}
// S4 cross-chat leak guard (I5'): any LIMITS.crossChatLeakWindow-char normalised window of a row served from another chat found in the draft
// => reject the draft, badge 'manipulation', reason 'cross_chat_leak'. No-op in trigger_chat scope by construction.
// [fix injection-v2-1] plus: a whole row shorter than the window (>= LEAK_WHOLE_ROW_MIN chars), any non-year 4-digit window of a digit
// run, and homoglyph copies (confusable fold in leakNormal). Still a verbatim guard: a paraphrase ("four-two-four-two") is out of reach.
export function crossChatLeak(draft: string, otherChatTexts: readonly string[], window: number): boolean {
  if (otherChatTexts.length === 0) return false;
  const w = Math.max(1, Math.trunc(window));
  const d = leakNormal(draft);
  if (d === '') return false;
  const draftDigits = digitRuns(d);
  for (const raw of otherChatTexts) {
    const t = leakNormal(raw);
    if (t === '') continue;
    if (t.length < w) {
      if (t.length >= Math.min(LEAK_WHOLE_ROW_MIN, w) && d.includes(t)) return true;
    } else {
      for (let i = 0; i + w <= t.length; i++) {
        if (d.includes(t.slice(i, i + w))) return true;
      }
    }
    for (const run of digitRuns(t)) {
      for (let i = 0; i + LEAK_DIGITS <= run.length; i++) {
        const four = run.slice(i, i + LEAK_DIGITS);
        if (!YEAR_RE.test(four) && draftDigits.some((r) => r.includes(four))) return true;
      }
    }
  }
  return false;
}
/** S4 provenance (B25): provider_class = 'cli_proven' only when the S1 AND S3 runs of this version both have sandbox_ok = 1 ;
 *  'cli_unproven' when a CLI run lacks it ; 'api_key' for claude/gemini ; 'local' for local.
 *  [V2-W1-03] P2 9.4 / concern 4: EVERY LLM run of the version counts (S1 and, when it ran, S3 - and V1); an empty list proves nothing.
 *  [B14/C4, T2 concern 1, D-072] every `antigravity_cli` proposal is `cli_unproven` in v2.0, even with passing init proofs. */
export function providerClassOf(provider: ProviderId, runSandboxOk: ReadonlyArray<boolean | null>): ProviderClass {
  switch (provider) {
    case 'local':
      return 'local';
    case 'claude':
    case 'gemini':
      return 'api_key';
    case 'antigravity_cli':
      return 'cli_unproven';
    case 'claude_cli':
      return runSandboxOk.length > 0 && runSandboxOk.every((ok) => ok === true) ? 'cli_proven' : 'cli_unproven';
  }
}
