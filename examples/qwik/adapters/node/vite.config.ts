import { nodeAdapter } from '@hypdriv/qwik/adapters/node';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config';

export default extendConfig(baseConfig, () => ({
  build: { ssr: true, rolldownOptions: { input: ['src/entry.node.tsx'] } },
  // `/api/*` is an endpoint, `/dynamic/` renders per request: neither is prerendered.
  plugins: [nodeAdapter({ ssg: { include: ['/*'], exclude: ['/api/*', '/dynamic/*'] } })],
}));
