import type { HypDrivConfig, HypManifest, ResolvedConfig } from '@hypdriv/core';
import { platformWaitUntil } from '@hypdriv/core';
import { createProxyHandler, type StageList } from '@hypdriv/runtime';

/**
 * `@hypdriv/vite/vercel-middleware` — the Vercel Routing Middleware HypDriv builds for Vite apps whose pages Vercel
 * serves statically: the request stages (shield, bots, rate limiting, WAF rules, geo, i18n, flags, redirects,
 * maintenance, request ids, logging) run before the CDN for every path. Response headers of static pages (security
 * preset, hash CSP, Early Hints) come from the Build Output `config.json` routes HypDriv writes, so the stages that
 * produce them are left out here to keep each header single.
 */

/** Stages whose headers the static routes already carry. */
export const STATIC_OWNED_STAGES = new Set([
  'csp',
  'security-headers',
  'early-hints',
  'speculation',
  'edge-cache',
]);

export interface VercelMiddlewareOptions {
  config: HypDrivConfig | ResolvedConfig;
  manifest?: HypManifest | null;
  stages?: StageList;
}

/** The `x-middleware-next` pass-through with request-header overrides (what `@vercel/functions` `next()` emits). */
export function middlewareNext(request: Request): Response {
  const headers = new Headers({ 'x-middleware-next': '1' });
  const names: string[] = [];
  request.headers.forEach((value, name) => {
    headers.set(`x-middleware-request-${name}`, value);
    names.push(name);
  });
  if (names.length) headers.set('x-middleware-override-headers', names.join(','));
  return new Response(null, { headers });
}

export function createVercelMiddleware(
  options: VercelMiddlewareOptions,
): (request: Request, context?: { waitUntil?(promise: Promise<unknown>): void }) => Promise<Response> {
  const handler = createProxyHandler(
    options.config,
    options.stages ?? ((defaults) => defaults.filter((s) => !STATIC_OWNED_STAGES.has(s.name))),
    {
      manifest: options.manifest ?? null,
      target: 'vercel',
      next: async (request) => middlewareNext(request),
    },
  );
  return (request, context) =>
    handler(request, {
      waitUntil: (promise) => {
        if (context?.waitUntil) context.waitUntil(promise);
        else {
          const wait = platformWaitUntil();
          if (wait) wait(promise);
          else void promise.catch(() => undefined);
        }
      },
    });
}
