// src/main/bridge/launcher.ts   (frozen signatures)
// Interface verbatim from docs/specs/contracts.md section 12 (owner W1-02) + the createBridgeLauncher seam of build-plan section 3.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import type { Clock, ClockTimer, FetchFn, Logger, RandomSource, SpawnFn } from '../deps';
import type { AppPaths } from '../paths';
import type { ChildHandle, ChildSpec } from '../proc/supervisor';
import { freePort } from '../proc/freePort';
import { matchMarkers, isAnnotationMarker, type BridgeMarker } from './stdoutMarkers';
import {
  BRIDGE_ENV_KEYS,
  BRIDGE_EXE,
  OS_ENV_PASSTHROUGH,
  SpawnInvariantError,
  assertBridgeSpawnInvariants,
  errorCodeForViolations,
  isPathInside,
  sha256OfFile,
  type BridgeSpawnPlan,
} from './invariants';
import { BridgeAuthError, createBridgeReadClient, type BridgeEndpoint, type BridgeReadClient } from './readClient';
import { createPairingPoller } from './pairing';
import type { AuditKind, AuditEntry, EpochMs } from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';
import type { BridgeStatus, PairingState } from '../../shared/health';
export interface BridgeLauncher {
  start(): Promise<void>; // no-op + status 'not_started' until consent whatsapp_tos is current
  stop(): Promise<void>;
  restartForNewCode(): Promise<void>; // pairing:newCode = kill + respawn (fresh port, token, doorbell secret)
  relink(): Promise<void>; // stop ; delete ONLY <userData>\bridge\store\whatsapp.db ; start
  unlinkAndWipe(): Promise<void>; // stop ; delete <userData>\bridge\store (path-prefix asserted) ; start
  status(): BridgeStatus;
  pairing(): PairingState;
  isOnline(): boolean; // executor precondition for send_reply
  onStatus(cb: (s: BridgeStatus) => void): () => void;
  onPairing(cb: (p: PairingState) => void): () => void;
  endpoint(): { port: number; token: string } | null; // passed as a thunk to the two REST clients by compose.ts
}
// ---------- supplementary seam (build-plan section 3; W0-authored, frozen in Wave 1) ----------
/** S-HASH: exe path + pin are parameters (the dummy-exe fixture and WCA_BRIDGE_CMD both work without touching invariants.ts). */
export interface BridgeLauncherDeps {
  paths: AppPaths;
  exePath: string; // <resources>\bridge\whatsapp-bridge.exe or the WCA_BRIDGE_CMD command in e2e builds
  exeArgs?: readonly string[]; // ALWAYS [] for the real exe; the fake-bridge argv in e2e child mode
  expectedSha256: string;
  tosAccepted: () => boolean; // consents.isCurrent('whatsapp_tos')
  doorbell: { port(): number; rotateSecret(): string }; // rotateSecret() returns the full WEBHOOK_URL for this launch
  spawn: SpawnFn;
  fetch: FetchFn;
  clock: Clock;
  random: RandomSource;
  log: Logger;
  audit: (kind: AuditKind, ref: string | null, detail: AuditEntry['detail'], now: EpochMs) => void;
  onMarker: (marker: BridgeMarker) => void; // hint/annotation markers by NAME only (stdoutMarkers.ts)
  storeDir?: string; // defaults to paths.bridgeStoreDir (relink / unlinkAndWipe delete inside it only)
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** ARCHITECTURE 4.2 readiness: poll GET /api/pairing/status every 500 ms from spawn, 10 s budget, max 3 ports. */
export const READINESS_BUDGET_MS = 10_000;
export const READINESS_POLL_MS = 500;
export const READINESS_REQUEST_TIMEOUT_MS = 2_000;
export const MAX_LAUNCH_ATTEMPTS = 3;
/** ARCHITECTURE 4.3: GET /api/health every 20 s while running; 10 min of 503 => kill + respawn. */
export const HEALTH_POLL_MS = 20_000;
export const HEALTH_MISSES_BEFORE_RESPAWN = 3;
export const DISCONNECTED_RESPAWN_MS = 10 * 60_000;
/** CONTRACTS section 13: bridge backoff / breaker / stable window. */
export const BRIDGE_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 60_000];
export const BRIDGE_BREAKER = { maxExits: 5, windowMs: 10 * 60_000 } as const;
export const BRIDGE_STABLE_AFTER_MS = 60_000;
/** ARCHITECTURE 4.4: the most recent annotation within this window selects BRIDGE_OUTDATED vs BRIDGE_CRASH_LOOP. */
export const ANNOTATION_WINDOW_MS = 60_000;
/** A stdout line longer than this without a newline is dropped rather than buffered (a message body can be arbitrarily long). */
const MAX_STDOUT_TAIL = 64 * 1024;
const STOP_GRACE_MS = 3_000;

// S-FS: the two directory probes the invariants need. Kept here so invariants.ts stays free of file-system calls.
function existsDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isEmptyDirSync(p: string): boolean {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
}
/** The `fs` collaborator the launcher hands to assertBridgeSpawnInvariants; exported so it can be tested on its own. */
export const bridgeSpawnFs = { existsDir: existsDirSync, isEmptyDir: isEmptyDirSync };

class ForeignListenerError extends Error {}
class ReadinessTimeoutError extends Error {}
class ChildExitedError extends Error {}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Which executable the launcher may spawn. In e2e mode the pinned bridge exe is NEVER a possible answer (TESTS 4.2). */
export function resolveBridgeExe(input: {
  bridgeExe: string;
  e2e: boolean;
  seamBridgeCmd?: { command: string; args: string[]; sha256?: string };
}): { exePath: string; exeArgs: readonly string[]; expectedSha256: string } | null {
  if (input.e2e) {
    const seam = input.seamBridgeCmd;
    if (seam === undefined) return null; // e2e without the seam => the bridge is disabled
    return { exePath: seam.command, exeArgs: [...seam.args], expectedSha256: (seam.sha256 ?? '').toLowerCase() };
  }
  return { exePath: input.bridgeExe, exeArgs: [], expectedSha256: BRIDGE_EXE.sha256 };
}

/**
 * The `BridgeStatus` -> `ErrorCode` mapping of ARCHITECTURE 4.4, as a pure function so `compose.ts` never has to
 * read back `spawn_refused` audit rows to find out WHY a spawn was refused.
 *
 * `BridgeLauncher` (CONTRACTS 12) is frozen and carries no `errorCode()`, so the code is derived from the status the
 * launcher already publishes plus, for `'refused'` only, the refusal code the launcher recorded at refusal time
 * (`BridgeLauncherHandle.lastRefusalCode()`, or the `code` field of the last `spawn_refused` audit row).
 *
 * Returns `null` for every status that is not an error the user must see: `'online'` (healthy), `'starting'`,
 * `'needs_pairing'` and `'stopped'` (transient / user-driven, UX shows progress, not an error).
 */
export function bridgeStatusToErrorCode(status: BridgeStatus, refusedCode?: ErrorCode | null): ErrorCode | null {
  switch (status) {
    case 'outdated':
      return 'BRIDGE_OUTDATED';
    case 'failed':
      return 'BRIDGE_CRASH_LOOP';
    case 'refused':
      // exe_hash_mismatch => BRIDGE_BINARY_BLOCKED ; any other invariant / startup refusal => BRIDGE_SPAWN_REFUSED.
      return refusedCode ?? 'BRIDGE_SPAWN_REFUSED';
    case 'logged_out':
      return 'WA_LOGGED_OUT';
    case 'not_started':
      return 'WA_TOS_REQUIRED';
    case 'reconnecting':
    case 'backoff':
      return 'WA_OFFLINE';
    default:
      return null;
  }
}

/** What `createBridgeLauncher` actually returns: the frozen interface plus the two additive, non-contract accessors. */
export type BridgeLauncherHandle = BridgeLauncher & {
  childSpec(): ChildSpec;
  /** The ErrorCode recorded the last time a spawn was refused, or null if no refusal has happened since the last start(). */
  lastRefusalCode(): ErrorCode | null;
  /** Convenience: `bridgeStatusToErrorCode(status(), lastRefusalCode())`. */
  errorCode(): ErrorCode | null;
};

export function createBridgeLauncher(deps: BridgeLauncherDeps): BridgeLauncherHandle {
  const log = deps.log.child('bridge');
  const storeDir = deps.storeDir ?? deps.paths.bridgeStoreDir;
  const exeArgs = deps.exeArgs ?? [];
  const seamMode = exeArgs.length > 0; // only reachable when both locks of TESTS 4.1 are open

  let status: BridgeStatus = 'not_started';
  let pairingState: PairingState = { status: 'unavailable' };
  let ep: BridgeEndpoint | null = null;
  let child: ChildProcess | null = null;
  let readinessAnswered = false;
  let terminal = false;
  let refusalCode: ErrorCode | null = null; // why the last spawn was refused; cleared by resetBreaker()
  let stopping = false;
  let supervised = false;
  let launching = false;
  let startedAt = 0;
  let backoffIndex = 0;
  let healthMisses = 0;
  let disconnectedSince: number | null = null;
  let healthTimer: ClockTimer | null = null;
  let respawnTimer: ClockTimer | null = null;
  let pokeReadiness: (() => void) | null = null;
  const exits: number[] = [];
  const annotations: Array<{ marker: BridgeMarker; at: number }> = [];
  const statusCbs = new Set<(s: BridgeStatus) => void>();
  const pairingCbs = new Set<(p: PairingState) => void>();

  const read: BridgeReadClient = createBridgeReadClient(() => ep, deps.fetch);

  /**
   * [repair data-integrity-2] Fan out to observers one at a time, each in its own try. A subscriber is an OBSERVER: its failure
   * is its own and may not decide what the subscribers behind it get to see, nor tear out through whatever caused the
   * transition. compose registers `healthHub.setBridge` / `healthHub.setPairing` and the renderer emit LAST, so an unguarded
   * loop let one throwing subscriber leave the health model and the UI stale while the caller mislabelled the cause - the
   * health tick flipped the bridge to 'reconnecting' every tick, the pairing poll logged `pairing_poll_failed{reason:'other'}`.
   * Only the error NAME is logged: a subscriber message can carry attacker-influenced text ([R2]).
   */
  function fanOut<T>(cbs: ReadonlySet<(v: T) => void>, value: T, event: string): void {
    for (const cb of [...cbs]) {
      try {
        cb(value);
      } catch (err) {
        log.warn(event, { reason: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }

  const setStatus = (next: BridgeStatus): void => {
    if (status === next) return;
    status = next;
    log.info('bridge_status', { status: next });
    fanOut(statusCbs, next, 'bridge_status_listener_failed');
  };

  const clearTimer = (t: ClockTimer | null): null => {
    if (t !== null) deps.clock.clearTimeout(t);
    return null;
  };

  // ---- pairing ----------------------------------------------------------------------------------------------------
  const poller = createPairingPoller({
    read,
    clock: deps.clock,
    log,
    onState: (p) => {
      onPairingState(p);
    },
  });

  function onPairingState(next: PairingState): void {
    const previous = pairingState;
    pairingState = next;
    fanOut(pairingCbs, next, 'bridge_pairing_listener_failed');
    if (next.status === 'logged_out') {
      // [R2] the ONLY source of this state is GET /api/pairing/status; no stdout line can produce it.
      log.warn('bridge_logged_out');
      deps.audit('pairing', null, { event: 'logged_out' }, deps.clock.now());
      terminal = true;
      void stopChild().then(() => {
        setStatus('logged_out');
      });
      return;
    }
    if (next.status === 'connected') {
      if (previous.status === 'qr_pending') {
        // [R2] EVERY connected-after-QR transition. compose() reacts to this audit row / onPairing edge by writing
        // meta.paired_at, recomputing live_from_ts and calling ingest.resolveLidChats() (see notes REQUESTS).
        deps.audit('pairing', null, { event: 'paired' }, deps.clock.now());
      }
      if (status === 'starting' || status === 'needs_pairing') setStatus('online');
      return;
    }
    if (next.status === 'qr_pending' && (status === 'starting' || status === 'online' || status === 'reconnecting')) {
      setStatus('needs_pairing');
    }
  }

  // ---- stdout markers ---------------------------------------------------------------------------------------------
  function handleMarker(marker: BridgeMarker): void {
    // Only the NAME is logged / forwarded; the raw line never leaves this function.
    log.info('bridge_marker', { marker });
    deps.onMarker(marker);
    if (isAnnotationMarker(marker)) annotations.push({ marker, at: deps.clock.now() });
    switch (marker) {
      case 'rest_starting':
        pokeReadiness?.();
        return;
      case 'qr_phase':
        void poller.pollNow();
        return;
      case 'token_banner':
      case 'invalid_port':
      case 'token_too_short':
        // These can only be printed BEFORE the REST server exists, i.e. before any message could have been echoed.
        if (status === 'starting' && !readinessAnswered) {
          // Not an invariant violation and not a hash mismatch: the bridge refused to start itself.
          refusalCode = 'BRIDGE_SPAWN_REFUSED';
          deps.audit('spawn_refused', null, { marker, code: refusalCode }, deps.clock.now());
          log.error('bridge_startup_refused', { marker });
          terminal = true;
          void stopChild().then(() => {
            setStatus('refused');
          });
        }
        return;
      default:
        // history_sync_done is forwarded via onMarker (ingest.poke()); everything else is logged by name and ignored.
        return;
    }
  }

  function attachStdout(proc: ChildProcess): void {
    const decoder = new StringDecoder('utf8');
    let tail = '';
    const onChunk = (buf: Buffer): void => {
      const text = tail + decoder.write(buf);
      const cut = text.lastIndexOf('\n');
      if (cut === -1) {
        tail = text.length > MAX_STDOUT_TAIL ? '' : text;
        return;
      }
      tail = text.slice(cut + 1);
      if (tail.length > MAX_STDOUT_TAIL) tail = '';
      for (const marker of matchMarkers(text.slice(0, cut + 1))) handleMarker(marker);
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
  }

  // ---- health -----------------------------------------------------------------------------------------------------
  const scheduleHealth = (): void => {
    healthTimer = clearTimer(healthTimer);
    if (child === null || stopping || terminal) return;
    healthTimer = deps.clock.setTimeout(() => {
      void healthTick();
    }, HEALTH_POLL_MS);
  };

  async function healthTick(): Promise<void> {
    if (child === null || stopping || terminal) return;
    try {
      const health = await read.health();
      healthMisses = 0;
      if (health.httpStatus === 200 && health.connected) {
        disconnectedSince = null;
        if (status !== 'online' && status !== 'needs_pairing') setStatus('online');
      } else {
        if (disconnectedSince === null) disconnectedSince = deps.clock.now();
        if (status === 'online') setStatus('reconnecting');
        if (deps.clock.now() - disconnectedSince >= DISCONNECTED_RESPAWN_MS) {
          log.warn('bridge_respawn', { reason: 'disconnected_10min' });
          await respawn();
          return;
        }
      }
    } catch (err) {
      if (err instanceof BridgeAuthError) {
        // Somebody else holds our port now: never keep talking to it.
        log.warn('bridge_respawn', { reason: 'foreign_listener' });
        await respawn();
        return;
      }
      healthMisses += 1;
      if (status === 'online') setStatus('reconnecting');
      if (healthMisses >= HEALTH_MISSES_BEFORE_RESPAWN) {
        log.warn('bridge_respawn', { reason: 'probe_dead' });
        await respawn();
        return;
      }
    }
    scheduleHealth();
  }

  async function respawn(): Promise<void> {
    if (supervised) {
      // The Supervisor owns restarts once it drives childSpec().start(); killing is enough.
      await stopChild();
      setStatus('backoff');
      return;
    }
    await stopChild();
    if (terminal) return;
    backoffIndex = 0;
    await launchLoop();
  }

  // ---- child lifecycle --------------------------------------------------------------------------------------------
  function teardownChildState(): void {
    ep = null;
    readinessAnswered = false;
    healthMisses = 0;
    disconnectedSince = null;
    pokeReadiness = null;
    healthTimer = clearTimer(healthTimer);
    poller.stop();
  }

  function stopChild(): Promise<void> {
    const proc = child;
    child = null;
    teardownChildState();
    if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return new Promise<void>((done) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        timer = clearTimer(timer);
        done();
      };
      let timer: ClockTimer | null = deps.clock.setTimeout(finish, STOP_GRACE_MS);
      proc.once('exit', finish);
      try {
        proc.kill();
      } catch {
        finish();
      }
    });
  }

  function openBreaker(): void {
    terminal = true;
    const now = deps.clock.now();
    const outdated = annotations.some((a) => a.marker === 'client_outdated' && now - a.at <= ANNOTATION_WINDOW_MS);
    log.error('bridge_breaker_open', { exits: exits.length, outdated });
    setStatus(outdated ? 'outdated' : 'failed');
  }

  function onChildExit(proc: ChildProcess, info: { code: number | null; signal: string | null }): void {
    if (child !== proc) return; // a stale child from an earlier attempt
    child = null;
    teardownChildState();
    if (stopping) return;
    if (supervised) {
      setStatus('backoff');
      return;
    }
    const now = deps.clock.now();
    // Any exit while not stopping is a crash - the bridge always returns exit code 0 (bridge-contract.md section 8).
    if (startedAt > 0 && now - startedAt >= BRIDGE_STABLE_AFTER_MS) backoffIndex = 0;
    exits.push(now);
    while (exits.length > 0 && now - (exits[0] ?? now) > BRIDGE_BREAKER.windowMs) exits.shift();
    log.warn('bridge_child_exit', { code: info.code ?? -1, signal: info.signal ?? '', exits: exits.length });
    if (exits.length >= BRIDGE_BREAKER.maxExits) {
      openBreaker();
      return;
    }
    const base = BRIDGE_BACKOFF_MS[Math.min(backoffIndex, BRIDGE_BACKOFF_MS.length - 1)] ?? 2_000;
    backoffIndex += 1;
    const delay = base + deps.random.int(0, Math.max(1, Math.floor(base / 4)));
    setStatus('backoff');
    respawnTimer = clearTimer(respawnTimer);
    respawnTimer = deps.clock.setTimeout(() => {
      void launchLoop();
    }, delay);
  }

  function buildEnv(port: number, token: string, webhookUrl: string): Record<string, string> {
    const env: Record<string, string> = {
      WHATSAPP_BRIDGE_PORT: String(port),
      WHATSAPP_BRIDGE_TOKEN: token,
      WEBHOOK_URL: webhookUrl,
      FORWARD_SELF: 'true',
      WHATSAPP_MEDIA_ROOTS: deps.paths.bridgeOutboxDir,
    };
    // never process.env wholesale (ARCHITECTURE 4.2)
    for (const key of OS_ENV_PASSTHROUGH) {
      const value = process.env[key];
      if (typeof value === 'string' && value !== '') env[key] = value;
    }
    return env;
  }

  function waitForReadiness(proc: ChildProcess, port: number, token: string): Promise<void> {
    return new Promise<void>((ok, fail) => {
      const deadline = deps.clock.now() + READINESS_BUDGET_MS;
      let done = false;
      let timer: ClockTimer | null = null;
      /** Once a listener answered 401/403 the token must never be sent to it again. */
      let poisoned = false;

      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        pokeReadiness = null;
        timer = clearTimer(timer);
        proc.off('exit', onExit);
        if (err === undefined) ok();
        else fail(err);
      };
      function onExit(): void {
        finish(new ChildExitedError('bridge exited during readiness'));
      }
      proc.once('exit', onExit);

      const probe = async (): Promise<void> => {
        if (done || poisoned) return;
        try {
          const res = await deps.fetch(`http://127.0.0.1:${port}/api/pairing/status`, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
          });
          void res.body?.cancel().catch(() => undefined);
          if (res.status === 401 || res.status === 403) {
            poisoned = true;
            finish(new ForeignListenerError(`foreign listener on port answered ${res.status}`));
            return;
          }
          if (res.status === 200) {
            finish();
            return;
          }
        } catch {
          // not listening yet
        }
        if (done || poisoned) return;
        if (deps.clock.now() >= deadline) {
          finish(new ReadinessTimeoutError('bridge did not answer within the readiness budget'));
          return;
        }
        timer = deps.clock.setTimeout(() => {
          void probe();
        }, READINESS_POLL_MS);
      };

      pokeReadiness = (): void => {
        if (done || poisoned) return;
        timer = clearTimer(timer);
        void probe();
      };
      void probe();
    });
  }

  /** One spawn attempt: invariants -> spawn -> readiness. Throws on refusal / readiness failure (the child is killed first). */
  async function spawnOnce(attempt: number): Promise<ChildHandle> {
    if (!deps.tosAccepted()) {
      setStatus('not_started');
      throw new Error('whatsapp_tos consent is not current');
    }
    // [repair] Backstop for I7 / ARCH 13: `child` is overwritten unconditionally below, so a second spawn while one is still running
    // would strand the first as an untracked orphan - no pid file, unreachable by killAllSync() and by the reaper, still holding a
    // whatsmeow session on the same whatsapp.db. At most one bridge process exists at any time, whatever the caller did.
    if (child !== null) {
      log.warn('bridge_spawn_replacing_live_child', { attempt });
      await stopChild();
    }
    setStatus('starting');
    readinessAnswered = false;

    const doorbellPort = deps.doorbell.port();
    const port = await freePort({ exclude: [doorbellPort] });
    const token = toHex(deps.random.bytes(32));
    const webhookUrl = deps.doorbell.rotateSecret();

    mkdirSync(deps.paths.bridgeCwd, { recursive: true });
    mkdirSync(deps.paths.bridgeOutboxDir, { recursive: true });

    let exeSha256: string;
    try {
      exeSha256 = await sha256OfFile(deps.exePath);
    } catch {
      exeSha256 = ''; // missing / unreadable exe => exe_hash_mismatch => BRIDGE_BINARY_BLOCKED
    }

    const env = buildEnv(port, token, webhookUrl);
    const plan: BridgeSpawnPlan = {
      exePath: deps.exePath,
      args: exeArgs as readonly [],
      cwd: deps.paths.bridgeCwd,
      env: env as BridgeSpawnPlan['env'],
      userDataDir: deps.paths.userData,
      outboxDir: deps.paths.bridgeOutboxDir,
      doorbellPort,
      exeSha256,
      tosAccepted: true,
    };
    try {
      assertBridgeSpawnInvariants(plan, bridgeSpawnFs, {
        expectedSha256: deps.expectedSha256,
        // The e2e child-mode seam spawns node.exe with the fake-bridge argv; everything else stays the production path.
        resourcesDir: seamMode ? undefined : deps.paths.resourcesDir,
        allowedArgs: exeArgs,
      });
    } catch (err) {
      if (err instanceof SpawnInvariantError) {
        terminal = true;
        const code = errorCodeForViolations(err.violations);
        refusalCode = code;
        deps.audit('spawn_refused', null, { violations: err.violations.join(','), code, attempt }, deps.clock.now());
        log.error('bridge_spawn_refused', { violations: err.violations.join(','), code });
        setStatus('refused');
      }
      throw err;
    }

    const proc = deps.spawn(deps.exePath, exeArgs, {
      cwd: deps.paths.bridgeCwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    child = proc;
    // Captured locally as well as on the module-level `startedAt`: this is the value the Supervisor stamps into the pid
    // file (ChildHandle.spawnedAt), and proc/reaper.ts only reaps an orphan whose Win32_Process.CreationDate is within
    // +-2 s of it. waitForReadiness() below can take seconds (cold start, first-run SQLite migration, slow disk), so
    // the instant this function RESOLVES is the wrong stamp.
    const spawnedAt: EpochMs = deps.clock.now();
    startedAt = spawnedAt;
    attachStdout(proc);
    const exitCbs: Array<(info: { code: number | null; signal: string | null }) => void> = [];
    proc.once('exit', (code, signal) => {
      for (const cb of [...exitCbs]) cb({ code: code ?? null, signal: signal ?? null });
      onChildExit(proc, { code: code ?? null, signal: signal ?? null });
    });
    proc.once('error', () => {
      for (const cb of [...exitCbs]) cb({ code: null, signal: null });
      onChildExit(proc, { code: null, signal: null });
    });

    try {
      await waitForReadiness(proc, port, token);
    } catch (err) {
      log.warn('bridge_readiness_failed', {
        attempt,
        reason:
          err instanceof ForeignListenerError
            ? 'foreign_listener'
            : err instanceof ChildExitedError
              ? 'child_exit'
              : 'timeout',
      });
      if (child === proc) {
        child = null;
        teardownChildState();
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }
      throw err;
    }

    readinessAnswered = true;
    ep = { port, token };
    poller.start();
    scheduleHealth();

    return {
      pid: proc.pid ?? -1,
      exePath: deps.exePath,
      spawnedAt,
      kill: (): void => {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      },
      onExit: (cb): void => {
        exitCbs.push(cb);
      },
    };
  }

  async function launchLoop(): Promise<void> {
    if (launching || terminal) return;
    launching = true;
    try {
      for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
        try {
          await spawnOnce(attempt);
          return;
        } catch {
          if (terminal || status === 'not_started') return;
        }
      }
      // Three ports, no readiness: terminal (no respawn loop, ARCHITECTURE 4.3).
      terminal = true;
      const now = deps.clock.now();
      const outdated = annotations.some((a) => a.marker === 'client_outdated' && now - a.at <= ANNOTATION_WINDOW_MS);
      log.error('bridge_readiness_exhausted', { attempts: MAX_LAUNCH_ATTEMPTS, outdated });
      setStatus(outdated ? 'outdated' : 'failed');
    } finally {
      launching = false;
    }
  }

  function resetBreaker(): void {
    terminal = false;
    refusalCode = null;
    exits.length = 0;
    annotations.length = 0;
    backoffIndex = 0;
    respawnTimer = clearTimer(respawnTimer);
  }

  async function stopInternal(): Promise<void> {
    stopping = true;
    respawnTimer = clearTimer(respawnTimer);
    await stopChild();
    stopping = false;
  }

  // ---- store maintenance ------------------------------------------------------------------------------------------
  function assertInsideStore(target: string, expectedName: string): string {
    const root = resolve(storeDir);
    const full = resolve(target);
    if (!isPathInside(full, root) || full === root || basename(full).toLowerCase() !== expectedName) {
      throw new Error('refusing to delete a path outside the bridge store');
    }
    return full;
  }

  return {
    async start(): Promise<void> {
      if (!deps.tosAccepted()) {
        setStatus('not_started');
        return;
      }
      resetBreaker(); // an explicit start is the user's "Try again"
      stopping = false;
      if (child !== null) return;
      await launchLoop();
    },

    async stop(): Promise<void> {
      await stopInternal();
      setStatus('stopped');
    },

    /** [repair] New QR code / Relink / Unlink & wipe mutate state (audit, store file, breaker) and then leave the RESTART to whoever owns
     *  the child. Once the Supervisor drives this launcher (`childSpec().start()` has run) its caller - compose's bridgeControl - restarts
     *  through `supervisor.start('bridge')`, so calling `launchLoop()` here as well spawned a SECOND whatsapp-bridge.exe and stranded the
     *  first as an untracked orphan (no pid file, invisible to killAllSync/the reaper, two whatsmeow clients on one whatsapp.db).
     *  This is the same early-out `respawn()` already uses; unsupervised callers keep the old self-restart. */
    async restartForNewCode(): Promise<void> {
      deps.audit('pairing', null, { event: 'new_code' }, deps.clock.now());
      await stopInternal();
      resetBreaker();
      if (supervised) return;
      await launchLoop();
    },

    async relink(): Promise<void> {
      await stopInternal();
      const target = assertInsideStore(join(storeDir, 'whatsapp.db'), 'whatsapp.db');
      rmSync(target, { force: true }); // ONLY the device session; messages.db and the media folders stay
      deps.audit('relink', null, { deleted: 'whatsapp.db' }, deps.clock.now());
      resetBreaker();
      if (supervised) return;
      await launchLoop();
    },

    async unlinkAndWipe(): Promise<void> {
      await stopInternal();
      const root = resolve(storeDir);
      if (!isPathInside(root, resolve(deps.paths.userData)) || basename(root).toLowerCase() !== 'store') {
        throw new Error('refusing to wipe a store path outside userData');
      }
      rmSync(root, { recursive: true, force: true });
      deps.audit('wipe', null, { scope: 'bridge_store' }, deps.clock.now());
      resetBreaker();
      if (supervised) return;
      await launchLoop();
    },

    status: (): BridgeStatus => status,
    pairing: (): PairingState => pairingState,
    isOnline: (): boolean => status === 'online',
    onStatus(cb): () => void {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    onPairing(cb): () => void {
      pairingCbs.add(cb);
      return () => pairingCbs.delete(cb);
    },
    endpoint: (): { port: number; token: string } | null => (ep === null ? null : { port: ep.port, token: ep.token }),

    lastRefusalCode: (): ErrorCode | null => refusalCode,
    errorCode: (): ErrorCode | null => bridgeStatusToErrorCode(status, refusalCode),

    childSpec(): ChildSpec {
      return {
        name: 'bridge',
        start: async (attempt: number): Promise<ChildHandle> => {
          supervised = true; // the Supervisor owns backoff / breaker / taskkill from here on
          return spawnOnce(attempt);
        },
        probe: async (): Promise<boolean> => {
          try {
            await read.health(); // 200 AND 503 both mean "the process answered"
            return true;
          } catch {
            return false;
          }
        },
        probeIntervalMs: HEALTH_POLL_MS,
        probeMisses: HEALTH_MISSES_BEFORE_RESPAWN,
        backoffMs: BRIDGE_BACKOFF_MS,
        breaker: { maxExits: BRIDGE_BREAKER.maxExits, windowMs: BRIDGE_BREAKER.windowMs },
        stableAfterMs: BRIDGE_STABLE_AFTER_MS,
        terminal: (): boolean => terminal,
      };
    },
  };
}

/** The exact env keys a bridge child may carry (ARCHITECTURE 4.2); asserted by the launcher's env test. */
export const BRIDGE_ENV_ALLOW_LIST: readonly string[] = [...BRIDGE_ENV_KEYS, ...OS_ENV_PASSTHROUGH];
