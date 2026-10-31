import { defineConfig } from '@hypdriv/core';

export default defineConfig({
  site: { name: 'hypdriv-sveltekit' },
  security: {
    rateLimit: [{ id: 'api', match: '/api/**', limit: 60, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  performance: { earlyHints: true },
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
