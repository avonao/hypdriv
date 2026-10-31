// One app, three targets: Cloudflare Workers (HypDriv's Worker entry around Nitro), Vercel (Build Output) and
// Node (`node .output/server/index.mjs`). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');
const presets: Record<string, string> = {
  cloudflare: 'cloudflare-module',
  vercel: 'vercel',
  node: 'node-server',
};

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  telemetry: false,
  modules: ['@hypdriv/nuxt'],
  // Options of @hypdriv/nuxt (all optional; `hypdriv.config.ts` holds the HypDriv config itself).
  hypdriv: {},
  routeRules: {
    // Prerendered at build time: served by Workers Static Assets / the Vercel CDN with hash-based CSP.
    '/': { prerender: true },
    '/about': { prerender: true },
  },
  nitro: {
    preset: presets[target] ?? target,
    // Cloudflare: write `.output/server/wrangler.json` from `wrangler.jsonc` (Durable Objects, compatibility flags).
    ...(target === 'cloudflare' ? { cloudflare: { deployConfig: true } } : {}),
  },
});
