import { defineConfig } from 'hypdriv';

export default defineConfig({
  // `auto` detects Vercel from VERCEL=1 (builds and functions) and from vercel.json; explicit here for clarity.
  platform: 'vercel',
  site: { name: 'hypdriv-vercel', origin: 'https://vercel-example.hypdriv.dev' },
  security: {
    csp: { allow: { images: ['https://images.unsplash.com'] } },
    rateLimit: [
      // Exact global counters in Upstash Redis when KV_REST_API_URL/TOKEN are set, per-instance memory otherwise.
      { id: 'api', match: '/api/**', limit: 120, window: '1m', key: ['ip'] },
      { id: 'contact', match: '/contact', methods: ['POST'], limit: 5, window: '10m', key: ['ip'] },
    ],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  cache: {
    edge: {
      policies: [
        // Expressed as Vercel-CDN-Cache-Control + Vercel-Cache-Tag route headers by withHypDriv.
        {
          id: 'products',
          match: '/products/:id',
          ttl: '5m',
          swr: '1h',
          respectOrigin: false,
          tags: ['catalog'],
        },
        // Route Handler wrapped with withVercelCdn (app/api/products/route.ts).
        { id: 'products-api', match: '/api/products', ttl: '1m', swr: '10m', tags: ['catalog'] },
      ],
    },
  },
  performance: {
    earlyHints: true,
    speculation: { prerender: { eagerness: 'moderate', topN: 3 } },
  },
  observe: { vitals: { sink: 'log' } },
  flags: {
    definitions: {
      newHero: {
        description: 'New landing hero',
        default: false,
        rules: [{ when: { country: ['US'] }, percentage: 50, value: true }],
      },
    },
  },
  jobs: {
    cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } },
    queues: { emails: { path: '/api/queues/emails' } },
  },
  vercel: {
    // HypDriv queue name → Vercel Queues topic (vercel.json triggers the consumer route).
    queues: { emails: 'transactional-email' },
  },
});
