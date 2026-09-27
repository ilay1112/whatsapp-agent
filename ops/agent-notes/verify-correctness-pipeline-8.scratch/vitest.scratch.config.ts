// Scratch-only vitest config for verifying review finding correctness-pipeline-8. NOT part of `npm test`.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root: p('../../../'),
  plugins: [react()],
  test: {
    name: 'verify8',
    environment: 'jsdom',
    include: ['ops/agent-notes/verify-correctness-pipeline-8.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
    pool: 'forks',
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      electron: p('../../../tests/mocks/electron.ts'),
      '@shared': p('../../../src/shared'),
      '@': p('../../../src/renderer/src'),
    },
  },
});
