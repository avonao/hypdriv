import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'config': 'src/config.ts',
    'next': 'src/next.ts',
    'proxy': 'src/proxy.ts',
    'cloudflare': 'src/cloudflare.ts',
    'durable-objects': 'src/durable-objects.ts',
    'server': 'src/server.ts',
    'client': 'src/client.tsx',
    'cache': 'src/cache.ts',
    'instrumentation': 'src/instrumentation.ts',
    'security': 'src/security.ts',
    'flags': 'src/flags.ts',
    'live': 'src/live.ts',
    'observe': 'src/observe.ts',
    'image': 'src/image.ts',
    'purser': 'src/purser.ts',
  },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2023',
  // Every @hypdriv/* package is a dependency: re-export, never bundle.
  external: [/^node:/, /^cloudflare:/, /^@hypdriv\//, /^next(\/|$)/, /^react(\/|$)/],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
