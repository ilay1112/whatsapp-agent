// scratch-only: mirrors the "renderer" project of vitest.config.ts but includes this folder.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': p('../../../src/shared'),
      '@': p('../../../src/renderer/src'),
      electron: p('../../../tests/mocks/electron.ts'),
    },
  },
  test: {
    name: 'scratch',
    environment: 'jsdom',
    setupFiles: [p('../../../tests/setup-renderer.ts')],
    include: ['ops/agent-notes/verify-ux-i18n-2.scratch/*.test.tsx'],
  },
});
