// src/main/agent/stage0.ts - S0 deterministic filter (build-plan section 3; owner W1-10). Safety-critical (TESTS 13). No LLM.
// The gate order is ARCHITECTURE 6.1 / PIPELINE section 3, first match wins. Nothing here sends text anywhere: the message is
// only inspected for structural facts (JID shape, media type, emptiness) - never interpreted.
import type { Repos } from '../db/index';
import type { Settings } from '../../shared/settings';
import {
  DM_LID_JID_RE,
  DM_PHONE_JID_RE,
  LIMITS,
  type Chat,
  type ChatRef,
  type EpochMs,
  type HoldReason,
  type Item,
  type Message,
  type ProviderId,
} from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';

export interface Stage0Input {
  chat: Chat;
  message: Message; // the row being classified (text UNTRUSTED; S0 never sends it anywhere)
  /** Backlog gate facts computed by ingest (ARCHITECTURE 4.6 / CONTRACTS section 12). */
  isLive: boolean; // false => context only (before live_from_ts, or syncing + older than syncMaxAgeMs)
  isOlderLive: boolean; // live but older than LIMITS.ingestMaxAgeMs => raw card with badge 'older_message', no LLM run
  hasOpenItem: boolean;
  nowMs: EpochMs;
  /** [V2-W1-07, F28 - optional, additive] ingest found the user's OWN text row (not an app send) in a chat whose findExistingEvent() is
   *  non-null: step 1 waives ONLY its from_me rule for a self-trigger candidate (text row, DM, not deleted, not a reaction, non-empty);
   *  every later gate (backlog, policy, pause, provider/consent, budgets, edit-lock) applies unchanged. Absent => v1 (from_me drops). */
  selfTrigger?: boolean;
}
export type Stage0Verdict =
  | { kind: 'drop' } // own message / reaction / deleted / empty / media without text / policy 'never'
  | { kind: 'context_only' } // backlog: stored as context, never a trigger
  | { kind: 'no_item' } // nothing to do (e.g. sticker)
  | { kind: 'held'; reason: HoldReason; code?: ErrorCode } // unknown_sender | paused | waiting_llm | budget -> raw card ; [v2-repair] code = why (CLOUD_QUOTA)
  | { kind: 'deferred'; until: EpochMs } // rate/budget window; re-evaluate later
  | { kind: 'queued' }; // enqueue the chat for S1
export type Stage0Fn = (input: Stage0Input) => Stage0Verdict;

export interface Stage0Deps {
  repos: Pick<Repos, 'chats' | 'items' | 'rate' | 'consents'>;
  settings: () => Settings;
  providerUsable: () => { ok: true } | { ok: false; code: ErrorCode }; // ProviderFactory.usable()
  paused: () => boolean;
  /**
   * WIRING CONTRACT (W2-01): `cloudDailyTokenBudget()` returns the tokens **REMAINING** for the current local day -
   * `settings.llm.cloudDailyTokenBudget` (the configured ceiling) MINUS `repos.runs.cloudTokensSince(startOfDay)`.
   * S0 holds the item as soon as it is `<= 0`, so handing it the raw ceiling would disable the budget gate entirely.
   */
  budgets: { llmRunsPerChatPerHour: number; llmRunsGlobalPerHour: number; cloudDailyTokenBudget: () => number };
  now: () => EpochMs;
  /** [V2-W1-07 refinement - optional, additive; REQUESTS -> V2-W2-01] true when the resolved voice tier's model AND the VAD file are
   *  ready (ModelManager). Absent => false: a voice note is a held raw card, never a whisper job (fail closed, P2 2 item 1). */
  voiceReady?: () => boolean;
}

const HOUR_MS = 3_600_000;

/** Consent record a cloud provider needs before ANY of the user's message text may leave the machine (ARCHITECTURE 6.1 step 5). */
const CLOUD_CONSENT = { claude: 'cloud_claude', gemini: 'cloud_gemini' } as const;

/** Structural "never a trigger" facts of ARCHITECTURE 6.1 step 1 / PIPELINE 1.3. Pure; the text is only measured, never read.
 *  [V2] P2 2: an inbound audio (voice note) or image row is NOT "empty" although its content is '' - S0 decides below by settings.
 *  video / document / sticker keep the v1 rule (a caption may trigger; no caption = context only). */
export function isNeverTriggerRow(m: Message): boolean {
  const isDm = DM_PHONE_JID_RE.test(m.chatJid) || DM_LID_JID_RE.test(m.chatJid);
  const voiceOrImage = m.mediaType === 'audio' || m.mediaType === 'image';
  return !isDm || m.fromMe || m.deleted || m.mediaType === 'reaction' || (m.text.trim() === '' && !voiceOrImage);
}

/** [V2-W1-07, F28 / P2 2 item 5] A row that may be a SELF trigger: the user's own non-empty TEXT row in a DM (no media, not deleted, not a
 *  reaction). A from_me voice row is not a candidate at ingest time: its transcript can only exist after V0, which runs inside runChat. */
export function isSelfTriggerCandidate(m: Message): boolean {
  const isDm = DM_PHONE_JID_RE.test(m.chatJid) || DM_LID_JID_RE.test(m.chatJid);
  return isDm && m.fromMe && !m.deleted && m.mediaType === '' && m.text.trim() !== '';
}

/** Gate order of PIPELINE section 3. Pure given its deps. */
export function createStage0(deps: Stage0Deps): Stage0Fn {
  const { repos, settings, providerUsable, paused, budgets } = deps;

  return (input: Stage0Input): Stage0Verdict => {
    const now = Number.isFinite(input.nowMs) ? input.nowMs : deps.now();

    // 1. Non-DM / reaction / empty / deleted / from_me - never a trigger (ingest already filters these; S0 re-checks).
    // [V2, F28] ... except the self-trigger candidate ingest flagged (only the from_me rule is waived; the rest of the gates follow).
    const selfCandidate = input.selfTrigger === true && isSelfTriggerCandidate(input.message);
    if (isNeverTriggerRow(input.message) && !selfCandidate) return { kind: 'drop' };

    // 2. Backlog - stored as context for the window, never a trigger.
    if (!input.isLive) return { kind: 'context_only' };

    // The policy / known flags are re-read from the DB: the caller's snapshot may predate a "never" or "Analyse this chat" click.
    const chat: Chat = repos.chats.byId(input.chat.id) ?? input.chat;
    const cfg = settings();

    // [V2] 2b. A picture without a caption triggers only while pictures are on (P2 2 item 2; the sniff happens later in V1 - S0 never
    // fetches bytes). Off => context only, exactly like v1.
    if (input.message.mediaType === 'image' && input.message.text.trim() === '' && !cfg.images.enabled)
      return { kind: 'context_only' };

    // 3. Chat policy 'never' - no item at all. ([R2] the 'local_only' policy is cut from v1.)
    if (chat.policy === 'never') return { kind: 'no_item' };

    // 4. Unknown-sender gate (A13), default ON: a stranger costs nothing and reaches no model until the user opts in.
    if (!cfg.whatsapp.processUnknownSenders && !chat.isKnown && !chat.forceKnown) {
      return { kind: 'held', reason: 'unknown_sender' };
    }

    // 5a. Kill switch.
    if (paused()) return { kind: 'held', reason: 'paused' };

    // 5b. No usable provider (model downloading, key missing, consent missing).
    const usable = providerUsable();
    // [v2-repair REQUEST 7] B13: an exhausted subscription window holds the chat as budget (CLOUD_QUOTA) until resetsAt; compose releases
    // it by itself (releaseQuotaHeldItems) once the provider is usable again. Every other reason waits for the provider as before.
    if (!usable.ok) {
      return usable.code === 'CLOUD_QUOTA'
        ? { kind: 'held', reason: 'budget', code: 'CLOUD_QUOTA' }
        : { kind: 'held', reason: 'waiting_llm' };
    }
    const consentKind = CLOUD_CONSENT[cfg.llm.provider as keyof typeof CLOUD_CONSENT] as
      (typeof CLOUD_CONSENT)[keyof typeof CLOUD_CONSENT] | undefined;
    // Defence in depth: the factory checks this too, but a missing consent must never be one bug away from a cloud call.
    if (consentKind !== undefined && !repos.consents.isCurrent(consentKind))
      return { kind: 'held', reason: 'waiting_llm' };

    // 5c. LLM budgets (ARCHITECTURE 6.1: 6 runs/h per chat, 60 runs/h global, cloud daily token budget).
    if (repos.rate.countSince('llm_chat', String(chat.id), now - HOUR_MS) >= budgets.llmRunsPerChatPerHour) {
      return { kind: 'held', reason: 'budget' };
    }
    if (repos.rate.countSince('llm_global', 'global', now - HOUR_MS) >= budgets.llmRunsGlobalPerHour) {
      return { kind: 'held', reason: 'budget' };
    }
    // `cloudDailyTokenBudget()` is the allowance LEFT for today (see ops/agent-notes/W1-10-agent-pipeline.md, REQUESTS -> W2-01).
    if (consentKind !== undefined && budgets.cloudDailyTokenBudget() <= 0) return { kind: 'held', reason: 'budget' };

    // [V2] 5d. A voice note is a live trigger only when voice is on AND its model + VAD are ready; otherwise a held raw card "Voice message"
    // with the download / "Turn on in Settings" action (P2 2 item 1). The earlier gates (stranger, pause, provider, budgets) already ran,
    // so a stranger's voice note never costs a whisper job.
    if (input.message.mediaType === 'audio' && (!cfg.voice.enabled || !(deps.voiceReady?.() ?? false))) {
      return { kind: 'held', reason: 'waiting_llm' };
    }

    // 6. Edit-lock: the user is typing in the card, so its shownHash must stay valid - defer, never drop.
    if (input.hasOpenItem) {
      const open = repos.items.openForChat(chat.id);
      if (open !== null && open.editingUntil > now) return { kind: 'deferred', until: open.editingUntil };
    }

    // 7. Run it.
    return { kind: 'queued' };
  };
}

/**
 * `[+]` ARCHITECTURE 6.1 step 5 / PIPELINE section 3: release of `held/waiting_llm` items once a provider becomes usable.
 * To the **Local** provider every held item is released, oldest first. To a **cloud** provider only items whose trigger is
 * within `LIMITS.heldReleaseWindowMs` (24 h) - the consent text describes analysing a chat, not a week of backlog; older
 * items stay raw cards with "Analyse this chat". Returns the released item ids (oldest trigger first).
 */
export function releaseHeldItems(
  repos: Pick<Repos, 'items' | 'queue'>,
  opts: { provider: ProviderId; now: EpochMs },
): number[] {
  const { provider, now } = opts;
  const held: Item[] =
    provider === 'local'
      ? repos.items.heldWith('waiting_llm')
      : repos.items.heldWith('waiting_llm', { triggerTsSince: now - LIMITS.heldReleaseWindowMs });
  const released: number[] = [];
  const chats = new Set<ChatRef>();
  for (const item of held) {
    repos.items.update(item.id, { analysis: 'queued', holdReason: null, errorCode: null }, now);
    released.push(item.id);
    chats.add(item.chatId);
  }
  for (const chatId of chats) repos.queue.enqueue(chatId, now);
  return released;
}

/**
 * [v2-repair REQUEST 7] Release of the chats an exhausted CLI subscription window held (held/budget with errorCode CLOUD_QUOTA, set by S0
 * or by the orchestrator on USAGE_LIMIT). Called by compose only when the provider is usable again (the window reset). v1 budget holds
 * (runs/h, cloud daily tokens - no error code) are NOT touched: they keep their "Analyse this chat" action. Oldest trigger first.
 */
export function releaseQuotaHeldItems(repos: Pick<Repos, 'items' | 'queue'>, now: EpochMs): number[] {
  const released: number[] = [];
  const chats = new Set<ChatRef>();
  for (const item of repos.items.heldWith('budget')) {
    if (item.errorCode !== 'CLOUD_QUOTA') continue;
    repos.items.update(item.id, { analysis: 'queued', holdReason: null, errorCode: null }, now);
    released.push(item.id);
    chats.add(item.chatId);
  }
  for (const chatId of chats) repos.queue.enqueue(chatId, now);
  return released;
}
