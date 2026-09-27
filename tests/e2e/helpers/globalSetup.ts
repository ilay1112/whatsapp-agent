// tests/e2e/helpers/globalSetup.ts - TESTS 2.2: refuse to drive anything but a freshly built `--mode e2e` bundle (owner W2-03).
// A production bundle constant-folds every seam away and would run against the user's REAL profile, so this is a hard gate.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_MARKER, MAIN_ENTRY, OUT_DIR } from './paths.ts';

/** Proof that the bundle was produced with `--mode e2e`: the seam master switch survives only in that mode (TESTS 4.1). */
const SEAM_PROOF = 'WCA_E2E';

function mainBundleHasSeamCode(): boolean {
  const mainDir = join(OUT_DIR, 'main');
  for (const name of readdirSync(mainDir)) {
    if (!name.endsWith('.js')) continue;
    if (readFileSync(join(mainDir, name), 'utf8').includes(SEAM_PROOF)) return true;
  }
  return false;
}

export default function globalSetup(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`E2E: ${MAIN_ENTRY} is missing - run \`npm run build:e2e\` first.`);
  }
  if (!existsSync(E2E_MARKER)) {
    throw new Error(
      `E2E: ${E2E_MARKER} is missing, so out/ holds a PRODUCTION bundle (every seam folded away). Run \`npm run build:e2e\`.`,
    );
  }
  if (statSync(E2E_MARKER).mtimeMs + 1_000 < statSync(MAIN_ENTRY).mtimeMs) {
    throw new Error('E2E: out/main/index.js is newer than the e2e marker - out/ was rebuilt. Run `npm run build:e2e`.');
  }
  if (!mainBundleHasSeamCode()) {
    throw new Error(`E2E: no file in out/main mentions ${SEAM_PROOF}; this is not an e2e-mode bundle.`);
  }
}
