---
"@hypdriv/vite": minor
"@hypdriv/astro": minor
"@hypdriv/sveltekit": minor
"@hypdriv/tanstack-start": minor
"@hypdriv/vinext": minor
"@hypdriv/nuxt": minor
---

Prerendered pages on Vercel get the request stages too. Vercel's CDN serves them without the framework's function, so they previously carried HypDriv's static header rules only; the build now adds HypDriv's Routing Middleware scoped to exactly those pages (`GET`/`HEAD`, their clean, trailing-slash and `.html` spellings), so rate limiting, the bot shield, maintenance, redirects and geo apply to every page while on-demand routes keep running the pipeline once, in the function. `addVercelMiddleware()` in `@hypdriv/vite` is the shared implementation; each integration has an option to turn it off (`vercel.middleware` / `vercelMiddleware: false`).
