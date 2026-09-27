// src/main/mcp/googleAuth.ts - Google wizard / sign-in service over the admin facade (build-plan section 3; owner W1-05).
// Nothing here ever logs, audits or returns the credentials file content, the client secret, an OAuth code or a token.
// The only URL this service may hand to `openExternal` is one whose host is exactly `accounts.google.com`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { win32 as path } from 'node:path';
import type { Clock, Logger } from '../deps';
import type { AppPaths } from '../paths';
import type { McpHost } from './host';
import type { McpAdminClient } from './adminClient';
import type { McpReadClient, McpErrorKind } from './readClient';
import type {
  AuditEntry,
  AuditKind,
  CalendarInfo,
  CredentialsProblem,
  EpochMs,
  GoogleWizardState,
  Result,
} from '../../shared/types';
import type { ErrorCode } from '../../shared/errors';

export interface GoogleAuthService {
  wizardState(): GoogleWizardState;
  /** Validates the FILE CONTENT (installed type, client id suffix, secret, localhost redirect, Google endpoints [R2]); writes gcp-oauth.keys.json; starts the host. */
  importCredentials(jsonText: string): Promise<Result<GoogleWizardState>>;
  /** manage-accounts add -> opens auth_url ONLY if host === accounts.google.com; polls list every 2 s for up to 5 min. */
  startSignIn(): Promise<Result<GoogleWizardState>>;
  status(): Promise<GoogleWizardState>;
  /** Stops the host, deletes tokens.json, clears the account. */
  disconnect(): Promise<Result<GoogleWizardState>>;
  listCalendars(): Promise<Result<CalendarInfo[]>>;
  onChange(cb: (s: GoogleWizardState) => void): () => void;
}
export interface GoogleAuthDeps {
  host: Pick<McpHost, 'start' | 'stop' | 'status' | 'onStatus'>;
  admin: McpAdminClient;
  read: Pick<McpReadClient, 'getCurrentTime'>; // connection smoke test after sign-in
  paths: Pick<AppPaths, 'googleDir' | 'googleCredentials' | 'googleTokens'>;
  openExternal: (url: string) => Promise<void>;
  clock: Clock;
  log: Logger;
  audit: (kind: AuditKind, ref: string | null, detail: AuditEntry['detail'], now: EpochMs) => void;
  targetCalendarId: () => string;
  fs?: {
    writeFile(path: string, text: string): Promise<void>;
    unlink(path: string): Promise<void>;
    exists(path: string): boolean;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// implementation (W1-05)
// ---------------------------------------------------------------------------------------------------------------------

/** A Desktop-app client JSON is a few hundred bytes; anything larger is not one. */
export const CREDENTIALS_MAX_BYTES = 64 * 1024;
/** [R2] The exact Google endpoints a genuine `installed` client file carries. A foreign token_uri would receive the
 *  client secret AND the authorization code, so a file that names one is refused and NOTHING is written to disk. */
export const GOOGLE_AUTH_URI = 'https://accounts.google.com/o/oauth2/auth';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CERT_URL = 'https://www.googleapis.com/oauth2/v1/certs';
/** The only host whose URL may be opened in the user's browser by this service. */
export const AUTH_URL_HOST = 'accounts.google.com';
/** `http://localhost`, optionally with a port and/or a trailing slash (Google's installed-app loopback form). */
export const LOCALHOST_REDIRECT_RE = /^http:\/\/localhost(:\d{1,5})?\/?$/;
export const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';
export const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
/** manage-accounts `add` expires after 5 minutes server-side (calendar-mcp.md 2 "OAuth flow"). */
export const SIGN_IN_POLL_MS = 2_000;
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (o: Json, k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);

/** Pure validation of a credentials JSON text: null = ok, else the first CredentialsProblem found. */
export function validateCredentialsJson(jsonText: string): CredentialsProblem | null {
  if (typeof jsonText !== 'string' || jsonText.length > CREDENTIALS_MAX_BYTES) return 'too_large';
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    return 'not_json';
  }
  if (!isObject(root)) return 'not_json';
  // A "Web application" client (top-level `web`) is the single most common mistake; it is still `not_installed_type`.
  const installed = root.installed;
  if (!isObject(installed)) return 'not_installed_type';
  const clientId = str(installed, 'client_id');
  if (clientId === null || !clientId.endsWith(CLIENT_ID_SUFFIX) || clientId.length <= CLIENT_ID_SUFFIX.length)
    return 'bad_client_id';
  const secret = str(installed, 'client_secret');
  if (secret === null || secret.length === 0) return 'no_secret';
  // [R2] Endpoint check FIRST: a file that names a foreign endpoint is rejected as bad_endpoint even when it has no
  //      localhost redirect at all (a hostile file would otherwise hide behind the friendlier problem code).
  for (const [key, expected] of [
    ['auth_uri', GOOGLE_AUTH_URI],
    ['token_uri', GOOGLE_TOKEN_URI],
    ['auth_provider_x509_cert_url', GOOGLE_CERT_URL],
  ] as const) {
    const value = installed[key];
    if (value !== undefined && value !== expected) return 'bad_endpoint';
  }
  const redirects = installed.redirect_uris;
  if (Array.isArray(redirects)) {
    for (const uri of redirects) {
      if (typeof uri !== 'string') return 'bad_endpoint';
      if (uri !== OOB_REDIRECT && !LOCALHOST_REDIRECT_RE.test(uri)) return 'bad_endpoint';
    }
    if (redirects.some((uri) => typeof uri === 'string' && LOCALHOST_REDIRECT_RE.test(uri))) return null;
  }
  return 'no_localhost_redirect';
}

/** `true` only for `https://accounts.google.com/...`. Everything else is refused and audited (never opened). */
export function isGoogleAuthUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.toLowerCase() === AUTH_URL_HOST;
  } catch {
    return false;
  }
}

/** McpErrorKind -> the ErrorCode the UI shows (CONTRACTS 2 gives each code exactly one action). */
export function errorCodeFor(kind: McpErrorKind): ErrorCode {
  switch (kind) {
    case 'auth':
      return 'CAL_RECONNECT';
    case 'port_busy':
      return 'CAL_PORT_BUSY';
    default:
      return 'CAL_UNAVAILABLE';
  }
}

function defaultFs(googleDir: string): NonNullable<GoogleAuthDeps['fs']> {
  return {
    async writeFile(file, text) {
      await fsp.mkdir(googleDir, { recursive: true });
      // 0o600: the file holds the client secret; the directory is already user-scoped under %APPDATA%.
      await fsp.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
    },
    async unlink(file) {
      await fsp.rm(file, { force: true });
    },
    exists: (file) => fs.existsSync(file),
  };
}

export function createGoogleAuth(deps: GoogleAuthDeps): GoogleAuthService {
  const io = deps.fs ?? defaultFs(deps.paths.googleDir);
  const cbs = new Set<(s: GoogleWizardState) => void>();
  let hasCredentials = io.exists(deps.paths.googleCredentials);
  let accountEmail: string | null = null;
  let code: ErrorCode | null = null;
  let credentialsProblem: CredentialsProblem | null = null;

  const snapshot = (): GoogleWizardState => ({
    status: deps.host.status(),
    hasCredentials,
    accountEmail,
    targetCalendarId: deps.targetCalendarId(),
    code,
    credentialsProblem,
  });
  const emit = (): void => {
    const s = snapshot();
    for (const cb of [...cbs]) cb(s);
  };
  deps.host.onStatus(() => emit());

  const fail = (c: ErrorCode): Result<GoogleWizardState> => {
    code = c;
    emit();
    return { ok: false, error: { code: c } };
  };
  const succeed = (): Result<GoogleWizardState> => {
    code = null;
    emit();
    return { ok: true, value: snapshot() };
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      deps.clock.setTimeout(() => resolve(), ms);
    });

  /** One `manage-accounts list` round trip; also refreshes the displayed account e-mail. */
  const pollAccount = async (): Promise<'active' | 'waiting' | McpErrorKind> => {
    const res = await deps.admin.manageAccounts('list');
    if (!res.ok) return res.error;
    if (res.value.action !== 'list') return 'bad_response';
    const personal = res.value.accounts.find((a) => a.accountId === 'personal');
    accountEmail = personal?.email ?? null;
    return personal !== undefined && personal.status === 'active' ? 'active' : 'waiting';
  };

  return {
    wizardState: snapshot,

    async importCredentials(jsonText) {
      const problem = validateCredentialsJson(jsonText);
      if (problem !== null) {
        // Nothing is written: a file naming a foreign token_uri never touches disk.
        credentialsProblem = problem;
        deps.log.warn('google.credentials_rejected', { problem });
        deps.audit(
          'settings_changed',
          null,
          { what: 'google_credentials', accepted: false, problem },
          deps.clock.now(),
        );
        return fail('GOOGLE_CREDENTIALS_INVALID');
      }
      credentialsProblem = null;
      try {
        await io.writeFile(deps.paths.googleCredentials, jsonText);
      } catch {
        // The text is never logged, so the failure is reported by code only.
        deps.log.error('google.credentials_write_failed', {});
        return fail('GOOGLE_CREDENTIALS_INVALID');
      }
      hasCredentials = true;
      deps.audit('settings_changed', null, { what: 'google_credentials', accepted: true }, deps.clock.now());
      const status = await deps.host.start();
      if (status === 'toolset_mismatch') return fail('CAL_TOOLSET_MISMATCH');
      if (status === 'port_busy') return fail('CAL_PORT_BUSY');
      if (status === 'unavailable' || status === 'not_configured') return fail('CAL_UNAVAILABLE');
      return succeed();
    },

    async startSignIn() {
      if (!hasCredentials) return fail('GOOGLE_CREDENTIALS_INVALID');
      const added = await deps.admin.manageAccounts('add');
      if (!added.ok) return fail(errorCodeFor(added.error));
      if (added.value.action !== 'add') return fail('CAL_UNAVAILABLE');
      const authUrl = added.value.authUrl;
      if (!isGoogleAuthUrl(authUrl)) {
        // The URL comes from the MCP server's response: untrusted. It is refused, audited and never opened.
        deps.audit('spawn_refused', null, { what: 'auth_url', reason: 'bad_host' }, deps.clock.now());
        deps.log.error('google.auth_url_refused', { reason: 'bad_host' });
        return fail('GOOGLE_CREDENTIALS_INVALID');
      }
      await deps.openExternal(authUrl);
      const deadline = deps.clock.now() + SIGN_IN_TIMEOUT_MS;
      for (;;) {
        const outcome = await pollAccount();
        if (outcome === 'active') break;
        if (outcome === 'auth') return fail('CAL_RECONNECT');
        if (outcome === 'port_busy') return fail('CAL_PORT_BUSY');
        if (deps.clock.now() >= deadline) return fail('GOOGLE_SIGNIN_TIMEOUT');
        await sleep(SIGN_IN_POLL_MS);
      }
      // Smoke test over the read facade (the frozen dep exposes getCurrentTime), then the calendar list for the picker.
      const smoke = await deps.read.getCurrentTime();
      if (!smoke.ok) return fail(errorCodeFor(smoke.error));
      const calendars = await deps.admin.listCalendars();
      if (!calendars.ok) return fail(errorCodeFor(calendars.error));
      deps.audit(
        'settings_changed',
        null,
        { what: 'google_signin', accepted: true, calendars: calendars.value.length },
        deps.clock.now(),
      );
      return succeed();
    },

    async status() {
      if (deps.host.status() !== 'not_configured') await pollAccount();
      return snapshot();
    },

    async disconnect() {
      await deps.host.stop();
      try {
        await io.unlink(deps.paths.googleTokens);
      } catch {
        deps.log.warn('google.tokens_unlink_failed', {});
      }
      accountEmail = null;
      credentialsProblem = null;
      deps.audit('settings_changed', null, { what: 'google_disconnect', accepted: true }, deps.clock.now());
      return succeed();
    },

    async listCalendars() {
      const res = await deps.admin.listCalendars();
      if (!res.ok) return { ok: false, error: { code: errorCodeFor(res.error) } };
      return { ok: true, value: res.value };
    },

    onChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
  };
}

/** Exported for the paths test: the wizard never builds a path itself, it uses AppPaths. */
export const GOOGLE_CREDENTIALS_FILE = 'gcp-oauth.keys.json';
export const GOOGLE_TOKENS_FILE = 'tokens.json';
export const googleFileIn = (dir: string, file: string): string => path.join(dir, file);
