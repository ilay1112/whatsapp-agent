#!/usr/bin/env node
// scripts/make-icons.mjs - owner W1-12-shell-main.
//
// Generates the whole icon set from code: no binary asset is checked in as a source, nothing is downloaded and nothing is
// executed. PNGs are encoded in-process (node:zlib + a minimal PNG writer); `.ico` containers come from the pinned dev
// dependency `png-to-ico`.
//
//   resources/icons/tray.ico            neutral date tab
//   resources/icons/tray-attention.ico  date tab + dot        (open items exist)
//   resources/icons/tray-paused.ico     date tab + pause bars
//   resources/icons/tray-error.ico      date tab + exclamation
//   resources/icons/notification.png    64 px toast icon
//   resources/icons/tray.svg            the same glyph as an SVG string (W1-14 / W1-16 inline it)
//   build/icon.ico                      installer / window icon (16 ... 256)
//
// The glyph is the signature object of UX 6.4: a small calendar "date tab" - a filled header band over a lighter body with
// two ticks. Shapes differ per variant (not only colours) and every size carries a 1 px contrasting outline so the icon
// reads on light and dark Windows taskbars (electron-stack 5.7).
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';

export const OWNER = 'W1-12-shell-main';

/** UX 2.1 tokens used by the icon set (opaque RGBA). */
export const COLORS = {
  outline: [12, 17, 24, 255],
  header: [37, 99, 235, 255], // accent
  body: [246, 248, 252, 255], // surface
  ink: [37, 47, 62, 255], // text on the body
  attention: [217, 119, 6, 255], // amber dot
  error: [190, 38, 38, 255], // red exclamation
  paused: [90, 102, 120, 255], // grey pause bars
};

export const TRAY_SIZES = [16, 20, 24, 32, 48];
export const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
export const VARIANTS = ['tray', 'tray-attention', 'tray-paused', 'tray-error'];

// ---------------------------------------------------------------------------------------------------------------------
// tiny RGBA canvas
// ---------------------------------------------------------------------------------------------------------------------
class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Uint8Array(size * size * 4); // transparent
  }
  set(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    if (a === 255) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = 255;
      return;
    }
    const src = a / 255;
    const dst = this.data[i + 3] / 255;
    const out = src + dst * (1 - src);
    this.data[i] = Math.round((r * src + this.data[i] * dst * (1 - src)) / out);
    this.data[i + 1] = Math.round((g * src + this.data[i + 1] * dst * (1 - src)) / out);
    this.data[i + 2] = Math.round((b * src + this.data[i + 2] * dst * (1 - src)) / out);
    this.data[i + 3] = Math.round(out * 255);
  }
  rect(x, y, w, h, color) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, color);
  }
  /** 1 px frame around a rectangle. */
  frame(x, y, w, h, color) {
    this.rect(x, y, w, 1, color);
    this.rect(x, y + h - 1, w, 1, color);
    this.rect(x, y, 1, h, color);
    this.rect(x + w - 1, y, 1, h, color);
  }
  disc(cx, cy, r, color) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) this.set(x, y, color);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// minimal PNG encoder (RGBA, 8 bit, no interlace)
// ---------------------------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** Encodes an RGBA canvas as a PNG buffer. */
export function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(data.subarray(y * size * 4, (y + 1) * size * 4)).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// the glyph
// ---------------------------------------------------------------------------------------------------------------------
/** Draws the date tab (and its variant mark) at any size. Returns the canvas. */
export function drawGlyph(size, variant = 'tray') {
  const c = new Canvas(size);
  const u = size / 16; // design grid: 16 x 16
  const px = (n) => Math.max(1, Math.round(n * u));
  const x = px(2);
  const y = px(2);
  const w = size - px(2) * 2;
  const h = size - px(2) * 2;
  const headerH = Math.max(1, Math.round(h * 0.32));

  c.rect(x, y, w, h, COLORS.body);
  c.rect(x, y, w, headerH, COLORS.header);
  c.frame(x, y, w, h, COLORS.outline);

  // two hanger ticks above the header
  const tick = Math.max(1, Math.round(u));
  c.rect(x + px(3), Math.max(0, y - tick), tick, tick, COLORS.outline);
  c.rect(x + w - px(3) - tick, Math.max(0, y - tick), tick, tick, COLORS.outline);

  // The "day number" bar inside the body, so the tab reads as a date even at 16 px. A variant keeps it short so its mark
  // sits in free space instead of on top of the bar.
  const barY = y + headerH + Math.max(1, Math.round(h * 0.16));
  const barH = Math.max(1, Math.round(h * 0.2));
  const fullBarW = w - px(6);
  c.rect(x + px(3), barY, variant === 'tray' ? fullBarW : Math.max(2, Math.round(fullBarW * 0.5)), barH, COLORS.ink);

  // Variant marks live in the free bottom-inline-end corner of the body.
  const markCx = x + w - px(3);
  const markCy = y + h - px(3);
  if (variant === 'tray-attention') {
    c.disc(markCx, markCy, Math.max(1.5, u * 2.2), COLORS.attention);
  } else if (variant === 'tray-paused') {
    const barW = Math.max(1, Math.round(u * 1.4));
    const pauseH = Math.max(3, Math.round(h * 0.3));
    const top = Math.round(markCy - pauseH / 2);
    c.rect(Math.round(markCx - barW * 2), top, barW, pauseH, COLORS.paused);
    c.rect(Math.round(markCx), top, barW, pauseH, COLORS.paused);
  } else if (variant === 'tray-error') {
    const barW = Math.max(1, Math.round(u * 1.4));
    const stemH = Math.max(3, Math.round(h * 0.22));
    const top = Math.round(markCy - (stemH + barW * 2) / 2);
    c.rect(Math.round(markCx - barW / 2), top, barW, stemH, COLORS.error);
    c.rect(Math.round(markCx - barW / 2), top + stemH + barW, barW, barW, COLORS.error);
  }
  return c;
}

/** PNG buffer for one variant at one size. */
export function renderGlyphPng(size, variant = 'tray') {
  return encodePng(drawGlyph(size, variant));
}

const rgb = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** The same glyph as an inline SVG string (UX 12.2 coach mark + the tray explanation of the onboarding wizard). */
export const TRAY_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-hidden="true">',
  `<rect x="2" y="2" width="12" height="12" rx="1.5" fill="${rgb(COLORS.body)}" stroke="${rgb(COLORS.outline)}" stroke-width="1"/>`,
  `<path d="M2.6 3.5a1 1 0 0 1 1-1h8.8a1 1 0 0 1 1 1V6H2.6Z" fill="${rgb(COLORS.header)}"/>`,
  `<rect x="5" y="1" width="1.4" height="2" rx="0.5" fill="${rgb(COLORS.outline)}"/>`,
  `<rect x="9.6" y="1" width="1.4" height="2" rx="0.5" fill="${rgb(COLORS.outline)}"/>`,
  `<rect x="4.5" y="8" width="7" height="2.6" rx="0.6" fill="${rgb(COLORS.ink)}"/>`,
  '</svg>',
].join('');

// ---------------------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..');

/** Writes the whole set. `toIco` is injected so the unit test does not depend on png-to-ico's output format. */
export async function main({
  iconsDir = join(REPO_ROOT, 'resources', 'icons'),
  buildDir = join(REPO_ROOT, 'build'),
  toIco = pngToIco,
  log = () => {},
} = {}) {
  await mkdir(iconsDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  const written = [];

  for (const variant of VARIANTS) {
    const pngs = TRAY_SIZES.map((size) => renderGlyphPng(size, variant));
    const file = join(iconsDir, `${variant}.ico`);
    await writeFile(file, await toIco(pngs));
    written.push(file);
    log(`wrote ${file} (${TRAY_SIZES.join('/')} px)`);
  }

  const notification = join(iconsDir, 'notification.png');
  await writeFile(notification, renderGlyphPng(64, 'tray'));
  written.push(notification);

  const svg = join(iconsDir, 'tray.svg');
  await writeFile(svg, `${TRAY_SVG}\n`, 'utf8');
  written.push(svg);

  const appIcon = join(buildDir, 'icon.ico');
  await writeFile(appIcon, await toIco(APP_SIZES.map((size) => renderGlyphPng(size, 'tray'))));
  written.push(appIcon);
  log(`wrote ${appIcon} (${APP_SIZES.join('/')} px)`);

  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main({ log: (line) => process.stdout.write(`make-icons: ${line}\n`) }).catch((err) => {
    process.stderr.write(`make-icons: failed (${err?.code ?? 'error'})\n`);
    process.exit(1);
  });
}
