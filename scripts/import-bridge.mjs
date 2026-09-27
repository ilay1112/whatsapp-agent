#!/usr/bin/env node
// scripts/import-bridge.mjs - copies EXACTLY ONE file by exact literal path into resources/bridge/ and verifies it (ARCH 4.1;
// build-plan section 2 deliverable 5; decision D-016). Owner W0 -> W2-04.
//
// Rules this file obeys literally (tests/setup-guards + scripts/import-bridge.test.mjs grep the source for them):
//   - the ONLY source path literal is the one exe below; the folder is never listed (no directory-listing or glob call anywhere);
//   - the exe is streamed (read stream -> SHA-256 + temp file); it is never started (no process-starting import, no shell);
//   - it refuses unless the byte size AND the SHA-256 match the pins; on refusal the temp file is deleted and nothing is written;
//   - it never touches the reference bridge's `store\` folder or anything else in that tree.
// Run once by the user or an explicitly user-approved step:  node scripts/import-bridge.mjs
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Pins (docs/research/bridge-contract.md section 1; ARCH 4.1). Lower-case hex for comparison. */
export const BRIDGE_EXE_SIZE = 43_540_541;
export const BRIDGE_EXE_SHA256 = 'ac23221e8bcf3937a4ca346b3bd80a8da09df94cbecd949af2916c4bc8d22ff5';

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
