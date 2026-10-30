# create-hypdriv

Scaffold a production-ready Next.js 16 application with [HypDriv](https://github.com/avonao/hypdriv) on **Cloudflare Workers** (OpenNext) or **Vercel**, optionally styled with [Purser CSS](https://github.com/avonao/purser).

```sh
npm create hypdriv@latest my-app
pnpm create hypdriv my-app --platform vercel
yarn create hypdriv my-app --purser
bun create hypdriv my-app --platform cloudflare --purser
```

Without options on a terminal, it asks for the directory, the platform and whether to use Purser. In CI pass the options (or `--yes` for the defaults).

## Options

| Option | Default | Description |
| --- | --- | --- |
| `[directory]` | `hypdriv-app` | Target directory; must be empty or missing. |
| `--platform <cloudflare\|vercel>` | `cloudflare` | Deploy target. |
| `--purser` | off | Purser CSS: zero-override atomic CSS, the unstyled-atom build guard, flashless themes. |
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
| `vercel` | `examples/vercel` | HypDriv stages in `proxy.ts`, Vercel CDN cache headers by policy, tag purge on Vercel's CDN, Vercel Cron, Vercel Queues, Upstash Redis counters, region `iad1` |
| `vercel-purser` | `examples/vercel-purser` | The Vercel setup with Purser CSS and hashed theme script |

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

MIT licensed. Part of [HypDriv](https://github.com/avonao/hypdriv).
