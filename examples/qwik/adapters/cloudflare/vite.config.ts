import { cloudflareAdapter } from '@hypdriv/qwik/adapters/cloudflare';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config';

export default extendConfig(baseConfig, () => ({
  build: { ssr: true, rolldownOptions: { input: ['src/entry.cloudflare.tsx'] } },
  // `/api/*` is an endpoint, `/dynamic/` renders per request: neither is prerendered.
  plugins: [cloudflareAdapter({ ssg: { include: ['/*'], exclude: ['/api/*', '/dynamic/*'] } })],
}));
