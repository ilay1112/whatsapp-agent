// Scratch-only vitest config for the v2 ux-i18n adversarial review (NOT part of the product test run).
// Mirrors the `renderer` project of vitest.config.ts but includes only this scratch folder.
// Run: npx vitest run --config "ops/agent-notes/v2-review-ux-i18n-v2.scratch/vitest.scratch.config.ts"
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': p('../../../src/shared'), '@': p('../../../src/renderer/src') } },
  test: {
    name: 'scratch-v2-ux-i18n',
    root: p('../../../'),
    environment: 'jsdom',
    setupFiles: ['tests/setup-renderer.ts'],
    include: ['ops/agent-notes/v2-review-ux-i18n-v2.scratch/**/*.test.tsx'],
  },
});
