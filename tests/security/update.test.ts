// tests/security/update.test.ts - v5 T-909 security gate for in-app updates (docs/specs/v5-updates-handover.md "Review focus").
// The REAL UpdateService against the fake GitHub Releases host (loopback only - rule T3; no real GitHub host is ever contacted).
//   1. release.json's sha256 does not match the zip  -> the file is deleted, UPDATE_VERIFY_FAILED, never 'ready', never installed
//   2. a redirect from the download URL to a foreign host -> refused before any request to it, never retried
//   +  a zip that tries to write outside its folder -> refused, nothing written, UPDATE_VERIFY_FAILED
//   +  the production configuration never reaches loopback / http; logs and audit never carry a URL or a path
//   +  nothing is ever spawned before an explicit install of a verified, staged build
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVirtualClock } from '../helpers/virtualClock.ts';
import { FAKE_EXE_NAME, startFakeGithubReleases, type FakeReleaseScenario } from '../fakes/fake-github-releases.ts';
import { createUpdateService, type UpdateServiceDeps } from '../../src/main/update/updateService.ts';
import { UPDATE_API_BASE, UPDATE_HOST_ALLOWLIST } from '../../src/shared/update.ts';
import { isAllowedUrl } from '../../src/main/net/pinnedDownload.ts';
import { IPC_REQUEST_SCHEMAS } from '../../src/shared/ipc.ts';
import type { Logger } from '../../src/main/deps.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function rig(scenario: FakeReleaseScenario, over: Partial<UpdateServiceDeps> = {}) {
  const fake = await startFakeGithubReleases({ scenario });
  cleanups.push(() => fake.stop());
  const root = mkdtempSync(join(tmpdir(), 'wca-update-sec-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const installDir = join(root, 'portable', 'WhatsApp Calendar Agent');
  mkdirSync(join(installDir, 'resources'), { recursive: true });
  writeFileSync(join(installDir, FAKE_EXE_NAME), 'MZ');
  writeFileSync(join(installDir, 'resources', 'app.asar'), 'asar');
  const lines: string[] = [];
  const log: Logger = {
    info: (e, m) => lines.push(JSON.stringify([e, m ?? {}])),
    warn: (e, m) => lines.push(JSON.stringify([e, m ?? {}])),
    error: (e, m) => lines.push(JSON.stringify([e, m ?? {}])),
    child: () => log,
  };
  const audit: string[] = [];
  const spawns: unknown[] = [];
  const svc = createUpdateService({
    currentVersion: '0.1.7',
    fetch: globalThis.fetch,
    clock: createVirtualClock(),
    log,
    meta: { get: () => null, set: () => undefined },
    audit: { append: (kind, ref, detail) => void audit.push(JSON.stringify([kind, ref, detail])) },
    updatesDir: join(root, 'userData', 'updates'),
    logsDir: join(root, 'userData', 'logs'),
    apiBase: fake.url,
    allowHttpLoopback: true,
    install: { isPackaged: true, exePath: join(installDir, FAKE_EXE_NAME), pid: 1234 },
    spawnDetached: (...a) => void spawns.push(a),
    requestQuit: () => undefined,
    probeWritable: async () => true,
    ...over,
  });
  cleanups.push(() => svc.stop());
  await svc.settled();
  return { svc, fake, root, installDir, lines, audit, spawns, updates: join(root, 'userData', 'updates') };
}

describe("review blocker - the swap may only ever touch the app's own folder", () => {
  it('a build extracted INTO a user folder (Downloads-style extras next to the exe) is never installable', async () => {
    const r = await rig('default');
    writeFileSync(join(r.installDir, 'photo.jpg'), 'jpg');
    mkdirSync(join(r.installDir, 'Documents'));
    const r2 = await rig('default', {
      install: { isPackaged: true, exePath: join(r.installDir, FAKE_EXE_NAME), pid: 1234 },
    });
    expect(r2.svc.state().canInstall).toBe(false);
    await r2.svc.check();
    await r2.svc.download();
    await r2.svc.settled();
    expect(r2.svc.state().status).toBe('ready');
    expect(await r2.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(r2.spawns).toEqual([]);
    expect(readFileSync(join(r.installDir, 'photo.jpg'), 'utf8')).toBe('jpg');
  });

  it('the release zip must be exactly one WhatsAppCalendarAgent/ folder: a flat zip is refused', async () => {
    const r = await rig('flat_layout');
    await r.svc.check();
    await r.svc.download();
    await r.svc.settled();
    expect(r.svc.state()).toMatchObject({ status: 'error', errorCode: 'UPDATE_VERIFY_FAILED' });
    expect(readdirSync(join(r.updates, '0.1.9'))).toEqual([]);
  });
});

describe('review focus 1 - a zip whose sha256 does not match release.json', () => {
  it('is deleted, reported as UPDATE_VERIFY_FAILED, never ready, never installable, never retried', async () => {
    const r = await rig('sha_mismatch');
    expect((await r.svc.check()).status).toBe('available');
    await r.svc.download();
    await r.svc.settled();
    expect(r.svc.state()).toMatchObject({ status: 'error', errorCode: 'UPDATE_VERIFY_FAILED' });
    expect(readdirSync(join(r.updates, '0.1.9'))).toEqual([]); // no zip, no .part, no sidecar, no extracted tree
    expect(r.fake.requests.filter((q) => q.path.startsWith('/cdn/') && q.path.endsWith('.zip'))).toHaveLength(1);
    expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(r.spawns).toEqual([]);
    expect(r.lines).toContain(JSON.stringify(['update_verify_failed', { reason: 'sha256_mismatch' }]));
  });
});

describe('review focus 2 - a redirect to a foreign host during the zip download', () => {
  it('is refused before any request reaches it, and is not retried', async () => {
    const r = await rig('foreign_redirect');
    await r.svc.check();
    await r.svc.download();
    await r.svc.settled();
    expect(r.svc.state()).toMatchObject({ status: 'error', errorCode: 'DOWNLOAD_FAILED' });
    // exactly one request to the github.com-style download URL; the setup guard would have thrown on evil.example
    expect(r.fake.requests.filter((q) => q.path.endsWith('.zip'))).toHaveLength(1);
    expect(r.lines).toContain(
      JSON.stringify(['update_download', { status: 'error', reason: 'redirect_host_refused' }]),
    );
    expect(existsSync(join(r.updates, '0.1.9', 'win-unpacked'))).toBe(false);
    expect(r.spawns).toEqual([]);
  });
});

describe('a release zip that tries to escape its folder', () => {
  it('(sha256 correct) is refused by the extractor: nothing written outside or inside, UPDATE_VERIFY_FAILED', async () => {
    const r = await rig('traversal_zip');
    await r.svc.check();
    await r.svc.download();
    await r.svc.settled();
    expect(r.svc.state()).toMatchObject({ status: 'error', errorCode: 'UPDATE_VERIFY_FAILED' });
    expect(readdirSync(join(r.updates, '0.1.9'))).toEqual([]);
    expect(existsSync(join(r.updates, 'evil.txt'))).toBe(false);
    expect(existsSync(join(r.updates, '0.1.9', 'evil.txt'))).toBe(false);
    expect(r.lines).toContain(JSON.stringify(['update_verify_failed', { reason: 'zip_unsafe_path' }]));
  });
});

describe('the production configuration', () => {
  it('allows https GitHub hosts only - never http, never loopback, never a look-alike', () => {
    for (const ok of [
      'https://api.github.com/repos/ilay1112/whatsapp-agent/releases/latest',
      'https://github.com/ilay1112/whatsapp-agent/releases/download/v0.1.9/release.json',
      'https://objects.githubusercontent.com/github-production-release-asset/x',
      'https://release-assets.githubusercontent.com/x',
    ])
      expect(isAllowedUrl(ok, UPDATE_HOST_ALLOWLIST), ok).toBe(true);
    for (const bad of [
      'http://github.com/x',
      'http://127.0.0.1:1/x',
      'https://127.0.0.1/x',
      'https://github.com.evil.example/x',
      'https://githubusercontent.com.evil.example/x',
      'https://evil.example/x?u=https://github.com',
      'https://gist.github.com/x',
      'https://raw.githubusercontent.co/x',
      'file:///C:/x.zip',
    ])
      expect(isAllowedUrl(bad, UPDATE_HOST_ALLOWLIST), bad).toBe(false);
    expect(UPDATE_API_BASE).toBe('https://api.github.com');
  });

  it('with the loopback gate shut, a loopback API base is refused without a single request', async () => {
    const r = await rig('default', { allowHttpLoopback: false });
    expect(await r.svc.check()).toMatchObject({ status: 'error', errorCode: 'UPDATE_CHECK_FAILED' });
    expect(r.fake.requests).toEqual([]);
  });
});

describe('src/shared/update.ts stays renderer-safe', () => {
  it('imports nothing but zod (no Node built-in, no main module)', () => {
    const src = readFileSync(new URL('../../src/shared/update.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['zod']);
    expect(src).not.toMatch(/require\(|process\.|node:/);
  });
});

describe('what leaves the app and what is written', () => {
  it('requests carry no credentials and only the version in User-Agent; logs and audit carry no URL or path', async () => {
    const r = await rig('default');
    await r.svc.check();
    await r.svc.download();
    await r.svc.settled();
    expect(r.svc.state().status).toBe('ready');
    expect(r.spawns).toEqual([]); // the zip is extracted, never executed; nothing starts before an explicit install
    for (const q of r.fake.requests) {
      expect(q.hasAuthorization).toBe(false);
      expect(q.userAgent).toBe('WhatsAppCalendarAgent/0.1.7');
    }
    r.svc.ignore('0.1.9');
    const res = await r.svc.install();
    expect(res.ok).toBe(true);
    const text = [...r.lines, ...r.audit].join('\n');
    expect(text).not.toMatch(/https?:|127\.0\.0\.1|githubusercontent|[A-Za-z]:\\|\\\\|\/cdn\//);
    expect(r.audit.map((a) => JSON.parse(a)[0])).toEqual(['update_ignored', 'update_install_started']);
  });

  it('no update:* request schema accepts a URL, a path or a file name', () => {
    const channels = Object.keys(IPC_REQUEST_SCHEMAS).filter((c) => c.startsWith('update:')) as Array<
      keyof typeof IPC_REQUEST_SCHEMAS
    >;
    expect(channels.sort()).toEqual(
      [
        'update:check',
        'update:download',
        'update:getState',
        'update:ignore',
        'update:install',
        'update:unignore',
      ].sort(),
    );
    for (const c of channels) {
      for (const evil of [
        { url: 'https://evil.example/x.zip' },
        { path: 'C:\\x.exe' },
        { version: '0.1.9', url: 'https://evil.example' },
        { version: '..\\..\\x' },
      ])
        expect(IPC_REQUEST_SCHEMAS[c].safeParse(evil).success, `${c} ${JSON.stringify(evil)}`).toBe(false);
    }
  });
});
