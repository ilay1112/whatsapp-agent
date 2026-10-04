// tests/integration/pipeline-voice.test.ts - owner V2-W1-07-media-voice (T2 6 row `pipeline-voice.test.ts`).
// Part A - the V0 chain on the REAL modules, before compose() exists: fake bridge over loopback HTTP -> bridgeDb -> ingest -> S0 ->
//   media/fetch.ts -> voice/ogg.ts -> opus-decoder -> WAV -> V2-W1-06's real JobRunner spawning tests/fakes/whisper-cli.mjs with the
//   system node.exe (WCA_WHISPER_CMD shape) -> transcripts row -> contextFor(). Nothing vendor-owned is executed (T8).
// Part B - the same scenarios through the production compose() via the harness (T2 6). Those need the harness `whisper` / `media`
//   options, which land with V2-W2-01 (they throw NotImplemented until then): BLOCKED-BY V2-W2-01, never skipped.
// Part C - tests/golden/voice.jsonl loader checks (T2 7.2 item 4: 12 rows, 4/4/4).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../src/main/db/index';
import { createBridgeDb, type BridgeDb } from '../../src/main/bridge/bridgeDb';
import { createBridgeReadClient } from '../../src/main/bridge/readClient';
import { createIngest, mediaWindowFor, type Ingest } from '../../src/main/bridge/ingest';
import { createStage0 } from '../../src/main/agent/stage0';
import { createMediaFetcher } from '../../src/main/media/fetch';
import { createJobRunner } from '../../src/main/proc/jobRunner';
import { createVoiceService, type VoiceServiceV2 } from '../../src/main/voice/service';
import type { ChatRef, ModelFileId } from '../../src/shared/types';
import { LIMITS } from '../../src/shared/types';
import type { Logger } from '../../src/main/deps';
import { startFakeBridge, type FakeBridge } from '../fakes/fake-bridge';
import { hugeGranule, oggSilence } from '../fakes/ogg-fixtures';
import { createHarness, type Harness } from '../helpers/harness';
import { loadGoldenCases } from '../helpers/goldenLoader';

const FAKES = fileURLToPath(new URL('../fakes/', import.meta.url));
const TOKEN = 'a1'.repeat(32);
const JID = '972550000061@s.whatsapp.net';
const NOW = Date.now();

interface World {
  root: string;
  fake: FakeBridge;
  db: Db;
  repos: Repos;
  bridgeDb: BridgeDb;
  ingest: Ingest;
  voice: (mode?: string) => VoiceServiceV2;
  journal: () => Array<{ violations: string[]; exit: number; mode: string }>;
  logs: string[];
  chatId: () => ChatRef;
}

async function world(opts: { voiceReady?: boolean; voiceEnabled?: boolean } = {}): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'wca-pvoice-'));
  const userData = join(root, 'userData');
  mkdirSync(join(userData, 'models'), { recursive: true });
  const db = openDb(':memory:');
  const repos = createRepos(db);
  repos.settings.setInternal((s) => {
    s.voice.enabled = opts.voiceEnabled ?? true;
    s.voice.tier = 'voice-hebrew';
  });
  repos.chats.upsertFromBridge(JID, 'Voice Contact', true, NOW);
  const fake = await startFakeBridge({
    token: TOKEN,
    storeDir: join(root, 'store'),
    pairing: 'connected',
    ansi: false,
  });
  const bridgeDb = createBridgeDb(join(root, 'store', 'messages.db'));
  const logs: string[] = [];
  const log: Logger = {
    info: (e, m) => void logs.push(JSON.stringify([e, m])),
    warn: (e, m) => void logs.push(JSON.stringify([e, m])),
    error: (e, m) => void logs.push(JSON.stringify([e, m])),
    child: () => log,
  };
  const clock = {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as never),
  };
  const stage0 = createStage0({
    repos,
    settings: () => repos.settings.get(),
    providerUsable: () => ({ ok: true }),
    paused: () => false,
    budgets: { llmRunsPerChatPerHour: 100, llmRunsGlobalPerHour: 100, cloudDailyTokenBudget: () => 1e9 },
    now: () => Date.now(),
    voiceReady: () => opts.voiceReady ?? true,
  });
  const ingest = createIngest({
    bridgeDb,
    repos,
    classify: stage0,
    settings: () => repos.settings.get(),
    clock: clock as never,
    log,
    onTsFormatError: () => undefined,
    notifyChanged: () => undefined,
    bridgeOnlineOnce: () => true,
    syncing: () => false,
  });
  // model files with the GGML magic (the fake whisper checks it), registered as ready
  for (const id of ['voice-hebrew', 'voice-vad'] as ModelFileId[]) {
    const p = join(userData, 'models', `${id}.bin`);
    writeFileSync(p, Buffer.from([0x6c, 0x6d, 0x67, 0x67, 0]));
    repos.models.upsert({
      id,
      kind: id === 'voice-vad' ? 'vad' : 'asr',
      path: p,
      size: 5,
      sha256: '0'.repeat(64) as never,
      mtime: 0,
      status: 'ready',
      bytesDone: 5,
      verifiedAt: NOW,
      bench: null,
    });
  }
  const journalPath = join(root, 'whisper-journal.ndjson');
  const transcriptsPath = join(root, 'transcripts.json');
  writeFileSync(
    transcriptsPath,
    JSON.stringify({ byDuration: { '3.0': { language: 'en', text: 'SENTINEL_TRANSCRIPT see you Thursday at five' } } }),
  );
  const jobs = createJobRunner({
    runDir: join(userData, 'run'),
    now: () => Date.now(),
    log: (e, m) => void logs.push(JSON.stringify([e, m])),
  });
  const voice = (mode = 'ok'): VoiceServiceV2 =>
    createVoiceService({
      repos,
      jobs,
      fetchMedia: createMediaFetcher({
        read: createBridgeReadClient(() => ({ port: fake.port, token: TOKEN })),
        sleep: async () => undefined,
      }),
      models: { pathOf: (id) => repos.models.get(id)?.path ?? null },
      settings: () => repos.settings.get(),
      clock: clock as never,
      log,
      paths: { voiceTmpDir: join(userData, 'voice', 'tmp'), whisperDir: FAKES, whisperCliExe: 'unused-with-seam' },
      onProgress: () => undefined,
      window: (id) => mediaWindowFor({ bridgeDb, repos }, id, LIMITS.contextMessages),
      whisperSeam: {
        command: process.execPath,
        args: [
          join(FAKES, 'whisper-cli.mjs'),
          '--fake-journal',
          journalPath,
          '--fake-mode',
          mode,
          '--fake-transcripts',
          transcriptsPath,
          '--fake-cores',
          String(cpus().length),
          '--fake-end',
        ],
        cwd: FAKES,
      },
    });
  return {
    root,
    fake,
    db,
    repos,
    bridgeDb,
    ingest,
    voice,
    logs,
    journal: () =>
      existsSync(journalPath)
        ? readFileSync(journalPath, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as never)
        : [],
    chatId: () => (repos.chats.byJid(JID) as { id: ChatRef }).id,
  };
}

let w: World | null = null;
afterEach(async () => {
  if (w !== null) {
    await w.fake.stop();
    w.bridgeDb.close();
    w.db.close();
    rmSync(w.root, { recursive: true, force: true });
    w = null;
  }
});
const live = (): AbortSignal => new AbortController().signal;
const seedNote = (x: World, id: string, bytes: Uint8Array | { scenario: 'missing' }): void => {
  x.fake.db.seedMediaRow({
    chatJid: JID,
    id,
    mediaType: 'audio',
    filename: 'voice-note.ogg',
    ts: x.fake.db.formatTs(new Date(Date.now() - 30_000)),
  });
  x.fake.setMedia(JID, id, bytes);
};

describe('Part A - V0 on the real modules (fake bridge + real JobRunner + fake whisper)', () => {
  it('a 3.0 s voice note: S0 queues it (trigger_kind voice), V0 writes a done transcript, contextFor carries source voice; a re-run reuses it', async () => {
    w = await world();
    seedNote(w, 'VN1', oggSilence(3));
    await w.ingest.scanNow();
    const item = w.repos.items.openForChat(w.chatId());
    expect(item).toMatchObject({ triggerMsgId: 'VN1', triggerKind: 'voice', analysis: 'queued' });
    const r = await w.voice().transcribeChat(w.chatId(), live());
    expect(r.deferred).toBe(false);
    expect(r.written).toHaveLength(1);
    expect(r.written[0]).toMatchObject({ status: 'done', language: 'en', modelLabel: 'voice-hebrew' });
    expect(r.written[0]?.text).toBe('SENTINEL_TRANSCRIPT see you Thursday at five');
    const ctx = w.ingest.contextFor(w.chatId(), LIMITS.contextMessages);
    expect(ctx.at(-1)).toMatchObject({
      waMsgId: 'VN1',
      text: '',
      voice: { transcript: 'SENTINEL_TRANSCRIPT see you Thursday at five', language: 'en' },
    });
    const again = await w.voice().transcribeChat(w.chatId(), live());
    expect(again.written).toEqual([]);
    const j = w.journal();
    expect(j).toHaveLength(1); // one job for two runs
    expect(j[0]?.violations).toEqual([]);
    expect(w.fake.mediaRequests).toHaveLength(1);
    expect(w.logs.join('\n')).not.toContain('SENTINEL'); // the transcript (and the fake's stdout copy of it) never reaches a log
    expect(existsSync(join(w.root, 'userData', 'voice', 'tmp'))).toBe(true);
  });

  it.each<[string, string]>([
    ['exit3', 'VOICE_MODEL_MISSING'],
    ['vcredist', 'LLM_VCREDIST_MISSING'],
    ['nojson', 'VOICE_DECODE_FAILED'],
    ['badjson', 'VOICE_DECODE_FAILED'],
    ['crash', 'VOICE_LOCAL_FAILED'],
  ])('fake whisper mode %s => transcripts row failed with %s', async (mode, code) => {
    w = await world();
    seedNote(w, 'VN2', oggSilence(3));
    const r = await w.voice(mode).transcribeChat(w.chatId(), live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: code });
  });

  it('empty transcript => status empty (never a trigger); wrong_lang is stored as the code whisper reported', async () => {
    w = await world();
    seedNote(w, 'VN3', oggSilence(3));
    expect((await w.voice('empty').transcribeChat(w.chatId(), live())).written[0]).toMatchObject({
      status: 'empty',
      text: '',
    });
    expect(w.ingest.contextFor(w.chatId(), 12).some((m) => m.waMsgId === 'VN3')).toBe(false);
  });

  it('media missing twice => VOICE_AUDIO_MISSING after exactly two /api/media requests; nothing spawned', async () => {
    w = await world();
    seedNote(w, 'VN4', { scenario: 'missing' });
    const r = await w.voice().transcribeChat(w.chatId(), live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: 'VOICE_AUDIO_MISSING' });
    expect(w.fake.mediaRequests.filter((q) => q.messageId === 'VN4')).toHaveLength(2);
    expect(w.journal()).toEqual([]);
  });

  it('a 15-min+ note never spawns a job (VOICE_TOO_LONG decided from the last granule)', async () => {
    w = await world();
    seedNote(w, 'VN5', hugeGranule(16));
    const r = await w.voice().transcribeChat(w.chatId(), live());
    expect(r.written[0]).toMatchObject({ status: 'failed', errorCode: 'VOICE_TOO_LONG' });
    expect(w.journal()).toEqual([]);
  });

  it('voice off, or its model not ready => S0 holds the note as a raw card (held/waiting_llm), no fetch, no job', async () => {
    for (const opts of [{ voiceEnabled: false }, { voiceReady: false }]) {
      const x = await world(opts);
      try {
        seedNote(x, 'VN6', oggSilence(3));
        await x.ingest.scanNow();
        expect(x.repos.items.openForChat(x.chatId())).toMatchObject({
          analysis: 'held',
          holdReason: 'waiting_llm',
          triggerKind: 'voice',
        });
        expect(x.fake.mediaRequests).toEqual([]);
        expect(x.journal()).toEqual([]);
      } finally {
        await x.fake.stop();
        x.bridgeDb.close();
        x.db.close();
        rmSync(x.root, { recursive: true, force: true });
      }
    }
  });
});

/** [V2-W2-01] The contact is known (the user talked to them before), as in Part A. */
function knownContact(harness: Harness, jid: string): void {
  harness.repos.chats.upsertFromBridge(jid, 'Contact', true, harness.clock.now() as never);
}

describe('Part B - through compose() via the harness (T2 6) - BLOCKED-BY V2-W2-01 until the harness whisper/media options land', () => {
  let h: Harness | null = null;
  beforeEach(() => {
    h = null;
  });
  afterEach(async () => {
    await h?.dispose();
  });

  it('audio row + setMedia Ogg (3.0 s) + fake whisper => transcripts row, trigger_kind voice, one job per note', async () => {
    h = await createHarness({
      settings: (s) => {
        s.voice.enabled = true;
      },
      whisper: { mode: 'ok', transcripts: { '3.0': { language: 'en', text: 'coffee Thursday at 5?' } } },
      media: [{ chatJid: JID, msgId: 'HV1', bytes: oggSilence(3) }],
    });
    knownContact(h, JID); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: JID, id: 'HV1', mediaType: 'audio' });
    await h.settle();
    const chat = h.repos.chats.byJid(JID);
    expect(chat).not.toBeNull();
    expect(h.repos.transcripts.get(JID, 'HV1')).toMatchObject({ status: 'done' });
    // [V2-W2-01] the harness default script answers "nothing to do" (item closes not_needed), so read the chat's newest item, open or not
    const newest = h.repos.db
      .prepare<{ trigger_kind: string }>('SELECT trigger_kind FROM items WHERE chat_id = ? ORDER BY id DESC LIMIT 1')
      .get((chat as { id: ChatRef }).id);
    expect(newest?.trigger_kind).toBe('voice');
    expect(h.whisperJournal()).toHaveLength(1);
  });

  it('media missing twice => VOICE_AUDIO_MISSING raw card after exactly two requests', async () => {
    h = await createHarness({
      settings: (s) => {
        s.voice.enabled = true;
      },
      whisper: { mode: 'ok' },
      media: [{ chatJid: JID, msgId: 'HV2', scenario: 'missing' }],
    });
    knownContact(h, JID); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: JID, id: 'HV2', mediaType: 'audio' });
    await h.settle();
    expect(h.repos.transcripts.get(JID, 'HV2')).toMatchObject({ status: 'failed', errorCode: 'VOICE_AUDIO_MISSING' });
    expect(h.bridge.mediaRequests.filter((r) => r.messageId === 'HV2')).toHaveLength(2);
  });
});

describe('Part C - tests/golden/voice.jsonl (T2 7.2 item 4)', () => {
  it('12 rows (4 he / 4 en / 4 mixed), unique ids and durations, synthetic JIDs, key phrases present in the scripted transcript', () => {
    const cases = loadGoldenCases('voice');
    expect(cases).toHaveLength(12);
    expect(['he', 'en', 'mixed'].map((l) => cases.filter((c) => c.lang === l).length)).toEqual([4, 4, 4]);
    expect(new Set(cases.map((c) => c.id)).size).toBe(12);
    const seconds = cases.map((c) => (c.media?.kind === 'voice' ? c.media.oggSeconds : -1));
    expect(new Set(seconds).size).toBe(12);
    for (const c of cases) {
      expect(c.chatJid).toMatch(/^9725500000\d{2}@s\.whatsapp\.net$/);
      expect(c.media).toMatchObject({ kind: 'voice' });
      const keys = c.expect.transcriptKeyPhrases ?? [];
      expect(keys.length).toBeGreaterThanOrEqual(2);
      const said = (c.messages.at(-1)?.text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, '');
      for (const k of keys)
        expect(said).toContain(
          k
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N} ]/gu, ''),
        );
    }
  });
});
