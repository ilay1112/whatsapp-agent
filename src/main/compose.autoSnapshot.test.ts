// src/main/compose.autoSnapshot.test.ts - auto-mode-6: the automatic-mode snapshot must bind a policy to the Google account
// it was granted under ACROSS RESTARTS (B7; v2-contracts C2 5 "googleAccountEmailSha8 '' when unknown =>
// AUTO_CALENDAR_NOT_OWNED").
//
// Before the fix the account came only from googleAuth's in-memory e-mail, which is null after every restart until a
// fresh sign-in, and the composition root hashed '' into a valid sha256 anyway. So (1) a policy enabled after a restart
// stayed valid after the user switched Google accounts and restarted, and (2) a policy enabled in the sign-in session was
// paused as snapshot_changed on the first automatic write after a restart.
//
// Everything runs against the REAL createGoogleAuth and the REAL compose.ts snapshot wiring; the admin facade is
// scripted (synthetic e-mails only), meta is an in-memory map, and a "restart" is a second service over the same meta.
import { describe, expect, it, vi } from 'vitest';
import { createAutoSnapshotSha, persistGoogleAccount } from './compose';
import { createGoogleAuth } from './mcp/googleAuth';
import type { McpAdminClient } from './mcp/adminClient';
import type { Clock, ClockTimer, Logger } from './deps';
import type { EpochMs, MetaKey, ProviderId } from '../shared/types';
import type { McpStatus } from '../shared/health';

const SHA256_HEX = /^[0-9a-f]{64}$/; // the shape autoPolicy.precondition() requires (else AUTO_CALENDAR_NOT_OWNED)
const ACCOUNT_A = 'owner-a@example.test';
const ACCOUNT_B = 'owner-b@example.test';

function memoryMeta(): { get(k: MetaKey): string | null; set(k: MetaKey, v: string): void; dump(): string } {
  const m = new Map<MetaKey, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), dump: () => JSON.stringify([...m]) };
}

/** The Google account the scripted MCP server currently reports (null = none signed in). */
const world = { email: null as string | null };

/** One app session: a fresh googleAuth (in-memory account = null, exactly like a restart) over the persisted meta. */
function session(meta: ReturnType<typeof memoryMeta>, provider: ProviderId = 'local') {
  let status: McpStatus = 'connected';
  const clock: Clock = {
    now: () => 0 as EpochMs,
    setTimeout: (fn) => {
      queueMicrotask(fn);
      return 0 as ClockTimer;
    },
    clearTimeout: () => undefined,
  };
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  const admin: McpAdminClient = {
    manageAccounts: async (action) =>
      action === 'list'
        ? {
            ok: true,
            value: {
              action: 'list',
              accounts: world.email === null ? [] : [{ accountId: 'personal', status: 'active', email: world.email }],
            },
          }
        : action === 'add'
          ? {
              ok: true,
              value: { action: 'add', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', expiresInMinutes: 5 },
            }
          : { ok: true, value: { action: 'remove' } },
    listCalendars: async () => ({ ok: true, value: [] }),
  };
  const auth = createGoogleAuth({
    host: {
      start: async () => status,
      stop: async () => {
        status = 'not_configured';
      },
      status: () => status,
      onStatus: () => () => undefined,
    },
    admin,
    read: {
      getCurrentTime: async () => ({
        ok: true,
        value: { nowIso: '2026-10-04T09:00:00.000Z', timeZone: 'Asia/Jerusalem' },
      }),
    },
    paths: {
      googleDir: 'C:\\u\\google',
      googleCredentials: 'C:\\u\\google\\c.json',
      googleTokens: 'C:\\u\\google\\t.json',
    },
    openExternal: async () => undefined,
    clock,
    log,
    audit: () => undefined,
    targetCalendarId: () => 'primary',
    fs: { writeFile: async () => undefined, unlink: async () => undefined, exists: () => true },
    persistAccount: persistGoogleAccount(meta),
  });
  const snapshotSha = createAutoSnapshotSha({
    accountEmail: () => auth.wizardState().accountEmail,
    meta,
    targetCalendarId: () => 'primary',
    provider: () => provider,
    appVersion: '2.0.0',
  });
  return { auth, snapshotSha };
}

describe('auto-mode-6: the automatic-mode snapshot is bound to the Google account across restarts', () => {
  it('an unknown account is not a hash (precondition => AUTO_CALENDAR_NOT_OWNED), never sha256 of an empty account', () => {
    world.email = null;
    const s = session(memoryMeta());
    expect(s.snapshotSha()).not.toMatch(SHA256_HEX);
  });

  it('scenario 2: a policy granted in the sign-in session keeps the SAME snapshot after a restart', async () => {
    const meta = memoryMeta();
    world.email = ACCOUNT_A;
    const first = session(meta);
    await first.auth.status(); // the wizard's account poll (sign-in / google:status)
    const granted = first.snapshotSha();
    expect(granted).toMatch(SHA256_HEX);

    const afterRestart = session(meta); // no poll at all in this session
    expect(afterRestart.snapshotSha()).toBe(granted);
  });

  it('scenario 1: switching Google accounts changes the snapshot, also after a restart', async () => {
    const meta = memoryMeta();
    world.email = ACCOUNT_A;
    const s1 = session(meta);
    await s1.auth.status();
    const grantedForA = s1.snapshotSha();

    // A restart: the policy's account is still A.
    const s2 = session(meta);
    expect(s2.snapshotSha()).toBe(grantedForA);
    // Disconnect: no account => unknown => not a hash (fail closed, no write can match the stored snapshot).
    await s2.auth.disconnect();
    expect(s2.snapshotSha()).not.toMatch(SHA256_HEX);
    // Sign in to ANOTHER account (the wizard's sign-in flow).
    world.email = ACCOUNT_B;
    await expect(s2.auth.startSignIn()).resolves.toMatchObject({ ok: true });
    const forB = s2.snapshotSha();
    expect(forB).toMatch(SHA256_HEX);
    expect(forB).not.toBe(grantedForA);

    // Restart before any automatic write: the snapshot must still be B's, never A's again.
    const s3 = session(meta);
    expect(s3.snapshotSha()).toBe(forB);
    expect(s3.snapshotSha()).not.toBe(grantedForA);
  });

  it('the account is matched case-insensitively and meta never holds the e-mail itself', async () => {
    const meta = memoryMeta();
    world.email = ACCOUNT_A.toUpperCase();
    const s = session(meta);
    await s.auth.status();
    const upper = s.snapshotSha();
    world.email = ACCOUNT_A;
    await s.auth.status();
    expect(s.snapshotSha()).toBe(upper);
    expect(meta.dump().toLowerCase()).not.toContain('example.test');
  });

  it('a corrupt persisted value is treated as unknown', () => {
    const meta = memoryMeta();
    meta.set('google_account_sha8', 'not-a-hash');
    world.email = null;
    expect(session(meta).snapshotSha()).not.toMatch(SHA256_HEX);
  });
});
