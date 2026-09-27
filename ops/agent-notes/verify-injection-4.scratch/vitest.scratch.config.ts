// SCRATCH config for verifying injection-4 - NOT part of `npm test`.
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  test: {
    name: 'scratch-inj4',
    environment: 'node',
    include: ['ops/agent-notes/verify-injection-4.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
  },
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
});
