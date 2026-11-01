import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fixture = (name: string) => fileURLToPath(new URL(`./src/__fixtures__/${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    // Hypdriv's virtual modules, for tests of the entries that import them.
    alias: {
      'virtual:hypdriv/config': fixture('virtual-config.ts'),
      'virtual:hypdriv/manifest': fixture('virtual-manifest.ts'),
      'virtual:hypdriv/solid-start': fixture('virtual-options.ts'),
    },
  },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'solid-start',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Real SolidStart builds of a fixture app run in `build.test.ts`.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
