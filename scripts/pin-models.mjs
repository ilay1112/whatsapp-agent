#!/usr/bin/env node
// scripts/pin-models.mjs - verifies the GGUF pins of `src/main/llm/local/manifest.ts`. Owner: W1-07-llm-local.
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
  const results = [];
  for (const entry of entries) {
    const result = await checkEntry({ fetch: fetchFn, entry });
    results.push(result);
    log(
      result.ok ? `pin-models: ${result.tier} OK` : `pin-models: ${result.tier} DRIFT - ${result.problems.join('; ')}`,
    );
  }
  const ok = results.every((r) => r.ok);
  if (!ok) throw new Error('pin-models: at least one pin drifted - refusing to pass');
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`pin-models: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
