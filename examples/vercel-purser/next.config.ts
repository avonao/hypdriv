import { withHypDriv } from 'hypdriv/config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
};

// withHypDriv builds app/purser.css before `next build` (and watches it during `next dev`), keeps Vercel in
// charge of deployment ids and image optimization, and emits Vercel CDN route headers for edge policies.
export default withHypDriv(nextConfig);
