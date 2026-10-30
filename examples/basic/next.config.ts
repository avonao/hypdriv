import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { withHypDriv } from 'hypdriv/config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
};

export default withHypDriv(nextConfig);

// Local bindings in `next dev` (KV, R2, Durable Objects...) through OpenNext's dev platform.
initOpenNextCloudflareForDev();
