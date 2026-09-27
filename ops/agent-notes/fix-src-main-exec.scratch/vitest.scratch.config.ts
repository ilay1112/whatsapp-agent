// Scratch-only vitest config for the data-integrity-6 positive control. Not referenced by npm scripts.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url)); // the project path contains a space

export default defineConfig({
  resolve: {
    alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') },
  },
  test: {
    name: 'scratch-di6',
    environment: 'node',
    root: p('./'),
    include: ['atomicity-control.test.ts'],
    env: { TZ: 'UTC' },
  },
});
