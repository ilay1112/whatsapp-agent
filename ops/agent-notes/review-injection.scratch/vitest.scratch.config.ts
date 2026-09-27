// SCRATCH config for the injection review - NOT part of `npm test`. Mirrors the `main` project of vitest.config.ts.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  test: {
    name: 'scratch',
    environment: 'node',
    include: ['ops/agent-notes/review-injection.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
  },
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
});
