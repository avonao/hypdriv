import type { HypHandler } from '@hypdriv/runtime';
import { isStaticRequest } from '@hypdriv/runtime';
import { carryPlatformFacts, nativeRequest, platformInput } from './entry';

/** Build metadata directories (Vite's manifest, Hypdriv's reports) that never belong to a deployment's public files. */
const PRIVATE_BUILD_DIRECTORIES = ['.vite', '.hypdriv'];

/** The parts of the Nitro 3 app the hook uses: `fetch` is the one function every request of every preset goes through. */
export interface NitroAppLike {
  fetch: (request: Request) => Response | Promise<Response>;
}

export interface FetchHookOptions {
  /** The Hypdriv handler (`createHandler({ config, manifest, host: 'solid-start', skip })`). */
  handler: HypHandler;
}

/**
 * The request-path predicate for SolidStart: content-hashed build assets (`/_build/assets/…`) and media skip the
 * pipeline (their headers are static: Nitro route rules on Node, the Build Output on Vercel, `_headers` on
 * Cloudflare), everything else — documents, API routes, server functions — runs through it.
 */
export function solidSkip(assetPrefixes: readonly string[]): (url: URL) => boolean {
  return (url) => isStaticRequest(url) || assetPrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

/**
 * Wraps `nitroApp.fetch` with the Hypdriv pipeline. Nitro calls it for every request — prerendered documents and
 * public files it serves itself included — and SolidStart's H3 app runs inside it, so the pipeline owns the whole
 * response: internal routes (`/_hypdriv/*`), the HTTPS upgrade, request stages, security headers, the CSP (nonce
 * injection into the streamed HTML, or the hashes of a prerendered document), `Server-Timing` and logging.
 *
 * The request the application sees is the pipeline's forwarded request (sanitised client headers plus the stages'
 * `x-hypdriv-*` headers and the nonce) carrying the original request's platform facts. Requests made inside an
 * outer Hypdriv runner (Nitro sub-requests while a request is handled, a Worker shell) pass straight through.
 */
export function installFetchHook(nitroApp: NitroAppLike, options: FetchHookOptions): void {
  const inner = nitroApp.fetch.bind(nitroApp);
  nitroApp.fetch = (request: Request) => {
    // Build metadata Nitro copies into the public directory (`/.vite/manifest.json`) is never served.
    if (isPrivateBuildPath(request.url)) return notFound();
    return options.handler(nativeRequest(request), {
      ...platformInput(request, options.handler.config),
      upstream: (forwarded) => inner(carryPlatformFacts(request, forwarded)),
    });
  };
}

/** Whether a URL addresses build metadata (`/.vite/…`, `/.hypdriv/…`) that deployments must not serve. */
export function isPrivateBuildPath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  let first = pathname.split('/')[1] ?? '';
  try {
    first = decodeURIComponent(first);
  } catch {
    // a malformed escape is not one of the build directories
  }
  return PRIVATE_BUILD_DIRECTORIES.includes(first.toLowerCase());
}

function notFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
