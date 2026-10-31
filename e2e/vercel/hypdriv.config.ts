import { defineConfig } from 'hypdriv';

/**
 * Every HypDriv capability that applies on Vercel switched on, each backed by the platform service that
 * upgrades it (Vercel CDN, Global Config, Vercel Queues, Vercel WAF, BotID, Vercel Cron), so the live suite
 * (`scripts/e2e.ts`) can verify them against a real Vercel project. Queue topics are project-scoped on
 * Vercel, so the names below need no account prefix.
 */
export default defineConfig({
  platform: 'vercel',
  site: { name: 'hypdriv-e2e-vercel' },
  security: {
    csp: { reportOnly: false },
    sessions: { secretEnv: 'HYPDRIV_SESSION_SECRET', ttl: '1h' },
    csrf: { match: ['/form/**'] },
    rateLimit: [
      // `auto`: exact global counters in Upstash Redis when KV_REST_API_* exist, per instance otherwise.
      { id: 'exact', match: '/api/limited', limit: 5, window: '1m', key: ['ip'] },
      // Enforced by the Vercel WAF rule `hypdriv-e2e-waf` (vercel.firewall.rateLimitRules).
      { id: 'waf', match: '/api/limited-waf', limit: 5, window: '1m', key: ['ip'] },
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
        // Prerendered pages: Vercel's CDN caches them natively (respectOrigin, the default, keeps the page's own
        // Cache-Control in charge); HypDriv reports them as `x-hypdriv-cache: CDN`.
        { id: 'static', match: '/', ttl: '1h', swr: '1d' },
        { id: 'tagged', match: '/tagged', ttl: '1h', swr: '1d', tags: ['e2e-tagged'] },
        // Cached per country (Vary: X-Vercel-IP-Country): withVercelCdn on Route Handlers; a page with `vary`
        // stays dynamic on Vercel (the function's own Vary replaces route-level ones) and is reported at build.
        {
          id: 'geo',
          match: ['/geo-cached', '/api/geo-cached'],
          ttl: '10m',
          vary: { geo: ['country'] },
          respectOrigin: false,
        },
        // A Route Handler wrapped with withVercelCdn (app/api/cdn/route.ts).
        { id: 'cdn-api', match: '/api/cdn', ttl: '10m', swr: '1h', tags: ['e2e-cdn'] },
      ],
    },
  },
  performance: {
    earlyHints: true,
    speculation: { prerender: { eagerness: 'moderate', topN: 2 } },
    fetch: { timeout: '5s', retries: 2 },
  },
  observe: {
    // Spans and vitals go to the function logs (Vercel runtime logs / log drains).
    tracing: { exporter: 'console', sampleRate: 1 },
    vitals: { sink: 'log', sampleRate: 1 },
    logging: { level: 'info' },
  },
  flags: {
    provider: 'kv',
    kvBinding: 'HYPDRIV_KV',
    kvKey: 'flags',
    refresh: '5s',
    definitions: {
      e2eBanner: {
        description: 'Shows the banner (overridden from Global Config by the suite)',
        default: false,
      },
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
    // Off unless the MAINTENANCE variable or the `maintenance` Global Config item switches it on.
    kvBinding: 'HYPDRIV_KV',
    kvKey: 'maintenance',
    bypassPaths: ['/api/**', '/_hypdriv/**'],
    retryAfter: '2m',
  },
  jobs: {
    // Hobby runs cron jobs once a day; the suite also calls the route with CRON_SECRET like Vercel Cron does.
    cron: { tick: { cron: '17 7 * * *', path: '/api/jobs/tick' } },
    queues: {
      jobs: { path: '/api/jobs/work' },
      'jobs-once': { path: '/api/jobs/once', retry: 'none' },
    },
  },
  vercel: {
    queues: { jobs: 'hypdriv-e2e-jobs', 'jobs-once': 'hypdriv-e2e-jobs-once' },
    firewall: { rateLimitRules: { waf: 'hypdriv-e2e-waf' } },
    botId: { checkLevel: 'basic' },
  },
  budgets: { routes: { '/**': { js: '300kb' } } },
});
