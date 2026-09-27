// vitest.config.ts - exactly docs/specs/test-strategy.md 2.1 with the thresholds of section 13 filled in (W0).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url)); // project path contains a space: never use URL.pathname
const alias = { electron: p('./tests/mocks/electron.ts'), '@shared': p('./src/shared') };

const SAFETY_CRITICAL = [
  'src/main/exec/**',
  'src/main/agent/toolGate.ts',
  'src/main/agent/sanitize.ts',
  'src/main/agent/minimize.ts',
  'src/main/agent/prompt.ts',
  'src/main/agent/toolDefs.ts',
  'src/main/agent/stage0.ts',
  'src/main/agent/validate.ts',
  'src/main/bridge/invariants.ts',
  'src/main/bridge/doorbell.ts',
  'src/main/bridge/sendClient.ts',
  'src/main/mcp/writeClient.ts',
  'src/main/mcp/projection.ts',
  'src/main/ipc/sender.ts',
  'src/main/ipc/handlers/actions.ts',
  'src/main/llm/factory.ts',
  'src/main/llm/consent.ts',
  'src/main/logger.ts',
  'src/shared/state.ts',
  'src/shared/when.ts',
  'src/shared/schemas.ts',
];
const safetyThresholds = Object.fromEntries(
  SAFETY_CRITICAL.map((g) => [g, { lines: 100, branches: 95, functions: 100, perFile: true }]),
);

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          setupFiles: ['tests/setup-guards.ts'],
          include: [
            'src/main/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'scripts/**/*.test.mjs',
          ],
          env: { TZ: 'UTC' },
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '@shared': alias['@shared'], '@': p('./src/renderer/src') } },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['tests/setup-renderer.ts'],
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          setupFiles: ['tests/setup-guards.ts', 'tests/helpers/ledger-hook.ts'],
          include: ['tests/integration/**/*.test.ts', 'tests/golden/golden.test.ts'],
          testTimeout: 20_000,
          pool: 'forks',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'security',
          environment: 'node',
          setupFiles: ['tests/setup-guards.ts', 'tests/helpers/ledger-hook.ts'],
          include: ['tests/security/**/*.test.ts'],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'golden-live',
          environment: 'node',
          include: ['tests/golden/golden.live.test.ts'],
          testTimeout: 600_000,
        },
      }, // NEVER part of `npm test` (see scripts)
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      exclude: [
        '**/*.test.*',
        // Test-support modules that live next to the code they double (build-plan section 6 naming rule), e.g.
        // src/main/ipc/register.fixtures.ts. Requested by W1-13; the `v8 ignore` pair in that file can now go.
        '**/*.fixtures.*',
        // The same rule for the directory form: src/main/db/__fixtures__/testDb.ts is a test-support module too, and
        // `**/*.fixtures.*` does not match a `__fixtures__/` directory (repair-test-fakes side observation).
        '**/__fixtures__/**',
        'src/shared/locales/**',
        'src/renderer/src/env.d.ts',
        'src/main/index.ts',
        'src/main/app/**',
        'src/main/testSeams.ts',
      ],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        ...safetyThresholds,
        'src/main/bridge/**': { lines: 90, branches: 85, functions: 90 },
        'src/main/mcp/**': { lines: 90, branches: 85, functions: 90 },
        'src/main/db/**': { lines: 90, branches: 85, functions: 90 },
        'src/main/proc/**': { lines: 90, branches: 85, functions: 90 },
        'src/main/agent/**': { lines: 90, branches: 85, functions: 90 },
        'src/main/llm/**': { lines: 90, branches: 85, functions: 90 },
        'src/renderer/**': { lines: 75, branches: 70, functions: 75 },
        'src/preload/**': { lines: 100, functions: 100 },
      },
    },
  },
});
