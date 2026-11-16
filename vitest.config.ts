import { defineConfig } from 'vitest/config';

/** Root Vitest config: workspace packages resolve to their sources through the `@kosh/source` condition. */
export default defineConfig({
  resolve: { conditions: ['@kosh/source'] },
  ssr: { resolve: { conditions: ['@kosh/source'] } },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'modules/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    passWithNoTests: false,
    // One PostgreSQL server for the run; each integration test file creates a database of its own on it
    // (RFC 0034 step 1, `testDatabase()`). `KOSH_TEST_DATABASE_URL` points the run at an existing server instead.
    globalSetup: ['packages/server/test/support/postgres.global.ts'],
    maxWorkers: 4,
    testTimeout: 30_000,
    // A failed test runs once more; one that passes then is reported as flaky and counted (RFC 0034 step 1).
    retry: 1,
    reporters: ['default', './scripts/flaky-reporter.ts'],
  },
});
