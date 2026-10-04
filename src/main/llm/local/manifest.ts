// src/main/llm/local/manifest.ts - compile-time model manifest (ARCHITECTURE section 17; owner W1-07). Pinned 2026-09-21.
import type { ModelFileId, ModelFileKind, ModelTier, Sha256Hex } from '../../../shared/types';

export interface ModelManifestEntry {
  tier: ModelTier;
  label: string; // shown in the UI ("Standard model" etc. come from locale keys; this is the technical label for runs/proposals)
  fileName: string;
  url: string; // pinned commit URL; download host allow-list: huggingface.co + *.hf.co redirects only
  size: number; // bytes
  sha256: Sha256Hex;
}

/** All Apache-2.0, not gated, text-only. Never download mmproj-* or mtp-*. */
export const MODEL_MANIFEST: Readonly<Record<ModelTier, ModelManifestEntry>> = {
  tiny: {
    tier: 'tiny',
    label: 'gemma-4-E2B-it-Q4_K_M',
    fileName: 'gemma-4-E2B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf',
    size: 3_106_738_272,
    sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
  },
  small: {
    tier: 'small',
    label: 'gemma-4-E4B-it-Q4_K_M',
    fileName: 'gemma-4-E4B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf',
    size: 4_977_171_584,
    sha256: '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87',
  },
  mid: {
    tier: 'mid',
    label: 'gemma-4-12B-it-qat-UD-Q4_K_XL',
    fileName: 'gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/980b060c40a8539ac159e0501a3e0f66a6365af3/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
    size: 6_716_356_800,
    sha256: '90fd44e29e0d7cffeb0fd00dc73cfdab9ed0b0e95306ecf7821ea634c940c370',
  },
};

/** Hosts the production downloader accepts (the e2e seam WCA_MODEL_MANIFEST additionally permits http://127.0.0.1).
 *  [R2] ARCHITECTURE section 9 states the rule as a SUFFIX rule over `.hf.co` AND `.huggingface.co` (never an exact-host
 *  list): Hugging Face picks the CDN host by region and backend. `.huggingface.co` was missing from the Wave 0 constant. */
export const DOWNLOAD_HOST_ALLOWLIST = { exact: ['huggingface.co'], suffix: ['.hf.co', '.huggingface.co'] } as const;

// =====================================================================================================================
// [V2 ADD] MEDIA_MODEL_MANIFEST (C2 13 "Manifests (F19, binding)", ARCH-v2 B18 / B19) - owner V2-W1-07-media-voice.
// MODEL_MANIFEST above keeps its exact v1 LLM-only shape (the frozen gguf-download.test.ts keeps passing). This second table holds
// the three projectors (B19, pinned at the v1 commits) and the four voice files (B18). Downloads and pins iterate BOTH tables; the
// magic is checked per entry; the "never mmproj-*" refusal is lifted for exactly the three projector ids below and nothing else.
// =====================================================================================================================
/** Id of a MEDIA_MODEL_MANIFEST entry: every ModelFileId that is not an LLM tier. */
export type MediaModelFileId = Exclude<ModelFileId, ModelTier>;
/** [V2-W1-07 refinement] C2 writes `ModelManifestEntry & {kind, magic}`, but `ModelManifestEntry.tier` is a ModelTier, which a voice
 *  file cannot carry. The media entry therefore keys `tier` by its own file id; every other field is the v1 entry's. */
export interface MediaModelManifestEntry extends Omit<ModelManifestEntry, 'tier'> {
  tier: MediaModelFileId;
  kind: Exclude<ModelFileKind, 'llm'>; // 'mmproj' | 'asr' | 'vad'
  magic: 'GGUF' | 'GGML'; // first 4 bytes: 'GGUF' / 6c 6d 67 67 ('lmgg', the legacy whisper.cpp ggml header)
}

/** B18 URLs not yet commit-pinned: the research pinned size + sha256 (LFS oid) but not the commit. The sha256 check makes the
 *  download content-addressed anyway; `scripts/pin-models.mjs` resolves these to `resolve/<commit>/` (V2-W2-04 runs it). */
export const UNPINNED_MEDIA_IDS: readonly MediaModelFileId[] = [
  'voice-hebrew',
  'voice-multilingual',
  'voice-lite',
  'voice-vad',
];

export const MEDIA_MODEL_MANIFEST: Readonly<Record<MediaModelFileId, MediaModelManifestEntry>> = {
  'mmproj-tiny': {
    tier: 'mmproj-tiny',
    label: 'gemma-4-E2B-it-mmproj-F16',
    fileName: 'mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/mmproj-F16.gguf',
    size: 985_654_080,
    sha256: '140be8d7849741f88c50757d529b84373ee8e27052cc2236855b537f4a8215fa',
    kind: 'mmproj',
    magic: 'GGUF',
  },
  'mmproj-small': {
    tier: 'mmproj-small',
    label: 'gemma-4-E4B-it-mmproj-F16',
    fileName: 'mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/mmproj-F16.gguf',
    size: 990_372_672,
    sha256: 'ddf46c21d7078e95338cfc22306b19b276a29a5ad089023449dd54d4b6170a51',
    kind: 'mmproj',
    magic: 'GGUF',
  },
  'mmproj-mid': {
    tier: 'mmproj-mid',
    label: 'gemma-4-12B-it-qat-mmproj-F16',
    fileName: 'mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/980b060c40a8539ac159e0501a3e0f66a6365af3/mmproj-F16.gguf',
    size: 175_115_840,
    sha256: 'ecc4e93128da8363b7dbf2193eab98cf1142353f52ceaa0c95c0872997aaadd3',
    kind: 'mmproj',
    magic: 'GGUF',
  },
  'voice-hebrew': {
    tier: 'voice-hebrew',
    label: 'ivrit-ai-whisper-large-v3-turbo-ggml',
    fileName: 'ggml-model.bin',
    url: 'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin',
    size: 1_624_555_275,
    sha256: 'c8090411113357097bfafc2b8e228ec1639fa7f5fe4ecb5d054ac0ccef8641b1',
    kind: 'asr',
    magic: 'GGML',
  },
  'voice-multilingual': {
    tier: 'voice-multilingual',
    label: 'ggml-large-v3-turbo-q8_0',
    fileName: 'ggml-large-v3-turbo-q8_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin',
    size: 874_188_075,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    kind: 'asr',
    magic: 'GGML',
  },
  'voice-lite': {
    tier: 'voice-lite',
    label: 'ggml-small-q8_0',
    fileName: 'ggml-small-q8_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin',
    size: 264_464_607,
    sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f',
    kind: 'asr',
    magic: 'GGML',
  },
  'voice-vad': {
    tier: 'voice-vad',
    label: 'ggml-silero-v6.2.0',
    fileName: 'ggml-silero-v6.2.0.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
    size: 885_098,
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    kind: 'vad',
    magic: 'GGML',
  },
};

/** The projector of each LLM tier (B19; ModelPlan.mmproj). */
export const MMPROJ_FOR_TIER: Readonly<Record<ModelTier, MediaModelFileId>> = {
  tiny: 'mmproj-tiny',
  small: 'mmproj-small',
  mid: 'mmproj-mid',
};

/** Local disk file name of a media entry. Two projectors share the upstream name `mmproj-F16.gguf`, so the local name is prefixed
 *  with the file id (the URL keeps the upstream name; nothing here is derived from outside input). */
export function mediaLocalFileName(id: MediaModelFileId): string {
  return `${id}-${MEDIA_MODEL_MANIFEST[id].fileName}`;
}

/** F24: the size string of the UI ("Download picture reading ({size})", "Download (1.6 GB)") - decimal GB with 2 significant decimals
 *  under 1 GB and 1 decimal above; MB below 0.1 GB. Rendered from the manifest entry, never a literal in a component. */
export function formatModelSize(entry: { size: number }): string {
  const gb = entry.size / 1e9;
  if (gb >= 1) return `${(Math.round(gb * 10) / 10).toFixed(1)} GB`;
  if (gb >= 0.1) return `${(Math.round(gb * 100) / 100).toFixed(2)} GB`;
  return `${Math.max(1, Math.round(entry.size / 1e6))} MB`;
}
