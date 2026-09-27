import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  test: {
    name: 'scratch',
    environment: 'node',
    root: p('../../..'),
    include: ['ops/agent-notes/review-data-integrity.scratch/*.test.ts'],
    env: { TZ: 'UTC' },
  },
  resolve: { alias: { '@shared': p('../../../src/shared') } },
});
