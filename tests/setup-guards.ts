// tests/setup-guards.ts - global vitest setup for the main / integration / security projects (TESTS 5.1; owner W0 -> W2-02).
// Implements the mechanical part of rules T1-T3 and T7:
//   T1 spawn guard   - no command or argument may name whatsapp-bridge.exe or the reference \whatsapp-mcp\ tree
//   T2 path guard    - node:fs / node:sqlite refuse any path under the reference bridge's private store
//   T3 network guard - fetch / http(s).request / net.connect refuse every non-loopback host (NETWORK_FORBIDDEN_IN_TESTS)
//   T7 leak guard    - afterEach fails on leaked fake timers, un-stopped fakes, un-closed DatabaseSync handles, leftover child PIDs
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
export function assertAllowedPath(p: unknown): void {
  const s = pathString(p);
  if (s && FORBIDDEN_STORE_RE.test(s)) throw new ForbiddenPathError(s);
}
export function assertAllowedSpawn(command: unknown, args: unknown): void {
  const parts = [String(command), ...(Array.isArray(args) ? args.map(String) : [])];
  if (parts.some((a) => FORBIDDEN_SPAWN_RE.test(a))) throw new ForbiddenSpawnError();
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

  if (problems.length) throw new Error(`T7 leak guard: ${problems.join('; ')}`);
});
