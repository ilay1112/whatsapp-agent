// scratch config for verifying correctness-pipeline-7 (read-only experiment; no project file touched)
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    root: p('../../../'),
    name: 'scratch',
    environment: 'node',
    include: ['ops/agent-notes/verify-correctness-pipeline-7.scratch/*.test.ts'],
    env: { TZ: 'UTC' },
  },
});
