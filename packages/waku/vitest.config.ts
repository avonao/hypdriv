import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'waku',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Real Waku builds of a fixture app run in `build.test.ts`.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
