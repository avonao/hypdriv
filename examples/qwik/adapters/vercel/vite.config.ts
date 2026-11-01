import { vercelAdapter } from '@hypdriv/qwik/adapters/vercel';
import { extendConfig } from '@qwik.dev/router/vite';
import baseConfig from '../../vite.config';

export default extendConfig(baseConfig, () => ({
  build: {
    ssr: true,
    rolldownOptions: { input: ['src/entry.vercel.tsx'] },
    // The server build is the Build Output API function; the client build becomes `.vercel/output/static`.
    outDir: '.vercel/output/functions/_qwik-router.func',
  },
  // `/api/*` is an endpoint, `/dynamic/` renders per request: neither is prerendered.
  plugins: [vercelAdapter({ ssg: { include: ['/*'], exclude: ['/api/*', '/dynamic/*'] } })],
}));
