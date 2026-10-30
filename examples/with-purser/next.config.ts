import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import type { NextConfig } from 'next';
import { withHypDriv } from 'hypdriv/config';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
};

// withHypDriv builds app/purser.css before `next build` (and watches it during `next dev`).
export default withHypDriv(nextConfig);

initOpenNextCloudflareForDev();
