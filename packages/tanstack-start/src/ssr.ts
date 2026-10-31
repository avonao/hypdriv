import { getGlobalStartContext } from '@tanstack/react-start';

/** The router's `ssr` option Hypdriv fills in. */
export interface HypDrivSsrOptions {
  nonce?: string;
}

/**
 * The `ssr` option for `createRouter()` in `getRouter()` (src/router.tsx): on the server, the CSP nonce of the
 * current request, which TanStack Router puts on every script, style and preload it renders (`HeadContent`,
 * `Scripts`, the streamed hydration scripts) and publishes in `<meta property="csp-nonce">` for the client. In
 * the browser, during prerendering and in hash mode it returns `undefined`.
 *
 * ```tsx
 * export function getRouter() {
 *   return createRouter({ routeTree, ssr: hypdrivSsr() });
 * }
 * ```
 */
export function hypdrivSsr(): HypDrivSsrOptions | undefined {
  try {
    const context = getGlobalStartContext() as { nonce?: unknown } | undefined;
    const nonce = context?.nonce;
    return typeof nonce === 'string' && nonce ? { nonce } : undefined;
  } catch {
    // Outside a request (module evaluation, tests): no nonce.
    return undefined;
  }
}
