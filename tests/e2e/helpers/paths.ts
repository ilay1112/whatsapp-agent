// tests/e2e/helpers/paths.ts - repo-relative locations every e2e helper needs (owner W2-03).
// The project path contains a space, so every path is derived with fileURLToPath, never URL.pathname (build-plan 1.1).
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** `C:\dev\whatsapp agent` - three levels up from tests/e2e/helpers. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/[\\/]$/, '');

export const OUT_DIR = join(REPO_ROOT, 'out');
/** The built e2e-mode main bundle Playwright drives (`electron.launch({ args: ['.'] })` resolves package.json `main`). */
export const MAIN_ENTRY = join(OUT_DIR, 'main', 'index.js');
/** Written by `scripts/mark-e2e-build.mjs`; `npm run build` (production) never writes it. */
export const E2E_MARKER = join(OUT_DIR, '.e2e-build');

export const TEST_RESULTS_DIR = join(REPO_ROOT, 'test-results');
/** TESTS 9: one screenshot per view per language for the user's Hebrew review (never pixel-compared). */
export const SCREENS_DIR = join(TEST_RESULTS_DIR, 'screens');

/** The three spawnable fakes, by absolute path (they are started with the system `node`, never a downloaded binary). */
export const FAKE_BRIDGE_TS = join(REPO_ROOT, 'tests', 'fakes', 'fake-bridge.ts');
export const FAKE_MCP_TS = join(REPO_ROOT, 'tests', 'fakes', 'fake-mcp-calendar.ts');
export const FAKE_LLAMA_TS = join(REPO_ROOT, 'tests', 'fakes', 'fake-llama-server.ts');
