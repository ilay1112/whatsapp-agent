// TESTS 5.3 row `bridge/readClient.ts, sendClient.ts`: base URL always 127.0.0.1, redirect:'error', bearer header,
// error mapping, QR PNG size cap, and the A16 rule that only the four implemented endpoints exist.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_READ_TIMEOUT_MS,
  BridgeAuthError,
  BridgeMediaIdError,
  BridgeMediaTooLargeError,
  BridgeUnreachableError,
  LOGGED_OUT_MESSAGE_RE,
  MEDIA_JID_RE,
  MEDIA_MSG_ID_RE,
  QR_PNG_MAX_BYTES,
  createBridgeReadClient,
  type BridgeReadClient,
} from './readClient';
import { createBridgeSendClient, type BridgeSendClient } from './sendClient';
import { FAKE_QR_PNG_BASE64, startFakeBridge, type FakeBridge } from '../../../tests/fakes/fake-bridge.ts';

const EP = { port: 5123, token: 'b'.repeat(64) };

interface Call {
  url: string;
  init: RequestInit;
}
function scripted(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(new URL(url), init ?? {});
  });
  return { fetch: fetchFn as unknown as typeof globalThis.fetch, calls };
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createBridgeReadClient', () => {
  it('always talks to http://127.0.0.1:<port> with the bearer header, redirect:error and a 15 s cap', async () => {
    const { fetch, calls } = scripted(() => json(200, { status: 'ok', connected: true, timestamp: 1 }));
    await createBridgeReadClient(() => EP, fetch).health();
    expect(calls[0]?.url).toBe(`http://127.0.0.1:${EP.port}/api/health`);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${EP.token}`);
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(BRIDGE_READ_TIMEOUT_MS).toBe(15_000);
  });

  it('throws BridgeUnreachableError when there is no endpoint yet', async () => {
    const { fetch, calls } = scripted(() => json(200, {}));
    await expect(createBridgeReadClient(() => null, fetch).health()).rejects.toBeInstanceOf(BridgeUnreachableError);
    expect(calls).toHaveLength(0);
  });

  it('maps 401 and 403 to BridgeAuthError on every endpoint', async () => {
    for (const status of [401, 403]) {
      const { fetch } = scripted(() => new Response('Unauthorized\n', { status }));
      const client = createBridgeReadClient(() => EP, fetch);
      await expect(client.health()).rejects.toBeInstanceOf(BridgeAuthError);
      await expect(client.pairingStatus()).rejects.toBeInstanceOf(BridgeAuthError);
      await expect(client.pairingQrPng()).rejects.toBeInstanceOf(BridgeAuthError);
    }
  });

  it('maps a transport failure to BridgeUnreachableError', async () => {
    const { fetch } = scripted(() => {
      throw new TypeError('fetch failed');
    });
    await expect(createBridgeReadClient(() => EP, fetch).health()).rejects.toBeInstanceOf(BridgeUnreachableError);
  });

  it('health: treats 200 and 503 as answers and anything else as unreachable', async () => {
    const ok = scripted(() => json(200, { status: 'ok', connected: true, timestamp: 1_700_000_000 }));
    await expect(createBridgeReadClient(() => EP, ok.fetch).health()).resolves.toEqual({
      httpStatus: 200,
      connected: true,
      timestampS: 1_700_000_000,
    });
    const down = scripted(() => json(503, { status: 'disconnected', connected: false, timestamp: 5 }));
    await expect(createBridgeReadClient(() => EP, down.fetch).health()).resolves.toEqual({
      httpStatus: 503,
      connected: false,
      timestampS: 5,
    });
    const weird = scripted(() => json(500, {}));
    await expect(createBridgeReadClient(() => EP, weird.fetch).health()).rejects.toBeInstanceOf(BridgeUnreachableError);
  });

  it('health: rejects a body that does not match the wire schema', async () => {
    const { fetch } = scripted(() => json(200, { status: 'weird', connected: 'yes', timestamp: 'now' }));
    await expect(createBridgeReadClient(() => EP, fetch).health()).rejects.toThrow();
  });

  it('pairingStatus: zod-validates and rejects an unknown status', async () => {
    const ok = scripted(() => json(200, { status: 'qr_pending', qr_present: true, expires_at: 12 }));
    await expect(createBridgeReadClient(() => EP, ok.fetch).pairingStatus()).resolves.toEqual({
      status: 'qr_pending',
      qr_present: true,
      expires_at: 12,
    });
    const bad = scripted(() => json(200, { status: 'paired' }));
    await expect(createBridgeReadClient(() => EP, bad.fetch).pairingStatus()).rejects.toThrow();
    const wrongStatus = scripted(() => json(500, {}));
    await expect(createBridgeReadClient(() => EP, wrongStatus.fetch).pairingStatus()).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
  });

  it('pairingStatus: the logged-out message is the ONLY source of that state', () => {
    expect(LOGGED_OUT_MESSAGE_RE.test('Device was logged out -- restart the bridge to pair again')).toBe(true);
    expect(LOGGED_OUT_MESSAGE_RE.test('QR code expired without being scanned')).toBe(false);
  });

  it('pairingQrPng: 200 image/png -> bytes; 404 and 500 -> null; anything else throws', async () => {
    const png = Buffer.from(FAKE_QR_PNG_BASE64, 'base64');
    const ok = scripted(() => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    await expect(createBridgeReadClient(() => EP, ok.fetch).pairingQrPng()).resolves.toEqual(new Uint8Array(png));
    for (const status of [404, 500]) {
      const s = scripted(() => new Response('no QR code available\n', { status }));
      await expect(createBridgeReadClient(() => EP, s.fetch).pairingQrPng()).resolves.toBeNull();
    }
    const odd = scripted(() => new Response('teapot', { status: 418 }));
    await expect(createBridgeReadClient(() => EP, odd.fetch).pairingQrPng()).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
  });

  it('pairingQrPng: refuses a non-PNG body, an empty body and anything over the size cap', async () => {
    const notPng = scripted(() => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(createBridgeReadClient(() => EP, notPng.fetch).pairingQrPng()).resolves.toBeNull();
    const empty = scripted(
      () => new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    await expect(createBridgeReadClient(() => EP, empty.fetch).pairingQrPng()).resolves.toBeNull();
    const huge = scripted(
      () =>
        new Response(new Uint8Array(QR_PNG_MAX_BYTES + 1), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    await expect(createBridgeReadClient(() => EP, huge.fetch).pairingQrPng()).resolves.toBeNull();
  });

  it('a body that refuses to be cancelled never turns into an unhandled rejection', async () => {
    const stubborn = {
      status: 500,
      headers: new Headers(),
      body: { cancel: () => Promise.reject(new Error('stream is stuck')) },
    } as unknown as Response;
    const { fetch } = scripted(() => stubborn);
    await expect(createBridgeReadClient(() => EP, fetch).pairingStatus()).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    await new Promise<void>((r) => setImmediate(r));
  });
});

describe('A16: only the four implemented endpoints exist', () => {
  it('the read client exposes exactly health / pairingStatus / pairingQrPng', () => {
    const client = createBridgeReadClient(() => null);
    expect(Object.keys(client).sort()).toEqual(['getMedia', 'health', 'pairingQrPng', 'pairingStatus']); // [V2] + getMedia (C2 12)
    for (const forbidden of ['typing', 'react', 'download', 'media', 'group', 'sendText', 'listChats', 'markRead']) {
      expect(Object.keys(client)).not.toContain(forbidden);
    }
    expectTypeOf<BridgeReadClient>().toHaveProperty('health');
    expectTypeOf<keyof BridgeReadClient>().toEqualTypeOf<'health' | 'pairingStatus' | 'pairingQrPng' | 'getMedia'>(); // [V2]
  });

  it('the send client exposes exactly sendText', () => {
    const client = createBridgeSendClient(() => null);
    expect(Object.keys(client)).toEqual(['sendText']);
    expectTypeOf<keyof BridgeSendClient>().toEqualTypeOf<'sendText'>();
  });
});

describe('against the fake bridge over real loopback HTTP', () => {
  let fake: FakeBridge;
  let root: string;

  // TESTS 5.1 T7: a fake registers itself on start and the global afterEach fails when one is still running, so it is per-test.
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wca-read-'));
    fake = await startFakeBridge({
      token: 'c'.repeat(64),
      storeDir: join(root, 'store'),
      pairing: 'connected',
      ansi: false,
    });
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const ep = (): { port: number; token: string } => ({ port: fake.port, token: 'c'.repeat(64) });

  it('reads health, pairing status and the QR PNG through the real wire contract', async () => {
    const client = createBridgeReadClient(ep);
    await expect(client.health()).resolves.toMatchObject({ httpStatus: 200, connected: true });
    await expect(client.pairingStatus()).resolves.toMatchObject({ status: 'connected' });
    await expect(client.pairingQrPng()).resolves.toBeNull(); // 404 while not qr_pending

    fake.setPairing('qr_pending');
    fake.setConnected(false);
    const wire = await client.pairingStatus();
    expect(wire).toMatchObject({ status: 'qr_pending', qr_present: true });
    expect(typeof wire.expires_at).toBe('number');
    const png = await client.pairingQrPng();
    expect(png).not.toBeNull();
    expect(Buffer.from(png ?? new Uint8Array()).toString('base64')).toBe(FAKE_QR_PNG_BASE64);
    await expect(client.health()).resolves.toMatchObject({ httpStatus: 503, connected: false });
    fake.setPairing('connected');
  });

  it('a wrong token is a BridgeAuthError, never a silent retry', async () => {
    const client = createBridgeReadClient(() => ({ port: fake.port, token: 'd'.repeat(64) }));
    await expect(client.health()).rejects.toBeInstanceOf(BridgeAuthError);
  });

  it('the fake flags any of the endpoints A16 (amended by B5) forbids, so a regression cannot pass unnoticed', async () => {
    // [V2] B5: /api/media is the fifth implemented endpoint (journaled in mediaRequests); the other four stay forbidden.
    for (const path of ['/api/typing', '/api/react', '/api/download', '/api/group/status']) {
      const res = await fetch(`http://127.0.0.1:${fake.port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${'c'.repeat(64)}` },
      });
      void res.body?.cancel().catch(() => undefined);
    }
    expect(fake.violations).toEqual([
      'forbidden_endpoint:/api/typing',
      'forbidden_endpoint:/api/react',
      'forbidden_endpoint:/api/download',
      'forbidden_endpoint:/api/group/status',
    ]);
    expect(fake.otherRequests).toHaveLength(4);
    fake.violations.length = 0; // provoked on purpose (the global fake-violation check runs after each test)
  });

  it('the fake records no forbidden endpoint for anything the clients do', async () => {
    const client = createBridgeReadClient(ep);
    await client.health();
    await client.pairingStatus();
    await client.pairingQrPng();
    expect(fake.otherRequests).toEqual([]);
    expect(fake.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] GET /api/media (C2 12, B5; V2-W1-07-media-voice) - T2 5 row `media/fetch.ts, bridge/readClient.ts getMedia`
// ---------------------------------------------------------------------------------------------------------------------
describe('getMedia (unit, scripted fetch)', () => {
  const JID = '972550000001@s.whatsapp.net';
  const ID = '3EB0FAKE000001';
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
  const live = (): AbortSignal => new AbortController().signal;
  const bytesResponse = (
    body: Uint8Array | ReadableStream<Uint8Array>,
    headers: Record<string, string> = {},
  ): Response => new Response(body as BodyInit, { status: 200, headers: { 'Content-Type': 'audio/ogg', ...headers } });

  it('ids are re-checked against both regexes BEFORE any request (BridgeMediaIdError, zero fetch calls)', async () => {
    const { fetch, calls } = scripted(() => bytesResponse(ogg));
    const client = createBridgeReadClient(() => EP, fetch);
    for (const [jid, id] of [
      ['../../etc@s.whatsapp.net', ID],
      [JID, '../x'],
      [JID, 'a.b'],
      ['x'.repeat(101) + '@s.whatsapp.net', ID],
      [JID, 'A'.repeat(129)],
      ['972550000001@S.WHATSAPP.NET', ID],
      ['', ID],
      [JID, ''],
    ] as const) {
      await expect(client.getMedia(jid, id, { maxBytes: 10, signal: live() })).rejects.toBeInstanceOf(
        BridgeMediaIdError,
      );
    }
    expect(calls).toHaveLength(0);
    expect(MEDIA_JID_RE.test(JID)).toBe(true);
    expect(MEDIA_MSG_ID_RE.test(ID)).toBe(true);
    await expect(client.getMedia(JID, ID, { maxBytes: 0, signal: live() })).rejects.toBeInstanceOf(RangeError);
  });

  it('GET http://127.0.0.1:<port>/api/media?jid=&message_id= with bearer, redirect:error; bytes + untrusted content type', async () => {
    const { fetch, calls } = scripted(() => bytesResponse(ogg, { 'Content-Type': 'text/html' }));
    const media = await createBridgeReadClient(() => EP, fetch).getMedia(JID, ID, { maxBytes: 64, signal: live() });
    expect(Array.from(media?.bytes ?? [])).toEqual(Array.from(ogg));
    expect(media?.contentType).toBe('text/html');
    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin).toBe(`http://127.0.0.1:${EP.port}`);
    expect(url.pathname).toBe('/api/media');
    expect(url.searchParams.get('jid')).toBe(JID);
    expect(url.searchParams.get('message_id')).toBe(ID);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${EP.token}`);
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('404 => null; 401/403 => BridgeAuthError; 5xx and other statuses => BridgeUnreachableError; network error => unreachable', async () => {
    const client = (status: number): BridgeReadClient =>
      createBridgeReadClient(() => EP, scripted(() => new Response('x', { status })).fetch);
    await expect(client(404).getMedia(JID, ID, { maxBytes: 9, signal: live() })).resolves.toBeNull();
    await expect(client(401).getMedia(JID, ID, { maxBytes: 9, signal: live() })).rejects.toBeInstanceOf(
      BridgeAuthError,
    );
    await expect(client(403).getMedia(JID, ID, { maxBytes: 9, signal: live() })).rejects.toBeInstanceOf(
      BridgeAuthError,
    );
    await expect(client(500).getMedia(JID, ID, { maxBytes: 9, signal: live() })).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    await expect(client(206).getMedia(JID, ID, { maxBytes: 9, signal: live() })).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    const down = createBridgeReadClient(() => EP, scripted(() => Promise.reject(new TypeError('fetch failed'))).fetch);
    await expect(down.getMedia(JID, ID, { maxBytes: 9, signal: live() })).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    await expect(
      createBridgeReadClient(() => null).getMedia(JID, ID, { maxBytes: 9, signal: live() }),
    ).rejects.toBeInstanceOf(BridgeUnreachableError);
  });

  it('hard cap: a declared Content-Length above the cap is refused unread; a streamed body aborts at cap + 1', async () => {
    const declared = scripted(() => bytesResponse(new Uint8Array(11), { 'Content-Length': '11' }));
    await expect(
      createBridgeReadClient(() => EP, declared.fetch).getMedia(JID, ID, { maxBytes: 10, signal: live() }),
    ).rejects.toBeInstanceOf(BridgeMediaTooLargeError);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += 1;
        ctrl.enqueue(new Uint8Array(4));
      },
    });
    const streamed = scripted(() => bytesResponse(endless));
    await expect(
      createBridgeReadClient(() => EP, streamed.fetch).getMedia(JID, ID, { maxBytes: 10, signal: live() }),
    ).rejects.toBeInstanceOf(BridgeMediaTooLargeError);
    expect(pulled).toBeLessThan(10); // stopped right after the cap, never drained
    const exact = scripted(() => bytesResponse(new Uint8Array(10)));
    const got = await createBridgeReadClient(() => EP, exact.fetch).getMedia(JID, ID, { maxBytes: 10, signal: live() });
    expect(got?.bytes.length).toBe(10);
    const none = scripted(() => new Response(null, { status: 200 }));
    const empty = await createBridgeReadClient(() => EP, none.fetch).getMedia(JID, ID, {
      maxBytes: 10,
      signal: live(),
    });
    expect(empty?.bytes.length).toBe(0);
    expect(empty?.contentType).toBeNull();
  });

  it('a body that breaks mid-stream is BridgeUnreachableError', async () => {
    let n = 0;
    const breaking = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        n += 1;
        if (n > 1) ctrl.error(new Error('socket hang up'));
        else ctrl.enqueue(new Uint8Array(2));
      },
    });
    const { fetch } = scripted(() => bytesResponse(breaking));
    await expect(
      createBridgeReadClient(() => EP, fetch).getMedia(JID, ID, { maxBytes: 10, signal: live() }),
    ).rejects.toBeInstanceOf(BridgeUnreachableError);
  });

  it('the caller signal: aborted before => no request; aborted during the request or the body => rejects with its reason', async () => {
    const { fetch, calls } = scripted(() => bytesResponse(ogg));
    const pre = new AbortController();
    pre.abort(new Error('paused'));
    await expect(
      createBridgeReadClient(() => EP, fetch).getMedia(JID, ID, { maxBytes: 9, signal: pre.signal }),
    ).rejects.toThrow('paused');
    const bare = new AbortController();
    bare.abort('not an error');
    await expect(
      createBridgeReadClient(() => EP, fetch).getMedia(JID, ID, { maxBytes: 9, signal: bare.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(0);

    for (const reason of [new Error('quit'), 'plain']) {
      const during = new AbortController();
      const hanging = scripted(
        (_u, init) =>
          new Promise<Response>((_res, rej) => {
            init.signal?.addEventListener('abort', () => rej(new Error('fetch aborted')));
            during.abort(reason);
          }),
      );
      const p = createBridgeReadClient(() => EP, hanging.fetch).getMedia(JID, ID, {
        maxBytes: 9,
        signal: during.signal,
      });
      if (reason instanceof Error) await expect(p).rejects.toThrow('quit');
      else await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    }

    for (const reason of [new Error('stop'), 'plain']) {
      const body = new AbortController();
      let k = 0;
      const trickle = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          k += 1;
          if (k === 2) body.abort(reason);
          ctrl.enqueue(new Uint8Array(1));
        },
      });
      const t = scripted(() => bytesResponse(trickle));
      const p = createBridgeReadClient(() => EP, t.fetch).getMedia(JID, ID, { maxBytes: 99, signal: body.signal });
      if (reason instanceof Error) await expect(p).rejects.toThrow('stop');
      else await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    }
  });

  it('the 15 s connect budget ends a request whose head never arrives (BridgeUnreachableError)', async () => {
    vi.useFakeTimers();
    try {
      const { fetch } = scripted(
        (_u, init) =>
          new Promise<Response>((_res, rej) => {
            init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
          }),
      );
      const p = createBridgeReadClient(() => EP, fetch).getMedia(JID, ID, { maxBytes: 9, signal: live() });
      const settled = expect(p).rejects.toBeInstanceOf(BridgeUnreachableError);
      await vi.advanceTimersByTimeAsync(BRIDGE_READ_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getMedia against the fake bridge /api/media (T2 3.6)', () => {
  let fake: FakeBridge;
  let root: string;
  const TOKEN = 'd'.repeat(64);
  const JID = '972550000002@s.whatsapp.net';
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wca-media-'));
    fake = await startFakeBridge({ token: TOKEN, storeDir: join(root, 'store'), pairing: 'connected', ansi: false });
    fake.db.seedMediaRow({ chatJid: JID, id: 'AUDIO01', mediaType: 'audio' });
    fake.db.seedMediaRow({ chatJid: JID, id: 'IMAGE01', mediaType: 'image' });
    fake.db.seedMediaRow({ chatJid: JID, id: 'VIDEO01', mediaType: 'video' });
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const client = (): BridgeReadClient => createBridgeReadClient(() => ({ port: fake.port, token: TOKEN }));
  const live = (): AbortSignal => new AbortController().signal;

  it('serves scripted bytes; unscripted / missing => null; the journal records every request', async () => {
    const ogg = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 9, 9]);
    fake.setMedia(JID, 'AUDIO01', ogg);
    const m = await client().getMedia(JID, 'AUDIO01', { maxBytes: 100, signal: live() });
    expect(Array.from(m?.bytes ?? [])).toEqual(Array.from(ogg));
    expect(m?.contentType).toBe('audio/ogg');
    await expect(client().getMedia(JID, 'IMAGE01', { maxBytes: 100, signal: live() })).resolves.toBeNull();
    fake.setMedia(JID, 'IMAGE01', { scenario: 'missing' });
    await expect(client().getMedia(JID, 'IMAGE01', { maxBytes: 100, signal: live() })).resolves.toBeNull();
    expect(fake.mediaRequests.map((r) => [r.messageId, r.status])).toEqual([
      ['AUDIO01', 200],
      ['IMAGE01', 404],
      ['IMAGE01', 404],
    ]);
    expect(fake.violations).toEqual([]);
    expect(fake.otherRequests).toEqual([]);
  });

  it('http_500_once then the bytes; http_500 always; partial => unreachable; wrong_bytes served as-is; oversize => too large', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    fake.setMedia(JID, 'IMAGE01', png);
    fake.setMedia(JID, 'IMAGE01', { scenario: 'http_500_once' });
    await expect(client().getMedia(JID, 'IMAGE01', { maxBytes: 100, signal: live() })).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    await expect(client().getMedia(JID, 'IMAGE01', { maxBytes: 100, signal: live() })).resolves.toMatchObject({
      contentType: 'image/png',
    });
    fake.setMedia(JID, 'AUDIO01', { scenario: 'http_500' });
    await expect(client().getMedia(JID, 'AUDIO01', { maxBytes: 100, signal: live() })).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    fake.setMedia(JID, 'AUDIO01', new Uint8Array(4096).fill(0x4f));
    fake.setMedia(JID, 'AUDIO01', { scenario: 'partial' });
    await expect(client().getMedia(JID, 'AUDIO01', { maxBytes: 10_000, signal: live() })).rejects.toBeInstanceOf(
      BridgeUnreachableError,
    );
    fake.setMedia(JID, 'IMAGE01', { scenario: 'wrong_bytes' });
    const gif = await client().getMedia(JID, 'IMAGE01', { maxBytes: 100, signal: live() });
    expect(String.fromCharCode(...(gif?.bytes.subarray(0, 3) ?? []))).toBe('GIF');
    fake.setMedia(JID, 'IMAGE01', { scenario: 'oversize' });
    await expect(
      client().getMedia(JID, 'IMAGE01', { maxBytes: 10 * 1024 * 1024, signal: live() }),
    ).rejects.toBeInstanceOf(BridgeMediaTooLargeError);
    expect(fake.violations).toEqual([]);
  });

  it('a slow trickle is cut by the caller signal', async () => {
    fake.setMedia(JID, 'AUDIO01', new Uint8Array(1600).fill(0x4f));
    fake.setMedia(JID, 'AUDIO01', { scenario: 'slow' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('paused')), 250);
    await expect(client().getMedia(JID, 'AUDIO01', { maxBytes: 10_000, signal: ac.signal })).rejects.toThrow('paused');
  });

  it('violations: unknown row, non-media row, retry storm; a bad id never reaches the fake', async () => {
    await expect(client().getMedia(JID, 'NOSUCHROW', { maxBytes: 9, signal: live() })).resolves.toBeNull();
    await expect(client().getMedia(JID, 'VIDEO01', { maxBytes: 9, signal: live() })).resolves.toBeNull();
    for (let i = 0; i < 3; i += 1) await client().getMedia(JID, 'AUDIO01', { maxBytes: 9, signal: live() });
    expect(fake.violations).toEqual(['media_unknown_row', 'media_non_media_row', 'media_retry_storm']);
    fake.violations.length = 0; // provoked on purpose
    await expect(client().getMedia(JID, 'bad.id', { maxBytes: 9, signal: live() })).rejects.toBeInstanceOf(
      BridgeMediaIdError,
    );
    expect(fake.mediaRequests.some((r) => r.messageId === 'bad.id')).toBe(false);
  });

  it('the fake itself answers 404 to malformed ids (like media_serve.go) and 405 to a non-GET', async () => {
    const base = `http://127.0.0.1:${fake.port}/api/media`;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const bad = await fetch(`${base}?jid=${encodeURIComponent('../x@s.whatsapp.net')}&message_id=A`, { headers: auth });
    expect(bad.status).toBe(404);
    await bad.body?.cancel();
    const post = await fetch(`${base}?jid=${encodeURIComponent(JID)}&message_id=A`, { method: 'POST', headers: auth });
    expect(post.status).toBe(405);
    await post.body?.cancel();
    expect(() => fake.setMedia(JID, 'AUDIO01', { scenario: 'nope' as never })).toThrow(/unknown media scenario/);
    expect(fake.violations).toEqual([]);
  });
});
