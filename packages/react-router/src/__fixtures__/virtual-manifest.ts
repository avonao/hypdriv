import { emptyManifest } from '@hypdriv/core';

// Stand-in for `virtual:hypdriv/manifest` in tests.
const manifest = emptyManifest({
  framework: { name: 'react-router', version: '8.5.1', bundler: 'vite', bundlerVersion: '8.3.5' },
});

export default manifest;
