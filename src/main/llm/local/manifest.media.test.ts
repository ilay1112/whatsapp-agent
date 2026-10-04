// src/main/llm/local/manifest.media.test.ts - owner V2-W1-07-media-voice. C2 13 "Manifests (F19)": MODEL_MANIFEST stays LLM-only; the
// three projectors and four voice files live in MEDIA_MODEL_MANIFEST with kind + magic; B18/B19 sizes; F24 size strings; C2 19 item 17.
import { describe, expect, it } from 'vitest';
import { MMPROJ_IDS, MODEL_FILE_IDS, MODEL_TIERS, VOICE_TIERS, modelFileKindOf } from '../../../shared/types';
import { isAllowedDownloadUrl } from './download';
import {
  formatModelSize,
  MEDIA_MODEL_MANIFEST,
  mediaLocalFileName,
  MMPROJ_FOR_TIER,
  MODEL_MANIFEST,
  UNPINNED_MEDIA_IDS,
  type MediaModelFileId,
} from './manifest';

const ids = Object.keys(MEDIA_MODEL_MANIFEST) as MediaModelFileId[];

describe('MEDIA_MODEL_MANIFEST', () => {
  it('the union of both tables is exactly MODEL_FILE_IDS (C2 19 item 17); MODEL_MANIFEST is untouched', () => {
    expect([...Object.keys(MODEL_MANIFEST), ...ids].sort()).toEqual([...MODEL_FILE_IDS].sort());
    expect(Object.keys(MODEL_MANIFEST).sort()).toEqual([...MODEL_TIERS].sort());
    for (const id of ids) expect(MEDIA_MODEL_MANIFEST[id].tier).toBe(id);
  });

  it('kind and magic per entry: projectors GGUF, voice GGML; kinds agree with modelFileKindOf', () => {
    for (const id of ids) expect(MEDIA_MODEL_MANIFEST[id].kind).toBe(modelFileKindOf(id));
    for (const id of MMPROJ_IDS) expect(MEDIA_MODEL_MANIFEST[id].magic).toBe('GGUF');
    for (const id of [...VOICE_TIERS, 'voice-vad'] as const) expect(MEDIA_MODEL_MANIFEST[id].magic).toBe('GGML');
  });

  it('B18 / B19 sizes and the pinned VAD sha256', () => {
    expect(MEDIA_MODEL_MANIFEST['voice-hebrew'].size).toBe(1_624_555_275);
    expect(MEDIA_MODEL_MANIFEST['voice-multilingual'].size).toBe(874_188_075);
    expect(MEDIA_MODEL_MANIFEST['voice-lite'].size).toBe(264_464_607);
    expect(MEDIA_MODEL_MANIFEST['voice-vad'].size).toBe(885_098);
    expect(MEDIA_MODEL_MANIFEST['voice-vad'].sha256).toBe(
      '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    );
    expect(MEDIA_MODEL_MANIFEST['mmproj-tiny'].size).toBe(985_654_080);
    expect(MEDIA_MODEL_MANIFEST['mmproj-small'].size).toBe(990_372_672);
    expect(MEDIA_MODEL_MANIFEST['mmproj-mid'].size).toBe(175_115_840);
    for (const id of ids) expect(MEDIA_MODEL_MANIFEST[id].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('projectors are pinned at the v1 commits of their LLM tier; exactly three mmproj entries exist', () => {
    for (const tier of MODEL_TIERS) {
      const commit = /\/resolve\/([0-9a-f]{40})\//.exec(MODEL_MANIFEST[tier].url)?.[1];
      const pj = MEDIA_MODEL_MANIFEST[MMPROJ_FOR_TIER[tier]];
      expect(pj.url).toBe(MODEL_MANIFEST[tier].url.replace(MODEL_MANIFEST[tier].fileName, 'mmproj-F16.gguf'));
      expect(pj.url).toContain(`/resolve/${String(commit)}/`);
    }
    expect(ids.filter((id) => /mmproj-/.test(MEDIA_MODEL_MANIFEST[id].fileName))).toEqual([
      'mmproj-tiny',
      'mmproj-small',
      'mmproj-mid',
    ]);
  });

  it('every URL is https on the allow-list and ends in its file; no executable extension; voice URLs await pin-models', () => {
    for (const id of ids) {
      const e = MEDIA_MODEL_MANIFEST[id];
      expect(isAllowedDownloadUrl(e.url)).toBe(true);
      expect(e.url.endsWith(`/${e.fileName}`)).toBe(true);
      expect(e.fileName).not.toMatch(/\.(exe|dll|ps1|bat|cmd|msi|com|scr)$/i);
      if (UNPINNED_MEDIA_IDS.includes(id)) expect(e.url).toContain('/resolve/main/');
      else expect(e.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    }
    expect(new Set(ids.map(mediaLocalFileName)).size).toBe(ids.length);
  });

  it('formatModelSize (F24): 0.99 GB for tiny/small projectors, 0.18 GB for mid, 1.6 GB for the Hebrew voice model', () => {
    expect(formatModelSize(MEDIA_MODEL_MANIFEST['mmproj-tiny'])).toBe('0.99 GB');
    expect(formatModelSize(MEDIA_MODEL_MANIFEST['mmproj-small'])).toBe('0.99 GB');
    expect(formatModelSize(MEDIA_MODEL_MANIFEST['mmproj-mid'])).toBe('0.18 GB');
    expect(formatModelSize(MEDIA_MODEL_MANIFEST['voice-hebrew'])).toBe('1.6 GB');
    expect(formatModelSize(MEDIA_MODEL_MANIFEST['voice-vad'])).toBe('1 MB');
    expect(formatModelSize({ size: 50_000_000 })).toBe('50 MB');
  });
});
