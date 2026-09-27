// src/main/llm/local/manifest.test.ts - the compile-time manifest must equal ARCHITECTURE section 17 byte-for-byte (owner W1-07).
import { describe, expect, it } from 'vitest';
import { MODEL_TIERS } from '../../../shared/types';
import { DOWNLOAD_HOST_ALLOWLIST, MODEL_MANIFEST } from './manifest';

/** Transcribed from docs/ARCHITECTURE.md section 17 (pinned 2026-09-21). Any drift here is a spec violation, not a test bug. */
const ARCH_17 = {
  tiny: {
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf',
    size: 3_106_738_272,
    sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
  },
  small: {
    url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf',
    size: 4_977_171_584,
    sha256: '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87',
  },
  mid: {
    url: 'https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/980b060c40a8539ac159e0501a3e0f66a6365af3/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf',
    size: 6_716_356_800,
    sha256: '90fd44e29e0d7cffeb0fd00dc73cfdab9ed0b0e95306ecf7821ea634c940c370',
  },
} as const;

describe('MODEL_MANIFEST', () => {
  it('has exactly one entry per tier, keyed by its own tier', () => {
    expect(Object.keys(MODEL_MANIFEST).sort()).toEqual([...MODEL_TIERS].sort());
    for (const tier of MODEL_TIERS) expect(MODEL_MANIFEST[tier].tier).toBe(tier);
  });

  it.each(MODEL_TIERS)('%s equals ARCHITECTURE section 17 (url, size, sha256)', (tier) => {
    expect(MODEL_MANIFEST[tier].url).toBe(ARCH_17[tier].url);
    expect(MODEL_MANIFEST[tier].size).toBe(ARCH_17[tier].size);
    expect(MODEL_MANIFEST[tier].sha256).toBe(ARCH_17[tier].sha256);
  });

  it('pins a 40-hex commit in every URL (never `main`)', () => {
    for (const tier of MODEL_TIERS) expect(MODEL_MANIFEST[tier].url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
  });

  it('downloads only .gguf files and never a multimodal / draft companion', () => {
    for (const tier of MODEL_TIERS) {
      const entry = MODEL_MANIFEST[tier];
      expect(entry.fileName.endsWith('.gguf')).toBe(true);
      expect(entry.fileName).not.toMatch(/mmproj-|mtp-/);
      expect(entry.url.endsWith(entry.fileName)).toBe(true);
      // nothing with an executable extension can ever be a download target
      expect(entry.fileName).not.toMatch(/\.(exe|dll|ps1|bat|cmd|msi|com|scr)$/i);
    }
  });

  it('labels are technical file labels, never a path', () => {
    for (const tier of MODEL_TIERS) {
      expect(MODEL_MANIFEST[tier].label).not.toMatch(/[\\/]/);
      expect(MODEL_MANIFEST[tier].label.length).toBeGreaterThan(0);
    }
  });

  it('the host allow-list is the suffix rule of ARCHITECTURE section 9', () => {
    expect(DOWNLOAD_HOST_ALLOWLIST.exact).toEqual(['huggingface.co']);
    expect([...DOWNLOAD_HOST_ALLOWLIST.suffix]).toEqual(['.hf.co', '.huggingface.co']);
  });
});
