#!/usr/bin/env node
// scripts/smoke-packaged.notices.mjs - regenerates `resources/licenses/THIRD_PARTY_NOTICES.txt`.
// Owner: W2-04-packaging (build-plan section 6 disjointness rule: `<ownedFile>.<suffix>` in the split `scripts/` dir).
//
// WHY THIS SCRIPT EXISTS
// The release notices that ARCH 15.3 ships in `<resources>\licenses\` cover eight sources: the bridge, llama.cpp,
// LLVM OpenMP, the VC++ CRT, the calendar MCP server, the Gemma models, Electron and the ~142 production npm
// packages. This script builds that file from the repo itself (lockfile, pin file, staged manifest).
//
// `[repair-packaging-blocker]` `scripts/fetch-llama.mjs` (owner W1-07) used to `writeFile` a two-section
// THIRD_PARTY_NOTICES.txt of its own, i.e. it OVERWROTE this file, so the correct release artefact depended on which
// script ran last. That script now writes only `resources/licenses/llama.cpp-MIT.txt`. The two files are disjoint,
// the run order is free, and regeneration never needs the network: the llama.cpp MIT text is read from the committed
// `resources/licenses/llama.cpp-MIT.txt`.
//
// [V2-W2-04] v2 adds sections 9-13 (ARCH-v2 12): whisper.cpp MIT, the opus-decoder chain, libopus BSD-3 with its patent
// paragraph (committed as resources/licenses/libopus-BSD-3.txt), the speech models (ivrit-ai Apache-2.0, OpenAI Whisper
// MIT, Silero VAD MIT - downloaded, not redistributed) and the calendar-mcp modification notice. `NOTICE_ANCHORS_V2`
// is what the packaged smoke (check 12) looks for.
//
// Everything is pure except `main()`: `buildNotices()` takes plain data and returns the file text.
// No binary is executed, no network call is made, nothing outside `resources/licenses/` is written.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNER = 'W2-04-packaging';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // never URL.pathname - the repo path contains a space

export const NOTICES_PATH = join(REPO_ROOT, 'resources', 'licenses', 'THIRD_PARTY_NOTICES.txt');
export const LLAMA_MIT_PATH = join(REPO_ROOT, 'resources', 'licenses', 'llama.cpp-MIT.txt');
export const BRIDGE_LICENSE_PATH = join(REPO_ROOT, 'resources', 'bridge', 'LICENSE');

/** The three CRT files of ARCH section 9; listed in the notices ONLY when they were actually staged. */
export const CRT_FILES = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

// ---- [V2-W2-04] v2 notices (ARCH-v2 12 THIRD_PARTY_NOTICES row, T2 11 check 12) -------------------------------------
export const WHISPER_MIT_PATH = join(REPO_ROOT, 'resources', 'licenses', 'whisper.cpp-MIT.txt');
/** Committed: libopus is compiled into opus-decoder's embedded WASM and the npm package ships no copy of its licence. */
export const LIBOPUS_LICENSE_PATH = join(REPO_ROOT, 'resources', 'licenses', 'libopus-BSD-3.txt');
/** The decoder chain of B18, in the order the notices list it. */
export const DECODER_CHAIN = ['opus-decoder', '@wasm-audio-decoders/common', 'simple-yenc', '@eshaz/web-worker'];

/**
 * String anchors the packaged smoke (check 12) requires in THIRD_PARTY_NOTICES.txt - one per v2 notice of ARCH-v2 12.
 * Changing a heading below without changing its anchor here fails both the unit test and the smoke.
 */
export const NOTICE_ANCHORS_V2 = {
  whisperCpp: 'whisper.cpp b5130 - Windows x64 CPU build  (MIT)',
  opusDecoderChain: 'Voice-note decoder chain - opus-decoder@0.7.12 and its dependencies',
  libopus: 'libopus - the Opus reference decoder, compiled to WebAssembly inside opus-decoder  (BSD-3-Clause)',
  libopusPatent: 'Opus is subject to the royalty-free patent licenses',
  ivritAi: 'ivrit-ai/whisper-large-v3-turbo-ggml  (Apache-2.0)',
  openaiWhisper: 'OpenAI Whisper model weights  (MIT)',
  sileroVad: 'Silero VAD  (MIT)',
  calendarPatch: 'MODIFICATION NOTICE - @cocal/google-calendar-mcp',
};

/** Lockfile rows of the decoder chain (root-level entries), in DECODER_CHAIN order; a missing one is reported, never skipped. */
export function decoderChainFrom(lock) {
  return DECODER_CHAIN.map((name) => {
    const row = lock.packages?.[`node_modules/${name}`];
    return { name, version: row?.version ?? 'MISSING', license: row?.license ?? 'MISSING' };
  });
}

/**
 * The v2 sections (9-13), pure.
 * @param {object} v2
 * @param {string} v2.whisperTag   e.g. `b5130`
 * @param {string} v2.whisperUrl   the pinned release asset URL
 * @param {string} v2.whisperMit   the MIT text of the pinned whisper.cpp tag (resources/licenses/whisper.cpp-MIT.txt)
 * @param {string[]} v2.whisperCrt CRT file names staged next to whisper-cli.exe (may be empty)
 * @param {{name,version,license}[]} v2.decoder  the four packages of DECODER_CHAIN
 * @param {string} v2.libopusLicense the libopus BSD-3 text incl. the patent paragraph
 * @param {{ version: string, unpatchedSha: string, patchedSha: string, insertions: {id:number,name:string}[] }} v2.calendarPatch
 */
export function buildV2Sections(v2) {
  const out = [];
  out.push(section(`9. ${NOTICE_ANCHORS_V2.whisperCpp.replace('b5130', v2.whisperTag)}`));
  out.push(
    [
      'Shipped at: resources\\whisper\\ (whisper-cli.exe, whisper.dll, ggml.dll, ggml-base.dll and the CPU-dispatched',
      'ggml-cpu-*.dll set of the pinned release; its own folder - it never shares a DLL with resources\\llama\\)',
      `Source of the binaries: ${v2.whisperUrl}`,
      'Project: https://github.com/ggml-org/whisper.cpp',
      v2.whisperCrt.length > 0
        ? `Its own copy of the Microsoft VC++ runtime (${v2.whisperCrt.join(', ')}) is shipped beside it under the terms of section 4.`
        : 'The Microsoft VC++ runtime is NOT shipped beside it in this build (see section 4; the app reports LLM_VCREDIST_MISSING).',
      '',
      v2.whisperMit.trim(),
      '',
    ].join('\n'),
  );

  out.push(section(`10. ${NOTICE_ANCHORS_V2.opusDecoderChain}`));
  out.push(
    [
      'Used to turn WhatsApp voice notes (Ogg Opus) into audio for the local transcriber. Plain JavaScript inside',
      'app.asar; the WebAssembly is embedded in the JavaScript as a string (no .wasm file, no native addon).',
      ...v2.decoder.map((d) => `  ${d.name}@${d.version}  -  ${d.license}`),
      'Each of these packages carries its own licence text inside app.asar under node_modules/<name>/ where its',
      'author ships one; the Apache-2.0 text is at https://www.apache.org/licenses/LICENSE-2.0',
      '',
    ].join('\n'),
  );

  out.push(section(`11. ${NOTICE_ANCHORS_V2.libopus}`));
  out.push(
    [
      'Project: https://opus-codec.org/  (licence: https://opus-codec.org/license/)',
      'The libopus licence, reproduced from the COPYING file of the libopus source distribution:',
      '',
      v2.libopusLicense.trim(),
      '',
    ].join('\n'),
  );

  out.push(section('12. Speech-recognition models  (downloaded by the user, not redistributed here)'));
  out.push(
    [
      'No speech model is contained in this installer. When the user turns on voice notes, the application',
      'downloads the chosen file from Hugging Face over HTTPS, pinned by commit, size and SHA-256:',
      '',
      `${NOTICE_ANCHORS_V2.ivritAi}`,
      '  Hebrew tier: ggml-model.bin - https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml',
      '  Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0',
      '',
      `${NOTICE_ANCHORS_V2.openaiWhisper}`,
      '  Multilingual and Lite tiers: ggml conversions of OpenAI Whisper (large-v3-turbo q8_0, small q8_0)',
      '  published at https://huggingface.co/ggerganov/whisper.cpp ; Whisper: https://github.com/openai/whisper',
      '  (MIT License, Copyright (c) 2022 OpenAI).',
      '',
      `${NOTICE_ANCHORS_V2.sileroVad}`,
      '  Voice-activity model ggml-silero-v6.2.0.bin - https://huggingface.co/ggml-org/whisper-vad ;',
      '  Silero VAD: https://github.com/snakers4/silero-vad (MIT License).',
      '',
      'The picture projectors (mmproj-F16.gguf of the three Gemma tiers) are downloaded on demand under the',
      'Gemma terms of section 6, like the language models themselves.',
      'Model files live in the user profile and are never bundled or re-distributed by this application.',
      '',
    ].join('\n'),
  );

  out.push(section(`13. ${NOTICE_ANCHORS_V2.calendarPatch} ${v2.calendarPatch.version}`));
  out.push(
    [
      `The file resources\\calendar-mcp\\node_modules\\@cocal\\google-calendar-mcp\\build\\index.js is a MODIFIED copy`,
      `of the published @cocal/google-calendar-mcp ${v2.calendarPatch.version} bundle (MIT, see section 5; the licence`,
      'text ships unchanged beside it as LICENSE). The build applies exactly these insertions and nothing else, only',
      'to the byte-identical published bundle:',
      ...v2.calendarPatch.insertions.map((i) => `  (${String(i.id)}) ${i.name}`),
      `SHA-256 of the published bundle: ${v2.calendarPatch.unpatchedSha}`,
      `SHA-256 of the shipped, modified bundle: ${v2.calendarPatch.patchedSha}`,
      'Purpose: let the application change or cancel an event it created itself, with an If-Match guard, and never',
      'delete one. The insertions are recorded in vendor/calendar-mcp.patch.json of the application source.',
      '',
    ].join('\n'),
  );
  return out;
}

/**
 * Production npm packages, from the root lockfile: every `node_modules/**` entry that is not `dev`.
 * Returns `[{ name, version, license }]` sorted by name (scoped names kept intact).
 */
export function productionPackages(lock) {
  const rows = [];
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    if (value.dev === true || value.devOptional === true) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    rows.push({ name, version: value.version ?? '', license: value.license ?? 'see package' });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/** `{ MIT: 113, ... }` sorted by descending count - the summary line above the full list. */
export function licenseHistogram(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.license, (counts.get(r.license) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function section(title) {
  return `${'='.repeat(100)}\n${title}\n${'='.repeat(100)}\n`;
}

/**
 * Builds the whole notices text.
 * @param {object} input
 * @param {string} input.llamaTag          e.g. `b10964`
 * @param {string} input.llamaUrl          the pinned release asset URL
 * @param {string} input.llamaMit          the MIT text of the pinned llama.cpp tag
 * @param {string} input.bridgeLicense     the bridge's MIT text (repository root LICENSE, ARCH 4.1)
 * @param {string} input.bridgeSha256      the pinned SHA-256 of `whatsapp-bridge.exe`
 * @param {string} input.mcpVersion        `@cocal/google-calendar-mcp` version (ARCH 16)
 * @param {string[]} input.stagedCrt       CRT file names actually staged next to llama-server.exe (may be empty)
 * @param {{name,version,license}[]} input.npmPackages
 * @param {string[]} input.models          human-readable model ids of ARCH 17
 */
export function buildNotices(input) {
  const hist = licenseHistogram(input.npmPackages);
  const out = [];

  out.push(section('THIRD PARTY NOTICES - WhatsApp Calendar Agent'));
  out.push(
    [
      'This application is distributed with the third-party components listed below.',
      'Each component remains under its own licence; the full licence text of every component that requires',
      'verbatim redistribution is reproduced in this file, except where the component ships its own licence file',
      'next to its binaries (those files are named explicitly).',
      '',
      'Local language models are NOT part of this installer. They are downloaded by the user, on request, at run time.',
      '',
    ].join('\n'),
  );

  out.push(section('1. WhatsApp bridge - whatsapp-bridge.exe  (MIT)'));
  out.push(
    [
      'Shipped at: resources\\bridge\\whatsapp-bridge.exe (pinned SHA-256 ' + input.bridgeSha256 + ')',
      'A prebuilt Go binary; the corresponding source is vendored for reference in vendor/whatsapp-bridge-src/.',
      'Fork of https://github.com/lharries/whatsapp-mcp',
      '',
      input.bridgeLicense.trim(),
      '',
    ].join('\n'),
  );

  out.push(section(`2. llama.cpp ${input.llamaTag} - Windows/Vulkan x64 build  (MIT)`));
  out.push(
    [
      'Shipped at: resources\\llama\\ (llama-server.exe and the ggml/llama/mtmd DLLs of the pinned release)',
      `Source of the binaries: ${input.llamaUrl}`,
      'Project: https://github.com/ggml-org/llama.cpp',
      '',
      input.llamaMit.trim(),
      '',
    ].join('\n'),
  );

  out.push(section('3. LLVM OpenMP runtime - libomp.dll  (Apache-2.0 WITH LLVM-exception)'));
  out.push(
    [
      'Shipped at: resources\\llama\\libomp.dll',
      'The complete licence text, as published in the same llama.cpp release archive, is shipped verbatim',
      'next to the binary as:  resources\\llama\\LICENSE-LLVM-OpenMP',
      'It is not duplicated here; that file is the copy required by the licence.',
      '',
    ].join('\n'),
  );

  out.push(section('4. Microsoft Visual C++ 2015-2022 Redistributable runtime files'));
  out.push(
    input.stagedCrt.length > 0
      ? [
          `Shipped at: resources\\llama\\ (${input.stagedCrt.join(', ')})`,
          'These files are redistributed under the "Distributable Code" terms of the Microsoft Visual Studio',
          'licence, which permit shipping the Visual C++ runtime files with an application. They are copied from a',
          'Microsoft.VC143.CRT folder on the build machine and pinned by SHA-256 in vendor/llama.pin.json.',
          'Microsoft Visual C++ and Visual Studio are trademarks of Microsoft Corporation.',
          '',
        ].join('\n')
      : [
          'NOT SHIPPED IN THIS BUILD.',
          'The build machine did not set VC_REDIST_CRT_DIR, so msvcp140.dll / vcruntime140.dll / vcruntime140_1.dll',
          'were not staged next to llama-server.exe. On a PC without the Microsoft Visual C++ 2015-2022 x64',
          'Redistributable the local model runtime cannot start; the application detects this before spawning and',
          "shows the LLM_VCREDIST_MISSING error, whose single action opens Microsoft's own download page.",
          'Cloud providers and every other feature are unaffected.',
          '',
        ].join('\n'),
  );

  out.push(section('5. Google Calendar MCP server  (MIT)'));
  out.push(
    [
      `Shipped at: resources\\calendar-mcp\\ - @cocal/google-calendar-mcp ${input.mcpVersion} and its production`,
      'dependency tree (googleapis, google-auth-library, @modelcontextprotocol/sdk, open, zod and their transitive',
      'dependencies), installed with `npm ci --omit=dev --ignore-scripts` from a committed lockfile.',
      'Project: https://github.com/nspady/google-calendar-mcp (MIT).',
      'Each package in that tree carries its own LICENSE file inside resources\\calendar-mcp\\node_modules\\.',
      'This server is never imported by application code; it runs as a separate stdio child process.',
      '',
    ].join('\n'),
  );

  out.push(section('6. Local language models  (downloaded by the user, not redistributed here)'));
  out.push(
    [
      'No model weights are contained in this installer. When the user chooses the Local provider, the application',
      'downloads one of the following GGUF files from Hugging Face over HTTPS, pinned by commit and SHA-256:',
      ...input.models.map((m) => `  - ${m}`),
      '',
      'The Gemma models are made available by Google under the Apache License 2.0 together with the Gemma Terms of',
      'Use and the Gemma Prohibited Use Policy, which the user accepts with Google on download:',
      '  https://ai.google.dev/gemma/terms      https://ai.google.dev/gemma/prohibited_use_policy',
      '  Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0',
      'The GGUF conversions are published by the Unsloth project. Model files live in the user profile',
      '(%APPDATA%\\WhatsApp Calendar Agent\\models) and are never bundled or re-distributed by this application.',
      '',
    ].join('\n'),
  );

  out.push(section('7. Electron'));
  out.push(
    [
      'This application is built on Electron (MIT), which embeds Chromium (BSD-3-Clause and the licences listed in',
      "Chromium's own credits) and Node.js (MIT). The complete Chromium and Electron credits are shipped by the",
      'Electron runtime itself as  LICENSES.chromium.html  and  LICENSE  in the installation directory.',
      '',
    ].join('\n'),
  );

  out.push(section(`8. npm production dependencies inside app.asar  (${input.npmPackages.length} packages)`));
  out.push(
    [
      'All are pure JavaScript; there is no native addon anywhere in the production tree (no binding.gyp, no *.node).',
      `Licence summary: ${hist.map(([lic, n]) => `${lic} (${n})`).join(', ')}.`,
      'Each package ships its own licence text inside app.asar under node_modules/<name>/.',
      '',
      ...input.npmPackages.map((p) => `  ${p.name}@${p.version}  -  ${p.license}`),
      '',
    ].join('\n'),
  );

  if (input.v2 !== undefined) out.push(...buildV2Sections(input.v2));

  out.push(section('END OF THIRD PARTY NOTICES'));
  return `${out.join('\n')}`;
}

/** Reads `vendor/llama/win-x64-vulkan/MANIFEST.txt` (when present) and returns the CRT names it lists. */
export function stagedCrtFrom(manifestText) {
  if (typeof manifestText !== 'string') return [];
  const listed = new Set(
    manifestText
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
  return CRT_FILES.filter((n) => listed.has(n));
}

export function main(io = { out: process.stdout, err: process.stderr }) {
  const pin = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor', 'llama.pin.json'), 'utf8'));
  const manifestPath = join(REPO_ROOT, ...pin.llama.targetDir.split('/'), 'MANIFEST.txt');
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const mcpPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'build-resources', 'calendar-mcp', 'package.json'), 'utf8'));

  if (!existsSync(LLAMA_MIT_PATH)) {
    io.err.write(
      `notices: FAIL - ${LLAMA_MIT_PATH} is missing. It is committed; restore it (or re-run scripts/fetch-llama.mjs and copy the MIT block out of the file it writes).\n`,
    );
    return 1;
  }
  // [V2-W2-04] the v2 inputs: every one is required - a missing file fails the regeneration instead of silently
  // dropping a notice (smoke check 12 would fail on the packaged file anyway).
  for (const [path, fix] of [
    [WHISPER_MIT_PATH, 'run `npm run fetch:whisper` (it writes the MIT text of the pinned tag)'],
    [LIBOPUS_LICENSE_PATH, 'it is committed; restore it from git'],
  ]) {
    if (!existsSync(path)) {
      io.err.write(`notices: FAIL - ${path} is missing - ${fix}.\n`);
      return 1;
    }
  }
  const whisperPin = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor', 'whisper.pin.json'), 'utf8'));
  const whisperManifest = join(REPO_ROOT, 'vendor', 'whisper', 'MANIFEST.txt');
  const calPin = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor', 'calendar-mcp.pin.json'), 'utf8'));
  const calPatch = JSON.parse(readFileSync(join(REPO_ROOT, 'vendor', 'calendar-mcp.patch.json'), 'utf8'));
  const decoder = decoderChainFrom(lock);
  const missingDecoder = decoder.filter((d) => d.version === 'MISSING');
  if (missingDecoder.length > 0) {
    io.err.write(
      `notices: FAIL - package-lock.json has no root entry for ${missingDecoder.map((d) => d.name).join(', ')}.\n`,
    );
    return 1;
  }

  const text = buildNotices({
    v2: {
      whisperTag: whisperPin.whisper.tag,
      whisperUrl: whisperPin.whisper.url,
      whisperMit: readFileSync(WHISPER_MIT_PATH, 'utf8'),
      whisperCrt: existsSync(whisperManifest) ? stagedCrtFrom(readFileSync(whisperManifest, 'utf8')) : [],
      decoder,
      libopusLicense: readFileSync(LIBOPUS_LICENSE_PATH, 'utf8'),
      calendarPatch: {
        version: calPin.version,
        unpatchedSha: calPin.bundleSha256Unpatched,
        patchedSha: calPin.bundleSha256Patched,
        insertions: calPatch.insertions.map((i) => ({ id: i.id, name: i.name })),
      },
    },
    llamaTag: pin.llama.tag,
    llamaUrl: pin.llama.url,
    llamaMit: readFileSync(LLAMA_MIT_PATH, 'utf8'),
    bridgeLicense: readFileSync(BRIDGE_LICENSE_PATH, 'utf8'),
    bridgeSha256: 'AC23221E8BCF3937A4CA346B3BD80A8DA09DF94CBECD949AF2916C4BC8D22FF5',
    mcpVersion: mcpPkg.dependencies['@cocal/google-calendar-mcp'],
    stagedCrt: existsSync(manifestPath) ? stagedCrtFrom(readFileSync(manifestPath, 'utf8')) : [],
    npmPackages: productionPackages(lock),
    models: [
      'tiny  - Gemma 4 E2B-it Q4_K_M   (unsloth/gemma-4-E2B-it-GGUF)',
      'small - Gemma 4 E4B-it Q4_K_M   (unsloth/gemma-4-E4B-it-GGUF)',
      'mid   - Gemma 4 12B-it QAT UD-Q4_K_XL (unsloth/gemma-4-12B-it-qat-GGUF)',
    ],
  });

  writeFileSync(NOTICES_PATH, text, 'utf8');
  io.out.write(`notices: wrote ${NOTICES_PATH} (${String(text.length)} bytes)\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
