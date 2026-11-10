# create-hypdriv

Scaffold a production-ready application with [Hypdriv](https://github.com/avonao/hypdriv): Next.js 16 on **Cloudflare Workers** (OpenNext) or **Vercel**, optionally styled with [Purser CSS](https://github.com/avonao/purser), a Vite framework — plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext, Waku, RedwoodSDK, SolidStart, Qwik, Nitro or Analog — or a server framework — Hono, Express or Fastify — on **Cloudflare Workers**, **Vercel** or **Node** (RedwoodSDK on Workers only, Fastify on Vercel and Node only).

> **Preview install.** The 0.1.0 packages are not on a package registry. Run the scaffolder from a release bundle or a source build with `--no-install` (`node dist/index.js my-app --no-install`), then run the bundle's `install.sh my-app`. The commands below show the registry form that applies once the packages are published.

```sh
npm create hypdriv@latest my-app
pnpm create hypdriv my-app --platform vercel
yarn create hypdriv my-app --purser
pnpm create hypdriv my-site --framework astro --platform cloudflare
pnpm create hypdriv my-shop --framework sveltekit --platform node
```

Without options on a terminal, it asks for the directory, the framework, the platform and (for Next.js) whether to use Purser. In CI pass the options (or `--yes` for the defaults).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `[directory]` | `hypdriv-app` | Target directory; must be empty or missing. |
| `--framework <name>` | `next` | `next`, `vite`, `react-router`, `tanstack-start`, `astro`, `sveltekit`, `nuxt`, `vinext`, `waku`, `rwsdk`, `solid-start`, `qwik`, `nitro`, `analog`, `hono`, `express` or `fastify`. |
| `--platform <cloudflare\|vercel\|node>` | `cloudflare` (`node` for Fastify) | Deploy target. Fastify runs on Vercel and Node only: its router compiles handlers with `new Function()`, which Workers refuse. |
| `--purser` | off | Next.js: Purser CSS — zero-override atomic CSS, the unstyled-atom build guard, flashless themes. |
| `--pm <pnpm\|npm\|yarn\|bun>` | the package manager running it | Used to install and in the printed commands. |
| `--name <package-name>` | from the directory | `package.json` name; Workers names are derived from it. |
| `--no-install` | — | Skip installing dependencies. |
| `--no-git` | — | Skip `git init` and the initial commit. |
| `-y, --yes` | — | Accept the defaults without prompting. |
| `--json` | — | Print the result as JSON (files, template, next steps). |

## What you get

Every template is one of the repository's example apps, built and audited end to end before each release:

| Template | Source | Highlights |
| --- | --- | --- |
| `cloudflare` | `examples/basic` | Worker shell (`hypdriv.worker.ts`) around OpenNext, edge cache, strict CSP with edge nonces, Durable Objects for exact rate limits, live channels and tag purges, cron jobs, Zod-validated Server Action |
| `cloudflare-purser` | `examples/with-purser` | The above plus Purser CSS, edge-pinned themes and the zero-override audit |
| `vercel` | `examples/vercel` | Hypdriv stages in `proxy.ts`, Vercel CDN cache headers by policy, tag purge on Vercel's CDN, Vercel Cron, Vercel Queues, Upstash Redis counters, region `iad1` |
| `vercel-purser` | `examples/vercel-purser` | The Vercel setup with Purser CSS and hashed theme script |
| `vite` | `examples/vite` | Single-page Vite app: `assetsWorker()` on Cloudflare, Build Output with Hypdriv's Routing Middleware and an `api/` function on Vercel, `hypdriv serve` on Node |
| `react-router` | `examples/react-router` | React Router 8 framework mode: preset, root middleware, nonce-aware server entry, prerendered pages, `reactRouterWorker()` |
| `tanstack-start` | `examples/tanstack-start` | TanStack Start with `withHypDriv()`, global request middleware (CSRF kept), router nonces, Nitro for Vercel and Node |
| `astro` | `examples/astro` | Astro 7 integration: prerendered pages with a server island, on-demand pages, endpoints, `src/fetch.ts` |
| `sveltekit` | `examples/sveltekit` | SvelteKit 3: adapter wrapper, `handle` hook, one CSP merged with `kit.csp`, form actions, Node server |
| `nuxt` | `examples/nuxt` | Nuxt 4 module: Nitro plugin, `useHyp()`, route-rule prerendering, Worker entry around Nitro |
| `vinext` | `examples/vinext` | The Next.js App Router API on Vite: request hook in every runtime, `createVinextWorker()`, cache purge bridge |
| `waku` | `examples/waku` | Waku 1 (React Server Components on Vite): `withHypDriv()`, server-entry adapters for Workers, Vercel and Node, prerendered and dynamic pages, API route |
| `rwsdk` | `examples/rwsdk` | RedwoodSDK 1 (React Server Components on Vite and Workers): `withHypDriv()` around `defineApp`, the CSP nonce handed to RedwoodSDK, route manifest from the app, Cloudflare Workers only |
| `solid-start` | `examples/solid-start` | SolidStart 2 (Vite, Nitro or `@cloudflare/vite-plugin`): `hypdriv()` plugin, Nitro runtime plugin or Worker shell, Solid nonce flow, prerendered and dynamic pages, API routes |
| `qwik` | `examples/qwik` | Qwik v2 with Qwik Router: Vite plugin, Hypdriv adapters and server entries for Workers, Vercel and Node, prerendered and dynamic pages, endpoint |
| `nitro` | `examples/nitro` | A Nitro 2 server (`nitropack`): the `hypdrivNitro()` module, prerendered and server-rendered pages, API routes, Worker entry around Nitro (Nitro 3 on Vite: `examples/nitro-vite`) |
| `analog` | `examples/analog` | Analog 2 (Angular on Vite and Nitro): `withHypDriv()` around `analog()`, `provideHypDriv()` and `injectHyp()`, prerendered and server-rendered routes, Nitro API routes |
| `hono` | `examples/hono` | Hono with `useHypDriv()`: one app on Workers (with the Durable Objects), Vercel Functions and Node (`@hono/node-server`) |
| `express` | `examples/express` | Express 5 with `useHypDriv()`: the app module for Vercel, `compression()` and `express.static` around it on Node, `httpServerHandler()` on Workers with the Durable Objects; streaming, a content-hashed asset |
| `fastify` | `examples/fastify` | Fastify 5 with the `hypdriv` plugin and `@fastify/compress` after it: one `src/server.ts` for Node and Vercel (zero-config Fastify), `@fastify/static` for `public/`, streaming |

Vite framework templates build for every platform (`build:cloudflare`, `build:vercel`, `build:node`); `--platform` picks the local secrets file (`.dev.vars` for Workers, `.env.local` otherwise) and the printed next steps. The RedwoodSDK template builds for Workers only (`build:cloudflare`; `--platform vercel|node` is refused). The server framework templates (Hono, Express, Fastify) have no build step: they run as they are (`dev`, `start`, `wrangler deploy`, `vercel deploy`); the Fastify template refuses `--platform cloudflare`.

The scaffolder also:

- generates real random values for `HYPDRIV_SESSION_SECRET`, `HYPDRIV_INTERNAL_SECRET` (and `CRON_SECRET` on Vercel) in the git-ignored `.dev.vars` / `.env.local`;
- names the Worker, its service binding, R2 bucket and Analytics Engine dataset after the project and sets a current compatibility date;
- writes a `pnpm-workspace.yaml` that allows the install scripts the platform needs (`workerd`, `esbuild`, `sharp`) when you use pnpm.

Then run `hypdriv doctor` in the new project: it checks the environment, configuration, bindings, CSP and budgets for the chosen platform.

## Programmatic use

```ts
import { scaffold } from 'create-hypdriv';

scaffold({
  directory: 'apps/shop',
  platform: 'vercel',
  purser: false,
  packageManager: 'pnpm',
  templatesDir: new URL('../node_modules/create-hypdriv/templates', import.meta.url).pathname,
});
```

MIT licensed. Part of [Hypdriv](https://github.com/avonao/hypdriv).
