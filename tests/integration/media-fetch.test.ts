// tests/integration/media-fetch.test.ts - owner V2-W1-07-media-voice (T2 6 row `media-fetch.test.ts`): every fake-bridge media scenario
// through the production chain media/fetch.ts -> bridge/readClient.ts getMedia -> real loopback HTTP -> fake bridge /api/media, with the
// fake's validation like media_serve.go. At most two requests per message per call; media_retry_storm is never raised.
// The retry delay is the injected sleep (production: LIMITS.mediaRetryDelayMs; e2e: WCA_TIMERS.mediaRetryMs) - asserted, not waited.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/shared/types';
import { createBridgeReadClient } from '../../src/main/bridge/readClient';
import { createMediaFetcher, type MediaFetcher } from '../../src/main/media/fetch';
import { FAKE_MEDIA_SCENARIOS, startFakeBridge, type FakeBridge } from '../fakes/fake-bridge';
import { oggSilence } from '../fakes/ogg-fixtures';
import { jpeg, png } from '../fakes/image-fixtures';

const TOKEN = 'e'.repeat(64);
const JID = '972550000051@s.whatsapp.net';

describe('media/fetch.ts against the fake bridge /api/media', () => {
  let root: string;
  let fake: FakeBridge;
  let sleeps: number[];
  let fetcher: MediaFetcher;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'wca-mfetch-'));
    fake = await startFakeBridge({ token: TOKEN, storeDir: join(root, 'store'), pairing: 'connected', ansi: false });
    for (const [id, t] of [
      ['AUD1', 'audio'],
      ['IMG1', 'image'],
      ['IMG2', 'image'],
    ] as const)
      fake.db.seedMediaRow({ chatJid: JID, id, mediaType: t });
    sleeps = [];
    fetcher = createMediaFetcher({
      read: createBridgeReadClient(() => ({ port: fake.port, token: TOKEN })),
      sleep: async (ms) => void sleeps.push(ms),
    });
  });
  afterEach(async () => {
    expect(fake.violations.filter((v) => v.startsWith('media_'))).toEqual([]); // media_retry_storm never raised
    await fake.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const live = (): AbortSignal => new AbortController().signal;
  const requestsFor = (id: string): number => fake.mediaRequests.filter((r) => r.messageId === id).length;

  it('covers every scenario name the fake declares', () => {
    expect([...FAKE_MEDIA_SCENARIOS].sort()).toEqual([
      'http_500',
      'http_500_once',
      'missing',
      'oversize',
      'partial',
      'slow',
      'wrong_bytes',
    ]);
  });

  it('bytes: an Ogg voice note, a JPEG and a PNG arrive whole and sniffed; one request each, no sleep', async () => {
    const note = oggSilence(3);
    fake.setMedia(JID, 'AUD1', note);
    fake.setMedia(JID, 'IMG1', jpeg(64, 48));
    fake.setMedia(JID, 'IMG2', png(32, 32));
    const a = await fetcher.fetch('audio', JID, 'AUD1', live());
    expect(a.ok && a.sniffed).toBe('ogg');
    expect(a.ok && a.bytes.length).toBe(note.length);
    expect(await fetcher.fetch('image', JID, 'IMG1', live())).toMatchObject({ ok: true, sniffed: 'jpeg' });
    expect(await fetcher.fetch('image', JID, 'IMG2', live())).toMatchObject({ ok: true, sniffed: 'png' });
    expect([requestsFor('AUD1'), requestsFor('IMG1'), requestsFor('IMG2')]).toEqual([1, 1, 1]);
    expect(sleeps).toEqual([]);
  });

  it('missing: 404 twice => missing (VOICE_AUDIO_MISSING / image_unread) after EXACTLY two requests and one retry delay', async () => {
    fake.setMedia(JID, 'AUD1', { scenario: 'missing' });
    expect(await fetcher.fetch('audio', JID, 'AUD1', live())).toEqual({ ok: false, reason: 'missing' });
    expect(requestsFor('AUD1')).toBe(2);
    expect(sleeps).toEqual([LIMITS.mediaRetryDelayMs]);
  });

  it('http_500_once: the retry succeeds; http_500: unreachable after two requests', async () => {
    fake.setMedia(JID, 'IMG1', jpeg(8, 8));
    fake.setMedia(JID, 'IMG1', { scenario: 'http_500_once' });
    expect(await fetcher.fetch('image', JID, 'IMG1', live())).toMatchObject({ ok: true, sniffed: 'jpeg' });
    expect(requestsFor('IMG1')).toBe(2);
    fake.setMedia(JID, 'IMG2', { scenario: 'http_500' });
    expect(await fetcher.fetch('image', JID, 'IMG2', live())).toEqual({ ok: false, reason: 'unreachable' });
    expect(requestsFor('IMG2')).toBe(2);
  });

  it('partial (Content-Length then a reset): retried once, then unreachable', async () => {
    fake.setMedia(JID, 'AUD1', oggSilence(2));
    fake.setMedia(JID, 'AUD1', { scenario: 'partial' });
    expect(await fetcher.fetch('audio', JID, 'AUD1', live())).toEqual({ ok: false, reason: 'unreachable' });
    expect(requestsFor('AUD1')).toBe(2);
  });

  it('oversize (cap + 1, chunked): too_large on the first request, never retried', async () => {
    fake.setMedia(JID, 'IMG1', { scenario: 'oversize' });
    expect(await fetcher.fetch('image', JID, 'IMG1', live())).toEqual({ ok: false, reason: 'too_large' });
    expect(requestsFor('IMG1')).toBe(1);
  });

  it('wrong_bytes (a GIF where an Ogg / a picture was expected): bad_type, never retried', async () => {
    fake.setMedia(JID, 'AUD1', { scenario: 'wrong_bytes' });
    expect(await fetcher.fetch('audio', JID, 'AUD1', live())).toEqual({ ok: false, reason: 'bad_type' });
    fake.setMedia(JID, 'IMG1', { scenario: 'wrong_bytes' });
    expect(await fetcher.fetch('image', JID, 'IMG1', live())).toEqual({ ok: false, reason: 'bad_type' });
    expect([requestsFor('AUD1'), requestsFor('IMG1')]).toEqual([1, 1]);
  });

  it('slow (a trickle): the caller signal (Pause / quit) ends it as aborted, without a retry', async () => {
    fake.setMedia(JID, 'AUD1', oggSilence(4));
    fake.setMedia(JID, 'AUD1', { scenario: 'slow' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 250);
    expect(await fetcher.fetch('audio', JID, 'AUD1', ac.signal)).toEqual({ ok: false, reason: 'aborted' });
    expect(requestsFor('AUD1')).toBe(1);
  });

  it('a bad id is refused in the app (bad_id) - the fake never sees it; a wrong bearer is auth, never retried', async () => {
    expect(await fetcher.fetch('audio', JID, '../etc', live())).toEqual({ ok: false, reason: 'bad_id' });
    expect(fake.mediaRequests).toEqual([]);
    const wrongToken = createMediaFetcher({
      read: createBridgeReadClient(() => ({ port: fake.port, token: 'f'.repeat(64) })),
      sleep: async () => undefined,
    });
    expect(await wrongToken.fetch('audio', JID, 'AUD1', live())).toEqual({ ok: false, reason: 'auth' });
  });
});
