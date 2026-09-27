// src/main/app/protocol.ts - app://bundle/ protocol with a traversal guard + production CSP (build-plan section 3; owner W1-12).
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { win32 as path } from 'node:path';

/** ARCHITECTURE 15.1 production CSP (response header). This is the enforced policy: every directive below is honoured
 *  because it arrives as a `Content-Security-Policy` response header from `createBundleHandler`. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

/** Directives Chromium refuses to honour inside a `<meta http-equiv>` CSP: it ignores them AND logs a console error
 *  for each one on every load. They must live on the response header only (they do - see `CSP`). */
export const META_IGNORED_DIRECTIVES = ['frame-ancestors', 'report-uri', 'sandbox'] as const;

/** The policy as it is written in `src/renderer/index.html`'s `<meta>` tag: `CSP` minus the directives a meta tag
 *  cannot carry, every remaining directive byte-identical (notably `connect-src 'none'`). Derived, never re-typed, so
 *  the meta tag and the header can never drift; `tests/security/electron-hardening.test.ts` pins the HTML to it. */
export const META_CSP = CSP.split('; ')
  .filter(
    (directive) => !META_IGNORED_DIRECTIVES.some((name) => directive === name || directive.startsWith(`${name} `)),
  )
  .join('; ');

export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
/** Must be registered at module top level, BEFORE app `ready` (ARCHITECTURE section 3). */
export const APP_SCHEME_PRIVILEGES = [
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
];
export const DEFAULT_DOCUMENT = 'index.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Content type from the file extension; never from the request. */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

const BACKSLASH = 0x5c;
const FIRST_PRINTABLE = 0x20;

/** A backslash or a C0 control character in a URL path is an attack, never a file name. */
function hasControlOrBackslash(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < FIRST_PRINTABLE || code === BACKSLASH) return true;
  }
  return false;
}

/** Pure traversal guard: maps app://bundle/<path> to a file under rendererDir or returns null ('..', drive letters, backslashes, encoded dots). */
export function resolveBundlePath(urlPathname: string, rendererDir: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (hasControlOrBackslash(decoded)) return null;
  if (decoded.includes(':')) return null; // drive letters, scheme-relative forms and alternate data streams
  const relative = decoded.replace(/^\/+/, '');
  const segments = relative.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  const root = path.normalize(rendererDir);
  const target = path.normalize(path.join(root, ...(segments.length === 0 ? [DEFAULT_DOCUMENT] : segments)));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(rootWithSep) ? target : null;
}

export interface ProtocolDeps {
  rendererDir: string; // out/renderer
  /** Injected so the handler is testable without the real bundle on disk (production: node:fs/promises.readFile). */
  readFile?: (filePath: string) => Promise<Uint8Array>;
  /** True only for the top-level call before app `ready`. */
  registerSchemes?: boolean;
}

/** The `protocol.handle` callback, exported so unit tests can drive it directly. */
export function createBundleHandler(deps: ProtocolDeps): (request: Request) => Promise<Response> {
  const read = deps.readFile ?? ((p: string) => readFile(p) as Promise<Uint8Array>);
  const deny = (status: number): Response =>
    new Response(null, { status, headers: { 'Content-Security-Policy': CSP } });
  return async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return deny(400);
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return deny(404);
    const file = resolveBundlePath(url.pathname, deps.rendererDir);
    if (file === null) return deny(403);
    let body: Uint8Array;
    try {
      body = await read(file);
    } catch {
      return deny(404);
    }
    // Node's DOM-less typings: hand Response a plain ArrayBuffer copy of the file.
    const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(file),
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    });
  };
}

/** Top-level (before `ready`): teaches Chromium that app:// is a standard, secure, fetchable scheme. */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged(APP_SCHEME_PRIVILEGES);
}

/** protocol.registerSchemesAsPrivileged (top level, before ready) + protocol.handle('app', ...) after ready, CSP header on every response. */
export function registerAppProtocol(deps: ProtocolDeps): void {
  if (deps.registerSchemes) registerAppSchemes();
  protocol.handle(APP_SCHEME, createBundleHandler(deps));
}
