import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { withHypDriv } from 'hypdriv/config';
import type { NextConfig } from 'next';

// Classic ISR (no Cache Components): `revalidate` segments exercise OpenNext's revalidation queue and the
// Hypdriv Worker's ISR pass-through; examples/basic covers Cache Components and PPR.
const nextConfig: NextConfig = {};

export default withHypDriv(nextConfig);

initOpenNextCloudflareForDev();
