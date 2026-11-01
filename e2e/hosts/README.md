# Live checks for Hypdriv's Vite hosts

One runner that verifies a deployed example of any host — plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext, Waku, Nitro (2 and 3), Analog and Hono — on Cloudflare Workers, Vercel or a Node server. The Next.js suites live in `e2e/cloudflare` and `e2e/vercel`.

```sh
pnpm -F @hypdriv/e2e-hosts check --url https://<deployment> --framework vite \
  --static / --dynamic /about --api /api/time --rate-limit 60 [--expect-runner worker] [--json]
```

| Check | What passes |
| --- | --- |
| `health` | `/_hypdriv/health` names the framework (and the runner with `--expect-runner`) |
| `static <path>` | A prerendered page: the security preset, a CSP that allows every inline and external script on the page (hash or nonce) |
| `dynamic <path>` | A rendered page: the same, a request id, and a fresh nonce per request in nonce mode |
| `hashed asset caching` | A content-hashed script or stylesheet the page references is cached `immutable` / one year |
| `bot shield` | A request with an automation user agent (`curl/…`, no browser headers) gets `403` |
| `stages on prerendered pages` | The same for every `--static` page: the request stages run for documents the static layer serves (Worker shell with `run_worker_first` on Cloudflare, Hypdriv's prerender Routing Middleware on Vercel); `--no-static-stages` skips it for deployments that serve them with static headers only |
| `api <path>` | `200`, a request id and a non-HTML content type (not a page or SPA fallback) |
| `rate limit` | Back-to-back requests over one keep-alive connection (one client address, even behind a NAT pool) reach `429` with `Retry-After` within three windows' worth |
| `http → https` | Plain HTTP redirects to https |

`hypdriv audit all --url …` (run in the example directory, so it reads the build's manifest) adds header grading, CSP coverage, cache behaviour and HTTPS enforcement for pages, `/_hypdriv/health` and a hashed asset.

## Private deployments

Test deployments are never public. Tooling passes the gateways with the variables `hypdriv audit` reads, sent over HTTPS to the checked host only and never printed: `HYPDRIV_ACCESS_HEADERS` (`x-hypdriv-gate: …` for the Cloudflare gate), `VERCEL_AUTOMATION_BYPASS_SECRET`, or `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` for Cloudflare Access.

### Cloudflare

```sh
export CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… HYPDRIV_GATE=$(openssl rand -hex 24)
pnpm -F @hypdriv/e2e-hosts provision cloudflare --dir examples/vite --name acme-hypdriv-vite \
  --prefix acme-hypdriv --domain acme-hypdriv-vite.acme.dev --zone <zone id>
cd examples/vite
WRANGLER_CONFIG=wrangler.acme-hypdriv.local.jsonc HYPDRIV_TARGET=cloudflare pnpm vite build
pnpm wrangler deploy                      # uses the redirected config the Cloudflare Vite plugin wrote
cd ../.. && pnpm -F @hypdriv/e2e-hosts provision cloudflare … --tag hypdriv-dev   # tags; confirms workers.dev off
HYPDRIV_ACCESS_HEADERS="x-hypdriv-gate: $HYPDRIV_GATE" pnpm -F @hypdriv/e2e-hosts check \
  --url https://acme-hypdriv-vite.acme.dev --framework vite --static / --dynamic /about --api /api/time \
  --rate-limit 60 --expect-runner worker
```

`provision cloudflare` writes the git-ignored `wrangler.<prefix>.local.jsonc` (custom domain, `workers_dev` and preview URLs off, observability) and keeps the zone to **two rules for every host of the prefix**: one WAF custom rule that blocks HTTPS requests without the `x-hypdriv-gate` header or `hypdriv_gate` cookie (the Free plan allows five custom rules), and one Redirect Rule that sends plain HTTP for those hosts to https. The redirect matters: Workers Static Assets answer before the Worker (so before `redirects.forceHttps`), and an HTTP request cannot carry the gate safely. Run it before the first deploy, so the hostname is gated before it resolves. Frameworks whose build writes the Worker config elsewhere (Astro, SvelteKit, Nuxt, Nitro, Analog) take the generated file through their adapter's config option; each example's README says how.

### Vercel

```sh
export VERCEL_TOKEN=… VERCEL_TEAM_ID=…
pnpm -F @hypdriv/e2e-hosts provision vercel --dir . --name acme-hypdriv-vite --root-directory examples/vite --framework vite
# link the repository root to the project, then build and deploy prebuilt
vercel pull --yes --environment=production && vercel build --prod && vercel deploy --prebuilt --prod
VERCEL_AUTOMATION_BYPASS_SECRET=$(jq -r .VERCEL_AUTOMATION_BYPASS_SECRET acme-hypdriv-vite.vercel.secrets.local.json) \
  pnpm -F @hypdriv/e2e-hosts check --url https://acme-hypdriv-vite.vercel.app --framework vite --static / \
  --dynamic /about --api /api/time --rate-limit 60
```

`provision vercel` creates the project when missing, turns on Vercel Authentication for every deployment (`ssoProtection: all`, available on Hobby) and stores an automation bypass in `<name>.vercel.secrets.local.json` (mode 600, git-ignored). Never put an account token into a deployment's environment.

## Results

The last verified run per host and platform is recorded in `docs/testing/vite-hosts-live-<date>.md`.
