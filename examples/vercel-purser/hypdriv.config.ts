import { defineConfig } from 'hypdriv';

export default defineConfig({
  platform: 'vercel',
  site: { name: 'hypdriv-vercel-purser', origin: 'https://vercel-purser.hypdriv.dev' },
  purser: {
    enabled: true,
    src: ['app', 'components', 'lib'],
    tokens: 'lib/tokens.ts',
    out: 'app/purser.css',
    // Fail `next build` when prerendered HTML references an atom the stylesheet does not declare.
    verify: 'error',
    usageReport: true,
    theme: {
      axes: {
        mode: {
          classes: { light: null, dark: 'dark' },
          default: 'light',
          clientHint: { hint: 'prefers-color-scheme', values: { light: 'light', dark: 'dark' } },
        },
        contrast: {
          classes: { normal: null, high: 'hc' },
          default: 'normal',
          clientHint: { hint: 'prefers-contrast', values: { 'no-preference': 'normal', more: 'high' } },
        },
      },
    },
    audit: { widths: [375, 768, 1280], states: ['default', 'hover', 'focus'] },
  },
  cache: {
    edge: {
      // Vercel CDN route headers (Vercel-CDN-Cache-Control, Vercel-Cache-Tag) via withHypDriv. Cached HTML stays
      // theme-neutral: the theme script pins classes in the browser.
      policies: [
        { id: 'docs', match: '/docs/**', ttl: '10m', swr: '1d', respectOrigin: false, tags: ['docs'] },
      ],
    },
  },
  performance: { earlyHints: true, speculation: { prerender: { eagerness: 'moderate', topN: 3 } } },
  observe: { vitals: { sink: 'log' } },
  budgets: { routes: { '/**': { js: '250kb', css: '40kb' } } },
});
