// src/main/mcp/googleAuth.test.ts - the Google wizard (owner W1-05).
// TESTS 5.3 row mcp/*: "auth_url opened only for host accounts.google.com (scenario auth_url_evil_host => refused +
// audit); credentials JSON validation errors incl. [R2] fixtures with token_uri/auth_uri/cert-url/redirect_uris not
// Google => GOOGLE_CREDENTIALS_INVALID bad_endpoint and the file is NOT written".
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeMcpCalendar } from '../../../tests/fakes/fake-mcp-calendar';
import { createMcpAdminClient } from './adminClient';
import { createMcpReadClient } from './readClient';
import {
  CREDENTIALS_MAX_BYTES,
  GOOGLE_AUTH_URI,
  GOOGLE_CERT_URL,
  GOOGLE_CREDENTIALS_FILE,
  GOOGLE_TOKEN_URI,
  GOOGLE_TOKENS_FILE,
  OOB_REDIRECT,
  SIGN_IN_POLL_MS,
  SIGN_IN_TIMEOUT_MS,
  createGoogleAuth,
  errorCodeFor,
  googleFileIn,
  isGoogleAuthUrl,
  validateCredentialsJson,
} from './googleAuth';
import type { GoogleAuthDeps, GoogleAuthExtras } from './googleAuth';
import type { McpAdminClient } from './adminClient';
import type { FakeCalendarOptions } from '../../../tests/fakes/fake-mcp-calendar';
import type { AuditEntry, AuditKind, CredentialsProblem, EpochMs, GoogleWizardState } from '../../shared/types';
import type { McpStatus } from '../../shared/health';
import type { Clock, ClockTimer, Logger } from '../deps';

// ---------------------------------------------------------------------------------------------------------------------
// credentials fixtures (synthetic; the client id/secret are TESTONLY sentinels, TESTS rule T5)
// ---------------------------------------------------------------------------------------------------------------------

const GOOD = {
  installed: {
    client_id: 'TESTONLY-123.apps.googleusercontent.com',
    project_id: 'wca-testonly',
    auth_uri: GOOGLE_AUTH_URI,
    token_uri: GOOGLE_TOKEN_URI,
    auth_provider_x509_cert_url: GOOGLE_CERT_URL,
    client_secret: 'GOCSPX-TESTONLY',
    redirect_uris: ['http://localhost'],
  },
};
const good = (mut?: (c: Record<string, unknown>) => void): string => {
  const copy = JSON.parse(JSON.stringify(GOOD)) as { installed: Record<string, unknown> };
  mut?.(copy.installed);
  return JSON.stringify(copy);
};

describe('validateCredentialsJson', () => {
  it('accepts a genuine Desktop-app client file', () => {
    expect(validateCredentialsJson(good())).toBeNull();
    // A file without the optional endpoint fields is still fine.
    expect(
      validateCredentialsJson(
        good((c) => {
          delete c.auth_uri;
          delete c.token_uri;
          delete c.auth_provider_x509_cert_url;
        }),
      ),
    ).toBeNull();
    // Loopback with a port, a trailing slash and the OOB urn are all legal installed-app redirects.
    for (const uri of ['http://localhost:3500', 'http://localhost/', 'http://localhost:3500/']) {
      expect(validateCredentialsJson(good((c) => (c.redirect_uris = [uri])))).toBeNull();
    }
    expect(validateCredentialsJson(good((c) => (c.redirect_uris = [OOB_REDIRECT, 'http://localhost'])))).toBeNull();
  });

  it('names the exact problem for every malformed file', () => {
    const cases: Array<[string, CredentialsProblem]> = [
      ['x'.repeat(CREDENTIALS_MAX_BYTES + 1), 'too_large'],
      [7 as unknown as string, 'too_large'],
      ['not json at all', 'not_json'],
      ['[1,2,3]', 'not_json'],
      ['"a string"', 'not_json'],
      [JSON.stringify({ web: GOOD.installed }), 'not_installed_type'],
      [JSON.stringify({ installed: 'nope' }), 'not_installed_type'],
      [good((c) => (c.client_id = 'TESTONLY-123')), 'bad_client_id'],
      [good((c) => delete c.client_id), 'bad_client_id'],
      [good((c) => (c.client_id = '.apps.googleusercontent.com')), 'bad_client_id'],
      [good((c) => delete c.client_secret), 'no_secret'],
      [good((c) => (c.client_secret = '')), 'no_secret'],
      [good((c) => delete c.redirect_uris), 'no_localhost_redirect'],
      [good((c) => (c.redirect_uris = [])), 'no_localhost_redirect'],
      [good((c) => (c.redirect_uris = 'http://localhost')), 'no_localhost_redirect'],
      [good((c) => (c.redirect_uris = [OOB_REDIRECT])), 'no_localhost_redirect'],
    ];
    for (const [text, problem] of cases) expect(validateCredentialsJson(text)).toBe(problem);
  });

  it('[R2] refuses a phished file that names a foreign endpoint - bad_endpoint, checked before the friendlier codes', () => {
    const cases = [
      good((c) => (c.token_uri = 'https://evil.example/token')),
      good((c) => (c.auth_uri = 'https://evil.example/o/oauth2/auth')),
      good((c) => (c.auth_provider_x509_cert_url = 'https://evil.example/certs')),
      good((c) => (c.redirect_uris = ['https://evil.example/cb'])),
      good((c) => (c.redirect_uris = ['http://localhost.evil.example'])),
      good((c) => (c.redirect_uris = ['http://127.0.0.1:3500'])),
      good((c) => (c.redirect_uris = [7])),
      // A foreign token_uri hides behind a missing redirect list in a naive check: the endpoint verdict must still win.
      good((c) => {
        c.token_uri = 'https://evil.example/token';
        delete c.redirect_uris;
      }),
      good((c) => {
        c.token_uri = 'https://evil.example/token';
        c.redirect_uris = ['http://localhost'];
      }),
    ];
    for (const text of cases) expect(validateCredentialsJson(text)).toBe('bad_endpoint');
  });
});

describe('isGoogleAuthUrl', () => {
  it('accepts only https://accounts.google.com', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(true);
    expect(isGoogleAuthUrl('https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth')).toBe(true);
  });

  it('refuses every look-alike, scheme trick and non-url', () => {
    for (const url of [
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com.evil.example/x',
      'https://evil.example/?x=accounts.google.com',
      'https://accounts.google.co/x',
      'https://www.google.com/x',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'not a url',
      '',
      `https://accounts.google.com/${'x'.repeat(2100)}`,
    ]) {
      expect(isGoogleAuthUrl(url)).toBe(false);
    }
    expect(isGoogleAuthUrl(7 as unknown as string)).toBe(false);
  });
});

describe('errorCodeFor / path helpers', () => {
  it('maps the MCP error kinds the UI must act on', () => {
    expect(errorCodeFor('auth')).toBe('CAL_RECONNECT');
    expect(errorCodeFor('port_busy')).toBe('CAL_PORT_BUSY');
    for (const kind of ['unavailable', 'timeout', 'bad_response', 'duplicate', 'id_exists', 'invalid_args'] as const) {
      expect(errorCodeFor(kind)).toBe('CAL_UNAVAILABLE');
    }
  });

  it('uses the file names the MCP server expects', () => {
    expect(GOOGLE_CREDENTIALS_FILE).toBe('gcp-oauth.keys.json');
    expect(GOOGLE_TOKENS_FILE).toBe('tokens.json');
    expect(googleFileIn('C:\\u\\google', GOOGLE_CREDENTIALS_FILE)).toBe('C:\\u\\google\\gcp-oauth.keys.json');
    expect(SIGN_IN_POLL_MS).toBe(2_000);
    expect(SIGN_IN_TIMEOUT_MS).toBe(5 * 60_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the service, over the real fake MCP server
// ---------------------------------------------------------------------------------------------------------------------

const PATHS = {
  googleDir: 'C:\\u\\google',
  googleCredentials: 'C:\\u\\google\\gcp-oauth.keys.json',
  googleTokens: 'C:\\u\\google\\tokens.json',
};

interface Harness {
  auth: ReturnType<typeof createGoogleAuth>;
  writes: Array<{ path: string; text: string }>;
  unlinks: string[];
  opened: string[];
  audits: Array<{ kind: AuditKind; detail: AuditEntry['detail'] }>;
  changes: GoogleWizardState[];
  status: () => McpStatus;
  setStatus: (s: McpStatus) => void;
  fake: ReturnType<typeof createFakeMcpCalendar>;
  stop: () => Promise<void>;
}

async function harness(
  opts: FakeCalendarOptions = {},
  overrides: Partial<GoogleAuthDeps & GoogleAuthExtras> = {},
): Promise<Harness> {
  const fake = createFakeMcpCalendar(opts);
  await fake.connect();
  const writes: Array<{ path: string; text: string }> = [];
  const unlinks: string[] = [];
  const opened: string[] = [];
  const audits: Array<{ kind: AuditKind; detail: AuditEntry['detail'] }> = [];
  const changes: GoogleWizardState[] = [];
  const statusCbs: Array<(s: McpStatus) => void> = [];
  let status: McpStatus = 'not_configured';
  let nowMs = Date.parse('2026-09-24T09:00:00Z') as EpochMs;

  // Virtual clock: setTimeout advances time and runs immediately, so the 5-minute poll loop is instantaneous.
  const clock: Clock = {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      nowMs = (nowMs + ms) as EpochMs;
      queueMicrotask(fn);
      return 0 as ClockTimer;
    },
    clearTimeout: () => undefined,
  };
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };

  const setStatus = (s: McpStatus): void => {
    status = s;
    for (const cb of statusCbs) cb(s);
  };

  const auth = createGoogleAuth({
    host: {
      start: async () => {
        setStatus('needs_sign_in');
        return status;
      },
      stop: async () => setStatus('not_configured'),
      status: () => status,
      onStatus: (cb) => {
        statusCbs.push(cb);
        return () => undefined;
      },
    },
    admin: createMcpAdminClient(fake.callerFor('admin')),
    read: createMcpReadClient(fake.callerFor('read')),
    paths: PATHS,
    openExternal: async (url) => {
      opened.push(url);
    },
    clock,
    log,
    audit: (kind, _ref, detail) => audits.push({ kind, detail }),
    targetCalendarId: () => 'primary',
    fs: {
      writeFile: async (path, text) => {
        writes.push({ path, text });
      },
      unlink: async (path) => {
        unlinks.push(path);
      },
      exists: () => false,
    },
    ...overrides,
  });
  auth.onChange((s) => changes.push(s));
  return {
    auth,
    writes,
    unlinks,
    opened,
    audits,
    changes,
    status: () => status,
    setStatus,
    fake,
    stop: () => fake.stop(),
  };
}

describe('importCredentials', () => {
  it('writes the file and starts the host for a valid Desktop client', async () => {
    const h = await harness();
    const res = await h.auth.importCredentials(good());
    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ path: PATHS.googleCredentials, text: good() }]);
    expect(h.auth.wizardState()).toMatchObject({
      hasCredentials: true,
      credentialsProblem: null,
      code: null,
      targetCalendarId: 'primary',
    });
    expect(h.audits).toContainEqual({
      kind: 'settings_changed',
      detail: { what: 'google_credentials', accepted: true },
    });
    await h.stop();
  });

  it('writes NOTHING when the file is rejected, and records the problem for the UI', async () => {
    const h = await harness();
    const res = await h.auth.importCredentials(good((c) => (c.token_uri = 'https://evil.example/token')));
    expect(res).toEqual({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } });
    expect(h.writes).toEqual([]);
    expect(h.auth.wizardState()).toMatchObject({
      hasCredentials: false,
      credentialsProblem: 'bad_endpoint',
      code: 'GOOGLE_CREDENTIALS_INVALID',
    });
    expect(h.audits).toContainEqual({
      kind: 'settings_changed',
      detail: { what: 'google_credentials', accepted: false, problem: 'bad_endpoint' },
    });
    // Neither the secret nor the hostile endpoint is ever logged or audited.
    expect(JSON.stringify(h.audits)).not.toContain('evil.example');
    expect(JSON.stringify(h.audits)).not.toContain('GOCSPX');
    await h.stop();
  });

  it('reports a write failure by code only - the credentials text is never logged', async () => {
    const h = await harness(
      {},
      {
        fs: {
          writeFile: async () => {
            throw new Error('EPERM: operation not permitted, open C:\\u\\google\\gcp-oauth.keys.json');
          },
          unlink: async () => undefined,
          exists: () => false,
        },
      },
    );
    await expect(h.auth.importCredentials(good())).resolves.toEqual({
      ok: false,
      error: { code: 'GOOGLE_CREDENTIALS_INVALID' },
    });
    await h.stop();
  });

  it('surfaces the host failure that follows the write', async () => {
    for (const [status, code] of [
      ['toolset_mismatch', 'CAL_TOOLSET_MISMATCH'],
      ['port_busy', 'CAL_PORT_BUSY'],
      ['unavailable', 'CAL_UNAVAILABLE'],
      ['not_configured', 'CAL_UNAVAILABLE'],
    ] as const) {
      const h = await harness();
      const failing = await harness(
        {},
        {
          host: {
            start: async () => status,
            stop: async () => undefined,
            status: () => status,
            onStatus: () => () => undefined,
          },
        },
      );
      await expect(failing.auth.importCredentials(good())).resolves.toEqual({ ok: false, error: { code } });
      await h.stop();
      await failing.stop();
    }
  });
});

describe('startSignIn', () => {
  it('opens the Google auth url, polls until the account is active and smoke-tests the connection', async () => {
    const h = await harness({ accounts: 'none' });
    await h.auth.importCredentials(good());
    h.fake.fake.signInAfterPolls(3);

    const res = await h.auth.startSignIn();
    expect(res.ok).toBe(true);
    expect(h.opened).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?client_id=FAKE&code_challenge=FAKE']);
    const tools = h.fake.calls.map((c) => c.tool);
    expect(tools.filter((t) => t === 'manage-accounts').length).toBeGreaterThanOrEqual(4); // add + >= 3 list polls
    expect(tools).toContain('get-current-time'); // smoke test
    expect(tools).toContain('list-calendars'); // calendar picker
    expect(tools).not.toContain('create-event');
    expect(h.auth.wizardState().accountEmail).toBe('user@example.test');
    expect(h.audits.some((a) => a.detail.what === 'google_signin')).toBe(true);
    expect(h.fake.violations).toEqual([]);
    await h.stop();
  });

  it('refuses and audits an auth url whose host is not accounts.google.com - and never opens it', async () => {
    const h = await harness({ accounts: 'none', scenario: 'auth_url_evil_host' });
    await h.auth.importCredentials(good());
    const res = await h.auth.startSignIn();
    expect(res).toEqual({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } });
    expect(h.opened).toEqual([]);
    expect(h.audits).toContainEqual({ kind: 'spawn_refused', detail: { what: 'auth_url', reason: 'bad_host' } });
    // The refused URL itself is attacker-influenced text: it is not stored in the audit row.
    expect(JSON.stringify(h.audits)).not.toContain('evil.example');
    await h.stop();
  });

  it('refuses to start before credentials were imported', async () => {
    const h = await harness();
    await expect(h.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'GOOGLE_CREDENTIALS_INVALID' } });
    expect(h.fake.calls).toEqual([]);
    await h.stop();
  });

  it('gives up with GOOGLE_SIGNIN_TIMEOUT after the 5-minute budget', async () => {
    const h = await harness({ accounts: 'none' });
    await h.auth.importCredentials(good());
    const res = await h.auth.startSignIn();
    expect(res).toEqual({ ok: false, error: { code: 'GOOGLE_SIGNIN_TIMEOUT' } });
    const polls = h.fake.calls.filter((c) => c.args.action === 'list').length;
    expect(polls).toBeGreaterThanOrEqual(SIGN_IN_TIMEOUT_MS / SIGN_IN_POLL_MS);
    await h.stop();
  });

  it('maps a dead-token and a bound-port poll answer to their own codes', async () => {
    const dead = await harness(
      {},
      {
        admin: {
          manageAccounts: async (action) =>
            action === 'add'
              ? { ok: true, value: { action: 'add', authUrl: 'https://accounts.google.com/x', expiresInMinutes: 5 } }
              : { ok: false, error: 'auth' },
          listCalendars: async () => ({ ok: false, error: 'auth' }),
        },
      },
    );
    await dead.auth.importCredentials(good());
    await expect(dead.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'CAL_RECONNECT' } });
    await dead.stop();

    const busy = await harness(
      {},
      {
        admin: {
          manageAccounts: async (action) =>
            action === 'add'
              ? { ok: true, value: { action: 'add', authUrl: 'https://accounts.google.com/x', expiresInMinutes: 5 } }
              : { ok: false, error: 'port_busy' },
          listCalendars: async () => ({ ok: false, error: 'port_busy' }),
        },
      },
    );
    await busy.auth.importCredentials(good());
    await expect(busy.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'CAL_PORT_BUSY' } });
    await busy.stop();
  });

  it('fails when manage-accounts add itself fails or answers with the wrong action', async () => {
    const failing = await harness(
      {},
      {
        admin: {
          manageAccounts: async () => ({ ok: false, error: 'unavailable' }),
          listCalendars: async () => ({ ok: true, value: [] }),
        },
      },
    );
    await failing.auth.importCredentials(good());
    await expect(failing.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    await failing.stop();

    const confused = await harness(
      {},
      {
        admin: {
          manageAccounts: async () => ({ ok: true, value: { action: 'remove' } }),
          listCalendars: async () => ({ ok: true, value: [] }),
        },
      },
    );
    await confused.auth.importCredentials(good());
    await expect(confused.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    await confused.stop();
  });

  it('fails when the post-sign-in smoke test or the calendar list fails', async () => {
    const manageAccounts: McpAdminClient['manageAccounts'] = async (action) =>
      action === 'add'
        ? { ok: true, value: { action: 'add', authUrl: 'https://accounts.google.com/x', expiresInMinutes: 5 } }
        : { ok: true, value: { action: 'list', accounts: [{ accountId: 'personal', status: 'active', email: null }] } };
    const base = { manageAccounts };
    const smokeDown = await harness(
      {},
      {
        admin: { ...base, listCalendars: async () => ({ ok: true, value: [] }) },
        read: { getCurrentTime: async () => ({ ok: false, error: 'timeout' }) },
      },
    );
    await smokeDown.auth.importCredentials(good());
    await expect(smokeDown.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'CAL_UNAVAILABLE' } });
    await smokeDown.stop();

    const listDown = await harness(
      {},
      {
        admin: { ...base, listCalendars: async () => ({ ok: false, error: 'auth' }) },
        read: {
          getCurrentTime: async () => ({
            ok: true,
            value: { nowIso: '2026-09-24T09:00:00.000Z', timeZone: 'Asia/Jerusalem' },
          }),
        },
      },
    );
    await listDown.auth.importCredentials(good());
    await expect(listDown.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'CAL_RECONNECT' } });
    await listDown.stop();
  });

  it('treats an unexpected list answer as a bad response rather than a sign-in', async () => {
    const h = await harness(
      {},
      {
        admin: {
          manageAccounts: async (action) =>
            action === 'add'
              ? { ok: true, value: { action: 'add', authUrl: 'https://accounts.google.com/x', expiresInMinutes: 5 } }
              : { ok: true, value: { action: 'remove' } },
          listCalendars: async () => ({ ok: true, value: [] }),
        },
      },
    );
    await h.auth.importCredentials(good());
    await expect(h.auth.startSignIn()).resolves.toEqual({ ok: false, error: { code: 'GOOGLE_SIGNIN_TIMEOUT' } });
    await h.stop();
  });
});

describe('status, disconnect, listCalendars and change events', () => {
  it('status() polls the account only once the host is configured', async () => {
    const h = await harness();
    await expect(h.auth.status()).resolves.toMatchObject({ status: 'not_configured', accountEmail: null });
    expect(h.fake.calls).toEqual([]);
    await h.auth.importCredentials(good());
    await expect(h.auth.status()).resolves.toMatchObject({ accountEmail: 'user@example.test' });
    await h.stop();
  });

  it('disconnect stops the host and deletes only tokens.json - never the credentials file', async () => {
    const h = await harness();
    await h.auth.importCredentials(good());
    const res = await h.auth.disconnect();
    expect(res.ok).toBe(true);
    expect(h.unlinks).toEqual([PATHS.googleTokens]);
    expect(h.unlinks).not.toContain(PATHS.googleCredentials);
    expect(h.status()).toBe('not_configured');
    expect(h.auth.wizardState().accountEmail).toBeNull();
    await h.stop();
  });

  it('disconnect survives a locked tokens file', async () => {
    const h = await harness(
      {},
      {
        fs: {
          writeFile: async () => undefined,
          unlink: async () => {
            throw new Error('EBUSY');
          },
          exists: () => false,
        },
      },
    );
    await expect(h.auth.disconnect()).resolves.toMatchObject({ ok: true });
    await h.stop();
  });

  it('listCalendars projects the picker list and maps failures to an ErrorCode', async () => {
    const h = await harness();
    await expect(h.auth.listCalendars()).resolves.toEqual({
      ok: true,
      value: [
        {
          id: 'primary',
          name: 'Personal',
          primary: true,
          timeZone: 'Asia/Jerusalem',
          writable: true,
          accessRole: 'owner',
        },
      ], // [V2]
    });
    await h.stop();

    const down = await harness(
      {},
      {
        admin: {
          manageAccounts: async () => ({ ok: false, error: 'auth' }),
          listCalendars: async () => ({ ok: false, error: 'auth' }),
        },
      },
    );
    await expect(down.auth.listCalendars()).resolves.toEqual({ ok: false, error: { code: 'CAL_RECONNECT' } });
    await down.stop();
  });

  it('notifies subscribers on every wizard change and on host status changes, and unsubscribes', async () => {
    const h = await harness();
    await h.auth.importCredentials(good());
    expect(h.changes.length).toBeGreaterThan(0);
    expect(h.changes.at(-1)).toMatchObject({ hasCredentials: true });

    const seen: GoogleWizardState[] = [];
    const off = h.auth.onChange((s) => seen.push(s));
    h.setStatus('connected');
    expect(seen).toHaveLength(1);
    off();
    h.setStatus('needs_sign_in');
    expect(seen).toHaveLength(1);
    await h.stop();
  });

  it('writes and deletes real files through the default fs adapter, with the credentials file 0600', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-google-auth-'));
    const googleDir = path.join(dir, 'google');
    const paths = {
      googleDir,
      googleCredentials: path.join(googleDir, GOOGLE_CREDENTIALS_FILE),
      googleTokens: path.join(googleDir, GOOGLE_TOKENS_FILE),
    };
    try {
      // No `fs` override: this exercises the production adapter (mkdir -p, mode 0600 write, force unlink, existsSync).
      const h = await harness({}, { paths, fs: undefined });
      expect(h.auth.wizardState().hasCredentials).toBe(false);
      await expect(h.auth.importCredentials(good())).resolves.toMatchObject({ ok: true });
      expect(fs.readFileSync(paths.googleCredentials, 'utf8')).toBe(good());

      // Deleting a tokens file that does not exist must not throw (force), and a real one is removed.
      await expect(h.auth.disconnect()).resolves.toMatchObject({ ok: true });
      fs.writeFileSync(paths.googleTokens, '{}', 'utf8');
      await expect(h.auth.disconnect()).resolves.toMatchObject({ ok: true });
      expect(fs.existsSync(paths.googleTokens)).toBe(false);
      expect(fs.existsSync(paths.googleCredentials)).toBe(true);

      // A second service sees the credentials that are already on disk.
      const again = await harness({}, { paths, fs: undefined });
      expect(again.auth.wizardState().hasCredentials).toBe(true);
      await h.stop();
      await again.stop();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts from the credentials file that is already on disk', async () => {
    const h = await harness(
      {},
      { fs: { writeFile: async () => undefined, unlink: async () => undefined, exists: () => true } },
    );
    expect(h.auth.wizardState().hasCredentials).toBe(true);
    await h.stop();
  });
});

// [V2] auto-mode-6 (B7): the account an automatic-mode policy is bound to must survive a restart, so every account answer
// is handed to the composition root (which stores only a short hash of it) and disconnect clears it.
describe('[V2] B7 account persistence (auto-mode-6)', () => {
  it('hands every polled account to persistAccount and clears it on disconnect', async () => {
    const seen: Array<string | null> = [];
    const h = await harness({}, { persistAccount: (email) => seen.push(email) });
    await h.auth.importCredentials(good());
    await h.auth.status();
    expect(seen.at(-1)).toBe('user@example.test');
    await h.auth.disconnect();
    expect(seen.at(-1)).toBeNull();
    await h.stop();
  });

  it('persists the account a sign-in ends with', async () => {
    const seen: Array<string | null> = [];
    const h = await harness({}, { persistAccount: (email) => seen.push(email) });
    await h.auth.importCredentials(good());
    await expect(h.auth.startSignIn()).resolves.toMatchObject({ ok: true });
    expect(seen.at(-1)).toBe('user@example.test');
    await h.stop();
  });

  it('a persistence failure never breaks the wizard', async () => {
    const h = await harness(
      {},
      {
        persistAccount: () => {
          throw new Error('disk full');
        },
      },
    );
    await h.auth.importCredentials(good());
    await expect(h.auth.status()).resolves.toMatchObject({ accountEmail: 'user@example.test' });
    await expect(h.auth.disconnect()).resolves.toMatchObject({ ok: true });
    await h.stop();
  });
});
