// playwright.config.ts - docs/specs/test-strategy.md 2.2 (W0 -> W2-03). `_electron` only: no browsers are ever downloaded.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  testDir: p('./tests/e2e'),
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'test-results',
  // Asserts out/main/index.js exists and was produced by `npm run build:e2e` (marker out/.e2e-build) - never a production bundle.
  globalSetup: p('./tests/e2e/helpers/globalSetup.ts'),
});
