import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Stress-harness tests are slower (real concurrency/timing, real
    // AbortSignal.timeout waits) and belong to `pnpm test:stress`
    // (vitest.stress.config.ts) instead, so the default `pnpm test` stays fast.
    exclude: ['tests/stress/**'],
    reporters: ['default'],
    clearMocks: true,
  },
});
