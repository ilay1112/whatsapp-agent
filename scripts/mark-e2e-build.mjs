#!/usr/bin/env node
// scripts/mark-e2e-build.mjs - TESTS 14: `npm run build:e2e` = `electron-vite build --mode e2e && node scripts/mark-e2e-build.mjs`.
// Drops a marker file next to the e2e bundle so the Playwright fixtures can refuse to drive a PRODUCTION build (where the
// seam code of `src/main/testSeams.ts` has been constant-folded away). `npm run build` rewrites `out/` without the marker.
// Owner W0 -> W2-03.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(fileURLToPath(new URL('../', import.meta.url)), 'out');
export const MARKER_PATH = join(OUT_DIR, '.e2e-build');

mkdirSync(dirname(MARKER_PATH), { recursive: true });
writeFileSync(MARKER_PATH, `${new Date().toISOString()}\n`, 'utf8');
