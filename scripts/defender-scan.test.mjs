// scripts/defender-scan.test.mjs - the Defender scan gate against a FAKE MpCmdRun / PowerShell (injected runner).
// No Defender scan and no PowerShell run here: the real gate run is recorded in ops/agent-notes/defender-gate.md.
// The only real process is `node` itself, to prove the default runner kills a child that outlives its timeout.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_EXE,
  AUTHENTICODE_SCRIPT,
  EXPECTED_PAYLOAD,
  EXIT_INCOMPLETE,
  EXIT_PASS,
  EXIT_SIGNATURE,
  EXIT_THREATS,
  authenticodeArgs,
  authenticodeProblems,
  batchPaths,
  classifyScan,
  decodeOutput,
  defaultRunner,
  defaultTargets,
  encodePathList,
  findInstallers,
  gateExitCode,
  hasPeHeader,
  listPeFiles,
  main,
  mpCmdRunArgs,
  mpCmdRunPath,
  parseArgs,
  parseThreatCount,
  parseThreatNames,
  payloadProblems,
  runDefenderGate,
  signModeActive,
} from './defender-scan.mjs';

const SOURCE = readFileSync(fileURLToPath(new URL('./defender-scan.mjs', import.meta.url)), 'utf8');

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wca-defender-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A packaged-tree look-alike: the app exe, a runtime DLL, app.asar (non-PE) and the nested bridge exe - 3 PE files.
 *  Empty files - nothing is executed. The real tree has 44 PE files: tests use `gate()` with a floor of 3. */
function fakeTree() {
  const root = tmp();
  const unpacked = join(root, 'win-unpacked');
  mkdirSync(join(unpacked, 'resources', 'bridge'), { recursive: true });
  writeFileSync(join(unpacked, APP_EXE), '');
  writeFileSync(join(unpacked, 'ffmpeg.dll'), '');
  writeFileSync(join(unpacked, 'resources', 'app.asar'), '');
  writeFileSync(join(unpacked, 'resources', 'bridge', 'whatsapp-bridge.exe'), '');
  return { root, unpacked };
}
/** [signing-fix] the gate with the real payload rule but a PE floor that fits the 3-file fake tree. */
const TEST_PAYLOAD = { ...EXPECTED_PAYLOAD, minPeFiles: 3 };
const gate = (opts) => runDefenderGate({ payload: TEST_PAYLOAD, ...opts });

// Console text in the exact shape MpCmdRun printed on this PC (2026-10-04); the threat block is MpCmdRun's documented
// "LIST OF DETECTED THREATS" layout with a synthetic detection name.
const CLEAN_OUT = (t) => `Scan starting...\r\nScan finished.\r\nScanning ${t} found no threats.\r\n`;
const THREAT_OUT = (t) =>
  `Scan starting...\r\nScan finished.\r\nScanning ${t} found 2 threats.\r\n\r\nLIST OF DETECTED THREATS\r\n` +
  '-----------------------------\r\nThreat                  : Trojan:Win32/Example.A!ml\r\nResources               : 1 total\r\n' +
  `    file                : ${t}\\App.exe\r\n-----------------------------\r\n` +
  'Threat                  : PUA:Win32/Example.B\r\nResources               : 1 total\r\n-----------------------------\r\n';
const HR_OUT =
  'Scan starting...\r\nCmdTool: Failed with hr = 0x80508023. Check C:\\Users\\x\\AppData\\Local\\Temp\\MpCmdRun.log for more information\r\n';

/**
 * A fake runner. `scan(target)` decides the MpCmdRun result; `ps(paths)` the PowerShell result. Every call is recorded.
 */
function fakeRunner({ scan, ps } = {}) {
  const calls = [];
  const runner = async (command, args, opts = {}) => {
    calls.push({ command, args, opts });
    if (/MpCmdRun\.exe$/i.test(command)) {
      const target = args[args.indexOf('-File') + 1];
      return {
        exitCode: 0,
        stdout: CLEAN_OUT(target),
        stderr: '',
        timedOut: false,
        spawnError: null,
        ...(scan ? scan(target) : {}),
      };
    }
    const paths = opts.env.WCA_AUTHENTICODE_PATHS.split('\n');
    const base = {
      exitCode: 0,
      stdout: JSON.stringify(paths.map((p) => ({ path: p, status: 'NotSigned', signer: null }))),
      stderr: '',
      timedOut: false,
      spawnError: null,
    };
    return { ...base, ...(ps ? ps(paths) : {}) };
  };
  return { runner, calls };
}

const quietEnv = (extra = {}) => ({ ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', ...extra });

describe('defender-scan.mjs - what it is allowed to run', () => {
  it('starts processes only with an array argv and shell:false, and never through a shell', () => {
    expect(SOURCE).toMatch(/spawn\(command, args, \{ shell: false, windowsHide: true/);
    expect(SOURCE).not.toMatch(/shell:\s*true/);
    expect(SOURCE).not.toMatch(/[^.\w]exec(Sync)?\(|execFile|spawnSync/); // RegExp#exec is not a process
    expect(SOURCE.match(/[^a-zA-Z.]spawn\(/g) ?? []).toHaveLength(1);
  });
  it('never touches Defender preferences, quarantine, definitions or certificate stores', () => {
    expect(SOURCE).not.toMatch(
      /-Restore|MpPreference|ExclusionPath|ExclusionProcess|-RemoveDefinitions|SignatureUpdate/i,
    );
    expect(SOURCE).not.toMatch(/Cert:\\|Import-Certificate|Import-PfxCertificate|certutil|New-SelfSignedCertificate/i);
    expect(AUTHENTICODE_SCRIPT).not.toMatch(/\bSet-|\bAdd-|\bRemove-|Invoke-Expression|\biex\b|Start-Process|&\s*\$/i);
  });
  it('MpCmdRun argv is exactly the report-only custom scan of one path', () => {
    expect(mpCmdRunArgs('C:\\dev\\whatsapp agent\\dist\\win-unpacked')).toEqual([
      '-Scan',
      '-ScanType',
      '3',
      '-File',
      'C:\\dev\\whatsapp agent\\dist\\win-unpacked',
      '-DisableRemediation',
    ]);
    expect(mpCmdRunPath({ ProgramFiles: 'D:\\PF' })).toBe(join('D:\\PF', 'Windows Defender', 'MpCmdRun.exe'));
  });
  it('PowerShell gets a fixed script; the file paths travel in the environment, never in the script text', async () => {
    const { unpacked } = fakeTree();
    const { runner, calls } = fakeRunner();
    await gate({ targets: [unpacked], runner, env: quietEnv() });
    const ps = calls.filter((c) => /powershell\.exe$/i.test(c.command));
    expect(ps).toHaveLength(1);
    expect(ps[0].command).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(ps[0].args).toEqual(authenticodeArgs());
    expect(ps[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(ps[0].args.join(' ')).not.toContain(unpacked);
    expect(ps[0].opts.env.WCA_AUTHENTICODE_PATHS.split('\n')).toHaveLength(3);
  });
  it('the path list is one path per line (no ConvertFrom-Json: PS 5.1 would wrap the array as ONE object)', () => {
    expect(encodePathList(['C:\\a b\\x.exe', 'C:\\y.dll'])).toBe('C:\\a b\\x.exe\nC:\\y.dll');
    expect(() => encodePathList(['C:\\bad\npath.exe'])).toThrow(/line break/);
    expect(AUTHENTICODE_SCRIPT).not.toMatch(/ConvertFrom-Json/);
    expect(AUTHENTICODE_SCRIPT).toContain('-split "`n"');
  });
});

describe('classifyScan / parsing', () => {
  it('clean = exit 0 AND the "found no threats" sentence', () => {
    expect(classifyScan({ exitCode: 0, stdout: CLEAN_OUT('C:\\x') }).verdict).toBe('clean');
  });
  it('threats = exit 2 with the threat list; every detection name is returned', () => {
    const c = classifyScan({ exitCode: 2, stdout: THREAT_OUT('C:\\x') });
    expect(c.verdict).toBe('threats');
    expect(c.threats).toEqual(['Trojan:Win32/Example.A!ml', 'PUA:Win32/Example.B']);
    expect(parseThreatCount(THREAT_OUT('C:\\x'))).toBe(2);
  });
  it('exit 2 with "Failed with hr" is a scan that could NOT run, not a detection (measured MpCmdRun behaviour)', () => {
    const c = classifyScan({ exitCode: 2, stdout: HR_OUT });
    expect(c.verdict).toBe('error');
    expect(c.detail).toMatch(/0x80508023/);
  });
  it('never reports anything else as clean', () => {
    expect(classifyScan({ exitCode: 0, stdout: 'Scan starting...\r\n' }).verdict).toBe('error');
    expect(classifyScan({ exitCode: 0, stdout: '' }).verdict).toBe('error');
    expect(classifyScan({ exitCode: 2, stdout: 'Scan starting...' }).verdict).toBe('error');
    expect(classifyScan({ exitCode: 1, stdout: CLEAN_OUT('C:\\x') }).verdict).toBe('error');
    expect(classifyScan({ exitCode: null, stdout: CLEAN_OUT('C:\\x') }).verdict).toBe('error');
    expect(classifyScan({ exitCode: 0, stdout: CLEAN_OUT('C:\\x'), timedOut: true }).verdict).toBe('error');
    const e = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    expect(classifyScan({ exitCode: null, spawnError: e })).toMatchObject({ verdict: 'error' });
  });
  it('a detection on exit 0 still fails (inconsistent output is never clean)', () => {
    expect(classifyScan({ exitCode: 0, stdout: THREAT_OUT('C:\\x') }).verdict).toBe('threats');
  });
  it('parseThreatNames de-duplicates and ignores other fields', () => {
    expect(parseThreatNames('Threat : A\nResources : 1 total\nThreat   :   A  \nThreat:B')).toEqual(['A', 'B']);
  });
  it('decodeOutput reads UTF-16LE (with or without BOM) as well as ANSI/UTF-8', () => {
    const t = 'Scanning C:\\x found no threats.';
    expect(decodeOutput(Buffer.from(t, 'utf8'))).toBe(t);
    expect(decodeOutput(Buffer.from(t, 'utf16le'))).toBe(t);
    expect(decodeOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]))).toBe(t);
  });
});

describe('runDefenderGate with a fake MpCmdRun', () => {
  it('clean: exit 0, Authenticode NotSigned is information only while WCA_SIGN_MODE is unset', async () => {
    const { unpacked } = fakeTree();
    const { runner, calls } = fakeRunner();
    const lines = [];
    const r = await gate({ targets: [unpacked], runner, env: quietEnv(), log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(EXIT_PASS);
    expect(r.enforce).toBe(false);
    expect(calls.filter((c) => /MpCmdRun/.test(c.command))).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/information only/);
    expect(lines.join('\n')).toMatch(/NotSigned 3/);
  });
  it('threat: exit 1 and the detection names are printed', async () => {
    const { unpacked } = fakeTree();
    const { runner } = fakeRunner({ scan: (t) => ({ exitCode: 2, stdout: THREAT_OUT(t) }) });
    const lines = [];
    const r = await gate({ targets: [unpacked], runner, env: quietEnv(), log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(EXIT_THREATS);
    expect(lines.join('\n')).toContain('Trojan:Win32/Example.A!ml');
    expect(lines.join('\n')).toContain('PUA:Win32/Example.B');
  });
  it('cannot run (hr failure or MpCmdRun missing): exit 4, never 0', async () => {
    const { unpacked } = fakeTree();
    const hr = fakeRunner({ scan: () => ({ exitCode: 2, stdout: HR_OUT }) });
    expect((await gate({ targets: [unpacked], runner: hr.runner, env: quietEnv() })).exitCode).toBe(EXIT_INCOMPLETE);
    const enoent = Object.assign(new Error('spawn C:\\Program Files\\Windows Defender\\MpCmdRun.exe ENOENT'), {
      code: 'ENOENT',
    });
    const missing = fakeRunner({ scan: () => ({ exitCode: null, stdout: '', spawnError: enoent }) });
    expect((await gate({ targets: [unpacked], runner: missing.runner, env: quietEnv() })).exitCode).toBe(
      EXIT_INCOMPLETE,
    );
  });
  it('timeout: exit 4 and the timeout is passed to the runner', async () => {
    const { unpacked } = fakeTree();
    const { runner, calls } = fakeRunner({ scan: () => ({ exitCode: null, stdout: '', timedOut: true }) });
    const lines = [];
    const r = await gate({
      targets: [unpacked],
      runner,
      env: quietEnv(),
      timeoutMs: 1234,
      log: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(EXIT_INCOMPLETE);
    expect(calls[0].opts.timeoutMs).toBe(1234);
    expect(lines.join('\n')).toMatch(/timed out/);
  });
  it('one clean + one failed target is still incomplete; a threat anywhere wins', async () => {
    const { root, unpacked } = fakeTree();
    const installer = join(root, 'WhatsAppCalendarAgent-Setup-0.1.0.exe');
    writeFileSync(installer, '');
    const mixed = fakeRunner({ scan: (t) => (t === installer ? { exitCode: 2, stdout: HR_OUT } : {}) });
    expect((await gate({ targets: [unpacked, installer], runner: mixed.runner, env: quietEnv() })).exitCode).toBe(
      EXIT_INCOMPLETE,
    );
    const threat = fakeRunner({
      scan: (t) => (t === installer ? { exitCode: 2, stdout: THREAT_OUT(t) } : { exitCode: 2, stdout: HR_OUT }),
    });
    expect((await gate({ targets: [unpacked, installer], runner: threat.runner, env: quietEnv() })).exitCode).toBe(
      EXIT_THREATS,
    );
  });
  it('a target that does not exist is incomplete and MpCmdRun is not started for it', async () => {
    const { runner, calls } = fakeRunner();
    const r = await gate({ targets: [join(tmp(), 'nope')], runner, env: quietEnv() });
    expect(r.exitCode).toBe(EXIT_INCOMPLETE);
    expect(calls.filter((c) => /MpCmdRun/.test(c.command))).toHaveLength(0);
  });
});

describe('Authenticode under WCA_SIGN_MODE', () => {
  it('signModeActive: unset / empty / off / none = signing off; anything else = on', () => {
    expect(signModeActive({})).toBe(false);
    expect(signModeActive({ WCA_SIGN_MODE: '' })).toBe(false);
    expect(signModeActive({ WCA_SIGN_MODE: ' Off ' })).toBe(false);
    expect(signModeActive({ WCA_SIGN_MODE: 'none' })).toBe(false);
    expect(signModeActive({ WCA_SIGN_MODE: 'signtool' })).toBe(true);
  });
  it('enforced: NotSigned fails with exit 2 even though the scan is clean', async () => {
    const { unpacked } = fakeTree();
    const { runner } = fakeRunner();
    const r = await gate({ targets: [unpacked], runner, env: quietEnv({ WCA_SIGN_MODE: 'signtool' }) });
    expect(r.exitCode).toBe(EXIT_SIGNATURE);
    expect(r.signatureFailures).toHaveLength(3);
  });
  it('enforced: every file Valid passes', async () => {
    const { unpacked } = fakeTree();
    const { runner } = fakeRunner({
      ps: (paths) => ({
        stdout: JSON.stringify(
          paths.map((p) => ({ path: p, status: 'Valid', signer: 'CN=Example', timestamped: true })),
        ),
      }),
    });
    const r = await gate({ targets: [unpacked], runner, env: quietEnv({ WCA_SIGN_MODE: 'signtool' }) });
    expect(r.exitCode).toBe(EXIT_PASS);
  });
  it('enforced: one HashMismatch fails; PowerShell failing fails (unreadable is not Valid)', async () => {
    const { unpacked } = fakeTree();
    const one = fakeRunner({
      ps: (paths) => ({
        stdout: JSON.stringify(
          paths.map((p, i) => ({ path: p, status: i === 0 ? 'HashMismatch' : 'Valid', timestamped: true })),
        ),
      }),
    });
    const r1 = await gate({
      targets: [unpacked],
      runner: one.runner,
      env: quietEnv({ WCA_SIGN_MODE: 'x' }),
    });
    expect(r1.exitCode).toBe(EXIT_SIGNATURE);
    expect(r1.signatureFailures).toHaveLength(1);
    const broken = fakeRunner({ ps: () => ({ exitCode: 1, stdout: '' }) });
    const r2 = await gate({
      targets: [unpacked],
      runner: broken.runner,
      env: quietEnv({ WCA_SIGN_MODE: 'x' }),
    });
    expect(r2.exitCode).toBe(EXIT_SIGNATURE);
  });
  it('not enforced: PowerShell failing is a warning, not a failure', async () => {
    const { unpacked } = fakeTree();
    const broken = fakeRunner({ ps: () => ({ exitCode: 1, stdout: '' }) });
    const lines = [];
    const r = await gate({
      targets: [unpacked],
      runner: broken.runner,
      env: quietEnv(),
      log: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(EXIT_PASS);
    expect(lines.join('\n')).toMatch(/WARN/);
  });
  it('threats outrank a signature failure', () => {
    expect(gateExitCode({ scans: [{ verdict: 'threats' }], signatureFailures: ['x'] })).toBe(EXIT_THREATS);
    expect(gateExitCode({ scans: [{ verdict: 'error' }], signatureFailures: ['x'] })).toBe(EXIT_SIGNATURE);
    expect(gateExitCode({ scans: [], signatureFailures: [] })).toBe(EXIT_INCOMPLETE);
  });
  it('authenticodeProblems is case-insensitive on paths and never prints a thumbprint field', () => {
    const a = authenticodeProblems(
      [{ path: 'C:\\A\\X.EXE', status: 'Valid', signer: 'CN=Y', timestamped: true }],
      ['C:\\a\\x.exe'],
      { enforce: true },
    );
    expect(a.failures).toEqual([]);
    expect(a.lines[0]).toMatch(/^Valid\s+C:\\a\\x\.exe - CN=Y$/);
    expect(AUTHENTICODE_SCRIPT).not.toMatch(/Thumbprint/i);
  });
});

describe('targets, batching, argv', () => {
  it('listPeFiles finds .exe/.dll recursively and skips other files', () => {
    const { unpacked } = fakeTree();
    expect(listPeFiles(unpacked).map((p) => p.slice(unpacked.length + 1))).toEqual(
      [APP_EXE, 'ffmpeg.dll', join('resources', 'bridge', 'whatsapp-bridge.exe')].sort(),
    );
  });
  it('listPeFiles also finds a PE image by its header whatever its name; MZ alone is not enough', () => {
    const { unpacked } = fakeTree();
    const pe = Buffer.alloc(0x100);
    pe.write('MZ', 0, 'latin1');
    pe.writeUInt32LE(0x80, 0x3c);
    pe.write('PE\0\0', 0x80, 'latin1');
    writeFileSync(join(unpacked, 'resources', 'payload.bin'), pe);
    const mzOnly = Buffer.from(pe);
    mzOnly.write('XX', 0x80, 'latin1');
    writeFileSync(join(unpacked, 'resources', 'notpe.bin'), mzOnly);
    expect(hasPeHeader(pe)).toBe(true);
    expect(hasPeHeader(mzOnly)).toBe(false);
    expect(hasPeHeader(Buffer.from('MZ'))).toBe(false);
    const found = listPeFiles(unpacked).map((p) => p.slice(unpacked.length + 1));
    expect(found).toContain(join('resources', 'payload.bin'));
    expect(found).not.toContain(join('resources', 'notpe.bin'));
  });
  it('findInstallers matches the electron-builder artifactName only', () => {
    const d = tmp();
    for (const n of [
      'WhatsAppCalendarAgent-Setup-0.1.0.exe',
      'WhatsAppCalendarAgent-Setup-0.1.0.exe.blockmap',
      'other.exe',
    ]) {
      writeFileSync(join(d, n), '');
    }
    expect(findInstallers(d)).toEqual([join(d, 'WhatsAppCalendarAgent-Setup-0.1.0.exe')]);
    expect(findInstallers(join(d, 'missing'))).toEqual([]);
  });
  it('batchPaths keeps every batch under the character budget and loses nothing', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `C:\\dir\\file-${String(i).padStart(3, '0')}.dll`);
    const batches = batchPaths(paths, 200);
    expect(batches.flat()).toEqual(paths);
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(encodePathList(b).length).toBeLessThanOrEqual(200);
  });
  it('parseArgs: positional targets, --no-installer, --timeout-ms', () => {
    expect(parseArgs(['dist/x', '--no-installer', '--timeout-ms=5000'])).toEqual({
      targets: ['dist/x'],
      noInstaller: true,
      timeoutMs: 5000,
    });
    expect(parseArgs(['--timeout-ms=abc']).timeoutMs).toBeGreaterThan(0);
  });
  it('main() returns the gate code and prints the detection names to stderr', async () => {
    const { unpacked } = fakeTree();
    const { runner } = fakeRunner({ scan: (t) => ({ exitCode: 2, stdout: THREAT_OUT(t) }) });
    let out = '';
    let err = '';
    const io = { out: { write: (s) => (out += s) }, err: { write: (s) => (err += s) } };
    const code = await main([unpacked], io, { runner, env: quietEnv(), payload: TEST_PAYLOAD });
    expect(code).toBe(EXIT_THREATS);
    expect(err).toContain('Trojan:Win32/Example.A!ml');
    expect(err).toContain('WINDOWS-SECURITY.md');
    expect(out).toContain('scanning');
  });
});

describe('smoke-packaged.mjs optional check 13 (--defender)', () => {
  const SMOKE = readFileSync(fileURLToPath(new URL('./smoke-packaged.mjs', import.meta.url)), 'utf8');
  it('runs only with --defender, after check 12 and before the check 6 spawn audit', () => {
    const at13 = SMOKE.indexOf("if (argv.includes('--defender')) await check13Defender({ unpacked, log, problems });");
    expect(at13).toBeGreaterThan(SMOKE.indexOf('  check12Notices({ resourcesDir, log, problems });'));
    expect(at13).toBeLessThan(SMOKE.indexOf('check6NoGui({ log, problems }); // last'));
  });
  it('maps every non-pass result (threats, cannot-run, signature) to a problem', () => {
    const body = SMOKE.slice(SMOKE.indexOf('async function check13Defender'), SMOKE.indexOf('// main\n'));
    expect(body).toMatch(/s\.verdict === 'threats'\) bad\(/);
    expect(body).toMatch(/s\.verdict === 'error'\) bad\(/);
    expect(body).toMatch(/for \(const f of r\.signatureFailures\) bad\(/);
    expect(body).toMatch(/for \(const p of r\.payloadProblems \?\? \[\]\) bad\(/); // [signing-fix] MAJOR 4
  });
});

describe('defaultRunner (real child process: node only)', () => {
  it('kills a child that outlives its timeout and reports timedOut', async () => {
    const r = await defaultRunner(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(classifyScan(r).verdict).toBe('error');
  }, 15_000);
  it('captures stdout and the exit code; a missing executable is a spawn error, not a crash', async () => {
    const ok = await defaultRunner(
      process.execPath,
      ['-e', 'process.stdout.write("found no threats"); process.exit(0)'],
      {
        timeoutMs: 10_000,
      },
    );
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'found no threats', timedOut: false, spawnError: null });
    const missing = await defaultRunner(join(tmp(), 'does-not-exist.exe'), [], { timeoutMs: 10_000 });
    expect(missing.spawnError).toBeTruthy();
    expect(classifyScan(missing).verdict).toBe('error');
  }, 15_000);
});

// [signing-fix, signing-review MAJOR 4] an empty / truncated / missing win-unpacked used to PASS: MpCmdRun says
// "found no threats" for an empty folder and 0 PE files gave 0 Authenticode failures, even when enforced.
describe('payload: the gate only passes a COMPLETE packed tree', () => {
  it('the expected payload: the app exe, app.asar, the bridge exe and a 44-PE-file floor', () => {
    expect(EXPECTED_PAYLOAD).toEqual({
      files: [APP_EXE, 'resources/app.asar', 'resources/bridge/whatsapp-bridge.exe'],
      minPeFiles: 44,
    });
    expect(APP_EXE).toBe('WhatsApp Calendar Agent.exe');
  });
  it('an EMPTY win-unpacked is incomplete (exit 4), not PASS - with and without enforcement (review reproduction)', async () => {
    for (const env of [quietEnv(), quietEnv({ WCA_SIGN_MODE: 'signtool-cert' })]) {
      const empty = join(tmp(), 'win-unpacked');
      mkdirSync(empty);
      const { runner } = fakeRunner();
      const r = await runDefenderGate({ targets: [empty], runner, env });
      expect(r.exitCode).not.toBe(EXIT_PASS);
      expect(r.payloadProblems.join('\n')).toMatch(/WhatsApp Calendar Agent\.exe is missing/);
      expect(r.payloadProblems.join('\n')).toMatch(/0 PE file\(s\), expected at least 44/);
    }
  });
  it('a truncated tree (below the PE floor, or without app.asar / the bridge) is incomplete', async () => {
    const { unpacked } = fakeTree();
    const { runner } = fakeRunner();
    const floor = await runDefenderGate({ targets: [unpacked], runner, env: quietEnv() }); // real floor: 44
    expect(floor.exitCode).toBe(EXIT_INCOMPLETE);
    expect(floor.payloadProblems).toEqual([`${unpacked}: 3 PE file(s), expected at least 44 (truncated tree?)`]);
    rmSync(join(unpacked, 'resources', 'app.asar'));
    rmSync(join(unpacked, 'resources', 'bridge', 'whatsapp-bridge.exe'));
    expect(payloadProblems(unpacked, TEST_PAYLOAD)).toEqual([
      `${unpacked}: resources/app.asar is missing`,
      `${unpacked}: resources/bridge/whatsapp-bridge.exe is missing`,
      `${unpacked}: 2 PE file(s), expected at least 3 (truncated tree?)`,
    ]);
    expect(gateExitCode({ scans: [{ verdict: 'clean' }], signatureFailures: [], payloadProblems: ['x'] })).toBe(
      EXIT_INCOMPLETE,
    );
  });
  it('enforced: no PE file at all is a signature failure', async () => {
    const f = join(tmp(), 'notes.txt');
    writeFileSync(f, 'not a PE');
    const { runner } = fakeRunner();
    const r = await gate({ targets: [f], runner, env: quietEnv({ WCA_SIGN_MODE: 'azure' }) });
    expect(r.signatureFailures).toEqual(['no PE file was found to verify (signing is enforced)']);
    expect(r.exitCode).toBe(EXIT_SIGNATURE);
  });
  it('the clean sentence must name the scanned target ("Scanning <target> found no threats")', () => {
    expect(classifyScan({ exitCode: 0, stdout: CLEAN_OUT('C:\\x\\y'), target: 'C:\\x\\y' }).verdict).toBe('clean');
    expect(classifyScan({ exitCode: 0, stdout: CLEAN_OUT('c:\\X\\Y\\'), target: 'C:\\x\\y' }).verdict).toBe('clean');
    const other = classifyScan({ exitCode: 0, stdout: CLEAN_OUT('C:\\elsewhere'), target: 'C:\\x\\y' });
    expect(other.verdict).toBe('error');
    expect(other.detail).toMatch(/does not name the target/);
    expect(classifyScan({ exitCode: 0, stdout: 'found no threats', target: 'C:\\x' }).verdict).toBe('error');
  });
  it('default targets ALWAYS include dist/win-unpacked: a missing tree is incomplete, never a note', async () => {
    const repo = tmp();
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'WhatsAppCalendarAgent-Setup-0.1.0.exe'), '');
    const targets = defaultTargets(repo);
    expect(targets).toEqual([
      join(repo, 'dist', 'win-unpacked'),
      join(repo, 'dist', 'WhatsAppCalendarAgent-Setup-0.1.0.exe'),
    ]);
    const { runner } = fakeRunner();
    expect((await gate({ targets, runner, env: quietEnv() })).exitCode).toBe(EXIT_INCOMPLETE);
  });
});

// [signing-fix, signing-review MAJOR 5] enforcement used to depend only on WCA_SIGN_MODE in the gate's shell, and any
// Valid signature from any CA passed.
describe('signature enforcement follows the build, the publisher and the time stamp', () => {
  const PUB = 'Test Publisher';
  const MS = 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const psWith = (fn) => (paths) => ({ stdout: JSON.stringify(paths.map((p) => ({ path: p, ...fn(p) }))) });
  const valid = { status: 'Valid', signer: `CN=${PUB}, O=Test, C=IL`, timestamped: true };
  const manifestFor = (unpacked, files) =>
    writeFileSync(
      join(unpacked, 'resources', 'signing-manifest.json'),
      JSON.stringify({
        schema: 1,
        files: files.map((rel) => ({ path: rel, signedSha256: sha(join(unpacked, ...rel.split('/'))) })),
      }),
    );

  it('a tree with resources/signing-manifest.json is enforced even when WCA_SIGN_MODE is unset', async () => {
    const { unpacked } = fakeTree();
    manifestFor(unpacked, [APP_EXE]);
    const { runner } = fakeRunner(); // every file NotSigned
    const r = await gate({ targets: [unpacked], runner, env: quietEnv() });
    expect(r.enforce).toBe(true);
    expect(r.exitCode).toBe(EXIT_SIGNATURE);
    expect(r.signatureFailures.length).toBeGreaterThanOrEqual(3);
  });
  it('manifest cross-check: on-disk bytes must equal signedSha256; a listed file must exist; bad JSON fails', async () => {
    const { unpacked } = fakeTree();
    manifestFor(unpacked, [APP_EXE, 'ffmpeg.dll']);
    writeFileSync(join(unpacked, 'ffmpeg.dll'), 'patched after signing');
    const m = JSON.parse(readFileSync(join(unpacked, 'resources', 'signing-manifest.json'), 'utf8'));
    m.files.push({ path: 'resources/llama/gone.dll', signedSha256: '00'.repeat(32) });
    writeFileSync(join(unpacked, 'resources', 'signing-manifest.json'), JSON.stringify(m));
    const { runner } = fakeRunner({ ps: psWith(() => valid) });
    const r = await gate({ targets: [unpacked], runner, env: quietEnv() });
    expect(r.exitCode).toBe(EXIT_SIGNATURE);
    expect(r.signatureFailures).toEqual([
      `${join(unpacked, 'ffmpeg.dll')}: on-disk sha256 differs from signing-manifest.json signedSha256`,
      `${join(unpacked, 'resources', 'llama', 'gone.dll')}: listed in signing-manifest.json but missing`,
    ]);
    writeFileSync(join(unpacked, 'resources', 'signing-manifest.json'), '{ not json');
    const bad = await gate({ targets: [unpacked], runner, env: quietEnv() });
    expect(bad.signatureFailures.join('\n')).toMatch(/signing-manifest\.json is unreadable/);
  });
  it('a MIXED tree (some of our files Valid, some NotSigned) fails even with signing off', async () => {
    const { unpacked } = fakeTree();
    const exe = join(unpacked, APP_EXE);
    const { runner } = fakeRunner({ ps: psWith((p) => (p === exe ? valid : { status: 'NotSigned' })) });
    const r = await gate({ targets: [unpacked], runner, env: quietEnv() });
    expect(r.enforce).toBe(false);
    expect(r.exitCode).toBe(EXIT_SIGNATURE);
    expect(r.signatureFailures.join('\n')).toMatch(/partially signed[\s\S]*ffmpeg\.dll: NotSigned/);
  });
  it('Microsoft-signed DirectX DLLs do not make an unsigned tree "mixed"', async () => {
    const { unpacked } = fakeTree();
    const dll = join(unpacked, 'ffmpeg.dll');
    const { runner } = fakeRunner({
      ps: psWith((p) => (p === dll ? { status: 'Valid', signer: MS, timestamped: true } : { status: 'NotSigned' })),
    });
    const r = await gate({ targets: [unpacked], runner, env: quietEnv() });
    expect(r.exitCode).toBe(EXIT_PASS);
  });
  it('a stale UNSIGNED installer next to a signed tree fails (failed signed build)', async () => {
    const { root, unpacked } = fakeTree();
    const installer = join(root, 'WhatsAppCalendarAgent-Setup-0.1.0.exe');
    writeFileSync(installer, '');
    const { runner } = fakeRunner({ ps: psWith((p) => (p === installer ? { status: 'NotSigned' } : valid)) });
    const r = await gate({ targets: [unpacked, installer], runner, env: quietEnv() });
    expect(r.exitCode).toBe(EXIT_SIGNATURE);
    expect(r.signatureFailures.join('\n')).toContain('WhatsAppCalendarAgent-Setup-0.1.0.exe: NotSigned');
  });
  it('enforced: the signer CN must be WCA_SIGN_PUBLISHER (when set) and every signature must be time-stamped', async () => {
    const env = quietEnv({ WCA_SIGN_MODE: 'signtool-cert', WCA_SIGN_PUBLISHER: PUB });
    const run = async (rec) => {
      const { unpacked } = fakeTree();
      const { runner } = fakeRunner({ ps: psWith(() => rec) });
      return gate({ targets: [unpacked], runner, env });
    };
    expect((await run(valid)).exitCode).toBe(EXIT_PASS);
    const other = await run({ ...valid, signer: 'CN=Someone Else, O=X' });
    expect(other.exitCode).toBe(EXIT_SIGNATURE);
    expect(other.signatureFailures[0]).toMatch(/signer CN "Someone Else" is not WCA_SIGN_PUBLISHER "Test Publisher"/);
    const noTs = await run({ ...valid, timestamped: false });
    expect(noTs.exitCode).toBe(EXIT_SIGNATURE);
    expect(noTs.signatureFailures[0]).toMatch(/no time stamp/);
    // without WCA_SIGN_PUBLISHER any CN is accepted, but the time stamp is still required
    const { unpacked } = fakeTree();
    const { runner } = fakeRunner({ ps: psWith(() => ({ ...valid, signer: 'CN=Anyone' })) });
    expect((await gate({ targets: [unpacked], runner, env: quietEnv({ WCA_SIGN_MODE: 'azure' }) })).exitCode).toBe(
      EXIT_PASS,
    );
  });
  it('the PowerShell script reports the time stamper (still no thumbprint)', () => {
    expect(AUTHENTICODE_SCRIPT).toContain('timestamped = [bool]$s.TimeStamperCertificate');
    expect(AUTHENTICODE_SCRIPT).not.toMatch(/Thumbprint/i);
  });
});
