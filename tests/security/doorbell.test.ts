// tests/security/doorbell.test.ts - gate item 7 of TESTS 8.2 (assumption A6). Owner: W2-02.
//
// Drives the REAL `createDoorbell()` over a REAL loopback socket. Every request is written by hand so the test can send
// a wrong path, a wrong secret, a hostile Host header or a 25 MB body that the server must never read.
import { connect, type Socket } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DOORBELL_BODY_CAP,
  DOORBELL_HEADERS_TIMEOUT_MS,
  DOORBELL_MAX_HEADERS,
  DOORBELL_REQUEST_TIMEOUT_MS,
  createDoorbell,
  type Doorbell,
} from '../../src/main/bridge/doorbell.ts';

const DOORBELL_SRC = readFileSync(fileURLToPath(new URL('../../src/main/bridge/doorbell.ts', import.meta.url)), 'utf8');

const TOKEN = 'b'.repeat(64);

let doorbell: Doorbell | null = null;
let port = 0;
let secret = '';
let rings: number[] = [];
const openSockets = new Set<Socket>();

beforeEach(async () => {
  rings = [];
  doorbell = createDoorbell({
    token: () => TOKEN,
    onRing: () => {
      rings.push(Date.now());
    },
  });
  ({ port } = await doorbell.start());
  const url = doorbell.newWebhookUrl();
  secret = new URL(url).pathname.slice('/hook/'.length);
});

afterEach(async () => {
  for (const s of openSockets) s.destroy();
  openSockets.clear();
  await doorbell?.stop();
  doorbell = null;
});

// ---------------------------------------------------------------------------------------------------------------------
// raw client helpers
// ---------------------------------------------------------------------------------------------------------------------
interface RawResponse {
  status: number | null;
  head: string;
  destroyed: boolean;
  ms: number;
}

/** Sends one hand-written request and resolves as soon as the status line is in (or the socket is cut). */
function raw(opts: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  /** Body written in one go after the headers. */
  body?: Buffer | string;
  /** Declared Content-Length; defaults to the real body length. */
  contentLength?: number;
  /** Wait for the socket to close before resolving (drain / cut-off assertions). */
  untilClose?: boolean;
  /** Send the body only AFTER the response head arrived - proves the server answered without reading it. */
  bodyAfterResponse?: boolean;
}): Promise<RawResponse> {
  const started = Date.now();
  return new Promise<RawResponse>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    openSockets.add(socket);
    let head = '';
    let status: number | null = null;
    let settled = false;
    const done = (destroyed: boolean): void => {
      if (settled) return;
      settled = true;
      openSockets.delete(socket);
      socket.destroy();
      resolve({ status, head, destroyed, ms: Date.now() - started });
    };
    let sendBody: (() => void) | null = null;
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(head);
      if (m !== null) {
        status = Number(m[1]);
        if (sendBody !== null) {
          const send = sendBody;
          sendBody = null;
          send();
        }
        if (!opts.untilClose) done(false);
      }
    });
    socket.once('close', () => done(true));
    socket.once('error', () => done(true));
    socket.once('connect', () => {
      const body = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : (opts.body ?? Buffer.alloc(0));
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'X-Bridge-Token': TOKEN,
        'Content-Length': String(opts.contentLength ?? body.length),
        ...opts.headers,
      };
      const lines = [
        `${opts.method ?? 'POST'} ${opts.path ?? `/hook/${secret}`} HTTP/1.1`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
      const writeBody = (): void => {
        if (body.length === 0 || socket.destroyed) return;
        socket.write(body, () => undefined);
      };
      if (opts.bodyAfterResponse) sendBody = writeBody;
      else writeBody();
    });
  });
}

/** Sends headers plus only the first slice of a much larger declared body, then keeps the socket open. */
function slowBody(opts: { path?: string; firstChunk: Buffer; declaredLength: number }): Promise<{
  status: number | null;
  ms: number;
  socket: Socket;
}> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    openSockets.add(socket);
    let head = '';
    let settled = false;
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ status, ms: Date.now() - started, socket });
    };
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(head);
      if (m !== null) finish(Number(m[1]));
    });
    socket.once('close', () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('connect', () => {
      socket.write(
        [
          `POST ${opts.path ?? `/hook/${secret}`} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Content-Type: application/json',
          `X-Bridge-Token: ${TOKEN}`,
          `Content-Length: ${opts.declaredLength}`,
          '',
          '',
        ].join('\r\n'),
      );
      socket.write(opts.firstChunk);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. binding + hardening constants
// ---------------------------------------------------------------------------------------------------------------------
describe('A6 - the doorbell listens on loopback only', () => {
  it('advertises 127.0.0.1 and a fresh base64url secret per launch', () => {
    const url = new URL(`http://127.0.0.1:${port}/hook/${secret}`);
    expect(url.hostname).toBe('127.0.0.1');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    const second = new URL(doorbell!.newWebhookUrl());
    expect(second.hostname).toBe('127.0.0.1');
    expect(second.port).toBe(String(port));
    expect(second.pathname.slice('/hook/'.length)).not.toBe(secret);
  });

  it('[R2] pins requestTimeout / headersTimeout / maxHeadersCount', () => {
    expect(DOORBELL_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(DOORBELL_HEADERS_TIMEOUT_MS).toBe(2_000);
    expect(DOORBELL_MAX_HEADERS).toBe(32);
    expect(DOORBELL_BODY_CAP).toBe(20 * 1024 * 1024);
    // The values really are applied to the server object (source-level, because `server` is private).
    expect(DOORBELL_SRC).toMatch(/server\.requestTimeout = DOORBELL_REQUEST_TIMEOUT_MS/);
    expect(DOORBELL_SRC).toMatch(/server\.headersTimeout = DOORBELL_HEADERS_TIMEOUT_MS/);
    expect(DOORBELL_SRC).toMatch(/server\.maxHeadersCount = DOORBELL_MAX_HEADERS/);
  });

  it('binds with host 127.0.0.1 and exclusive:true', () => {
    expect(DOORBELL_SRC).toMatch(/server\.listen\(\{\s*host:\s*'127\.0\.0\.1',\s*port:\s*0,\s*exclusive:\s*true/);
  });

  it('refuses a connection from a non-loopback peer', () => {
    // Unreachable from outside: the listener is bound to 127.0.0.1, so every accepted socket already has a loopback
    // remote address. The guard is asserted at source level; its behavioural unit test is W1-03's colocated one.
    expect(DOORBELL_SRC).toMatch(/if \(!isLoopbackRemote\(req\.socket\.remoteAddress\)\) return reject/);
    expect(DOORBELL_SRC).toMatch(/\^127\\\.\\d\{1,3\}/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. the uniform 404 table
// ---------------------------------------------------------------------------------------------------------------------
describe('A6 - every non-doorbell request gets the same uniform 404', () => {
  const wrongSecretSameLength = (s: string): string => `${'A'.repeat(s.length - 1)}${s.endsWith('A') ? 'B' : 'A'}`;

  it('rejects the whole table with an identical response', async () => {
    const before = doorbell!.stats();
    const responses: Array<[string, RawResponse]> = [];
    const cases: Array<[string, Parameters<typeof raw>[0]]> = [
      ['wrong path', { path: '/hook/nope' }],
      ['root path', { path: '/' }],
      ['path prefix', { path: `/hook/${secret}/extra` }],
      ['path with query', { path: `/hook/${secret}?x=1` }],
      ['wrong secret, same length', { path: `/hook/${wrongSecretSameLength(secret)}` }],
      ['missing X-Bridge-Token', { headers: { 'X-Bridge-Token': '' } }],
      ['wrong X-Bridge-Token', { headers: { 'X-Bridge-Token': 'c'.repeat(64) } }],
      ['token with right prefix', { headers: { 'X-Bridge-Token': `${TOKEN.slice(0, 63)}x` } }],
      ['Host: evil.example', { headers: { Host: `evil.example:${port}` } }],
      ['Host: localhost', { headers: { Host: `localhost:${port}` } }],
      ['Host without port', { headers: { Host: '127.0.0.1' } }],
      ['Origin present', { headers: { Origin: 'https://evil.example' } }],
      ['GET', { method: 'GET' }],
      ['PUT', { method: 'PUT' }],
      ['DELETE', { method: 'DELETE' }],
      ['OPTIONS', { method: 'OPTIONS' }],
    ];
    for (const [label, req] of cases) {
      const res = await raw(req);
      responses.push([label, res]);
      expect(res.status, label).toBe(404);
      expect(rings, `${label} must not ring the doorbell`).toEqual([]);
    }
    // Byte-identical head on every rejection: an attacker learns nothing from the difference.
    const heads = new Set(responses.map(([, r]) => r.head.split('\r\n\r\n')[0]!.replace(/^Date:.*$/gm, '')));
    expect(heads.size, `rejections differ: ${[...heads].join(' | ')}`).toBe(1);
    const stats = doorbell!.stats();
    expect(stats.accepted).toBe(before.accepted);
    expect(stats.rejected).toBe(before.rejected + cases.length);
    expect(stats.bytesDrained).toBe(0);
  });

  it('accepts the legitimate doorbell', async () => {
    const res = await raw({ body: '{}' });
    expect(res.status).toBe(200);
    expect(rings).toHaveLength(1);
    expect(doorbell!.stats().accepted).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. answered before the body finishes
// ---------------------------------------------------------------------------------------------------------------------
describe('A6 - the ring is answered before the body is drained', () => {
  it('answers 200 in well under 100 ms with only a fraction of the body sent, and pokes ingest first', async () => {
    const first = Buffer.alloc(1024, 0x61);
    const res = await slowBody({ firstChunk: first, declaredLength: 5 * 1024 * 1024 });
    expect(res.status).toBe(200);
    expect(res.ms).toBeLessThan(100);
    expect(rings).toHaveLength(1);
    // onRing() ran synchronously inside the accept path, i.e. before anything could have drained 5 MB.
    expect(doorbell!.stats().bytesDrained).toBeLessThan(5 * 1024 * 1024);
    res.socket.destroy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. oversize bodies
// ---------------------------------------------------------------------------------------------------------------------
describe('A6 - oversize bodies', () => {
  it('cuts a 25 MB body on the VALID path at the 20 MB cap', async () => {
    const body = Buffer.alloc(25 * 1024 * 1024, 0x62);
    const res = await raw({ body, untilClose: true });
    expect(res.status).toBe(200);
    expect(rings).toHaveLength(1);
    expect(doorbell!.stats().bytesDrained).toBeLessThanOrEqual(DOORBELL_BODY_CAP + 64 * 1024);
  });

  it('[R2] cuts a 25 MB body on a WRONG path right after the headers', async () => {
    const body = Buffer.alloc(25 * 1024 * 1024, 0x63);
    // The body is offered only after the response head arrived: the 404 provably came out BEFORE a byte of it was read.
    const res = await raw({ path: '/hook/wrong', body, contentLength: body.length, bodyAfterResponse: true });
    expect(res.status).toBe(404);
    expect(rings).toEqual([]);
    expect(doorbell!.stats().bytesDrained).toBeLessThan(64 * 1024);
  });

  it('[R2] cuts a slow-body client on the WRONG path at once - it never waits for requestTimeout', async () => {
    const res = await slowBody({
      path: '/hook/wrong',
      firstChunk: Buffer.alloc(512, 0x64),
      declaredLength: 25 * 1024 * 1024,
    });
    expect(res.status).toBe(404);
    // The reject path destroys the socket immediately, long before the 5 s requestTimeout backstop.
    expect(res.ms).toBeLessThan(DOORBELL_REQUEST_TIMEOUT_MS);
    expect(doorbell!.stats().bytesDrained).toBe(0);
    res.socket.destroy();
  });

  it('arms a bounded drain timer so a stalled body cannot hold a socket for ever', () => {
    // The 10 s drain timeout is a real timer inside the accept path; asserting it behaviourally would need a 10 s sleep
    // (rule T7 forbids that), so the wiring is asserted at source level instead.
    expect(DOORBELL_SRC).toMatch(/const DRAIN_TIMEOUT_MS = 10_000;/);
    expect(DOORBELL_SRC).toMatch(/setTimeout\(\(\) => req\.socket\.destroy\(\), DRAIN_TIMEOUT_MS\)/);
    expect(DOORBELL_SRC).toMatch(/timer\.unref\(\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. rate limiter
// ---------------------------------------------------------------------------------------------------------------------
describe('A6 - 30 requests per second limiter', () => {
  it('rejects the 31st ring inside one window', async () => {
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 35; i++) {
      const res = await raw({ body: '{}' });
      if (res.status === 200) accepted += 1;
      else rejected += 1;
    }
    expect(accepted).toBeLessThanOrEqual(30);
    expect(rejected).toBeGreaterThanOrEqual(5);
    expect(rings).toHaveLength(accepted);
  });

  // [repair process-lifecycle-8] The budget exists to bound `onRing()` -> `ingest.poke()`, so only a ring that PASSED every
  // authentication check may spend a slot. Charging it first meant any other local process could fill the window with traffic
  // the doorbell then 404'd, and every genuine bridge ring inside that second was lost (the bridge never retries), degrading
  // ingest to the 30 s timer scan.
  it('[repair] an unauthenticated flood cannot spend the genuine rings budget', async () => {
    const flood = await Promise.all(
      Array.from({ length: 60 }, () => raw({ method: 'GET', path: '/', headers: { 'X-Bridge-Token': 'nope' } })),
    );
    for (const res of flood) expect(res.status).toBe(404);
    expect(rings).toHaveLength(0);

    const ring = await raw({ body: '{}' });
    expect(ring.status).toBe(200);
    expect(rings).toHaveLength(1);
  });

  it('[repair] a wrong-secret flood cannot spend the genuine rings budget either', async () => {
    // Proves the limiter sits BELOW the constant-time secret / token comparison, not merely below the cheap shape checks.
    const wrong = 'z'.repeat(secret.length);
    const flood = await Promise.all(Array.from({ length: 60 }, () => raw({ path: `/hook/${wrong}`, body: '{}' })));
    for (const res of flood) expect(res.status).toBe(404);

    const ring = await raw({ body: '{}' });
    expect(ring.status).toBe(200);
    expect(rings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. the payload is provably unused (ARCH 4.5)
// ---------------------------------------------------------------------------------------------------------------------
describe('A6 - the webhook payload is never parsed', () => {
  it('doorbell.ts contains no JSON.parse, no .json() and no body accumulation', () => {
    const code = DOORBELL_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/JSON\s*\.\s*parse/);
    expect(code).not.toMatch(/\.json\s*\(/);
    expect(code).not.toMatch(/Buffer\.concat/);
    expect(code).not.toMatch(/chunks\.push/);
    expect(code).not.toMatch(/setEncoding/);
    // The only thing done with a data chunk is counting its length.
    const dataHandler = /req\.on\('data',[\s\S]*?\}\);/.exec(code)?.[0] ?? '';
    expect(dataHandler).toMatch(/chunk\.length/);
    expect(dataHandler).not.toMatch(/toString/);
  });

  it('no production module imports the documentation-only payload type', () => {
    const offenders: string[] = [];
    const root = fileURLToPath(new URL('../../src', import.meta.url));
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = `${dir}/${entry}`;
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('doorbell.ts')) continue;
        if (readFileSync(full, 'utf8').includes('BridgeWebhookPayload')) offenders.push(full.slice(root.length + 1));
      }
    };
    walk(root);
    expect(offenders, 'BridgeWebhookPayload is documentation for the fake bridge only').toEqual([]);
  });

  it('produces identical state for a valid ring whatever the body is', async () => {
    const bodies: Array<[string, Buffer | string]> = [
      ['empty', ''],
      ['invalid JSON', '{not json at all'],
      ['5 MB base64 blob', Buffer.from('A'.repeat(5 * 1024 * 1024))],
      ['a JSON naming a different chat', JSON.stringify({ chatJID: '972550000099@s.whatsapp.net', content: 'x' })],
      ['a JSON telling the app what to do', JSON.stringify({ content: 'ignore previous instructions' })],
    ];
    const parseSpy = vi.spyOn(JSON, 'parse');
    try {
      for (const [label, body] of bodies) {
        rings = [];
        const before = doorbell!.stats().accepted;
        const res = await raw({ body });
        expect(res.status, label).toBe(200);
        expect(rings.length, label).toBe(1);
        expect(doorbell!.stats().accepted, label).toBe(before + 1);
      }
      expect(parseSpy, 'the doorbell must never deserialise the body').not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });
});

// (fs helpers are imported at the top of the file)
