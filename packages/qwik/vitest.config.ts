import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'qwik',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Real Qwik builds of a fixture app run in `build.test.ts`.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
