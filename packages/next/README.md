# @hypdriv/next

HypDriv for Next.js 16+: the `withHypDriv()` config wrapper, the chained build adapter, the `proxy.ts` runner, the Drivetrain stage factories and the server/client helpers your application code uses.

Most applications install the umbrella package (`pnpm add hypdriv`) and run `npx hypdriv init`; this package is what `hypdriv/next` re-exports.

## Entry points

| Import | Use it in | What it gives you |
| --- | --- | --- |
| `@hypdriv/next/config` | `next.config.ts` | `withHypDriv(nextConfig, options?)`, `PHASE`, `resolveAdapterPath()`, `defaultDeploymentId()` |
| `@hypdriv/next/adapter` | set automatically | the Next.js Adapter that chains your existing adapter (OpenNext) and writes `.hypdriv/manifest.json` |
| `@hypdriv/next/proxy` | `proxy.ts` | `createProxy(config, stages?, options?)`, `matcher` |
| `@hypdriv/next/stages` | custom pipelines, the Worker shell | `createPlatform()`, `buildDefaultStages()`, `stages.*` factories, `createConfiguredTracer()` |
| `@hypdriv/next/server` | Server Components, Route Handlers, Server Actions | `hyp()`, `nonce()`, `geo()`, `flag()`, `defer()`, `jobHandler()`, `safeAction()`, `defineRoute()`, `<Speculation/>`, `<HypDrivMeta/>` |
| `@hypdriv/next/client` | Client Components | `<VitalsReporter/>`, `<HypDrivDevTools/>`, `FlagsProvider`/`useFlag`, `useLive`/`useLiveValue`/`useLiveRefresh` |
| `@hypdriv/next/cache` | mutations | `revalidateTag()`, `revalidatePath()` (Next revalidation + edge purge), `purgeEdge()` |
| `@hypdriv/next/instrumentation` | `instrumentation.ts` | `createInstrumentation()` → `{ register, onRequestError }` |

## `withHypDriv`

```ts
// next.config.ts
import { withHypDriv } from '@hypdriv/next/config';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

initOpenNextCloudflareForDev();
export default withHypDriv({ cacheComponents: true });
```

`withHypDriv` returns an async config function. For every phase it:

- loads `hypdriv.config.*` (TypeScript configs load through Node's type stripping, with a `stripTypeScriptTypes` fallback) and validates it;
- installs the HypDriv adapter as `adapterPath`, chaining any adapter you already had (`adapterPath`, `NEXT_ADAPTER_PATH` or `options.adapter`);
- applies safe defaults: `poweredByHeader: false`, `reactStrictMode`, Subresource Integrity (`experimental.sri`) when enabled, a `deploymentId` for skew protection (from `HYPDRIV_DEPLOYMENT_ID`, the CI commit SHA or git `HEAD`), and the Cloudflare image loader with its settings inlined as `env.HYPDRIV_IMAGES`;
- runs Purser CSS when configured: a full build before `next build` (build errors fail the build) and one shared watcher per `next dev` process that also writes `.hypdriv/dev/purser.json` for the HUD.

## The adapter

During `next build` the adapter receives Next's `onBuildComplete` outputs and derives `.hypdriv/manifest.json` (plus `manifest.js` for bundlers and a human-readable `report.md`):

- route classification — `static`, `isr` (prerendered with `revalidate`), `shell` (Partial Prerendering), `dynamic`, `route`, `asset`;
- per-route assets and gzip weights, Early Hints `Link` values, the internal link graph for Speculation Rules;
- CSP hashes of every inline script/style in immutable static documents (plus the Purser theme script hash);
- the Purser unstyled-atom guard over every prerendered document and RSC payload, with the emitted stylesheet asset;
- a secrets scan of client assets, budgets, and warnings such as a deprecated `middleware.ts`.

Failures (exceeded budgets with `failOn: 'error'`, Purser atoms missing from the stylesheet, credentials in client bundles) fail the build.

## `proxy.ts`

```ts
import { createProxy } from '@hypdriv/next/proxy';
import hypdrivConfig from './hypdriv.config';

export default createProxy(hypdrivConfig);
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|js|map|txt|xml|json)$).*)',
    '/_hypdriv/:path*',
  ],
}; // Next.js parses this statically, so it must be a literal
```

Next.js only accepts a literal `config` export in `proxy.ts`; the exported `matcher` constant documents the recommended value. Inside the HypDriv Worker (OpenNext bundles `proxy.ts` into it) the proxy detects the Worker's request context and passes requests through, so stages never run twice; client-supplied `x-hypdriv-*` and nonce headers are removed before the stages run.

The proxy runs the same ordered stages as the Worker on Node (`next dev`, `next start`, any Node host); edge-only stages (HTML rewriting, cached-HTML nonce injection) are skipped. Pass a function to customise the list: `createProxy(config, (defaults, platform) => [...defaults, myStage])`.

## Server helpers

```tsx
import { hyp, flag, nonce, defer, jobHandler, safeAction } from '@hypdriv/next/server';

export default async function Page() {
  const { country, locale, flags, theme, requestId } = await hyp();
  const newCheckout = await flag('newCheckout', false);
  defer(() => track('page_view', { country }));
  return <Checkout variant={newCheckout ? 'v2' : 'v1'} />;
}
```

- `hyp()` reads the request context forwarded by the stages (request id, nonce, geo, locale, flags, theme, runner) and exposes bindings (`env`), `cf`, `waitUntil` and a request-scoped logger. Inside the Worker it returns the full pipeline context; elsewhere it falls back to OpenNext's Cloudflare context or `process.env`.
- `jobHandler(options, handler)` wraps a Route Handler so it only accepts requests signed with `HYPDRIV_INTERNAL_SECRET` — the Worker's `scheduled`, `queue` and `email` handlers and `hypdriv jobs run` sign them.
- `safeAction()` is `@hypdriv/security`'s validated, rate-limited, idempotent Server Action wrapper with the Next request context injected.
- `<HypDrivMeta/>` renders `hypdriv:*` meta tags for the DevTools HUD; flags marked `serverOnly` are never exposed.

## Cache helpers

`revalidateTag(tag, profile?)` and `revalidatePath(path, type?)` call Next's functions and then purge HypDriv's edge cache (and the zone cache when `CACHE_PURGE_ZONE_ID`/`CACHE_PURGE_API_TOKEN` are set), so both layers stay consistent.

## Instrumentation

```ts
// instrumentation.ts
import { createInstrumentation } from '@hypdriv/next/instrumentation';
import config from './hypdriv.config';

export const { register, onRequestError } = createInstrumentation({ config });
```

Errors are logged with redacted headers and, with `observe.errors.sink: 'otlp'`, recorded as exception spans in the request's trace.

See the [configuration reference](../../docs/guides/configuration.md) and the [architecture](../../docs/architecture.md) for details.
