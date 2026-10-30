import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs *.workers.test.ts inside workerd (Miniflare). Invoke with: pnpm vitest run -c vitest.workers.config.ts
// `main` is shaped like an application's hypdriv.worker.ts (createWorker + the Durable Object classes).
export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  plugins: [
    cloudflareTest({
      main: './src/__fixtures__/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          HYPDRIV_LIMITER: { className: 'HypDrivLimiter', useSQLite: true },
          HYPDRIV_INDEX: { className: 'HypDrivIndex', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    name: 'cloudflare-workers',
    include: ['src/**/*.workers.test.ts'],
  },
});
