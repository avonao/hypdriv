// One app, three targets: Cloudflare Workers (Hypdriv's Worker entry around Nitro), Vercel (Build Output) and
// Node (`node .output/server/index.mjs`). Vercel builds set VERCEL=1.
import { readFileSync } from 'node:fs';

const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

// WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc (written by
// `e2e/hosts provision`). Nitro merges `cloudflare.wrangler` into wrangler.jsonc (arrays are concatenated), so only
// the deployment's own keys are taken from it.
const ACCOUNT_KEYS = ['name', 'routes', 'workers_dev', 'preview_urls', 'observability', 'vars'];
const accountWrangler = process.env.WRANGLER_CONFIG
  ? Object.fromEntries(
      Object.entries(
        JSON.parse(readFileSync(process.env.WRANGLER_CONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, '')) as Record<
          string,
          unknown
        >,
      ).filter(([key]) => ACCOUNT_KEYS.includes(key)),
    )
  : null;
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
  // Options of @hypdriv/nuxt (all optional; `hypdriv.config.ts` holds the Hypdriv config itself).
  hypdriv: {},
  routeRules: {
    // Prerendered at build time: served by Workers Static Assets / the Vercel CDN with hash-based CSP.
    '/': { prerender: true },
    '/about': { prerender: true },
  },
  nitro: {
    preset: presets[target] ?? target,
    // Cloudflare: write `.output/server/wrangler.json` from `wrangler.jsonc` (Durable Objects, compatibility flags).
    ...(target === 'cloudflare'
      ? { cloudflare: { deployConfig: true, ...(accountWrangler ? { wrangler: accountWrangler } : {}) } }
      : {}),
  },
});
