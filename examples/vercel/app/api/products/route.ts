import { withVercelCdn } from 'hypdriv/vercel';
import config from '@/hypdriv.config';
import { listProducts } from '@/lib/catalog';

// The function response is what Vercel's CDN caches: withVercelCdn applies the `products-api` policy
// (Vercel-CDN-Cache-Control, Vercel-Cache-Tag) with the same planning as the proxy stage.
export const GET = withVercelCdn(config, async () => Response.json({ products: await listProducts() }));
