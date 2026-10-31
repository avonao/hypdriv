---
"@hypdriv/cli": minor
---

The CLI understands Vite hosts: framework detection (plain Vite, React Router, TanStack Start, Astro, SvelteKit, Nuxt, vinext), Vite host checks in `hypdriv doctor` (integration installed and registered, manifest producer, `_headers` block and `.assetsignore`, `run_worker_first`, Durable Object exports, Build Output routes), framework-aware `routes`, `manifest` and `audit` (no `Vary: rsc` expectation outside Next.js; documents the platform's static layer serves and caches are reported as such), and `hypdriv serve` for Node. New `hypdriv audit https` (part of `all` for https deployments): pages, `/_hypdriv/health` and a content-hashed asset requested anonymously over `http://` must redirect permanently to the same URL over https — it names the zone setting when static assets are served over plain HTTP before the application runs.
