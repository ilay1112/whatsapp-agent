// CONTRACTS section 18 item 8 + TESTS 5.3 row `bridge/readClient.ts, sendClient.ts`.
// sendClient.ts is in the 100 %-coverage safety-critical set (TESTS section 13): every branch of the mapping has a test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_SEND_TIMEOUT_MS, createBridgeSendClient, type BridgeSendRequest } from './sendClient';
import { DM_PHONE_JID_RE } from '../../shared/types';
import { startFakeBridge, type FakeBridge } from '../../../tests/fakes/fake-bridge.ts';

const EP = { port: 5123, token: 'b'.repeat(64) };
const REQ: BridgeSendRequest = { recipient: '972550000001@s.whatsapp.net', message: 'hello' };

interface Call {
  url: string;
  init: RequestInit;
}
function scripted(handler: (init: RequestInit) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(init ?? {});
  });
  return { fetch: fetchFn as unknown as typeof globalThis.fetch, calls };
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

describe('BridgeSendRequest wire shape', () => {
  it('has exactly recipient + message', () => {
    const req: BridgeSendRequest = { recipient: '972550000001@s.whatsapp.net', message: 'hello' };
    expect(Object.keys(JSON.parse(JSON.stringify(req))).sort()).toEqual(['message', 'recipient']);
    expect(DM_PHONE_JID_RE.test(req.recipient)).toBe(true);
  });
  it('type forbids the media / quoted keys the bridge would also accept', () => {
    // @ts-expect-error media_path is not part of BridgeSendRequest
    const bad: BridgeSendRequest = { recipient: '972550000001@s.whatsapp.net', message: 'x', media_path: 'c:/x' };
    expect(bad).toBeDefined();
  });
});

describe('createBridgeSendClient', () => {
  it('POSTs to http://127.0.0.1:<port>/api/send with the bearer header, redirect:error and a 60 s cap', async () => {
    const { fetch, calls } = scripted(() => json(200, { success: true, message: 'Message sent to x' }));
    await createBridgeSendClient(() => EP, fetch).sendText(REQ);
    const call = calls[0];
    expect(call?.url).toBe(`http://127.0.0.1:${EP.port}/api/send`);
    expect(call?.init.method).toBe('POST');
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${EP.token}`);
    expect((call?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(call?.init.redirect).toBe('error');
    expect(BRIDGE_SEND_TIMEOUT_MS).toBe(60_000);
  });

  it('serialises EXACTLY {recipient, message}, whatever the caller smuggled onto the object', async () => {
    const { fetch, calls } = scripted(() => json(200, { success: true, message: 'ok' }));
    const smuggled = { ...REQ, media_path: 'c:/evil.png', quoted_message_id: '3EB0' } as BridgeSendRequest;
    await createBridgeSendClient(() => EP, fetch).sendText(smuggled);
    expect(Object.keys(JSON.parse(String(calls[0]?.init.body)) as object).sort()).toEqual(['message', 'recipient']);
  });

  it('no endpoint => unreachable without any request', async () => {
    const { fetch, calls } = scripted(() => json(200, {}));
    await expect(createBridgeSendClient(() => null, fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      httpStatus: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('200 + success:true => ok', async () => {
    const { fetch } = scripted(() =>
      json(200, { success: true, message: 'Message sent to 972550000001@s.whatsapp.net' }),
    );
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toEqual({ ok: true });
  });

  it('200 + success:false => rejected', async () => {
    const { fetch } = scripted(() => json(200, { success: false, message: 'Failed to send typing indicator' }));
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'rejected',
      httpStatus: 200,
    });
  });

  it('200 with a non-JSON body => rejected', async () => {
    const { fetch } = scripted(() => text(200, 'not json'));
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toMatchObject({ reason: 'rejected' });
  });

  it('200 with JSON that is not the envelope => rejected', async () => {
    const { fetch } = scripted(() => json(200, { message: 'no success key' }));
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toMatchObject({ reason: 'rejected' });
    const nullBody = scripted(() => json(200, null));
    await expect(createBridgeSendClient(() => EP, nullBody.fetch).sendText(REQ)).resolves.toMatchObject({
      reason: 'rejected',
    });
  });

  it('401 => auth', async () => {
    const { fetch } = scripted(() => text(401, 'Unauthorized\n'));
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'auth',
      httpStatus: 401,
    });
  });

  it('403 text (host allow-list) => auth ; 403 JSON (bridge refusal) => rejected', async () => {
    const hostBlocked = scripted(() => text(403, 'Forbidden: host not allowed\n'));
    await expect(createBridgeSendClient(() => EP, hostBlocked.fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'auth',
      httpStatus: 403,
    });
    const refused = scripted(() =>
      json(403, { success: false, message: 'Only group admins can send messages in this group' }),
    );
    await expect(createBridgeSendClient(() => EP, refused.fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'rejected',
      httpStatus: 403,
    });
  });

  it('400 and 405 => bad_request', async () => {
    for (const status of [400, 405]) {
      const { fetch } = scripted(() => text(status, 'Invalid request format\n'));
      await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toEqual({
        ok: false,
        reason: 'bad_request',
        httpStatus: status,
      });
    }
  });

  it('500 + /Not connected to WhatsApp/ => not_connected ; any other 500 => rejected', async () => {
    const offline = scripted(() => json(500, { success: false, message: 'Not connected to WhatsApp' }));
    await expect(createBridgeSendClient(() => EP, offline.fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'not_connected',
      httpStatus: 500,
    });
    const other = scripted(() => json(500, { success: false, message: 'Error sending message: boom' }));
    await expect(createBridgeSendClient(() => EP, other.fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'rejected',
      httpStatus: 500,
    });
    const plain500 = scripted(() => text(500, 'boom'));
    await expect(createBridgeSendClient(() => EP, plain500.fetch).sendText(REQ)).resolves.toMatchObject({
      reason: 'rejected',
    });
  });

  it('an unexpected status falls through to rejected', async () => {
    const { fetch } = scripted(() => text(418, 'teapot'));
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'rejected',
      httpStatus: 418,
    });
  });

  it('a transport failure => unreachable', async () => {
    const { fetch } = scripted(() => {
      throw new TypeError('fetch failed');
    });
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      httpStatus: null,
    });
  });

  it('an aborted request => timeout (the executor records unknown_outcome, never failed)', async () => {
    const { fetch } = scripted(async (init) => {
      await new Promise<void>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        setTimeout(resolve, 5_000);
      });
      return json(200, { success: true, message: 'late' });
    });
    const controller = new AbortController();
    const p = createBridgeSendClient(() => EP, fetch).sendText(REQ, controller.signal);
    controller.abort();
    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout', httpStatus: null });
  });

  it('a body that cannot be read is treated as an empty body', async () => {
    const broken = new Response('{}', { status: 200 });
    Object.defineProperty(broken, 'text', {
      value: () => Promise.reject(new Error('stream error')),
    });
    const { fetch } = scripted(() => broken);
    await expect(createBridgeSendClient(() => EP, fetch).sendText(REQ)).resolves.toMatchObject({ reason: 'rejected' });
  });
});

describe('against the fake bridge over real loopback HTTP', () => {
  let fake: FakeBridge;
  let root: string;
  const TOKEN = 'e'.repeat(64);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wca-send-'));
    fake = await startFakeBridge({ token: TOKEN, storeDir: join(root, 'store'), pairing: 'connected', ansi: false });
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const client = (): ReturnType<typeof createBridgeSendClient> =>
    createBridgeSendClient(() => ({ port: fake.port, token: TOKEN }));

  it('sends exactly two keys and records no shape violation', async () => {
    await expect(client().sendText(REQ)).resolves.toEqual({ ok: true });
    expect(fake.sends).toEqual([{ recipient: REQ.recipient, message: REQ.message, extraKeys: [] }]);
    expect(fake.violations).toEqual([]);
    expect(fake.otherRequests).toEqual([]);
  });

  it('maps the real 500 "Not connected to WhatsApp" answer', async () => {
    fake.failNextSend('not_connected');
    await expect(client().sendText(REQ)).resolves.toEqual({ ok: false, reason: 'not_connected', httpStatus: 500 });
  });

  it('maps the real 500 error answer', async () => {
    fake.failNextSend('error_500');
    await expect(client().sendText(REQ)).resolves.toMatchObject({ reason: 'rejected', httpStatus: 500 });
  });
});
