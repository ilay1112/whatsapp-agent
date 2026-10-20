// src/main/update/updateService.test.ts - v5 W2: UpdateService against the fake GitHub Releases host (real loopback HTTP, real
// fetch, real temp folders). Check -> states, ignore / unignore persistence, download + sha256 + unzip -> ready, install gating
// and the journaled updater argv, the schedule, the launch after an install. The security-review cases (sha mismatch, foreign
// redirect, traversal zip) are repeated end-to-end in tests/security/update.test.ts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVirtualClock, type VirtualClock } from '../../../tests/helpers/virtualClock';
import {
  FAKE_EXE_NAME,
  startFakeGithubReleases,
  type FakeGithubReleases,
  type FakeGithubReleasesOptions,
} from '../../../tests/fakes/fake-github-releases';
import type { Logger, LogMeta } from '../deps';
import type { AuditKind, MetaKey, UpdateState } from '../../shared/types';
import { LIMITS } from '../../shared/types';
import {
  UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_MANUAL_MIN_GAP_MS,
  UPDATE_QUIT_DELAY_MS,
  createUpdateService,
  type UpdateService,
  type UpdateServiceDeps,
} from './updateService';
import { UPDATER_SCRIPT } from './updaterScript';

interface LogLine {
  level: 'info' | 'warn' | 'error';
  event: string;
  meta: LogMeta | undefined;
}
function recordingLog(lines: LogLine[]): Logger {
  const l: Logger = {
    info: (event, meta) => lines.push({ level: 'info', event, meta }),
    warn: (event, meta) => lines.push({ level: 'warn', event, meta }),
    error: (event, meta) => lines.push({ level: 'error', event, meta }),
    child: () => l,
  };
  return l;
}

interface Rig {
  svc: UpdateService;
  fake: FakeGithubReleases;
  clock: VirtualClock;
  root: string;
  userData: string;
  installDir: string;
  meta: Map<MetaKey, string>;
  audit: Array<{ kind: AuditKind; detail: Record<string, unknown> }>;
  logs: LogLine[];
  spawns: Array<{ command: string; args: readonly string[]; cwd: string; env: Record<string, string> }>;
  quits: number;
  pushes: UpdateState[];
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function rig(
  opts: {
    fake?: FakeGithubReleasesOptions;
    current?: string;
    packaged?: boolean;
    writable?: boolean;
    meta?: Partial<Record<MetaKey, string>>;
    argv?: string[];
    apiBase?: string | null;
    freeDisk?: number;
    firstCheckDelayMs?: number;
    /** extra top-level files ('x') / folders ('x/') in the install folder (default: a clean packaged build only) */
    installExtras?: string[];
    /** the install folder is one of these "protected" paths: true = itself */
    protectInstallDir?: boolean;
    env?: Record<string, string>;
  } = {},
): Promise<Rig> {
  const fake = await startFakeGithubReleases(opts.fake);
  cleanups.push(() => fake.stop());
  const root = mkdtempSync(join(tmpdir(), 'wca-update-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const userData = join(root, 'userData');
  const installDir = join(root, 'portable', 'WhatsApp Calendar Agent');
  mkdirSync(join(installDir, 'resources'), { recursive: true });
  writeFileSync(join(installDir, FAKE_EXE_NAME), 'MZ old');
  writeFileSync(join(installDir, 'resources', 'app.asar'), 'asar old');
  writeFileSync(join(installDir, 'icudtl.dat'), 'icu');
  for (const e of opts.installExtras ?? [])
    if (e.endsWith('/')) mkdirSync(join(installDir, e.slice(0, -1)));
    else writeFileSync(join(installDir, e), 'x');
  mkdirSync(userData, { recursive: true });
  const clock = createVirtualClock(Date.UTC(2026, 9, 20, 9, 0, 0));
  const meta = new Map<MetaKey, string>(Object.entries(opts.meta ?? {}) as Array<[MetaKey, string]>);
  const r: Rig = {
    svc: undefined as unknown as UpdateService,
    fake,
    clock,
    root,
    userData,
    installDir,
    meta,
    audit: [],
    logs: [],
    spawns: [],
    quits: 0,
    pushes: [],
  };
  const deps: UpdateServiceDeps = {
    currentVersion: opts.current ?? '0.1.7',
    fetch: globalThis.fetch,
    clock,
    log: recordingLog(r.logs),
    meta: { get: (k) => meta.get(k) ?? null, set: (k, v) => void meta.set(k, v) },
    audit: { append: (kind, _ref, detail) => void r.audit.push({ kind, detail }) },
    updatesDir: join(userData, 'updates'),
    logsDir: join(userData, 'logs'),
    apiBase: opts.apiBase === undefined ? fake.url : opts.apiBase,
    allowHttpLoopback: true,
    install: { isPackaged: opts.packaged ?? true, exePath: join(installDir, FAKE_EXE_NAME), pid: 4242 },
    spawnDetached: (command, args, o) => void r.spawns.push({ command, args, cwd: o.cwd, env: o.env }),
    requestQuit: () => {
      r.quits += 1;
    },
    argv: opts.argv ?? [],
    env: opts.env ?? { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows;C:\\tools', ELECTRON_RUN_AS_NODE: '0' },
    probeWritable: async () => opts.writable ?? true,
    protectedDirs: opts.protectInstallDir === true ? [installDir] : [],
    ...(opts.firstCheckDelayMs === undefined ? {} : { firstCheckDelayMs: opts.firstCheckDelayMs }),
    ...(opts.freeDisk === undefined ? {} : { freeDiskBytes: async () => opts.freeDisk! }),
  };
  r.svc = createUpdateService(deps);
  r.svc.onChange((s) => r.pushes.push(s));
  cleanups.push(() => r.svc.stop());
  await r.svc.settled();
  return r;
}
async function downloadToEnd(r: Rig): Promise<UpdateState> {
  const res = await r.svc.download();
  expect(res.ok).toBe(true);
  await r.svc.settled();
  return r.svc.state();
}

describe('check', () => {
  it('a newer release -> available; the request carries only the version in User-Agent', async () => {
    const r = await rig();
    const s = await r.svc.check();
    expect(s).toMatchObject({ status: 'available', latest: '0.1.9', current: '0.1.7', errorCode: null });
    expect(s.lastCheckAt).toBe(r.clock.now());
    expect(r.meta.get('update_latest_seen')).toBe('0.1.9');
    expect(r.meta.get('update_last_check_at')).toBe(String(r.clock.now()));
    const api = r.fake.requests.find((q) => q.path.endsWith('/releases/latest'))!;
    expect(api.userAgent).toBe('WhatsAppCalendarAgent/0.1.7');
    expect(api.accept).toBe('application/vnd.github+json');
    expect(r.fake.requests.every((q) => !q.hasAuthorization)).toBe(true);
    expect(r.fake.requests.map((q) => q.path)).toEqual([
      '/repos/ilay1112/whatsapp-agent/releases/latest',
      '/ilay1112/whatsapp-agent/releases/download/v0.1.9/release.json',
      '/cdn/0.1.9/release.json',
    ]);
    expect(r.logs).toContainEqual({
      level: 'info',
      event: 'update_check',
      meta: { status: 'available', latest: '0.1.9' },
    });
  });

  it('the same or an older release -> up_to_date (release.json is not even fetched)', async () => {
    const r = await rig({ current: '0.1.9' });
    expect((await r.svc.check()).status).toBe('up_to_date');
    expect(r.fake.requests).toHaveLength(1);
    const older = await rig({ current: '0.2.0' });
    expect(await older.svc.check()).toMatchObject({ status: 'up_to_date', latest: '0.1.9' });
  });

  it('no release published yet (404) -> up_to_date', async () => {
    const r = await rig({ fake: { version: null } });
    expect(await r.svc.check()).toMatchObject({ status: 'up_to_date', latest: null, errorCode: null });
  });

  it.each([
    ['api_error', 'http_500'],
    ['bad_manifest', 'bad_manifest'],
    ['no_manifest_asset', 'no_manifest'],
  ] as const)('%s -> error UPDATE_CHECK_FAILED (no banner state), logged without a URL', async (scenario, reason) => {
    const r = await rig({ fake: { scenario } });
    const s = await r.svc.check();
    expect(s).toMatchObject({ status: 'error', errorCode: 'UPDATE_CHECK_FAILED' });
    expect(r.logs).toContainEqual({ level: 'warn', event: 'update_check', meta: { status: 'error', reason } });
    expect(JSON.stringify(r.logs)).not.toMatch(/https?:|127\.0\.0\.1|[A-Za-z]:\\/);
  });

  it('offline (connection refused) -> error UPDATE_CHECK_FAILED', async () => {
    const r = await rig();
    await r.fake.stop();
    expect(await r.svc.check()).toMatchObject({ status: 'error', errorCode: 'UPDATE_CHECK_FAILED' });
  });

  it('no network in this run (apiBase null): nothing scheduled, a manual check fails closed without a request', async () => {
    const r = await rig({ apiBase: null });
    r.svc.start();
    expect(r.clock.pendingCount()).toBe(0);
    expect(await r.svc.check()).toMatchObject({ status: 'error', errorCode: 'UPDATE_CHECK_FAILED' });
    expect(r.fake.requests).toHaveLength(0);
  });

  it('refuses a foreign API base even with the loopback gate open', async () => {
    const r = await rig({ apiBase: 'http://evil.example' });
    expect(await r.svc.check()).toMatchObject({ status: 'error' });
    expect(r.logs).toContainEqual({
      level: 'warn',
      event: 'update_check',
      meta: { status: 'error', reason: 'bad_api_base' },
    });
  });

  it('refuses release assets that do not live under this repo releases/download path', async () => {
    const r = await rig({ fake: { owner: 'someone-else' } }); // the fake answers for another repo: 404 on ours
    expect((await r.svc.check()).status).toBe('up_to_date');
    const r2 = await rig();
    // a different repo name in the asset URLs: the API path matches but the asset URLs do not
    const svcFor = createUpdateService({
      ...({} as UpdateServiceDeps),
      currentVersion: '0.1.7',
      fetch: async (url, init) => {
        const res = await globalThis.fetch(url, init);
        if (!String(url).endsWith('/releases/latest')) return res;
        const body = (await res.json()) as { assets: Array<{ browser_download_url: string }> };
        for (const a of body.assets)
          a.browser_download_url = a.browser_download_url.replace('/whatsapp-agent/', '/other/');
        return new Response(JSON.stringify(body), { status: 200 });
      },
      clock: r2.clock,
      log: recordingLog(r2.logs),
      meta: { get: () => null, set: () => undefined },
      audit: { append: () => undefined },
      updatesDir: join(r2.userData, 'updates'),
      logsDir: join(r2.userData, 'logs'),
      apiBase: r2.fake.url,
      allowHttpLoopback: true,
      install: { isPackaged: false, exePath: join(r2.installDir, FAKE_EXE_NAME), pid: 1 },
      spawnDetached: () => undefined,
      requestQuit: () => undefined,
    });
    expect(await svcFor.check()).toMatchObject({ status: 'error', errorCode: 'UPDATE_CHECK_FAILED' });
    expect(r2.logs).toContainEqual({
      level: 'warn',
      event: 'update_check',
      meta: { status: 'error', reason: 'no_manifest' },
    });
  });

  it('manual checks are rate-limited to one per minute; concurrent checks share one request', async () => {
    const r = await rig();
    const [a, b] = await Promise.all([r.svc.checkNow(), r.svc.checkNow()]);
    expect(a.status).toBe('available');
    expect(b.status).toBe('available');
    const apiCalls = () => r.fake.requests.filter((q) => q.path.endsWith('/releases/latest')).length;
    expect(apiCalls()).toBe(1);
    await r.svc.checkNow();
    expect(apiCalls()).toBe(1);
    await r.clock.advance(UPDATE_MANUAL_MIN_GAP_MS);
    await r.svc.checkNow();
    expect(apiCalls()).toBe(2);
  });

  it('schedule: first check 30 s after start, then every 6 h', async () => {
    const r = await rig();
    r.svc.start();
    const apiCalls = () => r.fake.requests.filter((q) => q.path.endsWith('/releases/latest')).length;
    await r.clock.advance(UPDATE_FIRST_CHECK_DELAY_MS - 1);
    expect(apiCalls()).toBe(0);
    await r.clock.advance(1);
    await vi.waitFor(() => expect(r.svc.state().status).toBe('available'));
    expect(apiCalls()).toBe(1);
    await vi.waitFor(() => expect(r.clock.pendingCount()).toBe(1)); // re-armed
    await r.clock.advance(LIMITS.updateCheckIntervalMs);
    await vi.waitFor(() => expect(apiCalls()).toBe(2));
    r.svc.stop();
    expect(r.clock.pendingCount()).toBe(0);
  });
});

describe('schedule seam', () => {
  it('WCA_TIMERS.updateFirstCheckMs moves the first check only', async () => {
    const r = await rig({ firstCheckDelayMs: 1000 });
    r.svc.start();
    await r.clock.advance(1000);
    await vi.waitFor(() => expect(r.svc.state().status).toBe('available'));
  });
});

describe('ignore / unignore', () => {
  it('persists the ignored version, audits it, and clears it again', async () => {
    const r = await rig();
    await r.svc.check();
    expect(r.svc.ignore('0.1.9').ignoredVersion).toBe('0.1.9');
    expect(r.meta.get('update_ignored_version')).toBe('0.1.9');
    expect(r.audit).toContainEqual({ kind: 'update_ignored', detail: { version: '0.1.9' } });
    expect(r.pushes.at(-1)?.ignoredVersion).toBe('0.1.9');
    expect(r.svc.unignore().ignoredVersion).toBeNull();
    expect(r.meta.get('update_ignored_version')).toBe('');
  });
  it('restores ignoredVersion, latest and lastCheckAt from meta on the next launch', async () => {
    const r = await rig({
      meta: { update_ignored_version: '0.1.9', update_latest_seen: '0.1.9', update_last_check_at: '123' },
    });
    expect(r.svc.state()).toMatchObject({ ignoredVersion: '0.1.9', latest: '0.1.9', lastCheckAt: 123, status: 'idle' });
    const junk = await rig({
      meta: { update_ignored_version: '../x', update_latest_seen: 'v1', update_last_check_at: 'x' },
    });
    expect(junk.svc.state()).toMatchObject({ ignoredVersion: null, latest: null, lastCheckAt: null });
  });
});

describe('download', () => {
  it('available -> downloading -> ready: verified zip, extracted tree with the exe, progress pushed', async () => {
    const r = await rig();
    await r.svc.check();
    const s = await downloadToEnd(r);
    const zip = r.fake.zipOf('0.1.9');
    expect(s).toMatchObject({
      status: 'ready',
      errorCode: null,
      progress: { bytesDone: zip.size, bytesTotal: zip.size },
    });
    const dir = join(r.userData, 'updates', '0.1.9');
    expect(readFileSync(join(dir, zip.name)).equals(zip.bytes)).toBe(true);
    expect(
      readFileSync(join(dir, 'win-unpacked', FAKE_EXE_NAME))
        .subarray(0, 12)
        .toString('latin1'),
    ).toBe('MZ FAKE 0.1.');
    expect(readFileSync(join(dir, 'win-unpacked', 'resources', 'version.txt'), 'utf8')).toBe('0.1.9');
    expect(readdirSync(dir).sort()).toEqual([zip.name, 'win-unpacked'].sort()); // no .part, no sidecar, no partial
    expect(r.pushes.map((p) => p.status)).toContain('downloading');
    expect(r.pushes.at(-1)?.status).toBe('ready');
    const zipReqs = r.fake.requests.filter((q) => q.path.endsWith('.zip'));
    expect(zipReqs.every((q) => q.userAgent === 'WhatsAppCalendarAgent/0.1.7')).toBe(true);
    expect(r.logs).toContainEqual({
      level: 'info',
      event: 'update_download',
      meta: { status: 'ready', latest: '0.1.9' },
    });
  });

  it.each([
    ['flat_layout', 'zip_layout'],
    ['other_top_folder', 'zip_layout'],
    ['foreign_entry', 'zip_foreign_entry'],
  ] as const)(
    'a zip that is not exactly WhatsAppCalendarAgent/<packaged build> (%s) -> UPDATE_VERIFY_FAILED, nothing staged',
    async (scenario, reason) => {
      const r = await rig({ fake: { scenario } });
      await r.svc.check();
      expect(await downloadToEnd(r)).toMatchObject({ status: 'error', errorCode: 'UPDATE_VERIFY_FAILED' });
      expect(readdirSync(join(r.userData, 'updates', '0.1.9'))).toEqual([]);
      expect(r.logs).toContainEqual({ level: 'warn', event: 'update_verify_failed', meta: { reason } });
      expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    },
  );

  it('a body that stalls for 30 s is aborted (idle timeout), retried once from the .part, then DOWNLOAD_FAILED', async () => {
    const r = await rig({ fake: { scenario: 'stall_at:40000' } });
    await r.svc.check();
    expect((await r.svc.download()).ok).toBe(true);
    const zip = r.fake.zipOf('0.1.9');
    const part = join(r.userData, 'updates', '0.1.9', `${zip.name}.part`);
    const bodies = () => r.fake.requests.filter((q) => q.path.startsWith('/cdn/') && q.path.endsWith('.zip'));
    // first attempt: bytes arrive, then nothing
    await vi.waitFor(() => expect(existsSync(part) && readFileSync(part).length >= 40000).toBe(true));
    await r.clock.advance(UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS - 1);
    expect(r.svc.state().status).toBe('downloading');
    await r.clock.advance(1);
    // the one automatic retry resumes from the part file
    await vi.waitFor(() => expect(bodies()).toHaveLength(2));
    expect(bodies()[1]!.range).toMatch(/^bytes=\d+-$/);
    await vi.waitFor(() => expect(readFileSync(part).length).toBeGreaterThan(40000));
    await r.clock.advance(UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS);
    await r.svc.settled();
    expect(r.svc.state()).toMatchObject({ status: 'error', errorCode: 'DOWNLOAD_FAILED', progress: null });
    expect(readFileSync(part).length).toBeGreaterThan(40000); // kept for the next resume
    expect(r.logs).toContainEqual({
      level: 'warn',
      event: 'update_download',
      meta: { status: 'error', reason: 'idle_timeout' },
    });
    // a later Download resumes from where the part file ends
    r.fake.setScenario('default');
    expect((await downloadToEnd(r)).status).toBe('ready');
    expect(bodies().at(-1)!.range).toMatch(/^bytes=\d+-$/);
  });

  it('a zip without the exe -> UPDATE_VERIFY_FAILED, the zip deleted, never ready', async () => {
    const r = await rig({ fake: { scenario: 'no_exe' } });
    await r.svc.check();
    expect(await downloadToEnd(r)).toMatchObject({ status: 'error', errorCode: 'UPDATE_VERIFY_FAILED' });
    expect(readdirSync(join(r.userData, 'updates', '0.1.9'))).toEqual([]);
    expect(r.logs).toContainEqual({ level: 'warn', event: 'update_verify_failed', meta: { reason: 'exe_missing' } });
  });

  it('a dropped connection is resumed with Range on the one automatic retry', async () => {
    const r = await rig({ fake: { scenario: 'drop_once_at:50000' } });
    await r.svc.check();
    expect((await downloadToEnd(r)).status).toBe('ready');
    const zipBodies = r.fake.requests.filter((q) => q.path.startsWith('/cdn/') && q.path.endsWith('.zip'));
    expect(zipBodies).toHaveLength(2);
    expect(zipBodies[1]!.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(zipBodies[1]!.range!)![0])).toBeGreaterThan(0);
  });

  it('a part file left by a previous run is resumed', async () => {
    const r = await rig();
    await r.svc.check();
    const zip = r.fake.zipOf('0.1.9');
    const dir = join(r.userData, 'updates', '0.1.9');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${zip.name}.part`), zip.bytes.subarray(0, 1000));
    writeFileSync(join(dir, `${zip.name}.part.json`), JSON.stringify({ size: zip.size, sha256: zip.sha256 }));
    expect((await downloadToEnd(r)).status).toBe('ready');
    expect(r.fake.requests.find((q) => q.path.startsWith('/cdn/') && q.path.endsWith('.zip'))?.range).toBe(
      'bytes=1000-',
    );
  });

  it('two hops (redirect chain) are refused by redirect:error and fail as DOWNLOAD_FAILED after one retry', async () => {
    const r = await rig({ fake: { scenario: 'redirect_chain' } });
    await r.svc.check();
    expect(await downloadToEnd(r)).toMatchObject({ status: 'error', errorCode: 'DOWNLOAD_FAILED' });
    expect(r.fake.requests.filter((q) => q.path.startsWith('/cdn/') && q.path.endsWith('.zip'))).toHaveLength(0);
  });

  it('not enough disk -> DISK_FULL before any byte', async () => {
    const r = await rig({ freeDisk: 1000 });
    await r.svc.check();
    expect(await downloadToEnd(r)).toMatchObject({ status: 'error', errorCode: 'DISK_FULL' });
    expect(r.fake.requests.some((q) => q.path.endsWith('.zip'))).toBe(false);
  });

  it('refused without an available release; a second call while running is a no-op', async () => {
    const r = await rig();
    expect(await r.svc.download()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    await r.svc.check();
    const first = await r.svc.download();
    const second = await r.svc.download();
    expect(first.ok && second.ok).toBe(true);
    await r.svc.settled();
    expect(r.fake.requests.filter((q) => q.path.startsWith('/cdn/') && q.path.endsWith('.zip'))).toHaveLength(1);
  });

  it('a check while ready does not disturb the staged build', async () => {
    const r = await rig();
    await r.svc.check();
    await downloadToEnd(r);
    r.fake.publish('0.1.10');
    expect((await r.svc.check()).status).toBe('ready');
  });

  it('stop() aborts a running download back to available', async () => {
    const r = await rig({ fake: { exeBytes: 8 * 1024 * 1024 } });
    await r.svc.check();
    await r.svc.download();
    r.svc.stop();
    await r.svc.settled();
    expect(r.svc.state().status).toBe('available');
  });
});

describe('install', () => {
  it('ready + canInstall: writes updater.cjs, spawns the STAGED exe as Node with the exact argv, audits, then quits', async () => {
    const r = await rig();
    await r.svc.check();
    await downloadToEnd(r);
    const res = await r.svc.install();
    expect(res).toMatchObject({ ok: true, value: { status: 'installing' } });
    const dir = join(r.userData, 'updates', '0.1.9');
    const staged = join(dir, 'win-unpacked');
    expect(readFileSync(join(dir, 'updater.cjs'), 'utf8')).toBe(UPDATER_SCRIPT);
    expect(r.spawns).toHaveLength(1);
    expect(r.spawns[0]!.command).toBe(join(staged, FAKE_EXE_NAME));
    expect(r.spawns[0]!.args).toEqual([
      join(dir, 'updater.cjs'),
      '4242',
      r.installDir,
      staged,
      FAKE_EXE_NAME,
      join(r.userData, 'logs', 'updater.log'),
      '0.1.7',
      '0.1.9',
    ]);
    expect(r.spawns[0]!.cwd).toBe(join(r.userData, 'updates'));
    expect(r.spawns[0]!.env).toEqual({
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(r.audit).toContainEqual({ kind: 'update_install_started', detail: { from: '0.1.7', to: '0.1.9' } });
    expect(r.quits).toBe(0);
    await r.clock.advance(UPDATE_QUIT_DELAY_MS);
    expect(r.quits).toBe(1);
  });

  it.each([
    ['dev / unpackaged', { packaged: false }],
    ['install folder not writable', { writable: false }],
  ])('refused when %s (canInstall false), nothing spawned', async (_label, o) => {
    const r = await rig(o);
    expect(r.svc.state().canInstall).toBe(false);
    await r.svc.check();
    expect((await downloadToEnd(r)).status).toBe('ready');
    expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(r.spawns).toHaveLength(0);
    expect(r.quits).toBe(0);
  });

  it('the updater gets a minimal environment: no WCA_*, ELECTRON_* (but RUN_AS_NODE=1), ANTHROPIC_* or token', async () => {
    const r = await rig({
      env: {
        SystemRoot: 'C:\\WINDOWS',
        Path: 'C:\\WINDOWS\\system32;C:\\Users\\u\\bin',
        TEMP: 'C:\\t',
        USERPROFILE: 'C:\\Users\\u',
        WCA_E2E: '1',
        WCA_UPDATE_BASE_URL: 'http://127.0.0.1:9',
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_RUN_AS_NODE: '0',
        ANTHROPIC_API_KEY: 'sk-ant-x',
        GITHUB_TOKEN: 'ghp_x',
      },
    });
    await r.svc.check();
    await downloadToEnd(r);
    expect((await r.svc.install()).ok).toBe(true);
    const env = r.spawns[0]!.env;
    expect(Object.keys(env).filter((k) => /^(WCA_|ELECTRON_|ANTHROPIC_|GITHUB_)/i.test(k))).toEqual([
      'ELECTRON_RUN_AS_NODE',
    ]);
    expect(env).toEqual({
      SystemRoot: 'C:\\WINDOWS',
      TEMP: 'C:\\t',
      USERPROFILE: 'C:\\Users\\u',
      PATH: 'C:\\WINDOWS\\System32',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it.each([
    ['a photo next to the exe ("Extract here" into Downloads)', { installExtras: ['photo.jpg'] }, 'foreign_entry'],
    ['a Documents folder next to the exe', { installExtras: ['Documents/'] }, 'foreign_entry'],
    [
      'a protected folder (Downloads / Desktop / Documents / the profile)',
      { protectInstallDir: true },
      'protected_path',
    ],
  ])('canInstall is false for %s; install refused, nothing spawned', async (_label, o, reason) => {
    const r = await rig(o);
    expect(r.svc.state().canInstall).toBe(false);
    expect(r.logs).toContainEqual({ level: 'info', event: 'update_install_unavailable', meta: { reason } });
    await r.svc.check();
    expect((await downloadToEnd(r)).status).toBe('ready');
    expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(r.spawns).toHaveLength(0);
  });

  it('the folder is checked again at install time: a file added since launch -> refused, canInstall false', async () => {
    const r = await rig();
    expect(r.svc.state().canInstall).toBe(true);
    await r.svc.check();
    await downloadToEnd(r);
    writeFileSync(join(r.installDir, 'holiday.jpg'), 'jpg');
    expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(r.svc.state().canInstall).toBe(false);
    expect(r.spawns).toHaveLength(0);
  });

  it('refused before ready', async () => {
    const r = await rig();
    await r.svc.check();
    expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(r.spawns).toHaveLength(0);
  });

  it('a spawn that throws -> INTERNAL, no audit, no quit', async () => {
    const r = await rig();
    await r.svc.check();
    await downloadToEnd(r);
    r.spawns.push = () => {
      throw new Error('EACCES');
    };
    expect(await r.svc.install()).toEqual({ ok: false, error: { code: 'INTERNAL' } });
    expect(r.audit.some((a) => a.kind === 'update_install_started')).toBe(false);
    await r.clock.advance(UPDATE_QUIT_DELAY_MS);
    expect(r.quits).toBe(0);
  });
});

describe('the launch after an install', () => {
  it('--updated-from: lastInstall installed, audit update_installed, old staging pruned on start', async () => {
    const r = await rig({ current: '0.1.9', argv: ['app.exe', '--updated-from', '0.1.7'] });
    expect(r.svc.state().lastInstall).toEqual({ outcome: 'installed', from: '0.1.7', to: '0.1.9' });
    expect(r.audit).toContainEqual({ kind: 'update_installed', detail: { from: '0.1.7', to: '0.1.9' } });
    const updates = join(r.userData, 'updates');
    for (const v of ['0.1.8', '0.1.9', '0.1.10']) mkdirSync(join(updates, v), { recursive: true });
    r.svc.start();
    await vi.waitFor(() => expect(readdirSync(updates)).toEqual(['0.1.10']));
  });
  it('cleanup of folders that hold an app.asar (dummy file): old staging pruned, leftovers of a failed run replaced', async () => {
    const r = await rig();
    const updates = join(r.userData, 'updates');
    const plant = (dir: string, tag: string): void => {
      mkdirSync(join(dir, 'resources'), { recursive: true });
      writeFileSync(join(dir, 'resources', 'app.asar'), `not an archive ${tag}`);
      writeFileSync(join(dir, FAKE_EXE_NAME), 'MZ');
    };
    plant(join(updates, '0.1.6', 'win-unpacked'), 'old staging'); // older than current: pruned on start
    plant(join(updates, '0.1.9', 'win-unpacked'), 'stale stage'); // a stage left by an earlier run: replaced
    plant(join(updates, '0.1.9', 'extract.partial', 'WhatsAppCalendarAgent'), 'crashed extract'); // ditto
    r.svc.start();
    await vi.waitFor(() => expect(existsSync(join(updates, '0.1.6'))).toBe(false));
    await r.svc.check();
    expect((await downloadToEnd(r)).status).toBe('ready');
    const dir = join(updates, '0.1.9');
    expect(readdirSync(dir).sort()).toEqual([r.fake.zipOf('0.1.9').name, 'win-unpacked'].sort());
    expect(readFileSync(join(dir, 'win-unpacked', 'resources', 'version.txt'), 'utf8')).toBe('0.1.9');
    expect(
      readFileSync(join(dir, 'win-unpacked', 'resources', 'app.asar'))
        .subarray(0, 10)
        .toString(),
    ).toBe('asar 0.1.9');
  });

  it('--update-failed: lastInstall failed, no audit', async () => {
    const r = await rig({ argv: ['app.exe', '--update-failed', '0.1.9'] });
    expect(r.svc.state().lastInstall).toEqual({ outcome: 'failed', from: '0.1.7', to: '0.1.9' });
    expect(r.audit).toEqual([]);
  });
  it('a malformed version after the flag is kept as null', async () => {
    const r = await rig({ argv: ['app.exe', '--updated-from', '../../x'] });
    expect(r.svc.state().lastInstall).toEqual({ outcome: 'installed', from: null, to: '0.1.7' });
  });
});
