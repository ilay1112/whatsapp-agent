// scripts/sign-windows.test.mjs - the signing plan of `sign-windows.mjs` with a FAKE signer and a FAKE verifier over a fake
// packed tree (TESTS 5.3 row `scripts/*.mjs`). No signtool, no PowerShell, no certificate, no real binary is ever involved.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_EXE,
  DEFAULT_TIMESTAMP_URL,
  PRODUCT_NAME,
  SIGNING_MANIFEST,
  SigningConfigError,
  afterSign,
  artifactBuildCompleted,
  asarIntegrityFuseEnabled,
  azureMetadata,
  beforePack,
  classifyFile,
  createProvenance,
  createSigningSession,
  createSigntoolSigner,
  readAsarText,
  describeSigningConfig,
  evaluateVerification,
  isPeImage,
  listPeFiles,
  main,
  pickSdkVersion,
  readSigningConfig,
  redactor,
  renderBridgePinFile,
  resolveSigntool,
  sign,
  signingPhase,
  signingPlan,
  signtoolArgs,
  subjectCn,
} from './sign-windows.mjs';
import { selectBridgePin } from '../src/main/bridge/invariants.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const THUMB = 'AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12'; // synthetic, not a real certificate
const PUBLISHER = 'Test Publisher';
/** @electron/fuses' sentinel (dist/constants.js): the fuse wire follows it as [version, length, ...states]. */
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const CERT_ENV = { WCA_SIGN_MODE: 'signtool-cert', WCA_SIGN_CERT_SHA1: THUMB, WCA_SIGN_PUBLISHER: PUBLISHER };
const AZURE_ENV = {
  WCA_SIGN_MODE: 'azure',
  WCA_AZURE_ENDPOINT: 'https://weu.codesigning.azure.net/',
  WCA_AZURE_ACCOUNT: 'test-account',
  WCA_AZURE_PROFILE: 'test-profile',
  WCA_AZURE_DLIB: 'C:\\tools\\ArtifactSigning\\bin\\x64\\Azure.CodeSigning.Dlib.dll',
  WCA_SIGN_PUBLISHER: PUBLISHER,
};

const dirs = [];
const tmp = (p = 'wca-sign-') => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaOf = (p) => sha(readFileSync(p));
/** A minimal PE image: DOS header ('MZ', e_lfanew = 64) + 'PE\0\0' + a body that makes every file distinct. */
const pe = (tag) => {
  const dos = Buffer.alloc(64);
  dos.write('MZ', 0, 'latin1');
  dos.writeUInt32LE(64, 0x3c);
  return Buffer.concat([dos, Buffer.from('PE\0\0', 'latin1'), Buffer.from(`body:${tag}`)]);
};
const put = (root, rel, body) => {
  const p = join(root, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  return p;
};

/** Fake repo (vendored sources + pins) and a fake electron-builder `--dir` tree copied from it. */
function fixture() {
  const repo = tmp('wca-sign-repo-');
  const out = tmp('wca-sign-dist-');
  const app = join(out, 'win-unpacked');
  const bridge = pe('bridge');
  const llama = {
    'llama-server.exe': pe('llama-server'),
    'ggml.dll': pe('llama-ggml'),
    'LICENSE-LLVM-OpenMP': 'licence',
  };
  const whisper = {
    'whisper-cli.exe': pe('whisper-cli'),
    'ggml.dll': pe('whisper-ggml'),
    'vcruntime140.dll': pe('crt'),
  };
  for (const [n, b] of Object.entries(llama)) put(repo, `vendor/llama/win-x64-vulkan/${n}`, b);
  for (const [n, b] of Object.entries(whisper)) put(repo, `vendor/whisper/win-x64-cpu/${n}`, b);
  // [signing-fix] the COMMITTED per-file pins (vendor/*.pin.json files.fileSha256, generated from the pinned zip by
  // fetch-*.mjs --pin-files) and the CRT pins (vcRedistCrt.files) - never the gitignored vendor/ copy itself
  put(
    repo,
    'vendor/llama.pin.json',
    JSON.stringify({
      files: {
        fileSha256: {
          'llama-server.exe': sha(llama['llama-server.exe']),
          'ggml.dll': sha(llama['ggml.dll']),
          'LICENSE-LLVM-OpenMP': sha(llama['LICENSE-LLVM-OpenMP']),
        },
      },
      vcRedistCrt: { files: { 'msvcp140.dll': null, 'vcruntime140.dll': null, 'vcruntime140_1.dll': null } },
    }),
  );
  put(
    repo,
    'vendor/whisper.pin.json',
    JSON.stringify({
      files: {
        fileSha256: { 'whisper-cli.exe': sha(whisper['whisper-cli.exe']), 'ggml.dll': sha(whisper['ggml.dll']) },
      },
      vcRedistCrt: {
        files: {
          'msvcp140.dll': null,
          'vcruntime140.dll': sha(whisper['vcruntime140.dll']),
          'vcruntime140_1.dll': null,
        },
      },
    }),
  );
  // [signing-fix] the extraResources SOURCE of the bridge (beforePack pre-signs a staged copy of it) and the build flag
  // electron-vite emits next to the main bundle (out/main/build-flags.json)
  put(repo, 'resources/bridge/whatsapp-bridge.exe', bridge);
  const setFlags = (signedBuild) =>
    put(repo, 'out/main/build-flags.json', `${JSON.stringify({ schema: 1, signedBuild })}\n`);
  setFlags(true);
  /** A stand-in for electron-builder's packager: BeforePackContext.packager (info.appDir, the mutable config). */
  const packager = {
    info: { appDir: repo },
    config: { electronFuses: { runAsNode: true, enableEmbeddedAsarIntegrityValidation: false } },
  };
  const ctx = { appOutDir: join(out, 'win-unpacked'), packager };
  put(app, APP_EXE, pe('electron-app'));
  put(app, 'ffmpeg.dll', pe('ffmpeg'));
  put(app, 'resources.pak', 'not a PE');
  put(app, 'resources/app.asar', 'asar bytes');
  put(app, 'resources/bridge/whatsapp-bridge.exe', bridge);
  put(app, 'resources/bridge/SHA256SUMS', `${sha(bridge).toUpperCase()}  whatsapp-bridge.exe\n`);
  put(app, 'resources/bridge/LICENSE', 'MIT');
  for (const [n, b] of Object.entries(llama)) put(app, `resources/llama/${n}`, b);
  for (const [n, b] of Object.entries(whisper)) put(app, `resources/whisper/${n}`, b);
  put(app, 'resources/calendar-mcp/build/index.js', 'console.log(1)');
  const signer = {
    calls: [],
    fail: new Set(),
    noop: new Set(),
    async sign({ file, args }) {
      this.calls.push({ file, args });
      if (this.fail.has(file)) throw new Error('signtool: SignerSign() failed');
      if (!this.noop.has(file)) appendFileSync(file, Buffer.from('<authenticode signature>'));
    },
  };
  const verifier = {
    calls: [],
    override: new Map(),
    async verify(files) {
      this.calls.push([...files]);
      return files.map((file) => ({
        file,
        status: 'Valid',
        subject: `CN=${PUBLISHER}, O=Test, C=IL`,
        thumbprint: THUMB,
        timestamped: true,
        ...(this.override.get(file) ?? {}),
      }));
    },
  };
  const made = { signer: 0, verifier: 0 };
  const session = (env = CERT_ENV) =>
    createSigningSession({
      env,
      repoRoot: repo,
      provenance: createProvenance({ repoRoot: repo, bridgePin: sha(bridge) }),
      resolveTool: () => 'C:\\fake\\signtool.exe',
      makeSigner: () => {
        made.signer += 1;
        return signer;
      },
      makeVerifier: () => {
        made.verifier += 1;
        return verifier;
      },
      // electron-builder copies out/** into app.asar AFTER beforePack: the fake asar serves the repo's out/ as it is now
      readAsarFile: (asarPath, entry) => {
        if (!existsSync(asarPath)) return null;
        const p = join(repo, ...entry.split('/'));
        return existsSync(p) ? readFileSync(p, 'utf8') : null;
      },
      // the fuse electron-builder flips from the (possibly beforePack-mutated) packager config
      asarIntegrityFuseOn: async () => packager.config.electronFuses.enableEmbeddedAsarIntegrityValidation === true,
      log: () => {},
    });
  const abs = (rel) => join(app, ...rel.split('/'));
  /** electron-builder 26.15.3 order: extraResources at copy time, then the app root (exe last here). */
  const packOrder = () => signingPlan(listPeFiles(app)).filter((r) => signingPhase(r) !== 3);
  return { repo, out, app, abs, bridge, signer, verifier, made, session, packOrder, packager, ctx, setFlags };
}
/** beforePack (idempotent: pre-signs the staged bridge once) + every PE of the tree in pack order. */
async function signTree(f, s, skip = []) {
  await s.beforePack(f.ctx);
  for (const rel of f.packOrder()) if (!skip.includes(rel)) await s.signFile({ path: f.abs(rel), hash: 'sha256' });
}
const SIGNED_PIN_ENTRY = 'out/main/bridge-signed-pin.txt';
const snapshot = (root) => Object.fromEntries(listAll(root).map((rel) => [rel, shaOf(join(root, ...rel.split('/')))]));
function listAll(root, base = root, acc = []) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) listAll(p, base, acc);
    else
      acc.push(
        p
          .slice(base.length + 1)
          .split('\\')
          .join('/'),
      );
  }
  return acc.sort();
}

// ---------------------------------------------------------------------------------------------------------------------

describe('readSigningConfig - off by default, refuses a half-configured mode', () => {
  it('unset, empty or "off" => off', () => {
    expect(readSigningConfig({})).toEqual({ mode: 'off' });
    expect(readSigningConfig({ WCA_SIGN_MODE: '' })).toEqual({ mode: 'off' });
    expect(readSigningConfig({ WCA_SIGN_MODE: '  OFF ' })).toEqual({ mode: 'off' });
    // the mode switch alone decides: stray variables never turn signing on
    expect(readSigningConfig({ WCA_SIGN_CERT_SHA1: THUMB, WCA_AZURE_ACCOUNT: 'x' })).toEqual({ mode: 'off' });
  });
  it('an unknown mode is refused', () => {
    expect(() => readSigningConfig({ WCA_SIGN_MODE: 'selfsigned' })).toThrow(SigningConfigError);
    expect(() => readSigningConfig({ WCA_SIGN_MODE: 'selfsigned' })).toThrow(/off \| signtool-cert \| azure/);
  });
  it('signtool-cert without / with a malformed thumbprint is refused with the variable name', () => {
    let err;
    try {
      readSigningConfig({ WCA_SIGN_MODE: 'signtool-cert' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SigningConfigError);
    expect(err.message).toMatch(/WCA_SIGN_CERT_SHA1 is required/);
    expect(err.message).toMatch(/Unset WCA_SIGN_MODE to build unsigned/);
    expect(() => readSigningConfig({ ...CERT_ENV, WCA_SIGN_CERT_SHA1: THUMB.slice(1) })).toThrow(/exactly 40 hex/);
    expect(() => readSigningConfig({ ...CERT_ENV, WCA_SIGN_CERT_SHA1: `${THUMB.slice(2)}ZZ` })).toThrow(
      /exactly 40 hex/,
    );
  });
  it('signtool-cert: thumbprint pasted with spaces / a left-to-right mark is normalised; defaults filled in', () => {
    const spaced = `\u200e${THUMB.toLowerCase().match(/.{2}/g).join(' ')}`;
    expect(readSigningConfig({ WCA_SIGN_MODE: 'signtool-cert', WCA_SIGN_CERT_SHA1: spaced })).toEqual({
      mode: 'signtool-cert',
      certSha1: THUMB,
      timestampUrl: DEFAULT_TIMESTAMP_URL['signtool-cert'],
      signtoolPath: null,
      publisher: null,
    });
  });
  it('azure: EVERY missing variable is listed at once', () => {
    let err;
    try {
      readSigningConfig({ WCA_SIGN_MODE: 'azure' });
    } catch (e) {
      err = e;
    }
    expect(err.problems).toHaveLength(5);
    for (const v of [
      'WCA_AZURE_ENDPOINT',
      'WCA_AZURE_ACCOUNT',
      'WCA_AZURE_PROFILE',
      'WCA_SIGN_PUBLISHER',
      'WCA_AZURE_DLIB',
    ]) {
      expect(err.message).toContain(v);
    }
  });
  it('azure: malformed values are refused', () => {
    const bad = (k, v) => () => readSigningConfig({ ...AZURE_ENV, [k]: v });
    expect(bad('WCA_AZURE_ENDPOINT', 'http://weu.codesigning.azure.net/')).toThrow(/https URL/);
    expect(bad('WCA_AZURE_ACCOUNT', 'a b')).toThrow(/plain account name/);
    expect(bad('WCA_AZURE_PROFILE', "x'y")).toThrow(/plain profile name/);
    expect(bad('WCA_AZURE_DLIB', 'Azure.CodeSigning.Dlib.dll')).toThrow(/absolute path/);
    expect(bad('WCA_AZURE_DLIB', 'C:\\tools\\other.dll')).toThrow(/absolute path/);
    expect(bad('WCA_SIGN_TIMESTAMP_URL', 'ftp://tsa')).toThrow(/RFC 3161/);
    expect(bad('WCA_SIGNTOOL_PATH', 'signtool.exe')).toThrow(/absolute path to signtool/);
  });
  it('azure: a complete configuration, Microsoft TSA by default, custom TSA honoured', () => {
    const cfg = readSigningConfig(AZURE_ENV);
    expect(cfg.mode).toBe('azure');
    expect(cfg.timestampUrl).toBe('http://timestamp.acs.microsoft.com');
    expect(
      readSigningConfig({ ...AZURE_ENV, WCA_SIGN_TIMESTAMP_URL: 'https://tsa.example/rfc3161' }).timestampUrl,
    ).toBe('https://tsa.example/rfc3161');
    expect(azureMetadata(cfg)).toEqual({
      Endpoint: 'https://weu.codesigning.azure.net/',
      CodeSigningAccountName: 'test-account',
      CertificateProfileName: 'test-profile',
    });
  });
  it('descriptions and redaction never carry the thumbprint', () => {
    const cfg = readSigningConfig(CERT_ENV);
    expect(describeSigningConfig(cfg)).not.toMatch(new RegExp(THUMB, 'i'));
    expect(describeSigningConfig(cfg)).toMatch(/signing ON \(signtool-cert\)/);
    expect(describeSigningConfig({ mode: 'off' })).toMatch(/OFF/);
    expect(describeSigningConfig(readSigningConfig(AZURE_ENV))).toMatch(/account test-account, profile test-profile/);
    const r = redactor(cfg);
    const echoed = `SHA1 hash: ${THUMB.toLowerCase()}\nIssued to: x\n${THUMB.match(/.{2}/g).join(' ')}`;
    expect(r(echoed)).not.toMatch(/ab12cd34/i);
    expect(r(echoed)).toContain('[REDACTED-SHA1 len=40]');
    expect(redactor(readSigningConfig(AZURE_ENV))('unchanged')).toBe('unchanged');
  });
});

describe('signtool command line', () => {
  it('signtool-cert: certificate by thumbprint, SHA-256 digest, RFC 3161 SHA-256 time stamp, file last', () => {
    const cfg = readSigningConfig(CERT_ENV);
    expect(signtoolArgs(cfg, 'C:\\o\\a.exe')).toEqual([
      'sign',
      '/sha1',
      THUMB,
      '/fd',
      'sha256',
      '/tr',
      'http://timestamp.digicert.com',
      '/td',
      'sha256',
      '/d',
      PRODUCT_NAME,
      'C:\\o\\a.exe',
    ]);
  });
  it('azure: the Artifact Signing dlib + metadata file, same digest / time-stamp switches', () => {
    const cfg = readSigningConfig(AZURE_ENV);
    expect(signtoolArgs(cfg, 'C:\\o\\a.dll', { metadataPath: 'C:\\t\\metadata.json' })).toEqual([
      'sign',
      '/fd',
      'sha256',
      '/tr',
      'http://timestamp.acs.microsoft.com',
      '/td',
      'sha256',
      '/d',
      PRODUCT_NAME,
      '/dlib',
      AZURE_ENV.WCA_AZURE_DLIB,
      '/dmdf',
      'C:\\t\\metadata.json',
      'C:\\o\\a.dll',
    ]);
    expect(() => signtoolArgs(cfg, 'x')).toThrow(/metadata/);
    expect(() => signtoolArgs({ mode: 'off' }, 'x')).toThrow(/no signtool arguments/);
  });
  it('no /a (auto-select), no /p password, no /f pfx - ever', () => {
    for (const cfg of [readSigningConfig(CERT_ENV), readSigningConfig(AZURE_ENV)]) {
      const args = signtoolArgs(cfg, 'f', { metadataPath: 'm' });
      for (const forbidden of ['/a', '/p', '/f', '/t', '/as']) expect(args).not.toContain(forbidden);
    }
  });
  it('signtool discovery: WCA_SIGNTOOL_PATH, else the newest Windows SDK that has one, else a clear refusal', () => {
    expect(pickSdkVersion(['10.0.19041.0', '10.0.22621.0', 'x64', '10.0.22621.1', '10.0.9.9'])).toBe('10.0.22621.1');
    expect(pickSdkVersion(['arm64'])).toBeNull();
    const cfg = readSigningConfig(CERT_ENV);
    const kits = join('C:\\PF86', 'Windows Kits', '10', 'bin');
    const fsx = (have) => ({
      existsSync: (p) => have.includes(p),
      readdirSync: () => ['10.0.19041.0', '10.0.26100.0', 'x86'],
    });
    const env = { 'ProgramFiles(x86)': 'C:\\PF86' };
    const newest = join(kits, '10.0.26100.0', 'x64', 'signtool.exe');
    const older = join(kits, '10.0.19041.0', 'x64', 'signtool.exe');
    expect(resolveSigntool(cfg, fsx([newest, older]), env)).toBe(newest);
    expect(resolveSigntool(cfg, fsx([older]), env)).toBe(older); // newest folder without signtool is skipped
    expect(() => resolveSigntool(cfg, fsx([]), env)).toThrow(/no signtool\.exe found/);
    const noKits = {
      existsSync: () => false,
      readdirSync: () => {
        throw new Error('ENOENT');
      },
    };
    expect(() => resolveSigntool(cfg, noKits, env)).toThrow(/Windows SDK/);
    const explicit = { ...cfg, signtoolPath: 'D:\\sdk\\signtool.exe' };
    expect(resolveSigntool(explicit, fsx(['D:\\sdk\\signtool.exe']), env)).toBe('D:\\sdk\\signtool.exe');
    expect(() => resolveSigntool(explicit, fsx([]), env)).toThrow(/WCA_SIGNTOOL_PATH does not exist/);
  });
});

// [signing-fix] MAJOR 2: a killed signtool (10-min timeout, SIGTERM) has err.code === null, and err.message is
// "Command failed: <signtool> sign /sha1 <THUMBPRINT> ..." - that text reached the error and electron-builder's log.
describe('createSigntoolSigner - errors never carry the thumbprint', () => {
  const cfg = readSigningConfig(CERT_ENV);
  const file = 'C:\\x\\win-unpacked\\resources\\llama\\llama-server.exe';
  it('a REAL signtool stand-in that hangs and is killed by the timeout', async () => {
    const signer = createSigntoolSigner({ signtoolPath: process.execPath, redact: redactor(cfg), timeoutMs: 300 });
    const args = ['-e', 'console.log(process.argv.join(" ")); setInterval(() => {}, 1000)', 'sign', '/sha1', THUMB];
    const err = await signer.sign({ file, args }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/signtool failed for llama-server\.exe \(timed out after 300 ms, SIGTERM\)/);
    expect(err.message).not.toMatch(new RegExp(THUMB, 'i'));
    expect(err.message).not.toMatch(/Command failed/);
  }, 15_000);
  it('every failure shape (killed, exit code, spawn error) is redacted as a whole', async () => {
    const shapes = [
      { code: null, signal: 'SIGTERM', killed: true },
      { code: 1, signal: null, killed: false },
      { code: 'ENOENT', signal: null, killed: false },
      { code: undefined, signal: undefined, killed: false },
    ];
    for (const shape of shapes) {
      const execFileImpl = (_cmd, argv, _opts, cb) =>
        cb(
          Object.assign(new Error(`Command failed: signtool.exe ${argv.join(' ')}`), shape),
          `Signing with /sha1 ${THUMB}\n`,
          `SignTool Error: no certificate ${THUMB.match(/.{2}/g).join(' ')}`,
        );
      const signer = createSigntoolSigner({
        signtoolPath: 'C:\\sdk\\signtool.exe',
        redact: redactor(cfg),
        execFileImpl,
      });
      const err = await signer.sign({ file, args: signtoolArgs(cfg, file) }).then(
        () => null,
        (e) => e,
      );
      expect(err.message).not.toMatch(new RegExp(THUMB, 'i'));
      expect(err.message).not.toMatch(/AB 12 CD 34/);
      expect(err.message).not.toMatch(/Command failed/);
      expect(err.message).toMatch(/\[REDACTED-SHA1 len=40\]/);
    }
  });
});

describe('which files, which order', () => {
  it('PE detection reads the header, not the extension', () => {
    const read = (buf) => (off, len) => buf.subarray(off, off + len);
    expect(isPeImage(read(pe('x')))).toBe(true);
    expect(isPeImage(read(Buffer.from('MZ but too short')))).toBe(false);
    const noPe = Buffer.from(pe('x'));
    noPe.write('XX', 64, 'latin1');
    expect(isPeImage(read(noPe))).toBe(false);
    const badLfanew = Buffer.from(pe('x'));
    badLfanew.writeUInt32LE(8, 0x3c);
    expect(isPeImage(read(badLfanew))).toBe(false);
    expect(isPeImage(read(Buffer.concat([Buffer.from('ZM'), Buffer.alloc(80)])))).toBe(false);
  });
  it('lists every PE file of the tree (a PE without .exe/.dll included, non-PE excluded) and orders the plan', () => {
    const f = fixture();
    put(f.app, 'resources/calendar-mcp/node_modules/x/prebuilt.node', pe('native'));
    put(f.app, 'resources/elevate.exe', pe('elevate'));
    expect(listPeFiles(f.app)).toEqual([
      APP_EXE,
      'ffmpeg.dll',
      'resources/bridge/whatsapp-bridge.exe',
      'resources/calendar-mcp/node_modules/x/prebuilt.node',
      'resources/elevate.exe',
      'resources/llama/ggml.dll',
      'resources/llama/llama-server.exe',
      'resources/whisper/ggml.dll',
      'resources/whisper/vcruntime140.dll',
      'resources/whisper/whisper-cli.exe',
    ]);
    const plan = signingPlan(listPeFiles(f.app));
    expect(plan.at(-1)).toBe('resources/elevate.exe'); // phase 3: copied in by the NSIS target
    expect(plan.at(-2)).toBe(APP_EXE); // the app exe closes the app-root phase
    expect(plan.slice(0, 7).every((r) => r.startsWith('resources/') && signingPhase(r) === 1)).toBe(true);
  });
  it('classifies what is being signed from its path', () => {
    const k = (p) => classifyFile(p).kind;
    expect(k('C:\\d\\win-unpacked\\resources\\bridge\\whatsapp-bridge.exe')).toBe('bridge');
    expect(k('C:\\d\\win-unpacked\\resources\\llama\\ggml.dll')).toBe('llama');
    expect(k('C:\\d\\win-unpacked\\resources\\whisper\\whisper-cli.exe')).toBe('whisper');
    expect(k('C:\\d\\win-unpacked\\resources\\elevate.exe')).toBe('nsis-elevate');
    expect(k('C:\\d\\win-unpacked\\resources\\calendar-mcp\\a.dll')).toBe('resources-other');
    expect(k('C:\\d\\WhatsAppCalendarAgent-Setup-0.1.0__uninstaller.exe')).toBe('uninstaller');
    expect(k('C:\\d\\WhatsAppCalendarAgent-Setup-0.1.0.exe')).toBe('installer');
    expect(k(`C:\\d\\win-unpacked\\${APP_EXE}`)).toBe('app-exe');
    expect(k('C:\\d\\win-unpacked\\ffmpeg.dll')).toBe('electron-runtime');
  });
});

describe('re-pinning format (writer here, reader in src/main/bridge/invariants.ts)', () => {
  it('round-trips: the launcher selects exactly the post-signing hash', () => {
    const original = sha('original');
    const signed = sha('signed');
    const text = renderBridgePinFile({ original, signed });
    expect(text).toBe(
      `${signed.toUpperCase()}  whatsapp-bridge.exe\n# wca-signed-from ${original.toUpperCase()}  whatsapp-bridge.exe\n`,
    );
    expect(selectBridgePin(text, original)).toEqual({ sha256: signed, source: 'signed' });
    // the same file is rejected by a launcher compiled with another original pin
    expect(selectBridgePin(text, sha('other')).source).toBe('signed_entry_rejected');
  });
  it('refuses nonsense pins and an "unsigned signed" exe', () => {
    expect(() => renderBridgePinFile({ original: 'ab', signed: sha('s') })).toThrow(/64 hex/);
    expect(() => renderBridgePinFile({ original: sha('o'), signed: sha('o') })).toThrow(/not signed/);
  });
  it('subjectCn + evaluateVerification judge identity, status and time stamp without quoting the thumbprint', () => {
    expect(subjectCn('CN=Test Publisher, O=Test, C=IL')).toBe('Test Publisher');
    expect(subjectCn('O=Test, CN="Pub, Inc.", C=IL')).toBe('Pub, Inc.');
    expect(subjectCn('O=Test')).toBeNull();
    expect(subjectCn(undefined)).toBeNull();
    const cfg = readSigningConfig(CERT_ENV);
    const ok = {
      file: 'C:\\A.EXE',
      status: 'Valid',
      subject: `CN=${PUBLISHER}`,
      thumbprint: THUMB.toLowerCase(),
      timestamped: true,
    };
    expect(evaluateVerification([ok], cfg, [{ abs: 'c:\\a.exe', label: 'a.exe' }])).toEqual([]);
    const problems = evaluateVerification(
      [{ ...ok, status: 'NotSigned', timestamped: false, thumbprint: '00'.repeat(20), subject: 'CN=Someone Else' }],
      cfg,
      [
        { abs: 'C:\\A.EXE', label: 'a.exe' },
        { abs: 'C:\\B.EXE', label: 'b.exe' },
      ],
    );
    expect(problems).toEqual([
      'a.exe: signature status NotSigned',
      'a.exe: no RFC 3161 time stamp',
      'a.exe: signed by a different certificate than WCA_SIGN_CERT_SHA1',
      `a.exe: signer CN is not "${PUBLISHER}"`,
      'b.exe: no signature result',
    ]);
    expect(problems.join('\n')).not.toMatch(new RegExp(THUMB, 'i'));
  });
});

describe('session - signing OFF is a no-op', () => {
  it('signs nothing, writes nothing, starts nothing: the tree is byte-identical', async () => {
    const f = fixture();
    f.setFlags(false);
    const before = snapshot(f.app);
    const repoBefore = snapshot(f.repo);
    const s = f.session({});
    await s.beforePack(f.ctx);
    for (const rel of f.packOrder()) expect(await s.signFile({ path: f.abs(rel), hash: 'sha256' })).toBe(false);
    await s.afterSign({ appOutDir: f.app });
    await s.artifactBuildCompleted({ file: join(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0.exe') });
    expect(snapshot(f.app)).toEqual(before);
    expect(snapshot(f.repo)).toEqual(repoBefore); // no signed pin in out/main, nothing else written
    expect(f.made).toEqual({ signer: 0, verifier: 0 });
    expect(existsSync(f.abs(`resources/${SIGNING_MANIFEST}`))).toBe(false);
    expect(f.packager.config.electronFuses.enableEmbeddedAsarIntegrityValidation).toBe(false); // unsigned: untouched
    expect(s.journal()).toEqual([]);
  });
  it('the electron-builder entry points are no-ops with WCA_SIGN_MODE unset', async () => {
    const saved = process.env.WCA_SIGN_MODE;
    delete process.env.WCA_SIGN_MODE;
    try {
      const f = fixture();
      f.setFlags(false);
      const before = snapshot(f.app);
      await beforePack(f.ctx);
      await sign({ path: f.abs(APP_EXE), hash: 'sha256' });
      await afterSign({ appOutDir: f.app });
      await artifactBuildCompleted({ file: join(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0.exe') });
      expect(snapshot(f.app)).toEqual(before);
    } finally {
      if (saved !== undefined) process.env.WCA_SIGN_MODE = saved;
    }
  });
});

// [signing-fix] MAJOR 1: the signed bridge pin lives in app.asar (written into out/main by beforePack, BEFORE
// electron-builder packs the asar), never in the writable <resources>\bridge\SHA256SUMS; the unsigned default never
// reads any pin file (compile-time flag), and beforePack refuses a WCA_SIGN_MODE / flag mismatch.
describe('session - build flag and the bridge pin inside app.asar', () => {
  it('beforePack refuses a mode/flag mismatch either way, and a missing flag file', async () => {
    const f = fixture();
    f.setFlags(true);
    await expect(f.session({}).beforePack(f.ctx)).rejects.toThrow(/built with WCA_SIGN_MODE set[\s\S]*npm run build/);
    f.setFlags(false);
    await expect(f.session().beforePack(f.ctx)).rejects.toThrow(/built WITHOUT WCA_SIGN_MODE[\s\S]*npm run build/);
    rmSync(join(f.repo, 'out', 'main', 'build-flags.json'));
    await expect(f.session({}).beforePack(f.ctx)).rejects.toThrow(/build-flags\.json/);
    await expect(f.session().beforePack(f.ctx)).rejects.toThrow(/build-flags\.json/);
    f.setFlags('yes');
    await expect(f.session({}).beforePack(f.ctx)).rejects.toThrow(/build-flags\.json/);
    expect(f.signer.calls).toHaveLength(0);
    expect(existsSync(join(f.repo, ...SIGNED_PIN_ENTRY.split('/')))).toBe(false);
  });
  it('beforePack pre-signs a STAGED copy of the bridge outside the repo and writes its pin into out/main', async () => {
    const f = fixture();
    const repoExe = join(f.repo, 'resources', 'bridge', 'whatsapp-bridge.exe');
    const s = f.session();
    await s.beforePack(f.ctx);
    expect(f.signer.calls).toHaveLength(1);
    const staged = f.signer.calls[0].file;
    expect(staged.toLowerCase().startsWith(f.repo.toLowerCase())).toBe(false);
    expect(staged.toLowerCase().startsWith(f.out.toLowerCase())).toBe(false);
    expect(f.signer.calls[0].args).toEqual(signtoolArgs(readSigningConfig(CERT_ENV), staged));
    expect(shaOf(repoExe)).toBe(sha(f.bridge)); // the import-bridge copy is never signed in place
    const pinText = readFileSync(join(f.repo, ...SIGNED_PIN_ENTRY.split('/')), 'utf8');
    expect(pinText).toBe(renderBridgePinFile({ original: sha(f.bridge), signed: shaOf(staged) }));
    expect(selectBridgePin(pinText, sha(f.bridge))).toEqual({ sha256: shaOf(staged), source: 'signed' });
    expect(f.verifier.calls).toEqual([[staged]]); // the pre-signed copy is verified before its hash is trusted
    // (c) asar integrity is switched on for the signed build only (the unsigned default keeps the yml value)
    expect(f.packager.config.electronFuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
    await s.beforePack(f.ctx); // idempotent: one pre-signing per build
    expect(f.signer.calls).toHaveLength(1);
  });
  it('sign() swaps the packaged bridge for the pre-signed bytes; resources/bridge/SHA256SUMS is never rewritten', async () => {
    const f = fixture();
    const sumsBefore = readFileSync(f.abs('resources/bridge/SHA256SUMS'), 'utf8');
    const s = f.session();
    await signTree(f, s);
    const staged = f.signer.calls[0].file;
    const exe = f.abs('resources/bridge/whatsapp-bridge.exe');
    expect(shaOf(exe)).toBe(shaOf(staged));
    expect(f.signer.calls.filter((c) => c.file === exe)).toHaveLength(0); // never signed a second time
    await s.afterSign({ appOutDir: f.app });
    expect(readFileSync(f.abs('resources/bridge/SHA256SUMS'), 'utf8')).toBe(sumsBefore);
  });
  it('signFile on the bridge without the beforePack pre-signing is refused', async () => {
    const f = fixture();
    const s = f.session();
    await expect(s.signFile({ path: f.abs('resources/bridge/whatsapp-bridge.exe'), hash: 'sha256' })).rejects.toThrow(
      /not pre-signed in beforePack/,
    );
    expect(f.signer.calls).toHaveLength(0);
  });
  it('a repo bridge that is not the pinned import is never pre-signed', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'resources', 'bridge', 'whatsapp-bridge.exe'), pe('substituted'));
    await expect(f.session().beforePack(f.ctx)).rejects.toThrow(/does not match its pin \(import-bridge pin\)/);
    expect(f.signer.calls).toHaveLength(0);
    expect(existsSync(join(f.repo, ...SIGNED_PIN_ENTRY.split('/')))).toBe(false);
  });
  it('beforePack refuses when it cannot reach the packager config to enable asar integrity', async () => {
    const f = fixture();
    await expect(f.session().beforePack({ packager: { info: { appDir: f.repo } } })).rejects.toThrow(
      /enableEmbeddedAsarIntegrityValidation/,
    );
  });
  it('afterSign refuses when app.asar does not carry the signed pin, or the asar-integrity fuse is off', async () => {
    const noPin = fixture();
    const s1 = noPin.session();
    await signTree(noPin, s1);
    rmSync(join(noPin.repo, ...SIGNED_PIN_ENTRY.split('/'))); // = an asar packed without it
    await expect(s1.afterSign({ appOutDir: noPin.app })).rejects.toThrow(/app\.asar does not carry/);
    const fuseOff = fixture();
    const s2 = fuseOff.session();
    await signTree(fuseOff, s2);
    fuseOff.packager.config.electronFuses.enableEmbeddedAsarIntegrityValidation = false;
    await expect(s2.afterSign({ appOutDir: fuseOff.app })).rejects.toThrow(/EnableEmbeddedAsarIntegrityValidation/);
    expect(existsSync(fuseOff.abs(`resources/${SIGNING_MANIFEST}`))).toBe(false);
  });
  it('the real asar reader finds the pin inside a real app.asar (and answers null when it is absent)', async () => {
    const src = tmp('wca-asar-src-');
    put(src, 'out/main/index.js', 'x');
    put(src, SIGNED_PIN_ENTRY, 'pin text\n');
    const asarPath = join(tmp('wca-asar-'), 'app.asar');
    await createRequire(import.meta.url)('@electron/asar').createPackage(src, asarPath);
    expect(readAsarText(asarPath, SIGNED_PIN_ENTRY)).toBe('pin text\n');
    expect(readAsarText(asarPath, 'out/main/nope.txt')).toBeNull();
    expect(readAsarText(join(src, 'missing.asar'), SIGNED_PIN_ENTRY)).toBeNull();
  });
  it('the real fuse reader reports EnableEmbeddedAsarIntegrityValidation from the fuse wire', async () => {
    const exe = (state) => {
      const wire = Buffer.from([1, 9, 48, 49, 48, 48, state, 49, 48, 48, 48]); // version 1, 9 fuses, #4 = asar integrity
      return put(tmp('wca-fuse-'), APP_EXE, Buffer.concat([pe('electron'), Buffer.from(FUSE_SENTINEL), wire]));
    };
    expect(await asarIntegrityFuseEnabled(exe(49))).toBe(true);
    expect(await asarIntegrityFuseEnabled(exe(48))).toBe(false);
  });
});

describe('session - signing ON with a fake signer', () => {
  it('signs every PE once, in pack order, verifies the tree, pins the bridge in app.asar and writes the manifest', async () => {
    const f = fixture();
    const nonPe = [
      'resources/app.asar',
      'resources/bridge/LICENSE',
      'resources/bridge/SHA256SUMS',
      'resources/llama/LICENSE-LLVM-OpenMP',
      'resources.pak',
    ];
    const nonPeBefore = nonPe.map((r) => shaOf(f.abs(r)));
    const s = f.session();
    await signTree(f, s);
    const bridgeRel = 'resources/bridge/whatsapp-bridge.exe';
    // call 0 = the staged bridge copy (beforePack); then every other PE in pack order
    expect(f.signer.calls.slice(1).map((c) => c.file)).toEqual(
      f
        .packOrder()
        .filter((r) => r !== bridgeRel)
        .map(f.abs),
    );
    expect(f.signer.calls[1].args).toEqual(signtoolArgs(readSigningConfig(CERT_ENV), f.signer.calls[1].file));
    await s.afterSign({ appOutDir: f.app });
    expect(f.verifier.calls).toHaveLength(2);
    expect(f.verifier.calls[1]).toHaveLength(f.packOrder().length);
    // the bridge pin (inside app.asar) names EXACTLY the signed exe, and only with the original provenance
    const exe = f.abs(bridgeRel);
    const pinText = readFileSync(join(f.repo, ...SIGNED_PIN_ENTRY.split('/')), 'utf8');
    expect(selectBridgePin(pinText, sha(f.bridge))).toEqual({ sha256: shaOf(exe), source: 'signed' });
    expect(shaOf(exe)).not.toBe(sha(f.bridge));
    // manifest: original + signed hash of every signed file of the tree, llama-server and whisper-cli included
    const manifest = JSON.parse(readFileSync(f.abs(`resources/${SIGNING_MANIFEST}`), 'utf8'));
    expect(manifest).toMatchObject({ schema: 1, mode: 'signtool-cert', fileDigest: 'sha256' });
    expect(manifest.files.map((e) => e.path)).toEqual(f.packOrder());
    for (const e of manifest.files) expect(e.signedSha256).toBe(shaOf(f.abs(e.path)));
    const byPath = Object.fromEntries(manifest.files.map((e) => [e.path, e]));
    expect(byPath['resources/llama/llama-server.exe'].provenance).toBe('vendor/llama.pin.json files.fileSha256');
    expect(byPath['resources/whisper/whisper-cli.exe'].provenance).toBe('vendor/whisper.pin.json files.fileSha256');
    expect(byPath['resources/whisper/vcruntime140.dll'].provenance).toBe('vendor/whisper.pin.json vcRedistCrt.files');
    expect(byPath[bridgeRel].originalSha256).toBe(sha(f.bridge));
    expect(JSON.stringify(manifest)).not.toMatch(new RegExp(THUMB, 'i'));
    // non-PE files are never touched (the packaged SHA256SUMS included: it is not the pin any more)
    expect(nonPe.map((r) => shaOf(f.abs(r)))).toEqual(nonPeBefore);
  });
  it('a missed file => afterSign refuses the partially signed tree and writes no manifest', async () => {
    const f = fixture();
    const s = f.session();
    await signTree(f, s, ['resources/llama/ggml.dll']);
    await expect(s.afterSign({ appOutDir: f.app })).rejects.toThrow(
      /partially signed tree[\s\S]*resources\/llama\/ggml\.dll: NOT SIGNED/,
    );
    expect(existsSync(f.abs(`resources/${SIGNING_MANIFEST}`))).toBe(false);
    expect(f.verifier.calls).toHaveLength(1); // only the beforePack check of the staged bridge
  });
  it('a PE file electron-builder does not sign by extension is caught by its header', async () => {
    const f = fixture();
    const s = f.session();
    await signTree(f, s);
    put(f.app, 'resources/calendar-mcp/node_modules/x/prebuilt.node', pe('native'));
    await expect(s.afterSign({ appOutDir: f.app })).rejects.toThrow(/prebuilt\.node: NOT SIGNED/);
  });
  it('a file modified after signing is refused', async () => {
    const f = fixture();
    const s = f.session();
    await signTree(f, s);
    appendFileSync(f.abs('ffmpeg.dll'), 'patched');
    await expect(s.afterSign({ appOutDir: f.app })).rejects.toThrow(/ffmpeg\.dll: changed after it was signed/);
  });
  it('signtool failure fails the file (no journal entry) and therefore the tree', async () => {
    const f = fixture();
    const s = f.session();
    f.signer.fail.add(f.abs('resources/whisper/whisper-cli.exe'));
    await expect(s.signFile({ path: f.abs('resources/whisper/whisper-cli.exe'), hash: 'sha256' })).rejects.toThrow(
      /SignerSign/,
    );
    expect(s.journal().some((e) => e.abs.endsWith('whisper-cli.exe'))).toBe(false);
    f.signer.fail.clear();
    await signTree(f, s, ['resources/whisper/whisper-cli.exe']);
    await expect(s.afterSign({ appOutDir: f.app })).rejects.toThrow(/whisper-cli\.exe: NOT SIGNED/);
  });
  it('a signer that "succeeds" without changing the bytes is refused', async () => {
    const f = fixture();
    const s = f.session();
    f.signer.noop.add(f.abs(APP_EXE));
    await expect(s.signFile({ path: f.abs(APP_EXE), hash: 'sha256' })).rejects.toThrow(
      /reported success but .* is unchanged/,
    );
  });
  it('verification problems fail afterSign (wrong certificate, no time stamp, not valid)', async () => {
    for (const bad of [
      { thumbprint: '11'.repeat(20) },
      { timestamped: false },
      { status: 'HashMismatch' },
      { subject: 'CN=X' },
    ]) {
      const f = fixture();
      const s = f.session();
      await signTree(f, s);
      f.verifier.override.set(f.abs('resources/llama/llama-server.exe'), bad);
      await expect(s.afterSign({ appOutDir: f.app })).rejects.toThrow(
        /signature problem\(s\):[\s\S]*llama-server\.exe/,
      );
      expect(existsSync(f.abs(`resources/${SIGNING_MANIFEST}`))).toBe(false);
    }
  });
  it('a bad signature on the staged bridge copy fails beforePack and writes no pin', async () => {
    const f = fixture();
    f.verifier.override = { get: () => ({ timestamped: false }) };
    await expect(f.session().beforePack(f.ctx)).rejects.toThrow(/bridge pre-signing: 1 signature problem/);
    expect(existsSync(join(f.repo, ...SIGNED_PIN_ENTRY.split('/')))).toBe(false);
  });
  it('only SHA-256 digests: a sha1 pass is refused', async () => {
    const f = fixture();
    await expect(f.session().signFile({ path: f.abs(APP_EXE), hash: 'sha1' })).rejects.toThrow(/only SHA-256/);
    expect(f.signer.calls).toHaveLength(0);
  });
  it('an electron-builder retry of an already signed file is a no-op (signed once)', async () => {
    const f = fixture();
    const s = f.session();
    const p = f.abs('resources/llama/llama-server.exe');
    expect(await s.signFile({ path: p, hash: 'sha256' })).toBe(true);
    expect(await s.signFile({ path: p, hash: 'sha256' })).toBe(true);
    expect(f.signer.calls).toHaveLength(1);
  });
  it('azure mode: one metadata file (no secret) passed with /dlib + /dmdf', async () => {
    const f = fixture();
    const s = f.session(AZURE_ENV);
    await s.signFile({ path: f.abs(APP_EXE), hash: 'sha256' });
    const args = f.signer.calls[0].args;
    const md = args[args.indexOf('/dmdf') + 1];
    expect(args[args.indexOf('/dlib') + 1]).toBe(AZURE_ENV.WCA_AZURE_DLIB);
    expect(JSON.parse(readFileSync(md, 'utf8'))).toEqual(azureMetadata(readSigningConfig(AZURE_ENV)));
    await s.signFile({ path: f.abs('ffmpeg.dll'), hash: 'sha256' });
    expect(f.signer.calls[1].args[f.signer.calls[1].args.indexOf('/dmdf') + 1]).toBe(md);
  });
});

describe('session - provenance before signing', () => {
  it('a bridge exe that is not the pinned import is never signed', async () => {
    const f = fixture();
    writeFileSync(f.abs('resources/bridge/whatsapp-bridge.exe'), pe('substituted'));
    const s = f.session();
    await expect(s.signFile({ path: f.abs('resources/bridge/whatsapp-bridge.exe'), hash: 'sha256' })).rejects.toThrow(
      /bridge\/whatsapp-bridge\.exe does not match its pin \(import-bridge pin\)/,
    );
    expect(f.signer.calls).toHaveLength(0);
  });
  it('whisper and llama files are held to the COMMITTED per-file pins of vendor/*.pin.json', async () => {
    const f = fixture();
    writeFileSync(f.abs('resources/whisper/whisper-cli.exe'), pe('other-whisper'));
    writeFileSync(f.abs('resources/llama/ggml.dll'), pe('other-ggml'));
    const s = f.session();
    await expect(s.signFile({ path: f.abs('resources/whisper/whisper-cli.exe'), hash: 'sha256' })).rejects.toThrow(
      /does not match its pin \(vendor\/whisper\.pin\.json files\.fileSha256\)/,
    );
    await expect(s.signFile({ path: f.abs('resources/llama/ggml.dll'), hash: 'sha256' })).rejects.toThrow(
      /does not match its pin \(vendor\/llama\.pin\.json files\.fileSha256\)/,
    );
    expect(f.signer.calls).toHaveLength(0);
  });
  // [signing-fix] MAJOR 3: the reference used to be the hash of the gitignored vendor/ copy the packaged file was made
  // from - a binary tampered in vendor/ after the fetch then matched itself and got OUR signature.
  it('a vendor/ binary tampered AFTER the fetch (packaged copy = tampered vendor copy) is refused', async () => {
    const f = fixture();
    for (const rel of ['vendor/llama/win-x64-vulkan/llama-server.exe', 'vendor/whisper/win-x64-cpu/whisper.dll']) {
      writeFileSync(join(f.repo, ...rel.split('/')), pe(`tampered ${rel}`));
    }
    writeFileSync(
      f.abs('resources/llama/llama-server.exe'),
      pe('tampered vendor/llama/win-x64-vulkan/llama-server.exe'),
    );
    put(f.app, 'resources/whisper/whisper.dll', pe('tampered vendor/whisper/win-x64-cpu/whisper.dll'));
    const s = f.session();
    await expect(s.signFile({ path: f.abs('resources/llama/llama-server.exe'), hash: 'sha256' })).rejects.toThrow(
      /does not match its pin/,
    );
    await expect(s.signFile({ path: f.abs('resources/whisper/whisper.dll'), hash: 'sha256' })).rejects.toThrow(
      /no vetted source/,
    );
    expect(f.signer.calls).toHaveLength(0);
  });
  it('CRT DLLs are held to vcRedistCrt.files; a null (UNPINNED) CRT pin is refused, never "equals the vendor copy"', async () => {
    const f = fixture();
    put(f.repo, 'vendor/llama/win-x64-vulkan/vcruntime140.dll', pe('crt-llama'));
    put(f.app, 'resources/llama/vcruntime140.dll', pe('crt-llama')); // identical to its vendor copy, but unpinned
    const s = f.session();
    await expect(s.signFile({ path: f.abs('resources/llama/vcruntime140.dll'), hash: 'sha256' })).rejects.toThrow(
      /UNPINNED in vendor\/llama\.pin\.json vcRedistCrt\.files[\s\S]*--pin-crt/,
    );
    writeFileSync(f.abs('resources/whisper/vcruntime140.dll'), pe('another-crt'));
    await expect(s.signFile({ path: f.abs('resources/whisper/vcruntime140.dll'), hash: 'sha256' })).rejects.toThrow(
      /does not match its pin \(vendor\/whisper\.pin\.json vcRedistCrt\.files\)/,
    );
    expect(f.signer.calls).toHaveLength(0);
  });
  it('no per-file pin map at all => every llama / whisper file is refused and --pin-files is named', async () => {
    const f = fixture();
    const pin = JSON.parse(readFileSync(join(f.repo, 'vendor', 'llama.pin.json'), 'utf8'));
    writeFileSync(join(f.repo, 'vendor', 'llama.pin.json'), JSON.stringify({ ...pin, files: { fileSha256: null } }));
    await expect(
      f.session().signFile({ path: f.abs('resources/llama/llama-server.exe'), hash: 'sha256' }),
    ).rejects.toThrow(/vendor\/llama\.pin\.json files\.fileSha256 is UNPINNED[\s\S]*fetch-llama\.mjs --pin-files/);
  });
  it('a vendored PE with no vetted source, or an unexpected file in bridge/, is refused', async () => {
    const f = fixture();
    put(f.app, 'resources/llama/injected.dll', pe('injected'));
    put(f.app, 'resources/bridge/helper.exe', pe('helper'));
    const s = f.session();
    await expect(s.signFile({ path: f.abs('resources/llama/injected.dll'), hash: 'sha256' })).rejects.toThrow(
      /no vetted source/,
    );
    await expect(s.signFile({ path: f.abs('resources/bridge/helper.exe'), hash: 'sha256' })).rejects.toThrow(
      /unexpected PE file/,
    );
  });
  it('never signs a file inside the source tree (vendor/, resources/, ...)', async () => {
    const f = fixture();
    const s = f.session();
    await expect(
      s.signFile({ path: join(f.repo, 'vendor', 'llama', 'win-x64-vulkan', 'llama-server.exe'), hash: 'sha256' }),
    ).rejects.toThrow(/inside the source tree/);
    expect(f.signer.calls).toHaveLength(0);
  });
  it('the real provenance resolver reads the repo pins (import-bridge pin, committed vendor/*.pin.json)', async () => {
    const prov = createProvenance();
    const bridge = await prov('C:\\x\\win-unpacked\\resources\\bridge\\whatsapp-bridge.exe');
    expect(bridge.expected).toBe('ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5');
    expect((await prov('C:\\x\\win-unpacked\\ffmpeg.dll')).expected).toBeNull();
    for (const kind of ['llama', 'whisper']) {
      const committed = JSON.parse(readFileSync(join(HERE, '..', 'vendor', `${kind}.pin.json`), 'utf8'));
      const exe = kind === 'llama' ? 'llama-server.exe' : 'whisper-cli.exe';
      const p = prov(`C:\\x\\win-unpacked\\resources\\${kind}\\${exe}`);
      if (committed.files.fileSha256 === null) {
        // not generated yet: signing refuses (fail closed) and names the command that generates them
        await expect(p).rejects.toThrow(new RegExp(`fetch-${kind}\\.mjs --pin-files`));
      } else {
        expect((await p).expected).toBe(committed.files.fileSha256[exe]);
      }
    }
  });
});

describe('session - the NSIS target (elevate, uninstaller, installer)', () => {
  async function packed(f, s) {
    await signTree(f, s);
    await s.afterSign({ appOutDir: f.app });
  }
  it('full order passes: elevate + uninstaller before the installer, all verified', async () => {
    const f = fixture();
    const s = f.session();
    await packed(f, s);
    put(f.app, 'resources/elevate.exe', pe('elevate'));
    await s.signFile({ path: f.abs('resources/elevate.exe'), hash: 'sha256' });
    const un = put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0__uninstaller.exe', pe('uninstaller'));
    await s.signFile({ path: un, hash: 'sha256' });
    const inst = put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0.exe', pe('installer'));
    await s.signFile({ path: inst, hash: 'sha256' });
    rmSync(un); // electron-builder deletes the uninstaller once the installer embeds it
    await s.artifactBuildCompleted({ file: `${inst}.blockmap` }); // not an exe: ignored
    await s.artifactBuildCompleted({ file: inst });
    expect(
      s
        .journal()
        .map((e) => e.kind)
        .slice(-3),
    ).toEqual(['nsis-elevate', 'uninstaller', 'installer']);
    expect(f.verifier.calls.at(-1)).toEqual([inst]);
  });
  it('the installer may not be signed before its uninstaller, nor before elevate.exe', async () => {
    const f = fixture();
    const s = f.session();
    await packed(f, s);
    const inst = put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0.exe', pe('installer'));
    await expect(s.signFile({ path: inst, hash: 'sha256' })).rejects.toThrow(/before its uninstaller/);
    await s.signFile({
      path: put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0__uninstaller.exe', pe('u')),
      hash: 'sha256',
    });
    put(f.app, 'resources/elevate.exe', pe('elevate'));
    await expect(s.signFile({ path: inst, hash: 'sha256' })).rejects.toThrow(/before resources\/elevate\.exe/);
  });
  it('an unsigned installer, an unsigned elevate.exe or a skipped afterSign fail artifactBuildCompleted', async () => {
    const f = fixture();
    const s = f.session();
    const inst = put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0.exe', pe('installer'));
    await expect(s.artifactBuildCompleted({ file: inst })).rejects.toThrow(/afterSign never verified/);
    await packed(f, s);
    await expect(s.artifactBuildCompleted({ file: inst })).rejects.toThrow(/was not signed/);
    await s.signFile({
      path: put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0__uninstaller.exe', pe('u')),
      hash: 'sha256',
    });
    await s.signFile({ path: inst, hash: 'sha256' });
    put(f.app, 'resources/elevate.exe', pe('elevate')); // appears after the installer was signed: never signed
    await expect(s.artifactBuildCompleted({ file: inst })).rejects.toThrow(/elevate\.exe: NOT SIGNED/);
  });
  it('the uninstaller is verified right after signing (it is deleted before the installer event)', async () => {
    const f = fixture();
    const s = f.session();
    const un = put(f.out, 'WhatsAppCalendarAgent-Setup-0.1.0__uninstaller.exe', pe('u'));
    f.verifier.override.set(un, { timestamped: false });
    await expect(s.signFile({ path: un, hash: 'sha256' })).rejects.toThrow(/uninstaller: 1 signature problem/);
  });
});

describe('session - a half-configured mode refuses before anything is packed', () => {
  it('beforePack and signFile throw SigningConfigError; nothing is signed', async () => {
    const f = fixture();
    const s = f.session({ WCA_SIGN_MODE: 'signtool-cert' });
    await expect(s.beforePack()).rejects.toThrow(SigningConfigError);
    await expect(s.signFile({ path: f.abs(APP_EXE), hash: 'sha256' })).rejects.toThrow(
      /WCA_SIGN_CERT_SHA1 is required/,
    );
    await expect(s.afterSign({ appOutDir: f.app })).rejects.toThrow(SigningConfigError);
    expect(f.made.signer).toBe(0);
  });
  it('azure: a dlib path that does not exist is refused in beforePack', async () => {
    const f = fixture();
    await expect(f.session(AZURE_ENV).beforePack()).rejects.toThrow(/WCA_AZURE_DLIB does not exist/);
  });
});

describe('CLI', () => {
  const io = () => {
    const o = { out: '', err: '' };
    return { o, io: { out: { write: (s) => (o.out += s) }, err: { write: (s) => (o.err += s) } } };
  };
  it('--check-env: off, refusal, usage', () => {
    let t = io();
    expect(main(['--check-env'], t.io, {})).toBe(0);
    expect(t.o.out).toMatch(/signing OFF/);
    t = io();
    expect(main(['--check-env'], t.io, { WCA_SIGN_MODE: 'azure' })).toBe(1);
    expect(t.o.err).toMatch(/WCA_AZURE_ENDPOINT is required/);
    t = io();
    expect(main([], t.io, {})).toBe(2);
  });
  it('--plan lists the PE files of a packed tree in signing order and signs nothing', () => {
    const f = fixture();
    const before = snapshot(f.app);
    const t = io();
    expect(main(['--plan', f.app], t.io, {})).toBe(0);
    const lines = t.o.out.trim().split('\n');
    expect(lines[0]).toMatch(/^phase 1 {2}bridge +resources\/bridge\/whatsapp-bridge\.exe$/);
    expect(lines.at(-2)).toMatch(/^phase 2 {2}app-exe +WhatsApp Calendar Agent\.exe$/);
    expect(lines.at(-1)).toMatch(/^8 PE file\(s\)/);
    expect(snapshot(f.app)).toEqual(before);
    const bad = io();
    expect(main(['--plan', join(f.app, 'nope')], bad.io, {})).toBe(1);
  });
});

describe('repo contract', () => {
  const yml = readFileSync(join(HERE, '..', 'electron-builder.yml'), 'utf8');
  const src = readFileSync(join(HERE, 'sign-windows.mjs'), 'utf8');
  it('electron-builder.yml wires every hook to this module, sha256 only, DLLs included, no certificate material', () => {
    expect(yml).toMatch(/^beforePack: \.\/scripts\/sign-windows\.mjs$/m);
    expect(yml).toMatch(/^afterSign: \.\/scripts\/sign-windows\.mjs$/m);
    expect(yml).toMatch(/^artifactBuildCompleted: \.\/scripts\/sign-windows\.mjs$/m);
    expect(yml).toMatch(/^ {4}sign: \.\/scripts\/sign-windows\.mjs\b/m);
    expect(yml).toMatch(/^ {4}signingHashAlgorithms: \[sha256\]/m);
    expect(yml).toMatch(/^ {2}signExts: \['\.dll'\]/m);
    expect(yml).toMatch(/artifactName: 'WhatsAppCalendarAgent-Setup-\$\{version\}\.\$\{ext\}'/); // INSTALLER_RE
    const code = yml.replace(/#.*$/gm, '');
    for (const k of [
      'certificateFile',
      'certificateSha1',
      'certificateSubjectName',
      'certificatePassword',
      'azureSignOptions',
      'forceCodeSigning',
    ]) {
      expect(code).not.toContain(k);
    }
    expect(code).not.toMatch(/[0-9a-f]{40}/i);
  });
  it('[signing-fix] the build flag is compiled from WCA_SIGN_MODE with the SAME off rule, and the yml default stays unsigned', () => {
    const viteCfg = readFileSync(join(HERE, '..', 'electron.vite.config.ts'), 'utf8');
    expect(viteCfg).toMatch(/__AUTHENTICODE_SIGNED_BUILD__: JSON\.stringify\(SIGNED_BUILD\)/);
    expect(viteCfg).toMatch(/fileName: 'build-flags\.json'/);
    // same rule as readSigningConfig: unset / empty / "off" (any case) = unsigned
    expect(viteCfg).toMatch(/const SIGNED_BUILD = SIGN_MODE !== '' && SIGN_MODE\.toLowerCase\(\) !== 'off';/);
    expect(viteCfg).toMatch(/const SIGN_MODE = String\(process\.env\.WCA_SIGN_MODE \?\? ''\)\.trim\(\);/);
    expect(readSigningConfig({ WCA_SIGN_MODE: ' OFF ' }).mode).toBe('off');
    // asar integrity is switched on by beforePack for SIGNED builds only; the yml (= every unsigned build) keeps false
    expect(yml).toMatch(/^ {2}enableEmbeddedAsarIntegrityValidation: false\b/m);
  });
  it('the module never carries a thumbprint and never touches certificate stores or security settings', () => {
    expect(src).not.toMatch(/\b[0-9A-Fa-f]{40}\b(?![0-9A-Fa-f])/);
    for (const forbidden of [
      /Import-PfxCertificate|Import-Certificate|New-SelfSignedCertificate|certutil|Cert:\\/i,
      /Install-Module|Install-PackageProvider/i,
      /Set-MpPreference|Add-MpPreference|Set-ExecutionPolicy/i,
      /\/f\s*['"`]|\.pfx|\.p12/i,
    ]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});
