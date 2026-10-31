---
"@hypdriv/sveltekit": minor
---

New package `@hypdriv/sveltekit`: HypDriv for SvelteKit 3 on Cloudflare Workers, Vercel and Node.

- `hypdriv(adapter())` wraps any SvelteKit adapter: it contributes the config and manifest modules, finalises the manifest after prerendering from `builder.routes` (route groups, matchers, optional and rest parameters, mixed segments with SvelteKit's own regex, adapter-vercel ISR), client assets per route and the prerendered pages (CSP hashes including those of SvelteKit's `<meta>` policy, Early Hints with root-relative URLs), patches it into every server output and verifies it, and writes the platform's static headers: adapter-cloudflare `_headers`, adapter-vercel `config.json` routes placed before the prerender rewrites.
- On Cloudflare Workers the adapter's Worker moves behind HypDriv's Worker shell (`createSvelteKitWorker`): the Drivetrain for every Worker request (CSRF rejections, trailing-slash redirects and `/_app` 404s included), `scheduled` / `queue` / `email` / `tail`, the HypDriv Durable Objects and, with `cloudflare.exports`, the application's own.
- `@hypdriv/sveltekit/hooks` is the `handle` hook (`sequence(hypdriv(), …)`), built on `createHandler`: full-response pipeline with the forwarded request, pass-through while SvelteKit builds and prerenders (`building`), for sub-requests and inside an outer runner; SvelteKit's `csp` option is folded into HypDriv's policy with one nonce for the page, `%sveltekit.nonce%`, `nonce()` and the header.
- `@hypdriv/sveltekit/node` serves an adapter-node build with the pipeline around `build/handler.js` (static files and prerendered pages included); `@hypdriv/sveltekit/server` re-exports `hyp`, `requireHyp`, `nonce`, `flag`, `geo`, `defer` and `jobHandler`.
