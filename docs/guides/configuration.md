# Configuration reference — `hypdriv.config.ts`

> **Loading.** `hypdriv.config.ts` is read by Node's own ES module loader (native type stripping, Node 22.18+ or 24; 22.13+ through `stripTypeScriptTypes`), not by your bundler. Relative imports inside it therefore need the explicit extension (`import { shared } from './shared.ts'`; with `tsc` set `allowImportingTsExtensions`), and only erasable TypeScript syntax is allowed (no `enum`, no `namespace`, no parameter properties). An extensionless import fails with the file to write.

```ts
import { defineConfig } from 'hypdriv';

export default defineConfig({
  site: { name: 'acme-shop', origin: 'https://www.acme.com' },
  security: {
    csp: { allow: { scripts: ['https://js.stripe.com'], frames: ['https://js.stripe.com'] } },
    rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m' }],
    bots: { likelyAutomated: 'log', definitelyAutomated: 'block' },
  },
  cache: {
    edge: {
      policies: [
        { id: 'blog', match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] },
        { id: 'home', match: '/', ttl: '1m', swr: '1h', vary: { geo: ['country'] } },
      ],
    },
  },
  performance: { earlyHints: { preconnect: ['https://cdn.acme.com'] }, speculation: true },
  observe: { tracing: { exporter: 'otlp', otlp: { url: 'https://api.honeycomb.io/v1/traces', headersEnv: 'OTLP_HEADERS' } } },
  purser: { tokens: 'lib/tokens.ts', theme: { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light', clientHint: { hint: 'prefers-color-scheme', values: { dark: 'dark', light: 'light' } } } } } },
  flags: { definitions: { newCheckout: { default: false, rules: [{ when: { country: ['US'] }, percentage: 25, value: true }] } } },
  jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } },
  budgets: { routes: { '/**': { js: '250kb' } }, worker: { gzip: '2.5mb' } },
});
```

Every section is optional. Durations accept seconds or `'30s' | '5m' | '2h' | '1d' | '1w'`; sizes accept bytes or `'250kb' | '3mb'`. Route patterns accept `/exact`, `/blog/:slug`, `/docs/:path*`, `/files/*.pdf`, `/api/**`, `'/search\\?*q=*'` (query matching), regular expressions, or arrays. Validation happens in `defineConfig()` and at build time; invalid configuration fails fast with the offending path.

## `site`

| Key | Default | Purpose |
| --- | --- | --- |
| `name` | `'app'` | Service name in logs, traces and the HUD |
| `origin` | — | Canonical origin; `forceHttps: 'auto'` follows its scheme, HSTS preload advice, audits |
| `basePath`, `trailingSlash` | from the manifest | Overrides when the manifest is unavailable |

## `security`

### `csp`

| Key | Default | Notes |
| --- | --- | --- |
| `mode` | `'auto'` | `auto` = hash mode for fully static routes, nonce mode otherwise (ADR 0006) |
| `reportOnly` | `false` | `true` emits report-only; `'both'` emits enforced + stricter report-only |
| `directives` | strict preset | Merged over the preset |
| `allow.scripts/styles/images/fonts/connect/frames/media/workers/frameAncestors/formAction` | `[]` | Shorthands appended to the matching directives |
| `routes` | `[]` | Per-route overrides (`match`, `directives`, `mode`, `reportOnly`) |
| `strictDynamic` | `true` | `'strict-dynamic'` on script-src |
| `unsafeInlineStyles` | `true` | React/Next emit inline style attributes |
| `devUnsafeEval` | `true` | `'unsafe-eval'` in development only (HMR) |
| `reportTo` | `/_hypdriv/csp-report` | `false` disables reporting |
| `trustedTypes` | `false` | Roll out with report-only first |
| `upgradeInsecureRequests` | `true` (prod) | |
| `nonceHeader` | `x-nonce` | Request header carrying the nonce to the app |

### `headers`

HSTS (2 years, includeSubDomains), COOP `same-origin-allow-popups`, CORP `same-site`, COEP off, Referrer-Policy `strict-origin-when-cross-origin`, Permissions-Policy (deny-by-default list), X-Frame-Options `DENY`, nosniff, DNS prefetch `on`, Origin-Agent-Cluster, fingerprint stripping. Each can be set to `false`; `extra` adds headers; `routes` overrides per pattern.

### `rateLimit[]`

`{ id, match, methods?, limit, window, burst?, algorithm: 'fixed-window' | 'sliding-window' (default) | 'token-bucket', key: 'ip' | 'session' | 'user' | 'api-key' | 'path' | 'global' | [...], store: 'auto' | 'memory' | 'cache-api' | 'kv' | 'durable-object' | 'binding', response?, headers?: true, skip? }`. `store: 'binding'` requires 10 s or 60 s windows (Cloudflare Rate Limiting binding).

### `bots`, `shield`, `csrf`, `secretsScan`, `sri`, `sessions`, `internalAuth`, `trustedProxies`

See the [security guide](security.md) for behaviour; defaults are listed in `packages/core/src/config/resolve.ts`.

## `cache`

### `edge`

| Key | Default | Notes |
| --- | --- | --- |
| `policies[]` | `[]` | `{ id?, match, methods?, ttl, swr?, staleIfError?, tags?, vary?: { headers?, cookies?, geo?, flags?, experiments?: true, language?, device? }, bypass?, respectOrigin?: true, includeRsc?: true, statuses?, keyQuery? }` |
| `infer` | `true` | Infer policies for static routes from the manifest |
| `inferredStatic` | `{ ttl: '5m', swr: '1d', staleIfError: '7d' }` | |
| `bypass` | `{ cookies: [], headers: [], query: [] }` | Applied to every policy, inferred ones too: a request carrying one skips the cache. The cache answers before `middleware.ts`, so list what the middleware gates on (a site gate's cookie). See the [caching guide](caching.md) |
| `inferredShell` | `false` | Opt in to caching PPR shells |
| `store` | `'auto'` | tiered → Cache API → memory |
| `negativeTtl` | `'60s'` | 404/410 |
| `ignoredQuery` | tracking params | Removed from keys |
| `maxBodySize` | `'5mb'` | |
| `purge` | `{ zoneIdEnv: 'CACHE_PURGE_ZONE_ID', tokenEnv: 'CACHE_PURGE_API_TOKEN', index: 'auto' }` | |
| `emitTagHeaders`, `debugHeader` | `true` | `Cache-Tag`/`Surrogate-Key`, `x-hypdriv-cache` |

### `warm`

`{ routes: [], onDeploy: false, cron?: '…', concurrency: 4, hot?: true | { limit: 25, days: 7, minViews: 20, dataset?, datasetEnv: 'HYPDRIV_ANALYTICS_DATASET', accountIdEnv: 'HYPDRIV_ANALYTICS_ACCOUNT_ID', apiTokenEnv: 'HYPDRIV_ANALYTICS_API_TOKEN' } }`. `hot` adds the busiest cacheable pages, learned from Web Vitals in Analytics Engine ([Hot pages](caching.md#hot-pages)).

## `performance`

- `earlyHints`: `{ preconnect: [], fonts: true, styles: true, scripts: 'main', purser: true, maxLinks: 12, onRsc: false }`
- `speculation`: `{ prerender: { eagerness: 'moderate', include: ['/*'], exclude: [], topN: 5 }, prefetch: { eagerness: 'moderate' }, exclude: [defaults], useGraph: true, inject: 'auto' }`
- `priorityHints`: `false | { selectors: string[] }`
- `skewProtection`: `true | { deploymentId?, reloadOnMismatch: true }`
- `fetch`: `{ timeout: '10s', retries: 2, retryOn: [408, 425, 429, 500, 502, 503, 504], backoff: { baseMs: 100, maxMs: 2000, jitter: true }, circuitBreaker: { failureThreshold: 5, cooldown: '30s', halfOpenMax: 1 } }`
- `html`: `{ stripComments: false, collapseWhitespace: false }`

## `observe`

- `tracing`: `{ exporter: 'console' | 'otlp' | 'analytics-engine' | 'none', serviceName, sampleRate: 1, otlp: { url, headers?, headersEnv?, timeout: '5s' }, analyticsEngineBinding: 'HYPDRIV_ANALYTICS', propagate: true }`
- `logging`: `{ level: 'info', format: 'json', redact: [], sampleRate: 1, requests: true }`
- `serverTiming`: `true` (auto: verbose in dev, compact in prod) | `'compact'` | `'verbose'` | `false`
- `vitals`: `{ endpoint: '/_hypdriv/vitals', sampleRate: 1, sink: 'log' | 'analytics-engine' | 'none', attribution: true, dashboard?: true | { tokenEnv: 'HYPDRIV_DASH_TOKEN', accountIdEnv: 'HYPDRIV_ANALYTICS_ACCOUNT_ID', apiTokenEnv: 'HYPDRIV_ANALYTICS_API_TOKEN', dataset?, datasetEnv: 'HYPDRIV_ANALYTICS_DATASET', days: 7, cacheSeconds: 60, sessionMinutes: 480, memoryCapacity: 5000 } }` (the dashboard at `/_hypdriv/dash` is off by default; see the observability guide)
- `errors`: `{ sink: 'log' | 'otlp' | 'none', includeStack: true }`

## `purser`

`false` disables the bridge. Otherwise `{ enabled: 'auto', project: '.', src: ['app','components','lib'], tokens?, out: 'app/purser.css', prefix: 'x', salt: '', packageName: '@avonao/purser', cssModule?, layers: { tokens: 'purser.tokens', globals: 'purser.globals', atoms: 'purser.atoms' }, verify: 'error', usageReport: true, theme?: { cookie: 'hyp_theme', axes: { [name]: { cookie?, classes: Record<value, class | null>, default, clientHint? } }, fallbackScript: true, acceptClientHints: true }, audit: { widths: [360, 768, 1280], states: ['default','hover','focus'] }, earlyHints: true, checkInDoctor: true }`.

## `flags`

`{ definitions: { [name]: { description?, default, rules?: [{ when?: { country?, continent?, path?, cookie?, header?, device?, from?, until?, flag? }, percentage?, value }], experiment?: { variants: { [variant]: weight }, traffic?: 0–100, when?, salt?, status?: 'running' | 'paused' | 'concluded', winner?, expose?: [paths] }, serverOnly? } }, provider: 'static' | 'env' | 'kv' | 'openfeature', envVar: 'HYPDRIV_FLAGS', kvBinding: 'HYPDRIV_KV', kvKey: 'flags', idCookie: 'hyp_uid', experimentCookie: 'hyp_exp', exposures: 'auto' | 'log' | 'analytics-engine' | 'none', exposuresBinding: 'HYPDRIV_ANALYTICS', header: 'x-hypdriv-flags', queryOverrides: 'development', refresh: '30s' }`. An `experiment` block makes the flag an A/B test whose `default` is the control ([Experiments](flags.md#experiments-ab-tests)).

## `live`

`{ enabled: true, binding: 'HYPDRIV_CHANNEL', transport: 'auto', pollInterval: '5s', path: '/_hypdriv/live', maxSubscribers: 10000, retain: 50, authorize? }`.

## `images`

`{ loader: 'cloudflare', cdnCgi: 'auto', quality: 75, formats: ['auto'], placeholders: { enabled: true, file: '.hypdriv/placeholders.json', size: 16, sources: ['public'] }, allowedHosts: [] }`.

## `jobs`

`{ cron: { [name]: { cron, path, timeout: '25s', method: 'POST' } }, queues: { [queue]: { path, retry: 'failed', maxConcurrency: 4 } }, email?: { path }, basePath: '/api/jobs' }`. Cron expressions must also be declared in `wrangler.jsonc#triggers.crons`; `hypdriv init` and `hypdriv doctor --fix` keep them in sync.

## `budgets`

`{ routes: { '<pattern>': { js?, css?, html? } }, worker: { raw?, gzip?, startupMs? }, totalJs?, failOn: 'warn', snapshotDir: '.hypdriv/snapshots' }`.

## `cloudflare`

`{ bindings: { kv: 'HYPDRIV_KV', tagIndex: 'HYPDRIV_INDEX', limiter: 'HYPDRIV_LIMITER', channel: 'HYPDRIV_CHANNEL', rateLimit: 'HYPDRIV_RATE_LIMIT', analyticsEngine: 'HYPDRIV_ANALYTICS', images: 'IMAGES', assets: 'ASSETS', queues: {}, ai: 'AI' }, smartPlacement: false, runWorkerFirst: false, internalPathPrefix: '/_hypdriv', skipStaticAssets: true, health: true }`.

## `devtools`, `i18n`, `redirects`, `maintenance`, `stages`

- `devtools`: `{ enabled: 'development' | 'preview' | boolean, hotkey: 'Alt+Shift+H', position: 'bottom-right', endpoint: '/_hypdriv/dev' }`
- `i18n`: `{ locales, defaultLocale, strategy: 'prefix-except-default', cookie: 'hyp_locale', geoMap?, redirect?, header: 'x-hypdriv-locale' }`
- `redirects`: `{ rules: [{ from, to, status: 308, preserveQuery: true, host? }], kvBinding?, kvKey: 'redirects', cacheTtl: '60s', canonicalHost?, forceHttps: 'auto' }` (`auto`: on when `site.origin` is https; without an origin, on for Cloudflare and Vercel deployments — their edge terminates TLS for every hostname — and off on Node, which may be reached over plain HTTP on purpose; local hosts and development are always exempt)
- `maintenance`: `{ enabled: 'env', envVar: 'HYPDRIV_MAINTENANCE', kvBinding?, kvKey: 'maintenance', allowIps: [], bypassCookie?, bypassCookieValue?, bypassPaths: ['/_hypdriv/**', '/api/webhooks/**'], html?, retryAfter: '5m', status: 503 }`
- `stages`: `{ disable: [], order?: [] }` — stage names: `request-id, maintenance, shield, bots, rate-limit, geo, i18n, flags, redirects, theme, edge-cache, csp, security-headers, early-hints, speculation, html-transforms, skew, observe`
