import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    // Runtime files the module registers with Nuxt and Nitro; they are bundled into the application's server.
    'runtime/nitro-plugin': 'src/runtime/nitro-plugin.ts',
    'runtime/cloudflare-worker': 'src/runtime/cloudflare-worker.ts',
    'runtime/nonce.server': 'src/runtime/nonce.server.ts',
    'runtime/composables': 'src/runtime/composables.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Workspace packages, the framework (Nuxt, Nitro, h3, Vue, Vite), Nitro's and HypDriv's virtual modules stay
  // external: Nuxt and Nitro resolve them when they bundle the application.
  deps: {
    neverBundle: [
      /^node:/,
      /^cloudflare:/,
      /^@hypdriv\//,
      /^nuxt(\/|$)/,
      /^#/,
      /^virtual:/,
      /^nitropack(\/|$)/,
      /^h3$/,
      /^vue$/,
      /^vite$/,
      /^crossws(\/|$)/,
    ],
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
