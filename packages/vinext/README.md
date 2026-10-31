# @hypdriv/vinext

HypDriv for [vinext](https://github.com/cloudflare/vinext), Cloudflare's Vite implementation of the Next.js API. The Drivetrain — security headers, CSP with build-time hashes or per-request nonces, rate limiting, the bot shield, geo, flags, redirects, maintenance, the edge cache, Early Hints, logging, tracing and `Server-Timing` — runs around every request vinext answers on Cloudflare Workers, Vercel and Node, and the build produces HypDriv's manifest from the vinext build.

```sh
pnpm add @hypdriv/vinext @hypdriv/core
```

```ts
// vite.config.ts
import { hypdriv, withHypDrivCache } from '@hypdriv/vinext';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vinext({ prerender: true, cache: withHypDrivCache() }), /* cloudflare() | nitro() */ hypdriv()],
});
```

## Entry points

| Import | Use |
|---|---|
| `@hypdriv/vinext` | `hypdriv(options)` — the Vite plugin: the request hook around vinext's App Router handler (every runtime, `vite dev` included), the manifest after vinext's prerender, the final manifest patched into every server output, Cloudflare `_headers` / Vercel Build Output routes, Vercel static pages. `withHypDrivCache(cache)` — makes `revalidateTag()` / `revalidatePath()` purge HypDriv's edge cache too. Route discovery helpers. |
| `@hypdriv/vinext/server` | `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `devtoolsMeta` (dynamic APIs, like `headers()`), `defer`, `jobHandler`. |
| `@hypdriv/vinext/worker` | `createVinextWorker({ config, manifest, app })` — HypDriv's Cloudflare Worker shell around `vinext/server/fetch-handler`, with `scheduled` / `queue` / `email` / `tail` and the Durable Objects. |
| `@hypdriv/vinext/proxy` | `createProxy({ config, manifest })` — `proxy.ts` for Pages Router apps. |
| `@hypdriv/vinext/cache` | `withHypDrivPurge(adapter)`, `purgeHypDriv(tags)`, `purgeTargets(tags)`. |
| `@hypdriv/vinext/runtime` | `wrapAppHandler()` (what the plugin's hook module calls), `isBuildPrerender()`. |
| `@hypdriv/vinext/virtual` | Types of `virtual:hypdriv/config` and `virtual:hypdriv/manifest`. |

Options of `hypdriv()`: `config` (file path or inline config), `appDir` (vinext's option, when set), `target` (`cloudflare` / `vercel` / `node`, detected by default), `hook` (default `true`), `vercelStaticPages` (default `true`).

See the [vinext guide](../../docs/guides/vinext.md) for the platforms, CSP behaviour and limitations, and `examples/vinext` for an app that builds for all three platforms.

## License

MIT
