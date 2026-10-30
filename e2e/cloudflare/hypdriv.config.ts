import { defineConfig } from 'hypdriv';

/**
 * Every HypDriv capability switched on, each backed by the binding that upgrades it, so the live suite
 * (`scripts/e2e.ts`) can verify them against a real Cloudflare account. Queue names are matched with
 * wildcards: each account names its queues (`<prefix>-e2e-jobs`, `<prefix>-e2e-jobs-dlq`).
 */
export default defineConfig({
  site: { name: 'hypdriv-e2e' },
  security: {
    csp: { reportOnly: false },
    sessions: { secretEnv: 'HYPDRIV_SESSION_SECRET', ttl: '1h' },
    csrf: { match: ['/form/**'] },
    rateLimit: [
      { id: 'exact', match: '/api/limited', limit: 5, window: '1m', key: ['ip'], store: 'durable-object' },
      { id: 'edge', match: '/api/limited-binding', limit: 120, window: '1m', key: ['ip'], store: 'binding' },
    ],
    bots: {
      likelyAutomated: 'challenge',
      definitelyAutomated: 'block',
      exempt: ['/api/**', '/_hypdriv/**'],
      turnstile: { siteKeyEnv: 'TURNSTILE_SITE_KEY', secretEnv: 'TURNSTILE_SECRET_KEY', action: 'e2e' },
    },
  },
  cache: {
    edge: {
      policies: [
        { id: 'static', match: '/', ttl: '1h', swr: '1d' },
        { id: 'tagged', match: '/tagged', ttl: '1h', swr: '1d', tags: ['e2e-tagged'] },
        { id: 'isr', match: '/isr', ttl: '10m', swr: '1d' },
        // A dynamic page (it reads the request) cached per country: the policy overrides Next's no-store.
        { id: 'geo', match: '/geo-cached', ttl: '10m', vary: { geo: ['country'] }, respectOrigin: false },
      ],
    },
  },
  performance: {
    earlyHints: true,
    speculation: { prerender: { eagerness: 'moderate', topN: 2 } },
    fetch: { timeout: '5s', retries: 2 },
  },
  observe: {
    tracing: { exporter: 'analytics-engine', sampleRate: 1 },
    vitals: { sink: 'analytics-engine', sampleRate: 1 },
    logging: { level: 'info' },
  },
  flags: {
    provider: 'kv',
    kvBinding: 'HYPDRIV_KV',
    kvKey: 'flags',
    refresh: '5s',
    definitions: {
      e2eBanner: { description: 'Shows the banner (overridden from KV by the suite)', default: false },
    },
  },
  live: { enabled: true, transport: 'auto' },
  redirects: {
    rules: [{ from: '/old-home', to: '/', status: 308 }],
    kvBinding: 'HYPDRIV_KV',
    kvKey: 'redirects',
    cacheTtl: '5s',
    forceHttps: true,
  },
  maintenance: {
    // Off unless the MAINTENANCE variable or the `maintenance` KV key switches it on (no redeploy).
    kvBinding: 'HYPDRIV_KV',
    kvKey: 'maintenance',
    bypassPaths: ['/api/**', '/_hypdriv/**'],
    retryAfter: '2m',
  },
  jobs: {
    cron: { tick: { cron: '* * * * *', path: '/api/jobs/tick' } },
    queues: {
      jobs: { path: '/api/jobs/work', queues: ['*-e2e-jobs'] },
      'jobs-dead': { path: '/api/jobs/dead', queues: ['*-e2e-jobs-dlq'], retry: 'none' },
    },
    email: { path: '/api/jobs/email' },
  },
  cloudflare: { bindings: { queues: { jobs: 'E2E_JOBS' } } },
  budgets: { routes: { '/**': { js: '300kb' } }, worker: { gzip: '3mb' } },
});
