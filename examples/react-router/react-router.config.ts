import { hypdrivPreset } from '@hypdriv/react-router';
import type { Config } from '@react-router/dev/config';
import { vercelPreset } from '@vercel/react-router/vite';

// One app, three targets: Cloudflare (Worker entry), Vercel (HypDriv's Build Output) and Node
// (`hypdriv-react-router-serve`). Vercel builds set VERCEL=1.
const target = process.env.HYPDRIV_TARGET ?? (process.env.VERCEL === '1' ? 'vercel' : 'cloudflare');

export default {
  ssr: true,
  // `/` and `/about` are prerendered (hash CSP from the static rules); `/ssr` renders per request (nonce CSP).
  prerender: ['/', '/about'],
  presets: [
    // On Vercel, `@vercel/react-router` splits the server build by each route's `config` (memory, maxDuration,
    // regions); HypDriv turns every server bundle into a function of its Build Output.
    ...(target === 'vercel' ? [vercelPreset()] : []),
    hypdrivPreset(),
  ],
} satisfies Config;
