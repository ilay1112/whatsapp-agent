// Scratch config for the editing-undo adversarial review (NOT part of npm test). Run from the project root:
//   npx vitest run --config "ops/agent-notes/v2-verify-editing-undo-7.scratch/vitest.scratch.config.ts"
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const alias = { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') };

export default defineConfig({
  root: p('../../..'),
  resolve: { alias },
  test: {
    name: 'verify-editing-undo-7',
    environment: 'node',
    setupFiles: [p('../../../tests/setup-guards.ts')],
    include: ['ops/agent-notes/v2-verify-editing-undo-7.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
    testTimeout: 20_000,
  },
});
