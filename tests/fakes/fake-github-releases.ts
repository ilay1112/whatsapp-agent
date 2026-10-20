// tests/fakes/fake-github-releases.ts - fake GitHub Releases host for the v5 updater (owner v5 W2; used by
// src/main/update/updateService.test.ts, tests/security/update.test.ts and W3's e2e through the WCA_UPDATE_BASE_URL seam).
// It mimics exactly the three GitHub surfaces the app touches:
//   GET /repos/<owner>/<repo>/releases/latest                      -> the API answer (tag_name + assets[].browser_download_url)
//   GET /<owner>/<repo>/releases/download/v<ver>/<asset>           -> 302 to the "CDN" (like github.com -> *.githubusercontent.com)
//   GET /cdn/<token>/<asset>                                       -> the bytes, with Range support
// The release zip is built here (Node built-ins only), shaped like CI's: ONE top folder `WhatsAppCalendarAgent/` holding
// `WhatsApp Calendar Agent.exe` (fake bytes, deflated), resources/app.asar (9 MiB, deflated) and resources/version.txt (stored), so the real
// extractor, the top-folder rule and the packaged-build check run against it.
// Spawnable-fake rules: Node built-ins only, erasable TS only (no enums / parameter properties / namespaces).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export type FakeReleaseScenario =
  | 'default'
  /** release.json names a sha256 that the zip does not have */
  | 'sha_mismatch'
  /** the zip download redirects to a foreign host (https://evil.example/...) */
  | 'foreign_redirect'
  /** the zip download redirects twice (CDN -> CDN): the app follows exactly one hop */
  | 'redirect_chain'
  /** the first zip body request drops the socket after N bytes (the next attempt resumes with Range) */
  | `drop_once_at:${number}`
  /** /releases/latest answers 500 */
  | 'api_error'
  /** /releases/latest answers 404 (no release published yet) */
  | 'no_release'
  /** release.json is not valid JSON */
  | 'bad_manifest'
  /** the release has no release.json asset */
  | 'no_manifest_asset'
  /** the zip contains no exe */
  | 'no_exe'
  /** the zip has the build at its root (no top folder) - refused by the stager */
  | 'flat_layout'
  /** the zip has the build under another top folder (`win-unpacked/`) - refused by the stager */
  | 'other_top_folder'
  /** the zip's top folder holds a file that is not part of a packaged build - refused by the stager */
  | 'foreign_entry'
  /** every zip body request sends N bytes and then stalls forever (the socket stays open) */
  | `stall_at:${number}`
  /** the zip contains an entry `../evil.txt` (and release.json pins THAT zip's real sha256) */
  | 'traversal_zip';

export interface FakeGithubReleasesOptions {
  owner?: string;
  repo?: string;
  /** The published version; null = no release yet. Default '0.1.9'. */
  version?: string | null;
  scenario?: FakeReleaseScenario;
  /** Size of the fake exe in bytes (default 300 KiB so a download emits several progress events). */
  exeBytes?: number;
}
export interface FakeReleaseRequest {
  method: string;
  path: string;
  range: string | null;
  userAgent: string | null;
  accept: string | null;
  hasAuthorization: boolean;
}
export interface FakeGithubReleases {
  /** http://127.0.0.1:<port> - the value for WCA_UPDATE_BASE_URL (it replaces https://api.github.com). */
  readonly url: string;
  readonly owner: string;
  readonly repo: string;
  readonly requests: FakeReleaseRequest[];
  /** Publishes (or replaces) the latest release. null = no release. */
  publish(version: string | null): void;
  setScenario(s: FakeReleaseScenario): void;
  /** Name, size and sha256 of the zip currently served for `version` (the real bytes, whatever release.json claims). */
  zipOf(version: string): { name: string; size: number; sha256: string; bytes: Buffer };
  stop(): Promise<void>;
}

export const FAKE_EXE_NAME = 'WhatsApp Calendar Agent.exe';
/** The zip's one top folder (src/shared/update.ts UPDATE_ZIP_TOP_FOLDER; repeated: a spawnable fake imports nothing of src). */
export const FAKE_ZIP_TOP_FOLDER = 'WhatsAppCalendarAgent';
export const fakeAssetName = (version: string): string => `WhatsAppCalendarAgent-win-x64-${version}.zip`;

// ---------------------------------------------------------------------------------------------------------------------
// a minimal zip writer (stored + deflate)
// ---------------------------------------------------------------------------------------------------------------------
function zipOfEntries(entries: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data) >>> 0;
    const method = e.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function buildReleaseZip(version: string, scenario: FakeReleaseScenario, exeBytes: number): Buffer {
  const exe = Buffer.alloc(exeBytes);
  let x = 0x9e3779b9 ^ version.length; // xorshift: incompressible, so the zip is as big as the exe (progress, drops, resume)
  for (let i = 0; i < exe.length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    exe[i] = x & 0xff;
  }
  exe.write(`MZ FAKE ${version}`, 0, 'latin1');
  const prefix =
    scenario === 'flat_layout' ? '' : scenario === 'other_top_folder' ? 'win-unpacked/' : `${FAKE_ZIP_TOP_FOLDER}/`;
  const entries: Array<{ name: string; data: Buffer; deflate: boolean }> = [];
  if (scenario !== 'no_exe') entries.push({ name: `${prefix}${FAKE_EXE_NAME}`, data: exe, deflate: true });
  // 9 MiB (deflates to a few KiB): above the extractor's 8 MiB streaming threshold, so the e2e app (Electron main, where
  // the asar fs patch is active) streams a `.asar` file to disk exactly like the real ~100 MB app.asar.
  const asar = Buffer.alloc(9 * 1024 * 1024, `asar ${version}\n`);
  entries.push({ name: `${prefix}resources/app.asar`, data: asar, deflate: true });
  entries.push({ name: `${prefix}resources/version.txt`, data: Buffer.from(version), deflate: false });
  if (scenario === 'foreign_entry')
    entries.push({ name: `${prefix}photo.jpg`, data: Buffer.from('jpg'), deflate: false });
  if (scenario === 'traversal_zip') entries.push({ name: '../evil.txt', data: Buffer.from('owned'), deflate: false });
  return zipOfEntries(entries);
}

// ---------------------------------------------------------------------------------------------------------------------
export async function startFakeGithubReleases(opts: FakeGithubReleasesOptions = {}): Promise<FakeGithubReleases> {
  const owner = opts.owner ?? 'ilay1112';
  const repo = opts.repo ?? 'whatsapp-agent';
  const exeBytes = opts.exeBytes ?? 300 * 1024;
  let version: string | null = opts.version === undefined ? '0.1.9' : opts.version;
  let scenario: FakeReleaseScenario = opts.scenario ?? 'default';
  let dropped = false;
  const requests: FakeReleaseRequest[] = [];
  const zips = new Map<string, Buffer>();
  const zipBytes = (v: string): Buffer => {
    const key = `${v}|${scenario}`;
    let z = zips.get(key);
    if (z === undefined) {
      z = buildReleaseZip(v, scenario, exeBytes);
      zips.set(key, z);
    }
    return z;
  };
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  let port = 0;
  const base = (): string => `http://127.0.0.1:${String(port)}`;

  const manifestOf = (v: string): Buffer => {
    if (scenario === 'bad_manifest') return Buffer.from('{ not json');
    const zip = zipBytes(v);
    return Buffer.from(
      JSON.stringify({
        schema: 1,
        version: v,
        commit: 'f'.repeat(40),
        publishedAt: '2026-10-20T12:00:00.000Z',
        asset: {
          name: fakeAssetName(v),
          size: zip.length,
          sha256: scenario === 'sha_mismatch' ? '0'.repeat(64) : sha(zip),
        },
        minVersion: '0.1.0',
        notes: `Fake release ${v}`,
      }),
    );
  };

  const send = (
    res: ServerResponse,
    status: number,
    body: Buffer | string,
    headers: Record<string, string> = {},
  ): void => {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    res.writeHead(status, { 'content-length': String(buf.length), ...headers });
    res.end(buf);
  };

  const serveBytes = (req: IncomingMessage, res: ServerResponse, bytes: Buffer): void => {
    const range = req.headers.range;
    let start = 0;
    if (typeof range === 'string') {
      const m = /^bytes=(\d+)-$/.exec(range);
      start = m === null ? 0 : Number(m[1]);
      if (start >= bytes.length) {
        res.writeHead(416, { 'content-range': `bytes */${String(bytes.length)}` });
        res.end();
        return;
      }
    }
    const slice = bytes.subarray(start);
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(slice.length),
      'accept-ranges': 'bytes',
    };
    if (start > 0)
      headers['content-range'] = `bytes ${String(start)}-${String(bytes.length - 1)}/${String(bytes.length)}`;
    const stall = /^stall_at:(\d+)$/.exec(scenario);
    if (stall !== null) {
      res.writeHead(start > 0 ? 206 : 200, headers);
      res.write(slice.subarray(0, Math.min(Number(stall[1]), slice.length - 1))); // ... and never end
      return;
    }
    const drop = /^drop_once_at:(\d+)$/.exec(scenario);
    if (drop !== null && !dropped && bytes.length > 4096) {
      dropped = true;
      const cut = Math.min(Number(drop[1]), slice.length - 1);
      res.writeHead(start > 0 ? 206 : 200, headers);
      res.write(slice.subarray(0, cut), () => {
        setTimeout(() => res.socket?.destroy(), 20);
      });
      return;
    }
    res.writeHead(start > 0 ? 206 : 200, headers);
    res.end(slice);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({
      method: req.method ?? 'GET',
      path,
      range: typeof req.headers.range === 'string' ? req.headers.range : null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      accept: typeof req.headers.accept === 'string' ? req.headers.accept : null,
      hasAuthorization: req.headers.authorization !== undefined,
    });
    if (req.method !== 'GET') return send(res, 405, 'method');

    if (path === `/repos/${owner}/${repo}/releases/latest`) {
      if (scenario === 'api_error') return send(res, 500, '{"message":"boom"}');
      if (version === null || scenario === 'no_release') return send(res, 404, '{"message":"Not Found"}');
      const v = version;
      const dl = (name: string): string => `${base()}/${owner}/${repo}/releases/download/v${v}/${name}`;
      const assets = [{ name: fakeAssetName(v), size: zipBytes(v).length, browser_download_url: dl(fakeAssetName(v)) }];
      if (scenario !== 'no_manifest_asset')
        assets.push({ name: 'release.json', size: manifestOf(v).length, browser_download_url: dl('release.json') });
      return send(
        res,
        200,
        JSON.stringify({ tag_name: `v${v}`, name: `v${v}`, draft: false, prerelease: false, assets }),
        {
          'content-type': 'application/json',
        },
      );
    }

    const dl = new RegExp(`^/${owner}/${repo}/releases/download/v([0-9.]+)/([^/]+)$`).exec(path);
    if (dl !== null) {
      const [, v, name] = dl as unknown as [string, string, string];
      if (version === null || v !== version) return send(res, 404, 'Not Found');
      const isZip = name === fakeAssetName(v);
      if (isZip && scenario === 'foreign_redirect')
        return send(res, 302, '', { location: `https://evil.example/${encodeURIComponent(name)}` });
      if (isZip && scenario === 'redirect_chain')
        return send(res, 302, '', { location: `${base()}/hop/${v}/${encodeURIComponent(name)}` });
      return send(res, 302, '', { location: `${base()}/cdn/${v}/${encodeURIComponent(name)}?sig=fake` });
    }
    const hop = /^\/hop\/([0-9.]+)\/([^/]+)$/.exec(path);
    if (hop !== null) return send(res, 302, '', { location: `${base()}/cdn/${hop[1]!}/${hop[2]!}` });

    const cdn = /^\/cdn\/([0-9.]+)\/([^/]+)$/.exec(path);
    if (cdn !== null) {
      const v = cdn[1]!;
      const name = decodeURIComponent(cdn[2]!);
      if (name === 'release.json') return send(res, 200, manifestOf(v), { 'content-type': 'application/json' });
      if (name === fakeAssetName(v)) return serveBytes(req, res, zipBytes(v));
      return send(res, 404, 'Not Found');
    }
    return send(res, 404, 'Not Found');
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  let unregister: (() => void) | undefined;
  const fake: FakeGithubReleases = {
    get url() {
      return base();
    },
    owner,
    repo,
    requests,
    publish: (v) => {
      version = v;
    },
    setScenario: (s) => {
      scenario = s;
      dropped = false;
    },
    zipOf: (v) => {
      const bytes = zipBytes(v);
      return { name: fakeAssetName(v), size: bytes.length, sha256: sha(bytes), bytes };
    },
    stop: async () => {
      unregister?.();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
  try {
    const guards = (await import('../setup-guards.ts')) as {
      registerFake?: (f: { name: string; stop(): Promise<void> | void }) => () => void;
    };
    unregister = guards.registerFake?.({ name: 'fake-github-releases', stop: () => fake.stop() });
  } catch {
    unregister = undefined;
  }
  return fake;
}
