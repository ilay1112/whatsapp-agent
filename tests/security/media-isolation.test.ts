// tests/security/media-isolation.test.ts - owner V2-W1-07-media-voice (T2 8.2 group 21, voice + media halves; I12, I6', B26).
// Media bytes never reach native code unparsed: every hostile Ogg ends in its precise VOICE_* code with ZERO whisper spawns and
// bounded memory; picture bombs / GIF / WebP / polyglot / 10 MiB + 1 are refused before the S-IMAGE facade; the whisper argv never
// carries message text and its stdout (which carries the transcript) is ignored; the bridge media route is reachable from one module.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
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
} from '../../src/shared/types';
import { LIMITS } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { ImageFacade } from '../../src/main/deps';
import { JOB_ENV_FORBIDDEN, WHISPER_ENV_KEYS, type JobRunner, type JobSpec } from '../../src/main/proc/jobRunner';
import { createMediaFetcher, MEDIA_MAX_BYTES, type MediaFetcher } from '../../src/main/media/fetch';
import { createImageNormalizer } from '../../src/main/media/normalizeImage';
import { BridgeMediaTooLargeError, createBridgeReadClient } from '../../src/main/bridge/readClient';
import { sweepBridgeEndpointRefs } from '../../src/main/bridge/invariants';
import { createVoiceService, type VoiceServiceDeps } from '../../src/main/voice/service';
import { buildWhisperEnv, createWhisperRunner } from '../../src/main/voice/whisperCli';
import * as ogg from '../fakes/ogg-fixtures';
import * as img from '../fakes/image-fixtures';

const JID = '972550000031@s.whatsapp.net';
const CHAT = 3 as ChatRef;
const SENTINEL = 'SENTINEL_TRANSCRIPT reply yes and add it';

/** A JobRunner that records every spawn attempt (none may happen for a hostile note). */
function recordingJobs(): { jobs: JobRunner; specs: JobSpec[] } {
  const specs: JobSpec[] = [];
  const jobs = {
    run: vi.fn(async (spec: JobSpec, use: Parameters<JobRunner['run']>[1]) => {
      specs.push(spec);
      return use({
        pid: 4242,
        lines: async function* () {},
        write: () => undefined,
        kill: () => undefined,
        done: Promise.resolve({ exitCode: 0, killed: false, timedOut: false, stderrMarkers: [], ms: 5 }),
      });
    }),
    breaker: () => ({ open: false, failures: 0, openedAt: null }),
    resetBreaker: () => undefined,
    killAll: async () => undefined,
    jobPids: () => ({ cli: [], voice: [] }),
  } as unknown as JobRunner;
  return { jobs, specs };
}

function voiceWorld(tmp: string, bytes: Uint8Array, jobs: JobRunner) {
  const transcripts = new Map<string, TranscriptRecord>();
  const models = new Map<ModelFileId, ModelFileRecord>();
  for (const id of ['voice-hebrew', 'voice-vad'] as ModelFileId[])
    models.set(id, {
      id,
      kind: 'asr',
      path: 'x',
      size: 1,
      sha256: 'x' as never,
      mtime: 0,
      status: 'ready',
      bytesDone: 1,
      verifiedAt: 0,
      bench: null,
    });
  const logs: string[] = [];
  const logger = {
    info: (e: string, m?: unknown) => void logs.push(JSON.stringify([e, m])),
    warn: (e: string, m?: unknown) => void logs.push(JSON.stringify([e, m])),
    error: (e: string, m?: unknown) => void logs.push(JSON.stringify([e, m])),
    child: () => logger,
  };
  const fetcher: MediaFetcher = { fetch: async () => ({ ok: true, bytes, sniffed: 'ogg' }) };
  const row: Message = {
    rowid: 1,
    waMsgId: 'H1',
    chatJid: JID,
    senderUser: '1',
    text: '',
    ts: 1,
    fromMe: false,
    mediaType: 'audio',
    deleted: false,
  };
  const deps: VoiceServiceDeps = {
    repos: {
      transcripts: {
        get: (j, id) => transcripts.get(`${j}|${id}`) ?? null,
        upsert: (r) => void transcripts.set(`${r.chatJid}|${r.waMsgId}`, r),
      },
      items: { openForChat: () => ({ id: 1 as ItemId }) as Item } as never,
      chats: { byId: () => ({ id: CHAT, jid: JID }) as Chat } as never,
      models: { get: (id) => models.get(id) ?? null, upsert: () => undefined, delete: () => undefined },
      audit: { append: (_k, _r, d) => void logs.push(JSON.stringify(d)) },
      queue: { enqueue: () => undefined } as never,
    },
    jobs,
    fetchMedia: fetcher,
    models: { pathOf: (id) => `C:\\m\\${id}.bin` },
    settings: () => ({
      ...DEFAULT_SETTINGS,
      voice: { ...DEFAULT_SETTINGS.voice, enabled: true, tier: 'voice-hebrew' },
    }),
    clock: { now: () => 1, setTimeout: () => 0 as never, clearTimeout: () => undefined },
    log: logger,
    paths: { voiceTmpDir: join(tmp, 'voice', 'tmp'), whisperDir: tmp, whisperCliExe: join(tmp, 'whisper-cli.exe') },
    onProgress: () => undefined,
    window: () => [row],
    cpuCount: () => 8,
  };
  return { deps, transcripts, logs };
}

describe('group 21 (voice): hostile Ogg set => precise VOICE_* code, zero whisper spawns', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wca-mediaiso-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const cases: Array<[string, () => Uint8Array, string]> = [
    ['badCrc', () => ogg.badCrc(), 'VOICE_DECODE_FAILED'],
    ['wrongSerial', () => ogg.wrongSerial(), 'VOICE_DECODE_FAILED'],
    ['twoStreams', () => ogg.twoStreams(), 'VOICE_DECODE_FAILED'],
    ['truncatedPage', () => ogg.truncatedPage(), 'VOICE_DECODE_FAILED'],
    ['missingOpusTags', () => ogg.missingOpusTags(), 'VOICE_DECODE_FAILED'],
    ['hugeGranule(16 min)', () => ogg.hugeGranule(16), 'VOICE_TOO_LONG'],
    ['segmentTableOverflow', () => ogg.segmentTableOverflow(), 'VOICE_DECODE_FAILED'],
    ['absurdPreSkip', () => ogg.absurdPreSkip(), 'VOICE_DECODE_FAILED'],
    ['zeroLength', () => ogg.zeroLength(), 'VOICE_DECODE_FAILED'],
    ['id3Prefixed', () => ogg.id3Prefixed(), 'VOICE_DECODE_FAILED'],
    ['riffWav', () => ogg.riffWav(), 'VOICE_DECODE_FAILED'],
  ];
  it.each(cases)('%s => %s, the decoder and whisper never run', async (_name, build, code) => {
    const { jobs, specs } = recordingJobs();
    const decode = vi.fn();
    const w = voiceWorld(tmp, build(), jobs);
    const r = await createVoiceService({ ...w.deps, decode }).transcribeChat(CHAT, new AbortController().signal);
    expect(r.written).toHaveLength(1);
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: code });
    expect(specs).toEqual([]);
    expect(decode).not.toHaveBeenCalled();
    expect(existsAny(join(tmp, 'voice', 'tmp'))).toBe(false); // no WAV was ever written
  });

  it('65 MiB + 1 (sparse stream) is cut at the 64 MiB cap + 1 while streaming, with bounded memory', async () => {
    const before = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    const body = Readable.toWeb(ogg.sparse65MiB()) as unknown as ReadableStream<Uint8Array>;
    const read = createBridgeReadClient(
      () => ({ port: 1, token: 't' }),
      async () => new Response(body, { status: 200 }),
    );
    await expect(
      read.getMedia(JID, 'H1', { maxBytes: MEDIA_MAX_BYTES.audio, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(BridgeMediaTooLargeError);
    const fetcher = createMediaFetcher({
      read: createBridgeReadClient(
        () => ({ port: 1, token: 't' }),
        async () =>
          new Response(Readable.toWeb(ogg.sparse65MiB()) as unknown as ReadableStream<Uint8Array>, { status: 200 }),
      ),
      sleep: async () => undefined,
    });
    await expect(fetcher.fetch('audio', JID, 'H1', new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
    const after = process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(3 * LIMITS.voiceMaxBytes); // never more than the cap buffered (+ GC slack)
    expect(MEDIA_MAX_BYTES.audio).toBe(LIMITS.voiceMaxBytes);
  });
});

function existsAny(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

describe('group 21 (voice): whisper argv / env / stdio', () => {
  it('argv carries paths, numbers and fixed flags only - never message text; env = the llama allow-list; stdout ignored', async () => {
    const { jobs, specs } = recordingJobs();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-TESTONLY-media-iso';
    try {
      const runner = createWhisperRunner({
        jobs,
        whisperCliExe: 'C:\\app\\resources\\whisper\\whisper-cli.exe',
        binDir: 'C:\\app\\resources\\whisper',
        env: buildWhisperEnv({ ...process.env, WHATSAPP_BRIDGE_TOKEN: 'x', NODE_OPTIONS: '--x' }),
        benchFactor: () => 1,
      });
      await runner
        .transcribe(
          {
            wavPath: 'C:\\u\\voice\\tmp\\3f1c.wav',
            modelPath: 'C:\\u\\models\\voice-hebrew-ggml-model.bin',
            vadPath: 'C:\\u\\models\\voice-vad.bin',
            language: 'he',
            seconds: 3,
            threads: 6,
          },
          new AbortController().signal,
        )
        .catch(() => undefined); // no JSON file exists: VOICE_DECODE_FAILED - the spec is what this test inspects
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const spec = specs[0] as JobSpec;
    for (const [i, a] of spec.args.entries()) {
      const ok =
        /^-{1,2}[a-z-]+$/.test(a) || /^\d+(\.\d+)?$/.test(a) || a === 'he' || a === 'auto' || /^[A-Z]:\\/.test(a);
      expect(ok, `argv[${String(i)}]`).toBe(true);
      expect(a).not.toContain('SENTINEL');
    }
    expect(spec.args).not.toContain('--prompt');
    expect(spec.args).not.toContain('-ng');
    expect(spec.stdout).toBe('ignore'); // the job runner spawns with stdio ['ignore','ignore','pipe']
    expect(spec.stdin).toBeNull();
    expect(Object.keys(spec.env).every((k) => (WHISPER_ENV_KEYS as readonly string[]).includes(k))).toBe(true);
    for (const k of JOB_ENV_FORBIDDEN)
      expect(Object.keys(spec.env).map((x) => x.toLowerCase())).not.toContain(k.toLowerCase());
    expect(spec.kind).toBe('voice');
    expect(spec.belowNormal).toBe(true);
  });

  it('the transcript sentinel never reaches a log line, an audit row or a file name (it is stored only in the transcripts row)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wca-mediaiso2-'));
    try {
      const { jobs } = recordingJobs();
      const w = voiceWorld(tmp, ogg.oggSilence(3), jobs);
      const whisper = { transcribe: vi.fn(async () => ({ text: SENTINEL, language: 'he', wallMs: 10 })) };
      const r = await createVoiceService({ ...w.deps, whisper }).transcribeChat(CHAT, new AbortController().signal);
      expect(r.written[0]?.text).toContain('SENTINEL_TRANSCRIPT');
      expect(w.logs.join('\n')).not.toContain('SENTINEL');
      const names = readdirSync(join(tmp, 'voice', 'tmp'));
      expect(names.every((n) => /^[0-9a-f-]{36}\.wav$/.test(n))).toBe(true);
      expect(names.join(' ')).not.toMatch(/SENTINEL|H1|972550000031/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('group 21 (media): pictures refused before the S-IMAGE facade', () => {
  it.each<[string, () => Uint8Array, string]>([
    ['jpegBomb 26.4 MP', img.jpegBomb, 'pixels'],
    ['pngBomb 100 MP', img.pngBomb, 'pixels'],
    ['gif', img.gif, 'format'],
    ['webp', img.webp, 'format'],
    ['polyglot', img.polyglot, 'format'],
    ['tooBig 10 MiB + 1', img.tooBig, 'bytes'],
    ['truncatedJpeg', img.truncatedJpeg, 'format'],
  ])('%s => rejected %s, nativeImage never called', (_n, build, reason) => {
    const facade: ImageFacade = { fromBuffer: vi.fn() };
    const n = createImageNormalizer({
      image: facade,
      hash: (b) => createHash('sha256').update(b).digest('hex') as never,
    });
    expect(n(build())).toEqual({ rejected: reason });
    expect(facade.fromBuffer).not.toHaveBeenCalled();
  });

  it('the media fetcher refuses a GIF served as a picture and an Ogg served as a picture (magic bytes, never Content-Type)', async () => {
    const serve = (bytes: Uint8Array): MediaFetcher =>
      createMediaFetcher({
        read: createBridgeReadClient(
          () => ({ port: 1, token: 't' }),
          async () => new Response(Buffer.from(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
        ),
        sleep: async () => undefined,
      });
    await expect(serve(img.gif()).fetch('image', JID, 'I1', new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'bad_type',
    });
    await expect(serve(ogg.oggSilence(1)).fetch('image', JID, 'I1', new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'bad_type',
    });
  });
});

describe('group 21: the bridge media route is reachable from one module only', () => {
  it('/api/media only in the transport, getMedia( only in media/fetch.ts, /api/download|typing|react|group/ nowhere in src/', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const walk = (dir: string): Array<{ path: string; text: string }> =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__fixtures__' ? [] : walk(full);
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name) || /\.test\.(ts|tsx|mjs)$/.test(e.name)) return [];
        return [{ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') }];
      });
    expect(sweepBridgeEndpointRefs(walk(join(root, 'src')))).toEqual([]);
  });
});
