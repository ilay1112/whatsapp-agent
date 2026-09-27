// SCRATCH ONLY - verification of review finding approval-first-3. Not part of `npm test`, not under tests/.
// Run: npx vitest run --config "ops/agent-notes/verify-approval-first-3.scratch/vitest.scratch.config.ts"
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url)); // project path contains a space
const alias = { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') };

export default defineConfig({
  root: p('../../../'),
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'verify-main',
          environment: 'node',
          include: ['ops/agent-notes/verify-approval-first-3.scratch/**/*.node.test.ts'],
          env: { TZ: 'UTC' },
        },
      },
    ],
  },
});
