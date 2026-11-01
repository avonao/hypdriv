import { defineHandler } from 'nitro';
import { page } from '../utils/page';

// Prerendered (`routeRules` in vite.config.ts): served by the static layer, with a hash-based CSP.
export default defineHandler(() =>
  page({
    title: 'Hypdriv × Nitro 3',
    body: `<h1>Hypdriv × Nitro 3</h1>
<p>This page is prerendered at build time. Its CSP allows the inline style and script by hash, written into the platform's static headers.</p>`,
  }),
);
