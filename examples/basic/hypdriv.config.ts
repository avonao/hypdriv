import { defineConfig } from 'hypdriv';

export default defineConfig({
  site: { name: 'hypdriv-basic', origin: 'https://basic.hypdriv.dev' },
  security: {
    csp: { allow: { images: ['https://images.unsplash.com'] } },
    rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  cache: {
    edge: {
      policies: [{ id: 'blog', match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] }],
    },
  },
  performance: {
    earlyHints: true,
    speculation: { prerender: { eagerness: 'moderate', topN: 3 } },
  },
  observe: { tracing: { exporter: 'console' }, vitals: { sink: 'log' } },
  flags: {
    definitions: {
      newHero: { description: 'New landing hero', default: false, rules: [{ when: { country: ['US'] }, percentage: 50, value: true }] },
    },
  },
  jobs: {
    cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } },
  },
  budgets: { routes: { '/**': { js: '300kb' } }, worker: { gzip: '3mb' } },
});
