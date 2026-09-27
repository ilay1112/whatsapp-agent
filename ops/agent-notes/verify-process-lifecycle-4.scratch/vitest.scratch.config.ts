// Scratch-only vitest config for the process-lifecycle review. NOT part of `npm test`.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch',
    environment: 'node',
    root: p('../../../'),
    include: ['ops/agent-notes/verify-process-lifecycle-4.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 20_000,
  },
});
