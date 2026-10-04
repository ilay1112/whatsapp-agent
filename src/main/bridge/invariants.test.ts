// TESTS 5.3 row `bridge/invariants.ts` (I6 / ARCHITECTURE A15): one test per violated precondition, plus the streamed hash.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_ENDPOINTS,
  BRIDGE_ENV_KEYS,
  FORBIDDEN_BRIDGE_ENDPOINT_NAMES,
  MEDIA_FETCH_MODULE,
  stripComments,
  sweepBridgeEndpointRefs,
  BRIDGE_EXE,
  BRIDGE_SIGNED_PIN_FILE,
  BRIDGE_PIN_FILE_MAX_BYTES,
  selectBridgePin,
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

// ---------------------------------------------------------------------------------------------------------------------
// [V2] B5 endpoint sweep (V2-W1-07-media-voice): /api/media only via media/fetch.ts; download/typing/react/group nowhere in src/
// ---------------------------------------------------------------------------------------------------------------------
describe('B5 endpoint sweep', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  function sourceFiles(dir: string): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__fixtures__') continue;
        out.push(...sourceFiles(full));
      } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\.(ts|tsx|mjs)$/.test(e.name)) {
        out.push({ path: relative(repo, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
      }
    }
    return out;
  }

  it('the real src/ tree is clean', () => {
    const files = sourceFiles(join(repo, 'src'));
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.path === MEDIA_FETCH_MODULE)).toBe(true);
    expect(sweepBridgeEndpointRefs(files)).toEqual([]);
  });

  it('five endpoints; the forbidden names are stored without their path so this module never references them', () => {
    expect(BRIDGE_ENDPOINTS).toEqual([
      '/api/health',
      '/api/pairing/status',
      '/api/pairing/qr.png',
      '/api/send',
      '/api/media',
    ]);
    expect(FORBIDDEN_BRIDGE_ENDPOINT_NAMES.map((n) => `/api/${n}`)).toEqual([
      '/api/download',
      '/api/typing',
      '/api/react',
      '/api/group/',
    ]);
  });

  it('flags each kind of violation; comments do not count; strings and escapes are kept', () => {
    const findings = sweepBridgeEndpointRefs([
      {
        path: 'src/main/x.ts',
        text: 'fetch(\'/api/typing\'); // /api/react in a comment\n/* /api/download */ const a = "/api/group/status";',
      },
      { path: 'src/main/agent/y.ts', text: 'const u = `http://h/api/media?x=1`; client.getMedia (a, b);' },
      { path: 'src/main/media/fetch.ts', text: 'await deps.read.getMedia(chat, id, opts);' },
      { path: 'src/main/bridge/readClient.ts', text: "const p = '/api/media'; const q = 'it\\'s /api/react';" },
      { path: 'src/main/z.ts', text: '/* never closed /api/download' },
      { path: 'src/main/w.ts', text: '// only a comment /api/typing' },
    ]);
    expect(findings).toEqual([
      { file: 'src/main/x.ts', kind: 'forbidden_endpoint', detail: '/api/typing' },
      { file: 'src/main/x.ts', kind: 'forbidden_endpoint', detail: '/api/group/' },
      { file: 'src/main/agent/y.ts', kind: 'media_path_outside_transport', detail: '/api/media' },
      { file: 'src/main/agent/y.ts', kind: 'get_media_outside_fetch', detail: 'getMedia(' },
      { file: 'src/main/bridge/readClient.ts', kind: 'forbidden_endpoint', detail: '/api/react' },
    ]);
    expect(stripComments('a/b // c')).toBe('a/b ');
  });
});

// [signing-pipeline, D-078] post-signing re-pin: which ONE hash the launcher compares the exe against.
describe('selectBridgePin', () => {
  const ORIG = BRIDGE_EXE.sha256;
  const SIGNED = 'be'.repeat(32);
  const OTHER = '0c'.repeat(32);
  const repoFile = `${ORIG.toUpperCase()}  whatsapp-bridge.exe\n`;
  const signedFile = `${SIGNED.toUpperCase()}  whatsapp-bridge.exe\n# wca-signed-from ${ORIG.toUpperCase()}  whatsapp-bridge.exe\n`;

  it('[signing-fix] the signed pin file lives in app.asar (out/main/bridge-signed-pin.txt) and is small', () => {
    expect(BRIDGE_SIGNED_PIN_FILE).toBe('bridge-signed-pin.txt');
    expect(BRIDGE_PIN_FILE_MAX_BYTES).toBe(4096);
  });
  it('unsigned build (no file, or the repo file): the compiled-in original pin', () => {
    expect(selectBridgePin(null)).toEqual({ sha256: ORIG, source: 'original' });
    expect(selectBridgePin(repoFile)).toEqual({ sha256: ORIG, source: 'original' });
    expect(selectBridgePin('')).toEqual({ sha256: ORIG, source: 'original' });
  });
  it('the file hash line alone never changes the pin (no signed-from line => original)', () => {
    expect(selectBridgePin(`${OTHER}  whatsapp-bridge.exe\n`)).toEqual({ sha256: ORIG, source: 'original' });
    expect(selectBridgePin(`${SIGNED} *whatsapp-bridge.exe\r\n`)).toEqual({ sha256: ORIG, source: 'original' });
  });
  it('signed build: the post-signing hash, lower-case, CRLF and binary marker tolerated', () => {
    expect(selectBridgePin(signedFile)).toEqual({ sha256: SIGNED, source: 'signed' });
    expect(selectBridgePin(signedFile.replace(/\n/g, '\r\n').replace('  whatsapp', ' *whatsapp'))).toEqual({
      sha256: SIGNED,
      source: 'signed',
    });
    expect(selectBridgePin(`# wca-signed-from ${ORIG}  whatsapp-bridge.exe\n${SIGNED}  whatsapp-bridge.exe`)).toEqual({
      sha256: SIGNED,
      source: 'signed',
    });
  });
  it('fails closed to the original pin on every malformed signed entry', () => {
    const rejected = { sha256: ORIG, source: 'signed_entry_rejected' };
    // signed from a DIFFERENT original (another bridge build)
    expect(selectBridgePin(signedFile.replace(`from ${ORIG.toUpperCase()}`, `from ${OTHER}`))).toEqual(rejected);
    // two signed-from lines
    expect(selectBridgePin(`${signedFile}# wca-signed-from ${ORIG}  whatsapp-bridge.exe\n`)).toEqual(rejected);
    // two hash lines (which one would be "the" pin?)
    expect(selectBridgePin(`${signedFile}${OTHER}  whatsapp-bridge.exe\n`)).toEqual(rejected);
    // no hash line at all
    expect(selectBridgePin(`# wca-signed-from ${ORIG}  whatsapp-bridge.exe\n`)).toEqual(rejected);
    // a "signed" hash equal to the original is not a signed build
    expect(selectBridgePin(`${ORIG}  whatsapp-bridge.exe\n# wca-signed-from ${ORIG}  whatsapp-bridge.exe\n`)).toEqual(
      rejected,
    );
  });
  it('lines for other files, short hashes and an oversized file are ignored', () => {
    expect(
      selectBridgePin(`${signedFile}${OTHER}  LICENSE\n${'ab'.repeat(20)}  whatsapp-bridge.exe\n# comment\n`),
    ).toEqual({ sha256: SIGNED, source: 'signed' });
    expect(selectBridgePin(signedFile + ' '.repeat(BRIDGE_PIN_FILE_MAX_BYTES))).toEqual({
      sha256: ORIG,
      source: 'original',
    });
  });
  it('an explicit original pin (seam) is honoured and compared case-insensitively', () => {
    expect(selectBridgePin(null, OTHER.toUpperCase())).toEqual({ sha256: OTHER, source: 'original' });
    expect(selectBridgePin(signedFile, ORIG.toUpperCase())).toEqual({ sha256: SIGNED, source: 'signed' });
  });
  it('the repo pin file carries only the original line (every unsigned build stays on the original pin)', () => {
    const repoText = readFileSync(
      fileURLToPath(new URL('../../../resources/bridge/SHA256SUMS', import.meta.url)),
      'utf8',
    );
    expect(selectBridgePin(repoText)).toEqual({ sha256: ORIG, source: 'original' });
    expect(repoText).not.toMatch(/wca-signed-from/);
  });
});
