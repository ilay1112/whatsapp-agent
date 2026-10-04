// src/main/voice/service.ts   ADD (C2 13 + v2-build-plan section 3 seam) - owner V2-W1-07-media-voice.
// V0 TRANSCRIBE (P2 3, ARCH-v2 B18): fetch (media/fetch.ts) -> demux (voice/ogg.ts, BEFORE any decoder) -> predicted-time guard (F33)
// -> WASM decode (voice/decode.ts) -> app-written WAV in <userData>\voice\tmp\<random id>.wav -> whisper job (voice/whisperCli.ts)
// -> transcripts row. The transcript is UNTRUSTED text: it is sanitised and capped here, stored in app.db only, and never logged,
// audited, put on argv, in a file name or in a progress event (numbers only).
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { ChatRef, EpochMs, ItemId, Message, TranscriptRecord, VoiceState, VoiceTier } from '../../shared/types';
import { LIMITS, VOICE_TIERS } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { Settings } from '../../shared/settings';
import type { Repos } from '../db/index';
import type { JobRunner } from '../proc/jobRunner';
import type { MediaFetcher, MediaFetchResult } from '../media/fetch';
import type { Clock, Logger } from '../deps';
import { DEFAULT_VOICE_TIER } from '../agent/gates';
import { sanitizeForModel } from '../agent/sanitize';
import { MEDIA_MODEL_MANIFEST } from '../llm/local/manifest';
import { parseOggOpus } from './ogg';
import { decodeToWav16k, VoiceDecodeError } from './decode';
import { encodeWavPcm16, WAV_SAMPLE_RATE } from './wav';
import {
  buildWhisperEnv,
  createWhisperRunner,
  whisperThreads,
  WhisperJobError,
  type WhisperRunner,
} from './whisperCli';

// ---- C2 13 (verbatim) ----
export interface VoiceService {
  /** For every live audio row of the chat without a transcripts row (or whose model_label differs from the active tier's label):
   *  fetch -> demux -> decode -> WAV in <userData>\voice\tmp\<uuid>.wav -> whisper job -> transcripts row (status done|empty|failed|aborted).
   *  '' transcript => status 'empty' => never a trigger. Returns the rows it wrote. Never throws for per-note failures (they are rows). */
  transcribePending(chatId: ChatRef, signal: AbortSignal): Promise<TranscriptRecord[]>;
  /** voice:retry - clears a failed/aborted row of this item's trigger and re-enqueues the chat. */
  retry(itemId: number): Promise<{ ok: true } | { ok: false; code: ErrorCode }>;
  selfTest(signal: AbortSignal): Promise<{ ok: boolean; secPerAudioSec: number | null }>;
  resolvedTier(): VoiceTier | null;
}

// ---- v2-build-plan section 3 seam (C2 13 shapes win where they exist; additions below) ----
/** [W0 refinement] the seam names `VoiceBench` without a shape: it is C2's selfTest() result. */
export type VoiceBench = { ok: boolean; secPerAudioSec: number | null };
/** [W0 refinement] the seam names `VoiceStageResult` without a shape: the rows V0 wrote for this chat, and whether the per-run
 *  predicted-time budget (LIMITS.voiceRunBudgetMs, F33) deferred the remaining notes to a follow-up run of the chat. */
export interface VoiceStageResult {
  written: TranscriptRecord[];
  deferred: boolean;
}
export interface VoiceServiceV2 extends VoiceService {
  /** V0 entry used by the orchestrator (OrchestratorDepsV2.voice) - transcribePending + the F33 budget/deferral. */
  transcribeChat(chatId: ChatRef, signal: AbortSignal): Promise<VoiceStageResult>;
  /** voice:getState */
  state(): VoiceState;
}
export interface VoiceServiceDeps {
  repos: Pick<Repos, 'transcripts' | 'items' | 'chats' | 'models' | 'audit' | 'queue'>;
  jobs: JobRunner;
  fetchMedia: MediaFetcher;
  models: { pathOf(id: import('../../shared/types').ModelFileId): string | null };
  settings: () => Settings;
  clock: Clock;
  log: Logger;
  paths: { voiceTmpDir: string; whisperDir: string; whisperCliExe: string };
  onProgress: (p: { itemId: ItemId; phase: 'fetch' | 'decode' | 'transcribe'; audioSeconds: number }) => void;
  // ---- [V2-W1-07 refinements - optional, additive; REQUESTS -> orchestrator / V2-W2-01 in ops/agent-notes/V2-W1-07-media-voice.md] ----
  /** The P1 section 2 window of the chat INCLUDING audio rows that have no transcript yet (bridge/ingest.ts `mediaWindowFor`). The
   *  frozen deps carry no message source; without this V0 finds no audio row (fail closed: nothing is transcribed). */
  window?: (chatId: ChatRef) => readonly Message[];
  /** WCA_WHISPER_CMD seam (T2 4.1): `node.exe <tests/fakes/whisper-cli.mjs> ... --fake-end` + the production argv; cwd = the fake's dir. */
  whisperSeam?: { command: string; args: readonly string[]; cwd: string } | null;
  /** Test seams (S-OPUS / S-JOB-cpuCount / randomness); production uses the real ones. */
  whisper?: WhisperRunner;
  decode?: typeof decodeToWav16k;
  cpuCount?: () => number;
  randomId?: () => string;
}

/** Predicted seconds of transcription per second of audio until the self-test measured this PC (conservative: realtime). */
export const DEFAULT_BENCH_FACTOR = 1;
/** VoiceState.suggestLite: the measured bench is slower than 2x realtime (never switches by itself). */
export const SUGGEST_LITE_SEC_PER_AUDIO_SEC = 2;
/** modelLabel written by voice:retry so the row no longer matches the active tier's label (=> transcribed again). */
export const RETRY_LABEL = 'retry';
/** The bundled self-test note (C2 13 selfTest): 5 s. */
export const SELF_TEST_SECONDS = 5;

/** A 5 s deterministic speech-band signal for the self-test (the app ships no recording; nothing here is user data). */
export function selfTestSignal(): Float32Array {
  const n = SELF_TEST_SECONDS * WAV_SAMPLE_RATE;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / WAV_SAMPLE_RATE;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t); // ~3 syllables per second
    out[i] =
      0.25 *
      envelope *
      (Math.sin(2 * Math.PI * 180 * t) +
        0.5 * Math.sin(2 * Math.PI * 720 * t) +
        0.25 * Math.sin(2 * Math.PI * 1440 * t));
  }
  return out;
}

/** Whisper's language code if it is a plain code, else null (nothing else from whisper reaches the app, P2 3.3). */
function languageOf(raw: string | null): string | null {
  return raw !== null && /^[a-z]{2,8}$/.test(raw) ? raw : null;
}

const fetchFailureCode = (r: Extract<MediaFetchResult, { ok: false }>): ErrorCode | 'aborted' => {
  switch (r.reason) {
    case 'aborted':
      return 'aborted';
    case 'too_large':
      return 'VOICE_TOO_LONG'; // > 64 MiB of Opus is far beyond 15 min
    case 'bad_type':
    case 'bad_id':
      return 'VOICE_DECODE_FAILED';
    default:
      return 'VOICE_AUDIO_MISSING'; // missing / unreachable / auth: retryable through the queue backoff
  }
};

class Aborted extends Error {}

export function createVoiceService(deps: VoiceServiceDeps): VoiceServiceV2 {
  const log = deps.log.child('voice');
  const decode = deps.decode ?? decodeToWav16k;
  const cpuCount = deps.cpuCount ?? (() => cpus().length);
  const randomId = deps.randomId ?? (() => randomUUID());

  const resolvedTier = (): VoiceTier | null => {
    const setting = deps.settings().voice.tier;
    if (setting !== 'auto') return setting;
    const ready = (id: VoiceTier): boolean => deps.repos.models.get(id)?.status === 'ready';
    if (ready(DEFAULT_VOICE_TIER)) return DEFAULT_VOICE_TIER;
    return VOICE_TIERS.find(ready) ?? DEFAULT_VOICE_TIER;
  };
  const benchFactor = (tier: VoiceTier): number => {
    const b = deps.repos.models.get(tier)?.bench?.secPerAudioSec;
    return typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : DEFAULT_BENCH_FACTOR;
  };
  let currentTier: VoiceTier = DEFAULT_VOICE_TIER;
  const whisper: WhisperRunner =
    deps.whisper ??
    createWhisperRunner({
      jobs: deps.jobs,
      whisperCliExe: deps.whisperSeam?.command ?? deps.paths.whisperCliExe,
      binDir: deps.whisperSeam?.cwd ?? deps.paths.whisperDir,
      env: buildWhisperEnv(process.env),
      benchFactor: () => benchFactor(currentTier),
      argsPrefix: deps.whisperSeam?.args ?? [],
    });

  /** P2 3.1: pending = no row, a row of another tier, an aborted row, or a failed row whose code is retryable (never VOICE_TIMEOUT, F33). */
  const isPending = (t: TranscriptRecord | null, label: string): boolean =>
    t === null ||
    t.modelLabel !== label ||
    t.status === 'aborted' ||
    (t.status === 'failed' && t.errorCode === 'VOICE_AUDIO_MISSING');

  const write = (
    row: Message,
    status: TranscriptRecord['status'],
    over: { text?: string | null; language?: string | null; seconds?: number; code?: ErrorCode | null; label: string },
  ): TranscriptRecord => {
    const rec: TranscriptRecord = {
      chatJid: row.chatJid,
      waMsgId: row.waMsgId,
      status,
      text: over.text ?? null,
      language: over.language ?? null,
      seconds: over.seconds ?? 0,
      modelLabel: over.label,
      errorCode: over.code ?? null,
      createdAt: deps.clock.now(),
    };
    deps.repos.transcripts.upsert(rec);
    return rec;
  };

  const audit = (itemId: ItemId | null, seconds: number, wallMs: number | null, outcome: string): void => {
    deps.repos.audit.append(
      'voice_job',
      itemId === null ? null : String(itemId),
      { itemId, seconds: Math.round(seconds * 10) / 10, wallMs, exitCode: null, outcome },
      deps.clock.now(),
    );
  };

  /** One note. Throws Aborted when the signal fired (the row is written 'aborted' first). Never throws otherwise. */
  const one = async (
    row: Message,
    ctx: { itemId: ItemId | null; tier: VoiceTier; modelPath: string; vadPath: string; label: string },
    budget: { spentMs: number; ran: number },
    signal: AbortSignal,
  ): Promise<TranscriptRecord | 'deferred'> => {
    const progress = (phase: 'fetch' | 'decode' | 'transcribe', audioSeconds: number): void => {
      if (ctx.itemId !== null) deps.onProgress({ itemId: ctx.itemId, phase, audioSeconds: Math.round(audioSeconds) });
    };
    const aborted = (seconds: number): never => {
      write(row, 'aborted', { label: ctx.label, seconds });
      audit(ctx.itemId, seconds, null, 'aborted');
      throw new Aborted();
    };
    const failed = (code: ErrorCode, seconds: number, wallMs: number | null = null): TranscriptRecord => {
      audit(ctx.itemId, seconds, wallMs, code);
      log.info('voice_note_failed', { code, seconds: Math.round(seconds) });
      return write(row, 'failed', { label: ctx.label, seconds, code });
    };

    progress('fetch', 0);
    const media = await deps.fetchMedia.fetch('audio', row.chatJid, row.waMsgId, signal);
    if (!media.ok) {
      const code = fetchFailureCode(media);
      if (code === 'aborted' || signal.aborted) return aborted(0);
      return failed(code, 0);
    }
    const parsed = parseOggOpus(media.bytes); // duration decided BEFORE any decoder exists (B18)
    if (!parsed.ok) return failed(parsed.code, 0);
    const seconds = parsed.info.seconds;
    if (seconds > deps.settings().voice.maxMinutes * 60) return failed('VOICE_TOO_LONG', seconds);
    const predictedMs = seconds * benchFactor(ctx.tier) * 1000;
    if (predictedMs > LIMITS.voiceJobMaxMs) return failed('VOICE_TOO_LONG_FOR_DEVICE', seconds); // F33: refused before spawning
    if (budget.ran > 0 && budget.spentMs + predictedMs > LIMITS.voiceRunBudgetMs) return 'deferred'; // F33: the rest waits
    budget.spentMs += predictedMs;
    budget.ran += 1;

    progress('decode', seconds);
    let wav: Uint8Array;
    try {
      wav = await decode(parsed.packets, parsed.info, signal);
    } catch (e) {
      if (signal.aborted) return aborted(seconds);
      return failed(e instanceof VoiceDecodeError ? e.code : 'VOICE_DECODE_FAILED', seconds);
    }
    if (signal.aborted) return aborted(seconds);
    // random job id: never a WhatsApp id, a contact name or a bridge file name in a path (B27)
    const wavPath = join(deps.paths.voiceTmpDir, `${randomId()}.wav`);
    try {
      await mkdir(deps.paths.voiceTmpDir, { recursive: true });
      await writeFile(wavPath, wav);
    } catch {
      return failed('VOICE_LOCAL_FAILED', seconds);
    }

    progress('transcribe', seconds);
    const setting = deps.settings().voice.threads;
    let out: { text: string; language: string | null; wallMs: number };
    try {
      currentTier = ctx.tier;
      out = await whisper.transcribe(
        {
          wavPath,
          modelPath: ctx.modelPath,
          vadPath: ctx.vadPath,
          language: ctx.tier === 'voice-hebrew' ? 'he' : 'auto',
          seconds,
          threads: whisperThreads(cpuCount(), setting),
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) return aborted(seconds);
      return failed(e instanceof WhisperJobError ? e.code : 'VOICE_LOCAL_FAILED', seconds);
    }
    const text = sanitizeForModel(out.text).text.trim();
    const status = text === '' ? 'empty' : 'done';
    audit(ctx.itemId, seconds, out.wallMs, status);
    log.info('voice_note_done', { status, seconds: Math.round(seconds), wallMs: out.wallMs }); // never the text
    return write(row, status, {
      label: ctx.label,
      seconds,
      text: status === 'done' ? text : '',
      language: languageOf(out.language),
    });
  };

  const run = async (chatId: ChatRef, signal: AbortSignal): Promise<VoiceStageResult> => {
    const result: VoiceStageResult = { written: [], deferred: false };
    const cfg = deps.settings();
    if (!cfg.voice.enabled || deps.window === undefined) return result;
    const chat = deps.repos.chats.byId(chatId);
    if (chat === null) return result;
    const tier = resolvedTier() as VoiceTier;
    const label = tier;
    const audio = deps.window(chatId).filter((m) => m.mediaType === 'audio' && !m.deleted);
    // P2 3.1 order: inbound newest first, then from_me newest first
    const ordered = [...audio.filter((m) => !m.fromMe).reverse(), ...audio.filter((m) => m.fromMe).reverse()];
    const pending = ordered.filter((m) => isPending(deps.repos.transcripts.get(m.chatJid, m.waMsgId), label));
    if (pending.length === 0) return result;
    if (deps.jobs.breaker('voice').open) {
      log.warn('voice_breaker_open', { pending: pending.length }); // health line VOICE_LOCAL_FAILED; rows stay pending (held)
      return result;
    }
    const itemId = deps.repos.items.openForChat(chatId)?.id ?? null;
    const modelPath = deps.models.pathOf(tier);
    const vadPath = deps.models.pathOf('voice-vad');
    const budget = { spentMs: 0, ran: 0 };
    for (const row of pending) {
      if (signal.aborted) break;
      if (modelPath === null || vadPath === null) {
        audit(itemId, 0, null, 'VOICE_MODEL_MISSING');
        result.written.push(write(row, 'failed', { label, code: 'VOICE_MODEL_MISSING' }));
        continue;
      }
      try {
        const r = await one(row, { itemId, tier, modelPath, vadPath, label }, budget, signal);
        if (r === 'deferred') {
          result.deferred = true;
          break;
        }
        result.written.push(r);
      } catch (e) {
        if (e instanceof Aborted) break;
        throw e;
      }
    }
    if (result.deferred) deps.repos.queue.enqueue(chatId, deps.clock.now()); // F33: re-armed behind the other queued chats
    return result;
  };

  const state = (): VoiceState => {
    const cfg = deps.settings();
    const tier = resolvedTier();
    const rec = tier === null ? null : deps.repos.models.get(tier);
    const bench = rec?.bench?.secPerAudioSec;
    const secPerAudioSec = typeof bench === 'number' && Number.isFinite(bench) ? bench : null;
    return {
      enabled: cfg.voice.enabled,
      tier: cfg.voice.tier,
      resolvedTier: tier,
      model:
        tier === null
          ? null
          : {
              id: tier,
              sizeBytes: MEDIA_MODEL_MANIFEST[tier].size,
              status: rec?.status ?? 'none',
              bytesDone: rec?.status === 'ready' ? MEDIA_MODEL_MANIFEST[tier].size : (rec?.bytesDone ?? 0),
            },
      vad: { status: deps.repos.models.get('voice-vad')?.status ?? 'none' },
      secPerAudioSec,
      suggestLite: tier !== 'voice-lite' && secPerAudioSec !== null && secPerAudioSec > SUGGEST_LITE_SEC_PER_AUDIO_SEC,
    };
  };

  return {
    transcribeChat: run,
    async transcribePending(chatId, signal) {
      return (await run(chatId, signal)).written;
    },
    async retry(itemId) {
      const item = deps.repos.items.byId(itemId as ItemId);
      if (item === null) return { ok: false, code: 'NOT_FOUND' };
      const chat = deps.repos.chats.byId(item.chatId);
      if (chat === null) return { ok: false, code: 'NOT_FOUND' };
      const t = deps.repos.transcripts.get(chat.jid, item.triggerMsgId);
      if (t === null || (t.status !== 'failed' && t.status !== 'aborted')) return { ok: false, code: 'BAD_REQUEST' };
      const now: EpochMs = deps.clock.now();
      deps.repos.transcripts.upsert({ ...t, modelLabel: RETRY_LABEL, createdAt: now });
      deps.jobs.resetBreaker('voice'); // a user click ("Try again" / "Analyse again") is the only thing that resets the breaker
      deps.repos.queue.enqueue(item.chatId, now);
      log.info('voice_retry', { itemId });
      return { ok: true };
    },
    async selfTest(signal) {
      const tier = resolvedTier() as VoiceTier;
      const rec = deps.repos.models.get(tier);
      const modelPath = deps.models.pathOf(tier);
      const vadPath = deps.models.pathOf('voice-vad');
      if (rec === null || modelPath === null || vadPath === null) return { ok: false, secPerAudioSec: null };
      deps.jobs.resetBreaker('voice');
      const wavPath = join(deps.paths.voiceTmpDir, `${randomId()}.wav`);
      try {
        await mkdir(deps.paths.voiceTmpDir, { recursive: true });
        await writeFile(wavPath, encodeWavPcm16(selfTestSignal(), WAV_SAMPLE_RATE));
        currentTier = tier;
        const out = await whisper.transcribe(
          {
            wavPath,
            modelPath,
            vadPath,
            language: tier === 'voice-hebrew' ? 'he' : 'auto',
            seconds: SELF_TEST_SECONDS,
            threads: whisperThreads(cpuCount(), deps.settings().voice.threads),
          },
          signal,
        );
        const secPerAudioSec = Math.round((out.wallMs / 1000 / SELF_TEST_SECONDS) * 1000) / 1000;
        const now = deps.clock.now();
        deps.repos.models.upsert({
          ...rec,
          bench: { tokPerSec: rec.bench?.tokPerSec ?? 0, device: 'cpu', ...rec.bench, measuredAt: now, secPerAudioSec },
        });
        log.info('voice_self_test', { ok: true, secPerAudioSec });
        return { ok: true, secPerAudioSec };
      } catch (e) {
        log.warn('voice_self_test', { ok: false, code: e instanceof WhisperJobError ? e.code : 'VOICE_LOCAL_FAILED' });
        return { ok: false, secPerAudioSec: null };
      }
    },
    resolvedTier,
    state,
  };
}
export type { EpochMs, ErrorCode };
