import { defineEventHandler } from 'h3';
import { page } from '../utils/page';

// Prerendered (`routeRules` in nitro.config.ts): served by the static layer, with a hash-based CSP.
export default defineEventHandler((event) =>
  page(event, {
    title: 'Hypdriv × Nitro',
    body: `<h1>Hypdriv × Nitro</h1>
<p>This page is prerendered at build time. Its CSP allows the inline style and script by hash, written into the platform's static headers.</p>`,
  }),
);
