import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': p('../../../src/shared'), '@': p('../../../src/renderer/src') } },
  test: {
    environment: 'jsdom',
    setupFiles: [p('../../../tests/setup-renderer.ts')],
    include: ['ops/agent-notes/verify-ux-i18n-4.scratch/boot-dead-end.test.tsx'],
    root: p('../../../'),
  },
});
