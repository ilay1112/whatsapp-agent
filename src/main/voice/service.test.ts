// src/main/voice/service.test.ts - owner V2-W1-07-media-voice. T2 5 row `voice/service.ts`: every live audio row without a transcript,
// predicted-time refusal VOICE_TOO_LONG_FOR_DEVICE with zero spawns, the 120 s V0 budget with deferral, no automatic VOICE_TIMEOUT
// retry (F33), empty transcript = status 'empty', tier change re-transcribes, the transcript never in a log line, progress numbers only,
// selfTest on the bundled 5 s signal, breaker => nothing spawned. Real demuxer + real opus-decoder; whisper is a recording double.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Chat,
  ChatRef,
  Item,
  ItemId,
  Message,
  ModelFileId,
  ModelFileRecord,
  TranscriptRecord,
} from '../../shared/types';
import { LIMITS } from '../../shared/types';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { Clock, ClockTimer, Logger, LogMeta } from '../deps';
import type { JobRunner } from '../proc/jobRunner';
import type { MediaFetcher, MediaFetchResult } from '../media/fetch';
import { createVoiceService, RETRY_LABEL, SELF_TEST_SECONDS, selfTestSignal, type VoiceServiceDeps } from './service';
import { WhisperJobError, type WhisperRunner } from './whisperCli';
import { hugeGranule, oggSilence } from '../../../tests/fakes/ogg-fixtures';

const JID = '972550000011@s.whatsapp.net';
const CHAT = 5 as ChatRef;

function audioRow(id: string, fromMe = false, rowid = 1): Message {
  return {
    rowid,
    waMsgId: id,
    chatJid: JID,
    senderUser: '972550000011',
    text: '',
    ts: 1,
    fromMe,
    mediaType: 'audio',
    deleted: false,
  };
}

interface World {
  deps: VoiceServiceDeps;
  transcripts: Map<string, TranscriptRecord>;
  models: Map<ModelFileId, ModelFileRecord>;
  audits: Array<{ kind: string; detail: Record<string, unknown> }>;
  logs: Array<{ event: string; meta?: LogMeta }>;
  enqueued: ChatRef[];
  progress: Array<{ itemId: ItemId; phase: string; audioSeconds: number }>;
  transcribe: ReturnType<typeof vi.fn>;
  fetchCalls: string[];
  resetBreaker: ReturnType<typeof vi.fn>;
  settings: Settings;
  rows: Message[];
  media: Map<string, MediaFetchResult>;
  breakerOpen: boolean;
}

function world(tmp: string, over: Partial<VoiceServiceDeps> = {}): World {
  const transcripts = new Map<string, TranscriptRecord>();
  const models = new Map<ModelFileId, ModelFileRecord>();
  const audits: World['audits'] = [];
  const logs: World['logs'] = [];
  const enqueued: ChatRef[] = [];
  const progress: World['progress'] = [];
  const fetchCalls: string[] = [];
  const media = new Map<string, MediaFetchResult>();
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    voice: { ...DEFAULT_SETTINGS.voice, enabled: true, tier: 'voice-hebrew' },
  };
  const chat = { id: CHAT, jid: JID } as Chat;
  const item = { id: 77 as ItemId, chatId: CHAT, triggerMsgId: 'A1' } as Item;
  const logger = (): Logger => ({
    info: (event, meta) => logs.push({ event, meta }),
    warn: (event, meta) => logs.push({ event, meta }),
    error: (event, meta) => logs.push({ event, meta }),
    child: () => logger(),
  });
  for (const id of ['voice-hebrew', 'voice-lite', 'voice-vad'] as ModelFileId[]) {
    models.set(id, {
      id,
      kind: 'asr',
      path: `C:\\m\\${id}.bin`,
      size: 1,
      sha256: 'x'.repeat(64) as never,
      mtime: 0,
      status: 'ready',
      bytesDone: 1,
      verifiedAt: 0,
      bench: null,
    });
  }
  const transcribe = vi.fn(async (_input: Parameters<WhisperRunner['transcribe']>[0], _signal: AbortSignal) => ({
    text: ' SENTINEL_TRANSCRIPT Thursday at 5 ',
    language: 'en',
    wallMs: 900,
  }));
  const resetBreaker = vi.fn();
  const w: World = {
    transcripts,
    models,
    audits,
    logs,
    enqueued,
    progress,
    transcribe,
    fetchCalls,
    resetBreaker,
    settings,
    rows: [audioRow('A1')],
    media,
    breakerOpen: false,
    deps: undefined as unknown as VoiceServiceDeps,
  };
  const fetcher: MediaFetcher = {
    fetch: async (_kind, _jid, id) => {
      fetchCalls.push(id);
      return media.get(id) ?? { ok: true, bytes: oggSilence(3), sniffed: 'ogg' };
    },
  };
  const clock: Clock = {
    now: () => 1_000_000,
    setTimeout: () => 0 as unknown as ClockTimer,
    clearTimeout: () => undefined,
  };
  w.deps = {
    repos: {
      transcripts: {
        get: (j, id) => transcripts.get(`${j}|${id}`) ?? null,
        upsert: (r) => void transcripts.set(`${r.chatJid}|${r.waMsgId}`, { ...r }),
      },
      items: {
        openForChat: () => item,
        byId: (id: ItemId) => (id === item.id ? item : null),
      } as unknown as VoiceServiceDeps['repos']['items'],
      chats: { byId: (id: ChatRef) => (id === CHAT ? chat : null) } as unknown as VoiceServiceDeps['repos']['chats'],
      models: {
        get: (id) => models.get(id) ?? null,
        upsert: (r) => void models.set(r.id, { ...r }),
        delete: (id) => void models.delete(id),
      },
      audit: { append: (kind, _ref, detail) => void audits.push({ kind, detail }) },
      queue: { enqueue: (id: ChatRef) => void enqueued.push(id) } as unknown as VoiceServiceDeps['repos']['queue'],
    },
    jobs: {
      breaker: () => ({ open: w.breakerOpen, failures: 0, openedAt: null }),
      resetBreaker,
    } as unknown as JobRunner,
    fetchMedia: fetcher,
    models: { pathOf: (id) => (models.get(id)?.status === 'ready' ? `C:\\m\\${id}.bin` : null) },
    settings: () => w.settings,
    clock,
    log: logger(),
    paths: { voiceTmpDir: join(tmp, 'voice', 'tmp'), whisperDir: tmp, whisperCliExe: join(tmp, 'whisper-cli.exe') },
    onProgress: (p) => progress.push(p),
    window: () => w.rows,
    whisper: { transcribe } as WhisperRunner,
    cpuCount: () => 8,
    randomId: (() => {
      let n = 0;
      return () => `job-${String((n += 1))}`;
    })(),
    ...over,
  };
  return w;
}
const live = (): AbortSignal => new AbortController().signal;

describe('createVoiceService.transcribeChat', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wca-voice-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('a 3 s note: fetch -> demux -> decode -> WAV in voice\\tmp -> whisper (he) -> done row; progress numbers only; no text in logs', async () => {
    const w = world(tmp);
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.deferred).toBe(false);
    expect(r.written).toHaveLength(1);
    expect(r.written[0]).toMatchObject({
      status: 'done',
      text: 'SENTINEL_TRANSCRIPT Thursday at 5',
      language: 'en',
      modelLabel: 'voice-hebrew',
      errorCode: null,
    });
    expect(r.written[0]?.seconds).toBeCloseTo(3, 5);
    const input = w.transcribe.mock.calls[0]?.[0] as Parameters<WhisperRunner['transcribe']>[0];
    expect(input).toMatchObject({
      language: 'he',
      threads: 6,
      modelPath: 'C:\\m\\voice-hebrew.bin',
      vadPath: 'C:\\m\\voice-vad.bin',
    });
    expect(input.wavPath).toBe(join(tmp, 'voice', 'tmp', 'job-1.wav'));
    expect(existsSync(input.wavPath)).toBe(true); // the runner deletes it (whisperCli finally); the double does not
    expect(w.progress.map((p) => p.phase)).toEqual(['fetch', 'decode', 'transcribe']);
    for (const p of w.progress) expect(Object.keys(p).sort()).toEqual(['audioSeconds', 'itemId', 'phase']);
    expect(JSON.stringify(w.logs)).not.toContain('SENTINEL');
    expect(JSON.stringify(w.audits)).not.toContain('SENTINEL');
    expect(w.audits[0]).toMatchObject({ kind: 'voice_job', detail: { outcome: 'done', seconds: 3 } });
  });

  it('re-triage reuses the transcript (one job); a tier change re-transcribes; auto language for non-Hebrew tiers', async () => {
    const w = world(tmp);
    const svc = createVoiceService(w.deps);
    await svc.transcribeChat(CHAT, live());
    await svc.transcribeChat(CHAT, live());
    expect(w.transcribe).toHaveBeenCalledTimes(1);
    w.settings = { ...w.settings, voice: { ...w.settings.voice, tier: 'voice-lite' } };
    const r = await svc.transcribeChat(CHAT, live());
    expect(w.transcribe).toHaveBeenCalledTimes(2);
    expect(r.written[0]?.modelLabel).toBe('voice-lite');
    expect((w.transcribe.mock.calls[1]?.[0] as { language: string }).language).toBe('auto');
  });

  it('an empty / whitespace-only / sanitised-away transcript => status empty (never a trigger)', async () => {
    const w = world(tmp);
    w.transcribe.mockResolvedValueOnce({ text: '  \u200b ', language: 'he', wallMs: 5 });
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.written[0]).toMatchObject({ status: 'empty', text: '', language: 'he' });
  });

  it('a huge transcript is capped at LIMITS.messageChars; a weird language code is dropped', async () => {
    const w = world(tmp);
    w.transcribe.mockResolvedValueOnce({ text: 'x'.repeat(50_000), language: '<script>', wallMs: 5 });
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.written[0]?.text?.length).toBeLessThanOrEqual(LIMITS.messageChars);
    expect(r.written[0]?.language).toBeNull();
  });

  it('order: inbound newest first, then from_me; only audio rows; deleted rows skipped', async () => {
    const w = world(tmp);
    w.rows = [
      audioRow('OLD1', false, 1),
      { ...audioRow('TXT1', false, 2), mediaType: '', text: 'hi' },
      audioRow('ME1', true, 3),
      { ...audioRow('DEL1', false, 4), deleted: true },
      audioRow('NEW1', false, 5),
    ];
    await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(w.fetchCalls).toEqual(['NEW1', 'OLD1', 'ME1']);
  });

  it('F33: predicted time > 300 s => VOICE_TOO_LONG_FOR_DEVICE with ZERO whisper calls; > 15 min => VOICE_TOO_LONG, decoder never built', async () => {
    const w = world(tmp, { decode: vi.fn() });
    w.models.set('voice-hebrew', {
      ...(w.models.get('voice-hebrew') as ModelFileRecord),
      bench: { tokPerSec: 0, measuredAt: 0, device: 'cpu', secPerAudioSec: 120 },
    });
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: 'VOICE_TOO_LONG_FOR_DEVICE' });
    expect(w.transcribe).not.toHaveBeenCalled();
    expect(w.deps.decode).not.toHaveBeenCalled();
    const w2 = world(tmp, { decode: vi.fn() });
    w2.media.set('A1', { ok: true, bytes: hugeGranule(16), sniffed: 'ogg' });
    const r2 = await createVoiceService(w2.deps).transcribeChat(CHAT, live());
    expect(r2.written[0]).toMatchObject({ status: 'failed', errorCode: 'VOICE_TOO_LONG' });
    expect(w2.deps.decode).not.toHaveBeenCalled();
    expect(w2.transcribe).not.toHaveBeenCalled();
  });

  it('F33 budget: 120 s of predicted time per run; the rest is deferred and the chat re-enqueued', async () => {
    const w = world(tmp);
    w.models.set('voice-hebrew', {
      ...(w.models.get('voice-hebrew') as ModelFileRecord),
      bench: { tokPerSec: 0, measuredAt: 0, device: 'cpu', secPerAudioSec: 20 },
    });
    w.rows = [audioRow('N1', false, 1), audioRow('N2', false, 2), audioRow('N3', false, 3)];
    // 3 s x 20 = 60 s predicted per note => two fit in 120 s, the third is deferred
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.deferred).toBe(true);
    expect(r.written.map((t) => t.waMsgId)).toEqual(['N3', 'N2']);
    expect(w.enqueued).toEqual([CHAT]);
    // a single note above the budget but under the job cap still runs (else it would never run)
    const w2 = world(tmp);
    w2.models.set('voice-hebrew', {
      ...(w2.models.get('voice-hebrew') as ModelFileRecord),
      bench: { tokPerSec: 0, measuredAt: 0, device: 'cpu', secPerAudioSec: 50 },
    });
    const r2 = await createVoiceService(w2.deps).transcribeChat(CHAT, live());
    expect(r2.written[0]?.status).toBe('done');
  });

  it.each<[string, ErrorCode | 'VOICE_AUDIO_MISSING', MediaFetchResult]>([
    ['missing', 'VOICE_AUDIO_MISSING', { ok: false, reason: 'missing' }],
    ['unreachable', 'VOICE_AUDIO_MISSING', { ok: false, reason: 'unreachable' }],
    ['auth', 'VOICE_AUDIO_MISSING', { ok: false, reason: 'auth' }],
    ['too_large', 'VOICE_TOO_LONG', { ok: false, reason: 'too_large' }],
    ['bad_type', 'VOICE_DECODE_FAILED', { ok: false, reason: 'bad_type' }],
    ['bad_id', 'VOICE_DECODE_FAILED', { ok: false, reason: 'bad_id' }],
    ['not ogg', 'VOICE_DECODE_FAILED', { ok: true, bytes: new Uint8Array(10), sniffed: 'ogg' }],
  ])('fetch / demux failure %s => %s, zero whisper calls', async (_n, code, res) => {
    const w = world(tmp);
    w.media.set('A1', res);
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: code });
    expect(w.transcribe).not.toHaveBeenCalled();
  });

  it('VOICE_AUDIO_MISSING rows are retried on the next run; VOICE_TIMEOUT is NEVER retried automatically (F33)', async () => {
    const w = world(tmp);
    w.media.set('A1', { ok: false, reason: 'missing' });
    const svc = createVoiceService(w.deps);
    await svc.transcribeChat(CHAT, live());
    w.media.delete('A1');
    const again = await svc.transcribeChat(CHAT, live());
    expect(again.written[0]?.status).toBe('done');
    const w2 = world(tmp);
    w2.transcribe.mockRejectedValueOnce(new WhisperJobError('VOICE_TIMEOUT'));
    const svc2 = createVoiceService(w2.deps);
    expect((await svc2.transcribeChat(CHAT, live())).written[0]).toMatchObject({
      status: 'failed',
      errorCode: 'VOICE_TIMEOUT',
    });
    expect((await svc2.transcribeChat(CHAT, live())).written).toEqual([]);
    expect(w2.transcribe).toHaveBeenCalledTimes(1);
  });

  it('whisper / decoder errors map to their code; an unexpected throw is VOICE_LOCAL_FAILED', async () => {
    for (const [err, code] of [
      [new WhisperJobError('VOICE_MODEL_MISSING'), 'VOICE_MODEL_MISSING'],
      [new WhisperJobError('LLM_VCREDIST_MISSING'), 'LLM_VCREDIST_MISSING'],
      [new Error('boom'), 'VOICE_LOCAL_FAILED'],
    ] as const) {
      const w = world(tmp);
      w.transcribe.mockRejectedValueOnce(err);
      expect((await createVoiceService(w.deps).transcribeChat(CHAT, live())).written[0]?.errorCode).toBe(code);
    }
    const w = world(tmp, { decode: vi.fn().mockRejectedValue(new Error('wasm')) });
    expect((await createVoiceService(w.deps).transcribeChat(CHAT, live())).written[0]?.errorCode).toBe(
      'VOICE_DECODE_FAILED',
    );
    const unwritable = world(tmp, {
      paths: { voiceTmpDir: join(tmp, 'nul\0dir'), whisperDir: tmp, whisperCliExe: 'x' },
    });
    expect((await createVoiceService(unwritable.deps).transcribeChat(CHAT, live())).written[0]?.errorCode).toBe(
      'VOICE_LOCAL_FAILED',
    );
  });

  it('abort (Pause / quit) writes status aborted and stops; aborted rows are pending again', async () => {
    const w = world(tmp);
    const ac = new AbortController();
    w.transcribe.mockImplementationOnce(async () => {
      ac.abort();
      throw new Error('killed');
    });
    w.rows = [audioRow('A1', false, 1), audioRow('A2', false, 2)];
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, ac.signal);
    expect(r.written).toEqual([]);
    expect(w.transcripts.get(`${JID}|A2`)?.status).toBe('aborted');
    expect(w.transcripts.has(`${JID}|A1`)).toBe(false);
    const again = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(again.written.map((t) => t.status)).toEqual(['done', 'done']);
    // aborted during the fetch, during the decode, before the loop
    for (const phase of ['fetch', 'decode'] as const) {
      const wx = world(tmp);
      const acx = new AbortController();
      if (phase === 'fetch')
        wx.deps.fetchMedia = { fetch: async () => (acx.abort(), { ok: false, reason: 'aborted' }) };
      else wx.deps.decode = async () => (acx.abort(), new Uint8Array(0));
      await createVoiceService(wx.deps).transcribeChat(CHAT, acx.signal);
      expect(wx.transcripts.get(`${JID}|A1`)?.status).toBe('aborted');
    }
    const wy = world(tmp);
    const acy = new AbortController();
    wy.deps.decode = async () => {
      acy.abort();
      throw new Error('x');
    };
    await createVoiceService(wy.deps).transcribeChat(CHAT, acy.signal);
    expect(wy.transcripts.get(`${JID}|A1`)?.status).toBe('aborted');
    const pre = new AbortController();
    pre.abort();
    const wz = world(tmp);
    expect((await createVoiceService(wz.deps).transcribeChat(CHAT, pre.signal)).written).toEqual([]);
    expect(wz.fetchCalls).toEqual([]);
  });

  it('fail closed: voice disabled, no window source, unknown chat, breaker open => nothing fetched or spawned', async () => {
    const off = world(tmp);
    off.settings = { ...off.settings, voice: { ...off.settings.voice, enabled: false } };
    const noWindow = world(tmp, { window: undefined });
    const unknown = world(tmp);
    const breaker = world(tmp);
    breaker.breakerOpen = true;
    for (const [w, chatId] of [
      [off, CHAT],
      [noWindow, CHAT],
      [unknown, 99 as ChatRef],
      [breaker, CHAT],
    ] as const) {
      expect((await createVoiceService(w.deps).transcribeChat(chatId, live())).written).toEqual([]);
      expect(w.fetchCalls).toEqual([]);
      expect(w.transcribe).not.toHaveBeenCalled();
    }
  });

  it('model or VAD missing => failed VOICE_MODEL_MISSING without fetching', async () => {
    const w = world(tmp);
    w.models.delete('voice-vad');
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: 'VOICE_MODEL_MISSING' });
    expect(w.fetchCalls).toEqual([]);
  });

  it('transcribePending returns the written rows', async () => {
    const w = world(tmp);
    expect((await createVoiceService(w.deps).transcribePending(CHAT, live())).map((t) => t.status)).toEqual(['done']);
  });
});

describe('retry / selfTest / resolvedTier / state', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wca-voice2-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('retry: clears a failed / aborted row (label no longer matches), resets the breaker, re-enqueues; refuses otherwise', async () => {
    const w = world(tmp);
    const svc = createVoiceService(w.deps);
    expect(await svc.retry(1)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await svc.retry(77)).toEqual({ ok: false, code: 'BAD_REQUEST' }); // no row yet
    w.transcribe.mockRejectedValueOnce(new WhisperJobError('VOICE_TIMEOUT'));
    await svc.transcribeChat(CHAT, live());
    expect(await svc.retry(77)).toEqual({ ok: true });
    expect(w.transcripts.get(`${JID}|A1`)?.modelLabel).toBe(RETRY_LABEL);
    expect(w.resetBreaker).toHaveBeenCalledWith('voice');
    expect(w.enqueued).toEqual([CHAT]);
    expect((await svc.transcribeChat(CHAT, live())).written[0]?.status).toBe('done');
    expect(await svc.retry(77)).toEqual({ ok: false, code: 'BAD_REQUEST' }); // done rows are not retried
    const orphan = world(tmp);
    (orphan.deps.repos.chats as unknown as { byId: () => null }).byId = () => null;
    expect(await createVoiceService(orphan.deps).retry(77)).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('selfTest: the bundled 5 s signal through whisper; bench stored as secPerAudioSec; failures => ok false', async () => {
    const w = world(tmp);
    w.transcribe.mockResolvedValueOnce({ text: '', language: null, wallMs: 2500 });
    const svc = createVoiceService(w.deps);
    await expect(svc.selfTest(live())).resolves.toEqual({ ok: true, secPerAudioSec: 0.5 });
    expect(w.models.get('voice-hebrew')?.bench?.secPerAudioSec).toBe(0.5);
    expect((w.transcribe.mock.calls[0]?.[0] as { seconds: number }).seconds).toBe(SELF_TEST_SECONDS);
    expect(selfTestSignal()).toHaveLength(SELF_TEST_SECONDS * 16_000);
    w.transcribe.mockRejectedValueOnce(new WhisperJobError('VOICE_MODEL_MISSING'));
    await expect(svc.selfTest(live())).resolves.toEqual({ ok: false, secPerAudioSec: null });
    w.transcribe.mockRejectedValueOnce(new Error('x'));
    await expect(svc.selfTest(live())).resolves.toEqual({ ok: false, secPerAudioSec: null });
    w.models.delete('voice-hebrew');
    await expect(svc.selfTest(live())).resolves.toEqual({ ok: false, secPerAudioSec: null });
    expect(readdirSync(join(tmp, 'voice', 'tmp')).length).toBeGreaterThan(0); // WAVs are the runner's to delete (double here)
  });

  it('resolvedTier: explicit setting wins; auto prefers the default Hebrew tier when ready, else the first ready tier, else the default', () => {
    const w = world(tmp);
    const svc = createVoiceService(w.deps);
    expect(svc.resolvedTier()).toBe('voice-hebrew');
    w.settings = { ...w.settings, voice: { ...w.settings.voice, tier: 'auto' } };
    expect(svc.resolvedTier()).toBe('voice-hebrew');
    w.models.delete('voice-hebrew');
    expect(svc.resolvedTier()).toBe('voice-lite');
    w.models.delete('voice-lite');
    expect(svc.resolvedTier()).toBe('voice-hebrew');
  });

  it('state(): enabled, tier, model status + manifest size, vad, bench, suggestLite (> 2 s per audio second, never on Lite)', () => {
    const w = world(tmp);
    const svc = createVoiceService(w.deps);
    expect(svc.state()).toMatchObject({
      enabled: true,
      tier: 'voice-hebrew',
      resolvedTier: 'voice-hebrew',
      model: { id: 'voice-hebrew', sizeBytes: 1_624_555_275, status: 'ready', bytesDone: 1_624_555_275 },
      vad: { status: 'ready' },
      secPerAudioSec: null,
      suggestLite: false,
    });
    w.models.set('voice-hebrew', {
      ...(w.models.get('voice-hebrew') as ModelFileRecord),
      status: 'downloading',
      bytesDone: 10,
      bench: { tokPerSec: 0, measuredAt: 0, device: 'cpu', secPerAudioSec: 2.5 },
    });
    expect(svc.state()).toMatchObject({
      model: { status: 'downloading', bytesDone: 10 },
      secPerAudioSec: 2.5,
      suggestLite: true,
    });
    w.models.delete('voice-hebrew');
    w.models.delete('voice-vad');
    expect(svc.state()).toMatchObject({ model: { status: 'none', bytesDone: 0 }, vad: { status: 'none' } });
    w.settings = { ...w.settings, voice: { ...w.settings.voice, tier: 'voice-lite' } };
    w.models.set('voice-lite', {
      ...(w.models.get('voice-lite') as ModelFileRecord),
      bench: { tokPerSec: 0, measuredAt: 0, device: 'cpu', secPerAudioSec: 9 },
    });
    expect(svc.state().suggestLite).toBe(false);
  });
});

type ErrorCode = import('../../shared/errors').ErrorCode;

describe('production defaults (real whisper runner over the JobRunner, real ids, real cpu count)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wca-voice3-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('the default runner builds a voice JobSpec (seam prefix + argv, cwd = seam dir) and maps exit 3', async () => {
    const specs: Array<import('../proc/jobRunner').JobSpec> = [];
    const w = world(tmp, { whisper: undefined, cpuCount: undefined, randomId: undefined });
    w.deps.whisperSeam = {
      command: 'C:\\node\\node.exe',
      args: ['C:\\repo\\tests\\fakes\\whisper-cli.mjs', '--fake-end'],
      cwd: 'C:\\repo\\tests\\fakes',
    };
    w.deps.jobs = {
      ...w.deps.jobs,
      breaker: () => ({ open: false, failures: 0, openedAt: null }),
      run: (async (spec, use) => {
        specs.push(spec);
        return use({
          pid: 1,
          lines: async function* () {},
          write: () => undefined,
          kill: () => undefined,
          done: Promise.resolve({ exitCode: 3, killed: false, timedOut: false, stderrMarkers: [], ms: 1 }),
        });
      }) as JobRunner['run'],
    } as JobRunner;
    const r = await createVoiceService(w.deps).transcribeChat(CHAT, live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: 'VOICE_MODEL_MISSING' });
    expect(specs[0]?.exePath).toBe('C:\\node\\node.exe');
    expect(specs[0]?.cwd).toBe('C:\\repo\\tests\\fakes');
    expect(specs[0]?.args.slice(0, 2)).toEqual(['C:\\repo\\tests\\fakes\\whisper-cli.mjs', '--fake-end']);
    expect(specs[0]?.args).toContain('-oj');
    expect(specs[0]?.wallClockMs).toBe(30_000);
    const wav = specs[0]?.args[specs[0].args.indexOf('-f') + 1] ?? '';
    expect(wav).toMatch(/[\\/]voice[\\/]tmp[\\/][0-9a-f-]{36}\.wav$/);
  });

  it('an unexpected error that is not an abort propagates (a bug, never swallowed as a row)', async () => {
    const w = world(tmp);
    (w.deps.repos.transcripts as unknown as { upsert: () => void }).upsert = () => {
      throw new Error('db gone');
    };
    await expect(createVoiceService(w.deps).transcribeChat(CHAT, live())).rejects.toThrow('db gone');
  });
});
