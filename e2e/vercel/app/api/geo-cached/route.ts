import { hyp } from 'hypdriv/server';
import { withVercelCdn } from 'hypdriv/vercel';
import config from '@/hypdriv.config';

// The `geo` policy (vary: country) on a Route Handler: withVercelCdn adds `Vary: X-Vercel-IP-Country`, so the
// CDN keeps one entry per country. (Pages cannot carry their own Vary through route headers.)
export const GET = withVercelCdn(config, async () => {
  const ctx = await hyp();
  return Response.json({ country: ctx.country ?? null, renderedAt: new Date().toISOString() });
});
