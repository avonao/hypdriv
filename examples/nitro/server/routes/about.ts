import { defineEventHandler } from 'h3';
import { page } from '../utils/page';

// Prerendered (`routeRules` in nitro.config.ts).
export default defineEventHandler((event) =>
  page(event, {
    title: 'About',
    body: `<h1>About</h1>
<p>A second prerendered page. Hypdriv runs its request stages for it too: rate limiting, the bot shield, geo, redirects.</p>`,
  }),
);
