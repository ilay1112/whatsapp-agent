#!/usr/bin/env node
// scripts/hash-bridge.mjs - build gate (ARCH 15.4): fails `pack:dir` unless resources/bridge/whatsapp-bridge.exe streams to the
// pinned SHA-256 and byte size and SHA256SUMS agrees. Hashing only - the exe is never started. Owner W0 -> W2-04.
//
//   node scripts/hash-bridge.mjs                         exit 0 on match, 1 on mismatch / missing exe
//   node scripts/hash-bridge.mjs --allow-missing-bridge   TESTS section 11: when the exe is ABSENT, writes a ZERO-BYTE placeholder
//                                                        (which can never pass the pin) so electron-builder can run; prints
//                                                        BRIDGE PLACEHOLDER and exits 0. A present-but-wrong exe still fails.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_EXE_SHA256, BRIDGE_EXE_SIZE } from './import-bridge.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BRIDGE_EXE_PATH = join(REPO_ROOT, 'resources', 'bridge', 'whatsapp-bridge.exe');
export const BRIDGE_SUMS_PATH = join(REPO_ROOT, 'resources', 'bridge', 'SHA256SUMS');

/** Streamed SHA-256 of a file, lower-case hex. */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Parses a GNU-style SHA256SUMS text: returns { <name>: <lowerHex> }. */
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

/**
 * Checks one exe against the pins (and, when `sumsPath` exists, against its SHA256SUMS line).
 * Returns { ok: true, sha256, bytes } or { ok: false, reason } - never throws for a missing file.
 */
export async function checkBridge({ exePath, sumsPath, expectedSize, expectedSha256 }) {
  if (!existsSync(exePath)) return { ok: false, reason: 'missing' };
  const bytes = statSync(exePath).size;
  if (bytes !== expectedSize) return { ok: false, reason: `size ${bytes} != ${expectedSize}` };
  const sha256 = await hashFile(exePath);
  if (sha256 !== String(expectedSha256).toLowerCase()) return { ok: false, reason: 'sha256 mismatch' };
  if (sumsPath && existsSync(sumsPath)) {
    const sums = parseSums(readFileSync(sumsPath, 'utf8'));
    const listed = sums['whatsapp-bridge.exe'];
    if (listed !== sha256) return { ok: false, reason: 'SHA256SUMS disagrees with the exe' };
  }
  return { ok: true, sha256, bytes };
}

/** Zero-byte placeholder for `--allow-missing-bridge` (never passes the pin; only lets electron-builder run). */
export function writePlaceholder(exePath) {
  mkdirSync(dirname(exePath), { recursive: true });
  writeFileSync(exePath, Buffer.alloc(0));
}

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const allowMissing = argv.includes('--allow-missing-bridge');
  const r = await checkBridge({
    exePath: BRIDGE_EXE_PATH,
    sumsPath: BRIDGE_SUMS_PATH,
    expectedSize: BRIDGE_EXE_SIZE,
    expectedSha256: BRIDGE_EXE_SHA256,
  });
  if (r.ok) {
    io.out.write(`hash-bridge: OK ${r.bytes} bytes sha256 ${r.sha256.toUpperCase()}\n`);
    return 0;
  }
  const isPlaceholder = existsSync(BRIDGE_EXE_PATH) && statSync(BRIDGE_EXE_PATH).size === 0;
  if (allowMissing && (r.reason === 'missing' || isPlaceholder)) {
    if (!isPlaceholder) writePlaceholder(BRIDGE_EXE_PATH);
    io.out.write(
      'hash-bridge: BRIDGE PLACEHOLDER (zero bytes) in place - this build can never pass the pin; SMOKE INCOMPLETE\n',
    );
    return 0;
  }
  io.err.write(`hash-bridge: FAIL - ${r.reason}. Run \`node scripts/import-bridge.mjs\` (user-approved step) first.\n`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code));
}
