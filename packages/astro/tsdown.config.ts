import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    middleware: 'src/middleware.ts',
    'internal-route': 'src/internal-route.ts',
    server: 'src/server.ts',
    fetch: 'src/fetch.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, Astro, Vite and the virtual modules stay external: the runtime entries are bundled by the
  // application's Vite build (they import `virtual:hypdriv/*`).
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^astro(?:\/|$)/,
      /^@astrojs\//,
      /^vite$/,
      /^virtual:hypdriv\//,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
