// src/main/bridge/doorbell.ts   (frozen signatures)
// Frozen signatures pasted verbatim from docs/specs/contracts.md section 12 (owner W1-03).
// SAFETY: this file never reads, buffers, decodes or deserialises a request body. The body is answered, then discarded byte-count-only.
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bridge -> host webhook body, exactly as emitted by webhook.go. DOCUMENTATION + fake-bridge ONLY:
 *  the doorbell NEVER parses the body (ARCHITECTURE 4.5); no production code may reference this type (lint rule in tests/security). */
export interface BridgeWebhookPayload {
  eventType?: 'reaction'; // ONLY for reactions
  sender: string; // USER PART ONLY (phone digits, else LID digits)
  content: string; // text/caption ; emoji for reactions ('' = removed)
  chatJID: string; // full JID
  isFromMe: boolean;
  quotedMessageId?: string;
  quotedSender?: string;
  quotedContent?: string;
  messageId?: string; // ONLY for image messages and reactions ; plain text has NO id and NO timestamp
  mediaType?: 'image' | 'reaction';
  mimeType?: string;
  mediaFilename?: string;
  mediaBase64?: string; // image only, omitted when > 10 MB
  reactionToMessageId?: string;
  reactionEmoji?: string;
  reactionRemoved?: boolean;
}
/** Request contract: POST <WEBHOOK_URL>, Content-Type application/json, header X-Bridge-Token: <token>. No retry; success is status 200 exactly;
 *  synchronous inside the bridge's event handler => answer 200 IMMEDIATELY.
 *  [R2] Server hardening (binding): server.requestTimeout = 5_000, headersTimeout = 2_000, maxHeadersCount = 32.
 *  Reject path (wrong method/path/secret/token, or any exception): `res.writeHead(404); res.end(); req.socket.destroy()` WITHOUT reading the body.
 *  Accept path: `res.writeHead(200); res.end()` FIRST, then `onRing()` synchronously, then `req.resume()` (discard) with a DOORBELL_BODY_CAP
 *  byte cap and a 10 s drain timeout - both destroy the socket; the drain is never awaited before onRing(). */
export const DOORBELL_BODY_CAP = 20 * 1024 * 1024;
export interface DoorbellDeps {
  token: () => string | null;
  onRing: () => void;
} // onRing = ingest.poke()
export interface Doorbell {
  /** Listens on 127.0.0.1:0 exclusive. Returns the URL to put in WEBHOOK_URL: http://127.0.0.1:<port>/hook/<secret>. New secret per bridge launch. */
  start(): Promise<{ port: number }>;
  newWebhookUrl(): string; // fresh 32-byte base64url secret per bridge launch ; returns the full WEBHOOK_URL value
  stop(): Promise<void>;
  stats(): { accepted: number; rejected: number; bytesDrained: number }; // [R2] bytesDrained: tests assert < 64 KB after a 25 MB body on a wrong path
}

// ---------------------------------------------------------------------------------------------------------------------
// hardening constants (ARCHITECTURE 4.5 [R2])
// ---------------------------------------------------------------------------------------------------------------------
export const DOORBELL_REQUEST_TIMEOUT_MS = 5_000;
export const DOORBELL_HEADERS_TIMEOUT_MS = 2_000;
export const DOORBELL_MAX_HEADERS = 32;
const DRAIN_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 1_000;
const RATE_MAX_PER_WINDOW = 30;
const SECRET_BYTES = 32;

/** Constant-time string comparison that does not leak the length either (both sides are hashed first). */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function isLoopbackRemote(address: string | undefined): boolean {
  const a = (address ?? '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function createDoorbell(deps: DoorbellDeps): Doorbell {
  let port = 0;
  let secret: string | null = null;
  let accepted = 0;
  let rejected = 0;
  let bytesDrained = 0;
  const recent: number[] = [];
  const sockets = new Set<Socket>();

  const withinRateLimit = (): boolean => {
    const now = Date.now();
    while (recent.length > 0 && now - (recent[0] as number) > RATE_WINDOW_MS) recent.shift();
    if (recent.length >= RATE_MAX_PER_WINDOW) return false;
    recent.push(now);
    return true;
  };

  /** Uniform rejection: identical status, identical headers, empty body, socket cut - and the body is never read. */
  const reject = (req: IncomingMessage, res: ServerResponse): void => {
    rejected += 1;
    res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
    res.end();
    req.socket.destroy();
  };

  const accept = (req: IncomingMessage, res: ServerResponse): void => {
    // NOTE: no `Connection: close` here - a `close` response makes Node destroySoon() the socket as soon as the
    // response is flushed, which would cut the drain short. The reject path below does want exactly that.
    res.writeHead(200, { 'Content-Length': '0' });
    res.end();
    accepted += 1;
    deps.onRing(); // synchronous; the drain below is never awaited
    let drained = 0;
    const timer = setTimeout(() => req.socket.destroy(), DRAIN_TIMEOUT_MS);
    timer.unref();
    const finish = (): void => clearTimeout(timer);
    req.on('data', (chunk: Buffer) => {
      drained += chunk.length;
      bytesDrained += chunk.length;
      if (drained > DOORBELL_BODY_CAP) {
        finish();
        req.socket.destroy();
      }
    });
    req.once('end', finish);
    req.once('error', finish);
    req.once('close', finish);
    req.resume();
  };

  /**
   * [repair process-lifecycle-8] AUTHENTICATE FIRST, CHARGE THE BUDGET LAST.
   *
   * `withinRateLimit()` used to be the first statement here, so every request spent one of the 30 slots BEFORE the doorbell knew
   * whether it came from our bridge. Any other local process could therefore fill the single global window with traffic that was
   * 404'd a microsecond later, and every genuine `POST /hook/<secret>` inside that second was rejected too. The bridge does not
   * retry a ring (see the header note), so those rings were lost and ingest fell back to the 30 s `LIMITS.scanIntervalMs` timer.
   *
   * The limiter is an INTAKE limiter (ARCH 4.5): its job is to bound `onRing()` -> `ingest.poke()`, which only an authenticated
   * ring may trigger. It never was - and cannot be - a defence against local resource exhaustion, because the TCP accept and the
   * HTTP header parse have already happened by the time this handler runs; `requestTimeout` / `headersTimeout` / `maxHeadersCount`
   * and the immediate `socket.destroy()` on the reject path are what bound that. So the budget belongs on the accept path only.
   *
   * The cheap, allocation-free shape checks stay above the two SHA-256 digests of `constantTimeEquals`, so an unauthenticated
   * flood of the obvious shape (wrong remote, wrong method, an `Origin`, a wrong `Host`) is still turned away before any hashing.
   */
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isLoopbackRemote(req.socket.remoteAddress)) return reject(req, res);
    if (req.method !== 'POST') return reject(req, res);
    if (req.headers.origin !== undefined) return reject(req, res);
    if (req.headers.host !== `127.0.0.1:${port}`) return reject(req, res);
    if (secret === null) return reject(req, res);
    if (!constantTimeEquals(req.url ?? '', `/hook/${secret}`)) return reject(req, res);
    const expected = deps.token();
    const presented = req.headers['x-bridge-token'];
    if (expected === null || expected === '' || typeof presented !== 'string') return reject(req, res);
    if (!constantTimeEquals(presented, expected)) return reject(req, res);
    if (!withinRateLimit()) return reject(req, res);
    return accept(req, res);
  };

  // `http.createServer` (not the named import) so the request handler can be exercised directly in unit tests: Node's HTTP server
  // stops feeding an unfinished request body once the response has completed, which makes the DOORBELL_BODY_CAP branch unreachable
  // end-to-end (see ops/agent-notes/W1-03-bridge-ingest.md).
  const server: Server = http.createServer(handle);
  server.requestTimeout = DOORBELL_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DOORBELL_HEADERS_TIMEOUT_MS;
  server.maxHeadersCount = DOORBELL_MAX_HEADERS;
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  // a malformed request line must not take the process down
  server.on('clientError', (_err, s) => (s as Socket).destroy());

  return {
    start: () =>
      new Promise<{ port: number }>((resolve, rejectStart) => {
        server.once('error', rejectStart);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          server.removeListener('error', rejectStart);
          port = (server.address() as AddressInfo).port;
          resolve({ port });
        });
      }),
    newWebhookUrl: () => {
      if (port === 0) throw new Error('doorbell: start() must resolve before newWebhookUrl()');
      secret = randomBytes(SECRET_BYTES).toString('base64url');
      return `http://127.0.0.1:${port}/hook/${secret}`;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
    stats: () => ({ accepted, rejected, bytesDrained }),
  };
}
