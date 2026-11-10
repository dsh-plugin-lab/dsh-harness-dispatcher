import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Day-to-day test configuration (`pnpm test`).
 *
 * The projection fold, the harness-config normalizer and the feature extractor are pure functions,
 * so the default suite needs no host process. Anything that needs a live Host belongs in a
 * separate, explicitly-run suite rather than here — otherwise "green locally" silently starts to
 * mean "green only with a running Harness".
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    environment: 'node',
  },
})
