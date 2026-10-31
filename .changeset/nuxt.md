---
'@hypdriv/nuxt': minor
---

Add `@hypdriv/nuxt`, the Nuxt 4 module (Nitro 2). A Nitro plugin wraps Nitro's h3 app handler so the Hypdriv Drivetrain owns every response — rendered pages, API routes and Nuxt's error pages — with the request context (`hyp()`) available in handlers and components; Nuxt stamps the request's CSP nonce on the tags it renders and the pipeline injects it everywhere else. On `cloudflare-module` the module installs Hypdriv's Worker entry (the Worker shell around Nitro, with `scheduled` / `queue` / `email` dispatch and the Hypdriv Durable Objects exported). Builds write `.hypdriv/manifest.json` from Nuxt's pages, Nitro's server routes, prerendered documents and the client manifest, embed the final manifest in the server output, and write the static header rules into Cloudflare's `_headers` or Vercel's Build Output `config.json`. Server helpers come from `@hypdriv/nuxt/server`; components get the auto-imported `useHyp()` and `useHypNonce()`.
