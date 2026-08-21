import { defineConfig } from 'vitest/config';

/**
 * The stress-testing harness's own test suite: `pnpm test:stress`.
 *
 * Deliberately separate from `vitest.config.ts` / `pnpm test` -- these tests
 * drive real concurrency and real `AbortSignal.timeout` waits (seconds, not
 * milliseconds), so they don't belong in the fast default suite. They are
 * still fully offline and deterministic (mock upstream, no real network).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/stress/**/*.test.ts'],
    reporters: ['default'],
    clearMocks: true,
    testTimeout: 20_000,
  },
});
