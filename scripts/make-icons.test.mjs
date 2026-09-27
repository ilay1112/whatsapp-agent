// TESTS 5.3 row `scripts/*.mjs`: the icon generator is pure code (no network, no binary source asset) and writes the exact
// file list electron-builder.yml and app/tray.ts expect.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_SIZES,
  COLORS,
  crc32,
  drawGlyph,
  main,
  renderGlyphPng,
  TRAY_SIZES,
  TRAY_SVG,
  VARIANTS,
} from './make-icons.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('PNG encoding', () => {
  it('crc32 matches the known IEND vector', () => {
    expect(crc32(Buffer.from('IEND', 'ascii')).toString(16)).toBe('ae426082');
  });

  it.each(TRAY_SIZES)('renders a valid %s px PNG with IHDR/IDAT/IEND', (size) => {
    const png = renderGlyphPng(size);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(png.readUInt32BE(16)).toBe(size); // IHDR width
    expect(png.readUInt32BE(20)).toBe(size); // IHDR height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    expect(png.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });

  it('is deterministic - the same inputs give byte-identical output', () => {
    expect(renderGlyphPng(32, 'tray-paused')).toEqual(renderGlyphPng(32, 'tray-paused'));
  });
});

describe('the glyph', () => {
  const pixel = (canvas, x, y) => {
    const i = (y * canvas.size + x) * 4;
    return [canvas.data[i], canvas.data[i + 1], canvas.data[i + 2], canvas.data[i + 3]];
  };

  it('draws the accent header over a light body with an outline', () => {
    const c = drawGlyph(32);
    expect(pixel(c, 16, 8)).toEqual(COLORS.header); // header band
    expect(pixel(c, 16, 26)).toEqual(COLORS.body); // body
    expect(pixel(c, 4, 4)).toEqual(COLORS.outline); // frame
    expect(pixel(c, 0, 0)[3]).toBe(0); // transparent margin
  });

  it.each(VARIANTS)('%s differs in SHAPE, not only in colour', (variant) => {
    const base = renderGlyphPng(32, 'tray');
    const png = renderGlyphPng(32, variant);
    if (variant === 'tray') expect(png).toEqual(base);
    else expect(png).not.toEqual(base);
  });

  it('every variant carries its own mark colour', () => {
    expect(drawGlyph(32, 'tray-attention').data).toContain(COLORS.attention[0]);
    expect(drawGlyph(32, 'tray-error').data).toContain(COLORS.error[0]);
    expect(drawGlyph(32, 'tray-paused').data).toContain(COLORS.paused[0]);
  });

  it('renders at 16 px without collapsing (the smallest tray size still has all three bands)', () => {
    const c = drawGlyph(16);
    const colours = new Set();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) colours.add(pixel(c, x, y).join(','));
    expect(colours.size).toBeGreaterThanOrEqual(4); // transparent + outline + header + body (+ ink)
  });
});

describe('TRAY_SVG', () => {
  it('is a self-contained inline SVG with no script and no external reference', () => {
    expect(TRAY_SVG.startsWith('<svg')).toBe(true);
    expect(TRAY_SVG.endsWith('</svg>')).toBe(true);
    expect(TRAY_SVG).toContain('viewBox="0 0 16 16"');
    expect(TRAY_SVG).not.toMatch(/<script|href=|url\(|onload/i);
  });
});

describe('main()', () => {
  it('writes exactly the files electron-builder.yml and app/tray.ts expect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wca-icons-'));
    const iconsDir = join(root, 'icons');
    const buildDir = join(root, 'build');
    // png-to-ico is exercised for real by the repository run; the unit test injects a container stub so it stays fast.
    const toIco = async (pngs) => Buffer.concat([Buffer.from('ICO'), Buffer.from(String(pngs.length)), ...pngs]);
    const written = await main({ iconsDir, buildDir, toIco });

    expect((await readdir(iconsDir)).sort()).toEqual([
      'notification.png',
      'tray-attention.ico',
      'tray-error.ico',
      'tray-paused.ico',
      'tray.ico',
      'tray.svg',
    ]);
    expect(await readdir(buildDir)).toEqual(['icon.ico']);
    expect(written).toHaveLength(VARIANTS.length + 3);

    const tray = await readFile(join(iconsDir, 'tray.ico'));
    expect(tray.subarray(0, 3).toString()).toBe('ICO');
    expect(tray.subarray(3, 4).toString()).toBe(String(TRAY_SIZES.length));
    const appIcon = await readFile(join(buildDir, 'icon.ico'));
    expect(appIcon.subarray(3, 4).toString()).toBe(String(APP_SIZES.length));
    expect((await readFile(join(iconsDir, 'notification.png'))).subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(await readFile(join(iconsDir, 'tray.svg'), 'utf8')).toContain('<svg');
  });

  it('the app icon contains the 256 px entry electron-builder requires', () => {
    expect(APP_SIZES).toContain(256);
    expect(TRAY_SIZES).toEqual([16, 20, 24, 32, 48]);
  });

  it('the generator never spawns, downloads or reads a binary source asset', async () => {
    const source = await readFile(new URL('./make-icons.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/child_process|spawn\(|exec\(|fetch\(/);
    expect(source).not.toMatch(/readFile\(/);
    // The only URL in the file is the SVG namespace, which is never dereferenced.
    const urls = source.match(/https?:\/\/[^\s"')]+/g) ?? [];
    expect(urls).toEqual(['http://www.w3.org/2000/svg']);
  });
});
