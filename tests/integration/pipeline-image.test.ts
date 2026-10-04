// tests/integration/pipeline-image.test.ts - T2 6 row `pipeline-image` (owner V2-W1-08-vision; inherited by V2-W2-01 in Wave 2).
// Part A - V1 READ-IMAGE on the REAL modules, before compose() exists: fake bridge `/api/media` -> bridge readClient -> media/fetch.ts
//   -> media/imageDims + media/normalizeImage (S-IMAGE facade double: nativeImage is Electron-only) -> media/mediaCache (temp dir) ->
//   agent/readImage.ts -> the production provider adapters (local over the SPAWNED fake llama-server with --mmproj + /props vision,
//   Claude / Gemini over recording SDK doubles, claude_cli over the real CliRunner + the spawned fake CLI) -> S2 image_absolute
//   (agent/resolve.ts) -> the P2 4.5 badges. Pictures are the committed synthetic golden files (tests/golden/images, T12).
// Part B - the same scenarios through the production compose() via the harness (T2 6): needs the harness `media` option and the V1
//   wiring of V2-W2-01 (the option throws NotImplemented until then) => BLOCKED-BY V2-W2-01, never skipped.
// Nothing vendor-owned is executed (T8): llama-server is tests/fakes/fake-llama-server.ts under the system node, claude is the .mjs fake.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepos, openDb, type Db, type Repos } from '../../src/main/db/index';
import { createBridgeDb, type BridgeDb } from '../../src/main/bridge/bridgeDb';
import { createBridgeReadClient } from '../../src/main/bridge/readClient';
import { createIngest, mediaWindowFor, type Ingest } from '../../src/main/bridge/ingest';
import { createStage0 } from '../../src/main/agent/stage0';
import { createMediaFetcher } from '../../src/main/media/fetch';
import { createImageNormalizer } from '../../src/main/media/normalizeImage';
import { createMediaCache, type MediaCache } from '../../src/main/media/mediaCache';
import { readImageDims } from '../../src/main/media/imageDims';
import {
  createPickImage,
  createReadImageStage,
  imageBadgesOf,
  readerOf,
  type NormalizedImage,
  type ReadImageOutcome,
} from '../../src/main/agent/readImage';
import { resolveExtractionWithImage } from '../../src/main/agent/resolve';
import { createLlamaRuntime, type LlamaRuntime } from '../../src/main/llm/local/llamaServer';
import { createLocalProvider, DEFAULT_LOCAL_SAMPLING } from '../../src/main/llm/local';
import { createClaudeProvider, type ClaudeClientLike } from '../../src/main/llm/claude';
import { createGeminiProvider, type GeminiClientLike } from '../../src/main/llm/gemini';
import { freePort } from '../../src/main/proc/freePort';
import { formatModelSize, MEDIA_MODEL_MANIFEST, MMPROJ_FOR_TIER } from '../../src/main/llm/local/manifest';
import { MODEL_TIERS } from '../../src/shared/types';
import type { LlmProvider } from '../../src/main/llm/types';
import type { ChatRef, EpochMs, ProviderId, Sha256Hex } from '../../src/shared/types';
import { ExtractionSchema, type ImageRead } from '../../src/shared/schemas';
import type { ImageFacade, ImageHandle, Logger, SpawnFn } from '../../src/main/deps';
import { startFakeBridge, type FakeBridge } from '../fakes/fake-bridge';
import { jpeg } from '../fakes/image-fixtures';
import { createClaudeFakeWorld, type ClaudeFakeWorld } from '../helpers/cli-fakes-hook.world';
import { createHarness, type Harness } from '../helpers/harness';
import { loadGoldenCases, type GoldenCase } from '../helpers/goldenLoader';

const FAKE_LLAMA = fileURLToPath(new URL('../fakes/fake-llama-server.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN = 'c3'.repeat(32);
const GOLDEN = new Map(loadGoldenCases('images').map((c) => [c.id, c]));
const golden = (id: string): GoldenCase => GOLDEN.get(id)!;
const NOW = Date.parse('2026-09-21T07:00:00.000Z'); // the golden now (Mon 10:00 Asia/Jerusalem)
const TZ = 'Asia/Jerusalem';

/** The scripted V1 answer / S1 extraction of a golden picture case. */
const readOf = (c: GoldenCase): ImageRead =>
  (c.stub.rules.find((r) => r.when.purpose === 'read_image')!.respond as unknown as { structured: ImageRead })
    .structured;
const s1Of = (c: GoldenCase) =>
  ExtractionSchema.parse({
    refersToExisting: false,
    change: 'no_change',
    changeConfidence: 'high',
    confidence: 'high',
    ...(c.stub.rules.find((r) => r.when.purpose === 'extract')!.respond as { structured: Record<string, unknown> })
      .structured,
  });
const fileOf = (c: GoldenCase): string => (c.media as { kind: 'image'; file: string }).file;
const fileBytes = (c: GoldenCase): Uint8Array => new Uint8Array(readFileSync(join(ROOT, ...fileOf(c).split('/'))));

/** S-IMAGE double: decodes nothing, reports the header size and emits a small deterministic JPEG (nativeImage is Electron-only). */
function imageFacade(): { facade: ImageFacade; calls: number } {
  const state = { calls: 0 };
  const handle = (w: number, h: number): ImageHandle => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (o) =>
      handle(o.width ?? Math.round((w * (o.height ?? h)) / h), o.height ?? Math.round((h * (o.width ?? w)) / w)),
    toJPEG: () => jpeg(Math.min(w, 48), Math.min(h, 48)),
  });
  return {
    get calls() {
      return state.calls;
    },
    facade: {
      fromBuffer: (bytes) => {
        state.calls += 1;
        const d = readImageDims(bytes)!;
        return handle(d.width, d.height);
      },
    },
  } as { facade: ImageFacade; calls: number };
}

interface World {
  root: string;
  userData: string;
  fake: FakeBridge;
  db: Db;
  repos: Repos;
  bridgeDb: BridgeDb;
  ingest: Ingest;
  cache: MediaCache;
  logs: string[];
  audits: unknown[];
  unavailable: unknown[];
  chatId: () => ChatRef;
  pick: (c: GoldenCase) => Promise<NormalizedImage | null>;
  seedPicture: (c: GoldenCase, msgId: string, media?: Uint8Array | { scenario: 'missing' }) => void;
}

async function world(opts: { imagesEnabled?: boolean; jid: string }): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'wca-pimage-'));
  const userData = join(root, 'userData');
  mkdirSync(userData, { recursive: true });
  const db = openDb(':memory:');
  const repos = createRepos(db);
  repos.settings.setInternal((s) => {
    s.images.enabled = opts.imagesEnabled ?? true;
    s.images.cloud = true;
  });
  repos.chats.upsertFromBridge(opts.jid, 'Picture Contact', true, NOW as EpochMs);
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
    voiceReady: () => true,
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
  const cache = createMediaCache({
    dir: join(userData, 'media-cache'),
    repos,
    fs: {
      writeFileSync: (p, d) => writeFileSync(p, d),
      readFileSync: (p) => new Uint8Array(readFileSync(p)),
      rmSync: (p, o) => rmSync(p, o),
      mkdirSync: (p, o) => void mkdirSync(p, o),
    },
    hash: (t) => createHash('sha256').update(t).digest('hex') as Sha256Hex,
  });
  const chatId = (): ChatRef => (repos.chats.byJid(opts.jid) as { id: ChatRef }).id;
  const audits: unknown[] = [];
  const unavailable: unknown[] = [];
  const { facade } = imageFacade();
  const pickImage = createPickImage({
    images: () => repos.settings.get().images,
    chatJidOf: (id) => repos.chats.byId(id)?.jid ?? null,
    media: createMediaFetcher({
      read: createBridgeReadClient(() => ({ port: fake.port, token: TOKEN })),
      sleep: async () => undefined,
    }),
    normalize: createImageNormalizer({
      image: facade,
      hash: (b) => createHash('sha256').update(b).digest('hex') as Sha256Hex,
    }),
    cache,
    alreadyRead: () => false,
    audit: (kind, detail) => void audits.push([kind, detail]),
    onUnavailable: (...a) => void unavailable.push(a),
  });
  return {
    root,
    userData,
    fake,
    db,
    repos,
    bridgeDb,
    ingest,
    cache,
    logs,
    audits,
    unavailable,
    chatId,
    pick: async () => pickImage(chatId(), mediaWindowFor({ bridgeDb, repos }, chatId(), 12)),
    seedPicture: (c, msgId, media) => {
      fake.db.seedMediaRow({
        chatJid: opts.jid,
        id: msgId,
        mediaType: 'image',
        caption: c.messages[0]!.text,
        ts: fake.db.formatTs(new Date(Date.now() - 30_000)),
      });
      fake.setMedia(opts.jid, msgId, media ?? fileBytes(c));
    },
  };
}

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };
const runsOf = (repos: Repos) => repos.runs;
/** The production V1 stage over one world with `active` as the active provider and `local` as the projector route. */
function v1(x: World, active: LlmProvider, local: LlmProvider | null, over: { cloud?: boolean } = {}) {
  return createReadImageStage({
    images: () => ({ enabled: x.repos.settings.get().images.enabled, cloud: over.cloud ?? true }),
    activeProvider: async () => active,
    consentCurrent: () => true,
    local: { mmprojReady: () => local !== null, provider: () => local! },
    imagesPassed: () => false,
    repos: { runs: runsOf(x.repos) },
    clock: {
      now: () => Date.now() as EpochMs,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as never),
    },
    log: quiet,
  });
}
const input = (x: World, image: NormalizedImage, caption: string) => ({
  chatId: x.chatId(),
  itemId: x.repos.items.openForChat(x.chatId())!.id,
  image,
  captionSanitised: caption,
  nowMs: NOW as EpochMs,
  timeZone: TZ,
  nonce: '9f2c4e1a0b7d3e55',
});
/** S2 + the P2 4.5 badges exactly as the orchestrator composes them (reader = the provider that read the picture). */
function s2(c: GoldenCase, out: ReadImageOutcome, active: ProviderId) {
  const slot = resolveExtractionWithImage(s1Of(c), out.ok ? out.read : null, {
    nowMs: NOW as EpochMs,
    timeZone: TZ,
    defaultDurationMin: 60,
    ambiguousHour: 'assume',
  });
  const badges = imageBadgesOf(out, out.ok ? readerOf(out.route, active) : active, () => false);
  return { slot, badges };
}
const expectGoldenSlot = (c: GoldenCase, r: ReturnType<typeof s2>) => {
  expect(r.slot.state).toBe('complete');
  expect(r.slot.event).toMatchObject({ startLocal: c.expect.startLocal, endLocal: c.expect.endLocal });
  expect(r.slot.imageMerge).toMatchObject({ used: true, conflict: false, unclear: false });
  expect(r.badges).toEqual(c.expect.badges!.filter((b) => b !== 'manipulation' || c.injection === true));
};

let w: World | null = null;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  if (w !== null) {
    await w.fake.stop();
    w.bridgeDb.close();
    w.db.close();
    rmSync(w.root, { recursive: true, force: true });
    w = null;
  }
});

/** The REAL llama runtime spawning the fake llama-server child under the system node, with the projector flags. */
function spawnedLocal(
  x: World,
  c: GoldenCase,
  opts: { vision?: boolean } = {},
): { provider: LlmProvider; runtime: LlamaRuntime; journal: () => Array<Record<string, unknown>> } {
  const rulesFile = join(x.root, 'llama-rules.json');
  const journalFile = join(x.root, 'llama-journal.ndjson');
  writeFileSync(
    rulesFile,
    JSON.stringify({ rules: [{ when: { purpose: 'read_image' }, respond: { structured: readOf(c) } }] }),
  );
  const modelFile = join(x.userData, 'models', 'gemma-4-E4B-it-Q4_K_M.gguf');
  const mmprojFile = join(x.userData, 'models', 'gemma-4-E4B-it-mmproj-F16.gguf');
  mkdirSync(join(x.userData, 'models'), { recursive: true });
  writeFileSync(modelFile, 'GGUF');
  writeFileSync(mmprojFile, 'GGUF');
  const runtime = createLlamaRuntime({
    exePath: process.execPath,
    exeArgs: [FAKE_LLAMA, '--fake-rules', rulesFile, '--fake-journal', journalFile],
    llamaDir: x.root,
    modelPath: () => modelFile,
    tier: () => 'small',
    forceCpu: () => true,
    acceleration: () => 'off',
    freePort: () => freePort(),
    spawn: spawn as unknown as SpawnFn,
    fetch,
    clock: {
      now: () => Date.now() as EpochMs,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as never),
    },
    random: { bytes: (n) => new Uint8Array(randomBytes(n)), int: (a) => a, float: () => 0 },
    log: quiet,
    exists: () => true,
    totalMemBytes: () => 32 * 1024 ** 3,
    setPriority: () => undefined,
    readyTimeoutMs: 15_000,
    healthPollMs: 50,
    imagesEnabled: () => x.repos.settings.get().images.enabled,
    mmprojPath: () => (opts.vision === false ? null : mmprojFile),
  });
  cleanups.push(() => runtime.stop());
  return {
    runtime,
    provider: createLocalProvider({
      runtime,
      modelLabel: 'gemma-4-E4B-it-Q4_K_M',
      sampling: DEFAULT_LOCAL_SAMPLING,
      fetch,
      log: quiet,
    }),
    journal: () =>
      existsSync(journalFile)
        ? readFileSync(journalFile, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}
function claudeApi(c: GoldenCase) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      create: async (p: Record<string, unknown>) => {
        requests.push(p);
        return {
          content: [{ type: 'text', text: JSON.stringify(readOf(c)) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
    },
    models: { list: async () => ({ data: [] }), retrieve: async () => ({}) },
  } as unknown as ClaudeClientLike;
  return {
    requests,
    provider: createClaudeProvider({ apiKey: 'sk-ant-TESTONLY-pimage', model: 'claude-opus-5', client, log: quiet }),
  };
}
function geminiApi(c: GoldenCase) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    interactions: {
      create: async (p: Record<string, unknown>) => {
        requests.push(p);
        return {
          id: 'int_TESTONLY',
          status: 'completed',
          output_text: JSON.stringify(readOf(c)),
          steps: [],
          usage: {},
        };
      },
    },
    models: { generateContent: async () => ({}), get: async () => ({}), list: async () => ({}) },
  } as unknown as GeminiClientLike;
  return {
    requests,
    provider: createGeminiProvider({
      apiKey: 'AIzaTESTONLYpipelineimagexxxxxxxxxxxxxx',
      model: 'gemini-3.8-flash',
      client,
      log: quiet,
    }),
  };
}
/** Scan the seeded picture row into an item and pick + normalise + cache it. */
async function ingestAndPick(x: World, c: GoldenCase, msgId: string): Promise<NormalizedImage> {
  x.seedPicture(c, msgId);
  await x.ingest.scanNow();
  expect(x.repos.items.openForChat(x.chatId())).toMatchObject({ triggerMsgId: msgId, triggerKind: 'image' });
  const img = await x.pick(c);
  expect(img).not.toBeNull();
  return img!;
}

// =================================================================================================================================
describe('Part A - V1 on the real modules, per provider', () => {
  it('Local: the spawned fake llama-server gets --mmproj (+ /props vision); image_url first, no tools; S2 image_absolute date', async () => {
    const c = golden('img-he-01');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG1');
    // the normalised picture + its thumbnail are cached under a hash-only name (no JID, no id, no caption)
    const files = [...new Set((await import('node:fs')).readdirSync(join(w.userData, 'media-cache')))];
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{64}(\.thumb)?\.jpg$/);
    const local = spawnedLocal(w, c);
    const out = await v1(
      w,
      local.provider,
      local.provider,
    )(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toMatchObject({ ok: true, route: 'local', read: { day: 24, month: 9, year: 2026, hour: 19 } });
    expect(local.runtime.vision!()).toMatchObject({ requested: true, ready: true });
    const j = local.journal();
    expect(j[0]).toMatchObject({ kind: 'argv', visionViolations: [] });
    expect(j[0]!.argv).toEqual(
      expect.arrayContaining(['--mmproj', '--mmproj-device', 'none', '--image-max-tokens', '1120']),
    );
    const completion = j.find((e) => e.kind === 'completion')!;
    expect(completion).toMatchObject({
      authorized: true,
      hasTools: false,
      hasResponseFormat: true,
      partTypes: ['image_url', 'text'],
      violations: [],
    });
    expect(completion.images).toEqual([{ mime: 'image/jpeg', sha256: img.sha256, bytes: img.jpeg.length }]);
    expectGoldenSlot(c, s2(c, out, 'local'));
    const run = w.db
      .prepare<{ stage: string; provider: string; outcome: string }>('SELECT stage, provider, outcome FROM runs')
      .all();
    expect(run).toEqual([{ stage: 'read_image', provider: 'local', outcome: 'ok' }]);
    expect(w.logs.join('\n')).not.toContain('שירה'); // nothing read from the picture reaches a log
  });

  it('Claude API: the native image block first, no tools; S2 date + badges', async () => {
    const c = golden('img-en-01');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG2');
    const api = claudeApi(c);
    const out = await v1(w, api.provider, null)(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toMatchObject({ ok: true, route: 'provider' });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).not.toHaveProperty('tools');
    const content = (
      api.requests[0]!.messages as Array<{ content: Array<{ type: string; source?: { data: string } }> }>
    )[0]!.content;
    expect(content.map((p) => p.type)).toEqual(['image', 'text']);
    expect(createHash('sha256').update(Buffer.from(content[0]!.source!.data, 'base64')).digest('hex')).toBe(img.sha256);
    expectGoldenSlot(c, s2(c, out, 'claude'));
  });

  it('Gemini API: the inline picture first, no function declarations (a JPEG golden picture)', async () => {
    const c = golden('img-mix-02');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG3');
    const api = geminiApi(c);
    const out = await v1(w, api.provider, null)(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toMatchObject({ ok: true, route: 'provider' });
    expect(JSON.stringify(api.requests[0])).not.toMatch(/"tools"|function_?[dD]eclarations/);
    expectGoldenSlot(c, s2(c, out, 'gemini'));
  });

  it('claude_cli (spawned fake): read_image stage, --tools "" --max-turns 1, no --mcp-config, the image block first on stdin', async () => {
    const c = golden('img-he-07');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG4');
    const cli: ClaudeFakeWorld = createClaudeFakeWorld({
      script: [
        {
          when: { stage: 'read_image', imageSha256: img.sha256 },
          respond: { structured: readOf(c) as unknown as Record<string, unknown> },
        },
      ],
    });
    cleanups.push(() => cli.cleanup());
    const out = await v1(w, cli.provider(), null)(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toMatchObject({ ok: true, route: 'provider', read: { kind: 'ticket', hour: 21, minute: 30 } });
    const run = cli.journal().find((e) => e.stage === 'read_image')!;
    expect(run.violations).toEqual([]);
    expect(run.argv[run.argv.indexOf('--tools') + 1]).toBe('');
    expect(run.argv[run.argv.indexOf('--max-turns') + 1]).toBe('1');
    expect(run.argv).not.toContain('--mcp-config');
    expectGoldenSlot(c, s2(c, out, 'claude_cli'));
    const sandbox = w.db
      .prepare<{ sandbox_ok: number | null }>("SELECT sandbox_ok FROM runs WHERE stage = 'read_image'")
      .all();
    expect(sandbox).toEqual([{ sandbox_ok: 1 }]); // I11: the V1 run carries its own init proof
  });

  it('antigravity_cli active => the picture goes to Local, never to agy', async () => {
    const c = golden('img-en-03');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG5');
    const agyCalls: string[] = [];
    const agy = {
      id: 'antigravity_cli',
      model: 'agy-m',
      loop: 'prefetch',
      capabilities: { images: false },
      structured: async () => {
        agyCalls.push('structured');
        throw new Error('agy must not read pictures');
      },
      chat: async () => {
        throw new Error('no');
      },
      validate: async () => ({ ok: true, model: 'x' }),
      dispose: async () => undefined,
    } as unknown as LlmProvider;
    const local = spawnedLocal(w, c);
    const out = await v1(w, agy, local.provider)(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toMatchObject({ ok: true, route: 'local' });
    expect(agyCalls).toEqual([]);
    expectGoldenSlot(c, s2(c, out, 'antigravity_cli'));
  });
});

describe('Part A - the fail-closed paths', () => {
  it('images.enabled = false: a captionless picture is context only; pickImage never fetches', async () => {
    const c = golden('img-he-02');
    w = await world({ jid: c.chatJid, imagesEnabled: false });
    w.fake.db.seedMediaRow({
      chatJid: c.chatJid,
      id: 'IMG6',
      mediaType: 'image',
      ts: w.fake.db.formatTs(new Date(Date.now() - 30_000)),
    });
    w.fake.setMedia(c.chatJid, 'IMG6', fileBytes(c));
    await w.ingest.scanNow();
    expect(w.repos.items.openForChat(w.chatId())).toBeNull();
    expect(await w.pick(c)).toBeNull();
    expect(w.fake.mediaRequests).toEqual([]);
  });

  it('no projector and no cloud route => image_unread, no model call, and S1 runs text-only (the v1 slot)', async () => {
    const c = golden('img-he-04');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG7');
    const api = claudeApi(c);
    const out = await v1(w, api.provider, null, { cloud: false })(
      input(w, img, c.messages[0]!.text),
      new AbortController().signal,
    );
    expect(out).toEqual({ ok: false, badge: 'image_unread', reason: 'no_route' });
    expect(api.requests).toEqual([]);
    const r = s2(c, out, 'claude');
    expect(r.slot.imageMerge).toBeNull();
    expect(r.slot.state).toBe('incomplete'); // S1 named no date: the text-only run asks for it
    expect(r.badges).toEqual(['image_unread']);
  });

  it('the child without a projector never reads pictures: /props reports no vision => image_unread (no silent text-only guess)', async () => {
    const c = golden('img-he-05');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG8');
    const local = spawnedLocal(w, c, { vision: false });
    const out = await v1(
      w,
      local.provider,
      local.provider,
    )(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toEqual({ ok: false, badge: 'image_unread', reason: 'no_route' });
    expect(local.journal().filter((e) => e.kind === 'completion')).toEqual([]);
    expect(local.journal()[0]!.argv).not.toContain('--mmproj');
  });

  it('V1 failure (garbage twice) => text-only run + image_unread; the runs row says LLM_BAD_OUTPUT', async () => {
    const c = golden('img-en-04');
    w = await world({ jid: c.chatJid });
    const img = await ingestAndPick(w, c, 'IMG9');
    const bad = claudeApi({
      ...c,
      stub: { rules: [{ when: { purpose: 'read_image' }, respond: { structured: { readable: 'maybe' } } }] },
    } as GoldenCase);
    const out = await v1(w, bad.provider, null)(input(w, img, c.messages[0]!.text), new AbortController().signal);
    expect(out).toEqual({ ok: false, badge: 'image_unread', reason: 'bad_output' });
    expect(bad.requests).toHaveLength(2); // one repair turn
    expect(s2(c, out, 'claude').badges).toEqual(['image_unread']);
    const run = w.db
      .prepare<{ outcome: string; error_code: string }>(
        "SELECT outcome, error_code FROM runs WHERE stage = 'read_image'",
      )
      .all();
    expect(run).toEqual([{ outcome: 'failed', error_code: 'LLM_BAD_OUTPUT' }]);
  });

  it('media missing twice => image_unread with MEDIA_UNAVAILABLE ("Try again"), exactly two requests, nothing cached', async () => {
    const c = golden('img-en-05');
    w = await world({ jid: c.chatJid });
    w.seedPicture(c, 'IMG10', { scenario: 'missing' });
    await w.ingest.scanNow();
    expect(await w.pick(c)).toBeNull();
    expect(w.unavailable).toEqual([[w.chatId(), 'IMG10', 'media_unavailable']]);
    expect(w.fake.mediaRequests.filter((q) => q.messageId === 'IMG10')).toHaveLength(2);
    expect(existsSync(join(w.userData, 'media-cache'))).toBe(false);
  });

  it('Dismiss deletes the cached picture and thumbnail at once (mediaCache.deleteForItem)', async () => {
    const c = golden('img-en-06');
    w = await world({ jid: c.chatJid });
    await ingestAndPick(w, c, 'IMG11');
    const item = w.repos.items.openForChat(w.chatId())!;
    const row = w.repos.mediaCache.get(w.chatId(), 'IMG11')!;
    w.repos.mediaCache.upsert({ ...row, itemId: item.id }); // the orchestrator links the row to its item
    expect(w.cache.thumb(item.id)).toMatch(/^data:image\/jpeg;base64,/);
    expect(w.cache.deleteForItem(item.id)).toBe(1);
    expect((await import('node:fs')).readdirSync(join(w.userData, 'media-cache'))).toEqual([]);
    expect(w.cache.thumb(item.id)).toBeNull();
  });
});

// =================================================================================================================================
/** [V2-W2-01] Local picture reading needs the selected tier's text model AND its projector downloaded (B19): mark every tier + projector
 *  ready in the models table (the fake is the scripted provider; nothing is loaded or executed). */
function projectorReady(harness: Harness): void {
  for (const tier of MODEL_TIERS) {
    for (const id of [tier, MMPROJ_FOR_TIER[tier]] as const) {
      harness.repos.models.upsert({
        id,
        kind: id === tier ? 'llm' : 'mmproj',
        path: join(harness.paths.modelsDir, `${id}.gguf`),
        size: 1,
        sha256: '0'.repeat(64) as Sha256Hex,
        mtime: 0,
        status: 'ready',
        bytesDone: 1,
        verifiedAt: harness.clock.now() as EpochMs,
        bench: null,
      });
    }
  }
}

/** [V2-W2-01] The contact is known (the user talked to them before), as in Part A. */
function knownContact(harness: Harness, jid: string): void {
  harness.repos.chats.upsertFromBridge(jid, 'Contact', true, harness.clock.now() as never);
}

describe('Part B - through compose() via the harness (T2 6) - BLOCKED-BY V2-W2-01 until the harness media option + V1 wiring land', () => {
  let h: Harness | null = null;
  beforeEach(() => {
    h = null;
  });
  afterEach(async () => {
    await h?.dispose();
  });
  const pictureRules = (c: GoldenCase) => c.stub.rules;

  it('image row => V1 (scripted provider) => proposal with the picture date, from_image + image_unclear, trigger_kind image', async () => {
    const c = golden('img-he-01');
    h = await createHarness({
      nowMs: NOW,
      rules: pictureRules(c),
      settings: (s) => {
        s.images.enabled = true;
      },
      media: [{ chatJid: c.chatJid, msgId: 'HB1', bytes: fileBytes(c) }],
    });
    projectorReady(h); // Local (the default provider) reads pictures only with its projector (B19)
    knownContact(h, c.chatJid); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: c.chatJid, id: 'HB1', mediaType: 'image', caption: c.messages[0]!.text });
    await h.settle();
    const chat = h.repos.chats.byJid(c.chatJid) as { id: ChatRef };
    const item = h.repos.items.openForChat(chat.id)!;
    expect(item.triggerKind).toBe('image');
    expect(item.badges).toEqual(expect.arrayContaining(['from_image', 'image_unclear']));
    expect(h.llm.calls.map((k) => k.purpose)).toEqual(['read_image', 'extract', 'draft']);
    expect(h.llm.calls[0]!.tools).toEqual([]);
  });

  it('images.enabled = false => the picture is context only (no V1 run, no media request)', async () => {
    const c = golden('img-en-01');
    h = await createHarness({
      nowMs: NOW,
      rules: pictureRules(c),
      settings: (s) => {
        s.images.enabled = false;
      },
      media: [{ chatJid: c.chatJid, msgId: 'HB2', bytes: fileBytes(c) }],
    });
    knownContact(h, c.chatJid); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: c.chatJid, id: 'HB2', mediaType: 'image' });
    await h.settle();
    expect(h.bridge.mediaRequests).toEqual([]);
    expect(h.llm.calls.some((k) => k.purpose === 'read_image')).toBe(false);
  });

  it('media missing => image_unread card (MEDIA_UNAVAILABLE, Try again) and S1 still runs text-only', async () => {
    const c = golden('img-en-02');
    h = await createHarness({
      nowMs: NOW,
      rules: pictureRules(c),
      settings: (s) => {
        s.images.enabled = true;
      },
      media: [{ chatJid: c.chatJid, msgId: 'HB3', scenario: 'missing' }],
    });
    knownContact(h, c.chatJid); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: c.chatJid, id: 'HB3', mediaType: 'image', caption: c.messages[0]!.text });
    await h.settle();
    const chat = h.repos.chats.byJid(c.chatJid) as { id: ChatRef };
    expect(h.repos.items.openForChat(chat.id)!.badges).toContain('image_unread');
    expect(h.llm.calls.map((k) => k.purpose)).toEqual(['extract', 'draft']);
  });

  it('no projector (local active) => image_unread raw card; the "Download picture reading ({size})" size comes from MEDIA_MODEL_MANIFEST (F24)', async () => {
    const c = golden('img-he-06');
    h = await createHarness({
      nowMs: NOW,
      rules: pictureRules(c),
      settings: (s) => {
        s.images.enabled = true;
      },
      media: [{ chatJid: c.chatJid, msgId: 'HB5', bytes: fileBytes(c) }],
    });
    knownContact(h, c.chatJid); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: c.chatJid, id: 'HB5', mediaType: 'image', caption: c.messages[0]!.text });
    await h.settle();
    const chat = h.repos.chats.byJid(c.chatJid) as { id: ChatRef };
    expect(h.repos.items.openForChat(chat.id)!.badges).toContain('image_unread');
    expect(h.llm.calls.some((k) => k.purpose === 'read_image')).toBe(false);
    const plan = await h.invoke('model:getPlan', undefined);
    expect(plan.ok).toBe(true);
    const mmproj = (plan as { value: { mmproj: { id: keyof typeof MEDIA_MODEL_MANIFEST; sizeBytes: number } | null } })
      .value.mmproj!;
    expect(mmproj.sizeBytes).toBe(MEDIA_MODEL_MANIFEST[mmproj.id].size);
    expect(formatModelSize({ size: mmproj.sizeBytes })).toBe(formatModelSize(MEDIA_MODEL_MANIFEST[mmproj.id]));
  });

  it('Dismiss deletes the thumbnail file at once', async () => {
    const c = golden('img-mix-01');
    h = await createHarness({
      nowMs: NOW,
      rules: pictureRules(c),
      settings: (s) => {
        s.images.enabled = true;
      },
      media: [{ chatJid: c.chatJid, msgId: 'HB4', bytes: fileBytes(c) }],
    });
    knownContact(h, c.chatJid); // [V2-W2-01] a fresh profile holds an unknown sender (A11) - the scenario is about a known contact
    h.bridgeDb.seedMediaRow({ chatJid: c.chatJid, id: 'HB4', mediaType: 'image', caption: c.messages[0]!.text });
    await h.settle();
    const chat = h.repos.chats.byJid(c.chatJid) as { id: ChatRef };
    const item = h.repos.items.openForChat(chat.id)!;
    expect((await import('node:fs')).readdirSync(join(h.userData, 'media-cache')).length).toBeGreaterThan(0);
    await h.invoke('item:dismiss', { itemId: item.id } as never);
    expect((await import('node:fs')).readdirSync(join(h.userData, 'media-cache'))).toEqual([]);
  });
});

describe('Part C - tests/golden/images.jsonl (T2 7.2 item 4)', () => {
  it('24 picture cases split 8/6/4/2/4, every file present', () => {
    const cases = [...GOLDEN.values()];
    expect(cases).toHaveLength(24);
    const by = (p: string) => cases.filter((c) => c.category === `image_${p}`).length;
    expect([by('printed_he'), by('printed_en'), by('mixed_screenshot'), by('script'), by('injection')]).toEqual([
      8, 6, 4, 2, 4,
    ]);
    for (const c of cases) expect(existsSync(join(ROOT, ...fileOf(c).split('/')))).toBe(true);
  });
});
