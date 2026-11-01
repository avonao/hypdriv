import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'hypdriv-qwik' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
  // Route loader data (`<page>/q-loader-<id>.<hash>.json`) is application data that looks like a file: on Cloudflare
  // the Worker runs the pipeline for it as well as for pages (Qwik's content-hashed files never reach the Worker).
  cloudflare: { skipStaticAssets: false },
  observe: { vitals: { sink: 'log' } },
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
