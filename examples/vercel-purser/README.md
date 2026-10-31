# Hypdriv × Purser CSS — Vercel example

Next.js 16 (Cache Components on) on Vercel with Hypdriv and [Purser CSS](https://github.com/avonao/purser), US-first (`iad1`).

```sh
pnpm install
cp .env.example .env.local   # or: vercel env pull .env.local
pnpm dev                     # next dev: Purser watches and rebuilds app/purser.css
pnpm build                   # next build: Purser build + unstyled-atom guard
pnpm start                   # next start (proxy runs the Hypdriv stages)
pnpm audit:css               # zero-override audit in headless Chrome against `pnpm start`
pnpm build:vercel            # vercel build → .vercel/output
```

- `withHypDriv` builds `app/purser.css` before `next build`, fails the build on unstyled atoms and turns the `docs` policy into Vercel CDN route headers.
- `ThemeScript` (hashed into the CSP) pins the theme classes before first paint; the proxy adds `Accept-CH` / `Critical-CH` so the colour-scheme hint is available on the first navigation.
- Static pages get a hash-based CSP; ISR pages fall back to `'unsafe-inline'` scripts because no per-request nonce can reach a cached body on Vercel (`hypdriv audit csp` explains each route).
