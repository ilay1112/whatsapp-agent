#!/usr/bin/env node
// scripts/release-manifest.mjs - writes the `release.json` the in-app updater reads (v5, docs/specs/v5-updates-handover.md
// 2.1; owner v5-W1). Run by .github/workflows/release.yml after the portable zip is built:
//
//   node scripts/release-manifest.mjs <zipPath> <version> <commit> [--notes "<text>"] --out release.json
//
// Output (schema 1): { schema, version, commit, publishedAt, asset: { name, size, sha256 }, minVersion, notes }.
//   - size + sha256 are computed by STREAMING the zip (it is ~300 MB; never read into memory);
//   - version must match ^0\.1\.\d+$ (CI writes 0.1.<run_number>), commit must be a full lower-case 40-hex sha;
//   - the zip's file name must be exactly `WhatsAppCalendarAgent-win-x64-<version>.zip` and start with a zip signature;
//   - an existing manifest of a DIFFERENT version (or one that is not a manifest) is never overwritten.
// No network, no child process: this script only hashes a file and writes one JSON file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 1;
export const MIN_VERSION = '0.1.0';
export const NOTES_MAX = 200;
export const VERSION_RE = /^0\.1\.\d+$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
const USAGE = 'usage: release-manifest.mjs <zipPath> <version> <commit> [--notes "<text>"] --out <release.json>';

/** The one asset name a release carries; the updater looks for exactly this. */
export const assetName = (version) => `WhatsAppCalendarAgent-win-x64-${version}.zip`;

/** Streamed size + sha256 (lower-case hex) of a file. */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let size = 0;
    createReadStream(filePath)
      .on('data', (chunk) => {
        size += chunk.length;
        h.update(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve({ size, sha256: h.digest('hex') }));
  });
}

export function parseArgs(argv) {
  const positional = [];
  const opts = { notes: '', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--notes' || a === '--out') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 3) throw new Error(USAGE);
  if (opts.out === null || opts.out === '') throw new Error(`--out is required (${USAGE})`);
  const [zipPath, version, commit] = positional;
  if (!VERSION_RE.test(version)) throw new Error(`version ${JSON.stringify(version)} does not match ${VERSION_RE}`);
  if (!COMMIT_RE.test(commit)) throw new Error(`commit ${JSON.stringify(commit)} is not a full lower-case sha`);
  return { zipPath, version, commit, notes: opts.notes, out: opts.out };
}

/** One line, no control characters, at most NOTES_MAX characters (a commit subject, shown in the app). */
export function cleanNotes(text) {
  const flat = String(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return [...flat].slice(0, NOTES_MAX).join('').trimEnd();
}

export async function buildManifest({ zipPath, version, commit, notes, now = () => new Date() }) {
  const name = path.basename(zipPath);
  if (name !== assetName(version)) throw new Error(`the zip must be named ${assetName(version)} (got ${name})`);
  let st;
  try {
    st = await fsp.stat(zipPath);
  } catch {
    throw new Error(`zip not found: ${zipPath}`);
  }
  if (!st.isFile()) throw new Error(`${zipPath} is not a file`);
  if (st.size === 0) throw new Error(`${zipPath} is empty`);
  const fh = await fsp.open(zipPath, 'r');
  const head = Buffer.alloc(4);
  try {
    await fh.read(head, 0, 4, 0);
  } finally {
    await fh.close();
  }
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${zipPath} is not a zip (no local file header)`);
  const { size, sha256 } = await hashFile(zipPath);
  return {
    schema: SCHEMA,
    version,
    commit,
    publishedAt: now().toISOString(),
    asset: { name, size, sha256 },
    minVersion: MIN_VERSION,
    notes: cleanNotes(notes),
  };
}

/** Atomic write (tmp + rename). Refuses to replace a manifest of another version, or a file that is not one. */
export async function writeManifest({ out, manifest }) {
  let existing = null;
  try {
    existing = await fsp.readFile(out, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (existing !== null) {
    let prev;
    try {
      prev = JSON.parse(existing);
    } catch {
      throw new Error(`refusing to overwrite ${out}: it is not a release manifest`);
    }
    if (prev === null || typeof prev !== 'object' || typeof prev.version !== 'string') {
      throw new Error(`refusing to overwrite ${out}: it is not a release manifest`);
    }
    if (prev.version !== manifest.version) {
      throw new Error(
        `refusing to overwrite ${out}: it holds version ${prev.version}, not ${manifest.version} (different version)`,
      );
    }
  }
  const tmp = `${out}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, out);
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  try {
    const args = parseArgs(argv);
    const manifest = await buildManifest({ ...args, now: io.now });
    await writeManifest({ out: args.out, manifest });
    out.write(
      `release-manifest: ${manifest.asset.name} ${manifest.version} ${manifest.asset.sha256} ` +
        `${String(manifest.asset.size)} B -> ${args.out}\n`,
    );
    return 0;
  } catch (e) {
    err.write(`release-manifest: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  });
}
