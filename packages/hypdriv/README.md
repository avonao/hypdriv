# hypdriv

**HypDriv** — the Hyper-Extension for Next.js 16+ on Cloudflare Workers and Vercel. This umbrella package installs every HypDriv module and the `hypdriv` command.

```sh
npm create hypdriv@latest my-app                       # new app on Cloudflare Workers (OpenNext)
npm create hypdriv@latest my-app -- --platform vercel  # new app on Vercel
pnpm add hypdriv && npx hypdriv init                   # existing app (add --platform vercel on Vercel)
```

## Entry points

| Import | Use it in | Main exports |
| --- | --- | --- |
| `hypdriv` | `hypdriv.config.ts`, anywhere | `defineConfig`, config/manifest types, core utilities (`hypFetch`, `cspHash`, …) |
| `hypdriv/config` | `next.config.ts` | `withHypDriv` |
| `hypdriv/proxy` | `proxy.ts` | `createProxy`, `matcher` |
| `hypdriv/cloudflare` | `hypdriv.worker.ts` | `createWorker`, `enqueue` |
| `hypdriv/durable-objects` | `hypdriv.worker.ts` | `HypDrivChannel`, `HypDrivLimiter`, `HypDrivIndex` |
| `hypdriv/vercel` | Route Handlers, `instrumentation.ts` on Vercel | `withVercelCdn`, `queueConsumer`, `botIdGuard`, `registerVercelSdk`, `invalidateTags`, `upstashKv`, … (the proxy wires the rest automatically) |
| `hypdriv/server` | Server Components, Route Handlers, Server Actions | `hyp`, `flag`, `nonce`, `geo`, `defer`, `jobHandler`, `safeAction`, `defineRoute`, sessions, JWT, signing, webhooks, passwords, `safeRedirect`, `enqueue`, `publish` |
| `hypdriv/client` | Client Components | `VitalsReporter`, `HypDrivDevTools`, `FlagsProvider`, `useFlag`, `useLive`, `useLiveValue`, `useLiveRefresh` |
| `hypdriv/cache` | mutations | `revalidateTag`, `revalidatePath`, `purgeEdge` |
| `hypdriv/instrumentation` | `instrumentation.ts` | `createInstrumentation` |
| `hypdriv/next`, `hypdriv/security`, `hypdriv/flags`, `hypdriv/live`, `hypdriv/observe`, `hypdriv/image`, `hypdriv/purser` | advanced use | the full package APIs |

```ts
// hypdriv.worker.ts
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

## The `hypdriv` command

`hypdriv init · doctor · analyze · routes · audit · budget · csp · css · warm · bench · deps · manifest · jobs · vitals · agent` — every command supports `--json` and `--root`. See the [CLI guide](../../docs/guides/cli.md).

## Documentation

[Getting started](../../docs/guides/getting-started.md) · [Configuration](../../docs/guides/configuration.md) · [Architecture](../../docs/architecture.md) · [Feature catalog](../../docs/feature-catalog.md)

MIT © Avonao, Inc. and HypDriv contributors
