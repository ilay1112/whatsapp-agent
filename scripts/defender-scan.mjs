#!/usr/bin/env node
// scripts/defender-scan.mjs - Microsoft Defender scan gate for the packaged app (D-078, NOTES R11). Owner: defender-gate.
//
//   node scripts/defender-scan.mjs [<file-or-folder> ...] [--no-installer] [--timeout-ms=<ms>]
//
// With no positional argument the targets are `dist/win-unpacked` and every NSIS installer at the top of `dist/`
// (`WhatsAppCalendarAgent-Setup-<version>.exe`, the electron-builder.yml `nsis.artifactName`), when present.
//
// For every target it runs ONE on-demand custom scan:
//
//   "%ProgramFiles%\Windows Defender\MpCmdRun.exe" -Scan -ScanType 3 -File <absolute path> -DisableRemediation
//
// `-DisableRemediation` = report only: no action is taken on a detection, exclusions are ignored (so a local exclusion
// cannot hide a detection from the gate), archives (app.asar, the NSIS payload) are scanned, and the detections are
// printed to the console. The gate never quarantines, never brings anything back from quarantine, never adds an
// exclusion and never changes a Defender preference - it only reads. Every process is started with an array argv and
// `shell: false`.
//
// MpCmdRun exit codes are NOT enough on their own (measured 2026-10-04 on this PC, platform 4.18): exit 2 means
// "threats found" AND ALSO "CmdTool: Failed with hr = 0x80508023" (e.g. the path does not exist). So a verdict needs
// the exit code AND the console text:
//   clean   = exit 0 and the "found no threats" sentence;
//   threats = exit 2 (or 0) with a "found N threats" (N > 0) sentence or `Threat : <name>` lines;
//   error   = anything else (a spawn failure, a timeout, "Failed with hr", unrecognised output). Never clean.
//
// Authenticode (information while signing is off): `Get-AuthenticodeSignature` for every PE file (.exe/.dll/.node/.sys)
// of each target, via `powershell.exe -NoProfile -NonInteractive -Command <fixed script>`; the paths travel in the
// environment variable WCA_AUTHENTICODE_PATHS (one per line), never interpolated into the script text. Today (D-078 "Not now")
// the app is unsigned, so NotSigned is expected and is NOT a failure - unless the set is MIXED (some of our files Valid,
// some not; Microsoft-signed DirectX DLLs excluded): a failed / partial signed build or a stale unsigned installer
// fails. Signatures are ENFORCED when WCA_SIGN_MODE is set (any value other than empty / off / none) OR a folder target
// carries resources/signing-manifest.json (a signed build) [signing-fix, review MAJOR 5]: every file Valid, time-stamped,
// signer CN = WCA_SIGN_PUBLISHER when set, "status could not be read" fails, and every manifest signedSha256 must
// match the bytes on disk.
//
// Payload [signing-fix, review MAJOR 4]: a folder target must hold the app exe, resources/app.asar, the bridge exe and
// at least 44 PE files; dist/win-unpacked is always a default target. An empty / truncated / missing tree is exit 4.
// A clean verdict also needs the "Scanning <target> found no threats" line to name that target.
//
// Exit codes: 0 = PASS, 1 = THREATS FOUND, 2 = SIGNATURE FAIL (WCA_SIGN_MODE set), 4 = SCAN INCOMPLETE (a target
// could not be scanned; never a release result). Precedence: 1 > 2 > 4 > 0.
//
// Nothing the gate scans is ever executed: no packaged exe, no bridge / llama / whisper binary, no installer.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNER = 'defender-gate';

export const EXIT_PASS = 0;
export const EXIT_THREATS = 1;
export const EXIT_SIGNATURE = 2;
export const EXIT_INCOMPLETE = 4;

/** 20 minutes per target: the unpacked tree is ~1 GB of PE files and archives once llama/whisper are staged. */
export const DEFAULT_SCAN_TIMEOUT_MS = 20 * 60_000;
export const AUTHENTICODE_TIMEOUT_MS = 5 * 60_000;
/** Cap on captured console output per process (MpCmdRun prints a few lines; the cap only guards a runaway child). */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Keeps WCA_AUTHENTICODE_PATHS well under the 32,767-character Windows environment-block limit per variable. */
export const AUTHENTICODE_BATCH_CHARS = 20_000;

export const PE_EXT_RE = /\.(exe|dll|node|sys)$/i;
/** electron-builder.yml `nsis.artifactName: 'WhatsAppCalendarAgent-Setup-${version}.${ext}'`. */
export const INSTALLER_RE = /^WhatsAppCalendarAgent-Setup-[^\\/]+\.exe$/i;
export const AUTHENTICODE_STATUSES = [
  'Valid',
  'UnknownError',
  'NotSigned',
  'HashMismatch',
  'NotTrusted',
  'NotSupportedFileFormat',
  'Incompatible',
];

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // never URL.pathname - the repo path contains a space

/** `%ProgramFiles%\Windows Defender\MpCmdRun.exe` - an absolute path, never a PATH lookup. */
export function mpCmdRunPath(env = process.env) {
  return join(env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
}

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` - an absolute path, never a PATH lookup. */
export function powershellPath(env = process.env) {
  return join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The complete MpCmdRun argv for one target. This array is the ONLY set of switches the gate ever passes. */
export function mpCmdRunArgs(target) {
  return ['-Scan', '-ScanType', '3', '-File', target, '-DisableRemediation'];
}

/** Console bytes -> text. MpCmdRun writes ANSI today; a UTF-16LE stream (BOM or every 2nd byte NUL) is also accepted. */
export function decodeOutput(buf) {
  if (typeof buf === 'string') return buf;
  if (!buf || buf.length === 0) return '';
  const bom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  let nulOdd = 0;
  const probe = Math.min(buf.length, 512);
  for (let i = 1; i < probe; i += 2) if (buf[i] === 0) nulOdd += 1;
  if (bom || nulOdd > probe / 4) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8');
}

/** Detection names from MpCmdRun's "LIST OF DETECTED THREATS" block (`Threat : <name>` lines), de-duplicated. */
export function parseThreatNames(text) {
  const names = [];
  for (const m of String(text).matchAll(/^\s*Threat\s*:\s*(.+?)\s*$/gim)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** `found N threats` -> N; `found no threats` -> 0; neither -> null. */
export function parseThreatCount(text) {
  const t = String(text);
  if (/found\s+no\s+threats/i.test(t)) return 0;
  const m = /found\s+(\d+)\s+threats?/i.exec(t);
  return m ? Number(m[1]) : null;
}

/** Path comparison key: case-insensitive, `/` and `\` alike, no trailing separator. */
const pathKey = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** [signing-fix] True when the console names THIS target in "Scanning <target> found no threats". */
export function cleanLineNamesTarget(text, target) {
  const want = pathKey(target);
  for (const m of String(text).matchAll(/^\s*Scanning\s+(.+?)\s+found\s+no\s+threats\.?\s*$/gim)) {
    if (pathKey(m[1]) === want) return true;
  }
  return false;
}

/**
 * The verdict for one MpCmdRun run. With `target`, "clean" also needs the "Scanning <target> found no threats" line
 * for THAT target [signing-fix, review MAJOR 4] - a sentence about some other path is not a clean result.
 * @returns {{ verdict: 'clean' | 'threats' | 'error', threats: string[], detail: string }}
 */
export function classifyScan({ exitCode, stdout = '', stderr = '', timedOut = false, spawnError = null, target }) {
  const text = `${stdout}\n${stderr}`;
  if (spawnError) {
    const code = spawnError.code ? ` (${String(spawnError.code)})` : '';
    return {
      verdict: 'error',
      threats: [],
      detail: `MpCmdRun could not be started${code}: ${spawnError.message ?? String(spawnError)}`,
    };
  }
  if (timedOut) return { verdict: 'error', threats: [], detail: 'MpCmdRun timed out and was stopped' };

  const threats = parseThreatNames(text);
  const count = parseThreatCount(text);
  const hr = /Failed with hr\s*=\s*(0x[0-9a-f]+)/i.exec(text);
  if ((exitCode === 2 || exitCode === 0) && (threats.length > 0 || (count !== null && count > 0))) {
    return {
      verdict: 'threats',
      threats: threats.length > 0 ? threats : ['(detection names not printed - see the MpCmdRun output above)'],
      detail: `Defender reported ${String(count ?? threats.length)} threat(s)`,
    };
  }
  if (hr) {
    return {
      verdict: 'error',
      threats: [],
      detail: `MpCmdRun failed with hr = ${hr[1]} (exit ${String(exitCode)}); see %TEMP%\\MpCmdRun.log`,
    };
  }
  if (exitCode === 0 && count === 0) {
    if (target !== undefined && !cleanLineNamesTarget(text, target)) {
      return {
        verdict: 'error',
        threats: [],
        detail: '"found no threats" does not name the target - output not recognised, NOT reported as clean',
      };
    }
    return { verdict: 'clean', threats: [], detail: 'found no threats' };
  }
  return {
    verdict: 'error',
    threats: [],
    detail:
      exitCode === 0
        ? 'exit 0 but the "found no threats" sentence is missing - output not recognised, NOT reported as clean'
        : `MpCmdRun exit ${String(exitCode)} without a threat report - the scan did not complete`,
  };
}

/** True when the release is meant to be signed: WCA_SIGN_MODE set to anything but empty / off / none. */
export function signModeActive(env = process.env) {
  const v = String(env.WCA_SIGN_MODE ?? '')
    .trim()
    .toLowerCase();
  return v !== '' && v !== 'off' && v !== 'none';
}

/** Subject CN of an X.500 DN as Get-AuthenticodeSignature prints it ('CN="A, Inc.", O=...' or 'CN=A, O=...'). Pure. */
export function subjectCn(subject) {
  const m = /(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]*)/.exec(String(subject ?? ''));
  if (m === null) return null;
  const v = m[1].trim();
  return v.startsWith('"') ? v.slice(1, -1).replace(/""/g, '"') : v;
}

/** A Microsoft-issued signature (Electron ships d3dcompiler_47.dll / dxil.dll signed "CN=Microsoft Windows, O=Microsoft Corporation"). */
export function isMicrosoftSigner(subject) {
  return (
    /^Microsoft\b/.test(subjectCn(subject) ?? '') && /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/.test(String(subject))
  );
}

/**
 * Authenticode records -> the per-file lines and the failures.
 *  - enforce [signing-fix, review MAJOR 5]: every file must be Valid AND time-stamped (TimeStamperCertificate), and its
 *    signer CN must equal `publisher` when one is given (WCA_SIGN_PUBLISHER) - "Valid from any CA" is not enough;
 *  - not enforced: information only, EXCEPT a mixed set - some of OUR files Valid and some not (Microsoft-signed
 *    DirectX DLLs do not count as ours) - which is a failed or partial signed build (or a stale unsigned installer
 *    next to a signed tree) and fails.
 * @param {{ path: string, status: string, signer?: string | null, timestamped?: boolean }[]} records
 * @param {string[]} expectedFiles every file whose status was asked for (a missing record is a failure when enforcing)
 * @param {{ enforce: boolean, publisher?: string | null }} opts
 */
export function authenticodeProblems(records, expectedFiles, { enforce, publisher = null }) {
  const byPath = new Map(records.map((r) => [String(r.path).toLowerCase(), r]));
  const lines = [];
  const failures = [];
  const counts = {};
  const oursValid = [];
  const oursNotValid = [];
  for (const file of expectedFiles) {
    const r = byPath.get(file.toLowerCase());
    const status = r ? String(r.status) : 'Unreadable';
    counts[status] = (counts[status] ?? 0) + 1;
    const signer = r?.signer ? ` - ${String(r.signer)}` : '';
    const ts = status === 'Valid' && r?.timestamped !== true ? ' (no time stamp)' : '';
    const why = r?.error ? ` (${String(r.error)})` : '';
    lines.push(`${status.padEnd(22)} ${file}${signer}${ts}${why}`);
    if (status !== 'Valid') oursNotValid.push(`${file}: ${status}`);
    else if (!isMicrosoftSigner(r?.signer)) oursValid.push(file);
    if (!enforce) continue;
    if (status !== 'Valid') failures.push(`${file}: Authenticode status ${status} (signing is enforced)`);
    else if (r?.timestamped !== true)
      failures.push(`${file}: no time stamp (TimeStamperCertificate) - signing is enforced`);
    else if (publisher !== null && subjectCn(r?.signer) !== publisher) {
      failures.push(`${file}: signer CN "${String(subjectCn(r?.signer))}" is not WCA_SIGN_PUBLISHER "${publisher}"`);
    }
  }
  if (!enforce && oursValid.length > 0 && oursNotValid.length > 0) {
    failures.push(
      `partially signed: ${String(oursValid.length)} of our PE file(s) are Valid but ${String(oursNotValid.length)} ` +
        'are not - a failed / partial signed build, or a stale unsigned installer next to a signed tree:',
      ...oursNotValid,
    );
  }
  return { lines, failures, counts };
}

/** `WhatsApp Calendar Agent.exe` (electron-builder productName). */
export const APP_EXE = 'WhatsApp Calendar Agent.exe';
/** Written by scripts/sign-windows.mjs afterSign into every SIGNED tree. */
export const SIGNING_MANIFEST_REL = 'resources/signing-manifest.json';
/**
 * [signing-fix, review MAJOR 4] What a packed tree (a folder target) must contain for the gate to pass: the app exe,
 * app.asar, the bridge, and at least `minPeFiles` PE files (44 in today's --dir tree: `node scripts/sign-windows.mjs
 * --plan dist/win-unpacked`). An empty or truncated tree (a failed build) is never a clean result.
 */
export const EXPECTED_PAYLOAD = Object.freeze({
  files: Object.freeze([APP_EXE, 'resources/app.asar', 'resources/bridge/whatsapp-bridge.exe']),
  minPeFiles: 44,
});

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Problems of one folder target against the expected payload ([] = complete; a missing folder is a scan error). */
export function payloadProblems(dir, payload = EXPECTED_PAYLOAD) {
  if (!isDirectory(dir)) return [];
  const problems = payload.files
    .filter((rel) => !existsSync(join(dir, ...rel.split('/'))))
    .map((rel) => `${dir}: ${rel} is missing`);
  const pe = listPeFiles(dir).length;
  if (pe < payload.minPeFiles) {
    problems.push(
      `${dir}: ${String(pe)} PE file(s), expected at least ${String(payload.minPeFiles)} (truncated tree?)`,
    );
  }
  return problems;
}

/** Streamed sha256 of a file (lower-case hex). Reads only. */
function sha256Of(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')));
  });
}

/**
 * [signing-fix, review MAJOR 5] Cross-checks a signed tree's resources/signing-manifest.json: every listed file must
 * exist inside the tree and still hash to its `signedSha256`. Returns the failures ([] = consistent).
 */
export async function manifestProblems(dir) {
  const manifestPath = join(dir, ...SIGNING_MANIFEST_REL.split('/'));
  let files;
  try {
    files = JSON.parse(readFileSync(manifestPath, 'utf8')).files;
    if (!Array.isArray(files)) throw new Error('no files array');
  } catch (err) {
    return [`${manifestPath}: signing-manifest.json is unreadable (${err instanceof Error ? err.message : 'error'})`];
  }
  const failures = [];
  const root = `${pathKey(resolve(dir))}\\`;
  for (const e of files) {
    const rel = typeof e?.path === 'string' ? e.path : '';
    const abs = resolve(dir, ...rel.split('/'));
    if (rel === '' || !pathKey(abs).startsWith(root)) {
      failures.push(`${manifestPath}: entry ${JSON.stringify(rel)} is not a path inside the tree`);
    } else if (!existsSync(abs)) {
      failures.push(`${abs}: listed in signing-manifest.json but missing`);
    } else if ((await sha256Of(abs)) !== String(e.signedSha256 ?? '').toLowerCase()) {
      failures.push(`${abs}: on-disk sha256 differs from signing-manifest.json signedSha256`);
    }
  }
  return failures;
}

/** True when `head` (the first bytes of a file) is a PE image: `MZ`, then `PE\0\0` at the e_lfanew offset. */
export function hasPeHeader(head) {
  if (!head || head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
  const off = head.readUInt32LE(0x3c);
  return (
    off + 4 <= head.length && head[off] === 0x50 && head[off + 1] === 0x45 && head[off + 2] === 0 && head[off + 3] === 0
  );
}

/** Reads (never executes) the first 4 KiB of a file; `null` when it cannot be read. */
function readHead(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A PE file by extension OR by header (the signing pipeline also detects PE files by header, not by name). */
function isPeFile(path) {
  return PE_EXT_RE.test(path) || hasPeHeader(readHead(path));
}

/** Every PE file under `dir` (absolute paths), or `[dir]` itself when it is a PE file. */
export function listPeFiles(target) {
  let st;
  try {
    st = statSync(target);
  } catch {
    return [];
  }
  if (st.isFile()) return isPeFile(target) ? [target] : [];
  const out = [];
  const stack = [target];
  while (stack.length > 0) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && isPeFile(p)) out.push(p);
    }
  }
  return out.sort();
}

/** The NSIS installer(s) at the top of `distDir` (electron-builder's artifactName); `[]` when none was built. */
export function findInstallers(distDir) {
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isFile() && INSTALLER_RE.test(e.name))
    .map((e) => join(distDir, e.name))
    .sort();
}

/**
 * The value of WCA_AUTHENTICODE_PATHS: one path per line. A Windows path cannot contain CR/LF, so the list is
 * unambiguous; a path that does contain one is refused rather than split. (Measured 2026-10-04: a JSON array piped
 * through Windows PowerShell 5.1 `ConvertFrom-Json` arrives as ONE pipeline object, which `@(...)` wraps instead of
 * enumerating - every path then came back unmatched. Plain lines avoid that version trap.)
 */
export function encodePathList(paths) {
  for (const p of paths) if (/[\r\n]/.test(p)) throw new Error(`path contains a line break: ${JSON.stringify(p)}`);
  return paths.join('\n');
}

/** Batches `paths` so each encoded list stays under AUTHENTICODE_BATCH_CHARS. */
export function batchPaths(paths, maxChars = AUTHENTICODE_BATCH_CHARS) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const p of paths) {
    const add = p.length + 1;
    if (cur.length > 0 && len + add > maxChars) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += add;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/**
 * The fixed PowerShell script. It reads the paths (one per line) from $env:WCA_AUTHENTICODE_PATHS and only READS
 * signatures: no certificate store, no Set-* / Add-* cmdlet, no file is executed.
 */
export const AUTHENTICODE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$paths = @($env:WCA_AUTHENTICODE_PATHS -split "`n" | Where-Object { $_ -ne \'\' })',
  '$out = foreach ($p in $paths) {',
  '  try {',
  '    $s = Get-AuthenticodeSignature -LiteralPath $p',
  '    $signer = $null',
  '    if ($s.SignerCertificate) { $signer = $s.SignerCertificate.Subject }',
  '    [pscustomobject]@{ path = [string]$p; status = [string]$s.Status; signer = $signer; ' +
    'timestamped = [bool]$s.TimeStamperCertificate; error = $null }',
  '  } catch {',
  "    [pscustomobject]@{ path = [string]$p; status = 'Unreadable'; signer = $null; error = $_.Exception.Message }",
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($out) -Compress -Depth 3',
].join('\n');

export function authenticodeArgs() {
  return ['-NoProfile', '-NonInteractive', '-Command', AUTHENTICODE_SCRIPT];
}

/** PowerShell's JSON -> records. Throws on anything that is not an array of `{ path, status }`. */
export function parseAuthenticodeJson(text) {
  const trimmed = String(text).trim();
  const parsed = JSON.parse(trimmed === '' ? '[]' : trimmed);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  for (const r of arr) {
    if (!r || typeof r.path !== 'string' || typeof r.status !== 'string') {
      throw new Error('unexpected Get-AuthenticodeSignature output');
    }
  }
  return arr;
}

/**
 * The default process runner: array argv, `shell: false`, hidden window, bounded output, killed on timeout.
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean, spawnError: Error | null }>}
 */
export function defaultRunner(command, args, { timeoutMs, env } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, env: env ?? process.env });
    } catch (err) {
      resolvePromise({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: err });
      return;
    }
    const out = [];
    const errOut = [];
    let outBytes = 0;
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    const take = (sink) => (chunk) => {
      if (outBytes >= MAX_OUTPUT_BYTES) return;
      outBytes += chunk.length;
      sink.push(chunk);
    };
    child.stdout?.on('data', take(out));
    child.stderr?.on('data', take(errOut));
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs)
        : null;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        exitCode,
        stdout: decodeOutput(Buffer.concat(out)),
        stderr: decodeOutput(Buffer.concat(errOut)),
        timedOut,
        spawnError,
      });
    };
    child.on('error', (err) => {
      spawnError = err;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** One Defender custom scan of one target. */
export async function scanTarget({ target, runner, mpCmdRun, timeoutMs }) {
  if (!existsSync(target)) {
    return { target, verdict: 'error', threats: [], detail: 'target does not exist', output: '' };
  }
  const r = await runner(mpCmdRun, mpCmdRunArgs(target), { timeoutMs });
  const c = classifyScan({ ...r, target });
  return { target, ...c, exitCode: r.exitCode, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Authenticode records for `files`; `{ records, error }` - error is set when PowerShell could not report them. */
export async function readAuthenticode({ files, runner, env, powershell }) {
  const records = [];
  for (const batch of batchPaths(files)) {
    const r = await runner(powershell, authenticodeArgs(), {
      timeoutMs: AUTHENTICODE_TIMEOUT_MS,
      env: { ...env, WCA_AUTHENTICODE_PATHS: encodePathList(batch) },
    });
    if (r.spawnError || r.timedOut || r.exitCode !== 0) {
      const why = r.spawnError ? r.spawnError.message : r.timedOut ? 'timed out' : `exit ${String(r.exitCode)}`;
      return { records, error: `Get-AuthenticodeSignature did not run (${why})` };
    }
    try {
      records.push(...parseAuthenticodeJson(r.stdout));
    } catch (err) {
      return { records, error: `Get-AuthenticodeSignature output unreadable: ${err.message}` };
    }
  }
  return { records, error: null };
}

/** The exit code for a set of results (precedence 1 > 2 > 4 > 0). An incomplete payload is incomplete (4). */
export function gateExitCode({ scans, signatureFailures, payloadProblems: payload = [] }) {
  if (scans.some((s) => s.verdict === 'threats')) return EXIT_THREATS;
  if (signatureFailures.length > 0) return EXIT_SIGNATURE;
  if (scans.length === 0 || scans.some((s) => s.verdict !== 'clean') || payload.length > 0) return EXIT_INCOMPLETE;
  return EXIT_PASS;
}

/**
 * Scans every target and reads its Authenticode status.
 * [signing-fix] A folder target must hold the expected payload (review MAJOR 4). Signatures are enforced when
 * WCA_SIGN_MODE is set OR a folder target carries resources/signing-manifest.json (a signed build), and that manifest
 * is cross-checked against the bytes on disk (review MAJOR 5).
 * @param {{ targets: string[], runner?: Function, env?: Record<string, string | undefined>, log?: (line: string) => void,
 *           timeoutMs?: number, authenticode?: boolean, payload?: { files: string[], minPeFiles: number } }} opts
 */
export async function runDefenderGate({
  targets,
  runner = defaultRunner,
  env = process.env,
  log = () => {},
  timeoutMs = DEFAULT_SCAN_TIMEOUT_MS,
  authenticode = true,
  payload = EXPECTED_PAYLOAD,
}) {
  const mpCmdRun = mpCmdRunPath(env);
  const folders = targets.filter(isDirectory);
  const missingPayload = folders.flatMap((d) => payloadProblems(d, payload));
  for (const p of missingPayload) log(`defender-scan: PAYLOAD ${p}`);
  const signedTrees = folders.filter((d) => existsSync(join(d, ...SIGNING_MANIFEST_REL.split('/'))));
  const enforce = signModeActive(env) || signedTrees.length > 0;
  const publisher = String(env.WCA_SIGN_PUBLISHER ?? '').trim() || null;
  const scans = [];
  for (const target of targets) {
    log(`defender-scan: scanning ${target}`);
    const started = Date.now();
    const s = await scanTarget({ target, runner, mpCmdRun, timeoutMs });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (s.verdict === 'clean') log(`  OK      no threats (${secs} s)`);
    else if (s.verdict === 'threats') {
      log(`  THREATS ${s.detail}:`);
      for (const t of s.threats) log(`          - ${t}`);
    } else log(`  ERROR   scan could not complete: ${s.detail}`);
    if (s.verdict !== 'clean' && s.output) for (const l of s.output.split(/\r?\n/)) log(`          | ${l}`);
    scans.push(s);
  }

  let signatureFailures = [];
  for (const d of signedTrees) signatureFailures.push(...(await manifestProblems(d)));
  if (authenticode) {
    const files = [...new Set(targets.flatMap((t) => listPeFiles(t)))];
    const why = signModeActive(env) ? 'WCA_SIGN_MODE is set' : `${SIGNING_MANIFEST_REL} present (a signed build)`;
    log(
      `defender-scan: Authenticode status of ${String(files.length)} PE file(s) - ` +
        (enforce
          ? `ENFORCED (${why}: every file Valid + time-stamped` +
            `${publisher === null ? '' : `, signer CN "${publisher}"`})`
          : 'information only (signing off, D-078); a mixed signed/unsigned set still fails'),
    );
    if (enforce && files.length === 0) signatureFailures.push('no PE file was found to verify (signing is enforced)');
    const { records, error } = await readAuthenticode({ files, runner, env, powershell: powershellPath(env) });
    if (error) log(`  WARN    ${error}`);
    const a = authenticodeProblems(records, files, { enforce, publisher });
    for (const l of a.lines) log(`  ${l}`);
    log(
      `  summary: ${
        Object.entries(a.counts)
          .map(([k, v]) => `${k} ${String(v)}`)
          .join(', ') || 'no PE files'
      }`,
    );
    signatureFailures = [...signatureFailures, ...a.failures]; // 'Unreadable' (PowerShell failed) fails when enforced
  } else if (enforce) {
    signatureFailures.push('Authenticode was not read although signing is enforced');
  }

  const exitCode = gateExitCode({ scans, signatureFailures, payloadProblems: missingPayload });
  return { exitCode, scans, signatureFailures, payloadProblems: missingPayload, enforce };
}

export function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const t = argv.find((a) => a.startsWith('--timeout-ms='));
  const timeoutMs = t ? Number(t.slice('--timeout-ms='.length)) : DEFAULT_SCAN_TIMEOUT_MS;
  return {
    targets: positional,
    noInstaller: argv.includes('--no-installer'),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SCAN_TIMEOUT_MS,
  };
}

/**
 * Default targets: dist/win-unpacked - ALWAYS [signing-fix, review MAJOR 4]: a missing tree is a scan that could not
 * run (exit 4), never a "note" - plus the NSIS installer(s) in dist/, when present. To scan an installer alone, name it.
 */
export function defaultTargets(repoRoot = REPO_ROOT, { noInstaller = false } = {}) {
  const dist = join(repoRoot, 'dist');
  const out = [join(dist, 'win-unpacked')];
  if (!noInstaller) out.push(...findInstallers(dist));
  return out;
}

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }, deps = {}) {
  const log = (line) => io.out.write(`${line}\n`);
  const args = parseArgs(argv);
  const targets =
    args.targets.length > 0
      ? args.targets.map((t) => resolve(REPO_ROOT, t))
      : defaultTargets(REPO_ROOT, { noInstaller: args.noInstaller });
  if (args.targets.length === 0 && !existsSync(targets[0])) {
    io.err.write(
      'defender-scan: dist/win-unpacked does not exist - build first (`npm run pack:dir`, then ' +
        '`npx electron-builder --win --x64` for the installer). This run cannot pass.\n',
    );
  }
  const r = await runDefenderGate({ targets, timeoutMs: args.timeoutMs, log, ...deps });
  log('');
  if (r.exitCode === EXIT_THREATS) {
    io.err.write('defender-scan: FAIL - Microsoft Defender reported threats:\n');
    for (const s of r.scans.filter((x) => x.verdict === 'threats')) {
      for (const t of s.threats) io.err.write(`  - ${t}  (${basename(s.target)})\n`);
    }
    io.err.write('If this is a false positive, see docs/WINDOWS-SECURITY.md "Submitting a false positive".\n');
  } else if (r.exitCode === EXIT_SIGNATURE) {
    io.err.write(`defender-scan: FAIL - ${String(r.signatureFailures.length)} file(s) not validly signed:\n`);
    for (const f of r.signatureFailures) io.err.write(`  - ${f}\n`);
  } else if (r.exitCode === EXIT_INCOMPLETE) {
    io.err.write(
      'defender-scan: SCAN INCOMPLETE - at least one target could not be scanned; this is NOT a clean result.\n',
    );
    for (const s of r.scans.filter((x) => x.verdict === 'error')) io.err.write(`  - ${s.target}: ${s.detail}\n`);
    for (const p of r.payloadProblems) io.err.write(`  - incomplete payload: ${p}\n`);
  } else {
    log(
      `defender-scan: PASS - ${String(r.scans.length)} target(s) scanned, no threats` +
        (r.enforce
          ? '; every PE file is validly signed and time-stamped.'
          : '; Authenticode reported for information (signing off).'),
    );
  }
  return r.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`defender-scan: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(EXIT_INCOMPLETE);
    },
  );
}
