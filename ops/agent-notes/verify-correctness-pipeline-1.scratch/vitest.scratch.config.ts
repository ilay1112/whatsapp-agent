import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  root: p('../../../'),
  test: {
    name: 'verify-scratch',
    environment: 'node',
    setupFiles: ['tests/setup-guards.ts'],
    include: ['ops/agent-notes/verify-correctness-pipeline-1.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
    pool: 'forks',
    testTimeout: 20_000,
  },
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
});
