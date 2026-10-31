import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv, withHypDrivCache } from '@hypdriv/vinext';
import { staticAssetsAdapter } from '@vinext/cloudflare/cache/static-assets-adapter';
import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// One app, three targets: Cloudflare Workers (worker/index.ts), Vercel (Nitro's Vercel preset) and Node
// (`vinext start`). Vercel builds set VERCEL=1.
const target = (process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare')) as
  | 'cloudflare'
  | 'vercel'
  | 'node';

export default defineConfig({
  plugins: [
    vinext({
      // Render static pages at build time: HypDriv gives the ones the platform serves as built a hash-based CSP.
      prerender: true,
      // On Workers, prerendered pages are served from Workers Static Assets. `withHypDrivCache` makes
      // revalidateTag()/revalidatePath() purge HypDriv's edge cache as well.
      cache: withHypDrivCache(target === 'cloudflare' ? { cdn: staticAssetsAdapter() } : {}),
    }),
    ...(target === 'cloudflare'
      ? [
          cloudflare({
            // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
            configPath: process.env.WRANGLER_CONFIG ?? './cloudflare/wrangler.jsonc',
            viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
          }),
        ]
      : []),
    ...(target === 'vercel' ? [nitro({ preset: 'vercel' })] : []),
    hypdriv({ target }),
  ],
});
