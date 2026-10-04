// tests/setup-guards.ts - global vitest setup for the main / integration / security projects (TESTS 5.1; owner W0 -> W2-02).
// Implements the mechanical part of rules T1-T3 and T7:
//   T1 spawn guard   - no command or argument may name whatsapp-bridge.exe or the reference \whatsapp-mcp\ tree
//   T2 path guard    - node:fs / node:sqlite refuse any path under the reference bridge's private store
//   T3 network guard - fetch / http(s).request / net.connect refuse every non-loopback host (NETWORK_FORBIDDEN_IN_TESTS)
//   T7 leak guard    - afterEach fails on leaked fake timers, un-stopped fakes, un-closed DatabaseSync handles, leftover child PIDs
//   [V2] T8 vendor-binary guard - no command or argv element (split on whitespace, so `cmd /c claude ...` is caught) may
//        have the basename claude|agy|whisper-cli|llama-server|where (+ .exe/.cmd/.bat); `cmd`/`cmd.exe` with `/k` refused
//   [V2] T9 vendor-state guard - fs reads, lists, stats AND writes refuse the real user's vendor-CLI state, with prefixes
//        resolved from the REAL env at install time (%USERPROFILE%\.claude*, \.gemini\, \.local\bin\, %APPDATA%\npm\,
//        %LOCALAPPDATA%\agy\, %LOCALAPPDATA%\AnthropicClaude\)
//   [V2] T7 additions - an open tool-server listener, <userData>\run\job-*.pid.json, a non-empty <userData>\cli-runs\ or
//        <userData>\agy-workspace\runs\, a <userData>\voice\tmp\*.wav (userData dirs are registered by the harness)
// Everything is installed once per worker; the registries below are exported for the ledger hook and the fakes.
import { afterEach, vi } from 'vitest';
import cp from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type sqlite from 'node:sqlite';
import { syncBuiltinESMExports } from 'node:module';

// node:sqlite: syncBuiltinESMExports() does NOT propagate a replaced DatabaseSync class to named imports on Node 24.19, so the
// class is wrapped through vitest module mocking instead (applies to every import of node:sqlite in this project).
vi.mock('node:sqlite', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:sqlite')>();
  class GuardedDatabaseSync extends orig.DatabaseSync {
    constructor(location: string | Buffer | URL, options?: sqlite.DatabaseSyncOptions) {
      assertAllowedPath(location);
      if (options === undefined) super(location);
      else super(location, options);
      dbs.add(this);
    }
  }
  return { ...orig, DatabaseSync: GuardedDatabaseSync, default: { ...orig, DatabaseSync: GuardedDatabaseSync } };
});

process.env.TZ = 'UTC';

// ---------------------------------------------------------------------------------------------------------------------
// registries (T7 + ledger)
// ---------------------------------------------------------------------------------------------------------------------
export interface StoppableFake {
  name: string;
  stop(): Promise<void> | void;
  violations?: string[];
}
const fakes = new Set<StoppableFake>();
/** Fakes register themselves on start and unregister on stop; the afterEach fails the test when one is still registered. */
export function registerFake(f: StoppableFake): () => void {
  fakes.add(f);
  return () => fakes.delete(f);
}
export function activeFakes(): StoppableFake[] {
  return [...fakes];
}
const children = new Set<cp.ChildProcess>();
export function trackedChildren(): cp.ChildProcess[] {
  return [...children];
}
const dbs = new Set<sqlite.DatabaseSync>();
export function openDatabases(): sqlite.DatabaseSync[] {
  return [...dbs].filter((d) => d.isOpen);
}
/** [V2] T7 (a): every loopback listener the tool server (or a test) opens registers here; a still-listening one fails. */
export interface TrackedListener {
  name: string;
  readonly listening: boolean;
  close(): unknown;
}
const listeners = new Set<TrackedListener>();
export function registerListener(l: TrackedListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** [V2] T7 (b)-(d): per-test userData dirs (the harness registers its temp dir; the scan runs only while it still exists). */
const userDataDirs = new Set<string>();
export function registerUserDataDir(dir: string): () => void {
  userDataDirs.add(dir);
  return () => userDataDirs.delete(dir);
}

// ---------------------------------------------------------------------------------------------------------------------
// forbidden strings / paths
// ---------------------------------------------------------------------------------------------------------------------
const FORBIDDEN_STORE_RE = /whatsapp-mcp[\\/]+whatsapp-bridge[\\/]+store([\\/]|$)/i;
const FORBIDDEN_SPAWN_RE = /whatsapp-bridge\.exe|[\\/]whatsapp-mcp[\\/]/i;

export class ForbiddenPathError extends Error {
  constructor(p: string) {
    super(`FORBIDDEN_PATH_IN_TESTS: ${p.replace(/[^\\/]+$/, '<redacted>')}`);
    this.name = 'ForbiddenPathError';
  }
}
export class ForbiddenSpawnError extends Error {
  constructor() {
    super('FORBIDDEN_SPAWN_IN_TESTS: whatsapp-bridge.exe / reference bridge tree');
    this.name = 'ForbiddenSpawnError';
  }
}
/** [V2] T8: a vendor CLI / whisper / llama-server / where.exe or a visible `cmd /k` console was about to be spawned. */
export class ForbiddenVendorSpawnError extends Error {
  constructor(what: string) {
    super(`FORBIDDEN_VENDOR_SPAWN_IN_TESTS (T8): ${what}`);
    this.name = 'ForbiddenVendorSpawnError';
  }
}
/** [V2] T9: the real user's vendor-CLI state. The message names the RULE prefix, never the resolved home path. */
export class ForbiddenVendorStateError extends Error {
  constructor(label: string) {
    super(`FORBIDDEN_VENDOR_STATE_IN_TESTS (T9): ${label}`);
    this.name = 'ForbiddenVendorStateError';
  }
}
export class NetworkForbiddenError extends Error {
  constructor(host: string) {
    super(`NETWORK_FORBIDDEN_IN_TESTS: ${host}`);
    this.name = 'NetworkForbiddenError';
  }
}

function pathString(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p instanceof URL) return p.pathname;
  if (p instanceof Uint8Array) return Buffer.from(p).toString('utf8');
  return '';
}
// [V2] T9 prefixes, resolved ONCE from the real environment when this module loads (a test that later rewrites
// process.env cannot move them). Compared case-insensitively on normalised backslash paths.
interface VendorPrefix {
  label: string;
  /** lower-case, backslash-normalised; `exact` = the prefix may be followed by anything (`.claude*`), else a dir. */
  prefix: string;
  glob: boolean;
}
const norm = (s: string): string =>
  s
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
function vendorPrefixes(env: NodeJS.ProcessEnv): VendorPrefix[] {
  const out: VendorPrefix[] = [];
  const add = (base: string | undefined, rel: string, label: string, glob: boolean): void => {
    if (base === undefined || base === '') return;
    out.push({ label, prefix: norm(`${base}\\${rel}`), glob });
  };
  add(env.USERPROFILE, '.claude', '%USERPROFILE%\\.claude*', true);
  add(env.USERPROFILE, '.gemini', '%USERPROFILE%\\.gemini\\', false);
  add(env.USERPROFILE, '.local\\bin', '%USERPROFILE%\\.local\\bin\\', false);
  add(env.APPDATA, 'npm', '%APPDATA%\\npm\\', false);
  add(env.LOCALAPPDATA, 'agy', '%LOCALAPPDATA%\\agy\\', false);
  add(env.LOCALAPPDATA, 'AnthropicClaude', '%LOCALAPPDATA%\\AnthropicClaude\\', false);
  return out;
}
export const VENDOR_STATE_PREFIXES: readonly VendorPrefix[] = Object.freeze(vendorPrefixes(process.env));
/** The label of the T9 rule a path falls under, or null. Exported for the self-test. */
export function vendorStateRuleOf(p: string): string | null {
  if (!/^[a-z]:[\\/]|^\\\\/i.test(p)) return null; // relative / URL-ish paths never resolve into a profile here
  const s = norm(p);
  for (const v of VENDOR_STATE_PREFIXES) {
    if (v.glob ? s.startsWith(v.prefix) : s === v.prefix || s.startsWith(`${v.prefix}\\`)) return v.label;
  }
  return null;
}
export function assertAllowedPath(p: unknown): void {
  const s = pathString(p);
  if (s && FORBIDDEN_STORE_RE.test(s)) throw new ForbiddenPathError(s);
  const rule = s ? vendorStateRuleOf(s) : null;
  if (rule !== null) throw new ForbiddenVendorStateError(rule);
}
/** [V2] T8 basename rule (T2 0) - over the command AND every argv element. */
export const VENDOR_BINARY_RE = /^(claude|agy|whisper-cli|llama-server|where)(\.exe|\.cmd|\.bat)?$/i;
const baseNameOf = (s: string): string =>
  s
    .replace(/^["']+|["']+$/g, '')
    .split(/[\\/]/)
    .pop() ?? '';
export function assertAllowedSpawn(command: unknown, args: unknown): void {
  const parts = [String(command), ...(Array.isArray(args) ? args.map(String) : [])];
  if (parts.some((a) => FORBIDDEN_SPAWN_RE.test(a))) throw new ForbiddenSpawnError();
  const tokens = parts.flatMap((a) => a.split(/\s+/)).filter((a) => a !== '');
  const hit = tokens.find((a) => VENDOR_BINARY_RE.test(baseNameOf(a)));
  if (hit !== undefined) throw new ForbiddenVendorSpawnError(baseNameOf(hit));
  // `cmd /k` (the visible sign-in console) - in the argv or inside a command string.
  for (let i = 0; i < tokens.length; i += 1) {
    if (/^cmd(\.exe)?$/i.test(baseNameOf(tokens[i]!)) && tokens.slice(i + 1).some((a) => /^\/k$/i.test(a)))
      throw new ForbiddenVendorSpawnError('cmd /k');
  }
}
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return true; // node defaults to localhost
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
export function assertLoopback(host: string | undefined | null): void {
  if (!isLoopbackHost(host)) throw new NetworkForbiddenError(String(host));
}

// ---------------------------------------------------------------------------------------------------------------------
// T1 spawn guard
// ---------------------------------------------------------------------------------------------------------------------
const g = globalThis as unknown as { __wcaGuardsInstalled?: boolean };
if (!g.__wcaGuardsInstalled) {
  g.__wcaGuardsInstalled = true;

  const origSpawn = cp.spawn;
  const origExecFile = cp.execFile;
  const origExec = cp.exec;
  const origFork = cp.fork;
  const origSpawnSync = cp.spawnSync;
  const origExecSync = cp.execSync;
  const origExecFileSync = cp.execFileSync;

  const track = (child: cp.ChildProcess): cp.ChildProcess => {
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.once('error', () => children.delete(child));
    return child;
  };
  cp.spawn = ((command: string, args?: unknown, options?: unknown) => {
    assertAllowedSpawn(command, Array.isArray(args) ? args : []);
    if (options && typeof options === 'object' && (options as { shell?: unknown }).shell)
      throw new ForbiddenSpawnError();
    return track((origSpawn as (...a: unknown[]) => cp.ChildProcess)(command, args, options));
  }) as typeof cp.spawn;
  cp.execFile = ((command: string, ...rest: unknown[]) => {
    assertAllowedSpawn(command, Array.isArray(rest[0]) ? rest[0] : []);
    return track((origExecFile as (...a: unknown[]) => cp.ChildProcess)(command, ...rest));
  }) as typeof cp.execFile;
  cp.exec = ((command: string, ...rest: unknown[]) => {
    assertAllowedSpawn(command, []);
    return track((origExec as (...a: unknown[]) => cp.ChildProcess)(command, ...rest));
  }) as typeof cp.exec;
  cp.fork = ((modulePath: string, args?: unknown, options?: unknown) => {
    assertAllowedSpawn(modulePath, Array.isArray(args) ? args : []);
    return track((origFork as (...a: unknown[]) => cp.ChildProcess)(modulePath, args, options));
  }) as typeof cp.fork;
  cp.spawnSync = ((command: string, args?: unknown, options?: unknown) => {
    assertAllowedSpawn(command, Array.isArray(args) ? args : []);
    return (origSpawnSync as (...a: unknown[]) => cp.SpawnSyncReturns<Buffer>)(command, args, options);
  }) as typeof cp.spawnSync;
  cp.execSync = ((command: string, options?: unknown) => {
    assertAllowedSpawn(command, []);
    return (origExecSync as (...a: unknown[]) => Buffer)(command, options);
  }) as typeof cp.execSync;
  cp.execFileSync = ((command: string, args?: unknown, options?: unknown) => {
    assertAllowedSpawn(command, Array.isArray(args) ? args : []);
    return (origExecFileSync as (...a: unknown[]) => Buffer)(command, args, options);
  }) as typeof cp.execFileSync;

  // -------------------------------------------------------------------------------------------------------------------
  // T2 path guard (fs sync + promises + node:sqlite)
  // -------------------------------------------------------------------------------------------------------------------
  const guardFirstArg = <F extends (...a: never[]) => unknown>(fn: F): F =>
    ((...a: unknown[]) => {
      assertAllowedPath(a[0]);
      // [V2] T9: the second path of rename/copyFile/cp (an options object or an encoding string is harmless here)
      if (typeof a[1] === 'string' || a[1] instanceof URL) assertAllowedPath(a[1]);
      return (fn as unknown as (...x: unknown[]) => unknown)(...a);
    }) as unknown as F;
  for (const name of [
    'openSync',
    'readdirSync',
    'statSync',
    'lstatSync',
    'readFileSync',
    'existsSync',
    'accessSync',
    'opendirSync',
    'createReadStream',
  ] as const) {
    (fs as unknown as Record<string, unknown>)[name] = guardFirstArg(fs[name] as (...a: never[]) => unknown);
  }
  // [V2] T9: writes too
  for (const name of [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'rmSync',
    'rmdirSync',
    'unlinkSync',
    'renameSync',
    'copyFileSync',
    'cpSync',
    'createWriteStream',
  ] as const) {
    (fs as unknown as Record<string, unknown>)[name] = guardFirstArg(fs[name] as (...a: never[]) => unknown);
  }
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename', 'copyFile', 'cp'] as const) {
    (fs as unknown as Record<string, unknown>)[name] = guardFirstArg(fs[name] as (...a: never[]) => unknown);
    (fsp as unknown as Record<string, unknown>)[name] = guardFirstArg(fsp[name] as (...a: never[]) => unknown);
  }
  for (const name of ['open', 'readdir', 'stat', 'lstat', 'readFile', 'access', 'opendir'] as const) {
    (fs as unknown as Record<string, unknown>)[name] = guardFirstArg(fs[name] as (...a: never[]) => unknown);
    (fsp as unknown as Record<string, unknown>)[name] = guardFirstArg(fsp[name] as (...a: never[]) => unknown);
  }
  (fs.promises as unknown as Record<string, unknown>).open = fsp.open;
  (fs.promises as unknown as Record<string, unknown>).readdir = fsp.readdir;
  (fs.promises as unknown as Record<string, unknown>).stat = fsp.stat;

  // -------------------------------------------------------------------------------------------------------------------
  // T3 network guard
  // -------------------------------------------------------------------------------------------------------------------
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let host: string | null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    assertLoopback(host);
    return origFetch(input, init);
  }) as typeof fetch;

  const hostOfRequestArgs = (a: unknown[]): string | undefined => {
    const first = a[0];
    if (typeof first === 'string') return new URL(first).hostname;
    if (first instanceof URL) return first.hostname;
    const opts = (typeof first === 'object' && first ? first : typeof a[1] === 'object' && a[1] ? a[1] : {}) as {
      host?: string;
      hostname?: string;
    };
    return opts.hostname ?? opts.host ?? undefined;
  };
  for (const mod of [http, https] as Array<typeof http>) {
    const origRequest = mod.request;
    const origGet = mod.get;
    mod.request = ((...a: unknown[]) => {
      assertLoopback(hostOfRequestArgs(a));
      return (origRequest as (...x: unknown[]) => http.ClientRequest)(...a);
    }) as typeof http.request;
    mod.get = ((...a: unknown[]) => {
      assertLoopback(hostOfRequestArgs(a));
      return (origGet as (...x: unknown[]) => http.ClientRequest)(...a);
    }) as typeof http.get;
  }
  const origConnect = net.connect;
  const origCreateConnection = net.createConnection;
  const hostOfConnectArgs = (a: unknown[]): string | undefined => {
    if (typeof a[0] === 'number') return typeof a[1] === 'string' ? a[1] : undefined;
    if (typeof a[0] === 'string') return undefined; // IPC path
    const o = a[0] as { host?: string; path?: string } | undefined;
    return o?.path ? undefined : o?.host;
  };
  net.connect = ((...a: unknown[]) => {
    assertLoopback(hostOfConnectArgs(a));
    return (origConnect as (...x: unknown[]) => net.Socket)(...a);
  }) as typeof net.connect;
  net.createConnection = ((...a: unknown[]) => {
    assertLoopback(hostOfConnectArgs(a));
    return (origCreateConnection as (...x: unknown[]) => net.Socket)(...a);
  }) as typeof net.createConnection;

  syncBuiltinESMExports();
}

// ---------------------------------------------------------------------------------------------------------------------
// T7 leak guard
// ---------------------------------------------------------------------------------------------------------------------
afterEach(async () => {
  const problems: string[] = [];

  if (vi.isFakeTimers()) {
    const pending = vi.getTimerCount();
    if (pending > 0) problems.push(`${pending} fake timer(s) still pending`);
    vi.useRealTimers();
  }

  for (const f of [...fakes]) {
    problems.push(`fake "${f.name}" was not stopped`);
    try {
      await f.stop();
    } catch {
      /* best effort */
    }
    fakes.delete(f);
  }

  const open = openDatabases();
  for (const d of open) {
    problems.push('a DatabaseSync handle was left open');
    try {
      d.close();
    } catch {
      /* already closed */
    }
    dbs.delete(d);
  }
  for (const d of [...dbs]) if (!d.isOpen) dbs.delete(d);

  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      problems.push(`child pid ${child.pid} was still running`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    children.delete(child);
  }

  problems.push(...v2LeakProblems());

  if (problems.length) throw new Error(`T7 leak guard: ${problems.join('; ')}`);
});

/** [V2] T7 (a)-(d). Pure report (the afterEach above turns it into a failure); exported for the self-test. Closes a
 *  leaked listener so the next test starts clean; never deletes files (the evidence stays for the failure). */
export function v2LeakProblems(): string[] {
  const problems: string[] = [];
  for (const l of [...listeners]) {
    if (l.listening) {
      problems.push(`listener "${l.name}" was still open`);
      try {
        l.close();
      } catch {
        /* best effort */
      }
    }
    listeners.delete(l);
  }
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const dir of [...userDataDirs]) {
    if (!fs.existsSync(dir)) {
      userDataDirs.delete(dir);
      continue;
    }
    const pids = list(`${dir}/run`).filter((f) => /^job-.*\.pid\.json$/i.test(f));
    if (pids.length) problems.push(`${pids.length} job pid file(s) left in <userData>\\run`);
    if (list(`${dir}/cli-runs`).length) problems.push('<userData>\\cli-runs is not empty');
    if (list(`${dir}/agy-workspace/runs`).length) problems.push('<userData>\\agy-workspace\\runs is not empty');
    const wavs = list(`${dir}/voice/tmp`).filter((f) => /\.wav$/i.test(f));
    if (wavs.length) problems.push(`${wavs.length} .wav file(s) left in <userData>\\voice\\tmp`);
  }
  return problems;
}
