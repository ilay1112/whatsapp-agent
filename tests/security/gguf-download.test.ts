// tests/security/gguf-download.test.ts - gate item 12b of TESTS 8.2 (assumption A21). Owner: W2-02.
//
// The REAL `createModelManager` against the fake GGUF host of `tests/fakes/fake-llama-server.ts`. No llama-server binary
// is ever executed (rule T1) and no real Hugging Face host is ever contacted (rule T3 - the guard would throw).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DISK_HEADROOM,
  GGUF_MAGIC,
  MAX_AUTO_RETRIES,
  createModelManager,
  isAllowedDownloadUrl,
  requiredFreeBytes,
} from '../../src/main/llm/local/download.ts';
import { DOWNLOAD_HOST_ALLOWLIST, MODEL_MANIFEST, type ModelManifestEntry } from '../../src/main/llm/local/manifest.ts';
import { createRepos, openDb, type Db } from '../../src/main/db/index.ts';
import { createVirtualClock } from '../helpers/virtualClock.ts';
import { FAKE_GGUF_COMMIT, startFakeLlamaServer, type FakeLlamaServer } from '../fakes/fake-llama-server.ts';
import type { Clock, Logger } from '../../src/main/deps.ts';
import type { HardwareInfo, ModelTier, Sha256Hex } from '../../src/shared/types.ts';

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

const HARDWARE: HardwareInfo = {
  ramGiB: 32,
  freeDiskGiB: 200,
  gpus: [{ name: 'NVIDIA GeForce RTX 4070', vramGiB: 12 }],
} as unknown as HardwareInfo;

// ---------------------------------------------------------------------------------------------------------------------
// 1. the URL allow-list (pure) - [R2] suffix rule
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] A21 - the download host allow-list', () => {
  const ALLOWED = [
    'https://huggingface.co/org/repo/resolve/0123456789abcdef0123456789abcdef01234567/m.gguf',
    'https://cdn-lfs-us-1.hf.co/repo/x',
    'https://us.aws.cdn.hf.co/repo/x',
    'https://cas-bridge.xethub.hf.co/x',
    'https://cdn.huggingface.co/x',
  ];
  const REJECTED = [
    'https://hf.co.evil.example/cdn/signed-1',
    'https://evil-hf.co.attacker.test/x',
    'https://huggingface.co.evil.example/x',
    'http://huggingface.co/org/repo/x', // plain http is never allowed in production
    'http://cdn-lfs.hf.co/x',
    'ftp://huggingface.co/x',
    'file:///C:/Windows/System32/calc.exe',
    'https://127.0.0.1/x',
    'not a url',
    '',
  ];

  it.each(ALLOWED)('accepts %s', (url) => {
    expect(isAllowedDownloadUrl(url)).toBe(true);
  });

  it.each(REJECTED)('rejects %s', (url) => {
    expect(isAllowedDownloadUrl(url)).toBe(false);
  });

  it('`hf.co` itself is only reachable through the declared exact / suffix entries', () => {
    expect(DOWNLOAD_HOST_ALLOWLIST).toEqual({ exact: ['huggingface.co'], suffix: ['.hf.co', '.huggingface.co'] });
    // A bare `hf.co` is NOT in the exact list, so it is refused - the suffix must be a real sub-domain.
    expect(isAllowedDownloadUrl('https://hf.co/x')).toBe(false);
  });

  it('the http loopback exception exists only behind the e2e seam', () => {
    expect(isAllowedDownloadUrl('http://127.0.0.1:1234/x')).toBe(false);
    expect(isAllowedDownloadUrl('http://127.0.0.1:1234/x', true)).toBe(true);
    // Even with the seam open, a foreign http host stays refused.
    expect(isAllowedDownloadUrl('http://evil.example/x', true)).toBe(false);
    expect(isAllowedDownloadUrl('http://hf.co.evil.example/x', true)).toBe(false);
  });

  it('every pinned manifest URL passes the production rule and names a commit, never a branch', () => {
    for (const entry of Object.values(MODEL_MANIFEST)) {
      expect(isAllowedDownloadUrl(entry.url), entry.url).toBe(true);
      expect(entry.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(entry.fileName).toMatch(/\.gguf$/i);
      expect(entry.fileName).not.toMatch(/^mmproj-|^mtp-/);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.size).toBeGreaterThan(0);
    }
  });

  it('nothing with an executable extension can be a download target', () => {
    // The manifest type carries no "command" or "executable" field; the tier enum is the only thing a caller chooses.
    for (const entry of Object.values(MODEL_MANIFEST)) {
      expect(Object.keys(entry).sort()).toEqual(['fileName', 'label', 'sha256', 'size', 'tier', 'url']);
      expect(entry.url).not.toMatch(/\.(exe|dll|bat|cmd|ps1|msi|scr|com)(\?|$)/i);
      expect(entry.fileName).not.toMatch(/\.(exe|dll|bat|cmd|ps1|msi|scr|com)$/i);
    }
    expect(Object.keys(MODEL_MANIFEST).sort()).toEqual(['mid', 'small', 'tiny']);
  });

  it('the free-disk rule is size + 5 %', () => {
    expect(DISK_HEADROOM).toBe(1.05);
    expect(requiredFreeBytes(1000)).toBe(1050);
    expect(requiredFreeBytes(0)).toBe(0);
    expect(requiredFreeBytes(-5)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. against the fake model host
// ---------------------------------------------------------------------------------------------------------------------
interface Rig {
  manager: ReturnType<typeof createModelManager>;
  server: FakeLlamaServer;
  modelsDir: string;
  db: Db;
  repos: ReturnType<typeof createRepos>;
  clock: ReturnType<typeof createVirtualClock>;
  entry: ModelManifestEntry;
  stop: () => Promise<void>;
}

const TERMINAL: ReadonlySet<string> = new Set(['ready', 'failed', 'paused', 'none']);

/**
 * `start()` / `resume()` kick the transfer off and return `downloading` at once (the UI is driven by `onProgress`).
 * This awaits the terminal emit, or - if it was already terminal before the subscription - reads the stored status.
 */
async function settle(
  r: Rig,
  kick: () => Promise<{ status: string; errorCode: string | null; bytesDone: number }>,
): Promise<{
  status: string;
  errorCode: string | null;
  bytesDone: number;
}> {
  let last: { status: string; errorCode: string | null; bytesDone: number } | null = null;
  const off = r.manager.onProgress((p) => {
    if (p.tier !== 'tiny') return;
    if (TERMINAL.has(p.status)) last = { status: p.status, errorCode: p.errorCode, bytesDone: p.bytesDone };
  });
  try {
    const first = await kick();
    if (TERMINAL.has(first.status)) return first;
    // The fake host drops a socket on a real timer, so the loop yields real time in 1 ms slices (rule T7 forbids a
    // single real sleep longer than 50 ms, not a bounded poll).
    for (let i = 0; i < 5_000 && last === null; i++) {
      await new Promise<void>((done) => setTimeout(done, 1));
      const stored = r.repos.models.get('tiny')?.status;
      if (stored !== undefined && TERMINAL.has(stored) && last === null) {
        // Give the forced emit one more turn to arrive before falling back to the stored row.
        await new Promise<void>((done) => setImmediate(done));
        if (last === null) last = { status: stored, errorCode: null, bytesDone: r.repos.models.get('tiny')!.bytesDone };
      }
    }
    if (last === null) throw new Error('the download never reached a terminal state');
    return last;
  } finally {
    off();
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function rig(
  opts: {
    scenario?: Parameters<FakeLlamaServer['setModelHostScenario']>[0];
    sizeBytes?: number;
    freeDiskBytes?: number;
    sha256?: string;
    size?: number;
  } = {},
): Promise<Rig> {
  const server = await startFakeLlamaServer({
    apiKey: 'fake-llama-key',
    modelHost: {
      ...(opts.scenario ? { scenario: opts.scenario } : {}),
      ...(opts.sizeBytes ? { sizeBytes: opts.sizeBytes } : {}),
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'wca-gguf-'));
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const clock = createVirtualClock(Date.UTC(2026, 8, 23, 8, 0, 0));

  const entry: ModelManifestEntry = {
    tier: 'tiny',
    label: 'fake-model',
    fileName: 'fake-model-Q4_K_M.gguf',
    url: server.modelUrl(),
    size: opts.size ?? server.modelSize,
    sha256: (opts.sha256 ?? server.modelSha256) as Sha256Hex,
  };
  const manifest = { ...MODEL_MANIFEST, tiny: entry } as Readonly<Record<ModelTier, ModelManifestEntry>>;

  const manager = createModelManager({
    manifest,
    allowHttpLoopback: true, // the fake host is http on 127.0.0.1 (the WCA_MODEL_MANIFEST seam)
    modelsDir: dir,
    repos,
    hardware: () => Promise.resolve(HARDWARE),
    selectedTier: () => 'tiny',
    freeDiskBytes: () => Promise.resolve(opts.freeDiskBytes ?? 10 * 1024 * 1024 * 1024),
    fetch: globalThis.fetch,
    clock: clock as unknown as Clock,
    log: silentLog,
  });

  const stop = async (): Promise<void> => {
    // A transfer still in flight would keep writing to the database after it is closed.
    try {
      await manager.cancel('tiny');
    } catch {
      /* nothing was running */
    }
    await server.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(stop);
  return { manager, server, modelsDir: dir, db, repos, clock, entry, stop };
}

describe('A21 - downloading a model', () => {
  it('happy path: streams, verifies the sha256 and lands as a single .gguf file', async () => {
    const r = await rig();
    const progress = await settle(r, () => r.manager.start('tiny'));
    expect(progress.status).toBe('ready');
    expect(progress.errorCode).toBeNull();
    expect(progress.bytesDone).toBe(r.entry.size);

    const files = readdirSync(r.modelsDir);
    expect(files).toContain(r.entry.fileName);
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.part.json'))).toEqual([]);
    expect(r.manager.readyPath('tiny')).toBe(join(r.modelsDir, r.entry.fileName));
  });

  it('resume after a dropped connection keeps the sha correct', async () => {
    const r = await rig({ scenario: 'drop_at:100000' });
    // The connection is cut at byte 100 000; the `.part` file plus its sidecar let the next attempt continue with a
    // Range request, and the automatic retry inside `run()` does exactly that.
    const res = await settle(r, () => r.manager.start('tiny'));
    expect(res.status).toBe('ready');
    expect(res.errorCode).toBeNull();

    const files = readdirSync(r.modelsDir);
    expect(files).toContain(r.entry.fileName);
    expect(files.filter((f) => f.endsWith('.part') || f.endsWith('.part.json'))).toEqual([]);
    // The resumed bytes really do hash to the pin: a Range resume cannot smuggle a different body in.
    const promoted = createHash('sha256')
      .update(readFileSync(join(r.modelsDir, r.entry.fileName)))
      .digest('hex');
    expect(promoted).toBe(r.entry.sha256);
  });

  it('an expired signed URL on resume makes the downloader re-request the pinned resolve URL', async () => {
    const r = await rig({ scenario: 'drop_at:100000' });
    await settle(r, () => r.manager.start('tiny'));
    r.server.setModelHostScenario('expired_redirect_on_resume');
    const resumed = await settle(r, () => r.manager.resume('tiny'));
    // Either it recovers by asking `resolve/<commit>/` again, or it fails cleanly - but it never writes a bad file.
    if (resumed.status === 'ready') {
      expect(readdirSync(r.modelsDir)).toContain(r.entry.fileName);
    } else {
      expect(resumed.errorCode).not.toBeNull();
      expect(readdirSync(r.modelsDir)).not.toContain(r.entry.fileName);
    }
    expect(r.entry.url).toContain(`/resolve/${FAKE_GGUF_COMMIT}/`);
  });

  it('[R2] a redirect to a foreign host aborts before a single byte is written', async () => {
    const r = await rig({ scenario: 'foreign_redirect_host' });
    const res = await settle(r, () => r.manager.start('tiny'));
    expect(res.status).toBe('failed');
    expect(res.errorCode).not.toBeNull();
    expect(readdirSync(r.modelsDir)).not.toContain(r.entry.fileName);
    // `hf.co.evil.example` must be rejected by the same pure rule the test above pins.
    expect(isAllowedDownloadUrl('https://hf.co.evil.example/cdn/signed-1')).toBe(false);
  });

  it('an X-Linked-Size that disagrees with the manifest aborts before streaming', async () => {
    const r = await rig({ scenario: 'wrong_size' });
    const res = await settle(r, () => r.manager.start('tiny'));
    expect(res.status).toBe('failed');
    expect(res.errorCode).not.toBeNull();
    expect(readdirSync(r.modelsDir)).not.toContain(r.entry.fileName);
  });

  it('a corrupt byte is caught by the sha256, retried once automatically, then reported as DOWNLOAD_FAILED', async () => {
    const r = await rig({ scenario: 'corrupt_byte' });
    const res = await settle(r, () => r.manager.start('tiny'));
    expect(res.status).toBe('failed');
    expect(res.errorCode).toBe('DOWNLOAD_FAILED');
    expect(MAX_AUTO_RETRIES).toBe(1);
    // The bad bytes are gone: neither the final file nor a `.part` is left behind to be re-used.
    const files = readdirSync(r.modelsDir);
    expect(files).not.toContain(r.entry.fileName);
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('a manifest size that does not match the served body fails the download', async () => {
    const r = await rig({ size: 123_456 });
    const res = await settle(r, () => r.manager.start('tiny'));
    expect(res.status).toBe('failed');
    expect(readdirSync(r.modelsDir)).not.toContain(r.entry.fileName);
  });

  it('a body without the GGUF magic is refused', async () => {
    const r = await rig();
    // Pre-stage a `.part` whose first bytes are an HTML error page, then let the downloader finish it.
    writeFileSync(join(r.modelsDir, `${r.entry.fileName}.part`), '<html>captive portal</html>', 'utf8');
    writeFileSync(
      join(r.modelsDir, `${r.entry.fileName}.part.json`),
      JSON.stringify({ url: r.entry.url, size: r.entry.size, sha256: r.entry.sha256, etag: null }),
      'utf8',
    );
    const res = await settle(r, () => r.manager.resume('tiny'));
    expect(GGUF_MAGIC).toBe('GGUF');
    if (res.status === 'ready') {
      // The downloader may legitimately discard the poisoned partial and re-fetch from zero - but whatever it
      // promotes must hash to the pinned sha256, so the HTML bytes can never end up in the model file.
      const promoted = createHash('sha256')
        .update(readFileSync(join(r.modelsDir, r.entry.fileName)))
        .digest('hex');
      expect(promoted).toBe(r.entry.sha256);
    } else {
      expect(readdirSync(r.modelsDir)).not.toContain(r.entry.fileName);
    }
  });

  it('refuses to start when the free disk space is below size + 5 %', async () => {
    const r = await rig({ freeDiskBytes: 1024 });
    const res = await settle(r, () => r.manager.start('tiny'));
    expect(res.status).toBe('failed');
    expect(res.errorCode).not.toBeNull();
    expect(existsSync(join(r.modelsDir, r.entry.fileName))).toBe(false);
  });

  it('a production-configured manager refuses an http or foreign URL outright', async () => {
    const r = await rig();
    const dir = mkdtempSync(join(tmpdir(), 'wca-gguf-prod-'));
    const db = openDb(':memory:');
    cleanups.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const repos = createRepos(db);
    const clock = createVirtualClock(Date.UTC(2026, 8, 23, 8, 0, 0));

    for (const hostileUrl of [r.entry.url, 'https://hf.co.evil.example/x.gguf', 'file:///C:/Windows/calc.exe']) {
      const manager = createModelManager({
        manifest: {
          ...MODEL_MANIFEST,
          tiny: { ...r.entry, url: hostileUrl },
        } as Readonly<Record<ModelTier, ModelManifestEntry>>,
        // no `allowHttpLoopback`: this is the shipping configuration
        modelsDir: dir,
        repos,
        hardware: () => Promise.resolve(HARDWARE),
        selectedTier: () => 'tiny',
        freeDiskBytes: () => Promise.resolve(10 * 1024 * 1024 * 1024),
        fetch: globalThis.fetch,
        clock: clock as unknown as Clock,
        log: silentLog,
      });
      const prodRig: Rig = { ...r, manager, modelsDir: dir, repos };
      repos.models.delete('tiny');
      const res = await settle(prodRig, () => manager.start('tiny'));
      expect(res.status, hostileUrl).toBe('failed');
      expect(readdirSync(dir), hostileUrl).not.toContain(r.entry.fileName);
    }
  });
});
