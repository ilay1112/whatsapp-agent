// scratch config: mirrors the "main" project of the repo's vitest.config.ts, but includes only this scratch dir.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  test: {
    name: 'scratch-verify',
    environment: 'node',
    root: p('../../../'),
    include: ['ops/agent-notes/verify-correctness-pipeline-6.scratch/*.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      electron: p('../../../tests/mocks/electron.ts'),
      '@shared': p('../../../src/shared'),
    },
  },
});
