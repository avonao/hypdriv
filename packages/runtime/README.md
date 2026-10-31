# @hypdriv/runtime

[Hypdriv](https://github.com/avonao/hypdriv)'s framework-neutral runtime: the Drivetrain stages (request ids, maintenance, shield, bots, rate limiting, geo, i18n, flags, redirects, themes, speculation, CSP, edge cache, security headers, Early Hints, skew, DevTools, observability), the platform assembly (`createPlatform`, `platformFor`) and the runners every host uses:

| Runner | Used by | Sees the body |
| --- | --- | --- |
| `createHandler()` | framework hooks (React Router, TanStack Start, Astro, SvelteKit, Nuxt), plain Vite servers, any Web `fetch` handler | yes — CSP nonces are injected (`HTMLRewriter` on Workers, a streaming tokenizer elsewhere) |
| `createProxyHandler()` | Next.js `proxy.ts` (`@hypdriv/next`), Hypdriv's Vercel Routing Middleware (`@hypdriv/vite`) | no — headers only |
| `createWorker()` | the Cloudflare shell (`@hypdriv/cloudflare`) | yes |

```ts
import { createHandler } from '@hypdriv/runtime';
import config from './hypdriv.config';

const hypdriv = createHandler({ config, manifest: () => import('./.hypdriv/manifest.js'), host: 'custom' });

export default {
  // Any Web fetch handler: Workers, Bun, Deno, srvx, a framework's server entry…
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) =>
    hypdriv(request, { upstream: (forwarded) => app.fetch(forwarded), env, waitUntil: (p) => ctx.waitUntil(p) }),
};
```

`createHandler` answers `/_hypdriv/*` (health, vitals, CSP reports, live channels), upgrades plain HTTP when `forceHttps` is on, skips content-hashed assets, strips client-supplied `x-hypdriv-*` headers, runs the stages with `runner: 'host'` and passes through when an outer Hypdriv runner (the Worker shell) already ran them. The deploy target is detected (`VERCEL=1` → Vercel services and Vercel CDN headers that Vercel's cache follows; workerd → Cloudflare bindings and Durable Object stores; else Node).

Application code below a handler reads the request context synchronously:

```ts
import { flag, hyp, nonce } from '@hypdriv/runtime';

const ctx = hyp(); // null outside a request (prerendering)
ctx?.requestId; ctx?.geo?.country; flag('newHero', false); nonce();
```

`jobHandler()` protects job endpoints (signed `scheduled`/`queue` dispatch and Vercel Cron with `CRON_SECRET`).

See `docs/adr/0019-vite-hosts.md` and the guides in `docs/guides/`.
