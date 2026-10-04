#!/usr/bin/env node
// scripts/smoke-packaged.mjs - L6 packaging smoke (TESTS section 11, ARCH 15.4). Owner: W2-04-packaging.
//
//   node scripts/smoke-packaged.mjs "dist/win-unpacked" [--allow-missing-bridge]
//
// Runs the six checks of TESTS section 11 against an `electron-builder --dir` tree, plus check 4a (below):
//   4a. the packaged calendar MCP server: `<resources>\calendar-mcp\node_modules` must carry the whole staged tree.
//      Its own hard check, run FIRST, because the verbatim ARCH 15.2 `extraResources` block ships a package with no
//      calendar server at all (electron-builder drops a matcher's ROOT node_modules) and checks 1/2 would report that
//      shipping blocker as a spawn failure;
//   1. fuse alive + the real calendar MCP server reachable THROUGH the packaged exe under ELECTRON_RUN_AS_NODE=1
//      (initialize + tools/list === the six names of ARCH 5.1; 20 s budget; killed by PID);
//   2. one real `tools/call` through the packaged binary, against a type-stripped copy of
//      `tests/fakes/fake-mcp-calendar.ts` (step 1 cannot call a tool - there is no Google account);
//   3. the fuse wire read back with `@electron/fuses` === the ARCH 15.2 values;
//   4. resources present; the packaged `whatsapp-bridge.exe` STREAMS to the pinned SHA-256 (hashing only);
//      every file of `vendor/llama/MANIFEST.txt`; the staged calendar-mcp entry; icons, links.json, licenses;
//   5. `app.asar` LISTING (never extracted into a temp app): required entries present; no `*.map`, `tests/`,
//      `*.node`, `binding.gyp`, no forbidden root-declared package, no seam string in the main bundle,
//      no `app.asar.unpacked` directory;
//   6. the no-GUI rule: this script NEVER starts the packaged app as a GUI. Every spawn it makes is recorded and
//      asserted to carry ELECTRON_RUN_AS_NODE=1, i.e. the binary only ever runs as plain Node here.
//      Starting the packaged/installed GUI is manual checklist item M9 and is a job for the user, never an agent.
//
// [V2-W2-04] v2 (T2 section 11): check 1 now expects the EIGHT names of ARCH-v2 B3, plus checks 7-12:
//   7. whisper binaries: `<resources>\whisper` == the file set of `vendor/whisper/MANIFEST.txt` (CRT iff staged), every
//      file streams to its `vendor/whisper/SHA256SUMS` line, the zip pin is b5130 / 8,573,270 B / f9ec...16f3c,
//      `whisper-cli.exe` is a PE32+ x64 image (header bytes READ, never executed), and no ggml DLL is shared between
//      `<resources>\whisper` and `<resources>\llama` (hash comparison - B18 "never mix");
//   8. model manifest: `out/main/manifest.json` inside app.asar (the build's JSON sidecar of manifest.ts) deep-equals
//      `vendor/models.pin.json`, with the B18 voice sizes, the VAD sha256, the three mmproj pins, commit-pinned
//      https huggingface.co URLs only and no executable extension;
//   9. calendar server v2: the real packaged server's tools/list (from check 1) has update-event with
//      `status.enum ∋ cancelled`, an `ifMatch` property, `destructiveHint:true`, and get-event; the packaged
//      `build/index.js` sha256 equals the post-patch pin and carries each of the seven insertion markers once;
//  10. no vendor binaries: no claude.exe / claude.cmd / agy.exe / gemini*.exe / whisper-server.exe anywhere in the
//      unpacked tree; none of the ARCH-v2 12 forbidden packages anywhere inside app.asar;
//  11. decoder packaging: opus-decoder@0.7.12 and its three deps in app.asar, no `*.wasm` anywhere, no
//      app.asar.unpacked; the seam-string scan (check 5) covers every `out/main/**.js` and the v2 seams;
//  12. notices: THIRD_PARTY_NOTICES.txt carries the v2 anchors of `smoke-packaged.notices.mjs` and the whisper.cpp
//      MIT text verbatim.
//
// Exit codes: 0 = pass, 1 = fail, 3 = SMOKE INCOMPLETE (`--allow-missing-bridge`; never a release result).
//
// No binary from `resources\bridge`, `resources\llama` or `resources\whisper` is ever EXECUTED: the bridge exe and
// every whisper file are only hashed (whisper-cli.exe's PE header is read), llama-server.exe is only checked for
// existence. The only process this script starts is the packaged exe AS PLAIN NODE (ELECTRON_RUN_AS_NODE=1).
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import { BRIDGE_EXE_SHA256, BRIDGE_EXE_SIZE } from './import-bridge.mjs';
import { hashFile, parseSums } from './hash-bridge.mjs';
import { NOTICE_ANCHORS_V2 } from './smoke-packaged.notices.mjs';

const require = createRequire(import.meta.url);
/** `@electron/asar` is CJS and has no `exports` map; the default import is its `module.exports`. */
const asar = require('@electron/asar');

export const OWNER = 'W2-04-packaging';
/** TESTS 11: `--allow-missing-bridge` produces this exit code, never 0 - it is not a release result. */
export const EXIT_SMOKE_INCOMPLETE = 3;

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url)); // never URL.pathname - the repo path contains a space

// =====================================================================================================================
// frozen expectations (all copied from ARCH / TESTS; a drift here must fail the build, not be "fixed" silently)
// =====================================================================================================================

/**
 * ARCH-v2 B3 `ENABLED_TOOLS` (eight names), in the order the architecture lists them. `tools/list` must equal this SET
 * exactly. The same set is pinned in `vendor/calendar-mcp.pin.json` `enabledTools` (unit test asserts both agree).
 */
export const EXPECTED_MCP_TOOLS = [
  'get-current-time',
  'get-freebusy',
  'list-events',
  'get-event',
  'list-calendars',
  'create-event',
  'update-event',
  'manage-accounts',
];

/**
 * ARCH 15.4 `[R2]`: the fixture credentials file, EXACTLY this shape. `redirect_uris[0]` is dereferenced by the
 * server BEFORE the MCP handshake; a fixture without it throws a TypeError that reads exactly like a flipped fuse.
 * These are not credentials: `TESTONLY` is a literal placeholder and no Google endpoint is ever contacted.
 */
export const OAUTH_FIXTURE = {
  installed: {
    client_id: 'TESTONLY.apps.googleusercontent.com',
    client_secret: 'TESTONLY',
    redirect_uris: ['http://localhost'],
  },
};

/** TESTS 4.1 lock 1 + T2 11 check 11: a PRODUCTION bundle (every `out/main/**.js`) must contain none of these. */
export const SEAM_STRINGS = [
  'WCA_E2E',
  'WCA_BRIDGE_CMD',
  'WCA_LLM',
  '__wcaTest',
  'stub-llm',
  'WCA_CLI_CMD',
  'WCA_WHISPER_CMD',
  'WCA_DIALOG_SCRIPT',
  'fake-claude-cli',
  'whisper-cli.mjs',
  'fake-agy',
];

/**
 * ARCH 16 forbidden packages, checked as ROOT-DECLARED entries inside `app.asar` (`node_modules/<name>`).
 * `ajv` / `ajv-formats` are expected DEEPER in the tree (under `@modelcontextprotocol/sdk`) and are allowed there.
 */
export const FORBIDDEN_PACKAGES = [
  'node-llama-cpp',
  'better-sqlite3',
  'electron-rebuild',
  'electron-store',
  'electron-updater',
  'openai',
  'ajv',
  'ipull',
  'tree-kill',
  'dependency-cruiser',
];
/** Same rule, as prefixes: `@electron-toolkit/*` and the `i18next-*` plugin family. */
export const FORBIDDEN_PACKAGE_PREFIXES = ['@electron-toolkit/', 'i18next-'];
/**
 * ARCH 16 `[R2]` explicit allow-list of TRANSITIVE occurrences. npm hoists, so `@modelcontextprotocol/sdk`'s own
 * `ajv` physically lands at `node_modules/ajv` inside the archive even though nothing declares it. The real rule
 * ("no forbidden name in the root package.json") is therefore checked separately, against the package.json that
 * `app.asar` actually carries - see `declaredDependencyProblems`.
 */
export const TRANSITIVE_ALLOWED = ['ajv', 'ajv-formats'];

/** ARCH 15.2 `electronFuses`. Fuses the architecture does not name are not asserted. */
export const EXPECTED_FUSES = {
  [FuseV1Options.RunAsNode]: FuseState.ENABLE, // REQUIRED by the MCP stdio child (A4)
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.DISABLE, // [LR] UNVERIFIED on Windows
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
};

export const FUSE_NAMES = {
  [FuseV1Options.RunAsNode]: 'runAsNode',
  [FuseV1Options.EnableCookieEncryption]: 'enableCookieEncryption',
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 'enableNodeOptionsEnvironmentVariable',
  [FuseV1Options.EnableNodeCliInspectArguments]: 'enableNodeCliInspectArguments',
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 'enableEmbeddedAsarIntegrityValidation',
  [FuseV1Options.OnlyLoadAppFromAsar]: 'onlyLoadAppFromAsar',
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: 'grantFileProtocolExtraPrivileges',
};

export const PRODUCT_EXE = 'WhatsApp Calendar Agent.exe';
export const MCP_PACKAGE_REL = join('calendar-mcp', 'node_modules', '@cocal', 'google-calendar-mcp');
export const MCP_REL_ENTRY = join(MCP_PACKAGE_REL, 'build', 'index.js');
export const MCP_TIMEOUT_MS = 20_000;
/** The staging `scripts/stage-calendar-mcp.mjs` produces; check 4a compares the package against it. */
export const STAGED_MCP_NODE_MODULES = join(REPO_ROOT, 'build-resources', 'calendar-mcp', 'node_modules');
/**
 * The one line `electron-builder.yml` must carry for the staged server to reach the package at all. Quoted verbatim
 * in the check 4a failure message, because the fix is not guessable from the symptom.
 */
export const CALENDAR_NODE_MODULES_MATCHER =
  '- { from: build-resources/calendar-mcp/node_modules, to: calendar-mcp/node_modules }';

// ---- [V2-W2-04] v2 expectations (T2 section 11, ARCH-v2 B4 / B18 / B32 / 12) ---------------------------------------

export const CALENDAR_PIN_PATH = join(REPO_ROOT, 'vendor', 'calendar-mcp.pin.json');
export const CALENDAR_PATCH_PATH = join(REPO_ROOT, 'vendor', 'calendar-mcp.patch.json');
export const WHISPER_PIN_PATH = join(REPO_ROOT, 'vendor', 'whisper.pin.json');
export const WHISPER_VENDOR_DIR = join(REPO_ROOT, 'vendor', 'whisper');
export const MODELS_PIN_PATH = join(REPO_ROOT, 'vendor', 'models.pin.json');
export const WHISPER_MIT_PATH = join(REPO_ROOT, 'resources', 'licenses', 'whisper.cpp-MIT.txt');

/** ARCH-v2 B18: the pinned whisper.cpp CPU zip. A drift in `vendor/whisper.pin.json` fails check 7. */
export const WHISPER_ZIP_PIN = {
  tag: 'b5130',
  size: 8_573_270,
  sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
};
/** ARCH-v2 12 `extraResources` filter for `<resources>\whisper` (the CRT trio only when staged). */
export const WHISPER_EXACT_FILES = ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll'];
export const WHISPER_CPU_RE = /^ggml-cpu-[a-z0-9_]+\.dll$/;
export const CRT_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];

/** ARCH-v2 B18 / T2 11 check 8: the voice files (size + kind) and the VAD sha256. */
export const VOICE_PINS = {
  'voice-hebrew': { size: 1_624_555_275, kind: 'asr' },
  'voice-multilingual': { size: 874_188_075, kind: 'asr' },
  'voice-lite': { size: 264_464_607, kind: 'asr' },
  'voice-vad': {
    size: 885_098,
    kind: 'vad',
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  },
};
/** ARCH-v2 12: the three `mmproj-F16.gguf` projectors - the ONLY mmproj- files anything may download (F19). */
export const MMPROJ_PINS = {
  'mmproj-tiny': 985_654_080,
  'mmproj-small': 990_372_672,
  'mmproj-mid': 175_115_840,
};
/** Download host allow-list for the manifest URLs (the `*.hf.co` CDN redirect is the downloader's concern). */
export const MODEL_URL_RE = /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\/([^/?#]+)$/;
export const EXECUTABLE_EXT_RE = /\.(exe|dll|cmd|bat|ps1|msi|com|scr|js|mjs|cjs|vbs)$/i;

/** B32 / T2 11 check 10: vendor binaries that must never be anywhere in the unpacked tree (case-insensitive). */
export const VENDOR_BINARY_RE = /^(claude\.exe|claude\.cmd|agy\.exe|gemini[^\\/]*\.exe|whisper-server\.exe)$/i;
/** ARCH-v2 12 forbidden list, searched at ANY depth inside app.asar (not only root-declared). */
export const FORBIDDEN_V2_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-code',
  '@google/gemini-cli',
  'ogg-opus-decoder',
  'codec-parser',
  'sharp',
  'canvas',
  '@discordjs/opus',
  'node-opus',
];
export const FORBIDDEN_V2_PREFIXES = ['@napi-rs/', 'ffmpeg'];

/** T2 11 check 11: the decoder chain (B18) and the licence each must declare. */
export const DECODER_PACKAGES = {
  'opus-decoder': { version: '0.7.12', license: 'MIT' },
  '@wasm-audio-decoders/common': { license: 'MIT' },
  'simple-yenc': { license: 'MIT' },
  '@eshaz/web-worker': { license: 'Apache-2.0' },
};

const sortedUnique = (xs) => [...new Set(xs)].sort();

/**
 * CHECK 7a - the whisper file set and its hashes. Plain data in, one line per problem out.
 * @param {object} input
 * @param {string[]|null} input.manifest      names of `vendor/whisper/MANIFEST.txt` (`null` = not fetched)
 * @param {Record<string,string>|null} input.sums  `vendor/whisper/SHA256SUMS` parsed (`null` = missing)
 * @param {object|null} input.pin             `vendor/whisper.pin.json`
 * @param {string[]|null} input.packaged      file names in `<resources>\whisper` (`null` = folder missing)
 * @param {Record<string,string>} input.packagedHashes  streamed sha256 of every packaged file
 */
export function whisperSetProblems({ manifest, sums, pin, packaged, packagedHashes }) {
  if (manifest === null) {
    return [
      'vendor/whisper/MANIFEST.txt is missing - run `npm run fetch:whisper` (the pinned b5130 zip, sha256-verified, ' +
        'never executed) and re-pack. Voice notes cannot be transcribed by a package without it.',
    ];
  }
  const problems = [];
  const p = pin?.whisper ?? {};
  if (p.tag !== WHISPER_ZIP_PIN.tag || p.size !== WHISPER_ZIP_PIN.size || p.sha256 !== WHISPER_ZIP_PIN.sha256) {
    problems.push(
      `vendor/whisper.pin.json drifted from ARCH-v2 B18 (expected tag ${WHISPER_ZIP_PIN.tag}, ` +
        `${String(WHISPER_ZIP_PIN.size)} B, sha256 ${WHISPER_ZIP_PIN.sha256}; got tag ${String(p.tag)}, ` +
        `${String(p.size)} B, sha256 ${String(p.sha256)})`,
    );
  }
  const names = sortedUnique(manifest);
  const notAllowed = names.filter(
    (n) => !WHISPER_EXACT_FILES.includes(n) && !WHISPER_CPU_RE.test(n) && !CRT_DLLS.includes(n),
  );
  if (notAllowed.length > 0)
    problems.push(`MANIFEST.txt lists files outside the B18 allow-list: ${notAllowed.join(', ')}`);
  const missingExact = WHISPER_EXACT_FILES.filter((n) => !names.includes(n));
  if (missingExact.length > 0) problems.push(`MANIFEST.txt lacks the required file(s) ${missingExact.join(', ')}`);
  if (!names.some((n) => WHISPER_CPU_RE.test(n))) problems.push('MANIFEST.txt lists no ggml-cpu-*.dll (CPU backend)');
  const crt = CRT_DLLS.filter((n) => names.includes(n));
  if (crt.length !== 0 && crt.length !== CRT_DLLS.length) {
    problems.push(`the VC++ CRT is staged partially (${crt.join(', ')}) - all three or none (VC_REDIST_CRT_DIR)`);
  }
  if (sums === null) {
    problems.push('vendor/whisper/SHA256SUMS is missing - re-run `npm run fetch:whisper`');
  } else {
    const unsummed = names.filter((n) => typeof sums[n] !== 'string');
    if (unsummed.length > 0) problems.push(`SHA256SUMS has no line for ${unsummed.join(', ')}`);
  }
  if (packaged === null) {
    problems.push(
      '<resources>\\whisper does not exist - electron-builder.yml needs the ARCH-v2 12 extraResources entry ' +
        '`{ from: vendor/whisper/win-x64-cpu, to: whisper, filter: [...] }`',
    );
    return problems;
  }
  const got = sortedUnique(packaged);
  const missing = names.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !names.includes(n));
  if (missing.length > 0) problems.push(`<resources>\\whisper is missing ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`<resources>\\whisper holds files outside MANIFEST.txt: ${extra.join(', ')}`);
  if (sums !== null) {
    for (const n of got.filter((x) => names.includes(x))) {
      if (typeof sums[n] === 'string' && packagedHashes?.[n] !== sums[n]) {
        problems.push(`<resources>\\whisper\\${n} does not stream to its SHA256SUMS line`);
      }
    }
  }
  return problems;
}

/**
 * CHECK 7b - `whisper-cli.exe` must be a PE32+ x64 image. Reads header bytes only; the file is never executed (T8).
 * @param {Buffer} head the first bytes of the file (>= 512 is plenty for a normal `e_lfanew`)
 */
export function pe32PlusX64Problems(head) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head ?? []);
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return ['whisper-cli.exe has no MZ header'];
  const off = b.readUInt32LE(0x3c);
  if (off + 26 > b.length) return ['whisper-cli.exe: e_lfanew points outside the header bytes read'];
  if (b.readUInt32LE(off) !== 0x00004550) return ['whisper-cli.exe has no PE\\0\\0 signature'];
  const problems = [];
  const machine = b.readUInt16LE(off + 4);
  if (machine !== 0x8664) problems.push(`whisper-cli.exe machine is 0x${machine.toString(16)}, expected 0x8664 (x64)`);
  const magic = b.readUInt16LE(off + 24);
  if (magic !== 0x20b)
    problems.push(`whisper-cli.exe optional-header magic is 0x${magic.toString(16)}, expected 0x20b (PE32+)`);
  return problems;
}

/**
 * CHECK 7c - B18 "ggml b5130 must never mix with llama's b10964": no ggml file of one folder may be byte-identical to
 * any file of the other (same-named files must differ or be absent). The CRT copies are excluded on purpose: each
 * folder carries its own identical copy by design (ARCH-v2 12).
 * @param {{ whisperHashes: Record<string,string>, llamaHashes: Record<string,string> }} input
 */
export function ggmlMixProblems({ whisperHashes, llamaHashes }) {
  const ggml = (h) => Object.entries(h ?? {}).filter(([n]) => /^ggml/i.test(n));
  const problems = [];
  const llama = ggml(llamaHashes);
  for (const [wName, wSha] of ggml(whisperHashes)) {
    for (const [lName, lSha] of llama) {
      if (wSha === lSha) {
        problems.push(
          `ggml mixing: <resources>\\whisper\\${wName} is byte-identical to <resources>\\llama\\${lName} (B18: never mix)`,
        );
      }
    }
  }
  return problems;
}

/** `out/main/manifest.json` ({MODEL_MANIFEST, MEDIA_MODEL_MANIFEST}) -> the `vendor/models.pin.json` shape. */
export function normalizeManifestSidecar(sidecar) {
  const row = (e, kind, magic) => ({
    id: e.tier,
    kind,
    magic,
    fileName: e.fileName,
    url: e.url,
    size: e.size,
    sha256: e.sha256,
  });
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  return {
    llm: Object.values(sidecar?.MODEL_MANIFEST ?? {})
      .map((e) => row(e, 'llm', 'GGUF'))
      .sort(byId),
    media: Object.values(sidecar?.MEDIA_MODEL_MANIFEST ?? {})
      .map((e) => row(e, e.kind, e.magic))
      .sort(byId),
  };
}

const PIN_ROW_KEYS = ['id', 'kind', 'magic', 'fileName', 'url', 'size', 'sha256'];
const pinRow = (e) => Object.fromEntries(PIN_ROW_KEYS.map((k) => [k, e?.[k]]));

/**
 * CHECK 8 - the packaged model manifest deep-equals `vendor/models.pin.json` and obeys the B18 / F19 pin rules.
 * @param {{ sidecar: object|null, pin: object|null }} input
 */
export function modelManifestProblems({ sidecar, pin }) {
  if (sidecar === null) {
    return ['app.asar has no out/main/manifest.json - the electron-vite sidecar plugin did not run (T2 11 check 8)'];
  }
  if (pin === null) {
    return ['vendor/models.pin.json is missing - run `node scripts/pin-models.mjs` (Hugging Face metadata only)'];
  }
  const problems = [];
  if (!sidecar.MODEL_MANIFEST || !sidecar.MEDIA_MODEL_MANIFEST) {
    problems.push('out/main/manifest.json lacks MODEL_MANIFEST or MEDIA_MODEL_MANIFEST');
  }
  const shipped = normalizeManifestSidecar(sidecar);
  const pinned = {
    llm: (pin.llm ?? []).map(pinRow).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    media: (pin.media ?? []).map(pinRow).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
  for (const table of ['llm', 'media']) {
    const s = new Map(shipped[table].map((e) => [e.id, e]));
    const p = new Map(pinned[table].map((e) => [e.id, e]));
    for (const id of sortedUnique([...s.keys(), ...p.keys()])) {
      if (!s.has(id)) {
        problems.push(`manifest.json has no ${table} entry "${id}" that vendor/models.pin.json pins`);
        continue;
      }
      if (!p.has(id)) {
        problems.push(`manifest.json ships the ${table} entry "${id}" that vendor/models.pin.json does not pin`);
        continue;
      }
      for (const k of PIN_ROW_KEYS) {
        if (s.get(id)[k] !== p.get(id)[k]) {
          problems.push(
            `manifest.json ${id}.${k} = ${JSON.stringify(s.get(id)[k])} differs from vendor/models.pin.json ` +
              `${JSON.stringify(p.get(id)[k])}${k === 'url' ? ' (copy the commit-pinned URL into manifest.ts)' : ''}`,
          );
        }
      }
    }
  }
  // Pin rules, applied to what SHIPS (the sidecar).
  for (const e of [...shipped.llm, ...shipped.media]) {
    const m = MODEL_URL_RE.exec(String(e.url));
    if (m === null) {
      problems.push(
        `${e.id}: URL is not an https://huggingface.co/<repo>/resolve/<40-hex commit>/ URL: ${String(e.url)}`,
      );
    } else if (m[1] !== e.fileName) {
      problems.push(`${e.id}: URL file ${m[1]} != fileName ${String(e.fileName)}`);
    }
    if (EXECUTABLE_EXT_RE.test(String(e.fileName)))
      problems.push(`${e.id}: executable extension ${String(e.fileName)}`);
    if (/mmproj-/i.test(String(e.fileName)) || /mmproj-/i.test(String(e.url))) {
      if (!(e.id in MMPROJ_PINS)) problems.push(`${e.id}: an mmproj- file outside the three pinned projectors (F19)`);
    }
  }
  for (const e of shipped.llm) {
    if (e.magic !== 'GGUF' || !String(e.fileName).endsWith('.gguf')) problems.push(`${e.id}: LLM files are GGUF .gguf`);
  }
  for (const [id, size] of Object.entries(MMPROJ_PINS)) {
    const e = shipped.media.find((x) => x.id === id);
    if (e === undefined) {
      problems.push(`${id}: missing from MEDIA_MODEL_MANIFEST`);
      continue;
    }
    if (e.kind !== 'mmproj' || e.magic !== 'GGUF' || e.fileName !== 'mmproj-F16.gguf' || e.size !== size) {
      problems.push(`${id}: expected kind mmproj, GGUF, mmproj-F16.gguf, ${String(size)} B`);
    }
  }
  for (const [id, want] of Object.entries(VOICE_PINS)) {
    const e = shipped.media.find((x) => x.id === id);
    if (e === undefined) {
      problems.push(`${id}: missing from MEDIA_MODEL_MANIFEST`);
      continue;
    }
    if (e.kind !== want.kind || e.magic !== 'GGML' || e.size !== want.size || !String(e.fileName).endsWith('.bin')) {
      problems.push(`${id}: expected kind ${want.kind}, GGML, a .bin file of ${String(want.size)} B (B18)`);
    }
    if (want.sha256 !== undefined && e.sha256 !== want.sha256) problems.push(`${id}: sha256 differs from B18`);
  }
  const known = new Set([...Object.keys(MMPROJ_PINS), ...Object.keys(VOICE_PINS)]);
  for (const e of shipped.media) {
    if (!known.has(e.id)) problems.push(`${e.id}: unexpected MEDIA_MODEL_MANIFEST entry`);
  }
  return problems;
}

/**
 * CHECK 9 - the real packaged calendar server's `tools/list` objects carry the B4 patch surface.
 * @param {Array<{name: string, inputSchema?: object, annotations?: object}>} tools
 */
export function calendarV2ToolProblems(tools) {
  const problems = [];
  const byName = new Map((tools ?? []).map((t) => [t.name, t]));
  if (!byName.has('get-event')) problems.push('get-event is not listed (B3 READ class for pre-flight + reconcile)');
  const upd = byName.get('update-event');
  if (upd === undefined) return [...problems, 'update-event is not listed'];
  const props = upd.inputSchema?.properties ?? {};
  const statusEnum = props.status?.enum;
  if (!Array.isArray(statusEnum) || !statusEnum.includes('cancelled')) {
    problems.push('update-event.inputSchema.properties.status.enum lacks "cancelled" (B4 insertion 1 missing)');
  }
  if (props.ifMatch === undefined) problems.push('update-event has no ifMatch property (B4 insertion 3 missing)');
  if (upd.annotations?.destructiveHint !== true) problems.push('update-event is not annotated destructiveHint:true');
  return problems;
}

/**
 * CHECK 9 - the packaged `build/index.js` is exactly the pinned patched bundle and carries every insertion once.
 * @param {{ bundleSha: string|null, bundleText: string|null, pin: object|null, insertions: Array<{id:number, marker:string}> }} input
 */
export function calendarPatchProblems({ bundleSha, bundleText, pin, insertions }) {
  if (bundleSha === null || bundleText === null) return ['the packaged calendar server build/index.js is missing'];
  const problems = [];
  if (typeof pin?.bundleSha256Patched !== 'string') {
    problems.push('vendor/calendar-mcp.pin.json has no bundleSha256Patched');
  } else if (bundleSha !== pin.bundleSha256Patched) {
    problems.push(
      bundleSha === pin.bundleSha256Unpatched
        ? 'the packaged calendar server is the UNPATCHED 2.6.3 bundle - run `npm run stage:mcp` (npm ci + the B4 patch) and re-pack'
        : 'the packaged calendar server build/index.js matches neither pin (unknown bytes)',
    );
  }
  if (!Array.isArray(insertions) || insertions.length !== 7) {
    problems.push('vendor/calendar-mcp.patch.json does not list the seven B4 insertions');
  } else {
    for (const ins of insertions) {
      const n = String(bundleText).split(ins.marker).length - 1;
      if (n !== 1)
        problems.push(`B4 insertion ${String(ins.id)} (${String(ins.name)}) occurs ${String(n)} times, expected once`);
    }
  }
  return problems;
}

/** CHECK 10a - vendor binaries anywhere in the unpacked tree (relative paths in, problems out). */
export function vendorBinaryProblems(relPaths) {
  return relPaths
    .filter((p) => VENDOR_BINARY_RE.test(basename(p.replace(/\\/g, '/'))))
    .map((p) => `vendor binary in the package (B32: never bundled): ${p}`);
}

/** Every package name that occurs as a `node_modules/<name>` segment of `entry`, at any depth. */
export function packageNamesIn(entry) {
  const p = entry.replace(/\\/g, '/');
  const out = [];
  const re = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/@][^/]*)/g;
  for (const m of p.matchAll(re)) out.push(m[1]);
  return out;
}

/** CHECK 10b - the ARCH-v2 12 forbidden packages anywhere inside app.asar. */
export function forbiddenV2PackageProblems(entries) {
  const found = new Set();
  for (const e of entries) {
    for (const name of packageNamesIn(e)) {
      if (FORBIDDEN_V2_PACKAGES.includes(name) || FORBIDDEN_V2_PREFIXES.some((pre) => name.startsWith(pre))) {
        found.add(name);
      }
    }
  }
  return [...found].sort().map((n) => `app.asar contains the forbidden package ${n} (ARCH-v2 12)`);
}

/**
 * CHECK 11 - the decoder chain is packaged, as plain JS, with no `.wasm` file and nothing unpacked.
 * @param {{ packages: Record<string, {version?: string, license?: string}|null>, wasmFiles: string[], hasUnpackedDir: boolean }} input
 *        `packages[name]` = the package.json found at `node_modules/<name>` in app.asar (`null` = absent)
 */
export function decoderProblems({ packages, wasmFiles, hasUnpackedDir }) {
  const problems = [];
  for (const [name, want] of Object.entries(DECODER_PACKAGES)) {
    const got = packages?.[name] ?? null;
    if (got === null) {
      problems.push(`app.asar lacks node_modules/${name} (the B18 decoder chain)`);
      continue;
    }
    if (want.version !== undefined && got.version !== want.version) {
      problems.push(`${name} is ${String(got.version)} in app.asar, D-070 approved ${want.version}`);
    }
    if (got.license !== want.license) {
      problems.push(`${name} declares licence ${String(got.license)}, expected ${want.license}`);
    }
  }
  for (const w of wasmFiles) problems.push(`a .wasm file ships in the package (the WASM must stay embedded): ${w}`);
  if (hasUnpackedDir) problems.push('resources\\app.asar.unpacked exists (B18: no asarUnpack for the decoder)');
  return problems;
}

/**
 * CHECK 12 - the packaged notices carry every v2 anchor and the whisper.cpp MIT text verbatim.
 * @param {{ text: string|null, anchors: Record<string,string>, whisperMit: string|null }} input
 */
export function noticesProblems({ text, anchors, whisperMit }) {
  if (text === null) return ['<resources>\\licenses\\THIRD_PARTY_NOTICES.txt is missing'];
  const problems = [];
  for (const [key, anchor] of Object.entries(anchors)) {
    if (!text.includes(anchor)) problems.push(`THIRD_PARTY_NOTICES.txt lacks the ${key} notice (anchor "${anchor}")`);
  }
  if (whisperMit === null) {
    problems.push('resources/licenses/whisper.cpp-MIT.txt is missing - run `npm run fetch:whisper`');
  } else if (!text.includes(whisperMit.trim())) {
    problems.push('THIRD_PARTY_NOTICES.txt does not reproduce the whisper.cpp MIT text verbatim');
  }
  return problems;
}

// =====================================================================================================================
// pure helpers (no fs, no spawn - these are what the unit tests drive)
// =====================================================================================================================

/** Compares a `getCurrentFuseWire` result against ARCH 15.2. Returns one line per disagreement. */
export function fuseProblems(wire) {
  const problems = [];
  for (const [key, expected] of Object.entries(EXPECTED_FUSES)) {
    const actual = wire?.[key];
    if (actual !== expected) {
      problems.push(
        `fuse ${FUSE_NAMES[key] ?? key}: expected ${describeFuse(expected)}, packaged exe has ${describeFuse(actual)}`,
      );
    }
  }
  return problems;
}

export function describeFuse(state) {
  if (state === FuseState.ENABLE) return 'ENABLE';
  if (state === FuseState.DISABLE) return 'DISABLE';
  if (state === FuseState.REMOVED) return 'REMOVED';
  if (state === FuseState.INHERIT) return 'INHERIT';
  return `<${String(state)}>`;
}

/** `tools/list` names must equal the six of ARCH 5.1 exactly - extra and missing are both fatal. */
export function toolListProblems(names) {
  const got = [...names].sort();
  const want = [...EXPECTED_MCP_TOOLS].sort();
  if (got.length === want.length && got.every((n, i) => n === want[i])) return [];
  const missing = want.filter((n) => !got.includes(n));
  const extra = got.filter((n) => !want.includes(n));
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`unexpected ${extra.join(', ')}`);
  return [`tools/list does not equal the eight ARCH-v2 B3 names (${parts.join('; ')})`];
}

/**
 * ARCH 15.4 / TESTS 11: the two failure modes of check 1 read identically from the outside, so they are
 * separated deliberately.
 *  - the child exited non-zero and said `Failed to start server`  => the FIXTURE or the server runtime is wrong;
 *  - the child is still alive, produced no JSON-RPC line in 20 s   => `runAsNode` is OFF and the exe started as a GUI.
 */
export function classifyMcpFailure({ exited, exitCode, stderr, sawJsonRpc, timedOut }) {
  if (sawJsonRpc) return null;
  const text = String(stderr ?? '');
  if (exited && exitCode !== 0 && /Failed to start server/i.test(text)) {
    return {
      mode: 'fixture',
      message:
        `fixture/runtime problem: the MCP server exited ${String(exitCode)} with "Failed to start server". ` +
        'The packaged exe DID run as Node (the fuse is fine); the credentials fixture or the staged server is wrong.',
    };
  }
  if (exited) {
    return {
      mode: 'fixture',
      message:
        `fixture/runtime problem: the MCP child exited ${String(exitCode)} before any JSON-RPC reply. stderr tail: ` +
        `${text.trim().split(/\r?\n/).slice(-4).join(' | ') || '(empty)'}`,
    };
  }
  if (timedOut) {
    return {
      mode: 'fuse',
      message:
        `fuse flipped: the packaged exe stayed alive for ${String(MCP_TIMEOUT_MS / 1000)} s and wrote no JSON-RPC to ` +
        'stdout. With ELECTRON_RUN_AS_NODE=1 honoured it would have answered `initialize`; instead it ignored the ' +
        'variable and started as an Electron GUI process. Check `electronFuses.runAsNode: true` in electron-builder.yml.',
    };
  }
  return { mode: 'unknown', message: 'the MCP child produced no JSON-RPC reply (no exit, no timeout recorded)' };
}

/**
 * CHECK 4a - "the package actually carries the calendar MCP server".
 *
 * This is a HARD check with its own message, not a by-product of "some file is missing", because the regression it
 * guards is silent, shipping-grade and not guessable from the symptom:
 *
 *   `extraResources: - { from: build-resources/calendar-mcp, to: calendar-mcp }` (the verbatim ARCH 15.2 block)
 *   copies ONLY package.json + package-lock.json. `app-builder-lib/out/util/filter.js` rejects a matcher's ROOT
 *   node_modules before any pattern is consulted:
 *       if (relative === "node_modules") { return false; }
 *   so no `filter:` entry can bring it back (measured: `filter: ['**\/*', 'node_modules/**']` still copies 0 files).
 *   The build stays green, every unit/integration test stays green - and the installed app has no calendar server:
 *   `mcp/host.ts` can never spawn it and every calendar feature is dead at run time.
 *
 * Inputs are plain data so the decision logic is unit-tested without a packaged tree:
 * @param {object} input
 * @param {string[]|null} input.stagedPackages   top-level names under build-resources/calendar-mcp/node_modules
 *                                               (`null` = the folder does not exist; dot-entries excluded)
 * @param {string[]|null} input.packagedPackages the same listing inside `<resources>\calendar-mcp\node_modules`
 * @param {boolean} input.entryExists            `<resources>\` + MCP_REL_ENTRY exists
 * @param {boolean} input.packageJsonExists      `<resources>\calendar-mcp\package.json` exists (ARCH 15.3)
 * @param {boolean} input.lockExists             `<resources>\calendar-mcp\package-lock.json` exists (ARCH 15.3)
 * @returns {string[]} one line per problem; empty = pass
 */
export function calendarServerProblems({
  stagedPackages,
  packagedPackages,
  entryExists,
  packageJsonExists,
  lockExists,
}) {
  const problems = [];
  const staged = stagedPackages ?? [];
  const packaged = packagedPackages ?? [];

  if (packaged.length === 0) {
    if (staged.length === 0) {
      // Not a packaging fault: there was nothing to copy in the first place.
      problems.push(
        'the calendar MCP server was never STAGED: build-resources\\calendar-mcp\\node_modules is empty or missing. ' +
          'Run `npm run stage:mcp` (npm ci --omit=dev --ignore-scripts from the committed lockfile) and re-pack. ' +
          'Until then this run cannot prove anything about the packaging of the server.',
      );
    } else {
      problems.push(
        `PACKAGING REGRESSION - the packaged app contains NO calendar server: <resources>\\calendar-mcp\\node_modules ` +
          `is empty although build-resources\\calendar-mcp\\node_modules holds ${String(staged.length)} packages. ` +
          "Cause: electron-builder drops a matcher's ROOT node_modules unconditionally " +
          '(app-builder-lib/out/util/filter.js: `if (relative === "node_modules") return false`), before any ' +
          '`filter:` pattern is consulted - so an explicit `node_modules/**` include does NOT help (measured: 0 files). ' +
          `Fix: keep a SECOND extraResources matcher rooted AT that folder in electron-builder.yml:  ${CALENDAR_NODE_MODULES_MATCHER}  ` +
          'Without it mcp/host.ts can never spawn the server and every calendar feature is dead at run time.',
      );
    }
    return problems; // everything below would only repeat this one cause
  }

  if (!entryExists) {
    problems.push(
      `the calendar MCP entry point ${MCP_REL_ENTRY} is missing although ${String(packaged.length)} package folder(s) ` +
        'were copied into <resources>\\calendar-mcp\\node_modules - the staged tree is incomplete or the wrong ' +
        'server version was staged. Re-run `npm run stage:mcp` and re-pack.',
    );
  }

  const missing = staged.filter((name) => !packaged.includes(name));
  if (missing.length > 0) {
    problems.push(
      `PARTIAL COPY of the calendar server: ${String(missing.length)} of ${String(staged.length)} staged top-level ` +
        `package folder(s) never reached <resources>\\calendar-mcp\\node_modules (first missing: ` +
        `${missing.slice(0, 6).join(', ')}). A dependency of the server will fail to resolve at run time; check the ` +
        'extraResources matchers in electron-builder.yml - nothing may filter that tree.',
    );
  }

  if (!packageJsonExists) {
    problems.push('<resources>\\calendar-mcp\\package.json is missing - ARCH 15.3 requires it beside node_modules');
  }
  if (!lockExists) {
    problems.push(
      '<resources>\\calendar-mcp\\package-lock.json is missing - ARCH 15.3 ships the committed lockfile with the server',
    );
  }
  return problems;
}

/** `vendor/llama/MANIFEST.txt` -> the file names it lists (MANIFEST.txt itself is not one of them). */
export function manifestNames(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== 'MANIFEST.txt');
}

/** True when `entry` is `node_modules/<name>` at the TOP level of the archive (root-declared), not nested. */
export function rootDeclaredPackage(entry) {
  const p = entry.replace(/\\/g, '/').replace(/^\/+/, '');
  const m = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)$/.exec(p);
  return m ? m[1] : null;
}

/**
 * The literal ARCH 16 rule, applied to the `package.json` that `app.asar` carries: no forbidden name may appear in
 * the root `dependencies` / `devDependencies`. There is NO transitive allow-list here - a declared `ajv` is a
 * violation even though a hoisted one is not.
 */
export function declaredDependencyProblems(packageJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    return ['app.asar/package.json is not valid JSON'];
  }
  const problems = [];
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (FORBIDDEN_PACKAGES.includes(name) || FORBIDDEN_PACKAGE_PREFIXES.some((p) => name.startsWith(p))) {
        problems.push(`app.asar/package.json declares the forbidden package "${name}" in ${field} (ARCH 16)`);
      }
    }
  }
  if (Object.keys(pkg.devDependencies ?? {}).length > 0) {
    problems.push(
      'app.asar/package.json still carries devDependencies - the packaged manifest should be production-only',
    );
  }
  return problems;
}

/**
 * The whole of check 5, over a plain list of archive entries plus the text of the main bundle and of package.json.
 * Returns one line per problem; an empty array is a pass.
 */
export function asarProblems({ entries, mainBundleText, packageJsonText, hasUnpackedDir }) {
  const problems = [];
  const norm = entries.map((e) => e.replace(/\\/g, '/').replace(/^\/+/, ''));
  const set = new Set(norm);

  for (const required of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'package.json']) {
    if (!set.has(required)) problems.push(`app.asar is missing the required entry ${required}`);
  }
  if (!norm.some((e) => /^out\/renderer\/assets\/.+\.js$/.test(e))) {
    problems.push('app.asar contains no built renderer script under out/renderer/assets/');
  }
  if (!norm.some((e) => /^out\/renderer\/assets\/.+\.css$/.test(e))) {
    problems.push('app.asar contains no built renderer stylesheet under out/renderer/assets/');
  }

  for (const e of norm) {
    if (e.endsWith('.map')) problems.push(`app.asar contains a source map: ${e}`);
    if (e.endsWith('.node')) problems.push(`app.asar contains a native addon: ${e}`);
    if (basename(e) === 'binding.gyp') problems.push(`app.asar contains a native build file: ${e}`);
    if (/^tests\//.test(e)) problems.push(`app.asar contains test material: ${e}`);
    if (basename(e) === '.e2e-build') {
      problems.push(
        `app.asar contains the e2e marker ${e} - this tree was built by \`build:e2e\`, or a stale marker survived ` +
          '`npm run build` (TESTS 14 says the production build rewrites out/ without it).',
      );
    }
    const pkg = rootDeclaredPackage(e);
    if (pkg === null || TRANSITIVE_ALLOWED.includes(pkg)) continue;
    if (FORBIDDEN_PACKAGES.includes(pkg) || FORBIDDEN_PACKAGE_PREFIXES.some((p) => pkg.startsWith(p))) {
      problems.push(`app.asar ships the forbidden package node_modules/${pkg} (ARCH 16)`);
    }
  }

  if (packageJsonText !== undefined) problems.push(...declaredDependencyProblems(packageJsonText));

  for (const seam of SEAM_STRINGS) {
    if (String(mainBundleText).includes(seam)) {
      problems.push(`the packaged main bundle contains the seam string "${seam}" (TESTS 4.1 lock 1)`);
    }
  }

  if (hasUnpackedDir) {
    problems.push(
      'resources\\app.asar.unpacked exists - ARCH 15.2 ships nothing unpacked (npmRebuild: false, no asarUnpack)',
    );
  }
  return problems;
}

// =====================================================================================================================
// a minimal newline-delimited JSON-RPC client over a child's stdio
// =====================================================================================================================

/** Every spawn this script makes, for the check-6 assertion. Exported so the unit test can inspect it. */
export const SPAWNS = [];

/**
 * Spawns the PACKAGED exe as plain Node. `ELECTRON_RUN_AS_NODE=1` is not optional and not a parameter:
 * this script must never be able to start the packaged app as a GUI (TESTS 11 check 6).
 */
function spawnAsNode(exePath, args, extraEnv) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    ...extraEnv,
    // Belt and braces: even if something above tried, these can never re-enable a GUI or a debugger.
    ELECTRON_NO_ATTACH_CONSOLE: '1',
  };
  SPAWNS.push({ exePath, args, runAsNode: env.ELECTRON_RUN_AS_NODE });
  return spawn(exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env });
}

/**
 * initialize -> notifications/initialized -> tools/list -> (optional) one tools/call, over stdio.
 * Resolves `{ ok, tools, callText, failure }`; never throws for a protocol failure, and always kills by PID.
 */
async function mcpSession({ exePath, args, env, callTool, timeoutMs = MCP_TIMEOUT_MS, log }) {
  const child = spawnAsNode(exePath, args, env);
  const pending = new Map();
  let stdoutBuf = '';
  let stderr = '';
  let sawJsonRpc = false;
  let exited = false;
  let exitCode = null;
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a server that prints a banner on stdout is tolerated; only JSON-RPC lines count
      }
      if (msg.jsonrpc !== '2.0') continue;
      sawJsonRpc = true;
      const waiter = msg.id !== undefined && pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    for (const [, waiter] of pending) waiter(null);
    pending.clear();
  });

  const deadline = Date.now() + timeoutMs;
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolveRpc) => {
      const id = nextId++;
      pending.set(id, resolveRpc);
      const left = deadline - Date.now();
      const timer = setTimeout(
        () => {
          if (pending.delete(id)) {
            timedOut = true;
            resolveRpc(null);
          }
        },
        Math.max(1, left),
      );
      timer.unref();
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        if (pending.delete(id)) resolveRpc(null);
      }
    });

  const finish = (result) => {
    // Kill by PID (TESTS 11): the child is a plain Node process here, so this ends the whole session.
    try {
      if (!exited && typeof child.pid === 'number') process.kill(child.pid);
    } catch {
      /* already gone */
    }
    return result;
  };

  const init = await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'wca-smoke-packaged', version: '1.0.0' },
  });
  if (init === null || init.error) {
    return finish({
      ok: false,
      failure: classifyMcpFailure({ exited, exitCode, stderr, sawJsonRpc, timedOut }) ?? {
        mode: 'protocol',
        message: `initialize failed: ${JSON.stringify(init?.error ?? null)}`,
      },
    });
  }
  log?.(
    `      initialize OK (server ${init.result?.serverInfo?.name ?? '?'} ${init.result?.serverInfo?.version ?? ''})`,
  );
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } catch {
    /* the exit handler reports it */
  }

  const listed = await request('tools/list', {});
  if (listed === null || listed.error || !Array.isArray(listed.result?.tools)) {
    return finish({
      ok: false,
      failure: classifyMcpFailure({ exited, exitCode, stderr, sawJsonRpc, timedOut }) ?? {
        mode: 'protocol',
        message: `tools/list failed: ${JSON.stringify(listed?.error ?? null)}`,
      },
    });
  }
  const toolDefs = listed.result.tools;
  const tools = toolDefs.map((t) => t.name);

  let callText = null;
  if (callTool) {
    const called = await request('tools/call', { name: callTool.name, arguments: callTool.args ?? {} });
    if (called === null || called.error) {
      return finish({
        ok: false,
        tools,
        failure: {
          mode: 'protocol',
          message: `tools/call ${callTool.name} failed: ${JSON.stringify(called?.error ?? null)}`,
        },
      });
    }
    if (called.result?.isError === true) {
      return finish({
        ok: false,
        tools,
        failure: { mode: 'protocol', message: `tools/call ${callTool.name} returned isError` },
      });
    }
    callText = (called.result?.content ?? []).map((c) => c.text ?? '').join('');
  }
  return finish({ ok: true, tools, toolDefs, callText });
}

// =====================================================================================================================
// check 2 fixture: a runnable copy of the fake, type-stripped with node:module
// =====================================================================================================================

/**
 * `tests/fakes/fake-mcp-calendar.ts` only auto-starts when `process.argv[1]` ends in `.ts` (its own guard), so the
 * stripped `.mjs` copy needs a 9-line launcher beside it. That launcher uses the fake's PUBLIC export
 * (`createFakeCalendar`) - it is not a re-implementation of the fake.
 * Both files are written INSIDE the repo so `@modelcontextprotocol/sdk` and `zod` resolve from the root node_modules.
 */
export function writeStrippedFake({ sourcePath, outDir, stripTypeScriptTypes }) {
  mkdirSync(outDir, { recursive: true });
  const stripped = stripTypeScriptTypes(readFileSync(sourcePath, 'utf8'), { mode: 'strip' });
  const fakePath = join(outDir, 'fake-mcp-calendar.mjs');
  const launcherPath = join(outDir, 'launch-fake-mcp-calendar.mjs');
  writeFileSync(fakePath, stripped, 'utf8');
  writeFileSync(
    launcherPath,
    [
      '// generated by scripts/smoke-packaged.mjs - starts the type-stripped fake as an MCP stdio server.',
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
      "import { createFakeCalendar } from './fake-mcp-calendar.mjs';",
      '',
      'const enabled =',
      "  process.env.ENABLED_TOOLS === undefined ? undefined : process.env.ENABLED_TOOLS.split(',').filter((s) => s.length > 0);",
      'const fake = createFakeCalendar({ enabledTools: enabled });',
      'await fake.server.connect(new StdioServerTransport());',
      '',
    ].join('\n'),
    'utf8',
  );
  return { fakePath, launcherPath };
}

// =====================================================================================================================
// the six checks
// =====================================================================================================================

function ok(log, line) {
  log(`  [ok]   ${line}`);
}
function bad(problems, log, line) {
  problems.push(line);
  log(`  [FAIL] ${line}`);
}

/** Top-level entry names of a directory, `null` when it does not exist. Dot-entries (`.bin`) are not packages. */
function packageFolderNames(dir) {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'));
  } catch {
    return null;
  }
}

/**
 * Check 4a - the packaged calendar MCP server. Runs FIRST: checks 1 and 2 both spawn that server, so without this
 * line a missing server reads as "the MCP child exited" and the reader goes looking for a flipped fuse.
 */
function check4aCalendarServer({ resourcesDir, log, problems }) {
  const packagedRoot = join(resourcesDir, 'calendar-mcp');
  const staged = packageFolderNames(STAGED_MCP_NODE_MODULES);
  const packaged = packageFolderNames(join(packagedRoot, 'node_modules'));
  const cp = calendarServerProblems({
    stagedPackages: staged,
    packagedPackages: packaged,
    entryExists: existsSync(join(resourcesDir, MCP_REL_ENTRY)),
    packageJsonExists: existsSync(join(packagedRoot, 'package.json')),
    lockExists: existsSync(join(packagedRoot, 'package-lock.json')),
  });
  for (const p of cp) bad(problems, log, `check 4a - ${p}`);
  if (cp.length === 0) {
    ok(
      log,
      `check 4a - calendar server packaged: all ${String((staged ?? []).length)} staged package folder(s), ` +
        `${MCP_REL_ENTRY} and the ARCH 15.3 package.json/package-lock.json are in <resources>\\calendar-mcp`,
    );
  }
}

async function check1Mcp({ exePath, resourcesDir, tmpDir, state, log, problems }) {
  const entry = join(resourcesDir, MCP_REL_ENTRY);
  if (!existsSync(entry)) {
    bad(
      problems,
      log,
      `check 1 - skipped: the calendar MCP entry is missing from the package: ${entry}. Check 4a above says why ` +
        '(staging vs the extraResources matchers of electron-builder.yml).',
    );
    return;
  }
  const credsPath = join(tmpDir, 'smoke-oauth-fixture.json');
  writeFileSync(credsPath, JSON.stringify(OAUTH_FIXTURE), 'utf8');

  const r = await mcpSession({
    exePath,
    args: [entry, 'start', '--transport', 'stdio'],
    env: {
      GOOGLE_OAUTH_CREDENTIALS: credsPath,
      GOOGLE_CALENDAR_MCP_TOKEN_PATH: join(tmpDir, 'smoke-tokens.json'),
      GOOGLE_ACCOUNT_MODE: 'personal',
      ENABLED_TOOLS: EXPECTED_MCP_TOOLS.join(','),
    },
    log,
  });
  if (!r.ok) {
    bad(problems, log, `check 1 - ${r.failure.message}`);
    return;
  }
  const listProblems = toolListProblems(r.tools);
  if (listProblems.length > 0) {
    for (const p of listProblems) bad(problems, log, `check 1 - ${p}`);
    return;
  }
  state.calendarToolDefs = r.toolDefs;
  ok(log, `check 1 - the packaged exe ran as Node and the real MCP server listed exactly the eight ARCH-v2 B3 tools`);
}

async function check2ToolCall({ exePath, tmpDir, log, problems }) {
  const { stripTypeScriptTypes } = await import('node:module');
  if (typeof stripTypeScriptTypes !== 'function') {
    bad(
      problems,
      log,
      'check 2 - node:module.stripTypeScriptTypes is unavailable (Node 24 is required, ARCH 16 engines)',
    );
    return;
  }
  const source = join(REPO_ROOT, 'tests', 'fakes', 'fake-mcp-calendar.ts');
  if (!existsSync(source)) {
    bad(problems, log, `check 2 - ${source} is missing`);
    return;
  }
  let launcherPath;
  try {
    ({ launcherPath } = writeStrippedFake({ sourcePath: source, outDir: tmpDir, stripTypeScriptTypes }));
  } catch (err) {
    bad(problems, log, `check 2 - could not type-strip the fake: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const r = await mcpSession({
    exePath,
    args: [launcherPath],
    env: { ENABLED_TOOLS: EXPECTED_MCP_TOOLS.join(',') },
    callTool: { name: 'get-current-time', args: {} },
    log,
  });
  if (!r.ok) {
    bad(problems, log, `check 2 - ${r.failure.message}`);
    return;
  }
  for (const p of toolListProblems(r.tools)) bad(problems, log, `check 2 - ${p}`);
  if (typeof r.callText !== 'string' || r.callText.trim() === '') {
    bad(problems, log, 'check 2 - `get-current-time` returned no text content through the packaged runtime');
    return;
  }
  ok(log, 'check 2 - one tools/call round trip completed over stdio through the packaged binary');
}

async function check3Fuses({ exePath, log, problems }) {
  let wire;
  try {
    wire = await getCurrentFuseWire(exePath);
  } catch (err) {
    bad(problems, log, `check 3 - could not read the fuse wire: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const fp = fuseProblems(wire);
  for (const p of fp) bad(problems, log, `check 3 - ${p}`);
  if (fp.length === 0) ok(log, 'check 3 - the fuse wire read back equals the seven ARCH 15.2 values');
}

async function check4Resources({ resourcesDir, allowMissingBridge, state, log, problems }) {
  const need = (rel, why) => {
    const p = join(resourcesDir, rel);
    if (existsSync(p)) return true;
    bad(problems, log, `check 4 - missing ${rel}${why ? ` (${why})` : ''}`);
    return false;
  };

  // --- bridge -------------------------------------------------------------------------------------------------
  const exe = join(resourcesDir, 'bridge', 'whatsapp-bridge.exe');
  need(join('bridge', 'LICENSE'));
  const sumsOk = need(join('bridge', 'SHA256SUMS'));
  if (!existsSync(exe)) {
    bad(problems, log, 'check 4 - missing bridge\\whatsapp-bridge.exe');
  } else if (allowMissingBridge && statSync(exe).size === 0) {
    // Only THIS branch downgrades the run to SMOKE INCOMPLETE. Passing the flag while a real, correctly pinned exe
    // is present must still produce a normal exit 0 - the flag is a permission to proceed, not a result.
    state.placeholderUsed = true;
    log('  [skip] check 4 - bridge hash line skipped: this tree was packed with the zero-byte placeholder');
  } else {
    const size = statSync(exe).size;
    const sha = (await hashFile(exe)).toUpperCase();
    if (size !== BRIDGE_EXE_SIZE) {
      bad(
        problems,
        log,
        `check 4 - packaged bridge exe is ${String(size)} bytes, the pin is ${String(BRIDGE_EXE_SIZE)}`,
      );
    } else if (sha !== BRIDGE_EXE_SHA256.toUpperCase()) {
      bad(problems, log, 'check 4 - packaged bridge exe does not match the pinned SHA-256');
    } else {
      ok(
        log,
        `check 4 - packaged whatsapp-bridge.exe streams to the pinned SHA-256 (${String(size)} bytes, never executed)`,
      );
    }
    if (sumsOk) {
      const listed = parseSums(readFileSync(join(resourcesDir, 'bridge', 'SHA256SUMS'), 'utf8'))['whatsapp-bridge.exe'];
      if (listed !== sha.toLowerCase())
        bad(problems, log, 'check 4 - packaged SHA256SUMS disagrees with the packaged exe');
    }
  }

  // --- llama --------------------------------------------------------------------------------------------------
  const manifest = join(REPO_ROOT, 'vendor', 'llama', 'win-x64-vulkan', 'MANIFEST.txt');
  if (!existsSync(manifest)) {
    bad(
      problems,
      log,
      'check 4 - vendor/llama/win-x64-vulkan/MANIFEST.txt is missing (run `node scripts/fetch-llama.mjs`)',
    );
  } else {
    const names = manifestNames(readFileSync(manifest, 'utf8'));
    const missing = names.filter((n) => !existsSync(join(resourcesDir, 'llama', n)));
    if (!names.includes('llama-server.exe'))
      bad(problems, log, 'check 4 - MANIFEST.txt does not list llama-server.exe');
    if (missing.length > 0) {
      bad(
        problems,
        log,
        `check 4 - resources\\llama is missing ${String(missing.length)} manifest file(s): ${missing.slice(0, 6).join(', ')}`,
      );
    } else {
      ok(
        log,
        `check 4 - all ${String(names.length)} files of vendor/llama/MANIFEST.txt are in resources\\llama (none executed)`,
      );
    }
  }

  // --- calendar mcp, icons, links, licenses -------------------------------------------------------------------
  // [R2] `resources\onboarding` is deliberately NOT required: ARCH 15.2 / build-plan section 6 removed the raster
  // onboarding assets from v1, so the "onboarding" word in TESTS 11 check 4 is stale. Requiring it would fail a
  // correct build.
  // The calendar MCP server is NOT checked here: it has its own hard check (4a), which compares the package against
  // the staged tree and names the electron-builder matcher that has to exist. A one-line `need()` here would report
  // that shipping blocker as just another missing file.
  const icons = ['tray.ico', 'tray-attention.ico', 'tray-paused.ico', 'tray-error.ico', 'notification.png'];
  const missingIcons = icons.filter((n) => !existsSync(join(resourcesDir, 'icons', n)));
  if (missingIcons.length > 0) bad(problems, log, `check 4 - resources\\icons is missing ${missingIcons.join(', ')}`);
  else ok(log, 'check 4 - the five tray/notification icons are present');
  need('links.json');
  if (need(join('licenses', 'THIRD_PARTY_NOTICES.txt'), 'run `node scripts/smoke-packaged.notices.mjs`')) {
    ok(log, 'check 4 - THIRD_PARTY_NOTICES.txt is present');
  }
}

function check5Asar({ resourcesDir, log, problems }) {
  const asarPath = join(resourcesDir, 'app.asar');
  if (!existsSync(asarPath)) {
    bad(problems, log, 'check 5 - resources\\app.asar does not exist');
    return;
  }
  let entries;
  let mainBundleText;
  let packageJsonText;
  try {
    entries = asar.listPackage(asarPath, { isPack: false });
    // `extractFile` splits the name on `path.sep`, so on Windows it must be given a backslash path even though
    // `listPackage` is normalised to forward slashes by `asarProblems`.
    // [V2] T2 11 check 11: the seam scan covers EVERY main-process chunk, not only index.js (v2 splits out chunks).
    mainBundleText = mainBundleEntries(entries)
      .map((e) => asar.extractFile(asarPath, join(...e.split('/'))).toString('utf8'))
      .join('\n');
    packageJsonText = asar.extractFile(asarPath, 'package.json').toString('utf8');
  } catch (err) {
    bad(problems, log, `check 5 - could not read app.asar: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const ap = asarProblems({
    entries,
    mainBundleText,
    packageJsonText,
    hasUnpackedDir: existsSync(join(resourcesDir, 'app.asar.unpacked')),
  });
  for (const p of ap) bad(problems, log, `check 5 - ${p}`);
  if (ap.length === 0) {
    ok(
      log,
      `check 5 - app.asar listing clean (${String(entries.length)} entries, no map/test/native/seam content in ` +
        `${String(mainBundleEntries(entries).length)} main chunk(s), nothing unpacked)`,
    );
  }
}

function check6NoGui({ log, problems }) {
  const offenders = SPAWNS.filter((s) => s.runAsNode !== '1');
  if (offenders.length > 0) {
    bad(
      problems,
      log,
      `check 6 - ${String(offenders.length)} spawn(s) of the packaged exe did NOT set ELECTRON_RUN_AS_NODE=1`,
    );
    return;
  }
  ok(
    log,
    `check 6 - no-GUI rule held: all ${String(SPAWNS.length)} spawn(s) ran the packaged exe as plain Node. ` +
      'Starting the packaged GUI is manual item M9.',
  );
}

// ---- [V2-W2-04] checks 7-12 ------------------------------------------------------------------------------------------

/** Every file under `dir`, as paths relative to it (forward slashes). `[]` when the folder does not exist. */
export function walkFiles(dir) {
  const out = [];
  const visit = (abs, rel) => {
    let items;
    try {
      items = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const r = rel === '' ? it.name : `${rel}/${it.name}`;
      if (it.isDirectory()) visit(join(abs, it.name), r);
      else out.push(r);
    }
  };
  visit(dir, '');
  return out;
}

/** The main-process JavaScript chunks inside the archive listing. */
export function mainBundleEntries(entries) {
  return entries
    .map((e) => e.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((e) => /^out\/main\/.+\.(js|mjs|cjs)$/.test(e));
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function hashesOf(dir, names) {
  const out = {};
  for (const n of names) out[n] = await hashFile(join(dir, n));
  return out;
}

/** Reads the first bytes of a file (the PE header) - reading only, never executing. */
function readHead(path, bytes = 4096) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

async function check7Whisper({ resourcesDir, log, problems }) {
  const manifestText = readTextOrNull(join(WHISPER_VENDOR_DIR, 'MANIFEST.txt'));
  const sumsText = readTextOrNull(join(WHISPER_VENDOR_DIR, 'SHA256SUMS'));
  const whisperDir = join(resourcesDir, 'whisper');
  const packaged = existsSync(whisperDir) ? readdirSync(whisperDir) : null;
  const packagedHashes = packaged === null ? {} : await hashesOf(whisperDir, packaged);
  const set = whisperSetProblems({
    manifest: manifestText === null ? null : manifestNames(manifestText),
    sums: sumsText === null ? null : parseSums(sumsText),
    pin: readJsonOrNull(WHISPER_PIN_PATH),
    packaged,
    packagedHashes,
  });
  for (const p of set) bad(problems, log, `check 7 - ${p}`);
  if (packaged === null || manifestText === null) return;

  const cli = join(whisperDir, 'whisper-cli.exe');
  const pe = existsSync(cli) ? pe32PlusX64Problems(readHead(cli)) : [];
  for (const p of pe) bad(problems, log, `check 7 - ${p}`);

  const llamaDir = join(resourcesDir, 'llama');
  const llamaNames = existsSync(llamaDir) ? readdirSync(llamaDir) : [];
  const mix = ggmlMixProblems({ whisperHashes: packagedHashes, llamaHashes: await hashesOf(llamaDir, llamaNames) });
  for (const p of mix) bad(problems, log, `check 7 - ${p}`);
  if (set.length === 0 && pe.length === 0 && mix.length === 0) {
    ok(
      log,
      `check 7 - <resources>\\whisper = the ${String(packaged.length)} MANIFEST files, each streams to SHA256SUMS; ` +
        'pin b5130 / 8,573,270 B; whisper-cli.exe is PE32+ x64 (header read, never executed); no ggml mixing with llama',
    );
  }
}

function check8ModelManifest({ resourcesDir, log, problems }) {
  const asarPath = join(resourcesDir, 'app.asar');
  let sidecar;
  try {
    sidecar = JSON.parse(asar.extractFile(asarPath, join('out', 'main', 'manifest.json')).toString('utf8'));
  } catch {
    sidecar = null;
  }
  const mp = modelManifestProblems({ sidecar, pin: readJsonOrNull(MODELS_PIN_PATH) });
  for (const p of mp) bad(problems, log, `check 8 - ${p}`);
  if (mp.length === 0) {
    ok(log, 'check 8 - the packaged model manifest deep-equals vendor/models.pin.json (B18 voice, F19 projectors)');
  }
}

async function check9CalendarV2({ resourcesDir, state, log, problems }) {
  const entry = join(resourcesDir, MCP_REL_ENTRY);
  const patch = readJsonOrNull(CALENDAR_PATCH_PATH);
  const pp = calendarPatchProblems({
    bundleSha: existsSync(entry) ? await hashFile(entry) : null,
    bundleText: readTextOrNull(entry),
    pin: readJsonOrNull(CALENDAR_PIN_PATH),
    insertions: patch?.insertions ?? null,
  });
  const tp =
    state.calendarToolDefs === undefined
      ? ['no tools/list result from check 1 to inspect (see check 1 above)']
      : calendarV2ToolProblems(state.calendarToolDefs);
  for (const p of [...pp, ...tp]) bad(problems, log, `check 9 - ${p}`);
  if (pp.length === 0 && tp.length === 0) {
    ok(
      log,
      'check 9 - packaged calendar server = the pinned PATCHED 2.6.3 bundle (7 insertions once each); update-event has ' +
        'status.enum incl. cancelled, ifMatch and destructiveHint; get-event listed (initialize + tools/list only)',
    );
  }
}

function check10NoVendorBinaries({ unpacked, resourcesDir, state, log, problems }) {
  const files = walkFiles(unpacked);
  state.unpackedFiles = files;
  const vb = vendorBinaryProblems(files);
  let fp;
  try {
    fp = forbiddenV2PackageProblems(asar.listPackage(join(resourcesDir, 'app.asar'), { isPack: false }));
  } catch (err) {
    fp = [`could not list app.asar: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const p of [...vb, ...fp]) bad(problems, log, `check 10 - ${p}`);
  if (vb.length === 0 && fp.length === 0) {
    ok(
      log,
      `check 10 - no claude/agy/gemini/whisper-server binary among ${String(files.length)} files; no ARCH-v2 12 ` +
        'forbidden package inside app.asar',
    );
  }
}

function check11Decoder({ unpacked, resourcesDir, state, log, problems }) {
  const asarPath = join(resourcesDir, 'app.asar');
  let entries;
  const packages = {};
  try {
    entries = asar.listPackage(asarPath, { isPack: false }).map((e) => e.replace(/\\/g, '/').replace(/^\/+/, ''));
    for (const name of Object.keys(DECODER_PACKAGES)) {
      const rel = `node_modules/${name}/package.json`;
      packages[name] = entries.includes(rel)
        ? JSON.parse(asar.extractFile(asarPath, join(...rel.split('/'))).toString('utf8'))
        : null;
    }
  } catch (err) {
    bad(problems, log, `check 11 - could not read app.asar: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const wasmFiles = [
    ...(state.unpackedFiles ?? walkFiles(unpacked)).filter((f) => /\.wasm$/i.test(f)),
    ...entries.filter((e) => /\.wasm$/i.test(e)).map((e) => `app.asar/${e}`),
  ];
  const dp = decoderProblems({
    packages,
    wasmFiles,
    hasUnpackedDir: existsSync(join(resourcesDir, 'app.asar.unpacked')),
  });
  for (const p of dp) bad(problems, log, `check 11 - ${p}`);
  if (dp.length === 0) {
    ok(
      log,
      'check 11 - opus-decoder@0.7.12 + its three MIT/Apache deps are in app.asar; no .wasm file anywhere; nothing ' +
        'unpacked (seam strings: check 5)',
    );
  }
}

function check12Notices({ resourcesDir, log, problems }) {
  const np = noticesProblems({
    text: readTextOrNull(join(resourcesDir, 'licenses', 'THIRD_PARTY_NOTICES.txt')),
    anchors: NOTICE_ANCHORS_V2,
    whisperMit: readTextOrNull(WHISPER_MIT_PATH),
  });
  for (const p of np) bad(problems, log, `check 12 - ${p}`);
  if (np.length === 0) {
    ok(
      log,
      `check 12 - THIRD_PARTY_NOTICES.txt carries all ${String(Object.keys(NOTICE_ANCHORS_V2).length)} v2 anchors ` +
        'and the whisper.cpp MIT text',
    );
  }
}

// =====================================================================================================================
// main
// =====================================================================================================================

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const allowMissingBridge = argv.includes('--allow-missing-bridge');
  const target = argv.find((a) => !a.startsWith('--')) ?? 'dist/win-unpacked';
  const unpacked = resolve(REPO_ROOT, target);
  const log = (line) => io.out.write(`${line}\n`);

  log(`smoke-packaged: ${unpacked}`);
  const exePath = join(unpacked, PRODUCT_EXE);
  if (!existsSync(exePath)) {
    io.err.write(`smoke-packaged: FAIL - ${exePath} does not exist. Run \`npm run pack:dir\` first.\n`);
    return 1;
  }
  const resourcesDir = join(unpacked, 'resources');
  const tmpDir = join(REPO_ROOT, 'test-results', 'smoke');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  SPAWNS.length = 0;

  const problems = [];
  const state = { placeholderUsed: false };
  check4aCalendarServer({ resourcesDir, log, problems });
  await check1Mcp({ exePath, resourcesDir, tmpDir, state, log, problems });
  await check2ToolCall({ exePath, tmpDir, log, problems });
  await check3Fuses({ exePath, log, problems });
  await check4Resources({ resourcesDir, allowMissingBridge, state, log, problems });
  check5Asar({ resourcesDir, log, problems });
  await check7Whisper({ resourcesDir, log, problems });
  check8ModelManifest({ resourcesDir, log, problems });
  await check9CalendarV2({ resourcesDir, state, log, problems });
  check10NoVendorBinaries({ unpacked, resourcesDir, state, log, problems });
  check11Decoder({ unpacked, resourcesDir, state, log, problems });
  check12Notices({ resourcesDir, log, problems });
  check6NoGui({ log, problems }); // last: it audits every spawn the checks above made

  if (problems.length > 0) {
    io.err.write(`\nsmoke-packaged: FAIL - ${String(problems.length)} problem(s):\n`);
    for (const p of problems) io.err.write(`  - ${p}\n`);
    return 1;
  }
  if (state.placeholderUsed) {
    log(
      '\nSMOKE INCOMPLETE - this tree was packed with the zero-byte bridge placeholder, so check 4 could not verify\n' +
        'the pinned bridge binary. Every other check passed. This is NOT a release result: run\n' +
        '`node scripts/import-bridge.mjs` (manual item M1) and then `npm run test:smoke` without the flag.',
    );
    return EXIT_SMOKE_INCOMPLETE;
  }
  log('\nsmoke-packaged: PASS - checks 1-12 (and 4a) green.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`smoke-packaged: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
