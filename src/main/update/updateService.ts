// src/main/update/updateService.ts - v5 in-app updates from GitHub Releases (docs/specs/v5-updates-handover.md 2.2; owner v5 W2).
// The ONLY place that talks to GitHub (the renderer keeps connect-src 'none'). Check: the releases/latest API answer + release.json
// (zod), plain-version compare. Download: the shared pinned-download rules (net/pinnedDownload.ts) - host allow-list, https, one
// redirect hop, size pin, `.part` + Range resume, streamed sha256 - then the zip is extracted by our own refusing extractor and the
// exe must be present. Install: updater.cjs is written next to the staged build and run DETACHED by that build's own exe as Node,
// then the app quits through its normal sequence; the helper is never a managed child (killAllSync cannot reach it).
// Logs and audit carry enums, versions and numbers only - never a URL or a path.
import { realFsp as fsp } from './fsReal';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Clock, ClockTimer, FetchFn, Logger } from '../deps';
import type { Repos } from '../db/index';
import { LIMITS, type EpochMs, type MetaKey, type Result, type UpdateState } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import {
  GithubReleaseSchema,
  RELEASE_MANIFEST_ASSET,
  RELEASE_MANIFEST_MAX_BYTES,
  ReleaseManifestSchema,
  UPDATE_API_BASE,
  UPDATE_EXE_NAME,
  UPDATE_HOST_ALLOWLIST,
  UPDATE_REPO,
  UPDATE_ZIP_TOP_FOLDER,
  isVersion,
  semverCompare,
  type ReleaseManifest,
} from '../../shared/update';
import { PinnedTransferError, fetchSmall, isAllowedUrl, sha256OfFile, transferToPart } from '../net/pinnedDownload';
import { ZipError, extractZip } from './zip';
import { UPDATER_SCRIPT, updaterArgs } from './updaterScript';
import { inspectInstallDir, minimalUpdaterEnv, protectedDirsFor } from './updatePolicy';

/** First automatic check after `start()` (spec: 30 s after ready). */
export const UPDATE_FIRST_CHECK_DELAY_MS = 30_000;
/** `update:check` on demand: at most one real check per minute (a faster call answers the current state). */
export const UPDATE_MANUAL_MIN_GAP_MS = 60_000;
/** API + release.json timeout. */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** `update:changed` during a download: 4 Hz max. */
export const UPDATE_PROGRESS_INTERVAL_MS = 250;
/** A failed transfer (network, truncated body) is retried exactly once; a sha mismatch and a refused redirect never are. */
export const UPDATE_MAX_AUTO_RETRIES = 1;
/** Free disk needed before a download: the zip, the extracted tree and headroom. */
export const UPDATE_DISK_FACTOR = 3.2;
/** Delay between answering update:install and asking the app to quit (lets the IPC reply and the push leave first). */
export const UPDATE_QUIT_DELAY_MS = 200;
/** A zip download that receives no byte for this long is aborted (a stalled TCP read would otherwise sit in 'downloading'
 *  forever, and check() / download() both no-op in that state). The `.part` is kept for the resume. */
export const UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

export interface UpdateSpawnOptions {
  cwd: string;
  env: Record<string, string>;
}
export interface UpdateServiceDeps {
  currentVersion: string;
  fetch: FetchFn;
  clock: Clock;
  log: Logger;
  meta: Pick<Repos['meta'], 'get' | 'set'>;
  audit: Pick<Repos['audit'], 'append'>;
  /** <userData>\updates */
  updatesDir: string;
  /** <userData>\logs (the updater appends updater.log there) */
  logsDir: string;
  /** https://api.github.com in production; the loopback WCA_UPDATE_BASE_URL in e2e; null = no network at all (an e2e / harness
   *  run without that seam): nothing is scheduled and a manual check answers UPDATE_CHECK_FAILED without a request. */
  apiBase: string | null;
  /** The e2e gate of the shared allow-list (http://127.0.0.1 only). false in production. */
  allowHttpLoopback: boolean;
  repo?: { owner: string; repo: string };
  /** app.isPackaged, app.getPath('exe'), process.pid. */
  install: { isPackaged: boolean; exePath: string; pid: number };
  /** Starts the updater DETACHED (production: child_process.spawn + unref; e2e: the WCA_UPDATE_SPAWN_JOURNAL recorder). */
  spawnDetached: (command: string, args: readonly string[], opts: UpdateSpawnOptions) => void;
  /** app.quit() - the normal quit sequence (before-quit -> shutdown -> killAllSync -> exit). */
  requestQuit: () => void;
  /** process.argv: `--updated-from <v>` / `--update-failed <v>` written by the updater. */
  argv?: readonly string[];
  /** The environment the updater's minimal environment is picked from (default process.env; see updatePolicy.ts). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Folders that are never an install folder besides the profile and its Desktop / Downloads / Documents (main passes
   *  app.getPath('home' | 'desktop' | 'downloads' | 'documents'), which follows known-folder redirection). */
  protectedDirs?: readonly string[];
  /** Free bytes on the userData volume (absent = not checked). */
  freeDiskBytes?: () => Promise<number>;
  /** First automatic check after start() (default UPDATE_FIRST_CHECK_DELAY_MS; the e2e WCA_TIMERS.updateFirstCheckMs seam). */
  firstCheckDelayMs?: number;
  /** Write probe for canInstall (default: create + delete a temp file in the folder). */
  probeWritable?: (dir: string) => Promise<boolean>;
}

export interface UpdateService {
  state(): UpdateState;
  /** Scheduled / startup check; never rate-limited by the manual gap. */
  check(): Promise<UpdateState>;
  /** `update:check`: at most one real check per UPDATE_MANUAL_MIN_GAP_MS. */
  checkNow(): Promise<UpdateState>;
  /** `update:download`: kicks the background download off and answers at once (status 'downloading'). */
  download(): Promise<Result<UpdateState>>;
  /** `update:install`: requires 'ready' and canInstall; spawns the updater and asks the app to quit. */
  install(): Promise<Result<UpdateState>>;
  ignore(version: string): UpdateState;
  unignore(): UpdateState;
  onChange(cb: (s: UpdateState) => void): () => void;
  /** Schedules the first check (+30 s) and the 6-hourly ones; prunes old staging folders. */
  start(): void;
  /** Clears the timers and aborts a running download (quit). */
  stop(): void;
  /** Tests: resolves once the canInstall probe and any running download / check have settled. */
  settled(): Promise<void>;
}

interface Pending {
  version: string;
  manifest: ReleaseManifest;
  zipUrl: string;
}

const NONE = '';

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const log = deps.log.child('update');
  const repo = deps.repo ?? UPDATE_REPO;
  const current = deps.currentVersion;
  const listeners = new Set<(s: UpdateState) => void>();
  const userAgent = `WhatsAppCalendarAgent/${current}`;
  const now = (): EpochMs => deps.clock.now();

  const metaVersion = (k: MetaKey): string | null => {
    const v = deps.meta.get(k);
    return v !== null && isVersion(v) ? v : null;
  };
  const lastCheckRaw = Number(deps.meta.get('update_last_check_at') ?? NaN);
  const latestSeen = metaVersion('update_latest_seen');

  let state: UpdateState = {
    current,
    latest: latestSeen,
    status: 'idle',
    progress: null,
    errorCode: null,
    ignoredVersion: metaVersion('update_ignored_version'),
    lastCheckAt: Number.isFinite(lastCheckRaw) && lastCheckRaw > 0 ? lastCheckRaw : null,
    canInstall: false,
    lastInstall: null,
  };
  let pending: Pending | null = null;
  let staged: { version: string; dir: string; stagedDir: string } | null = null;
  let checking: Promise<UpdateState> | null = null;
  let downloading: Promise<void> | null = null;
  let downloadAbort: AbortController | null = null;
  let lastAttemptAt = -Infinity;
  let lastProgressEmit = 0;
  const timers = new Set<ClockTimer>();
  let stopped = false;

  const emit = (): void => {
    const snapshot = { ...state };
    for (const cb of [...listeners]) {
      try {
        cb(snapshot);
      } catch {
        /* a listener never breaks the service */
      }
    }
  };
  const set = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  // ---- the launch after an install (argv written by the updater) ---------------------------------------------------------
  const argv = deps.argv ?? [];
  const argAfter = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v !== undefined && isVersion(v) ? v : null;
  };
  if (argv.includes('--updated-from')) {
    const from = argAfter('--updated-from');
    state = { ...state, lastInstall: { outcome: 'installed', from, to: current } };
    log.info('update_installed', { from, to: current });
    deps.audit.append('update_installed', null, { from, to: current }, now());
  } else if (argv.includes('--update-failed')) {
    const to = argAfter('--update-failed');
    state = { ...state, lastInstall: { outcome: 'failed', from: current, to } };
    log.warn('update_install_failed', { from: current, to });
  }

  // ---- canInstall --------------------------------------------------------------------------------------------------------
  const installDir = path.dirname(deps.install.exePath);
  const probeWritable =
    deps.probeWritable ??
    (async (dir: string): Promise<boolean> => {
      const probe = path.join(dir, `.wca-write-probe-${randomBytes(6).toString('hex')}`);
      try {
        await fsp.writeFile(probe, '', { flag: 'wx' });
        await fsp.rm(probe, { force: true });
        return true;
      } catch {
        return false;
      }
    });
  const protectedDirs = protectedDirsFor(os.homedir(), deps.protectedDirs ?? []);
  /** The swap renames installDir and later deletes it as `.old-*`: it must be exactly a packaged build (updatePolicy.ts). */
  const installDirOk = async (): Promise<boolean> => {
    const verdict = await inspectInstallDir(installDir, UPDATE_EXE_NAME, protectedDirs);
    if (!verdict.ok) log.info('update_install_unavailable', { reason: verdict.reason });
    return verdict.ok;
  };
  const probing: Promise<void> = (async () => {
    if (!deps.install.isPackaged || path.basename(deps.install.exePath) !== UPDATE_EXE_NAME) return;
    if (!(await installDirOk())) return;
    // the swap renames the install folder, so its PARENT must be writable too
    const ok = (await probeWritable(installDir)) && (await probeWritable(path.dirname(installDir)));
    if (ok) set({ canInstall: true });
    else log.info('update_install_unavailable', { reason: 'not_writable' });
  })().catch(() => undefined);

  // ---- URL rules ---------------------------------------------------------------------------------------------------------
  const apiOrigin = ((): string | null => {
    if (deps.apiBase === null) return null;
    try {
      return new URL(deps.apiBase).origin;
    } catch {
      return null;
    }
  })();
  /** A redirect target: the shared allow-list (loopback only behind the e2e gate). */
  const isAllowedHop = (u: string): boolean => isAllowedUrl(u, UPDATE_HOST_ALLOWLIST, deps.allowHttpLoopback);
  /** A release asset URL taken from the API answer: allowed host AND this repo's releases/download path (and, under the e2e gate,
   *  the seam's own origin - a loopback answer cannot point the app at some other local port). */
  const isReleaseAssetUrl = (u: string): boolean => {
    if (!isAllowedHop(u)) return false;
    const url = new URL(u);
    if (url.protocol === 'http:' && url.origin !== apiOrigin) return false;
    if (url.protocol === 'https:' && url.hostname.toLowerCase() !== 'github.com') return false;
    return url.pathname.startsWith(`/${repo.owner}/${repo.repo}/releases/download/`);
  };

  // ---- check ---------------------------------------------------------------------------------------------------------------
  const failCheck = (reason: string): UpdateState => {
    log.warn('update_check', { status: 'error', reason });
    set({ status: 'error', errorCode: 'UPDATE_CHECK_FAILED', progress: null });
    return state;
  };
  const runCheck = async (): Promise<UpdateState> => {
    lastAttemptAt = now();
    if (deps.apiBase === null || apiOrigin === null) return failCheck('disabled');
    if (!(apiOrigin === UPDATE_API_BASE || (deps.allowHttpLoopback && isAllowedHop(deps.apiBase))))
      return failCheck('bad_api_base');
    set({ status: 'checking', errorCode: null });
    const signal = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
    let release;
    try {
      const raw = await fetchSmall({
        fetch: deps.fetch,
        url: `${apiOrigin}/repos/${repo.owner}/${repo.repo}/releases/latest`,
        isAllowed: isAllowedHop,
        headers: { accept: 'application/vnd.github+json', 'user-agent': userAgent },
        maxBytes: 1024 * 1024,
        signal,
      });
      release = GithubReleaseSchema.parse(JSON.parse(raw));
    } catch (err) {
      if (err instanceof PinnedTransferError && err.message === 'http_404') {
        // no release published yet
        const at = now();
        deps.meta.set('update_last_check_at', String(at));
        log.info('update_check', { status: 'up_to_date', reason: 'no_release' });
        set({ status: 'up_to_date', errorCode: null, lastCheckAt: at });
        return state;
      }
      return failCheck(reasonOf(err));
    }
    const tag = /^v(.+)$/.exec(release.tag_name)?.[1] ?? '';
    if (!isVersion(tag)) return failCheck('bad_tag');
    if (semverCompare(tag, current) <= 0) {
      const at = now();
      deps.meta.set('update_last_check_at', String(at));
      deps.meta.set('update_latest_seen', tag);
      log.info('update_check', { status: 'up_to_date', latest: tag });
      pending = null;
      set({ status: 'up_to_date', latest: tag, errorCode: null, lastCheckAt: at });
      return state;
    }
    const manifestAsset = release.assets.find((a) => a.name === RELEASE_MANIFEST_ASSET);
    if (manifestAsset === undefined || !isReleaseAssetUrl(manifestAsset.browser_download_url))
      return failCheck('no_manifest');
    let manifest: ReleaseManifest;
    try {
      const raw = await fetchSmall({
        fetch: deps.fetch,
        url: manifestAsset.browser_download_url,
        isAllowed: isAllowedHop,
        headers: { accept: 'application/octet-stream', 'user-agent': userAgent },
        maxBytes: RELEASE_MANIFEST_MAX_BYTES,
        signal,
      });
      manifest = ReleaseManifestSchema.parse(JSON.parse(raw));
    } catch (err) {
      return failCheck(err instanceof PinnedTransferError ? err.message : 'bad_manifest');
    }
    if (manifest.version !== tag) return failCheck('manifest_version_mismatch');
    const zipAsset = release.assets.find((a) => a.name === manifest.asset.name);
    if (
      zipAsset === undefined ||
      zipAsset.size !== manifest.asset.size ||
      !isReleaseAssetUrl(zipAsset.browser_download_url)
    )
      return failCheck('no_zip');
    const at = now();
    deps.meta.set('update_last_check_at', String(at));
    deps.meta.set('update_latest_seen', tag);
    if (semverCompare(current, manifest.minVersion) < 0) {
      log.info('update_check', { status: 'up_to_date', latest: tag, reason: 'min_version' });
      pending = null;
      set({ status: 'up_to_date', latest: tag, errorCode: null, lastCheckAt: at });
      return state;
    }
    pending = { version: tag, manifest, zipUrl: zipAsset.browser_download_url };
    log.info('update_check', { status: 'available', latest: tag });
    set({ status: 'available', latest: tag, errorCode: null, lastCheckAt: at, progress: null });
    return state;
  };
  const check = (): Promise<UpdateState> => {
    if (stopped) return Promise.resolve(state);
    // a download / a staged build / an install in progress is not interrupted by a check
    if (state.status === 'downloading' || state.status === 'ready' || state.status === 'installing')
      return Promise.resolve(state);
    checking ??= runCheck()
      .catch((err: unknown) => failCheck(reasonOf(err)))
      .finally(() => {
        checking = null;
      });
    return checking;
  };

  // ---- download ------------------------------------------------------------------------------------------------------------
  const versionDir = (v: string): string => path.join(deps.updatesDir, v);
  const sizeOf = async (f: string): Promise<number> => {
    try {
      return (await fsp.stat(f)).size;
    } catch {
      return -1;
    }
  };
  const fileExists = async (f: string): Promise<boolean> => {
    try {
      return (await fsp.stat(f)).isFile();
    } catch {
      return false;
    }
  };
  const failDownload = (code: ErrorCode, reason: string): void => {
    if (code === 'UPDATE_VERIFY_FAILED') log.warn('update_verify_failed', { reason });
    else log.warn('update_download', { status: 'error', reason });
    set({ status: 'error', errorCode: code, progress: null });
  };

  /** One verified zip at `<dir>\<asset>`; false when the run already reported a failure. */
  const fetchVerifiedZip = async (p: Pending, dir: string, signal: AbortSignal): Promise<string | null> => {
    const { name, size, sha256 } = p.manifest.asset;
    const zipPath = path.join(dir, name);
    const part = `${zipPath}.part`;
    const sidecar = `${part}.json`;
    if ((await sizeOf(zipPath)) === size && (await sha256OfFile(zipPath)) === sha256) return zipPath; // already here
    await fsp.rm(zipPath, { force: true });

    for (let attempt = 0; attempt <= UPDATE_MAX_AUTO_RETRIES; attempt += 1) {
      let offset = await sizeOf(part);
      try {
        const side = JSON.parse(await fsp.readFile(sidecar, 'utf8')) as { size?: unknown; sha256?: unknown };
        if (side.size !== size || side.sha256 !== sha256) offset = -1;
      } catch {
        offset = -1;
      }
      if (offset < 0 || offset > size) {
        await fsp.rm(part, { force: true });
        offset = 0;
      }
      await fsp.writeFile(sidecar, JSON.stringify({ size, sha256 }), 'utf8');
      // Idle timeout: armed before the request and re-armed on every chunk; it aborts only THIS attempt (the .part stays).
      const idle = new AbortController();
      const idleTimer: { t: ClockTimer | null } = { t: null };
      const disarmIdle = (): void => {
        if (idleTimer.t !== null) deps.clock.clearTimeout(idleTimer.t);
        idleTimer.t = null;
      };
      const armIdle = (): void => {
        disarmIdle();
        idleTimer.t = deps.clock.setTimeout(() => idle.abort(), UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS);
      };
      armIdle();
      try {
        // Resume note: the offset is the .part size and the server's 206 Content-Range start is NOT compared with it. A server
        // that answers a Range request from another offset would splice the file; the full-file sha256 below rejects that zip
        // (UPDATE_VERIFY_FAILED, part deleted), so this is a wasted download, never an installed one.
        const done = await transferToPart({
          fetch: deps.fetch,
          url: p.zipUrl,
          partPath: part,
          offset,
          isAllowed: isAllowedHop,
          signal: AbortSignal.any([signal, idle.signal]),
          headers: { accept: 'application/octet-stream', 'user-agent': userAgent },
          maxBytes: size,
          onBytes: (bytesDone) => {
            armIdle();
            const t = now();
            if (t - lastProgressEmit < UPDATE_PROGRESS_INTERVAL_MS) return;
            lastProgressEmit = t;
            set({ progress: { bytesDone, bytesTotal: size } });
          },
        });
        if (done !== size || (await sizeOf(part)) !== size) throw new PinnedTransferError('size_mismatch');
      } catch (err) {
        if (signal.aborted) throw err;
        const reason = idle.signal.aborted ? 'idle_timeout' : reasonOf(err);
        // A refused redirect is never retried (review focus 2); a body past the pin is deleted before the retry.
        if (reason === 'redirect_host_refused') {
          failDownload('DOWNLOAD_FAILED', reason);
          return null;
        }
        // A body past the pin is deleted before the retry; an idle timeout / dropped connection keeps the part (Range resume).
        if (reason === 'size_exceeded' || reason === 'size_mismatch') await fsp.rm(part, { force: true });
        log.warn('update_download', { status: 'retry', reason, attempt });
        if (attempt === UPDATE_MAX_AUTO_RETRIES) {
          failDownload('DOWNLOAD_FAILED', reason);
          return null;
        }
        continue;
      } finally {
        disarmIdle();
      }
      set({ progress: { bytesDone: size, bytesTotal: size } });
      const digest = await sha256OfFile(part);
      if (digest !== sha256) {
        // never retried, never installed: the published zip is not the one release.json pins (review focus 1)
        await fsp.rm(part, { force: true });
        await fsp.rm(sidecar, { force: true });
        failDownload('UPDATE_VERIFY_FAILED', 'sha256_mismatch');
        return null;
      }
      await fsp.rename(part, zipPath);
      await fsp.rm(sidecar, { force: true });
      return zipPath;
    }
    return null; // unreachable: the loop returns on its last attempt
  };

  /** Extracts the verified zip to `<dir>\win-unpacked` and checks the exe is there. */
  const stage = async (dir: string, zipPath: string): Promise<string | null> => {
    const partial = path.join(dir, 'extract.partial');
    const target = path.join(dir, 'win-unpacked');
    await fsp.rm(partial, { recursive: true, force: true });
    await fsp.rm(target, { recursive: true, force: true });
    try {
      await extractZip(zipPath, partial, {
        maxEntries: 50_000,
        maxTotalBytes: 6 * 1024 ** 3,
        maxEntryBytes: 2 * 1024 ** 3,
      });
    } catch (err) {
      await fsp.rm(zipPath, { force: true });
      // an fs error keeps only its code (EACCES, ENOSPC ...) - never its message, which carries the path
      const code = (err as { code?: unknown }).code;
      failDownload(
        'UPDATE_VERIFY_FAILED',
        err instanceof ZipError
          ? `zip_${err.reason}`
          : typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
            ? `unzip_failed_${code}`
            : 'unzip_failed',
      );
      return null;
    }
    // The release zip has exactly ONE top folder, UPDATE_ZIP_TOP_FOLDER, holding a packaged build and nothing else (the same
    // rule canInstall and the updater apply to the install folder). Any other layout is refused.
    const refuse = async (reason: string): Promise<null> => {
      await fsp.rm(partial, { recursive: true, force: true });
      await fsp.rm(zipPath, { force: true });
      failDownload('UPDATE_VERIFY_FAILED', reason);
      return null;
    };
    const top = await fsp.readdir(partial, { withFileTypes: true });
    const only = top.length === 1 ? top[0] : undefined;
    if (only === undefined || !only.isDirectory() || only.name !== UPDATE_ZIP_TOP_FOLDER) return refuse('zip_layout');
    const root = path.join(partial, only.name);
    const verdict = await inspectInstallDir(root, UPDATE_EXE_NAME, []);
    if (!verdict.ok) return refuse(verdict.reason === 'exe_missing' ? 'exe_missing' : `zip_${verdict.reason}`);
    await fsp.rename(root, target);
    await fsp.rm(partial, { recursive: true, force: true });
    return target;
  };

  const runDownload = async (p: Pending): Promise<void> => {
    const controller = new AbortController();
    downloadAbort = controller;
    const dir = versionDir(p.version);
    try {
      await fsp.mkdir(dir, { recursive: true });
      if (deps.freeDiskBytes !== undefined) {
        const free = await deps.freeDiskBytes();
        if (free < p.manifest.asset.size * UPDATE_DISK_FACTOR) {
          failDownload('DISK_FULL', 'disk_full');
          return;
        }
      }
      const zipPath = await fetchVerifiedZip(p, dir, controller.signal);
      if (zipPath === null) return;
      const stagedDir = await stage(dir, zipPath);
      if (stagedDir === null) return;
      staged = { version: p.version, dir, stagedDir };
      log.info('update_download', { status: 'ready', latest: p.version });
      set({
        status: 'ready',
        errorCode: null,
        progress: { bytesDone: p.manifest.asset.size, bytesTotal: p.manifest.asset.size },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        log.info('update_download', { status: 'aborted' });
        set({ status: 'available', progress: null });
        return;
      }
      failDownload('DOWNLOAD_FAILED', reasonOf(err));
    } finally {
      downloadAbort = null;
    }
  };

  const download = async (): Promise<Result<UpdateState>> => {
    if (state.status === 'downloading' || state.status === 'ready') return { ok: true, value: state };
    const p = pending;
    if (p === null || (state.status !== 'available' && state.status !== 'error') || stopped)
      return { ok: false, error: { code: 'BAD_REQUEST' } };
    lastProgressEmit = 0;
    set({ status: 'downloading', errorCode: null, progress: { bytesDone: 0, bytesTotal: p.manifest.asset.size } });
    log.info('update_download', { status: 'started', latest: p.version });
    downloading = runDownload(p).finally(() => {
      downloading = null;
    });
    return { ok: true, value: state };
  };

  // ---- install -------------------------------------------------------------------------------------------------------------
  const install = async (): Promise<Result<UpdateState>> => {
    await probing;
    const s = staged;
    if (state.status !== 'ready' || s === null || !state.canInstall)
      return { ok: false, error: { code: 'BAD_REQUEST' } };
    // the folder may have changed since launch (a file dropped next to the exe): check it again right before the swap
    if (!(await installDirOk())) {
      set({ canInstall: false });
      return { ok: false, error: { code: 'BAD_REQUEST' } };
    }
    const stagedExe = path.join(s.stagedDir, UPDATE_EXE_NAME);
    if (!(await fileExists(stagedExe))) return { ok: false, error: { code: 'BAD_REQUEST' } };
    const script = path.join(s.dir, 'updater.cjs');
    try {
      await fsp.writeFile(script, UPDATER_SCRIPT, 'utf8');
      // never the app's own environment (WCA_*, ELECTRON_*, keys, tokens): an allow-list of Windows basics, PATH = System32
      const env = minimalUpdaterEnv(deps.env ?? process.env, true);
      const args = [
        script,
        ...updaterArgs({
          pid: deps.install.pid,
          installDir,
          stagedDir: s.stagedDir,
          exeName: UPDATE_EXE_NAME,
          logFile: path.join(deps.logsDir, 'updater.log'),
          from: current,
          to: s.version,
        }),
      ];
      deps.spawnDetached(stagedExe, args, { cwd: deps.updatesDir, env });
    } catch (err) {
      log.error('update_install_failed', { reason: reasonOf(err) });
      return { ok: false, error: { code: 'INTERNAL' } };
    }
    deps.audit.append('update_install_started', null, { from: current, to: s.version }, now());
    log.info('update_install_started', { from: current, to: s.version });
    set({ status: 'installing', errorCode: null });
    const t = deps.clock.setTimeout(() => {
      timers.delete(t);
      deps.requestQuit();
    }, UPDATE_QUIT_DELAY_MS);
    timers.add(t);
    return { ok: true, value: state };
  };

  // ---- schedule ------------------------------------------------------------------------------------------------------------
  const arm = (ms: number): void => {
    const t = deps.clock.setTimeout(() => {
      timers.delete(t);
      void check().finally(() => {
        if (!stopped) arm(LIMITS.updateCheckIntervalMs);
      });
    }, ms);
    timers.add(t);
  };
  const prune = async (): Promise<void> => {
    let names: string[];
    try {
      names = await fsp.readdir(deps.updatesDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!isVersion(name) || semverCompare(name, current) > 0) continue; // only staging of this or an older version
      await fsp.rm(path.join(deps.updatesDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return {
    state: () => ({ ...state }),
    check,
    checkNow: () => {
      if (checking !== null) return checking;
      if (now() - lastAttemptAt < UPDATE_MANUAL_MIN_GAP_MS) return Promise.resolve({ ...state });
      return check();
    },
    download,
    install,
    ignore: (version) => {
      deps.meta.set('update_ignored_version', version);
      deps.audit.append('update_ignored', null, { version }, now());
      log.info('update_ignored', { version });
      set({ ignoredVersion: version });
      return { ...state };
    },
    unignore: () => {
      deps.meta.set('update_ignored_version', NONE);
      set({ ignoredVersion: null });
      return { ...state };
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start: () => {
      if (stopped) return;
      void prune();
      if (deps.apiBase === null) return; // no network in this run: nothing is scheduled
      arm(deps.firstCheckDelayMs ?? UPDATE_FIRST_CHECK_DELAY_MS);
    },
    stop: () => {
      stopped = true;
      for (const t of timers) deps.clock.clearTimeout(t);
      timers.clear();
      downloadAbort?.abort();
    },
    settled: async () => {
      await probing;
      while (checking !== null || downloading !== null) {
        await checking;
        await downloading;
      }
    },
  };
}

/** A short machine reason for logs (never err.message of a fetch error: it can carry the URL). */
function reasonOf(err: unknown): string {
  if (err instanceof PinnedTransferError) return err.message;
  if (err instanceof ZipError) return `zip_${err.reason}`;
  if (err instanceof SyntaxError) return 'bad_json';
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    if (err.name === 'ZodError') return 'bad_answer';
    return 'network';
  }
  return 'unknown';
}
