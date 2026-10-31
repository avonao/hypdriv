import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fixture = (name: string) => fileURLToPath(new URL(`./src/__fixtures__/${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    // The build's virtual modules, for tests of the entries that import them.
    alias: {
      'virtual:hypdriv/config': fixture('virtual-config.ts'),
      'virtual:hypdriv/manifest': fixture('virtual-manifest.ts'),
      'virtual:hypdriv/tanstack-start': fixture('virtual-start.ts'),
    },
  },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'tanstack-start',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
