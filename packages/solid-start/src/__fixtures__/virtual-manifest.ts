import { emptyManifest, routePatternToRegex } from '@hypdriv/core';

// Stands in for `virtual:hypdriv/manifest` in tests: a prerendered page and a dynamic one.
const manifest = emptyManifest({
  buildId: 'fixture',
  framework: { name: 'solid-start', version: '2.1.0', bundler: 'vite' },
  routes: [
    {
      id: 'page:/about',
      pathname: '/about',
      regex: routePatternToRegex('/about'),
      kind: 'page',
      classification: 'static',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: [], css: [], fonts: [] },
    },
    {
      id: 'page:/request',
      pathname: '/request',
      regex: routePatternToRegex('/request'),
      kind: 'page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: false,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
  csp: { 'page:/about': { scriptHashes: ["'sha256-fixture'"], styleHashes: [] } },
});

export default manifest;
