// src/main/llm/local/download.media.test.ts - owner V2-W1-07-media-voice. The v2 downloader deltas: ONE queue for LLM tiers,
// projectors and voice files; the magic is checked PER ENTRY (GGUF for llm/mmproj, 6c 6d 67 67 for asr/vad); ModelPlan.mmproj is the
// selected tier's projector; model_files.kind follows the id. Bytes come from a loopback server in this file; nothing is fetched.
import fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, ClockTimer, Logger } from '../../deps';
import type { ModelFileId, ModelFileRecord } from '../../../shared/types';
import type { Repos } from '../../db/index';
import { createModelManager, GGML_MAGIC } from './download';
import {
  MEDIA_MODEL_MANIFEST,
  type MediaModelFileId,
  type MediaModelManifestEntry,
  type ModelManifestEntry,
} from './manifest';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function host(
  files: Record<string, Buffer>,
  gateMs = 0,
): Promise<{ url: (name: string) => string; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const name = (req.url ?? '/').slice(1);
    hits.push(name);
    const body = files[name];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    }, gateMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  return { url: (name) => `http://127.0.0.1:${port}/${name}`, hits };
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
function repo(): Pick<Repos, 'models'> & { rows: Map<ModelFileId, ModelFileRecord> } {
  const rows = new Map<ModelFileId, ModelFileRecord>();
  return {
    rows,
    models: {
      get: (id) => rows.get(id) ?? null,
      upsert: (r) => void rows.set(r.id, { ...r }),
      delete: (id) => void rows.delete(id),
    },
  };
}
const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn) => setTimeout(fn, 0) as unknown as ClockTimer,
  clearTimeout: () => undefined,
};
const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };
async function settled(rows: Map<ModelFileId, ModelFileRecord>, id: ModelFileId): Promise<ModelFileRecord> {
  for (let i = 0; i < 4000; i += 1) {
    const r = rows.get(id);
    if (r !== undefined && ['ready', 'failed', 'none', 'paused'].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 2));
  }
  throw new Error('not settled');
}

async function setup(opts: { vad?: Buffer; llm?: Buffer; mmproj?: Buffer; gateMs?: number } = {}) {
  const vad = opts.vad ?? Buffer.concat([Buffer.from(GGML_MAGIC, 'ascii'), Buffer.alloc(4096, 7)]);
  const llm = opts.llm ?? Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(8192, 1)]);
  const mmproj = opts.mmproj ?? Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2048, 2)]);
  const srv = await host({ 'vad.bin': vad, 'llm.gguf': llm, 'mmproj-F16.gguf': mmproj }, opts.gateMs ?? 0);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wca-media-dl-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const llmEntry: ModelManifestEntry = {
    tier: 'small',
    label: 'fake',
    fileName: 'llm.gguf',
    url: srv.url('llm.gguf'),
    size: llm.length,
    sha256: sha(llm),
  };
  const manifest = {
    tiny: { ...llmEntry, tier: 'tiny' as const },
    small: llmEntry,
    mid: { ...llmEntry, tier: 'mid' as const },
  };
  const media: Record<MediaModelFileId, MediaModelManifestEntry> = {
    ...MEDIA_MODEL_MANIFEST,
    'voice-vad': { ...MEDIA_MODEL_MANIFEST['voice-vad'], url: srv.url('vad.bin'), size: vad.length, sha256: sha(vad) },
    'mmproj-small': {
      ...MEDIA_MODEL_MANIFEST['mmproj-small'],
      url: srv.url('mmproj-F16.gguf'),
      size: mmproj.length,
      sha256: sha(mmproj),
    },
  };
  const models = repo();
  const manager = createModelManager({
    manifest,
    mediaManifest: media,
    allowHttpLoopback: true,
    modelsDir: dir,
    repos: models,
    hardware: () => Promise.resolve({ ramGiB: 16, gpus: [], freeDiskGiB: 100, recommendedTier: 'small' }),
    selectedTier: () => 'small',
    freeDiskBytes: () => Promise.resolve(10 * 1024 ** 3),
    fetch: (i, init) => fetch(i, init),
    clock,
    log,
  });
  return { manager, models, dir, srv };
}

describe('ModelManager v2 (media files)', () => {
  it('a voice file downloads with the GGML magic, kind vad, a local name that cannot collide', async () => {
    const { manager, models, dir } = await setup();
    await manager.start('voice-vad');
    const rec = await settled(models.rows, 'voice-vad');
    expect(rec.status).toBe('ready');
    expect(rec.kind).toBe('vad');
    expect(path.basename(rec.path)).toBe('voice-vad-ggml-silero-v6.2.0.bin');
    expect(manager.readyPath('voice-vad')).toBe(path.join(dir, 'voice-vad-ggml-silero-v6.2.0.bin'));
  });

  it('the magic is checked per entry: GGUF bytes served for a GGML voice file fail (bad_magic), and vice versa', async () => {
    const wrong = await setup({ vad: Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(100)]) });
    await wrong.manager.start('voice-vad');
    expect((await settled(wrong.models.rows, 'voice-vad')).status).toBe('failed');
    const wrong2 = await setup({ mmproj: Buffer.concat([Buffer.from(GGML_MAGIC, 'ascii'), Buffer.alloc(100)]) });
    await wrong2.manager.start('mmproj-small');
    expect((await settled(wrong2.models.rows, 'mmproj-small')).status).toBe('failed');
  });

  it('plan().mmproj is the selected tier projector with its manifest size; the projector downloads as kind mmproj', async () => {
    const { manager, models } = await setup();
    const before = await manager.plan();
    expect(before.mmproj).toMatchObject({ id: 'mmproj-small', status: 'none', bytesDone: 0 });
    await manager.start('mmproj-small');
    const rec = await settled(models.rows, 'mmproj-small');
    expect([rec.status, rec.kind]).toEqual(['ready', 'mmproj']);
    const after = await manager.plan();
    expect(after.mmproj?.status).toBe('ready');
    expect(after.mmproj?.bytesDone).toBe(after.mmproj?.sizeBytes);
  });

  it('one queue: a media file waits for a running LLM download before its first request', async () => {
    const { manager, models, srv } = await setup({ gateMs: 150 });
    await manager.start('small');
    await manager.start('voice-vad');
    await settled(models.rows, 'small');
    await settled(models.rows, 'voice-vad');
    expect(srv.hits.indexOf('llm.gguf')).toBeLessThan(srv.hits.indexOf('vad.bin'));
    expect(models.rows.get('small')?.kind).toBe('llm');
  });

  it('an unknown file id is refused; delete removes a media file', async () => {
    const { manager, models } = await setup();
    await expect(manager.start('voice-nope' as ModelFileId)).rejects.toThrow(/unknown tier/);
    await manager.start('voice-vad');
    await settled(models.rows, 'voice-vad');
    await manager.delete('voice-vad');
    expect(models.rows.has('voice-vad')).toBe(false);
    expect(manager.readyPath('voice-vad')).toBeNull();
  });
});
