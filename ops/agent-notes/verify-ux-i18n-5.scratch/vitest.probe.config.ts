// Scratch-only vitest config: the renderer project of the repo's vitest.config.ts, with `include` pointed at this dir.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url)); // project path contains a space: never use URL.pathname
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: { '@shared': `${root}src/shared`, '@': `${root}src/renderer/src` },
  },
  test: {
    name: 'probe',
    environment: 'jsdom',
    setupFiles: [`${root}tests/setup-renderer.ts`],
    include: ['ops/agent-notes/verify-ux-i18n-5.scratch/probe.test.tsx'],
  },
});
