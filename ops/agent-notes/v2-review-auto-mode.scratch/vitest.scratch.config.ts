// SCRATCH ONLY - adversarial review "auto-mode" (v2 phase 3). Not part of `npm test`, not under tests/.
// Run:  npx vitest run --config "ops/agent-notes/v2-review-auto-mode.scratch/vitest.scratch.config.ts"
// Every test here asserts the CORRECT behaviour; a red test is the proof of a finding in ../v2-review-auto-mode.md.
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
          name: 'scratch-auto-mode',
          environment: 'node',
          setupFiles: ['tests/setup-guards.ts'],
          include: ['ops/agent-notes/v2-review-auto-mode.scratch/**/*.node.test.ts'],
          env: { TZ: 'UTC' },
        },
      },
    ],
  },
});
