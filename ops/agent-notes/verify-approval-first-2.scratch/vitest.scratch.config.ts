// SCRATCH ONLY - adversarial review "approval-first". Not part of `npm test`, not under tests/.
// Run:  npx vitest run --config "ops/agent-notes/verify-approval-first-2.scratch/vitest.scratch.config.ts"
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
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
          name: 'scratch-main',
          environment: 'node',
          include: ['ops/agent-notes/verify-approval-first-2.scratch/**/*.node.test.ts'],
          env: { TZ: 'UTC' },
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '@shared': alias['@shared'], '@': p('../../../src/renderer/src') } },
        test: {
          name: 'scratch-renderer',
          environment: 'jsdom',
          setupFiles: ['tests/setup-renderer.ts'],
          include: ['ops/agent-notes/verify-approval-first-2.scratch/**/*.dom.test.tsx'],
        },
      },
    ],
  },
});
