// src/main/bridge/invariants.ts   (frozen signatures; I6)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-02); bodies implemented by W1-02.
// S-FS / S-HASH (TESTS 4.3): the directory probes arrive as the `fs` collaborator and the exe path + pin arrive as parameters,
// so the dummy-exe fixture and the WCA_BRIDGE_CMD child mode both work without touching this file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { ErrorCode } from '../../shared/errors';

export const BRIDGE_EXE = {
  fileName: 'whatsapp-bridge.exe',
  size: 43_540_541,
  sha256: 'ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5',
} as const; // compared lowercase
export const BRIDGE_ENV_KEYS = [
  'WHATSAPP_BRIDGE_PORT',
  'WHATSAPP_BRIDGE_TOKEN',
  'WEBHOOK_URL',
  'FORWARD_SELF',
  'WHATSAPP_MEDIA_ROOTS',
] as const;
export const OS_ENV_PASSTHROUGH = ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const;
export const FORBIDDEN_BRIDGE_ARGS = ['--full-history-pair'] as const;

export interface BridgeSpawnPlan {
  exePath: string; // <resources>\bridge\whatsapp-bridge.exe
  args: readonly []; // ALWAYS empty
  cwd: string; // <userData>\bridge
  env: Record<(typeof BRIDGE_ENV_KEYS)[number], string> & Partial<Record<(typeof OS_ENV_PASSTHROUGH)[number], string>>;
  userDataDir: string;
  outboxDir: string; // <userData>\bridge\outbox-empty
  doorbellPort: number; // our LIVE doorbell
  exeSha256: string; // streamed hash computed just before this call
  tosAccepted: boolean;
}
export const SPAWN_VIOLATIONS = [
  'tos_not_accepted',
  'cwd_outside_userdata',
  'cwd_missing',
  'env_missing',
  'env_extra',
  'port_8080',
  'port_invalid',
  'token_weak',
  'webhook_not_loopback',
  'webhook_wrong_port',
  'webhook_no_secret',
  'forward_self_not_true',
  'outbox_missing',
  'outbox_not_empty',
  'outbox_outside_userdata',
  'exe_hash_mismatch',
  'exe_outside_resources',
  'args_not_empty',
] as const;
export type SpawnViolation = (typeof SPAWN_VIOLATIONS)[number];
/** Throws SpawnInvariantError listing ALL violations. exe_hash_mismatch => BRIDGE_BINARY_BLOCKED ; anything else => BRIDGE_SPAWN_REFUSED. */
export class SpawnInvariantError extends Error {
  constructor(public readonly violations: SpawnViolation[]) {
    super(violations.join(','));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** Probes the two directory facts the invariants need (S-FS: tests pass a `mkdtemp` root or a pure stub). */
export interface SpawnInvariantFs {
  existsDir(p: string): boolean;
  isEmptyDir(p: string): boolean;
}

/** [W1-02 refinement, justified by TESTS 4.3 seams S-HASH ("expectedSha256 + exePath are parameters") and TESTS 4.2 WCA_BRIDGE_CMD.
 *  Purely additive: `assertBridgeSpawnInvariants(plan, fs)` keeps its frozen meaning with the production defaults. */
export interface SpawnInvariantOptions {
  /** Pin the streamed hash must equal. Default: the vendored exe's pin. The e2e child-mode seam supplies its own. */
  expectedSha256?: string;
  /** Root the exe must live under (`paths.resourcesDir`). Omitted => only "not under userData" is enforced. */
  resourcesDir?: string;
  /** Exact argv the plan may carry. Default `[]`. The e2e child-mode seam supplies the fake-bridge argv. */
  allowedArgs?: readonly string[];
}

/** 32 random bytes hex-encoded, exactly as ARCHITECTURE 4.2 prescribes. */
const TOKEN_RE = /^[0-9a-f]{64}$/;
/** `/hook/<32-byte base64url secret>` = 43 chars; anything shorter than 22 is not a secret. */
const WEBHOOK_PATH_RE = /^\/hook\/[A-Za-z0-9_-]{22,}$/;
const PORT_RE = /^[1-9][0-9]{0,4}$/;

function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
/** True when `child` is `parent` itself or lives under it. OS-agnostic, case-insensitive (Windows semantics). */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(`${p}/`);
}
/** A literal `..` segment in the RAW path is a traversal attempt even when it happens to resolve back inside. */
function hasTraversalSegment(p: string): boolean {
  return p.split(/[\\/]+/).includes('..');
}

/** exe_hash_mismatch => BRIDGE_BINARY_BLOCKED ; anything else => BRIDGE_SPAWN_REFUSED (CONTRACTS section 12). */
export function errorCodeForViolations(violations: readonly SpawnViolation[]): ErrorCode {
  return violations.includes('exe_hash_mismatch') ? 'BRIDGE_BINARY_BLOCKED' : 'BRIDGE_SPAWN_REFUSED';
}

/** Streamed SHA-256 of one file - the bridge exe is 43.5 MB, so it is never read into memory whole. Rejects when it cannot be read. */
export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise<string>((res, rej) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', rej);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      res(hash.digest('hex'));
    });
  });
}

export function assertBridgeSpawnInvariants(
  plan: BridgeSpawnPlan,
  fs: SpawnInvariantFs,
  opts: SpawnInvariantOptions = {},
): void {
  const found = new Set<SpawnViolation>();
  const add = (v: SpawnViolation): void => {
    found.add(v);
  };
  const expectedSha256 = (opts.expectedSha256 ?? BRIDGE_EXE.sha256).toLowerCase();
  const allowedArgs = opts.allowedArgs ?? [];
  const env = plan.env as unknown as Record<string, string | undefined>;

  // ---- ToS disclosure -------------------------------------------------------------------------------------------
  if (!plan.tosAccepted) add('tos_not_accepted');

  // ---- cwd ------------------------------------------------------------------------------------------------------
  if (hasTraversalSegment(plan.cwd) || !isPathInside(plan.cwd, plan.userDataDir)) add('cwd_outside_userdata');
  if (!fs.existsDir(plan.cwd)) add('cwd_missing');

  // ---- env ------------------------------------------------------------------------------------------------------
  for (const key of BRIDGE_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== 'string' || value === '') add('env_missing');
  }
  const allowedEnv = new Set<string>([...BRIDGE_ENV_KEYS, ...OS_ENV_PASSTHROUGH]);
  for (const key of Object.keys(env)) {
    if (!allowedEnv.has(key)) add('env_extra');
  }

  // ---- port -----------------------------------------------------------------------------------------------------
  const rawPort = env.WHATSAPP_BRIDGE_PORT ?? '';
  const port = Number(rawPort);
  if (port === 8080) add('port_8080');
  else if (!PORT_RE.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) add('port_invalid');

  // ---- token ----------------------------------------------------------------------------------------------------
  if (!TOKEN_RE.test(env.WHATSAPP_BRIDGE_TOKEN ?? '')) add('token_weak');

  // ---- webhook --------------------------------------------------------------------------------------------------
  let hook: URL | null;
  try {
    hook = new URL(env.WEBHOOK_URL ?? '');
  } catch {
    hook = null;
  }
  if (hook === null || hook.protocol !== 'http:' || hook.hostname !== '127.0.0.1') {
    add('webhook_not_loopback');
  } else {
    if (Number(hook.port) !== plan.doorbellPort) add('webhook_wrong_port');
    if (!WEBHOOK_PATH_RE.test(hook.pathname)) add('webhook_no_secret');
  }

  // ---- forward self ---------------------------------------------------------------------------------------------
  if (env.FORWARD_SELF !== 'true') add('forward_self_not_true');

  // ---- outbox ---------------------------------------------------------------------------------------------------
  const mediaRoots = env.WHATSAPP_MEDIA_ROOTS ?? '';
  if (
    !isPathInside(plan.outboxDir, plan.userDataDir) ||
    (mediaRoots !== '' && !isPathInside(mediaRoots, plan.userDataDir))
  ) {
    add('outbox_outside_userdata');
  }
  if (!fs.existsDir(plan.outboxDir)) add('outbox_missing');
  else if (!fs.isEmptyDir(plan.outboxDir)) add('outbox_not_empty');

  // ---- exe ------------------------------------------------------------------------------------------------------
  if (plan.exeSha256.toLowerCase() !== expectedSha256) add('exe_hash_mismatch');
  if (opts.resourcesDir === undefined) {
    if (isPathInside(plan.exePath, plan.userDataDir)) add('exe_outside_resources');
  } else if (!isPathInside(plan.exePath, opts.resourcesDir)) {
    add('exe_outside_resources');
  }

  // ---- args -----------------------------------------------------------------------------------------------------
  const args = plan.args as readonly string[];
  const forbidden = FORBIDDEN_BRIDGE_ARGS as readonly string[];
  if (
    args.length !== allowedArgs.length ||
    args.some((a, i) => a !== allowedArgs[i]) ||
    args.some((a) => forbidden.includes(a))
  ) {
    add('args_not_empty');
  }

  if (found.size > 0) {
    const ordered = SPAWN_VIOLATIONS.filter((v) => found.has(v));
    throw new SpawnInvariantError([...ordered]);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// [V2] B5 (A16 amended): five implemented endpoints; GET /api/media only through media/fetch.ts (V2-W1-07-media-voice)
// ---------------------------------------------------------------------------------------------------------------------
/** The FIVE bridge endpoints the app implements (v1 four + GET /api/media). */
export const BRIDGE_ENDPOINTS = [
  '/api/health',
  '/api/pairing/status',
  '/api/pairing/qr.png',
  '/api/send',
  '/api/media',
] as const;
/** Endpoint names referenced NOWHERE in src/ code. Stored as names (the sweep builds `/api/<name>`) so this file does not reference them. */
export const FORBIDDEN_BRIDGE_ENDPOINT_NAMES = ['download', 'typing', 'react', 'group/'] as const;
/** The only module that may call `BridgeReadClient.getMedia` (B5, I6'). */
export const MEDIA_FETCH_MODULE = 'src/main/media/fetch.ts';
/** Modules that may carry the `/api/media` path literal: the transport that builds the request and this list. */
export const MEDIA_PATH_MODULES = ['src/main/bridge/readClient.ts', 'src/main/bridge/invariants.ts'] as const;

export interface EndpointSweepFinding {
  file: string;
  kind: 'forbidden_endpoint' | 'media_path_outside_transport' | 'get_media_outside_fetch';
  detail: string;
}

/** Removes block and line comments (C2 doc comments quote the forbidden names on purpose); string contents are kept. */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

/** B5 sweep over repo-relative, forward-slash source files (tests and fixtures excluded by the caller). Pure. */
export function sweepBridgeEndpointRefs(files: ReadonlyArray<{ path: string; text: string }>): EndpointSweepFinding[] {
  const findings: EndpointSweepFinding[] = [];
  const mediaPathOk = MEDIA_PATH_MODULES as readonly string[];
  for (const f of files) {
    const code = stripComments(f.text);
    for (const name of FORBIDDEN_BRIDGE_ENDPOINT_NAMES) {
      if (code.includes(`/api/${name}`))
        findings.push({ file: f.path, kind: 'forbidden_endpoint', detail: `/api/${name}` });
    }
    if (code.includes('/api/media') && !mediaPathOk.includes(f.path)) {
      findings.push({ file: f.path, kind: 'media_path_outside_transport', detail: '/api/media' });
    }
    if (/\.getMedia\s*\(/.test(code) && f.path !== MEDIA_FETCH_MODULE) {
      findings.push({ file: f.path, kind: 'get_media_outside_fetch', detail: 'getMedia(' });
    }
  }
  return findings;
}
