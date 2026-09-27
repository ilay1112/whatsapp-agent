// Scratch-only vitest config for the ux-i18n adversarial review (NOT part of the product test run).
// Mirrors the `renderer` project of vitest.config.ts but includes only this scratch folder.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': p('../../../src/shared'), '@': p('../../../src/renderer/src') } },
  test: {
    name: 'scratch-ux-i18n',
    root: p('../../../'),
    environment: 'jsdom',
    setupFiles: ['tests/setup-renderer.ts'],
    include: ['ops/agent-notes/review-ux-i18n.scratch/**/*.test.tsx'],
  },
});
