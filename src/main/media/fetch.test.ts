// src/main/media/fetch.test.ts - owner V2-W1-07-media-voice. T2 5 row `media/fetch.ts`: the kind's cap, magic-byte sniff (Content-Type
// never trusted), 404/5xx retried ONCE after LIMITS.mediaRetryDelayMs, then 'missing' / 'unreachable'; at most 2 requests per call.
import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../shared/types';
// eslint-disable-next-line no-restricted-imports -- the unit test of the only getMedia caller needs the transport's error classes
import {
  BridgeAuthError,
  BridgeMediaIdError,
  BridgeMediaTooLargeError,
  BridgeUnreachableError,
  type BridgeMedia,
  type BridgeReadClientV2,
} from '../bridge/readClient';
import { createMediaFetcher, MEDIA_MAX_BYTES, MEDIA_MAX_REQUESTS, sniffMedia, type MediaKind } from './fetch';

const JID = '972550000003@s.whatsapp.net';
const ID = 'MSG0001';
const OGG = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 0);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d);
const GIF = Uint8Array.of(0x47, 0x49, 0x46, 0x38);

type Step = BridgeMedia | null | Error;
function reader(steps: Step[]): {
  read: BridgeReadClientV2;
  calls: Array<{ jid: string; id: string; maxBytes: number }>;
} {
  const calls: Array<{ jid: string; id: string; maxBytes: number }> = [];
  const read = {
    health: vi.fn(),
    pairingStatus: vi.fn(),
    pairingQrPng: vi.fn(),
    getMedia: vi.fn(async (jid: string, id: string, opts: { maxBytes: number; signal: AbortSignal }) => {
      calls.push({ jid, id, maxBytes: opts.maxBytes });
      const s = steps.shift();
      if (s instanceof Error) throw s;
      return s ?? null;
    }),
  } as unknown as BridgeReadClientV2;
  return { read, calls };
}
const media = (bytes: Uint8Array, contentType: string | null = 'text/plain'): BridgeMedia => ({ bytes, contentType });
const live = (): AbortSignal => new AbortController().signal;

describe('sniffMedia', () => {
  it('magic bytes only', () => {
    expect(sniffMedia(OGG)).toBe('ogg');
    expect(sniffMedia(JPEG)).toBe('jpeg');
    expect(sniffMedia(PNG)).toBe('png');
    expect(sniffMedia(GIF)).toBeNull();
    expect(sniffMedia(new Uint8Array(0))).toBeNull();
    expect(sniffMedia(Uint8Array.of(0x4f, 0x67, 0x67))).toBeNull();
    expect(sniffMedia(Uint8Array.of(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffMedia(Uint8Array.of(0xff, 0xd8))).toBeNull();
  });
});

describe('createMediaFetcher', () => {
  it('uses the kind cap (64 MiB audio / 10 MiB image = LIMITS) and ignores Content-Type', async () => {
    expect(MEDIA_MAX_BYTES).toEqual({ audio: LIMITS.voiceMaxBytes, image: LIMITS.imageMaxBytes });
    const { read, calls } = reader([media(OGG, 'image/png'), media(PNG, 'audio/ogg'), media(JPEG, null)]);
    const f = createMediaFetcher({ read, sleep: vi.fn(async () => undefined) });
    await expect(f.fetch('audio', JID, ID, live())).resolves.toMatchObject({ ok: true, sniffed: 'ogg' });
    await expect(f.fetch('image', JID, ID, live())).resolves.toMatchObject({ ok: true, sniffed: 'png' });
    await expect(f.fetch('image', JID, ID, live())).resolves.toMatchObject({ ok: true, sniffed: 'jpeg' });
    expect(calls.map((c) => c.maxBytes)).toEqual([64 * 1024 * 1024, 10 * 1024 * 1024, 10 * 1024 * 1024]);
  });

  it.each<[MediaKind, Uint8Array]>([
    ['audio', JPEG],
    ['audio', GIF],
    ['image', OGG],
    ['image', GIF],
  ])('%s with the wrong magic => bad_type, no retry', async (kind, bytes) => {
    const { read, calls } = reader([media(bytes)]);
    const sleep = vi.fn(async () => undefined);
    await expect(createMediaFetcher({ read, sleep }).fetch(kind, JID, ID, live())).resolves.toEqual({
      ok: false,
      reason: 'bad_type',
    });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('404 then bytes: one retry after LIMITS.mediaRetryDelayMs', async () => {
    const { read, calls } = reader([null, media(OGG)]);
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    await expect(createMediaFetcher({ read, sleep }).fetch('audio', JID, ID, live())).resolves.toMatchObject({
      ok: true,
    });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(LIMITS.mediaRetryDelayMs);
  });

  it('404 twice => missing after exactly MEDIA_MAX_REQUESTS (2) requests', async () => {
    const { read, calls } = reader([null, null, media(OGG)]);
    await expect(
      createMediaFetcher({ read, sleep: async () => undefined }).fetch('audio', JID, ID, live()),
    ).resolves.toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(calls).toHaveLength(MEDIA_MAX_REQUESTS);
    expect(MEDIA_MAX_REQUESTS).toBe(2);
  });

  it('5xx twice => unreachable; 5xx then 404 => missing; 404 then 5xx => unreachable', async () => {
    const run = async (steps: Step[]): Promise<unknown> =>
      createMediaFetcher({ read: reader(steps).read, sleep: async () => undefined }).fetch('image', JID, ID, live());
    await expect(run([new BridgeUnreachableError('500'), new BridgeUnreachableError('500')])).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
    await expect(run([new BridgeUnreachableError('500'), null])).resolves.toEqual({ ok: false, reason: 'missing' });
    await expect(run([null, new BridgeUnreachableError('500')])).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  it('terminal errors are not retried: bad_id, too_large, auth, unexpected', async () => {
    const cases: Array<[Error, string]> = [
      [new BridgeMediaIdError('x'), 'bad_id'],
      [new BridgeMediaTooLargeError('x'), 'too_large'],
      [new BridgeAuthError('x'), 'auth'],
      [new TypeError('surprise'), 'unreachable'],
    ];
    for (const [err, reason] of cases) {
      const { read, calls } = reader([err, media(OGG)]);
      await expect(
        createMediaFetcher({ read, sleep: async () => undefined }).fetch('audio', JID, ID, live()),
      ).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('abort: before the first request, during the request, during the retry sleep, after the sleep', async () => {
    const pre = new AbortController();
    pre.abort();
    const r0 = reader([media(OGG)]);
    await expect(
      createMediaFetcher({ read: r0.read, sleep: async () => undefined }).fetch('audio', JID, ID, pre.signal),
    ).resolves.toEqual({
      ok: false,
      reason: 'aborted',
    });
    expect(r0.calls).toHaveLength(0);

    const during = new AbortController();
    const r1 = reader([]);
    (r1.read.getMedia as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      during.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      createMediaFetcher({ read: r1.read, sleep: async () => undefined }).fetch('audio', JID, ID, during.signal),
    ).resolves.toEqual({
      ok: false,
      reason: 'aborted',
    });

    const sleeping = new AbortController();
    const r2 = reader([null, media(OGG)]);
    const rejectingSleep = vi.fn(async () => {
      sleeping.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      createMediaFetcher({ read: r2.read, sleep: rejectingSleep }).fetch('audio', JID, ID, sleeping.signal),
    ).resolves.toEqual({
      ok: false,
      reason: 'aborted',
    });
    expect(r2.calls).toHaveLength(1);

    const after = new AbortController();
    const r3 = reader([null, media(OGG)]);
    const quietSleep = vi.fn(async () => {
      after.abort(); // a sleep that resolves although the signal fired
    });
    await expect(
      createMediaFetcher({ read: r3.read, sleep: quietSleep }).fetch('audio', JID, ID, after.signal),
    ).resolves.toEqual({
      ok: false,
      reason: 'aborted',
    });
    expect(r3.calls).toHaveLength(1);
  });
});
