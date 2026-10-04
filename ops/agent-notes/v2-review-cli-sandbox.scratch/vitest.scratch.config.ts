// Scratch-only vitest config for the cli-sandbox review. NOT part of `npm test`.
// Run: npx vitest run --config "ops/agent-notes/v2-review-cli-sandbox.scratch/vitest.scratch.config.ts"
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch-cli-sandbox',
    environment: 'node',
    root: p('../../../'),
    include: ['ops/agent-notes/v2-review-cli-sandbox.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 30_000,
  },
});
