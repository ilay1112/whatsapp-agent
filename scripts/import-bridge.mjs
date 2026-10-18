#!/usr/bin/env node
// scripts/import-bridge.mjs - LEGACY PATH. Since 2026-10-18 resources/bridge/whatsapp-bridge.exe is BUILT by `npm run build:bridge`
// (scripts/build-bridge.mjs) from vendor/whatsapp-bridge-src - WhatsApp now refuses the old prebuilt exe (ClientOutdated). This
// script is kept for reference and for its pins: BRIDGE_EXE_SIZE / BRIDGE_EXE_SHA256 below are the pins of the CURRENT built exe
// (hash-bridge.mjs and sign-windows.mjs import them), so copying the reference exe with it now REFUSES on size/hash, by design.
// Originally (ARCH 4.1; build-plan section 2 deliverable 5; decision D-016, owner W0 -> W2-04) it copied EXACTLY ONE file by exact
// literal path into resources/bridge/ and verified it.
//
// Rules this file obeys literally (tests/setup-guards + scripts/import-bridge.test.mjs grep the source for them):
//   - the ONLY source path literal is the one exe below; the folder is never listed (no directory-listing or glob call anywhere);
//   - the exe is streamed (read stream -> SHA-256 + temp file); it is never started (no process-starting import, no shell);
//   - it refuses unless the byte size AND the SHA-256 match the pins; on refusal the temp file is deleted and nothing is written;
//   - it never touches the reference bridge's `store\` folder or anything else in that tree.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Pins of the exe built by `npm run build:bridge` (ARCH 4.1; docs/research/bridge-contract.md section 0). Lower-case hex. */
export const BRIDGE_EXE_SIZE = 37_538_577;
export const BRIDGE_EXE_SHA256 = '150a85fc65b0d1989b692f3da4399888d92cbc23ac9283e915d4e090c4358ab5';

/** The one and only source path (literal, never derived from a listing). */
const SOURCE_EXE = 'C:\\Users\\ilay1\\Documents\\minime\\whatsapp-mcp\\whatsapp-bridge\\whatsapp-bridge.exe';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // the project path contains a space: never URL.pathname
const DEST_DIR = join(REPO_ROOT, 'resources', 'bridge');
const DEST_EXE = join(DEST_DIR, 'whatsapp-bridge.exe');
const DEST_SUMS = join(DEST_DIR, 'SHA256SUMS');

/**
 * Streams `src` into `dest` while hashing. Refuses (throws, deletes the partial copy) unless size and SHA-256 match.
 * Returns the lower-case hex digest and the byte count on success. Pure function of its arguments so the unit test can
 * run it against a dummy fixture file - the real exe is never used by tests.
 */
export async function importBridgeFile({ src, dest, expectedSize, expectedSha256 }) {
  const want = String(expectedSha256).toLowerCase();
  let size;
  try {
    size = statSync(src).size;
  } catch (err) {
    throw new Error(`import-bridge: source not found or unreadable (${err && err.code ? err.code : 'ERR'})`, {
      cause: err,
    });
  }
  if (size !== expectedSize) {
    throw new Error(`import-bridge: REFUSED - source size ${size} bytes, expected ${expectedSize}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const out = createWriteStream(tmp, { flags: 'w' });
    const input = createReadStream(src);
    input.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    await pipeline(input, out);
    const got = hash.digest('hex');
    if (bytes !== expectedSize)
      throw new Error(`import-bridge: REFUSED - streamed ${bytes} bytes, expected ${expectedSize}`);
    if (got !== want)
      throw new Error(
        `import-bridge: REFUSED - SHA-256 mismatch (got ${got.slice(0, 12)}..., expected ${want.slice(0, 12)}...)`,
      );
    renameSync(tmp, dest);
    return { sha256: got, bytes };
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** SHA256SUMS content in the GNU coreutils format (`<hex>  <name>`), upper-case like the ARCH pin. */
export function sha256sumsLine(sha256Hex, fileName) {
  return `${String(sha256Hex).toUpperCase()}  ${fileName}\n`;
}

async function main() {
  const r = await importBridgeFile({
    src: SOURCE_EXE,
    dest: DEST_EXE,
    expectedSize: BRIDGE_EXE_SIZE,
    expectedSha256: BRIDGE_EXE_SHA256,
  });
  writeFileSync(DEST_SUMS, sha256sumsLine(r.sha256, 'whatsapp-bridge.exe'), 'utf8');
  process.stdout.write(
    `import-bridge: OK ${r.bytes} bytes, sha256 ${r.sha256.toUpperCase()} -> resources/bridge/whatsapp-bridge.exe\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
