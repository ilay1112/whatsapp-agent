// Scratch-only vitest config for verifying review finding ux-i18n-8. Not part of `npm test`.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': p('../../../src/shared'), '@': p('../../../src/renderer/src') } },
  test: {
    root: p('../../../'),
    environment: 'jsdom',
    setupFiles: ['tests/setup-renderer.ts'],
    include: ['ops/agent-notes/verify-ux-i18n-8.scratch/*.test.tsx'],
  },
});
