// Scratch config for the data-integrity-v4 review (NOT part of npm test). Run:
//   npx vitest run --config ops/agent-notes/v2-review-data-integrity-v4.scratch/vitest.scratch.config.ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const alias = { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') };
export default defineConfig({
  resolve: { alias },
  test: {
    name: 'scratch-di-v4',
    environment: 'node',
    root: p('../../..'),
    setupFiles: ['tests/setup-guards.ts'],
    include: ['ops/agent-notes/v2-review-data-integrity-v4.scratch/*.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 20_000,
  },
});
