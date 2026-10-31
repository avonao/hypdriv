import { withBotId } from 'botid/next/config';
import { withHypDriv } from 'hypdriv/config';
import type { NextConfig } from 'next';

// Classic ISR (no Cache Components), like the Cloudflare suite: `revalidate` segments exercise Vercel's ISR,
// `unstable_cache` tags exercise revalidateTag() with Vercel's CDN purge. withBotId adds the rewrites that
// proxy BotID's challenge script; withHypDriv keeps them and adds its own headers.
const nextConfig: NextConfig = {};

export default withHypDriv(withBotId(nextConfig));
