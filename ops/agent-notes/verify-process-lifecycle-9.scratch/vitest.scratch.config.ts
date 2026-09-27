import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  test: {
    name: 'scratch',
    environment: 'node',
    include: ['ops/agent-notes/verify-process-lifecycle-9.scratch/*.test.ts'],
    root: p('../../../'),
    env: { TZ: 'UTC' },
  },
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
});
