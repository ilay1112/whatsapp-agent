#!/usr/bin/env node
// scripts/sign-windows.mjs - Authenticode signing pipeline for the Windows build, INACTIVE until configured (D-078).
// Owner: signing-pipeline. Wired into electron-builder.yml as `win.signtoolOptions.sign`, `beforePack`, `afterSign` and
// `artifactBuildCompleted` (electron-builder 26.15.3: app-builder-lib/out/codeSign/windowsSignToolManager.js resolves the
// named export `sign`; app-builder-lib/out/packager.js resolves the hooks by their own names).
//
// OFF BY DEFAULT. With WCA_SIGN_MODE unset (or "off") every export below returns before touching anything: no file is
// hashed, written or signed, no process is started, and the build output is byte-identical to an unsigned build. The
// one read is beforePack's out/main/build-flags.json check (an out/ built for a SIGNED build is refused).
//
// ON (WCA_SIGN_MODE = signtool-cert | azure) - see `readSigningConfig` for the variables of each mode:
//   * EVERY PE file that ships is signed with a SHA-256 file digest and an RFC 3161 time stamp (/fd sha256 /tr <url> /td
//     sha256): the app exe, every .exe/.dll under resources (bridge, llama, whisper, elevate), the Electron runtime DLLs,
//     the NSIS uninstaller and the installer. electron-builder decides WHEN (copy-time for extraResources, then the app
//     root, then the NSIS target); this module decides HOW and refuses anything it cannot vouch for.
//   * provenance BEFORE signing [signing-fix, review MAJOR 3]: a vendored binary is signed only when its bytes equal a
//     COMMITTED pin (bridge: the import-bridge pin; llama / whisper: vendor/*.pin.json files.fileSha256, generated from
//     the pinned zip by fetch-*.mjs --pin-files; the app-local CRT DLLs: vcRedistCrt.files, null = refused). The
//     gitignored vendor/ copy is never its own reference. Our signature never lands on a binary that is not the vetted one.
//   * no silent partial tree: a failed signtool run throws (electron-builder fails the build); `afterSign` re-walks the
//     packaged tree, requires EVERY PE file (detected by its MZ/PE header, not its extension) to be in the signing
//     journal with unchanged bytes, and verifies every signature (Valid + time-stamped + the configured certificate)
//     with Get-AuthenticodeSignature; `artifactBuildCompleted` does the same for the installer, the uninstaller and
//     elevate.exe. Any gap throws.
//   * re-pinning [signing-fix, review MAJOR 1]: signing changes the bridge exe's bytes. `beforePack` - which
//     electron-builder runs BEFORE it packs app.asar (platformPackager.js: emitBeforePack, then copyAppFiles) - checks
//     the import-bridge copy against its pin, signs a STAGED copy outside the repo, verifies it and writes
//     out/main/bridge-signed-pin.txt (post-signing hash + a `# wca-signed-from <original pin>` line), so the signed pin
//     ships INSIDE app.asar, never in the writable resources/bridge/SHA256SUMS (which is left untouched). `sign` then
//     puts those pre-signed bytes in place of the packaged bridge instead of signing it again (time stamps make
//     signatures non-deterministic). The launcher reads that file ONLY in a build compiled with __AUTHENTICODE_SIGNED_BUILD__
//     (electron.vite.config.ts, from WCA_SIGN_MODE at `npm run build`; it emits out/main/build-flags.json), and
//     `beforePack` refuses a WCA_SIGN_MODE / flag mismatch in both directions. A signed build also switches the
//     EnableEmbeddedAsarIntegrityValidation fuse on; `afterSign` checks that app.asar carries the pin and the fuse is
//     on. It is always an exact hash match - never "any signed file". Every signed file's original and signed hash is
//     recorded in resources/signing-manifest.json (llama-server / whisper-cli included) for the smoke / Defender gates.
//
// Never: create, import, trust or delete a certificate; touch a certificate store or any security setting; download
// a tool; print or write the certificate thumbprint. The only processes started (signing ON only) are signtool.exe and
// powershell.exe (Get-AuthenticodeSignature, read-only).
//
//   node scripts/sign-windows.mjs --check-env          validates the WCA_SIGN_* variables (exit 1 + reasons when invalid)
//   node scripts/sign-windows.mjs --plan <appOutDir>   lists the PE files of a packed tree in signing order (signs nothing)
import { execFile } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './hash-bridge.mjs';
import { BRIDGE_EXE_SHA256 } from './import-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // the project path contains a space: never URL.pathname
const require = createRequire(import.meta.url);

/** Every variable this pipeline reads. Nothing else is read; nothing is ever written back to the environment. */
export const SIGN_ENV = Object.freeze({
  mode: 'WCA_SIGN_MODE',
  timestampUrl: 'WCA_SIGN_TIMESTAMP_URL',
  signtoolPath: 'WCA_SIGNTOOL_PATH',
  publisher: 'WCA_SIGN_PUBLISHER',
  certSha1: 'WCA_SIGN_CERT_SHA1',
  azureEndpoint: 'WCA_AZURE_ENDPOINT',
  azureAccount: 'WCA_AZURE_ACCOUNT',
  azureProfile: 'WCA_AZURE_PROFILE',
  azureDlib: 'WCA_AZURE_DLIB',
});
export const SIGN_MODES = Object.freeze(['signtool-cert', 'azure']);
/** RFC 3161 time-stamp authorities used when WCA_SIGN_TIMESTAMP_URL is unset. */
export const DEFAULT_TIMESTAMP_URL = Object.freeze({
  'signtool-cert': 'http://timestamp.digicert.com', // electron-builder's own default (winOptions.d.ts rfc3161TimeStampServer)
  azure: 'http://timestamp.acs.microsoft.com', // Microsoft's TSA for Artifact Signing
});
export const PRODUCT_NAME = 'WhatsApp Calendar Agent'; // signtool /d - the description Windows shows in the UAC/SAC prompt
export const APP_EXE = `${PRODUCT_NAME}.exe`;
/** electron-builder.yml nsis.artifactName = 'WhatsAppCalendarAgent-Setup-${version}.${ext}' (pinned by the yml contract test). */
export const INSTALLER_RE = /^WhatsAppCalendarAgent-Setup-[^\\/]+\.exe$/i;
export const UNINSTALLER_SUFFIX = '__uninstaller.exe'; // NsisTarget.computeScriptAndSignUninstaller
export const SIGNED_FROM_TAG = 'wca-signed-from';
export const SIGNING_MANIFEST = 'signing-manifest.json';
/** [signing-fix] The signed bridge pin, written by beforePack into out/main => shipped inside app.asar. Must equal
 *  src/main/bridge/invariants.ts BRIDGE_SIGNED_PIN_FILE (pinned by the tests). */
export const BRIDGE_SIGNED_PIN_FILE = 'bridge-signed-pin.txt';
export const SIGNED_PIN_ASAR_ENTRY = `out/main/${BRIDGE_SIGNED_PIN_FILE}`;
/** [signing-fix] electron.vite.config.ts emits this next to the main bundle: { schema: 1, signedBuild: boolean }. */
export const BUILD_FLAGS_FILE = 'out/main/build-flags.json';
const BRIDGE_EXE_NAME = 'whatsapp-bridge.exe';
/** [signing-fix] COMMITTED per-file pins (files.fileSha256, from the pinned zip) and CRT pins (vcRedistCrt.files). */
const PIN_FILE = Object.freeze({ llama: 'vendor/llama.pin.json', whisper: 'vendor/whisper.pin.json' });
const FETCH_SCRIPT = Object.freeze({ llama: 'scripts/fetch-llama.mjs', whisper: 'scripts/fetch-whisper.mjs' });
const HEX64_RE = /^[0-9a-f]{64}$/;
/** Source trees a signer must never write into (signing a hard-linked or source copy would change the pinned original). */
const SOURCE_TREES = ['resources', 'vendor', 'build-resources', 'node_modules'];

export class SigningConfigError extends Error {
  /** @param {string[]} problems  @param {string} [mode] */
  constructor(problems, mode) {
    super(
      `sign-windows: ${mode === undefined ? 'WCA_SIGN_MODE' : `WCA_SIGN_MODE=${mode}`} is set but signing is not ` +
        `configured - refusing to build:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Unset WCA_SIGN_MODE to build unsigned. The variables are documented in README "Code signing".',
    );
    this.name = 'SigningConfigError';
    this.problems = problems;
  }
}
export class SigningError extends Error {
  constructor(message) {
    super(`sign-windows: ${message}`);
    this.name = 'SigningError';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// configuration (pure)
// ---------------------------------------------------------------------------------------------------------------------

function isHttpUrl(s, { httpsOnly = false } = {}) {
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:')) && u.hostname !== '';
  } catch {
    return false;
  }
}
/** A plain resource name (Artifact Signing account / profile): no whitespace, quotes or path characters. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Thumbprints copied from certmgr carry spaces and an invisible left-to-right mark; both are stripped. */
const THUMB_NOISE_RE = /[\s\u200e\u200f\ufeff]/g;

/**
 * Reads the signing configuration. Returns `{ mode: 'off' }` when WCA_SIGN_MODE is unset, empty or "off". Throws a
 * SigningConfigError listing EVERY missing / invalid variable when a mode is set but cannot be honoured.
 * @param {Record<string, string | undefined>} env
 */
export function readSigningConfig(env = process.env) {
  const raw = (k) => (typeof env[k] === 'string' ? env[k].trim() : '');
  const mode = raw(SIGN_ENV.mode);
  if (mode === '' || mode.toLowerCase() === 'off') return Object.freeze({ mode: 'off' });
  if (!SIGN_MODES.includes(mode)) {
    throw new SigningConfigError([`${SIGN_ENV.mode} must be one of off | ${SIGN_MODES.join(' | ')} (got "${mode}")`]);
  }
  const problems = [];
  const timestampUrl = raw(SIGN_ENV.timestampUrl) || DEFAULT_TIMESTAMP_URL[mode];
  if (!isHttpUrl(timestampUrl)) {
    problems.push(`${SIGN_ENV.timestampUrl} must be the http(s) URL of an RFC 3161 time-stamp authority`);
  }
  const signtoolPath = raw(SIGN_ENV.signtoolPath) || null;
  if (signtoolPath !== null && !(isAbsolute(signtoolPath) && /(^|[\\/])signtool\.exe$/i.test(signtoolPath))) {
    problems.push(
      `${SIGN_ENV.signtoolPath} must be an absolute path to signtool.exe (or unset to use the newest Windows SDK)`,
    );
  }
  const publisher = raw(SIGN_ENV.publisher) || null;
  if (mode === 'signtool-cert') {
    const certSha1 = raw(SIGN_ENV.certSha1).replace(THUMB_NOISE_RE, '').toUpperCase();
    if (certSha1 === '') {
      problems.push(
        `${SIGN_ENV.certSha1} is required: the SHA-1 thumbprint of the code-signing certificate signtool should select ` +
          '(a Trusted Root Program certificate, e.g. the cloud key exposed by the CA virtual smart card)',
      );
    } else if (!/^[0-9A-F]{40}$/.test(certSha1)) {
      problems.push(`${SIGN_ENV.certSha1} must be exactly 40 hex digits (spaces are allowed and ignored)`);
    }
    if (problems.length > 0) throw new SigningConfigError(problems, mode);
    return Object.freeze({ mode, timestampUrl, signtoolPath, publisher, certSha1 });
  }
  // azure (Azure Artifact Signing, formerly Trusted Signing) through signtool's /dlib integration
  const azureEndpoint = raw(SIGN_ENV.azureEndpoint);
  const azureAccount = raw(SIGN_ENV.azureAccount);
  const azureProfile = raw(SIGN_ENV.azureProfile);
  const azureDlib = raw(SIGN_ENV.azureDlib);
  if (azureEndpoint === '')
    problems.push(`${SIGN_ENV.azureEndpoint} is required (e.g. https://weu.codesigning.azure.net/)`);
  else if (!isHttpUrl(azureEndpoint, { httpsOnly: true }))
    problems.push(`${SIGN_ENV.azureEndpoint} must be an https URL`);
  if (azureAccount === '') problems.push(`${SIGN_ENV.azureAccount} is required (the Artifact Signing account name)`);
  else if (!NAME_RE.test(azureAccount)) problems.push(`${SIGN_ENV.azureAccount} is not a plain account name`);
  if (azureProfile === '') problems.push(`${SIGN_ENV.azureProfile} is required (the certificate profile name)`);
  else if (!NAME_RE.test(azureProfile)) problems.push(`${SIGN_ENV.azureProfile} is not a plain profile name`);
  if (publisher === null) {
    problems.push(
      `${SIGN_ENV.publisher} is required in azure mode: the certificate subject CN every signature is checked against`,
    );
  }
  if (azureDlib === '') {
    problems.push(
      `${SIGN_ENV.azureDlib} is required: absolute path to Azure.CodeSigning.Dlib.dll (Artifact Signing client)`,
    );
  } else if (!(isAbsolute(azureDlib) && /(^|[\\/])Azure\.CodeSigning\.Dlib\.dll$/i.test(azureDlib))) {
    problems.push(`${SIGN_ENV.azureDlib} must be an absolute path ending in Azure.CodeSigning.Dlib.dll`);
  }
  if (problems.length > 0) throw new SigningConfigError(problems, mode);
  return Object.freeze({
    mode,
    timestampUrl,
    signtoolPath,
    publisher,
    azureEndpoint,
    azureAccount,
    azureProfile,
    azureDlib,
  });
}

/** One-line, thumbprint-free description for logs and `--check-env`. */
export function describeSigningConfig(cfg) {
  if (cfg.mode === 'off') return 'signing OFF (WCA_SIGN_MODE unset) - the build is unsigned';
  const common = `time stamp ${cfg.timestampUrl}; signtool ${cfg.signtoolPath ?? 'newest Windows SDK'}`;
  if (cfg.mode === 'signtool-cert') {
    return (
      `signing ON (signtool-cert): certificate selected by thumbprint [set, 40 hex]` +
      `${cfg.publisher === null ? '' : `; publisher CN "${cfg.publisher}"`}; ${common}`
    );
  }
  return (
    `signing ON (azure): endpoint ${cfg.azureEndpoint}, account ${cfg.azureAccount}, profile ${cfg.azureProfile}, ` +
    `publisher CN "${cfg.publisher}"; ${common}`
  );
}

/** Removes the thumbprint from text that may reach a log or an error message (signtool echoes it). */
export function redactor(cfg) {
  if (cfg.mode !== 'signtool-cert') return (s) => String(s);
  const spaced = cfg.certSha1.match(/.{2}/g).join('[\\s\\u200e]*');
  const re = new RegExp(spaced, 'gi');
  return (s) => String(s).replace(re, '[REDACTED-SHA1 len=40]');
}

/** `Endpoint` / `CodeSigningAccountName` / `CertificateProfileName` - the documented /dmdf metadata file. No secret. */
export function azureMetadata(cfg) {
  return {
    Endpoint: cfg.azureEndpoint,
    CodeSigningAccountName: cfg.azureAccount,
    CertificateProfileName: cfg.azureProfile,
  };
}

/** The signtool argv for one file (SHA-256 file digest, RFC 3161 SHA-256 time stamp, the file LAST). */
export function signtoolArgs(cfg, file, { metadataPath = null } = {}) {
  const common = ['/fd', 'sha256', '/tr', cfg.timestampUrl, '/td', 'sha256', '/d', PRODUCT_NAME];
  if (cfg.mode === 'signtool-cert') return ['sign', '/sha1', cfg.certSha1, ...common, file];
  if (cfg.mode === 'azure') {
    if (metadataPath === null) throw new SigningError('azure mode needs the /dmdf metadata file');
    return ['sign', ...common, '/dlib', cfg.azureDlib, '/dmdf', metadataPath, file];
  }
  throw new SigningError(`no signtool arguments for mode ${String(cfg.mode)}`);
}

/** Newest `10.0.x.y` folder name of `<Windows Kits>\10\bin` (null when none). */
export function pickSdkVersion(names) {
  const parsed = names
    .map((n) => ({ n, v: /^10\.0\.(\d+)\.(\d+)$/.exec(n) }))
    .filter((e) => e.v !== null)
    .sort((a, b) => Number(b.v[1]) - Number(a.v[1]) || Number(b.v[2]) - Number(a.v[2]));
  return parsed.length === 0 ? null : parsed[0].n;
}

/** WCA_SIGNTOOL_PATH, else the newest Windows SDK x64 signtool. Never downloads anything. Throws when none exists. */
export function resolveSigntool(cfg, fsx = { existsSync, readdirSync }, env = process.env) {
  if (cfg.signtoolPath !== null) {
    if (!fsx.existsSync(cfg.signtoolPath))
      throw new SigningConfigError([`${SIGN_ENV.signtoolPath} does not exist`], cfg.mode);
    return cfg.signtoolPath;
  }
  const kits = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  let names;
  try {
    names = fsx.readdirSync(kits);
  } catch {
    names = [];
  }
  const ordered = names.filter((n) => pickSdkVersion([n]) !== null);
  while (ordered.length > 0) {
    const v = pickSdkVersion(ordered);
    const candidate = join(kits, v, 'x64', 'signtool.exe');
    if (fsx.existsSync(candidate)) return candidate;
    ordered.splice(ordered.indexOf(v), 1);
  }
  throw new SigningConfigError(
    [
      `no signtool.exe found: install the Windows SDK "Signing Tools for Desktop Apps" (10.0.22621 or newer for azure) ` +
        `or set ${SIGN_ENV.signtoolPath}`,
    ],
    cfg.mode,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// PE detection + tree walk
// ---------------------------------------------------------------------------------------------------------------------

/** True when the first bytes are a DOS stub whose e_lfanew points at a `PE\0\0` signature (pure; `read(off, len)`). */
export function isPeImage(read) {
  const dos = read(0, 64);
  if (dos.length < 64 || dos[0] !== 0x4d || dos[1] !== 0x5a) return false; // 'MZ'
  const lfanew = dos.readUInt32LE(0x3c);
  if (lfanew < 64 || lfanew > 16 * 1024 * 1024) return false;
  const sig = read(lfanew, 4);
  return sig.length === 4 && sig[0] === 0x50 && sig[1] === 0x45 && sig[2] === 0 && sig[3] === 0; // 'PE\0\0'
}

/** Header-only PE check of one file (reads at most 68 bytes; never executes anything). */
export function isPeFile(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    return isPeImage((off, len) => {
      const b = Buffer.alloc(len);
      const n = readSync(fd, b, 0, len, off);
      return b.subarray(0, n);
    });
  } finally {
    closeSync(fd);
  }
}

/** Every PE file under `root` (by header, not extension), as sorted forward-slash relative paths. Symlinks are not followed. */
export function listPeFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && isPeFile(abs)) out.push(relative(root, abs).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The phase electron-builder signs a file of a packed tree in (app-builder-lib 26.15.3): 1 = extraResources at copy time
 * (bridge, llama, whisper, every other resources PE), 2 = the app root (runtime DLLs, then the app exe), 3 = the NSIS
 * target (elevate.exe is copied in by the installer build). Pure.
 */
export function signingPhase(rel) {
  if (rel === 'resources/elevate.exe') return 3;
  if (rel.startsWith('resources/')) return 1;
  return 2;
}

/** `--plan`: the PE files of a packed tree in signing order - resources first, the app exe last of its phase. Pure. */
export function signingPlan(relPaths) {
  const rank = (rel) => [signingPhase(rel), rel === APP_EXE ? 1 : 0];
  return [...relPaths].sort((a, b) => {
    const [pa, ea] = rank(a);
    const [pb, eb] = rank(b);
    return pa - pb || ea - eb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// provenance + pins
// ---------------------------------------------------------------------------------------------------------------------

const VENDORED_RE = /[\\/]resources[\\/](bridge|llama|whisper)[\\/]([^\\/]+)$/i;

/** What a path to be signed IS. Pure: decided from the path alone. */
export function classifyFile(absPath) {
  const name = basename(absPath);
  const vendored = VENDORED_RE.exec(absPath);
  if (vendored !== null) return { kind: vendored[1].toLowerCase(), name };
  if (/[\\/]resources[\\/]elevate\.exe$/i.test(absPath)) return { kind: 'nsis-elevate', name };
  if (/[\\/]resources[\\/]/i.test(absPath)) return { kind: 'resources-other', name };
  if (name.toLowerCase().endsWith(UNINSTALLER_SUFFIX)) return { kind: 'uninstaller', name };
  if (INSTALLER_RE.test(name)) return { kind: 'installer', name };
  if (name === APP_EXE) return { kind: 'app-exe', name };
  return { kind: 'electron-runtime', name };
}

/**
 * Provenance resolver: the sha256 a vendored binary MUST have before we put our signature on it (null = produced by
 * this build or by Electron/NSIS, nothing to compare). Throws for a vendored file no COMMITTED pin covers.
 *
 * [signing-fix, signing-review MAJOR 3] llama / whisper files are compared with vendor/*.pin.json files.fileSha256
 * (generated from the pinned zip by `node scripts/fetch-*.mjs --pin-files` and committed), the app-local CRT DLLs with
 * vcRedistCrt.files (null = UNPINNED = refused). The gitignored vendor/ copy - the very file the packaged copy was made
 * from - is never the reference: a binary tampered in vendor/ after the fetch no longer matches "itself".
 * @param {{ repoRoot?: string, bridgePin?: string, readPin?: (rel: string) => any }} [o]
 */
export function createProvenance({ repoRoot = REPO_ROOT, bridgePin = BRIDGE_EXE_SHA256, readPin } = {}) {
  const read = readPin ?? ((rel) => JSON.parse(readFileSync(join(repoRoot, ...rel.split('/')), 'utf8')));
  const pins = {};
  return async function provenanceOf(absPath) {
    const c = classifyFile(absPath);
    if (c.kind === 'bridge') {
      if (c.name.toLowerCase() !== BRIDGE_EXE_NAME)
        throw new SigningError(`unexpected PE file in resources/bridge: ${c.name}`);
      return { ...c, expected: bridgePin.toLowerCase(), source: 'import-bridge pin' };
    }
    if (c.kind === 'llama' || c.kind === 'whisper') {
      const pinFile = PIN_FILE[c.kind];
      pins[c.kind] ??= read(pinFile);
      const pin = pins[c.kind];
      const crt = pin?.vcRedistCrt?.files ?? {};
      if (!c.name.startsWith('_') && Object.hasOwn(crt, c.name)) {
        const v = crt[c.name];
        if (typeof v !== 'string' || !HEX64_RE.test(v)) {
          throw new SigningError(
            `resources/${c.kind}/${c.name} is an app-local CRT DLL that is UNPINNED in ${pinFile} vcRedistCrt.files - ` +
              'refusing to sign it (pin it with `node scripts/fetch-llama.mjs --pin-crt`, review, commit)',
          );
        }
        return { ...c, expected: v, source: `${pinFile} vcRedistCrt.files` };
      }
      const map = pin?.files?.fileSha256;
      if (map === null || map === undefined || typeof map !== 'object') {
        throw new SigningError(
          `${pinFile} files.fileSha256 is UNPINNED - nothing under resources/${c.kind} is signed without committed ` +
            `per-file pins: run \`node ${FETCH_SCRIPT[c.kind]} --pin-files\` (downloads the PINNED zip, verifies it), ` +
            'review the recorded hashes and commit them',
        );
      }
      const v = c.name.startsWith('_') ? undefined : map[c.name];
      if (typeof v !== 'string' || !HEX64_RE.test(v)) {
        throw new SigningError(
          `resources/${c.kind}/${c.name} has no vetted source: no per-file pin in ${pinFile} files.fileSha256 - ` +
            'refusing to sign it',
        );
      }
      return { ...c, expected: v, source: `${pinFile} files.fileSha256` };
    }
    return { ...c, expected: null, source: 'built' };
  };
}

/** The signed bridge pin (out/main/bridge-signed-pin.txt => app.asar; format read by invariants.ts selectBridgePin). Pure. */
export function renderBridgePinFile({ original, signed }) {
  const o = String(original).toLowerCase();
  const s = String(signed).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(o) || !/^[0-9a-f]{64}$/.test(s))
    throw new SigningError('bridge pins must be 64 hex digits');
  if (o === s) throw new SigningError('the signed bridge exe has the ORIGINAL hash - it was not signed');
  return `${s.toUpperCase()}  ${BRIDGE_EXE_NAME}\n# ${SIGNED_FROM_TAG} ${o.toUpperCase()}  ${BRIDGE_EXE_NAME}\n`;
}

/** Subject CN of an X.500 DN as Get-AuthenticodeSignature prints it ('CN="A, Inc.", O=...' or 'CN=A, O=...'). Pure. */
export function subjectCn(subject) {
  const m = /(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]*)/.exec(String(subject ?? ''));
  if (m === null) return null;
  const v = m[1].trim();
  return v.startsWith('"') ? v.slice(1, -1).replace(/""/g, '"') : v;
}

/**
 * Judges Get-AuthenticodeSignature results: every expected file must be Valid, time-stamped and signed by the configured
 * identity (thumbprint in signtool-cert mode; subject CN when WCA_SIGN_PUBLISHER is set / in azure mode). Pure; the
 * problems never quote a thumbprint.
 */
export function evaluateVerification(results, cfg, expected) {
  const byFile = new Map(results.map((r) => [String(r.file).toLowerCase(), r]));
  const problems = [];
  for (const { abs, label } of expected) {
    const r = byFile.get(abs.toLowerCase());
    if (r === undefined) {
      problems.push(`${label}: no signature result`);
      continue;
    }
    if (r.status !== 'Valid') problems.push(`${label}: signature status ${String(r.status)}`);
    if (r.timestamped !== true) problems.push(`${label}: no RFC 3161 time stamp`);
    if (cfg.mode === 'signtool-cert' && String(r.thumbprint ?? '').toUpperCase() !== cfg.certSha1) {
      problems.push(`${label}: signed by a different certificate than ${SIGN_ENV.certSha1}`);
    }
    if (cfg.publisher !== null && subjectCn(r.subject) !== cfg.publisher) {
      problems.push(`${label}: signer CN is not "${cfg.publisher}"`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// the session (all state of one electron-builder run; every collaborator injectable)
// ---------------------------------------------------------------------------------------------------------------------

const keyOf = (p) => resolve(p).toLowerCase();

/**
 * @param {object} o
 * @param {Record<string,string|undefined>} [o.env]            read once, lazily, at the first hook call
 * @param {(cfg) => { sign(req: { file: string, args: string[] }): Promise<void> }} [o.makeSigner]
 * @param {(cfg) => { verify(files: string[]): Promise<Array<{file,status,subject,thumbprint,timestamped}>> }} [o.makeVerifier]
 * @param {(absPath: string) => Promise<{kind,name,expected,source}>} [o.provenance]
 * @param {(cfg) => string} [o.resolveTool]                     signtool path (validated in beforePack)
 * @param {(p: string) => Promise<string>} [o.hash]
 * @param {string} [o.repoRoot]                                 source trees under it are never signed in place; the
 *                                                              fallback project dir when beforePack gets no packager
 * @param {(asarPath: string, entry: string) => string | null} [o.readAsarFile]   afterSign: one file of app.asar
 * @param {(appExe: string) => Promise<boolean>} [o.asarIntegrityFuseOn]          afterSign: the fuse state of the app exe
 * @param {(msg: string) => void} [o.log]
 */
export function createSigningSession(o = {}) {
  const env = o.env ?? process.env;
  const hash = o.hash ?? hashFile;
  const repoRoot = o.repoRoot ?? REPO_ROOT;
  const readAsarFile = o.readAsarFile ?? readAsarText;
  const asarIntegrityFuseOn = o.asarIntegrityFuseOn ?? asarIntegrityFuseEnabled;
  const log = o.log ?? ((m) => process.stdout.write(`  • sign-windows: ${m}\n`));
  let cfg = null;
  let signer = null;
  let verifier = null;
  let provenance = null;
  let metadataDir = null;
  /** [signing-fix] the bridge pre-signed in beforePack: { staged, original, signed, pinText } */
  let presigned = null;
  /** key -> { abs, kind, source, original, signed } in signing order */
  const journal = new Map();
  const appOutDirs = new Set();

  function config() {
    if (cfg === null) cfg = readSigningConfig(env); // throws SigningConfigError on a half-configured mode
    return cfg;
  }
  function ready() {
    if (signer !== null) return;
    const c = config();
    const tool = (o.resolveTool ?? resolveSigntool)(c);
    signer = (o.makeSigner ?? ((cc) => createSigntoolSigner({ signtoolPath: tool, redact: redactor(cc) })))(c);
    verifier = (o.makeVerifier ?? (() => createPowershellVerifier()))(c);
    provenance = o.provenance ?? createProvenance({ repoRoot, hash });
    log(describeSigningConfig(c));
  }
  function metadataPath() {
    if (metadataDir === null) {
      metadataDir = tempDir('wca-sign-');
      writeFileSync(join(metadataDir, 'metadata.json'), `${JSON.stringify(azureMetadata(cfg), null, 2)}\n`);
    }
    return join(metadataDir, 'metadata.json');
  }
  const argsFor = (file) => signtoolArgs(cfg, file, cfg.mode === 'azure' ? { metadataPath: metadataPath() } : {});
  /** [signing-fix] The project dir electron-builder packs from (out/** and the extraResources sources live there). */
  const projectDirOf = (ctx) => ctx?.packager?.info?.appDir ?? ctx?.packager?.projectDir ?? repoRoot;
  /** [signing-fix] out/main/build-flags.json -> the compile-time signed-build flag; throws when absent / malformed. */
  function readBuildFlags(projectDir) {
    const p = join(projectDir, ...BUILD_FLAGS_FILE.split('/'));
    let flags;
    try {
      flags = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      flags = null;
    }
    if (flags === null || typeof flags !== 'object' || typeof flags.signedBuild !== 'boolean') {
      throw new SigningError(
        `${BUILD_FLAGS_FILE} is missing or malformed - out/ was not built by this electron.vite.config.ts; ` +
          'run `npm run build` (in the same shell, with the same WCA_SIGN_MODE) before packaging',
      );
    }
    return flags;
  }
  /**
   * [signing-fix] (c) a signed build turns on asar integrity: the packager config is the object electron-builder reads
   * when it flips the fuses (doAddElectronFuses, after afterPack). The yml - every unsigned build - keeps `false`.
   */
  function enableAsarIntegrity(packager) {
    const config = packager?.config;
    if (config === null || typeof config !== 'object') {
      throw new SigningError(
        'beforePack got no electron-builder packager config - cannot switch on enableEmbeddedAsarIntegrityValidation',
      );
    }
    if (config.electronFuses === null || typeof config.electronFuses !== 'object') config.electronFuses = {};
    config.electronFuses.enableEmbeddedAsarIntegrityValidation = true;
  }
  /**
   * [signing-fix] Signs a STAGED copy of the import-bridge exe (outside the repo and outside the packed tree), verifies
   * it and writes its pin into out/main - beforePack runs before electron-builder packs out/** into app.asar.
   */
  async function presignBridge(projectDir) {
    if (presigned !== null) return;
    const src = join(projectDir, 'resources', 'bridge', BRIDGE_EXE_NAME);
    const p = await provenance(src);
    const original = existsSync(src) ? await hash(src) : null;
    if (p.kind !== 'bridge' || original !== p.expected) {
      throw new SigningError(
        `resources/bridge/${BRIDGE_EXE_NAME} does not match its pin (import-bridge pin) - refusing to pre-sign it`,
      );
    }
    const staged = join(tempDir('wca-bridge-'), BRIDGE_EXE_NAME);
    copyFileSync(src, staged);
    await signer.sign({ file: staged, args: argsFor(staged) });
    const signed = await hash(staged);
    if (signed === original) throw new SigningError(`signtool reported success but ${BRIDGE_EXE_NAME} is unchanged`);
    await verifyOrThrow([{ abs: staged, label: `${BRIDGE_EXE_NAME} (pre-signed copy)` }], 'bridge pre-signing');
    const pinText = renderBridgePinFile({ original, signed });
    const pinPath = join(projectDir, ...SIGNED_PIN_ASAR_ENTRY.split('/'));
    mkdirSync(join(pinPath, '..'), { recursive: true });
    writeFileSync(pinPath, pinText);
    presigned = { staged, original, signed, pinText };
    log(`bridge pre-signed; its pin is in ${SIGNED_PIN_ASAR_ENTRY} (=> app.asar)`);
  }
  function insideSourceTree(abs) {
    const k = keyOf(abs);
    return SOURCE_TREES.some((t) => k.startsWith(`${keyOf(join(repoRoot, t))}${sep}`));
  }
  async function verifyOrThrow(entries, what) {
    const results = await verifier.verify(entries.map((e) => e.abs));
    const problems = evaluateVerification(results, cfg, entries);
    if (problems.length > 0) {
      throw new SigningError(
        `${what}: ${problems.length} signature problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      );
    }
  }
  /** Every PE file of every packed tree must be journaled with its post-signing bytes still on disk, then verified. */
  async function assertTreesSigned(what) {
    const entries = [];
    const gaps = [];
    for (const root of appOutDirs) {
      for (const rel of listPeFiles(root)) {
        const abs = join(root, ...rel.split('/'));
        const j = journal.get(keyOf(abs));
        if (j === undefined) gaps.push(`${rel}: NOT SIGNED`);
        else if ((await hash(abs)) !== j.signed) gaps.push(`${rel}: changed after it was signed`);
        else entries.push({ abs, label: rel });
      }
    }
    if (gaps.length > 0) {
      throw new SigningError(`${what}: refusing a partially signed tree:\n${gaps.map((g) => `  - ${g}`).join('\n')}`);
    }
    await verifyOrThrow(entries, what);
    return entries.length;
  }

  return {
    /** The parsed configuration (throws when half-configured). */
    config,
    /** Read-only copy of the journal, in signing order. */
    journal: () => [...journal.values()].map((e) => ({ ...e })),

    /**
     * electron-builder `beforePack` (BeforePackContext): refuse a half-configured mode or a mode / build-flag mismatch
     * BEFORE anything is packed; signing ON: switch on asar integrity and pre-sign the bridge (its pin -> app.asar).
     */
    async beforePack(ctx = {}) {
      const c = config();
      const projectDir = projectDirOf(ctx);
      const flags = readBuildFlags(projectDir);
      if (c.mode === 'off') {
        if (flags.signedBuild) {
          throw new SigningError(
            `out/main was built with WCA_SIGN_MODE set (signed-build flag ON: the launcher would trust the pin in ` +
              `app.asar) but WCA_SIGN_MODE is not set now - run \`npm run build\` again in this shell, or set it`,
          );
        }
        return;
      }
      if (!flags.signedBuild) {
        throw new SigningError(
          `WCA_SIGN_MODE=${c.mode} but out/main was built WITHOUT WCA_SIGN_MODE (signed-build flag OFF: the launcher ` +
            'would refuse the signed bridge) - run `npm run build` in this shell with the same WCA_SIGN_MODE',
        );
      }
      ready();
      if (cfg.mode === 'azure' && !existsSync(cfg.azureDlib)) {
        throw new SigningConfigError([`${SIGN_ENV.azureDlib} does not exist`], cfg.mode);
      }
      enableAsarIntegrity(ctx.packager);
      await presignBridge(projectDir);
    },

    /** electron-builder `win.signtoolOptions.sign`: signs ONE file. */
    async signFile({ path, hash: digest }) {
      if (config().mode === 'off') return false;
      ready();
      if (digest !== 'sha256') {
        throw new SigningError(
          `only SHA-256 file digests are produced (electron-builder asked for "${String(digest)}"); ` +
            'keep win.signtoolOptions.signingHashAlgorithms = [sha256]',
        );
      }
      const abs = resolve(path);
      if (insideSourceTree(abs)) throw new SigningError(`refusing to sign a file inside the source tree: ${abs}`);
      const before = await hash(abs);
      const known = journal.get(keyOf(abs));
      if (known !== undefined && known.signed === before) return true; // electron-builder retry of a file already signed
      const p = await provenance(abs);
      if (p.expected !== null && before !== p.expected) {
        throw new SigningError(
          `${p.kind}/${p.name} does not match its pin (${p.source}) - refusing to put our signature on an unvetted binary`,
        );
      }
      if (p.kind === 'installer') {
        if (![...journal.values()].some((e) => e.kind === 'uninstaller')) {
          throw new SigningError('the installer is being signed before its uninstaller was - refusing');
        }
        for (const root of appOutDirs) {
          const elevate = join(root, 'resources', 'elevate.exe');
          if (existsSync(elevate) && !journal.has(keyOf(elevate))) {
            throw new SigningError('the installer is being signed before resources/elevate.exe was - refusing');
          }
        }
      }
      if (p.kind === 'bridge') {
        // [signing-fix] never signed a second time: the packaged copy becomes the bytes whose pin is in app.asar
        if (presigned === null || presigned.original !== before) {
          throw new SigningError(
            `${BRIDGE_EXE_NAME} was not pre-signed in beforePack - refusing (its signed pin must ship inside app.asar)`,
          );
        }
        copyFileSync(presigned.staged, abs);
        const placed = await hash(abs);
        if (placed !== presigned.signed) throw new SigningError('the pre-signed bridge copy changed after beforePack');
        journal.set(keyOf(abs), {
          abs,
          kind: p.kind,
          source: `${p.source}; pre-signed in beforePack`,
          original: before,
          signed: placed,
        });
        return true;
      }
      await signer.sign({ file: abs, args: argsFor(abs) });
      const after = await hash(abs);
      if (after === before) throw new SigningError(`signtool reported success but ${p.name} is unchanged`);
      journal.set(keyOf(abs), { abs, kind: p.kind, source: p.source, original: before, signed: after });
      if (p.kind === 'uninstaller') await verifyOrThrow([{ abs, label: p.name }], 'uninstaller'); // deleted before the installer event
      return true;
    },

    /** electron-builder `afterSign`: completeness + verification of the packed tree, the app.asar pin, the fuse. */
    async afterSign({ appOutDir }) {
      if (config().mode === 'off') return;
      ready();
      appOutDirs.add(resolve(appOutDir));
      const n = await assertTreesSigned('afterSign');
      // ---- [signing-fix] the bridge: the pre-signed bytes, whose pin app.asar carries; asar integrity enforced -------
      const exe = join(appOutDir, 'resources', 'bridge', BRIDGE_EXE_NAME);
      const j = journal.get(keyOf(exe));
      if (j === undefined || j.kind !== 'bridge' || presigned === null || j.signed !== presigned.signed) {
        throw new SigningError('the packaged bridge exe is not the copy pre-signed in beforePack');
      }
      const asarPath = join(appOutDir, 'resources', 'app.asar');
      if (readAsarFile(asarPath, SIGNED_PIN_ASAR_ENTRY) !== presigned.pinText) {
        throw new SigningError(
          `app.asar does not carry the signed bridge pin (${SIGNED_PIN_ASAR_ENTRY}) - the launcher would refuse the ` +
            'signed bridge',
        );
      }
      if (!(await asarIntegrityFuseOn(join(appOutDir, APP_EXE)))) {
        throw new SigningError(
          `${APP_EXE}: the EnableEmbeddedAsarIntegrityValidation fuse is not on - the pin inside app.asar would not be ` +
            'protected',
        );
      }
      // ---- record every signed file of this tree (llama-server / whisper-cli included) for the smoke / Defender gates
      const root = resolve(appOutDir);
      const files = [...journal.values()]
        .filter((e) => keyOf(e.abs).startsWith(`${keyOf(root)}${sep}`))
        .map((e) => ({
          path: relative(root, e.abs).split(sep).join('/'),
          kind: e.kind,
          provenance: e.source,
          originalSha256: e.original,
          signedSha256: e.signed,
        }));
      const manifest = { schema: 1, mode: cfg.mode, fileDigest: 'sha256', timestampUrl: cfg.timestampUrl, files };
      writeFileSync(join(appOutDir, 'resources', SIGNING_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      log(
        `${n} PE file(s) signed and verified; bridge pin in app.asar; asar integrity on; ${SIGNING_MANIFEST} written`,
      );
    },

    /** electron-builder `artifactBuildCompleted`: the installer (and what it embeds) must be signed and verified. */
    async artifactBuildCompleted({ file }) {
      if (config().mode === 'off') return;
      if (typeof file !== 'string' || !file.toLowerCase().endsWith('.exe')) return; // .blockmap etc.
      ready();
      if (appOutDirs.size === 0)
        throw new SigningError('an installer was built but afterSign never verified the packed tree');
      const j = journal.get(keyOf(file));
      if (j === undefined || (await hash(file)) !== j.signed) {
        throw new SigningError(`${basename(file)} was not signed (or changed after signing)`);
      }
      await assertTreesSigned('installer payload'); // re-walk: elevate.exe is copied in by the NSIS target
      await verifyOrThrow([{ abs: resolve(file), label: basename(file) }], 'installer');
      log(`${basename(file)} signed and verified`);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// real collaborators (used only when signing is ON)
// ---------------------------------------------------------------------------------------------------------------------

/** Temp dirs of this process (staged bridge, azure metadata): removed by ONE exit hook. Outside the repo by design. */
const TEMP_DIRS = new Set();
function tempDir(prefix) {
  if (TEMP_DIRS.size === 0) {
    process.once('exit', () => {
      for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
    });
  }
  const d = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.add(d);
  return d;
}

/**
 * [signing-fix] One file of an app.asar as text (null when the archive or the entry is absent). Never extracts to disk.
 * `entry` uses `/`; @electron/asar 3.4.1 on Windows only finds native-separator paths (measured), hence the join.
 */
export function readAsarText(asarPath, entry) {
  try {
    return require('@electron/asar')
      .extractFile(asarPath, join(...entry.split('/')))
      .toString('utf8');
  } catch {
    return null;
  }
}

/** [signing-fix] True when the Electron exe's fuse wire has EnableEmbeddedAsarIntegrityValidation ENABLED (read only). */
export async function asarIntegrityFuseEnabled(appExe) {
  const { FuseState, FuseV1Options, getCurrentFuseWire } = await import('@electron/fuses');
  const wire = await getCurrentFuseWire(appExe);
  return wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] === FuseState.ENABLE;
}

export const SIGNTOOL_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs signtool.exe (shell: false). Output reaches an error message only, with the thumbprint redacted.
 * [signing-fix, signing-review MAJOR 2] err.message is NEVER used: for a killed signtool (timeout / SIGTERM, err.code
 * null) it is "Command failed: <signtool> sign /sha1 <THUMBPRINT> ...". The reason is built from code / signal only, and
 * the WHOLE message goes through `redact` (electron-builder logs it again: winPackager.js "signing failed for file").
 */
export function createSigntoolSigner({
  signtoolPath,
  redact,
  timeoutMs = SIGNTOOL_TIMEOUT_MS,
  execFileImpl = execFile,
}) {
  return {
    sign({ file, args }) {
      return new Promise((res, rej) => {
        execFileImpl(
          signtoolPath,
          args,
          { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err === null || err === undefined) {
              res();
              return;
            }
            const why = err.killed
              ? `timed out after ${String(timeoutMs)} ms, ${String(err.signal ?? 'killed')}`
              : String(err.code ?? err.signal ?? 'failed');
            const detail = `${String(stderr ?? '')}\n${String(stdout ?? '')}`.trim().slice(-2000);
            rej(new SigningError(redact(`signtool failed for ${basename(file)} (${why}):\n${detail}`)));
          },
        );
      });
    },
  };
}

const PS_VERIFY = (listPath) => `$ErrorActionPreference = 'Stop'
$files = Get-Content -Raw -LiteralPath '${listPath.replace(/'/g, "''")}' | ConvertFrom-Json
$out = foreach ($f in $files) {
  $s = Get-AuthenticodeSignature -LiteralPath $f
  $c = $s.SignerCertificate
  [pscustomobject]@{
    file = $f
    status = [string]$s.Status
    subject = $(if ($c) { $c.Subject } else { '' })
    thumbprint = $(if ($c) { $c.Thumbprint } else { '' })
    timestamped = [bool]$s.TimeStamperCertificate
  }
}
ConvertTo-Json -Compress -Depth 3 -InputObject @($out)`;

/** Get-AuthenticodeSignature through Windows PowerShell (read-only). The thumbprints it returns stay in memory. */
export function createPowershellVerifier() {
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    async verify(files) {
      if (files.length === 0) return [];
      const dir = mkdtempSync(join(tmpdir(), 'wca-verify-'));
      try {
        const list = join(dir, 'files.json');
        writeFileSync(list, JSON.stringify(files));
        const encoded = Buffer.from(PS_VERIFY(list), 'utf16le').toString('base64');
        const stdout = await new Promise((res, rej) => {
          execFile(
            ps,
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
            (err, out, errOut) =>
              err === null
                ? res(String(out))
                : rej(new SigningError(`signature check failed: ${String(errOut).slice(-1000)}`)),
          );
        });
        return JSON.parse(stdout.trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// electron-builder entry points (one session per build process; electron-builder imports this module once)
// ---------------------------------------------------------------------------------------------------------------------

let defaultSession = null;
const session = () => (defaultSession ??= createSigningSession());

/** `win.signtoolOptions.sign` - CustomWindowsSign(configuration, packager). */
export async function sign(configuration) {
  await session().signFile({ path: configuration.path, hash: configuration.hash });
}
/** `beforePack` hook (BeforePackContext: its `packager` gives the project dir and the fuse config). */
export async function beforePack(context) {
  await session().beforePack(context ?? {});
}
/** `afterSign` hook (AfterPackContext). */
export async function afterSign(context) {
  await session().afterSign({ appOutDir: context.appOutDir });
}
/** `artifactBuildCompleted` hook (ArtifactCreated). */
export async function artifactBuildCompleted(event) {
  await session().artifactBuildCompleted({ file: event.file });
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

export function main(
  argv = process.argv.slice(2),
  io = { out: process.stdout, err: process.stderr },
  env = process.env,
) {
  try {
    if (argv[0] === '--check-env') {
      const cfg = readSigningConfig(env);
      if (cfg.mode !== 'off') resolveSigntool(cfg);
      io.out.write(`${describeSigningConfig(cfg)}\n`);
      return 0;
    }
    if (argv[0] === '--plan' && typeof argv[1] === 'string') {
      const root = resolve(argv[1]);
      if (!existsSync(root) || !statSync(root).isDirectory()) throw new SigningError(`${root} is not a packed tree`);
      const plan = signingPlan(listPeFiles(root));
      for (const rel of plan) {
        const c = classifyFile(join(root, ...rel.split('/')));
        io.out.write(`phase ${signingPhase(rel)}  ${c.kind.padEnd(16)} ${rel}\n`);
      }
      io.out.write(`${plan.length} PE file(s); then the NSIS target signs the uninstaller and the installer\n`);
      return 0;
    }
    io.err.write('usage: node scripts/sign-windows.mjs --check-env | --plan <appOutDir>\n');
    return 2;
  } catch (e) {
    io.err.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
