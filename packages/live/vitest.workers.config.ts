import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs *.workers.test.ts inside workerd (Miniflare). Invoke with: pnpm vitest run -c vitest.workers.config.ts
// `main` is a tiny test Worker that exports the HypDrivChannel Durable Object and routes through the
// real live handler, so the tests exercise the same code path as `createWorker`.
export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  plugins: [
    cloudflareTest({
      main: './src/durable-object/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          HYPDRIV_CHANNEL: { className: 'HypDrivChannel', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    name: 'live-workers',
    include: ['src/**/*.workers.test.ts'],
  },
});
