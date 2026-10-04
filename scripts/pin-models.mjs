#!/usr/bin/env node
// scripts/pin-models.mjs - verifies the GGUF pins of `src/main/llm/local/manifest.ts`. Owner: W1-07-llm-local; v2: V2-W1-07-media-voice.
//
// [V2] Also checks MEDIA_MODEL_MANIFEST (the three mmproj-F16.gguf projectors + the four whisper voice files, ARCH-v2 B18/B19, F19):
// a `resolve/main/` URL is resolved to its commit through the API, size + lfs.oid (sha256) + the first 4 bytes (GGUF / 6c 6d 67 67)
// are verified, and only when EVERY entry of both tables passes is `vendor/models.pin.json` written (commit-pinned URLs). The
// ".gguf only / never mmproj-" refusal is lifted for exactly the three projector ids, nothing else. Run by V2-W2-04 (network).
//
// Contract (ARCH 16 / 17): re-checks every entry of `MODEL_MANIFEST` against the Hugging Face API - `lfs.oid` (sha256)
// and `size` for the pinned `resolve/<commit>/` path - and FAILS on any drift, so a silently re-uploaded GGUF can never
// slip past the download verifier. Never downloads a model. `fetch` is injectable so the unit tests run with no network.
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const OWNER = 'W1-07-llm-local';
export const MANIFEST_PATH = 'src/main/llm/local/manifest.ts';
export const HF_API = 'https://huggingface.co/api/models';
export const PIN_OUT_PATH = 'vendor/models.pin.json';
/** [V2] the ONLY ids for which the mmproj- refusal is lifted (F19). */
export const PINNED_MMPROJ_IDS = ['mmproj-tiny', 'mmproj-small', 'mmproj-mid'];
export const MAGIC_BYTES = { GGUF: [0x47, 0x47, 0x55, 0x46], GGML: [0x6c, 0x6d, 0x67, 0x67] };

const MEDIA_ENTRY_RE =
  /tier:\s*'((?:mmproj|voice)-[a-z]+)',\s*label:\s*'([^']*)',\s*fileName:\s*'([^']*)',\s*url:\s*'([^']*)',\s*size:\s*([\d_]+),\s*sha256:\s*'([0-9a-f]{64})',\s*kind:\s*'(mmproj|asr|vad)',\s*magic:\s*'(GGUF|GGML)'/g;

/** [V2] Reads MEDIA_MODEL_MANIFEST out of the TypeScript source. */
export function parseMediaManifestSource(source) {
  const entries = [];
  for (const m of source.matchAll(MEDIA_ENTRY_RE)) {
    entries.push({
      tier: m[1],
      label: m[2],
      fileName: m[3],
      url: m[4],
      size: Number(m[5].replaceAll('_', '')),
      sha256: m[6],
      kind: m[7],
      magic: m[8],
    });
  }
  if (entries.length === 0) throw new Error('pin-models: no MEDIA_MODEL_MANIFEST entries found');
  return entries;
}

/** [V2] `resolve/<40-hex>/` or `resolve/main/` (the voice files until this script pinned them). */
export function parseMediaResolveUrl(url) {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40}|main)\/([^/?#]+)$/.exec(url);
  if (m === null) throw new Error(`pin-models: not a resolve URL: ${url}`);
  return { repo: m[1], commit: m[2] === 'main' ? null : m[2], file: m[3] };
}

/** [V2] `GET /api/models/<repo>/revision/main` -> the 40-hex commit sha. */
export async function resolveCommit({ fetch, repo }) {
  const res = await fetch(`${HF_API}/${repo}/revision/main`, {
    redirect: 'follow',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`pin-models: HTTP ${String(res.status)} resolving ${repo}@main`);
  const body = await res.json();
  const sha = body?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error(`pin-models: ${repo}@main has no commit sha`);
  return sha;
}

/** [V2] Reads at most the first 4 bytes of the pinned file (Range request; the rest of the body is cancelled, never stored). */
export async function firstBytes({ fetch, url }) {
  const res = await fetch(url, { redirect: 'follow', headers: { range: 'bytes=0-3' } });
  if (!res.ok || res.body === null || res.body === undefined)
    throw new Error(`pin-models: HTTP ${String(res.status)} reading the magic`);
  const reader = res.body.getReader();
  const got = [];
  try {
    while (got.length < 4) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const b of chunk.value) {
        if (got.length < 4) got.push(b);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return got;
}

/** [V2] One MEDIA_MODEL_MANIFEST entry: rules, commit, tree (size + sha256), magic. Returns the commit-pinned URL when ok. */
export async function checkMediaEntry({ fetch, entry }) {
  const problems = [];
  let parts;
  try {
    parts = parseMediaResolveUrl(entry.url);
  } catch (e) {
    return { tier: entry.tier, ok: false, problems: [e.message], pinnedUrl: null };
  }
  if (parts.file !== entry.fileName) problems.push(`url file ${parts.file} != fileName ${entry.fileName}`);
  if (entry.kind === 'mmproj') {
    if (!PINNED_MMPROJ_IDS.includes(entry.tier) || entry.fileName !== 'mmproj-F16.gguf' || entry.magic !== 'GGUF')
      problems.push('only the three pinned mmproj-F16.gguf projectors are allowed');
  } else {
    if (/mmproj-|mtp-/.test(entry.fileName)) problems.push('multimodal/draft file is not allowed as a voice file');
    if (!entry.fileName.endsWith('.bin') || entry.magic !== 'GGML')
      problems.push('voice files are .bin ggml files (GGML magic)');
  }
  if (/\.(exe|dll|ps1|bat|cmd|msi|com|scr)$/i.test(entry.fileName)) problems.push('executable extension');
  if (problems.length > 0) return { tier: entry.tier, ok: false, problems, pinnedUrl: null };

  let commit = parts.commit;
  try {
    if (commit === null) commit = await resolveCommit({ fetch, repo: parts.repo });
  } catch (e) {
    return { tier: entry.tier, ok: false, problems: [e.message], pinnedUrl: null };
  }
  const pinnedUrl = `https://huggingface.co/${parts.repo}/resolve/${commit}/${entry.fileName}`;
  const res = await fetch(treeUrl({ repo: parts.repo, commit }), {
    redirect: 'follow',
    headers: { accept: 'application/json' },
  });
  if (!res.ok)
    return {
      tier: entry.tier,
      ok: false,
      problems: [`HTTP ${String(res.status)} from the Hugging Face API`],
      pinnedUrl: null,
    };
  const tree = await res.json();
  const row = Array.isArray(tree) ? tree.find((x) => x.path === entry.fileName) : undefined;
  if (row === undefined)
    return {
      tier: entry.tier,
      ok: false,
      problems: [`${entry.fileName} is not in ${parts.repo}@${commit}`],
      pinnedUrl: null,
    };
  const remoteSize = row.lfs?.size ?? row.size;
  const remoteSha = row.lfs?.oid ?? null;
  if (remoteSize !== entry.size)
    problems.push(`size drift: pinned ${String(entry.size)}, remote ${String(remoteSize)}`);
  if (remoteSha === null) problems.push('the remote file has no lfs.oid (sha256) - cannot verify the pin');
  else if (remoteSha !== entry.sha256) problems.push(`sha256 drift: pinned ${entry.sha256}, remote ${remoteSha}`);
  try {
    const head = await firstBytes({ fetch, url: pinnedUrl });
    const want = MAGIC_BYTES[entry.magic];
    if (head.length !== 4 || head.some((b, i) => b !== want[i]))
      problems.push(`magic mismatch: expected ${entry.magic}`);
  } catch (e) {
    problems.push(e.message);
  }
  return { tier: entry.tier, ok: problems.length === 0, problems, pinnedUrl: problems.length === 0 ? pinnedUrl : null };
}

const ENTRY_RE =
  /tier:\s*'(tiny|small|mid)',\s*label:\s*'([^']*)',\s*fileName:\s*'([^']*)',\s*url:\s*'([^']*)',\s*size:\s*([\d_]+),\s*sha256:\s*'([0-9a-f]{64})'/g;

/** Reads the compile-time manifest out of the TypeScript source (the script is plain ESM and cannot import .ts). */
export function parseManifestSource(source) {
  const entries = [];
  for (const m of source.matchAll(ENTRY_RE)) {
    entries.push({
      tier: m[1],
      label: m[2],
      fileName: m[3],
      url: m[4],
      size: Number(m[5].replaceAll('_', '')),
      sha256: m[6],
    });
  }
  if (entries.length === 0) throw new Error('pin-models: no MODEL_MANIFEST entries found');
  return entries;
}

/** `https://huggingface.co/<org>/<repo>/resolve/<40-hex>/<file>` -> its parts. Any other shape is a pin bug. */
export function parseResolveUrl(url) {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]{40})\/([^/?#]+)$/.exec(url);
  if (m === null) throw new Error(`pin-models: not a pinned resolve URL: ${url}`);
  return { repo: m[1], commit: m[2], file: m[3] };
}

export function treeUrl({ repo, commit }) {
  return `${HF_API}/${repo}/tree/${commit}`;
}

export async function checkEntry({ fetch, entry }) {
  const problems = [];
  const parts = parseResolveUrl(entry.url);
  if (parts.file !== entry.fileName) problems.push(`url file ${parts.file} != fileName ${entry.fileName}`);
  if (/mmproj-|mtp-/.test(entry.fileName)) problems.push('multimodal/draft file is not allowed in the manifest');
  if (!entry.fileName.endsWith('.gguf')) problems.push('only .gguf files may be downloaded');

  const res = await fetch(treeUrl(parts), { redirect: 'follow', headers: { accept: 'application/json' } });
  if (!res.ok) {
    problems.push(`HTTP ${String(res.status)} from the Hugging Face API`);
    return { tier: entry.tier, ok: false, problems };
  }
  const tree = await res.json();
  const row = Array.isArray(tree) ? tree.find((f) => f.path === entry.fileName) : undefined;
  if (row === undefined) {
    problems.push(`${entry.fileName} is not in ${parts.repo}@${parts.commit}`);
    return { tier: entry.tier, ok: false, problems };
  }
  const remoteSize = row.lfs?.size ?? row.size;
  const remoteSha = row.lfs?.oid ?? null;
  if (remoteSize !== entry.size)
    problems.push(`size drift: pinned ${String(entry.size)}, remote ${String(remoteSize)}`);
  if (remoteSha === null) problems.push('the remote file has no lfs.oid (sha256) - cannot verify the pin');
  else if (remoteSha !== entry.sha256) problems.push(`sha256 drift: pinned ${entry.sha256}, remote ${remoteSha}`);
  return { tier: entry.tier, ok: problems.length === 0, problems };
}

export async function main(io = {}) {
  const fetchFn = io.fetch ?? globalThis.fetch;
  const fs = io.fs ?? fsp;
  const log = io.log ?? ((m) => process.stdout.write(`${m}\n`));
  const root = io.root ?? path.resolve(fileURLToPath(new URL('..', import.meta.url)));

  const source = await fs.readFile(path.join(root, ...MANIFEST_PATH.split('/')), 'utf8');
  const entries = parseManifestSource(source);
  const media = parseMediaManifestSource(source);
  const results = [];
  const report = (result) => {
    results.push(result);
    log(
      result.ok ? `pin-models: ${result.tier} OK` : `pin-models: ${result.tier} DRIFT - ${result.problems.join('; ')}`,
    );
  };
  for (const entry of entries) report(await checkEntry({ fetch: fetchFn, entry }));
  for (const entry of media) report(await checkMediaEntry({ fetch: fetchFn, entry }));
  const ok = results.every((r) => r.ok);
  if (!ok) throw new Error('pin-models: at least one pin drifted - refusing to pass');

  // [V2] vendor/models.pin.json - written only when every entry of BOTH tables passed (T2 11 check 8 compares it with the build's
  // out/main/manifest.json). A voice URL that was still resolve/main/ is written in its commit-pinned form: copy it into manifest.ts.
  const pinned = {
    _comment:
      'Generated by scripts/pin-models.mjs (never hand-edited). Every URL is resolve/<commit>/; size + sha256 verified.',
    llm: entries.map((e) => ({
      id: e.tier,
      kind: 'llm',
      magic: 'GGUF',
      fileName: e.fileName,
      url: e.url,
      size: e.size,
      sha256: e.sha256,
    })),
    media: media.map((e) => {
      const r = results.find((x) => x.tier === e.tier);
      return {
        id: e.tier,
        kind: e.kind,
        magic: e.magic,
        fileName: e.fileName,
        url: r.pinnedUrl,
        size: e.size,
        sha256: e.sha256,
      };
    }),
  };
  await fs.writeFile(path.join(root, ...PIN_OUT_PATH.split('/')), `${JSON.stringify(pinned, null, 2)}\n`, 'utf8');
  const unpinned = media.filter((e) => /\/resolve\/main\//.test(e.url)).map((e) => e.tier);
  if (unpinned.length > 0)
    log(`pin-models: copy the commit-pinned URLs of ${unpinned.join(', ')} from ${PIN_OUT_PATH} into manifest.ts`);
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`pin-models: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
