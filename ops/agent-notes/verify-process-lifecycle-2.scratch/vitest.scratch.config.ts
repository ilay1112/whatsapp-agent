import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: p('../../../'),
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch-pl2',
    environment: 'node',
    include: ['ops/agent-notes/verify-process-lifecycle-2.scratch/*.test.ts'],
    env: { TZ: 'UTC' },
  },
});
