// Scratch-only vitest config (throwaway): runs the verification test outside the project's include globs.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch',
    environment: 'node',
    root: p('../../../'),
    include: ['ops/agent-notes/verify-correctness-pipeline-2.scratch/verify.test.ts'],
    env: { TZ: 'UTC' },
  },
});
