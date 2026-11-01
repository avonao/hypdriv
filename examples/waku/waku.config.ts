import { cloudflare } from '@cloudflare/vite-plugin';
import { withHypDriv } from '@hypdriv/waku';
import { defineConfig } from 'waku/config';

// One app, three targets: Cloudflare Workers, Vercel and Node. `withHypDriv` selects the Hypdriv adapter of the
// target (HYPDRIV_TARGET, else VERCEL=1, else Node) and adds the Hypdriv Vite plugin.
const cloudflareBuild = process.env.HYPDRIV_TARGET === 'cloudflare';

export default defineConfig(
  withHypDriv({
    vite: {
      plugins: cloudflareBuild
        ? [
            cloudflare({
              // WRANGLER_CONFIG points at an account-specific, git-ignored wrangler.<name>.local.jsonc.
              ...(process.env.WRANGLER_CONFIG ? { configPath: process.env.WRANGLER_CONFIG } : {}),
              viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
            }),
          ]
        : [],
    },
  }),
);
