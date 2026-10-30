import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { withHypDriv } from 'hypdriv/config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
};

// withHypDriv builds app/purser.css before `next build` (and watches it during `next dev`).
export default withHypDriv(nextConfig);

initOpenNextCloudflareForDev();
