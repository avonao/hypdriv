import { defineConfig } from 'vitest/config';

// Each package owns its own vitest.config.ts (Node or Workers runtime).
// The root config only aggregates them so `pnpm test` runs everything.
export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'packages/*/vitest.workers.config.ts'],
    reporters: process.env.CI ? ['default', 'github-actions'] : ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['**/*.test.*', '**/*.spec.*', '**/dist/**', '**/__fixtures__/**'],
    },
  },
});
