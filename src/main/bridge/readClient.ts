// src/main/bridge/readClient.ts   (frozen signatures)
// Frozen signatures pasted verbatim from docs/specs/contracts.md (owner W1-02); bodies implemented by W1-02.
import { z } from 'zod';
import type { FetchFn } from '../deps';
/** Base URL is ALWAYS http://127.0.0.1:<port> (never 'localhost'); header `Authorization: Bearer <token>` (case-sensitive prefix);
 *  fetch with redirect:'error'. 403 'Forbidden: host not allowed' / 401 'Unauthorized' => a foreign listener => BridgeAuthError. */
export interface BridgeEndpoint {
  port: number;
  token: string;
} // memory only ; never logged, never sent to the renderer

/** GET /api/health -> 200 {"status":"ok","connected":true,"timestamp":<unix s>} | 503 {"status":"disconnected","connected":false,"timestamp":...} */
export interface BridgeHealthWire {
  status: 'ok' | 'disconnected';
  connected: boolean;
  timestamp: number;
}
export interface BridgeHealth {
  httpStatus: 200 | 503;
  connected: boolean;
  timestampS: number;
}

/** GET /api/pairing/status -> always 200 */
export interface BridgePairingStatusWire {
  status: 'connecting' | 'qr_pending' | 'connected' | 'timeout' | 'error';
  qr_present?: true; // only while a QR code is held
  expires_at?: number; // unix SECONDS ; last rotation + 20 s ; a hint only
  message?: string; // on timeout / error ; UNTRUSTED for display, matched only against LOGGED_OUT_MESSAGE_RE
}
export const LOGGED_OUT_MESSAGE_RE = /logged out/i; // "Device was logged out -- restart the bridge to pair again"
// [R2] `status:'error'` + LOGGED_OUT_MESSAGE_RE on THIS endpoint is the ONLY source of the launcher's `logged_out` state (never a stdout marker).

export class BridgeAuthError extends Error {} // 401 / 403: someone else's process on our port
export class BridgeUnreachableError extends Error {} // connection refused / timeout (15 s)

export interface BridgeReadClient {
  health(): Promise<BridgeHealth>; // treats 200 and 503 as answers ; anything else throws
  pairingStatus(): Promise<BridgePairingStatusWire>; // zod-validated ; unknown status => throws
  /** GET /api/pairing/qr.png -> 200 image/png | 404 'no QR code available' (=> null) | 500 (=> null). Main converts to a data: URL. */
  pairingQrPng(): Promise<Uint8Array | null>;
  /** [V2 ADD] (C2 12 BridgeReadClientV2) - see the block below. Callable ONLY from src/main/media/fetch.ts. */
  getMedia(
    chatJid: string,
    waMsgId: string,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<BridgeMedia | null>;
}

// ---------------------------------------------------------------------------------------------------------------------
// [V2 ADD] C2 12 (after the v1 block; BridgeReadClient gains getMedia)
// ---------------------------------------------------------------------------------------------------------------------
/** GET /api/media?jid=<chatJID>&message_id=<id> - the bridge downloads + decrypts on demand (serveMedia -> downloadMedia) and validates the ids.
 *  Same base URL / bearer / redirect:'error' / 15 s connect budget as the v1 reads. Before the request: chatJid must match MEDIA_JID_RE and waMsgId
 *  MEDIA_MSG_ID_RE (else throws BridgeMediaIdError - no request). The body is streamed into a Buffer with a hard cap: abort at maxBytes + 1
 *  => BridgeMediaTooLargeError. 404 => null ; 401/403 => BridgeAuthError ; 5xx / timeout => BridgeUnreachableError. contentType is UNTRUSTED
 *  (callers sniff magic bytes). Callable ONLY from src/main/media/fetch.ts (import-graph + invariants.test.ts endpoint sweep); no
 *  /api/download, /api/typing, /api/react or /api/group/* reference exists anywhere. */
// eslint-disable-next-line no-useless-escape -- C2 verbatim
export const MEDIA_JID_RE = /^[A-Za-z0-9.\-]{1,100}@[a-z.]{1,40}$/;
export const MEDIA_MSG_ID_RE = /^[A-Za-z0-9]{1,128}$/;
export class BridgeMediaIdError extends Error {}
export class BridgeMediaTooLargeError extends Error {}
export interface BridgeMedia {
  bytes: Uint8Array;
  contentType: string | null;
}
/** C2 names the delta `BridgeReadClientV2`; per the C2 convention the member lives on BridgeReadClient itself. */
export type BridgeReadClientV2 = BridgeReadClient;

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** ARCHITECTURE 4.2 readiness budget / bridge-contract.md section 2: every read is bounded. */
export const BRIDGE_READ_TIMEOUT_MS = 15_000;
/** A QR PNG from rsc.io/qr level M is a few hundred bytes; anything bigger is not a QR code we will turn into a data: URL. */
export const QR_PNG_MAX_BYTES = 256 * 1024;

const healthWireSchema = z.object({
  status: z.enum(['ok', 'disconnected']),
  connected: z.boolean(),
  timestamp: z.number(),
});
const pairingWireSchema = z.object({
  status: z.enum(['connecting', 'qr_pending', 'connected', 'timeout', 'error']),
  qr_present: z.literal(true).optional(),
  expires_at: z.number().optional(),
  message: z.string().optional(),
});

function discard(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

/** Streams a response body into one buffer, aborting at cap + 1 bytes (the rest is never read). */
async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<Uint8Array> {
  const body = res.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (signal.aborted)
          throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError');
        throw new BridgeUnreachableError('bridge media body interrupted', { cause });
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > cap) throw new BridgeMediaTooLargeError('media larger than the cap');
      parts.push(chunk.value);
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined);
    throw e;
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** [W1-02 refinement, justified by TESTS 4.3 seam S-FETCH ("bridge/readClient.ts ... fetch" is injected).
 *  Purely additive: `createBridgeReadClient(ep)` keeps its frozen meaning and uses the global fetch. */
export function createBridgeReadClient(
  ep: () => BridgeEndpoint | null,
  fetchFn: FetchFn = globalThis.fetch,
): BridgeReadClient {
  const request = async (path: string): Promise<Response> => {
    const endpoint = ep();
    if (endpoint === null) throw new BridgeUnreachableError('bridge endpoint unavailable');
    let res: Response;
    try {
      // never 'localhost': Node may resolve it to ::1, which the bridge does not bind (bridge-contract.md section 2).
      res = await fetchFn(`http://127.0.0.1:${endpoint.port}${path}`, {
        headers: { Authorization: `Bearer ${endpoint.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(BRIDGE_READ_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new BridgeUnreachableError('bridge request failed', { cause });
    }
    if (res.status === 401 || res.status === 403) {
      discard(res);
      throw new BridgeAuthError(`bridge answered ${res.status}`);
    }
    return res;
  };

  return {
    async health(): Promise<BridgeHealth> {
      const res = await request('/api/health');
      if (res.status !== 200 && res.status !== 503) {
        discard(res);
        throw new BridgeUnreachableError(`unexpected health status ${res.status}`);
      }
      const wire = healthWireSchema.parse(await res.json());
      return { httpStatus: res.status, connected: wire.connected, timestampS: wire.timestamp };
    },

    async pairingStatus(): Promise<BridgePairingStatusWire> {
      const res = await request('/api/pairing/status');
      if (res.status !== 200) {
        discard(res);
        throw new BridgeUnreachableError(`unexpected pairing status ${res.status}`);
      }
      return pairingWireSchema.parse(await res.json());
    },

    async pairingQrPng(): Promise<Uint8Array | null> {
      const res = await request('/api/pairing/qr.png');
      if (res.status === 404 || res.status === 500) {
        discard(res);
        return null;
      }
      if (res.status !== 200) {
        discard(res);
        throw new BridgeUnreachableError(`unexpected qr status ${res.status}`);
      }
      if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/png')) {
        discard(res);
        return null;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > QR_PNG_MAX_BYTES) return null;
      return bytes;
    },

    // [V2 ADD] GET /api/media (C2 12, B5; V2-W1-07-media-voice). Callable only from src/main/media/fetch.ts.
    async getMedia(
      chatJid: string,
      waMsgId: string,
      opts: { maxBytes: number; signal: AbortSignal },
    ): Promise<BridgeMedia | null> {
      // ids re-checked BEFORE any request (the bridge checks them too - media_serve.go - but a bad id never leaves the app)
      if (!MEDIA_JID_RE.test(chatJid) || !MEDIA_MSG_ID_RE.test(waMsgId))
        throw new BridgeMediaIdError('media id rejected');
      if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes <= 0) throw new RangeError('maxBytes');
      const endpoint = ep();
      if (endpoint === null) throw new BridgeUnreachableError('bridge endpoint unavailable');
      if (opts.signal.aborted)
        throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException('aborted', 'AbortError');
      const query = new URLSearchParams({ jid: chatJid, message_id: waMsgId }).toString();
      // 15 s connect budget (until the response head arrives); the body is then bounded by the byte cap and the caller's signal.
      const connect = new AbortController();
      const connectTimer = setTimeout(
        () => connect.abort(new BridgeUnreachableError('bridge media connect timeout')),
        BRIDGE_READ_TIMEOUT_MS,
      );
      const onCallerAbort = (): void => connect.abort(opts.signal.reason);
      opts.signal.addEventListener('abort', onCallerAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(connectTimer);
        opts.signal.removeEventListener('abort', onCallerAbort);
      };
      let res: Response;
      try {
        res = await fetchFn(`http://127.0.0.1:${endpoint.port}/api/media?${query}`, {
          headers: { Authorization: `Bearer ${endpoint.token}` },
          redirect: 'error',
          signal: connect.signal,
        });
      } catch (cause) {
        cleanup();
        if (opts.signal.aborted)
          throw opts.signal.reason instanceof Error ? opts.signal.reason : new DOMException('aborted', 'AbortError');
        throw new BridgeUnreachableError('bridge media request failed', { cause });
      }
      clearTimeout(connectTimer);
      try {
        if (res.status === 401 || res.status === 403) {
          discard(res);
          throw new BridgeAuthError(`bridge answered ${res.status}`);
        }
        if (res.status === 404) {
          discard(res);
          return null;
        }
        if (res.status !== 200) {
          discard(res);
          throw new BridgeUnreachableError(`unexpected media status ${res.status}`);
        }
        const declared = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          discard(res);
          throw new BridgeMediaTooLargeError('media larger than the cap');
        }
        const bytes = await readCapped(res, opts.maxBytes, connect.signal);
        const contentType = res.headers.get('content-type'); // UNTRUSTED - callers sniff magic bytes
        return { bytes, contentType };
      } finally {
        cleanup();
      }
    },
  };
}
