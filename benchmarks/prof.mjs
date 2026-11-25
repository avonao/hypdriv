// Profile one path through the handler: node --cpu-prof prof.mjs through|hit [requests]
import { emptyManifest, routePatternToRegex } from '@hypdriv/core';
import { createHandler } from '@hypdriv/runtime';

const mode = process.argv[2] ?? 'through';
const N = Number(process.argv[3] ?? 6000);
const items = Array.from(
  { length: 120 },
  (_, i) =>
    `<li class="item"><a href="/products/${i}">Product ${i}</a><p>${'A sentence about this product. '.repeat(5)}</p></li>`,
).join('');
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Products</title><link rel="stylesheet" href="/assets/app-1a2b3c.css"><script type="module" src="/assets/app-4d5e6f.js"></script></head><body><main><h1>Products</h1><ul>${items}</ul></main><script>window.__DATA__ = ${JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `Product ${i}` })) })}</script><script>document.documentElement.dataset.ready = '1'</script></body></html>`;
const upstream = () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const manifest = emptyManifest({
  buildId: 'bench',
  routes: [
    {
      id: 'page:/products/[id]',
      pathname: '/products/[id]',
      regex: routePatternToRegex('/products/[id]'),
      kind: 'page',
      classification: 'dynamic',
      runtime: 'nodejs',
      dynamic: true,
      assets: { js: [], css: [], fonts: [] },
    },
  ],
});
for (const m of ['log', 'info', 'debug', 'warn']) console[m] = () => {};
const config =
  mode === 'hit' ? { cache: { edge: { policies: [{ match: '/products/:id', ttl: '5m' }] } } } : {};
const handler = createHandler({ config, manifest, target: 'node', development: false });
const t = performance.now();
for (let i = 0; i < N; i++) {
  const r = await handler(
    new Request(`https://shop.example/products/${i % 50}`, {
      headers: { accept: 'text/html', 'accept-encoding': 'br, gzip', 'user-agent': 'Mozilla/5.0 (bench)' },
    }),
    { upstream },
  );
  await r.arrayBuffer();
}
process.stdout.write(`${mode}: ${(((performance.now() - t) / N) * 1000).toFixed(0)} µs a request\n`);
