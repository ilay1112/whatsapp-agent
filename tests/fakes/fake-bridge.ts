// tests/fakes/fake-bridge.ts - the only "bridge" any automated test ever sees (TESTS 3.1 + CONTRACTS 16; owner W1-02).
// Spawnable-fake rules (TESTS 2.3): Node built-ins + other tests/fakes files only; never src/**. Erasable TS only (no enums,
// no parameter properties, no namespaces) so `node --experimental-strip-types tests/fakes/fake-bridge.ts` runs in child mode.
// Child mode: node tests/fakes/fake-bridge.ts --control-port <p> --control-secret <s> [--scenario <name>] (reads the five real env vars).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createFakeBridgeDb, type FakeBridgeDb, type FakeTsFormat } from './fake-bridge-db.ts';

export type FakePairingPhase = 'connecting' | 'qr_pending' | 'connected' | 'timeout' | 'error';
export type FakeSendBehaviour = 'ok' | 'not_connected_500' | 'hang' | 'http_500' | 'drop_connection';
export type FakeBridgeScenario =
  | 'default'
  | 'needs_pairing'
  | 'bind_fail'
  | 'foreign_listener'
  | `exit_after_ms:${number}`
  | 'logged_out'
  | 'client_outdated'
  | 'token_banner'
  | `slow_start:${number}`;

export interface FakeBridgeOptions {
  port?: number;
  token: string;
  webhookUrl?: string; // in-process mode; child mode reads env instead
  storeDir: string; // where messages.db is created (= <cwd>/store)
  pairing?: 'connected' | 'qr_pending' | 'connecting'; // initial phase, default 'connected'
  tsFormat?: 'go-sqlite3' | 'rfc3339' | 'epoch_s' | 'epoch_ms' | 'garbage'; // default 'go-sqlite3'
  ansi?: boolean; // colourise stdout like whatsmeow, default true
  scenario?: FakeBridgeScenario;
}
/** Wire shape of GET /api/pairing/status (kept here so this file never imports src/**). */
export interface FakePairingStatusWire {
  status: FakePairingPhase;
  qr_present?: true;
  expires_at?: number;
  message?: string;
}
/** Bridge -> host webhook body exactly as emitted by webhook.go (documentation + this fake only). */
export interface FakeWebhookPayload {
  eventType?: 'reaction';
  sender: string;
  content: string;
  chatJID: string;
  isFromMe: boolean;
  quotedMessageId?: string;
  quotedSender?: string;
  quotedContent?: string;
  messageId?: string;
  mediaType?: 'image' | 'reaction';
  mimeType?: string;
  mediaFilename?: string;
  mediaBase64?: string;
  reactionToMessageId?: string;
  reactionEmoji?: string;
  reactionRemoved?: boolean;
}

/** [V2] T2 3.6: `GET /api/media` scenarios (the route moves from FORBIDDEN_PATHS to a served route with V2-W1-07). */
export const FAKE_MEDIA_SCENARIOS = [
  'missing',
  'http_500_once',
  'http_500',
  'partial',
  'slow',
  'oversize',
  'wrong_bytes',
] as const;
export type FakeMediaScenario = (typeof FAKE_MEDIA_SCENARIOS)[number];
/** [V2] T2 3.6 violation names the media route records (the ledger fails any test that triggers one). */
export const FAKE_MEDIA_VIOLATIONS = ['media_unknown_row', 'media_non_media_row', 'media_retry_storm'] as const;
export interface FakeMediaRequest {
  chatJid: string;
  messageId: string;
  status: number | 'reset';
  at: number;
}

export interface FakeBridge {
  readonly url: string;
  readonly port: number;
  readonly db: FakeBridgeDb;
  // scenario controls (child mode: same verbs over POST http://127.0.0.1:<control-port>/__control/<verb>, header X-Control-Secret)
  inbound(msg: {
    chatJid: string;
    text: string;
    ts?: Date;
    pushName?: string;
    mediaType?: string;
    quotedText?: string;
  }): Promise<{ id: string; rowid: number }>;
  outboundFromPhone(msg: { chatJid: string; text: string; ts?: Date }): Promise<{ id: string }>;
  historySync(rows: Array<{ chatJid: string; text: string; ts: Date; fromMe: boolean }>): Promise<void>;
  reaction(chatJid: string, targetId: string, emoji: string): Promise<void>;
  markDeleted(chatJid: string, id: string): Promise<void>;
  setPairing(phase: FakePairingPhase, message?: string): void;
  setConnected(up: boolean): void;
  setSendBehaviour(b: FakeSendBehaviour): void;
  /** CONTRACTS 16 alias of setSendBehaviour: 'not_connected' | 'error_500' | 'hang' for the NEXT send only. */
  failNextSend(mode: 'not_connected' | 'error_500' | 'hang'): void;
  emitStdout(line: string): void;
  setWebhookEnabled(on: boolean): void;
  wipeStore(): Promise<void>;
  exit(): void;
  /** Security tests: POST a raw (possibly malformed) doorbell; returns the HTTP status. */
  postRawDoorbell(req: {
    path: string;
    headers: Record<string, string>;
    body: string | Uint8Array;
    method?: string;
  }): Promise<number>;
  /** CONTRACTS 16: well-formed doorbell to a webhook URL; returns the HTTP status. */
  ringDoorbell(webhookUrl: string, payload: FakeWebhookPayload): Promise<number>;
  // journal
  readonly requests: Array<{
    at: number;
    method: string;
    path: string;
    authorized: boolean;
    host: string;
    body?: unknown;
  }>;
  readonly sent: Array<{ at: number; recipient: string; message: string; rawBody: Record<string, unknown> }>;
  /** CONTRACTS 16 view of `sent`: extraKeys must always be []. */
  readonly sends: ReadonlyArray<{ recipient: string; message: string; extraKeys: string[] }>;
  /** MUST stay empty (typing/react/download/group; [V2] /api/media is a served route journaled in mediaRequests). */
  readonly otherRequests: ReadonlyArray<{ method: string; path: string }>;
  readonly doorbellProblems: Array<{ at: number; status: number; ms: number }>;
  readonly violations: string[];
  // ---- [V2] T2 3.6 (types frozen in Wave 0; body V2-W1-07-media-voice) ----
  /** Scripts the `/api/media` answer for one message: real bytes, or a failure scenario layered over them (http_500_once then the bytes). Resets that message's retry-storm count. */
  setMedia(chatJid: string, msgId: string, media: Uint8Array | { scenario: FakeMediaScenario }): void;
  /** Journal of every `/api/media` request (ledger rule 10). */
  readonly mediaRequests: FakeMediaRequest[];
  /** Every line the fake "printed". In child mode these also go to the real stdout; in-process they stay here. */
  readonly stdoutLines: string[];
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-02)
// ---------------------------------------------------------------------------------------------------------------------

/** A fixed 8x8 PNG (TESTS 3.1): the QR image never varies, so tests can assert an exact data: URL. */
export const FAKE_QR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADn+P8AAAAAG0lEQVR4nGP4z8DAwMDAxMDAwMDwn4GBgYEBAB8bAgGvXrGDAAAAAElFTkSuQmCC';
const FAKE_QR_PNG = Buffer.from(FAKE_QR_PNG_BASE64, 'base64');

/** Endpoints the product must never call (ARCHITECTURE A16). Reaching one is recorded as a violation. */
const FORBIDDEN_PATHS = [
  '/api/typing',
  '/api/react',
  '/api/download',
  '/api/group/status',
  '/api/group/participant-count',
];
const SEND_RECIPIENT_RE = /^[0-9]{5,20}@s\.whatsapp\.net$/;
/** [V2] media_serve.go allow-lists (the bridge answers 404 "media not found" to anything else - never a format oracle). */
const MEDIA_JID_PATTERN = /^[A-Za-z0-9.-]{1,100}@[a-z.]{1,40}$/;
const MEDIA_ID_PATTERN = /^[A-Za-z0-9]{1,128}$/;
/** [V2] the app's caps (C2 1.2 LIMITS.voiceMaxBytes / imageMaxBytes); 'oversize' serves cap + 1 bytes for the row's media type. */
export const FAKE_MEDIA_CAPS = { audio: 64 * 1024 * 1024, image: 10 * 1024 * 1024 } as const;
/** [V2] more than this many requests for one message since its last setMedia() = media_retry_storm (T2 3.6, ledger rule 10). */
export const FAKE_MEDIA_MAX_REQUESTS = 2;
const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0,
  0, 2, 2, 0x44, 1, 0, 0x3b,
]);
function mediaMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  return 'application/octet-stream';
}
const QR_ROTATE_MS = 20_000;
/** The privacy bait line the redaction tests look for: it must never reach a log file. */
export const SENTINEL_MSG_TEXT = 'SENTINEL_MSG_TEXT coffee Thursday at 5?';

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function plainText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${body}\n`);
}
function jsonBody(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req: IncomingMessage, cap = 4 * 1024 * 1024): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= cap) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

let msgCounter = 0;
function nextMessageId(): string {
  msgCounter += 1;
  return `3EB0FAKE${String(msgCounter).padStart(6, '0')}`;
}

/** In-process mode. */
export async function startFakeBridge(opts: FakeBridgeOptions): Promise<FakeBridge> {
  const scenario: FakeBridgeScenario = opts.scenario ?? 'default';
  const ansi = opts.ansi ?? true;
  const requests: FakeBridge['requests'] = [];
  const sent: FakeBridge['sent'] = [];
  const sends: Array<{ recipient: string; message: string; extraKeys: string[] }> = [];
  const otherRequests: Array<{ method: string; path: string }> = [];
  const doorbellProblems: FakeBridge['doorbellProblems'] = [];
  const violations: string[] = [];
  // [V2] GET /api/media state (T2 3.6)
  const mediaRequests: FakeMediaRequest[] = [];
  const mediaBytes = new Map<string, Uint8Array>();
  const mediaScenario = new Map<string, FakeMediaScenario>();
  const mediaCount = new Map<string, number>();
  const mediaKey = (chatJid: string, msgId: string): string => `${chatJid}|${msgId}`;

  mkdirSync(opts.storeDir, { recursive: true });
  let db: FakeBridgeDb = createFakeBridgeDb({
    path: join(opts.storeDir, 'messages.db'),
    tsFormat: (opts.tsFormat ?? 'go-sqlite3') as FakeTsFormat,
  });

  let phase: FakePairingPhase = opts.pairing ?? 'connected';
  let phaseMessage = '';
  let qrRotatedAt = Date.now();
  let connected = phase === 'connected';
  let sendBehaviour: FakeSendBehaviour = 'ok';
  let nextSendOverride: FakeSendBehaviour | null = null;
  let webhookEnabled = true;
  const webhookUrl = opts.webhookUrl;
  let stopped = false;

  if (scenario === 'needs_pairing') {
    phase = 'qr_pending';
    connected = false;
  } else if (scenario === 'logged_out') {
    phase = 'error';
    phaseMessage = 'Device was logged out -- restart the bridge to pair again';
    connected = false;
  }

  const stdoutLines: string[] = [];
  const emitStdout = (line: string): void => {
    const text = ansi ? `[32m${line}[0m` : line;
    stdoutLines.push(text);
    if (isChildMode) process.stdout.write(`${text}\n`);
  };

  const authorize = (req: IncomingMessage, res: ServerResponse, port: number): boolean => {
    const host = (req.headers.host ?? '').toLowerCase();
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowed.includes(host)) {
      plainText(res, 403, 'Forbidden: host not allowed');
      return false;
    }
    const auth = req.headers.authorization ?? '';
    const ok =
      scenario === 'foreign_listener'
        ? false
        : auth.startsWith('Bearer ') && constantTimeEquals(auth.slice('Bearer '.length).trim(), opts.token);
    if (!ok) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="whatsapp-bridge"');
      plainText(res, 401, 'Unauthorized');
      return false;
    }
    return true;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const port = (server.address() as { port: number } | null)?.port ?? 0;
    const host = (req.headers.host ?? '').toLowerCase();
    const authorized = authorize(req, res, port);
    requests.push({ at: Date.now(), method: req.method ?? 'GET', path, authorized, host });
    if (!authorized) return;

    if (FORBIDDEN_PATHS.includes(path)) {
      otherRequests.push({ method: req.method ?? 'GET', path });
      violations.push(`forbidden_endpoint:${path}`);
      jsonBody(res, 200, { success: true, message: 'ok' });
      return;
    }

    if (path === '/api/health') {
      const body = connected
        ? { status: 'ok', connected: true, timestamp: Math.floor(Date.now() / 1000) }
        : { status: 'disconnected', connected: false, timestamp: Math.floor(Date.now() / 1000) };
      jsonBody(res, connected ? 200 : 503, body);
      return;
    }

    if (path === '/api/pairing/status') {
      const wire: FakePairingStatusWire = { status: phase };
      if (phase === 'qr_pending') {
        const now = Date.now();
        while (now - qrRotatedAt > QR_ROTATE_MS) qrRotatedAt += QR_ROTATE_MS;
        wire.qr_present = true;
        wire.expires_at = Math.floor((qrRotatedAt + QR_ROTATE_MS) / 1000);
      }
      if (phaseMessage !== '') wire.message = phaseMessage;
      jsonBody(res, 200, wire);
      return;
    }

    if (path === '/api/pairing/qr.png') {
      if (phase !== 'qr_pending') {
        plainText(res, 404, 'no QR code available');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(FAKE_QR_PNG);
      return;
    }

    if (path === '/api/media') {
      handleMedia(req, res, url);
      return;
    }

    if (path === '/api/send') {
      if (req.method !== 'POST') {
        plainText(res, 405, 'Method not allowed');
        return;
      }
      void handleSend(req, res);
      return;
    }

    plainText(res, 404, '404 page not found');
  });

  /** [V2] media_serve.go: GET only; both ids checked against the allow-lists (404 otherwise); the row must exist in messages.db. */
  function handleMedia(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const jid = url.searchParams.get('jid') ?? '';
    const messageId = url.searchParams.get('message_id') ?? '';
    const entry: FakeMediaRequest = { chatJid: jid, messageId, status: 404, at: Date.now() };
    mediaRequests.push(entry);
    const finish = (status: number | 'reset'): void => {
      entry.status = status;
    };
    if (req.method !== 'GET') {
      finish(405);
      plainText(res, 405, 'Method not allowed');
      return;
    }
    if (!MEDIA_JID_PATTERN.test(jid) || !MEDIA_ID_PATTERN.test(messageId)) {
      finish(404);
      plainText(res, 404, 'media not found');
      return;
    }
    let rowType: string | null;
    try {
      const ro = new DatabaseSync(join(opts.storeDir, 'messages.db'), { readOnly: true });
      try {
        const row = ro.prepare('SELECT media_type FROM messages WHERE id = ? AND chat_jid = ?').get(messageId, jid) as
          { media_type: string | null } | undefined;
        rowType = row === undefined ? null : (row.media_type ?? '');
      } finally {
        ro.close();
      }
    } catch {
      rowType = null;
    }
    if (rowType === null) {
      violations.push('media_unknown_row');
      finish(404);
      plainText(res, 404, 'media not found');
      return;
    }
    if (rowType !== 'audio' && rowType !== 'image') {
      violations.push('media_non_media_row');
      finish(404);
      plainText(res, 404, 'media not found');
      return;
    }
    const key = mediaKey(jid, messageId);
    const count = (mediaCount.get(key) ?? 0) + 1;
    mediaCount.set(key, count);
    if (count > FAKE_MEDIA_MAX_REQUESTS) violations.push('media_retry_storm');

    const scenario = mediaScenario.get(key);
    const bytes = mediaBytes.get(key);
    if (scenario === 'http_500_once') mediaScenario.delete(key); // the next request is served normally
    if (scenario === 'missing' || (scenario === undefined && bytes === undefined)) {
      finish(404);
      plainText(res, 404, 'media not found');
      return;
    }
    if (scenario === 'http_500' || scenario === 'http_500_once') {
      finish(500);
      plainText(res, 500, 'media download failed');
      return;
    }
    if (scenario === 'wrong_bytes') {
      finish(200);
      res.writeHead(200, {
        'Content-Type': rowType === 'audio' ? 'audio/ogg' : 'image/jpeg',
        'Content-Length': GIF_BYTES.length,
      });
      res.end(Buffer.from(GIF_BYTES));
      return;
    }
    if (scenario === 'oversize') {
      // chunked (no Content-Length): the client must enforce the cap while streaming and abort at cap + 1
      finish(200);
      const total = FAKE_MEDIA_CAPS[rowType] + 1;
      res.writeHead(200, { 'Content-Type': rowType === 'audio' ? 'audio/ogg' : 'image/jpeg' });
      const chunk = Buffer.alloc(256 * 1024);
      chunk.set([0x4f, 0x67, 0x67, 0x53]);
      let sentBytes = 0;
      const pump = (): void => {
        while (sentBytes < total && !res.destroyed) {
          const n = Math.min(chunk.length, total - sentBytes);
          sentBytes += n;
          if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
            res.once('drain', pump);
            return;
          }
        }
        if (!res.destroyed) res.end();
      };
      res.on('error', () => undefined);
      pump();
      return;
    }
    const body = Buffer.from(bytes ?? new Uint8Array(1024).fill(0x4f));
    const mime = mediaMime(body);
    if (scenario === 'partial') {
      finish('reset');
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length });
      res.write(body.subarray(0, Math.floor(body.length / 2)), () => {
        setTimeout(() => res.socket?.destroy(), 20);
      });
      return;
    }
    if (scenario === 'slow') {
      finish(200);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length });
      const parts = 16;
      const step = Math.ceil(body.length / parts);
      let i = 0;
      const timer = setInterval(() => {
        if (res.destroyed || i * step >= body.length) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        res.write(body.subarray(i * step, (i + 1) * step));
        i += 1;
      }, 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    finish(200);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(body);
  }

  async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      plainText(res, 400, 'Invalid request format');
      return;
    }
    const recipient = typeof body.recipient === 'string' ? body.recipient : '';
    const message = typeof body.message === 'string' ? body.message : '';
    const extraKeys = Object.keys(body).filter((k) => k !== 'recipient' && k !== 'message');
    if (extraKeys.length > 0 || !SEND_RECIPIENT_RE.test(recipient)) violations.push('send_body_shape');
    if (recipient === '') {
      plainText(res, 400, 'Recipient is required');
      return;
    }
    if (message === '') {
      plainText(res, 400, 'Message or media path is required');
      return;
    }

    const behaviour = nextSendOverride ?? sendBehaviour;
    nextSendOverride = null;
    if (behaviour === 'hang') return; // never answers: exercises the 60 s send timeout
    if (behaviour === 'drop_connection') {
      req.socket.destroy();
      return;
    }
    if (behaviour === 'not_connected_500') {
      jsonBody(res, 500, { success: false, message: 'Not connected to WhatsApp' });
      return;
    }
    if (behaviour === 'http_500') {
      jsonBody(res, 500, { success: false, message: 'Error sending message: transient' });
      return;
    }

    const id = nextMessageId();
    db.addMessage({ id, chatJid: recipient, sender: '972500000000', content: message, fromMe: true });
    sent.push({ at: Date.now(), recipient, message, rawBody: body });
    sends.push({ recipient, message, extraKeys });
    // The real bridge emits NO webhook for API-sent messages and returns no message id.
    jsonBody(res, 200, { success: true, message: `Message sent to ${recipient}` });
  }

  async function postWebhook(payload: FakeWebhookPayload): Promise<void> {
    if (!webhookEnabled || webhookUrl === undefined || webhookUrl === '') return;
    const started = Date.now();
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': opts.token },
        body: JSON.stringify(payload),
        redirect: 'manual',
      });
      const ms = Date.now() - started;
      void res.body?.cancel().catch(() => undefined);
      if (res.status !== 200 || ms > 1000) doorbellProblems.push({ at: started, status: res.status, ms });
    } catch {
      doorbellProblems.push({ at: started, status: 0, ms: Date.now() - started });
    }
  }

  const listening = await new Promise<number>((resolveListen, rejectListen) => {
    if (scenario === 'bind_fail') {
      emitStdout('REST API server error: listen tcp 127.0.0.1: bind: address already in use');
      resolveListen(0);
      return;
    }
    server.once('error', rejectListen);
    server.listen({ host: '127.0.0.1', port: opts.port ?? 0, exclusive: true }, () => {
      resolveListen((server.address() as { port: number }).port);
    });
  });

  const fake: FakeBridge = {
    url: `http://127.0.0.1:${listening}`,
    port: listening,
    db,
    requests,
    sent,
    sends,
    otherRequests,
    doorbellProblems,
    violations,
    setMedia(chatJid: string, msgId: string, media: Uint8Array | { scenario: FakeMediaScenario }): void {
      const key = mediaKey(chatJid, msgId);
      if (media instanceof Uint8Array) {
        mediaBytes.set(key, media.slice());
        mediaScenario.delete(key);
      } else {
        if (!(FAKE_MEDIA_SCENARIOS as readonly string[]).includes(media.scenario))
          throw new Error(`unknown media scenario ${String(media.scenario)}`);
        mediaScenario.set(key, media.scenario);
      }
      mediaCount.delete(key); // a (re)scripted message starts a new triage window for media_retry_storm
    },
    mediaRequests,
    stdoutLines,

    async inbound(msg): Promise<{ id: string; rowid: number }> {
      const id = nextMessageId();
      const senderUser = msg.chatJid.split('@')[0] ?? '972500000001';
      db.addChat(msg.chatJid, msg.pushName ?? null);
      const rowid = db.addMessage({
        id,
        chatJid: msg.chatJid,
        sender: senderUser,
        content: msg.text,
        fromMe: false,
        mediaType: msg.mediaType ?? '',
        timestamp: msg.ts === undefined ? undefined : db.formatTs(msg.ts),
      });
      emitStdout(
        `[${new Date(msg.ts ?? Date.now()).toISOString().slice(0, 19).replace('T', ' ')}] <- ${senderUser}: ${msg.text}`,
      );
      emitStdout(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] <- ${senderUser}: ${SENTINEL_MSG_TEXT}`);
      await postWebhook({
        sender: senderUser,
        content: msg.text,
        chatJID: msg.chatJid,
        isFromMe: false,
        ...(msg.quotedText === undefined ? {} : { quotedContent: msg.quotedText }),
      });
      return { id, rowid };
    },

    async outboundFromPhone(msg): Promise<{ id: string }> {
      const id = nextMessageId();
      db.addChat(msg.chatJid, null);
      db.addMessage({
        id,
        chatJid: msg.chatJid,
        sender: '972500000000',
        content: msg.text,
        fromMe: true,
        timestamp: msg.ts === undefined ? undefined : db.formatTs(msg.ts),
      });
      await postWebhook({ sender: '972500000000', content: msg.text, chatJID: msg.chatJid, isFromMe: true });
      return { id };
    },

    async historySync(rows): Promise<void> {
      for (const row of rows) {
        db.addChat(row.chatJid, null);
        db.addMessage({
          id: nextMessageId(),
          chatJid: row.chatJid,
          sender: row.fromMe ? '972500000000' : (row.chatJid.split('@')[0] ?? '972500000001'),
          content: row.text,
          fromMe: row.fromMe,
          timestamp: db.formatTs(row.ts),
        });
      }
      emitStdout(`History sync complete. Stored ${rows.length} messages.`);
      await Promise.resolve(); // rows arrive WITHOUT webhooks, exactly like the real history sync
    },

    async reaction(chatJid, targetId, emoji): Promise<void> {
      const id = nextMessageId();
      db.addMessage({
        id,
        chatJid,
        sender: '972500000000',
        content: emoji,
        fromMe: true,
        mediaType: 'reaction',
        filename: targetId,
      });
      await postWebhook({
        eventType: 'reaction',
        sender: '972500000000',
        content: emoji,
        chatJID: chatJid,
        isFromMe: true,
        mediaType: 'reaction',
        messageId: id,
        reactionToMessageId: targetId,
        reactionEmoji: emoji,
        reactionRemoved: emoji === '',
      });
    },

    async markDeleted(chatJid, id): Promise<void> {
      db.markDeleted(chatJid, id);
      await Promise.resolve();
    },

    setPairing(next, message): void {
      phase = next;
      phaseMessage = message ?? (next === 'timeout' ? 'QR code expired without being scanned' : '');
      if (next === 'qr_pending') {
        qrRotatedAt = Date.now();
        emitStdout('Scan this QR code with your WhatsApp app:');
      }
      if (next === 'connected') {
        connected = true;
        emitStdout("✓ Connected to WhatsApp! Type 'help' for commands.");
      }
    },

    setConnected(up): void {
      connected = up;
    },
    setSendBehaviour(b): void {
      sendBehaviour = b;
    },
    failNextSend(mode): void {
      nextSendOverride = mode === 'not_connected' ? 'not_connected_500' : mode === 'error_500' ? 'http_500' : 'hang';
    },
    emitStdout,
    setWebhookEnabled(on): void {
      webhookEnabled = on;
    },

    async wipeStore(): Promise<void> {
      db.close();
      rmSync(join(opts.storeDir, 'messages.db'), { force: true });
      db = createFakeBridgeDb({
        path: join(opts.storeDir, 'messages.db'),
        tsFormat: (opts.tsFormat ?? 'go-sqlite3') as FakeTsFormat,
      });
      (fake as { db: FakeBridgeDb }).db = db;
      await Promise.resolve();
    },

    exit(): void {
      // child mode: the real bridge always exits with code 0 (bridge-contract.md section 8).
      if (isChildMode) process.exit(0);
    },

    async postRawDoorbell(reqInit): Promise<number> {
      if (webhookUrl === undefined) return 0;
      const base = new URL(webhookUrl);
      const target = new URL(reqInit.path, `${base.protocol}//${base.host}`);
      try {
        const res = await fetch(target, {
          method: reqInit.method ?? 'POST',
          headers: reqInit.headers,
          body: typeof reqInit.body === 'string' ? reqInit.body : Buffer.from(reqInit.body),
          redirect: 'manual',
        });
        void res.body?.cancel().catch(() => undefined);
        return res.status;
      } catch {
        return 0;
      }
    },

    async ringDoorbell(target, payload): Promise<number> {
      try {
        const res = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': opts.token },
          body: JSON.stringify(payload),
          redirect: 'manual',
        });
        void res.body?.cancel().catch(() => undefined);
        return res.status;
      } catch {
        return 0;
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      db.close();
      await new Promise<void>((done) => {
        if (!server.listening) {
          done();
          return;
        }
        server.closeAllConnections();
        server.close(() => done());
      });
      unregister?.();
    },
  };

  // T7 leak guard (TESTS 5.1): register in vitest, silently skip in child mode where `vitest` cannot be imported.
  let unregister: (() => void) | undefined;
  try {
    const guards = (await import('../setup-guards.ts')) as {
      registerFake?: (f: { name: string; stop(): Promise<void> | void; violations?: string[] }) => () => void;
    };
    unregister = guards.registerFake?.({ name: 'fake-bridge', stop: () => fake.stop(), violations });
  } catch {
    unregister = undefined;
  }

  if (scenario === 'token_banner') emitStdout('WHATSAPP BRIDGE AUTH TOKEN - first-time setup');
  if (scenario === 'client_outdated') emitStdout('❌ Client outdated - please update whatsmeow library');
  emitStdout(`Starting REST API server on 127.0.0.1:${listening}...`);
  if (phase === 'qr_pending') emitStdout('Scan this QR code with your WhatsApp app:');
  if (phase === 'connected') emitStdout("✓ Connected to WhatsApp! Type 'help' for commands.");

  return fake;
}

export const FakeBridge = { start: startFakeBridge };

// ---------------------------------------------------------------------------------------------------------------------
// child mode
// ---------------------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const isChildMode = /fake-bridge\.ts$/.test(process.argv[1] ?? '') && argv.includes('--control-port');

function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** JSON carries no Date: a control-verb timestamp arrives as an ISO string (or an epoch number), never as a Date. */
export function reviveDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  throw new Error(`fake-bridge control: not a timestamp: ${JSON.stringify(raw)}`);
}

/** The control-verb payload with its optional `ts` revived (absent `ts` stays absent: the fake then picks its own now). */
function withRevivedTs(args: Record<string, unknown>): Record<string, unknown> {
  return args.ts === undefined ? args : { ...args, ts: reviveDate(args.ts) };
}

async function runChildMode(): Promise<void> {
  const controlPort = Number(argValue('--control-port') ?? 0);
  const controlSecret = argValue('--control-secret') ?? '';
  const scenario = (argValue('--scenario') ?? 'default') as FakeBridgeScenario;
  const port = Number(process.env.WHATSAPP_BRIDGE_PORT ?? 0);
  const token = process.env.WHATSAPP_BRIDGE_TOKEN ?? '';
  const webhook = process.env.WEBHOOK_URL;
  const storeDir = join(process.cwd(), 'store'); // cwd-relative, exactly like the real exe

  const slow = /^slow_start:(\d+)$/.exec(scenario);
  if (slow) await new Promise<void>((r) => setTimeout(r, Number(slow[1] ?? '0')));

  const fake = await startFakeBridge({ port, token, webhookUrl: webhook, storeDir, scenario, ansi: true });

  const exitAfter = /^exit_after_ms:(\d+)$/.exec(scenario);
  if (exitAfter) {
    setTimeout(
      () => {
        void fake.stop().then(() => process.exit(0));
      },
      Number(exitAfter[1] ?? '0'),
    ).unref();
  }

  const control = createServer((req, res) => {
    const secret = req.headers['x-control-secret'];
    if (typeof secret !== 'string' || !constantTimeEquals(secret, controlSecret)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const verb = (req.url ?? '').replace('/__control/', '').split('?')[0] ?? '';
    void readBody(req)
      .then(async (raw) => {
        const args = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
        let result: unknown = null;
        switch (verb) {
          // `ts` is optional on both verbs; when present it crossed the control server as JSON and must be revived
          // before `db.formatTs()` sees it (a string there is `date.getTime is not a function`, i.e. a 500).
          case 'inbound':
            result = await fake.inbound(withRevivedTs(args) as unknown as Parameters<FakeBridge['inbound']>[0]);
            break;
          case 'outboundFromPhone':
            result = await fake.outboundFromPhone(
              withRevivedTs(args) as unknown as Parameters<FakeBridge['outboundFromPhone']>[0],
            );
            break;
          // A history-sync burst: rows land in messages.db with NO webhook, exactly like the real sync. `ts` crosses the
          // control server as a JSON string, so every row is revived into a real Date before the fake formats it.
          case 'historySync':
            await fake.historySync(
              (Array.isArray(args.rows) ? args.rows : []).map((raw) => {
                const row = raw as { chatJid?: unknown; text?: unknown; ts?: unknown; fromMe?: unknown };
                return {
                  chatJid: String(row.chatJid ?? ''),
                  text: String(row.text ?? ''),
                  ts: reviveDate(row.ts),
                  fromMe: row.fromMe === true,
                };
              }),
            );
            break;
          case 'setPairing':
            fake.setPairing(args.phase as FakePairingPhase, args.message as string | undefined);
            break;
          case 'setMedia':
            fake.setMedia(
              String(args.chatJid ?? ''),
              String(args.msgId ?? ''),
              typeof args.base64 === 'string'
                ? new Uint8Array(Buffer.from(args.base64, 'base64'))
                : { scenario: args.scenario as FakeMediaScenario },
            );
            break;
          case 'setConnected':
            fake.setConnected(Boolean(args.up));
            break;
          case 'setSendBehaviour':
            fake.setSendBehaviour(args.behaviour as FakeSendBehaviour);
            break;
          case 'emitStdout':
            fake.emitStdout(String(args.line ?? ''));
            break;
          case 'setWebhookEnabled':
            fake.setWebhookEnabled(Boolean(args.on));
            break;
          case 'wipeStore':
            await fake.wipeStore();
            break;
          case 'exit':
            res.writeHead(200);
            res.end('{}');
            await fake.stop();
            process.exit(0);
            return;
          default:
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result ?? {}));
      })
      .catch((err: unknown) => {
        // A malformed control payload must fail the CALLING spec, not hang it (and not kill the child with an
        // unhandled rejection): answer 500 with the reason, which `control()` turns into a thrown Error.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
  });
  control.listen({ host: '127.0.0.1', port: controlPort, exclusive: true });
}

if (isChildMode) void runChildMode();
