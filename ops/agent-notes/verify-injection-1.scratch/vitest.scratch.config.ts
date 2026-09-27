// Scratch-only vitest config for the injection-1 verification (never part of `npm test`).
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@shared': p('../../../src/shared') } },
  test: {
    name: 'scratch-injection-1',
    environment: 'node',
    include: [p('./slot.test.ts').replace(/\\/g, '/')],
    env: { TZ: 'UTC' },
  },
});
