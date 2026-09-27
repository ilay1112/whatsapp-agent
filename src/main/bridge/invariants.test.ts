// TESTS 5.3 row `bridge/invariants.ts` (I6 / ARCHITECTURE A15): one test per violated precondition, plus the streamed hash.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_ENV_KEYS,
  BRIDGE_EXE,
  FORBIDDEN_BRIDGE_ARGS,
  OS_ENV_PASSTHROUGH,
  SPAWN_VIOLATIONS,
  SpawnInvariantError,
  assertBridgeSpawnInvariants,
  errorCodeForViolations,
  isPathInside,
  sha256OfFile,
  type BridgeSpawnPlan,
  type SpawnInvariantOptions,
  type SpawnViolation,
} from './invariants';

const root = mkdtempSync(join(tmpdir(), 'wca-inv-'));
const USER_DATA = join(root, 'userData');
const RESOURCES = join(root, 'resources');
const CWD = join(USER_DATA, 'bridge');
const OUTBOX = join(CWD, 'outbox-empty');
const EXE = join(RESOURCES, 'bridge', 'whatsapp-bridge.exe');
const DOORBELL_PORT = 51234;
const TOKEN = 'a'.repeat(64);
const SECRET = 'Zm9vYmFyLWJhemJhei1xdXV4LTEyMzQ1Njc4OQ'; // 38 base64url chars

mkdirSync(OUTBOX, { recursive: true });
mkdirSync(join(RESOURCES, 'bridge'), { recursive: true });
writeFileSync(EXE, 'dummy-exe-bytes');
const EXE_SHA = sha256OfFile(EXE);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const fs = { existsDir: (p: string) => p === CWD || p === OUTBOX, isEmptyDir: (p: string) => p === OUTBOX };

function goodEnv(over: Partial<Record<string, string>> = {}): BridgeSpawnPlan['env'] {
  return {
    WHATSAPP_BRIDGE_PORT: '51999',
    WHATSAPP_BRIDGE_TOKEN: TOKEN,
    WEBHOOK_URL: `http://127.0.0.1:${DOORBELL_PORT}/hook/${SECRET}`,
    FORWARD_SELF: 'true',
    WHATSAPP_MEDIA_ROOTS: OUTBOX,
    ...over,
  } as BridgeSpawnPlan['env'];
}
function goodPlan(over: Partial<BridgeSpawnPlan> = {}): BridgeSpawnPlan {
  return {
    exePath: EXE,
    args: [],
    cwd: CWD,
    env: goodEnv(),
    userDataDir: USER_DATA,
    outboxDir: OUTBOX,
    doorbellPort: DOORBELL_PORT,
    exeSha256: 'dead'.repeat(16),
    tosAccepted: true,
    ...over,
  };
}
const OPTS = { expectedSha256: 'dead'.repeat(16), resourcesDir: RESOURCES };

function violationsOf(plan: BridgeSpawnPlan, opts: SpawnInvariantOptions = OPTS): SpawnViolation[] {
  try {
    assertBridgeSpawnInvariants(plan, fs, opts);
  } catch (err) {
    if (err instanceof SpawnInvariantError) return err.violations;
    throw err;
  }
  return [];
}

describe('assertBridgeSpawnInvariants', () => {
  it('accepts the production plan', () => {
    expect(violationsOf(goodPlan())).toEqual([]);
  });

  it('tos_not_accepted', () => {
    expect(violationsOf(goodPlan({ tosAccepted: false }))).toEqual(['tos_not_accepted']);
  });

  it('cwd_outside_userdata', () => {
    expect(violationsOf(goodPlan({ cwd: join(root, 'elsewhere') }))).toEqual(['cwd_outside_userdata', 'cwd_missing']);
  });

  it('cwd traversal with `..` is refused even when it resolves back inside', () => {
    expect(violationsOf(goodPlan({ cwd: `${USER_DATA}\\bridge\\..\\bridge` }))).toContain('cwd_outside_userdata');
  });

  it('cwd_missing', () => {
    const missing = join(USER_DATA, 'bridge-missing');
    expect(violationsOf(goodPlan({ cwd: missing }))).toEqual(['cwd_missing']);
  });

  it('env_missing - one test per required variable', () => {
    for (const key of BRIDGE_ENV_KEYS) {
      const env = goodEnv();
      delete (env as Record<string, string | undefined>)[key];
      expect(violationsOf(goodPlan({ env }))).toContain('env_missing');
    }
  });

  it('env_missing when a required variable is empty', () => {
    expect(violationsOf(goodPlan({ env: goodEnv({ FORWARD_SELF: '' }) }))).toContain('env_missing');
  });

  it('env_extra for any key outside the minimal allow-list', () => {
    for (const rogue of ['ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'PATH']) {
      expect(violationsOf(goodPlan({ env: goodEnv({ [rogue]: 'x' }) }))).toContain('env_extra');
    }
  });

  it('the OS passthrough keys are allowed', () => {
    const env = goodEnv();
    for (const key of OS_ENV_PASSTHROUGH) (env as Record<string, string>)[key] = 'c:/windows';
    expect(violationsOf(goodPlan({ env }))).toEqual([]);
  });

  it('port_8080', () => {
    expect(violationsOf(goodPlan({ env: goodEnv({ WHATSAPP_BRIDGE_PORT: '8080' }) }))).toEqual(['port_8080']);
  });

  it('port_invalid', () => {
    for (const bad of ['0', 'abc', '70000', '-1', '']) {
      const v = violationsOf(goodPlan({ env: goodEnv({ WHATSAPP_BRIDGE_PORT: bad }) }));
      expect(v).toContain('port_invalid');
    }
  });

  it('token_weak', () => {
    for (const bad of ['short', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      expect(violationsOf(goodPlan({ env: goodEnv({ WHATSAPP_BRIDGE_TOKEN: bad }) }))).toContain('token_weak');
    }
  });

  it('webhook_not_loopback', () => {
    for (const bad of ['https://127.0.0.1:1/hook/x', `http://localhost:${DOORBELL_PORT}/hook/${SECRET}`, 'not a url']) {
      expect(violationsOf(goodPlan({ env: goodEnv({ WEBHOOK_URL: bad }) }))).toContain('webhook_not_loopback');
    }
  });

  it('webhook_wrong_port', () => {
    const env = goodEnv({ WEBHOOK_URL: `http://127.0.0.1:${DOORBELL_PORT + 1}/hook/${SECRET}` });
    expect(violationsOf(goodPlan({ env }))).toEqual(['webhook_wrong_port']);
  });

  it('webhook_no_secret', () => {
    for (const path of ['/hook/', '/hook/short', '/', '/webhook/' + SECRET]) {
      const env = goodEnv({ WEBHOOK_URL: `http://127.0.0.1:${DOORBELL_PORT}${path}` });
      expect(violationsOf(goodPlan({ env }))).toContain('webhook_no_secret');
    }
  });

  it('forward_self_not_true', () => {
    expect(violationsOf(goodPlan({ env: goodEnv({ FORWARD_SELF: 'false' }) }))).toEqual(['forward_self_not_true']);
  });

  it('outbox_missing', () => {
    const dir = join(CWD, 'outbox-gone');
    expect(violationsOf(goodPlan({ outboxDir: dir, env: goodEnv({ WHATSAPP_MEDIA_ROOTS: dir }) }))).toEqual([
      'outbox_missing',
    ]);
  });

  it('outbox_not_empty', () => {
    expect(violationsOf(goodPlan({ outboxDir: CWD, env: goodEnv({ WHATSAPP_MEDIA_ROOTS: CWD }) }))).toEqual([
      'outbox_not_empty',
    ]);
  });

  it('outbox_outside_userdata', () => {
    const outside = join(root, 'outbox');
    expect(violationsOf(goodPlan({ outboxDir: outside, env: goodEnv({ WHATSAPP_MEDIA_ROOTS: outside }) }))).toEqual([
      'outbox_missing',
      'outbox_outside_userdata',
    ]);
    // media roots pointing outside userData is enough on its own
    expect(violationsOf(goodPlan({ env: goodEnv({ WHATSAPP_MEDIA_ROOTS: outside }) }))).toEqual([
      'outbox_outside_userdata',
    ]);
  });

  it('exe_hash_mismatch (dummy fixture) => BRIDGE_BINARY_BLOCKED', () => {
    const v = violationsOf(goodPlan({ exeSha256: 'beef'.repeat(16) }));
    expect(v).toEqual(['exe_hash_mismatch']);
    expect(errorCodeForViolations(v)).toBe('BRIDGE_BINARY_BLOCKED');
  });

  it('a missing exe reaches the invariants as an empty hash', () => {
    expect(violationsOf(goodPlan({ exeSha256: '' }))).toEqual(['exe_hash_mismatch']);
  });

  it('exe_outside_resources', () => {
    const inUserData = join(USER_DATA, 'whatsapp-bridge.exe');
    expect(violationsOf(goodPlan({ exePath: inUserData }))).toEqual(['exe_outside_resources']);
    // without a resourcesDir the fallback rule is "never under userData"
    expect(violationsOf(goodPlan({ exePath: inUserData }), { expectedSha256: OPTS.expectedSha256 })).toEqual([
      'exe_outside_resources',
    ]);
    expect(
      violationsOf(goodPlan({ exePath: join(root, 'other.exe') }), { expectedSha256: OPTS.expectedSha256 }),
    ).toEqual([]);
  });

  it('args_not_empty', () => {
    expect(violationsOf(goodPlan({ args: ['--full-history-pair'] as unknown as readonly [] }))).toEqual([
      'args_not_empty',
    ]);
    expect(violationsOf(goodPlan({ args: ['--anything'] as unknown as readonly [] }))).toEqual(['args_not_empty']);
  });

  it('the e2e child-mode seam may pass its own argv, but never a forbidden flag', () => {
    const seamArgs = ['c:/repo/tests/fakes/fake-bridge.ts', '--control-port', '1'];
    const opts = { ...OPTS, allowedArgs: seamArgs, resourcesDir: undefined };
    expect(violationsOf(goodPlan({ args: seamArgs as unknown as readonly [] }), opts)).toEqual([]);
    const withForbidden = [...seamArgs, ...FORBIDDEN_BRIDGE_ARGS];
    expect(
      violationsOf(goodPlan({ args: withForbidden as unknown as readonly [] }), {
        ...opts,
        allowedArgs: withForbidden,
      }),
    ).toEqual(['args_not_empty']);
  });

  it('collects ALL violations, in SPAWN_VIOLATIONS order', () => {
    const v = violationsOf(
      goodPlan({
        tosAccepted: false,
        cwd: join(root, 'nope'),
        env: goodEnv({ WHATSAPP_BRIDGE_PORT: '8080', FORWARD_SELF: 'no' }),
        exeSha256: 'beef'.repeat(16),
      }),
    );
    expect(v).toEqual([
      'tos_not_accepted',
      'cwd_outside_userdata',
      'cwd_missing',
      'port_8080',
      'forward_self_not_true',
      'exe_hash_mismatch',
    ]);
    expect([...v].sort((a, b) => SPAWN_VIOLATIONS.indexOf(a) - SPAWN_VIOLATIONS.indexOf(b))).toEqual(v);
    expect(new SpawnInvariantError(v).message).toBe(v.join(','));
  });

  it('anything but a hash mismatch maps to BRIDGE_SPAWN_REFUSED', () => {
    expect(errorCodeForViolations(['tos_not_accepted'])).toBe('BRIDGE_SPAWN_REFUSED');
  });

  it('defaults to the vendored exe pin when no expectedSha256 is given', () => {
    const v = violationsOf(goodPlan({ exeSha256: BRIDGE_EXE.sha256.toUpperCase() }), { resourcesDir: RESOURCES });
    expect(v).toEqual([]);
    expect(BRIDGE_EXE.size).toBe(43_540_541);
  });
});

describe('isPathInside', () => {
  it('accepts the directory itself and its children, rejects siblings', () => {
    expect(isPathInside(CWD, USER_DATA)).toBe(true);
    expect(isPathInside(USER_DATA, USER_DATA)).toBe(true);
    expect(isPathInside(join(root, 'userDataOther'), USER_DATA)).toBe(false);
  });
});

describe('sha256OfFile', () => {
  it('hashes a file without ever reading it whole', async () => {
    const expected = (await EXE_SHA).toLowerCase();
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    // S-HASH: the hash must be streamed (the real exe is 43.5 MB) - proven by the source, which has no readFileSync.
    const source = readFileSync(new URL('./invariants.ts', import.meta.url), 'utf8');
    expect(source).toContain('createReadStream');
    expect(source).not.toContain('readFileSync');
  });

  it('rejects when the file cannot be read', async () => {
    await expect(sha256OfFile(join(root, 'does-not-exist.bin'))).rejects.toThrow();
  });
});
