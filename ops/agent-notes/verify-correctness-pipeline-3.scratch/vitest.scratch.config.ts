// Scratch-only vitest config for the adversarial review (lens correctness-pipeline).
// NOT part of `npm test`; lives outside tests/ on purpose.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: p('../../../'),
  test: {
    name: 'scratch',
    environment: 'node',
    setupFiles: ['tests/setup-guards.ts'],
    include: ['ops/agent-notes/verify-correctness-pipeline-3.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
    pool: 'forks',
    testTimeout: 20_000,
  },
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
});
