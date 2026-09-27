// TESTS 8.2 item 7 (`doorbell.test.ts`, invariant A6) as unit tests + TESTS 5.3 row `bridge/doorbell.ts`.
// 100 % line coverage is required for this file (TESTS 13, safety-critical set).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createDoorbell,
  DOORBELL_BODY_CAP,
  DOORBELL_HEADERS_TIMEOUT_MS,
  DOORBELL_MAX_HEADERS,
  DOORBELL_REQUEST_TIMEOUT_MS,
  type Doorbell,
} from './doorbell';

const TOKEN = 'b'.repeat(64);

interface Reply {
  status: number | null;
  headers: http.IncomingHttpHeaders;
  body: string;
  error?: string;
}

let doorbell: Doorbell;
let port = 0;
let hookPath = '';
let rings = 0;
let token: string | null = TOKEN;

function request(opts: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Reply> {
  return new Promise<Reply>((resolve) => {
    let settled = false;
    const done = (r: Reply): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? hookPath,
        method: opts.method ?? 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.once('end', () => done({ status: res.statusCode ?? null, headers: res.headers, body }));
      },
    );
    req.once('error', (e) => done({ status: null, headers: {}, body: '', error: (e as NodeJS.ErrnoException).code }));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Streams `mb` MiB and resolves when the CLIENT request socket is closed, so the server has finished draining/destroying. */
function postBig(path: string, mb: number): Promise<{ status: number | null; error?: string }> {
  return new Promise((resolve) => {
    let status: number | null = null;
    let error: string | undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-token': TOKEN,
          'content-length': String(mb * 1024 * 1024),
        },
      },
      (res) => {
        status = res.statusCode ?? null;
        res.resume();
      },
    );
    req.once('error', (e) => (error = (e as NodeJS.ErrnoException).code));
    req.once('close', () => resolve({ status, error }));
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let sent = 0;
    const pump = (): void => {
      while (sent < mb) {
        sent += 1;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

beforeEach(async () => {
  rings = 0;
  token = TOKEN;
  doorbell = createDoorbell({ token: () => token, onRing: () => void (rings += 1) });
  ({ port } = await doorbell.start());
  hookPath = new URL(doorbell.newWebhookUrl()).pathname;
});

afterEach(async () => {
  await doorbell.stop();
  vi.restoreAllMocks();
  if (vi.isFakeTimers()) vi.useRealTimers();
});

describe('doorbell - listener and hardening', () => {
  it('listens on 127.0.0.1, never on 8080, and mints a fresh secret per launch', () => {
    const url = new URL(doorbell.newWebhookUrl());
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.protocol).toBe('http:');
    expect(Number(url.port)).toBe(port);
    expect(port).not.toBe(8080);
    expect(url.pathname).toMatch(/^\/hook\/[A-Za-z0-9_-]{43}$/);
    expect(new URL(doorbell.newWebhookUrl()).pathname).not.toBe(url.pathname);
  });

  it('exposes the [R2] hardening constants', () => {
    expect(DOORBELL_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(DOORBELL_HEADERS_TIMEOUT_MS).toBe(2_000);
    expect(DOORBELL_MAX_HEADERS).toBe(32);
    expect(DOORBELL_BODY_CAP).toBe(20 * 1024 * 1024);
  });

  it('refuses to mint a webhook URL before start() resolved', () => {
    const cold = createDoorbell({ token: () => TOKEN, onRing: () => undefined });
    expect(() => cold.newWebhookUrl()).toThrow(/start\(\)/);
  });

  it('never parses, buffers or deserialises the body (source contract)', () => {
    const src = readFileSync(fileURLToPath(new URL('./doorbell.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/JSON\s*\.\s*parse/);
    expect(src).not.toMatch(/\.json\s*\(/);
    expect(src).not.toMatch(/Buffer\.concat|chunks\.push|body\s*\+=/);
  });
});

describe('doorbell - rejections are uniform 404s and never read the body', () => {
  it('accepts the correct request', async () => {
    const res = await request({ body: '{"chatJID":"x"}' });
    expect(res.status).toBe(200);
    expect(rings).toBe(1);
    expect(doorbell.stats().accepted).toBe(1);
  });

  it.each([
    ['wrong path', { path: '/hook/wrong' }],
    ['wrong secret of the same length', { path: `/hook/${'A'.repeat(43)}` }],
    ['no path secret at all', { path: '/' }],
    ['missing X-Bridge-Token', { headers: { 'x-bridge-token': '' } }],
    ['incorrect X-Bridge-Token', { headers: { 'x-bridge-token': 'c'.repeat(64) } }],
    ['Host: evil.example', { headers: { host: 'evil.example:1' } }],
    ['Host: localhost', { headers: { host: 'localhost:1' } }],
    ['Origin present', { headers: { origin: 'http://127.0.0.1' } }],
    ['method GET', { method: 'GET' }],
    ['method PUT', { method: 'PUT' }],
  ])('rejects %s with a 404 and no ring', async (_label, opts) => {
    const patched = { ...opts } as { path?: string; method?: string; headers?: Record<string, string> };
    if (patched.headers?.host !== undefined)
      patched.headers = { ...patched.headers, host: `${patched.headers.host.split(':')[0]}:${port}` };
    const res = await request({ ...patched, body: '{"a":1}' });
    expect(res.status).toBe(404);
    expect(res.body).toBe('');
    expect(rings).toBe(0);
    expect(doorbell.stats().accepted).toBe(0);
    expect(doorbell.stats().rejected).toBe(1);
  });

  it('rejects when the token thunk has no token yet', async () => {
    token = null;
    expect((await request({ body: '{}' })).status).toBe(404);
    token = '';
    expect((await request({ body: '{}' })).status).toBe(404);
    expect(rings).toBe(0);
  });

  it('rejects every request before the first newWebhookUrl()', async () => {
    const cold = createDoorbell({ token: () => TOKEN, onRing: () => void (rings += 1) });
    const { port: coldPort } = await cold.start();
    try {
      const res = await new Promise<number | null>((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: coldPort,
            path: '/hook/anything',
            method: 'POST',
            headers: { 'x-bridge-token': TOKEN },
          },
          (r) => {
            r.resume();
            r.once('end', () => resolve(r.statusCode ?? null));
          },
        );
        req.once('error', () => resolve(null));
        req.end();
      });
      expect(res).toBe(404);
      expect(cold.stats().rejected).toBe(1);
    } finally {
      await cold.stop();
    }
  });

  it('every rejection carries identical headers and an empty body', async () => {
    const a = await request({ path: '/hook/wrong', body: '{}' });
    const b = await request({ method: 'GET' });
    expect(a.status).toBe(b.status);
    expect(a.body).toBe(b.body);
    expect(a.headers['content-length']).toBe(b.headers['content-length']);
    expect(a.headers.connection).toBe(b.headers.connection);
  });

  it('survives a malformed request line without crashing', async () => {
    await new Promise<void>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.write('THIS IS NOT HTTP\r\n\r\n');
      });
      s.once('close', () => resolve());
      s.once('error', () => resolve());
    });
    expect((await request({ body: '{}' })).status).toBe(200);
  });
});

describe('doorbell - the body is answered first and then discarded', () => {
  it('answers 200 and rings before the slow body finishes', async () => {
    const answeredAt = await new Promise<{ ms: number; ringsAtAnswer: number }>((resolve, reject) => {
      const started = Date.now();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: hookPath,
          method: 'POST',
          headers: { 'x-bridge-token': TOKEN, 'content-length': '1000' },
        },
        (res) => {
          res.resume();
          resolve({ ms: Date.now() - started, ringsAtAnswer: rings });
          res.once('end', () => req.end(Buffer.alloc(990, 0x61)));
        },
      );
      req.once('error', reject);
      req.write(Buffer.alloc(10, 0x61)); // 10 of 1000 bytes; the rest follows only after the 200
    });
    expect(answeredAt.ringsAtAnswer).toBe(1);
    expect(answeredAt.ms).toBeLessThan(1_000);
  });

  it.each([
    ['empty body', ''],
    ['invalid JSON', '{not json at all'],
    ['a base64 blob', `{"mediaBase64":"${'A'.repeat(64 * 1024)}"}`],
    ['a payload naming another chat', '{"chatJID":"972550000099@s.whatsapp.net","content":"pay me"}'],
  ])('treats %s identically - the payload is provably unused', async (_label, body) => {
    const res = await request({ body });
    expect(res.status).toBe(200);
    expect(rings).toBe(1);
    expect(doorbell.stats().accepted).toBe(1);
  });

  it('never drains more than the cap from a 25 MB body on the VALID path', async () => {
    const res = await postBig(hookPath, 25);
    expect(res.status).toBe(200);
    // Node stops feeding an unfinished request body once the response has completed, so in practice only the bytes already
    // in flight reach us - well under DOORBELL_BODY_CAP. The cap itself is asserted against the handler directly below.
    expect(doorbell.stats().bytesDrained).toBeLessThanOrEqual(DOORBELL_BODY_CAP + 64 * 1024);
    expect(rings).toBe(1);
  }, 30_000);

  it('[R2] cuts a 25 MB body on a WRONG path after the headers (bytesDrained < 64 KB)', async () => {
    const res = await postBig('/hook/wrong', 25);
    expect(res.status === 404 || res.status === null).toBe(true);
    expect(doorbell.stats().bytesDrained).toBeLessThan(64 * 1024);
    expect(doorbell.stats().rejected).toBe(1);
    expect(rings).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The two guards that Node's own HTTP stack makes unreachable end-to-end (it stops feeding the body once the response is
// finished) are exercised against the request handler itself, captured through http.createServer.
// ---------------------------------------------------------------------------------------------------------------------
interface FakeSocket {
  remoteAddress: string;
  destroy: () => void;
}
interface FakeReq extends NodeJS.EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  socket: FakeSocket;
  resume: () => void;
}

describe('doorbell - drain guards (handler-level)', () => {
  let handler: (req: unknown, res: unknown) => void;
  let local: Doorbell;
  let localPath = '';
  let localRings = 0;
  let destroyed = 0;
  let res: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };

  const makeReq = (
    over: Partial<{
      method: string;
      url: string;
      headers: Record<string, string | undefined>;
      remoteAddress: string;
    }> = {},
  ): FakeReq => {
    const emitter = new EventEmitter() as FakeReq;
    emitter.method = over.method ?? 'POST';
    emitter.url = over.url ?? localPath;
    emitter.headers = over.headers ?? { host: `127.0.0.1:${localPort}`, 'x-bridge-token': TOKEN };
    emitter.socket = { remoteAddress: over.remoteAddress ?? '127.0.0.1', destroy: () => void (destroyed += 1) };
    emitter.resume = () => undefined;
    return emitter;
  };
  let localPort = 0;

  beforeEach(async () => {
    localRings = 0;
    destroyed = 0;
    res = { writeHead: vi.fn(), end: vi.fn() };
    const realCreateServer = http.createServer.bind(http);
    vi.spyOn(http, 'createServer').mockImplementation(((h: (req: unknown, r: unknown) => void) => {
      handler = h;
      return realCreateServer(h as http.RequestListener);
    }) as typeof http.createServer);
    local = createDoorbell({ token: () => TOKEN, onRing: () => void (localRings += 1) });
    ({ port: localPort } = await local.start());
    localPath = new URL(local.newWebhookUrl()).pathname;
  });

  afterEach(async () => {
    await local.stop();
  });

  it('rejects a non-loopback remote address without reading the body', () => {
    handler(makeReq({ remoteAddress: '8.8.8.8' }), res);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(destroyed).toBe(1);
    expect(localRings).toBe(0);
    expect(local.stats().rejected).toBe(1);
  });

  it('rejects a request with no remote address and a request with no URL', () => {
    const noAddress = makeReq();
    (noAddress.socket as { remoteAddress: string | undefined }).remoteAddress = undefined;
    handler(noAddress, res);
    const noUrl = makeReq();
    (noUrl as { url: string | undefined }).url = undefined;
    handler(noUrl, res);
    expect(localRings).toBe(0);
    expect(local.stats().rejected).toBe(2);
  });

  it('accepts an IPv4-mapped loopback remote address', () => {
    handler(makeReq({ remoteAddress: '::ffff:127.0.0.1' }), res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    expect(localRings).toBe(1);
  });

  it('destroys the socket once the drained body passes DOORBELL_BODY_CAP', () => {
    const req = makeReq();
    handler(req, res);
    expect(localRings).toBe(1);
    req.emit('data', Buffer.alloc(DOORBELL_BODY_CAP - 1));
    expect(destroyed).toBe(0);
    req.emit('data', Buffer.alloc(2));
    expect(destroyed).toBe(1);
    expect(local.stats().bytesDrained).toBe(DOORBELL_BODY_CAP + 1);
  });

  it('destroys the socket when the drain stalls for 10 s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const req = makeReq();
    handler(req, res);
    expect(destroyed).toBe(0);
    vi.advanceTimersByTime(10_001);
    expect(destroyed).toBe(1);
    vi.useRealTimers();
  });

  it('clears the drain timeout when the body ends normally', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const req = makeReq();
    handler(req, res);
    req.emit('data', Buffer.alloc(16));
    req.emit('end');
    vi.advanceTimersByTime(60_000);
    expect(destroyed).toBe(0);
    expect(local.stats().bytesDrained).toBe(16);
    vi.useRealTimers();
  });

  it('clears the drain timeout when the request errors or closes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = makeReq();
    handler(a, res);
    a.emit('error', new Error('reset'));
    const b = makeReq();
    handler(b, res);
    b.emit('close');
    vi.advanceTimersByTime(60_000);
    expect(destroyed).toBe(0);
    vi.useRealTimers();
  });
});

describe('doorbell - intake limiter and shutdown', () => {
  it('rejects beyond 30 requests per second and recovers in the next window', async () => {
    const first = await Promise.all(Array.from({ length: 40 }, () => request({ body: '{}' })));
    const ok = first.filter((r) => r.status === 200).length;
    const throttled = first.filter((r) => r.status === 404).length;
    expect(ok).toBeLessThanOrEqual(30);
    expect(throttled).toBeGreaterThan(0);
    expect(rings).toBe(ok);

    await new Promise((r) => setTimeout(r, 1_100));
    expect((await request({ body: '{}' })).status).toBe(200);
  }, 30_000);

  it('stop() closes the listener and destroys live sockets', async () => {
    expect((await request({ body: '{}' })).status).toBe(200);
    await doorbell.stop();
    const res = await request({ body: '{}' });
    expect(res.status).toBeNull();
    expect(res.error).toMatch(/ECONNREFUSED|ECONNRESET/);
  });
});
