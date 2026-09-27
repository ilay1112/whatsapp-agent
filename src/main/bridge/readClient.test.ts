// TESTS 5.3 row `bridge/readClient.ts, sendClient.ts`: base URL always 127.0.0.1, redirect:'error', bearer header,
// error mapping, QR PNG size cap, and the A16 rule that only the four implemented endpoints exist.
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_READ_TIMEOUT_MS,
  BridgeAuthError,
  BridgeUnreachableError,
  LOGGED_OUT_MESSAGE_RE,
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
    expect(Object.keys(client).sort()).toEqual(['health', 'pairingQrPng', 'pairingStatus']);
    for (const forbidden of ['typing', 'react', 'download', 'media', 'group', 'sendText', 'listChats', 'markRead']) {
      expect(Object.keys(client)).not.toContain(forbidden);
    }
    expectTypeOf<BridgeReadClient>().toHaveProperty('health');
    expectTypeOf<keyof BridgeReadClient>().toEqualTypeOf<'health' | 'pairingStatus' | 'pairingQrPng'>();
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

  it('the fake flags any of the endpoints A16 forbids, so a regression cannot pass unnoticed', async () => {
    for (const path of ['/api/typing', '/api/react', '/api/download', '/api/media', '/api/group/status']) {
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
      'forbidden_endpoint:/api/media',
      'forbidden_endpoint:/api/group/status',
    ]);
    expect(fake.otherRequests).toHaveLength(5);
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
