import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Runs *.workers.test.ts inside workerd (Miniflare). Invoke with: pnpm vitest run -c vitest.workers.config.ts
export default defineConfig({
  resolve: { conditions: ['source'] },
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    name: 'live-workers',
    include: ['src/**/*.workers.test.ts'],
  },
});
