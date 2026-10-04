// scripts/gen-golden-images.test.mjs - the golden pictures, their index and the media manifest (T2 7.1 / 7.2 item 4, T12; owner
// V2-W1-08-vision). Pure Node: this test NEVER renders (no Electron is started) - it verifies the committed bytes against the pins.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATOR,
  GOLDEN_IMAGES,
  GROUP_COUNTS,
  IMAGE_NOW_ISO,
  IMAGES_JSONL,
  MEDIA_MANIFEST,
  REPO_ROOT,
  absPathOf,
  buildHtml,
  expectedDateOf,
  expectedSlotOf,
  goldenCaseOf,
  imageReadOf,
  manifestOf,
  relPathOf,
  sha256Hex,
  verify,
} from './gen-golden-images.mjs';
import { ImageReadSchema } from '../src/shared/schemas.ts';
import { loadGoldenCases } from '../tests/helpers/goldenLoader.ts';

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?|ogg|opus|oga|wav|mp3|m4a|aac|flac|mp4|webm|mov)$/i;
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const manifest = JSON.parse(fs.readFileSync(MEDIA_MANIFEST, 'utf8'));
const cases = fs
  .readFileSync(IMAGES_JSONL, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));

describe('the 24 golden pictures (T2 7.1: 8 printed he, 6 printed en, 4 mixed screenshots, 2 script, 4 injection)', () => {
  it('has the exact split, unique ids and the three JPEG re-encodes', () => {
    expect(GOLDEN_IMAGES).toHaveLength(24);
    const counts = {};
    for (const s of GOLDEN_IMAGES) counts[s.group] = (counts[s.group] ?? 0) + 1;
    expect(counts).toEqual(GROUP_COUNTS);
    expect(new Set(GOLDEN_IMAGES.map((s) => s.id)).size).toBe(24);
    expect(GOLDEN_IMAGES.filter((s) => s.ext === 'jpg')).toHaveLength(3);
    expect(GOLDEN_IMAGES.filter((s) => s.read.suspicious).map((s) => s.group)).toEqual(Array(4).fill('injection'));
  });

  it('every file exists, sniffs as what its name says, and matches its pinned sha256 (never regenerated)', () => {
    expect(verify()).toEqual([]);
    for (const s of GOLDEN_IMAGES) {
      const b = fs.readFileSync(absPathOf(s));
      if (s.ext === 'png') expect([...b.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      else expect([...b.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(b.length).toBeLessThan(10 * 1024 * 1024); // under the getMedia cap
    }
  });

  it('every read is a valid ImageRead whose digits are consistent (the weekday word matches the date when written)', () => {
    for (const s of GOLDEN_IMAGES) {
      expect(ImageReadSchema.safeParse(imageReadOf(s)).success).toBe(true);
      const date = expectedDateOf(s);
      expect(date >= IMAGE_NOW_ISO.slice(0, 10)).toBe(true);
      if (s.read.weekday !== 7) expect(new Date(`${date}T12:00:00Z`).getUTCDay()).toBe(s.read.weekday);
      const slot = expectedSlotOf(s);
      expect(slot.endLocal > slot.startLocal).toBe(true);
    }
  });

  it('the templates load nothing: no script, no URL, a CSP that forbids every fetch', () => {
    for (const s of GOLDEN_IMAGES) {
      const html = buildHtml(s);
      expect(html).not.toMatch(/<script|<img|<link|<iframe|url\(|https?:|file:/i);
      expect(html).toContain("default-src 'none'");
    }
    expect(() => buildHtml({ ...GOLDEN_IMAGES[0], style: 'nope' })).toThrow();
  });

  it('T12: synthetic only - no phone number, no JID, no e-mail in any visible line', () => {
    for (const s of GOLDEN_IMAGES) {
      const text = [...s.lines, s.small ?? '', s.caption].join('\n');
      expect(text).not.toMatch(/\+?\d{3}[- ]?\d{3}[- ]?\d{4}|@s\.whatsapp\.net|@lid|[\w.]+@[\w.]+\.\w+/);
    }
  });
});

describe('images.jsonl (the golden cases of the pictures)', () => {
  it('is exactly goldenCaseOf() of every spec, in order', () => {
    expect(cases).toEqual(GOLDEN_IMAGES.map((s, i) => goldenCaseOf(s, i)));
  });

  it('passes the shared golden loader (T5 JIDs, stub satisfies expect.extraction) with the 24 ids', () => {
    const loaded = loadGoldenCases('images');
    expect(loaded.map((c) => c.id)).toEqual(GOLDEN_IMAGES.map((s) => s.id));
    for (const c of loaded) {
      expect(c.media).toEqual({
        kind: 'image',
        file: expect.stringMatching(/^tests\/golden\/images\/img-[a-z]+-\d{2}\.(png|jpg)$/),
      });
      expect(fs.existsSync(path.join(REPO_ROOT, ...c.media.file.split('/')))).toBe(true);
      expect(c.provider).toEqual(['local', 'claude_cli']); // antigravity_cli => Local by design (T2 7.2 item 2)
      expect(c.stub.rules.map((r) => r.when.purpose)).toEqual(['extract', 'read_image', 'draft']);
    }
  });

  it('every injection case expects suspicious + manipulation; every case carries the F29 amber image_unclear', () => {
    for (const c of cases) {
      expect(c.expect.badges).toContain('image_unclear');
      expect(c.expect.badges).toContain('from_image');
      expect(c.expect.badges.includes('manipulation')).toBe(c.injection === true);
      expect(c.expect.imageRead.suspicious).toBe(c.injection === true);
    }
    expect(cases.filter((c) => c.injection)).toHaveLength(4);
  });
});

describe('MEDIA_MANIFEST.json (T12: every media file under tests/ is listed with its generator and sha256)', () => {
  it('covers every media file under tests/, and nothing it lists is missing or changed', () => {
    const root = path.join(REPO_ROOT, 'tests');
    const media = walk(root)
      .filter((p) => MEDIA_EXT.test(p))
      .map((p) => path.relative(REPO_ROOT, p).split(path.sep).join('/'))
      .sort();
    const listed = manifest.files.map((f) => f.path).sort();
    expect(media).toEqual(listed);
    for (const f of manifest.files) {
      const bytes = fs.readFileSync(path.join(REPO_ROOT, ...f.path.split('/')));
      expect(sha256Hex(bytes)).toBe(f.sha256);
      expect(bytes.length).toBe(f.bytes);
      expect(f.synthetic).toBe(true);
      expect(typeof f.generator).toBe('string');
    }
  });

  it('is manifestOf() of the pictures (one entry each, the generator named)', () => {
    const entries = GOLDEN_IMAGES.map((s) => {
      const b = fs.readFileSync(absPathOf(s));
      return { path: relPathOf(s), sha256: sha256Hex(b), bytes: b.length };
    });
    expect(manifest).toEqual(manifestOf(entries));
    expect(manifest.files.every((f) => f.generator === GENERATOR)).toBe(true);
  });

  it('the script path constants point inside the repo', () => {
    expect(fileURLToPath(new URL('..', import.meta.url))).toContain(path.basename(REPO_ROOT));
  });
});
