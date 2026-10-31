import { timingSafeEqual } from '@hypdriv/core';

/** The framework label Hypdriv reports in logs, the manifest and `/_hypdriv/health`. */
export const HOST = 'react-router';

/** Build-time module with the prerender token (`prerenderToken`), served by the Hypdriv Vite plugin. */
export const VIRTUAL_REACT_ROUTER = 'virtual:hypdriv/react-router';

/** Hypdriv's SSR entry for Node and Vercel builds: the React Router server build plus a full-response handler. */
export const VIRTUAL_SERVER_ENTRY = 'virtual:hypdriv/react-router/server-entry';

/**
 * Request header that marks React Router's build-time prerender requests. The build injects a random per-build
 * token into it (on the preview server React Router prerenders through) and into the server bundle; after the
 * build the token is erased from the server output, so no production request can carry a valid one.
 */
export const PRERENDER_HEADER = 'x-hypdriv-prerender';

/**
 * Whether a request is one of the build's own prerender requests: the header carries the build token and the
 * token is non-empty (production bundles carry an empty token).
 */
export function isPrerenderRequest(request: Request, token: string | null | undefined): boolean {
  if (!token) return false;
  const value = request.headers.get(PRERENDER_HEADER);
  return value !== null && value.length === token.length && timingSafeEqual(value, token);
}

/** A Response that redirects (3xx with a `Location`). */
export function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has('location');
}
