// src/main/net/pinnedDownload.ts - the pinned-download rules shared by the model downloader (llm/local/download.ts) and the
// v5 update downloader (update/updateService.ts). Extracted from download.ts (v5 W2) so both enforce ONE implementation of:
// host allow-list (https only; http loopback only behind the e2e gate), exactly one redirect hop (`redirect:'manual'`, then
// `redirect:'error'`), `.part` + Range resume (416 = already complete, 200 = server ignored Range -> restart), an optional
// byte cap (size pin), and a streamed sha256. Policy (sidecars, retries, magic, error codes, logs) stays with each caller.
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FetchFn } from '../deps';

export interface HostAllowList {
  readonly exact: readonly string[];
  readonly suffix: readonly string[];
}

/**
 * True when `raw` is an https URL whose host is in `allow.exact` or ends with one of `allow.suffix` (a real sub-domain: the
 * suffixes start with a dot). `allowHttpLoopback` (an e2e seam, false in production) additionally admits http://127.0.0.1 / [::1].
 */
export function isAllowedUrl(raw: string, allow: HostAllowList, allowHttpLoopback = false): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false; // never credentials in a download URL
  const host = url.hostname.toLowerCase();
  if (allowHttpLoopback && url.protocol === 'http:' && (host === '127.0.0.1' || host === '[::1]' || host === '::1'))
    return true;
  if (url.protocol !== 'https:') return false;
  if (allow.exact.some((h) => h === host)) return true;
  return allow.suffix.some((s) => host.endsWith(s));
}

/** A refusal of the transfer itself. `message` is a short machine reason (never a URL): `redirect_host_refused`, `http_404`, ... */
export class PinnedTransferError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PinnedTransferError';
  }
}

export interface PinnedTransferInput {
  fetch: FetchFn;
  /** The pinned URL; re-requested on every attempt (a CDN redirect is signed and expires). */
  url: string;
  /** `<file>.part`; appended to from `offset` (a resume) or truncated (offset 0). */
  partPath: string;
  /** Bytes already in the part file that the caller trusts (0 = start over). */
  offset: number;
  /** The redirect target rule (the first URL is the caller's own pinned constant). */
  isAllowed: (url: string) => boolean;
  signal?: AbortSignal;
  /** Extra request headers (User-Agent, Accept). Range is added here. */
  headers?: Record<string, string>;
  /** Sees the first response (`redirected` = it is the 3xx) before anything else happens; may throw to refuse. */
  onFirstResponse?: (res: Response, redirected: boolean) => Promise<void> | void;
  /** Called after every written chunk with the total bytes in the part file. */
  onBytes?: (bytesDone: number, startOffset: number) => void;
  /** Size pin: the part file may never grow past this many bytes (`size_exceeded`). */
  maxBytes?: number;
}

/** One transfer attempt into `partPath`. Resolves with the byte count of the part file; throws PinnedTransferError on a refusal. */
export async function transferToPart(input: PinnedTransferInput): Promise<number> {
  let offset = input.offset;
  const headersAt = (from: number): Record<string, string> => ({
    ...(input.headers ?? {}),
    ...(from > 0 ? { range: `bytes=${String(from)}-` } : {}),
  });
  const init = (redirect: 'manual' | 'error'): RequestInit => ({
    method: 'GET',
    redirect,
    headers: headersAt(offset),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  let res = await input.fetch(input.url, init('manual'));
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (location === null || !input.isAllowed(location)) throw new PinnedTransferError('redirect_host_refused');
    await input.onFirstResponse?.(res, true);
    // ONE hop only: `redirect:'error'` makes a second redirect throw.
    res = await input.fetch(location, init('error'));
  } else {
    await input.onFirstResponse?.(res, false);
  }

  if (res.status === 416) {
    await res.body?.cancel();
    return offset; // the part is already complete
  }
  if (res.status === 200 && offset > 0) {
    await fsp.rm(input.partPath, { force: true }); // server ignored Range: restart from zero
    offset = 0;
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw new PinnedTransferError(`http_${String(res.status)}`);
  }
  const body = res.body;
  if (body === null) throw new PinnedTransferError('empty_body');
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (input.maxBytes !== undefined && Number.isFinite(declared) && offset + declared > input.maxBytes) {
    await body.cancel();
    throw new PinnedTransferError('size_exceeded');
  }

  const handle = await fsp.open(input.partPath, offset > 0 ? 'a' : 'w');
  const reader = body.getReader();
  let done = offset;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      if (input.maxBytes !== undefined && done + buf.length > input.maxBytes) {
        await reader.cancel();
        throw new PinnedTransferError('size_exceeded');
      }
      await handle.write(buf);
      done += buf.length;
      input.onBytes?.(done, offset);
    }
  } finally {
    await handle.close();
  }
  return done;
}

/** Streamed sha256 (hex) of a file - never the whole file in memory. */
export function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * A small JSON (or text) GET with the same host rule and one redirect hop, capped at `maxBytes`. Used for the GitHub API answer
 * and `release.json`. Throws PinnedTransferError (`redirect_host_refused`, `http_<n>`, `too_large`, `empty_body`).
 */
export async function fetchSmall(input: {
  fetch: FetchFn;
  url: string;
  isAllowed: (url: string) => boolean;
  headers?: Record<string, string>;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<string> {
  const init = (redirect: 'manual' | 'error'): RequestInit => ({
    method: 'GET',
    redirect,
    headers: input.headers ?? {},
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  let res = await input.fetch(input.url, init('manual'));
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    await res.body?.cancel();
    if (location === null || !input.isAllowed(location)) throw new PinnedTransferError('redirect_host_refused');
    res = await input.fetch(location, init('error'));
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new PinnedTransferError(`http_${String(res.status)}`);
  }
  const body = res.body;
  if (body === null) throw new PinnedTransferError('empty_body');
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > input.maxBytes) {
      await reader.cancel();
      throw new PinnedTransferError('too_large');
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
