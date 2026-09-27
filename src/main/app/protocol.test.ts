// TESTS 5.3 row `app/protocol.ts` + gate item 12a: app://bundle traversal guard (incl. encoded variants) and the exact CSP string.
import { beforeEach, describe, expect, it } from 'vitest';
// The vitest alias maps `electron` to this mock, so production code and this test share one module instance.
import { protocol, resetElectronMock } from '../../../tests/mocks/electron';
import {
  APP_HOST,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  contentTypeFor,
  createBundleHandler,
  CSP,
  META_CSP,
  META_IGNORED_DIRECTIVES,
  registerAppProtocol,
  resolveBundlePath,
} from './protocol';

const ROOT = 'C:\\dev\\whatsapp agent\\out\\renderer';

beforeEach(() => resetElectronMock());

describe('CSP', () => {
  it('is byte-for-byte the ARCHITECTURE 15.1 string', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });
  it('allows no network from the renderer and no framing', () => {
    expect(CSP).toContain("connect-src 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("object-src 'none'");
  });
});

describe('META_CSP', () => {
  it('is the header policy minus only the directives a <meta> tag cannot carry', () => {
    expect(META_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
  });
  it('drops frame-ancestors (Chromium ignores it in a meta tag and logs an error) and nothing else', () => {
    expect(META_CSP).not.toContain('frame-ancestors');
    const dropped = CSP.split('; ').filter((d) => !META_CSP.split('; ').includes(d));
    expect(dropped).toEqual(["frame-ancestors 'none'"]);
  });
  it('keeps every other directive byte-identical, in order', () => {
    expect(META_CSP.split('; ')).toEqual(CSP.split('; ').filter((d) => !d.startsWith('frame-ancestors')));
    expect(META_CSP).toContain("connect-src 'none'");
    expect(META_CSP).toContain("default-src 'none'");
    expect(META_CSP).toContain("object-src 'none'");
  });
  it('never becomes the header policy: frame-ancestors stays enforceable on the response', () => {
    expect(CSP).not.toBe(META_CSP);
    expect(META_IGNORED_DIRECTIVES).toContain('frame-ancestors');
  });
});

describe('resolveBundlePath - allowed', () => {
  it.each([
    ['/', `${ROOT}\\index.html`],
    ['', `${ROOT}\\index.html`],
    ['/index.html', `${ROOT}\\index.html`],
    ['/assets/index-abc123.js', `${ROOT}\\assets\\index-abc123.js`],
    ['/assets/style.css', `${ROOT}\\assets\\style.css`],
    ['/a/b/c/deep.png', `${ROOT}\\a\\b\\c\\deep.png`],
    ['//index.html', `${ROOT}\\index.html`],
    ['/assets/%D7%A2%D7%91%D7%A8%D7%99%D7%AA.js', `${ROOT}\\assets\\עברית.js`],
  ])('%s -> %s', (pathname, expected) => {
    expect(resolveBundlePath(pathname, ROOT)).toBe(expected);
  });

  it('accepts a root given with a trailing separator', () => {
    expect(resolveBundlePath('/index.html', `${ROOT}\\`)).toBe(`${ROOT}\\index.html`);
  });
});

describe('resolveBundlePath - refused', () => {
  it.each([
    ['parent traversal', '/../../x'],
    ['parent traversal mid-path', '/assets/../../secret.txt'],
    ['single dot segment', '/./index.html'],
    ['encoded dots', '/%2e%2e/%2e%2e/x'],
    ['encoded dots, mixed case', '/%2E%2E/x'],
    ['encoded slash after dots', '/..%2f..%2fx'],
    ['backslash', '\\..\\..\\x'],
    ['backslash inside', '/assets\\..\\..\\x'],
    ['encoded backslash', '/%5c..%5cx'],
    ['drive letter', '/C:/Windows/System32/drivers/etc/hosts'],
    ['encoded drive letter', '/C%3A/Windows/win.ini'],
    ['UNC-ish', '/%5C%5Cserver%5Cshare%5Cx'],
    ['NUL byte', '/index.html%00.js'],
    ['control character', '/index%01.html'],
    ['malformed percent-encoding', '/%zz'],
    ['alternate data stream', '/index.html:$DATA'],
  ])('%s => null', (_name, pathname) => {
    expect(resolveBundlePath(pathname, ROOT)).toBeNull();
  });

  it('a sibling directory with the same prefix is not inside the root', () => {
    expect(resolveBundlePath('/x', 'C:\\out\\renderer')).toBe('C:\\out\\renderer\\x');
    expect(resolveBundlePath('/../renderer-evil/x', 'C:\\out\\renderer')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['app.JS', 'text/javascript; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['tray.svg', 'image/svg+xml'],
    ['icon.png', 'image/png'],
    ['font.woff2', 'font/woff2'],
    ['unknown.bin', 'application/octet-stream'],
    ['noextension', 'application/octet-stream'],
  ])('%s -> %s', (file, type) => {
    expect(contentTypeFor(file)).toBe(type);
  });
});

describe('the app:// handler', () => {
  const files = new Map<string, Uint8Array>([
    [`${ROOT}\\index.html`, new TextEncoder().encode('<!doctype html><title>x</title>')],
  ]);
  const handler = createBundleHandler({
    rendererDir: ROOT,
    readFile: async (p) => {
      const hit = files.get(p);
      if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return hit;
    },
  });

  it('serves index.html with the CSP header on the response', async () => {
    const res = await handler(new Request('app://bundle/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('refuses a traversal attempt that survives URL parsing with 403 and still sets the CSP header', async () => {
    const res = await handler(new Request('app://bundle/..%2f..%2fpackage.json'));
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(await res.text()).toBe('');
  });

  it.each([
    'app://bundle/../../package.json',
    'app://bundle/%2e%2e/%2e%2e/package.json',
    'app://bundle/..%2f..%2fpackage.json',
    'app://bundle/%2e%2e%2f%2e%2e%2fpackage.json',
    'app://bundle/a/../../../package.json',
  ])('%s never reads a file outside out/renderer', async (url) => {
    const asked: string[] = [];
    const guarded = createBundleHandler({
      rendererDir: ROOT,
      readFile: async (p) => {
        asked.push(p);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    const res = await guarded(new Request(url));
    expect(res.status).not.toBe(200);
    for (const p of asked) expect(p.startsWith(`${ROOT}\\`)).toBe(true);
  });

  it('refuses another host with 404', async () => {
    expect((await handler(new Request('app://evil/index.html'))).status).toBe(404);
  });

  it('a missing file is 404, never an exception', async () => {
    expect((await handler(new Request('app://bundle/missing.js'))).status).toBe(404);
  });

  it('registers the scheme privileges and the handler exactly once', () => {
    registerAppProtocol({ rendererDir: ROOT, registerSchemes: true });
    expect(protocol.privileged).toEqual(APP_SCHEME_PRIVILEGES);
    expect(protocol.handlers.has(APP_SCHEME)).toBe(true);
    expect(APP_SCHEME_PRIVILEGES[0]!.privileges).toEqual({ standard: true, secure: true, supportFetchAPI: true });
    expect(APP_HOST).toBe('bundle');
  });

  it('does not register the privileges when it is called after ready', () => {
    registerAppProtocol({ rendererDir: ROOT });
    expect(protocol.privileged).toEqual([]);
    expect(protocol.handlers.has(APP_SCHEME)).toBe(true);
  });

  it('the production handler reads from disk through node:fs (no injected reader needed)', async () => {
    const real = createBundleHandler({ rendererDir: ROOT });
    expect((await real(new Request('app://bundle/definitely-missing.js'))).status).toBe(404);
  });
});
