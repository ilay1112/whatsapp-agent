// SCRATCH-only vitest config so the probe can run outside `npm test` includes. Not part of the product.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch-injection-2',
    environment: 'node',
    root: p('./'),
    include: ['verify.test.ts'],
    env: { TZ: 'UTC' },
  },
});
