// src/main/agent/orchestrator.ts - runs S1..S4 for one chat (build-plan section 3; owner W1-10). Never imports exec/**.
// ONE provider per run (never a mid-run fallback, ARCHITECTURE section 8). The only thing a run can produce is a proposal plus
// PENDING actions - approval-first means nothing here can send or write.
import { buildDayTable } from '../../shared/when';
import { LIMITS, type BusyBlock, type ChatRef, type EpochMs, type Lang } from '../../shared/types';
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
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
  type ProviderFactory,
} from '../llm/types';
import type { RunCtx, ToolGate } from './toolGate';
import type { Ingest } from '../bridge/ingest';
import type { Settings } from '../../shared/settings';
import { buildContext } from './contextBuilder';
import { buildSystemPrompt } from './prompt';
import { detectReplyLang } from './replyLang';
import { resolveExtraction } from './resolve';
import { runExtract } from './extract';
import { runDraft } from './draft';
import { validateAndPersist } from './validate';
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

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { repos, providers, gate, ingest, settings, clock, random, log, notifyChanged } = deps;

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
        const code = providerErrorToErrorCode(provider.id, reason);
        if (reason === 'bad_output' || NO_RETRY_PROVIDER_ERRORS.includes(reason)) {
          failItem(code);
          throw new RunAborted();
        }
        retry(code);
      };

      try {
        // ---------------- context (one chat only, I5) ----------------
        const messages = ingest.contextFor(chatId, LIMITS.contextMessages);
        const anchorMs: EpochMs = item.triggerTs; // PIPELINE 5.1: the trigger's timestamp, never Date.now()
        const nowIso = new Date(anchorMs).toISOString();
        const dayTable = buildDayTable(anchorMs, tz);
        const nonce = hex(random.bytes(8));
        const chatLangBefore: Lang | null = chat.lang;
        const inboundNewestFirst = messages
          .filter((m) => !m.fromMe)
          .map((m) => m.text)
          .reverse();
        const replyLang = detectReplyLang(
          inboundNewestFirst,
          chatLangBefore ?? (cfg.general.language === 'he' ? 'he' : 'en'),
        );
        if (chatLangBefore === null) repos.chats.touch(chatId, { lang: replyLang });

        const extractCtx = buildContext({
          messages,
          nonce,
          dayTable,
          nowIso,
          timeZone: tz,
          replyLang,
          stage: 'extract',
        });
        repos.items.snapshotMessages(
          item.id,
          extractCtx.snapshot.map((s) => ({ ...s, itemId: item.id })),
        );

        // ---------------- S1 EXTRACT ----------------
        const extractRunId = repos.runs.start({
          itemId: item.id,
          stage: 'extract',
          provider: provider.id,
          model: provider.model,
          startedAt: clock.now(),
        });
        const extractUsage = usageSink();
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
        });
        repos.runs.finish(extractRunId, {
          finishedAt: clock.now(),
          outcome: extracted.ok ? 'ok' : 'failed',
          inputTokens: extractUsage.usage.inputTokens,
          outputTokens: extractUsage.usage.outputTokens,
          errorCode: extracted.ok ? null : providerErrorToErrorCode(provider.id, extracted.reason),
        });
        if (!extracted.ok) {
          handleProviderError(extracted.reason);
          return;
        }
        const extraction = extracted.extraction;

        // ---------------- S2 RESOLVE (+ free/busy prefetch, [R2]) ----------------
        const slot = resolveExtraction(extraction, {
          nowMs: anchorMs,
          timeZone: tz,
          defaultDurationMin: cfg.calendar.defaultDurationMin,
          ambiguousHour: cfg.agent.ambiguousHour,
        });
        const calendarConnected = gate.exposedTools().length > 0;
        let busy: BusyBlock[] | null = null;
        const slotEvent = slot.event;
        if (slot.state === 'complete' && calendarConnected && slotEvent !== null) {
          busy = await gate.prefetchFreeBusy(
            { startLocal: slotEvent.startLocal, endLocal: slotEvent.endLocal },
            { nowMs: clock.now(), timeZone: tz, signal, itemId: item.id, chatId },
          );
        }

        // ---------------- S3 DRAFT (only when a reply is wanted) ----------------
        let draftText: string | null = null;
        let manipulation = extraction.suspicious;
        if (extraction.needsReply) {
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
            signal: ac.signal,
          };
          const draftUsage = usageSink();
          let drafted;
          try {
            drafted = await runDraft(provider, {
              messages: draftMessages,
              ctx: runCtx,
              gate,
              maxOutputTokens: isLocal ? DRAFT_MAX_OUTPUT_TOKENS_LOCAL : DRAFT_MAX_OUTPUT_TOKENS_CLOUD,
              wallClockMs,
              onUsage: draftUsage.onUsage,
            });
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
            errorCode:
              drafted.ok || drafted.reason === 'aborted_manipulation' || drafted.reason === 'max_turns'
                ? null
                : 'LLM_BAD_OUTPUT',
          });
          if (drafted.ok) {
            draftText = drafted.text;
            manipulation = manipulation || drafted.manipulation;
          } else if (drafted.reason === 'aborted_manipulation') {
            // The run is over but the card is not lost: it becomes a manipulation-badged item with no draft.
            manipulation = true;
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
            contextBadges: extractCtx.badges,
            manipulation,
            now: clock.now(),
          },
          { calendarConnected },
        );
        notifyChanged([item.id]);
        log.info('triage_done', {
          chatId,
          itemId: item.id,
          version: outcome.proposalVersion,
          actions: outcome.actionsCreated.length,
          badges: outcome.badges.length,
          durationMs: clock.now() - startedAt,
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
