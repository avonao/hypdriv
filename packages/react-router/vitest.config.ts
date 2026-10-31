import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fixture = (name: string) => fileURLToPath(new URL(`./src/__fixtures__/${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    // The virtual modules Hypdriv's Vite plugin and React Router serve in an application build.
    alias: {
      'virtual:hypdriv/config': fixture('virtual-config.ts'),
      'virtual:hypdriv/manifest': fixture('virtual-manifest.ts'),
      'virtual:hypdriv/react-router': fixture('virtual-react-router.ts'),
      'virtual:react-router/server-build': fixture('virtual-server-build.ts'),
    },
  },
  // Vitest runs tests in the SSR environment; resolve workspace packages from src, not dist.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'react-router',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
