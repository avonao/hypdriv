import { withVercelCdn } from 'hypdriv/vercel';
import config from '@/hypdriv.config';

// The function response is what Vercel's CDN caches: withVercelCdn applies the `cdn-api` policy
// (Vercel-CDN-Cache-Control, Vercel-Cache-Tag: e2e-cdn); revalidateTag('e2e-cdn') purges it.
export const GET = withVercelCdn(config, async () =>
  Response.json({ renderedAt: new Date().toISOString(), region: process.env.VERCEL_REGION ?? null }),
);
