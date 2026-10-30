import type { NextConfig } from 'next';
import { withHypDriv } from '@hypdriv/next/config';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
};

export default withHypDriv(nextConfig);

// Local bindings in `next dev` (KV, R2, ...) through OpenNext's dev platform.
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
initOpenNextCloudflareForDev();
