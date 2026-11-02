import { defineHandler } from 'nitro';
import { page } from '../utils/page';

// Prerendered (`routeRules` in vite.config.ts).
export default defineHandler(() =>
  page({
    title: 'About',
    body: `<h1>About</h1>
<p>A second prerendered page. Hypdriv runs its request stages for it too: rate limiting, the bot shield, geo, redirects.</p>`,
  }),
);
