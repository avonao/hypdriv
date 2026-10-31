/**
 * `@hypdriv/astro/internal-route` — the on-demand endpoint the integration injects at `/_hypdriv/[...path]`. Astro
 * runs middleware only for routes it matches, and an unmatched path is answered by the (usually prerendered) 404
 * page without middleware; this route makes `/_hypdriv/*` reach the HypDriv middleware, which answers the internal
 * routes (`/_hypdriv/health`, CSP reports, Web Vitals, DevTools) before rendering. Anything it does not answer
 * ends here as a 404.
 */
export const prerender = false;

export function ALL(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
