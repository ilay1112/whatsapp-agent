// SCRATCH ONLY - runs the single repro file; the project's own vitest.config.ts is untouched.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: p('../../../'),
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch-pl5',
    environment: 'node',
    include: ['ops/agent-notes/verify-process-lifecycle-5.scratch/repro.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 20_000,
  },
});
