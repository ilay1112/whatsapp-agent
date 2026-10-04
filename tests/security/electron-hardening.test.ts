// tests/security/electron-hardening.test.ts - gate item 12a of TESTS 8.2 (ARCH 15.1 / 15.2 / 16). Owner: W2-02.
//
// Everything here runs against the REAL production modules (`app/window.ts`, `app/protocol.ts`, `ipc/handlers/app.ts`)
// and the REAL repository files (`electron-builder.yml`, `package.json`, `package-lock.json`). Nothing is mocked except
// the injected collaborators the modules already take.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildWebPreferences, hardenWebContents, isAppUrl, WINDOW_BOUNDS, APP_URL } from '../../src/main/app/window.ts';
import {
  CSP,
  META_CSP,
  contentTypeFor,
  createBundleHandler,
  resolveBundlePath,
  APP_SCHEME_PRIVILEGES,
} from '../../src/main/app/protocol.ts';
import { CALENDAR_DAY_URL_PREFIX, calendarDayUrl, createAppHandlers } from '../../src/main/ipc/handlers/app.ts';
import type { HandlerDeps } from '../../src/main/ipc/register.ts';
import { EXTERNAL_TARGETS, IPC_REQUEST_SCHEMAS } from '../../src/shared/ipc.ts';
import type { EpochMs, Item, ItemId } from '../../src/shared/types.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
} as unknown as Parameters<typeof hardenWebContents>[1];

// ---------------------------------------------------------------------------------------------------------------------
// 1. webPreferences + window geometry (ARCH 15.1)
// ---------------------------------------------------------------------------------------------------------------------
describe('ARCH 15.1 - webPreferences is exactly the hardened object', () => {
  it('has every hardening key at its required value and nothing else', () => {
    const prefs = buildWebPreferences({
      preloadPath: 'C:\\app\\out\\preload\\index.cjs',
      isPackaged: true,
      initial: { lang: 'en', dir: 'ltr' },
    });
    expect(prefs).toEqual({
      preload: 'C:\\app\\out\\preload\\index.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: false,
      additionalArguments: ['--wca-lang=en', '--wca-dir=ltr'],
    });
  });

  it('opens devTools only in an unpackaged build', () => {
    const dev = buildWebPreferences({
      preloadPath: 'p',
      isPackaged: false,
      initial: { lang: 'he', dir: 'rtl' },
    });
    expect(dev.devTools).toBe(true);
    expect(dev.additionalArguments).toEqual(['--wca-lang=he', '--wca-dir=rtl']);
  });

  it('uses the geometry of ARCH 15.1 and loads only app://bundle/index.html', () => {
    expect(WINDOW_BOUNDS).toEqual({ width: 980, height: 680, minWidth: 420, minHeight: 560 });
    expect(APP_URL).toBe('app://bundle/index.html');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. CSP (ARCH 15.1, exact string)
// ---------------------------------------------------------------------------------------------------------------------
describe('ARCH 15.1 - production CSP', () => {
  it('is the exact header string', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
  });

  it('forbids every network sink and every inline script', () => {
    const directives = Object.fromEntries(
      CSP.split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const [name, ...values] = d.split(/\s+/);
          return [name!, values];
        }),
    );
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['connect-src']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['form-action']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['script-src']).toEqual(["'self'"]); // no 'unsafe-inline', no 'unsafe-eval', no host
  });

  it('is sent on every protocol response, success or denial', async () => {
    const handler = createBundleHandler({
      rendererDir: 'C:\\app\\out\\renderer',
      readFile: (p) =>
        p.endsWith('index.html')
          ? Promise.resolve(new TextEncoder().encode('<!doctype html>'))
          : Promise.reject(new Error('ENOENT')),
    });
    const okRes = await handler(new Request('app://bundle/index.html'));
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(okRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const denied = await handler(new Request('app://bundle/../secrets.txt'));
    expect(denied.headers.get('Content-Security-Policy')).toBe(CSP);
  });

  // The renderer's <meta> tag is defence in depth behind that header. Chromium IGNORES `frame-ancestors` in a meta
  // tag and logs a console error for it on every load, so the tag carries `META_CSP` - the same policy minus that one
  // directive - while `frame-ancestors 'none'` stays on the header above, where it is enforced.
  describe('the renderer <meta> tag', () => {
    const html = read('src/renderer/index.html');
    const metaContent = (): string => {
      const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html.replace(/\s+/g, ' '));
      expect(match, 'src/renderer/index.html must carry exactly one CSP meta tag').not.toBeNull();
      return match![1]!;
    };

    it('is exactly META_CSP', () => {
      expect(metaContent()).toBe(META_CSP);
    });

    it('does not carry frame-ancestors (Chromium ignores it there and logs a console error every boot)', () => {
      expect(metaContent()).not.toContain('frame-ancestors');
      // Nowhere else in the document either - comments stripped, so the explanatory comment does not count.
      expect(html.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('frame-ancestors');
    });

    it('still forbids every network sink inline, byte-identical to the header', () => {
      const meta = metaContent();
      for (const directive of CSP.split('; ')) {
        if (directive.startsWith('frame-ancestors')) continue;
        expect(meta.split('; '), directive).toContain(directive);
      }
      expect(meta).toContain("connect-src 'none'");
      expect(meta).toContain("default-src 'none'");
      expect(meta).toContain("script-src 'self'");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. navigation / new-window / webview / permission handlers all deny
// ---------------------------------------------------------------------------------------------------------------------
describe('ARCH 15.1 - every escape hatch off the bundle is denied', () => {
  interface Recorded {
    navigations: Array<{ url: string; prevented: boolean }>;
    windowOpen: unknown;
    webviewPrevented: boolean;
    permissionRequest: boolean | null;
    permissionCheck: boolean | null;
  }

  function harden(): Recorded {
    const rec: Recorded = {
      navigations: [],
      windowOpen: undefined,
      webviewPrevented: false,
      permissionRequest: null,
      permissionCheck: null,
    };
    const listeners = new Map<string, (...a: never[]) => void>();
    const sessionDouble = {
      setPermissionRequestHandler: (fn: (wc: unknown, p: string, cb: (granted: boolean) => void) => void) => {
        fn(null, 'media', (granted) => {
          rec.permissionRequest = granted;
        });
      },
      setPermissionCheckHandler: (fn: () => boolean) => {
        rec.permissionCheck = fn();
      },
    };
    const contents = {
      on: (event: string, fn: (...a: never[]) => void) => {
        listeners.set(event, fn);
      },
      setWindowOpenHandler: (fn: () => unknown) => {
        rec.windowOpen = fn();
      },
      session: sessionDouble,
    };
    hardenWebContents({ webContents: contents } as never, silentLog);

    const navigate = listeners.get('will-navigate') as unknown as (e: { preventDefault(): void }, url: string) => void;
    for (const url of [
      'https://evil.example/',
      'http://127.0.0.1:1/',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'data:text/html,<script>1</script>',
      'about:blank',
      'javascript:alert(1)',
      'app://other-host/index.html',
      'app://bundle/index.html', // the only allowed one
    ]) {
      let prevented = false;
      navigate({ preventDefault: () => (prevented = true) }, url);
      rec.navigations.push({ url, prevented });
    }
    const webview = listeners.get('will-attach-webview') as unknown as (e: { preventDefault(): void }) => void;
    webview({
      preventDefault: () => {
        rec.webviewPrevented = true;
      },
    });
    return rec;
  }

  const rec = harden();

  it('blocks navigation to everything except app://bundle', () => {
    for (const nav of rec.navigations) {
      expect(nav.prevented, nav.url).toBe(nav.url !== 'app://bundle/index.html');
    }
  });

  it('denies window.open', () => {
    expect(rec.windowOpen).toEqual({ action: 'deny' });
  });

  it('denies <webview> attachment', () => {
    expect(rec.webviewPrevented).toBe(true);
  });

  it('denies every permission request and every permission check', () => {
    expect(rec.permissionRequest).toBe(false);
    expect(rec.permissionCheck).toBe(false);
  });

  it('isAppUrl accepts only the app bundle origin', () => {
    expect(isAppUrl('app://bundle/index.html')).toBe(true);
    expect(isAppUrl('app://bundle/assets/x.js')).toBe(true);
    for (const bad of [
      'app://bundle.evil.example/index.html',
      'app://BUNDLE@evil.example/',
      'apps://bundle/index.html',
      'https://bundle/index.html',
      'not a url',
    ]) {
      expect(isAppUrl(bad), bad).toBe(false);
    }
  });

  it('registers app:// as standard + secure and nothing else', () => {
    expect(APP_SCHEME_PRIVILEGES).toEqual([
      { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. app:// traversal guard
// ---------------------------------------------------------------------------------------------------------------------
describe('ARCH 15.1 - app://bundle traversal guard', () => {
  const ROOT = 'C:\\app\\out\\renderer';

  const ESCAPES = [
    '/../secrets.txt',
    '/../../package.json',
    '/assets/../../../../Windows/win.ini',
    '/%2e%2e/secrets.txt',
    '/%2E%2E%2Fsecrets.txt',
    '/..%5Csecrets.txt',
    '/C:/Windows/win.ini',
    '/\\\\server\\share\\x',
    '/index.html:$DATA',
    '/%00/index.html',
    '/%ZZ',
  ];

  it.each(ESCAPES)('refuses %s', (pathname) => {
    expect(resolveBundlePath(pathname, ROOT)).toBeNull();
  });

  it('maps legitimate paths under the renderer directory only', () => {
    expect(resolveBundlePath('/', ROOT)).toBe(join(ROOT, 'index.html'));
    expect(resolveBundlePath('/index.html', ROOT)).toBe(join(ROOT, 'index.html'));
    expect(resolveBundlePath('/assets/app.js', ROOT)).toBe(join(ROOT, 'assets', 'app.js'));
    const resolved = resolveBundlePath('/assets/./app.css', ROOT);
    expect(resolved).toBeNull(); // a '.' segment is an attack shape, not a file name
  });

  it('never lets the request choose the content type', () => {
    expect(contentTypeFor('x.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.exe')).toBe('application/octet-stream');
    expect(contentTypeFor('x.js.exe')).toBe('application/octet-stream');
  });

  it('answers a traversal attempt with 403 and never reads a file', async () => {
    const reads: string[] = [];
    const handler = createBundleHandler({
      rendererDir: ROOT,
      readFile: (p) => {
        reads.push(p);
        return Promise.resolve(new Uint8Array());
      },
    });
    // `new URL()` already collapses a literal `/../`, so the handler-level cases are the forms that SURVIVE parsing:
    // percent-encoded dots, backslashes, drive letters, alternate data streams, NUL and malformed escapes.
    const SURVIVING = [
      '/%2E%2E%2Fsecrets.txt',
      '/..%5Csecrets.txt',
      '/C:/Windows/win.ini',
      '/index.html:$DATA',
      '/%00/index.html',
      '/%ZZ',
    ];
    // Sanity: these really do reach the handler un-normalised (Chromium's URL parser collapses `%2e%2e` itself).
    for (const p of SURVIVING) expect(new URL(`app://bundle${p}`).pathname, p).toBe(p);
    for (const pathname of SURVIVING) {
      const res = await handler(new Request(`app://bundle${pathname}`));
      expect([400, 403, 404], pathname).toContain(res.status);
    }
    expect(reads).toEqual([]);
  });

  it('refuses a foreign host on the app scheme', async () => {
    const handler = createBundleHandler({ rendererDir: ROOT, readFile: () => Promise.resolve(new Uint8Array()) });
    expect((await handler(new Request('app://evil.example/index.html'))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. external:open - the allow-list table and the [R2] calendarEvent bypass strings
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] external:open opens only app-chosen URLs', () => {
  const ITEM_ID = 1 as ItemId;
  /** The window state every handler is given; `external:open` does not read it, but the signature requires it. */
  const FAKE_CTX = { windowFocused: true, windowVisible: true, shownByNotificationAt: null };
  const START = Date.UTC(2026, 8, 25, 12, 0, 0) as EpochMs;

  /** Every hostile "calendar link" an item row could carry after a poisoned MCP result. */
  const BYPASS_LINKS = [
    'https://www-google.com/',
    'https://wwwXgoogle.com/',
    'https://www.google.com/url?q=https://evil.example',
    'https://www.google.com@evil.example/',
    'https://calendar.google.com@evil.example/calendar/r/day/2026/09/25',
    'https://evil.example/#https://calendar.google.com/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:fetch("https://evil.example")',
  ];

  function handlersWith(item: Item | null): {
    handlers: ReturnType<typeof createAppHandlers>;
    opened: string[];
  } {
    const opened: string[] = [];
    const deps = {
      repos: { items: { byId: () => item } },
      settings: { get: () => ({ general: { timeZone: 'Asia/Jerusalem', language: 'en' } }) },
      electron: {
        openExternal: (url: string) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
      links: JSON.parse(read('resources/links.json')) as Record<string, string>,
      clock: { now: () => START },
      audit: () => undefined,
      log: silentLog,
    } as unknown as HandlerDeps;
    return { handlers: createAppHandlers(deps), opened };
  }

  const poisonedItem = (link: string): Item =>
    ({
      id: ITEM_ID,
      eventStartTs: START,
      calendarHtmlLink: link,
      calendarEventId: 'evt_1',
    }) as unknown as Item;

  it.each(BYPASS_LINKS)('never opens the MCP-supplied htmlLink %s', async (link) => {
    const { handlers, opened } = handlersWith(poisonedItem(link));
    const res = await handlers['external:open']({ itemId: ITEM_ID, target: 'calendarEvent' } as never, FAKE_CTX);
    expect(res.ok).toBe(true);
    expect(opened).toEqual(['https://calendar.google.com/calendar/r/day/2026/09/25']);
    expect(opened[0]!.startsWith(`${CALENDAR_DAY_URL_PREFIX}/`)).toBe(true);
    expect(opened.some((u) => u.includes('evil.example'))).toBe(false);
  });

  it('opens nothing when the item has no event start', async () => {
    const { handlers, opened } = handlersWith({ ...poisonedItem(BYPASS_LINKS[0]!), eventStartTs: null });
    const res = await handlers['external:open']({ itemId: ITEM_ID, target: 'calendarEvent' } as never, FAKE_CTX);
    expect(res.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('opens nothing for an unknown item', async () => {
    const { handlers, opened } = handlersWith(null);
    const res = await handlers['external:open']({ itemId: 2 as ItemId, target: 'calendarEvent' } as never, FAKE_CTX);
    expect(res.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('builds the day URL from digits only, in the app time zone', () => {
    expect(calendarDayUrl(START, 'Asia/Jerusalem')).toBe('https://calendar.google.com/calendar/r/day/2026/09/25');
    expect(calendarDayUrl(START, 'UTC')).toBe('https://calendar.google.com/calendar/r/day/2026/09/25');
    expect(calendarDayUrl(START, 'Pacific/Kiritimati')).toBe('https://calendar.google.com/calendar/r/day/2026/09/26');
    expect(calendarDayUrl(START, 'Not/AZone')).toBeNull();
    expect(calendarDayUrl(START, '../../evil')).toBeNull();
  });

  it('resolves every enum target through resources/links.json, https only', async () => {
    const { handlers, opened } = handlersWith(null);
    for (const target of EXTERNAL_TARGETS) {
      await handlers['external:open']({ target } as never, FAKE_CTX);
    }
    expect(opened).toHaveLength(EXTERNAL_TARGETS.length);
    for (const url of opened) expect(url.startsWith('https://')).toBe(true);
  });

  it('opens nothing when links.json holds a non-https entry', async () => {
    const opened: string[] = [];
    const deps = {
      repos: { items: { byId: () => null } },
      settings: { get: () => ({ general: { timeZone: 'UTC', language: 'en' } }) },
      electron: {
        openExternal: (url: string) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
      links: {
        ...(JSON.parse(read('resources/links.json')) as Record<string, string>),
        project_readme: 'http://evil.example',
      },
      clock: { now: () => START },
      audit: () => undefined,
      log: silentLog,
    } as unknown as HandlerDeps;
    const handlers = createAppHandlers(deps);
    const res = await handlers['external:open']({ target: 'project_readme' } as never, FAKE_CTX);
    expect(res.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('the IPC schema itself makes a renderer-supplied URL unrepresentable', () => {
    const schema = IPC_REQUEST_SCHEMAS['external:open'];
    expect(schema.safeParse({ url: 'https://evil.example' }).success).toBe(false);
    expect(schema.safeParse({ target: 'not_a_target' }).success).toBe(false);
    expect(schema.safeParse({ target: 'project_readme', url: 'https://evil.example' }).success).toBe(false);
    expect(schema.safeParse({ itemId: 'itm_1', target: 'calendarEvent', url: 'https://evil.example' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ target: 'project_readme' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. production bundle carries no E2E seam strings (TESTS 4.1 / concern C9)
// ---------------------------------------------------------------------------------------------------------------------
describe('TESTS 4.1 - the build-time seam lock', () => {
  const SEAM_STRINGS = ['WCA_E2E', 'WCA_BRIDGE_CMD', 'WCA_LLM', '__wcaTest', 'stub-llm'];
  const OUT_MAIN = join(REPO_ROOT, 'out', 'main');
  const E2E_MARKER = join(REPO_ROOT, 'out', '.e2e-build');

  it("imports testSeams only behind an `import.meta.env.MODE === 'e2e'` guard (source lock)", () => {
    for (const rel of ['src/main/compose.ts', 'src/main/index.ts']) {
      const src = read(rel);
      // A `import type { Seams }` is erased by the compiler and carries no seam CODE; only a value import matters.
      const valueImport = /^\s*import\s+(?!type\b)[^;]*from\s+'[^']*testSeams'/m.test(src);
      const dynamicImport = /import\(\s*'[^']*testSeams'\s*\)/.test(src);
      if (!valueImport && !dynamicImport) continue;
      expect(src, `${rel} must gate its seam use on MODE === 'e2e'`).toMatch(
        /import\.meta\.env(?:\?)?\.MODE\s*===\s*'e2e'/,
      );
      expect(valueImport, `${rel} must import testSeams dynamically so the production build folds it away`).toBe(false);
    }
    // Only `testSeams.ts` may contain seam CODE. Comments are prose (several modules legitimately cite `WCA_*` in a
    // doc comment), so they are stripped before the scan.
    const seamOwners = ['src/main/testSeams.ts'];
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry) || /\.fixtures\.ts$/.test(entry)) continue;
        const rel = relative(REPO_ROOT, full).replaceAll(sep, '/');
        if (seamOwners.includes(rel)) continue;
        const code = stripComments(readFileSync(full, 'utf8'));
        // [V2] WCA_MCP_TOKEN is a PRODUCTION env name (C2 13 CLAUDE_S3_ENV_KEYS: the S3 tool-server token the CLI expands from
        // --mcp-config), not a test seam; every other WCA_* name stays seam-only.
        if (/WCA_(?!MCP_TOKEN\b)[A-Z0-9_]+/.test(code)) offenders.push(rel);
      }
    };
    walk(join(REPO_ROOT, 'src'));
    expect(offenders, 'only src/main/testSeams.ts may name the seam environment variables').toEqual([]);
  });

  it('a PRODUCTION out/main contains none of the seam strings', () => {
    if (!existsSync(OUT_MAIN)) {
      // No bundle in the tree: the source lock above is the guarantee, and the packaged smoke (TESTS 11) re-checks it.
      expect(existsSync(join(REPO_ROOT, 'src', 'main', 'testSeams.ts'))).toBe(true);
      return;
    }
    if (existsSync(E2E_MARKER)) {
      // out/ currently holds an `--mode e2e` build (scripts/mark-e2e-build.mjs). Asserting the production lock against
      // it would be wrong; the e2e bundle is SUPPOSED to carry the seams. Assert the inverse instead: the marker and the
      // seam code always travel together, so no production build can be mistaken for an e2e one.
      const bundle = readdirSync(OUT_MAIN)
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(OUT_MAIN, f), 'utf8'))
        .join('\n');
      expect(SEAM_STRINGS.some((s) => bundle.includes(s))).toBe(true);
      return;
    }
    const bundle = readdirSync(OUT_MAIN)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(OUT_MAIN, f), 'utf8'))
      .join('\n');
    for (const s of SEAM_STRINGS) expect(bundle.includes(s), `production bundle leaks ${s}`).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. electron-builder.yml + installer.nsh (ARCH 15.2)
// ---------------------------------------------------------------------------------------------------------------------
describe('ARCH 15.2 - electron-builder configuration', () => {
  const raw = read('electron-builder.yml');
  /** Comments carry prose (including the words "NO asarUnpack"); the rules below read the CONFIG, not the prose. */
  const yml = raw.replace(/(^|\s)#[^\n]*/g, '$1');

  /** Minimal YAML reader for the flat `key: value` lines this file uses; no new dependency (ARCH 16). */
  const scalar = (key: string): string | undefined => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*(?:#.*)?$`, 'm').exec(yml);
    return m?.[1];
  };

  it('declares the exact fuse wire of ARCH 15.2', () => {
    const fuses = /electronFuses:\s*\n((?:\s{2,}.*\n)+)/.exec(yml)?.[1] ?? '';
    const parsed = Object.fromEntries(
      fuses
        .split('\n')
        .map((l) => /^\s*([A-Za-z]+):\s*(true|false)/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1]!, m[2] === 'true']),
    );
    expect(parsed).toEqual({
      runAsNode: true, // REQUIRED by the MCP stdio child (A4)
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: false,
      enableCookieEncryption: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  it('ships asar, rebuilds nothing native and unpacks nothing', () => {
    expect(scalar('asar')).toBe('true');
    expect(scalar('npmRebuild')).toBe('false');
    expect(yml).not.toMatch(/asarUnpack/);
  });

  it('names the app id, product name and the x64 nsis target of ARCH 15.2', () => {
    expect(scalar('appId')).toBe('com.ilay.whatsapp-calendar-agent');
    expect(scalar('productName')).toBe('WhatsApp Calendar Agent');
    expect(yml).toMatch(/target:\s*nsis/);
    expect(yml).toMatch(/requestedExecutionLevel:\s*asInvoker/);
  });

  it('never lets the installer kill a foreign process image', () => {
    const nsh = join(REPO_ROOT, 'build', 'installer.nsh');
    if (!existsSync(nsh)) return; // owned by W2-04; the rule below is re-asserted there
    const text = readFileSync(nsh, 'utf8');
    expect(text).not.toMatch(/\/IM\s+"?whatsapp-bridge\.exe/i);
    expect(text).not.toMatch(/\/IM\s+"?llama-server\.exe/i);
    if (/taskkill/i.test(text)) {
      expect(text).toMatch(/\/IM\s+"WhatsApp Calendar Agent\.exe"/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. [R2] forbidden packages: direct deps only + exact pins + no native addon anywhere in the production tree
// ---------------------------------------------------------------------------------------------------------------------
describe('[R2] ARCH 16 - dependency rules', () => {
  interface Pkg {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }
  interface LockEntry {
    version?: string;
    dev?: boolean;
    gypfile?: boolean;
    hasInstallScript?: boolean;
  }
  const pkg = JSON.parse(read('package.json')) as Pkg;
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, LockEntry> };

  const FORBIDDEN = [
    'node-llama-cpp',
    'better-sqlite3',
    'electron-rebuild',
    'electron-store',
    'electron-updater',
    'openai',
    'ajv',
    'ipull',
    'tree-kill',
    'dependency-cruiser',
  ];
  const FORBIDDEN_PREFIXES = ['@electron-toolkit/', 'i18next-'];
  /** Explicitly allowed as TRANSITIVE occurrences only (ARCH 16). */
  const ALLOWED_TRANSITIVE = ['ajv', 'ajv-formats'];

  const directs = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

  it('lists no forbidden package as a direct dependency', () => {
    const offenders = Object.keys(directs).filter(
      (name) => FORBIDDEN.includes(name) || FORBIDDEN_PREFIXES.some((p) => name.startsWith(p)),
    );
    expect(offenders).toEqual([]);
  });

  it('declares no forbidden package at the lockfile root', () => {
    // A "root-declared" entry is `node_modules/<name>` at depth 1 - i.e. hoisted AND named by the root manifest.
    const rootDeclared = Object.keys(lock.packages)
      .filter((p) => p.startsWith('node_modules/'))
      .map((p) => p.slice('node_modules/'.length))
      .filter((name) => !name.includes('/node_modules/'))
      .filter((name) => name in directs);
    const offenders = rootDeclared.filter(
      (name) =>
        (FORBIDDEN.includes(name) || FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) &&
        !ALLOWED_TRANSITIVE.includes(name),
    );
    expect(offenders).toEqual([]);
  });

  it('allows ajv / ajv-formats only as a transitive of @modelcontextprotocol/sdk or eslint', () => {
    for (const name of ALLOWED_TRANSITIVE) {
      expect(name in directs, `${name} must not be a direct dependency`).toBe(false);
    }
  });

  it('pins every direct dependency exactly (no ^, no ~, no range)', () => {
    const loose = Object.entries(directs).filter(([, range]) => !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(range));
    expect(loose).toEqual([]);
  });

  it('has no native addon anywhere in the production tree', () => {
    const native = Object.entries(lock.packages)
      .filter(([p]) => p !== '')
      .filter(([, entry]) => entry.dev !== true)
      .filter(([, entry]) => entry.gypfile === true)
      .map(([p]) => p);
    expect(native, 'a production package declares binding.gyp / gypfile').toEqual([]);
  });

  // [V2] + opus-decoder (D-070, the only new v2 runtime dependency; pure JS/WASM, MIT)
  it('declares the seven pure-JS runtime dependencies of ARCH 16 + D-070 and nothing else', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(
      [
        '@anthropic-ai/sdk',
        '@google/genai',
        '@modelcontextprotocol/sdk',
        'electron-log',
        'i18next',
        'opus-decoder',
        'zod',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [V2] (owner V2-W2-02) T2 8.2 group 12a extensions: the forbidden packages of ARCH2 12 and the B18 SPDX licence allow-list over
// EVERY production entry of the lockfile (direct and transitive).
// ---------------------------------------------------------------------------------------------------------------------
describe('[V2] ARCH2 12 / B18 - forbidden v2 packages and the SPDX licence allow-list', () => {
  interface LockEntry {
    version?: string;
    dev?: boolean;
    license?: unknown;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lock = JSON.parse(read('package-lock.json')) as {
    lockfileVersion?: number;
    packages: Record<string, LockEntry>;
  };
  const nameOf = (lockPath: string): string =>
    lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
  /** Every production entry (npm marks dev-only entries `dev: true`; everything else ships or may ship). */
  const production = Object.entries(lock.packages).filter(([p, e]) => p !== '' && e.dev !== true);

  /** ARCH2 12 forbidden list (exact names, scopes and prefixes). */
  const V2_FORBIDDEN =
    /^(ogg-opus-decoder|codec-parser|sharp|canvas|@napi-rs\/.+|ffmpeg.*|@ffmpeg[^/]*\/.+|@ffmpeg-installer\/.+|@discordjs\/opus|node-opus|@anthropic-ai\/claude-agent-sdk|@anthropic-ai\/claude-code|@google\/gemini-cli)$/;
  const SPDX_ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense']); // Unlicense: D-075 (fast-sha256 via @anthropic-ai/sdk -> standardwebhooks)

  it('the lockfile is v3 (every entry carries its licence field) and the production tree is not empty', () => {
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(production.length).toBeGreaterThan(20);
    expect(production.map(([p]) => nameOf(p))).toContain('opus-decoder');
  });

  it('no ARCH2 12 forbidden package is a direct dependency (runtime or dev)', () => {
    const directs = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    expect(directs.filter((n) => V2_FORBIDDEN.test(n))).toEqual([]);
  });

  it('no ARCH2 12 forbidden package is anywhere in the production tree, nor referenced by a production entry', () => {
    const present = production.map(([p]) => nameOf(p)).filter((n) => V2_FORBIDDEN.test(n));
    expect(present).toEqual([]);
    const referenced: string[] = [];
    for (const [p, e] of production) {
      for (const dep of Object.keys({ ...(e.dependencies ?? {}), ...(e.optionalDependencies ?? {}) })) {
        if (V2_FORBIDDEN.test(dep)) referenced.push(`${nameOf(p)} -> ${dep}`);
      }
    }
    expect(referenced).toEqual([]);
  });

  it('the LGPL Ogg demuxer pair (ogg-opus-decoder / codec-parser) appears nowhere in the lockfile, dev included', () => {
    const anywhere = Object.keys(lock.packages)
      .filter((p) => p !== '')
      .map(nameOf)
      .filter((n) => n === 'ogg-opus-decoder' || n === 'codec-parser');
    expect(anywhere).toEqual([]);
  });

  it('the regex is not vacuous', () => {
    for (const n of ['sharp', 'canvas', '@napi-rs/canvas', 'ffmpeg-static', '@ffmpeg-installer/ffmpeg', 'node-opus'])
      expect(V2_FORBIDDEN.test(n), n).toBe(true);
    for (const n of ['opus-decoder', 'sharpen', 'zod']) expect(V2_FORBIDDEN.test(n), n).toBe(false);
  });

  it('every production package (direct AND transitive) carries an SPDX licence from the allow-list', () => {
    const offenders: string[] = [];
    for (const [p, e] of production) {
      const lic = e.license;
      if (typeof lic !== 'string' || !SPDX_ALLOWED.has(lic)) {
        offenders.push(`${nameOf(p)}@${e.version ?? '?'}: ${typeof lic === 'string' ? lic : 'missing'}`);
      }
    }
    expect(offenders, 'production packages outside the SPDX allow-list (missing / UNLICENSED / other)').toEqual([]);
  });
});
