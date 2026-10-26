import { defineConfig } from 'vitest/config';

/** Benchmarks (`pnpm bench`): long-running budget checks on seeded data, kept out of `pnpm test`. */
export default defineConfig({
  resolve: { conditions: ['@kosh/source'] },
  ssr: { resolve: { conditions: ['@kosh/source'] } },
  test: {
    include: ['packages/*/bench/**/*.bench.test.ts', 'apps/*/bench/**/*.bench.test.ts'],
    passWithNoTests: false,
    maxWorkers: 1,
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
