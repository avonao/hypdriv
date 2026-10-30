import { defineConfig } from 'vitest/config';

// Node project for pure logic; Workers project for files that need workerd APIs (Cache API, Durable Objects).
export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'testing',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.workers.test.ts'],
  },
});
