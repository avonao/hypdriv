import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs *.workers.test.ts inside workerd (Miniflare). Invoke with: pnpm vitest run -c vitest.workers.config.ts
export default defineConfig({
  resolve: { conditions: ['source'] },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    name: 'testing-workers',
    include: ['src/**/*.workers.test.ts'],
  },
});
