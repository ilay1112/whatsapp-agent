// src/main/agent/orchestrator.ts - runs one chat through the pipeline (v1 owner W1-10; v2 V2-W1-03-edit-pipeline). Never imports exec/**.
// ONE provider per run (never a mid-run fallback, ARCHITECTURE section 8). The only thing a run can produce is a proposal plus
// PENDING actions - approval-first means nothing here can send or write. The one v2 exception to "nothing after S4" is S5a: the
// orchestrator hands each pending calendar action to the INJECTED `tryAuto` (exec/actionExecutor.ts, wired by compose.ts), which applies
// its own deterministic gates (AutoGate) - this file never approves anything itself.
// [V2] P2 1 order: V0 TRANSCRIBE -> trigger re-check (P2 3.4) -> V1 READ-IMAGE (a failure never blocks S1) -> findExistingEvent -> S1 ->
// S2 (resolveWhen | resolveDelta | image_absolute) -> S3 (skipped for a self run, F28) -> S4 -> S5a tryAuto -> dashboard:changed.
import type {
  ActionId,
  AutoReason,
  AutoVerdict,
  Badge,
  Message,
  ProviderClass,
  ProviderId,
  TriggerKind,
} from '../../shared/types';
import type { VoiceStageResult } from '../voice/service';
import type { NormalizedImage } from '../media/normalizeImage';
import { imageBadgesOf, newestImageRow, readerOf, type readImageStage, type ReadImageOutcome } from './readImage';
import { existingEventBlock, findExistingEvent, type ExistingEventCtx } from './existingEvent';
import { FEATURE_GATES, type ProviderFeatureGates } from './gates';
import { buildDayTable, todayIn, type WhenContext } from '../../shared/when';
import { LIMITS, type BusyBlock, type ChatRef, type EpochMs, type Lang } from '../../shared/types';
import type { EventContentWithStatus, Extraction, ImageRead } from '../../shared/schemas';
import {
  NO_RETRY_PROVIDER_ERRORS,
  providerErrorToErrorCode,
  type ErrorCode,
  type ProviderErrorCode,
} from '../../shared/errors';
import type { Clock, Logger, RandomSource } from '../deps';
import type { Repos } from '../db/index';
import {
  ConsentRequiredError,
  LlmError,
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
  type ProviderFactory,
} from '../llm/types';
import type { CliSandboxProof } from '../../shared/types';
import type { RunCtx, ToolGate } from './toolGate';
import { createHandleTable } from './handles';
import type { Ingest } from '../bridge/ingest';
import type { Settings } from '../../shared/settings';
import { buildContext, type DraftDeltaView, type ImageTextAttachment } from './contextBuilder';
import { buildSystemPrompt } from './prompt';
import { detectReplyLang } from './replyLang';
import { resolveExtractionWithImage, resolveImageDate, type ResolvedSlot } from './resolve';
import { resolveDeltaOutcome, type DeltaOutcome } from './resolveDelta';
import { runExtract } from './extract';
import { runDraft, type DraftInput } from './draft';
import { providerClassOf, validateAndPersist } from './validate';
import { sanitizeForModel } from './sanitize';
import { TriageRetryError } from './queue';

export interface OrchestratorDeps {
  repos: Repos;
  providers: ProviderFactory;
  gate: ToolGate;
  ingest: Pick<Ingest, 'contextFor'>;
  settings: () => Settings;
  clock: Clock;
  random: RandomSource; // nonce
  log: Logger;
  notifyChanged: (itemIds: number[]) => void;
  onItemCreated?: (itemId: number) => void; // notifications
}

// ======================= [V2 ADD] v2-build-plan section 3 seam (V2-W0-scaffold; owner V2-W1-03-edit-pipeline, wired by V2-W2-01) =======================
/** [W0 refinement] The seam names `AutoOutcome`; agent/** may not import exec/** (not even types - lint rule), so it is the structural
 *  twin of exec/actionExecutor.ts `AutoDecisionOutcome` (C2 14). compose.ts passes `(id) => executor.tryAuto(id)`. */
export type AutoOutcome =
  | { verdict: 'none'; reason: 'no_policy' }
  | {
      verdict: AutoVerdict;
      reason: AutoReason;
      decisionId: string;
      autoWriteId: string | null;
      result: 'done' | 'failed' | 'unknown_outcome' | null;
    };
/** `tryAuto` is a function value so agent/** never imports exec/**. */
export type OrchestratorDepsV2 = OrchestratorDeps & {
  voice: { transcribeChat(chatId: ChatRef, signal: AbortSignal): Promise<VoiceStageResult> };
  readImage: typeof readImageStage;
  /** [W0 refinement] `window` = the context window (normalised bridge rows) the image trigger is picked from. */
  pickImage(chatId: ChatRef, window: readonly Message[]): Promise<NormalizedImage | null>;
  existingEvent: typeof findExistingEvent;
  tryAuto(actionId: ActionId): Promise<AutoOutcome>;
  onTranscribing(seconds: number | null): void;
  featureGates: (p: ProviderId) => ProviderFeatureGates;
};

/**
 * [V2-W1-03] What `createOrchestrator` accepts: the v1 deps, every v2 member OPTIONAL (a v1-shaped caller keeps compiling and keeps the
 * v1 behaviour; each default is the fail-closed one: no transcription, no picture reading, no automatic decision), plus one member the
 * frozen seam does not carry:
 *  - `updateSurfaceAvailable` (B4 / P2 9.1): McpHost.updateSurface() - `false` (the default) degrades every delta to the v1
 *    `change_in_google` info card, so no `update_event` is ever proposed without a proven update surface. REQUEST -> V2-W2-01 (wiring).
 */
export type OrchestratorDepsIn = OrchestratorDeps &
  Partial<Omit<OrchestratorDepsV2, keyof OrchestratorDeps>> & {
    updateSurfaceAvailable?: () => boolean;
    /** [V2-W2-01 fix-up] The raw window INCLUDING audio rows without a transcript (bridge/ingest.ts `mediaWindowFor`): `contextFor` omits
     *  every non-done audio row (C2 12), so V0 cannot find pending notes through it. Absent => the context window (v1 callers). */
    audioWindow?: (chatId: ChatRef) => readonly Message[];
  };

export interface Orchestrator {
  /** One full pipeline run for the chat's open item: extract -> resolve -> (draft) -> validate. Records runs rows. */
  runChat(chatId: ChatRef, signal: AbortSignal): Promise<void>;
}

/** PIPELINE 10.1 output budgets. The schema is tiny, the draft is 1-2 sentences; the rest is headroom for tool turns. */
export const EXTRACT_MAX_OUTPUT_TOKENS = 512;
export const DRAFT_MAX_OUTPUT_TOKENS_CLOUD = 2048;
export const DRAFT_MAX_OUTPUT_TOKENS_LOCAL = 512;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** An abort that came from Pause / quit, not from the provider - the item goes back to `queued` and nothing is lost. */
class RunAborted extends Error {}

// ---------------------------------------------------------------------------------------------------------------------
// pure helpers (exported for the unit tables)
// ---------------------------------------------------------------------------------------------------------------------

/** The text a row contributes (an audio row: its done transcript; '' when there is none). */
export function rowText(m: Message): string {
  if (m.mediaType === 'audio') return m.voice?.transcript ?? '';
  return m.text;
}

/** P2 3.4: does the row still carry something S1 can read (text, a done transcript, or a picture V1 read / tried to read)? */
export function isUsableTrigger(m: Message, pictureTried: boolean): boolean {
  if (m.deleted) return false;
  if (m.mediaType === 'image') return pictureTried || sanitizeForModel(m.text).text.trim() !== '';
  return sanitizeForModel(rowText(m)).text.trim() !== '';
}

/**
 * The trigger rows of the item: the inbound rows from the item's trigger message on (a later message re-arms the same item). A window
 * that no longer holds the trigger row (a fixture, an unparseable timestamp) falls back to the rows at or after the trigger time, then to
 * the newest inbound row - never to an empty set while inbound rows exist.
 */
export function triggerRowsOf(window: readonly Message[], triggerMsgId: string, triggerTs: EpochMs): Message[] {
  const inbound = window.filter((m) => !m.fromMe && !m.deleted);
  const at = inbound.findIndex((m) => m.waMsgId === triggerMsgId);
  if (at >= 0) return inbound.slice(at);
  const since = inbound.filter((m) => m.ts !== null && m.ts >= triggerTs);
  return since.length > 0 ? since : inbound.slice(-1);
}

/** The text of an approved outbound action (post-edit wins), or null when it is not a reply or the payload is gone. */
function approvedReplyText(json: string | null | undefined): string | null {
  if (json === null || json === undefined || json === '') return null;
  try {
    const parsed = JSON.parse(json) as { kind?: unknown; text?: unknown };
    return parsed.kind === 'send_reply' && typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

/**
 * [F28] Is `row` (the newest row of the window, from_me) an app send? An app send is a `send_reply` of this chat's open item or of the
 * source item of its editable event that reached `executing` / `done` / `unknown_outcome` and whose recorded message id or approved
 * text equals the row. Only rows that are NOT app sends can be self triggers.
 */
export function isAppSend(repos: Pick<Repos, 'actions'>, itemIds: readonly number[], row: Message): boolean {
  for (const id of itemIds) {
    for (const a of repos.actions.forItem(id)) {
      if (a.kind !== 'send_reply') continue;
      if (a.state !== 'executing' && a.state !== 'done' && a.state !== 'unknown_outcome') continue;
      if (a.result?.kind === 'send_reply' && a.result.waMsgId !== null && a.result.waMsgId === row.waMsgId) return true;
      const text = approvedReplyText(a.approvedFinalJson) ?? approvedReplyText(a.canonicalJson);
      if (text !== null && text === row.text) return true;
    }
  }
  return false;
}

/**
 * [F28, P2 2 item 5] The self trigger: the newest row of the window is the user's own text (or a from_me voice note with a done
 * transcript) that is not an app send, and the chat has an editable event. Without an editable event from_me rows stay non-triggers (v1).
 */
export function selfTriggerRow(
  repos: Pick<Repos, 'actions'>,
  window: readonly Message[],
  existing: ExistingEventCtx | null,
  openItemId: number,
): Message | null {
  if (existing === null) return null;
  const newest = window.at(-1);
  if (newest === undefined || !newest.fromMe || newest.deleted) return null;
  if (newest.mediaType !== '' && newest.mediaType !== 'audio') return null;
  if (sanitizeForModel(rowText(newest)).text.trim() === '') return null;
  if (isAppSend(repos, [openItemId, existing.sourceItemId], newest)) return null;
  return newest;
}

/** P2 2: `trigger_kind` per proposal version - 'voice' if the model saw an inbound transcript, else 'image' if it saw picture text, the
 *  run had a picture trigger that could not be read, or [fix injection-v2-3] the picture's digits shaped the slot (S2 image branch,
 *  `imageMerge.used`) even though V1 returned no picture text; else 'text'. Conservative on purpose (media-derived is never automatic, B8). */
export function triggerKindOfRun(p: {
  voiceInWindow: boolean;
  imageInWindow: boolean;
  imageTriggerUnread: boolean;
  /** [fix injection-v2-3] resolveExtractionWithImage() filled the date and/or time from V1's digits. */
  imageShapedSlot?: boolean;
}): TriggerKind {
  if (p.voiceInWindow) return 'voice';
  if (p.imageInWindow || p.imageTriggerUnread || p.imageShapedSlot === true) return 'image';
  return 'text';
}

/** P2 8.1: the S3 `app_computed.delta` view of an S2 outcome (`from` = the existing event as approved). */
export function draftDeltaOf(outcome: DeltaOutcome | null, existing: ExistingEventCtx | null): DraftDeltaView | null {
  if (outcome === null || existing === null) return null;
  const from: EventContentWithStatus = {
    title: existing.title,
    startLocal: existing.startLocal,
    endLocal: existing.endLocal,
    timeZone: existing.timeZone,
    location: existing.location,
    status: 'confirmed',
  };
  switch (outcome.path) {
    case 'v1':
      return null;
    case 'delta':
      return { change: outcome.delta.kind, from, to: outcome.delta.to, confidence: outcome.delta.confidence };
    case 'incomplete':
      return { change: 'reschedule', from, to: null, missing: outcome.missing };
    case 'unclear':
      return { change: 'unclear', from, to: null };
    case 'no_change':
    case 'suppressed':
      return { change: 'no_change', from, to: null };
  }
}

/** P2 7.4 for R6: the picture's date / time as the delta resolver consumes them (only when the read carries a usable date or time). */
export function imageWhenOf(
  read: ImageRead | null,
  today: string,
): { date: string | null; time24h: string; timeAmbiguous: boolean } | null {
  if (read === null || !read.readable) return null;
  const date = read.day > 0 && read.month > 0 ? resolveImageDate(read, today).date : '';
  const time24h =
    read.hour >= 24 ? '' : `${String(read.hour).padStart(2, '0')}:${String(read.minute).padStart(2, '0')}`;
  if (date === '' && time24h === '') return null;
  return { date: date === '' ? null : date, time24h, timeAmbiguous: read.timeAmbiguous };
}

export function createOrchestrator(deps: OrchestratorDepsIn): Orchestrator {
  const { repos, providers, gate, ingest, settings, clock, random, log, notifyChanged } = deps;
  const existingEventOf = deps.existingEvent ?? findExistingEvent;
  const featureGates = deps.featureGates ?? ((p: ProviderId): ProviderFeatureGates => FEATURE_GATES[p]);
  const onTranscribing = deps.onTranscribing ?? ((): void => undefined);
  const updateSurfaceAvailable = deps.updateSurfaceAvailable ?? ((): boolean => false);

  /** Accumulates `onUsage` callbacks of one stage into the `runs` row (metadata only: counts, never text). */
  const usageSink = (): { usage: LlmUsage; onUsage: (u: LlmUsage) => void } => {
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    return {
      usage,
      onUsage: (u) => {
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
      },
    };
  };

  /** V0 results live in app.db `transcripts` (never on the bridge row): attach the done ones to the audio rows of the window. */
  const attachTranscripts = (chatJid: string, window: Message[]): Message[] =>
    window.map((m) => {
      if (m.mediaType !== 'audio') return m;
      const t = repos.transcripts.get(chatJid, m.waMsgId);
      if (t === null || t.status !== 'done' || t.text === null || t.text === '') return { ...m, voice: null };
      return { ...m, voice: { transcript: t.text, language: t.language, seconds: t.seconds } };
    });

  return {
    async runChat(chatId: ChatRef, signal: AbortSignal): Promise<void> {
      const startedAt = clock.now();
      const chat = repos.chats.byId(chatId);
      if (chat === null) return;
      const item = repos.items.openForChat(chatId);
      if (item === null) return;
      if (item.analysis !== 'queued' && item.analysis !== 'running') return;
      // The queue defers an edit-locked chat; this is the second line of defence so a card's shownHash cannot move under the user.
      if (item.editingUntil > startedAt) return;

      const cfg = settings();
      const tz = cfg.general.timeZone;

      let provider: LlmProvider;
      try {
        provider = await providers.get();
      } catch (e) {
        // [v2-repair REQUEST 7] B13 / P2 9: an exhausted subscription window (the provider-start smoke hit USAGE_LIMIT) holds the
        // chat as budget with CLOUD_QUOTA; compose releases it by itself once the window has reset (releaseQuotaHeldItems).
        if (e instanceof LlmError && e.code === 'usage_limit') {
          repos.items.update(
            item.id,
            { analysis: 'held', holdReason: 'budget', errorCode: 'CLOUD_QUOTA' },
            clock.now(),
          );
          notifyChanged([item.id]);
          log.info('triage_no_provider', { chatId, code: 'CLOUD_QUOTA' });
          return;
        }
        const code: ErrorCode = e instanceof ConsentRequiredError ? 'CONSENT_REQUIRED' : 'LLM_NOT_READY';
        repos.items.update(item.id, { analysis: 'held', holdReason: 'waiting_llm', errorCode: code }, clock.now());
        notifyChanged([item.id]);
        log.info('triage_no_provider', { chatId, code });
        return;
      }

      const isLocal = provider.id === 'local';
      repos.items.update(item.id, { analysis: 'running' }, startedAt);
      notifyChanged([item.id]);
      repos.rate.record('llm_chat', String(chatId), startedAt);
      repos.rate.record('llm_global', 'global', startedAt);

      const failItem = (code: ErrorCode): void => {
        repos.items.update(item.id, { analysis: 'failed', errorCode: code }, clock.now());
        notifyChanged([item.id]);
        log.info('triage_failed', { chatId, itemId: item.id, code });
      };
      /** Retryable provider trouble: the item stays queued and the QUEUE applies the 1/5/30 min backoff. */
      const retry = (code: ErrorCode): never => {
        repos.items.update(item.id, { analysis: 'queued', errorCode: code }, clock.now());
        notifyChanged([item.id]);
        throw new TriageRetryError(code);
      };
      /** Maps a provider failure onto the item, then either returns (terminal) or throws (retry / abort). */
      const handleProviderError = (reason: ProviderErrorCode): void => {
        if (reason === 'aborted') {
          repos.items.update(item.id, { analysis: 'queued' }, clock.now());
          notifyChanged([item.id]);
          throw new RunAborted();
        }
        if (reason === 'usage_limit') {
          // [v2-repair REQUEST 7] USAGE_LIMIT -> held/budget until resetsAt (never 'failed': nothing is wrong with the chat)
          repos.items.update(
            item.id,
            { analysis: 'held', holdReason: 'budget', errorCode: 'CLOUD_QUOTA' },
            clock.now(),
          );
          notifyChanged([item.id]);
          log.info('triage_held_quota', { chatId, itemId: item.id });
          throw new RunAborted();
        }
        const code = providerErrorToErrorCode(provider.id, reason);
        if (reason === 'bad_output' || NO_RETRY_PROVIDER_ERRORS.includes(reason)) {
          failItem(code);
          throw new RunAborted();
        }
        retry(code);
      };

      try {
        // ---------------- context (one chat only, I5) ----------------
        let rawWindow = ingest.contextFor(chatId, LIMITS.contextMessages);

        // ---------------- V0 TRANSCRIBE (local whisper job; P2 3) ----------------
        let voiceDeferred = false;
        const pendingAudio = (deps.audioWindow?.(chatId) ?? rawWindow).some((m) => {
          if (m.mediaType !== 'audio' || m.deleted) return false;
          const t = repos.transcripts.get(chat.jid, m.waMsgId);
          return t === null || t.status === 'failed' || t.status === 'aborted';
        });
        if (deps.voice !== undefined && pendingAudio && cfg.voice.enabled) {
          onTranscribing(0); // the queue header line; the exact seconds arrive through the voice service's own progress hook
          try {
            const v0 = await deps.voice.transcribeChat(chatId, signal);
            voiceDeferred = v0.deferred;
          } finally {
            onTranscribing(null);
          }
          if (signal.aborted) {
            repos.items.update(item.id, { analysis: 'queued' }, clock.now());
            notifyChanged([item.id]);
            return;
          }
          // [V2-W2-01 fix-up] contextFor admits an audio row only with a 'done' transcript: re-read the window now that V0 wrote them
          rawWindow = ingest.contextFor(chatId, LIMITS.contextMessages);
        }
        const messages = attachTranscripts(chat.jid, rawWindow);

        // ---------------- existing event (B20; re-evaluated on every run) ----------------
        const existing = existingEventOf(repos, chatId, clock.now());
        const selfRow = selfTriggerRow(repos, messages, existing, item.id);
        const selfRun = selfRow !== null;

        // ---------------- V1 READ-IMAGE (P2 4; tool-less; a failure never blocks S1) ----------------
        const imagesOn = cfg.images.enabled;
        // one picture per run: the newest inbound picture among the TRIGGER rows (older pictures reach S1 with their caption only)
        const inboundTriggers = triggerRowsOf(messages, item.triggerMsgId, item.triggerTs);
        const pictureRow = imagesOn && !selfRun ? newestImageRow(inboundTriggers) : null;
        const pictureIsTrigger = pictureRow !== null;
        let imageRead: ImageRead | null = null;
        let imageOutcome: ReadImageOutcome | null = null;
        let imageText: ImageTextAttachment | null = null;
        if (pictureRow !== null) {
          const nonceV1 = hex(random.bytes(8));
          const normalised = deps.pickImage !== undefined ? await deps.pickImage(chatId, messages) : null;
          if (normalised !== null && deps.readImage !== undefined) {
            imageOutcome = await deps.readImage(
              {
                chatId,
                itemId: item.id,
                image: normalised,
                captionSanitised: sanitizeForModel(pictureRow.text).text.trim(),
                nowMs: item.triggerTs,
                timeZone: tz,
                nonce: nonceV1,
              },
              signal,
            );
          } else {
            // P2 4.1 [refinement]: a successful read of THIS picture already exists (the media cache holds it and the item's current
            // proposal carries the read) => V1 does not run again; otherwise the picture is unread (no route / unavailable / rejected).
            const cached = repos.mediaCache.get(chatId, pictureRow.waMsgId);
            const previous = item.currentProposalId !== null ? repos.proposals.current(item.id) : null;
            if (cached !== null && previous !== null && previous.imageRead !== null) {
              imageOutcome = { ok: true, read: previous.imageRead, route: 'local', runId: 0 };
            } else {
              imageOutcome = { ok: false, badge: 'image_unread', reason: 'no_route' };
            }
          }
          if (signal.aborted) {
            repos.items.update(item.id, { analysis: 'queued' }, clock.now());
            notifyChanged([item.id]);
            return;
          }
          if (imageOutcome.ok) {
            imageRead = imageOutcome.read;
            if (imageRead.readable && imageRead.readText !== '')
              imageText = { waMsgId: pictureRow.waMsgId, readText: imageRead.readText, kind: imageRead.kind };
          }
        }

        // ---------------- trigger re-check after V0 / V1 (P2 3.4) ----------------
        const triggers = selfRun ? [selfRow] : inboundTriggers;
        const usable = triggers.some((m) => isUsableTrigger(m, m.waMsgId === pictureRow?.waMsgId));
        if (!usable) {
          const now = clock.now();
          // [v2-repair REQUEST 4] `contextFor` admits an audio row only with a DONE transcript, so a note whose V0 failed is not in
          // `messages` at all: look for it among the trigger rows of the raw media window (the rows V0 itself read), or the item would
          // close not_needed and the raw "Voice message" card with its VOICE_* action (P2 3.4 / 3.5) would never be shown.
          const audioTriggers = selfRun
            ? triggers
            : triggerRowsOf(deps.audioWindow?.(chatId) ?? rawWindow, item.triggerMsgId, item.triggerTs);
          const failedVoice = audioTriggers
            .filter((m) => m.mediaType === 'audio')
            .map((m) => repos.transcripts.get(chat.jid, m.waMsgId))
            .find((t) => t !== null && (t.status === 'failed' || t.status === 'aborted'));
          if (failedVoice !== undefined && failedVoice !== null) {
            // the only trigger is a voice note whose transcript failed: a raw card with its VOICE_* code and its one action
            failItem(failedVoice.errorCode ?? 'VOICE_LOCAL_FAILED');
            return;
          }
          if (voiceDeferred) {
            // the note is still waiting for its transcript (F33 per-run budget): run the chat again, behind the others
            repos.items.update(item.id, { analysis: 'queued' }, now);
            repos.queue.enqueue(chatId, now);
            notifyChanged([item.id]);
            return;
          }
          // an empty voice note (or nothing left to read) never triggers (B18): closed without an S1 run
          repos.items.update(
            item.id,
            {
              analysis: 'done',
              closedReason: 'not_needed',
              closedAt: now,
              linkedItemId: existing?.sourceItemId ?? null,
            },
            now,
          );
          notifyChanged([item.id]);
          log.info('triage_not_needed', { chatId, itemId: item.id, llmRuns: 0 });
          return;
        }

        const anchorMs: EpochMs = Math.max(item.triggerTs, selfRow?.ts ?? 0); // PIPELINE 5.1: the trigger's timestamp, never Date.now()
        const nowIso = new Date(anchorMs).toISOString();
        const dayTable = buildDayTable(anchorMs, tz);
        const nonce = hex(random.bytes(8));
        const chatLangBefore: Lang | null = chat.lang;
        const inboundNewestFirst = messages
          .filter((m) => !m.fromMe)
          .map(rowText)
          .reverse();
        const replyLang = detectReplyLang(
          inboundNewestFirst,
          chatLangBefore ?? (cfg.general.language === 'he' ? 'he' : 'en'),
        );
        if (chatLangBefore === null) repos.chats.touch(chatId, { lang: replyLang });

        const eventBlock = existingEventBlock(existing);
        const extractCtx = buildContext({
          messages,
          nonce,
          dayTable,
          nowIso,
          timeZone: tz,
          replyLang,
          stage: 'extract',
          existingEvent: eventBlock,
          imageText,
          anchorMs,
        });
        repos.items.snapshotMessages(
          item.id,
          extractCtx.snapshot.map((s) => ({ ...s, itemId: item.id })),
        );

        // ---------------- S1 EXTRACT ----------------
        const sandboxOk: Array<boolean | null> = [];
        const extractRunId = repos.runs.start({
          itemId: item.id,
          stage: 'extract',
          provider: provider.id,
          model: provider.model,
          startedAt: clock.now(),
        });
        const extractUsage = usageSink();
        let extractProof: CliSandboxProof | null = null;
        const extracted = await runExtract(provider, {
          systemPrompt: buildSystemPrompt({
            stage: 'extract',
            nowIso,
            tz,
            replyLang,
            userGender: cfg.agent.userGender,
            nonce,
          }),
          userMessage: extractCtx.userMessage,
          signal,
          maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
          onUsage: extractUsage.onUsage,
          onSandbox: (p) => {
            extractProof = p;
          },
        });
        repos.runs.finish(extractRunId, {
          finishedAt: clock.now(),
          outcome: extracted.ok ? 'ok' : 'failed',
          inputTokens: extractUsage.usage.inputTokens,
          outputTokens: extractUsage.usage.outputTokens,
          errorCode: extracted.ok ? null : providerErrorToErrorCode(provider.id, extracted.reason),
        });
        const s1Proof = extractProof as CliSandboxProof | null;
        if (s1Proof !== null) {
          repos.runs.finishCli(extractRunId, {
            sandboxOk: s1Proof.initOk && s1Proof.mismatch === null,
            sandboxProof: s1Proof,
          });
          sandboxOk.push(s1Proof.initOk && s1Proof.mismatch === null);
        } else {
          sandboxOk.push(null);
        }
        if (!extracted.ok) {
          handleProviderError(extracted.reason);
          return;
        }
        // [F28] a self run never drafts a reply to the user's own message
        const extraction: Extraction = selfRun ? { ...extracted.extraction, needsReply: false } : extracted.extraction;

        // ---------------- S2 RESOLVE (+ free/busy prefetch, [R2]) ----------------
        const whenCtx: WhenContext = {
          nowMs: anchorMs,
          timeZone: tz,
          defaultDurationMin: cfg.calendar.defaultDurationMin,
          ambiguousHour: cfg.agent.ambiguousHour,
        };
        const merged = resolveExtractionWithImage(extraction, imageRead, whenCtx);
        const { imageMerge, ...slotOnly } = merged;
        const slot: ResolvedSlot = slotOnly;
        const triggerText = triggers.map(rowText).join('\n');
        const deltaOutcome: DeltaOutcome | null =
          existing === null
            ? null
            : resolveDeltaOutcome(extraction, existing, whenCtx, triggerText, {
                rejectedTos: repos.actions.rejectedDeltaTo(existing.eventId, existing.revision),
                image: imageWhenOf(imageRead, todayIn(tz, anchorMs)),
              });
        const onV1Path = deltaOutcome === null || deltaOutcome.path === 'v1';

        const calendarConnected = gate.exposedTools().some((t) => t.name === 'get_freebusy');
        let busy: BusyBlock[] | null = null;
        const prefetchCtx = { nowMs: clock.now(), timeZone: tz, signal, itemId: item.id, chatId };
        const slotEvent = slot.event;
        if (onV1Path && slot.state === 'complete' && calendarConnected && slotEvent !== null) {
          busy = await gate.prefetchFreeBusy(
            { startLocal: slotEvent.startLocal, endLocal: slotEvent.endLocal },
            prefetchCtx,
          );
        } else if (
          deltaOutcome !== null &&
          deltaOutcome.path === 'delta' &&
          deltaOutcome.delta.kind === 'reschedule' &&
          calendarConnected
        ) {
          // P2 7.3: the new slot, minus the block exactly equal to the event's own slot (cancel / move do not prefetch)
          const d = deltaOutcome.delta;
          busy = await gate.prefetchFreeBusy({ startLocal: d.to.startLocal, endLocal: d.to.endLocal }, prefetchCtx, {
            startLocal: d.from.startLocal,
            endLocal: d.from.endLocal,
          });
        }

        // ---------------- S3 DRAFT (only when a reply is wanted; never on a self run) ----------------
        let draftText: string | null = null;
        let manipulation = extraction.suspicious;
        let blockedCalls = 0;
        let crossChatRows = 0;
        let otherChatTexts: string[] = [];
        if (extraction.needsReply && !selfRun) {
          const draftCtx = buildContext({
            messages,
            nonce,
            dayTable,
            nowIso,
            timeZone: tz,
            replyLang,
            busy,
            slot, // PIPELINE 6.1: the app-computed slot + missing[] the draft rules 3/4/5 refer to
            stage: 'draft',
            existingEvent: eventBlock,
            imageText,
            anchorMs,
            delta: draftDeltaOf(deltaOutcome, existing),
          });
          const draftMessages: LlmMessage[] = [
            {
              role: 'system',
              content: buildSystemPrompt({
                stage: 'draft',
                nowIso,
                tz,
                replyLang,
                userGender: cfg.agent.userGender,
                nonce,
              }),
            },
            { role: 'user', content: draftCtx.userMessage },
          ];
          const wallClockMs = isLocal ? LIMITS.draftWallClockLocalMs : LIMITS.draftWallClockCloudMs;
          const draftRunId = repos.runs.start({
            itemId: item.id,
            stage: 'draft',
            provider: provider.id,
            model: provider.model,
            startedAt: clock.now(),
          });

          // Wall clock on the INJECTED clock (virtual in tests), folded together with the caller's Pause signal.
          const ac = new AbortController();
          const onAbort = (): void => ac.abort();
          if (signal.aborted) ac.abort();
          else signal.addEventListener('abort', onAbort, { once: true });
          const timer = clock.setTimeout(() => ac.abort(), wallClockMs);
          const runCtx: RunCtx = {
            runId: draftRunId,
            itemId: item.id,
            chatId,
            nowMs: clock.now(),
            timeZone: tz,
            nonce,
            calls: {},
            totalCalls: 0,
            blockedCalls: 0,
            // [V2] C2 10 RunCtx additions: run-scoped handles (the trigger chat is always chat_1) + what the WhatsApp tools served
            handles: createHandleTable(chatId),
            waRowsServed: 0,
            crossChatRows: 0,
            otherChatTexts: [],
            signal: ac.signal,
          };
          const draftUsage = usageSink();
          let draftProof: CliSandboxProof | null = null;
          // `onSandbox` is not (yet) a DraftInput member: carried as an extra property so a draft.ts that forwards it records the S3 proof.
          // REQUEST -> V2-W1-06 (DraftInput.onSandbox forwarded into CallOpts on the agentic / prefetch loops).
          const draftInput: DraftInput = Object.assign(
            {
              messages: draftMessages,
              ctx: runCtx,
              gate,
              maxOutputTokens: isLocal ? DRAFT_MAX_OUTPUT_TOKENS_LOCAL : DRAFT_MAX_OUTPUT_TOKENS_CLOUD,
              wallClockMs,
              onUsage: draftUsage.onUsage,
            },
            {
              onSandbox: (p: CliSandboxProof) => {
                draftProof = p;
              },
            },
          );
          let drafted;
          try {
            drafted = await runDraft(provider, draftInput);
          } finally {
            clock.clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
          }
          repos.runs.finish(draftRunId, {
            finishedAt: clock.now(),
            outcome: drafted.ok ? 'ok' : 'failed',
            inputTokens: draftUsage.usage.inputTokens,
            outputTokens: draftUsage.usage.outputTokens,
            toolCalls: drafted.ok ? drafted.toolCalls : 0,
            blockedToolCalls: drafted.blockedToolCalls,
            waRowsServed: runCtx.waRowsServed,
            errorCode:
              drafted.ok || drafted.reason === 'aborted_manipulation' || drafted.reason === 'max_turns'
                ? null
                : 'LLM_BAD_OUTPUT',
          });
          const s3Proof = draftProof as CliSandboxProof | null;
          if (s3Proof !== null) {
            repos.runs.finishCli(draftRunId, {
              sandboxOk: s3Proof.initOk && s3Proof.mismatch === null,
              sandboxProof: s3Proof,
            });
            sandboxOk.push(s3Proof.initOk && s3Proof.mismatch === null);
          } else if (provider.loop === 'agentic') {
            // draft.ts discards every agentic run without its init proof (reason 'sandbox'), so an ok draft IS a proven run;
            // anything else proves nothing.
            sandboxOk.push(drafted.ok ? true : null);
          } else {
            sandboxOk.push(null);
          }
          crossChatRows = runCtx.crossChatRows;
          otherChatTexts = runCtx.otherChatTexts;
          // P2 9.4: gate strikes + (agentic) the CLI runner's strikes of this S3 run
          blockedCalls = Math.max(runCtx.blockedCalls, provider.loop === 'agentic' ? drafted.blockedToolCalls : 0);
          if (drafted.ok) {
            draftText = drafted.text;
            manipulation = manipulation || drafted.manipulation;
          } else if (drafted.reason === 'aborted_manipulation') {
            // The run is over but the card is not lost: it becomes a manipulation-badged item with no draft.
            manipulation = true;
            blockedCalls = Math.max(blockedCalls, drafted.blockedToolCalls, 1);
            log.warn('triage_manipulation', { chatId, itemId: item.id, blockedToolCalls: drafted.blockedToolCalls });
          } else if (drafted.reason === 'max_turns') {
            failItem('LLM_BAD_OUTPUT');
            return;
          } else {
            handleProviderError(drafted.reason);
            return;
          }
        }

        // ---------------- S4 VALIDATE ----------------
        const readerGates = (p: ProviderId): boolean => featureGates(p).imagesPassed;
        const imageBadges: Array<Extract<Badge, 'from_image' | 'image_unclear' | 'image_unread'>> = [];
        const contextBadges: Badge[] = [...extractCtx.badges];
        let imageSuspicious = false;
        if (imageOutcome !== null) {
          const reader = imageOutcome.ok ? readerOf(imageOutcome.route, provider.id) : provider.id;
          for (const b of imageBadgesOf(imageOutcome, reader, readerGates)) {
            if (b === 'manipulation') imageSuspicious = true;
            else if (b === 'from_image' || b === 'image_unclear' || b === 'image_unread') imageBadges.push(b);
          }
        }
        if (imageMerge !== null) {
          if (imageMerge.used && !imageBadges.includes('from_image')) imageBadges.push('from_image');
          if (imageMerge.unclear && !imageBadges.includes('image_unclear')) imageBadges.push('image_unclear');
          if (imageMerge.conflict) contextBadges.push('conflict');
        }
        const providerClass: ProviderClass = providerClassOf(provider.id, sandboxOk);
        const now = clock.now();
        const outcome = validateAndPersist(
          repos,
          {
            item,
            chat: { id: chat.id, sendable: chat.sendable, lang: chatLangBefore },
            extraction,
            slot,
            draftText,
            replyLang,
            busy,
            provider: provider.id,
            model: provider.model,
            contextBadges,
            manipulation: manipulation || imageSuspicious,
            now,
            existing,
            deltaOutcome,
            triggerAuthor: selfRun ? 'self' : 'contact',
            triggerKind: triggerKindOfRun({
              voiceInWindow: extractCtx.voiceInWindow || (selfRun && selfRow.mediaType === 'audio'),
              imageInWindow: extractCtx.imageInWindow,
              imageTriggerUnread: pictureIsTrigger && imageOutcome !== null && !imageOutcome.ok,
              imageShapedSlot: imageMerge?.used === true,
            }),
            imageRead,
            imageBadges,
            providerClass,
            blockedCalls,
            contextFromMeRecent: extractCtx.contextFromMeRecent,
            crossChatRows,
            otherChatTexts,
            mediaTexts: extractCtx.mediaTexts,
          },
          { calendarConnected, updateSurfaceAvailable: calendarConnected && updateSurfaceAvailable() },
        );
        if (voiceDeferred) {
          // F33: the notes beyond this run's transcription budget are still pending - the chat runs again, behind the others.
          repos.items.update(item.id, { analysis: 'queued' }, clock.now());
          repos.queue.enqueue(chatId, clock.now());
        }

        // ---------------- S5a: the automatic decision point (P2 9.6 step 2 / 10) - BEFORE dashboard:changed ----------------
        if (deps.tryAuto !== undefined) {
          for (const actionId of outcome.calendarActionIds) {
            try {
              const auto = await deps.tryAuto(actionId);
              log.info('triage_auto', { chatId, itemId: item.id, verdict: auto.verdict, reason: auto.reason });
            } catch (e) {
              // the card stays an ordinary pending card: a failure of the automatic path never costs the manual one
              log.warn('triage_auto_error', { chatId, itemId: item.id, name: e instanceof Error ? e.name : 'unknown' });
            }
          }
        }

        notifyChanged([item.id]);
        log.info('triage_done', {
          chatId,
          itemId: item.id,
          version: outcome.proposalVersion,
          actions: outcome.actionsCreated.length,
          badges: outcome.badges.length,
          durationMs: clock.now() - startedAt,
          self: selfRun,
          delta: deltaOutcome?.path ?? 'none',
        });
        if (outcome.proposalVersion === 1) {
          const fresh = repos.items.byId(item.id);
          if (fresh !== null && (fresh.state === 'needs_reply' || fresh.state === 'info_missing'))
            deps.onItemCreated?.(item.id);
        }
      } catch (e) {
        if (e instanceof RunAborted) return;
        throw e;
      }
    },
  };
}
