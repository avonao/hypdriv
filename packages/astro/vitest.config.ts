import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'astro',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Real Astro builds of a fixture app run in `build.test.ts`.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
