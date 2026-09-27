// src/main/llm/local/manifest.ts - compile-time model manifest (ARCHITECTURE section 17; owner W1-07). Pinned 2026-09-21.
import type { ModelTier, Sha256Hex } from '../../../shared/types';

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
