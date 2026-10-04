// SCRATCH config for the v2 injection review (lens injection-v2) - NOT part of `npm test`. Mirrors the `main` project of vitest.config.ts.
// Run: npx vitest run --config "ops/agent-notes/v2-verify-injection-v2-1.scratch/vitest.scratch.config.ts"
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export default defineConfig({
  test: {
    name: 'scratch-verify-injection-v2-1',
    environment: 'node',
    include: ['ops/agent-notes/v2-verify-injection-v2-1.scratch/**/*.test.ts'],
    env: { TZ: 'UTC' },
  },
  resolve: { alias: { electron: p('../../../tests/mocks/electron.ts'), '@shared': p('../../../src/shared') } },
});
