import { handlerFor, type WakuServerEntry, type WrapOptions, wrapFetch } from './entry';

/** `Cache-Control` of content-hashed build assets. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Waku's Node adapter behind the Drivetrain (`waku start`, `node dist/serve-node.js`). Waku's Node server serves
 * `dist/public` (prerendered pages, RSC payloads, hashed assets) before any middleware of its own, so the wrapper
 * sits around the whole server: every response gets the request stages, and content-hashed assets (the
 * manifest's immutable prefixes) get the immutable cache header Waku's static file server does not set.
 */
export function wrapNodeEntry(entry: WakuServerEntry, options: WrapOptions): WakuServerEntry {
  const handler = handlerFor(options);
  let prefixes: Promise<string[]> | null = null;
  const immutablePrefixes = (): Promise<string[]> => {
    prefixes ??= handler
      .ready()
      .then((runtime) => runtime.platform.manifest.staticFiles.immutablePrefixes ?? [])
      .catch(() => []);
    return prefixes;
  };
  const cacheAssets = async (request: Request, response: Response): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return response;
    if (!response.ok || response.headers.has('cache-control')) return response;
    const { pathname } = new URL(request.url);
    if (!(await immutablePrefixes()).some((prefix) => pathname.startsWith(prefix))) return response;
    const cached = new Response(response.body, response);
    cached.headers.set('cache-control', IMMUTABLE_CACHE_CONTROL);
    return cached;
  };
  return { ...entry, fetch: wrapFetch(entry.fetch, handler, cacheAssets) };
}
