import { nonce } from '@hypdriv/nitro/server';
import { type H3Event, setHeader } from 'h3';

const STYLE =
  'body{font-family:system-ui,sans-serif;margin:0 auto;max-width:44rem;padding:2rem 1rem;line-height:1.5}nav a{margin-right:1rem}code{background:#f3f3f3;padding:0 .25rem}';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A complete HTML document. The inline style and script carry the request's nonce on dynamic pages (`nonce()` is
 * `undefined` while Nitro prerenders, where Hypdriv hashes the inline code instead).
 */
export function page(event: H3Event, options: { title: string; body: string }): string {
  setHeader(event, 'content-type', 'text/html; charset=utf-8');
  const attr = nonce() ? ` nonce="${nonce()}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style${attr}>${STYLE}</style>
<script type="module" src="/assets/app.3f9a1c2e.js"></script>
</head>
<body>
<nav>
<a href="/">Home</a>
<a href="/about">About</a>
<a href="/ssr">Request facts</a>
<a href="/api/hello">/api/hello</a>
<a href="/_hypdriv/health">/_hypdriv/health</a>
</nav>
${options.body}
<script${attr}>document.documentElement.dataset.ready = 'inline'</script>
</body>
</html>
`;
}
