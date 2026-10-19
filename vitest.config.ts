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
    // Integration tests start PostgreSQL containers (Testcontainers): keep Docker responsive. With 6 workers, fresh
    // containers on Docker Desktop timed out on connect now and then (a different file each run).
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
