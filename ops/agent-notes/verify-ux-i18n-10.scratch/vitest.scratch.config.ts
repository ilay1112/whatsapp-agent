// scratch-only vitest config for verifying review finding ux-i18n-10. Not part of `npm test`.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': p('../../../src/shared'), '@': p('../../../src/renderer/src') } },
  test: {
    name: 'scratch-renderer',
    environment: 'jsdom',
    setupFiles: [p('../../../tests/setup-renderer.ts')],
    include: ['ops/agent-notes/verify-ux-i18n-10.scratch/*.test.tsx'],
  },
});
