// scratch-only vitest config (mirrors the `security` project of vitest.config.ts) - verification of data-integrity-4.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const alias = { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') };

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  resolve: { alias },
  test: {
    name: 'scratch',
    environment: 'node',
    setupFiles: ['tests/setup-guards.ts'],
    include: ['ops/agent-notes/verify-data-integrity-4.scratch/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
  },
});
