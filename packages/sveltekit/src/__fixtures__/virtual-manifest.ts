// Test stand-in for `virtual:hypdriv/manifest` (aliased in vitest.config.ts).
import { emptyManifest } from '@hypdriv/core';

export default emptyManifest({
  buildId: 'fixture',
  framework: { name: 'sveltekit', version: '3.1.1', bundler: 'vite', bundlerVersion: '8.3.5' },
});
