// src/main/net/pinnedDownload.test.ts - the shared pinned-download rules (v5 W2 extraction from llm/local/download.ts).
// The model downloader keeps its own end-to-end tests (download.test.ts, tests/security/gguf-download.test.ts).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PinnedTransferError, fetchSmall, isAllowedUrl, sha256OfFile, transferToPart } from './pinnedDownload';
import type { FetchFn } from '../deps';

const ALLOW = { exact: ['github.com'], suffix: ['.githubusercontent.com'] } as const;
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wca-pinned-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = { url: string; init: RequestInit };
function scripted(responses: Array<() => Response>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    return next();
  }) as unknown as FetchFn;
  return { fetch, calls };
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const body =
  (bytes: Buffer | string, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(typeof bytes === 'string' ? bytes : new Uint8Array(bytes), { status, headers });

describe('isAllowedUrl', () => {
  it.each([
    ['https://github.com/o/r/releases/download/v1/x.zip', true],
    ['https://objects.githubusercontent.com/x', true],
    ['https://release-assets.githubusercontent.com/x', true],
    ['http://github.com/x', false],
    ['https://githubusercontent.com/x', false], // the suffix must be a real sub-domain
    ['https://github.com.evil.example/x', false],
    ['https://evilgithubusercontent.com/x', false],
    ['https://user:pw@github.com/x', false],
    ['ftp://github.com/x', false],
    ['not a url', false],
    ['http://127.0.0.1:5/x', false],
  ])('%s -> %s', (url, ok) => {
    expect(isAllowedUrl(url, ALLOW)).toBe(ok);
  });
  it('http loopback only behind the e2e gate, and never a foreign http host', () => {
    expect(isAllowedUrl('http://127.0.0.1:5/x', ALLOW, true)).toBe(true);
    expect(isAllowedUrl('http://[::1]:5/x', ALLOW, true)).toBe(true);
    expect(isAllowedUrl('http://localhost:5/x', ALLOW, true)).toBe(false);
    expect(isAllowedUrl('http://github.com/x', ALLOW, true)).toBe(false);
  });
});

describe('transferToPart', () => {
  const isAllowed = (u: string) => isAllowedUrl(u, ALLOW);
  it('follows exactly one allowed redirect hop with redirect:error and writes the body', async () => {
    const d = tmp();
    const { fetch, calls } = scripted([redirect('https://objects.githubusercontent.com/s'), body('hello')]);
    const seen: boolean[] = [];
    const n = await transferToPart({
      fetch,
      url: 'https://github.com/a',
      partPath: join(d, 'f.part'),
      offset: 0,
      isAllowed,
      headers: { 'user-agent': 'UA/1' },
      onFirstResponse: (_r, redirected) => {
        seen.push(redirected);
      },
    });
    expect(n).toBe(5);
    expect(readFileSync(join(d, 'f.part'), 'utf8')).toBe('hello');
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'error']);
    expect(calls[1]!.url).toBe('https://objects.githubusercontent.com/s');
    expect((calls[0]!.init.headers as Record<string, string>)['user-agent']).toBe('UA/1');
    expect(seen).toEqual([true]);
  });
  it('refuses a redirect to a foreign host before fetching it', async () => {
    const d = tmp();
    const { fetch, calls } = scripted([redirect('https://evil.example/x')]);
    await expect(
      transferToPart({ fetch, url: 'https://github.com/a', partPath: join(d, 'f.part'), offset: 0, isAllowed }),
    ).rejects.toThrow(new PinnedTransferError('redirect_host_refused'));
    expect(calls).toHaveLength(1);
    expect(existsSync(join(d, 'f.part'))).toBe(false);
  });
  it('a redirect without Location is refused', async () => {
    const { fetch } = scripted([() => new Response(null, { status: 302 })]);
    await expect(
      transferToPart({ fetch, url: 'https://github.com/a', partPath: join(tmp(), 'p'), offset: 0, isAllowed }),
    ).rejects.toThrow('redirect_host_refused');
  });
  it('resumes with Range and appends on 206', async () => {
    const d = tmp();
    writeFileSync(join(d, 'f.part'), 'hel');
    const { fetch, calls } = scripted([body('lo', 206)]);
    const progress: number[] = [];
    const n = await transferToPart({
      fetch,
      url: 'https://github.com/a',
      partPath: join(d, 'f.part'),
      offset: 3,
      isAllowed,
      onBytes: (done) => progress.push(done),
    });
    expect(n).toBe(5);
    expect(readFileSync(join(d, 'f.part'), 'utf8')).toBe('hello');
    expect((calls[0]!.init.headers as Record<string, string>).range).toBe('bytes=3-');
    expect(progress).toEqual([5]);
  });
  it('restarts from zero when the server ignores Range (200)', async () => {
    const d = tmp();
    writeFileSync(join(d, 'f.part'), 'xxx');
    const { fetch } = scripted([body('hello')]);
    expect(
      await transferToPart({ fetch, url: 'https://github.com/a', partPath: join(d, 'f.part'), offset: 3, isAllowed }),
    ).toBe(5);
    expect(readFileSync(join(d, 'f.part'), 'utf8')).toBe('hello');
  });
  it('416 means the part is already complete', async () => {
    const { fetch } = scripted([body('', 416)]);
    expect(
      await transferToPart({ fetch, url: 'https://github.com/a', partPath: join(tmp(), 'p'), offset: 9, isAllowed }),
    ).toBe(9);
  });
  it('an HTTP error is a refusal named by its status', async () => {
    const { fetch } = scripted([body('nope', 404)]);
    await expect(
      transferToPart({ fetch, url: 'https://github.com/a', partPath: join(tmp(), 'p'), offset: 0, isAllowed }),
    ).rejects.toThrow('http_404');
  });
  it('an empty body is a refusal', async () => {
    const { fetch } = scripted([() => new Response(null, { status: 200 })]);
    await expect(
      transferToPart({ fetch, url: 'https://github.com/a', partPath: join(tmp(), 'p'), offset: 0, isAllowed }),
    ).rejects.toThrow('empty_body');
  });
  it('the size pin refuses a declared Content-Length over the cap before writing', async () => {
    const d = tmp();
    const { fetch } = scripted([body('0123456789', 200, { 'content-length': '10' })]);
    await expect(
      transferToPart({
        fetch,
        url: 'https://github.com/a',
        partPath: join(d, 'p'),
        offset: 0,
        isAllowed,
        maxBytes: 5,
      }),
    ).rejects.toThrow('size_exceeded');
    expect(existsSync(join(d, 'p'))).toBe(false);
  });
  it('the size pin refuses a streamed body that grows past the cap', async () => {
    const d = tmp();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
        c.enqueue(new Uint8Array(4));
        c.close();
      },
    });
    const { fetch } = scripted([() => new Response(stream, { status: 200 })]);
    await expect(
      transferToPart({ fetch, url: 'https://github.com/a', partPath: join(d, 'p'), offset: 0, isAllowed, maxBytes: 6 }),
    ).rejects.toThrow('size_exceeded');
    expect(readFileSync(join(d, 'p')).length).toBe(4);
  });
  it('a throwing onFirstResponse stops the transfer', async () => {
    const { fetch, calls } = scripted([redirect('https://objects.githubusercontent.com/s')]);
    await expect(
      transferToPart({
        fetch,
        url: 'https://github.com/a',
        partPath: join(tmp(), 'p'),
        offset: 0,
        isAllowed,
        onFirstResponse: () => {
          throw new Error('pin');
        },
      }),
    ).rejects.toThrow('pin');
    expect(calls).toHaveLength(1);
  });
});

describe('sha256OfFile', () => {
  it('streams the digest', async () => {
    const d = tmp();
    const data = Buffer.alloc(300_000, 7);
    writeFileSync(join(d, 'f'), data);
    expect(await sha256OfFile(join(d, 'f'))).toBe(createHash('sha256').update(data).digest('hex'));
  });
  it('rejects for a missing file', async () => {
    await expect(sha256OfFile(join(tmp(), 'missing'))).rejects.toThrow();
  });
});

describe('fetchSmall', () => {
  const isAllowed = (u: string) => isAllowedUrl(u, ALLOW);
  it('reads a small body through one allowed hop', async () => {
    const { fetch, calls } = scripted([redirect('https://objects.githubusercontent.com/m'), body('{"a":1}')]);
    expect(await fetchSmall({ fetch, url: 'https://github.com/m', isAllowed, maxBytes: 100 })).toBe('{"a":1}');
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'error']);
  });
  it('refuses a foreign hop, an HTTP error, an empty body and an oversized body', async () => {
    await expect(
      fetchSmall({
        ...scripted([redirect('https://evil.example/')]),
        url: 'https://github.com/m',
        isAllowed,
        maxBytes: 9,
      }),
    ).rejects.toThrow('redirect_host_refused');
    await expect(
      fetchSmall({
        ...scripted([() => new Response(null, { status: 302 })]),
        url: 'https://github.com/m',
        isAllowed,
        maxBytes: 9,
      }),
    ).rejects.toThrow('redirect_host_refused');
    await expect(
      fetchSmall({ ...scripted([body('x', 403)]), url: 'https://github.com/m', isAllowed, maxBytes: 9 }),
    ).rejects.toThrow('http_403');
    await expect(
      fetchSmall({
        ...scripted([() => new Response(null, { status: 200 })]),
        url: 'https://github.com/m',
        isAllowed,
        maxBytes: 9,
      }),
    ).rejects.toThrow('empty_body');
    await expect(
      fetchSmall({ ...scripted([body('0123456789')]), url: 'https://github.com/m', isAllowed, maxBytes: 9 }),
    ).rejects.toThrow('too_large');
  });
});
