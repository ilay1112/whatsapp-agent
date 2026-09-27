// src/main/llm/local/download.ts - resumable GGUF downloader + ModelManager (build-plan section 3; owner W1-07). S-FETCH / S-FS / S-CLOCK.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Clock, FetchFn, Logger } from '../../deps';
import type { Repos } from '../../db/index';
import type {
  DownloadProgress,
  HardwareInfo,
  ModelFileStatus,
  ModelPlan,
  ModelTier,
  TierInfo,
} from '../../../shared/types';
import { MODEL_TIERS } from '../../../shared/types';
import type { ErrorCode } from '../../../shared/errors';
import { DOWNLOAD_HOST_ALLOWLIST, type ModelManifestEntry } from './manifest';

export interface ModelManager {
  plan(): Promise<ModelPlan>;
  /** Starts (or resumes) the download of `tier` (default: selected tier); verifies sha256 after the last byte; status -> ready. */
  start(tier?: ModelTier): Promise<DownloadProgress>;
  pause(tier?: ModelTier): Promise<DownloadProgress>;
  resume(tier?: ModelTier): Promise<DownloadProgress>;
  cancel(tier?: ModelTier): Promise<ModelPlan>;
  delete(tier: ModelTier): Promise<ModelPlan>;
  /** 4 Hz max; unsubscribe function. */
  onProgress(cb: (p: DownloadProgress) => void): () => void;
  /** Absolute path of a READY model file for the runtime, null otherwise. */
  readyPath(tier: ModelTier): string | null;
}
export interface ModelManagerDeps {
  manifest: Readonly<Record<ModelTier, ModelManifestEntry>>;
  allowHttpLoopback?: boolean; // e2e seam only
  modelsDir: string;
  repos: Pick<Repos, 'models'>;
  hardware: () => Promise<HardwareInfo>;
  selectedTier: () => 'auto' | ModelTier;
  freeDiskBytes: () => Promise<number>;
  fetch: FetchFn;
  clock: Clock;
  log: Logger;
}

// ---------------------------------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------------------------------
/** ARCH section 9: free-disk check is `size + 5 %`. */
export const DISK_HEADROOM = 1.05;
/** `model:progress` is pushed at 4 Hz max (CONTRACTS section 8). */
export const PROGRESS_INTERVAL_MS = 250;
/** GGUF magic - fails fast on HTML error pages / captive portals. */
export const GGUF_MAGIC = 'GGUF';
/** A sha256 / size mismatch triggers exactly ONE automatic re-download. */
export const MAX_AUTO_RETRIES = 1;
/** Below this the UI may suggest a smaller tier (never an automatic switch). */
export const SUGGEST_SMALLER_TOK_PER_SEC = 5;

export function requiredFreeBytes(remainingBytes: number): number {
  return Math.ceil(Math.max(0, remainingBytes) * DISK_HEADROOM);
}

/**
 * [R2] Redirect allow-list as a SUFFIX rule (ARCH section 9): Hugging Face picks the CDN host by region and backend
 * (`us.aws.cdn.hf.co`, `cas-bridge.xethub.hf.co`, `cdn-lfs-us-1.hf.co`, ...). The sha256 pin is the real integrity check.
 * `allowHttpLoopback` is the `WCA_MODEL_MANIFEST` e2e seam and is false in production.
 */
export function isAllowedDownloadUrl(raw: string, allowHttpLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (allowHttpLoopback && url.protocol === 'http:' && (host === '127.0.0.1' || host === '[::1]' || host === '::1'))
    return true;
  if (url.protocol !== 'https:') return false;
  if (DOWNLOAD_HOST_ALLOWLIST.exact.some((h) => h === host)) return true;
  return DOWNLOAD_HOST_ALLOWLIST.suffix.some((s) => host.endsWith(s));
}

interface Sidecar {
  url: string;
  size: number;
  sha256: string;
  etag: string | null;
}

class DownloadAbort extends Error {
  readonly code: ErrorCode | null;
  constructor(code: ErrorCode | null, message: string) {
    super(message);
    this.name = 'DownloadAbort';
    this.code = code;
  }
}

export function createModelManager(deps: ModelManagerDeps): ModelManager {
  const log = deps.log.child('models');
  const listeners = new Set<(p: DownloadProgress) => void>();
  const controllers = new Map<ModelTier, AbortController>();
  const running = new Map<ModelTier, Promise<void>>();
  const lastEmitAt = new Map<ModelTier, number>();
  const pausedTiers = new Set<ModelTier>();

  const entryOf = (tier: ModelTier): ModelManifestEntry => {
    const entry = deps.manifest[tier];
    if (entry === undefined) throw new Error(`unknown tier: ${tier}`);
    return entry;
  };
  const finalPath = (tier: ModelTier): string => path.join(deps.modelsDir, entryOf(tier).fileName);
  const partPath = (tier: ModelTier): string => `${finalPath(tier)}.part`;
  const sidecarPath = (tier: ModelTier): string => `${partPath(tier)}.json`;

  const statusOf = (tier: ModelTier): ModelFileStatus => deps.repos.models.get(tier)?.status ?? 'none';
  const bytesDoneOf = (tier: ModelTier): number => deps.repos.models.get(tier)?.bytesDone ?? 0;

  const record = (
    tier: ModelTier,
    patch: { status: ModelFileStatus; bytesDone: number; mtime?: number; verifiedAt?: number | null },
  ): void => {
    const entry = entryOf(tier);
    const prev = deps.repos.models.get(tier);
    deps.repos.models.upsert({
      id: tier,
      path: finalPath(tier),
      size: entry.size,
      sha256: entry.sha256,
      mtime: patch.mtime ?? prev?.mtime ?? 0,
      status: patch.status,
      bytesDone: patch.bytesDone,
      verifiedAt: patch.verifiedAt === undefined ? (prev?.verifiedAt ?? null) : patch.verifiedAt,
      bench: prev?.bench ?? null,
    });
  };

  const progressOf = (
    tier: ModelTier,
    over: {
      status?: ModelFileStatus;
      bytesDone?: number;
      bytesPerSec?: number;
      etaSec?: number | null;
      errorCode?: ErrorCode | null;
    } = {},
  ): DownloadProgress => ({
    tier,
    status: over.status ?? statusOf(tier),
    bytesDone: over.bytesDone ?? bytesDoneOf(tier),
    bytesTotal: entryOf(tier).size,
    bytesPerSec: over.bytesPerSec ?? 0,
    etaSec: over.etaSec ?? null,
    errorCode: over.errorCode ?? null,
  });

  const emit = (p: DownloadProgress, force = false): void => {
    const now = deps.clock.now();
    const last = lastEmitAt.get(p.tier) ?? 0;
    if (!force && now - last < PROGRESS_INTERVAL_MS) return;
    lastEmitAt.set(p.tier, now);
    for (const cb of [...listeners]) cb(p);
  };

  const readSidecar = async (tier: ModelTier): Promise<Sidecar | null> => {
    try {
      return JSON.parse(await fsp.readFile(sidecarPath(tier), 'utf8')) as Sidecar;
    } catch {
      return null;
    }
  };
  const writeSidecar = async (tier: ModelTier, side: Sidecar): Promise<void> => {
    await fsp.writeFile(sidecarPath(tier), JSON.stringify(side), 'utf8');
  };
  const removeQuietly = async (file: string): Promise<void> => {
    await fsp.rm(file, { force: true });
  };
  const sizeOf = async (file: string): Promise<number> => {
    try {
      return (await fsp.stat(file)).size;
    } catch {
      return 0;
    }
  };

  const sha256OfFile = (file: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(file);
      stream.on('data', (c) => hash.update(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });

  const hasGgufMagic = async (file: string): Promise<boolean> => {
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(file, 'r');
      const buf = Buffer.alloc(4);
      const { bytesRead } = await handle.read(buf, 0, 4, 0);
      return bytesRead === 4 && buf.toString('ascii') === GGUF_MAGIC;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  };

  /** One transfer attempt into `<file>.part`. Throws DownloadAbort on a refusal, returns the byte count on success. */
  const transfer = async (tier: ModelTier, signal: AbortSignal): Promise<number> => {
    const entry = entryOf(tier);
    const part = partPath(tier);
    const side = await readSidecar(tier);
    let offset = await sizeOf(part);
    if (side === null || side.url !== entry.url || side.size !== entry.size || side.sha256 !== entry.sha256) {
      await removeQuietly(part);
      offset = 0;
    }
    if (offset > entry.size) {
      await removeQuietly(part);
      offset = 0;
    }

    const rangeHeaders = (from: number): Record<string, string> =>
      from > 0 ? { range: `bytes=${String(from)}-` } : {};
    // Always re-request the pinned `resolve/<commit>/` URL: the CDN redirect is signed and expires.
    let res = await deps.fetch(entry.url, { method: 'GET', redirect: 'manual', headers: rangeHeaders(offset), signal });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (location === null || !isAllowedDownloadUrl(location, deps.allowHttpLoopback ?? false)) {
        throw new DownloadAbort('DOWNLOAD_FAILED', 'redirect_host_refused');
      }
      const linkedSize = res.headers.get('x-linked-size');
      if (linkedSize !== null && Number(linkedSize) !== entry.size)
        throw new DownloadAbort('DOWNLOAD_FAILED', 'linked_size_mismatch');
      const linkedEtag = res.headers.get('x-linked-etag');
      if (linkedEtag !== null && linkedEtag.replace(/"/g, '').toLowerCase() !== entry.sha256) {
        throw new DownloadAbort('DOWNLOAD_FAILED', 'linked_etag_mismatch');
      }
      await writeSidecar(tier, { url: entry.url, size: entry.size, sha256: entry.sha256, etag: linkedEtag });
      // ONE hop only: `redirect:'error'` makes a second redirect throw.
      res = await deps.fetch(location, { method: 'GET', redirect: 'error', headers: rangeHeaders(offset), signal });
    } else {
      await writeSidecar(tier, {
        url: entry.url,
        size: entry.size,
        sha256: entry.sha256,
        etag: res.headers.get('x-linked-etag'),
      });
    }

    if (res.status === 416) {
      await res.body?.cancel();
      return offset; // the part is already complete
    }
    if (res.status === 200 && offset > 0) {
      await removeQuietly(part); // server ignored Range: restart from zero
      offset = 0;
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel();
      throw new DownloadAbort('DOWNLOAD_FAILED', `http_${String(res.status)}`);
    }
    const body = res.body;
    if (body === null) throw new DownloadAbort('DOWNLOAD_FAILED', 'empty_body');

    const handle = await fsp.open(part, offset > 0 ? 'a' : 'w');
    const reader = body.getReader();
    let done = offset;
    const startedAt = deps.clock.now();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        await handle.write(buf);
        done += buf.length;
        const elapsed = Math.max(1, deps.clock.now() - startedAt);
        const bytesPerSec = Math.round(((done - offset) / elapsed) * 1000);
        emit(
          progressOf(tier, {
            status: 'downloading',
            bytesDone: done,
            bytesPerSec,
            etaSec: bytesPerSec > 0 ? Math.max(0, Math.round((entry.size - done) / bytesPerSec)) : null,
          }),
        );
      }
    } finally {
      await handle.close();
    }
    return done;
  };

  const verifyAndPromote = async (tier: ModelTier): Promise<void> => {
    const entry = entryOf(tier);
    const part = partPath(tier);
    const size = await sizeOf(part);
    if (size !== entry.size) throw new DownloadAbort('DOWNLOAD_FAILED', 'size_mismatch');
    if (!(await hasGgufMagic(part))) throw new DownloadAbort('DOWNLOAD_FAILED', 'bad_magic');
    record(tier, { status: 'verifying', bytesDone: size });
    emit(progressOf(tier, { status: 'verifying', bytesDone: size }), true);
    const digest = await sha256OfFile(part);
    if (digest !== entry.sha256) throw new DownloadAbort('DOWNLOAD_FAILED', 'sha256_mismatch');
    const target = finalPath(tier);
    await fsp.rename(part, target);
    await removeQuietly(sidecarPath(tier));
    const mtime = Math.round((await fsp.stat(target)).mtimeMs);
    record(tier, { status: 'ready', bytesDone: entry.size, mtime, verifiedAt: deps.clock.now() });
    emit(progressOf(tier, { status: 'ready', bytesDone: entry.size }), true);
    log.info('model_ready', { tier });
  };

  const run = async (tier: ModelTier, signal: AbortSignal): Promise<void> => {
    for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt += 1) {
      try {
        const done = await transfer(tier, signal);
        record(tier, { status: 'downloading', bytesDone: done });
        await verifyAndPromote(tier);
        return;
      } catch (err) {
        if (signal.aborted) {
          const paused = pausedTiers.has(tier);
          const bytes = await sizeOf(partPath(tier));
          record(tier, { status: paused ? 'paused' : 'none', bytesDone: bytes });
          emit(progressOf(tier, { status: paused ? 'paused' : 'none', bytesDone: bytes }), true);
          return;
        }
        const reason = err instanceof DownloadAbort ? err.message : 'network';
        const fatal = err instanceof DownloadAbort && /redirect_host_refused|linked_/.test(err.message);
        log.warn('model_download_failed', { tier, reason, attempt });
        // A corrupt body is deleted and re-downloaded exactly once; a refused redirect is never retried.
        if (/sha256_mismatch|bad_magic|size_mismatch/.test(reason)) await removeQuietly(partPath(tier));
        if (fatal || attempt === MAX_AUTO_RETRIES) {
          record(tier, { status: 'failed', bytesDone: await sizeOf(partPath(tier)) });
          emit(progressOf(tier, { status: 'failed', errorCode: 'DOWNLOAD_FAILED' }), true);
          return;
        }
      }
    }
  };

  const resolveTier = async (tier?: ModelTier): Promise<ModelTier> => {
    if (tier !== undefined) return tier;
    const selected = deps.selectedTier();
    if (selected !== 'auto') return selected;
    return (await deps.hardware()).recommendedTier;
  };

  const startInternal = async (tier: ModelTier): Promise<DownloadProgress> => {
    if (statusOf(tier) === 'ready' && (await sizeOf(finalPath(tier))) === entryOf(tier).size) {
      return progressOf(tier, { status: 'ready', bytesDone: entryOf(tier).size });
    }
    if (running.has(tier)) return progressOf(tier, { status: 'downloading' });
    const partBytes = await sizeOf(partPath(tier));
    const free = await deps.freeDiskBytes();
    if (free < requiredFreeBytes(entryOf(tier).size - partBytes)) {
      record(tier, { status: 'failed', bytesDone: partBytes });
      const p = progressOf(tier, { status: 'failed', bytesDone: partBytes, errorCode: 'DISK_FULL' });
      emit(p, true);
      return p;
    }
    await fsp.mkdir(deps.modelsDir, { recursive: true });
    pausedTiers.delete(tier);
    const controller = new AbortController();
    controllers.set(tier, controller);
    record(tier, { status: 'downloading', bytesDone: partBytes });
    const task = run(tier, controller.signal).finally(() => {
      running.delete(tier);
      controllers.delete(tier);
    });
    running.set(tier, task);
    const p = progressOf(tier, { status: 'downloading', bytesDone: partBytes });
    emit(p, true);
    return p;
  };

  const stopInternal = async (tier: ModelTier, paused: boolean): Promise<void> => {
    if (paused) pausedTiers.add(tier);
    controllers.get(tier)?.abort();
    const task = running.get(tier);
    if (task !== undefined) await task;
  };

  const plan = async (): Promise<ModelPlan> => {
    const hw = await deps.hardware();
    const selected = deps.selectedTier();
    const selectedTier = selected === 'auto' ? hw.recommendedTier : selected;
    const free = await deps.freeDiskBytes();
    const tiers: TierInfo[] = MODEL_TIERS.map((tier) => {
      const entry = entryOf(tier);
      const rec = deps.repos.models.get(tier);
      const bytesDone = rec?.status === 'ready' ? entry.size : (rec?.bytesDone ?? 0);
      return {
        tier,
        modelLabel: entry.label,
        sizeBytes: entry.size,
        status: rec?.status ?? 'none',
        bytesDone,
        fitsDisk: rec?.status === 'ready' || free >= requiredFreeBytes(entry.size - bytesDone),
        tokPerSec: rec?.bench?.tokPerSec ?? null,
      };
    });
    const bench = deps.repos.models.get(selectedTier)?.bench ?? null;
    const smallerExists = MODEL_TIERS.indexOf(selectedTier) > 0;
    return {
      recommendedTier: hw.recommendedTier,
      selectedTier,
      tiers,
      suggestSmaller: smallerExists && bench !== null && bench.tokPerSec < SUGGEST_SMALLER_TOK_PER_SEC,
    };
  };

  return {
    plan,
    start: async (tier) => startInternal(await resolveTier(tier)),
    pause: async (tier) => {
      const t = await resolveTier(tier);
      await stopInternal(t, true);
      const bytes = await sizeOf(partPath(t));
      record(t, { status: 'paused', bytesDone: bytes });
      const p = progressOf(t, { status: 'paused', bytesDone: bytes });
      emit(p, true);
      return p;
    },
    resume: async (tier) => startInternal(await resolveTier(tier)),
    cancel: async (tier) => {
      const t = await resolveTier(tier);
      await stopInternal(t, false);
      await removeQuietly(partPath(t));
      await removeQuietly(sidecarPath(t));
      deps.repos.models.delete(t);
      emit(progressOf(t, { status: 'none', bytesDone: 0 }), true);
      return plan();
    },
    delete: async (tier) => {
      await stopInternal(tier, false);
      await removeQuietly(partPath(tier));
      await removeQuietly(sidecarPath(tier));
      await removeQuietly(finalPath(tier));
      deps.repos.models.delete(tier);
      emit(progressOf(tier, { status: 'none', bytesDone: 0 }), true);
      log.info('model_deleted', { tier });
      return plan();
    },
    onProgress: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readyPath: (tier) => {
      const rec = deps.repos.models.get(tier);
      if (rec === null || rec.status !== 'ready') return null;
      return finalPath(tier);
    },
  };
}
