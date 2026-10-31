import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'hypdriv-tanstack-start' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
  observe: { vitals: { sink: 'log' } },
  // Cloudflare: the Worker shell's `scheduled` handler calls the job endpoint (src/routes/api/jobs/$job.ts) with a
  // signed request (set HYPDRIV_INTERNAL_SECRET); Vercel: Vercel Cron calls it with CRON_SECRET.
  jobs: { cron: { cleanup: { cron: '0 * * * *', path: '/api/jobs/cleanup' } } },
  flags: {
    definitions: {
      newHero: {
        description: 'New landing hero',
        default: false,
        rules: [{ when: { country: ['US'] }, value: true }],
      },
    },
  },
});
