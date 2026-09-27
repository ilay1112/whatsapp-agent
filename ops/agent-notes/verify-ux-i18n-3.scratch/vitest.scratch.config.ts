// Scratch-only config: mirrors the `renderer` project of vitest.config.ts but includes this scratch dir.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': p('../../../src/shared'), '@': p('../../../src/renderer/src') } },
  test: {
    root: p('../../../'),
    name: 'scratch-renderer',
    environment: 'jsdom',
    setupFiles: ['tests/setup-renderer.ts'],
    include: ['ops/agent-notes/verify-ux-i18n-3.scratch/*.test.tsx'],
  },
});
