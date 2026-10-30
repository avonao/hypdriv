import { withHypDriv } from 'hypdriv/config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
};

// On Vercel, withHypDriv keeps Vercel in charge of deployment ids and image optimization and turns
// explicit edge-cache policies into Vercel CDN route headers.
export default withHypDriv(nextConfig);
