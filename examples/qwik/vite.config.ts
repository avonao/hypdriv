import { hypdriv } from '@hypdriv/qwik';
import { qwikVite } from '@qwik.dev/core/optimizer';
import { qwikRouter } from '@qwik.dev/router/vite';
import { defineConfig } from 'vite';

// The client build (`vite build`) and the dev server use this config; each server build extends it with its
// adapter (adapters/<target>/vite.config.ts). `hypdriv()` writes the route manifest, the CSP hashes of the
// prerendered pages and the platform's static headers after a server build, and runs the pipeline in `vite dev`.
export default defineConfig({
  plugins: [qwikRouter(), qwikVite(), hypdriv()],
});
