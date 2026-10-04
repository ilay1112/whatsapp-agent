// src/main/llm/local/download.test.ts - TESTS 5.3 row `llm/local*` + the gate item 12b download cases as unit tests
// (owner W1-07). Every byte comes from the loopback fake model host of tests/fakes/fake-llama-server.ts; no real model
// is ever fetched and no URL outside 127.0.0.1 is ever contacted.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeLlamaServer, type FakeLlamaServer } from '../../../../tests/fakes/fake-llama-server';
import type { Clock, ClockTimer, Logger, LogMeta } from '../../deps';
import type { DownloadProgress, ModelFileId, ModelFileRecord, ModelTier } from '../../../shared/types';
import { MODEL_TIERS } from '../../../shared/types';
import type { Repos } from '../../db/index';
import {
  DISK_HEADROOM,
  SUGGEST_SMALLER_TOK_PER_SEC,
  createModelManager,
  isAllowedDownloadUrl,
  requiredFreeBytes,
  type ModelManagerDeps,
} from './download';
import type { ModelManifestEntry } from './manifest';

// ---------------------------------------------------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------------------------------------------------
function memoryModelsRepo(): Pick<Repos, 'models'> & { rows: Map<ModelFileId, ModelFileRecord> } {
  const rows = new Map<ModelFileId, ModelFileRecord>(); // [V2] keyed by ModelFileId (C2 16.1)
  return {
    rows,
    models: {
      get: (tier) => rows.get(tier) ?? null,
      upsert: (r) => {
        rows.set(r.id, { ...r });
      },
      delete: (tier) => {
        rows.delete(tier);
      },
    },
  } as Pick<Repos, 'models'> & { rows: Map<ModelFileId, ModelFileRecord> };
}

function tickingClock(stepMs = 1000): Clock {
  let t = 1_700_000_000_000;
  return {
    now: () => {
      const v = t;
      t += stepMs;
      return v;
    },
    setTimeout: (fn) => setTimeout(fn, 0) as unknown as ClockTimer,
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

function recordingLog(): { events: Array<{ event: string; meta?: LogMeta }>; log: Logger } {
  const events: Array<{ event: string; meta?: LogMeta }> = [];
  const make = (): Logger => ({
    info: (event, meta) => events.push({ event, meta }),
    warn: (event, meta) => events.push({ event, meta }),
    error: (event, meta) => events.push({ event, meta }),
    child: () => make(),
  });
  return { events, log: make() };
}

const tempDirs: string[] = [];
const servers: FakeLlamaServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wca-models-'));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  fake: FakeLlamaServer;
  modelsDir: string;
  repos: ReturnType<typeof memoryModelsRepo>;
  manager: ReturnType<typeof createModelManager>;
  entry: ModelManifestEntry;
  progress: DownloadProgress[];
  log: ReturnType<typeof recordingLog>;
  fileName: string;
  /** Swaps the transport the manager uses mid-test (a stalling body, then the real loopback host again). */
  setFetch(fn: typeof fetch): void;
}

const TERMINAL_STATUSES = new Set(['ready', 'failed', 'none', 'paused']);
/** Waits for the background `run()` task to reach a terminal status. `pause()` would ABORT it, so it is never used for this. */
async function settle(h: Harness, tier: ModelTier = 'small'): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    const status = h.repos.rows.get(tier)?.status;
    if (status !== undefined && TERMINAL_STATUSES.has(status)) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`download did not settle: ${String(h.repos.rows.get(tier)?.status)}`);
}

/** Waits until the `.part` file holds at least `min` bytes, so a pause() lands mid-transfer rather than before it. */
async function waitForPartBytes(h: Harness, min: number): Promise<void> {
  const part = path.join(h.modelsDir, `${h.fileName}.part`);
  for (let i = 0; i < 4000; i += 1) {
    const size = await fsp.stat(part).then(
      (s) => s.size,
      () => -1,
    );
    if (size >= min) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('the transfer never wrote any bytes');
}

/**
 * Streams the real body up to `afterBytes` and then stalls until the request is aborted - the only way to observe a
 * genuinely partial `.part` (the manager's own retry would otherwise finish the transfer inside one `start()`).
 */
function stallingFetch(afterBytes: number): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const body = res.body;
    if ((res.status !== 200 && res.status !== 206) || body === null) return res;
    const reader = body.getReader();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= afterBytes) {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        sent += chunk.value.length;
        controller.enqueue(chunk.value);
      },
      cancel: () => reader.cancel(),
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  };
}

/** A manifest whose `small` tier is the 256 KiB fake GGUF served on loopback. */
async function harness(
  over: Partial<ModelManagerDeps> & { modelHostScenario?: Parameters<FakeLlamaServer['setModelHostScenario']>[0] } = {},
): Promise<Harness> {
  const fake = await startFakeLlamaServer({
    apiKey: 'unused',
    modelHost: { scenario: over.modelHostScenario ?? 'default' },
  });
  servers.push(fake);
  const modelsDir = await tempDir();
  const repos = memoryModelsRepo();
  const log = recordingLog();
  const fileName = 'fake-model-Q4_K_M.gguf';
  const entry: ModelManifestEntry = {
    tier: 'small',
    label: 'fake-model',
    fileName,
    url: fake.modelUrl(),
    size: fake.modelSize,
    sha256: fake.modelSha256,
  };
  const manifest = {
    tiny: { ...entry, tier: 'tiny' as const, fileName: `tiny-${fileName}` },
    small: entry,
    mid: { ...entry, tier: 'mid' as const, fileName: `mid-${fileName}` },
  };
  const progress: DownloadProgress[] = [];
  let impl: typeof fetch = over.fetch ?? fetch;
  const manager = createModelManager({
    manifest,
    allowHttpLoopback: true, // the WCA_MODEL_MANIFEST e2e seam; production is asserted separately below
    modelsDir,
    repos,
    hardware: () => Promise.resolve({ ramGiB: 32, gpus: [], freeDiskGiB: 500, recommendedTier: 'small' }),
    selectedTier: () => 'small',
    freeDiskBytes: () => Promise.resolve(10 * 1024 ** 3),
    clock: tickingClock(),
    log: log.log,
    ...over,
    fetch: (input, init) => impl(input, init),
  });
  manager.onProgress((p) => progress.push(p));
  return {
    fake,
    modelsDir,
    repos,
    manager,
    entry,
    progress,
    log,
    fileName,
    setFetch: (fn) => {
      impl = fn;
    },
  };
}

const sha256File = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await fsp.readFile(file))
    .digest('hex');
const exists = async (file: string): Promise<boolean> =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------------------------------------------------
// [R2] the suffix rule (gate item 12b)
// ---------------------------------------------------------------------------------------------------------------------
describe('isAllowedDownloadUrl - [R2] suffix rule, never an exact-host list', () => {
  it.each([
    'https://huggingface.co/unsloth/x/resolve/abc/y.gguf',
    'https://us.aws.cdn.hf.co/repos/aa/bb/signed',
    'https://cas-bridge.xethub.hf.co/xet-bridge-us/abc',
    'https://cdn-lfs-us-1.hf.co/repos/x',
    'https://cdn-lfs.hf.co/repos/x',
    'https://cdn.huggingface.co/repos/x',
  ])('accepts %s', (url) => {
    expect(isAllowedDownloadUrl(url)).toBe(true);
  });

  it.each([
    ['a look-alike host', 'https://hf.co.evil.example/cdn/signed-1'],
    ['a suffix-lookalike without the dot', 'https://evilhf.co/x'],
    ['plain http on an allowed host', 'http://cdn.hf.co/repos/x'],
    ['plain http on the main host', 'http://huggingface.co/x.gguf'],
    ['a bare hf.co host', 'https://hf.co/x'],
    ['a userinfo smuggle', 'https://huggingface.co@evil.example/x'],
    ['a non-http scheme', 'file:///C:/windows/system32/calc.exe'],
    ['nonsense', 'not a url'],
  ])('rejects %s', (_name, url) => {
    expect(isAllowedDownloadUrl(url)).toBe(false);
  });

  it('production config (allowHttpLoopback false) rejects the loopback URL the e2e seam allows', () => {
    expect(isAllowedDownloadUrl('http://127.0.0.1:51234/cdn/x')).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1:51234/cdn/x', true)).toBe(true);
    expect(isAllowedDownloadUrl('http://evil.example/cdn/x', true)).toBe(false);
  });
});

describe('requiredFreeBytes', () => {
  it('is size + 5 %', () => {
    expect(DISK_HEADROOM).toBe(1.05);
    expect(requiredFreeBytes(1000)).toBe(1050);
    expect(requiredFreeBytes(0)).toBe(0);
    expect(requiredFreeBytes(-5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the happy path and its artefacts
// ---------------------------------------------------------------------------------------------------------------------
describe('download happy path', () => {
  it('follows exactly one redirect, verifies the sha256 and renames atomically into place', async () => {
    const h = await harness();
    await h.manager.start('small');
    await settle(h);

    const final = path.join(h.modelsDir, h.fileName);
    expect(await exists(final)).toBe(true);
    expect(await sha256File(final)).toBe(h.entry.sha256);
    // `.part` and its sidecar are gone after the promotion
    expect(await exists(`${final}.part`)).toBe(false);
    expect(await exists(`${final}.part.json`)).toBe(false);

    const row = h.repos.rows.get('small');
    expect(row?.status).toBe('ready');
    expect(row?.bytesDone).toBe(h.entry.size);
    expect(row?.verifiedAt).not.toBeNull();
    expect(h.manager.readyPath('small')).toBe(final);

    // one `resolve/<commit>/` request + one signed CDN request
    const resolves = h.fake.requests.filter((r) => /\/resolve\/[0-9a-f]{40}\//.test(r.path));
    const cdn = h.fake.requests.filter((r) => r.path.startsWith('/cdn/'));
    expect(resolves).toHaveLength(1);
    expect(cdn).toHaveLength(1);
    expect(h.progress.map((p) => p.status)).toContain('verifying');
    expect(h.progress.at(-1)?.status).toBe('ready');
  });

  it('writes `.part` + a sidecar while the transfer is in flight, and never the final name', async () => {
    const h = await harness();
    h.setFetch(stallingFetch(32 * 1024));
    await h.manager.start('small');
    await waitForPartBytes(h, 1024);
    await h.manager.pause('small');

    const part = path.join(h.modelsDir, `${h.fileName}.part`);
    expect(await exists(part)).toBe(true);
    expect((await fsp.stat(part)).size).toBeLessThan(h.entry.size);
    // the final name only ever appears after the sha256 matched (atomic rename)
    expect(await exists(path.join(h.modelsDir, h.fileName))).toBe(false);
    const side = JSON.parse(await fsp.readFile(`${part}.json`, 'utf8')) as {
      url: string;
      size: number;
      sha256: string;
    };
    expect(side).toMatchObject({ url: h.entry.url, size: h.entry.size, sha256: h.entry.sha256 });
    expect(h.repos.rows.get('small')?.status).toBe('paused');
  });

  it('resume after a dropped connection keeps the sha256 correct', async () => {
    const h = await harness({ modelHostScenario: 'drop_at:65536' });
    await h.manager.start('small');
    await settle(h);

    // the connection dropped once; the automatic retry resumed the `.part` from its watermark
    expect(h.log.events.filter((e) => e.event === 'model_download_failed').map((e) => e.meta?.reason)).toEqual([
      'network',
    ]);
    const final = path.join(h.modelsDir, h.fileName);
    expect(await sha256File(final)).toBe(h.entry.sha256);
    expect(h.repos.rows.get('small')?.status).toBe('ready');
    expect(await exists(`${final}.part`)).toBe(false);
    // two CDN transfers, the second one resumed with a Range request rather than restarted from byte 0
    expect(h.fake.requests.filter((r) => r.path.startsWith('/cdn/')).length).toBe(2);
  });

  it('[R2] `expired_redirect_on_resume`: the pinned resolve/<commit>/ URL is re-requested, never the stale signed one', async () => {
    const h = await harness();
    h.setFetch(stallingFetch(32 * 1024));
    await h.manager.start('small');
    await waitForPartBytes(h, 1024);
    await h.manager.pause('small');
    const firstSigned = h.fake.requests.filter((r) => r.path.startsWith('/cdn/')).map((r) => r.path);
    expect(firstSigned).toHaveLength(1);

    // the signed CDN link has expired: only a fresh `resolve/<commit>/` round trip can produce a usable one
    h.fake.setModelHostScenario('expired_redirect_on_resume');
    h.setFetch(fetch);
    await h.manager.resume('small');
    await settle(h);

    const resolves = h.fake.requests.filter((r) => /\/resolve\/[0-9a-f]{40}\//.test(r.path));
    expect(resolves).toHaveLength(2); // one per attempt
    const cdnPaths = h.fake.requests.filter((r) => r.path.startsWith('/cdn/')).map((r) => r.path);
    expect(new Set(cdnPaths).size).toBe(cdnPaths.length); // an expired signed path is never replayed
    expect(await sha256File(path.join(h.modelsDir, h.fileName))).toBe(h.entry.sha256);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// refusals (gate item 12b)
// ---------------------------------------------------------------------------------------------------------------------
describe('download refusals', () => {
  it('a foreign redirect host aborts before a single byte is streamed and is never retried', async () => {
    const h = await harness({ modelHostScenario: 'foreign_redirect_host' });
    await h.manager.start('small');
    await settle(h);
    expect(await exists(path.join(h.modelsDir, h.fileName))).toBe(false);
    expect(h.progress.some((p) => p.errorCode === 'DOWNLOAD_FAILED')).toBe(true);
    // fatal: exactly ONE attempt, no automatic re-download
    expect(h.log.events.filter((e) => e.event === 'model_download_failed')).toHaveLength(1);
    expect(h.log.events.find((e) => e.event === 'model_download_failed')?.meta?.reason).toBe('redirect_host_refused');
  });

  it('an X-Linked-Size mismatch on the 302 aborts before streaming', async () => {
    const h = await harness({ modelHostScenario: 'wrong_size' });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.find((e) => e.event === 'model_download_failed')?.meta?.reason).toBe('linked_size_mismatch');
    expect(h.fake.requests.filter((r) => r.path.startsWith('/cdn/'))).toHaveLength(0);
    expect(h.repos.rows.get('small')?.status).toBe('failed');
  });

  it('an X-Linked-Etag that is not the pinned sha256 aborts before streaming', async () => {
    const h = await harness({
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://us.aws.cdn.hf.co/signed',
            'x-linked-etag': '"0000000000000000000000000000000000000000000000000000000000000000"',
          },
        }),
    });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.find((e) => e.event === 'model_download_failed')?.meta?.reason).toBe('linked_etag_mismatch');
  });

  it('a redirect without a Location header is refused', async () => {
    const h = await harness({ fetch: async () => new Response(null, { status: 302 }) });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.find((e) => e.event === 'model_download_failed')?.meta?.reason).toBe('redirect_host_refused');
  });

  it('a SECOND hop is refused: the follow-up request uses redirect:"error"', async () => {
    const seen: Array<{ url: string; redirect: string | undefined }> = [];
    const h = await harness({
      fetch: (input, init) => {
        seen.push({ url: String(input), redirect: init?.redirect });
        if (seen.length === 1)
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: 'https://us.aws.cdn.hf.co/hop1' } }),
          );
        // fetch itself throws on a redirect when redirect:'error'; the double mirrors that
        return Promise.reject(new TypeError('unexpected redirect'));
      },
    });
    await h.manager.start('small');
    await settle(h);
    expect(seen[0]?.redirect).toBe('manual');
    expect(seen[1]?.redirect).toBe('error');
    expect(h.repos.rows.get('small')?.status).toBe('failed');
  });

  it('a corrupt body is deleted and re-downloaded EXACTLY once, then fails with DOWNLOAD_FAILED', async () => {
    const h = await harness({ modelHostScenario: 'corrupt_byte' });
    await h.manager.start('small');
    await settle(h);
    const reasons = h.log.events.filter((e) => e.event === 'model_download_failed').map((e) => e.meta?.reason);
    expect(reasons).toEqual(['sha256_mismatch', 'sha256_mismatch']); // one attempt + exactly one automatic retry
    expect(await exists(path.join(h.modelsDir, h.fileName))).toBe(false);
    expect(await exists(path.join(h.modelsDir, `${h.fileName}.part`))).toBe(false);
    expect(h.repos.rows.get('small')?.status).toBe('failed');
    expect(h.progress.at(-1)).toMatchObject({ status: 'failed', errorCode: 'DOWNLOAD_FAILED' });
  });

  it('a short body (size mismatch) never reaches the hash step', async () => {
    const bytes = Buffer.alloc(64, 7);
    const h = await harness({
      fetch: async () =>
        new Response(new Blob([bytes as unknown as BlobPart]).stream(), {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
    });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.filter((e) => e.event === 'model_download_failed').map((e) => e.meta?.reason)).toEqual([
      'size_mismatch',
      'size_mismatch',
    ]);
  });

  it('a body of the right length without the GGUF magic is refused', async () => {
    const h = await harness({
      fetch: async (_input) => {
        const bytes = Buffer.alloc(256 * 1024, 1); // right size, wrong magic (an HTML error page / captive portal)
        return new Response(new Blob([bytes as unknown as BlobPart]).stream(), { status: 200 });
      },
    });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.filter((e) => e.event === 'model_download_failed').map((e) => e.meta?.reason)).toEqual([
      'bad_magic',
      'bad_magic',
    ]);
  });

  it('an HTTP error status is retried once and then fails', async () => {
    const h = await harness({ fetch: async () => new Response('nope', { status: 500 }) });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.filter((e) => e.event === 'model_download_failed').map((e) => e.meta?.reason)).toEqual([
      'http_500',
      'http_500',
    ]);
  });

  it('a transport error is retried once and then fails', async () => {
    const h = await harness({ fetch: () => Promise.reject(new Error('ECONNRESET')) });
    await h.manager.start('small');
    await settle(h);
    expect(h.log.events.filter((e) => e.event === 'model_download_failed').map((e) => e.meta?.reason)).toEqual([
      'network',
      'network',
    ]);
  });

  it('too little free disk fails with DISK_FULL before any request', async () => {
    const h = await harness({ freeDiskBytes: () => Promise.resolve(1024) });
    const p = await h.manager.start('small');
    expect(p).toMatchObject({ status: 'failed', errorCode: 'DISK_FULL' });
    expect(h.fake.requests).toHaveLength(0);
    expect(h.repos.rows.get('small')?.status).toBe('failed');
  });

  it('a server that ignores Range restarts from zero instead of appending a second copy', async () => {
    const h = await harness();
    h.setFetch(stallingFetch(32 * 1024));
    await h.manager.start('small');
    await waitForPartBytes(h, 1024);
    await h.manager.pause('small');
    expect((await fsp.stat(path.join(h.modelsDir, `${h.fileName}.part`))).size).toBeLessThan(h.entry.size);

    h.fake.setModelHostScenario('no_range_support');
    h.setFetch(fetch);
    await h.manager.resume('small');
    await settle(h);
    expect(await sha256File(path.join(h.modelsDir, h.fileName))).toBe(h.entry.sha256);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// ModelManager surface
// ---------------------------------------------------------------------------------------------------------------------
describe('ModelManager', () => {
  it('plan() reports every tier with fitsDisk computed against size + 5 %', async () => {
    const h = await harness({ freeDiskBytes: () => Promise.resolve(Math.ceil(256 * 1024 * 1.05)) });
    const plan = await h.manager.plan();
    expect(plan.recommendedTier).toBe('small');
    expect(plan.selectedTier).toBe('small');
    expect(plan.tiers.map((t) => t.tier)).toEqual([...MODEL_TIERS]);
    expect(plan.tiers.every((t) => t.fitsDisk)).toBe(true);
    expect(plan.suggestSmaller).toBe(false);

    const tight = await harness({ freeDiskBytes: () => Promise.resolve(1024) });
    expect((await tight.manager.plan()).tiers.every((t) => t.fitsDisk)).toBe(false);
  });

  it('plan() follows the hardware recommendation when the setting is `auto`', async () => {
    const h = await harness({
      selectedTier: () => 'auto',
      hardware: () => Promise.resolve({ ramGiB: 8, gpus: [], freeDiskGiB: 100, recommendedTier: 'tiny' }),
    });
    const plan = await h.manager.plan();
    expect(plan.recommendedTier).toBe('tiny');
    expect(plan.selectedTier).toBe('tiny');
  });

  it('suggestSmaller is true only when the measured bench is below 5 tok/s and a smaller tier exists', async () => {
    const h = await harness();
    const row = (tokPerSec: number): ModelFileRecord => ({
      id: 'small',
      kind: 'llm', // [V2] C2 1.3
      path: 'x',
      size: h.entry.size,
      sha256: h.entry.sha256,
      mtime: 0,
      status: 'ready',
      bytesDone: h.entry.size,
      verifiedAt: 1,
      bench: { tokPerSec, measuredAt: 1, device: 'cpu' },
    });
    h.repos.models.upsert(row(SUGGEST_SMALLER_TOK_PER_SEC - 0.1));
    expect((await h.manager.plan()).suggestSmaller).toBe(true);
    h.repos.models.upsert(row(SUGGEST_SMALLER_TOK_PER_SEC));
    expect((await h.manager.plan()).suggestSmaller).toBe(false);

    // the smallest tier can never suggest something smaller
    const tiny = await harness({ selectedTier: () => 'tiny' });
    tiny.repos.models.upsert({ ...row(1), id: 'tiny' });
    expect((await tiny.manager.plan()).suggestSmaller).toBe(false);
  });

  it('start() on an already-ready tier is a no-op that never touches the network', async () => {
    const h = await harness();
    await h.manager.start('small');
    await settle(h);
    const before = h.fake.requests.length;
    const again = await h.manager.start('small');
    expect(again.status).toBe('ready');
    expect(h.fake.requests).toHaveLength(before);
  });

  it('cancel() removes the .part, its sidecar and the row', async () => {
    const h = await harness();
    h.setFetch(stallingFetch(32 * 1024));
    await h.manager.start('small');
    await waitForPartBytes(h, 1024);
    await h.manager.pause('small');
    expect(await exists(path.join(h.modelsDir, `${h.fileName}.part`))).toBe(true);
    const plan = await h.manager.cancel('small');
    expect(await exists(path.join(h.modelsDir, `${h.fileName}.part`))).toBe(false);
    expect(await exists(path.join(h.modelsDir, `${h.fileName}.part.json`))).toBe(false);
    expect(h.repos.rows.has('small')).toBe(false);
    expect(plan.tiers.find((t) => t.tier === 'small')?.status).toBe('none');
  });

  it('delete() removes a finished model file and forgets it', async () => {
    const h = await harness();
    await h.manager.start('small');
    await settle(h);
    expect(h.manager.readyPath('small')).not.toBeNull();
    await h.manager.delete('small');
    expect(await exists(path.join(h.modelsDir, h.fileName))).toBe(false);
    expect(h.manager.readyPath('small')).toBeNull();
    expect(h.log.events.map((e) => e.event)).toContain('model_deleted');
  });

  it('pause() records `paused` and resume() continues from the sidecar', async () => {
    const h = await harness();
    h.setFetch(stallingFetch(32 * 1024));
    await h.manager.start('small');
    await waitForPartBytes(h, 1024);
    const paused = await h.manager.pause('small');
    expect(paused.status).toBe('paused');
    expect(paused.bytesDone).toBeGreaterThan(0);
    h.setFetch(fetch);
    await h.manager.resume('small');
    await settle(h);
    expect(h.repos.rows.get('small')?.status).toBe('ready');
    expect(await sha256File(path.join(h.modelsDir, h.fileName))).toBe(h.entry.sha256);
  });

  it('onProgress() unsubscribes and never fires again', async () => {
    const h = await harness();
    const seen: DownloadProgress[] = [];
    const off = h.manager.onProgress((p) => seen.push(p));
    off();
    await h.manager.start('small');
    await settle(h);
    expect(seen).toEqual([]);
    expect(h.progress.length).toBeGreaterThan(0);
  });

  it('readyPath() is null for an unknown or unfinished tier', async () => {
    const h = await harness();
    expect(h.manager.readyPath('mid')).toBeNull();
  });

  it('an unknown tier is rejected rather than silently downloaded', async () => {
    const h = await harness();
    await expect(h.manager.start('nope' as ModelTier)).rejects.toThrow(/unknown tier/);
  });
});
