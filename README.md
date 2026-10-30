<p align="center">
  <strong>HypDriv</strong><br/>
  The Hyper-Extension for Next.js 16+ on Cloudflare Workers and Vercel.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/hypdriv"><img alt="npm" src="https://img.shields.io/npm/v/hypdriv?color=0f766e&label=hypdriv"></a>
  <a href="https://github.com/avonao/hypdriv/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/avonao/hypdriv/ci.yml?branch=main&label=ci"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-0f766e"></a>
  <img alt="Next.js 16+" src="https://img.shields.io/badge/Next.js-16%2B-000000">
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-f38020">
  <img alt="Vercel" src="https://img.shields.io/badge/Vercel-supported-000000">
</p>

HypDriv is a **sidecar** that attaches to a Next.js application through its public contracts — `next.config.ts`, the Adapter API, `proxy.ts`, the Worker entry and your application code — and makes it faster, safer and more observable. It works out of the box on **Cloudflare Workers** with [OpenNext](https://opennext.js.org/cloudflare) and on **Vercel**, needs **no infrastructure beyond the platform itself**, never patches Next.js, OpenNext or Vercel's builder, and treats platform services as optional upgrades it detects at runtime: Cloudflare bindings (KV, R2, D1, Durable Objects, Queues, Rate Limiting, Analytics Engine, Images) on Workers; the Vercel CDN, Upstash Redis, Global Config, the Vercel WAF, BotID and Vercel Queues on Vercel.

```sh
npm create hypdriv@latest my-app                       # new app on Cloudflare Workers (OpenNext)
npm create hypdriv@latest my-app -- --platform vercel  # new app on Vercel
# or, in an existing project
pnpm add hypdriv && npx hypdriv init
```

## What you get

| Area | HypDriv adds |
| --- | --- |
| **Speed** | Edge full-response cache with SWR, stale-if-error, tags, coalescing and normalised keys · Early Hints (103) per route · Speculation Rules per route · flashless themes pinned at the edge · Worker weight reports and budgets · skew protection assist · cache warming · Cloudflare image loader + placeholders · resilient `hypFetch` |
| **Security** | CSP autopilot (hash mode for static routes, nonce mode elsewhere, edge nonce injection for cached HTML, report-only rollout, collector + suggestions) · A+ security headers · rate limiting (fixed/sliding/token bucket; memory → Cache API → KV → Durable Object → Rate Limiting binding) · bot shield with Turnstile challenges · WAF-lite shield · `safeAction()` / `defineRoute()` with Standard Schema validation · encrypted sessions · JWT/JWKS · signed URLs & internal requests · webhook verification · password hashing · build-time secrets scan · SRI |
| **Observability** | Tracing (OTLP/HTTP, console, Analytics Engine) · structured logs with redaction · `Server-Timing` for every stage · Web Vitals with route/cache attribution · `onRequestError` hooks · an in-app DevTools HUD |
| **Cloudflare-native** | Worker shell around OpenNext with `scheduled`, `queue`, `email` and `tail` handlers dispatched to Route Handlers · geo & locale negotiation · live channels (Durable Objects + SSE/WebSocket, polling fallback) · edge feature flags · KV-managed redirects · maintenance mode · typed bindings in server code |
| **Vercel-native** | Edge-cache policies expressed as `Vercel-CDN-Cache-Control` + `Vercel-Cache-Tag` (route headers, `withVercelCdn`) with tag purge on Vercel's CDN · Upstash Redis for exact global rate limits · Global Config for flags, redirects and maintenance · Vercel WAF rate-limit rules · BotID guards for Server Actions · Vercel Cron with `CRON_SECRET` · Vercel Queues for `enqueue()` · Vercel geo headers |
| **Purser CSS** | In-process build/watch inside `withHypDriv` · unstyled-atom guard (a stale stylesheet fails the build) · atom usage reports · flashless themes · zero-override audits with headless Chrome |
| **Tooling** | `hypdriv init · doctor · analyze · routes · audit · budget · csp · css · warm · bench · deps · jobs · vitals · manifest`, all with `--json` and Cloudflare/Vercel awareness · signed audit tokens so audits pass your own bot shield · `create-hypdriv` · a testing kit · an agent skill |

The full list with baseline/upgrade behaviour per feature is in [`docs/feature-catalog.md`](docs/feature-catalog.md).

## How it attaches

```ts
// next.config.ts
import { withHypDriv } from 'hypdriv/config';
export default withHypDriv({ cacheComponents: true });
```

```ts
// hypdriv.worker.ts  (wrangler.jsonc → "main")
import { createWorker } from 'hypdriv/cloudflare';
import config from './hypdriv.config';
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { HypDrivChannel, HypDrivLimiter, HypDrivIndex } from 'hypdriv/durable-objects';
export default createWorker({
  config,
  next: () => import('./.open-next/worker.js'),
  manifest: () => import('./.hypdriv/manifest.js'),
});
```

On **Vercel** there is no Worker entry: `proxy.ts` runs the stages in Routing Middleware and wires `@hypdriv/vercel` automatically (Vercel CDN headers instead of the edge cache, Upstash / Global Config stores, Vercel purges, WAF rules), and `withHypDriv` emits the CDN route headers at build time. See the [Vercel guide](docs/guides/vercel.md).

```ts
// proxy.ts  (Vercel, next dev, next start, any Node host; passes through inside the Cloudflare Worker)
import { createProxy } from 'hypdriv/proxy';
import hypdrivConfig from './hypdriv.config';
export default createProxy(hypdrivConfig);   // passes through inside the Worker, which already ran the stages
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
}; // Next.js parses this statically, so it must be a literal
```

```ts
// hypdriv.config.ts
import { defineConfig } from 'hypdriv';
export default defineConfig({
  security: { csp: { allow: { scripts: ['https://js.stripe.com'] } }, rateLimit: [{ id: 'api', match: '/api/**', limit: 120, window: '1m' }] },
  cache: { edge: { policies: [{ match: '/blog/**', ttl: '10m', swr: '1d', tags: ['blog'] }] } },
  flags: { definitions: { newCheckout: { default: false, rules: [{ when: { country: ['US'] }, percentage: 25, value: true }] } } },
  jobs: { cron: { digest: { cron: '0 9 * * 1', path: '/api/jobs/digest' } } },
});
```

```tsx
// anywhere on the server
import { hyp, flag, safeAction, jobHandler } from 'hypdriv/server';
import { revalidateTag } from 'hypdriv/cache';      // Next revalidation + edge purge
```

At build time the chained adapter writes `.hypdriv/manifest.json` — routes, classifications (static / isr / shell / dynamic / route), per-route assets, CSP hashes, Early Hints, the link graph for Speculation Rules, Purser atom usage, weights and budgets. At request time the **Drivetrain** pipeline runs the same ordered stages in the Worker and in `proxy.ts`:

`request-id → maintenance → shield → bots → rate-limit → rate-limit-vercel → geo → i18n → flags → redirects → theme → speculation → csp → edge-cache → security-headers → early-hints → html-transforms → skew → devtools → observe`

Every stage reports a `Server-Timing` entry, so its effect is visible on every response (and in the HUD). `rate-limit-vercel` exists on Vercel only; `html-transforms` and edge nonce injection need the Worker's `HTMLRewriter`.

## Compatibility

Next.js 16.0 → 16.4+ (App Router first, Pages Router supported) · React 19.2+ · Node 20.9+ · `@opennextjs/cloudflare` 1.15+ · Vercel (legacy builder and the Next.js adapter, `NEXT_ENABLE_ADAPTER=1`) · Turbopack and webpack · TypeScript 5.9–7 in host apps · Purser CSS 0.1+. Deprecated Next features (`middleware.ts`, Edge runtime segments) are detected and reported by `hypdriv doctor`, not supported.

## Documentation

- [Architecture](docs/architecture.md) · [Feature catalog](docs/feature-catalog.md) · [Decision records](docs/adr/README.md) · [Package contracts](docs/contracts.md)
- Guides: [getting started](docs/guides/getting-started.md) · [configuration reference](docs/guides/configuration.md) · [Cloudflare](docs/guides/cloudflare.md) · [Vercel](docs/guides/vercel.md) · [caching](docs/guides/caching.md) · [security](docs/guides/security.md) · [observability](docs/guides/observability.md) · [Purser CSS](docs/guides/purser.md) · [flags](docs/guides/flags.md) · [live channels](docs/guides/live.md) · [jobs](docs/guides/jobs.md) · [CLI](docs/guides/cli.md)
- Examples: [`examples/basic`](examples/basic) and [`examples/with-purser`](examples/with-purser) on Cloudflare · [`examples/vercel`](examples/vercel) and [`examples/vercel-purser`](examples/vercel-purser) on Vercel
- For coding agents: [`AGENTS.md`](AGENTS.md) and [`skills/hypdriv`](skills/hypdriv/SKILL.md)

## Packages

| Package | Purpose |
| --- | --- |
| [`hypdriv`](packages/hypdriv) | Umbrella: everything below plus the CLI |
| [`@hypdriv/core`](packages/core) | Config schema, pipeline kernel, manifest, utilities |
| [`@hypdriv/next`](packages/next) | `withHypDriv`, adapter chain, proxy, stages, server/client helpers |
| [`@hypdriv/cloudflare`](packages/cloudflare) | Worker shell, handlers, Durable Objects, bindings |
| [`@hypdriv/vercel`](packages/vercel) | Vercel CDN headers and purge, Upstash / Global Config stores, WAF, BotID, Queues |
| [`@hypdriv/cache`](packages/cache) | Edge cache engine |
| [`@hypdriv/security`](packages/security) | CSP, headers, rate limiting, bots, actions, sessions, crypto |
| [`@hypdriv/observe`](packages/observe) | Tracing, logging, Server-Timing, Web Vitals |
| [`@hypdriv/purser`](packages/purser) | Purser CSS bridge |
| [`@hypdriv/flags`](packages/flags) · [`@hypdriv/live`](packages/live) · [`@hypdriv/image`](packages/image) · [`@hypdriv/devtools`](packages/devtools) · [`@hypdriv/testing`](packages/testing) | Flags, live channels, images, HUD, testing kit |
| [`@hypdriv/cli`](packages/cli) · [`create-hypdriv`](packages/create-hypdriv) | The `hypdriv` command and the scaffolder |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: [`SECURITY.md`](SECURITY.md). MIT licensed — see [`LICENSE`](LICENSE).
